/**
 * **The reverse sync: a ticket a person finished — or took — stops its task** (M28 ruling 4,
 * TD-029 amendment B decision 3, S-28.5).
 *
 * S-28.4 bounds where a task **starts** (intake, the claim). This module bounds where it keeps
 * going: when a live task's ticket moves to a status that means a person finished it (`closed`, or
 * the Done category), or into a working status the platform did not put it in (`hands_off`), the
 * task stops — a **queued** task is cancelled (`ticket_closed_in_tracker` /
 * `ticket_taken_by_person`), any other live one has its offer closed and its run stopped the way an
 * escalation does (`applyDecision`, which closes the stage offer first — TD-031 decision 13) and
 * waits in `needs_human` with a brief that says who moved the ticket, when, and what to do. A task
 * that may have an open merge request is never cancelled by the platform. The table is the domain's
 * `ticketStatusStopDecision`.
 *
 * ## Never for the platform's own moves
 *
 * The policy the decision reads is the binding's status policy **with the legacy `status_mapping`
 * targets added** when no lifecycle slot is mapped (`withStatusMappingStatuses`), and the disposition
 * is asked with `platformHolds: true` — so a lifecycle slot (a `done` slot of *Ready for Merge*
 * included), a `returned` status, or a `status_mapping` target is never a reason to stop. A task at
 * a human stage (`qa`, `ready_for_merge`, `merged_gate`) or past the merge is never stopped: a person
 * is working its ticket there, and a merge may move it to Done before `mr.merged` arrives.
 *
 * ## The shape
 *
 * A **handler** on `ticket.status.changed` and on a `ticket.updated` that may name the status
 * (polled edits carry no field names) decides only that a live task's ticket should be re-read, and
 * enqueues the `pipeline.outbound` duty **`ticket_status_recheck`** after the commit. The **duty**
 * re-validates on fire (TD-004), reads the ticket once through `IntegrationActionExecutor`
 * (`readTicketForTask`, outside every transaction), decides, and applies the decision in one task
 * transaction that re-loads the task. A ticket it cannot read stops nothing. The one-off **sweep**
 * (`recovery/ticket-status-sweep.ts`) enqueues the same duty for every live task once.
 */
import {
  type DomainEvent,
  type Id,
  type IsoDateTime,
  lifecycleStatusKey,
} from '@platform/contracts';
import {
  amendEscalation,
  cancelTask,
  compilePipeline,
  isMergedTask,
  isTerminalTaskState,
  MERGED_GATE_STAGE,
  QA_STAGE_ID,
  READY_FOR_MERGE_STAGE,
  type TicketStatusStop,
  type TicketStatusStopReason,
  ticketStatusDisposition,
  ticketStatusStopDecision,
  withStatusMappingStatuses,
} from '@platform/domain';
import type { EventHandler } from '../events/handler.js';
import { TransactionOpenError } from '../events/open-transaction.js';
import { JOB_QUEUES, type Jobs } from '../ports/jobs.js';
import { silentLogger } from '../ports/logger.js';
import type { TransactionScope } from '../ports/unit-of-work.js';
import { gitReads, integrationsForProject, noRunScopedSecrets } from './integrations.js';
import type { OutboundJobData, PipelineOutboundData } from './jobs.js';
import { closeStageOffer } from './offer-withdrawal.js';
import { PIPELINE_ACTOR, type PipelineStore, type StoredTask } from './store.js';
import { inTaskTransaction, type TaskTransactionOptions } from './task-transaction.js';
import { readTicketForTask } from './ticket-snapshot.js';
import { applyDecision, CANCELLED_OUTCOME, closeCurrentStageRow } from './transitions.js';

/** The handler's registered name. */
export const TICKET_STATUS_RECHECK_HANDLER = 'pipeline.ticket.status.recheck';

/** The stages at which a person works the ticket, so the reverse sync never stops a task there. */
const HUMAN_STAGES: readonly string[] = [QA_STAGE_ID, READY_FOR_MERGE_STAGE, MERGED_GATE_STAGE];

