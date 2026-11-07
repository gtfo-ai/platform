/**
 * **A task has an owner** — the decisions, pure (S-26.1, TD-031's 2026-11-06 amendment items 1–3,
 * BD-031's 2026-11-06 amendment 1).
 *
 * Every write of a task's owner is decided here and nowhere else, and recorded as
 * `task.owner.changed`; the application ring reads the rows, asks these functions, and writes what
 * they answer through the one narrow writer (`TaskRepository.saveOwner`). Three rules:
 *
 * 1. **Latest change wins.** A tracker read changes anything only when the assignee it reads is a
 *    different identity from the one last read (`ticket_assignee`). Then the stored assignee is
 *    replaced and the owner follows it: the mapped `member`-or-above person, or nobody. So a
 *    platform assignment made after a read survives every later read that names the same assignee,
 *    and a tracker change made after a platform assignment replaces it. A read that names the
 *    identity already stored — including the claim's own `assignToSelf` and the release's
 *    `unassign`, which write `ticket_assignee` in their own transactions (S-26.2,
 *    {@link recordPlatformAssign}, {@link recordPlatformUnassign}) — is never a change. **A read that
 *    names a platform assignee** (the binding's own account, a machine) replaces the stored
 *    assignee and **never changes the owner** (the review of PR #92): it is the claim's own assign
 *    read back — S-26.2 records that assign, so this guard now covers what the record cannot (a
 *    claim made before S-26.2, a machine a person assigned) — and an owner a person set must
 *    survive it. TD-031's amendment item 2 reads such an assignee as *nobody*; that is what it
 *    still means for a task with no owner, and only an owner already held is kept.
 * 2. **An owner is a `member` or above of the project.** The caller answers that question
 *    (`classifyAssignee`, `mayOwn`) and hands the answer in; a mapped person below `member` is shown
 *    as an assignee and is never an owner.
 * 3. **Held elsewhere** ({@link taskHeldElsewhere}): the ticket's stored assignee names a person
 *    (not the platform's own account or a machine) who is not a linked `member`-or-above of the
 *    project. A task with no owner that is not held elsewhere is **unassigned**
 *    ({@link taskIsUnassigned}) — what a member may take, what a pick assigns, and what a
 *    *mine-and-unassigned* machine takes (S-26.4). The SQL spelling of the same predicate, which the
 *    claim reads live, is `taskHeldElsewhereSql` in `packages/infrastructure/src/pipeline/running-role.ts`.
 *
 * Nothing here reads a clock or a row: the instant arrives as an argument.
 */
import type {
  Id,
  IsoDateTime,
  TaskOwnerSource,
  TaskOwnerVia,
  TaskState,
  TicketAssignee,
  UserRole,
} from '@platform/contracts';
import { TICKET_ASSIGNEE_NAME_MAX_CHARS } from '@platform/contracts';
import { TERMINAL_TASK_STATES } from '../aggregates/task-state-machine.js';
import { can } from '../permissions.js';

/** The four ownership columns of a task (migration 0104). */
export interface TaskOwnership {
  readonly ownerUserId: Id | null;
  readonly ownerSource: TaskOwnerSource | null;
  readonly ownerChangedAt: IsoDateTime | null;
  readonly ticketAssignee: TicketAssignee | null;
}

/** A task nobody has owned and whose tracker assignee was never read — every row before 0104. */
export const UNOWNED: TaskOwnership = {
  ownerUserId: null,
  ownerSource: null,
  ownerChangedAt: null,
  ticketAssignee: null,
};

/**
 * What the platform can say about a tracker assignee, asked of `user_identities`, the project's
 * roles and the binding's own account by the caller:
 *
 *  - `member`: a `person` identity linked to a user whose effective role in the project is
 *    `member` or above — the owner a sync gives the task;
 *  - `platform`: the binding's own account (unless it maps to such a member) or a `machine`
 *    identity — never an owner, never a reason the task is held elsewhere;
 *  - `person`: anybody else — an unlinked account, or a linked user below `member`.
 */
export type AssigneeClass =
  | { readonly kind: 'member'; readonly userId: Id }
  | { readonly kind: 'platform' }
  | { readonly kind: 'person' };

/** One owner change, as `task.owner.changed` records it. */
export interface OwnerChange {
  readonly ownerUserId: Id | null;
  readonly previousOwnerUserId: Id | null;
  readonly source: TaskOwnerSource;
  readonly via: TaskOwnerVia;
}

