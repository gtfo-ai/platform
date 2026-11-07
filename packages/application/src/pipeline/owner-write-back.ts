/**
 * **Writing the owner back to the tracker** — opt-in per binding (S-26.3, TD-031's 2026-11-06
 * amendment item 4, BD-031's 2026-11-06 amendment).
 *
 * WP-15d's shape: one handler decides and one `pipeline.outbound` duty calls.
 *
 * - `pipeline.ticket.owner_assign` (TD-005 priority **120**, the integrations band) reads a
 *   `task.owner.changed`. It enqueues the `ticket_owner_assign` duty only for a change the platform
 *   made that names somebody (`ownerChangeWritesBack`: a command or a pick, never a tracker sync and
 *   never a release — the platform never unassigns a person, TD-029 decision 5), on a live task that
 *   names a provider ticket, when the project's task-management binding sets
 *   `lifecycle.assign_owner`. **With the switch off — the default — nothing is enqueued and no
 *   provider is called.**
 * - The duty, when it fires:
 *   1. **re-validates** (TD-004: a job cannot be cancelled). The task must be live, the switch still
 *      on, and the task's owner, its source and `owner_changed_at` still the event's
 *      (`ownerWriteBackStillDue`). A platform assignment to Bob followed by a tracker change to Carol
 *      therefore writes nothing: the owner is Carol's mapping (or nobody) by then. Every skip is one
 *      logged reason.
 *   2. asks the directory for the owner's **`person` identity** for the ticket's provider. None —
 *      the owner never linked an account there — is no call and one logged reason; the task DTO's
 *      `owner_writes_back` says `false` for that task, from the same two facts.
 *   3. **presets `ticket_assignee`** to that identity (`presetTicketAssignee`, a compare-and-set
 *      through `saveOwner`, on the conflict bound), so the next tracker read — the call's own result
 *      — compares equal and changes nothing (S-26.1's *latest change wins*). A shadow task presets
 *      nothing: its call writes nothing, and a stored assignee the tracker does not show would make
 *      the next read look like somebody else's change.
 *   4. **calls** `ticketWrites.assignTo` outside any transaction, through `IntegrationActionExecutor`
 *      (a shadow task is `would_have`), keyed by the task and the owner change, so a redelivered job
 *      replays rather than writes twice.
 *   5. on a refusal **puts the previous value back** (`restoreTicketAssignee`: only while the column
 *      still names the intended identity). The owner is kept — the platform's assignment stands
 *      whether or not the tracker shows it — and the refusal is logged. A provider that is
 *      unavailable or rate-limited past the executor's own retries is put back too and **thrown**,
 *      so the job's retry presets again from the restored value; every other refusal (a missing
 *      *Assign Issues* permission, an account the tracker does not know) ends the job.
 *
 * **Residuals, stated.** Jira has no conditional assign: a person who changes the tracker between
 * the preset and the `PUT` is overwritten by it, and the next tracker read then follows the ticket
 * back to the platform's owner. A process that dies between the preset and the restore leaves the
 * preset in place; the retry finds it already set and so cannot restore what it replaced, and a
 * terminal refusal on that retry leaves `ticket_assignee` naming the owner while the tracker names
 * somebody else — until that somebody changes it again.
 */
import type { ExternalIdentity, Id, IsoDateTime, TicketAssignee } from '@platform/contracts';
import {
  intendedTicketAssignee,
  isTerminalTaskState,
  type OwnershipDecision,
  ownerChangeWritesBack,
  ownerWriteBackStillDue,
  presetTicketAssignee,
  restoreTicketAssignee,
  type TaskOwnership,
} from '@platform/domain';
import type { EventHandler } from '../events/handler.js';
import { TransactionOpenError } from '../events/open-transaction.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import {
  integrationsForProject,
  namesAProviderTicket,
  noRunScopedSecrets,
  ticketWrites,
} from './integrations.js';
import { enqueueOutbound, type PipelineOutboundData, type TaskTransactionOptions } from './jobs.js';
import { TaskOwnerConflictError } from './owner-sync.js';
import type { PipelineSagaOptions } from './saga.js';
import type { PipelineStore } from './store.js';
import { retryOnTaskConflict } from './task-conflict.js';

/** The handler's `handler_executions` key; renaming it re-runs it over the log. */
export const OWNER_WRITE_BACK_HANDLER = 'pipeline.ticket.owner_assign';

/** Whether the binding's lifecycle block switches the write-back on (default `false`). */
export const assignsOwner = (settings: {
  readonly ticketLifecycle: { readonly slots: { readonly assign_owner?: boolean } } | null;
}): boolean => settings.ticketLifecycle?.slots.assign_owner === true;

/** The write's idempotency key: the task and the owner change it writes back — platform ids only. */
export const ownerWriteBackKeyFor = (taskId: Id, causeEventId: Id): string =>
  `ticket_owner_assign:${taskId}:${causeEventId}`;

