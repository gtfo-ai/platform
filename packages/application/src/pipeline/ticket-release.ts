/**
 * **The ticket release** — BD-031 ruling 5, TD-029 decision 5 (WP-177; its own module since
 * WP-178).
 *
 * Unassign the binding's own account and move the ticket to `pick_up_from` when that is mapped,
 * then record `released_at` and `ticket.released`. Two callers:
 *
 *  - the `ticket_release` duty (`runTicketRelease`, `ticket-lifecycle.ts`), for a cancelled task
 *    and for a task that stopped between the claim's assign and its record (`stopped`);
 *  - **the claim itself**, for a person's *Rework* (WP-178 criterion (17) (i), PROGRESS backlog
 *    541). Until WP-178 the Rework enqueued this as a duty, and the reworked task's next agent stage
 *    re-claimed on another queue: a re-claim that landed between the release's check and its
 *    `unassign` was undone by the `unassign`, and the claim then read held over an unassigned
 *    ticket. The release now runs on the task's `stage.execute` path, **before** the claim, in one
 *    job — released, then claimed, in that order (`ensureTicketClaim`). That is backlog 541's
 *    option (a); its option (b), a per-task advisory lock held across the provider call, would
 *    have needed a session-scoped lock the `UnitOfWork` port does not offer.
 *
 * It lives apart from `ticket-lifecycle.ts` because the claim calls it, and importing that module
 * from `ticket-claim.ts` closes a cycle through `jobs.ts`.
 *
 * Each provider step fails open with a `warn`; what happened is recorded either way. A `rework` or
 * `stopped` release acts only while the claim is still **stale** — the stale mark is the token, and
 * a re-claim clears it — so a release that finds the claim held again does nothing.
 */
import type { DomainEvent, Id, IsoDateTime } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { TransactionOpenError } from '../events/open-transaction.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import { integrationsForProject, noRunScopedSecrets, ticketWrites } from './integrations.js';
import { PIPELINE_ACTOR } from './store.js';
import { inTaskTransaction, type TaskTransactionOptions } from './task-transaction.js';

/** Why the ticket is given back (`ticket.released.cause`). */
export type TicketReleaseCause = 'cancelled' | 'rework' | 'stopped';

export interface TicketReleaseRequest {
  readonly taskId: Id;
  readonly cause: TicketReleaseCause;
  /** The idempotency keys' identity: one release, one pair of provider writes. */
  readonly keySuffix: string;
  /** The event the release answers, or `null` when none caused it (`stopped`, a claim's rework). */
  readonly causeEventId: Id | null;
}

/** The release — see the module docblock. Never throws for the provider. */
export const releaseTicket = async (
  options: TaskTransactionOptions,
  request: TicketReleaseRequest,
): Promise<void> => {
  const { taskId, cause } = request;
  const logger: Logger = options.logger ?? silentLogger;
  const read = await options.unitOfWork.transaction(async (scope) => {
    const stored = await options.store.tasks.load(scope.tx, taskId);
    return stored === null
      ? null
      : { stored, claim: await options.store.tasks.ticketClaim(scope.tx, taskId) };
  });
  if (read === null || read.claim === null || read.claim.released_at !== null) {
    return;
  }
  const { stored, claim } = read;
  // A Rework and a stopped claim marked the claim stale; a re-claim clears it (the token).
  if (cause !== 'cancelled' && !claim.stale) {
    logger.info(
      { task_id: taskId, cause },
      'the task claimed its ticket again after the release was decided; the release leaves it held',
    );
    return;
  }
  const { task } = stored;
  const settings = await options.settings.forProject(task.projectId);
  const pickUpFrom = settings.ticketLifecycle?.pickUpFrom ?? null;
  const writeContext = {
    projectId: task.projectId,
    taskId,
    mode: task.mode,
    causeEventId: request.causeEventId,
  };
  const integrations = await integrationsForProject(
    options.integrations,
    task.projectId,
    noRunScopedSecrets(),
  );
  const shadow = task.mode === 'shadow';
  const unassigned = await failingOpen(logger, taskId, 'unassign', async () => {
    const result = await ticketWrites(integrations).unassign(task.ticket, {
      ...writeContext,
      idempotencyKey: `ticket_release_unassign:${taskId}:${request.keySuffix}`,
    });
    return result?.changed === true && !shadow;
  });
  const pickUpFromWritten =
    pickUpFrom !== null &&
    (await failingOpen(logger, taskId, 'pick_up_from', async () => {
      const result = await ticketWrites(integrations).transition(task.ticket, pickUpFrom, {
        ...writeContext,
        idempotencyKey: `ticket_release_pick_up_from:${taskId}:${request.keySuffix}`,
      });
      return result !== null && !shadow;
    }));

  await inTaskTransaction(options, taskId, 'recording the ticket release', async (scope) => {
    await options.store.tasks.bumpVersion(scope.tx, taskId);
    const current = await options.store.tasks.load(scope.tx, taskId);
    const latest = await options.store.tasks.ticketClaim(scope.tx, taskId);
    // A re-claim that landed while the provider calls ran is not marked released. Since WP-178 a
    // Rework's release runs in the claiming job, before the claim, so no re-claim can land here for
    // it (backlog 541). For a `rework` duty enqueued before WP-178 the old residual stands: the
    // unassign above may have undone that re-claim's assignment while the claim still reads held.
    if (
      current === null ||
      latest === null ||
      latest.released_at !== null ||
      (cause !== 'cancelled' && !latest.stale)
    ) {
      return null;
    }
    await options.store.tasks.saveTicketClaim(scope.tx, taskId, {
      ...latest,
      released_at: options.clock.now() as IsoDateTime,
      release_cause: cause,
    });
    const event = domainEventSchemasByType['ticket.released'].parse({
      id: options.ids.next(),
      stream_type: 'task',
      stream_id: taskId,
      stream_seq: current.task.sequence,
      correlation_id: taskId,
      cause_event_id: request.causeEventId,
      actor: PIPELINE_ACTOR,
      occurred_at: options.clock.now(),
      type: 'ticket.released',
      payload: {
        project_id: task.projectId,
        task_id: taskId,
        ticket: { ...current.task.ticket },
        unassigned,
        pick_up_from_written: pickUpFromWritten,
        cause,
      },
    }) as DomainEvent;
    await scope.events.append([event]);
    return null;
  });
};

/** One provider step of the release: its answer, or `false` with a `warn` naming the step. */
const failingOpen = async (
  logger: Logger,
  taskId: Id,
  step: 'unassign' | 'pick_up_from',
  perform: () => Promise<boolean>,
): Promise<boolean> => {
  try {
    return await perform();
  } catch (error) {
    if (error instanceof TransactionOpenError) {
      throw error;
    }
    logger.warn(
      { task_id: taskId, step, err: error },
      'a step of the ticket release failed; the release is recorded with what it did',
    );
    return false;
  }
};
