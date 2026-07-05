import React, { useEffect, useState } from 'react'
import DetectorForm from './DetectorForm.jsx'
import ReactionForm from './ReactionForm.jsx'
import PhysicsForm from './PhysicsForm.jsx'
import CrossSectionEditor from './CrossSectionEditor.jsx'
import Configs from './Configs.jsx'
import {
  inputsState, inputsGetFile, inputsSaveFile, inputsLoadExample, csGet, csSave, csCandidates,
  inputsSources, configsLoad, configsShare,
} from './api.js'

const FORM_SLOTS = { detector: DetectorForm, reaction: ReactionForm, physics: PhysicsForm }
const CS = 'crosssection'

// Setup tab: edit the three input files (Physics list / Detector / Reaction) that
// the simulation runs against. project.config + unused macros are managed/hidden.
export default function InputsTab({ me, onSetupName }) {
  const [data, setData] = useState(null)     // {slots, examples, project}
  const [slot, setSlot] = useState('')
  const [label, setLabel] = useState('')
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  const [msg, setMsg] = useState('')
  const [mode, setMode] = useState('text')     // 'form' | 'text' (detector/reaction)
  const [fileKey, setFileKey] = useState(0)     // remounts the form on (re)parse
  const [csPath, setCsPath] = useState('')
  const [csFiles, setCsFiles] = useState([])    // available cross-section files
  const [sources, setSources] = useState({ common: [], users: [], me: '' })
  const [srcKey, setSrcKey] = useState('common')  // 'common' | 'user:<owner>'
  const [setupKey, setSetupKey] = useState('')    // preset key or shared save id

  async function load() {
    try {
      const d = await inputsState()
      setData(d)
      const rea = d.slots.find((s) => s.key === 'reaction')   // default to Reaction
      if (rea && !slot) openSlot(rea)
    } catch (e) { setMsg(e.status === 401 ? '포탈 로그인 필요' : String(e.message || e)) }
  }
  const refreshSources = () => inputsSources()
    .then((d) => setSources({ common: d.common || [], users: d.users || [], me: d.me })).catch(() => {})
  useEffect(() => {
    load(); refreshSources()
    csCandidates().then((d) => setCsFiles(d.files)).catch(() => {})
  }, [])

  useEffect(() => { if (data && onSetupName) onSetupName({ name: data.name, run: data.run }) }, [data])
  const reloadState = () => inputsState().then(setData).catch(() => {})

  const curUser = srcKey.startsWith('user:')
    ? sources.users.find((u) => u.owner === srcKey.slice(5)) : null
  const loadItems = srcKey === 'common'
    ? sources.common.map((c) => ({ value: c.key, label: c.label }))
    : (curUser?.items || []).map((i) => ({ value: i.id, label: i.name }))
  useEffect(() => {
    // keep the current selection if it's still valid (so loading a preset doesn't
    // snap the dropdown back to the first item); only default when it's gone.
    const vals = srcKey === 'common'
      ? sources.common.map((c) => c.key)
      : (sources.users.find((u) => u.owner === srcKey.slice(5))?.items || []).map((i) => i.id)
    if (!vals.includes(setupKey)) {
      // default to the CURRENTLY loaded setup (manifest example) when it's a preset
      const pref = srcKey === 'common' && data && vals.includes(data.example) ? data.example : vals[0]
      setSetupKey(pref || '')
    }
  }, [srcKey, sources, data])
  const canDelShare = !!(curUser && curUser.owner === sources.me && setupKey)

  async function openSlot(s) {
    try {
      const r = await inputsGetFile(s.key)
      setSlot(s.key); setLabel(s.label); setContent(r.content); setDirty(false); setMsg('')
      setMode(FORM_SLOTS[s.key] ? 'form' : 'text')
      setFileKey((k) => k + 1)
    } catch (e) { setMsg(String(e.message || e)) }
  }
  function switchMode(m) { setMode(m); setFileKey((k) => k + 1) }   // re-parse on switch
  async function afterConfigLoad() {                                // reload state + open reaction
    const fresh = await inputsState(); setData(fresh)
    const rea = fresh.slots.find((s) => s.key === 'reaction'); if (rea) openSlot(rea)
  }
  async function openCS() {
    try {
      const r = await csGet()
      setSlot(CS); setLabel('Cross-section'); setContent(r.content); setCsPath(r.path)
      setDirty(false); setMsg('')
    } catch (e) { setMsg(String(e.message || e)) }
  }
  async function csPick(name) {                       // load a different CS file
    try {
      const r = await csGet(name)
      setContent(r.content); setCsPath(name); setDirty(false); setMsg('')
    } catch (e) { setMsg(String(e.message || e)) }
  }
  async function csSaveAs(name) {                      // save current content under a name
    try {
      const r = await csSave(content, name)
      setCsPath(r.path || name); setDirty(false)
      csCandidates().then((d) => setCsFiles(d.files)).catch(() => {})
      flash('저장됨 — ' + (r.path || name))
    } catch (e) { setMsg(String(e.message || e)) }
  }
  async function save() {
    try {
      if (slot === CS) await csSave(content)
      else await inputsSaveFile(slot, content)
      setDirty(false); flash('저장됨 — ' + label)
    } catch (e) { setMsg(e.message || String(e)) }
  }
  async function doLoad() {                         // single click, applies immediately
    if (!setupKey) return
    const label = loadItems.find((i) => i.value === setupKey)?.label || setupKey
    try {
      if (srcKey === 'common') await inputsLoadExample(setupKey)
      else await configsLoad(setupKey)
      await afterConfigLoad()
      flash('불러옴 — ' + label); refreshSources()
    } catch (e) { setMsg(e.detail || e.message || String(e)) }
  }
  async function doDeleteShare() {                  // owner un-shares their input
    const label = loadItems.find((i) => i.value === setupKey)?.label || setupKey
    try { await configsShare(setupKey, false); flash('공유 제거됨 — ' + label); refreshSources() }
    catch (e) { setMsg(e.detail || e.message || String(e)) }
  }
  function flash(m) { setMsg(m); setTimeout(() => setMsg(''), 1800) }

  if (!data) return <div className="placeholder">{msg || '…'}</div>

  return (
    <div className="inputstab">
      <aside className="filesidebar">
        <div className="slabel">files</div>
        <div className="filelist big">
          {data.slots.map((s) => (
            <button key={s.key} className={`filerow ${s.key === slot ? 'on' : ''}`} onClick={() => openSlot(s)}>
              <span className="fname">{s.label}</span>
            </button>
          ))}
          <button className={`filerow ${slot === CS ? 'on' : ''}`} onClick={openCS}>
            <span className="fname">Cross-section</span>
          </button>
        </div>

        <div className="sidefoot">
          <div className="ssect2">
            <div className="slabel" title="프리셋 또는 다른 사용자가 공유한 입력을 불러옵니다">load input</div>
            <div className="srow">
              <select value={srcKey} onChange={(e) => setSrcKey(e.target.value)} title="출처">
                <option value="common">common (프리셋)</option>
                {sources.users.map((u) => (
                  <option key={u.owner} value={'user:' + u.owner}>{u.owner_name || u.owner}</option>
                ))}
              </select>
            </div>
            <div className="srow">
              <select value={setupKey} onChange={(e) => setSetupKey(e.target.value)} title="설정">
                {loadItems.length === 0 && <option value="">(없음)</option>}
                {loadItems.map((it) => <option key={it.value} value={it.value}>{it.label}</option>)}
              </select>
            </div>
            <div className="srow">
              <button className="sbtn go" style={{ flex: 1 }} onClick={doLoad} disabled={!setupKey}>load</button>
            </div>
            {canDelShare && (
              <button className="sbtn stop" onClick={doDeleteShare}>선택한 공유 삭제</button>
            )}
          </div>
          <Configs onLoaded={afterConfigLoad} onSaved={reloadState} project={data.project} />
        </div>
      </aside>

      <main className="editorarea">
        {slot ? (
          <>
            <div className="ehead">
              <span className="ename">{label}{dirty ? ' •' : ''}</span>
              {FORM_SLOTS[slot] && (
                <div className="modetoggle">
                  <button className={mode === 'form' ? 'on' : ''} onClick={() => switchMode('form')}>form</button>
                  <button className={mode === 'text' ? 'on' : ''} onClick={() => switchMode('text')}>text</button>
                </div>
              )}
              {msg && <span className="emsg">{msg}</span>}
              <button className="sbtn go" disabled={!dirty} onClick={save}>save</button>
            </div>
            {slot === CS ? (
              <CrossSectionEditor path={csPath} value={content} files={csFiles}
                onPick={csPick} onSaveAs={csSaveAs}
                onChange={(t) => { setContent(t); setDirty(true) }} />
            ) : FORM_SLOTS[slot] && mode === 'form' ? (
              <div className="formscroll">
                {React.createElement(FORM_SLOTS[slot], {
                  key: fileKey, initialText: content, csFiles,
                  onChange: (t) => { setContent(t); setDirty(true) },
                })}
              </div>
            ) : (
              <textarea value={content} spellCheck={false}
                onChange={(e) => { setContent(e.target.value); setDirty(true) }} />
            )}
          </>
        ) : (
          <div className="placeholder">왼쪽에서 편집할 파일을 선택하세요 (Physics list / Detector / Reaction).</div>
        )}
      </main>
    </div>
  )
}
