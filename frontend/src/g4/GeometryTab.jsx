/**
 * GeometryTab — 간이 CAD: script-defined Geant4 geometry.
 *
 * Data model: per-user geometry documents (`.geo`, NPL block text holding
 * `Solid`/`Volume` blocks and optionally regular detector blocks like STARK).
 * Everything the forms know comes from the backend catalog (detectors.json,
 * generated from the nptool sources) — nothing detector-specific is hardcoded
 * here. Field descriptions from the catalog drive the help panel.
 *
 * Preview: edits render instantly client-side (approximate for booleans/STL/
 * unknown detector blocks); the "Geant4 검증" button runs the real
 * construction server-side and swaps in the exact exported scene (mesh
 * triangles), plus overlap/error reports.
 */
import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import {
  geomCatalog, geomMaterials, geomDocs, geomDocGet, geomDocPut, geomDocDelete,
  geomDocRename, geomApply, geomRemove, geomValidate,
} from './api.js'
import { parseDetector, serializeDetector, getParam, setParam } from './detector.js'

// The production scene viewer (three.js) — lazy so the tab paints fast and the
// heavy 3D bundle loads on demand, exactly like SimulationTab does.
const Viewer = lazy(() => import('./Viewer.jsx'))
const EMPTY_EVENT = { tracks: [], edep: [], meta: { n_events: 0, n_points: 0, energy_max: 0 } }
const NO_HIDDEN = new Set() // Viewer calls hidden.has() unconditionally

const DEG = Math.PI / 180

// ── numeric helpers ────────────────────────────────────────────────────────────
const nums = (v) => String(v ?? '').trim().split(/\s+/).map(Number).filter((x) => !isNaN(x))
const n1 = (v, d = 0) => { const a = nums(v); return a.length ? a[0] : d }
const n3 = (v) => { const a = nums(v); return [a[0] || 0, a[1] || 0, a[2] || 0] }

// ── tiny 3x3 matrix math (pure JS — keeps three.js out of the main bundle) ────
// G4 convention: Rot.rotateX(rx); rotateY(ry); rotateZ(rz) → R = Rz·Ry·Rx
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]
function rot3(rxDeg, ryDeg, rzDeg) {
  const [a, b, c] = [rxDeg * DEG, ryDeg * DEG, rzDeg * DEG]
  const cx = Math.cos(a), sx = Math.sin(a), cy = Math.cos(b), sy = Math.sin(b), cz = Math.cos(c), sz = Math.sin(c)
  const Rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx]
  const Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy]
  const Rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1]
  return mul3(Rz, mul3(Ry, Rx))
}
function mul3(A, B) {
  const C = new Array(9)
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]
  return C
}
const apply3 = (A, v) => [
  A[0] * v[0] + A[1] * v[1] + A[2] * v[2],
  A[3] * v[0] + A[4] * v[1] + A[5] * v[2],
  A[6] * v[0] + A[7] * v[1] + A[8] * v[2],
]
// compose parent ∘ local placements: R = Rp·Rl, T = Rp·Tl + Tp
const compose = (P, L) => ({ R: mul3(P.R, L.R), T: apply3(P.R, L.T).map((x, i) => x + P.T[i]) })
const tr3 = (A) => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]] // rotation inverse

// world placement of a named Volume block (mother-chain composition)
function worldPlacementOf(blocks, name, depth = 0) {
  const b = blocks.find((x) => x.type === 'Volume' && x.arg === name)
  if (!b || depth > 32) return { R: I3, T: [0, 0, 0] }
  const local = { R: rot3(...n3(getParam(b, 'RotateXYZ'))), T: n3(getParam(b, 'POS')) }
  const mother = getParam(b, 'Mother')
  if (!mother || mother === 'world') return local
  return compose(worldPlacementOf(blocks, mother, depth + 1), local)
}

// a dragged world position expressed in the volume's mother frame (= its POS)
function worldToMotherLocal(blocks, name, world) {
  const b = blocks.find((x) => x.type === 'Volume' && x.arg === name)
  const mother = b && getParam(b, 'Mother')
  if (!mother || mother === 'world') return world
  const P = worldPlacementOf(blocks, mother)
  const d = [world[0] - P.T[0], world[1] - P.T[1], world[2] - P.T[2]]
  return apply3(tr3(P.R), d)
}