/**
 * What a decision writes: the next value of the four columns, and the owner change to record — or
 * `null` when only the stored assignee moved (an unlinked person replaced by another), which changes
 * no owner and records no event.
 */
export interface OwnershipWrite {
  readonly kind: 'write';
  readonly next: TaskOwnership;
  readonly change: OwnerChange | null;
}

export type OwnershipDecision = { readonly kind: 'unchanged' } | OwnershipWrite;

/** Two reads name the same assignee when they name the same provider identity (the name may drift). */
export const sameTicketAssignee = (
  a: Pick<TicketAssignee, 'provider' | 'external_id'> | null,
  b: Pick<TicketAssignee, 'provider' | 'external_id'> | null,
): boolean =>
  a === null || b === null ? a === b : a.provider === b.provider && a.external_id === b.external_id;

/**
 * A display name cut to the column's bound — whole code points, never half a surrogate pair, and
 * at most {@link TICKET_ASSIGNEE_NAME_MAX_CHARS} UTF-16 units, which is what the schema counts.
 */
const boundName = (name: string): string => {
  let bounded = '';
  for (const character of name) {
    if (bounded.length + character.length > TICKET_ASSIGNEE_NAME_MAX_CHARS) {
      break;
    }
    bounded += character;
  }
  return bounded;
};

/**
 * The stored assignee for a read: the identity, the display name **already redacted** by the caller
 * (the binding's redactor is an application concern) and cut here to the column's bound, and
 * whether it is the platform's own. `null` for an unassigned ticket.
 */
export const ticketAssigneeOf = (
  read: {
    readonly provider: string;
    readonly externalId: string;
    readonly redactedDisplayName: string | null;
  } | null,
  assigneeClass: AssigneeClass | null,
): TicketAssignee | null => {
  if (read === null) {
    return null;
  }
  const name = read.redactedDisplayName;
  return {
    provider: read.provider.slice(0, 255),
    external_id: read.externalId.slice(0, 255),
    display_name: name === null || name.length === 0 ? null : boundName(name),
    platform: assigneeClass?.kind === 'platform',
  };
};

/**
 * **Held elsewhere**: the ticket's stored assignee is a person — not the platform's own account,
 * not a machine — who is not a linked `member`-or-above of the project. `assigneeIsLinkedMember` is
 * the caller's live answer for the stored identity (TD-031's amendment item 6: read through
 * `user_identities` at the moment of asking, so a link made since the read counts). Independent of
 * the owner: a maintainer may own a task whose ticket an unlinked person holds.
 */
export const taskHeldElsewhere = (input: {
  readonly ticketAssignee: TicketAssignee | null;
  readonly assigneeIsLinkedMember: boolean;
}): boolean =>
  input.ticketAssignee !== null && !input.ticketAssignee.platform && !input.assigneeIsLinkedMember;

/**
 * **Unassigned**: no owner, and not held elsewhere — the task a member may take and a pick assigns.
 * A task a linked member released (owner `null`, the ticket still theirs in the tracker) is
 * unassigned.
 */
export const taskIsUnassigned = (input: {
  readonly ownerUserId: Id | null;
  readonly heldElsewhere: boolean;
}): boolean => input.ownerUserId === null && !input.heldElsewhere;

/**
 * A tracker read applied to a task (intake, a stage's re-read, the `owner_sync` duty): rule 1 of
 * the module docblock. `assignee` is the stored shape of what was read ({@link ticketAssigneeOf}),
 * `assigneeClass` what the platform says about it; both `null` for an unassigned ticket.
 */
