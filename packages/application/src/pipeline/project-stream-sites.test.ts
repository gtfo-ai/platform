/**
 * Every production `nextStreamSequence` call in the application ring, counted off disk and
 * classified — WP-109, PROGRESS backlog **357** criterion (3).
 *
 * Backlog 333 named four knowledge writers that read a stream's next sequence over the pool and
 * appended at it without retrying a lost race; 357 found three more by hand, one of which 333 had
 * called "a different shape". A census in prose is a census somebody has to re-take (standing rule
 * 63), so it lives here: since WP-109 every project-stream writer outside the dispatcher reads its
 * sequence **through** `appendOnProjectWithRetry` (`project-stream.ts`), and a new direct call fails
 * this test until somebody decides which of the shapes below it is.
 *
 * ## The shapes, and the sites of each
 *
 * - **retries in place** — `project-stream.ts` (the shared helper: ten writers since WP-109, the
 *   knowledge passes, the onboarding recorders, the history recorder and the delivery measures) and
 *   `integrations/inbound.ts` (WP-15c's own loop, bounded by `DEFAULT_INBOUND_SEQUENCE_ATTEMPTS`,
 *   which predates the helper and retries a whole ingress transaction, not one append).
 * - **run stream, serialised by the row** — `pipeline/commands.ts` (a cancel from another process)
 *   and `recovery/run-lease.ts` (the lease sweep). Both read the **run** stream's sequence inside a
 *   transaction whose first write is a compare-and-set on the `runs` row (`runs.finish` answering
 *   `won`), so the only other writer of that run's stream — the process that ran it — is refused at
 *   the same row before it appends. Not a project-stream race, and out of WP-109's scope.
 * - **pass-retried, filed** — `pipeline/intake-reconcile.ts`. It appends `ticket.matched` on the
 *   **project** stream with the sequence read outside its transaction and no retry: a lost race
 *   throws out of the pass, the rest of that tick's matches wait for the next tick, and nothing is
 *   lost because the append rolled back and the match is found again. The same shape as 333's, on a
 *   pipeline writer rather than a knowledge or onboarding one, so it is **filed** (PROGRESS,
 *   WP-109's discovered work) rather than changed here.
 *
 * ## Scope
 *
 * The application ring's production sources, read through git's view (tracked and committable
 * untracked, standing rule 85). The infrastructure's one caller — the integration audit log
 * (`postgres-audit-log.ts`, on the `integration` stream) — retries in place with its own loop and is
 * outside this ring. Like `task-save-sites.test.ts`, it is syntactic: a call through an alias is
 * invisible to it, and it says so rather than claiming closure.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { censusPaths, censusText } from '../../../../scripts/census-files.mjs';
import { withoutComments } from '../../../../scripts/source-scanner.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

const EXPECTED_SITES: ReadonlyMap<string, number> = new Map([
  // retries in place
  ['packages/application/src/pipeline/project-stream.ts', 1],
  ['packages/application/src/integrations/inbound.ts', 1],
  // run stream, serialised by the `runs` row's compare-and-set
  ['packages/application/src/pipeline/commands.ts', 1],
  ['packages/application/src/recovery/run-lease.ts', 1],
  // project stream, pass-retried — filed by WP-109, not changed
  ['packages/application/src/pipeline/intake-reconcile.ts', 1],
]);

const SEQUENCE_READ = /\.\s*nextStreamSequence\s*\(/g;

const isTestTier = (file: string): boolean =>
  /\.(?:test|spec)\.[cm]?tsx?$/.test(file) || file.includes('/src/testing/');

const census = (): Map<string, number> => {
  const found = new Map<string, number>();
  for (const file of censusPaths(REPO_ROOT, { pathspecs: ['packages/application/src/*.ts'] })) {
    if (isTestTier(file)) continue;
    const hits = withoutComments(censusText(REPO_ROOT, file)).match(SEQUENCE_READ)?.length ?? 0;
    if (hits > 0) found.set(file, hits);
  }
  return found;
};

describe('the stream-sequence read census (WP-109)', () => {
  it('has exactly the classified sites, and no knowledge or onboarding writer among them', () => {
    const found = census();
    expect(Object.fromEntries([...found].sort())).toEqual(
      Object.fromEntries([...EXPECTED_SITES].sort()),
    );
    // The writers 333 and 357 named read their sequence only through the shared retry.
    expect(
      [...found.keys()].filter(
        (file) =>
          file.includes('/src/knowledge/') ||
          file.includes('/src/onboarding/') ||
          file.includes('/src/bootstrap/'),
      ),
    ).toEqual([]);
  });

  it('reads a tree that includes this file, so an untracked new site is seen (rule 85)', () => {
    const all = censusPaths(REPO_ROOT, { pathspecs: ['packages/application/src/*.ts'] });
    expect(all).toContain('packages/application/src/pipeline/project-stream-sites.test.ts');
    expect(all).toContain('packages/application/src/knowledge/apply.ts');
  });
});
