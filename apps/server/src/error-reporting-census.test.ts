/**
 * **`@sentry/*` stays in `apps/server`** — TD-023's 2026-11-05 amendment, decision 4 (WP-295).
 *
 * Two halves, both read off disk:
 *
 * 1. **No source under `apps/web/src` imports `@sentry/*`** — git's census (tracked and untracked,
 *    `scripts/census-files.mjs`), comments stripped. The worker's local page needs no SDK, and its
 *    initial graph is held to 120 kB gzipped (`bundle:check`); the platform's SPA reports nothing.
 * 2. **No `package.json` but `apps/server`'s names an `@sentry/*` dependency** — so the launcher's
 *    image, which ships `packages/infrastructure`, carries none, and the reporter's SDK-free half
 *    (`packages/infrastructure/src/error-reporting/`) cannot start importing it unnoticed.
 *
 * It is syntactic and says what it cannot see: an import through a variable specifier
 * (`import(name)`), or a bundle that inlines a copy of the SDK under another name.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { censusFiles } from '../../../scripts/census-files.mjs';
import { withoutComments } from '../../../scripts/source-scanner.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** `from '@sentry/…'`, `import '@sentry/…'`, `import('@sentry/…')`, `require('@sentry/…')`. */
const SENTRY_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"`]@sentry\//;

export const importsSentry = (source: string): boolean =>
  SENTRY_IMPORT.test(withoutComments(source));

describe('@sentry/* reaches neither the web bundle nor any package but apps/server (WP-295)', () => {
  it('tells an import from a mention, in every spelling it claims', () => {
    for (const planted of [
      "import * as Sentry from '@sentry/node';",
      'import { init } from "@sentry/browser";',
      "import '@sentry/react';",
      "const s = await import('@sentry/node');",
      "const s = require('@sentry/node');",
      'export { init } from `@sentry/core`;',
    ]) {
      expect(importsSentry(planted), planted).toBe(true);
    }
    for (const innocent of [
      "// import * as Sentry from '@sentry/node';",
      "/** from '@sentry/node' */\nconst a = 1;",
      "const label = 'Sentry DSN';",
      "import { x } from '@sentryish/thing';",
    ]) {
      expect(importsSentry(innocent), innocent).toBe(false);
    }
  });

  it('finds no @sentry/* import under apps/web/src', () => {
    const files = censusFiles(REPO_ROOT, {
      pathspecs: ['apps/web/src'],
      include: (path: string) => /\.(?:[cm]?[jt]sx?)$/.test(path),
    });
    // Not vacuous: the walk read the page's own sources.
    expect(files.length).toBeGreaterThan(50);
    expect(files.map((file) => file.path)).toContain('apps/web/src/worker/worker-app.tsx');
    const offenders = files.filter((file) => importsSentry(file.contents)).map((file) => file.path);
    expect(offenders).toEqual([]);
    // A walk of the tree: WP-249's floor, 15 s (a census read timed out at 5.1 s on a loaded runner).
  }, 15_000);

  it('names @sentry/* as a dependency of apps/server only', () => {
    const manifests = censusFiles(REPO_ROOT, {
      include: (path: string) => /(?:^|\/)package\.json$/.test(path),
    });
    const declaring = manifests
      .filter((file) => {
        const manifest = JSON.parse(file.contents) as Record<string, Record<string, string>>;
        return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].some(
          (field) => Object.keys(manifest[field] ?? {}).some((name) => name.startsWith('@sentry/')),
        );
      })
      .map((file) => file.path);
    expect(manifests.map((file) => file.path)).toContain('apps/web/package.json');
    expect(declaring).toEqual(['apps/server/package.json']);
    // A walk of the tree: WP-249's floor, 15 s (a census read timed out at 5.1 s on a loaded runner).
  }, 15_000);
});
