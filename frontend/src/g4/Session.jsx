import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { sessionStatus, sessionStart, sessionRun, sessionLog, sessionStop, sessionTrackingVerbose } from './api.js'

// The app's official notice channel: a transient toast under the account button
// (Shell listens for `nptoy-notify` and also logs it into the drawer).
const notify = (text, level = 'info') =>
  window.dispatchEvent(new CustomEvent('nptoy-notify', { detail: { text, level } }))

// Live interactive nptool session: Start a `npsimulation -N` on the current input
// workspace, then push `/run/beamOn <n>` one at a time and watch the terminal stream.
// forwardRef exposes start/stop/run so the Simulation tab's keyboard shortcuts
// (space/enter) work even when this panel isn't the visible one.
export default forwardRef(function Session({ onState } = {}, ref) {
  const [sess, setSess] = useState(null)        // {state, runs, example, ...} or null
  const [n, setN] = useState(1)
  const [lines, setLines] = useState([])
  const [error, setError] = useState(null)
  const [verbose, setVerbose] = useState(false)  // /tracking/verbose 1 ↔ 0
  const sinceRef = useRef(0)
  const logRef = useRef(null)

  useEffect(() => { refresh() }, [])

  // Poll status + new log lines while a session exists.
  useEffect(() => {
    if (!sess) return
    const t = setInterval(async () => {
      try {
        const lg = await sessionLog(sinceRef.current)
        if (lg.lines.length) {
          setLines((p) => [...p, ...lg.lines].slice(-1000))
          sinceRef.current = lg.next
        }
        setSess((s) => (s ? { ...s, state: lg.state } : s))
      } catch (e) {
        if (e.status === 409) { setSess(null) }      // session gone
      }
    }, 800)
    return () => clearInterval(t)
  }, [sess?.id])

  // scroll the log box itself (NOT scrollIntoView, which would scroll the whole
  // dock and push the header/stop button off-screen)
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight }, [lines])

  async function refresh() {
    try {
      const d = await sessionStatus()
      setSess(d.session)
    } catch (e) { setError(authMsg(e)) }
  }

  async function doStart() {
    setError(null); setLines([]); sinceRef.current = 0; setVerbose(false)
    try { setSess(await sessionStart()) } catch (e) { setError(authMsg(e)) }
  }
  async function doStop(force = false) {
    setError(null)
    let res = null
    try { res = await sessionStop(force) } catch (e) {}
    setSess(null); setLines([]); sinceRef.current = 0; setVerbose(false)
    // Report the files the session left in outputs/ via the top-right toast.
    const files = res && res.files
    if (force) notify('세션을 강제 종료했습니다' + (files && files.length ? ' — 저장: ' + files.join('  /  ') : ''))
    else if (files && files.length) notify('저장됨: ' + files.join('  /  '))
  }
  async function doRun(count) {
    setError(null)
    try { setSess(await sessionRun(Number(count ?? n))) } catch (e) { setError(authMsg(e)) }
  }
  async function toggleVerbose() {
    const next = !verbose
    setVerbose(next)   // optimistic — revert if the call fails
    try { await sessionTrackingVerbose(next) } catch (e) { setVerbose(!next); setError(authMsg(e)) }
  }

  const state = sess?.state
  const idle = state === 'idle'
  const alive = sess && state !== 'stopped'

  useImperativeHandle(ref, () => ({
    start: () => { if (!alive) doStart() },
    stop: () => { if (alive) doStop() },
    toggle: () => (alive ? doStop() : doStart()),
    run: (count) => { if (idle) doRun(count) },   // count optional → defaults to the input n
    isAlive: () => !!alive,
    isIdle: () => !!idle,
  }))

  // Report state upward so the dock buttons (start/stop/run) reflect it reactively.
  useEffect(() => { onState && onState({ alive: !!alive, idle: !!idle, state, runs: sess?.runs || 0 }) },
    [alive, idle, state, sess?.runs])

  return (
    <div className="session">
      <div className="srow">
        {alive
          ? <button className="sbtn stop" onClick={() => doStop(false)}>stop</button>
          : <button className="sbtn go" onClick={doStart}>start</button>}
        <span className="wsinfo">runs the input workspace ▸</span>
        {/* far right, away from stop, so it isn't hit by accident */}
        {alive && <button className="sbtn kill" title="즉시 강제 종료 (SIGKILL) — 오래 도는 job 을 바로 중단"
          onClick={() => doStop(true)}>강제 종료</button>}
      </div>

      <div className="sstat">
        <Badge state={state} />
        {sess && <span>runs: {sess.runs}</span>}
        {state === 'starting' && <span className="hint">Geant4 초기화 중…</span>}
      </div>

      <div className="srun">
        <label>/run/beamOn</label>
        <input type="number" min="1" value={n}
          onChange={(e) => setN(e.target.value)} disabled={!idle}
          onKeyDown={(e) => { if (e.key === 'Enter' && idle) { e.preventDefault(); doRun() } }} />
        <button className="sbtn go" onClick={() => doRun()} disabled={!idle}>run</button>
      </div>

      <label className={`vbrow ${alive ? '' : 'off'}`} title="Geant4 /tracking/verbose — 스텝별 트래킹 로그를 켭니다 (다음 run부터 적용)">
        <input type="checkbox" checked={verbose} disabled={!alive} onChange={toggleVerbose} />
        <span>tracking verbose {verbose ? '1' : '0'}</span>
      </label>

      {error && <div className="serr">⚠ {error}</div>}

      <pre className="slog" ref={logRef}>
        {lines.length ? lines.join('\n') : (alive ? '' : '세션을 시작하세요.')}
      </pre>
    </div>
  )
})

function Badge({ state }) {
  const label = { starting: 'starting', idle: 'idle', running: 'running', stopped: 'stopped' }[state] || 'no session'
  return <span className={`badge ${state || 'none'}`}>{label}</span>
}

function authMsg(e) {
  return e.status === 401 ? '포탈 로그인이 필요합니다 (?job= 토큰).' : String(e.message || e)
}
