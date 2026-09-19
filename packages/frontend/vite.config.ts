import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vite configuration.
 *
 * In development the dev server proxies `/api`, `/health`, and `/ws` to the
 * backend so the browser sees a single origin. That matters for more than
 * convenience: the backend's CORS allowlist and its WebSocket ticket check both
 * behave differently on a cross-origin request, and testing against a single
 * origin is what production looks like behind Caddy.
 */
export default defineConfig({
  plugins: [react()],
  // Monaco's worker entry files are imported with `?worker`; excluding the
  // package from dependency pre-bundling keeps those imports intact so Vite's
  // worker plugin can bundle each worker as a same-origin script (required by
  // the app's `script-src 'self'` CSP — no CDN, no cross-origin workers).
  optimizeDeps: { exclude: ['monaco-editor'] },
  worker: { format: 'es' },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/health': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    // Source maps let a production stack trace be mapped back to source. They
    // are not referenced from the bundle, so nothing extra is served to a
    // client. But emitting them roughly doubles the build's peak memory —
    // Rollup keeps every map in memory next to Monaco's already-large graph —
    // which OOM-kills the build on a small (<=2 GB) VPS. Default them off and
    // let a host with memory to spare opt back in with AETHER_BUILD_SOURCEMAP=true.
    sourcemap: process.env.AETHER_BUILD_SOURCEMAP === 'true',
    // A single vendor chunk would be re-downloaded on every app change; the
    // split below keeps the two heavy libraries cacheable on their own.
    rollupOptions: {
      output: {
        manualChunks: {
          xterm: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links'],
          react: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
