/**
 * `pipeline.outbound` duty **ready_head_check** — a human's way into `ready_for_merge` is judged
 * by the branch head, not by the edge (WP-79, PROGRESS backlog 267).
 *
 * ## What was wrong
 *
 * WP-73a made a pause at Ready resumable (`paused → ready_for_merge`, backlog 244), and a take-over
 * at Ready **is** a pause at Ready. So a human who took over, pushed to the branch and handed back
 * to `ready_for_merge` — or simply resumed — put commits at Ready that neither `ci_gate` nor
 * `rebase_gate` had read. A hand-back into `ready_for_merge` from an `active` task was the same
 * door opened wider: `active → ready_for_merge` is an edge, so it skipped both gates outright.
 *
 * ## The shape (the ruling on 267, and why it is a duty)
 *
 * **No human command moves a task into Ready itself.** Every stage entry a command makes goes
 * through one function, `humanEnter` (`commands.ts`) — resume, retry-stage, retry-run and
 * hand-back; retry-stage at a pause at Ready was a third way in until WP-79's review round 1 — and
 * the command-side apply refuses a Ready entry that bypassed it (`human-commands.test.ts` holds the
 * one-entry census). `return-to-stage` and `rework` aimed at Ready are refused by the state machine.
 * For Ready, `humanEnter` validates the move against the aggregate (a dry run of
 * `markReadyForMerge`, so the 409s are the ones it always gave), writes nothing — the hand-back
 * has already appended its `task.handed_back` — and enqueues this duty after the commit. The only
 * other ways into Ready are the pipeline's own: a passing rebase-gate settlement — which, since
 * review round 2 (backlog 275), enters Ready only when its head is the one the CI gate passed
 * (`tasks.ci_head_sha`, `rebaseAgainstCi` in `gates.ts`) and otherwise re-enters `ci_gate` as a
 * forward move bounded by `rebase_rechecks`, so a hand-back at `code_review` or `rebase_gate` after
 * a push cannot reach Ready past CI either, and since WP-102 reads the Code review's confirmation of
 * the protected paths CI excused provisionally before it enters (`tamper-confirmation.ts`) — and a
 * fall-through into Ready from an agent or system stage (below). The duty then:
 *
 *  1. re-reads the task and **re-validates** it (TD-004): it acts only while the task is still in
 *     the state, and at the stage, the command saw — a cancel, a merge on the provider, or a second
 *     resume that got there first each leave it nothing to do, and it logs that it did nothing;
 *  2. reads the merge request's **live** head, **outside every transaction** (WP-15d:
 *     `integrationsForProject` and the executor refuse inside one), through the project's git
 *     binding and `IntegrationActionExecutor` like every other provider read;
 *  3. in a transaction of its own, re-validates again and applies one decision.
 *
 * The decision is {@link readyHeadVerdict}, and it has two answers:
 *
 *  - **the head the gates judged** (`tasks.ready_head_sha`, written by the Ready entry that the
 *    gate settlement made) → re-enter **`rebase_gate`** (WP-105, {@link readyEntryFor}), with
 *    `task.resumed` when the task was paused. Until WP-105 this answer entered Ready directly with
 *    no gate, which trusted two judgements the head cannot vouch for: the target branch may have
 *    moved while the task was stopped (`defaultBranchHandler` re-checks only a task whose state is
 *    `ready_for_merge`, so a paused one dropped the move — PROGRESS backlog 274, ruled option (c)),
 *    and a round that returned out of Ready and pushed nothing may have changed the plan or written
 *    new Implementation Notes, which invalidates the Code review's confirmation of the protected
 *    paths CI excused without moving the head (backlog 337). The rebase gate's settlement answers
 *    both: one mergeability read, WP-26's conflict warning on its entry, WP-102's confirmation in
 *    its transaction, and Ready only for the head CI passed. A template that does not run
 *    `rebase_gate` — which since WP-120 runs no `ci_gate` either, so nothing excused a path —
 *    still enters Ready directly and records the head;
 *  - **anything else** → re-enter `ci_gate`. *Anything else* is a different head, a task with no
 *    recorded head (a row older than migration 0056, or a Ready entered by a template whose gates
 *    are disabled), **and a head the platform could not read** — a provider that refused, a binding
 *    that would not load, a project with no git binding, a task with no merge request. An unreadable
 *    head is not an unmoved one (standing rule 20: fail closed on a mutation), and the gate it
 *    re-enters has its own bounded answer for a provider that stays down (`MAX_GATE_CHECKS` — or
 *    the CI timeout on a poll-only binding, WP-136 — then `needs_human`), so failing closed here
 *    costs a gate evaluation rather than a stuck task.
 *
 * ## The edge it adds, and which loop it spends (standing rule 81)
 *
 * **None.** Re-entering `ci_gate` or `rebase_gate` from a stop at Ready is a **forward move**: the duty applies an
 * `enter` decision rather than interpreting a signal, because the interpreter's rule 2 would read a
 * target earlier than `ready_for_merge` as a return and charge it to a loop — and a human's push is
 * not a failure of any loop BD-008 bounds. So no iteration counter moves, and the template's own
 * fall-through (`ci_gate → code_review → business_review → rebase_gate → ready_for_merge` on the
 * shipped templates) carries the human's commits through review and the rebase gate again. The
 * state machine needs no new edge either: from `paused` the entry is `paused → active`, and from an
 * `active` task handed back it is `active → active`.
 *
 * Which gate: {@link gateToReenter} — `ci_gate` when the task's template runs it, else
 * `rebase_gate`, else none. A template that enables neither judges no head at its front door, so
 * its side door enters Ready as it always did.
 *
 * ## A template with its gates disabled
 *
 * A Ready reached by **falling through** from an agent or system stage happens only on a template
 * that does not run `rebase_gate`, and since WP-120 (PROGRESS backlog 338, ruled option (a)) such a
 * template runs no `ci_gate` either: `assertValidTemplate` refuses `rebase_gate` disabled, missing
 * or declared before an enabled `ci_gate`, naming both stages, because the rebase settlement is the
 * only reader of the protected paths CI excused provisionally. So the fall-through records
 * `ready_head_sha` as `null` — no gate judged a head — and every later resume, retry or hand-back
 * reads `null` as *judge again*, finds no gate to re-enter ({@link gateToReenter} is none) and
 * enters Ready directly, as such a template always did. Until WP-120 this paragraph priced a CI
 * read and a review round per resume on a template with `ci_gate` but no `rebase_gate`; that
 * template is no longer accepted.
 *
 * ## What it does not close
 *
 * The wake-up is **at most once**, like every `afterCommit` enqueue: a process that dies between
 * the command's commit and the enqueue leaves the task where the command found it — paused, or at
 * its stage — with the hand-back's event written. Nothing is moved past a gate by that loss; the
 * human presses the button again. A default branch that moved while the task was paused at Ready
 * **is** answered since WP-105, by the rebase gate every way back into Ready now passes through;
 * the duty itself still compares only the task's own branch head.
 *
 * ## Every way into Ready after WP-105, and why each is sound
 *
 *  1. **The rebase gate's settlement** — the judgement itself: a mergeability read, Ready only for
 *     the head CI passed (`rebaseAgainstCi`), and WP-102's confirmation read in its transaction.
 *  2. **This duty, for a human's resume, retry-stage, retry-run or hand-back** — through the rebase
 *     gate (1) on every template that runs it, whatever the head; directly only on a template that
 *     runs no rebase gate, where the head the gates judged is recorded again.
 *  3. **A fall-through from an agent or system stage** on a template that disabled `rebase_gate` —
 *     no gate judged anything, so it records `ready_head_sha` as `null`. Such a template runs no
 *     `ci_gate` either (WP-120: `assertValidTemplate` refuses the other shape, PROGRESS backlog
 *     338), so no CI pass excused a protected path, and every later way back in enters Ready
 *     directly (above). No shipped template produces it.
 *
 * `return-to-stage` and `rework` into Ready are refused by the state machine, and a human command
 * cannot enter Ready itself (`applyHumanDecisionRecorded`'s census) — so there is no fourth.
 */
