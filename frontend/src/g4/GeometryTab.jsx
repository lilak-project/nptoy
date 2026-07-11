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
import { Stack, TreeStructure, SlidersHorizontal, Flask } from '@phosphor-icons/react'
import {
  geomCatalog, geomMaterials, geomDocs, geomDocGet, geomDocPut, geomDocDelete,
  geomDocRename, geomApply, geomRemove, geomValidate, geomMatFileGet, geomMatFilePut,
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

// ── materials panel: browse the library, define workspace materials ───────────
// Workspace definitions live in inputs/materials.txt (same NPL block syntax as
// the shipped library); npsimulation overlays them at run/validate time, so a
// saved material is immediately usable as a Volume's Material=.
const MAT_EMPTY = { name: '', density: '', unit: 'g/cm3', state: 'Solid',
  temperature: '293.15', pressure: '1', mode: 'Counts', rows: [{ el: '', v: '' }] }

function matFormFromBlock(b) {
  const den = String(getParam(b, 'Density') || '').trim().split(/\s+/)
  const mode = getParam(b, 'MassFractions') ? 'MassFractions' : 'Counts'
  const els = String(getParam(b, 'Elements') || '').trim().split(/\s+/).filter(Boolean)
  const vals = String(getParam(b, mode) || '').trim().split(/\s+/).filter(Boolean)
  return {
    name: b.arg, density: den[0] || '', unit: den[1] || 'g/cm3',
    state: getParam(b, 'State') || 'Solid',
    temperature: (String(getParam(b, 'Temperature')).trim().split(/\s+/)[0]) || '293.15',
    pressure: (String(getParam(b, 'Pressure')).trim().split(/\s+/)[0]) || '1',
    mode, rows: els.length ? els.map((el, i) => ({ el, v: vals[i] || '' })) : [{ el: '', v: '' }],
  }
}

function matBlockText(f) {
  const rows = f.rows.filter((r) => r.el.trim())
  const lines = [`Material ${f.name.trim()}`]
  if (f.density.trim()) lines.push(` Density= ${f.density.trim()} ${f.unit}`)
  if (f.state !== 'Solid') lines.push(` State= ${f.state}`)
  if (f.state === 'Gas') {
    lines.push(` Temperature= ${f.temperature || '293.15'} kelvin`)
    lines.push(` Pressure= ${f.pressure || '1'} bar`)
  }
  lines.push(` Elements= ${rows.map((r) => r.el.trim()).join(' ')}`)
  lines.push(` ${f.mode}= ${rows.map((r) => r.v.trim() || '0').join(' ')}`)
  return lines.join('\n')
}

function MaterialsPanel({ materials, matText, onSave, S }) {
  const [q, setQ] = useState('')
  const [form, setForm] = useState(null) // null = list only
  const [msg, setMsg] = useState('')
  const wsNames = useMemo(() => new Set(parseDetector(matText).filter((b) => b.type === 'Material').map((b) => b.arg)), [matText])
  const list = materials.filter((m) => !q || m.name.toLowerCase().includes(q.toLowerCase())
    || (m.aliases || []).some((a) => a.toLowerCase().includes(q.toLowerCase())))

  const save = async () => {
    setMsg('')
    const f = form
    if (!/^[A-Za-z0-9_.\-]{1,48}$/.test(f.name.trim())) return setMsg('이름: 영문/숫자/_/-/. 1-48자')
    const rows = f.rows.filter((r) => r.el.trim())
    if (!rows.length) return setMsg('원소를 최소 1개 입력하세요')
    if (!f.density.trim() && !(f.state === 'Gas' && f.mode === 'Counts')) return setMsg('밀도가 필요합니다 (가스+원자수 조합만 자동 계산)')
    if (f.mode === 'MassFractions') {
      const sum = rows.reduce((s, r) => s + (+r.v || 0), 0)
      if (Math.abs(sum - 1) > 1e-3) return setMsg(`질량분율 합이 ${sum.toFixed(4)} — 1이 되어야 합니다`)
    }
    // replace-or-append the block in the workspace file
    const blocks = parseDetector(matText).filter((b) => !(b.type === 'Material' && b.arg === f.name.trim()))
    const kept = serializeDetector(blocks).trim()
    const next = (kept ? kept + '\n\n' : '') + matBlockText(f) + '\n'
    await onSave(next)
    setForm(null)
  }
  const del = async (name) => {
    const blocks = parseDetector(matText).filter((b) => !(b.type === 'Material' && b.arg === name))
    await onSave(blocks.length ? serializeDetector(blocks) : '')
  }
  const inp = { width: '100%', boxSizing: 'border-box', padding: '4px 7px', fontSize: 12,
    border: '1px solid var(--border-default,#ccc)', borderRadius: 6, background: 'var(--surface,#fff)' }

  if (form) return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <b style={{ fontSize: 13 }}>{wsNames.has(form.name) ? '재료 편집' : '새 재료'}</b>
        <button style={S.btn} onClick={() => setForm(null)}>목록으로</button>
      </div>
      <label style={{ fontSize: 12, fontWeight: 600 }}>이름</label>
      <input style={{ ...inp, marginBottom: 6 }} value={form.name} placeholder="MyScint"
        onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <label style={{ fontSize: 12, fontWeight: 600 }}
        title="가스에서 원자수 조성일 때만 비워도 됩니다 (몰질량+이상기체로 자동 계산)">밀도</label>
      <div style={{ display: 'flex', gap: 5, marginBottom: 6 }}>
        <input style={{ ...inp, flex: 1, minWidth: 0 }} value={form.density} placeholder="1.15"
          onChange={(e) => setForm({ ...form, density: e.target.value })} />
        <select style={{ ...inp, width: 90 }} value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}>
          {['g/cm3', 'mg/cm3', 'kg/m3'].map((u) => <option key={u}>{u}</option>)}
        </select>
      </div>
      <label style={{ fontSize: 12, fontWeight: 600 }}>상태</label>
      <select style={{ ...inp, marginBottom: 6 }} value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })}>
        <option>Solid</option><option>Gas</option><option>Liquid</option>
      </select>
      {form.state === 'Gas' && (
        <div style={{ display: 'flex', gap: 5, marginBottom: 6 }}>
          <span style={{ flex: 1 }}>
            <label style={{ fontSize: 11, fontWeight: 600 }}>온도 (K)</label>
            <input style={inp} value={form.temperature} onChange={(e) => setForm({ ...form, temperature: e.target.value })} />
          </span>
          <span style={{ flex: 1 }}>
            <label style={{ fontSize: 11, fontWeight: 600 }}>압력 (bar)</label>
            <input style={inp} value={form.pressure} onChange={(e) => setForm({ ...form, pressure: e.target.value })} />
          </span>
        </div>
      )}
      <label style={{ fontSize: 12, fontWeight: 600 }}
        title="원자 개수 = 분자식 (C 10, H 8 = C10H8) / 질량 분율 = 합이 1이 되는 비율">조성</label>
      <select style={{ ...inp, marginBottom: 6 }} value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
        <option value="Counts">원자 개수 (분자)</option>
        <option value="MassFractions">질량 분율 (합=1)</option>
      </select>
      {form.rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 5, marginBottom: 4 }}>
          <input style={{ ...inp, width: 74 }} value={r.el} placeholder="C, H, Li6…"
            onChange={(e) => setForm({ ...form, rows: form.rows.map((x, j) => j === i ? { ...x, el: e.target.value } : x) })} />
          <input style={{ ...inp, flex: 1, minWidth: 0 }} value={r.v} placeholder={form.mode === 'Counts' ? '개수' : '분율'}
            onChange={(e) => setForm({ ...form, rows: form.rows.map((x, j) => j === i ? { ...x, v: e.target.value } : x) })} />
          <button style={{ ...S.btn, padding: '0 7px' }} onClick={() => setForm({ ...form, rows: form.rows.filter((_, j) => j !== i) })}>✕</button>
        </div>
      ))}
      <button style={{ ...S.btn, width: '100%', marginBottom: 8 }}
        onClick={() => setForm({ ...form, rows: [...form.rows, { el: '', v: '' }] })}>+ 원소</button>
      {msg && <div style={{ fontSize: 12, color: '#dc2626', marginBottom: 6 }}>{msg}</div>}
      <button style={{ ...S.btnP, width: '100%' }} onClick={save}>저장 → materials.txt</button>
      <div style={{ fontSize: 11, opacity: 0.65, marginTop: 6, lineHeight: 1.5 }}>
        저장하면 워크스페이스 materials.txt에 기록되어 시뮬레이션/검증에서 바로 쓸 수 있고,
        Volume의 Material= 자동완성에도 나타납니다. 같은 이름은 라이브러리 정의를 덮어씁니다.
      </div>
    </div>
  )

  return (
    <div>
      <div style={{ display: 'flex', gap: 5, marginBottom: 8 }}>
        <input style={{ ...inp, flex: 1, minWidth: 0 }} placeholder="검색…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button style={S.btnP} onClick={() => setForm({ ...MAT_EMPTY })}>+ 새 재료</button>
      </div>
      {list.map((m) => {
        const ws = m.origin === 'workspace'
        return (
          <div key={m.name} style={S.row(false)} title={(m.aliases || []).join(' ')}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</span>
            <span style={{ fontSize: 10.5, opacity: 0.6 }}>{m.density || ''}</span>
            {ws && <span style={{ fontSize: 10, background: 'var(--accent-soft,#efe9fb)', color: 'var(--accent,#7c5cbf)', borderRadius: 4, padding: '0 4px', fontWeight: 700 }}>내 재료</span>}
            {ws ? (<>
              <button style={{ ...S.btn, padding: '0 6px', fontSize: 11 }} title="편집"
                onClick={() => setForm(matFormFromBlock(parseDetector(matText).find((b) => b.type === 'Material' && b.arg === m.name)))}>✎</button>
              <button style={{ ...S.btn, padding: '0 6px', fontSize: 11 }} title="삭제" onClick={() => del(m.name)}>✕</button>
            </>) : (
              <button style={{ ...S.btn, padding: '0 6px', fontSize: 11 }} title="이 정의를 바탕으로 새 재료 만들기"
                onClick={() => setForm({ ...MAT_EMPTY, name: m.name + '_mod', density: (m.density || '').split(/\s+/)[0] || '',
                  unit: (m.density || '').split(/\s+/)[1] || 'g/cm3', state: m.state || 'Solid',
                  rows: (m.elements || ['']).map((el) => ({ el, v: '' })) })}>⧉</button>
            )}
          </div>
        )
      })}
      {!list.length && <div style={{ fontSize: 12, opacity: 0.6 }}>검색 결과 없음</div>}
    </div>
  )
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

  // dock panels (left icon rail, like the other tabs); open ones stack left→right
  const PANELS = [
    { key: 'docs', label: '지오메트리', Icon: Stack },
    { key: 'blocks', label: '블록', Icon: TreeStructure },
    { key: 'props', label: '속성', Icon: SlidersHorizontal },
    { key: 'materials', label: '재료', Icon: Flask },
  ]
  const [open, setOpen] = useState({ docs: true, blocks: true, props: false, materials: false })
  const [matText, setMatText] = useState('')   // workspace materials.txt (raw)
  const saveMatFile = async (content) => {
    await geomMatFilePut(content)
    setMatText(content)
    geomMaterials().then((d) => setMaterials(d.materials)).catch(() => {})
  }
  const togglePanel = (key) => setOpen((o) => ({ ...o, [key]: !o[key] }))
  const openPanels = PANELS.filter((p) => open[p.key])
  // selecting a block opens the property panel (still closable by hand)
  const selectBlock = (i) => { setSelIdx(i); if (i >= 0) setOpen((o) => (o.props ? o : { ...o, props: true })) }

  const refreshDocs = async () => setDocs((await geomDocs()).docs)
  useEffect(() => {
    geomCatalog().then(setCatalog).catch((e) => setErr(String(e.message || e)))
    geomMaterials().then((d) => setMaterials(d.materials)).catch(() => {})
    geomMatFileGet().then((d) => setMatText(d.content)).catch(() => {})
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
    if (i >= 0) selectBlock(i)
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
    touch([...blocks, b]); selectBlock(blocks.length)
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
    <div style={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
      {/* ── full-bleed 3D preview (canvas must not init inside the hidden tab) ── */}
      <div style={{ position: 'absolute', inset: 0 }}>
        {active && (
          <Suspense fallback={<div style={{ padding: 20, fontSize: 13, opacity: 0.6 }}>3D 뷰어 로딩…</div>}>
            <Viewer geometry={scene} event={EMPTY_EVENT} styles={viewStyles} hidden={NO_HIDDEN}
              show={{ tracks: false, edep: false, axes: true, pointSize: 0.5 }}
              controlsRef={controlsRef} onPick={pickHandler} transform={transformSpec} />
          </Suspense>
        )}
      </div>

      {/* ── floating action bar (top-right) ── */}
      <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 3, display: 'flex', gap: 6, alignItems: 'center',
        padding: '7px 9px', borderRadius: 12, border: '1px solid rgba(var(--glass-rgb,255,255,255),0.6)',
        background: 'rgba(var(--glass-rgb,255,255,255),0.45)', backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)', boxShadow: 'var(--shadow)' }}>
        <button style={S.btnP} disabled={!docName || !!busy} onClick={saveDoc}>{dirty ? '저장 *' : '저장'}</button>
        <button style={{ ...S.btnP, background: '#2a7d46' }} disabled={!blocks.length || !!busy} onClick={validate}>
          {busy === 'validate' ? 'Geant4 실행 중…' : 'Geant4 검증'}
        </button>
        {validated && <button style={S.btn} onClick={() => { setValidated(null) }}>라이브로</button>}
        <button title="켜면 3D에서 볼륨을 클릭해 선택하고, 선택된 Volume을 기즈모로 끌어 옮기거나 돌릴 수 있습니다 (POS/RotateXYZ 자동 반영)"
          style={{ ...S.btn, background: editMode ? 'var(--accent,#7c5cbf)' : 'var(--surface,#fff)', color: editMode ? '#fff' : 'inherit', fontWeight: 600 }}
          onClick={() => setEditMode((v) => !v)}>🖱 편집 {editMode ? 'ON' : 'OFF'}</button>
        {editMode && [['translate', '이동'], ['rotate', '회전']].map(([m, label]) => (
          <button key={m} style={{ ...S.btn, padding: '3px 9px',
            background: gizmoMode === m ? 'var(--accent,#7c5cbf)' : 'var(--surface,#fff)',
            color: gizmoMode === m ? '#fff' : 'inherit' }}
            onClick={() => setGizmoMode(m)}>{label}</button>
        ))}
      </div>
      {/* status hint under the action bar */}
      <div style={{ position: 'absolute', top: 56, right: 12, zIndex: 3, fontSize: 11.5,
        padding: '3px 9px', borderRadius: 8, background: 'rgba(var(--glass-rgb,255,255,255),0.55)',
        backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)', color: err ? '#dc2626' : 'inherit',
        fontWeight: err ? 600 : 400, opacity: 0.9 }}>
        {err || (editMode ? `편집 모드 — 클릭=선택, 드래그=${gizmoMode === 'rotate' ? '회전 (RotateXYZ 반영)' : '이동 (POS 반영)'}`
          : validated ? '검증된 지오메트리 (Geant4가 만든 정확한 형상)' : '라이브 미리보기 — 점선/주황 = 근사 (검증 후 정확 표시)')}
      </div>

      {/* ── left icon rail: click to open/close the dock panels ── */}
      <div className="simrail">
        {PANELS.map(({ key, label, Icon }) => (
          <button key={key} title={label} className={`railbtn ${open[key] ? 'on' : ''}`} onClick={() => togglePanel(key)}>
            <Icon size={20} weight={open[key] ? 'fill' : 'regular'} /><span>{label}</span>
          </button>
        ))}
      </div>

      {/* ── open panels, attached to the left in rail order ── */}
      {openPanels.map(({ key, label }, idx) => (
        <div key={key} className="simpanel" style={{ left: 86 + idx * 296, width: 284 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '9px 12px 7px', borderBottom: '1px solid var(--line, #e2e2e8)', flex: '0 0 auto' }}>
            <b style={{ fontSize: 13 }}>
              {key === 'blocks' && docName ? <>블록 <span style={{ fontWeight: 400, opacity: 0.65 }}>— {docName}{dirty ? ' *' : ''}</span></> : label}
            </b>
            <button style={{ ...S.btn, padding: '0 7px', border: 'none', background: 'transparent', fontSize: 13 }}
              onClick={() => togglePanel(key)}>✕</button>
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: 10 }}>

            {key === 'docs' && (<>
              <button style={{ ...S.btn, width: '100%', marginBottom: 6 }} onClick={() => setNewName(newName === null ? '' : null)}>+ 새로</button>
              {newName !== null && (
                <div style={{ display: 'flex', gap: 5, marginBottom: 6 }}>
                  <input autoFocus style={{ flex: 1, minWidth: 0, padding: '4px 8px', fontSize: 12, border: '1px solid var(--border-default,#ccc)', borderRadius: 6 }}
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
            </>)}

            {key === 'blocks' && (<>
              {tree.map(({ b, i, depth }) => (
                <div key={i} style={{ ...S.row(i === selIdx), paddingLeft: 7 + depth * 14 }} onClick={() => selectBlock(i)}>
                  <span style={{ opacity: 0.55, fontSize: 11 }}>{depth > 0 ? '└' : '■'}</span>
                  <span style={{ flex: 1 }}>{b.arg}</span>
                  {getParam(b, 'Scorer') && <span title="scorer" style={{ fontSize: 10, background: '#e8f6ec', color: '#1d7a3c', borderRadius: 4, padding: '0 4px' }}>S</span>}
                  <button style={{ ...S.btn, padding: '0 6px', fontSize: 11 }} onClick={(e) => { e.stopPropagation(); removeBlock(i) }}>✕</button>
                </div>
              ))}
              {others.map(({ b, i }) => (
                <div key={i} style={S.row(i === selIdx)} onClick={() => selectBlock(i)}>
                  <span style={{ opacity: 0.55, fontSize: 11 }}>{b.type === 'Solid' ? '◇' : '⬡'}</span>
                  <span style={{ flex: 1 }}>{b.type === 'Solid' ? `${b.arg}` : `${b.type} ${b.arg}`.trim()}</span>
                  <span style={{ fontSize: 10, opacity: 0.5 }}>{b.type === 'Solid' ? getParam(b, 'Type') : '검출기'}</span>
                  <button style={{ ...S.btn, padding: '0 6px', fontSize: 11 }} onClick={(e) => { e.stopPropagation(); removeBlock(i) }}>✕</button>
                </div>
              ))}
              {docName && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <select style={{ flex: 1, minWidth: 0, fontSize: 12, padding: 3, borderRadius: 6, border: '1px solid var(--border-default,#ccc)' }} value={addSel} onChange={(e) => setAddSel(e.target.value)}>
                    <option value="Volume">Volume (스크립트 볼륨)</option>
                    <option value="Solid">Solid (재사용/Boolean)</option>
                    <optgroup label="정의된 검출기 (카탈로그)">
                      {catalogTypes.map((k) => <option key={k} value={k}>{k}</option>)}
                    </optgroup>
                  </select>
                  <button style={S.btn} onClick={addBlock}>추가</button>
                </div>
              )}
              {!docName && <div style={{ fontSize: 12, opacity: 0.6 }}>지오메트리를 먼저 선택하세요.</div>}
            </>)}

            {key === 'materials' && (
              <MaterialsPanel materials={materials} matText={matText} onSave={saveMatFile} S={S} />
            )}

            {key === 'props' && (<>
              {!sel && <div style={{ fontSize: 13, opacity: 0.6 }}>블록을 선택하거나 추가하세요.<br /><br />
                · <b>Volume</b>: solid + material + 배치 (mother/daughter)<br />
                · <b>Solid</b>: 이름 붙은 형상 — Boolean(A−B 등)과 재사용<br />
                · <b>정의된 검출기</b>: STARK 등 카탈로그 검출기 블록</div>}
              {sel && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <b style={{ fontSize: 14 }}>{sel.type}</b>
                    {(sel.type === 'Volume' || sel.type === 'Solid') && (
                      <input style={{ flex: 1, minWidth: 0, padding: '4px 8px', fontSize: 13, border: '1px solid var(--border-default,#ccc)', borderRadius: 6 }}
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
            </>)}
          </div>

          {key === 'props' && (
            <div style={{ flex: '0 0 auto', padding: '8px 12px', borderTop: '1px solid var(--line, #e2e2e8)', minHeight: 64,
              background: 'rgba(var(--glass-rgb,255,255,255),0.35)' }}>
              <b style={{ fontSize: 12, opacity: 0.75 }}>{help ? help.name : '필드 설명'}</b>
              <div style={{ fontSize: 12, lineHeight: 1.5, marginTop: 3 }}>
                {help ? help.text : '필드에 마우스를 올리거나 포커스하면 자세한 설명이 여기 표시됩니다.'}
              </div>
            </div>
          )}
        </div>
      ))}

      {/* ── validation report — floating bottom-right ── */}
      {report && (
        <div style={{ position: 'absolute', right: 12, bottom: 12, zIndex: 3, maxWidth: 520, maxHeight: 180, overflow: 'auto',
          ...S.box, borderLeft: `5px solid ${report.ok ? '#2a7d46' : '#dc2626'}`,
          background: 'rgba(var(--glass-rgb,255,255,255),0.7)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
          <b style={{ fontSize: 13, color: report.ok ? '#2a7d46' : '#dc2626' }}>
            {report.ok ? '✓ 지오메트리 정상 (겹침 없음)' : '문제 발견'}
          </b>
          {report.errors.map((e, i) => <div key={'e' + i} style={{ fontSize: 12, color: '#dc2626', fontFamily: 'monospace' }}>{e}</div>)}
          {report.overlaps.slice(0, 12).map((o, i) => <div key={'o' + i} style={{ fontSize: 12, color: '#b45309', fontFamily: 'monospace' }}>{o}</div>)}
          {!!report.overlaps.length && <div style={{ fontSize: 11, opacity: 0.6 }}>겹침 관련 {report.overlaps.length}줄</div>}
        </div>
      )}
    </div>
  )
}

function uniqueName(prefix, blocks) {
  const used = new Set(blocks.map((b) => b.arg))
  for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`
}