export const syncOwnerFromTracker = (
  current: TaskOwnership,
  read: {
    readonly assignee: TicketAssignee | null;
    readonly assigneeClass: AssigneeClass | null;
    readonly at: IsoDateTime;
  },
): OwnershipDecision => {
  if (sameTicketAssignee(current.ticketAssignee, read.assignee)) {
    return { kind: 'unchanged' };
  }
  if (read.assigneeClass?.kind === 'platform' || read.assignee?.platform === true) {
    // **A platform assignee is never an owner change** (the review of PR #92): the binding's own
    // account or a machine in the tracker is the claim's `assignToSelf` read back — until S-26.2
    // stops that re-assignment, a task a person took before its first claim would otherwise lose
    // its owner at the next read. The stored assignee is replaced so the next read compares
    // against it; the owner, its source and its instant stay as they were.
    return { kind: 'write', next: { ...current, ticketAssignee: read.assignee }, change: null };
  }
  const owner = read.assigneeClass?.kind === 'member' ? read.assigneeClass.userId : null;
  if (owner === current.ownerUserId) {
    // The assignee moved and the owner it maps to did not: the stored assignee is replaced (so the
    // next read compares against it) and nothing about ownership changed.
    return { kind: 'write', next: { ...current, ticketAssignee: read.assignee }, change: null };
  }
  return {
    kind: 'write',
    next: {
      ownerUserId: owner,
      ownerSource: 'tracker',
      ownerChangedAt: read.at,
      ticketAssignee: read.assignee,
    },
    change: {
      ownerUserId: owner,
      previousOwnerUserId: current.ownerUserId,
      source: 'tracker',
      via: 'tracker_sync',
    },
  };
};

/**
 * **The platform's own tracker write, recorded as the last-seen assignee** (S-26.2, TD-031's
 * amendment item 2): the claim's `assignToSelf` writes the binding's account into `ticket_assignee`
 * in the claim's own transaction, so the next read — which names that account — is no change
 * (rule 1) and costs nobody their owner. The owner, its source and its instant are kept; nothing
 * is recorded. `assignee` is the stored shape of the binding's account ({@link ticketAssigneeOf}).
 */
export const recordPlatformAssign = (
  current: TaskOwnership,
  assignee: TicketAssignee,
): OwnershipDecision =>
  sameTicketAssignee(current.ticketAssignee, assignee)
    ? { kind: 'unchanged' }
    : { kind: 'write', next: { ...current, ticketAssignee: assignee }, change: null };

/**
 * **The release's `unassign`, recorded** (S-26.2): when the release took the binding's own account
 * off the ticket, `ticket_assignee` becomes nobody in the release's transaction — but only while it
 * still names that account, so a person read since is never overwritten. Without it the next read
 * (nobody) would differ from the stored account and cost a platform-set owner the task after a
 * *Rework*. The owner is kept; nothing is recorded.
 */
export const recordPlatformUnassign = (
  current: TaskOwnership,
  self: Pick<TicketAssignee, 'provider' | 'external_id'>,
): OwnershipDecision =>
  current.ticketAssignee !== null && sameTicketAssignee(current.ticketAssignee, self)
    ? { kind: 'write', next: { ...current, ticketAssignee: null }, change: null }
    : { kind: 'unchanged' };

/**
 * A link made later adopts the owner (TD-031's amendment item 2's last sentence, the hook S-26.6
 * calls): a task with **no owner** whose stored assignee is the newly linked identity, linked to a
 * user who may own it, gets that user — with no provider call, because the identity was read
 * already. A task somebody owns keeps its owner (latest change wins: nothing in the tracker moved).
 */
export const adoptOwnerOnLink = (
  current: TaskOwnership,
  link: {
    readonly provider: string;
    readonly externalId: string;
    readonly userId: Id;
    readonly userMayOwn: boolean;
    readonly at: IsoDateTime;
  },
): OwnershipDecision => {
  if (
    current.ownerUserId !== null ||
    !link.userMayOwn ||
    current.ticketAssignee === null ||
    current.ticketAssignee.platform ||
    !sameTicketAssignee(current.ticketAssignee, {
      provider: link.provider,
      external_id: link.externalId,
    })
  ) {
    return { kind: 'unchanged' };
  }
  return {
    kind: 'write',
    next: { ...current, ownerUserId: link.userId, ownerSource: 'tracker', ownerChangedAt: link.at },
    change: {
      ownerUserId: link.userId,
      previousOwnerUserId: null,
      source: 'tracker',
      via: 'link',
    },
  };
};

/** Who a command names, from the caller's side: themselves, nobody, or another person. */
export type OwnerTarget = 'self' | 'nobody' | 'another';

/** The command's target as the caller sees it. */
export const ownerTargetOf = (actorUserId: Id, target: Id | null): OwnerTarget =>
  target === null ? 'nobody' : target === actorUserId ? 'self' : 'another';