// Euler angles (deg) in the G4 convention R = Rz(rz)·Ry(ry)·Rx(rx), from a
// row-major 3x3. Standard ZYX extraction; at the ry = ±90° gimbal point rx
// and rz are degenerate — fold everything into rz.
function eulerZYX(R) {
  const r20 = Math.max(-1, Math.min(1, R[6]))
  const ry = Math.asin(-r20)
  let rx, rz
  if (Math.abs(r20) < 0.999999) {
    rx = Math.atan2(R[7], R[8])
    rz = Math.atan2(R[3], R[0])
  } else {
    rx = 0
    rz = Math.atan2(-R[1], R[4])
  }
  return [rx / DEG, ry / DEG, rz / DEG]
}

// a world-frame delta rotation applied to the volume, expressed as its new
// local RotateXYZ: R'l = Rpᵀ · ΔR · Rw  (Rw = current world rotation)
function rotateCommit(blocks, name, dRot9) {
  const b = blocks.find((x) => x.type === 'Volume' && x.arg === name)
  const mother = b && getParam(b, 'Mother')
  const W = worldPlacementOf(blocks, name)
  const newWorld = mul3(dRot9, W.R)
  const Rp = (!mother || mother === 'world') ? I3 : worldPlacementOf(blocks, mother).R
  return eulerZYX(mul3(tr3(Rp), newWorld))
}

// ── live preview: blocks → Viewer scene items (same JSON the run viewer eats) ──
// Exact for Box/Tubs/Sphere/Orb; bounding approximations (rendered as wire) for
// the rest — the Geant4 validation swaps in the exact tessellated shapes.
function shapeItem(block, solids, depth = 0) {
  const type = getParam(block, 'Type') || getParam(block, 'Shape')
  const P = (k, d) => n1(getParam(block, k), d)
  switch (type) {
    case 'Box': { const s = n3(getParam(block, 'Size')); return { type: 'box', size: s, approx: false } }
    case 'Tubs': return { type: 'cylinder', rmax: P('Rmax'), height: P('Length'), rmin: P('Rmin'),
      phi0: P('Phi0') * DEG, dphi: P('DPhi', 360) * DEG, approx: false }
    case 'Sphere': case 'Orb': return { type: 'sphere', radius: P('Rmax'), approx: false }
    case 'Cons': return { type: 'cylinder', rmax: Math.max(P('Rmax1'), P('Rmax2')), height: P('Length'), approx: true }
    case 'Trd': return { type: 'box', size: [Math.max(P('Dx1'), P('Dx2')), Math.max(P('Dy1'), P('Dy2')), P('Dz')], approx: true }
    case 'Torus': return { type: 'cylinder', rmax: P('Rtor') + P('Rmax'), rmin: Math.max(0, P('Rtor') - P('Rmax')), height: 2 * P('Rmax'), approx: true }
    case 'EllipticalTube': return { type: 'cylinder', rmax: Math.max(P('Dx'), P('Dy')) / 2, height: P('Dz'), approx: true }
    case 'Union': case 'Subtraction': case 'Intersection': {
      const a = solids[getParam(block, 'A')]
      const base = a && depth < 8 ? shapeItem(a, solids, depth + 1) : { type: 'box', size: [20, 20, 20] }
      return { ...base, approx: true }
    }
    case 'STL': default: return { type: 'box', size: [20, 20, 20], approx: true }
  }
}

