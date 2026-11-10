/**
 * **Which tracker statuses start work, and which mean a person finished the ticket** — the M28
 * rulings 1–3 (S-28.4), amending TD-029.
 *
 * A pick-up label says a ticket is *meant* for the platform; it does not say the ticket is *ready*.
 * On the dogfood installation a ticket a person had delivered and released three weeks earlier still
 * carried the label, and the poll started it again. So the binding's lifecycle block carries a
 * **status policy** beside its slots:
 *
 *  - `start_from` — the statuses work is started from. Absent: every status whose tracker category
 *    is **To Do**. `pickup_status` (the `pick_up_from` slot) is always startable: it is the binding's
 *    own statement of when a ticket is ready.
 *  - `closed` — the statuses that mean a person finished the ticket. Absent: every status whose
 *    category is **Done**.
 *  - `on_ticket_closed` — `stop` (default) or `ignore`, read by the reverse sync.
 *
 * A status of an **unknown** category is never startable. Every name is compared as the slots
 * compare ({@link lifecycleStatusKey}: trimmed, case-insensitive).
 *
 * This module is pure: the caller hands in the status it read, the category the provider reported
 * (`null` when it reported none — which is not the same as `unknown`, a category the provider
 * reported and the platform does not recognise) and the policy. Every door asks it: the poll's
 * query and the webhook's rule (the provider adapters, which render the same policy into their own
 * terms), intake ({@link intakeStatusDecision}) and the claim before the first run
 * ({@link claimStatusDecision}).
 */
import type {
  LifecycleSingleSlot,
  TicketLifecycle,
  TicketStatusCategory,
} from '@platform/contracts';
import { LIFECYCLE_SINGLE_SLOTS, lifecycleStatusKey } from '@platform/contracts';
import { lifecycleMapsAnySlot } from './claim.js';

/** A binding's status policy, as every door reads it. */
export interface TicketStatusPolicy {
  /** `pickup_status` — the `pick_up_from` slot — or `null` when the binding picks up by label. */
  readonly pickUpFrom: string | null;
  /** `start_from`, or `null` for the tracker's To Do category. */
  readonly startFrom: readonly string[] | null;
  /** `closed`, or `null` for the tracker's Done category. */
  readonly closed: readonly string[] | null;
  readonly onTicketClosed: 'stop' | 'ignore';
  /**
   * The statuses the platform's own lifecycle writes or reads as a person handing work back: the
   * five single slots and `returned` (TD-029 decision 1). For a ticket the platform holds, a move
   * into one of these is the platform's own (or a human return), never a person taking it.
   */
  readonly platformStatuses: readonly string[];
  /**
   * **Which moment writes each of those statuses** (S-28.11): a lifecycle slot, `returned`, or a
   * `status_mapping` key (a stage or a task state). {@link platformWrittenStatuses} reads it against
   * how far a task has got, so a status is exempt only once the platform has actually put the ticket
   * there for that task.
   */
  readonly platformWriters: readonly PlatformStatusWriter[];
}

/** One status the platform may write, and the moment that writes it. */
export type PlatformStatusWriter =
  | { readonly status: string; readonly slot: LifecycleSingleSlot | 'returned' }
  | { readonly status: string; readonly mappingKey: string };

/**
 * The policy of a binding: its `pickup_status` and its `lifecycle` block, which may be absent — the
 * policy's defaults apply to **every** binding, block or not (M28 ruling 1: the default changes
 * behaviour for existing bindings, deliberately).
 */
export const ticketStatusPolicyOf = (
  pickUpFrom: string | null,
  block: TicketLifecycle | null | undefined,
): TicketStatusPolicy => ({
  pickUpFrom,
  startFrom: block?.start_from ?? null,
  closed: block?.closed ?? null,
  onTicketClosed: block?.on_ticket_closed ?? 'stop',
  platformStatuses:
    block === null || block === undefined
      ? []
      : [
          ...LIFECYCLE_SINGLE_SLOTS.flatMap((slot) => {
            const name = block[slot];
            return name === undefined ? [] : [name];
          }),
          ...(block.returned ?? []),
        ],
  platformWriters:
    block === null || block === undefined
      ? []
      : [
          ...LIFECYCLE_SINGLE_SLOTS.flatMap((slot): PlatformStatusWriter[] => {
            const name = block[slot];
            return name === undefined ? [] : [{ status: name, slot }];
          }),
          ...(block.returned ?? []).map(
            (name): PlatformStatusWriter => ({ status: name, slot: 'returned' }),
          ),
        ],
});

