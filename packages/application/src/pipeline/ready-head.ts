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
 *    gate settlement made) → `ready_for_merge`, with `task.resumed` when the task was paused, and no
 *    gate. This is also the head recorded for the new entry, so a second pause keeps the judgement;
 *  - **anything else** → re-enter `ci_gate`. *Anything else* is a different head, a task with no
 *    recorded head (a row older than migration 0056, or a Ready entered by a template whose gates
 *    are disabled), **and a head the platform could not read** — a provider that refused, a binding
 *    that would not load, a project with no git binding, a task with no merge request. An unreadable
 *    head is not an unmoved one (standing rule 20: fail closed on a mutation), and the gate it
 *    re-enters has its own bounded answer for a provider that stays down (`MAX_GATE_CHECKS`, then
 *    `needs_human`), so failing closed here costs a gate evaluation rather than a stuck task.
 *
 * ## The edge it adds, and which loop it spends (standing rule 81)
 *
 * **None.** Re-entering `ci_gate` from a stop at Ready is a **forward move**: the duty applies an
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
 * ## What failing closed costs on a template with its gates disabled
 *
 * A Ready reached by **falling through** from an agent or system stage — a project that disabled
 * `rebase_gate` (and so nothing settled a gate on the way in) — records `ready_head_sha` as `null`,
 * because no gate judged a head. Every later resume, retry or hand-back of that task at Ready then
 * reads `null` as *judge again* and re-enters `ci_gate` (or `rebase_gate`, whichever is enabled),
 * so the human pays a CI read and a fresh review round each time, even for an untouched branch.
 * That is the price of rule 20 here, and it is accepted: the alternative is to trust a head nobody
 * judged. Only a template that disables **both** gates skips it, by entering Ready directly.
 *
 * ## What it does not close
 *
 * The wake-up is **at most once**, like every `afterCommit` enqueue: a process that dies between
 * the command's commit and the enqueue leaves the task where the command found it — paused, or at
 * its stage — with the hand-back's event written. Nothing is moved past a gate by that loss; the
 * human presses the button again. A default branch that moved while the task was paused at Ready is
 * **not** this duty's question: it compares the task's own branch head, and the rebase gate's
 * re-check on `default_branch.moved` is only taken while the task is at Ready (filed in PROGRESS
 * under WP-79's discovered work).
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

/** The first gate a human's new commits re-enter: `ci_gate`, else `rebase_gate`, else none. */
export const gateToReenter = (pipeline: CompiledPipeline): Slug | null => {
  for (const id of [CI_GATE_STAGE, REBASE_GATE_STAGE]) {
    const stage = stageOf(pipeline, id);
    if (stage?.enabled === true && stage.kind === 'gate') {
      return id;
    }
  }
  return null;
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
      const gate = verdict.kind === 'judge_again' ? gateToReenter(pipeline) : null;
      const decision: PipelineDecision = {
        kind: 'enter',
        stage: gate ?? READY_FOR_MERGE_STAGE,
      };
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
        ...(verdict.kind === 'ready' ? { readyHeadSha: verdict.sha } : {}),
        ...(gate === null || verdict.kind !== 'judge_again'
          ? {}
          : { resumeReason: verdict.reason }),
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
    outcome.verdict.kind === 'ready'
      ? 'the branch head is the one the gates judged; the task waits at ready_for_merge'
      : outcome.gate === null
        ? 'the template runs no gate to re-enter; the task waits at ready_for_merge'
        : `${outcome.verdict.reason}: re-entering ${outcome.gate}, which spends no iteration loop`,
  );
  if (outcome.work !== null) {
    await enqueueStage(options.jobs, outcome.work);
  }
};
