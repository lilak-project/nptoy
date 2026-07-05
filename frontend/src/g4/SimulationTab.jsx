import React, { useEffect, useMemo, useRef, useState, Suspense, lazy } from 'react'
import { Gauge, Terminal, Stack, SlidersHorizontal, Path, Play, Stop, Lightning } from '@phosphor-icons/react'
import { ColorPicker } from 'lilak-ui'
import Session from './Session.jsx'
import StylePresets from './StylePresets.jsx'

// [r,g,b] 0..1 → #hex, with an optional darken factor (matches the wireframe
// render: default material colour is darkened ×0.7 so it reads on white).
const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')
const rgbHex = (c, k = 1) => '#' + hex2((c[0] || 0) * k) + hex2((c[1] || 0) * k) + hex2((c[2] || 0) * k)

const PANELS = [
  { key: 'status', label: 'status', Icon: Gauge },
  { key: 'session', label: 'session', Icon: Terminal },
  { key: 'volumes', label: 'volumes', Icon: Stack },
  { key: 'tracks', label: 'tracks', Icon: Path },
  { key: 'display', label: 'display', Icon: SlidersHorizontal },
]

// A few common PDG codes → readable particle labels; nptool ions use the
// ±10LZZZAAAI convention, decoded to A + element symbol (e.g. 1000020040 → 4He).
const PDG_SIMPLE = {
  2212: 'p', 2112: 'n', 11: 'e⁻', '-11': 'e⁺', 22: 'γ', '-22': 'optical photon',
  211: 'π⁺', '-211': 'π⁻', 111: 'π⁰', 13: 'μ⁻', '-13': 'μ⁺',
}
// symbol by Z (index 0 = neutron); full-ish table so recoils in heavy detector
// materials (e.g. Cs/I in the CsI crystals) get a proper name, not "Z55".
const ELEM = ['n',
  'H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne',
  'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca',
  'Sc', 'Ti', 'V', 'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn',
  'Ga', 'Ge', 'As', 'Se', 'Br', 'Kr', 'Rb', 'Sr', 'Y', 'Zr',
  'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd', 'In', 'Sn',
  'Sb', 'Te', 'I', 'Xe', 'Cs', 'Ba', 'La', 'Ce', 'Pr', 'Nd',
  'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb',
  'Lu', 'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg',
  'Tl', 'Pb', 'Bi', 'Po', 'At', 'Rn', 'Fr', 'Ra', 'Ac', 'Th',
  'Pa', 'U', 'Np', 'Pu', 'Am', 'Cm', 'Bk', 'Cf']
function pdgName(pdg) {
  if (PDG_SIMPLE[pdg] != null) return PDG_SIMPLE[pdg]
  const a = Math.abs(pdg)
  if (a > 1000000000) {                         // nuclear code 10LZZZAAAI
    const z = Math.floor(a / 10000) % 1000
    const A = Math.floor(a / 10) % 1000
    return `${A}${ELEM[z] || 'Z' + z}`
  }
  return `pdg ${pdg}`
}

// Default per-track colour (hue by index) — mirrors Viewer.trackHue but computed
// here so it doesn't force the lazy three.js Viewer to load with the tab.
function hslHex(h, s, l) {
  const a = s * Math.min(l, 1 - l)
  const ch = (n) => {
    const k = (n + h * 12) % 12
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(255 * c).toString(16).padStart(2, '0')
  }
  return '#' + ch(0) + ch(8) + ch(4)
}
const trackHue = (i) => hslHex((i * 0.137) % 1, 0.75, 0.42)
const trackKey = (t) => `${t.eventID}:${t.trackID}`

// A stable colour per particle species (so every proton shares a colour, etc.) —
// a small fixed palette with a hashed-hue fallback for anything else.
const SPECIES_COLOR = {
  beam: '#d9480f', p: '#1c7ed6', n: '#495057', '4He': '#2f9e44', '12C': '#ae3ec9',
  'γ': '#f08c00', 'e⁻': '#0ca678', 'e⁺': '#e64980', 'π⁺': '#7048e8', 'π⁻': '#5f3dc4',
  'optical photon': '#aeb82e',   // the hashed colour it had before the label was added
}
function hashHue(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0
  return (h % 360) / 360
}
const isBeam = (t) => t.parentID === 0                       // primary particle = the beam
const speciesKey = (t) => (isBeam(t) ? 'beam' : pdgName(t.pdg))
const speciesColor = (sp) => SPECIES_COLOR[sp] || hslHex(hashHue(sp), 0.6, 0.45)
// default line width: all tracks (beam included) start at 1px
const defWidth = () => 1
const defTrackColor = (t) => speciesColor(speciesKey(t))

// three.js + react-three-fiber are ~1MB; load them only when a scene actually
// renders (never on the default Setup tab, which keeps first paint fast).
const Viewer = lazy(() => import('./Viewer.jsx'))
import { fetchJobScene, sessionScene, outputsScene } from './api.js'

const JOB_ID = new URLSearchParams(location.search).get('job')
const RUN_ID = new URLSearchParams(location.search).get('run')
const EMPTY_EVENT = { tracks: [], edep: [], meta: { n_events: 0, n_points: 0, energy_max: 0 } }
const swatch = (c) => (c ? `rgb(${c.map((v) => Math.round(v * 255)).join(',')})` : '#888')

// background/dock colour helpers
function hexToRgbArr(hex) {
  const h = (hex || '#ffffff').replace('#', '')
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [parseInt(n.slice(0, 2), 16) || 0, parseInt(n.slice(2, 4), 16) || 0, parseInt(n.slice(4, 6), 16) || 0]
}
const isDarkHex = (hex) => { const [r, g, b] = hexToRgbArr(hex); return 0.299 * r + 0.587 * g + 0.114 * b < 128 }
const rgbCss = (hex) => hexToRgbArr(hex).join(',')

