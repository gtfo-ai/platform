/**
 * The outbox's work queue (TD-005).
 *
 * TD-005 makes the `events` table the outbox: appending an event *is* enqueueing its dispatch, in
 * the same transaction. The queue below is the index over that log — one row per event that has
 * not finished dispatching, written by a database trigger on `events`, so no code path can append
 * an event without queueing it and none can queue one that was never appended.
 *
 * Every method is **transaction-bound**: `claim` takes a row lock that is held for the whole
 * dispatch of that event, which is what stops two workers from running one event's handlers at
 * the same time. `complete` deletes the row in the same transaction, so a crash mid-dispatch
 * leaves the row in place and the sweep picks it up again — at-least-once, by construction.
 */
import type { Id, StreamType } from '@platform/contracts';

export type DispatchClaim =
  /** The row is ours until this transaction ends. */
  | 'claimed'
  /** No row: the event finished dispatching. */
  | 'completed'
  /** Another worker holds the row. */
  | 'busy'
  /**
   * The row is there and is terminal: a handler spent the attempt bound and the event was
   * dead-lettered (WP-49). Distinct from `completed`, which means the opposite — every handler
   * succeeded — and from `busy`, which invites a retry this row must never get again.
   */
  | 'dead-lettered';

/** Exponential backoff bounds, applied to the queue row's own attempt count. */
export interface RetryBackoff {
  readonly baseMs: number;
  readonly maxMs: number;
}

/** What one failed dispatch attempt is recorded with (WP-49). */
export interface DispatchFailure {
  /** The failure text, stored on the row for an operator to read. */
  readonly error: string;
  /** The handler that failed. Stored only when this attempt spends the bound. */
  readonly handler: string;
  readonly backoff: RetryBackoff;
  /**
   * Attempts this event gets in total. The attempt being recorded is counted, so `1` means the
   * first failure is the last one and `Infinity` is the old for-ever behaviour.
   */
  readonly maxAttempts: number;
}

/** How a recorded failure ended: another retry, or the end of the line. */
export interface DispatchAttemptEnding {
  /** The row's attempt count **after** this failure. */
  readonly attempts: number;
  readonly ending: 'retry' | 'dead-lettered';
}

export interface DispatchQueue {
  /** Takes the event's queue row for the life of this transaction, without waiting. */
  claim(position: number): Promise<DispatchClaim>;

  /** Removes the event from the queue: its dispatch finished. */
  complete(position: number): Promise<void>;

  /**
   * Records one failed attempt and decides what happens to the event (WP-49).
   *
   * `retry` leaves it queued with the failure on the row and `available_at` pushed into the future.
   * The delay is computed from the row's own `attempts` (`base × 2^attempts`, capped at `maxMs`),
   * because the row is the only place that count survives a rolled-back handler transaction. It
   * keeps the whole stream waiting behind it, which is what "ordering per stream" costs.
   *
   * `dead-lettered` is the ending: the attempt that reached `maxAttempts` marks the row terminal
   * instead of scheduling another retry, and from that moment the sweep, the ordering guard and the
   * backlog count all skip it — so the stream moves on and the event stops being re-dispatched.
   * The row is **not** deleted: `event_dispatch` is the only record that this event was never
   * dispatched, and `events` is append-only, so the dead letter is evidence rather than a loss.
   *
   * Both are one statement, so the count that decides cannot be read before the increment that
   * changes it.
   */
  failAttempt(position: number, failure: DispatchFailure): Promise<DispatchAttemptEnding>;

  /**
   * Whether an earlier event of the same stream is still queued.
   *
   * The ordering guard. Checked while holding the claim, so it cannot race: an event is dispatched
   * only once every lower `stream_seq` of its stream has left the queue — or been dead-lettered,
   * which is how a poisoned event stops blocking the events behind it.
   */
  hasEarlierPending(streamType: StreamType, streamId: Id, streamSeq: number): Promise<boolean>;
}

/** One queued event, for tests and for the queue-depth metric. */
export interface DispatchQueueEntry {
  readonly eventPosition: number;
  readonly streamType: string;
  readonly streamId: string;
  readonly streamSeq: number;
  readonly attempts: number;
  readonly error: string | null;
  readonly availableAt: string;
  /** `null` for every row that is still being retried (WP-49). */
  readonly deadLetteredAt: string | null;
  readonly deadLetterHandler: string | null;
}
