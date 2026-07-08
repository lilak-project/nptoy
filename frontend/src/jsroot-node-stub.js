// Empty stub for jsroot's Node-only optional deps (resvg / canvas / jsdom / xhr2 /
// tmp / mathjax). jsroot only reaches these under isNodeJs() — headless SVG→PNG and
// server-side canvas — never in the browser. But Vite/rollup still tries to bundle
// the dynamic import()s, and the native .node binaries (@resvg, canvas) break the
// build. Aliasing them to this no-op keeps the browser bundle clean; the guarded code
// paths never run client-side. See vite.config.js resolve.alias.
export default {}
