import React, { useEffect, useRef, useState } from 'react'
import { jobsSubmit, jobsList, jobGet, jobCancel, fetchMe } from './api.js'

// Same transient-toast channel the session panel uses (Shell listens for it).
const notify = (text, level = 'info') =>
  window.dispatchEvent(new CustomEvent('nptoy-notify', { detail: { text, level } }))

const human = (b) => {
  if (!b) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']; let x = b, i = 0
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++ }
  return `${i ? x.toFixed(1) : x} ${u[i]}`
}
const ACTIVE = new Set(['queued', 'running'])
const ST_LABEL = { queued: '대기', running: '실행 중', done: '완료', failed: '실패', timeout: '시간초과', cancelled: '취소됨' }

// Batch run: submit `npsimulation -B` for N events from scratch — the ROOT output
// lands straight in outputs/ (unlike the disposable viewer session). Batch access is
// gated per user (managers + allowed ids only); everyone can still do viewer runs.
export default function BatchPanel() {
  const [allowed, setAllowed] = useState(null)   // null = unknown yet
  const [n, setN] = useState(1000)
  const [jobs, setJobs] = useState([])
  const [logId, setLogId] = useState(null)        // job whose log tail is shown
  const [logTail, setLogTail] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [histOpen, setHistOpen] = useState(false)   // 실행 기록: default collapsed
  const logBoxRef = useRef(null)

  useEffect(() => { fetchMe().then((m) => setAllowed(!!m.batch_allowed)).catch(() => setAllowed(false)) }, [])

  // Poll the job list while the panel is mounted; keep the newest first.
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try { const d = await jobsList(); if (alive) setJobs(d.jobs || []) } catch {}
    }
    tick()
    const id = setInterval(tick, 1500)
    return () => { alive = false; clearInterval(id) }
  }, [])

  // The log tail follows the running job by default; poll the shown job's tail.
  const running = jobs.find((j) => j.status === 'running')
  const shown = logId || running?.id || jobs[0]?.id || null
  useEffect(() => {
    if (!shown) { setLogTail(''); return }
    let alive = true
    const tick = async () => {
      try { const d = await jobGet(shown); if (alive) setLogTail(d.log_tail || '') } catch {}
    }
    tick()
    const id = setInterval(tick, 1500)
    return () => { alive = false; clearInterval(id) }
  }, [shown])
  useEffect(() => { const el = logBoxRef.current; if (el) el.scrollTop = el.scrollHeight }, [logTail])

  async function runBatch() {
    setError(null); setBusy(true)
    try {
      const ev = Math.max(1, Math.min(1000000, Number(n) || 1))
      await jobsSubmit({ n_events: ev })
      notify(`배치 실행 등록됨 — ${ev.toLocaleString()} 이벤트`)
      const d = await jobsList(); setJobs(d.jobs || [])
    } catch (e) {
      const msg = e.status === 403 ? '배치 실행 권한이 없습니다 — 관리자에게 요청하세요.'
        : e.status === 401 ? '포탈 로그인이 필요합니다.' : String(e.message || e)
      setError(msg)
      if (e.status === 403) setAllowed(false)
    } finally { setBusy(false) }
  }
  async function cancel(id) {
    try { await jobCancel(id); const d = await jobsList(); setJobs(d.jobs || []) }
    catch (e) { setError(String(e.message || e)) }
  }

  if (allowed === false) {
    return (
      <div className="batchpanel">
        <div className="dnote lock">🔒 배치 실행이 제한되어 있습니다. 현재 계정은 <b>viewer 실행</b>(start · run 1 · run 10)만
          사용할 수 있습니다. 배치 실행이 필요하면 관리자에게 요청하세요.</div>
        {error && <div className="serr">⚠ {error}</div>}
      </div>
    )
  }

  return (
    <div className="batchpanel">
      <div className="dnote">처음부터 지정한 이벤트 수만큼 <b>npsimulation -B</b> 로 배치 실행합니다.
        결과 ROOT 파일이 곧바로 outputs/ 에 저장됩니다 (viewer 실행과 별개).</div>
      <div className="brun">
        <label>이벤트 수</label>
        <input type="number" min="1" max="1000000" value={n}
          onChange={(e) => setN(e.target.value)} disabled={busy || allowed === null}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) { e.preventDefault(); runBatch() } }} />
        <button className="sbtn go" onClick={runBatch} disabled={busy || allowed === null}>
          {busy ? '등록 중…' : '배치 실행'}</button>
      </div>
      {error && <div className="serr">⚠ {error}</div>}

      <button className="bhisthead" onClick={() => setHistOpen((v) => !v)}
        title={histOpen ? '실행 기록 접기' : '실행 기록 펼치기'}>
        <span className="bcaret">{histOpen ? '▾' : '▸'}</span>
        <span>실행 기록</span>
        <span className="bhcount">{jobs.length}</span>
      </button>
      {histOpen && (
        <div className="bjobs">
          {jobs.length === 0 && <div className="dnote">아직 배치 작업이 없습니다.</div>}
          {jobs.map((j) => (
            <div key={j.id} className={`bjob ${j.status} ${j.id === shown ? 'sel' : ''}`}
              onClick={() => setLogId(j.id)} title="로그 보기">
              <span className={`bbadge ${j.status}`}>{ST_LABEL[j.status] || j.status}</span>
              <span className="bev">{(j.params?.n_events ?? 0).toLocaleString()} ev</span>
              {j.status === 'queued' && j.queue_position > 0 && <span className="bpos">#{j.queue_position} 대기</span>}
              {j.size_bytes > 0 && <span className="bsize">{human(j.size_bytes)}</span>}
              {j.error && j.status !== 'cancelled' && <span className="berr" title={j.error}>{j.error}</span>}
              {ACTIVE.has(j.status) && (
                <button className="sbtn stop bcancel" title="작업 취소"
                  onClick={(e) => { e.stopPropagation(); cancel(j.id) }}>취소</button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Log stays visible even after the batch finishes (follows the running/most-recent
          job, or a job you click in 실행 기록). */}
      {shown && (<>
        <div className="bloghead">로그{running ? ' · 실행 중' : ''}</div>
        <pre className="slog batchlog" ref={logBoxRef}>{logTail || '로그 대기 중…'}</pre>
      </>)}
    </div>
  )
}