/**
 * **How far a task has got through the moments that write the ticket** (S-28.11): the stages it has
 * entered (`Task.stageAttempts`' keys — every entry is recorded there, and nothing else writes it),
 * its state now, and whether its claim recorded the `in_progress` write. The task's own history is
 * the source rather than the `transition_ticket` audit rows: a lifecycle write that failed still
 * leaves the moment reached, and the audit is per binding, not a column the pipeline reads.
 */
export interface TaskLifecycleReach {
  readonly stagesEntered: readonly string[];
  readonly state: string;
  readonly inProgressWritten: boolean;
}

export const taskLifecycleReachOf = (
  task: { readonly stageAttempts: Readonly<Record<string, number>>; readonly state: string },
  claim: { readonly in_progress_written: boolean } | null,
): TaskLifecycleReach => ({
  stagesEntered: Object.keys(task.stageAttempts).filter(
    (stage) => (task.stageAttempts[stage] ?? 0) > 0,
  ),
  state: task.state,
  inProgressWritten: claim?.in_progress_written === true,
});

/** The stages whose entry writes `in_progress` (developer-role agent stages, `moments.ts`). */
const IN_PROGRESS_STAGES: readonly string[] = ['implementation', 'conflict_resolution'];
/** The stages a task enters only after its last agent review approved (`approved` is written then). */
const AFTER_APPROVAL_STAGES: readonly string[] = [
  'ci_gate',
  'rebase_gate',
  'qa',
  'ready_for_merge',
  'merged_gate',
];

/**
 * **The statuses the platform has actually written for this task** (S-28.11, the production
 * defect: a queued task whose ticket a person had delivered to *Ready for Merge* — the binding's
 * `done` slot — was exempted as the platform's own status and started). A slot's status is the
 * platform's only once the task reached the moment that writes it (`moments.ts`): `in_progress` at
 * the claim's recorded write or a developer stage's entry; `in_review` at `code_review`;
 * `approved` once the task moved past its reviews; `qa` at `qa`; `done` at `merged_gate`;
 * `returned` (a person handing work back) once the task waited at `qa` or `ready_for_merge`; a
 * `status_mapping` target once its key — a stage the task entered, or the state it is in — was
 * reached. A task that never ran has reached nothing, so nothing is exempt.
 */
export const platformWrittenStatuses = (
  policy: TicketStatusPolicy,
  reach: TaskLifecycleReach,
): readonly string[] => {
  const entered = (stages: readonly string[]) =>
    stages.some((stage) => reach.stagesEntered.includes(stage));
  const reached = (writer: PlatformStatusWriter): boolean => {
    if ('mappingKey' in writer) {
      return reach.stagesEntered.includes(writer.mappingKey) || reach.state === writer.mappingKey;
    }
    switch (writer.slot) {
      case 'in_progress':
        return reach.inProgressWritten || entered(IN_PROGRESS_STAGES);
      case 'in_review':
        return entered(['code_review']);
      case 'approved':
        return entered(AFTER_APPROVAL_STAGES);
      case 'qa':
        return entered(['qa']);
      case 'done':
        return entered(['merged_gate']);
      case 'returned':
        return entered(['qa', 'ready_for_merge']);
      default:
        return false;
    }
  };
  return policy.platformWriters.filter(reached).map((writer) => writer.status);
};

/**
 * **The legacy `status_mapping` writes count as the platform's own** (S-28.4 review finding 1): a
 * block that maps no slot does not supersede `status_mapping` (TD-029 decision 3), so the status
 * mapping handler moves the ticket — into an In Progress status, or a Done one — and the claim's
 * pre-read, the reverse sync and the sweep must not read that move as a person's. Adds the
 * mapping's target statuses to `platformStatuses` exactly when no slot is mapped; idempotent.
 */
