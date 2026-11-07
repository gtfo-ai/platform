/**
 * **A task's owner** — the sync from the tracker, the command, the link adoption and the
 * `owner_sync` duty (S-26.1, TD-031's 2026-11-06 amendment items 1–3, BD-031's 2026-11-06
 * amendment 1).
 *
 * Every owner write is decided by a pure function in `packages/domain/src/tasks/owner.ts` and
 * written through the one narrow writer, `TaskRepository.saveOwner` (a compare-and-set), with
 * `task.owner.changed` on the task's stream in the same transaction. This module only reads the
 * rows the decisions need and writes what they answer.
 *
 * ## Where the tracker is read
 *
 * At every read the platform already makes, and at one it adds:
 *
 *  - **intake** — in the insert's transaction ({@link syncOwnerAtIntake}), from the read intake made
 *    for the ticket's words;
 *  - **a stage's re-read** — `ensureTicketSnapshot` with {@link ownerSyncOnRead}, in the
 *    transaction that stores the snapshot, and only for the read that won the freshness race, so an
 *    older read never puts its assignee over a newer one;
 *  - **the `owner_sync` duty** on `ticket.updated` for a live task ({@link runOwnerSync}): the same
 *    re-read, which asks the provider only while the snapshot is older than the newest
 *    `ticket.updated` (`isTicketSnapshotStale`) — so a **burst** of updates costs **one** read: the
 *    first duty's read stamps a snapshot newer than every signal it answered, and the rest find
 *    nothing stale. A signal that arrives while the read is in flight is newer than it, and the next
 *    duty reads again.
 *
 * The claim's pre-read (`ticket-claim.ts`) is S-26.2's, with the claim's own `assignToSelf`
 * writing `ticket_assignee` in its transaction.
 *
 * ## The stream
 *
 * Outside the task's own transactions (the duty, a stage's re-read, the command, the adoption) the
 * event is appended only after `bumpVersion` — the row lock first, so the sequence read is the
 * committed one, and every in-flight `save` over a snapshot read before it is refused and retried
 * (`bumpVersion`'s docblock). The version moves only when the decision writes: a read that changes
 * nothing takes no lock and refuses nobody, and one that replaces only the stored assignee takes
 * it too, so a concurrent owner command is serialised behind it rather than failing it.
 *
 * **A platform assignee is never an owner change** (the domain's `syncOwnerFromTracker`, the review
 * of PR #92): until S-26.2 stops the claim's `assignToSelf`, every read after a first claim names
 * the binding's own account, and the owner a person set before the claim is kept.
 */
import type { DomainEvent, ExternalIdentity, Id, IsoDateTime, UserRole } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import {
  type AssigneeClass,
  adoptOwnerOnLink,
  decideOwnerCommand,
  isTerminalTaskState,
  type OwnerChange,
  type OwnerCommandRefusal,
  type OwnershipDecision,
  syncOwnerFromTracker,
  type TaskOwnership,
  taskHeldElsewhere,
  ticketAssigneeOf,
} from '@platform/domain';
import type { ConcurrencyConflict } from '../events/concurrency.js';
import type { EventHandler } from '../events/handler.js';
import { JOB_QUEUES, type Jobs } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import type { OutboundJobData, PipelineOutboundData } from './jobs.js';
import type { PipelineStore, StoredTask } from './store.js';
import { PIPELINE_ACTOR } from './store.js';
import { retryOnTaskConflict } from './task-conflict.js';
import {
  type EnsureTicketSnapshotOptions,
  ensureTicketSnapshot,
  type TicketRead,
  type TicketReadHook,
} from './ticket-snapshot.js';

/** The handler's `handler_executions` key; renaming it re-runs it over the log. */
export const OWNER_SYNC_HANDLER = 'pipeline.owner.sync';

/** What the owner decisions need: the rows, ids for the event, and the clock. */
export interface OwnerSyncOptions {
  readonly store: PipelineStore;
  readonly ids: { next(): Id };
  readonly clock: { now(): string };
  readonly logger?: Logger;
}

/**
 * A compare-and-set that lost: `saveOwner` found an owner or an assignee other than the one the
 * decision was made over. A **concurrency conflict** (`events/concurrency.ts`), so the bus and
 * `retryOnTaskConflict` re-run the whole unit over a fresh read — never re-apply what was held.
 */
export class TaskOwnerConflictError extends Error implements ConcurrencyConflict {
  override readonly name = 'TaskOwnerConflictError';
  readonly concurrencyConflict = true as const;
  readonly taskId: Id;

