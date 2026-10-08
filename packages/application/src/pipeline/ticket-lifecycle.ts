/**
 * **The ticket lifecycle's moments and the release** — BD-031 rulings 2 and 5, TD-029 decisions 3,
 * 4 and 5 (WP-177).
 *
 * Two handlers decide and two `pipeline.outbound` duties call (WP-15d's shape):
 *
 * - `pipeline.ticket.lifecycle` (TD-005 priority **110**, beside `statusMappingHandler`) reads a
 *   task's `task.stage.entered` / `task.stage.completed` against the moment table
 *   (`lifecycleMomentFor`, `packages/domain/src/lifecycle/moments.ts`) and, when the project's
 *   binding maps the slot the moment names, enqueues the `ticket_lifecycle` duty with that status.
 *   An **unmapped slot enqueues nothing and makes no call**, and the stage runs regardless
 *   (decision 4). The status is decided here rather than when the job fires, for the status
 *   mapping's reason: a transition is a movement, and a task that moved twice owes the board both
 *   moves in order.
 * - `pipeline.ticket.release` (110) reads `task.cancelled` and enqueues `ticket_release` for a task
 *   that holds a claim. A person's *Rework* enqueued the same duty from its command until WP-178;
 *   since then it marks the claim stale (`stale_cause: 'rework'`) and the reworked task's next agent
 *   admission performs the release before it claims (`ticket-release.ts`, PROGRESS backlog 541).
 *
 * **One writer per moment** (decision 3): when the binding maps any slot other than `pick_up_from`,
 * `statusMappingHandler` returns before it decides anything, so the two never race on one ticket.
 * With nothing mapped this module enqueues nothing and the status mapping applies exactly as before.
 *
 * **On a claiming binding the duty moves only a ticket the task holds** (`ticketClaimHeld`): before
 * the claim — or after a refused one — the ticket may be somebody else's, and the claim writes its
 * own `in_progress`. A binding whose block sets `claim: false` moves the ticket without a claim.
 *
 * **A failed write does not block anything** (decision 4): the executor leaves its audit row, the
 * duty logs a `warn` naming the slot, and the next moment moves the ticket on — `JOB_EXHAUSTION`'s
 * `notification_shaped` row.
 */
import type { Id } from '@platform/contracts';
import {
  compilePipeline,
  type LifecycleSignal,
  lifecycleClaims,
  lifecycleMapsAnySlot,
  lifecycleMomentFor,
  ticketClaimHeld,
} from '@platform/domain';
import type { EventHandler } from '../events/handler.js';
import { TransactionOpenError } from '../events/open-transaction.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import {
  integrationsForProject,
  namesAProviderTicket,
  noRunScopedSecrets,
  ticketWrites,
} from './integrations.js';
import { enqueueOutbound, type PipelineOutboundData, type TaskTransactionOptions } from './jobs.js';
import type { PipelineSagaOptions } from './saga.js';
import { releaseTicket } from './ticket-release.js';

/** The handler that decides a lifecycle moment (TD-005 integrations band, beside the mapping). */
export const TICKET_LIFECYCLE_HANDLER = 'pipeline.ticket.lifecycle';
/** The handler that asks for a release on cancellation. */
export const TICKET_RELEASE_HANDLER = 'pipeline.ticket.release';

interface TaskEventPayload {
  readonly task_id?: Id;
  readonly project_id?: Id;
  readonly stage?: string;
  readonly verdict?: string | null;
}

/** The moment a stage event is, or `null` for an event of another type. */
const signalOf = (type: string, payload: TaskEventPayload): LifecycleSignal | null => {
  if (payload.stage === undefined) {
    return null;
  }
  if (type === 'task.stage.entered') {
    return { kind: 'stage_entered', stage: payload.stage };
  }
  if (type === 'task.stage.completed') {
    return { kind: 'stage_completed', stage: payload.stage, verdict: payload.verdict ?? null };
  }
  return null;
};

