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
import type { Transaction } from '../ports/transaction.js';

/** What the duty records before it tries to deliver anything. */
export interface NotificationEntry {
  readonly id: Id;
  readonly projectId: Id;
  /** `null` for a notification about a project rather than a task — a budget window. */
  readonly taskId: Id | null;
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

/** A recorded notification, as the digest reads it back. */
export interface StoredNotification extends NotificationEntry {
  readonly deliveredAt: IsoDateTime | null;
  readonly deliveredAs: NotificationDelivery | null;
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
    },
  ): Promise<void>;

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
   * Claims this project's undelivered notifications for `day` and returns them, oldest first.
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
      readonly projectId: Id;
      readonly day: string;
      readonly before: IsoDateTime;
      /** The bound for `plannedDelivery: 'immediate'` rows — usually `before` minus a grace. */
      readonly immediateBefore: IsoDateTime;
      readonly limit: number;
    },
  ): Promise<readonly StoredNotification[]>;

  /** Marks a claimed set delivered by digest. */
  markDigested(
    tx: Transaction,
    input: { readonly ids: readonly Id[]; readonly at: IsoDateTime },
  ): Promise<void>;

  /** Has a digest already been *delivered* for this project on this day? */
  digestDelivered(
    tx: Transaction,
    input: { readonly projectId: Id; readonly day: string },
  ): Promise<boolean>;
}