export const withStatusMappingStatuses = (
  policy: TicketStatusPolicy,
  block: TicketLifecycle | null | undefined,
  statusMapping: Readonly<Record<string, string>> | null | undefined,
): TicketStatusPolicy => {
  if (lifecycleMapsAnySlot(block) || statusMapping === null || statusMapping === undefined) {
    return policy;
  }
  const extra = Object.values(statusMapping).filter(
    (name) => !listHas(policy.platformStatuses, name),
  );
  const writers = Object.entries(statusMapping)
    .filter(
      ([key, name]) =>
        !policy.platformWriters.some(
          (writer) =>
            'mappingKey' in writer &&
            writer.mappingKey === key &&
            lifecycleStatusKey(writer.status) === lifecycleStatusKey(name),
        ),
    )
    .map(([mappingKey, status]): PlatformStatusWriter => ({ status, mappingKey }));
  return extra.length === 0 && writers.length === 0
    ? policy
    : {
        ...policy,
        platformStatuses: [...policy.platformStatuses, ...extra],
        platformWriters: [...policy.platformWriters, ...writers],
      };
};

/** The policy of a binding that declares nothing: the category defaults, no `pickup_status`. */
export const DEFAULT_TICKET_STATUS_POLICY: TicketStatusPolicy = ticketStatusPolicyOf(null, null);

/**
 * What a ticket's status means to the platform (M28 ruling 2):
 *
 *  - `startable` — work may start: `pickup_status`, a `start_from` status, or (no list) a To Do
 *    status;
 *  - `closed` — a person finished it: a `closed` status, or (no list) a Done status;
 *  - `hands_off` — a person is working it: a status of the In Progress category that is neither of
 *    the above, and — for a ticket the platform holds — not one the platform's own lifecycle writes
 *    (a slot) or reads as a hand-back (`returned`);
 *  - `not_ready` — everything else: a waiting status outside `start_from` (an *Idea*), a status of
 *    an unknown or unreported category, or the platform's own status on a ticket it holds. Nothing
 *    to act on.
 */
export type TicketStatusDisposition = 'startable' | 'not_ready' | 'hands_off' | 'closed';

const listHas = (list: readonly string[], status: string): boolean => {
  const key = lifecycleStatusKey(status);
  return list.some((name) => lifecycleStatusKey(name) === key);
};

/** Whether the status starts work (`pickup_status`, `start_from`, or the To Do category). */
const startable = (
  status: string,
  category: TicketStatusCategory | null,
  policy: TicketStatusPolicy,
): boolean =>
  (policy.pickUpFrom !== null && listHas([policy.pickUpFrom], status)) ||
  (policy.startFrom === null ? category === 'todo' : listHas(policy.startFrom, status));

/** Whether the status means a person finished the ticket (`closed`, or the Done category). */
const closed = (
  status: string,
  category: TicketStatusCategory | null,
  policy: TicketStatusPolicy,
): boolean => (policy.closed === null ? category === 'done' : listHas(policy.closed, status));

/**
 * The disposition of one status — see {@link TicketStatusDisposition}. `platformHolds` is whether
 * the platform holds this ticket for a live task (it claimed it, or the task is past its first
 * stage); a status the platform's lifecycle writes is then its own, and answers `not_ready` before
 * anything else, so the platform's own `done` write never reads as a person closing the ticket.
 */
export const ticketStatusDisposition = (
  status: string,
  category: TicketStatusCategory | null,
  policy: TicketStatusPolicy,
  /**
   * The statuses the platform wrote for this task ({@link platformWrittenStatuses}, S-28.11), which
   * answer `not_ready`; `true` exempts every status it could write, `false` none.
   */
  platformHolds: boolean | readonly string[],
): TicketStatusDisposition => {
  const exempt =
    platformHolds === true ? policy.platformStatuses : platformHolds === false ? [] : platformHolds;
  if (listHas(exempt, status)) {
    return 'not_ready';
  }
  if (closed(status, category, policy)) {
    return 'closed';
  }
  if (startable(status, category, policy)) {
    return 'startable';
  }
  return category === 'in_progress' ? 'hands_off' : 'not_ready';
};

