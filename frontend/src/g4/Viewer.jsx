import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { OrbitControls, GizmoHelper, GizmoViewport, Html, PerspectiveCamera, OrthographicCamera } from '@react-three/drei'
import * as THREE from 'three'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'

const HILITE = 0xff2d95   // bright magenta overlay for highlighted volumes

// blue → cyan → green → yellow → red colormap for normalised energy t∈[0,1].
function colormap(t) {
  t = Math.max(0, Math.min(1, t))
  // saturated/darker so it reads on a white background
  const stops = [
    [0.16, 0.20, 0.80], [0.06, 0.50, 0.78], [0.10, 0.60, 0.24],
    [0.80, 0.60, 0.05], [0.82, 0.18, 0.13],
  ]
  const s = t * (stops.length - 1)
  const i = Math.floor(s), f = s - i
  const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

const DEG = Math.PI / 180

// Rotation matrix from Euler XYZ degrees (R = Rz·Ry·Rx — matches gdml.py).
function rotMat(rx, ry, rz) {
  rx *= DEG; ry *= DEG; rz *= DEG
  const cx = Math.cos(rx), sx = Math.sin(rx)
  const cy = Math.cos(ry), sy = Math.sin(ry)
  const cz = Math.cos(rz), sz = Math.sin(rz)
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ]
}
const apply = (M, p, t) => [
  M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2] + t[0],
  M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2] + t[1],
  M[2][0] * p[0] + M[2][1] * p[1] + M[2][2] * p[2] + t[2],
]

const BOX_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
]

// Effective display style for a volume: a per-name override merged over the
// nptool material colour. mode: wire | solid | transparent.
function effStyle(g, styles) {
  // Merge a name-level override with a per-instance (id) override; instance wins
  // per-field, so e.g. one copy #103 can differ from the rest of its group.
  const byName = (styles && styles[g.name]) || null
  const byId = (styles && styles[g.id]) || null
  const d = (byName || byId) ? { ...byName, ...byId } : null
  const mat = '#' + new THREE.Color(...(g.color || [0.6, 0.7, 0.8])).getHexString()
  return {
    mode: (d && d.mode) || 'wire',
    edge: (d && d.edge) || mat,
    fill: (d && d.fill) || mat,
    edgeSet: !!(d && d.edge),      // user override → render exactly (no darkening)
    opacity: d && d.opacity != null ? d.opacity : 0.35,
    width: (d && d.width) || 1,    // wire line width in px (1 = thin/fast path)
    label: !!(d && d.label),       // show a 3D dimension label at this volume
    highlight: !!(d && d.highlight),
    noWire: !!(d && d.noWire),     // solid/transparent: hide the edge outline
  }
}

// THREE.Matrix4 for a volume's global placement (rot 9-matrix or Euler).
function mat4(g) {
  const T = g.pos || [0, 0, 0]
  const r = g.rot
  const M = (r && r.length === 9)
    ? [[r[0], r[1], r[2]], [r[3], r[4], r[5]], [r[6], r[7], r[8]]]
    : rotMat(...(r || [0, 0, 0]))
  const m = new THREE.Matrix4()
  m.set(M[0][0], M[0][1], M[0][2], T[0],
        M[1][0], M[1][1], M[1][2], T[1],
        M[2][0], M[2][1], M[2][2], T[2], 0, 0, 0, 1)
  return m
}

