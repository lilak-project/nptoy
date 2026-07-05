import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { sessionStatus, sessionStart, sessionRun, sessionLog, sessionStop } from './api.js'

// Live interactive nptool session: Start a `npsimulation -N` on the current input
// workspace, then push `/run/beamOn <n>` one at a time and watch the terminal stream.
// forwardRef exposes start/stop/run so the Simulation tab's keyboard shortcuts
// (space/enter) work even when this panel isn't the visible one.
export default forwardRef(function Session({ onState } = {}, ref) {
  const [sess, setSess] = useState(null)        // {state, runs, example, ...} or null
  const [n, setN] = useState(1)
  const [lines, setLines] = useState([])
  const [error, setError] = useState(null)
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
    setError(null); setLines([]); sinceRef.current = 0
    try { setSess(await sessionStart()) } catch (e) { setError(authMsg(e)) }
  }
  async function doStop() {
    setError(null)
    try { await sessionStop() } catch (e) {}
    setSess(null); setLines([]); sinceRef.current = 0
  }
  async function doRun(count) {
    setError(null)
    try { setSess(await sessionRun(Number(count ?? n))) } catch (e) { setError(authMsg(e)) }
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
          ? <button className="sbtn stop" onClick={doStop}>stop</button>
          : <button className="sbtn go" onClick={doStart}>start</button>}
        <span className="wsinfo">runs the input workspace ▸</span>
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