/**
 * Whether the answer depended on a category the provider did not report: a status outside both
 * lists (or with no list to decide it) whose category is `null`. Jira always reports one; a
 * provider — or a fake — that does not cannot be judged by category, and intake then fails open as
 * it does for a ticket it could not read (M28 ruling 3 (c)).
 */
const undecidedForWantOfCategory = (
  status: string,
  category: TicketStatusCategory | null,
  policy: TicketStatusPolicy,
): boolean =>
  category === null &&
  !(policy.closed !== null && listHas(policy.closed, status)) &&
  policy.startFrom === null &&
  !(policy.pickUpFrom !== null && listHas([policy.pickUpFrom], status));

/** What intake does with a matched ticket's status. */
export type IntakeStatusDecision =
  | { readonly kind: 'take' }
  | { readonly kind: 'skip'; readonly disposition: Exclude<TicketStatusDisposition, 'startable'> };

/**
 * **Intake's question** (M28 ruling 3 (c)): a matched ticket becomes a task only when its status is
 * startable. Intake holds no ticket, so the platform's own statuses are not exempt. A status the
 * provider gave no category for, outside both lists, is taken — the same fail-open as a ticket that
 * could not be read; the claim before the first run asks again.
 */
export const intakeStatusDecision = (
  status: string,
  category: TicketStatusCategory | null,
  policy: TicketStatusPolicy,
): IntakeStatusDecision => {
  const disposition = ticketStatusDisposition(status, category, policy, false);
  if (disposition === 'startable' || undecidedForWantOfCategory(status, category, policy)) {
    return { kind: 'take' };
  }
  return { kind: 'skip', disposition };
};

/** What the claim's pre-read does with the ticket's status. */
export type ClaimStatusDecision =
  | { readonly kind: 'proceed' }
  | {
      readonly kind: 'refuse';
      readonly reason: 'ticket_not_startable' | 'ticket_closed_in_tracker';
    };

/**
 * **The claim's re-check** (M28 ruling 3 (d)): a task that waited — WIP-queued, or behind a gate —
 * may find its ticket moved by the time its first agent run is admitted.
 *
 *  - A `closed` ticket refuses every claim (`ticket_closed_in_tracker`), unless the binding says
 *    `on_ticket_closed: ignore`.
 *  - A **first** claim refuses a ticket that is not startable any more (`ticket_not_startable`) —
 *    a person took it (`hands_off`) or put it back to wait (`not_ready`). The platform's own slot
 *    statuses are exempt: a claim that crashed after its `in_progress` write meets its own move.
 *  - A **re-claim** (after a human return) proceeds from any status that is not closed: the person
 *    who returned the work moved the ticket wherever their workflow sends returned work.
 *  - A status of no reported category, outside both lists, proceeds (intake's fail-open).
 */
export const claimStatusDecision = (input: {
  readonly status: string;
  readonly category: TicketStatusCategory | null;
  readonly policy: TicketStatusPolicy;
  readonly first: boolean;
  /**
   * The claim was made for a person's explicit instruction — a *Rework*, a resume, a return to a
   * stage, a hand-back (S-28.4 review ruling (a)): where the ticket sits does not override it, so
   * nothing is refused; the caller may say a closed status as a notice.
   */
  readonly humanCommanded?: boolean;
  /**
   * The statuses the platform wrote for this task (S-28.11, {@link platformWrittenStatuses}): only
   * these are exempt. Absent, every status it could write is (the behaviour before S-28.11).
   */
  readonly written?: readonly string[];
}): ClaimStatusDecision => {
  const { status, category, policy, first } = input;
  if (input.humanCommanded === true) {
    return { kind: 'proceed' };
  }
  const written = input.written ?? policy.platformStatuses;
  const disposition = ticketStatusDisposition(status, category, policy, written);
  if (disposition === 'closed') {
    return policy.onTicketClosed === 'ignore'
      ? { kind: 'proceed' }
      : { kind: 'refuse', reason: 'ticket_closed_in_tracker' };
  }
  if (
    !first ||
    disposition === 'startable' ||
    listHas(written, status) ||
    undecidedForWantOfCategory(status, category, policy)
  ) {
    return { kind: 'proceed' };
  }
  return { kind: 'refuse', reason: 'ticket_not_startable' };
};