// The wireframe edges of one volume as a flat list of point pairs (already placed
// by its global transform). rot is either a 9-element GLOBAL rotation matrix (the
// /det/export_geometry dump — exact, no Euler drift) or [rx,ry,rz] Euler degrees.
function edgesOf(g) {
  const r = g.rot
  const M = (r && r.length === 9)
    ? [[r[0], r[1], r[2]], [r[3], r[4], r[5]], [r[6], r[7], r[8]]]
    : rotMat(...(r || [0, 0, 0]))
  const T = g.pos
  const out = []
  const seg = (a, b) => out.push(a, b)
  if (g.type === 'box') {
    const [sx, sy, sz] = g.size.map((v) => v / 2)
    const sgn = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
                 [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]
    const cor = sgn.map((s) => apply(M, [s[0] * sx, s[1] * sy, s[2] * sz], T))
    for (const [i, j] of BOX_EDGES) seg(cor[i], cor[j])
  } else if (g.type === 'cylinder') {
    const rr = g.rmax, h = g.height / 2
    const TWO_PI = 2 * Math.PI
    const rmin = g.rmin || 0
    const full = !g.dphi || g.dphi >= TWO_PI - 0.01   // dphi absent (old dumps) = full circle
    if (full && rmin <= 0) {
      const N = 24
      const ring = (z) => Array.from({ length: N + 1 }, (_, k) => {
        const a = (TWO_PI * k) / N
        return apply(M, [rr * Math.cos(a), rr * Math.sin(a), z], T)
      })
      const top = ring(h), bot = ring(-h)
      for (let k = 0; k < N; k++) { seg(top[k], top[k + 1]); seg(bot[k], bot[k + 1]) }
      for (let k = 0; k < N; k += 6) seg(bot[k], top[k])
    } else {
      // annular sector (fan): inner + outer arcs over [phi0, phi0+dphi] with radial caps
      const phi0 = g.phi0 || 0, dphi = full ? TWO_PI : (g.dphi || TWO_PI)
      const N = Math.max(6, Math.ceil((dphi / TWO_PI) * 40))
      const arc = (rad, z) => Array.from({ length: N + 1 }, (_, k) => {
        const a = phi0 + (dphi * k) / N
        return apply(M, [rad * Math.cos(a), rad * Math.sin(a), z], T)
      })
      const oT = arc(rr, h), oB = arc(rr, -h), iT = arc(rmin, h), iB = arc(rmin, -h)
      for (let k = 0; k < N; k++) { seg(oT[k], oT[k + 1]); seg(oB[k], oB[k + 1]) }
      if (rmin > 0) for (let k = 0; k < N; k++) { seg(iT[k], iT[k + 1]); seg(iB[k], iB[k + 1]) }
      for (const k of full ? [] : [0, N]) {   // the two straight radial edges (skip if full ring)
        seg(iT[k], oT[k]); seg(iB[k], oB[k]); seg(oT[k], oB[k]); seg(iT[k], iB[k])
      }
      const step = Math.max(1, Math.floor(N / 4))
      for (let k = 0; k <= N; k += step) seg(oB[k], oT[k])
    }
  } else if (g.type === 'sphere') {
    const rr = g.radius, N = 24
    const circle = (ax) => Array.from({ length: N + 1 }, (_, k) => {
      const a = (2 * Math.PI * k) / N, u = rr * Math.cos(a), v = rr * Math.sin(a)
      const p = ax === 0 ? [0, u, v] : ax === 1 ? [u, 0, v] : [u, v, 0]
      return apply(M, p, T)
    })
    for (const ax of [0, 1, 2]) {
      const cc = circle(ax)
      for (let k = 0; k < N; k++) seg(cc[k], cc[k + 1])
    }
  } else if (g.type === 'mesh') {
    // feature edges of the triangulated solid (outline + boolean-cut edges)
    const bg = new THREE.BufferGeometry()
    bg.setAttribute('position', new THREE.Float32BufferAttribute(g.verts, 3))
    // Low crease threshold: coplanar flat faces still merge (clean outlines for cut
    // wafers), but CURVED surfaces show their tessellation — otherwise a smooth
    // sphere shell (e.g. the Plunger chamber) has no feature edges and is invisible.
    const eg = new THREE.EdgesGeometry(bg, 1)
    const p = eg.attributes.position.array
    for (let i = 0; i < p.length; i += 6) {
      seg(apply(M, [p[i], p[i + 1], p[i + 2]], T), apply(M, [p[i + 3], p[i + 4], p[i + 5]], T))
    }
    bg.dispose(); eg.dispose()
  }
  return out
}

// Bucket every visible volume's edges by line width: thin (width 1 → one fast
// LineSegments draw call) vs fat (width>1 → one LineSegments2 per width). A
// separate positions-only `hi` buffer collects highlighted volumes for the overlay.
function buildGroups(geometry, hidden, styles) {
  const thin = { pos: [], col: [] }
  const fat = new Map()   // width → {pos, col}
  const hi = []           // flat positions for the highlight overlay
  for (const g of geometry) {
    if (hidden.has(g.id)) continue
    const s = effStyle(g, styles)
    // Solid/transparent fills normally keep their wire outline on top; `noWire`
    // drops the outline so the volume shows as a clean fill only.
    if (s.noWire && s.mode !== 'wire') continue
    // Every mode draws its wire edges — solid/transparent fills render on top of
    // them (Solids), so a wireframe stays visible over a solid volume too.
    const e = edgesOf(g)
    const ec = new THREE.Color(s.edge)
    // user-picked colour renders exactly; the default material colour is darkened
    // a touch so it reads on white (matches the ColorPicker default).
    const c = s.edgeSet ? [ec.r, ec.g, ec.b] : [ec.r * 0.7, ec.g * 0.7, ec.b * 0.7]
    let b = thin
    if (s.width > 1) { b = fat.get(s.width) || fat.set(s.width, { pos: [], col: [] }).get(s.width) }
    for (let i = 0; i < e.length; i += 2) {
      const a = e[i], d = e[i + 1]
      b.pos.push(a[0], a[1], a[2], d[0], d[1], d[2])
      b.col.push(c[0], c[1], c[2], c[0], c[1], c[2])
    }
    if (s.highlight) {
      for (let i = 0; i < e.length; i += 2) {
        const a = e[i], d = e[i + 1]
        hi.push(a[0], a[1], a[2], d[0], d[1], d[2])
      }
    }
  }
  return { thin, fat, hi }
}

// A fat (real pixel-width) line pass via three's LineSegments2. Used for volumes
// whose style sets width>1, and for the always-on-top highlight overlay.
function FatWire({ pos, col, width, color, overlay }) {
  const size = useThree((s) => s.size)
  const line = useMemo(() => {
    const geom = new LineSegmentsGeometry()
    geom.setPositions(pos)
    if (col) geom.setColors(col)
    const mat = new LineMaterial({
      vertexColors: !!col, color: color ?? 0xffffff, linewidth: width,
      transparent: true, opacity: overlay ? 0.95 : 0.9, depthTest: !overlay,
    })
    const seg = new LineSegments2(geom, mat)
    if (overlay) seg.renderOrder = 999
    return seg
  }, [pos, col, width, color, overlay])
  useEffect(() => { line.material.resolution.set(size.width, size.height) }, [line, size])
  useEffect(() => () => { line.geometry.dispose(); line.material.dispose() }, [line])
  return <primitive object={line} />
}

