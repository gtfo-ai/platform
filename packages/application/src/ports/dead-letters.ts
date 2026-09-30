/**
 * The dead-letter store (WP-95, PROGRESS backlog 126): the one read and the one write an operator
 * needs over the events WP-49 took out of the dispatch queue.
 *
 * A port of its own rather than two more members of `EventStore` and `DispatchQueue`, because the
 * dispatcher never calls either: they are an operator's instruments over the same table, and a
 * member added to the dispatcher's ports would be a member every fake of the dispatcher has to grow
 * for a caller it does not have.
 *
 * ## The queue row is the aggregate, and its state machine is three words
 *
 * `pending` (queued, being retried) → `dead_lettered` (spent the bound, WP-49) → `pending` again on
 * a re-queue → gone when a dispatch completes (`DispatchQueue.complete`). A re-queue is the one
 * operation this port adds, and it is legal from exactly one state; every other state is a refusal
 * the caller names (`routes/dead-letters.ts` answers each with a typed 409 or a 404).
 */
import type { Id } from '@platform/contracts';
import type { Transaction } from './transaction.js';

/** One dead-lettered event, as the log and the queue row together describe it. */
export interface DeadLetterRow {
  readonly position: number;
  /** `events.type` as stored — a type this build no longer knows is still listed. */
  readonly eventType: string;
  readonly streamType: string;
  readonly streamId: Id;
  readonly occurredAt: string;
  readonly deadLetteredAt: string;
  /** `event_dispatch.dead_letter_handler`: the handler whose failure spent the bound. */
  readonly handler: string | null;
  readonly attempts: number;
  /** `event_dispatch.error` **as stored — unredacted**; the reader redacts before publishing it. */
  readonly error: string | null;
  /** The task the dead-letter sink escalated, when the event names one that exists. */
  readonly task: {
    readonly id: Id;
    readonly ticketKey: string;
    readonly projectKey: string;
  } | null;
}

export interface DeadLetterPageRequest {
  readonly limit: number;
  /** Exclusive upper bound on `position`: the last position of the previous page. */
  readonly beforePosition?: number;
}

export interface DeadLetterPage {
  readonly items: readonly DeadLetterRow[];
  /** Every dead letter, not the page — `countDeadLettered`'s statement (standing rule 16). */
  readonly total: number;
}

/** Where a re-queue found the event's queue row. */
export type DeadLetterRequeueOutcome =
  /** It was dead-lettered and is queued again: `attempts` 0, `dead_lettered_at` cleared. */
  | { readonly status: 'requeued'; readonly row: DeadLetterRow; readonly requeuedAt: string }
  /** It is queued and not dead-lettered: a dispatcher will offer it again by itself. */
  | { readonly status: 'pending' }
  /** No queue row, and the event is in the log: its dispatch already completed. */
  | { readonly status: 'dispatched' }
  /** No queue row and no event at this position. */
  | { readonly status: 'unknown' };

export interface DeadLetterStore {
  /** Newest position first, bounded by `limit`. A read, never a lock. */
  readonly list: (request: DeadLetterPageRequest) => Promise<DeadLetterPage>;
  /**
   * Re-queues one dead-lettered event **on the caller's transaction**, or says why it cannot.
   *
   * The arbiter is a **locking read** of the row where `dead_lettered_at is not null` (standing
   * rule 9): of two concurrent re-queues the second waits on the first's lock, re-reads the
   * committed row, finds it no longer dead-lettered and answers `pending`; exactly one sees
   * `requeued`. (The Postgres adapter's `update` repeats the condition as a second check.) A dispatcher's claim takes the same row
   * `FOR UPDATE SKIP LOCKED` and returns `dead-lettered` for it without dispatching, so a sweep
   * racing the re-queue either sees the old state and skips it or the new one and dispatches it —
   * never half of each.
   */
  readonly requeue: (tx: Transaction, position: number) => Promise<DeadLetterRequeueOutcome>;
}
