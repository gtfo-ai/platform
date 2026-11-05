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
 * ## Since BACKLOG 971: one shape, and one read that is not an append's
 *
 * Every writer of a shared stream — a project's or a run's — now takes the stream's lock and reads
 * its sequence **inside** its transaction through `scope.events.lockStreamSequence`, so none reads
 * `nextStreamSequence` to append at. The project-stream writers go through `appendOnProjectWithRetry`
 * (`project-stream.ts`), whose in-place retry is the defence against a writer that bypassed the lock;
 * the run-stream writers (`commands.ts`, `run-lease.ts`, `settle.ts`, `claimant.ts`,
 * `ask/executor.ts`, `offer-withdrawal.ts`, `remote-runs.ts`) were already serialised by the `runs`
 * row's compare-and-set and now read on the transaction's own connection rather than borrowing a
 * second one from the pool.
 *
 * The one `nextStreamSequence` left is `integrations/inbound.ts`'s: the stream position a
 * merge-request lifecycle answer was read at, outside the transaction, compared under the lock with
 * the position the transaction holds (WP-110). It is not a sequence anything is appended at.
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
  // the lifecycle answer's stream position, never an append's sequence (module docblock)
  ['packages/application/src/integrations/inbound.ts', 1],
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

describe('the stream-sequence read census (WP-109, BACKLOG 971)', () => {
  // WP-249: slowest of 10 green CI runs 787 ms (median 737 ms); 2× it, 15 s floor.
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
  }, 15_000);

  // WP-249: under 300 ms in all 10 green CI runs (vitest printed no duration); the 15 s floor.
  it('reads a tree that includes this file, so an untracked new site is seen (rule 85)', () => {
    const all = censusPaths(REPO_ROOT, { pathspecs: ['packages/application/src/*.ts'] });
    expect(all).toContain('packages/application/src/pipeline/project-stream-sites.test.ts');
    expect(all).toContain('packages/application/src/knowledge/apply.ts');
  }, 15_000);
});
