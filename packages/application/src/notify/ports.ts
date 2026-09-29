/**
 * The notification outbox — the rows that make "quiet hours defer and never drop" true (WP-32).
 *
 * ## Why there is a table at all
 *
 * product/18:33 batches a notification raised inside the quiet window into *"a daily digest"*. A
 * notification is decided by an event handler, delivered (or not) by a `pipeline.outbound` job
 * minutes later, and collected by a cron job hours after that — three processes, any of which may
 * be a different replica or a restarted one. The thing that survives all three is a row.
 *
 * The alternative considered and rejected was re-deriving the digest from the `events` log at
 * collection time: it needs no new table, and it loses exactly the property this exists for — a
 * digest that missed its tick (a process down at 09:00) would have to guess how far back to read,
 * and a notification whose immediate delivery *failed* has no trace in the log at all. A row that
 * says "undelivered" answers both without arithmetic.
 *
 * ## What a row is
 *
 * One row per `(project, cause event, class)` — the unique key is what makes an at-least-once
 * wake-up idempotent, and it is a platform identity rather than provider text.
 *
 * `deliveredAt` is the only thing that says a human was told. Everything else is evidence:
 * `plannedDelivery` records what the policy decided **at the moment the notification was raised**
 * (which is the only moment the quiet window can be evaluated for it), `digestDay` records which
 * digest has claimed it, and `urgent` records the classification the project's configuration gave
 * it. A row whose immediate delivery failed keeps `deliveredAt` null and is therefore picked up by
 * the next digest — the failure is a delay, never a loss. *Failed* and *still being delivered* look
 * identical in the row, which is what {@link NotificationStore.claimForDigest}'s second bound is
 * for.
 *
 * Transaction-bound like `PipelineStore` and `CostStore`, for the same reason: the claim and the
 * rows it claims have to move together, and a repository that could open its own transaction is how
 * a job ends up holding two connections at once.
 */
import type { Id, IsoDateTime, NotificationClass, TaskMode } from '@platform/contracts';
import type { NotificationDelivery } from '@platform/domain';
import type { MessageRef } from '../ports/integrations/communication.js';
import type { Transaction } from '../ports/transaction.js';

/** What the duty records before it tries to deliver anything. */
export interface NotificationEntry {
  readonly id: Id;
  /**
   * `null` for an **organisation-scoped** notification (WP-65, backlog 80): an organisation budget
   * has no project, and it is delivered to the organisation's own chat account's channel rather
   * than to any project's binding. Migration 0051 keeps such rows deduplicated (`nulls not
   * distinct`).
   */
  readonly projectId: Id | null;
  /** `null` for a notification about a project rather than a task — a budget window. */
  readonly taskId: Id | null;
  /**
   * The approval an `approval` notification asked about (WP-65, backlog 202), so the message can be
   * found again once the approval is decided or expires. Absent for every other class.
   */
  readonly approvalId?: Id | null;
  /**
   * The question a `question` row asks, or a `reminder` row reminds about (WP-84 review round 1,
   * migration 0059) — what a retry or a re-post re-checks before it sends. An approval's
   * `reminder` row names its approval in {@link approvalId} instead. Absent for every other class.
   */
  readonly questionId?: Id | null;
  readonly notificationClass: NotificationClass;
  /** The event that caused it. Half of the unique key, and the identity a replay is keyed by. */
  readonly causeEventId: Id;
  /** Platform text with the event's own words in it, already bounded and redacted. */
  readonly title: string;
  readonly detail: string | null;
  /**
   * The ticket or merge request a human would open — redacted and bounded like the two above, by
   * `boundUrl`, which drops rather than truncates. Never rendered as markup (BD-022).
   */
  readonly url: string | null;
  readonly urgent: boolean;
  readonly plannedDelivery: NotificationDelivery;
  /**
   * `tasks.mode` — `normal` for a notification with no task (a budget window).
   *
   * It is on the row because the **digest** needs it hours later and cannot ask the task any more:
   * the executor's shadow guard takes the mode of the call, so a digest that mixed a shadow task's
   * lines into a real message would post what BD-021 says must only ever be recorded as
   * `would_have`. The digest therefore groups its claimed rows by this column and makes one call
   * per mode.
   */
  readonly mode: TaskMode;
  readonly createdAt: IsoDateTime;
  /** How many secrets TD-012 redacted out of `title` and `detail`; the `inbox` precedent. */
  readonly redactionCount: number;
}

