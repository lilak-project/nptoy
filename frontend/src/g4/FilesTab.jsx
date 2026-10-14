import React, { useEffect, useRef, useState } from 'react'
import { RailNav } from 'lilak-ui'
import { filesList, filesRead, filesDelete, downloadFile, downloadFilesZip } from './api.js'
import RootViewer from './RootViewer.jsx'
import { ArrowClockwise, ArrowUUpLeft, Folder, File, FolderOpen, ChartBar } from '@phosphor-icons/react'

const MB = 1024 * 1024
const fmt = (b) => (b == null ? '' : b >= MB ? (b / MB).toFixed(1) + ' MB'
  : b >= 1024 ? (b / 1024).toFixed(0) + ' KB' : b + ' B')
const fmtTime = (t) => (t ? new Date(t * 1000).toLocaleString() : '')

// Files tab: a macOS-dock-style workspace (matching the Simulation tab). A left icon
// rail toggles two individual panel boxes that slide out from the LEFT —
//   ▸ 파일 브라우저: sortable directory list + the selected file's summary and
//     download/delete buttons (moved out of the preview so the preview is wider).
//   ▸ ROOT 컨트롤 (RootViewer): branch tree + draw form; opens on double-clicking a .root.
// When both are open, the file browser sits further left. The rest is the preview,
// which fills the full height — text inline, or the ROOT plots (portalled in).
export default function FilesTab({ active = true }) {
  const [dir, setDir] = useState(null)        // { path, entries, usage, quota }
  const [preview, setPreview] = useState(null) // single opened file info
  const [sel, setSel] = useState(new Set())    // selected entry paths (batch ops)
  const [confirmDel, setConfirmDel] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [showFiles, setShowFiles] = useState(true)      // 파일 브라우저 panel
  const [showRoot, setShowRoot] = useState(false)       // ROOT 컨트롤 panel
  const [rootPath, setRootPath] = useState(null)        // .root loaded in the viewer — PERSISTS across
                                                        // navigation + tab switches (independent of preview)
  const [sortKey, setSortKey] = useState('mtime')       // name | size | mtime — default newest first
  const [sortDir, setSortDir] = useState('desc')
  const [plotHost, setPlotHost] = useState(null)        // preview DOM node (RootViewer portals plots here)
  const pathRef = useRef('')
  const anchorRef = useRef(-1)                  // index for shift-range selection
  const rootRef = useRef(null)                  // tab root — number keys act only when it's visible

  const open = (path = '') => {
    pathRef.current = path
    setErr(''); setSel(new Set()); setPreview(null); setConfirmDel(false); anchorRef.current = -1
    filesList(path).then(setDir).catch((e) => setErr(String(e.message || e)))
  }
  const refresh = () => open(pathRef.current)
  useEffect(() => { open('') }, [])
  // Re-list whenever the tab becomes active (files may have changed elsewhere).
  useEffect(() => { if (active) open(pathRef.current) }, [active])

  // Number-key toggling (1 = 파일 브라우저, 2 = ROOT, 0 = 모두 닫기) now lives in the
  // shared RailNav (kit) — no local keydown handler needed.

  const clickSort = (k) => {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir(k === 'name' ? 'asc' : 'desc') }  // biggest/newest first
  }

  const cmp = (a, b) => {
    let r
    if (sortKey === 'size') r = (a.size || 0) - (b.size || 0)
    else if (sortKey === 'mtime') r = (a.mtime || 0) - (b.mtime || 0)
    else r = a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    return sortDir === 'asc' ? r : -r
  }
  const entries = dir ? [...dir.entries].sort((a, b) => (a.is_dir === b.is_dir ? cmp(a, b) : a.is_dir ? -1 : 1)) : []
  const newest = entries.reduce((m, e) => (!e.is_dir && (!m || (e.mtime || 0) > (m.mtime || 0)) ? e : m), null)
  const newestPath = newest ? newest.path : null

  const rowClick = (entry, i, ev) => {
    setConfirmDel(false)
    if (ev.shiftKey && anchorRef.current >= 0 && entries.length) {
      const [a, b] = [anchorRef.current, i].sort((x, y) => x - y)
      setSel(new Set(entries.slice(a, b + 1).map((e) => e.path)))
      setPreview(null); return
    }
    if (ev.metaKey || ev.ctrlKey) {
      setSel((prev) => {
        const n = new Set(prev)
        n.has(entry.path) ? n.delete(entry.path) : n.add(entry.path)
        return n
      })
      anchorRef.current = i; setPreview(null); return
    }
    if (entry.is_dir) { open(entry.path); return }
    anchorRef.current = i
    setSel(new Set([entry.path]))
    filesRead(entry.path).then(setPreview).catch((e) => setErr(String(e.message || e)))
  }
  // Double-click a .root → load it into the ROOT viewer (persists across navigation).
  const rowDouble = (entry) => {
    if (!entry.is_dir && /\.root$/i.test(entry.name)) { setRootPath(entry.path); setShowRoot(true) }
  }

  async function doDelete(paths) {
    if (!paths.length) return
    setBusy(true); setErr('')
    try { await filesDelete(paths); refresh() }
    catch (e) { setErr(String(e.message || e)) }
    finally { setBusy(false) }
  }
  const dlZip = (paths) => downloadFilesZip(paths).catch((e) => setErr(String(e.message || e)))

  const parent = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
  const crumbs = dir ? ['', ...dir.path.split('/').filter(Boolean).reduce((a, seg) => {
    a.push(a.length ? a[a.length - 1] + '/' + seg : seg); return a
  }, [])] : ['']
  const selEntries = entries.filter((e) => sel.has(e.path))
  const selBytes = selEntries.reduce((a, e) => a + (e.size || 0), 0)
  const showBatch = sel.size >= 1 && !preview
  const arrow = (k) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '')

  return (
    <div className="filesbrowse" ref={rootRef}>
      {/* ── far left: icon rail (shared RailNav, like Simulation). Both are
             duplicate-openable (stack alongside other panels), so they carry the
             default `dup` outline. ── */}
      <RailNav style={{ margin: '12px 0 12px 12px' }} items={[
        { id: 'files', label: '파일', title: '파일 브라우저', Icon: FolderOpen, dup: true, on: showFiles, onClick: () => setShowFiles((v) => !v) },
        { id: 'root', label: 'root', title: 'ROOT 컨트롤', Icon: ChartBar, dup: true, on: showRoot, disabled: !rootPath, onClick: () => setShowRoot((v) => !v) },
      ]} />

      {/* ── file browser panel (individual box) ──────────────────────────── */}
      {showFiles && (
        <div className="filespanel filesnav">
          <div className="fphead">
            <span className="fptitle">파일</span>
            {dir && (
              <span className="filesusage" title="유저 폴더 총 용량">
                {fmt(dir.usage)}{dir.quota ? ` / ${fmt(dir.quota)}` : ''}
              </span>
            )}
            <button className="fpicon" title="새로고침" onClick={refresh}><ArrowClockwise size={16} /></button>
          </div>

          {dir && (
            <div className="filescrumb">
              {crumbs.map((c, i) => (
                <span key={c || 'root'}>
                  {i > 0 && <span className="crumbsep">/</span>}
                  <button className="crumb" onClick={() => open(c)}>
                    {i === 0 ? '홈' : c.split('/').pop()}
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="filessort">
            <span className="filessortlbl">정렬</span>
            <button className={`sortbtn ${sortKey === 'name' ? 'on' : ''}`} onClick={() => clickSort('name')}>이름{arrow('name')}</button>
            <button className={`sortbtn ${sortKey === 'size' ? 'on' : ''}`} onClick={() => clickSort('size')}>용량{arrow('size')}</button>
            <button className={`sortbtn ${sortKey === 'mtime' ? 'on' : ''}`} onClick={() => clickSort('mtime')}>시간{arrow('mtime')}</button>
          </div>

          <div className="fileslist">
            {dir && dir.path !== '' && (
              <button className="filerow up" onClick={() => open(parent(dir.path))}>
                <span className="fileicon"><ArrowUUpLeft size={16} /></span><span className="filename">..</span>
              </button>
            )}
            {entries.map((e, i) => (
              <button key={e.path}
                className={`filerow ${e.is_dir ? 'dir' : 'file'} ${sel.has(e.path) ? 'on' : ''} ${e.path === newestPath ? 'new' : ''}`}
                onClick={(ev) => rowClick(e, i, ev)} onDoubleClick={() => rowDouble(e)} title={e.name}>
                <span className="fileicon">{e.is_dir ? <Folder size={16} weight="fill" /> : <File size={16} />}</span>
                <span className="filename">{e.name}</span>
                {e.path === newestPath && <span className="newtag">최신</span>}
                <span className="filesize">{fmt(e.size)}</span>
              </button>
            ))}
            {dir && !entries.length && <div className="dnote">빈 폴더입니다.</div>}
            {!dir && !err && <div className="dnote">로딩 중…</div>}
            {err && <div className="dnote warn">⚠ {err}</div>}
          </div>

          {showBatch ? (
            <div className="filesel">
              <div className="fvname">{sel.size}개 선택됨 · 총 {fmt(selBytes)}</div>
              <div className="fvactions">
                <button className="sbtn go" disabled={busy} onClick={() => dlZip([...sel])}>zip 다운로드</button>
                <button className={`sbtn ${confirmDel ? 'stop' : ''}`} disabled={busy}
                  onClick={() => (confirmDel ? doDelete([...sel]) : setConfirmDel(true))}>
                  {confirmDel ? '정말 삭제?' : '삭제'}</button>
              </div>
            </div>
          ) : preview ? (
            <div className="filesel">
              <div className="fvname">{preview.name}</div>
              <div className="fvpath">{preview.path}</div>
              <div className="fvmeta">
                <span>{fmt(preview.size)}</span><span>·</span>
                <span>{preview.ext ? preview.ext.toUpperCase() : '파일'}</span><span>·</span>
                <span>{fmtTime(preview.mtime)}</span>
              </div>
              <div className="fvactions">
                <button className="sbtn go" onClick={() => downloadFile(preview.path)}>다운로드</button>
                <button className={`sbtn ${confirmDel ? 'stop' : ''}`} disabled={busy}
                  onClick={() => (confirmDel ? doDelete([preview.path]) : setConfirmDel(true))}>
                  {confirmDel ? '정말 삭제?' : '삭제'}</button>
              </div>
            </div>
          ) : (
            <div className="filestip">shift · ⌘/ctrl 클릭으로 여러 개 선택 · .root 더블클릭 → ROOT 컨트롤</div>
          )}
        </div>
      )}

      {/* ── ROOT control panel (individual box, left of the preview). Mounted on
             `rootPath`, which survives folder navigation and tab switches. ─────── */}
      {rootPath && (
        <RootViewer key={rootPath} path={rootPath} controlOpen={showRoot}
          plotHost={plotHost} onCloseControl={() => setShowRoot(false)}
          onCloseViewer={() => { setRootPath(null); setShowRoot(false) }}
          onSaved={() => refresh()} />
      )}

      {/* ── middle/right: preview / plots (fills the full height) ─────────── */}
      <div className="filesmain" ref={setPlotHost}>
        {rootPath ? null /* RootViewer portals its plots here */
          : preview && preview.is_text ? (
            <div className="fvtextwrap">
              {preview.truncated && <div className="dnote warn">⚠ 파일이 커서 앞부분 512KB만 표시합니다.</div>}
              <pre className="fvtext">{preview.content}</pre>
            </div>
          ) : preview ? (
            <div className="fvbinary">텍스트로 미리볼 수 없는 파일입니다. 다운로드해서 확인하세요.</div>
          ) : (
            <div className="placeholder">파일을 선택하면 여기에 내용이 표시됩니다.</div>
          )}
      </div>
    </div>
  )
}