function Geometry({ geometry, hidden, styles }) {
  const { thin, fat, hi } = useMemo(
    () => buildGroups(geometry, hidden, styles), [geometry, hidden, styles])
  const thinGeom = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(thin.pos), 3))
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(thin.col), 3))
    return g
  }, [thin])
  return (
    <>
      {thin.pos.length > 0 && (
        <lineSegments geometry={thinGeom}>
          <lineBasicMaterial vertexColors transparent opacity={0.85} />
        </lineSegments>
      )}
      {[...fat.entries()].map(([w, b]) => b.pos.length > 0 && (
        <FatWire key={'w' + w} pos={b.pos} col={b.col} width={w} />
      ))}
      {hi.length > 0 && <FatWire key="hi" pos={hi} width={4} color={HILITE} overlay />}
    </>
  )
}

const rnd = (v) => Math.round(v * 10) / 10
function dimText(g) {
  if (g.type === 'box') return `${rnd(g.size[0])}×${rnd(g.size[1])}×${rnd(g.size[2])} mm`
  if (g.type === 'cylinder') {
    const TWO_PI = 2 * Math.PI
    const sector = (g.rmin > 0) || (g.dphi && g.dphi < TWO_PI - 0.01)
    if (sector) return `r${rnd(g.rmin || 0)}–${rnd(g.rmax)} · ${Math.round((g.dphi || TWO_PI) * 180 / Math.PI)}° × ${rnd(g.height)} mm`
    return `⌀${rnd(g.rmax * 2)}×${rnd(g.height)} mm`
  }
  if (g.type === 'sphere') return `r${rnd(g.radius)} mm`
  if (g.type === 'mesh') return `mesh · ${(g.verts?.length || 0) / 9 | 0} tri`
  return ''
}

// 3D dimension labels (drei Html overlays) for volumes whose style enabled them.
function Labels({ geometry, hidden, styles }) {
  return geometry.map((g) => {
    if (hidden.has(g.id)) return null
    if (!effStyle(g, styles).label) return null
    return (
      <Html key={g.id} position={g.pos} center zIndexRange={[10, 0]}
        style={{ pointerEvents: 'none' }}>
        <div className="dimlabel">{dimText(g)}</div>
      </Html>
    )
  })
}

// An annular sector (fan) plate: extrude a 2D ring-sector along z, centred in z.
// Matches a G4Tubs(rmin, rmax, dz, phi0, dphi) — the QQQ5 wafer is a 90° wedge.
function tubeSectorGeometry(rmin, rmax, height, phi0, dphi) {
  const shape = new THREE.Shape()
  const seg = Math.max(8, Math.ceil((dphi / (2 * Math.PI)) * 64))
  shape.moveTo(rmax * Math.cos(phi0), rmax * Math.sin(phi0))
  shape.absarc(0, 0, rmax, phi0, phi0 + dphi, false)           // outer arc, CCW
  if (rmin > 0) {
    shape.lineTo(rmin * Math.cos(phi0 + dphi), rmin * Math.sin(phi0 + dphi))
    shape.absarc(0, 0, rmin, phi0 + dphi, phi0, true)          // inner arc, CW back
  } else {
    shape.lineTo(0, 0)                                          // wedge to centre
  }
  shape.closePath()
  const gg = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: seg, steps: 1 })
  gg.translate(0, 0, -height / 2)   // ExtrudeGeometry grows +z from 0 → centre it
  return gg
}

// A single solid/transparent volume as a real filled mesh (flat MeshBasicMaterial,
// no lights needed). Placed via the volume's global transform.
function SolidMesh({ g, fill, opacity, transparent }) {
  const geom = useMemo(() => {
    let gg
    if (g.type === 'box') gg = new THREE.BoxGeometry(g.size[0], g.size[1], g.size[2])
    else if (g.type === 'cylinder') {
      const TWO_PI = 2 * Math.PI, rmin = g.rmin || 0
      const full = !g.dphi || g.dphi >= TWO_PI - 0.01
      if (full && rmin <= 0) { gg = new THREE.CylinderGeometry(g.rmax, g.rmax, g.height, 28); gg.rotateX(Math.PI / 2) }
      else gg = tubeSectorGeometry(rmin, g.rmax, g.height, g.phi0 || 0, full ? TWO_PI : (g.dphi || TWO_PI))
    }
    else if (g.type === 'sphere') gg = new THREE.SphereGeometry(g.radius, 24, 16)
    else if (g.type === 'mesh') {
      gg = new THREE.BufferGeometry()
      gg.setAttribute('position', new THREE.Float32BufferAttribute(g.verts, 3))
      gg.computeVertexNormals()
    }
    else gg = new THREE.BoxGeometry(1, 1, 1)
    return gg
  }, [g])
  const { pos, quat } = useMemo(() => {
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3()
    mat4(g).decompose(p, q, s)
    return { pos: p, quat: q }
  }, [g])
  return (
    <mesh geometry={geom} position={pos} quaternion={quat}>
      <meshBasicMaterial color={fill} transparent={transparent} opacity={opacity}
        depthWrite={!transparent} side={THREE.DoubleSide}
        polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
    </mesh>
  )
}

// All volumes the user set to solid/transparent (default is wire → none here).
function Solids({ geometry, hidden, styles }) {
  return geometry.map((g) => {
    if (hidden.has(g.id)) return null
    const s = effStyle(g, styles)
    if (s.mode !== 'solid' && s.mode !== 'transparent') return null
    return <SolidMesh key={g.id} g={g} fill={s.fill}
      transparent={s.mode === 'transparent'} opacity={s.mode === 'transparent' ? s.opacity : 1} />
  })
}