  // Fields, not parameter properties: Node's type stripping refuses those (`TaskConcurrentModificationError`).
  constructor(taskId: Id) {
    super(
      `the owner of task ${taskId} moved while a change was being decided; it is decided again`,
    );
    this.taskId = taskId;
  }
}

/** Why `POST /api/tasks/:id/owner` was refused; the route answers 403, 422 or 409 by `reason`. */
export class OwnerChangeRefusedError extends Error {
  override readonly name = 'OwnerChangeRefusedError';
  readonly reason: OwnerCommandRefusal;

  constructor(taskId: Id, reason: OwnerCommandRefusal) {
    super(
      reason === 'owner_change_not_permitted'
        ? `you may not make this owner change on task ${taskId}: a member may take an unassigned task or give back their own, and a maintainer may set anyone`
        : reason === 'owner_not_project_member'
          ? `the user named is not a member (or above) of task ${taskId}'s project, so they cannot own it`
          : `task ${taskId} has finished, so its owner is not changed`,
    );
    this.reason = reason;
  }
}

/** What the platform says about a read assignee — nothing is asked for an unassigned ticket. */
const classifyRead = async (
  store: PipelineStore,
  tx: Transaction,
  projectId: Id,
  assignee: ExternalIdentity | null,
): Promise<AssigneeClass | null> =>
  assignee === null
    ? null
    : store.owners.classifyAssignee(tx, {
        projectId,
        provider: assignee.provider,
        externalId: assignee.external_id,
      });

/**
 * **Held elsewhere, now** (TD-031's amendment item 6): the stored assignee's platform flag, and its
 * identity asked of `user_identities` and the project's roles at this moment — so a link made since
 * the read counts. The predicate itself is the domain's (`taskHeldElsewhere`).
 */
export const heldElsewhereNow = async (
  store: PipelineStore,
  tx: Transaction,
  projectId: Id,
  ownership: TaskOwnership,
): Promise<boolean> => {
  const assignee = ownership.ticketAssignee;
  if (assignee === null || assignee.platform) {
    return false;
  }
  const assigneeClass = await store.owners.classifyAssignee(tx, {
    projectId,
    provider: assignee.provider,
    externalId: assignee.external_id,
  });
  return taskHeldElsewhere({
    ticketAssignee: assignee,
    assigneeIsLinkedMember: assigneeClass.kind === 'member',
  });
};

/** The decision for one tracker read, over `current`. */
const trackerDecision = async (
  options: OwnerSyncOptions,
  tx: Transaction,
  input: {
    readonly projectId: Id;
    readonly assignee: ExternalIdentity | null;
    readonly assigneeDisplayName: string | null;
  },
  current: TaskOwnership,
): Promise<OwnershipDecision> => {
  const assigneeClass = await classifyRead(options.store, tx, input.projectId, input.assignee);
  const stored = ticketAssigneeOf(
    input.assignee === null
      ? null
      : {
          provider: input.assignee.provider,
          externalId: input.assignee.external_id,
          redactedDisplayName: input.assigneeDisplayName,
        },
    assigneeClass,
  );
  return syncOwnerFromTracker(current, {
    assignee: stored,
    assigneeClass,
    at: options.clock.now() as IsoDateTime,
  });
};

/**
 * `task.owner.changed`, on the task's stream at `streamSeq`, carrying the `owner_changed_at` the
 * same write stored (S-26.3: what the write-back duty re-validates against on fire).
 */
const ownerChangedEvent = (
  options: OwnerSyncOptions,
  input: {
    readonly projectId: Id;
    readonly taskId: Id;
    readonly streamSeq: number;
    readonly change: OwnerChange;
    readonly changedAt: IsoDateTime | null;
    readonly actor: DomainEvent['actor'];
    readonly causeEventId: Id | null;
  },
): DomainEvent =>
  domainEventSchemasByType['task.owner.changed'].parse({
    id: options.ids.next(),
    stream_type: 'task',
    stream_id: input.taskId,
    stream_seq: input.streamSeq,
    correlation_id: input.taskId,
    cause_event_id: input.causeEventId,
    actor: input.actor,
    occurred_at: options.clock.now(),
    type: 'task.owner.changed',
    payload: {
      project_id: input.projectId,
      task_id: input.taskId,
      owner_user_id: input.change.ownerUserId,
      previous_owner_user_id: input.change.previousOwnerUserId,
      source: input.change.source,
      via: input.change.via,
      ...(input.changedAt === null ? {} : { owner_changed_at: input.changedAt }),
    },
  }) as DomainEvent;

