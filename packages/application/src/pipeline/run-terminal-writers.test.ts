/**
 * Every writer of a terminal run status closes the run's offer — WP-274, criterion (6b), TD-031 §12.
 *
 * The per-task partial unique index `run_offers_one_live_stage_per_task` (migration 0094) replaces
 * the job singleton for a run's duration: a task's next stage offer is refused while an earlier
 * stage offer of the task is still `open` or `claimed`. So a terminal writer that ended a run
 * **without** closing its offer would leave the task unable to run another stage — and it would do
 * so silently, at the next stage's insert, in another job. This census makes that a failure here.
 *
 * ## The shape it holds
 *
 * There is **one** place a run's status becomes terminal: `RunRepository.finish` (the conditional
 * `update runs … where status = any(active)`), and `finish` closes the offer in the same
 * transaction after it wins the row (`closeRunOffer` in the PostgreSQL adapter, `closeOffer` in the
 * memory store; the contract suite holds both to the behaviour). So the census has three halves:
 *
 * 1. **No other statement writes `runs.status`.** Every production SQL text that updates `runs` and
 *    assigns `status` is listed — today exactly `finish`'s — so a new raw writer fails here until it
 *    goes through `finish` or closes the offer itself and is added below with its reason.
 * 2. **Both `finish` implementations close the offer**, read off their bodies.
 * 3. **Every caller of `finish` is named**, per file, with the terminal writer of criterion (6b) it
 *    is — so a new terminal writer is a decision somebody records rather than a line somebody adds.
 *
 * ## Criterion (6b)'s writers, and where each one's `finish` is
 *
 * - the normal finish and failure — `stage-executor.ts`'s transaction 2: `record` and
 *   `recordUnsuccessful`;
 * - cancel — `cancelRunCommand`'s in-place ending (`commands.ts`, no live lease), and the holder's
 *   applied cancel, which stops the session so the run ends `cancelled` through the executor's own
 *   `recordUnsuccessful`;
 * - the start failures — `recordUnstarted`;
 * - today's lease sweep — `recovery/run-lease.ts`;
 * - WP-144's shutdown hand-back — `recordHandBack`;
 * - the take-over's stop — the holder stops the session and the executor's `recordOntoStoppedTask`
 *   ends the run (the task was stopped under it);
 * - the ask's ending — `ask/executor.ts`'s four: the hand-back, the failure, the answer and the
 *   start failure.
 *
 * ## What it cannot see
 *
 * Like `task-save-sites.test.ts`, it is syntactic: a `finish` reached through an alias, or a SQL text
 * assembled from fragments so that `update runs` and `set … status` are in different literals, is
 * invisible to it. The test tiers are out of scope by design (a store contract drives `finish`
 * directly), which also keeps this file out of its own census.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { censusPaths, censusText } from '../../../../scripts/census-files.mjs';
import { withoutComments } from '../../../../scripts/source-scanner.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

/** The callers of `runs.finish`, per file — each a terminal writer criterion (6b) names. */
const EXPECTED_FINISH_CALLERS: ReadonlyMap<string, number> = new Map([
  // `cancelRunCommand`'s in-place ending (no live lease, WP-101).
  ['packages/application/src/pipeline/commands.ts', 1],
  // `record`, `recordOntoStoppedTask` (the take-over's stop), `recordUnsuccessful` (failure and the
  // holder's applied cancel), `recordHandBack` (WP-144's shutdown) and `recordUnstarted`.
  ['packages/application/src/pipeline/stage-executor.ts', 5],
  // The ask's endings: the hand-back, the failure, the answer, and the start failure.
  ['packages/application/src/ask/executor.ts', 4],
  // The lease sweep (`lease_expired`).
  ['packages/application/src/recovery/run-lease.ts', 1],
]);

/** The production SQL texts that assign `runs.status`, per file — `finish`'s alone. */
const EXPECTED_STATUS_WRITERS: ReadonlyMap<string, number> = new Map([
  ['packages/infrastructure/src/pipeline/postgres-pipeline-store.ts', 1],
]);