// Default per-track colour (distinct hue by index) when no override is set.
export function trackHue(i) {
  const c = new THREE.Color().setHSL((i * 0.137) % 1, 0.75, 0.42)
  return '#' + c.getHexString()
}
export const trackKey = (t) => `${t.eventID}:${t.trackID}`

// Tracks bucketed by line width (thin → 1 fast draw call, fat → LineSegments2 per
// width). Per-track overrides set colour/width/hidden (styles[key]).
function buildTracks(tracks, styles) {
  const thin = { pos: [], col: [] }
  const fat = new Map()
  tracks.forEach((t, i) => {
    const st = styles && styles[trackKey(t)]
    if (st && st.hidden) return
    const c = new THREE.Color(st && st.color ? st.color : trackHue(i))
    const w = (st && st.width) || 1
    let b = thin
    if (w > 1) b = fat.get(w) || fat.set(w, { pos: [], col: [] }).get(w)
    const p = t.points
    for (let k = 0; k + 1 < p.length; k++) {
      b.pos.push(p[k][0], p[k][1], p[k][2], p[k + 1][0], p[k + 1][1], p[k + 1][2])
      b.col.push(c.r, c.g, c.b, c.r, c.g, c.b)
    }
  })
  return { thin, fat }
}

function Tracks({ tracks, styles }) {
  const { thin, fat } = useMemo(() => buildTracks(tracks, styles), [tracks, styles])
  const thinGeom = useMemo(() => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(thin.pos), 3))
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(thin.col), 3))
    return g
  }, [thin])
  return (
    <>
      {thin.pos.length > 0 && (
        <lineSegments geometry={thinGeom}><lineBasicMaterial vertexColors /></lineSegments>
      )}
      {[...fat.entries()].map(([w, b]) => b.pos.length > 0 && (
        <FatWire key={'t' + w} pos={b.pos} col={b.col} width={w} />
      ))}
    </>
  )
}

