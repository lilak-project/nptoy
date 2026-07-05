import React, { useEffect, useMemo, useState } from 'react'
import { configsList, configsSave, configsLoad, configsShare, configsDelete } from './api.js'

// Save the current setup under a name; pick a saved one from a dropdown to reload
// it (share / delete sit beside the dropdown) — mirrors the volume StylePresets UI.
export default function Configs({ onLoaded, onSaved, project }) {
  const [list, setList] = useState([])
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const [msg, setMsg] = useState('')
  const [selected, setSelected] = useState('')     // dropdown: chosen setup id
  const [confirmDel, setConfirmDel] = useState(false)

  const sel = useMemo(() => list.find((c) => c.id === selected) || null, [list, selected])
  const refresh = () => configsList().then((d) => setList(d.configs)).catch(() => {})
  useEffect(() => { refresh() }, [])
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 1600) }

  async function save() {
    if (!name.trim()) return
    try {
      await configsSave(name.trim(), shared); setName(''); setShared(false)
      flash('저장됨'); refresh(); onSaved && onSaved()
    } catch (e) { flash(e.message || String(e)) }
  }
  async function load(id) {
    if (!id) return
    try { await configsLoad(id); flash('불러옴 — ' + (list.find((c) => c.id === id)?.name || '')); onLoaded && onLoaded() }
    catch (e) { flash(e.detail || e.message || String(e)) }
  }
  async function toggleShare() {
    if (!sel?.mine) return
    try { await configsShare(sel.id, !sel.shared); flash(sel.shared ? '공유 해제됨' : '공유됨'); refresh() }
    catch (e) { flash(e.message || String(e)) }
  }
  async function remove() {
    if (!sel?.mine) return
    if (!confirmDel) { setConfirmDel(true); return }
    setConfirmDel(false)
    try { await configsDelete(sel.id); flash('삭제됨'); setSelected(''); refresh() }
    catch (e) { flash(e.message || String(e)) }
  }

  return (
    <div className="configs">
      <div className="ssect2">
        <div className="slabel">save and load</div>
        {/* save the current setup under a name */}
        <div className="srow">
          <input type="text" placeholder="이름" value={name}
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        </div>
        <div className="srow">
          <button className="sbtn go" style={{ flex: 1 }} onClick={save} disabled={!name.trim()}>save</button>
        </div>
        <label className="shareck">
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          share (다른 사람도 사용)
        </label>

        {/* pick a saved setup (share / delete beside it), then press load */}
        <div className="srow sppick">
          <select value={selected}
            onChange={(e) => { setConfirmDel(false); setSelected(e.target.value) }}>
            <option value="">저장된 setup 선택…</option>
            {list.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{c.mine ? '' : ` · ${c.owner_name}`}{c.shared ? ' (shared)' : ''}
              </option>
            ))}
          </select>
          <button className="confbtn" disabled={!sel?.mine}
            title={sel?.shared ? '공유 해제' : '공유'} onClick={toggleShare}>{sel?.shared ? '🔓' : '🔒'}</button>
          <button className={`confbtn ${confirmDel ? 'delconfirm' : ''}`} disabled={!sel?.mine}
            title={confirmDel ? '한 번 더 누르면 삭제' : '삭제'} onClick={remove}>{confirmDel ? '삭제?' : '✕'}</button>
        </div>
        <div className="srow">
          <button className="sbtn go" style={{ flex: 1 }} disabled={!selected}
            onClick={() => load(selected)}>load</button>
        </div>
      </div>
      {msg && <div className="emsg">{msg}</div>}
      <div className="projspace" aria-hidden>&nbsp;</div>
    </div>
  )
}