/** Writes a decision over `current`, or throws {@link TaskOwnerConflictError} when the row moved. */
const writeDecision = async (
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
 * One decision applied **from outside the task's own transactions** (the module's § The stream):
 * decide over a plain read; when it writes anything, take the row lock (`bumpVersion`), read and
 * decide again under it, write, and append at the committed sequence when it records a change.
 * Answers the change recorded.
 */
const applyOnTaskStream = async (
  options: OwnerSyncOptions,
  scope: Pick<TransactionScope, 'tx' | 'events'>,
  input: {
    readonly projectId: Id;
    readonly taskId: Id;
    readonly actor: DomainEvent['actor'];
    readonly causeEventId: Id | null;
    readonly decide: (current: TaskOwnership) => Promise<OwnershipDecision>;
  },
): Promise<OwnerChange | null> => {
  const { store } = options;
  let current = await store.tasks.ownership(scope.tx, input.taskId);
  let decision = await input.decide(current);
  if (decision.kind === 'write') {
    // Any write takes the row lock — an assignee-only one too (the review of PR #92): a concurrent
    // owner command then waits and decides over this write, rather than this compare-and-set
    // losing to it and failing the stage job's or the duty's try.
    await store.tasks.bumpVersion(scope.tx, input.taskId);
    current = await store.tasks.ownership(scope.tx, input.taskId);
    decision = await input.decide(current);
  }
  await writeDecision(store, scope.tx, input.taskId, current, decision);
  if (decision.kind === 'unchanged' || decision.change === null) {
    return null;
  }
  const loaded = await store.tasks.load(scope.tx, input.taskId);
  if (loaded === null) {
    throw new TaskOwnerConflictError(input.taskId);
  }
  await scope.events.append([
    ownerChangedEvent(options, {
      projectId: input.projectId,
      taskId: input.taskId,
      streamSeq: loaded.task.sequence,
      change: decision.change,
      changedAt: decision.next.ownerChangedAt,
      actor: input.actor,
      causeEventId: input.causeEventId,
    }),
  ]);
  return decision.change;
};

/**
 * **Intake's sync**, in the insert's own transaction, for the task the transaction just inserted:
 * the read assignee becomes `ticket_assignee`, and the owner the linked `member` it maps to. The
 * caller appends the answered event after the creation's own, because the stream's sequence is
 * the aggregate's there — `streamSeqAfter` names the next free one ({@link nextTaskSequence}).
 */
export const syncOwnerAtIntake = async (
  options: OwnerSyncOptions,
  tx: Transaction,
  input: {
    readonly projectId: Id;
    readonly taskId: Id;
    readonly read: Pick<TicketRead, 'assignee' | 'assigneeDisplayName'> | null;
    readonly causeEventId: Id;
  },
): Promise<((streamSeq: number) => DomainEvent) | null> => {
  if (input.read === null || input.read.assignee === null) {
    // An unassigned ticket, or one intake could not read: nothing to store, nothing to compare.
    return null;
  }
  const current = await options.store.tasks.ownership(tx, input.taskId);
  const decision = await trackerDecision(
    options,
    tx,
    {
      projectId: input.projectId,
      assignee: input.read.assignee,
      assigneeDisplayName: input.read.assigneeDisplayName,
    },
    current,
  );
  await writeDecision(options.store, tx, input.taskId, current, decision);
  if (decision.kind === 'unchanged' || decision.change === null) {
    return null;
  }
  const change = decision.change;
  const changedAt = decision.next.ownerChangedAt;
  return (streamSeq) =>
    ownerChangedEvent(options, {
      projectId: input.projectId,
      taskId: input.taskId,
      streamSeq,
      change,
      changedAt,
      actor: PIPELINE_ACTOR,
      causeEventId: input.causeEventId,
    });
};

/** The next `stream_seq` of a task's stream after `events` — the last of the task's own, plus one. */
export const nextTaskSequence = (events: readonly DomainEvent[], taskId: Id): number =>
  Math.max(
    0,
    ...events
      .filter((event) => event.stream_type === 'task' && event.stream_id === taskId)
      .map((event) => event.stream_seq),
  ) + 1;

/**
 * The hook a re-read passes to `ensureTicketSnapshot` (the `stage.execute` job, the `owner_sync`
 * duty): the read's assignee applied to the task's owner, in the transaction that stores the read.
 */
