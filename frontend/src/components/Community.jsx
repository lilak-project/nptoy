/**
 * Community — one global chat room for everyone connected to the service.
 *
 * Full-refresh poll (latest 120) so deletions/edits/moderation propagate. Supports
 * file attachments (+ drag-drop), replies, questions (button or /질문 · /q), a
 * question-list view, keyboard focus/command modes, and manager moderation
 * (delete message, clear all, ban/unban accounts).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, Avatar } from 'lilak-ui'
import { get, post, del, postForm, fetchBlobURL } from '../api'

const POLL_MS = 2500
const isImg = (t, name) => /^image\//.test(t || '') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name || '')
const fmtSize = (n) => (n > 1e6 ? (n / 1e6).toFixed(1) + 'MB' : n > 1e3 ? Math.round(n / 1e3) + 'KB' : n + 'B')
const timeLabel = (iso) => {
  try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
  catch { return '' }
}

// One attachment — images render inline (fetched as a blob so the bearer token
// travels), everything else is a download chip.
function Attachment({ att }) {
  const [src, setSrc] = useState('')
  const image = isImg(att.type, att.name)
  useEffect(() => {
    if (!image) return
    let url = ''
    fetchBlobURL(att.url).then((u) => { url = u; setSrc(u) }).catch(() => {})
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [att.url, image])

  async function download() {
    try {
      const url = await fetchBlobURL(att.url)
      const a = document.createElement('a')
      a.href = url; a.download = att.name || 'file'
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch {}
  }

  if (image) {
    return src
      ? <img className="cmimg" src={src} alt={att.name} onClick={download} title={att.name} />
      : <div className="cmfile cmimgload">🖼 {att.name}</div>
  }
  return (
    <button className="cmfile" onClick={download} title={`${att.name} · ${fmtSize(att.size || 0)}`}>
      <Icon name="download" size={15} /> <span className="cmfn">{att.name}</span>
      <em>{fmtSize(att.size || 0)}</em>
    </button>
  )
}

export default function Community() {
  const [messages, setMessages] = useState([])
  const [online, setOnline] = useState([])
  const [me, setMe] = useState('')
  const [role, setRole] = useState('user')
  const [banned, setBanned] = useState(false)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState([])   // uploaded-but-not-sent attachments
  const [reply, setReply] = useState(null)      // message being replied to
  const [uploading, setUploading] = useState(false)
  const [drag, setDrag] = useState(false)
  const [view, setView] = useState('chat')      // 'chat' | 'questions'
  const [questions, setQuestions] = useState([])
  const [showMod, setShowMod] = useState(false) // moderation panel
  const [users, setUsers] = useState([])
  const [confirmClear, setConfirmClear] = useState(false)

  const logRef = useRef(null)
  const inputRef = useRef(null)
  const stickRef = useRef(true)
  const sendingRef = useRef(false)
  const isManager = role === 'manager'

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const d = await get('/api/community/messages')
        if (!alive) return
        setMe(d.me || ''); setRole(d.my_role || 'user'); setBanned(!!d.banned)
        setOnline(d.online || []); setMessages(d.messages || []); setError('')
      } catch (e) { if (alive) setError(String(e.message || e)) }
    }
    tick()
    const t = setInterval(tick, POLL_MS)
    return () => { alive = false; clearInterval(t) }
  }, [])

  // keep pinned to the newest message unless the user scrolled up to read history
  useEffect(() => {
    const el = logRef.current
    if (el && stickRef.current && view === 'chat') el.scrollTop = el.scrollHeight
  }, [messages, view])

  // Keyboard: Enter (outside the input) jumps into the chat box; Esc leaves it so
  // the [ ] tab shortcuts work again ("command mode").
  useEffect(() => {
    const onKey = (e) => {
      const inInput = document.activeElement === inputRef.current
      if (e.key === 'Enter' && !inInput && view === 'chat' && !banned) {
        const tag = (document.activeElement?.tagName || '').toLowerCase()
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return
        e.preventDefault(); inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, banned])

  const onScroll = () => {
    const el = logRef.current
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  }

  async function uploadFiles(files) {
    const list = Array.from(files || []).slice(0, 6)
    if (!list.length) return
    setUploading(true)
    try {
      for (const f of list) {
        const fd = new FormData(); fd.append('file', f)
        const att = await postForm('/api/community/upload', fd)
        setPending((p) => [...p, att])
      }
    } catch (e) { setError(String(e.message || e)) }
    finally { setUploading(false) }
  }

  function onDrop(e) {
    e.preventDefault(); setDrag(false)
    if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files)
  }
  function onPaste(e) {
    const files = Array.from(e.clipboardData?.files || [])
    if (files.length) { e.preventDefault(); uploadFiles(files) }
  }

  async function doSend(kind) {
    const body = text.trim()
    if ((!body && !pending.length) || sendingRef.current) return
    sendingRef.current = true
    const payload = { body, kind: kind || 'msg', reply_to_id: reply?.id || 0, attachments: pending }
    setText(''); setPending([]); setReply(null)
    try {
      const m = await post('/api/community/messages', payload)
      stickRef.current = true
      setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]))
      if (m.kind === 'question' && view === 'questions') loadQuestions()
    } catch (e) { setError(String(e.message || e)); setText(body) }
    finally { sendingRef.current = false }
  }

  async function loadQuestions() {
    try { const d = await get('/api/community/questions'); setQuestions(d.questions || []) }
    catch (e) { setError(String(e.message || e)) }
  }
  function openQuestions() { setView('questions'); loadQuestions() }

  async function loadUsers() {
    try { const d = await get('/api/community/users'); setUsers(d.users || []) }
    catch (e) { setError(String(e.message || e)) }
  }
  function toggleMod() { const n = !showMod; setShowMod(n); if (n) loadUsers() }

  async function deleteMsg(id) {
    try { await del(`/api/community/messages/${id}`); setMessages((p) => p.filter((m) => m.id !== id)) }
    catch (e) { setError(String(e.message || e)) }
  }
  async function clearAll() {
    if (!confirmClear) { setConfirmClear(true); setTimeout(() => setConfirmClear(false), 3000); return }
    setConfirmClear(false)
    try { await post('/api/community/clear', {}); setMessages([]) }
    catch (e) { setError(String(e.message || e)) }
  }
  async function toggleBan(u) {
    try {
      await post('/api/community/ban', { user_key: u.user_key, name: u.name, banned: !u.banned })
      setUsers((p) => p.map((x) => (x.user_key === u.user_key ? { ...x, banned: !x.banned } : x)))
    } catch (e) { setError(String(e.message || e)) }
  }

  const list = view === 'questions' ? questions : messages

  return (
    <div className="community">

      <div className="cmhead">
        <span className="cmtitle">
          <Icon name="community" size={18} />
          {view === 'questions' ? '질문 목록' : '커뮤니티 채팅'}
        </span>
        <span className="cmheadr">
          {view === 'questions'
            ? <button className="cmback" onClick={() => setView('chat')}>← 채팅으로 돌아가기</button>
            : <span className="cmonline" title="접속 중">
                <span className="cmdot" />{online.length}명 접속 중
                <span className="cmwho">{online.map((u) => (
                  <span className="cmchip" key={u.key}>
                    <Avatar icon={u.shape} color={u.color} seed={u.key} size={17} />{u.name}
                  </span>
                ))}</span>
              </span>}
          {isManager && view === 'chat' && (
            <button className={`cmmodbtn ${showMod ? 'on' : ''}`} onClick={toggleMod} title="관리자 도구">
              <Icon name="shield" size={15} /> 관리
            </button>
          )}
        </span>
      </div>

      {isManager && showMod && view === 'chat' && (
        <div className="cmmod">
          <div className="cmmodrow">
            <strong>관리자 도구</strong>
            <button className={`cmclear ${confirmClear ? 'confirm' : ''}`} onClick={clearAll}>
              {confirmClear ? '정말 전체 삭제?' : '채팅 전체 삭제'}
            </button>
          </div>
          <div className="cmuserlist">
            {users.length === 0 && <span className="cmempty2">사용자가 없습니다.</span>}
            {users.map((u) => (
              <span className={`cmuser ${u.banned ? 'banned' : ''}`} key={u.user_key}>
                {u.name}
                <button onClick={() => toggleBan(u)}>{u.banned ? '이용제한 해제' : '이용제한'}</button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* the drop zone is JUST the message area (the chat window) — not the header
          or input row — and it fills the available height (~3× the input). */}
      <div className={`cmlog ${view === 'questions' ? 'qlist' : ''} ${drag ? 'dropping' : ''}`}
        ref={logRef} onScroll={onScroll}
        onDragOver={view === 'chat' && !banned ? (e) => { e.preventDefault(); setDrag(true) } : undefined}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDrag(false) }}
        onDrop={view === 'chat' && !banned ? onDrop : undefined}>
        {drag && <div className="cmdrop">📎 파일을 여기에 놓으세요</div>}
        {list.length === 0 && (
          <div className="cmempty">
            {view === 'questions' ? '아직 등록된 질문이 없습니다.' : '아직 메시지가 없습니다. 첫 메시지를 남겨보세요.'}
          </div>
        )}
        {list.map((m, i) => {
          const mine = m.author_key === me
          const grouped = view === 'chat' && i > 0 && list[i - 1].author_key === m.author_key
            && list[i - 1].kind !== 'question' && m.kind !== 'question'
          const isQ = m.kind === 'question'
          return (
            <div className={`cmrow ${mine ? 'mine' : ''} ${isQ ? 'q' : ''}`} key={m.id}>
              {!mine && (
                <Avatar className="cmava" icon={m.author_shape} color={m.author_color} seed={m.author_key}
                  size={30} title={m.author_name} style={{ visibility: grouped ? 'hidden' : 'visible' }} />
              )}
              <div className="cmbubblewrap">
                {!grouped && <span className="cmauthor">{mine ? '나' : m.author_name} <em>{timeLabel(m.created_at)}</em></span>}
                {/* bubblebox shrinks to the bubble so the hover actions anchor to the
                    bubble's own edge (not the wider author line) — no gap to cross. */}
                <div className="cmbubblebox">
                  <div className={`cmbubble ${isQ ? 'qbubble' : ''}`}>
                    {isQ && <span className="cmqtag">질문</span>}
                    {m.reply_to_id ? (
                      <div className="cmquote"><b>{m.reply_to_author}</b>{m.reply_to_body}</div>
                    ) : null}
                    {m.body && <div className="cmtext">{m.body}</div>}
                    {(m.attachments || []).length > 0 && (
                      <div className="cmatts">{m.attachments.map((a, k) => <Attachment att={a} key={k} />)}</div>
                    )}
                  </div>
                  <div className="cmactions">
                    {view === 'chat' && <button onClick={() => { setReply(m); inputRef.current?.focus() }}>답글</button>}
                    {isManager && <button className="del" onClick={() => deleteMsg(m.id)}>삭제</button>}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {error && <div className="cmerr">⚠ {error}</div>}
      {banned && <div className="cmban">커뮤니티 이용이 제한된 계정입니다.</div>}

      {!banned && (
        <>
          {reply && (
            <div className="cmreplybar">
              <span className="cmreplyto">↩ <b>{reply.author_name}</b>에게 답글: {(reply.body || '첨부').slice(0, 60)}</span>
              <button onClick={() => setReply(null)}>✕</button>
            </div>
          )}
          {pending.length > 0 && (
            <div className="cmpending">
              {pending.map((a, k) => (
                <span className="cmpend" key={k}>
                  {isImg(a.type, a.name) ? '🖼' : '📎'} {a.name}
                  <button onClick={() => setPending((p) => p.filter((_, j) => j !== k))}>✕</button>
                </span>
              ))}
            </div>
          )}
          <div className="cminput">
            <button className="cmattach" title="파일 첨부" disabled={uploading}
              onClick={() => document.getElementById('cmfileinput')?.click()}>
              <Icon name={uploading ? 'spinner' : 'attach'} size={17} />
            </button>
            <input id="cmfileinput" type="file" multiple hidden
              onChange={(e) => { uploadFiles(e.target.files); e.target.value = '' }} />
            <textarea ref={inputRef} rows={1} value={text}
              placeholder="메시지 입력… (Enter 전송, Shift+Enter 줄바꿈, /질문 으로 질문 등록)"
              onChange={(e) => setText(e.target.value)} onPaste={onPaste}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); inputRef.current?.blur(); return }
                // !isComposing / keyCode 229: a Korean IME fires an Enter keydown to
                // *confirm* composition — sending on it would double-post.
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
                  e.preventDefault(); doSend('msg')
                }
              }} />
            <button className="cmsend" onClick={() => doSend('msg')}
              disabled={!text.trim() && !pending.length} title="전송">
              <Icon name="send" size={17} weight="fill" />
            </button>
            <button className="cmqbtn" onClick={() => doSend('question')}
              disabled={!text.trim() && !pending.length} title="질문으로 등록">질문</button>
            {view === 'chat'
              ? <button className="cmqlist" onClick={openQuestions} title="질문 목록 보기">
                  <Icon name="menu" size={16} /> 목록
                </button>
              : <button className="cmqlist" onClick={() => setView('chat')} title="채팅으로 돌아가기">
                  ← 채팅
                </button>}
          </div>
        </>
      )}
    </div>
  )
}
