import React from 'react'
import ReactDOM from 'react-dom/client'
import { applyTheme, setTheme, loadFonts } from 'lilak-ui'
import App from './App.jsx'
import { applyMainColor } from './theme/main.js'
import './index.css'
import './g4/styles.css'   // ported g4toy component styles (bridged to lilak tokens)

// Self-heal after a redeploy: a page opened against an old build lazily imports a
// chunk whose hash changed, so the fetch 404s ("Failed to fetch dynamically imported
// module"). Reload ONCE (guarded via sessionStorage so a genuinely-missing chunk
// can't loop) to pull the fresh index.html + current hashes.
;(() => {
  const RELOAD_KEY = 'nptoy-chunk-reload-ts'
  const stale = (msg) => /dynamically imported module|importing a module script failed|ChunkLoadError/i.test(String(msg || ''))
  const recover = () => {
    // Reload at most once per 30s window: heals the redeploy case (fresh index.html
    // fixes the hashes) without looping if a chunk is genuinely, persistently gone.
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0)
    if (Date.now() - last < 30000) return
    try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())) } catch { /* ignore */ }
    location.reload()
  }
  window.addEventListener('vite:preloadError', (e) => { e.preventDefault(); recover() })
  window.addEventListener('error', (e) => { if (stale(e?.message)) recover() })
  window.addEventListener('unhandledrejection', (e) => { if (stale(e?.reason?.message || e?.reason)) recover() })
})()

applyTheme()          // inject the kit's CSS custom properties
setTheme('bright')    // pin to bright (the main colour is fixed)
loadFonts()           // Pretendard / IBM Plex Sans / D2Coding + set --font-sans
applyMainColor()      // override accent + nav tokens to the service colour
// The kit's default mono ('D2 coding', broken .eot) never renders — pin the
// monospace stack to our working D2Coding webface (see @font-face in g4/styles.css).
document.documentElement.style.setProperty(
  '--font-mono', "'D2Coding', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace")

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