/**
 * `task.owner.changed` → the `ticket_owner_assign` duty, when the module docblock's conditions
 * hold. The instant to re-validate against is the event's `owner_changed_at`; an event written
 * before S-26.3 has none, and the row's own instant stands in while the row still names this owner
 * as the platform's (otherwise a later change has its own wake-up, and this one asks for nothing).
 */
export const ownerWriteBackHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: OWNER_WRITE_BACK_HANDLER,
  priority: 120,
  eventTypes: ['task.owner.changed'],
  handle: async (context) => {
    const event = context.event.event;
    if (event.type !== 'task.owner.changed') {
      return;
    }
    const { payload } = event;
    const ownerUserId = payload.owner_user_id;
    if (ownerUserId === null || !ownerChangeWritesBack({ ownerUserId, source: payload.source })) {
      return;
    }
    const { tx } = context.scope;
    const stored = await options.store.tasks.load(tx, payload.task_id);
    if (
      stored === null ||
      isTerminalTaskState(stored.task.state) ||
      !namesAProviderTicket(stored.task.ticket)
    ) {
      return;
    }
    const settings = await options.settings.forProject(stored.task.projectId, tx);
    if (!assignsOwner(settings)) {
      return;
    }
    let changedAt = payload.owner_changed_at ?? null;
    if (changedAt === null) {
      const current = await options.store.tasks.ownership(tx, payload.task_id);
      if (current.ownerUserId !== ownerUserId || current.ownerSource !== 'platform') {
        return;
      }
      changedAt = current.ownerChangedAt;
    }
    if (changedAt === null) {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'ticket_owner_assign',
      project_id: stored.task.projectId,
      task_id: stored.task.id,
      cause_event_id: event.id,
      owner_user_id: ownerUserId,
      owner_changed_at: changedAt,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/** The handler this module registers (`createPipelineRuntime`). */
export const ownerWriteBackHandlers = (options: PipelineSagaOptions): readonly EventHandler[] => [
  ownerWriteBackHandler(options),
];

/** Why the duty wrote nothing — each one logged line (criterion 4's *one logged reason*). */
export type OwnerWriteBackOutcome =
  | { readonly kind: 'written'; readonly changed: boolean }
  | {
      readonly kind: 'skipped';
      readonly reason:
        | 'task_gone'
        | 'task_finished'
        | 'no_provider_ticket'
        | 'switch_off'
        | 'owner_changed'
        | 'owner_changed_again'
        | 'owner_not_platform'
        | 'owner_has_no_identity'
        | 'no_binding'
        | 'provider_cannot_assign';
    }
  | { readonly kind: 'refused'; readonly code: IntegrationError['code'] };

const SKIP_WORDS: Readonly<Record<string, string>> = {
  task_gone: 'the task no longer exists',
  task_finished: 'the task has finished',
  no_provider_ticket: 'the task names no provider ticket',
  switch_off: 'the binding no longer sets lifecycle.assign_owner',
  owner_changed: 'the task’s owner changed since (TD-004: the duty re-validates on fire)',
  owner_changed_again: 'the same owner was set again since, and that change writes itself back',
  owner_not_platform: 'the task’s owner was last set by the tracker, not the platform',
  owner_has_no_identity: 'the owner has no linked account for the ticket’s provider',
  no_binding: 'the project has no task-management binding',
  provider_cannot_assign: 'the provider does not declare assignOthers',
};

/** One compare-and-set of the ownership columns, or a conflict the bound re-runs. */
const writeOwnership = async (
  store: PipelineStore,
  tx: Transaction,
  taskId: Id,
  current: TaskOwnership,
  decision: OwnershipDecision,
): Promise<void> => {
  if (decision.kind === 'unchanged') {
    return;
  }
  const written = await store.tasks.saveOwner(tx, taskId, {
    expected: { ownerUserId: current.ownerUserId, ticketAssignee: current.ticketAssignee },
    next: decision.next,
  });
  if (!written) {
    throw new TaskOwnerConflictError(taskId);
  }
};

/**
 * `pipeline.outbound` duty **ticket_owner_assign** — the module docblock's five steps. Answers what
 * it did, which the tests read; production reads the log line.
 */
export const runTicketOwnerAssign = async (
  options: TaskTransactionOptions,
  data: PipelineOutboundData,
): Promise<OwnerWriteBackOutcome> => {
  const logger: Logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id | undefined;
  const ownerUserId = data.owner_user_id as Id | undefined;
  const ownerChangedAt = data.owner_changed_at as IsoDateTime | undefined;
  if (taskId === undefined || ownerUserId === undefined || ownerChangedAt === undefined) {
    return { kind: 'skipped', reason: 'task_gone' };
  }
  const event = { ownerUserId, ownerChangedAt };
  const skip = (
    reason: Extract<OwnerWriteBackOutcome, { kind: 'skipped' }>['reason'],
  ): OwnerWriteBackOutcome => {
    logger.info(
      { task_id: taskId, owner_user_id: ownerUserId, reason },
      `ticket_owner_assign: the ticket is not assigned — ${SKIP_WORDS[reason] ?? reason}`,
    );
    return { kind: 'skipped', reason };
  };

  // 1–2. Re-validate on fire, and find the owner's account — one transaction, no provider call.
  const read = await options.unitOfWork.transaction(async (scope) => {
    const stored = await options.store.tasks.load(scope.tx, taskId);
    if (stored === null) {
      return { kind: 'skip', reason: 'task_gone' } as const;
    }
    if (isTerminalTaskState(stored.task.state)) {
      return { kind: 'skip', reason: 'task_finished' } as const;
    }
    if (!namesAProviderTicket(stored.task.ticket)) {
      return { kind: 'skip', reason: 'no_provider_ticket' } as const;
    }
    const due = ownerWriteBackStillDue(
      await options.store.tasks.ownership(scope.tx, taskId),
      event,
    );
    if (due !== null) {
      return { kind: 'skip', reason: due } as const;
    }
    const identity = await options.store.owners.personIdentity(scope.tx, {
      userId: ownerUserId,
      provider: stored.task.ticket.provider,
    });
    return { kind: 'due', stored, identity } as const;
  });
  if (read.kind === 'skip') {
    return skip(read.reason);
  }
  const { stored, identity } = read;
  const settings = await options.settings.forProject(stored.task.projectId);
  if (!assignsOwner(settings)) {
    return skip('switch_off');
  }
  if (identity === null) {
    return skip('owner_has_no_identity');
  }
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  const binding = integrations.taskManagement;
  if (binding === null) {
    return skip('no_binding');
  }
  if (binding.port.capabilities().assignOthers !== true) {
    return skip('provider_cannot_assign');
  }

  const ticket = stored.task.ticket;
  const intended = intendedTicketAssignee({
    provider: ticket.provider,
    externalId: identity.externalId,
  });
  const shadow = stored.task.mode === 'shadow';

  // 3. The preset, under the same re-validation, on the conflict bound.
  let previous: TicketAssignee | null = intended;
  if (!shadow) {
    const preset = await retryOnTaskConflict(
      { taskId, what: 'presetting the ticket’s assignee for the owner write-back', logger },
      async () =>
        options.unitOfWork.transaction(async (scope) => {
          const current = await options.store.tasks.ownership(scope.tx, taskId);
          const due = ownerWriteBackStillDue(current, event);
          if (due !== null) {
            return { kind: 'skip', reason: due } as const;
          }
          await writeOwnership(
            options.store,
            scope.tx,
            taskId,
            current,
            presetTicketAssignee(current, intended),
          );
          return { kind: 'preset', previous: current.ticketAssignee } as const;
        }),
    );
    if (preset.kind === 'skip') {
      return skip(preset.reason);
    }
    previous = preset.previous;
  }

  // 5. Put back what the preset replaced, while the column still holds what it wrote.
  const restore = async (): Promise<void> => {
    if (shadow) {
      return;
    }
    await retryOnTaskConflict(
      { taskId, what: 'restoring the ticket’s assignee after a refused write-back', logger },
      async () =>
        options.unitOfWork.transaction(async (scope) => {
          const current = await options.store.tasks.ownership(scope.tx, taskId);
          await writeOwnership(
            options.store,
            scope.tx,
            taskId,
            current,
            restoreTicketAssignee(current, { intended, previous }),
          );
        }),
    );
  };

  // 4. The call: outside every transaction, through the executor.
  const assignee: ExternalIdentity = {
    provider: ticket.provider,
    external_id: identity.externalId,
    verified: true,
  };
  try {
    const result = await ticketWrites(integrations).assignTo(ticket, assignee, {
      projectId: stored.task.projectId,
      taskId,
      mode: stored.task.mode,
      causeEventId: data.cause_event_id as Id,
      idempotencyKey: ownerWriteBackKeyFor(taskId, data.cause_event_id as Id),
    });
    if (result === null) {
      await restore();
      return skip('provider_cannot_assign');
    }
    return { kind: 'written', changed: result.changed };
  } catch (error) {
    if (error instanceof TransactionOpenError) {
      throw error;
    }
    await restore();
    if (!(error instanceof IntegrationError) || error.retryable) {
      // A tracker outage — or a programming error, which is not a tracker's answer: the restored
      // value is what the retry presets from.
      throw error;
    }
    const { code } = error;
    logger.warn(
      { task_id: taskId, owner_user_id: ownerUserId, code, err: error },
      'ticket_owner_assign: the tracker refused to assign the ticket to its owner; the platform’s owner stands, and the stored assignee is put back',
    );
    return { kind: 'refused', code };
  }
};
