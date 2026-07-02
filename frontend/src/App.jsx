import { LangProvider, IdentityProvider } from 'lilak-ui'
import { DICTS } from './i18n'
import { token } from './api'
import Shell from './components/Shell'

// Portal SSO — decode the stored JWT client-side for the display name.
function portalName() {
  try {
    const t = token()
    if (!t) return 'guest'
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    return p.name || p.username || p.email || 'guest'
  } catch { return 'guest' }
}

export default function App() {
  return (
    <LangProvider dicts={DICTS} defaultLang="ko">
      <IdentityProvider defaultName={portalName()}>
        <Shell />
      </IdentityProvider>
    </LangProvider>
  )
}
