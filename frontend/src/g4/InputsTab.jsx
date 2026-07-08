import React, { useEffect, useRef, useState } from 'react'
import DetectorForm from './DetectorForm.jsx'
import ReactionForm from './ReactionForm.jsx'
import PhysicsForm from './PhysicsForm.jsx'
import CrossSectionEditor from './CrossSectionEditor.jsx'
import AnalysisSetup from './AnalysisSetup.jsx'
import { Package, Atom, Cube, ArrowsLeftRight, ChartLine, ChartBar, Stack, Palette } from '@phosphor-icons/react'
import {
  inputsState, inputsGetFile, inputsSaveFile, inputsLoadExample, csGet, csSave, csCandidates,
  inputsSources, libraryList, librarySave, libraryLoad, libraryDelete,
  stylesList, stylesSave, stylesLoad, stylesDelete,
  librarySharedList, librarySharedSave, librarySharedLoad, librarySharedDelete,
} from './api.js'

const FORM_SLOTS = { detector: DetectorForm, reaction: ReactionForm, physics: PhysicsForm }
const CS = 'crosssection'
// The five editors (one always open). `preset` (no editor — 1..3 file boxes) and
// `style` (a file box + a JSON preview) are menus of their own.
const EDIT_ITEMS = [
  { key: 'physics', label: 'physics', Icon: Atom },
  { key: 'detector', label: 'detector', Icon: Cube },
  { key: 'reaction', label: 'reaction', Icon: ArrowsLeftRight },
  { key: CS, label: 'x-section', Icon: ChartLine },
  { key: 'analysis', label: 'analysis', Icon: ChartBar },
]
const EDITOR_KEYS = EDIT_ITEMS.map((i) => i.key)
// Rail order: preset (above physics) · the five editors · style (bottom).
const RAIL_ITEMS = [
  { key: 'preset', label: 'preset', Icon: Stack },
  ...EDIT_ITEMS,
  { key: 'style', label: 'style', Icon: Palette },
]
const SLOT_LABEL = { physics: 'Physics list', detector: 'Detector', reaction: 'Reaction',
  analysis: 'Analysis setup', [CS]: 'X-section' }
const MENU_LABEL = { ...SLOT_LABEL, preset: 'preset', style: 'style' }
// slots a preset load can change — marked with a box until the user opens them
const CHANGEABLE = ['physics', 'detector', 'reaction', CS, 'analysis']
// preset sub-types (system read-only; shared/user save-able)
const PRESET_TYPES = ['system', 'shared', 'user']
const BOX_PX = 280   // max width of one preset file box
const RAIL_PX = 74   // icon rail + its margin — fixed overhead beside the boxes

// Every file box has the same shape: name · save · load · list. `preset` fans this out
// by how many ≤280px boxes fit: 3 (system·shared·user), 2 (system+shared merged · user),
// or 1 (a single box with a sub-type selector).
const slotDesc = (key) => ({ id: key, kind: 'slot', slot: key, label: SLOT_LABEL[key] || key, save: true })
const presetDesc = (ptype) => ({ id: 'preset:' + ptype, kind: 'preset', ptype, label: ptype, save: ptype !== 'system' })
const styleDesc = () => ({ id: 'style', kind: 'style', label: 'style', save: true })
// A style blob is always {styles, hidden}; older/pasted maps get normalised.
const normStyle = (d) => (d && typeof d === 'object' && d.styles !== undefined)
  ? { styles: d.styles || {}, hidden: Array.isArray(d.hidden) ? d.hidden : [] }
  : { styles: d || {}, hidden: [] }