const sources = (): string[] => censusPaths(REPO_ROOT, { pathspecs: ['*.ts', '*.tsx'] });

const isTestTier = (file: string): boolean =>
  file.startsWith('test/') ||
  /\.(?:test|spec)\.[cm]?tsx?$/.test(file) ||
  /(?:^|\/)(?:testing|fixtures)\.ts$/.test(file) ||
  file.includes('/src/testing/');

const FINISH_CALL = /\bruns\s*\.\s*finish\s*\(/g;

/**
 * One SQL statement that updates `runs` and assigns `status` (not `lease_status` or the like): an
 * `update runs` whose text up to its `where` contains `status =` as a bare assignment. Read over a
 * comment-stripped body, statement by statement (split at `update`).
 */
const STATUS_WRITE =
  /\bupdate\s+(?:only\s+)?runs\b(?:\s+(?:as\s+)?(?!set\b)\w+)?\s+set\b((?:(?!\bwhere\b)[\s\S])*)/gi;
const ASSIGNS_STATUS = /(?:^|[\s,])status\s*=/i;

const census = (pattern: (body: string) => number): Map<string, number> => {
  const found = new Map<string, number>();
  for (const file of sources()) {
    if (isTestTier(file) || file.includes('/db/migrations/')) {
      continue;
    }
    const hits = pattern(withoutComments(censusText(REPO_ROOT, file)));
    if (hits > 0) {
      found.set(file, hits);
    }
  }
  return found;
};

const sorted = (map: ReadonlyMap<string, number>) => Object.fromEntries([...map].sort());

/** The body of `name: async (…) => {` up to the next sibling member, read off `file`. */
const memberBody = (file: string, name: string): string => {
  const text = withoutComments(censusText(REPO_ROOT, file));
  const start = text.search(new RegExp(`\\b${name}: async \\(`));
  expect(start, `${file} declares ${name}`).toBeGreaterThan(-1);
  const rest = text.slice(start);
  const next = rest.search(/\n {4}[a-zA-Z]+: async \(/);
  return next === -1 ? rest : rest.slice(0, next);
};

describe('the terminal run-status writers close the offer (WP-274, criterion 6b)', () => {
  it('has exactly one SQL text assigning runs.status, RunRepository.finish', () => {
    expect(
      sorted(
        census(
          (body) =>
            [...body.matchAll(STATUS_WRITE)].filter((match) => ASSIGNS_STATUS.test(match[1] ?? ''))
              .length,
        ),
      ),
    ).toEqual(sorted(EXPECTED_STATUS_WRITERS));
  }, 15_000);

  it('closes the offer in both finish implementations, after the row is won', () => {
    const postgres = memberBody(
      'packages/infrastructure/src/pipeline/postgres-pipeline-store.ts',
      'finish',
    );
    expect(postgres).toMatch(/if \(result\.rowCount !== 0\) \{\s*await closeRunOffer\(/);
    const memory = memberBody('packages/application/src/testing/memory-pipeline.ts', 'finish');
    expect(memory).toMatch(/closeOffer\(outcome\.runId/);
    // The closing statement itself: `claimed → settled`, `open → withdrawn`.
    const closing = withoutComments(
      censusText(REPO_ROOT, 'packages/infrastructure/src/pipeline/postgres-run-offers.ts'),
    );
    expect(closing).toMatch(/when 'claimed' then 'settled' else 'withdrawn'/);
    expect(closing).toMatch(/where run_id = \$1 and state in \('open', 'claimed'\)/);
  });

  it('names every caller of runs.finish — each one a terminal writer criterion (6b) lists', () => {
    expect(sorted(census((body) => body.match(FINISH_CALL)?.length ?? 0))).toEqual(
      sorted(EXPECTED_FINISH_CALLERS),
    );
  }, 15_000);
});
