// Single chokepoint for backend calls: portal base-path + SSO bearer token.
const PORTAL_BASE = (typeof window !== 'undefined' && window.__PORTAL_BASE__) || ''

export function token() {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem('lilak_portal_token') || localStorage.getItem('elog_token')
}
function authHeaders(extra) {
  const t = token()
  return { ...(extra || {}), ...(t ? { Authorization: `Bearer ${t}` } : {}) }
}
export function apiURL(path) {
  if (/^https?:\/\//.test(path)) return path
  if (PORTAL_BASE && path.startsWith(PORTAL_BASE + '/')) return path
  return PORTAL_BASE + path
}
export async function get(url) {
  const res = await fetch(apiURL(url), { headers: authHeaders() })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}
export async function post(url, body) {
  const res = await fetch(apiURL(url), { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body ?? {}) })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}
export async function del(url) {
  const res = await fetch(apiURL(url), { method: 'DELETE', headers: authHeaders() })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}
// multipart upload (FormData sets its own Content-Type boundary)
export async function postForm(url, formData) {
  const res = await fetch(apiURL(url), { method: 'POST', headers: authHeaders(), body: formData })
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}
// Fetch a protected file with the bearer token and hand back an object URL
// (<img>/<a> can't carry the Authorization header themselves).
export async function fetchBlobURL(url) {
  const res = await fetch(apiURL(url), { headers: authHeaders() })
  if (!res.ok) throw new Error(`${res.status}`)
  return URL.createObjectURL(await res.blob())
}
// The portal cover UI lives one level up from this service's base.
export function portalHome() { return PORTAL_BASE ? PORTAL_BASE.replace(/\/p\/[^/]+$/, '/') || '/' : '/' }

// Fallback only. The shell normally uses /api/whoami so profile edits made in the
// portal are reflected without requiring a fresh login/JWT.
export function portalProfile() {
  try {
    const t = token()
    if (!t) return { name: 'guest', email: '', color: '', shape: '' }
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return {
      name: p.name || p.username || p.email || 'guest',
      email: p.email || '', color: p.color || '', shape: p.shape || '',
      role: p.prole || p.role || 'user',
    }
  } catch { return { name: 'guest', email: '', color: '', shape: '' } }
}