import type { Id, Slug } from '@platform/contracts';
import {
  type CommandContext,
  type CompiledPipeline,
  compilePipeline,
  type PipelineDecision,
  READY_FOR_MERGE_STAGE,
  stageOf,
} from '@platform/domain';
import { TransactionOpenError } from '../events/open-transaction.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import { CI_GATE_STAGE } from './gates.js';
import { gitReads, integrationsForProject, noRunScopedSecrets } from './integrations.js';
import {
  enqueueStage,
  inTaskTransaction,
  type ReadyHeadCheckData,
  type TaskTransactionOptions,
} from './jobs.js';
import { REBASE_GATE_STAGE } from './rebase.js';
import type { StoredTask } from './store.js';
import { applyDecision } from './transitions.js';

/** What the live read found: a head, or the reason there is none. */
export type LiveHead =
  | { readonly kind: 'read'; readonly sha: string }
  | { readonly kind: 'unreadable'; readonly detail: string };

export type ReadyHeadVerdict =
  | { readonly kind: 'ready'; readonly sha: string }
  | { readonly kind: 'judge_again'; readonly reason: string };

/**
 * **The comparison**, and the whole of the fix: Ready only for the head the gates judged.
 *
 * Pure so both answers are unit-tested without a provider; `ready-head.test.ts` asserts each branch
 * and the saga cases in `human-commands.test.ts` drive it end to end.
 */
