/**
 * **No route, export or DTO reads a run's sealed plan** (WP-275a criterion 2, TD-031's 2026-11-04
 * amendment §2).
 *
 * `run_plans.sealed_spec` holds a live run's whole spec — its prompts **unredacted** — sealed under
 * `APP_SECRET_KEY`. It is the `secrets` table's shape (technical/03: never joined into an API
 * response): the session reads it through `loadRunPackage` in the application ring, settle reads the
 * plan's readable columns, and nothing in the composition root that serves HTTP may touch the table
 * at all. This census reads every source git knows about under `apps/server/src` — tracked and
 * untracked (`scripts/census-files.mjs`, standing rule 85) — and refuses a mention of the table, the
 * column, or the repository's read.
 *
 * What it cannot see: a query assembled from fragments (`'run_' + 'plans'`), or a read through an
 * alias of `store.runPlans`. The composition root's one legitimate mention — the sealer it composes,
 * `runPlans: createEnvelopeRunPlanSealer(…)` — is a key, not a read, and matches none of the patterns.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { censusPaths, censusText } from '../../../scripts/census-files.mjs';
import { withoutComments } from '../../../scripts/source-scanner.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

/** The table, the column in either spelling, and the repository's read. */
const SEALED_PLAN_READ = /\brun_plans\b|\bsealed_spec\b|\bsealedSpec\b|\brunPlans\s*\.\s*load\s*\(/;

const isThisFile = (file: string): boolean => file.endsWith('run-plans-census.test.ts');

export const sealedPlanReaders = (
  sources: readonly { readonly file: string; readonly text: string }[],
): readonly string[] =>
  sources
    .filter(({ file, text }) => !isThisFile(file) && SEALED_PLAN_READ.test(withoutComments(text)))
    .map(({ file }) => file);

describe('the sealed run plan census (WP-275a)', () => {
  it('finds no reader of run_plans or its sealed spec anywhere under apps/server/src', () => {
    const sources = censusPaths(REPO_ROOT, { pathspecs: ['apps/server/src/*'] })
      .filter((file) => /\.[cm]?tsx?$/.test(file))
      .map((file) => ({ file, text: censusText(REPO_ROOT, file) }));
    expect(sources.length).toBeGreaterThan(100);
    expect(sealedPlanReaders(sources)).toEqual([]);
  }, 15_000);

  it('names a route that selects the column, a DTO that names the field, and a repository read', () => {
    // The census's own negatives (standing rule 6): each spelling it claims to catch, caught.
    expect(
      sealedPlanReaders([
        {
          file: 'apps/server/src/routes/x.ts',
          text: "await pool.query('select sealed_spec from x')",
        },
        { file: 'apps/server/src/queries/y.ts', text: 'const dto = { sealedSpec: row.s };' },
        { file: 'apps/server/src/z.ts', text: 'await store.runPlans.load(tx, runId);' },
        { file: 'apps/server/src/w.ts', text: 'await sql`select * from run_plans`;' },
        { file: 'apps/server/src/ok.ts', text: 'runPlans: createEnvelopeRunPlanSealer(key),' },
      ]),
    ).toEqual([
      'apps/server/src/routes/x.ts',
      'apps/server/src/queries/y.ts',
      'apps/server/src/z.ts',
      'apps/server/src/w.ts',
    ]);
  });
});