/** The longest moved-by name the duty carries (a display name, redacted at ingress). */
const MAX_MOVED_BY_CHARS = 128;

/**
 * Whether a `ticket.updated` may have moved the status: its changed fields name it, or say nothing
 * (empty or truncated) — the rule the human-return handler reads (`saga.ts`'s `mayNameTheStatus`).
 */
const mayNameTheStatus = (payload: {
  readonly changed_fields: readonly string[];
  readonly truncated: boolean;
}): boolean =>
  payload.truncated ||
  payload.changed_fields.length === 0 ||
  payload.changed_fields.some((field) => field.trim().toLowerCase() === 'status');

/** Who moved the ticket, as the delivery named them — a display name, or `null`. */
const movedByOf = (event: DomainEvent): string | null => {
  const actor = event.actor;
  if (actor.kind !== 'integration') {
    return null;
  }
  const name = actor.identity?.display_name ?? null;
  return name === null || name.trim().length === 0 ? null : name.slice(0, MAX_MOVED_BY_CHARS);
};

/**
 * `ticket.status.changed` / `ticket.updated` → the `ticket_status_recheck` duty for the ticket's live
 * task. Priority **120**, the integrations band: it enqueues after the commit and reads nothing else.
 */
export const ticketStatusRecheckHandler = (options: {
  readonly store: PipelineStore;
  readonly jobs: Jobs;
}): EventHandler => ({
  name: TICKET_STATUS_RECHECK_HANDLER,
  priority: 120,
  eventTypes: ['ticket.status.changed', 'ticket.updated'],
  handle: async (context) => {
    const event = context.event.event;
    if (event.type !== 'ticket.status.changed' && event.type !== 'ticket.updated') {
      return;
    }
    if (event.type === 'ticket.updated' && !mayNameTheStatus(event.payload)) {
      return;
    }
    const stored = await options.store.tasks.findByTicketSignal(context.scope.tx, {
      projectId: event.payload.project_id,
      provider: event.payload.ticket.provider,
      ticketKey: event.payload.ticket.key,
      ticketId: event.payload.ticket.id ?? null,
      mode: 'normal',
    });
    if (stored === null || isTerminalTaskState(stored.task.state)) {
      return;
    }
    const movedBy = movedByOf(event);
    const data: PipelineOutboundData = {
      duty: 'ticket_status_recheck',
      project_id: event.payload.project_id,
      task_id: stored.task.id,
      cause_event_id: event.id,
      // A status change is a move a person made now; a polled edit may be nothing of the kind.
      status_moved: event.type === 'ticket.status.changed',
      moved_at: event.occurred_at,
      ...(movedBy === null ? {} : { moved_by: movedBy }),
    };
    context.afterCommit(async () => {
      await options.jobs.enqueue<OutboundJobData>({ queue: JOB_QUEUES.pipelineOutbound, data });
    });
  },
});

/** The handlers this module registers (`createPipelineRuntime`). */
export const ticketStatusRecheckHandlers = (options: {
  readonly store: PipelineStore;
  readonly jobs: Jobs;
}): readonly EventHandler[] => [ticketStatusRecheckHandler(options)];

/** The tracker's word, for the brief: Jira, GitLab, or *the tracker*. */
const trackerWord = (provider: string): string =>
  provider.startsWith('jira') ? 'Jira' : provider.startsWith('gitlab') ? 'GitLab' : 'the tracker';

/**
 * The brief a stopped task carries — platform text around the ticket's key, the status name (the
 * redacted, bounded read) and, when the delivery named one, who moved it and when (M28 ruling 4's
 * wording). It says what happened, why, and the two ways out.
 */
