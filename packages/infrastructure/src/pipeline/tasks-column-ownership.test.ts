/**
 * Every column of `tasks` has **one** writing statement — read off disk (WP-15e) — except the ones
 * {@link CO_OWNED_COLUMNS} names by shape with a reason (`mr_ref`, WP-60 and WP-138).
 *
 * This is the half of PROGRESS backlog 18 that a version column cannot do. Optimistic concurrency
 * makes `save` refuse a write over a row that moved; it says nothing about a column `save` names
 * that it has no business naming. That was live on `main` until this work package: WP-15d gave the
 * workpad job `saveWorkpad` so it would stop clobbering the executor's cost, and `save` still wrote
 * `workpad_ref`, so the executor went on clobbering the workpad — one direction fixed, one
 * direction not, and nothing could tell, because the property was *described* in a docblock rather
 * than checked.
 *
 * So it is checked. Standing rule **44**: a "this is the only place X happens" docblock must be
 * enforced by the same check that enforces X, or it is decoration.
 *
 * ## Scope
 *
 * git's, not a list carried here (rule 7): tracked sources **and** untracked-but-committable ones
 * (rule 85), `.ts` and `.sql`. A new adapter that writes `tasks` is inside the scope the moment the
 * file exists, which is the point — the writer this guard exists to catch is the one nobody has
 * written yet.
 *
 * ## What it reads, and the three things it cannot
 *
 * It finds `update tasks set … where …` inside a string or template literal — the character before
 * `update` must be a quote or a backtick, and the line must not begin a comment — and takes the
 * identifier on the left of every top-level assignment. That rule is what keeps the prose in
 * `store.ts` ("every `update tasks` statement") and in `memory-pipeline.ts` out of the corpus,
 * because a guard that fires on legitimate content gets switched off.
 *
 *  - **A statement built by concatenation is invisible.** `\`update tasks set \` + column` parses as
 *    a set clause with no assignments and is reported as unparsable rather than skipped, but a
 *    column name that only exists at runtime cannot be attributed to an owner at all.
 *  - **It cannot see an `insert … on conflict do update`.** `tasks` has no upsert writer today and
 *    the census below would not find one; a reviewer adding one owes this guard a case.
 *  - **It says nothing about the in-memory store**, which is TypeScript rather than SQL. The
 *    memory store's own `save` is held to the same column set by the shared contract suites, and
 *    its divergence register says so explicitly.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CensusUnreadableError,
  censusPaths,
  readCensus,
} from '../../../../scripts/census-files.mjs';
import { checkoutGitEnv } from '../../../../scripts/git-scratch-env.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

/**
 * Columns more than one statement may write, with the reason.
 *
 * `updated_at` is a bookkeeping timestamp every writer sets to `now()`; two writers racing on it
 * disagree about a millisecond and about nothing else, and giving it an owner would mean a narrow
 * write could not touch it — which is worse, because then a narrow write would leave the row
 * looking untouched.
 *
 * `version` is the other, added deliberately at WP-59 review round 1: `save` owns it as the token it
 * guards with, and `bumpVersion` moves it **and nothing else**, for an appender that writes a task's
 * stream from outside the task's transactions (the conflict warning's peer half). It writes no
 * column of the aggregate, so it cannot clobber one; its whole effect is to make an in-flight
 * `save` over a stale snapshot refuse and retry — which is the property the token exists for.
 */
const SHARED_COLUMNS: ReadonlySet<string> = new Set(['updated_at', 'version']);

/**
 * Columns more than one statement writes by decision, with the statements named and the reason —
 * the exception to "exactly one", stated by shape so a further writer still fails.
 *
 * `mr_ref` (WP-60, PROGRESS backlog 182; WP-138): since WP-138 it is **not** `save`'s — a whole-row
 * write no longer names it, so no stale snapshot can put an older merge request back — and three
 * narrow statements write it, each one key or one transition of the document:
 * `recordMergeRequest` (the developer's `open_mr`, compare-and-set: only while the row holds none or
 * the same iid, on the task's own branch), `releaseMergeRequest` (the rework's let-go, only while it
 * names that iid) and `saveMergeRequestHead` (one key, `head_sha`, forward only by the provider's
 * instant, still bumping the token as it did when `save` owned the document). All three live in
 * `postgres-pipeline-store.ts`, which the per-file list below still pins.
 */
