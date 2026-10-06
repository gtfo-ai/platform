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
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { censusPaths, censusText } from '../../../../scripts/census-files.mjs';
import { withoutComments } from '../../../../scripts/source-scanner.mjs';

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
 *
 * `dependency-gate.ts` joined them at WP-38 with **one** site and the **job's** ending: the `ask`
 * branch moves the task to `waiting_answers` through the aggregate, inside a transaction the duty
 * owns, so it retries through `retryOnTaskConflict` and escalates when the bound is spent — the
 * same ending `jobs.ts` gives, spelled locally because that module's helper takes a
 * `PipelineJobOptions` this duty has no `StageExecutor` for. The gate's **other** write is narrow
 * (`saveDependencies`) and is not in this census by design: it is a column `save` does not name.
 *
 * `recovery/run-lease.ts` joined them at **WP-47**, and it is the first site outside
 * `pipeline/` — which is a fact about where a transaction owner may live, not a loosening. The
 * lease sweep ends a run no process is renewing and escalates its task, in a transaction it owns,
 * so it retries through `retryOnTaskConflict` like a job. Its ending when the bound is spent is the
 * **third** shape and is stated at the function: the error escapes to the recovery pass's caller —
 * the `pipeline.intake.reconcile` job — and what is lost is the *escalation*, never the run row,
 * because the attempt that committed had already made the run terminal and released its
 * reservation. Re-parking a task on the next pass is impossible by construction (the run is no
 * longer live), which is why it does not call `escalateTaskAfterConflict`: that would be a second
 * transaction escalating a task about a run this pass can no longer see.
 *
 * `dead-letter.ts` joined them at **WP-49** with the **fourth** ending, and it is the only site that
 * owns no transaction of its own: it runs inside the *dispatcher's*, called when an event has spent
 * its attempt bound, and it parks the task exactly as `task-conflict.ts` does for an exhausted
 * conflict. A refused write therefore escapes — `EventBus` owns that transaction, so catching it
 * here would be the in-handler retry `task-conflict.ts` forbids — and it rolls the dead letter back
 * with it, which means the event is offered again on the next sweep and the escalation is retried
 * rather than lost. That is the fail-closed direction (standing rule 20) and it is why this site
 * needs neither `retryOnTaskConflict` nor an escalation of its own.
 *
 * `commands.ts` joined them at WP-15i, and its ending is the **other** one: a human command owns
 * its transaction and retries through `retryOnTaskConflict` like a job, but when the bound is spent
 * the error reaches the caller as a typed `409` rather than escalating the task — a person can press
 * the button again, and parking their task for a race they never saw is not an ending they asked
 * for. Its **four** sites are pause, cancel, the pause a cancelled run leaves behind, and WP-27's
 * take-over — which is a pause with a branch and a session id on its event, and which therefore
 * shares that ending exactly.
 *
 * `deadlines.ts` joined them at **WP-56** with **one** site and the **job's** ending, spelled as the
 * dependency gate spells it: the `deadline.sweep` job escalates a take-over nobody touched for five
 * working days, in a transaction it owns, retrying through `retryOnTaskConflict` and handing an
 * exhausted bound to `escalateTaskAfterConflict` — whose ending is the same state this one wanted.
 * The question and approval expiries write **no** task row: they expire their own aggregate and the
 * saga escalates on the event, inside the handler transaction `EventBus` owns.
 *
 * **WP-79 adds no site, and says why.** The `ready_head_check` duty (`ready-head.ts`) moves the task
 * through `applyDecision` inside `jobs.ts`'s exported `inTaskTransaction`, so it has the job's retry
 * and ending and no `save` of its own; the two columns WP-79 writes (`ready_head_sha`,
 * `requested_by_user_id`'s fill) are narrow statements `save` does not name, held by
 * `tasks-column-ownership.test.ts` instead of here. The resume and hand-back into Ready now write
 * nothing but the hand-back's event, so `commands.ts` keeps its four.
 *
 * `recovery/stranded-stage.ts` joined them at **WP-108** with **one** site: the ending of a task
 * left at an agent or gate stage nothing ever ran (backlog 320), escalated from the recovery pass in
 * a transaction it owns, under `retryOnTaskConflict`. Its ending when the bound is spent is the
 * fifth shape: logged, and left to the next pass — the task is still stranded and still marked, so
 * the next pass finds it again, which `run-lease.ts` cannot rely on (its run is terminal by then).
 *
 * `pipeline/job-escalation.ts` joined them at **WP-124** with **two** sites — the escalation and the
 * amended brief of `escalateTaskWithBrief`, the ending of a job a person waits on that spent its
 * tries (TD-004's M7 amendment) and of the discovery-record recovery row. A transaction of its own
 * under `retryOnTaskConflict`; a spent bound escapes to the wrapper, which logs it and rethrows the
 * job's own failure, so the job still ends `failed` and listed.
 */
const EXPECTED_SITES: ReadonlyMap<string, number> = new Map([
  ['packages/application/src/pipeline/commands.ts', 4],
  ['packages/application/src/pipeline/dead-letter.ts', 1],
  ['packages/application/src/pipeline/deadlines.ts', 1],
  ['packages/application/src/recovery/run-lease.ts', 1],
  ['packages/application/src/pipeline/dependency-gate.ts', 1],
  // 12 since WP-60 review round 2: the CI handler's streak escalation left the handler for the
  // gate settlement both paths share (`jobs.ts` § `ciConvergence`), which writes through
  // `applyDecision` rather than a `save` of its own.
  // 13 since WP-110 review round 1: the merge-request close on a task already at `needs_human`
  // amends its brief (`amendEscalation`) inside the handler, with the handler's ending.
  ['packages/application/src/pipeline/saga.ts', 13],
  // 6 since WP-63: the admission refusal of a run whose repository `.agentic/config.yml` does not
  // parse, inside the executor's own admission transaction and under its `retryOnTaskConflict`.
  ['packages/application/src/pipeline/stage-executor.ts', 6],
  ['packages/application/src/pipeline/transitions.ts', 5],
  ['packages/application/src/pipeline/task-conflict.ts', 1],
  // WP-80 (PROGRESS backlog 131): the shadow report's identifier refusal escalates its task from
  // the `pipeline.outbound` job, in a transaction of its own, under `retryOnTaskConflict`.
  ['packages/application/src/shadow/report.ts', 1],
  // WP-106 review round 1: the parking of a task whose configuration cannot be read
  // (`config-refusal.ts`). One `save`, two callers: an event handler's (the bus owns the
  // transaction, so the refusal escapes and the handler re-runs) and a job's (its own
  // transaction under `retryOnTaskConflict`; a spent bound escapes to the job's retry, and a
  // finished task is logged, as `shadow/report.ts` logs one).
  ['packages/application/src/pipeline/config-refusal.ts', 1],
  // WP-108 (PROGRESS backlog 320): the stranded-stage recovery's ending escalates a task left at a
  // stage nothing ever ran, in a transaction it owns, under `retryOnTaskConflict`; a spent bound is
  // logged and the next pass ends it, because the task is still stranded and still marked.
  ['packages/application/src/recovery/stranded-stage.ts', 1],
  // WP-124 (PROGRESS backlog 366, TD-004's M7 amendment): the bound-and-escalate ending of a job a
  // person waits on — `escalateTaskWithBrief`'s escalation and its amended brief for a task already
  // waiting — in a transaction it owns, under `retryOnTaskConflict`; a spent bound escapes to the
  // wrapper, which logs it and rethrows the job's own failure, so the failed job stays listed.
  ['packages/application/src/pipeline/job-escalation.ts', 2],
]);

/** Tracked *and* committable-but-untracked, which is the tree the pre-push hook sees (rule 85). */
const sources = (): string[] => censusPaths(REPO_ROOT, { pathspecs: ['*.ts', '*.tsx'] });

const isTestTier = (file: string): boolean =>
  file.startsWith('test/') ||
  /\.(?:test|spec)\.[cm]?tsx?$/.test(file) ||
  /(?:^|\/)(?:testing|fixtures)\.ts$/.test(file) ||
  file.includes('/src/testing/');

const SAVE_CALL = /\btasks\s*\.\s*save\s*\(/g;

const census = (): Map<string, number> => {
  const found = new Map<string, number>();
  for (const file of sources()) {
    if (isTestTier(file)) {
      continue;
    }
    const body = withoutComments(censusText(REPO_ROOT, file));
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

  it('counts thirty-eight, which is the number the change states', () => {
    // Twenty-one inherited from WP-15d (`saga.ts` 11, `transitions.ts` 5, `stage-executor.ts` 5 —
    // backlog 18 counted twenty before `stage-executor.ts` gained its fifth) plus the one
    // `escalateTaskAfterConflict` adds, which is the ending for the other twenty-one; plus four
    // from WP-15i — three human commands and the executor's sixth, which writes a run's spend onto
    // a task a human stopped mid-run without completing its stage; plus WP-27's take-over, which is
    // a fourth human command with the same ending as the other three; plus WP-28's two, both in
    // `saga.ts` and both with the handler's ending — the budget gate's `requestApproval` and the
    // escalation a rejected spend leaves, which are the plan gate's two shapes one kind across;
    // **minus one at WP-31**, which took `cost_actual` out of `save`'s column list and gave it the
    // narrow `addSpend` (the ask executor writes the same column from another process, and the
    // version token cannot arbitrate an increment). The save that went was the one on a task a
    // human stopped mid-run: with the spend written separately it had nothing left to write.
    // **Plus one at WP-38**: the dependency gate's `ask` ending, which parks the task on the
    // existing question gate from a `pipeline.outbound` job and therefore owns its own transaction,
    // its own retry and its own escalation.
    // **Plus one at WP-47**: the run-lease sweep's escalation of a task whose run nothing was
    // driving — a transaction owner outside `pipeline/` for the first time, with the retry every
    // job has and the ending named in this file's docblock.
    // **Plus one at WP-49**: the dead-letter escalation, the first site that owns **no** transaction
    // — it writes on the dispatcher's — and therefore the first whose ending is to let the refusal
    // escape and roll the dead letter back with it, so the next sweep tries again.
    // **Plus one at WP-56**: the take-over inactivity escalation, from the `deadline.sweep` job,
    // with the job's retry and `escalateTaskAfterConflict` as its ending.
    // **Minus one at WP-60 review round 2**: the CI handler's three-identical-failures escalation
    // moved into the gate settlement (`jobs.ts`), where it is a decision `applyDecision` applies.
    // **Plus one at WP-63**: the stage executor's admission refusal — a repository configuration
    // that does not parse escalates the task before any run exists, in `admit`'s own transaction,
    // with the executor's retry and `escalateOnConflict` as its ending.
    // **Plus one at WP-80**: the shadow report's identifier refusal (backlog 131), which fails the
    // `pipeline.outbound` duty and escalates the task in its own transaction, with the job's
    // `retryOnTaskConflict` as its retry and `IllegalTransitionError` logged as its ending.
    // **Plus one at WP-106 review round 1**: `config-refusal.ts`'s parking of a task whose
    // configuration cannot be read, with the handler's ending or the job's, by caller.
    // **Plus one at WP-108**: the stranded-stage recovery's escalation (backlog 320).
    // **Plus one at WP-110 review round 1**: the saga's close of a merge request whose task already
    // waits for a human writes the amended brief (`amendEscalation`), with the handler's ending.
    // **Plus two at WP-124**: `job-escalation.ts`'s escalation and amended brief, the
    // bound-and-escalate ending of a job a person waits on (backlog 366).
    const total = [...census().values()].reduce((sum, count) => sum + count, 0);
    expect(total).toBe(38);
    expect([...EXPECTED_SITES.values()].reduce((sum, count) => sum + count, 0)).toBe(total);
  });

  it('sees a site written after a `//` inside a string on the same line (backlog 269)', () => {
    // The line-by-line stripper this file carried until WP-96 cut the line at the URL's `//`.
    const planted = "const url = 'https://jira.example.test/x'; await store.tasks.save(tx, t);";
    expect(withoutComments(planted).match(SAVE_CALL)).toHaveLength(1);
    expect(withoutComments(`${planted} // tasks.save(tx, t)`).match(SAVE_CALL)).toHaveLength(1);
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

/**
 * **Every escalation closes the row of the stage it parks the task at** — the census half of the
 * invariant `transitions.ts` states at `closeLeftStage` (WP-46, PROGRESS backlog 160).
 *
 * Backlog 160 found three gate escalations that left their row `running` under a `needs_human`
 * task, and the escalation sites are many and spread across seven modules, so "remember to close
 * the row" is exactly the sentence rule 44 says must be checked rather than written. The check is
 * syntactic and per file: every `escalateTask(` call in a production module is matched by a
 * `closeParkedStageRow(` call in the same module, one for one — so a new escalation that forgets
 * fails here, naming its file.
 *
 * **Two modules close the row themselves and are exempt by name, with the reason**, rather than
 * made to call a helper that would do nothing: `stage-executor.ts` writes `recordStageExited`
 * `failed` beside each of its escalations (it knows the run's reason and has always recorded it),
 * and `recovery/run-lease.ts` does the same for a run nothing is driving (WP-47). A third exemption
 * is a decision somebody writes here.
 *
 * What it cannot see is what the save census above cannot: an escalation reached through an alias,
 * and a `closeParkedStageRow` placed on a different branch from the escalation it answers — the
 * count is per file, not per call. The per-site behaviour is asserted in `saga.test.ts`.
 *
 * **`resumeStage(` counts as an escalation** (PROGRESS backlog 495): the domain command escalates by
 * itself when its loop is spent, so its one call site (`resumeAtStage`) closes the parked row on
 * that branch like any other escalation does.
 */
const ESCALATE_CALL = /\bescalateTask\s*\(|\bresumeStage\s*\(/g;
const CLOSE_PARKED_CALL = /\bcloseParkedStageRow\s*\(/g;

const ROW_CLOSED_BY_ITS_OWN_WRITE: ReadonlyMap<string, string> = new Map([
  [
    'packages/application/src/pipeline/stage-executor.ts',
    'every escalation writes recordStageExited failed with the run’s reason',
  ],
  [
    'packages/application/src/recovery/run-lease.ts',
    'the sweep writes recordStageExited failed for the run it ends',
  ],
]);

const escalationCensus = (): Map<string, { escalations: number; closes: number }> => {
  const found = new Map<string, { escalations: number; closes: number }>();
  for (const file of sources()) {
    if (isTestTier(file) || !file.startsWith('packages/application/src/')) {
      continue;
    }
    const body = withoutComments(censusText(REPO_ROOT, file));
    const escalations = body.match(ESCALATE_CALL)?.length ?? 0;
    const closes = body.match(CLOSE_PARKED_CALL)?.length ?? 0;
    if (escalations > 0 || closes > 0) {
      found.set(file, { escalations, closes });
    }
  }
  return found;
};

describe('every escalation closes the parked stage’s row (WP-46, backlog 160)', () => {
  it('matches each `escalateTask` with a `closeParkedStageRow`, file by file', () => {
    const census = escalationCensus();
    const unmatched = [...census]
      .filter(([file]) => !ROW_CLOSED_BY_ITS_OWN_WRITE.has(file))
      .filter(([, counts]) => counts.escalations !== counts.closes)
      .map(
        ([file, counts]) => `${file}: ${counts.escalations} escalations, ${counts.closes} closes`,
      );
    expect(unmatched).toEqual([]);
  });

  it('finds the escalations it claims to, so a vacuous census cannot pass', () => {
    // Calibrate the instrument (standing rule 21): the modules backlog 160 named, plus the saga's
    // own six, are all in the census with a close for each escalation.
    const census = escalationCensus();
    // `applyEscalation`'s `escalateTask` and `resumeAtStage`'s `resumeStage` (backlog 495).
    expect(census.get('packages/application/src/pipeline/transitions.ts')).toEqual({
      escalations: 2,
      closes: 2,
    });
    expect(census.get('packages/application/src/pipeline/saga.ts')).toEqual({
      escalations: 6,
      closes: 6,
    });
    for (const file of ROW_CLOSED_BY_ITS_OWN_WRITE.keys()) {
      expect(census.get(file)?.escalations, file).toBeGreaterThan(0);
    }
  });
});

/**
 * **Every other ending of an attempt closes its row too** — the sibling of the escalation census
 * (WP-46 review round 1, PROGRESS backlog 212). An attempt also ends when a stage is entered (a new
 * attempt of it, or another stage), when the task completes and when it is cancelled; each of
 * those sites — `.recordStageEntered(`, `completeTask(`, `cancelTask(` in a production module — is
 * matched one for one by a `closeCurrentStageRow(` in the same module. Round 1 had none of them,
 * and a take-over handed back at `ci_gate` left attempt 1 `running` for ever. Same syntactic limits
 * as the census above; the behaviour per site is asserted in `saga.test.ts`.
 */
const ENDING_CALL = /\.recordStageEntered\s*\(|\bcompleteTask\s*\(|\bcancelTask\s*\(/g;
const CLOSE_CURRENT_CALL = /\bcloseCurrentStageRow\s*\(/g;

describe('every entry, completion and cancellation closes the attempt it ends (WP-46, backlog 212)', () => {
  const census = (): Map<string, { endings: number; closes: number }> => {
    const found = new Map<string, { endings: number; closes: number }>();
    for (const file of sources()) {
      if (isTestTier(file) || !file.startsWith('packages/application/src/')) {
        continue;
      }
      const body = withoutComments(censusText(REPO_ROOT, file));
      const endings = body.match(ENDING_CALL)?.length ?? 0;
      const closes = body.match(CLOSE_CURRENT_CALL)?.length ?? 0;
      if (endings > 0 || closes > 0) {
        found.set(file, { endings, closes });
      }
    }
    return found;
  };

  it('matches each ending with a `closeCurrentStageRow`, file by file', () => {
    const unmatched = [...census()]
      .filter(([, counts]) => counts.endings !== counts.closes)
      .map(([file, counts]) => `${file}: ${counts.endings} endings, ${counts.closes} closes`);
    expect(unmatched).toEqual([]);
  });

  it('finds the endings it claims to, so a vacuous census cannot pass', () => {
    // Two entries (`enter` and `resumeAtStage`, backlog 495) and two completions in the
    // transitions, one cancellation in the commands.
    expect(census().get('packages/application/src/pipeline/transitions.ts')).toEqual({
      endings: 4,
      closes: 4,
    });
    expect(census().get('packages/application/src/pipeline/commands.ts')).toEqual({
      endings: 1,
      closes: 1,
    });
  });
});

/**
 * **Every entry into a stage opens that attempt's row** — the census the two above did not have,
 * and whose absence is PROGRESS backlog 495. The domain enters a stage through two commands,
 * `enterStage(` and `resumeStage(` (a wait ending back into the stage it was at); each call in a
 * production module is matched one for one by a `.recordStageEntered(` in the same module. Until
 * backlog 495 the saga called `resumeStage` for an answered question and a rejected plan and wrote
 * no row, so the attempt it entered was run with `runs.task_stage_id` null and a rejected plan's
 * reason never reached the architect — the product owner inserted the row by hand. Same syntactic
 * limits as the censuses above; the behaviour is asserted in `saga.test.ts` (`plan approval`,
 * `questions`).
 */
const ENTRY_CALL = /\benterStage\s*\(|\bresumeStage\s*\(/g;
const ROW_OPENED_CALL = /\.recordStageEntered\s*\(/g;

describe('every stage entry opens its attempt’s row (PROGRESS backlog 495)', () => {
  const census = (): Map<string, { entries: number; opens: number }> => {
    const found = new Map<string, { entries: number; opens: number }>();
    for (const file of sources()) {
      if (isTestTier(file) || !file.startsWith('packages/application/src/')) {
        continue;
      }
      const body = withoutComments(censusText(REPO_ROOT, file));
      const entries = body.match(ENTRY_CALL)?.length ?? 0;
      const opens = body.match(ROW_OPENED_CALL)?.length ?? 0;
      if (entries > 0 || opens > 0) {
        found.set(file, { entries, opens });
      }
    }
    return found;
  };

  it('matches each `enterStage`/`resumeStage` with a `.recordStageEntered`, file by file', () => {
    const unmatched = [...census()]
      .filter(([, counts]) => counts.entries !== counts.opens)
      .map(([file, counts]) => `${file}: ${counts.entries} entries, ${counts.opens} row opens`);
    expect(unmatched).toEqual([]);
  });

  it('finds the entries it claims to, so a vacuous census cannot pass', () => {
    // `enter`'s `enterStage` and `resumeAtStage`'s `resumeStage`, and nowhere else.
    expect(census().get('packages/application/src/pipeline/transitions.ts')).toEqual({
      entries: 2,
      opens: 2,
    });
    expect(census().get('packages/application/src/pipeline/saga.ts')).toBeUndefined();
  });
});
