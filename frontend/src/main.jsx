import React from 'react'
import ReactDOM from 'react-dom/client'
import { applyTheme, setTheme, loadFonts } from 'lilak-ui'
import App from './App.jsx'
import { applyMainColor } from './theme/main.js'
import './index.css'

applyTheme()          // inject the kit's CSS custom properties
setTheme('bright')    // pin to bright (the main colour is fixed)
loadFonts()           // Pretendard / IBM Plex Sans / D2Coding + set --font-sans
applyMainColor()      // override accent + nav tokens to the service colour

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
