/**
 * **Writing the owner back to the tracker** — on by default per binding (S-26.3, TD-031's 2026-11-06
 * amendment item 4 as amended on 2026-11-26, BD-031's 2026-11-06 amendment).
 *
 * WP-15d's shape: one handler decides and one `pipeline.outbound` duty calls.
 *
 * - `pipeline.ticket.owner_assign` (TD-005 priority **120**, the integrations band) reads a
 *   `task.owner.changed`. It enqueues the `ticket_owner_assign` duty only for a person's own act
 *   that names somebody (`ownerChangeWritesBack`: `via` `command` — a manual Start, *Take it*,
 *   *Assign…* — or `pick`; never a worker's automatic `claim`, never a tracker sync and never a
 *   release — the platform never unassigns a person, TD-029 decision 5), on a live task that names
 *   a provider ticket, unless the project's task-management binding sets
 *   `lifecycle.assign_owner: false` (`assignOwnerOn`). **With the switch explicitly off nothing is
 *   enqueued and no provider is called.** An event with no `owner_changed_at` (one written before S-26.3) **fails
 *   safe**: the instant the duty would re-validate against is unknown, so nothing is enqueued and
 *   the reason is logged — a person's next assignment writes back.
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
 *   6. **after a terminal refusal with nothing to restore** — the preset was already in place when
 *      this try began, because a process died between an earlier try's preset and its restore —
 *      it **reads the ticket** and writes the tracker's actual assignee into `ticket_assignee`
 *      (still only while the column holds the preset). Otherwise the stale preset would make the
 *      next sync read the tracker's real assignee as a change and drop the platform's owner. A read
 *      that fails leaves the preset and logs it (the backlog 1420 case, closed here).
 *   7. **after a terminal refusal over nobody** (TD-031's 2026-11-27 amendment item 5, BACKLOG 1674)
 *      — on a binding whose lifecycle claims, while the ticket still names nobody and the owner is
 *      still the event's — assigns the **binding's own account** as an ordinary claim would
 *      (`assignBindingAccountOverNobody`), so the agent never works a ticket that shows nobody. A
 *      ticket a person holds is never touched. An **expired** last try does not reach it (BACKLOG
 *      1675).
 *
 * **Residuals, stated.** Jira has no conditional assign: a person who changes the tracker between
 * the preset and the `PUT` is overwritten by it, and the next tracker read then follows the ticket
 * back to the platform's owner (backlog 1421). A sync that **runs** between the preset and the `PUT`
 * reads the tracker's old assignee, which differs from the preset, so it moves the owner — and the
 * read after the `PUT` lands moves it back: TD-031's *"a sync racing the call reads no change"*
 * holds only for reads made after the call (backlog 1422).
 */
import type { ExternalIdentity, Id, IsoDateTime, TicketAssignee } from '@platform/contracts';
import {
  assignOwnerOn,
  intendedTicketAssignee,
  isTerminalTaskState,
  lifecycleClaims,
  type OwnershipDecision,
  ownerChangeWritesBack,
  ownerWriteBackBlocker,
  ownerWriteBackStillDue,
  presetTicketAssignee,
  restoreTicketAssignee,
  sameTicketAssignee,
  type TaskOwnership,
  ticketAssigneeOf,
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
  type PipelineIntegrations,
  ticketReads,
  ticketWrites,
} from './integrations.js';
import { enqueueOutbound, type PipelineOutboundData, type TaskTransactionOptions } from './jobs.js';
import { recordClaimAssign, TaskOwnerConflictError } from './owner-sync.js';
import type { PipelineSagaOptions } from './saga.js';
import type { TicketLifecycleReadingKind } from './settings.js';
import type { PipelineStore, StoredTask } from './store.js';
import { retryOnTaskConflict } from './task-conflict.js';
import { readTicketForTask } from './ticket-snapshot.js';

/** The handler's `handler_executions` key; renaming it re-runs it over the log. */
export const OWNER_WRITE_BACK_HANDLER = 'pipeline.ticket.owner_assign';

/**
 * Whether the binding writes the owner back — on unless its lifecycle block says
 * `assign_owner: false` (`assignOwnerOn`, TD-031's second 2026-11-26 amendment item 1). A binding
 * with no block is on. **No binding, two task-management bindings, or a block that fails its
 * schema is off** (TD-031's 2026-11-27 amendment item 3, BACKLOG 1672): the loader refuses that
 * project's or binding's every call, so a write-back would only fail and retry — the one rule the
 * task DTO's `owner_writes_back` reads too (`projectsAssigningOwners` in
 * `apps/server/src/queries/pipeline-queries.ts` asks this function). A settings reader that does
 * not say how it read the lifecycle (`ticketLifecycleReading` absent) is read off the block alone.
 */
