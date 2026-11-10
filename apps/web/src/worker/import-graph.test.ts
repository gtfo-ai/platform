/**
 * **The worker page's static import graph carries only the words it shows** (BACKLOG 1455, closed
 * by S-26.7).
 *
 * `ui/humanize.ts` is one module, and a bundler places a module's statements in **one** chunk: the
 * worker's local page imported five names from it and carried every word the SPA prints, because
 * the module lived in the chunk both entries share. The words the page shows now live in
 * `ui/words/*` (re-exported from `humanize.ts`, unchanged, for the SPA), and the page imports those
 * modules directly. This census walks the entry's graph off disk and holds it there:
 *
 * - **`ui/humanize.ts` is never reached** — through a worker module or through a shared `ui/*`
 *   module the page renders (`ui/phase-track.tsx` was one);
 * - **nothing under `viz/`** is reached (the lazy visualisations; `bundle:check` also refuses their
 *   marker in the built page);
 * - every `ui/words/*` module the page reaches is one this test names, so a new one is a decision.
 *
 * The walker is calibrated by walking the SPA's entry, which must reach `humanize.ts`.
 *
 * ## What it reads, and what it cannot see
 *
 * Relative `import`/`export … from` specifiers of `.ts`/`.tsx` sources (the repository's `.js`
 * spelling mapped onto the file on disk), comments stripped by `scripts/source-scanner.mjs`. An
 * `import type` or `export type` is skipped: it is erased and puts nothing in a bundle. A dynamic
 * `import()` is **not followed** — it is a lazy chunk, outside the initial graph — and a package
 * specifier is not followed either (none of the page's packages reach `apps/web/src`). It is
 * syntactic: a specifier built at run time is invisible to it, and the bundler would refuse one.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withoutComments } from '../../../../scripts/source-scanner.mjs';

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The `ui/words/*` modules the worker page shows, each for the screen part that needs it. */
const WORKER_WORDS = [
  'ui/words/claim-policy.ts', // What this machine takes, and picks (S-26.7)
  'ui/words/roles.ts', // a run's agent
  'ui/words/stages.ts', // a run's stage
  'ui/words/terminal-reasons.ts', // the guard's vocabulary of how a run ended
  'ui/words/worker-blockers.ts', // why this worker takes no work (S-22.19)
  'ui/words/worker-idle.ts', // why a ready worker runs nothing (more) (S-28.6)
];

const STATIC_IMPORT =
  /\b(?:import|export)\s+(type\s+)?(?:[\w*$\s{},]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g;

/** The file a relative specifier names: `./x.js` is `./x.ts` or `./x.tsx` on disk. */
const resolveSpecifier = (from: string, specifier: string): string | null => {
  const base = resolve(dirname(from), specifier);
  const stem = base.replace(/\.js$/, '');
  for (const candidate of [`${stem}.ts`, `${stem}.tsx`]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

/** Every source reached from `entry` by static, non-type imports, relative to `apps/web/src`. */
const staticGraph = (entry: string): Set<string> => {
  const seen = new Set<string>();
  const pending = [resolve(SOURCE_ROOT, entry)];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    const name = relative(SOURCE_ROOT, file);
    if (seen.has(name)) continue;
    seen.add(name);
    const code = withoutComments(readFileSync(file, 'utf8'));
    for (const match of code.matchAll(STATIC_IMPORT)) {
      if (match[1] !== undefined) continue;
      const specifier = match[2] as string;
      if (specifier.endsWith('.css')) continue;
      const target = resolveSpecifier(file, specifier);
      if (target === null) {
        throw new Error(`${name} imports ${specifier}, which names no source on disk`);
      }
      pending.push(target);
    }
  }
  return seen;
};

describe('the worker page’s import graph (BACKLOG 1455)', () => {
  const graph = staticGraph('worker/main.tsx');

  it('never reaches ui/humanize.ts, and nothing of viz/*', () => {
    expect(graph.has('ui/humanize.ts')).toBe(false);
    expect([...graph].filter((name) => name.startsWith('viz/'))).toEqual([]);
  });

  it('reaches exactly the ui/words modules it names', () => {
    expect([...graph].filter((name) => name.startsWith('ui/words/')).sort()).toEqual(
      [...WORKER_WORDS].sort(),
    );
  });

  it('is calibrated: the SPA’s entry does reach ui/humanize.ts and every words module', () => {
    const spa = staticGraph('main.tsx');
    expect(spa.has('ui/humanize.ts')).toBe(true);
    for (const words of WORKER_WORDS) expect(spa.has(words)).toBe(true);
    // The walker follows a shared ui module (the route the stage words used to take).
    expect(graph.has('ui/phase-track.tsx')).toBe(true);
  });
});
