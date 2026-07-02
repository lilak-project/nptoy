import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// Host/port from env (with defaults) so the same code runs anywhere. base:'./'
// + injected <base href> makes the build portal-proxy aware.
export default defineConfig(({ mode }) => {
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), '') }
  const PORT = Number(env.PORT) || 5160
  const BACKEND = env.NPTOY_BACKEND || 'http://localhost:8160'
  const UI = env.LILAK_UI_PATH ? resolve(env.LILAK_UI_PATH) : resolve(__dirname, '../../lilak_ui')
  return {
    base: './',
    plugins: [react()],
    resolve: { alias: { 'lilak-ui': resolve(UI, 'src') } },
    optimizeDeps: { include: ['@phosphor-icons/react', 'react-markdown', 'remark-gfm'] },
    server: { port: PORT, host: true, fs: { allow: [resolve(__dirname), UI] }, proxy: { '/api': BACKEND } },
  }
})