export const ticketLifecycleHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: TICKET_LIFECYCLE_HANDLER,
  priority: 110,
  eventTypes: ['task.stage.entered', 'task.stage.completed'],
  handle: async (context) => {
    const logger = options.logger ?? silentLogger;
    const event = context.event.event;
    const payload = event.payload as TaskEventPayload;
    const signal = signalOf(event.type, payload);
    if (signal === null || payload.task_id === undefined || payload.project_id === undefined) {
      return;
    }
    const stored = await options.store.tasks.load(context.scope.tx, payload.task_id);
    if (stored === null || !namesAProviderTicket(stored.task.ticket)) {
      return;
    }
    const settings = await options.settings.forProject(stored.task.projectId, context.scope.tx);
    const lifecycle = settings.ticketLifecycle;
    if (lifecycle === null || !lifecycleMapsAnySlot(lifecycle.slots)) {
      return;
    }
    const slot = lifecycleMomentFor(
      signal,
      compilePipeline(stored.task.template, stored.template, stored.pipelineDial, stored.qaStage),
    );
    if (slot === null) {
      return;
    }
    const status = lifecycle.slots[slot];
    if (status === undefined) {
      logger.debug(
        { task_id: stored.task.id, slot, stage: signal.stage },
        'the lifecycle slot this moment names is not mapped; the ticket is left where it is',
      );
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'ticket_lifecycle',
      project_id: stored.task.projectId,
      task_id: stored.task.id,
      cause_event_id: event.id,
      status,
      lifecycle_slot: slot,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/**
 * `task.cancelled` → give the ticket back, when the task holds a claim (TD-029 decision 5). A task
 * that never claimed, or whose claim was already released, enqueues nothing.
 */
export const ticketReleaseHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: TICKET_RELEASE_HANDLER,
  priority: 110,
  eventTypes: ['task.cancelled'],
  handle: async (context) => {
    const event = context.event.event;
    if (event.type !== 'task.cancelled') {
      return;
    }
    const taskId = event.payload.task_id;
    const claim = await options.store.tasks.ticketClaim(context.scope.tx, taskId);
    if (claim === null || claim.released_at !== null) {
      return;
    }
    const data = releaseRequest({
      projectId: event.payload.project_id,
      taskId,
      causeEventId: event.id,
      cause: 'cancelled',
    });
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/**
 * The `ticket_release` wake-up — the cancellation handler's (and, until WP-178, the rework command's;
 * `ensureTicketClaim` writes the `stopped` one out by hand).
 */
export const releaseRequest = (input: {
  readonly projectId: Id;
  readonly taskId: Id;
  readonly causeEventId: Id;
  readonly cause: 'cancelled' | 'rework' | 'stopped';
}): PipelineOutboundData => ({
  duty: 'ticket_release',
  project_id: input.projectId,
  task_id: input.taskId,
  cause_event_id: input.causeEventId,
  release_cause: input.cause,
});

/** Both handlers, for `createPipelineRuntime`. */
export const ticketLifecycleHandlers = (options: PipelineSagaOptions): readonly EventHandler[] => [
  ticketLifecycleHandler(options),
  ticketReleaseHandler(options),
];

/**
 * `pipeline.outbound` duty **ticket_lifecycle**: move the ticket to the status the handler decided.
 * Re-validates the task and — on a claiming binding — the claim; never throws for the provider.
 */
export const runTicketLifecycle = async (
  options: TaskTransactionOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger: Logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id | undefined;
  const status = data.status;
  if (taskId === undefined || typeof status !== 'string' || status === '') {
    return;
  }
  const read = await options.unitOfWork.transaction(async (scope) => {
    const stored = await options.store.tasks.load(scope.tx, taskId);
    return stored === null
      ? null
      : { stored, claim: await options.store.tasks.ticketClaim(scope.tx, taskId) };
  });
  if (read === null) {
    return;
  }
  const { stored, claim } = read;
  const settings = await options.settings.forProject(stored.task.projectId);
  const lifecycle = settings.ticketLifecycle;
  if (lifecycle !== null && lifecycleClaims(lifecycle.slots) && !ticketClaimHeld(claim)) {
    logger.debug(
      { task_id: taskId, slot: data.lifecycle_slot, status },
      'the task does not hold its ticket, so the lifecycle leaves the ticket alone; the claim moves it',
    );
    return;
  }
  try {
    const integrations = await integrationsForProject(
      options.integrations,
      stored.task.projectId,
      noRunScopedSecrets(),
    );
    await ticketWrites(integrations).transition(stored.task.ticket, status, {
      projectId: stored.task.projectId,
      taskId,
      mode: stored.task.mode,
      causeEventId: data.cause_event_id as Id,
    });
  } catch (error) {
    if (error instanceof TransactionOpenError) {
      throw error;
    }
    logger.warn(
      { task_id: taskId, slot: data.lifecycle_slot, err: error },
      'the ticket could not be moved to its lifecycle slot; the stage runs regardless, and the next moment moves the ticket on',
    );
  }
};

/**
 * `pipeline.outbound` duty **ticket_release**: give the ticket back ({@link releaseTicket}).
 *
 * Its wake-ups are `task.cancelled` ({@link ticketReleaseHandler}) and a task that stopped between
 * the claim's assign and its record (`ensureTicketClaim`, cause `stopped`). A person's *Rework* no
 * longer enqueues it (WP-178 criterion (17) (i), PROGRESS backlog 541): the reworked task's next
 * agent admission performs that release itself, before it claims, so the two cannot interleave. A
 * `rework` wake-up enqueued before WP-178 is still performed here, with the race it always had.
 */
export const runTicketRelease = async (
  options: TaskTransactionOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const taskId = data.task_id as Id | undefined;
  const cause = data.release_cause;
  if (
    taskId === undefined ||
    (cause !== 'cancelled' && cause !== 'rework' && cause !== 'stopped')
  ) {
    return;
  }
  await releaseTicket(options, {
    taskId,
    cause,
    keySuffix: String(data.cause_event_id),
    // A `stopped` release has no cause event (the claim enqueued it from a job, with a fresh id
    // standing as its wake-up identity), so the envelope names none.
    causeEventId: cause === 'stopped' ? null : (data.cause_event_id as Id),
  });
};
