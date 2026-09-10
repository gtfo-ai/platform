/**
 * Vite build for the SPA (TD-013).
 *
 * Two things here are load-bearing rather than boilerplate.
 *
 * **Same origin.** technical/08 puts the API, the SSE stream and the bundle on one origin, which is
 * what makes the `__Host-` session cookie reach `/api` and `/events` without CORS. In production
 * `apps/server` serves `dist/` with an SPA fallback (WP-22 packages it); in development the proxy
 * below reproduces that origin so nothing in the client needs a base URL. `APP_DEV_API_URL` is a
 * developer convenience only — it is read at config time, never bundled.
 *
 * **`manualChunks` is deliberately absent.** The bundle budget (`scripts/bundle-budget.mjs`)
 * measures the *initial* graph — the entry chunk plus everything `index.html` preloads — so a hand
 * written chunk split that moves bytes out of the entry chunk and into a preloaded one would lower
 * no number that matters. What lowers it is a route that is genuinely lazy, and those are declared
 * with `lazyRouteComponent` in `src/routes/`.
 */
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.APP_DEV_API_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The budget is measured over gzipped bytes; a source map is not part of the initial graph and
    // is not shipped, so it neither helps nor hurts the number and is left off.
    sourcemap: false,
  },
  server: {
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
      // SSE through a proxy needs the response streamed rather than buffered; Vite's proxy does
      // that already, but the explicit entry documents that `/events` is not part of `/api`.
      '/events': { target: apiTarget, changeOrigin: false },
    },
  },
});