const CO_OWNED_COLUMNS: Readonly<Record<string, readonly RegExp[]>> = {
  // Named by the statement's shape, not counted (review round 1): a substituted writer — a second
  // whole-document assignment, say — fails even at the same count.
  mr_ref: [
    // `recordMergeRequest`: the whole document, compare-and-set on the iid and the branch.
    /mr_ref\s*=\s*case[\s\S]*jsonb_set\(\$2::jsonb,\s*'\{head_sha\}',\s*mr_ref\s*->\s*'head_sha'\)[\s\S]*mr_ref\s+is\s+null\s+or\s+\(mr_ref\s*->>\s*'iid'\)::int\s*=\s*\$3[\s\S]*branch\s+is\s+null\s+or\s+branch\s*=\s*\$4/,
    // `releaseMergeRequest`: null, only while it names the iid.
    /mr_ref\s*=\s*null[\s\S]*\(mr_ref\s*->>\s*'iid'\)::int\s*=\s*\$2/,
    // `saveMergeRequestHead`: one key, forward only by the provider's instant, bumping the token.
    /mr_ref\s*=\s*case\s+when\s+\$5\s+then\s+jsonb_set\(mr_ref,\s*'\{head_sha\}'[\s\S]*version\s*=\s*version\s*\+\s*case\s+when\s+\$5[\s\S]*mr_head_at\s*<\s*\$4::timestamptz/,
  ],
  // WP-145 (PROGRESS backlog 437): `branch` is the aggregate's (`save`), and `rekeyTicket` fills it
  // **only while it is null** — the old key's branch, pinned when a moved issue's task changes key,
  // so the work stays on `agentic/<old key>`. It bumps the token, so `save` over a snapshot read
  // before it is refused rather than writing the `null` back (rule 79).
  branch: [
    // `save`: the whole aggregate, guarded by the version.
    /set\s+state\s*=\s*\$2::task_state,\s*current_stage\s*=\s*\$3,\s*branch\s*=\s*\$4/,
    // `rekeyTicket`: coalesce only, compare-and-set on the old key, bumping the token.
    /branch\s*=\s*coalesce\(branch,\s*\$5::text\),\s*version\s*=\s*version\s*\+\s*1[\s\S]*ticket_key\s*=\s*\$2/,
  ],
};

/** The owner of every `tasks` column that any statement in this repository writes. */
const EXPECTED_OWNERSHIP: Readonly<Record<string, readonly string[]>> = {
  'packages/infrastructure/src/cost/postgres-cost-store.ts': [
    // `saveEstimate` — the four columns of the cost estimate (WP-19, and WP-28's basis/samples)
    'size',
    'estimate_usd',
    'estimate_basis',
    'estimate_samples',
  ],
  'packages/infrastructure/src/recovery/postgres-deferred-dependency-store.ts': [
    // `markDeferredDependencyAttempt` — the recovery pass's one attempt per resume for a deferred
    // dependency-gate ending whose wake-up was lost (WP-84, migration 0059, backlog 240). A column
    // of the recovery's own on the task's row, the shape migration 0032 gave the other marks.
    'dependency_recovery_attempted_at',
  ],
  'packages/infrastructure/src/recovery/postgres-stranded-stage-store.ts': [
    // `markStageAttempt` — the recovery pass's one attempt per stage entry for a task left at an
    // agent or gate stage with no job and no run (WP-108, migration 0067, backlog 320); the same
    // shape as the mark above, written only while the entry is still stranded.
    'stage_recovery_attempted_at',
  ],
  'packages/infrastructure/src/pipeline/postgres-pipeline-store.ts': [
    // `saveTicketSnapshot`
    'ticket_snapshot',
    'ticket_snapshot_at',
    // `recordTicketSignal` — the newest `ticket.updated`'s receipt time on every live task of the
    // ticket (WP-60, Q61 (b)). Narrow because its writer is an event handler on a *project*-stream
    // event, ordered with respect to none of the task's own transactions.
    'ticket_signal_at',
    // `rekeyTicket` — the key and URL a moved issue holds now, compare-and-set on the old key
    // (WP-145, backlog 437). Insert-only until it; its third column, `branch`, is co-owned (above).
    'ticket_key',
    'ticket_url',
    // `saveMergeRequestHead` — the provider's instant of the recorded head, which orders the head's
    // moves (WP-60 review round 1). Its other column, `mr_ref`, is co-owned (above).
    'mr_head_at',
    // `saveWorkpad`
    'workpad_ref',
    // `saveRiskClasses` — the classes the merge request's own diff falls into (WP-37). A fourth
    // narrow writer for the third time the same reason applied: it runs in a `pipeline.outbound`
    // job beside the stage executor.
    'risk_classes',
    // `saveCoverage` — what the CI reported for the head revision and for the default branch
    // (WP-39). The fifth narrow writer, same reason again: the `coverage` duty fires on
    // `ci.pipeline.finished`, which arrives whenever it arrives.
    'coverage',
    // `saveDependencies` — what the dependency gate found in the Developer stage's diff and what
    // it decided (WP-38). The sixth narrow writer, same reason again: the `dependency_gate` duty
    // runs in a `pipeline.outbound` job beside the stage executor — and it stays narrow even in the
    // `ask` ending, which writes the aggregate in the same transaction, because the record is not
    // the aggregate's.
    'dependencies',
    // `saveRequiredReviewers` — who the routing asked for a review from, including the handles it
    // could not resolve (WP-38, the record WP-37's duty had nowhere to put).
    'required_reviewers',
    // `saveReviewThreads` — the merge request's human review threads, open and resolved, as BD-007's
    // review window counted them (WP-46, migration 0048). The eighth narrow writer, same reason
    // again: the window is the `mr.comment.debounce` job, which runs beside the stage executor.
    'review_threads',
    // `saveReadyHead` — the head the gates judged on the way into `ready_for_merge` (WP-79,
    // migration 0056, backlog 267). Its **one** caller is `applyDecision`'s Ready entry
    // (`packages/application/src/pipeline/transitions.ts`), inside the entry's own transaction;
    // the `ready_head_check` duty reads it and never writes it.
    'ready_head_sha',
    // `saveCiSettlement` — the head the CI gate last passed (WP-79 review round 2, backlog 275) and
    // the protected paths it excused provisionally (WP-102, migration 0065, Q109 (b)), in one
    // statement. One caller: the gate settlement in `packages/application/src/pipeline/jobs.ts`;
    // the rebase gate's settlement reads both before it lets a task into Ready.
    'ci_head_sha',
    'ci_excused_paths',
    // `refreezeSettings` — the frozen limits and dial of a task created under a `configRefusal`,
    // taken again from the parsed document before its first admitted run, and the mark that says
    // so (WP-106, migration 0066). One caller: the stage executor's admission. The insert writes
    // all three at creation, which this census does not read.
    'iteration_limits',
    'pipeline_dial',
    'settings_refreeze_pending',
    // Review round 2: the template routed again at `intake` (id and snapshot), and intake's routing
    // inputs, cleared in the same statement.
    'template',
    'template_snapshot',
    'refreeze_routing',
    // `saveRequester` — the column's first `update` (WP-79, backlog 243): the reporter a stage's
    // ticket re-read resolved through `user_identities`, filled only while the row holds `null`.
    // The other writer is the **insert** (discovery, a shadow batch, a bootstrap's chunk tasks and,
    // since WP-79, intake), which this census does not read — see "What it reads" above.
    'requested_by_user_id',
    // `addSpend` — the one column two *processes* write, and therefore the one whose statement is
    // an increment rather than an assignment (WP-31). It left `save`'s list with this row: the ask
    // executor adds a run's spend from a process that runs beside the stage executor, and the
    // version token cannot arbitrate an increment.
    'cost_actual',
    // `raiseBudgetCap` — the task's own cap, only ever raised, by a maintainer's command (WP-131
    // review round 1, migration 0072). Not the aggregate's, and never `save`'s.
    'budget_cap_usd',
    // `save` — the aggregate's own columns, plus the token that guards them
    'state',
    'current_stage',
    'branch',
    // `recordMergeRequest`, `releaseMergeRequest`, `saveMergeRequestHead` — co-owned (above);
    // not `save`'s since WP-138.
    'mr_ref',
    'stage_attempts',
    'iteration_counters',
    'completed_at',
  ],
};

const sources = (): string[] => censusPaths(REPO_ROOT, { pathspecs: ['*.ts', '*.sql'] });

interface Statement {
  readonly file: string;
  readonly columns: readonly string[];
  /** The statement's whole literal, predicate included — what a co-owner is named by. */
  readonly text: string;
}

const UPDATE_TASKS = /update\s+tasks\s+set\b([\s\S]*?)\bwhere\b/gi;

/** The line `index` falls on, so a match inside a comment can be recognised. */
const lineAt = (source: string, index: number): string => {
  const start = source.lastIndexOf('\n', index) + 1;
  const end = source.indexOf('\n', index);
  return source.slice(start, end === -1 ? source.length : end);
};

/** Splits a `set` clause on commas that are not inside parentheses. */
const assignments = (clause: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of clause) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
};

