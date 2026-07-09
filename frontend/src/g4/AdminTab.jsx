import React, { useEffect, useState } from 'react'
import { adminSettings, adminSettingsUpdate, adminClean, adminUserLimit, adminUserBatch } from './api.js'

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
  // Global batch default: allow everyone / restrict everyone. Individual overrides
  // (below) win over this. Applies immediately.
  async function saveBatchDefault(on) {
    try { await adminSettingsUpdate({ batch_default: on }); flash(on ? '배치 전체 허용' : '배치 전체 제한'); load() }
    catch (e) { flash(e.message || String(e)) }
  }
  // Per-user batch permission: true=허용, false=제한, null=기본(전역값 따름).
  async function setUserBatch(key, allowed) {
    try { await adminUserBatch(key, allowed); flash('배치 권한 저장됨 — ' + key.split('-')[0]); load() }
    catch (e) { flash(e.message || String(e)) }
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
        <div className="admgrid" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>배치 실행 기본 권한 (개별 설정이 우선)</span>
            <div className="bseg">
              <button className={data.settings.batch_default ? 'on' : ''}
                onClick={() => saveBatchDefault(true)}>전체 허용</button>
              <button className={!data.settings.batch_default ? 'on' : ''}
                onClick={() => saveBatchDefault(false)}>전체 제한</button>
            </div>
          </div>
          <span className="dnote" style={{ margin: 0 }}>제한 시 새 사용자는 viewer 실행만 가능합니다.</span>
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
            <span className="ucell">배치 권한</span>
            <span className="ucell acts"></span>
          </div>
          {(data.users || []).length === 0 && <div className="dnote">사용자가 없습니다.</div>}
          {(data.users || []).map((u) => {
            const r = rows[u.user_key] || { q: '', t: '' }
            const over = (u.used_bytes ?? u.bytes) >= u.quota_bytes
            return (
              <div className="urow" key={u.user_key}>
                <span className="ucell wide" title={`${u.username || ''}${u.email ? ' · ' + u.email : ''}\n${u.user_key}`}>{u.username || u.name || u.user_key.split('-')[0]}</span>
                <span className={`ucell ${over ? 'over' : ''}`}>{fmt(u.bytes)} / {fmt(u.quota_bytes)}</span>
                <input className="ucell" type="number" placeholder="기본" value={r.q}
                  onChange={(e) => setRow(u.user_key, 'q', e.target.value)} />
                <input className="ucell" type="number" placeholder="기본" value={r.t}
                  onChange={(e) => setRow(u.user_key, 't', e.target.value)} />
                <span className="ucell bseg" title={`현재: ${u.batch_allowed ? '허용' : '제한'}`}>
                  {(() => { const o = u.override?.batch_allowed
                    return (<>
                      <button className={o === true ? 'on' : ''} onClick={() => setUserBatch(u.user_key, true)}>허용</button>
                      <button className={o === false ? 'on' : ''} onClick={() => setUserBatch(u.user_key, false)}>제한</button>
                      <button className={o === undefined || o === null ? 'on' : ''}
                        onClick={() => setUserBatch(u.user_key, null)}>기본</button>
                    </>) })()}
                </span>
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
