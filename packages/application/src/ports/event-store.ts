/**
 * The event store port (TD-005): an append-only log that is also the transactional outbox.
 *
 * Two halves, because they have different lifetimes. `EventAppender` is **transaction-bound** —
 * it is reached through a `TransactionScope`, so an aggregate's state change and its events
 * commit together or not at all. `EventStore` is the connection-scoped read side used by
 * aggregate loading and by the dispatcher's sweep.
 *
 * The caller appends with `stream_seq = last + 1`; the `events_stream_seq_guard` trigger takes the
 * `event_streams` row lock inside its own upsert, and a mismatch surfaces as `StreamConflictError`
 * — a caller that *tried* to lock `event_streams` itself would get `42501`, because the application
 * role holds SELECT only there (migration 0005). An aggregate's stream is serialised by the
 * aggregate's own row; a **shared** stream — a project's, a run's — has no row every writer locks,
 * so its writers take {@link EventAppender.lockStreamSequence} instead (BACKLOG 971): the stream's
 * transaction-scoped lock and its next sequence, read on the transaction's own connection.
 */
import type { DomainEvent, DomainEventType, Id, StreamType } from '@platform/contracts';

/** One row of `events`, with its envelope parsed back into a catalogue event. */
export interface StoredEvent {
  /** `events.position` — the identity sequence. Globally unique, but **not gapless**. */
  readonly position: number;
  /** `events.cause_event_position` — the physical link to the event that caused this one. */
  readonly causeEventPosition: number | null;
  /** The catalogue event, envelope included (`@platform/contracts`). */
  readonly event: DomainEvent;
}

export interface AppendOptions {
  /**
   * Position of the event whose handler is emitting these (chaining, TD-005). The envelope's
   * `cause_event_id` is written from the event itself; this is its `bigint` counterpart.
   */
  readonly causeEventPosition?: number | null;
}

/** Transaction-bound append. Reached through `TransactionScope.events`. */
export interface EventAppender {
  /**
   * Appends events in order, returning them with the positions the log assigned.
   *
   * @throws {StreamConflictError} when a `stream_seq` is not `last + 1` for its stream.
   * @throws {PartitionWindowError} when `occurred_at` has no monthly partition.
   */
  readonly append: (
    events: readonly DomainEvent[],
    options?: AppendOptions,
  ) => Promise<readonly StoredEvent[]>;
  /**
   * **Takes the stream's lock for the rest of this transaction and answers its next sequence**, read
   * in this transaction (BACKLOG 971). Every appender of a shared stream calls this — the one place
   * the lock-then-read is spelled — so two writers of one stream wait for each other instead of
   * racing for the sequence and losing at the trigger. Released at commit or rollback.
   *
   * Lock order: call it **before the first append** of the transaction and after the row locks the
   * transaction takes first (`run_offers` → `runs` → `tasks`); a transaction that locks several
   * streams locks them in `(stream type, stream id)` order.
   */
  readonly lockStreamSequence: (streamType: StreamType, streamId: Id) => Promise<number>;
}

export interface ReadStreamOptions {
  /** Lowest `stream_seq` to return, inclusive. Default 1 (the whole stream). */
  readonly fromSeq?: number;
  /** Highest number of events to return. */
  readonly limit?: number;
}

/**
 * A window of the log, in position order — the read a **backfill** is built on (WP-19).
 *
 * `events` is append-only (TD-005 `REVOKE DELETE`), so a handler registered after the fact can be
 * served from the log itself; what it needs and the dispatcher's two queries do not provide is a
 * forward scan bounded by position and filtered by type. `fromPosition` is **exclusive** so a caller
 * can page with the last position it saw, which is the only cursor the log guarantees is unique.
 */
export interface ReadRangeRequest {
  /** Exclusive lower bound; 0 starts at the beginning of the log. */
  readonly fromPosition: number;
  /** Inclusive upper bound; absent reads to the end. */
  readonly toPosition?: number;
  /** Catalogue types to return; absent returns every type. */
  readonly types?: readonly DomainEventType[];
  /** Highest number of events to return. */
  readonly limit: number;
}

export interface PendingDispatchRequest {
  /** Highest number of events to return. One per stream at most, see below. */
  readonly limit: number;
}

/**
 * The read side, plus the two queries the dispatcher needs.
 *
 * `readPendingDispatch` returns at most **one event per stream** — the lowest undispatched
 * `stream_seq` — which is what makes "ordering per stream" hold when several workers sweep at
 * once: two events of one stream can never be handed out together.
 */
export interface EventStore {
  readonly readStream: (
    streamType: StreamType,
    streamId: Id,
    options?: ReadStreamOptions,
  ) => Promise<readonly StoredEvent[]>;

  /** The `stream_seq` the next append to this stream must carry (`last + 1`, so 1 when empty). */
  readonly nextStreamSequence: (streamType: StreamType, streamId: Id) => Promise<number>;

  readonly readAt: (position: number) => Promise<StoredEvent | null>;

  /**
   * A window of the log in position order (see {@link ReadRangeRequest}).
   *
   * It reads `events` and **not** `event_dispatch`: an event whose dispatch completed has no queue
   * row left, and those are exactly the events a backfill exists for.
   */
  readonly readRange: (request: ReadRangeRequest) => Promise<readonly StoredEvent[]>;

  /** Events whose dispatch is due, earliest-pending-per-stream first, in position order. */
  readonly readPendingDispatch: (
    request: PendingDispatchRequest,
  ) => Promise<readonly StoredEvent[]>;

  /**
   * How many events are waiting to be dispatched (queue depth, for tests and metrics).
   *
   * A dead-lettered event is **not** waiting: nothing will dispatch it again, so counting it here
   * would publish a backlog that no amount of draining can clear. It is counted by
   * {@link countDeadLettered} instead, and the two together are the whole of `event_dispatch`.
   */
  readonly countPendingDispatch: () => Promise<number>;

  /**
   * How many events spent their attempt bound and left the queue (WP-49).
   *
   * The number that tells a poisoned event from a busy queue: the backlog gauge rises under load
   * and falls again, this one only rises — and only when something is permanently failing.
   */
  readonly countDeadLettered: () => Promise<number>;
}