export const readyHeadVerdict = (recorded: string | null, live: LiveHead): ReadyHeadVerdict => {
  if (live.kind === 'unreadable') {
    return {
      kind: 'judge_again',
      reason: `the branch head could not be read (${live.detail}), so the platform's gates judge the branch again`,
    };
  }
  if (recorded === null) {
    return {
      kind: 'judge_again',
      reason:
        'no gate recorded the head this task entered ready_for_merge with, so the platform’s gates judge the branch again',
    };
  }
  if (live.sha !== recorded) {
    return {
      kind: 'judge_again',
      reason:
        'the branch head moved since the task entered ready_for_merge, so the platform’s gates judge the new commits',
    };
  }
  return { kind: 'ready', sha: live.sha };
};

/** Is `id` an enabled gate of this pipeline? */
const runsGate = (pipeline: CompiledPipeline, id: Slug): boolean => {
  const stage = stageOf(pipeline, id);
  return stage?.enabled === true && stage.kind === 'gate';
};

/** The first gate a human's new commits re-enter: `ci_gate`, else `rebase_gate`, else none. */
export const gateToReenter = (pipeline: CompiledPipeline): Slug | null => {
  for (const id of [CI_GATE_STAGE, REBASE_GATE_STAGE]) {
    if (runsGate(pipeline, id)) {
      return id;
    }
  }
  return null;
};

/**
 * The `task.resumed` reason when an unmoved head re-enters the rebase gate (WP-105) — platform text.
 */
export const REBASE_RECHECK_REASON =
  'the branch head is the one the gates judged, and the rebase gate judges it again against the target branch before ready_for_merge';

/**
 * **Where the duty sends the task** (WP-105, PROGRESS backlogs 274 and 337) — the verdict and the
 * template's gates, as one pure decision:
 *
 *  - a head to **judge again** → {@link gateToReenter} (`ci_gate`, else `rebase_gate`), or Ready on
 *    a template that runs neither;
 *  - the head **the gates judged** → `rebase_gate` when the template runs it — ruled option (c) on
 *    274: the target branch may have moved while the task was stopped, and the rebase gate's
 *    settlement is also where the Code review's confirmation of the protected paths CI excused is
 *    read (WP-102, `tamper-confirmation.ts`), so a round that changed the plan without pushing
 *    cannot reach Ready on a confirmation that no longer holds (337). The entry is a forward move,
 *    one mergeability read, and no loop;
 *  - the head the gates judged on a template that does **not** run `rebase_gate` → Ready, as
 *    before, with that head recorded — there is no gate to re-read, and since WP-120 such a
 *    template runs no `ci_gate` either (PROGRESS backlog 338, `assertValidTemplate`).
 */
export const readyEntryFor = (
  pipeline: CompiledPipeline,
  verdict: ReadyHeadVerdict,
): { readonly stage: Slug; readonly gate: boolean; readonly reason: string | null } => {
  if (verdict.kind === 'judge_again') {
    const gate = gateToReenter(pipeline);
    return gate === null
      ? { stage: READY_FOR_MERGE_STAGE, gate: false, reason: null }
      : { stage: gate, gate: true, reason: verdict.reason };
  }
  return runsGate(pipeline, REBASE_GATE_STAGE)
    ? { stage: REBASE_GATE_STAGE, gate: true, reason: REBASE_RECHECK_REASON }
    : { stage: READY_FOR_MERGE_STAGE, gate: false, reason: null };
};

/** Is the task still where the command left it? The duty's re-validation, asked twice. */
const stillAsRequested = (stored: StoredTask | null, data: ReadyHeadCheckData): boolean =>
  stored !== null &&
  stored.task.state === data.expected_state &&
  stored.task.currentStage === data.expected_stage;

