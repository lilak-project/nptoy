// Base-path aware API access. Relative URLs (no leading slash) resolve against
// document.baseURI, which is `/` standalone and `/p/nptoy/` behind the portal.
// The portal token (when present) is read the same way the other LILAK services
// read it, so authed endpoints work once entered through the portal.

function token() {
  return (
    window.__PORTAL_TOKEN__ ||
    localStorage.getItem('elog_token') ||
    localStorage.getItem('lilak_portal_token') ||
    null
  )
}

async function req(path, method = 'GET', body = null) {
  const headers = {}
  const t = token()
  if (t) headers['Authorization'] = `Bearer ${t}`
  if (body) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : null })
  if (!res.ok) {
    let detail = `${res.status}`
    try {
      const d = (await res.json()).detail
      if (typeof d === 'string') detail = d
      else if (Array.isArray(d)) detail = d.map((x) => x.msg || JSON.stringify(x)).join('; ')  // FastAPI 422
      else if (d) detail = JSON.stringify(d)
    } catch {}
    const e = new Error(detail); e.status = res.status; throw e
  }
  return res.json()
}

// ── identity ──────────────────────────────────────────────────────────────────
export const fetchMe = () => req('api/me')

// ── viewer scenes ─────────────────────────────────────────────────────────────
// tracks_from/tracks_count page through the tracks (keeps each response small).
const _pg = (from, count) => (count ? `tracks_from=${from}&tracks_count=${count}` : '')
export const fetchJobScene = (id, from = 0, count = 0) =>
  req(`api/jobs/${id}/viewer${_pg(from, count) ? '?' + _pg(from, count) : ''}`)

// ── input workspace (3 editable slots: physics / detector / reaction) ─────────
export const inputsState = () => req('api/inputs')
export const inputsGetFile = (slot) => req(`api/inputs/file?slot=${encodeURIComponent(slot)}`)
export const inputsSaveFile = (slot, content) => req('api/inputs/file', 'PUT', { slot, content })
export const inputsLoadExample = (example) => req('api/inputs/load-example', 'POST', { example })
export const inputsSources = () => req('api/inputs/sources')
export const csCandidates = () => req('api/inputs/crosssections')
export const csGet = (name) => req('api/inputs/crosssection' + (name ? `?name=${encodeURIComponent(name)}` : ''))
export const csSave = (content, name) =>
  req('api/inputs/crosssection', 'PUT', name ? { content, name } : { content })

// ── user outputs + admin (manager) ────────────────────────────────────────────
export const outputsList = () => req('api/outputs')
export const outputsDelete = (run) => req('api/outputs?run=' + encodeURIComponent(run), 'DELETE')
export const outputsScene = (run, from = 0, count = 0) =>
  req('api/outputs/scene?run=' + encodeURIComponent(run) + (count ? `&tracks_from=${from}&tracks_count=${count}` : ''))
export const outputsClean = () => req('api/outputs/clean', 'POST')

// authed binary download → triggers a browser save
export async function downloadOutput(name) {
  const t = token()
  const res = await fetch('api/outputs/file?name=' + encodeURIComponent(name),
    { headers: t ? { Authorization: `Bearer ${t}` } : {} })
  if (!res.ok) throw new Error('download ' + res.status)
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url; a.download = name.split('/').pop()
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
// ── file browser (read-only, sandboxed to the user's data folder) ─────────────
export const filesList = (path = '') => req('api/files' + (path ? `?path=${encodeURIComponent(path)}` : ''))
export const filesRead = (path) => req('api/files/read?path=' + encodeURIComponent(path))
export const filesDelete = (paths) => req('api/files/delete', 'POST', { paths })
// Ensure the user's confined RBrowser is running (scoped to their folder) and get
// its launch URL. Reused across .root files — one RBrowser per user.
export const rbrowserOpen = (path = '') => req('api/rbrowser/open', 'POST', { path })
export async function downloadFile(path) {
  const t = token()
  const res = await fetch('api/files/download?path=' + encodeURIComponent(path),
    { headers: t ? { Authorization: `Bearer ${t}` } : {} })
  if (!res.ok) throw new Error('download ' + res.status)
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url; a.download = path.split('/').pop()
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
export async function downloadFilesZip(paths) {
  const t = token()
  const res = await fetch('api/files/zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    body: JSON.stringify({ paths }),
  })
  if (!res.ok) throw new Error('download ' + res.status)
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url; a.download = 'nptoy-files.zip'
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export const adminSettings = () => req('api/admin/settings')
export const adminSettingsUpdate = (patch) => req('api/admin/settings', 'PUT', patch)
export const adminClean = (userKey) => req('api/admin/clean', 'POST', userKey ? { user_key: userKey } : {})
export const adminUserLimit = (userKey, patch) => req('api/admin/user-limit', 'PUT', { user_key: userKey, ...patch })

// ── named / shareable configs ─────────────────────────────────────────────────
export const configsList = () => req('api/configs')
export const configsSave = (name, shared) => req('api/configs', 'POST', { name, shared })
export const configsLoad = (id) => req(`api/configs/${id}/load`, 'POST')
export const configsShare = (id, shared) => req(`api/configs/${id}/share`, 'POST', { shared })
export const configsDelete = (id) => req(`api/configs/${id}`, 'DELETE')

// ── viewer style presets (per-user, shareable) ────────────────────────────────
export const stylesList = () => req('api/styles')
export const stylesSave = (name, data, shared) => req('api/styles', 'POST', { name, data, shared })
export const stylesLoad = (id) => req(`api/styles/${id}`)
export const stylesShare = (id, shared) => req(`api/styles/${id}/share`, 'POST', { shared })
export const stylesDelete = (id) => req(`api/styles/${id}`, 'DELETE')

// ── interactive nptool session ────────────────────────────────────────────────
export const sessionStatus = () => req('api/session')
export const sessionStart = () => req('api/session/start', 'POST')
export const sessionRun = (n) => req('api/session/run', 'POST', { n })
export const sessionLog = (since) => req(`api/session/log?since=${since}`)
export const sessionScene = (from = 0, count = 0) =>
  req('api/session/scene' + (count ? `?tracks_from=${from}&tracks_count=${count}` : ''))
export const sessionStop = () => req('api/session/stop', 'POST')