export const ownerSyncOnRead =
  (options: OwnerSyncOptions, causeEventId: Id | null = null): TicketReadHook =>
  async (scope, current: StoredTask, read) => {
    await applyOnTaskStream(options, scope, {
      projectId: current.task.projectId,
      taskId: current.task.id,
      actor: PIPELINE_ACTOR,
      causeEventId,
      decide: async (ownership) =>
        trackerDecision(
          options,
          scope.tx,
          {
            projectId: current.task.projectId,
            assignee: read.assignee,
            assigneeDisplayName: read.assigneeDisplayName,
          },
          ownership,
        ),
    });
  };

export interface OwnerSyncDutyOptions extends EnsureTicketSnapshotOptions, OwnerSyncOptions {
  readonly unitOfWork: UnitOfWork;
}

/**
 * `pipeline.outbound` duty **owner_sync** (TD-031's amendment item 2): re-validates on fire (TD-004)
 * — the task must still exist and be live — then re-reads the ticket only while its snapshot is
 * stale, and applies the read's assignee. **One read per burst** (the module's § Where the tracker
 * is read). No provider call is made inside a transaction: the read is `readTicketForTask`'s,
 * between this duty's two.
 */
export const runOwnerSync = async (
  options: OwnerSyncDutyOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  if (data.task_id === undefined) {
    return;
  }
  const taskId = data.task_id as Id;
  const stored = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.load(scope.tx, taskId),
  );
  if (stored === null || isTerminalTaskState(stored.task.state)) {
    (options.logger ?? silentLogger).debug(
      { task_id: taskId },
      'owner_sync: the task is gone or finished, so its ticket is not read',
    );
    return;
  }
  await ensureTicketSnapshot(
    options,
    stored,
    ownerSyncOnRead(options, (data.cause_event_id ?? null) as Id | null),
  );
};

/**
 * `ticket.updated` → the `owner_sync` duty for the ticket's live task. Priority **120**, the
 * integrations band: it enqueues after the commit and reads nothing else, because a job is a
 * wake-up and not a message (TD-004). `pipeline.ticket.signal` (priority 10) has stamped the
 * signal in the same dispatch, which is what makes the snapshot stale for the duty.
 */
export const ownerSyncHandler = (options: {
  readonly store: PipelineStore;
  readonly jobs: Jobs;
}): EventHandler => ({
  name: OWNER_SYNC_HANDLER,
  priority: 120,
  eventTypes: ['ticket.updated'],
  handle: async (context) => {
    const event = context.event.event;
    if (event.type !== 'ticket.updated') {
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
    const data: PipelineOutboundData = {
      duty: 'owner_sync',
      project_id: event.payload.project_id,
      task_id: stored.task.id,
      cause_event_id: event.id,
    };
    // `enqueueOutbound`'s shape, written out: importing it from `jobs.ts` closes a module cycle.
    context.afterCommit(async () => {
      await options.jobs.enqueue<OutboundJobData>({ queue: JOB_QUEUES.pipelineOutbound, data });
    });
  },
});

/** The handlers this module registers (`createPipelineRuntime`). */
export const ownerSyncHandlers = (options: {
  readonly store: PipelineStore;
  readonly jobs: Jobs;
}): readonly EventHandler[] => [ownerSyncHandler(options)];

export interface TaskOwnerCommandDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: PipelineStore;
  readonly ids: { next(): Id };
  readonly clock: { now(): string };
  readonly logger?: Logger;
}

/**
 * `POST /api/tasks/:id/owner` (TD-031's amendment item 3): the matrix, the target's role and the
 * task's state, decided by `decideOwnerCommand` over a read taken under the row lock, on the
 * conflict bound (`retryOnTaskConflict`). A refusal throws {@link OwnerChangeRefusedError} and
 * writes nothing; a permitted change to the owner the task already has answers `changed: false`.
 * `ticket_assignee` is not touched: a platform assignment survives until the tracker changes.
 */