export const ticketStatusStopBrief = (input: {
  readonly key: string;
  readonly provider: string;
  readonly status: string;
  readonly reason: TicketStatusStopReason;
  readonly movedBy: string | null;
  readonly movedAt: string | null;
}): string => {
  const by = input.movedBy === null ? '' : ` by ${input.movedBy}`;
  const on = input.movedAt === null ? '' : ` on ${input.movedAt.slice(0, 10)}`;
  const where = trackerWord(input.provider);
  return input.reason === 'ticket_closed_in_tracker'
    ? `${input.key} was moved to "${input.status}" in ${where}${by}${on}, a status that means it is finished; the platform stopped working on it. Cancel the task, or move the ticket back to continue.`
    : `${input.key} was moved to "${input.status}" in ${where}${by}${on}, a status the platform did not set — a person seems to be working on it, so the platform stopped. Agree who takes it: cancel the task, or move the ticket back to a status work starts from and give it back to the agent.`;
};

/**
 * `pipeline.outbound` duty **ticket_status_recheck** — see the module docblock. Re-validates on
 * fire: the task exists, is live, and the project has a status policy; then one read, then one
 * transaction that re-loads the task and decides again on what it holds.
 */
export const runTicketStatusRecheck = async (
  options: TaskTransactionOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  if (data.task_id === undefined) {
    return;
  }
  const logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id;
  const loaded = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.load(scope.tx, taskId),
  );
  if (loaded === null || isTerminalTaskState(loaded.task.state)) {
    return;
  }
  const settings = await options.settings.forProject(loaded.task.projectId);
  const base = settings.ticketStatusPolicy ?? null;
  // A configuration that cannot be read hides `status_mapping`, so the platform's own mapped
  // statuses could read as a person's move: stop nothing until it parses (WP-106's rule).
  if (base === null || settings.configRefusal !== undefined) {
    return;
  }
  // The platform's own statuses: the slots, `returned`, and — no slot mapped — `status_mapping`.
  const policy = withStatusMappingStatuses(
    base,
    settings.ticketLifecycle?.slots,
    settings.config.status_mapping,
  );
  const read = await readTicketForTask(options, {
    projectId: loaded.task.projectId,
    taskId,
    ticket: loaded.task.ticket,
  });
  if (read === null) {
    // A ticket the platform cannot read stops nothing; the next signal or pass asks again.
    return;
  }
  const disposition = ticketStatusDisposition(read.status, read.statusCategory, policy, true);
  if (disposition !== 'closed' && disposition !== 'hands_off') {
    return;
  }
  /**
   * **A merge request merged by hand closed the ticket** (S-28.5 review ruling 4): a task back at a
   * gate whose merge request a person merged gets its ticket moved to Done before `mr.merged`
   * arrives, and `needs_human` has no edge to `merged`. So before a `closed` stop the merge request
   * is read (outside every transaction, through the executor); merged means the task's own delivery
   * closed the ticket and the merge path owns the ending. A read that fails stops nothing.
   */
  if (disposition === 'closed' && loaded.mr !== null && !isMergedTask(loaded.task)) {
    let mergedByHand = true;
    try {
      const integrations = await integrationsForProject(
        options.integrations,
        loaded.task.projectId,
        noRunScopedSecrets(),
      );
      const live = await gitReads(integrations).mergeRequest(loaded.mr, {
        projectId: loaded.task.projectId,
        taskId,
      });
      mergedByHand = live?.state === 'merged';
    } catch (error) {
      if (error instanceof TransactionOpenError) {
        throw error;
      }
      logger.warn(
        { task_id: taskId, err: error },
        'the merge request could not be read, so a finished ticket does not stop its task now; the next signal asks again',
      );
    }
    if (mergedByHand) {
      return;
    }
  }
  const mayAmend = data.status_moved === true || data.ticket_status_sweep === true;
  const outcome = await inTaskTransaction(
    options,
    taskId,
    'stopping a task whose ticket moved',
    async (scope) => {
      const stored = await options.store.tasks.load(scope.tx, taskId);
      if (stored === null) {
        return null;
      }
      /**
       * **A stop acts once per status** (S-28.5 review finding 3): a wake-up that is not a status
       * change — a polled edit (`changed_fields: []`, the platform's own comment echo included) or
       * the sweep — stops the task again only when the status differs from the one its last stop
       * acted on, so a person who resumed it while the ticket stays closed is not stopped by every
       * later edit. A `ticket.status.changed` is a move and decides afresh.
       */
      if (data.status_moved !== true) {
        const actedOn = await options.store.tasks.ticketStatusStopOf(scope.tx, taskId);
        if (actedOn !== null && lifecycleStatusKey(actedOn) === lifecycleStatusKey(read.status)) {
          return { kind: 'none' } as const;
        }
      }
      const decision = ticketStatusStopDecision({
        state: stored.task.state,
        merged: isMergedTask(stored.task),
        humanStage: HUMAN_STAGES.includes(stored.task.currentStage ?? ''),
        disposition,
        onTicketClosed: policy.onTicketClosed,
        mayAmend,
      });
      if (decision.kind === 'none') {
        return decision;
      }
      const brief = ticketStatusStopBrief({
        key: stored.task.ticket.key,
        provider: stored.task.ticket.provider,
        status: read.status,
        reason: decision.reason,
        movedBy: data.moved_by ?? null,
        movedAt: data.moved_at ?? null,
      });
      await applyStop(options, scope, stored, decision, brief);
      await options.store.tasks.recordTicketStatusStop(
        scope.tx,
        taskId,
        read.status,
        options.clock.now() as IsoDateTime,
      );
      return decision;
    },
  );
  if (outcome !== null && outcome.kind !== 'none') {
    logger.info(
      { task_id: taskId, status: read.status, decision: outcome.kind, reason: outcome.reason },
      'the ticket moved to a status that stops its task; the task was stopped',
    );
  }
};