function buildLive(blocks) {
  const solids = {}
  for (const b of blocks) if (b.type === 'Solid' && b.arg) solids[b.arg] = b
  const volsByName = {}
  for (const b of blocks) if (b.type === 'Volume' && b.arg) volsByName[b.arg] = b

  const worldOf = {}
  const localOf = (b) => ({ R: rot3(...n3(getParam(b, 'RotateXYZ'))), T: n3(getParam(b, 'POS')) })
  const resolve = (name, depth = 0) => {
    if (worldOf[name]) return worldOf[name]
    const b = volsByName[name]
    if (!b) return { R: I3, T: [0, 0, 0] }
    const mother = getParam(b, 'Mother')
    const parent = mother && mother !== 'world' && depth < 32 ? resolve(mother, depth + 1) : { R: I3, T: [0, 0, 0] }
    return (worldOf[name] = compose(parent, localOf(b)))
  }

  const items = []
  for (const b of blocks) {
    if (b.type === 'Solid') continue
    if (b.type === 'Volume' && b.arg) {
      if (getParam(b, 'Visible') === '0') continue
      const solidRef = getParam(b, 'Solid')
      const shapeBlock = solidRef ? solids[solidRef] : b
      const { approx, ...shape } = shapeBlock ? shapeItem(shapeBlock, solids) : { type: 'box', size: [20, 20, 20], approx: true }
      const color = nums(getParam(b, 'Color'))
      const w = resolve(b.arg)
      items.push({
        id: b.arg, name: b.arg, group: '', copy: 0, visible: true, ...shape,
        pos: w.T, rot: w.R,
        color: color.length >= 3 ? color.slice(0, 3) : [0.55, 0.65, 0.85],
        _approx: approx, _alpha: color.length >= 4 ? color[3] : 0.55,
      })
    } else {
      // a regular detector block (STARK, ATOMX…): a marker cube at POS —
      // its real geometry appears after the Geant4 validation run
      const nm = `${b.type}${b.arg ? ' ' + b.arg : ''}`
      items.push({ id: nm, name: nm, group: '', copy: 0, visible: true, type: 'box',
        size: [28, 28, 28], pos: n3(getParam(b, 'POS')), rot: I3, color: [0.95, 0.45, 0.15], _approx: true, _alpha: 0.9 })
    }
  }
  return items
}

// ── form field ────────────────────────────────────────────────────────────────
function Field({ name, spec, value, onChange, onHelp, materials }) {
  const label = (
    <label title={spec.description || ''} onMouseEnter={() => onHelp(name, spec)} onFocus={() => onHelp(name, spec)}
      style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 2, cursor: 'help',
        color: spec.optional === false ? 'var(--text-primary,#1a1a1a)' : 'var(--text-secondary,#556)' }}>
      {name}{spec.optional === false ? ' *' : ''}{spec.unit ? <span style={{ fontWeight: 400, opacity: 0.7 }}> ({spec.unit})</span> : null}
    </label>
  )
  const base = { width: '100%', boxSizing: 'border-box', padding: '5px 8px', fontSize: 13,
    border: '1px solid var(--border-default,#ccc)', borderRadius: 6, background: 'var(--surface,#fff)' }
  let input
  if (spec.choices) {
    input = (
      <select style={base} value={value} onChange={(e) => onChange(e.target.value)} onFocus={() => onHelp(name, spec)}>
        <option value="">—</option>
        {spec.choices.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    )
  } else if (name === 'Material') {
    input = (
      <>
        <input style={base} list="geom-materials" value={value} onFocus={() => onHelp(name, spec)}
          onChange={(e) => onChange(e.target.value)} placeholder="Al, NaI, MyGas…" />
        <datalist id="geom-materials">{materials.map((m) => <option key={m.name} value={m.name} />)}</datalist>
      </>
    )
  } else {
    input = <input style={base} value={value} onFocus={() => onHelp(name, spec)}
      onChange={(e) => onChange(e.target.value)}
      placeholder={spec.type === 'vector3' ? `x y z ${spec.unit || ''}` : spec.unit || ''} />
  }
  return <div style={{ marginBottom: 8 }}>{label}{input}</div>
}

// ── main tab ──────────────────────────────────────────────────────────────────
const NEW_DOC = `% new geometry
Volume MyBox
 Shape= Box
 Size= 100 100 100 mm
 Material= Al
 POS= 0 0 0 mm
 Color= 0.55 0.65 0.85 0.7
`

