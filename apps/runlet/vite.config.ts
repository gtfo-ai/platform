/**
 * The `agentic-runlet` bundle (TD-025 §1, WP-22).
 *
 * TD-025 asks for "a small static shim … compiled to a single file or Go — implementer's choice,
 * must have no runtime deps", and the `platform-runtime` image is where that matters: a run
 * container carries the shim, never the platform (TD-021). This config is the whole of the
 * packaging step, and three settings are load-bearing rather than boilerplate.
 *
 * **`ssr` rather than `lib`.** A library build emits for a bundler to consume again; this is an
 * executable. `ssr` targets Node, leaves `node:*` external and emits one ESM file.
 *
 * **`ssr.noExternal: true`.** The default externalises every dependency, which would leave the
 * image needing a `node_modules` — exactly what TD-025 rules out. With it, zod and the frame codec
 * travel inside the file.
 *
 * **The banner.** The output is copied to `/usr/local/bin/agentic-runlet` and executed by name
 * (the git credential helper inside the workspace runs `!agentic-runlet credential`), so it needs
 * the shebang the source has and which rolldown drops.
 *
 * Vite is a devDependency of this package only, and the bundle is generated output: `dist/` is
 * git-ignored and is built in the image, not committed.
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: {
    ssr: 'src/index.ts',
    outDir: 'dist',
    emptyOutDir: true,
    target: 'node24',
    // Readable on purpose: this file runs inside a container an operator debugs by reading a stack
    // trace out of `docker logs`, and the bundle is ~1 % of the image either way.
    minify: false,
    sourcemap: false,
    rollupOptions: {
      treeshake: { moduleSideEffects: 'no-external' },
      output: {
        format: 'esm',
        entryFileNames: 'agentic-runlet.mjs',
      },
    },
  },
  ssr: { target: 'node', noExternal: true },
});