export const setTaskOwnerCommand = async (
  deps: TaskOwnerCommandDependencies,
  input: {
    readonly taskId: Id;
    readonly actorUserId: Id;
    /** The caller's effective role in the task's project — the role the route's guard resolved. */
    readonly actorRole: UserRole;
    readonly targetUserId: Id | null;
  },
): Promise<{ readonly changed: boolean; readonly ownerUserId: Id | null }> => {
  const options: OwnerSyncOptions = {
    store: deps.store,
    ids: deps.ids,
    clock: deps.clock,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  };
  return retryOnTaskConflict(
    {
      taskId: input.taskId,
      what: 'changing the task’s owner',
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    },
    async () =>
      deps.unitOfWork.transaction(async (scope) => {
        // The row lock first, always: the command reads `held elsewhere` and the owner under it, so
        // the matrix is asked of the row it then writes.
        await deps.store.tasks.bumpVersion(scope.tx, input.taskId);
        const stored = await deps.store.tasks.load(scope.tx, input.taskId);
        if (stored === null) {
          throw new TaskOwnerConflictError(input.taskId);
        }
        const projectId = stored.task.projectId;
        const targetMayOwn =
          input.targetUserId === null
            ? true
            : await deps.store.owners.mayOwn(scope.tx, { projectId, userId: input.targetUserId });
        const decide = async (current: TaskOwnership): Promise<OwnershipDecision> => {
          const decision = decideOwnerCommand(current, {
            actorUserId: input.actorUserId,
            actorRole: input.actorRole,
            taskState: stored.task.state,
            heldElsewhere: await heldElsewhereNow(deps.store, scope.tx, projectId, current),
            targetUserId: input.targetUserId,
            targetMayOwn,
            at: options.clock.now() as IsoDateTime,
          });
          if (decision.kind === 'refused') {
            throw new OwnerChangeRefusedError(input.taskId, decision.reason);
          }
          return decision;
        };
        const change = await applyOnTaskStream(options, scope, {
          projectId,
          taskId: input.taskId,
          actor: { kind: 'user', user_id: input.actorUserId },
          causeEventId: null,
          decide,
        });
        const after = await deps.store.tasks.ownership(scope.tx, input.taskId);
        return { changed: change !== null, ownerUserId: after.ownerUserId };
      }),
  );
};

/**
 * **The hook S-26.6 calls when a person's tracker identity is linked** (TD-031's amendment item 2's
 * last sentence): every live task nobody owns whose stored assignee is that identity gets the
 * linked user as its owner — `via: link`, `source: tracker` — when the directory says, at that
 * moment, that the identity is a `person` linked to that very user and that they are a `member` or
 * above of the task's project.
 * **No provider call**: the identity was read already; this asks only the rows. One transaction per
 * task, each on the conflict bound, so one busy task never holds back the rest. Answers the tasks
 * whose owner it set. `onAdopted` (S-26.6) is told each one **as its transaction commits**, so a
 * caller still knows what was adopted when a later task throws and the answer is never returned.
 */
export const adoptOwnersOnLink = async (
  deps: TaskOwnerCommandDependencies,
  link: { readonly userId: Id; readonly provider: string; readonly externalId: string },
  onAdopted?: (taskId: Id) => void,
): Promise<readonly Id[]> => {
  const options: OwnerSyncOptions = {
    store: deps.store,
    ids: deps.ids,
    clock: deps.clock,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  };
  const candidates = await deps.unitOfWork.transaction(async (scope) =>
    deps.store.tasks.unownedLiveByAssignee(scope.tx, {
      provider: link.provider,
      externalId: link.externalId,
    }),
  );
  const adopted: Id[] = [];
  for (const candidate of candidates) {
    const change = await retryOnTaskConflict(
      {
        taskId: candidate.taskId,
        what: 'adopting a linked owner',
        ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      },
      async () =>
        deps.unitOfWork.transaction(async (scope) => {
          // The link is re-checked against the directory, not taken on the caller's word (the
          // review of PR #92): the identity must map, now, to this very user as a `member` or above
          // of the task's project.
          const linked = await deps.store.owners.classifyAssignee(scope.tx, {
            projectId: candidate.projectId,
            provider: link.provider,
            externalId: link.externalId,
          });
          const userMayOwn = linked.kind === 'member' && linked.userId === link.userId;
          return applyOnTaskStream(options, scope, {
            projectId: candidate.projectId,
            taskId: candidate.taskId,
            actor: PIPELINE_ACTOR,
            causeEventId: null,
            decide: async (current) =>
              adoptOwnerOnLink(current, {
                provider: link.provider,
                externalId: link.externalId,
                userId: link.userId,
                userMayOwn,
                at: options.clock.now() as IsoDateTime,
              }),
          });
        }),
    );
    if (change !== null) {
      adopted.push(candidate.taskId);
      onAdopted?.(candidate.taskId);
    }
  }
  return adopted;
};
