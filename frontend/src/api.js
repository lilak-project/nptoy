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
// The portal cover UI lives one level up from this service's base.
export function portalHome() { return PORTAL_BASE ? PORTAL_BASE.replace(/\/p\/[^/]+$/, '/') || '/' : '/' }
