import React, { useEffect, useState } from 'react'
import { outputsList, outputsDelete, downloadOutput } from './api.js'

const MB = 1024 * 1024
const fmt = (b) => (b >= MB ? (b / MB).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB')
const fmtTime = (t) => (t ? new Date(t * 1000).toLocaleString() : '')

// Outputs manager: the ROOT / GDML / log artifacts each run produces, with
// download, delete, and "view 3D" (opens the run's GDML geometry in the viewer).
export default function AnalysisTab() {
  const [runs, setRuns] = useState(null)
  const [msg, setMsg] = useState('')
  const [pendDel, setPendDel] = useState('')

  const refresh = () => outputsList().then((d) => setRuns(d.runs)).catch((e) => setMsg(String(e.message || e)))
  useEffect(() => { refresh() }, [])
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 1800) }

  async function doDel(run) {
    setPendDel('')
    try { await outputsDelete(run); flash('삭제됨'); refresh() }
    catch (e) { setMsg(String(e.message || e)) }
  }
  const dl = (name) => downloadOutput(name).catch((e) => flash(String(e.message || e)))
  const fileOf = (r, ext) => r.files.find((f) => f.ext === ext)
  const view = (run) => { location.href = 'index.html?run=' + encodeURIComponent(run) }

  if (runs === null) return <div className="placeholder">{msg || '…'}</div>
  if (!runs.length) {
    return <div className="placeholder">아직 결과가 없습니다 — Simulation 탭에서 실행하세요.{msg && ' · ' + msg}</div>
  }

  return (
    <div className="analysis">
      <div className="anhead">
        <span className="antitle">Outputs</span>
        <span className="ancount">{runs.length} run{runs.length > 1 ? 's' : ''}</span>
        <span className="anmsg">{msg}</span>
        <button className="sbtn" onClick={refresh}>새로고침</button>
      </div>
      <div className="runtable">
        {runs.map((r) => {
          const root = fileOf(r, 'root'), gdml = fileOf(r, 'gdml'), log = fileOf(r, 'log')
          const kind = r.run.startsWith('session_') ? 'session' : r.run.startsWith('job_') ? 'job' : 'run'
          return (
            <div className="runrow" key={r.run}>
              <div className="runmeta">
                <span className={`runkind ${kind}`}>{kind}</span>
                <span className="runid" title={r.run}>{r.run.replace(/^(session|job)_/, '').slice(0, 12)}</span>
                <span className="runtime">{fmtTime(r.mtime)}</span>
                <span className="runsize">{fmt(r.bytes)}</span>
              </div>
              <div className="runacts">
                {gdml && <button className="sbtn" onClick={() => view(r.run)} title="3D 지오메트리 보기">view 3D</button>}
                {root && <button className="sbtn" onClick={() => dl(root.name)}>.root</button>}
                {gdml && <button className="sbtn" onClick={() => dl(gdml.name)}>.gdml</button>}
                {log && <button className="sbtn" onClick={() => dl(log.name)}>.log</button>}
                <button className={`sbtn ${pendDel === r.run ? 'stop' : ''}`}
                  onClick={() => (pendDel === r.run ? doDel(r.run) : setPendDel(r.run))}>
                  {pendDel === r.run ? '삭제?' : '✕'}</button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