/**
 * What became of a row: posted on its own, carried by a digest, or **withheld** — the platform
 * decided not to send it because its question or approval was settled first (WP-84 review round 2,
 * migration 0059). All three are terminal and set `deliveredAt`, so nothing counts, re-posts or
 * carries a withheld row.
 */
export type NotificationOutcome = NotificationDelivery | 'withheld';

/** A recorded notification, as the digest reads it back. */
export interface StoredNotification extends NotificationEntry {
  readonly approvalId: Id | null;
  readonly questionId: Id | null;
  /** Where the provider put the message, when an immediate delivery recorded it (WP-65). */
  readonly messageRef: MessageRef | null;
  readonly deliveredAt: IsoDateTime | null;
  readonly deliveredAs: NotificationOutcome | null;
  /** `YYYY-MM-DD` in the organisation's zone, set when a digest claims the row. */
  readonly digestDay: string | null;
}

export interface NotificationStore {
  /**
   * Records a notification, or reports that this project has already recorded this one.
   *
   * `false` is the ordinary outcome of a duplicated wake-up (a job is at-least-once) and is not an
   * error: the caller stops rather than delivering a second copy.
   */
  record(tx: Transaction, entry: NotificationEntry): Promise<boolean>;

  /** Marks one row delivered. `via` is what actually happened, not what was planned. */
  markDelivered(
    tx: Transaction,
    input: {
      readonly id: Id;
      readonly at: IsoDateTime;
      readonly via: NotificationDelivery;
      /**
       * The provider's address of the posted message, **redacted** by the caller — recorded for an
       * approval, whose buttons a later duty removes (WP-65, backlog 202), and since WP-88 for a
       * question, whose message a later duty edits to say it was answered or expired (backlog 233)
       * and into whose thread a reply answers it (backlog 195). Absent leaves the column as it was.
       */
      readonly messageRef?: MessageRef | null;
    },
  ): Promise<void>;

  /**
   * The row a `(project, cause event, class)` key names, or `null` — what a retried wake-up reads
   * when `record` answers `false` (WP-65 review round 1). A duplicate is only a reason to stop when
   * the first attempt **delivered**; one whose provider call threw left an undelivered `immediate`
   * row, and the retry must deliver it rather than read "already recorded" as "already told".
   */
  findByCause(
    tx: Transaction,
    key: {
      readonly projectId: Id | null;
      readonly causeEventId: Id;
      readonly notificationClass: NotificationClass;
    },
  ): Promise<StoredNotification | null>;

  /**
   * The message that asked about this approval, or `null` when none was posted with an address —
   * the approval was announced as a digest line, as text through a binding that cannot receive a
   * click, or never (WP-65, backlog 202).
   */
  approvalMessage(tx: Transaction, approvalId: Id): Promise<StoredNotification | null>;

  /**
   * The message that asked this question, or `null` when none was posted with an address — the
   * question reached a digest, or nobody (WP-88, PROGRESS backlog 233). A `reminder` row names the
   * question too and carries no address, so it is never the answer.
   */
  questionMessage(tx: Transaction, questionId: Id): Promise<StoredNotification | null>;

  /**
   * Records that `taskId`'s chat thread is `channel`/`threadId` on this account (WP-88, PROGRESS
   * backlog 195) — the durable half of the thread ↔ task map, which a chat reply is resolved
   * through (`InboundThreadDirectory`). The adapter's own map is per instance and the loader builds
   * one per call (Q55), so this row is the only thing that outlives the call that opened the thread.
   *
   * Idempotent: a thread already recorded is left as it is. `channel` and `threadId` are provider
   * text, **redacted and bounded by the caller** (at most `MAX_THREAD_HANDLE_CHARS`).
   */
  recordThread(
    tx: Transaction,
    input: {
      readonly projectId: Id;
      readonly integrationId: Id;
      readonly taskId: Id;
      readonly channel: string;
      readonly threadId: string;
      readonly at: IsoDateTime;
    },
  ): Promise<void>;