// `active`: tabs stay mounted behind a display:none toggle, but an R3F Canvas
// must not initialize inside a hidden (zero-size) container — mount it only
// while this tab is visible (same reason SimulationTab lazy-loads its Viewer).
export default function GeometryTab({ active = true }) {
  const [catalog, setCatalog] = useState(null)
  const [materials, setMaterials] = useState([])
  const [docs, setDocs] = useState([])
  const [docName, setDocName] = useState('')
  const [blocks, setBlocks] = useState([])
  const [dirty, setDirty] = useState(false)
  const [selIdx, setSelIdx] = useState(-1)
  const [validated, setValidated] = useState(null)   // exact scene after 검증
  const [report, setReport] = useState(null)         // {ok, errors, overlaps, log}
  const [busy, setBusy] = useState('')
  const [help, setHelp] = useState(null)             // {name, text}
  const [addSel, setAddSel] = useState('Volume')
  const [err, setErr] = useState('')
  const [editMode, setEditMode] = useState(false)  // click-select + drag gizmo (off = orbit only)
  const [gizmoMode, setGizmoMode] = useState('translate') // translate | rotate
  const controlsRef = useRef(null)

  const refreshDocs = async () => setDocs((await geomDocs()).docs)
  useEffect(() => {
    geomCatalog().then(setCatalog).catch((e) => setErr(String(e.message || e)))
    geomMaterials().then((d) => setMaterials(d.materials)).catch(() => {})
    refreshDocs().catch((e) => setErr(String(e.message || e)))
  }, [])

  const items = useMemo(() => buildLive(blocks), [blocks])
  const sel = selIdx >= 0 && selIdx < blocks.length ? blocks[selIdx] : null
  const selName = sel ? (sel.type === 'Volume' || sel.type === 'Solid' ? sel.arg : `${sel.type}${sel.arg ? ' ' + sel.arg : ''}`) : ''

  // scene + per-volume display styles for the shared Viewer. In edit mode every
  // volume renders as a pickable transparent mesh (wire lines can't be clicked).
  const scene = validated || items
  const viewStyles = useMemo(() => {
    const st = {}
    for (const it of scene) {
      if (it._approx === undefined) // validated scene item
        st[it.name] = editMode ? { mode: 'transparent', opacity: 0.3 } : {}
      else if (it._approx)
        st[it.name] = editMode ? { mode: 'transparent', opacity: 0.25 } : { mode: 'wire', width: 2 }
      else
        st[it.name] = { mode: 'transparent', opacity: it._alpha }
    }
    if (selName) {
      st[selName] = { ...(st[selName] || {}), highlight: true }
      st[selName + '_log'] = { ...(st[selName + '_log'] || {}), highlight: true }
    }
    return st
  }, [scene, selName, editMode])

  // edit-mode hooks for the Viewer: click-to-select + translate gizmo
  const pickHandler = editMode ? (g) => {
    const nm = (g.name || '').replace(/_log$/, '')
    const i = blocks.findIndex((b) =>
      (b.type === 'Volume' || b.type === 'Solid') ? b.arg === nm : `${b.type}${b.arg ? ' ' + b.arg : ''}` === nm)
    if (i >= 0) setSelIdx(i)
  } : undefined
  const transformSpec = editMode && !validated && sel?.type === 'Volume' && sel.arg ? {
    name: sel.arg,
    mode: gizmoMode,
    onCommit: ({ position, rot9 }) => {
      if (gizmoMode === 'rotate') {
        const [rx, ry, rz] = rotateCommit(blocks, sel.arg, rot9)
        setField('RotateXYZ', [rx, ry, rz].map((x) => +x.toFixed(1)).join(' ') + ' deg')
      } else {
        const local = worldToMotherLocal(blocks, sel.arg, position)
        setField('POS', local.map((x) => +x.toFixed(2)).join(' ') + ' mm')
      }
    },
  } : undefined

  // schema for the selected block: Volume/Solid or any catalog detector
  const schema = useMemo(() => {
    if (!sel || !catalog) return null
    return catalog.detectors[sel.type] || null
  }, [sel, catalog])

  const touch = (next) => { setBlocks(next); setDirty(true); setValidated(null); setReport(null) }

  const openDoc = async (name) => {
    const d = await geomDocGet(name)
    setDocName(name); setBlocks(parseDetector(d.content)); setDirty(false)
    setSelIdx(-1); setValidated(null); setReport(null)
  }
  const saveDoc = async () => {
    if (!docName) return
    await geomDocPut(docName, serializeDetector(blocks))
    setDirty(false); refreshDocs()
  }
  // portal-proxied context suppresses window.prompt → inline name input
  const [newName, setNewName] = useState(null) // null = closed, '' = open
  const newDoc = async () => {
    const name = (newName || '').trim()
    if (!name) return
    try { await geomDocPut(name, NEW_DOC); setNewName(null); await refreshDocs(); await openDoc(name) }
    catch (e) { setErr(String(e.message || e)) }
  }
  // deletion is confirmed by a second click on the row's 확인 button
  // (window.confirm is suppressed behind the portal proxy)
  const [pendingDel, setPendingDel] = useState('')
  const removeDoc = async (name) => {
    await geomDocDelete(name)
    if (docName === name) { setDocName(''); setBlocks([]); setSelIdx(-1) }
    refreshDocs()
  }

  const validate = async () => {
    setBusy('validate'); setErr('')
    try {
      if (dirty && docName) await saveDoc()
      const r = await geomValidate(serializeDetector(blocks))
      setReport(r); setValidated(r.geometry?.length ? r.geometry : null)
    } catch (e) { setErr(String(e.message || e)) }
    setBusy('')
  }
  const applyDoc = async (name, applied) => {
    setBusy('apply')
    try {
      if (dirty && name === docName) await saveDoc()
      if (applied) await geomRemove(name); else await geomApply(name)
      await refreshDocs()
    } catch (e) { setErr(String(e.message || e)) }
    setBusy('')
  }

  const addBlock = () => {
    const b = { type: addSel === 'Volume' || addSel === 'Solid' ? addSel : addSel, arg: '', header: [''], params: [] }
    if (addSel === 'Volume') {
      b.arg = uniqueName('Vol', blocks)
      b.params = [{ key: 'Shape', value: 'Box' }, { key: 'Size', value: '50 50 50 mm' },
        { key: 'Material', value: 'Al' }, { key: 'POS', value: '0 0 0 mm' }]
    } else if (addSel === 'Solid') {
      b.arg = uniqueName('Sol', blocks)
      b.params = [{ key: 'Type', value: 'Box' }, { key: 'Size', value: '50 50 50 mm' }]
    } else if (catalog?.detectors[addSel]) {
      const det = catalog.detectors[addSel]
      const req = det.variants?.[0]?.requires || []
      b.params = req.map((k) => {
        const f = det.fields[k] || {}
        const v = f.choices ? f.choices[0] : f.type === 'vector3' ? `0 0 0 ${f.unit || 'mm'}` : f.type === 'double' ? `0 ${f.unit || ''}`.trim() : ''
        return { key: k, value: v }
      })
    }
    touch([...blocks, b]); setSelIdx(blocks.length)
  }
  const removeBlock = (i) => { const nb = blocks.filter((_, j) => j !== i); touch(nb); setSelIdx(-1) }

  const setField = (key, value) => {
    if (!sel) return
    const nb = blocks.map((b, i) => {
      if (i !== selIdx) return b
      const copy = { ...b, params: b.params.map((p) => ({ ...p })) }
      if (value === '') copy.params = copy.params.filter((p) => p.key !== key)
      else setParam(copy, key, value)
      return copy
    })
    touch(nb)
  }

  // mother/daughter tree of Volume blocks
  const tree = useMemo(() => {
    const vols = blocks.map((b, i) => ({ b, i })).filter((x) => x.b.type === 'Volume')
    const byName = Object.fromEntries(vols.map((x) => [x.b.arg, x]))
    const childrenOf = {}
    const roots = []
    for (const x of vols) {
      const m = getParam(x.b, 'Mother')
      if (m && m !== 'world' && byName[m]) (childrenOf[m] = childrenOf[m] || []).push(x)
      else roots.push(x)
    }
    const flat = []
    const walk = (x, depth) => { flat.push({ ...x, depth }); (childrenOf[x.b.arg] || []).forEach((c) => walk(c, depth + 1)) }
    roots.forEach((r) => walk(r, 0))
    return flat
  }, [blocks])
  const others = blocks.map((b, i) => ({ b, i })).filter((x) => x.b.type !== 'Volume')

  const catalogTypes = useMemo(() => {
    if (!catalog) return []
    return Object.entries(catalog.detectors)
      .filter(([k, v]) => v.simulation && k !== 'Volume' && k !== 'Solid')
      .map(([k]) => k).sort()
  }, [catalog])

  const S = {
    col: { display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 },
    box: { background: 'var(--surface,#fff)', border: '1px solid var(--border-default,#ddd)', borderRadius: 10, padding: 10, overflow: 'auto' },
    btn: { padding: '4px 10px', fontSize: 12, border: '1px solid var(--border-default,#ccc)', borderRadius: 7, background: 'var(--surface,#fff)', cursor: 'pointer' },
    btnP: { padding: '4px 12px', fontSize: 12, border: 'none', borderRadius: 7, background: 'var(--accent,#7c5cbf)', color: '#fff', cursor: 'pointer', fontWeight: 600 },
    row: (active) => ({ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 7px', borderRadius: 6, cursor: 'pointer', fontSize: 13, background: active ? 'var(--accent-soft,#efe9fb)' : 'transparent' }),
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr 320px', gap: 10, height: '100%', padding: 10, boxSizing: 'border-box' }}>
      {/* ── left: documents + block tree ── */}
      <div style={S.col}>
        <div style={{ ...S.box, flex: '0 0 auto', maxHeight: '38%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <b style={{ fontSize: 13 }}>지오메트리</b>
            <button style={S.btn} onClick={() => setNewName(newName === null ? '' : null)}>+ 새로</button>
          </div>
          {newName !== null && (
            <div style={{ display: 'flex', gap: 5, marginBottom: 6 }}>
              <input autoFocus style={{ flex: 1, padding: '4px 8px', fontSize: 12, border: '1px solid var(--border-default,#ccc)', borderRadius: 6 }}
                placeholder="이름 (영문/숫자/_/-)" value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') newDoc(); if (e.key === 'Escape') setNewName(null) }} />
              <button style={S.btnP} onClick={newDoc}>생성</button>
            </div>
          )}
          {docs.map((d) => (
            <div key={d.name} style={S.row(d.name === docName)} onClick={() => openDoc(d.name)}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</span>
              <span style={{ fontSize: 11, opacity: 0.6 }}>{d.volumes}V {d.solids}S</span>
              <button title={d.applied ? 'detector.txt에서 제거' : 'detector.txt에 적용'} style={{ ...S.btn, padding: '1px 7px', background: d.applied ? 'var(--accent,#7c5cbf)' : 'var(--surface,#fff)', color: d.applied ? '#fff' : 'inherit' }}
                onClick={(e) => { e.stopPropagation(); applyDoc(d.name, d.applied) }}>{d.applied ? '적용됨' : '적용'}</button>
              {pendingDel === d.name
                ? <button style={{ ...S.btn, padding: '1px 7px', color: '#dc2626', fontWeight: 700 }} onClick={(e) => { e.stopPropagation(); removeDoc(d.name); setPendingDel('') }}>확인</button>
                : <button style={{ ...S.btn, padding: '1px 7px' }} onClick={(e) => { e.stopPropagation(); setPendingDel(d.name); setTimeout(() => setPendingDel(''), 2500) }}>✕</button>}
            </div>
          ))}
          {!docs.length && <div style={{ fontSize: 12, opacity: 0.6 }}>아직 없음 — "새로"로 시작</div>}
        </div>

        <div style={{ ...S.box, flex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <b style={{ fontSize: 13 }}>블록 {docName && <span style={{ fontWeight: 400, opacity: 0.65 }}>— {docName}{dirty ? ' *' : ''}</span>}</b>
          </div>
          {tree.map(({ b, i, depth }) => (
            <div key={i} style={{ ...S.row(i === selIdx), paddingLeft: 7 + depth * 14 }} onClick={() => setSelIdx(i)}>
              <span style={{ opacity: 0.55, fontSize: 11 }}>{depth > 0 ? '└' : '■'}</span>
              <span style={{ flex: 1 }}>{b.arg}</span>
              {getParam(b, 'Scorer') && <span title="scorer" style={{ fontSize: 10, background: '#e8f6ec', color: '#1d7a3c', borderRadius: 4, padding: '0 4px' }}>S</span>}
              <button style={{ ...S.btn, padding: '0 6px', fontSize: 11 }} onClick={(e) => { e.stopPropagation(); removeBlock(i) }}>✕</button>
            </div>
          ))}
          {others.map(({ b, i }) => (
            <div key={i} style={S.row(i === selIdx)} onClick={() => setSelIdx(i)}>
              <span style={{ opacity: 0.55, fontSize: 11 }}>{b.type === 'Solid' ? '◇' : '⬡'}</span>
              <span style={{ flex: 1 }}>{b.type === 'Solid' ? `${b.arg}` : `${b.type} ${b.arg}`.trim()}</span>
              <span style={{ fontSize: 10, opacity: 0.5 }}>{b.type === 'Solid' ? getParam(b, 'Type') : '검출기'}</span>
              <button style={{ ...S.btn, padding: '0 6px', fontSize: 11 }} onClick={(e) => { e.stopPropagation(); removeBlock(i) }}>✕</button>
            </div>
          ))}
          {docName && (
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <select style={{ flex: 1, fontSize: 12, padding: 3, borderRadius: 6, border: '1px solid var(--border-default,#ccc)' }} value={addSel} onChange={(e) => setAddSel(e.target.value)}>
                <option value="Volume">Volume (스크립트 볼륨)</option>
                <option value="Solid">Solid (재사용/Boolean)</option>
                <optgroup label="정의된 검출기 (카탈로그)">
                  {catalogTypes.map((k) => <option key={k} value={k}>{k}</option>)}
                </optgroup>
              </select>
              <button style={S.btn} onClick={addBlock}>추가</button>
            </div>
          )}
        </div>
      </div>

      {/* ── center: preview + actions + report ── */}
      <div style={S.col}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: '0 0 auto' }}>
          <button style={S.btnP} disabled={!docName || busy} onClick={saveDoc}>{dirty ? '저장 *' : '저장'}</button>
          <button style={{ ...S.btnP, background: '#2a7d46' }} disabled={!blocks.length || !!busy} onClick={validate}>
            {busy === 'validate' ? 'Geant4 실행 중…' : 'Geant4 검증'}
          </button>
          {validated && <button style={S.btn} onClick={() => { setValidated(null) }}>라이브 미리보기로</button>}
          <button title="켜면 3D에서 볼륨을 클릭해 선택하고, 선택된 Volume을 기즈모로 끌어 옮길 수 있습니다 (POS 자동 반영)"
            style={{ ...S.btn, background: editMode ? 'var(--accent,#7c5cbf)' : 'var(--surface,#fff)', color: editMode ? '#fff' : 'inherit', fontWeight: 600 }}
            onClick={() => setEditMode((v) => !v)}>🖱 편집 {editMode ? 'ON' : 'OFF'}</button>
          {editMode && (
            <span style={{ display: 'inline-flex', gap: 2 }}>
              {[['translate', '이동'], ['rotate', '회전']].map(([m, label]) => (
                <button key={m} style={{ ...S.btn, padding: '3px 9px',
                  background: gizmoMode === m ? 'var(--accent,#7c5cbf)' : 'var(--surface,#fff)',
                  color: gizmoMode === m ? '#fff' : 'inherit' }}
                  onClick={() => setGizmoMode(m)}>{label}</button>
              ))}
            </span>
          )}
          <span style={{ fontSize: 12, opacity: 0.7 }}>
            {editMode ? `편집 모드 — 클릭=선택, 드래그=${gizmoMode === 'rotate' ? '회전 (RotateXYZ 반영)' : '이동 (POS 반영)'}` :
              validated ? '검증된 지오메트리 (Geant4가 만든 정확한 형상)' : '라이브 미리보기 — 점선/주황 = 근사 (검증 후 정확 표시)'}
          </span>
          {err && <span style={{ color: '#dc2626', fontSize: 12, fontWeight: 600 }}>{err}</span>}
        </div>
        <div style={{ flex: 1, minHeight: 0, border: '1px solid var(--border-default,#ddd)', borderRadius: 10, overflow: 'hidden', position: 'relative' }}>
          {/* Canvas must not initialize inside the hidden (display:none) tab */}
          {active && (
            <Suspense fallback={<div style={{ padding: 20, fontSize: 13, opacity: 0.6 }}>3D 뷰어 로딩…</div>}>
              <Viewer geometry={scene} event={EMPTY_EVENT} styles={viewStyles} hidden={NO_HIDDEN}
                show={{ tracks: false, edep: false, axes: true, pointSize: 0.5 }}
                controlsRef={controlsRef} onPick={pickHandler} transform={transformSpec} />
            </Suspense>
          )}
        </div>
        {report && (
          <div style={{ ...S.box, flex: '0 0 auto', maxHeight: 170, borderLeft: `5px solid ${report.ok ? '#2a7d46' : '#dc2626'}` }}>
            <b style={{ fontSize: 13, color: report.ok ? '#2a7d46' : '#dc2626' }}>
              {report.ok ? '✓ 지오메트리 정상 (겹침 없음)' : '문제 발견'}
            </b>
            {report.errors.map((e, i) => <div key={'e' + i} style={{ fontSize: 12, color: '#dc2626', fontFamily: 'monospace' }}>{e}</div>)}
            {report.overlaps.slice(0, 12).map((o, i) => <div key={'o' + i} style={{ fontSize: 12, color: '#b45309', fontFamily: 'monospace' }}>{o}</div>)}
            {!!report.overlaps.length && <div style={{ fontSize: 11, opacity: 0.6 }}>겹침 관련 {report.overlaps.length}줄</div>}
          </div>
        )}
      </div>

      {/* ── right: block form + help ── */}
      <div style={S.col}>
        <div style={{ ...S.box, flex: 1 }}>
          {!sel && <div style={{ fontSize: 13, opacity: 0.6 }}>블록을 선택하거나 추가하세요.<br /><br />
            · <b>Volume</b>: solid + material + 배치 (mother/daughter)<br />
            · <b>Solid</b>: 이름 붙은 형상 — Boolean(A−B 등)과 재사용<br />
            · <b>정의된 검출기</b>: STARK 등 카탈로그 검출기 블록</div>}
          {sel && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <b style={{ fontSize: 14 }}>{sel.type}</b>
                {(sel.type === 'Volume' || sel.type === 'Solid') && (
                  <input style={{ flex: 1, padding: '4px 8px', fontSize: 13, border: '1px solid var(--border-default,#ccc)', borderRadius: 6 }}
                    value={sel.arg} onChange={(e) => { const nb = blocks.map((b, i) => i === selIdx ? { ...b, arg: e.target.value.replace(/\s+/g, '_') } : b); touch(nb) }} />
                )}
              </div>
              {schema?.description && <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10, lineHeight: 1.45 }}>{schema.description}</div>}
              {schema && Object.entries(schema.fields)
                .sort(([, a], [, b]) => (a.optional === false ? 0 : 1) - (b.optional === false ? 0 : 1))
                .map(([name, spec]) => (
                  <Field key={name} name={name} spec={spec} value={getParam(sel, name)}
                    onChange={(v) => setField(name, v)} materials={materials}
                    onHelp={(n, s) => setHelp({ name: n, text: s.description || '(설명 없음)' })} />
                ))}
              {!schema && <div style={{ fontSize: 12, color: '#b45309' }}>카탈로그에 스키마가 없는 블록입니다 — 텍스트로만 편집됩니다.</div>}
              {!schema && sel.params.map((p, k) => (
                <Field key={k} name={p.key} spec={{}} value={p.value} onChange={(v) => setField(p.key, v)} materials={materials} onHelp={() => {}} />
              ))}
            </>
          )}
        </div>
        <div style={{ ...S.box, flex: '0 0 auto', minHeight: 84, background: 'var(--surface-sunken,#f6f7fb)' }}>
          <b style={{ fontSize: 12, opacity: 0.75 }}>{help ? help.name : '필드 설명'}</b>
          <div style={{ fontSize: 12, lineHeight: 1.5, marginTop: 3 }}>
            {help ? help.text : '필드에 마우스를 올리거나 포커스하면 자세한 설명이 여기 표시됩니다.'}
          </div>
        </div>
      </div>
    </div>
  )
}

function uniqueName(prefix, blocks) {
  const used = new Set(blocks.map((b) => b.arg))
  for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`
}