// Setup tab: a macOS-dock workspace. A left icon rail — a duplicate-openable `file`
// menu, a divider, then preset / the five editors / style. The `file` box(es) follow
// whichever rail menu is active.
export default function InputsTab({ me, onSetupName }) {
  const [data, setData] = useState(null)     // {slots, examples, project}
  const [active, setActive] = useState('detector')  // selected rail menu (editor slot | 'preset' | 'style')
  const [fileOpen, setFileOpen] = useState(false)   // the `file` box(es) — beside/instead of the editor
  const [slot, setSlot] = useState('')       // editable slot currently loaded into the editor
  const [label, setLabel] = useState('')
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [msg, setMsg] = useState('')
  const [mode, setMode] = useState('form')     // 'form' | 'text' (detector/reaction/physics)
  const [fileKey, setFileKey] = useState(0)     // remounts the editor on (re)parse
  const [csPath, setCsPath] = useState('')
  const [csFiles, setCsFiles] = useState([])    // available cross-section files
  const [sources, setSources] = useState({ common: [], users: [], me: '' })
  const [changed, setChanged] = useState(() => new Set())  // slots changed by a preset load
  const rootRef = useRef(null)                             // tab root — number keys act only when visible
  const editorRef = useRef(null)                           // editor box — scanned for empty number fields on save
  // ── file box state ──
  const [names, setNames] = useState({})       // list id → save name (each box has its own field)
  const [styleText, setStyleText] = useState('')  // the style JSON preview / paste target
  const [presetType, setPresetType] = useState('system')  // 1-box fallback sub-type (system|shared|user)
  const [mergedType, setMergedType] = useState('system')  // 2-box: the merged system|shared box's sub-type
  const [cols, setCols] = useState(1)          // how many preset boxes fit (1..3)
  const [libItems, setLibItems] = useState({}) // list id → [{value,label,mine}]
  const [pick, setPick] = useState(null)       // { id, name } selected in a list
  const [confirmSave, setConfirmSave] = useState('')  // list id awaiting overwrite confirm

  async function load() {
    try { setData(await inputsState()) }
    catch (e) { setMsg(e.status === 401 ? '포탈 로그인 필요' : String(e.message || e)) }
  }
  const refreshSources = () => inputsSources()
    .then((d) => setSources({ common: d.common || [], users: d.users || [], me: d.me })).catch(() => {})
  useEffect(() => {
    load(); refreshSources()
    csCandidates().then((d) => setCsFiles(d.files)).catch(() => {})
    openSlot('detector', SLOT_LABEL.detector)     // one editor is always open on entry
  }, [])

  // Count how many ≤280px preset boxes fit beside the rail (1..3). Re-run when `data`
  // first arrives: the initial render shows a placeholder (no .inputstab / rootRef),
  // so the observer must attach only after the real tab is mounted.
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((ents) => {
      for (const en of ents) {
        const fit = Math.floor((en.contentRect.width - RAIL_PX) / (BOX_PX + 10))
        setCols(Math.max(1, Math.min(3, fit)))
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [!!data])

  useEffect(() => { if (data && onSetupName) onSetupName({ name: data.name, run: data.run }) }, [data])
  const reloadState = () => inputsState().then(setData).catch(() => {})

  async function openSlot(key, lbl) {
    try {
      const r = await inputsGetFile(key)
      setSlot(key); setLabel(lbl); setContent(r.content); setDirty(false); setMsg('')
      setMode(FORM_SLOTS[key] ? 'form' : 'text')
      setFileKey((k) => k + 1)
    } catch (e) { setMsg(String(e.message || e)) }
  }
  async function openCS() {
    try {
      const r = await csGet()
      setSlot(CS); setLabel('X-section'); setContent(r.content); setCsPath(r.path)
      setDirty(false); setMsg('')
    } catch (e) { setMsg(String(e.message || e)) }
  }
  // Select a rail menu. Editor slots open their editor; preset has no pane; style has a
  // JSON preview pane. Always resets the current list selection.
  function selectMenu(key) {
    setActive(key); setMsg(''); setPick(null); setConfirmSave('')
    setChanged((prev) => { const n = new Set(prev); n.delete(key); return n })  // clear this menu's marker
    if (key === 'preset') { setFileOpen(true); return }   // no editor — auto-open the file box
    if (key === 'style') {                                 // has its own preview pane
      if (!styleText.trim() && window.__nptoyStyle) {      // seed from the live viewer style (e.g. after a preset load)
        const b = normStyle(window.__nptoyStyle)
        if (Object.keys(b.styles).length || b.hidden.length) setStyleText(JSON.stringify(b, null, 2))
      }
      return
    }
    if (key === CS) { openCS(); return }
    openSlot(key, SLOT_LABEL[key])
  }
  function switchMode(m) { setMode(m); setFileKey((k) => k + 1) }
  async function afterConfigLoad() {                       // reload state + reopen current editor
    const fresh = await inputsState(); setData(fresh)
    setChanged(new Set(CHANGEABLE))                        // a preset load changes every slot
    if (EDITOR_KEYS.includes(active)) {
      if (active === CS) openCS()
      else openSlot(active, SLOT_LABEL[active])
      setChanged((prev) => { const n = new Set(prev); n.delete(active); return n })  // current one is shown → clear it
    }
  }
  async function csPick(name) {
    try { const r = await csGet(name); setContent(r.content); setCsPath(name); setDirty(false); setMsg('') }
    catch (e) { setMsg(String(e.message || e)) }
  }
  async function csSaveAs(name) {
    try {
      const r = await csSave(content, name)
      setCsPath(r.path || name); setDirty(false)
      csCandidates().then((d) => setCsFiles(d.files)).catch(() => {})
      flash('저장됨 — ' + (r.path || name))
    } catch (e) { setMsg(String(e.message || e)) }
  }
  // Block a save while any number field is blank; the empty ones are already red.
  function findEmpty() {
    const bad = editorRef.current?.querySelectorAll('input.numinput[data-empty="1"]')
    return bad && bad.length ? bad : null
  }
  async function save() {
    const bad = findEmpty()
    if (bad) { setMsg(`빈 숫자 칸이 ${bad.length}개 있습니다 — 빨간 테두리 칸을 채워주세요.`); try { bad[0].focus() } catch {} ; return }
    try {
      if (slot === CS) await csSave(content)
      else await inputsSaveFile(slot, content)
      setDirty(false); flash('저장됨 — ' + label)
    } catch (e) { setMsg(e.message || String(e)) }
  }
  // Toast + drawer log (Shell listens). `level: 'error'` renders a prominent red toast.
  const emit = (text, level = 'info') => {
    if (text) window.dispatchEvent(new CustomEvent('nptoy-notify', { detail: { text, level } }))
  }
  function flash(m) { emit(m, 'info') }        // success / neutral
  // Every error goes through setMsg → shown as an error toast (and, before data
  // loads, in the placeholder).
  useEffect(() => { if (msg) emit(msg, 'error') }, [msg])

  // ── the file box(es) — contents follow the active rail menu ──
  function visibleDescs() {
    if (active === 'preset') {
      if (cols >= 3) return PRESET_TYPES.map(presetDesc)                    // system · shared · user
      if (cols === 2) return [presetDesc(mergedType), presetDesc('user')]   // [system|shared] · user
      return [presetDesc(presetType)]                                       // one box + a selector
    }
    if (active === 'style') return [styleDesc()]
    return [slotDesc(active)]
  }
  const defaultName = (desc) => (desc.kind === 'style' ? '' : (data?.name || ''))
  const nameOf = (desc) => (names[desc.id] !== undefined ? names[desc.id] : defaultName(desc))

  async function fetchList(desc) {
    try {
      let arr = []
      if (desc.kind === 'slot') {
        const d = await libraryList(desc.slot)
        arr = (d.items || []).map((n) => ({ value: n, label: n, mine: true }))
      } else if (desc.kind === 'style') {
        const d = await stylesList()
        arr = (d.presets || []).map((s) => ({ value: s.id ?? s.name, label: s.name || s.id, mine: !!s.mine }))
      } else if (desc.ptype === 'system') {
        arr = (sources.common || []).map((c) => ({ value: c.key, label: c.label }))
      } else if (desc.ptype === 'shared') {
        const d = await librarySharedList()
        // "계정 / 프로젝트" — shows who shared it; namespaced so names never collide
        arr = (d.items || []).map((it) => ({
          value: it.name, owner: it.owner, mine: it.mine,
          label: `${it.owner_name || '?'} / ${it.name}`,
        }))
      } else {  // user preset
        const d = await libraryList('preset')
        arr = (d.items || []).map((n) => ({ value: n, label: n, mine: true }))
      }
      setLibItems((m) => ({ ...m, [desc.id]: arr }))
    } catch (e) { setMsg(String(e.message || e)) }
  }
  useEffect(() => {
    if (fileOpen) visibleDescs().forEach(fetchList)
  }, [fileOpen, active, presetType, mergedType, cols, sources])

  const isPersistTarget = (desc) => desc.kind === 'preset' || desc.slot === active
  async function doSave(desc, overwrite = false) {
    if (!desc.save) return
    const name = (nameOf(desc) || '').trim()
    if (!name) { setMsg('이름을 입력하세요.'); return }
    if (desc.kind === 'style') {   // save the preview JSON as a named style preset
      let parsed
      try { parsed = styleText.trim() ? JSON.parse(styleText) : null }
      catch { setMsg('스타일 JSON 을 해석할 수 없습니다.'); return }
      if (!parsed) { setMsg('저장할 스타일이 없습니다 — 먼저 붙여넣으세요.'); return }
      try {
        await stylesSave(name, normStyle(parsed), false)
        fetchList(desc); flash('저장됨 — style / ' + name)
      } catch (e) { setMsg(e.detail || String(e.message || e)) }
      return
    }
    const bad = findEmpty()
    if (bad) { setMsg(`빈 숫자 칸이 ${bad.length}개 있습니다 — 채워주세요.`); try { bad[0].focus() } catch {} ; return }
    try {
      // presets also carry the current viewer style (published by the Simulation tab)
      const style = desc.kind === 'preset' ? (window.__nptoyStyle || null) : null
      if (dirty && isPersistTarget(desc)) {   // persist the open editor first so the copy is current
        if (slot === CS) await csSave(content); else await inputsSaveFile(slot, content)
        setDirty(false)
      }
      if (desc.kind === 'slot') await librarySave(desc.slot, name, overwrite)
      else if (desc.ptype === 'shared') await librarySharedSave(name, overwrite, style)
      else await librarySave('preset', name, overwrite, style)   // user preset
      setConfirmSave(''); setMsg(''); fetchList(desc); reloadState()
      flash(`저장됨 — ${desc.label} / ${name}`)
    } catch (e) {
      // 409 = my own name exists → offer 덮어쓰기?/취소 (no repeated error text).
      if (e.status === 409) { setConfirmSave(desc.id); setMsg('') }
      else { setConfirmSave(''); setMsg(e.detail || String(e.message || e)) }  // 403 etc. show once
    }
  }
  async function doLoad(desc, name, owner) {
    if (!name) return
    try {
      if (desc.kind === 'style') {
        const d = await stylesLoad(name)   // `name` is the preset id
        const blob = normStyle(d && d.data)
        setStyleText(JSON.stringify(blob, null, 2))
        window.dispatchEvent(new CustomEvent('nptoy-style-apply', { detail: blob }))
        flash('불러옴 — style 을 뷰어에 적용했습니다')
        return
      }
      if (desc.kind === 'slot') {
        await libraryLoad(desc.slot, name)
        setChanged((prev) => new Set([...prev, desc.slot]))
        if (desc.slot === active) { if (active === CS) openCS(); else openSlot(active, SLOT_LABEL[active]) }
        reloadState()
      } else {   // preset — replaces every slot (and the viewer style, if it has one)
        let resp = null
        if (desc.ptype === 'system') await inputsLoadExample(name)
        else if (desc.ptype === 'shared') resp = await librarySharedLoad(owner, name)
        else resp = await libraryLoad('preset', name)
        await afterConfigLoad()
        if (resp && resp.style) {
          window.dispatchEvent(new CustomEvent('nptoy-style-apply', { detail: resp.style }))
          setChanged((prev) => new Set([...prev, 'style']))   // the viewer style changed too → mark the rail
        }
      }
      setNames((m) => ({ ...m, [desc.id]: name }))
      flash('불러옴 — ' + name)
    } catch (e) { setMsg(e.detail || e.message || String(e)) }
  }
  async function doDelete(desc, name, owner) {
    try {
      if (desc.kind === 'slot') await libraryDelete(desc.slot, name)
      else if (desc.kind === 'style') await stylesDelete(name)
      else if (desc.ptype === 'shared') await librarySharedDelete(owner, name)
      else await libraryDelete('preset', name)
      fetchList(desc); if (pick && pick.id === desc.id && pick.name === name) setPick(null)
    } catch (e) { setMsg(e.detail || String(e.message || e)) }
  }
  const canDelete = (desc, it) =>
    desc.kind === 'slot' ||
    (desc.kind === 'style' && it.mine) ||
    (desc.kind === 'preset' && (desc.ptype === 'user' || (desc.ptype === 'shared' && it.mine)))

  // Apply the pasted/loaded style JSON to the viewer without saving it.
  function applyStyle() {
    try {
      const parsed = styleText.trim() ? JSON.parse(styleText) : null
      if (!parsed) { setMsg('붙여넣은 스타일이 없습니다.'); return }
      window.dispatchEvent(new CustomEvent('nptoy-style-apply', { detail: normStyle(parsed) }))
      flash('스타일을 뷰어에 적용했습니다.')
    } catch { setMsg('스타일 JSON 을 해석할 수 없습니다.') }
  }

  // Command-mode number keys: 1 = file box 열기/닫기, 0 = 닫기,
  // 2..8 = preset / physics / detector / reaction / x-section / analysis / style.
  useEffect(() => {
    const onKey = (e) => {
      if (!rootRef.current || rootRef.current.offsetParent === null) return
      const tag = (e.target.tagName || '').toUpperCase()
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      let handled = true
      if (e.key === '1') setFileOpen((v) => !v)
      else if (e.key === '0') setFileOpen(false)
      else if (e.key >= '2' && e.key <= '8') { const it = RAIL_ITEMS[Number(e.key) - 2]; if (it) selectMenu(it.key) }
      else handled = false
      if (handled) { e.preventDefault(); e.stopImmediatePropagation() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active])

  if (!data) return <div className="placeholder">{msg || '…'}</div>

  const title = label || SLOT_LABEL[active] || active
  const isEditorSlot = EDITOR_KEYS.includes(active)
  const descs = visibleDescs()

  // One file box (name · save · load · list) for a descriptor. `selector` is an
  // optional header (the preset sub-type switch on narrow screens).
  const fileBox = (desc, selector, fill) => {
    const items = libItems[desc.id] || []
    return (
      <div key={desc.id} className={`filespanel setupbox setupfilebox ${fill ? 'fill' : ''}`}>
        <div className="fphead">
          <span className="fptitle">file · {desc.label}</span>
          <button className="fpclose" onClick={() => setFileOpen(false)} title="닫기">✕</button>
        </div>
        <div className="setupbody">
          {selector}
          <input className="filname" value={nameOf(desc)} disabled={!desc.save}
            onChange={(e) => setNames((m) => ({ ...m, [desc.id]: e.target.value }))}
            placeholder={desc.save ? '이름 (저장 시 사용)' : '저장할 수 없는 목록'}
            title="저장할 때 쓰이는 이름. load 하면 불러온 이름이 채워집니다." />
          {confirmSave === desc.id ? (
            <div className="filbtns">
              <button className="sbtn stop" onClick={() => doSave(desc, true)}>덮어쓰기?</button>
              <button className="sbtn" onClick={() => setConfirmSave('')}>취소</button>
            </div>
          ) : (
            <button className="sbtn go filsavebtn" disabled={!desc.save} onClick={() => doSave(desc)}
              title={desc.save ? '현재 내용을 위 이름으로 저장' : 'system 목록에는 저장할 수 없습니다'}>save</button>
          )}
          <button className="sbtn go filloadbtn" disabled={!pick || pick.id !== desc.id}
            onClick={() => doLoad(desc, pick.name, pick.owner)}>load</button>
          <div className="fillist">
            {!items.length ? (
              <div className="filempty">— 비어 있음 —</div>
            ) : items.map((it) => {
              const sel = pick && pick.id === desc.id && pick.name === it.value
              return (
                <div key={it.value} className={`filrow ${sel ? 'on' : ''}`}
                  onClick={() => setPick({ id: desc.id, name: it.value, owner: it.owner })}
                  onDoubleClick={() => doLoad(desc, it.value, it.owner)} title={it.label}>
                  <span className="filrowname">{it.label}</span>
                  {canDelete(desc, it) && (
                    <button className="filrowdel" title="삭제"
                      onClick={(e) => { e.stopPropagation(); doDelete(desc, it.value, it.owner) }}>×</button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  const presetSelector = (
    <div className="preseg">
      {PRESET_TYPES.map((t) => (
        <button key={t} className={presetType === t ? 'on' : ''}
          onClick={() => { setPresetType(t); setPick(null); setConfirmSave('') }}>{t}</button>
      ))}
    </div>
  )
  // 2-box layout merges system + shared into one box with a toggle.
  const mergedSelector = (
    <div className="preseg">
      {['system', 'shared'].map((t) => (
        <button key={t} className={mergedType === t ? 'on' : ''}
          onClick={() => { setMergedType(t); setPick(null); setConfirmSave('') }}>{t}</button>
      ))}
    </div>
  )

  return (
    <div className="inputstab" ref={rootRef}>
      {/* ── icon rail (dock): duplicate-openable `file`, a divider, then the menus ── */}
      <div className="filesrail">
        <button title="file (목록 열기 / 닫기)"
          onClick={() => setFileOpen((v) => !v)}
          className={`railbtn dup ${fileOpen ? 'on' : ''}`}>
          <Package size={20} weight={fileOpen ? 'fill' : 'regular'} /><span>file</span>
        </button>
        <div className="railsep" />
        {RAIL_ITEMS.map(({ key, label: lbl, Icon }) => {
          const editor = EDITOR_KEYS.includes(key)
          const markable = editor || key === 'style'   // style also gets the preset-changed border
          return (
            <button key={key} title={lbl} onClick={() => selectMenu(key)}
              className={`railbtn ${active === key ? 'on' : ''} ${markable && changed.has(key) ? 'changed' : ''} ${editor && (data.blank || []).includes(key) ? 'needfill' : ''}`}>
              <Icon size={20} weight={active === key ? 'fill' : 'regular'} /><span>{lbl}</span>
            </button>
          )
        })}
      </div>

      {/* ── file box(es) — preset: 3 boxes / 2 boxes (system+shared merged) / 1 box ── */}
      {fileOpen && active === 'preset' && (
        cols >= 3 ? PRESET_TYPES.map((t) => fileBox(presetDesc(t), null, true))
          : cols === 2 ? [
            fileBox(presetDesc(mergedType), mergedSelector, true),
            fileBox(presetDesc('user'), null, true),
          ]
          : fileBox(presetDesc(presetType), presetSelector, true)
      )}
      {fileOpen && active !== 'preset' && fileBox(descs[0], null, false)}

      {/* ── right pane: editor (slots), style preview, or a hint (preset closed) ── */}
      {isEditorSlot ? (
        <div className="filespanel setupbox setupeditor" ref={editorRef}>
          <div className="fphead editorhead">
            <span className="fptitle">{title}{dirty ? ' •' : ''}</span>
            <div className="fpctl">
              {FORM_SLOTS[active] && (
                <div className="modetoggle">
                  <button className={mode === 'form' ? 'on' : ''} onClick={() => switchMode('form')}>form</button>
                  <button className={mode === 'text' ? 'on' : ''} onClick={() => switchMode('text')}>text</button>
                </div>
              )}
              <button className="sbtn go" disabled={!dirty} onClick={save}>apply</button>
            </div>
          </div>

          {slot === CS ? (
            <div className="editorarea">
              <CrossSectionEditor path={csPath} value={content} files={csFiles}
                onPick={csPick} onSaveAs={csSaveAs}
                onChange={(t) => { setContent(t); setDirty(true) }} />
            </div>
          ) : active === 'analysis' ? (
            <div className="editorarea"><div className="formscroll">
              <AnalysisSetup key={fileKey} initialText={content}
                onChange={(t) => { setContent(t); setDirty(true) }} />
            </div></div>
          ) : FORM_SLOTS[slot] && mode === 'form' ? (
            <div className="editorarea"><div className="formscroll">
              {React.createElement(FORM_SLOTS[slot], {
                key: fileKey, initialText: content, csFiles,
                onChange: (t) => { setContent(t); setDirty(true) },
              })}
            </div></div>
          ) : (
            <div className="editorarea">
              <textarea value={content} spellCheck={false}
                onChange={(e) => { setContent(e.target.value); setDirty(true) }} />
            </div>
          )}
        </div>
      ) : active === 'style' ? (
        <div className="filespanel setupbox setupeditor">
          <div className="fphead">
            <span className="fptitle">style</span>
            <button className="sbtn go" disabled={!styleText.trim()} onClick={applyStyle}
              title="붙여넣은 스타일을 뷰어에 적용">적용</button>
          </div>
          {!styleText.trim() && (
            <div className="styleguide">
              아직 스타일이 없습니다.<br />
              <b>Simulation</b> 탭에서 <b>run</b> 한 뒤, <b>volumes ▸ 스타일 관리 ▸ 복사하기</b> 를
              눌러 복사한 스타일을 아래 칸에 붙여넣으세요. 그런 다음 왼쪽 <b>file</b> 에서 이름을
              지어 <b>save</b> 하면 스타일 프리셋으로 저장됩니다.
            </div>
          )}
          <div className="editorarea">
            <textarea value={styleText} spellCheck={false}
              placeholder='여기에 스타일 JSON 을 붙여넣기  (예: {"styles":{…},"hidden":[…]})'
              onChange={(e) => setStyleText(e.target.value)} />
          </div>
        </div>
      ) : !fileOpen ? (
        <div className="filespanel setupbox setupeditor setuphint">
          <div className="setupbody">
            <div className="filempty">왼쪽 <b>file</b> 을 열면 <b>preset</b> 목록이 표시됩니다.</div>
            <button className="sbtn go" onClick={() => setFileOpen(true)}>file 열기</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