const statementsIn = (file: string, source: string): Statement[] => {
  const found: Statement[] = [];
  UPDATE_TASKS.lastIndex = 0;
  for (const match of source.matchAll(UPDATE_TASKS)) {
    const index = match.index ?? 0;
    const before = source.slice(0, index).replace(/\s+$/, '');
    const quote = before.at(-1);
    if (quote !== '`' && quote !== "'" && quote !== '"') {
      continue;
    }
    const line = lineAt(source, index).trimStart();
    if (line.startsWith('*') || line.startsWith('//') || line.startsWith('--')) {
      continue;
    }
    const columns = assignments(match[1] ?? '').map((part) => part.split('=')[0]?.trim() ?? '');
    // The whole literal: from `update` to the quote that closes the one it opened in.
    const close = source.indexOf(quote, index);
    found.push({ file, columns, text: source.slice(index, close === -1 ? undefined : close) });
  }
  return found;
};

/**
 * Every `update tasks` statement in the tree.
 *
 * A path that vanished between the listing and the read is dropped (and named, below), which is the hole its
 * sibling census already names: *"a path can disappear between `ls-files` and here (a concurrent
 * editor, a temp file); a census that crashed on that would be a census people turn off"*
 * (`db/pool-errors.test.ts`). Measured here rather than reasoned — this file failed a `verify` with
 * `ENOENT … .vitest-scope-23805-egp4di/plain/ordinary.e2e.test.ts`, a fixture another test in the
 * same run plants and deletes, and it is a **crash** rather than a finding: the census reports
 * nothing at all rather than reporting one file it could not read. Found while WP-21 was in review;
 * the file is WP-15e's and nothing about it changed except this guard. Since WP-68 the listing, the
 * vanished-path rule and the unreadable-path report are `scripts/census-files.mjs`'s, shared with
 * every census: an unreadable path throws naming itself rather than reading as "no `update tasks`".
 */
