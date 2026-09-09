/**
 * Lets a plain Node script import this repository's TypeScript sources.
 *
 * Two things are needed. Node ≥ 22.18 strips types from `.ts` files on its own, but the repo
 * convention writes relative imports with a `.js` extension (see CLAUDE.md § Conventions), which
 * Node's resolver takes literally and cannot find. This registers a synchronous resolve hook
 * (`module.registerHooks`, Node ≥ 22.15) that retries `./x.js` as `./x.ts` when that file exists.
 *
 * Import it for its side effect *before* importing any workspace source:
 *
 *     import './ts-source-resolver.mjs';
 *     const { thing } = await import('../packages/contracts/src/index.ts');
 *
 * The hook is process-global, so it is deliberately narrow: it only fires for a relative `.js`
 * specifier, imported from a file inside this repository but outside any `node_modules`, when the
 * sibling `.ts` file is actually on disk. Third-party code resolves exactly as it would without
 * the hook.
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRootUrl = new URL('../', import.meta.url).href;

const isRepoSource = (parentURL) =>
  typeof parentURL === 'string' &&
  parentURL.startsWith(repoRootUrl) &&
  !parentURL.includes('/node_modules/');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && isRepoSource(context.parentURL)) {
      try {
        const candidate = nextResolve(`${specifier.slice(0, -3)}.ts`, context);
        if (candidate.url.startsWith('file:') && existsSync(fileURLToPath(candidate.url))) {
          return candidate;
        }
      } catch {
        // Fall through to the untouched specifier below.
      }
    }
    return nextResolve(specifier, context);
  },
});
