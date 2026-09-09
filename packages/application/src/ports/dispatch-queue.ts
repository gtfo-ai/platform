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
  | 'busy';

/** Exponential backoff bounds, applied to the queue row's own attempt count. */
export interface RetryBackoff {
  readonly baseMs: number;
  readonly maxMs: number;
}

export interface DispatchQueue {
  /** Takes the event's queue row for the life of this transaction, without waiting. */
  claim(position: number): Promise<DispatchClaim>;

  /** Removes the event from the queue: its dispatch finished. */
  complete(position: number): Promise<void>;

  /**
   * Leaves the event queued, records the failure and pushes it into the future.
   *
   * The delay is computed from the row's own `attempts` (`base × 2^attempts`, capped at `maxMs`),
   * because the row is the only place that count survives a rolled-back handler transaction.
   * Keeps the whole stream waiting behind it, which is what "ordering per stream" costs.
   */
  retryLater(position: number, error: string, backoff: RetryBackoff): Promise<void>;

  /**
   * Whether an earlier event of the same stream is still queued.
   *
   * The ordering guard. Checked while holding the claim, so it cannot race: an event is dispatched
   * only once every lower `stream_seq` of its stream has left the queue.
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
}
