import React, { useEffect, useState } from 'react'
import { slotlibList, slotlibSave, slotlibLoad, slotlibShare, slotlibDelete } from './api.js'

// Per-slot save/load library: save the current editor content under a name (optionally
// shared with other users), and load / share / delete saved entries — independently of
// full presets. Collapsible; used inside each Setup editor box.
export default function SlotLibrary({ slot, content, onLoad, flash }) {
  const [items, setItems] = useState([])
  const [name, setName] = useState('')
  const [pick, setPick] = useState('')
  const [shareNew, setShareNew] = useState(false)
  const [open, setOpen] = useState(false)

  const refresh = () => slotlibList(slot).then((d) => setItems(d.items || [])).catch(() => setItems([]))
  useEffect(() => { setPick(''); refresh() }, [slot])
  const cur = items.find((i) => i.id === pick)
  const note = (m) => flash && flash(m)

  async function doSave() {
    if (!name.trim()) return
    try { await slotlibSave(slot, name.trim(), content, shareNew); setName(''); refresh(); note('라이브러리에 저장됨') }
    catch (e) { note(String(e.message || e)) }
  }
  async function doLoad() {
    if (!pick) return
    try { const r = await slotlibLoad(slot, pick); onLoad(r.content); note('불러옴 — ' + (cur?.name || '')) }
    catch (e) { note(String(e.message || e)) }
  }
  async function toggleShare() {
    if (!cur?.mine) return
    try { await slotlibShare(slot, pick, !cur.shared); refresh() } catch (e) { note(String(e.message || e)) }
  }
  async function doDelete() {
    if (!cur?.mine) return
    try { await slotlibDelete(slot, pick); setPick(''); refresh(); note('삭제됨') } catch (e) { note(String(e.message || e)) }
  }

  return (
    <div className="slotlib">
      <button className="slotlibtog" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} 개별 저장 · 불러오기{items.length ? ` (${items.length})` : ''}
      </button>
      {open && (
        <div className="slotlibbody">
          <div className="srow">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="이름으로 저장" />
            <label className="slshare" title="다른 사용자와 공유">
              <input type="checkbox" checked={shareNew} onChange={(e) => setShareNew(e.target.checked)} />공유
            </label>
            <button className="sbtn go" onClick={doSave} disabled={!name.trim()}>저장</button>
          </div>
          <div className="srow">
            <select value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">(불러올 항목 선택)</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}{i.mine ? (i.shared ? ' · 공유중' : '') : ' · ' + (i.owner_name || '공유')}
                </option>
              ))}
            </select>
            <button className="sbtn go" onClick={doLoad} disabled={!pick}>불러오기</button>
          </div>
          {cur?.mine && (
            <div className="srow">
              <button className="sbtn" onClick={toggleShare}>{cur.shared ? '공유 해제' : '공유하기'}</button>
              <button className="sbtn stop" onClick={doDelete}>삭제</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
