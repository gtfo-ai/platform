/**
 * The human-time projector's persistence port — `human_time_entries` (technical/03:88), behind an
 * interface this ring can name.
 *
 * Transaction-bound like `CostStore` and `PipelineStore`, and for the same reason: every row the
 * projector writes commits together with the `handler_executions` claim that says the handler ran
 * (TD-005), so a redelivered event cannot double-count and a failure leaves nothing half-written.
 *
 * ## Why a store of its own rather than methods on `CostStore`
 *
 * The two projections answer different questions and are charged to different tables; nothing here
 * touches `cost_entries` and nothing there touches `human_time_entries`. Keeping them apart is also
 * what keeps the **one writer** claim checkable: `human-time-writers.test.ts` is a census over the
 * tree for statements that write this table, and it can only be an equality because exactly one
 * module contains them.
 *
 * ## What it deliberately cannot do
 *
 * There is no `delete` and no bulk write. A projection is rebuilt by replaying the log into it
 * (`events/replay.ts`), which the `handler_executions` claim makes a no-op for events it has
 * already served — so "rebuild" is a range of the log and never a `truncate` this port could offer.
 */
import type { HumanTimeKind, Id, IsoDateTime } from '@platform/contracts';
import type { Transaction } from '../ports/transaction.js';

/** A provider account as `user_identities` keys it: `(provider, external_id)`. */
export interface ExternalAccount {
  readonly provider: string;
  readonly externalId: string;
}

/** The identity a set of minutes is attributed to; both halves may be `null` (WP-31, Q10). */
export interface HumanTimeIdentity {
  /** The platform user, when `user_identities` maps the account. */
  readonly userId: Id | null;
  /** `"<provider>:<external id>"` — the segment key when `userId` is `null`. */
  readonly externalAuthor: string | null;
}

/** One `human_time_entries` row, as the projector reads it back. */
export interface HumanTimeEntry extends HumanTimeIdentity {
  readonly id: Id;
  readonly taskId: Id;
  readonly kind: HumanTimeKind;
  readonly startedAt: IsoDateTime;
  /** `null` while the window is still open — a review nobody has ended. */
  readonly endedAt: IsoDateTime | null;
  readonly minutes: number | null;
}

/** A row as the projector writes it. The id is the store's (`uuidv7()`), never the caller's. */
export interface NewHumanTimeEntry extends HumanTimeIdentity {
  readonly taskId: Id;
  readonly kind: HumanTimeKind;
  readonly startedAt: IsoDateTime;
  readonly endedAt: IsoDateTime | null;
  readonly minutes: number | null;
}

export interface HumanTimeStore {
  /**
   * The task that owns a merge request, or `null`.
   *
   * The `mr.*` payloads carry `task_id: null` — the normalisers cannot know it (a webhook names a
   * merge request, not a platform task) and the saga resolves it the same way
   * (`TaskRepository.findByMergeRequest`). `human_time_entries.task_id` is `not null`, so a merge
   * request that belongs to no task produces **no entry**, which is what happens for every
   * human-authored merge request review-only mode observes.
   */
  taskForMergeRequest(
    tx: Transaction,
    subject: { readonly projectId: Id; readonly iid: number },
  ): Promise<Id | null>;

  /**
   * The platform user a provider account is mapped to, or `null` (BD-006, Q10).
   *
   * One row of `user_identities`, which has had a writer since WP-31 and is empty until an operator
   * maps an account — so `null` is the ordinary answer on a fresh instance, not an error.
   */
  resolveUser(tx: Transaction, account: ExternalAccount): Promise<Id | null>;

  /**
   * Every `review` entry of a task, newest activity first.
   *
   * One read rather than "find the segment for this reviewer": the merge anchor has to end **all**
   * of them (product/19 §16's *"to merge or last activity"*) and a comment has to find one of them,
   * so a single bounded read serves both and the two cannot disagree about what a task's windows
   * are. It is bounded by construction — a task has one merge request and a handful of reviewers.
   */
  reviewEntries(tx: Transaction, taskId: Id): Promise<readonly HumanTimeEntry[]>;

  /** Appends one entry. */
  appendEntry(tx: Transaction, entry: NewHumanTimeEntry): Promise<void>;

  /**
   * Moves an open review window's ending and its minutes — the only update this table takes.
   *
   * @throws when the row does not exist: a projection that silently stops being written is the
   * defect standing rule 18 is about, and this write is the half of the fold that is not an insert.
   */
  extendEntry(
    tx: Transaction,
    id: Id,
    window: { readonly endedAt: IsoDateTime; readonly minutes: number },
  ): Promise<void>;

  /**
   * When a question was asked, or `null` when the row is gone.
   *
   * `task.question.answered` carries the question id and the answer and **not** the instant the
   * question was asked, so the fold of product/19 §16's *"asked → answered"* has to read it. The
   * `questions` row is written by the pipeline before the event exists, so `null` means the task
   * was deleted underneath the projector, never a race.
   */
  questionAskedAt(tx: Transaction, questionId: Id): Promise<IsoDateTime | null>;

  /**
   * The timezone of the project's organisation (BD-010, Q12); the caller falls back to UTC.
   *
   * The **same** question `CostStore.organisationTimezone` asks, because the review window's
   * *"per calendar day"* cap and the cost rollup's `day` must agree about when the day turned
   * (standing rule 9). The PostgreSQL adapters run the same statement.
   */
  organisationTimezone(tx: Transaction, projectId: Id): Promise<string | null>;
}