export const assignsOwner = (settings: {
  readonly ticketLifecycle: { readonly slots: { readonly assign_owner?: boolean } } | null;
  readonly ticketLifecycleReading?: TicketLifecycleReadingKind;
}): boolean => {
  const reading = settings.ticketLifecycleReading;
  if (reading !== undefined && reading !== 'lifecycle' && reading !== 'none') {
    return false;
  }
  return assignOwnerOn(settings.ticketLifecycle?.slots);
};

/** The write's idempotency key: the task and the owner change it writes back — platform ids only. */
export const ownerWriteBackKeyFor = (taskId: Id, causeEventId: Id): string =>
  `ticket_owner_assign:${taskId}:${causeEventId}`;

/**
 * `task.owner.changed` → the `ticket_owner_assign` duty, when the module docblock's conditions
 * hold. The instant to re-validate against is the event's `owner_changed_at`; an event written
 * before S-26.3 has none and **fails safe** — nothing is enqueued and the reason is logged, rather
 * than the row's instant standing in for one the event never named.
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
    if (
      ownerUserId === null ||
      !ownerChangeWritesBack({ ownerUserId, source: payload.source, via: payload.via })
    ) {
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
    const changedAt = payload.owner_changed_at;
    if (changedAt === undefined) {
      (options.logger ?? silentLogger).info(
        {
          task_id: payload.task_id,
          owner_user_id: ownerUserId,
          event_id: event.id,
          reason: 'event_without_owner_changed_at',
        },
        'ticket_owner_assign: the owner change names no instant to re-validate against (an event written before S-26.3), so it is not written back',
      );
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
  | {
      readonly kind: 'refused';
      readonly code: IntegrationError['code'];
      /**
       * TD-031's 2026-11-27 amendment item 5 (BACKLOG 1674): the refusal left the ticket with
       * nobody, so the binding's own account was assigned as an ordinary claim would.
       */
      readonly bindingAccountAssigned: boolean;
    };