/** A path the listing named and the read could not find — see {@link allStatements}. */
const dropped: string[] = [];

const allStatements = (): Statement[] => {
  const { files, vanished, unreadable } = readCensus(REPO_ROOT, sources());
  if (unreadable.length > 0) {
    throw new CensusUnreadableError(unreadable);
  }
  dropped.length = 0;
  dropped.push(...vanished);
  return files.flatMap(({ path: file, contents }) => statementsIn(file, contents));
};

/**
 * Is this dropped path genuinely gone — untracked and absent — or a **tracked** file this census
 * failed to read?
 *
 * The difference is the whole point of reporting them: a temp file another test planted and deleted
 * is a race to tolerate, and a tracked file that is missing is a hole in the census, which would
 * otherwise be indistinguishable from "this file contains no `update tasks`".
 */
const isTracked = (file: string): boolean =>
  execFileSync('git', ['ls-files', '--error-unmatch', '--', file], {
    cwd: REPO_ROOT,
    env: checkoutGitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\n')
    .some((line) => line.trim() === file);

describe('`tasks` column ownership (WP-15e)', () => {
  it('drops only paths that are genuinely gone, and says which', () => {
    // Dropping a vanished path tolerates a race; silently, it would also tolerate a **tracked**
    // file this census cannot read, which looks exactly like a file with no `update tasks` in it.
    // Nothing is expected here on a quiet tree — the assertion is that whatever *is* dropped was
    // untracked, and the path is in the message so a real gap names itself.
    // Calibrate the instrument before believing its verdict (standing rule 21): a predicate that
    // answered `false` for everything would make the assertion below vacuous.
    expect(isTracked('packages/infrastructure/src/pipeline/tasks-column-ownership.test.ts')).toBe(
      true,
    );
    expect(() => isTracked('packages/infrastructure/src/pipeline/not-a-file.ts')).toThrow();

    allStatements();
    const trackedButMissing = dropped.filter((file) => {
      try {
        return isTracked(file);
      } catch {
        // `--error-unmatch` exits non-zero for a path git does not track: genuinely gone.
        return false;
      }
    });
    expect(trackedButMissing).toEqual([]);
  });

  it('parses every `update tasks` statement it finds into plain column names', () => {
    // Fail closed: a set clause this guard cannot read is a statement whose columns cannot be
    // attributed, and reporting it as "no columns" would be a silent hole (standing rule 20).
    for (const statement of allStatements()) {
      expect(statement.columns.length).toBeGreaterThan(0);
      for (const column of statement.columns) {
        expect(column, `${statement.file} writes an unreadable assignment target`).toMatch(
          /^[a-z_][a-z0-9_]*$/,
        );
      }
    }
  });

  it('gives every column exactly one writing statement', () => {
    const owners = new Map<string, string[]>();
    for (const [index, statement] of allStatements().entries()) {
      for (const column of statement.columns) {
        if (SHARED_COLUMNS.has(column)) {
          continue;
        }
        owners.set(column, [...(owners.get(column) ?? []), `${statement.file}#${index}`]);
      }
    }
    const contested = [...owners].filter(
      ([column, writers]) => writers.length > (CO_OWNED_COLUMNS[column]?.length ?? 1),
    );
    // The declared co-ownership is **exact**, not a ceiling, and it is by **shape**: each named
    // statement is found exactly once among the column's writers, and nothing else writes it — so a
    // stale exception, a third writer and a substituted one all fail.
    const statements = allStatements();
    for (const [column, shapes] of Object.entries(CO_OWNED_COLUMNS)) {
      const writers = statements.filter((statement) => statement.columns.includes(column));
      expect({ column, writers: writers.length }).toEqual({ column, writers: shapes.length });
      for (const shape of shapes) {
        expect(
          writers
            .filter((statement) => shape.test(statement.text))
            .map((statement) => statement.file),
          `${column}: the writer shaped ${shape} is missing or doubled`,
        ).toEqual(['packages/infrastructure/src/pipeline/postgres-pipeline-store.ts']);
      }
    }
    // `workpad_ref` was in this list on `main` at 5121d73 — written by `save` and by `saveWorkpad`
    // — which is the defect, not a false positive.
    expect(Object.fromEntries(contested)).toEqual({});
  });

  it('writes exactly the columns this change says it writes, per file', () => {
    const byFile = new Map<string, Set<string>>();
    for (const statement of allStatements()) {
      const columns = byFile.get(statement.file) ?? new Set<string>();
      for (const column of statement.columns) {
        if (!SHARED_COLUMNS.has(column)) {
          columns.add(column);
        }
      }
      byFile.set(statement.file, columns);
    }
    expect(
      Object.fromEntries([...byFile].map(([file, columns]) => [file, [...columns].sort()])),
    ).toEqual(
      Object.fromEntries(
        Object.entries(EXPECTED_OWNERSHIP).map(([file, columns]) => [file, [...columns].sort()]),
      ),
    );
  });
});