/**
 * **The permission matrix** of the M26 UX spec § 2 and TD-031's amendment item 3 — the one function
 * the route decides with and the task DTO's `can_take`/`can_assign`/`can_unassign` are computed
 * from ({@link ownerCapabilities}):
 *
 * | | member | maintainer+ |
 * |---|---|---|
 * | take an **unassigned** task (no owner, not held elsewhere) | yes | yes |
 * | take a task somebody owns, or one held elsewhere | no | yes |
 * | assign another person | no | yes |
 * | unassign | only their own | yes |
 *
 * Below `member` nothing is permitted. Naming oneself on a task one already owns is permitted (a
 * no-op). The target's own role and the task's state are separate questions
 * ({@link decideOwnerCommand}).
 */
export const ownerChangePermitted = (input: {
  readonly actorUserId: Id;
  readonly actorRole: UserRole;
  readonly ownerUserId: Id | null;
  readonly heldElsewhere: boolean;
  readonly target: OwnerTarget;
}): boolean => {
  if (can(input.actorRole, 'task.owner.assign')) {
    return true;
  }
  if (!can(input.actorRole, 'task.owner.take')) {
    return false;
  }
  switch (input.target) {
    case 'self':
      return (
        input.ownerUserId === input.actorUserId ||
        taskIsUnassigned({ ownerUserId: input.ownerUserId, heldElsewhere: input.heldElsewhere })
      );
    case 'nobody':
      return input.ownerUserId === input.actorUserId;
    case 'another':
      return false;
  }
};

/** The states from which no owner change is made: a finished task is nobody's work any more. */
const FINISHED_STATES: ReadonlySet<TaskState> = new Set<TaskState>(TERMINAL_TASK_STATES);

/** Why a command was refused — each a status of its own at the route. */
export type OwnerCommandRefusal =
  /** 403: the matrix does not let this caller make this change. */
  | 'owner_change_not_permitted'
  /** 422: the user named is not a `member` or above of the project. */
  | 'owner_not_project_member'
  /** 409: the task is done or cancelled. */
  | 'task_finished';

export type OwnerCommandDecision =
  | { readonly kind: 'refused'; readonly reason: OwnerCommandRefusal }
  | OwnershipDecision;

/**
 * `POST /api/tasks/:id/owner`, decided: the matrix, then the target's role, then the state — so a
 * caller who may not act learns nothing about whom they named. A permitted change to the owner the
 * task already has is `unchanged`.
 */
export const decideOwnerCommand = (
  current: TaskOwnership,
  input: {
    readonly actorUserId: Id;
    readonly actorRole: UserRole;
    readonly taskState: TaskState;
    readonly heldElsewhere: boolean;
    readonly targetUserId: Id | null;
    /** Whether the target is a `member` or above of the project; ignored for `null`. */
    readonly targetMayOwn: boolean;
    readonly at: IsoDateTime;
  },
): OwnerCommandDecision => {
  const permitted = ownerChangePermitted({
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    ownerUserId: current.ownerUserId,
    heldElsewhere: input.heldElsewhere,
    target: ownerTargetOf(input.actorUserId, input.targetUserId),
  });
  if (!permitted) {
    return { kind: 'refused', reason: 'owner_change_not_permitted' };
  }
  if (input.targetUserId !== null && !input.targetMayOwn) {
    return { kind: 'refused', reason: 'owner_not_project_member' };
  }
  if (FINISHED_STATES.has(input.taskState)) {
    return { kind: 'refused', reason: 'task_finished' };
  }
  if (input.targetUserId === current.ownerUserId) {
    return { kind: 'unchanged' };
  }
  // `ticket_assignee` is left as it was read: a platform assignment does not touch it, so the next
  // sync changes nothing until somebody changes the tracker (rule 1).
  return {
    kind: 'write',
    next: {
      ...current,
      ownerUserId: input.targetUserId,
      ownerSource: 'platform',
      ownerChangedAt: input.at,
    },
    change: {
      ownerUserId: input.targetUserId,
      previousOwnerUserId: current.ownerUserId,
      source: 'platform',
      via: 'command',
    },
  };
};

/** The owner control the task page offers this caller — the M26 UX spec § 2. */
export interface OwnerCapabilities {
  /** *Take it*: the caller is not the owner and may name themselves. */
  readonly can_take: boolean;
  /** *Assign…*: the caller may name another person. */
  readonly can_assign: boolean;
  /** *Unassign*: the task has an owner and the caller may name nobody. */
  readonly can_unassign: boolean;
}