/**
 * The merge request's live head, read outside every transaction.
 *
 * Every way there can be no head is an `unreadable`, never a throw — except the open-transaction
 * refusal, which is a programming error and escapes (the reason `ticket-snapshot.ts` gives).
 */
const readLiveHead = async (
  options: TaskTransactionOptions,
  stored: StoredTask,
): Promise<LiveHead> => {
  if (stored.mr === null) {
    return { kind: 'unreadable', detail: 'the task has no merge request' };
  }
  try {
    const bindings = await integrationsForProject(
      options.integrations,
      stored.task.projectId,
      noRunScopedSecrets(),
    );
    if (bindings.git === null) {
      return { kind: 'unreadable', detail: 'the project has no git binding' };
    }
    const live = await gitReads(bindings).mergeRequest(stored.mr, {
      projectId: stored.task.projectId,
      taskId: stored.task.id,
    });
    const sha = live?.ref.head_sha ?? null;
    return sha === null || sha.length === 0
      ? { kind: 'unreadable', detail: 'the merge request names no head commit' }
      : { kind: 'read', sha };
  } catch (error) {
    if (error instanceof TransactionOpenError) {
      throw error;
    }
    return {
      kind: 'unreadable',
      detail: `the provider did not answer: ${error instanceof Error ? error.name : 'error'}`,
    };
  }
};

/** The duty. See the module docblock for what it decides and why. */
export const runReadyHeadCheck = async (
  options: TaskTransactionOptions,
  data: ReadyHeadCheckData,
): Promise<void> => {
  const logger: Logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id;
  const loaded = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.load(scope.tx, taskId),
  );
  if (loaded === null || !stillAsRequested(loaded, data)) {
    logger.info(
      { task_id: taskId, via: data.via, expected_state: data.expected_state },
      'the task moved before its way into ready_for_merge was judged; nothing to do',
    );
    return;
  }

  const live = await readLiveHead(options, loaded);

  const outcome = await inTaskTransaction(
    options,
    taskId,
    'judging a human’s way into ready_for_merge',
    async (scope) => {
      const current = await options.store.tasks.load(scope.tx, taskId);
      if (current === null || !stillAsRequested(current, data)) {
        return null;
      }
      const pipeline = compilePipeline(
        current.task.template,
        current.template,
        current.pipelineDial,
      );
      const verdict = readyHeadVerdict(current.readyHeadSha, live);
      const entry = readyEntryFor(pipeline, verdict);
      const gate = entry.gate ? entry.stage : null;
      const decision: PipelineDecision = { kind: 'enter', stage: entry.stage };
      const context: CommandContext = {
        ids: options.ids,
        // The person who resumed or handed back, as their command would have recorded.
        actor: { kind: 'user', user_id: data.user_id as Id },
        clock: options.clock as CommandContext['clock'],
        correlationId: taskId,
        causeEventId: (data.cause_event_id ?? null) as Id | null,
      };
      const applied = await applyDecision({
        store: options.store,
        pipeline,
        tx: scope.tx,
        stored: current,
        decision,
        context,
        // A person caused this, not an event: `task_stages.caused_by_event_id` stays null, which is
        // how a human command's row is told apart.
        causedByEventId: null,
        // Recorded only by an entry into Ready itself; a gate's settlement records its own head.
        ...(verdict.kind === 'ready' && gate === null ? { readyHeadSha: verdict.sha } : {}),
        ...(entry.reason === null ? {} : { resumeReason: entry.reason }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
      await scope.events.append(applied.events);
      return { work: applied.work, verdict, gate };
    },
  );
  if (outcome === null) {
    return;
  }
  logger.info(
    {
      task_id: taskId,
      via: data.via,
      verdict: outcome.verdict.kind,
      entered: outcome.gate ?? READY_FOR_MERGE_STAGE,
      recorded_head: loaded.readyHeadSha,
      live_head: live.kind === 'read' ? live.sha : null,
    },
    outcome.gate === null
      ? outcome.verdict.kind === 'ready'
        ? 'the branch head is the one the gates judged and the template runs no rebase gate; the task waits at ready_for_merge'
        : 'the template runs no gate to re-enter; the task waits at ready_for_merge'
      : outcome.verdict.kind === 'ready'
        ? `${REBASE_RECHECK_REASON}: re-entering ${outcome.gate}, which spends no iteration loop`
        : `${outcome.verdict.reason}: re-entering ${outcome.gate}, which spends no iteration loop`,
  );
  if (outcome.work !== null) {
    await enqueueStage(options.jobs, outcome.work);
  }
};