const SKIP_WORDS: Readonly<Record<string, string>> = {
  task_gone: 'the task no longer exists',
  task_finished: 'the task has finished',
  no_provider_ticket: 'the task names no provider ticket',
  switch_off: 'the binding sets lifecycle.assign_owner: false',
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
  // The one predicate every read that promises this write asks (`ownerWriteBackBlocker`).
  const blocker = ownerWriteBackBlocker({
    assignOwner: assignsOwner(settings),
    providerTicket: namesAProviderTicket(stored.task.ticket),
    hasPersonIdentity: identity !== null,
  });
  if (blocker !== null || identity === null) {
    return skip(blocker ?? 'owner_has_no_identity');
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
  /** The preset was already in place when this try began (an earlier try died before restoring). */
  let presetFound = false;
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
    presetFound = sameTicketAssignee(previous, intended);
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

  // 6. Nothing to restore after a terminal refusal: the tracker's own assignee, read and written back.
  const reconcileFromTracker = async (): Promise<void> => {
    const read = await readTicketForTask(
      options,
      { projectId: stored.task.projectId, taskId, ticket },
      integrations,
    );
    if (read === null) {
      logger.warn(
        { task_id: taskId, owner_user_id: ownerUserId },
        'ticket_owner_assign: the ticket could not be read after a refused write-back, so its stored assignee still names the owner',
      );
      return;
    }
    await retryOnTaskConflict(
      { taskId, what: 'storing the tracker’s assignee after a refused write-back', logger },
      async () =>
        options.unitOfWork.transaction(async (scope) => {
          const assigneeClass =
            read.assignee === null
              ? null
              : await options.store.owners.classifyAssignee(scope.tx, {
                  projectId: stored.task.projectId,
                  provider: read.assignee.provider,
                  externalId: read.assignee.external_id,
                });
          const actual = ticketAssigneeOf(
            read.assignee === null
              ? null
              : {
                  provider: read.assignee.provider,
                  externalId: read.assignee.external_id,
                  redactedDisplayName: read.assigneeDisplayName,
                },
            assigneeClass,
          );
          const current = await options.store.tasks.ownership(scope.tx, taskId);
          await writeOwnership(
            options.store,
            scope.tx,
            taskId,
            current,
            restoreTicketAssignee(current, { intended, previous: actual }),
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
    if (presetFound) {
      await reconcileFromTracker();
    }
    const { code } = error;
    logger.warn(
      { task_id: taskId, owner_user_id: ownerUserId, code, err: error },
      'ticket_owner_assign: the tracker refused to assign the ticket to its owner; the platform’s owner stands, and the stored assignee is put back',
    );
    const bindingAccountAssigned = shadow
      ? false
      : await assignBindingAccountOverNobody(options, {
          stored,
          integrations,
          event,
          causeEventId: data.cause_event_id as Id,
          logger,
        });
    return { kind: 'refused', code, bindingAccountAssigned };
  }
};

/** The idempotency key of the fallback assign: the task and the owner change it stands in for. */
export const ownerWriteBackFallbackKeyFor = (taskId: Id, causeEventId: Id): string =>
  `ticket_owner_assign_fallback:${taskId}:${causeEventId}`;

/**
 * **A refused write-back leaves the ticket with the platform's account, not with nobody** (TD-031's
 * 2026-11-27 amendment item 5, BACKLOG 1674). While a person's write-back is owed the claim keeps the
 * ticket `held_by: 'platform_owner'` and assigns nothing, even over nobody; when the write-back is
 * then refused for good, the ticket would show nobody while the agent works. So, after the refusal:
 *
 *  1. only on a binding whose lifecycle **claims** (an ordinary claim would have assigned its
 *     account; a binding that does not claim never shows it);
 *  2. **re-reads the ticket** and goes on only while it names **nobody** — a ticket a person holds,
 *     or one the binding already holds, is never touched; a read that fails or answers no ticket
 *     writes nothing;
 *  3. re-validates the task in a transaction (live, and the owner still the event's — a later owner
 *     change writes itself back);
 *  4. calls `assignToSelf` outside any transaction, through `IntegrationActionExecutor`, keyed by
 *     the task and the owner change ({@link ownerWriteBackFallbackKeyFor}), so a redelivered job
 *     replays it;
 *  5. records it as the claim does: `ticket_assignee` names the binding's account
 *     (`recordClaimAssign`), and a live claim kept `held_by: 'platform_owner'` loses that mark, so
 *     the release unassigns the account the platform put there.
 *
 * Every failure is logged and swallowed: the refusal already ended the job, and this is a mark on
 * the tracker, not the owner (the platform's owner stands either way). Jira has no conditional
 * assign, so a person who takes the ticket between the read and the `PUT` is overwritten by it —
 * the same residual the write-back states (backlog 1421).
 */
const assignBindingAccountOverNobody = async (
  options: TaskTransactionOptions,
  input: {
    readonly stored: StoredTask;
    readonly integrations: PipelineIntegrations;
    readonly event: { readonly ownerUserId: Id; readonly ownerChangedAt: IsoDateTime };
    readonly causeEventId: Id;
    readonly logger: Logger;
  },
): Promise<boolean> => {
  const { stored, integrations, logger } = input;
  const task = stored.task;
  const fields = { task_id: task.id, owner_user_id: input.event.ownerUserId };
  try {
    const settings = await options.settings.forProject(task.projectId);
    if (settings.ticketLifecycle === null || !lifecycleClaims(settings.ticketLifecycle.slots)) {
      return false;
    }
    const context = { projectId: task.projectId, taskId: task.id };
    const read = await ticketReads(integrations).ticket(task.ticket, context);
    if (read === null || read.assignee !== null) {
      return false;
    }
    const due = await options.unitOfWork.transaction(async (scope) => {
      const current = await options.store.tasks.load(scope.tx, task.id);
      return (
        current !== null &&
        !isTerminalTaskState(current.task.state) &&
        ownerWriteBackStillDue(
          await options.store.tasks.ownership(scope.tx, task.id),
          input.event,
        ) === null
      );
    });
    if (!due) {
      return false;
    }
    const self = await ticketReads(integrations).selfIdentity(context);
    if (self === null) {
      return false;
    }
    const assigned = await ticketWrites(integrations).assignToSelf(task.ticket, {
      ...context,
      mode: task.mode,
      causeEventId: input.causeEventId,
      idempotencyKey: ownerWriteBackFallbackKeyFor(task.id, input.causeEventId),
      self,
    });
    if (assigned === null) {
      return false;
    }
    const redactor = integrations.taskManagement?.redactor;
    const name = self.display_name ?? null;
    const selfDisplayName =
      name === null || name.length === 0 || redactor === undefined
        ? null
        : redactor.redactText(name).value;
    await retryOnTaskConflict(
      {
        taskId: task.id,
        what: 'recording the binding’s assign after a refused write-back',
        logger,
      },
      async () =>
        options.unitOfWork.transaction(async (scope) => {
          await recordClaimAssign(options, scope.tx, {
            projectId: task.projectId,
            taskId: task.id,
            self,
            selfDisplayName,
          });
          const claim = await options.store.tasks.ticketClaim(scope.tx, task.id);
          if (
            claim !== null &&
            !claim.stale &&
            claim.released_at === null &&
            claim.held_by === 'platform_owner'
          ) {
            const { held_by: _kept, ...assignedClaim } = claim;
            await options.store.tasks.saveTicketClaim(scope.tx, task.id, {
              ...assignedClaim,
              account_id: self.external_id.slice(0, 255),
            });
          }
        }),
    );
    logger.info(
      fields,
      'ticket_owner_assign: the refused write-back left the ticket with nobody, so the binding’s own account holds it, as an ordinary claim would',
    );
    return true;
  } catch (error) {
    if (error instanceof TransactionOpenError) {
      throw error;
    }
    logger.warn(
      { ...fields, err: error },
      'ticket_owner_assign: after a refused write-back the binding’s own account could not be assigned; the ticket may show nobody until a person or the next claim assigns it',
    );
    return false;
  }
};