// Time-ordered track animation. Draws each track only up to the current clock time T,
// interpolating the partial last segment so tracks grow SMOOTHLY (not point-by-point
// jumps). The clock runs inside useFrame (no React re-render per frame → 60fps); the
// panel controls it through `ctlRef` (seek / step-to-next-point / progress) and reactive
// `playing` / `duration` props. `tracks`: [{ points:[[x,y,z]], times:[ns], color }].
function AnimatedTracks({ tracks, playing, duration, ctlRef, onDone,
  emax, pointStyle, pointSize, ortho, showEdep }) {
  const built = useMemo(() => {
    let maxVerts = 0, tMin = Infinity, tMax = -Infinity
    // colour for an energy-deposit dot (mirror EdepPoints: solid, or an energy colormap)
    const solid = pointStyle && pointStyle.mode === 'solid'
    const lo = pointStyle && pointStyle.low != null ? pointStyle.low : 0
    const hi = pointStyle && pointStyle.high != null ? pointStyle.high : (emax || 1)
    const span = (hi - lo) || 1
    const sc = solid ? new THREE.Color((pointStyle && pointStyle.color) || '#ff3b30') : null
    const eds = []   // {p:[x,y,z], t, c:[r,g,b]} for every point that deposits energy
    const items = tracks.map((t) => {
      const pts = t.points || []
      const tm = (t.times && t.times.length === pts.length) ? t.times : pts.map((_, i) => i)
      const de = (t.edeps && t.edeps.length === pts.length) ? t.edeps : null
      maxVerts += Math.max(0, pts.length - 1) * 2
      if (tm.length) { tMin = Math.min(tMin, tm[0]); tMax = Math.max(tMax, tm[tm.length - 1]) }
      if (de) for (let i = 0; i < pts.length; i++) {
        if (de[i] > 0) {
          const tt = Math.min(1, Math.max(0, (de[i] - lo) / span))
          eds.push({ p: pts[i], t: tm[i], c: solid ? [sc.r, sc.g, sc.b] : colormap(tt) })
        }
      }
      return { pts, tm, col: new THREE.Color(t.color || '#88aacc') }
    })
    if (!isFinite(tMin)) { tMin = 0; tMax = 1 }
    if (tMax <= tMin) tMax = tMin + 1
    const uniq = Array.from(new Set(items.flatMap((it) => it.tm))).sort((a, b) => a - b)
    const geom = new THREE.BufferGeometry()
    const pos = new Float32Array(Math.max(6, maxVerts * 3))
    const col = new Float32Array(Math.max(6, maxVerts * 3))
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geom.setAttribute('color', new THREE.BufferAttribute(col, 3))
    geom.setDrawRange(0, 0)
    // energy points, pre-sorted by time so "visible so far" is just a draw-range count
    eds.sort((a, b) => a.t - b.t)
    const edN = eds.length
    const edTimes = new Float64Array(edN)
    const edGeom = new THREE.BufferGeometry()
    const edPos = new Float32Array(Math.max(3, edN * 3))
    const edCol = new Float32Array(Math.max(3, edN * 3))
    eds.forEach((d, i) => {
      edTimes[i] = d.t
      edPos[i * 3] = d.p[0]; edPos[i * 3 + 1] = d.p[1]; edPos[i * 3 + 2] = d.p[2]
      edCol[i * 3] = d.c[0]; edCol[i * 3 + 1] = d.c[1]; edCol[i * 3 + 2] = d.c[2]
    })
    edGeom.setAttribute('position', new THREE.BufferAttribute(edPos, 3))
    edGeom.setAttribute('color', new THREE.BufferAttribute(edCol, 3))
    edGeom.setDrawRange(0, 0)
    return { items, tMin, tMax, uniq, geom, pos, col, edGeom, edTimes, edN }
  }, [tracks, emax, pointStyle])

  const uRef = useRef(1)         // normalized clock 0..1 — starts FULL (tracks visible)
  const lastU = useRef(-1)
  const doneRef = useRef(false)
  const playingRef = useRef(playing); playingRef.current = playing
  const durRef = useRef(duration); durRef.current = duration
  // New track set (new run / visibility change): show it fully unless we're mid-play,
  // so tracks are always on screen except during an active play-through.
  useEffect(() => { if (!playingRef.current) { uRef.current = 1; lastU.current = -1 } }, [built])

  const paint = (u) => {
    const { items, tMin, tMax, pos, col, geom, edGeom, edTimes, edN } = built
    const T = tMin + u * (tMax - tMin)
    let v = 0
    for (const it of items) {
      const { pts, tm, col: c } = it
      for (let i = 0; i + 1 < pts.length; i++) {
        const t0 = tm[i], t1 = tm[i + 1]
        if (t0 > T) break                              // this + later segments are future
        const a = pts[i], b = pts[i + 1]
        let bx = b[0], by = b[1], bz = b[2]
        if (t1 > T) {                                  // interpolate the partial segment
          const f = t1 > t0 ? (T - t0) / (t1 - t0) : 1
          bx = a[0] + (b[0] - a[0]) * f
          by = a[1] + (b[1] - a[1]) * f
          bz = a[2] + (b[2] - a[2]) * f
        }
        pos[v * 3] = a[0]; pos[v * 3 + 1] = a[1]; pos[v * 3 + 2] = a[2]
        col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b; v++
        pos[v * 3] = bx; pos[v * 3 + 1] = by; pos[v * 3 + 2] = bz
        col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b; v++
        if (t1 > T) break
      }
    }
    geom.attributes.position.needsUpdate = true
    geom.attributes.color.needsUpdate = true
    geom.setDrawRange(0, v)
    // energy dots: reveal every one whose time has been reached (edTimes sorted asc)
    let loI = 0, hiI = edN
    while (loI < hiI) { const mid = (loI + hiI) >> 1; if (edTimes[mid] <= T) loI = mid + 1; else hiI = mid }
    edGeom.setDrawRange(0, loI)
  }

  useFrame((_, dt) => {
    let u = uRef.current
    if (playingRef.current) {
      u = Math.min(1, u + dt / Math.max(0.01, durRef.current))
      uRef.current = u
      if (u >= 1) { if (!doneRef.current) { doneRef.current = true; onDone && onDone() } }
      else doneRef.current = false
    }
    if (u !== lastU.current) { lastU.current = u; paint(u) }
  })

  useEffect(() => {
    if (!ctlRef) return
    ctlRef.current = {
      getProgress: () => uRef.current,
      seek: (u01) => { uRef.current = Math.min(1, Math.max(0, u01)); doneRef.current = false },
      stepPoint: (dir) => {
        const { uniq, tMin, tMax } = built
        const span = tMax - tMin
        const T = tMin + uRef.current * span
        let target = dir > 0 ? uniq.find((x) => x > T + 1e-9)
          : uniq.filter((x) => x < T - 1e-9).pop()
        if (target == null) target = dir > 0 ? tMax : tMin
        uRef.current = span > 0 ? Math.min(1, Math.max(0, (target - tMin) / span)) : (dir > 0 ? 1 : 0)
        doneRef.current = false
      },
    }
    return () => { if (ctlRef) ctlRef.current = null }
  }, [built, ctlRef])

  useEffect(() => () => { built.geom.dispose(); built.edGeom.dispose() }, [built])

  const round = pointStyle && pointStyle.shape === 'circle'
  const psize = pointSize || 0.5
  return (
    <>
      <lineSegments geometry={built.geom}>
        <lineBasicMaterial vertexColors />
      </lineSegments>
      {showEdep && built.edN > 0 && (
        <points geometry={built.edGeom}>
          <pointsMaterial vertexColors sizeAttenuation={!ortho}
            size={ortho ? Math.max(3, psize * 6) : psize}
            map={round ? CIRCLE_TEX : null} alphaTest={round ? 0.5 : 0} transparent={round} />
        </points>
      )}
    </>
  )
}

// A soft-edged white disc texture → circular (round) points when used as the
// pointsMaterial `map` (with alphaTest to punch out the square corners).
const CIRCLE_TEX = (() => {
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas'); c.width = c.height = 64
  const g = c.getContext('2d')
  g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill()
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t
})()

