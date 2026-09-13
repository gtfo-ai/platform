/**
 * Every production `tasks.save` call site, counted off disk — WP-15e, criterion 3.
 *
 * PROGRESS backlog 18 was filed with a number ("twenty production `tasks.save` call sites") taken
 * by grep on one day, and it had already moved by the time the work package that owned it started:
 * `stage-executor.ts` had gained a fifth. A count stated in prose is a count a reader has to
 * re-take, and standing rule **63** is exactly about the sentence nobody re-checks — so the census
 * lives here, where the number is produced by the test rather than quoted by it.
 *
 * ## What it asserts, and why each half matters
 *
 * 1. **The total**, and the per-file split. A *new* whole-row writer is the thing this work package
 *    exists to make visible: `save` refuses a stale write now, but a caller that has no ending for
 *    the refusal turns a silent lost update into a silently failing handler. Adding one fails this
 *    test, which is the reviewer's prompt to give it an ending.
 * 2. **Where they may live.** Every site must be in one of the four modules named below, each of
 *    whose transaction owners has an ending for a refused write. A `tasks.save` anywhere else (a
 *    new job, a query module, an app) fails this test until somebody decides which owner it
 *    belongs to.
 *
 * ## Scope, and the two things it cannot see
 *
 * The scope is git's, not a list carried here (standing rule 7): tracked files **and** untracked
 * ones git would let you commit, because standing rule **85** was earned by a census that was green
 * on every local run and red the moment its own new file was added. Ignored files are out, which is
 * the same rule's other half.
 *
 * It cannot see a save made through an alias (`const save = store.tasks.save; save(...)`) or one
 * reached through a variable holding the repository — it is a syntactic check, like
 * `apps/web/src/no-html.test.ts`, and it lists what it catches rather than claiming closure. And
 * the **test tiers are out of scope on purpose**: a test drives the store directly, that is what a
 * store contract *is*, and `test/contract/support/pipeline-store-suite.ts` calls `save` seven times
 * by design. That exclusion is also what keeps this file out of its own census (standing rule 59) —
 * stated rather than relied on silently.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

/**
 * The transaction owners that have an ending for a refused write (WP-15e).
 *
 * `stage-executor.ts` owns its transactions and retries through `retryOnTaskConflict`, escalating
 * the task when the bound is spent; so does `jobs.ts`, which reaches the store through
 * `applyDecision` and therefore has no `save` of its own. `saga.ts` and `transitions.ts` run inside
 * the handler transaction `EventBus` owns, and the bus re-runs the handler on a conflict with the
 * same bound — which is why a handler must let the conflict escape rather than catch it
 * (`task-conflict.ts` has the argument). `task-conflict.ts`'s own site is the **ending**:
 * `escalateTaskAfterConflict` parks a task whose write lost every race.
 */
const EXPECTED_SITES: ReadonlyMap<string, number> = new Map([
  ['packages/application/src/pipeline/saga.ts', 11],
  ['packages/application/src/pipeline/stage-executor.ts', 5],
  ['packages/application/src/pipeline/transitions.ts', 5],
  ['packages/application/src/pipeline/task-conflict.ts', 1],
]);

const gitFiles = (args: readonly string[]): string[] =>
  execFileSync('git', [...args, '-z', '--', '*.ts', '*.tsx'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\0')
    .filter((file) => file.length > 0);

/** Tracked *and* committable-but-untracked, which is the tree the pre-push hook sees (rule 85). */
const sources = (): string[] => [
  ...new Set([
    ...gitFiles(['ls-files']),
    ...gitFiles(['ls-files', '--others', '--exclude-standard']),
  ]),
];

const isTestTier = (file: string): boolean =>
  file.startsWith('test/') ||
  /\.(?:test|spec)\.[cm]?tsx?$/.test(file) ||
  /(?:^|\/)(?:testing|fixtures)\.ts$/.test(file) ||
  file.includes('/src/testing/');

/** Crude comment stripping, the same trade `apps/launcher/src/docker-access.test.ts` states. */
const withoutComments = (source: string): string =>
  source
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
        return '';
      }
      const comment = line.indexOf('//');
      return comment === -1 ? line : line.slice(0, comment);
    })
    .join('\n');

const SAVE_CALL = /\btasks\s*\.\s*save\s*\(/g;

const census = (): Map<string, number> => {
  const found = new Map<string, number>();
  for (const file of sources()) {
    if (isTestTier(file)) {
      continue;
    }
    const body = withoutComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    const hits = body.match(SAVE_CALL)?.length ?? 0;
    if (hits > 0) {
      found.set(file, hits);
    }
  }
  return found;
};

describe('the whole-row `tasks.save` census (WP-15e)', () => {
  it('has exactly the call sites this work package gave an ending, and no others', () => {
    expect(Object.fromEntries([...census()].sort())).toEqual(
      Object.fromEntries([...EXPECTED_SITES].sort()),
    );
  });

  it('counts twenty-two, which is the number the change states', () => {
    // Twenty-one inherited from WP-15d (`saga.ts` 11, `transitions.ts` 5, `stage-executor.ts` 5 —
    // backlog 18 counted twenty before `stage-executor.ts` gained its fifth) plus the one
    // `escalateTaskAfterConflict` adds, which is the ending for the other twenty-one.
    const total = [...census().values()].reduce((sum, count) => sum + count, 0);
    expect(total).toBe(22);
    expect([...EXPECTED_SITES.values()].reduce((sum, count) => sum + count, 0)).toBe(total);
  });

  it('reads a tree that includes untracked sources, so a planted site is seen (rule 85)', () => {
    // The scope itself, asserted: `git ls-files --others --exclude-standard` is what makes an
    // uncommitted new file visible, and it is the half the pool census was missing when it shipped
    // green and failed on push.
    const all = sources();
    expect(all).toContain('packages/application/src/pipeline/saga.ts');
    expect(all).toContain('packages/application/src/pipeline/task-save-sites.test.ts');
  });
});