  /**
   * A platform user's display name (`users.name`), or `null` for an id the store does not know —
   * read to name who decided an approval in its edited chat message (WP-73, PROGRESS backlog 234).
   * The name is text a person typed, so the caller redacts and bounds it like any other string it
   * posts.
   */
  userName(tx: Transaction, userId: Id): Promise<string | null>;

  /**
   * Every project with an undelivered notification older than `before` — the digest's fan-out.
   *
   * `before` is a bound rather than "now" so that a retried digest job collects the same set as the
   * run that failed: a row created while the job was posting belongs to the next digest, not to a
   * message that has already been sent.
   */
  projectsAwaitingDigest(
    tx: Transaction,
    input: { readonly before: IsoDateTime; readonly limit: number },
  ): Promise<readonly Id[]>;

  /**
   * Whether an **organisation-scoped** notification (no project, WP-65) is undelivered and older
   * than `before` — the organisation digest's fan-out (WP-93, PROGRESS backlog 235), the one row
   * {@link NotificationStore.projectsAwaitingDigest} leaves out.
   */
  organisationAwaitsDigest(
    tx: Transaction,
    input: { readonly before: IsoDateTime },
  ): Promise<boolean>;

  /**
   * Claims this project's undelivered notifications for `day` and returns them, oldest first.
   * `projectId: null` claims the **organisation's** rows (WP-93) — a row with no project is never
   * claimed for a project, nor a project's row for the organisation.
   *
   * Claiming is what makes a retry safe: a second run on the same day finds the same rows (they are
   * claimed *and* undelivered) and posts the same message under the same idempotency key, while a
   * claim left behind by a **failed** day is re-claimed by the next one rather than stranded —
   * which is the difference between a digest that is late and a notification that is lost.
   *
   * ## The two bounds, and why an `immediate` row needs its own
   *
   * `before` is the tick's own instant (see {@link NotificationStore.projectsAwaitingDigest}).
   * `immediateBefore` is the **older** bound that rows whose `plannedDelivery` is `immediate` are
   * held to, and it exists because "undelivered" is ambiguous for exactly those rows: the duty
   * records the row, then calls the provider, then marks it delivered, so a row recorded seconds
   * ago may have a delivery **in flight**. Claiming it posts the same notification twice and leaves
   * `delivered_as` set by whichever write lands last. A row planned `digest` has no such window —
   * nothing ever tried to deliver it — so it is claimable as soon as it exists.
   *
   * The caller supplies the instant rather than the store computing one, for the same reason
   * `before` is not `now()`: a retry must claim the set its first attempt did.
   */
  claimForDigest(
    tx: Transaction,
    input: {
      readonly projectId: Id | null;
      readonly day: string;
      readonly before: IsoDateTime;
      /** The bound for `plannedDelivery: 'immediate'` rows — usually `before` minus a grace. */
      readonly immediateBefore: IsoDateTime;
      readonly limit: number;
    },
  ): Promise<readonly StoredNotification[]>;

  /**
   * Closes rows as **withheld** (WP-84 review round 2): their question or approval was settled
   * before a retry, a re-post or the digest reached them, so they are not sent and must not be
   * counted as lost. Only a row still undelivered is touched.
   */
  markWithheld(
    tx: Transaction,
    input: { readonly ids: readonly Id[]; readonly at: IsoDateTime },
  ): Promise<void>;

  /** Marks a claimed set delivered by digest. */
  markDigested(
    tx: Transaction,
    input: { readonly ids: readonly Id[]; readonly at: IsoDateTime },
  ): Promise<void>;

  /** Has a digest already been *delivered* for this project — or, `null`, the organisation — on this day? */
  digestDelivered(
    tx: Transaction,
    input: { readonly projectId: Id | null; readonly day: string },
  ): Promise<boolean>;
}

/**
 * Whether a retried wake-up that found its row already recorded must still deliver it (WP-65 review
 * round 1): planned `immediate`, never delivered, and not claimed by a digest — i.e. an earlier
 * attempt of the same job recorded it and then failed at the provider. Such a retry posts under the
 * **same** idempotency key, so a provider call that had in fact succeeded is replayed by the
 * executor rather than posted twice.
 */
export const awaitsImmediateRetry = (row: StoredNotification | null): row is StoredNotification =>
  row !== null &&
  row.deliveredAt === null &&
  row.plannedDelivery === 'immediate' &&
  row.digestDay === null;
