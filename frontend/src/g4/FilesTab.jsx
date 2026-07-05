import React, { useEffect, useRef, useState } from 'react'
import { filesList, filesRead, filesDelete, downloadFile, downloadFilesZip, rbrowserOpen } from './api.js'

const MB = 1024 * 1024
const fmt = (b) => (b == null ? '' : b >= MB ? (b / MB).toFixed(1) + ' MB'
  : b >= 1024 ? (b / 1024).toFixed(0) + ' KB' : b + ' B')
const fmtTime = (t) => (t ? new Date(t * 1000).toLocaleString() : '')

// Files tab: a browser of the user's data folder. Left third lists the current
// directory (with running folder-usage total); files open on the right — text
// renders inline, anything downloads. Multi-select (cmd/ctrl + shift click) enables
// bundled zip-download and delete. `active` (from the Shell) re-lists on tab entry.
export default function FilesTab({ active = true }) {
  const [dir, setDir] = useState(null)        // { path, entries, usage, quota }
  const [preview, setPreview] = useState(null) // single opened file info
  const [sel, setSel] = useState(new Set())    // selected entry paths (batch ops)
  const [confirmDel, setConfirmDel] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const pathRef = useRef('')
  const anchorRef = useRef(-1)                  // index for shift-range selection

  const open = (path = '') => {
    pathRef.current = path
    setErr(''); setSel(new Set()); setPreview(null); setConfirmDel(false); anchorRef.current = -1
    filesList(path).then(setDir).catch((e) => setErr(String(e.message || e)))
  }
  const refresh = () => open(pathRef.current)
  useEffect(() => { open('') }, [])
  // Re-list whenever the tab becomes active (files may have changed elsewhere).
  useEffect(() => { if (active) open(pathRef.current) }, [active])

  const rowClick = (entry, i, ev) => {
    setConfirmDel(false)
    if (ev.shiftKey && anchorRef.current >= 0 && dir) {
      const [a, b] = [anchorRef.current, i].sort((x, y) => x - y)
      setSel(new Set(dir.entries.slice(a, b + 1).map((e) => e.path)))
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
    // plain click: folder navigates; file selects + previews
    if (entry.is_dir) { open(entry.path); return }
    anchorRef.current = i
    setSel(new Set([entry.path]))
    filesRead(entry.path).then(setPreview).catch((e) => setErr(String(e.message || e)))
  }

  async function doDelete(paths) {
    if (!paths.length) return
    setBusy(true); setErr('')
    try { await filesDelete(paths); refresh() }
    catch (e) { setErr(String(e.message || e)) }
    finally { setBusy(false) }
  }
  const dlZip = (paths) => downloadFilesZip(paths).catch((e) => setErr(String(e.message || e)))

  // Open a ROOT file in a confined RBrowser (scoped to this user's folder). One
  // RBrowser per user: the fixed window name reuses the same tab, and the backend
  // reuses the same process — so a second .root lands in the existing window.
  async function openRBrowser(path) {
    setBusy(true); setErr('')
    // Open the window synchronously (inside the click) so popup-blockers allow it,
    // then point it at the URL once the backend confirms the session.
    const win = window.open('', 'nptoy_rbrowser')
    try {
      const { url } = await rbrowserOpen(path)
      if (win) win.location.href = url
      else window.open(url, 'nptoy_rbrowser')   // fallback if the blank open failed
    } catch (e) {
      if (win) win.close()
      setErr('RBrowser 열기 실패: ' + String(e.message || e))
    } finally {
      setBusy(false)
    }
  }

  const parent = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
  const crumbs = dir ? ['', ...dir.path.split('/').filter(Boolean).reduce((a, seg) => {
    a.push(a.length ? a[a.length - 1] + '/' + seg : seg); return a
  }, [])] : ['']
  const selEntries = dir ? dir.entries.filter((e) => sel.has(e.path)) : []
  const selBytes = selEntries.reduce((a, e) => a + (e.size || 0), 0)
  // Batch panel whenever ≥1 is selected without an open preview (covers cmd/shift
  // multi-select AND a single cmd-clicked file/folder → so a folder can be deleted).
  const showBatch = !preview && sel.size >= 1

  return (
    <div className="filesbrowse">
      {/* ── left: directory listing ─────────────────────────────────────── */}
      <div className="filesnav">
        <div className="fileshead">
          <span className="filestitle">파일</span>
          {dir && (
            <span className="filesusage" title="유저 폴더 총 용량">
              {fmt(dir.usage)}{dir.quota ? ` / ${fmt(dir.quota)}` : ''}
            </span>
          )}
          <button className="filesreload" title="새로고침" onClick={refresh}>↻</button>
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

        <div className="fileslist">
          {dir && dir.path !== '' && (
            <button className="filerow up" onClick={() => open(parent(dir.path))}>
              <span className="fileicon">↩</span><span className="filename">..</span>
            </button>
          )}
          {dir && dir.entries.map((e, i) => (
            <button key={e.path}
              className={`filerow ${e.is_dir ? 'dir' : 'file'} ${sel.has(e.path) ? 'on' : ''}`}
              onClick={(ev) => rowClick(e, i, ev)} title={e.name}>
              <span className="fileicon">{e.is_dir ? '📁' : '📄'}</span>
              <span className="filename">{e.name}</span>
              <span className="filesize">{fmt(e.size)}</span>
            </button>
          ))}
          {dir && !dir.entries.length && <div className="dnote">빈 폴더입니다.</div>}
          {!dir && !err && <div className="dnote">로딩 중…</div>}
          {err && <div className="dnote warn">⚠ {err}</div>}
        </div>
        <div className="filestip">shift · ⌘/ctrl 클릭으로 여러 개 선택</div>
      </div>

      {/* ── right: batch panel / file preview ────────────────────────────── */}
      <div className="filesview">
        {showBatch ? (
          <div className="fvbatch">
            <div className="fvhead">
              <div className="fvtitle"><span className="fvname">{sel.size}개 선택됨</span>
                <span className="fvpath">총 {fmt(selBytes)}</span></div>
            </div>
            <div className="fvactions">
              <button className="sbtn go" disabled={busy} onClick={() => dlZip([...sel])}>zip 다운로드</button>
              <button className={`sbtn ${confirmDel ? 'stop' : ''}`} disabled={busy}
                onClick={() => (confirmDel ? doDelete([...sel]) : setConfirmDel(true))}>
                {confirmDel ? '정말 삭제?' : '삭제'}</button>
            </div>
            <div className="fvsellist">
              {selEntries.map((e) => (
                <div className="fvselrow" key={e.path}>
                  <span className="fileicon">{e.is_dir ? '📁' : '📄'}</span>
                  <span className="filename">{e.path}</span>
                  <span className="filesize">{fmt(e.size)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : !preview ? (
          <div className="placeholder">파일을 선택하면 여기에 내용이 표시됩니다.</div>
        ) : (
          <>
            <div className="fvhead">
              <div className="fvtitle">
                <span className="fvname">{preview.name}</span>
                <span className="fvpath">{preview.path}</span>
              </div>
              <div className="fvactions">
                {preview.ext === 'root' && (
                  <button className="sbtn" onClick={() => openRBrowser(preview.path)}>RBrowser 열기</button>
                )}
                <button className="sbtn go" onClick={() => downloadFile(preview.path)}>다운로드</button>
                <button className={`sbtn ${confirmDel ? 'stop' : ''}`} disabled={busy}
                  onClick={() => (confirmDel ? doDelete([preview.path]) : setConfirmDel(true))}>
                  {confirmDel ? '정말 삭제?' : '삭제'}</button>
              </div>
            </div>
            <div className="fvmeta">
              <span>{fmt(preview.size)}</span><span>·</span>
              <span>{preview.ext ? preview.ext.toUpperCase() : '파일'}</span><span>·</span>
              <span>{fmtTime(preview.mtime)}</span>
            </div>
            {preview.is_text ? (
              <>
                {preview.truncated && <div className="dnote warn">⚠ 파일이 커서 앞부분 512KB만 표시합니다.</div>}
                <pre className="fvtext">{preview.content}</pre>
              </>
            ) : (
              <div className="fvbinary">텍스트로 미리볼 수 없는 파일입니다. 다운로드해서 확인하세요.</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
