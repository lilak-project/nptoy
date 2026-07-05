import React from 'react'
import ReactDOM from 'react-dom/client'
import { applyTheme, setTheme, loadFonts } from 'lilak-ui'
import App from './App.jsx'
import { applyMainColor } from './theme/main.js'
import './index.css'
import './g4/styles.css'   // ported g4toy component styles (bridged to lilak tokens)

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