// Simulation-tab keyboard shortcuts (shown by the ? overlay).
const SHORTCUTS = [
  ['?', '단축키 설명 열기/닫기'],
  ['0', '열린 패널 닫기'],
  ['1', 'status 열기/닫기'],
  ['2', 'session 열기/닫기'],
  ['3', 'volumes 열기/닫기'],
  ['4', 'tracks 열기/닫기'],
  ['5', 'display 열기/닫기'],
  ['space', 'session start / stop'],
  ['enter', 'session run (/run/beamOn)'],
  ['b', '배경 흰색 ↔ 검은색'],
  ['x / y / z', '3D 축 방향으로 보기'],
  ['h', '뷰 방향 초기화 (home)'],
  ['o', '원근 ↔ 직교 전환'],
  ['- / =', '축소 / 확대 (zoom)'],
  ['방향키', '화면 이동 (pan)'],
]

export default function SimulationTab() {
  const [geometry, setGeometry] = useState([])
  const [event, setEvent] = useState(EMPTY_EVENT)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(null)
  const [show, setShow] = useState({ tracks: true, edep: true, axes: false, pointSize: 0.5 })
  const [ortho, setOrtho] = useState(false)   // orthographic (직교) vs perspective camera
  const [glass, setGlass] = useState(0.42)    // dock/panel background opacity
  const [bgColor, setBgColor] = useState('#ffffff')   // 3D background = dock tint colour
  const [clearGlass, setClearGlass] = useState(true)  // true = truly transparent (no blur) — default
  const [helpOpen, setHelpOpen] = useState(false)     // ? shortcuts overlay
  const [sessState, setSessState] = useState({ alive: false, idle: false, state: null, runs: 0 })
  const stageRef = useRef(null)
  const sessionRef = useRef(null)
  const [hidden, setHidden] = useState(() => new Set())
  const [collapsed, setCollapsed] = useState(() => new Set())   // volume tree nodes
  const [active, setActive] = useState(null)        // open dock panel (null = nothing open on entry)
  const [styles, setStyles] = useState({})          // per-name display overrides
  const [styleFor, setStyleFor] = useState(null)    // which name's style editor is open
  const [showPresets, setShowPresets] = useState(false)  // style-preset panel open
  const [trackStyles, setTrackStyles] = useState({})     // per-track overrides (key → {color,width,hidden})
  const [trackGroupStyles, setTrackGroupStyles] = useState({})  // per-group overrides
  const [trackGroup, setTrackGroup] = useState('species')  // 'species' | 'event'
  const [trackCol, setTrackCol] = useState(() => new Set())     // collapsed track groups
  const [trackFor, setTrackFor] = useState(null)         // which track / group editor is open
  const [pointStyle, setPointStyle] = useState({ mode: 'solid', color: '#e5a9a9' })  // bulk edep style
  const [trackPage, setTrackPage] = useState(0)         // which page of tracks is drawn
  const [trackPageSize, setTrackPageSize] = useState(500)  // tracks drawn per page (perf)
  const setTrackStyle = (k, patch) => setTrackStyles((s) => ({ ...s, [k]: { ...s[k], ...patch } }))
  const resetTrack = (k) => setTrackStyles((s) => { const n = { ...s }; delete n[k]; return n })
  const setGroupStyle = (gk, patch) => setTrackGroupStyles((s) => ({ ...s, [gk]: { ...s[gk], ...patch } }))
  const resetGroup = (gk) => setTrackGroupStyles((s) => { const n = { ...s }; delete n[gk]; return n })
  // Solo: show only the given track keys — set individual hidden on every track
  // (preserving colour/width), overriding any group-hide.
  const soloTracks = (keys) => {
    const set = new Set(keys)
    setTrackStyles((s) => {
      const n = { ...s }
      for (const t of event.tracks) {
        const k = trackKey(t)
        n[k] = { ...n[k], hidden: !set.has(k) }
      }
      return n
    })
  }
  // Clear all hide flags (individual + group), keeping colour/width overrides.
  const showAllTracks = () => {
    const drop = (obj) => {
      const n = {}
      for (const k in obj) { const c = { ...obj[k] }; delete c.hidden; if (Object.keys(c).length) n[k] = c }
      return n
    }
    setTrackStyles(drop); setTrackGroupStyles(drop)
  }
  const toggleTCol = (gk) =>
    setTrackCol((c) => { const n = new Set(c); n.has(gk) ? n.delete(gk) : n.add(gk); return n })
  const groupKeyOf = (t) => (trackGroup === 'event' ? 'event:' + t.eventID : 'sp:' + speciesKey(t))
  const groupLabelOf = (t) => (trackGroup === 'event' ? `event ${t.eventID}` : speciesKey(t))
  // Effective track style: colour/width default (species) ← group ← individual;
  // visibility is tracked only per-track so group toggle / solo stay consistent.
  const effTrack = (t) => {
    const g = trackGroupStyles[groupKeyOf(t)] || {}
    const ind = trackStyles[trackKey(t)] || {}
    return {
      color: ind.color || g.color || defTrackColor(t),
      width: ind.width || g.width || defWidth(t),
      hidden: ind.hidden || false,
    }
  }
  // Show/hide every track in a group (individual flags, so it composes with solo).
  const setGroupVis = (gr, hide) => setTrackStyles((s) => {
    const n = { ...s }
    gr.tracks.forEach(({ t }) => { const k = trackKey(t); n[k] = { ...n[k], hidden: hide } })
    return n
  })
  // fully-resolved per-track styles handed to the viewer (covers every track)
  const resolvedTracks = useMemo(() => {
    const m = {}
    for (const t of event.tracks) m[trackKey(t)] = effTrack(t)
    return m
  }, [event.tracks, trackStyles, trackGroupStyles, trackGroup])
  // tracks grouped for the tree (beam group first in species mode)
  const trackGroups = useMemo(() => {
    const m = new Map()
    event.tracks.forEach((t, i) => {
      const gk = groupKeyOf(t)
      if (!m.has(gk)) m.set(gk, { key: gk, label: groupLabelOf(t), species: speciesKey(t), tracks: [] })
      m.get(gk).tracks.push({ t, i })
    })
    return [...m.values()].sort((a, b) =>
      a.key === 'sp:beam' ? -1 : b.key === 'sp:beam' ? 1
        : a.label.localeCompare(b.label, undefined, { numeric: true }))
  }, [event.tracks, trackGroup])
  // groups start collapsed: collapse each group key the first time it appears
  // (so switching mode collapses the new set, but a user's later toggles stick).
  const seenGroupsRef = useRef(new Set())
  useEffect(() => {
    const fresh = trackGroups.map((g) => g.key).filter((k) => !seenGroupsRef.current.has(k))
    if (fresh.length) {
      fresh.forEach((k) => seenGroupsRef.current.add(k))
      setTrackCol((c) => { const n = new Set(c); fresh.forEach((k) => n.add(k)); return n })
    }
  }, [trackGroups])
  const [spinAxis, setSpinAxis] = useState('y')
  const setStyle = (name, patch) => setStyles((s) => ({ ...s, [name]: { ...s[name], ...patch } }))
  const resetOne = (name) => setStyles((s) => { const n = { ...s }; delete n[name]; return n })
  const resetAll = () => { setStyles({}); setGstyle({}) }
  const applyAll = (style) => setStyles(() => {
    const n = {}
    for (const nm of new Set(geometry.map((g) => g.name))) n[nm] = { ...style }
    return n
  })
  const [gstyle, setGstyle] = useState({})   // the one unified style (전체 볼륨)
  // Edit one style and apply it to every volume at once (drops per-instance
  // overrides, so all volumes truly share a single style).
  const applyGlobal = (patch) => {
    const merged = { ...gstyle, ...patch }
    setGstyle(merged)
    const n = {}
    for (const nm of new Set(geometry.map((g) => g.name))) n[nm] = { ...merged }
    setStyles(n)
  }
  const [recPct, setRecPct] = useState(null)   // 0..1 while recording, else null
  const controlsRef = useRef(null)
  const viewerApi = useRef(null)               // {capturePNG, recordTurntable}
  const geomSigRef = useRef('')

  function applyScene(s) {
    const sig = s.geometry.map((g) => g.id).join('|')
    if (sig !== geomSigRef.current) {
      geomSigRef.current = sig
      setHidden(new Set(s.geometry.filter((g) => g.visible === false).map((g) => g.id)))
      const cnt = {}
      for (const g of s.geometry) {
        if (g.group) cnt['g:' + g.group] = 1
        const nk = 'n:' + g.group + '/' + g.name
        cnt[nk] = (cnt[nk] || 0) + 1
      }
      setCollapsed(new Set(Object.entries(cnt)
        .filter(([k, c]) => k.startsWith('g:') || c > 1).map(([k]) => k)))
      setGeometry(s.geometry)
    }
    setEvent({ tracks: s.tracks, edep: s.edep, meta: s.meta })
    setLoaded(true)
  }

  // The backend returns one page of `trackPageSize` tracks at a time (server-side,
  // so the payload stays small even with thousands of tracks); the buttons in the
  // display panel page through the full set. Reset to page 0 on a new run / resize.
  const nTracks = event.meta.n_tracks_total ?? event.tracks.length
  const pageCount = Math.max(1, Math.ceil(nTracks / trackPageSize))
  const page = Math.min(trackPage, pageCount - 1)
  useEffect(() => { setTrackPage(0) }, [sessState.runs, trackPageSize])

  // Re-runs when the track page/size changes → immediately fetches that page and
  // keeps polling it live.
  useEffect(() => {
    const from = page * trackPageSize, count = trackPageSize
    if (JOB_ID) {
      fetchJobScene(JOB_ID, from, count).then(applyScene).catch((e) => setError(String(e.message || e)))
      return
    }
    if (RUN_ID) {
      outputsScene(RUN_ID, from, count).then(applyScene).catch((e) => setError(String(e.message || e)))
      return
    }
    let alive = true
    const tick = async () => {
      try { const s = await sessionScene(from, count); if (alive) applyScene(s) }
      catch (e) { if (alive && e.status === 409 && !geomSigRef.current) setLoaded(false) }
    }
    tick()
    const t = setInterval(tick, 1200)
    return () => { alive = false; clearInterval(t) }
  }, [page, trackPageSize])

  // Simulation-tab keyboard shortcuts. Only act when this tab is actually on-screen
  // (Shell keeps all tabs mounted via display:none) and not while typing in a field.
  useEffect(() => {
    // Capture phase + stopImmediatePropagation so our keys pre-empt the AppShell's
    // built-in shortcuts (esp. '?') and don't double-fire.
    const onKey = (e) => {
      if (!stageRef.current || stageRef.current.offsetParent === null) return
      const tag = (e.target.tagName || '').toUpperCase()
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key, lk = k.toLowerCase()
      const panel = { 1: 'status', 2: 'session', 3: 'volumes', 4: 'tracks', 5: 'display' }[k]
      let handled = true
      if (k === '?') setHelpOpen((v) => !v)
      else if (k === 'Escape' && helpOpen) setHelpOpen(false)
      else if (k === '0') setActive(null)
      else if (panel) setActive((a) => (a === panel ? null : panel))
      else if (k === ' ') sessionRef.current?.toggle?.()
      else if (k === 'Enter') sessionRef.current?.run?.()
      else if (lk === 'b') setBgColor((c) => (isDarkHex(c) ? '#ffffff' : '#000000'))
      else if (lk === 'o') setOrtho((v) => !v)
      else if (lk === 'h') viewerApi.current?.resetView?.()
      else if (lk === 'x' || lk === 'y' || lk === 'z') viewerApi.current?.viewAxis?.(lk)
      else if (k === '-' || k === '_') viewerApi.current?.zoom?.(1.15)      // zoom out
      else if (k === '=' || k === '+') viewerApi.current?.zoom?.(1 / 1.15)  // zoom in
      // reversed: pan the camera opposite to the arrow so the detector appears to
      // move in the arrow's direction (drag-the-object feel)
      else if (k === 'ArrowUp') viewerApi.current?.pan?.(0, -1)
      else if (k === 'ArrowDown') viewerApi.current?.pan?.(0, 1)
      else if (k === 'ArrowLeft') viewerApi.current?.pan?.(1, 0)
      else if (k === 'ArrowRight') viewerApi.current?.pan?.(-1, 0)
      else handled = false
      if (handled) { e.preventDefault(); e.stopImmediatePropagation() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [helpOpen])

  const groups = useMemo(() => {
    const m = new Map()
    for (const g of geometry) {
      if (!m.has(g.group)) m.set(g.group, new Map())
      const nm = m.get(g.group)
      if (!nm.has(g.name)) nm.set(g.name, [])
      nm.get(g.name).push({ id: g.id, copy: g.copy, color: g.color })
    }
    return m
  }, [geometry])

  const allIds = useMemo(() => geometry.map((g) => g.id), [geometry])
  const toggle = (k) => setShow((s) => ({ ...s, [k]: !s[k] }))
  const toggleIds = (ids) => setHidden((h) => {
    const n = new Set(h)
    const allHidden = ids.every((i) => n.has(i))
    ids.forEach((i) => (allHidden ? n.delete(i) : n.add(i)))
    return n
  })
  const soloIds = (ids) => setHidden(new Set(allIds.filter((i) => !ids.includes(i))))
  const showAll = () => setHidden(new Set())
  const allHidden = (ids) => ids.every((i) => hidden.has(i))
  const isCol = (k) => collapsed.has(k)
  const toggleCol = (k) =>
    setCollapsed((c) => { const n = new Set(c); n.has(k) ? n.delete(k) : n.add(k); return n })
  const reloadScene = () => (JOB_ID ? fetchJobScene(JOB_ID) : RUN_ID ? outputsScene(RUN_ID)
    : sessionScene()).then(applyScene).catch(() => {})
  const exportPNG = () => viewerApi.current?.capturePNG()
  const startSpin = () => {
    if (!viewerApi.current) return
    setRecPct(0)
    viewerApi.current.recordTurntable({
      axis: spinAxis, seconds: 6,
      onProgress: setRecPct,
      onDone: (err) => { setRecPct(null); if (err) setError(err) },
    })
  }

  const gearFor = (name) => () => setStyleFor((f) => (f === name ? null : name))
  const styleEditor = (name, color) => styleFor === name
    ? <StyleEditor style={styles[name]} onChange={(p) => setStyle(name, p)}
        onReset={() => resetOne(name)} onApplyAll={applyAll}
        defEdge={rgbHex(color, 0.7)} defFill={rgbHex(color)} /> : null

  // Colour of the little box before a volume name — reflect the user's edge/fill
  // override (per-id wins over per-name, matching the renderer) so it tracks edits.
  const swatchColor = (name, id, color) => {
    const d = { ...(styles[name] || {}), ...(id != null ? styles[id] || {} : {}) }
    return d.edge || d.fill || swatch(color)
  }

  function renderName(grp, name, items, indent) {
    const ids = items.map((x) => x.id)
    if (items.length === 1) {
      return (
        <div key={name}>
          <Row indent={indent} color={items[0].color} swatchC={swatchColor(name, ids[0], items[0].color)}
            label={name} styled={!!styles[name]}
            hidden={hidden.has(ids[0])} onToggle={() => toggleIds(ids)} onSolo={() => soloIds(ids)}
            onGear={gearFor(name)} />
          {styleEditor(name, items[0].color)}
        </div>
      )
    }
    const nk = 'n:' + grp + '/' + name
    return (
      <div className="vgroup" key={name}>
        <div className={`vghead ${indent ? 'indent' : ''}`}>
          <button className="caret" onClick={() => toggleCol(nk)}>{isCol(nk) ? '▸' : '▾'}</button>
          <button className={`tg ${allHidden(ids) ? '' : 'on'}`}
            onClick={() => toggleIds(ids)} title="show/hide all copies">
            <span className="box" style={{ '--c': swatchColor(name, null, items[0].color) }} />
            <span className="vname">{name}</span><span className="vtype">×{items.length}</span>
          </button>
          <button className={`gear ${styles[name] ? 'on' : ''}`} title="스타일" onClick={gearFor(name)}>◐</button>
        </div>
        {styleEditor(name, items[0].color)}
        {!isCol(nk) && items.map((it) => (
          <div key={it.id}>
            <Row indent={(indent || 0) + 1} color={it.color} swatchC={swatchColor(name, it.id, it.color)}
              label={`#${it.copy}`} styled={!!styles[it.id]}
              hidden={hidden.has(it.id)} onToggle={() => toggleIds([it.id])} onSolo={() => soloIds([it.id])}
              onGear={gearFor(it.id)} />
            {styleEditor(it.id, it.color)}
          </div>
        ))}
      </div>
    )
  }

  const hasScene = loaded && (geometry.length > 0 || event.tracks.length > 0)
  const mode = JOB_ID ? `job ${JOB_ID.slice(0, 8)}`
    : RUN_ID ? `run ${RUN_ID.replace(/^(session|job)_/, '').slice(0, 8)}` : 'live session'

  const volumeTree = (
    <div className="vollist tall">
      <div className="allstylerow">
        <span className="vname">모든 볼륨 스타일 통일</span>
        <button className={`gear ${styleFor === '*' ? 'on' : ''}`} title="전체 스타일 통일"
          onClick={gearFor('*')}>◐</button>
      </div>
      {styleFor === '*' && (
        <StyleEditor style={gstyle} onChange={applyGlobal}
          onReset={resetAll} defEdge="#88aacc" defFill="#88aacc" hideApplyAll />
      )}
      {[...groups.entries()].map(([grp, names]) =>
        grp === ''
          ? [...names.entries()].map(([name, items]) => renderName('', name, items, 0))
          : (() => {
              const gk = 'g:' + grp
              const gids = [...names.values()].flat().map((x) => x.id)
              return (
                <div className="vgroup" key={grp}>
                  <div className="vghead">
                    <button className="caret" onClick={() => toggleCol(gk)}>
                      {isCol(gk) ? '▸' : '▾'}</button>
                    <button className={`tg ${allHidden(gids) ? '' : 'on'}`}
                      onClick={() => toggleIds(gids)} title="show/hide group">
                      <span className="box" />
                      <span className="vname">{grp}</span>
                      <span className="vtype">{gids.length}</span>
                    </button>
                  </div>
                  {!isCol(gk) && [...names.entries()].map(([name, items]) =>
                    renderName(grp, name, items, 1))}
                </div>
              )
            })(),
      )}
    </div>
  )

  return (
    <div className={`stage ${isDarkHex(bgColor) ? 'darkui' : ''} ${clearGlass ? 'clearglass' : ''}`} ref={stageRef}
      style={{ '--glass-panel': glass, '--glass-rail': +(glass * 0.72).toFixed(2), '--glass-rgb': rgbCss(bgColor) }}>
      {hasScene ? (
        <ViewerBoundary>
          <Suspense fallback={<div className="placeholder">3D 뷰어 로딩…</div>}>
            <Viewer geometry={geometry} event={event} show={show} ortho={ortho} bgColor={bgColor}
              hidden={hidden} styles={styles} trackStyles={resolvedTracks} pointStyle={pointStyle}
              controlsRef={controlsRef} apiRef={viewerApi} />
          </Suspense>
        </ViewerBoundary>
      ) : (
        <div className="placeholder">
          {error ? `⚠ ${error}` : (JOB_ID || RUN_ID) ? 'loading…'
            : 'session 아이콘에서 nptool 시뮬레이션을 실행하세요.'}
        </div>
      )}

      {/* macOS-style vertical dock: click an icon to open its panel on the right */}
      <div className="simrail">
        {PANELS.map(({ key, label, Icon }) => (
          <button key={key} className={`railbtn ${active === key ? 'on' : ''}`} title={label}
            onClick={() => setActive((a) => (a === key ? null : key))}>
            <Icon size={21} weight={active === key ? 'fill' : 'regular'} />
            <span>{label}</span>
          </button>
        ))}
        {/* session actions — divider + coloured buttons that drive the live session */}
        <div className="railsep" />
        <button className={`railbtn act ${sessState.alive ? 'stop' : 'start'}`}
          title={sessState.alive ? '세션 정지 (stop)' : '세션 시작 (start)'}
          onClick={() => sessionRef.current?.toggle?.()}>
          {sessState.alive ? <Stop size={21} weight="fill" /> : <Play size={21} weight="fill" />}
          <span>{sessState.alive ? 'stop' : 'start'}</span>
        </button>
        <button className="railbtn act run" title="/run/beamOn 1" disabled={!sessState.idle}
          onClick={() => sessionRef.current?.run?.(1)}>
          <Lightning size={21} weight="fill" /><span>run 1</span>
        </button>
        <button className="railbtn act run" title="/run/beamOn 10" disabled={!sessState.idle}
          onClick={() => sessionRef.current?.run?.(10)}>
          <Lightning size={21} weight="fill" /><span>run 10</span>
        </button>
      </div>

      {active && active !== 'session' && (
        <div className={`simpanel ${active}`}>
          <div className="sphead">
            <span className="sptitle">{active}</span>
            {active === 'volumes' && geometry.length > 0 && (<>
              <button className="mini" onClick={showAll}>all on</button>
              <button className="mini" disabled={!Object.keys(styles).length}
                onClick={resetAll}>모두 초기화</button>
              <button className={`mini tog ${showPresets ? 'on' : ''}`}
                onClick={() => setShowPresets((v) => !v)}>
                <span className="sw" />스타일 관리</button>
            </>)}
            {active === 'tracks' && event.tracks.length > 0 && (<>
              <button className="mini" onClick={showAllTracks}>모두 표시</button>
              <button className="mini"
                disabled={!Object.keys(trackStyles).length && !Object.keys(trackGroupStyles).length}
                onClick={() => { setTrackStyles({}); setTrackGroupStyles({}); setTrackFor(null) }}>
                트랙 초기화</button>
            </>)}
            <button className="spclose" title="닫기" onClick={() => setActive(null)}>✕</button>
          </div>
          <div className="spbody">
            {active === 'status' && (
              <div className="statuspanel">
                <div className="strow"><span>mode</span><b>{mode}</b></div>
                <div className="strow"><span>events</span><b>{event.meta.n_events}</b></div>
                <div className="strow"><span>tracks</span><b>{nTracks}</b></div>
                <div className="strow"><span>energy pts</span><b>{event.meta.n_points.toLocaleString()}</b></div>
                <div className="strow"><span>E max</span><b>{(event.meta.energy_max || 0).toPrecision(3)} MeV</b></div>
                <div className="strow"><span>volumes</span><b>{geometry.length}</b></div>
                {!hasScene && <div className="dnote">아직 씬이 없습니다 — session에서 실행하세요.</div>}
              </div>
            )}
            {active === 'volumes' && (geometry.length > 0 ? (<>
              {showPresets && <StylePresets styles={styles} hidden={[...hidden]}
                onApply={(sty, hid) => { setStyles(sty || {}); setHidden(new Set(hid || [])) }} />}
              {volumeTree}
            </>) : <div className="dnote">지오메트리가 없습니다.</div>)}
            {active === 'tracks' && (event.tracks.length > 0 ? (
              <div className="trackspanel">
                <div className="tsec">
                  <div className="vsmodes">
                    <button className={`vsmode ${trackGroup === 'species' ? 'on' : ''}`}
                      onClick={() => { setTrackGroup('species'); setTrackFor(null) }}>종류별</button>
                    <button className={`vsmode ${trackGroup === 'event' ? 'on' : ''}`}
                      onClick={() => { setTrackGroup('event'); setTrackFor(null) }}>이벤트별</button>
                  </div>
                  <div className="tsechead">
                    <Toggle on={show.tracks} onClick={() => toggle('tracks')}>트랙 표시</Toggle>
                    <span className="tcount">{nTracks}개</span>
                  </div>
                  <div className="tracklist">
                    {trackGroups.map((gr) => {
                      const gk = gr.key
                      const gst = trackGroupStyles[gk]
                      const gAnyVis = gr.tracks.some(({ t }) => !effTrack(t).hidden)
                      const gBase = trackGroup === 'species' ? speciesColor(gr.species) : '#8a94a6'
                      const gDefW = gr.tracks.length ? defWidth(gr.tracks[0].t) : 1
                      return (
                        <div className="vgroup" key={gk}>
                          <div className="vghead">
                            <button className="caret" onClick={() => toggleTCol(gk)}>
                              {trackCol.has(gk) ? '▸' : '▾'}</button>
                            <button className={`tg ${gAnyVis ? 'on' : ''}`} title="show/hide group"
                              onClick={() => setGroupVis(gr, gAnyVis)}>
                              <span className="box" style={{ '--c': (gst && gst.color) || gBase }} />
                              <span className="vname">{gr.label}</span>
                              <span className="vtype">×{gr.tracks.length}</span>
                            </button>
                            <button className={`gear ${gst ? 'on' : ''}`} title="그룹 스타일"
                              onClick={() => setTrackFor((f) => (f === gk ? null : gk))}>◐</button>
                            <button className="solo" title="이 그룹만 표시"
                              onClick={() => soloTracks(gr.tracks.map(({ t }) => trackKey(t)))}>◎</button>
                          </div>
                          {trackFor === gk && (
                            <TrackEditor style={gst} defColor={gBase} defWidth={gDefW}
                              onChange={(p) => setGroupStyle(gk, p)} onReset={() => resetGroup(gk)} />
                          )}
                          {!trackCol.has(gk) && gr.tracks.map(({ t }) => {
                            const k = trackKey(t)
                            const e = effTrack(t)
                            return (
                              <div key={k}>
                                <div className="vol indent1">
                                  <button className={`tg ${e.hidden ? '' : 'on'}`} title="show/hide"
                                    onClick={() => setTrackStyle(k, { hidden: !e.hidden })}>
                                    <span className="box" style={{ '--c': e.color }} />
                                    <span className="vname">{pdgName(t.pdg)}</span>
                                    <span className="vtype">ev{t.eventID}·#{t.trackID}</span>
                                  </button>
                                  <button className={`gear ${trackStyles[k] ? 'on' : ''}`} title="스타일"
                                    onClick={() => setTrackFor((f) => (f === k ? null : k))}>◐</button>
                                  <button className="solo" title="이 트랙만 표시"
                                    onClick={() => soloTracks([k])}>◎</button>
                                </div>
                                {trackFor === k && (
                                  <TrackEditor style={trackStyles[k]} defColor={e.color} defWidth={e.width}
                                    onChange={(p) => setTrackStyle(k, p)}
                                    onReset={() => { resetTrack(k); setTrackFor(null) }} />
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )
                    })}
                  </div>
                </div>
                <div className="tsec">
                  <div className="tsechead">
                    <Toggle on={show.edep} onClick={() => toggle('edep')}>에너지 점 표시</Toggle>
                    <span className="tcount">{event.meta.n_points.toLocaleString()}개</span>
                  </div>
                  <label className="vsrow"><span>점 크기</span>
                    <input type="range" min="0.5" max="5" step="0.5" value={show.pointSize}
                      onChange={(e) => setShow((s) => ({ ...s, pointSize: +e.target.value }))} />
                    <b className="vsval">{show.pointSize.toFixed(1)}</b>
                  </label>
                  <div className="vsmodes">
                    <button className={`vsmode ${(pointStyle.shape || 'square') === 'square' ? 'on' : ''}`}
                      onClick={() => setPointStyle((p) => ({ ...p, shape: 'square' }))}>사각형</button>
                    <button className={`vsmode ${pointStyle.shape === 'circle' ? 'on' : ''}`}
                      onClick={() => setPointStyle((p) => ({ ...p, shape: 'circle' }))}>동그라미</button>
                  </div>
                  <div className="vsmodes">
                    <button className={`vsmode ${pointStyle.mode === 'energy' ? 'on' : ''}`}
                      onClick={() => setPointStyle((p) => ({ ...p, mode: 'energy' }))}>에너지 컬러맵</button>
                    <button className={`vsmode ${pointStyle.mode === 'solid' ? 'on' : ''}`}
                      onClick={() => setPointStyle((p) => ({ ...p, mode: 'solid' }))}>단색</button>
                  </div>
                  {pointStyle.mode === 'solid' ? (
                    <div className="vsrow"><span>점 색</span>
                      <ColorPicker value={pointStyle.color} size={22} title="점 색"
                        onChange={(c) => setPointStyle((p) => ({ ...p, color: c }))} />
                    </div>
                  ) : (<>
                    <div className="legendrow">
                      <span>energy</span><i className="ramp" />
                      <span className="lo">low</span><span className="hi">high</span>
                    </div>
                    <label className="vsrow"><span>low</span>
                      <input type="number" step="any" className="numin" value={pointStyle.low ?? ''} placeholder="0"
                        onChange={(e) => setPointStyle((p) => ({ ...p, low: e.target.value === '' ? null : +e.target.value }))} />
                      <b className="vsval">MeV</b></label>
                    <label className="vsrow"><span>high</span>
                      <input type="number" step="any" className="numin" value={pointStyle.high ?? ''}
                        placeholder={(event.meta.energy_max || 0).toPrecision(3)}
                        onChange={(e) => setPointStyle((p) => ({ ...p, high: e.target.value === '' ? null : +e.target.value }))} />
                      <b className="vsval">MeV</b></label>
                  </>)}
                </div>
              </div>
            ) : <div className="dnote">아직 트랙이 없습니다 — session에서 run을 실행하세요.</div>)}
            {active === 'display' && (
              <div className="displaypanel">
                <Toggle on={show.axes} onClick={() => toggle('axes')}>원점 축 (axes)</Toggle>
                <Toggle on={ortho} onClick={() => setOrtho((v) => !v)}>직교 뷰 (orthographic)</Toggle>
                <div className="vsrow"><span>배경색 (= dock)</span>
                  <span className="bgbtns">
                    <button className="bgbtn" title="흰색" style={{ background: '#ffffff' }}
                      onClick={() => setBgColor('#ffffff')} />
                    <button className="bgbtn" title="검은색" style={{ background: '#000000' }}
                      onClick={() => setBgColor('#000000')} />
                    <ColorPicker value={bgColor} onChange={setBgColor} size={22} title="배경색" />
                  </span>
                </div>
                <Toggle on={clearGlass} onClick={() => setClearGlass((v) => !v)}>투명 모드 (블러 끄기)</Toggle>
                <label className="vsrow"><span>패널 불투명도</span>
                  <input type="range" min="0.1" max="1" step="0.02" value={glass}
                    onChange={(e) => setGlass(+e.target.value)} />
                  <b className="vsval">{Math.round(glass * 100)}%</b>
                </label>
                {nTracks > 0 && (
                  <div className="trkpagebox">
                    <label className="vsrow"><span>트랙 페이지 크기</span>
                      <select value={trackPageSize} onChange={(e) => setTrackPageSize(+e.target.value)}>
                        {[20, 50, 100, 200, 300, 400, 500].map((n) => <option key={n} value={n}>{n}개</option>)}
                      </select>
                    </label>
                    {nTracks > trackPageSize && (
                      <div className="trkpager">
                        <button className="mini" disabled={page <= 0}
                          onClick={() => setTrackPage((p) => Math.max(0, p - 1))}>◀ 이전</button>
                        <span className="trkpginfo">{page * trackPageSize + 1}–{Math.min(nTracks, (page + 1) * trackPageSize)} / {nTracks}</span>
                        <button className="mini" disabled={page >= pageCount - 1}
                          onClick={() => setTrackPage((p) => Math.min(pageCount - 1, p + 1))}>다음 ▶</button>
                      </div>
                    )}
                  </div>
                )}
                <div className="dnote">단축키: <b>?</b> 로 목록 보기</div>
                <div className="dnote">트랙 / 에너지 점 스타일은 tracks 탭에서 조절합니다.</div>
                <div className="dgrid">
                  <button className="dbtn" onClick={reloadScene}>↻ 새로고침</button>
                  <button className="dbtn" disabled={!hasScene} onClick={exportPNG}>🖼 PNG</button>
                </div>
                <div className="dgrid">
                  <label className="dbtn axis">회전축
                    <select value={spinAxis} onChange={(e) => setSpinAxis(e.target.value)} disabled={recPct != null}>
                      <option value="x">X</option><option value="y">Y</option><option value="z">Z</option>
                    </select>
                  </label>
                  <button className="dbtn" disabled={!hasScene || recPct != null} onClick={startSpin}>
                    {recPct != null ? `녹화 ${Math.round(recPct * 100)}%` : '🎥 360°'}</button>
                </div>
                <div className="dnote">뷰 회전 초기화·90° 회전 버튼은 우하단 축 옆에 있습니다.</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* session panel — always mounted so keyboard start/stop/run works when closed */}
      <div className="simpanel session" style={{ display: active === 'session' ? 'flex' : 'none' }}>
        <div className="sphead">
          <span className="sptitle">session</span>
          <button className="spclose" title="닫기" onClick={() => setActive(null)}>✕</button>
        </div>
        <div className="spbody"><Session ref={sessionRef} onState={setSessState} /></div>
      </div>

      {hasScene && (
        <div className="gizmoctl">
          <button className="gizmobtn" title="반시계 방향으로 90° 회전"
            onClick={() => viewerApi.current?.roll?.(-1)}>⟲</button>
          <button className="gizmobtn" title="뷰 방향 초기화 (reset view) — h"
            onClick={() => (viewerApi.current?.resetView
              ? viewerApi.current.resetView() : controlsRef.current?.reset())}>⌂</button>
          <button className="gizmobtn" title="시계 방향으로 90° 회전"
            onClick={() => viewerApi.current?.roll?.(1)}>⟳</button>
        </div>
      )}

      {helpOpen && (
        <div className="kbdhelp" onClick={() => setHelpOpen(false)}>
          <div className="kbdcard" onClick={(e) => e.stopPropagation()}>
            <div className="kbdtitle">단축키
              <button className="spclose" onClick={() => setHelpOpen(false)}>✕</button></div>
            {SHORTCUTS.map(([keys, desc]) => (
              <div className="kbdrow" key={keys}>
                <span className="kbdkeys">{keys.split(' / ').map((kk) => <kbd key={kk}>{kk}</kbd>)}</span>
                <span>{desc}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// Keep a failure inside the 3D viewer from blanking the whole app — the dock and
// its panels stay usable. Surfaces the REAL error (not a hardcoded label) so a
// WebGL/context problem is distinguishable from a code/data error, with a retry.
class ViewerBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err, info) { console.error('[nptoy Viewer]', err, info && info.componentStack) }
  render() {
    const err = this.state.err
    if (err) {
      const msg = String((err && err.message) || err)
      const isGL = /webgl|context|gpu|getcontext|adapter/i.test(msg)
      return (
        <div className="placeholder viewererr">
          <div className="vetitle">{isGL ? '3D 뷰어를 초기화할 수 없습니다 (WebGL)' : '3D 뷰어 오류'}</div>
          <div className="vemsg">{msg}</div>
          <button className="sbtn" onClick={() => this.setState({ err: null })}>다시 시도</button>
          <div className="dnote">{isGL
            ? '브라우저 하드웨어 가속을 켜거나 탭을 줄인 뒤 다시 시도하세요. 오른쪽 패널은 계속 사용할 수 있습니다.'
            : '오른쪽 패널은 계속 사용할 수 있습니다.'}</div>
        </div>
      )
    }
    return this.props.children
  }
}

function Toggle({ on, onClick, children }) {
  return (
    <button className={`tg ${on ? 'on' : ''}`} onClick={onClick}>
      <span className="box" />{children}
    </button>
  )
}

function Row({ color, swatchC, label, hidden, onToggle, onSolo, onGear, styled, indent }) {
  return (
    <div className={`vol ${indent ? 'indent' + Math.min(indent, 2) : ''}`}>
      <button className={`tg ${hidden ? '' : 'on'}`} onClick={onToggle} title="show/hide">
        <span className="box" style={{ '--c': swatchC || swatch(color) }} />
        <span className="vname">{label}</span>
      </button>
      {onGear && <button className={`gear ${styled ? 'on' : ''}`} title="스타일" onClick={onGear}>◐</button>}
      <button className="solo" title="이것만 표시" onClick={onSolo}>◎</button>
    </div>
  )
}

// Track / track-group style: colour + line width. defColor/defWidth show the
// current effective values so the controls start where the render actually is.
function TrackEditor({ style, defColor, defWidth = 1, onChange, onReset }) {
  const s = style || {}
  const w = s.width ?? defWidth
  return (
    <div className="vstyle">
      <div className="vsrow"><span>색</span>
        <ColorPicker value={s.color || defColor} onChange={(c) => onChange({ color: c })} size={22} title="트랙 색" />
      </div>
      <label className="vsrow"><span>선 두께</span>
        <input type="range" min="1" max="6" step="1" value={w}
          onChange={(e) => onChange({ width: +e.target.value })} />
        <b className="vsval">{w}px</b></label>
      <div className="vsfoot"><button className="vsmini" onClick={onReset}>초기화</button></div>
    </div>
  )
}

const STYLE_MODES = [['wire', '와이어'], ['solid', '솔리드'], ['transparent', '투명']]

// Per-volume display style: render mode + edge/fill colours + opacity. Colours use
// the kit's ColorPicker (visual picker + hex + copy/paste built in); the default
// shown is the volume's actual current colour, so picker == what's on screen.
function StyleEditor({ style, onChange, onReset, onApplyAll, defEdge, defFill, hideApplyAll }) {
  const s = style || {}
  const mode = s.mode || 'wire'
  return (
    <div className="vstyle">
      <div className="vsmodes">
        {STYLE_MODES.map(([m, label]) => (
          <button key={m} className={`vsmode ${mode === m ? 'on' : ''}`}
            onClick={() => onChange({ mode: m })}>{label}</button>
        ))}
      </div>
      <div className="vsrow"><span>선 색</span>
        <ColorPicker value={s.edge || defEdge} onChange={(c) => onChange({ edge: c })} size={22} title="선 색" />
      </div>
      {mode !== 'wire' && (
        <div className="vsrow"><span>채움 색</span>
          <ColorPicker value={s.fill || defFill} onChange={(c) => onChange({ fill: c })} size={22} title="채움 색" />
        </div>
      )}
      {mode === 'transparent' && (
        <label className="vsrow"><span>투명도</span>
          <input type="range" min="0.05" max="0.9" step="0.05" value={s.opacity ?? 0.35}
            onChange={(e) => onChange({ opacity: +e.target.value })} />
          <b className="vsval">{(s.opacity ?? 0.35).toFixed(2)}</b></label>
      )}
      <label className="vsrow"><span>선 두께</span>
        <input type="range" min="1" max="6" step="1" value={s.width ?? 1}
          onChange={(e) => onChange({ width: +e.target.value })} />
        <b className="vsval">{s.width ?? 1}px</b></label>
      <div className="vsflags">
        <button className={`vsflag ${s.label ? 'on' : ''}`}
          onClick={() => onChange({ label: !s.label })}>치수 라벨</button>
        <button className={`vsflag ${s.highlight ? 'on' : ''}`}
          onClick={() => onChange({ highlight: !s.highlight })}>하이라이트</button>
        {mode !== 'wire' && (
          <button className={`vsflag ${s.noWire ? 'on' : ''}`}
            onClick={() => onChange({ noWire: !s.noWire })}>선 숨기기</button>
        )}
      </div>
      <div className="vsfoot">
        <button className="vsmini" onClick={onReset}>초기화</button>
        {!hideApplyAll && <button className="vsmini" onClick={() => onApplyAll(s)}>전체 적용</button>}
      </div>
    </div>
  )
}
