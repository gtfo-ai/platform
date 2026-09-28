/**
 * The notification nobody will ever try again — PROGRESS backlog **236** half (2), WP-84, a row of
 * `./stranded.ts`'s pass.
 *
 * ## What is wrong without this
 *
 * A planned-`immediate` notification is recorded, then posted, then marked delivered, by one
 * `pipeline.outbound` job (`notify/duty.ts`, `notify/organisation.ts`). Since WP-65's review round 1
 * each retry of that job re-posts its own recorded, undelivered row under the same idempotency key
 * (`awaitsImmediateRetry`) — and once the queue's retries are spent nothing else ever does: no
 * digest carries an organisation row, nor any row of a project whose digest is off. The
 * `notifications_undelivered` gauge counts such a row past the job's retry window, and until this
 * row nothing re-posted it — so an organisation budget alarm lost to a chat outage stayed lost.
 *
 * ## What it looks for, and what it does
 *
 * A row planned `immediate`, **undelivered**, **unclaimed by a digest** (a claimed row is the
 * digest's to deliver), never re-posted, and older than {@link IMMEDIATE_UNDELIVERED_AFTER_MS} — the
 * same bound the gauge counts past, so this acts on exactly the rows the gauge calls *not told*,
 * and never on one whose own job still has an attempt left.
 *
 * It re-enqueues **the original duty**, rebuilt from the row — `notify` with the row's project,
 * task, cause and class (and approval), or `notify_organisation` for a row with no project. Not a
 * duty of its own, for the reason the executor's idempotency scope gives: the scope is
 * `(integration, action, key)`, so a re-post must take **the same action** the first attempt took
 * (buttons or a message, a thread reply or a channel post) for a first attempt that had in fact
 * succeeded to be *replayed* rather than posted twice — and the one code path that already chooses
 * that action is the duty's. On fire the duty finds its row recorded, reads it back, and posts the
 * **row's own** stored title, detail and URL (not a re-render of a payload this rebuild does not
 * carry) under `notify:<cause>:<class>`, the key the first attempt used.
 *
 * ## What bounds it
 *
 * `notifications.repost_attempted_at` (migration 0059): one re-post per row, marked **before** the
 * enqueue, so a crash between the two costs that row its re-post rather than restoring an unbounded
 * loop (`stranded.ts`'s ordering argument). The re-enqueued job has the queue's own attempts; a row
 * they all fail stays undelivered and stays counted by the gauge, which is the operator's signal —
 * there is no ending to take, because nothing is held by an undelivered row.
 *
 * ## What it does not do, stated
 *
 *  - A row whose question or approval was settled meanwhile is closed **withheld** by the duty
 *    (review round 2) — correctly not sent, so not counted. A row skipped for another reason — its
 *    task gone, the project's chat binding removed — **stays counted**: that is a notification the
 *    platform could not deliver, and the gauge saying so is the loud direction.
 *  - **A question is re-checked** (review round 1): a `question` row carries its `question_id` and a
 *    `reminder` row its `question_id` or `approval_id`, and the rebuilt wake-up passes them on
 *    (`question_id`, `reminder_of`), so the duty posts nothing for a question answered or expired,
 *    or an approval decided or expired, since — the human sees nothing, and the row is closed
 *    `withheld` (review round 2), so neither the gauge nor the digest carries it on. **A row of
 *    those classes that names no aggregate is not re-posted at all** (review round 2, fail closed):
 *    its id was nulled by a delete, or an old build wrote it during a deploy window after 0059
 *    committed — it is closed `withheld` by the pass itself. Rows recorded before 0059 are marked
 *    attempted by the migration and never reach this.
 *  - On a digest-on project a re-post can race the digest tick that would have claimed the row, and
 *    both post it — one duplicate line, never a lost one; the residual `duty.ts` already states for
 *    the job's own retries.
 */
import type { Id, IsoDateTime, NotificationClass } from '@platform/contracts';
import type { Transaction } from '../ports/transaction.js';

/** One undelivered row, with what the original duty's payload needs to be rebuilt. */
export interface UndeliveredNotification {
  readonly id: Id;
  /** `null` for an organisation-scoped row, which is re-posted through `notify_organisation`. */
  readonly projectId: Id | null;
  readonly taskId: Id | null;
  readonly approvalId: Id | null;
  /** The question a `question` or `reminder` row is about (migration 0059, review round 1). */
  readonly questionId: Id | null;
  readonly notificationClass: NotificationClass;
  readonly causeEventId: Id;
  readonly createdAt: IsoDateTime;
}

export interface NotificationRepostStore {
  /**
   * Rows planned `immediate`, undelivered, unclaimed by a digest and never re-posted, created
   * before `before`. Oldest first, at most `limit`.
   */
  undeliveredImmediate(
    tx: Transaction,
    query: { readonly before: IsoDateTime; readonly limit: number },
  ): Promise<readonly UndeliveredNotification[]>;
  /**
   * Closes a row the pass will not re-post as **withheld** (review round 2): a `question`,
   * `reminder` or `approval` row that names no aggregate cannot be re-checked, and a message asking
   * somebody for something is not sent unchecked. A delivered row is left alone.
   */
  withholdRepost(
    tx: Transaction,
    input: { readonly id: Id; readonly at: IsoDateTime },
  ): Promise<void>;
  /** The one attempt, which is what the next pass reads. A delivered row is left alone. */
  markRepostAttempt(
    tx: Transaction,
    input: { readonly id: Id; readonly at: IsoDateTime },
  ): Promise<void>;
}

export interface NotificationRepostSite {
  readonly store: NotificationRepostStore;
}