/**
 * The task DTO's three flags, from {@link ownerChangePermitted} — the function the route decides
 * with — so the page offers a control only to a caller the route would admit. A finished task, and
 * a caller with no role, are offered nothing.
 */
export const ownerCapabilities = (input: {
  readonly actorUserId: Id;
  readonly actorRole: UserRole | undefined;
  readonly ownerUserId: Id | null;
  readonly heldElsewhere: boolean;
  readonly taskState: TaskState;
}): OwnerCapabilities => {
  const role = input.actorRole;
  if (role === undefined || FINISHED_STATES.has(input.taskState)) {
    return { can_take: false, can_assign: false, can_unassign: false };
  }
  const permitted = (target: OwnerTarget): boolean =>
    ownerChangePermitted({
      actorUserId: input.actorUserId,
      actorRole: role,
      ownerUserId: input.ownerUserId,
      heldElsewhere: input.heldElsewhere,
      target,
    });
  return {
    can_take: input.ownerUserId !== input.actorUserId && permitted('self'),
    can_assign: permitted('another'),
    can_unassign: input.ownerUserId !== null && permitted('nobody'),
  };
};

/**
 * Why a pick of a **stage** offer was refused (S-26.4, TD-031's amendment item 7): another person
 * owns the task. A pick never takes another person's task — a maintainer's included; reassigning
 * is the task page's (`decideOwnerCommand`).
 *
 * - `task_taken_by_another` — the owner changed after the list the person picked from was read
 *   (`asOf`): *they took it a moment ago*;
 * - `task_owned_by_another` — it was already theirs when the list was read, or no list instant was
 *   given.
 */
export type PickRefusal = 'task_taken_by_another' | 'task_owned_by_another';

/** Which of the two refusals, by the owner's last change against the list's `asOf`. */
export const pickRefusalOf = (
  ownerChangedAt: IsoDateTime | null,
  asOf: IsoDateTime | null,
): PickRefusal =>
  asOf !== null && ownerChangedAt !== null && Date.parse(ownerChangedAt) > Date.parse(asOf)
    ? 'task_taken_by_another'
    : 'task_owned_by_another';

export type PickOwnerDecision =
  | { readonly kind: 'refused'; readonly ownerUserId: Id }
  | OwnershipDecision;

/**
 * **A pick assigns** (S-26.4, TD-031's amendment item 7, BD-032's amendment 3), decided in the
 * claim's transaction over the row it locked:
 *
 * - a task another person owns is **refused** (the claim rolls back);
 * - a task the picker owns already changes nothing;
 * - an **unassigned** task ({@link taskIsUnassigned}) gets the picker as its owner — `source:
 *   platform`, `via: pick` — with `ticket_assignee` left as it was read (rule 1: the next sync keeps
 *   it until somebody changes the tracker);
 * - a task **held elsewhere** (an unlinked or non-member assignee, admitted by
 *   `take_assigned_tickets`) is claimed **without assigning**: the platform cannot map that
 *   assignee, and a platform owner over them would make the two records disagree silently.
 *
 * `pickerMayOwn` is the caller's live answer (`userMayOwnInProjectSql`); the claim's eligibility
 * already asked the same of the worker's user, so `false` here is a defence, and it claims without
 * assigning rather than refusing.
 */
export const decidePickOwner = (
  current: TaskOwnership,
  input: {
    readonly pickerUserId: Id;
    readonly heldElsewhere: boolean;
    readonly pickerMayOwn: boolean;
    readonly at: IsoDateTime;
  },
): PickOwnerDecision => {
  if (current.ownerUserId !== null && current.ownerUserId !== input.pickerUserId) {
    return { kind: 'refused', ownerUserId: current.ownerUserId };
  }
  if (
    current.ownerUserId === input.pickerUserId ||
    input.heldElsewhere ||
    !input.pickerMayOwn ||
    !taskIsUnassigned({ ownerUserId: current.ownerUserId, heldElsewhere: input.heldElsewhere })
  ) {
    return { kind: 'unchanged' };
  }
  return {
    kind: 'write',
    next: {
      ...current,
      ownerUserId: input.pickerUserId,
      ownerSource: 'platform',
      ownerChangedAt: input.at,
    },
    change: {
      ownerUserId: input.pickerUserId,
      previousOwnerUserId: null,
      source: 'platform',
      via: 'pick',
    },
  };
};