const contextOf = (options: TaskTransactionOptions, taskId: Id) => ({
  ids: options.ids,
  actor: PIPELINE_ACTOR,
  clock: options.clock as never,
  correlationId: taskId,
  causeEventId: null,
});

/** One decision, applied in the caller's task transaction. */
const applyStop = async (
  options: TaskTransactionOptions,
  scope: TransactionScope,
  stored: StoredTask,
  decision: Exclude<TicketStatusStop, { readonly kind: 'none' }>,
  brief: string,
): Promise<void> => {
  const context = contextOf(options, stored.task.id);
  if (decision.kind === 'amend') {
    const amended = amendEscalation(
      stored.task,
      { reason: decision.reason, blockerBrief: brief },
      context,
    );
    await options.store.tasks.save(scope.tx, { ...stored, task: amended.aggregate });
    await scope.events.append(amended.events);
    return;
  }
  if (decision.kind === 'escalate') {
    const applied = await applyDecision({
      offerClosing: { events: scope.events, broadcast: scope.broadcast },
      store: options.store,
      pipeline: compilePipeline(
        stored.task.template,
        stored.template,
        stored.pipelineDial,
        stored.qaStage,
      ),
      tx: scope.tx,
      stored,
      decision: { kind: 'escalate', reason: decision.reason, blockerBrief: brief },
      escalationOutcome: decision.reason,
      context,
      causedByEventId: null,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    await scope.events.append(applied.events);
    return;
  }
  // `cancel`: a queued task — it never ran, so it has no offer, no run and no merge request.
  const totals = await options.store.runs.totalsFor(scope.tx, stored.task.id);
  const cancelled = cancelTask(
    stored.task,
    {
      outcome: decision.reason,
      totals: {
        cost_usd: totals.costUsd,
        is_estimate: totals.isEstimate,
        unmeasured_runs: totals.unmeasuredRuns,
        runs: totals.runs,
        wall_ms: totals.wallMs,
      },
    },
    context,
  );
  const closing = await closeStageOffer(options, scope, {
    taskId: stored.task.id,
    code: 'stage_left',
    reason: `the task was cancelled: ${decision.reason}`,
    context,
  });
  await options.store.tasks.save(scope.tx, { ...stored, task: cancelled.aggregate });
  await closeCurrentStageRow(options.store, scope.tx, stored.task, CANCELLED_OUTCOME, brief);
  await scope.events.append([...closing.events, ...cancelled.events]);
};