function EdepPoints({ edep, emax, size, pointStyle, ortho }) {
  const solid = pointStyle && pointStyle.mode === 'solid'
  const round = pointStyle && pointStyle.shape === 'circle'
  const lo = pointStyle && pointStyle.low != null ? pointStyle.low : 0
  const hi = pointStyle && pointStyle.high != null ? pointStyle.high : (emax || 1)
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const pos = new Float32Array(edep.length * 3)
    const col = new Float32Array(edep.length * 3)
    const span = (hi - lo) || 1
    const sc = solid ? new THREE.Color((pointStyle && pointStyle.color) || '#ff3b30') : null
    edep.forEach((p, i) => {
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]
      const t = Math.min(1, Math.max(0, (p[3] - lo) / span))   // energy → [0,1] over [low,high]
      const c = solid ? [sc.r, sc.g, sc.b] : colormap(t)
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2]
    })
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    return g
  }, [edep, lo, hi, solid, pointStyle && pointStyle.color])
  return (
    <points geometry={geom}>
      {/* sizeAttenuation divides point size by depth — meaningless for an
          orthographic camera (renders points at ~0px), so use a fixed screen size. */}
      <pointsMaterial vertexColors sizeAttenuation={!ortho}
        size={ortho ? Math.max(3, size * 6) : size}
        map={round ? CIRCLE_TEX : null} alphaTest={round ? 0.5 : 0} transparent={round} />
    </points>
  )
}

const meshExtent = (verts) => {
  let m = 0
  for (let i = 0; i < verts.length; i++) { const v = Math.abs(verts[i]); if (v > m) m = v }
  return m
}
const halfExtent = (g) =>
  g.type === 'box' ? Math.max(...g.size) / 2
    : g.type === 'cylinder' ? Math.max(g.rmax, g.height / 2)
      : g.type === 'sphere' ? g.radius
        : g.type === 'mesh' ? meshExtent(g.verts || []) : 0

// Robust camera fit: centre on the median volume position and size to the 85th
// percentile reach, so far stray volumes (nptool parks a "sample" at 10 m) don't
// blow up the framing.
function fit(geometry) {
  const vis = geometry.filter((g) => g.visible !== false)
  if (!vis.length) return { center: [0, 0, 0], radius: 100 }
  const median = (k) => {
    const a = vis.map((g) => g.pos[k]).sort((x, y) => x - y)
    return a[a.length >> 1]
  }
  const center = [median(0), median(1), median(2)]
  const reach = vis
    .map((g) => Math.hypot(...g.pos.map((p, k) => p - center[k])) + halfExtent(g))
    .sort((a, b) => a - b)
  const radius = Math.max(1, reach[Math.floor(reach.length * 0.85)])
  return { center, radius }
}

function pickMime() {
  // Prefer MP4 (H.264) so the exported clip is an .mp4 wherever the browser can
  // record it (recent Chrome/Edge, Safari); fall back to WebM otherwise.
  const opts = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4',
    'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  for (const m of opts) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m
  return ''
}

