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
  // jsroot dynamically import()s these Node-only deps under isNodeJs() (headless
  // SVG→PNG, server canvas); they never run in the browser but rollup still tries to
  // bundle them and the native .node binaries break the build. Stub them out.
  const jsrootNodeStub = resolve(__dirname, 'src/jsroot-node-stub.js')
  const nodeOnly = ['@resvg/resvg-js', 'canvas', 'jsdom', 'xhr2', 'tmp', 'mathjax']
  return {
    base: './',
    plugins: [react()],
    resolve: {
      // Resolve react/react-dom to ONE copy (this app's), so the source-aliased kit
      // can't pull in its own React and trigger "Invalid hook call".
      dedupe: ['react', 'react-dom'],
      alias: {
        'lilak-ui': resolve(UI, 'src'),
        ...Object.fromEntries(nodeOnly.map((m) => [m, jsrootNodeStub])),
      },
    },
    optimizeDeps: { include: ['@phosphor-icons/react', 'react-markdown', 'remark-gfm'] },
    server: { port: PORT, host: true, fs: { allow: [resolve(__dirname), UI] }, proxy: { '/api': BACKEND } },
  }
})
