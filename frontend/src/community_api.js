// Community backend adapter → the kit <Community> talks to /api/community/* via this.
import { apiURL, token } from './api'
const P = '/api/community'
const H = () => (token() ? { Authorization: `Bearer ${token()}` } : {})
async function req(method, path, body) {
  const res = await fetch(apiURL(path), { method, headers: { ...H(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  if (res.status === 204) return null
  if (!res.ok) throw new Error(res.status + ' ' + await res.text())
  return res.json()
}
export const communityApi = {
  poll: () => req('GET', P + '/messages'),
  send: (p) => req('POST', P + '/messages', p),
  upload: async (fd) => (await fetch(apiURL(P + '/upload'), { method: 'POST', headers: H(), body: fd })).json(),
  blobURL: async (url) => { const r = await fetch(apiURL(url), { headers: H() }); return URL.createObjectURL(await r.blob()) },
  del: (id) => req('DELETE', P + '/messages/' + id),
  edit: (id, body) => req('PATCH', P + '/messages/' + id, { body }),
  setNotice: (id, on) => req('POST', P + '/messages/' + id + '/notice', { notice: on }),
  clearAll: () => req('POST', P + '/clear'),
  users: () => req('GET', P + '/users').then((d) => d.users),
  ban: (k, n, b) => req('POST', P + '/ban', { user_key: k, name: n, banned: b }),
  lockChat: (on) => req('POST', P + '/lock', { locked: on }),
  questions: () => req('GET', P + '/questions').then((d) => d.questions),
  completed: () => req('GET', P + '/completed').then((d) => d.questions),
  complete: (id) => req('POST', P + '/complete/' + id),
  anonIdentity: () => req('GET', P + '/anon-identity'),
  rerollAnon: () => req('POST', P + '/anon-reroll'),
  rerollAllAnon: () => req('POST', P + '/anon-reroll-all'),
  polls: () => req('GET', P + '/polls').then((d) => d.polls),
  createPoll: (p) => req('POST', P + '/polls', p),
  vote: (pid, oid, o) => req('POST', P + '/polls/' + pid + '/vote', { option_id: oid, ...(o || {}) }),
  closePoll: (pid) => req('POST', P + '/polls/' + pid + '/close'),
  pollResults: (pid) => req('GET', P + '/polls/' + pid + '/results'),
  anonNames: () => req('GET', P + '/anon-names'),
  saveAnonNames: (n) => req('PUT', P + '/anon-names', n),
  userReport: () => req('GET', P + '/user-report').then((d) => d.users || []),
  bots: () => req('GET', P + '/bots').then((d) => d.bots),
  saveBot: (b) => req('POST', P + '/bots', b),
  delBot: (name) => req('DELETE', P + '/bots/' + name),
  broadcastSettings: () => req('GET', P + '/broadcast-settings'),
  saveBroadcastSettings: (p) => req('PUT', P + '/broadcast-settings', p),
  notifications: () => req('GET', P + '/notifications').then((d) => d.notifications || []),
  deleteNotification: (id) => req('DELETE', P + '/notifications/' + id),
  clearNotifications: () => req('POST', P + '/notifications/clear'),
}