// Exposes capture helpers on apiRef (PNG snapshot + 360° turntable video) from
// inside the Canvas, where the renderer/scene/camera live.
function CaptureRig({ apiRef, center, camPos, rollRef }) {
  const { gl, scene, camera } = useThree()
  const controls = useThree((s) => s.controls)
  useEffect(() => {
    if (!apiRef) return
    let raf = null
    let rollRaf = null   // separate handle so a content-roll and a camera glide can co-exist
    let clipRec = null   // MediaRecorder for the track-animation clip (started/stopped by the panel)
    const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
    // Slerp the roll group's quaternion to a target orientation over ~ms.
    const animateGroupTo = (qTarget, ms = 350) => {
      const grp = rollRef && rollRef.current
      if (!grp) return
      if (rollRaf) cancelAnimationFrame(rollRaf)
      const q0 = grp.quaternion.clone()
      let start = null
      const step = (now) => {
        if (start == null) start = now
        const t = Math.min(1, (now - start) / ms), e = easeInOut(t)
        grp.quaternion.copy(q0).slerp(qTarget, e)
        rollRaf = t < 1 ? requestAnimationFrame(step) : null
      }
      rollRaf = requestAnimationFrame(step)
    }
    // Smoothly fly the camera to a target pose (position + look-target + up) over
    // ~0.45 s, so the home / axis buttons glide there instead of snapping (like the
    // gizmo). Cancels any in-flight animation.
    const animateTo = (toPos, toTarget, toUp, ms = 450) => {
      if (raf) cancelAnimationFrame(raf)
      const fromPos = camera.position.clone()
      const fromTgt = controls ? controls.target.clone() : new THREE.Vector3(...center)
      const fromUp = camera.up.clone()
      let start = null
      const step = (now) => {
        if (start == null) start = now
        const t = Math.min(1, (now - start) / ms), e = easeInOut(t)
        camera.position.lerpVectors(fromPos, toPos, e)
        camera.up.copy(fromUp).lerp(toUp, e).normalize()
        if (controls) { controls.target.lerpVectors(fromTgt, toTarget, e); controls.update() }
        else camera.lookAt(toTarget)
        raf = t < 1 ? requestAnimationFrame(step) : null
      }
      raf = requestAnimationFrame(step)
    }
    apiRef.current = {
      resetView() {   // home button — glide back to the initial framing (any camera type)
        animateTo(new THREE.Vector3(camPos[0], camPos[1], camPos[2]),
          new THREE.Vector3(center[0], center[1], center[2]), new THREE.Vector3(0, 1, 0))
        animateGroupTo(new THREE.Quaternion())   // also undo any content roll
      },
      viewAxis(axis) {   // glide to look down x / y / z (like clicking the gizmo axis)
        const c = new THREE.Vector3(center[0], center[1], center[2])
        const dist = camera.position.distanceTo(c) || 100
        const pos = new THREE.Vector3(
          c.x + (axis === 'x' ? dist : 0), c.y + (axis === 'y' ? dist : 0), c.z + (axis === 'z' ? dist : 0))
        animateTo(pos, c, new THREE.Vector3(0, axis === 'y' ? 0 : 1, axis === 'y' ? -1 : 0))
      },
      roll(dir) {   // CAD-style clockwise / counter-clockwise 90° view roll (dir = ±1)
        // Roll the scene CONTENT about its centre along the current view axis (the
        // camera is left alone, so OrbitControls' world-up levelling can't fight it).
        const grp = rollRef && rollRef.current
        if (!grp) return
        const c = controls ? controls.target.clone() : new THREE.Vector3(...center)
        const fwd = new THREE.Vector3().subVectors(c, camera.position).normalize()
        const dq = new THREE.Quaternion().setFromAxisAngle(fwd, dir * 90 * Math.PI / 180)
        animateGroupTo(dq.multiply(grp.quaternion))   // world-space rotation about the view axis
      },
      zoom(factor) {     // factor > 1 = zoom out, < 1 = zoom in
        if (camera.isOrthographicCamera) {
          camera.zoom = Math.max(1e-4, camera.zoom / factor); camera.updateProjectionMatrix()
        } else {
          const c = controls ? controls.target : new THREE.Vector3(center[0], center[1], center[2])
          // capture the camera→target offset BEFORE moving the camera (copy() mutates
          // position in place, so reading it after would give a zero-length offset).
          const off = camera.position.clone().sub(c).multiplyScalar(factor)
          camera.position.copy(c).add(off)
        }
        if (controls) controls.update()
      },
      pan(dx, dy) {      // screen-space pan; dx/dy in ±1 steps
        const c = controls ? controls.target : new THREE.Vector3(center[0], center[1], center[2])
        const step = camera.isOrthographicCamera
          ? ((camera.top - camera.bottom) / camera.zoom) * 0.04
          : camera.position.distanceTo(c) * 0.04
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0)
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1)
        const delta = right.multiplyScalar(dx * step).add(up.multiplyScalar(dy * step))
        camera.position.add(delta)
        if (controls) { controls.target.add(delta); controls.update() }
      },
      capturePNG() {
        gl.render(scene, camera)
        const a = document.createElement('a')
        a.href = gl.domElement.toDataURL('image/png')
        a.download = 'nptoy.png'; a.click()
      },
      // Start recording the live canvas to a video file. Unlike recordTurntable this
      // does NOT drive the camera — the tracking panel advances the animation while
      // this captures each rendered frame; call recordStop() when the animation ends.
      // onClip({ url, filename, ext }) receives the finished clip so the panel can
      // offer a download button; without it the clip auto-downloads (legacy).
      recordStart({ onDone, onClip } = {}) {
        const el = gl.domElement
        if (typeof el.captureStream !== 'function' || !window.MediaRecorder) {
          onDone && onDone('브라우저가 녹화를 지원하지 않습니다'); return false
        }
        const mime = pickMime()
        const px = el.width * el.height
        const bitrate = Math.min(40_000_000, Math.max(12_000_000, Math.round(px * 0.5) * 30))
        const opts = { videoBitsPerSecond: bitrate, ...(mime ? { mimeType: mime } : {}) }
        try { clipRec = new MediaRecorder(el.captureStream(30), opts) }
        catch { onDone && onDone('녹화 시작 실패'); return false }
        const chunks = []
        clipRec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
        clipRec.onstop = () => {
          const blob = new Blob(chunks, { type: chunks[0]?.type || mime || 'video/webm' })
          const ext = blob.type.includes('mp4') ? 'mp4' : 'webm'
          const url = URL.createObjectURL(blob)
          const filename = 'nptoy-tracks.' + ext
          if (onClip) onClip({ url, filename, ext })    // panel keeps it → download button
          else {
            const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
            setTimeout(() => URL.revokeObjectURL(url), 3000)
          }
          onDone && onDone()
        }
        clipRec.start()
        return true
      },
      recordStop() {
        if (clipRec && clipRec.state !== 'inactive') setTimeout(() => clipRec.stop(), 150)
        clipRec = null
      },
      recordTurntable({ axis = 'y', seconds = 6, onProgress, onDone } = {}) {
        const el = gl.domElement
        if (typeof el.captureStream !== 'function' || !window.MediaRecorder) {
          onDone && onDone('브라우저가 녹화를 지원하지 않습니다'); return
        }
        const mime = pickMime()
        let rec
        // Default MediaRecorder bitrate is low (~2.5 Mbps) → blocky video. Bump it a
        // lot (scaled to the canvas pixel count) so the turntable stays crisp.
        const px = el.width * el.height
        const bitrate = Math.min(40_000_000, Math.max(12_000_000, Math.round(px * 0.5) * 30))
        const opts = { videoBitsPerSecond: bitrate, ...(mime ? { mimeType: mime } : {}) }
        try { rec = new MediaRecorder(el.captureStream(30), opts) }
        catch { onDone && onDone('녹화 시작 실패'); return }
        const chunks = []
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
        rec.onstop = () => {
          const blob = new Blob(chunks, { type: chunks[0]?.type || 'video/webm' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url; a.download = 'nptoy-turntable.' + (mime.includes('mp4') ? 'mp4' : 'webm'); a.click()
          setTimeout(() => URL.revokeObjectURL(url), 3000)
          onDone && onDone()
        }
        const axisVec = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0)
        const c = new THREE.Vector3(...center)
        const startOffset = camera.position.clone().sub(c)
        let start = null
        rec.start()
        const step = (now) => {
          if (start == null) start = now
          const t = Math.min(1, (now - start) / (seconds * 1000))
          camera.position.copy(c).add(startOffset.clone().applyAxisAngle(axisVec, t * Math.PI * 2))
          camera.lookAt(c)
          if (controls) { controls.target.copy(c); controls.update() }
          onProgress && onProgress(t)
          if (t < 1) requestAnimationFrame(step)
          else {
            camera.position.copy(c).add(startOffset); camera.lookAt(c)
            if (controls) controls.update()
            setTimeout(() => rec.stop(), 150)   // flush the last frame
          }
        }
        requestAnimationFrame(step)
      },
    }
    return () => {
      if (raf) cancelAnimationFrame(raf)
      if (rollRaf) cancelAnimationFrame(rollRaf)
      if (clipRec && clipRec.state !== 'inactive') { try { clipRec.stop() } catch {} }
      if (apiRef) apiRef.current = null
    }
  }, [gl, scene, camera, controls, center, camPos, rollRef])
  return null
}