/** Why the reverse sync stops a task (M28 ruling 4, TD-029 amendment B decision 3). */
export type TicketStatusStopReason = 'ticket_closed_in_tracker' | 'ticket_taken_by_person';

/** What the reverse sync does with a live task whose ticket it re-read. */
export type TicketStatusStop =
  | { readonly kind: 'none' }
  /** A **queued** task — it never ran, holds nothing, and has no merge request: cancelled. */
  | { readonly kind: 'cancel'; readonly reason: TicketStatusStopReason }
  /** A task that ran or waits: its offer closed and its run stopped, then `needs_human`. */
  | { readonly kind: 'escalate'; readonly reason: TicketStatusStopReason }
  /** A task already in `needs_human` for another reason: the brief and the reason are replaced. */
  | { readonly kind: 'amend'; readonly reason: TicketStatusStopReason };

/**
 * **The reverse sync's table** (M28 ruling 4, S-28.5). `disposition` is
 * {@link ticketStatusDisposition}'s answer with `platformHolds: true` — a live task's ticket — over
 * a policy that already counts `status_mapping`'s targets as the platform's own
 * ({@link withStatusMappingStatuses}), so **a status the platform wrote is never a reason to stop**.
 *
 *  - Never for a finished task (`done`, `cancelled`), a merged one (`merged`, `retro`: its ticket
 *    legitimately ends Done), nor at a **human stage** (`qa`, `ready_for_merge`, `merged_gate`):
 *    there a person is working the ticket — QA moves it through their own statuses, and a merge
 *    may move it to Done before the platform hears `mr.merged`. Stopping there would race the
 *    person the stage waits for.
 *  - `closed` (unless `on_ticket_closed: ignore`): a `queued` task is cancelled; a task in
 *    `needs_human` has its escalation amended (say one stopped `ticket_assigned_elsewhere`), so the
 *    one click is *Cancel task* — only when the caller saw the ticket **move** (`mayAmend`: a
 *    status change, or the sweep), never on every polled edit of a ticket that stays closed;
 *    every other live state escalates. A task that may have an open merge request is never
 *    cancelled by the platform.
 *  - `hands_off`: a `queued` task is cancelled with `ticket_taken_by_person`; one already in
 *    `needs_human` is left (a person already decides); every other live state escalates.
 *  - `startable`, `not_ready`: nothing.
 */
export const ticketStatusStopDecision = (input: {
  readonly state: string;
  readonly humanStage: boolean;
  /**
   * The task's merge request was merged (`isMergedTask` — it entered `merged_gate`), or the caller
   * read it merged: its ticket was closed by the task's own delivery, so nothing is stopped
   * (S-28.5 review: a merged task escalated at `retrospective` is `needs_human`, and the merge moved
   * its ticket to Done).
   */
  readonly merged: boolean;
  readonly disposition: TicketStatusDisposition;
  readonly onTicketClosed: 'stop' | 'ignore';
  /** A `needs_human` task's escalation may be amended: the caller saw the status move (or sweeps). */
  readonly mayAmend: boolean;
}): TicketStatusStop => {
  const { state, disposition } = input;
  if (
    ['done', 'cancelled', 'merged', 'retro'].includes(state) ||
    input.merged ||
    input.humanStage ||
    (disposition !== 'closed' && disposition !== 'hands_off') ||
    (disposition === 'closed' && input.onTicketClosed === 'ignore')
  ) {
    return { kind: 'none' };
  }
  const reason: TicketStatusStopReason =
    disposition === 'closed' ? 'ticket_closed_in_tracker' : 'ticket_taken_by_person';
  if (state === 'queued') {
    return { kind: 'cancel', reason };
  }
  if (state === 'needs_human') {
    return disposition === 'closed' && input.mayAmend
      ? { kind: 'amend', reason }
      : { kind: 'none' };
  }
  return { kind: 'escalate', reason };
};
