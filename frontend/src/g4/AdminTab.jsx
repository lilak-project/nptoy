import React, { useEffect, useState } from 'react'
import { adminSettings, adminSettingsUpdate, adminClean, adminUserLimit } from './api.js'

const MB = 1024 * 1024
const fmt = (b) => (b >= 1024 * MB ? (b / 1024 / MB).toFixed(2) + ' GB'
  : b >= MB ? (b / MB).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB')

// Manager-only tab: global default limits + per-user overrides + cleanup.
export default function AdminTab() {
  const [data, setData] = useState(null)      // {settings, users}
  const [g, setG] = useState(null)            // editable global form
  const [rows, setRows] = useState({})        // per-user edit buffers {key:{q,t}}
  const [msg, setMsg] = useState('')

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 2000) }
  const load = () => adminSettings().then((d) => {
    setData(d)
    setG({
      job_timeout_sec: d.settings.job_timeout_sec,
      quota_mb: Math.round(d.settings.user_quota_bytes / MB),
      max_sessions: d.settings.max_sessions,
    })
    const buf = {}
    for (const u of (d.users || [])) {
      buf[u.user_key] = {
        q: u.override.user_quota_bytes ? Math.round(u.override.user_quota_bytes / MB) : '',
        t: u.override.job_timeout_sec || '',
      }
    }
    setRows(buf)
  }).catch((e) => setMsg(String(e.message || e)))
  useEffect(() => { load() }, [])

  async function saveGlobal() {
    try {
      await adminSettingsUpdate({
        job_timeout_sec: +g.job_timeout_sec,
        user_quota_bytes: Math.round(+g.quota_mb * MB),
        max_sessions: +g.max_sessions,
      })
      flash('전역 설정 저장됨'); load()
    } catch (e) { flash(e.message || String(e)) }
  }
  async function saveUser(key) {
    const r = rows[key]
    try {
      await adminUserLimit(key, {
        user_quota_bytes: r.q === '' ? null : Math.round(+r.q * MB),
        job_timeout_sec: r.t === '' ? null : +r.t,
      })
      flash('저장됨 — ' + key.split('-')[0]); load()
    } catch (e) { flash(e.message || String(e)) }
  }
  async function cleanUser(key) {
    try { const x = await adminClean(key); flash(`${fmt(x.bytes_freed)} 정리됨`); load() }
    catch (e) { flash(e.message || String(e)) }
  }
  async function cleanAll() {
    try { const x = await adminClean(null); flash(`${x.users_cleaned}명 · ${fmt(x.bytes_freed)} 정리됨`); load() }
    catch (e) { flash(e.message || String(e)) }
  }
  const setRow = (key, k, v) => setRows((s) => ({ ...s, [key]: { ...s[key], [k]: v } }))

  if (!data || !g) return <div className="placeholder">{msg || '…'}</div>

  return (
    <div className="admintab">
      <div className="anhead">
        <span className="antitle">Admin</span>
        <span className="anmsg">{msg}</span>
        <button className="sbtn" onClick={load}>새로고침</button>
        <button className="sbtn stop" onClick={cleanAll}>모든 outputs 정리</button>
      </div>

      <div className="admsect">
        <div className="slabel">전역 기본값 (default)</div>
        <div className="admgrid">
          <label>job 타임아웃 (초)
            <input type="number" value={g.job_timeout_sec}
              onChange={(e) => setG({ ...g, job_timeout_sec: e.target.value })} /></label>
          <label>사용자 쿼터 (MB)
            <input type="number" value={g.quota_mb}
              onChange={(e) => setG({ ...g, quota_mb: e.target.value })} /></label>
          <label>동시 세션 최대
            <input type="number" value={g.max_sessions}
              onChange={(e) => setG({ ...g, max_sessions: e.target.value })} /></label>
          <button className="sbtn go" onClick={saveGlobal}>저장</button>
        </div>
      </div>

      <div className="admsect">
        <div className="slabel">사용자별 한도 (비우면 전역값 사용)</div>
        <div className="usertable">
          <div className="urow uhead">
            <span className="ucell wide">user</span>
            <span className="ucell">usage</span>
            <span className="ucell">쿼터 MB</span>
            <span className="ucell">타임아웃 s</span>
            <span className="ucell acts"></span>
          </div>
          {(data.users || []).length === 0 && <div className="dnote">사용자가 없습니다.</div>}
          {(data.users || []).map((u) => {
            const r = rows[u.user_key] || { q: '', t: '' }
            const over = (u.used_bytes ?? u.bytes) >= u.quota_bytes
            return (
              <div className="urow" key={u.user_key}>
                <span className="ucell wide" title={u.user_key}>{u.user_key.split('-')[0]}</span>
                <span className={`ucell ${over ? 'over' : ''}`}>{fmt(u.bytes)} / {fmt(u.quota_bytes)}</span>
                <input className="ucell" type="number" placeholder="기본" value={r.q}
                  onChange={(e) => setRow(u.user_key, 'q', e.target.value)} />
                <input className="ucell" type="number" placeholder="기본" value={r.t}
                  onChange={(e) => setRow(u.user_key, 't', e.target.value)} />
                <span className="ucell acts">
                  <button className="sbtn" onClick={() => saveUser(u.user_key)}>저장</button>
                  <button className="sbtn stop" title="이 사용자 outputs 정리"
                    onClick={() => cleanUser(u.user_key)}>정리</button>
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