// Active camera: perspective (default) or orthographic (직교). Mounts at the live
// position/target (kept across a mode swap so the viewing angle is preserved); the
// orthographic zoom is chosen to match the perspective apparent scale at swap time.
function Cameras({ ortho, initPos, target, radius }) {
  const size = useThree((s) => s.size)
  const dist = Math.hypot(initPos[0] - target[0], initPos[1] - target[1], initPos[2] - target[2]) || radius * 2.4
  if (ortho) {
    const zoom = size.height / (2 * dist * Math.tan((42 * Math.PI) / 360))
    return <OrthographicCamera makeDefault position={initPos} zoom={zoom} near={0.1} far={radius * 80} />
  }
  return <PerspectiveCamera makeDefault position={initPos} fov={42} near={0.1} far={radius * 60} />
}

export default function Viewer({ geometry, event, show, hidden, styles, trackStyles, pointStyle, ortho, bgColor, controlsRef, apiRef,
  animTracks, animPlaying, animDuration, animCtlRef, onAnimDone }) {
  // keep the latest onAnimDone reachable from AnimatedTracks' useFrame loop
  const animDoneRef = useRef()
  animDoneRef.current = onAnimDone
  const { center, radius } = useMemo(() => fit(geometry), [geometry])
  const d = radius * 2.4
  const initCamPos = useMemo(() => [center[0] + d * 0.7, center[1] + d * 0.55, center[2] + d], [center, d])
  // Live camera position/target, updated on every control change — survives the
  // ortho toggle (Viewer re-renders but isn't unmounted) so the angle carries over.
  const camState = useRef(null)
  const onCtl = () => {
    const c = controlsRef.current
    if (c && c.object) camState.current = { position: c.object.position.toArray(), target: c.target.toArray() }
  }
  const pos = camState.current?.position || initCamPos
  const tgt = camState.current?.target || center
  // Roll pivot: OrbitControls hard-levels the camera to world-up every frame and
  // ignores camera.up, so a *camera* roll can't survive. Instead we roll the scene
  // CONTENT about its centre along the view axis — the camera/controls are never
  // touched, so the roll sticks. rollRef is the group whose quaternion we spin.
  const rollRef = useRef()
  const negCenter = useMemo(() => [-center[0], -center[1], -center[2]], [center])
  return (
    <Canvas gl={{ preserveDrawingBuffer: true }}>
      <color attach="background" args={[bgColor || '#ffffff']} />
      <Cameras ortho={ortho} initPos={pos} target={tgt} radius={radius} />
      {/* pivot at centre → roll group → shift content back to world coords */}
      <group position={center}>
        <group ref={rollRef}>
          <group position={negCenter}>
            <Geometry geometry={geometry} hidden={hidden} styles={styles} />
            <Solids geometry={geometry} hidden={hidden} styles={styles} />
            <Labels geometry={geometry} hidden={hidden} styles={styles} />
            {show.tracks && (animTracks
              ? <AnimatedTracks tracks={animTracks} playing={!!animPlaying} duration={animDuration || 0.4}
                  ctlRef={animCtlRef} onDone={() => animDoneRef.current && animDoneRef.current()}
                  emax={event.meta.energy_max} pointStyle={pointStyle} pointSize={show.pointSize}
                  ortho={ortho} showEdep={show.edep} />
              : <Tracks tracks={event.tracks} styles={trackStyles} />)}
            {/* static energy points — hidden during the animation, which reveals them in time */}
            {show.edep && !animTracks && event.edep.length > 0 && (
              <EdepPoints edep={event.edep} emax={event.meta.energy_max} size={show.pointSize}
                pointStyle={pointStyle} ortho={ortho} />
            )}
            {show.axes && <axesHelper args={[radius * 0.5]} />}
          </group>
        </group>
      </group>
      <OrbitControls key={ortho ? 'ortho' : 'persp'} ref={controlsRef} target={tgt}
        makeDefault onChange={onCtl} />
      <CaptureRig apiRef={apiRef} center={center} camPos={initCamPos} rollRef={rollRef} />
      <GizmoHelper alignment="bottom-right" margin={[70, 70]}>
        <GizmoViewport axisColors={['#e06666', '#93c47d', '#6fa8dc']} labelColor="white" />
      </GizmoHelper>
    </Canvas>
  )
}
