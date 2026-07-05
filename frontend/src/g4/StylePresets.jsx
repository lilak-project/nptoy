import React, { useEffect, useMemo, useRef, useState } from 'react'
import { stylesList, stylesSave, stylesLoad, stylesShare, stylesDelete } from './api.js'

// A preset bundles the per-volume style overrides AND the visibility (on/off) set,
// so loading it restores both. Old presets (just the style map) still load.
const pack = (styles, hidden) => ({ styles: styles || {}, hidden: hidden || [] })
function unpack(data) {
  if (data && typeof data === 'object' && 'styles' in data && 'hidden' in data) {
    return { styles: data.styles || {}, hidden: Array.isArray(data.hidden) ? data.hidden : [] }
  }
  return { styles: data || {}, hidden: [] }   // legacy: the whole blob is the style map
}

// Save / share / load named viewer-style presets (styles + visibility), pick a saved
// one from a dropdown, plus download to a .json file and drag-and-drop one back in.
export default function StylePresets({ styles, hidden, onApply }) {
  const [list, setList] = useState([])
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const [selected, setSelected] = useState('')   // dropdown: chosen preset id
  const [msg, setMsg] = useState('')
  const [confirmDel, setConfirmDel] = useState(false)
  const [drag, setDrag] = useState(false)
  const fileRef = useRef(null)

  const count = Object.keys(styles || {}).length + (hidden?.length || 0)
  const sel = useMemo(() => list.find((p) => p.id === selected) || null, [list, selected])
  const refresh = () => stylesList().then((d) => setList(d.presets || [])).catch(() => {})
  useEffect(() => { refresh() }, [])
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 1600) }

  async function save() {
    if (!name.trim()) return
    if (!count) { flash('저장할 내용이 없습니다'); return }
    try {
      await stylesSave(name.trim(), pack(styles, hidden), shared)
      setName(''); setShared(false); flash('저장됨'); refresh()
    } catch (e) { flash(e.detail || e.message || String(e)) }
  }
  async function load(id) {
    if (!id) return
    try {
      const d = await stylesLoad(id)
      const { styles: sty, hidden: hid } = unpack(d.data)
      onApply(sty, hid)
      flash('불러옴 — ' + (list.find((p) => p.id === id)?.name || ''))
    } catch (e) { flash(e.detail || e.message || String(e)) }
  }
  async function toggleShare() {
    if (!sel?.mine) return
    try { await stylesShare(sel.id, !sel.shared); refresh() } catch {}
  }
  async function remove() {
    if (!sel?.mine) return
    if (!confirmDel) { setConfirmDel(true); return }
    setConfirmDel(false)
    try { await stylesDelete(sel.id); setSelected(''); refresh() } catch {}
  }

  function download() {
    if (!count) { flash('저장할 내용이 없습니다'); return }
    const blob = new Blob([JSON.stringify(pack(styles, hidden), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'nptoy-styles.json'
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }
  async function readFile(file) {
    if (!file) return
    try {
      const obj = JSON.parse(await file.text())
      if (obj && typeof obj === 'object') {
        const { styles: sty, hidden: hid } = unpack(obj)
        onApply(sty, hid); flash('파일 불러옴 — ' + file.name)
      } else flash('올바른 스타일 파일이 아닙니다')
    } catch { flash('JSON 파싱 실패') }
  }
  function onDrop(e) {
    e.preventDefault(); setDrag(false)
    readFile(e.dataTransfer.files && e.dataTransfer.files[0])
  }

  return (
    <div className={`stylepresets ${drag ? 'dragover' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
      onDragLeave={() => setDrag(false)} onDrop={onDrop}>
      <div className="sprow">
        <input type="text" placeholder="스타일 이름" value={name}
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        <button className="sbtn go" onClick={save} disabled={!name.trim() || !count}>저장</button>
      </div>
      <label className="shareck">
        <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
        공유 (다른 사람도 사용)
      </label>

      {/* pick a saved preset from a dropdown; share / delete sit next to it */}
      <div className="sprow sppick">
        <select value={selected}
          onChange={(e) => { setConfirmDel(false); setSelected(e.target.value); load(e.target.value) }}>
          <option value="">저장된 스타일 불러오기…</option>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}{p.mine ? '' : ` · ${p.owner_name}`}{p.shared ? ' (shared)' : ''}
            </option>
          ))}
        </select>
        <button className="confbtn" disabled={!sel?.mine}
          title={sel?.shared ? '공유 해제' : '공유'} onClick={toggleShare}>{sel?.shared ? '🔓' : '🔒'}</button>
        <button className={`confbtn ${confirmDel ? 'delconfirm' : ''}`} disabled={!sel?.mine}
          title={confirmDel ? '한 번 더 누르면 삭제' : '삭제'} onClick={remove}>{confirmDel ? '삭제?' : '✕'}</button>
      </div>

      <div className="spactions">
        <button className="sbtn" onClick={download} disabled={!count}>⬇ 다운로드</button>
        <button className="sbtn" onClick={() => fileRef.current?.click()}>⬆ 파일 불러오기</button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden
          onChange={(e) => { readFile(e.target.files[0]); e.target.value = '' }} />
      </div>
      {msg && <div className="emsg">{msg}</div>}
      <div className="dnote">스타일 + 볼륨 표시(on/off)까지 함께 저장·복원됩니다. JSON 드롭도 가능.</div>
    </div>
  )
}
