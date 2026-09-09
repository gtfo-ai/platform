/**
 * The event store port (TD-005): an append-only log that is also the transactional outbox.
 *
 * Two halves, because they have different lifetimes. `EventAppender` is **transaction-bound** —
 * it is reached through a `TransactionScope`, so an aggregate's state change and its events
 * commit together or not at all. `EventStore` is the connection-scoped read side used by
 * aggregate loading and by the dispatcher's sweep.
 *
 * Sequencing is optimistic, not pessimistic. The caller appends with `stream_seq = last + 1`; the
 * `events_stream_seq_guard` trigger takes the `event_streams` row lock inside its own upsert, so
 * concurrent appends to one stream serialise without the caller locking anything — and a caller
 * that *tried* to lock `event_streams` would get `42501`, because the application role holds
 * SELECT only there (migration 0005). A mismatch surfaces as `StreamConflictError`.
 */
import type { DomainEvent, Id, StreamType } from '@platform/contracts';

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
  append(events: readonly DomainEvent[], options?: AppendOptions): Promise<readonly StoredEvent[]>;
}

export interface ReadStreamOptions {
  /** Lowest `stream_seq` to return, inclusive. Default 1 (the whole stream). */
  readonly fromSeq?: number;
  /** Highest number of events to return. */
  readonly limit?: number;
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
  readStream(
    streamType: StreamType,
    streamId: Id,
    options?: ReadStreamOptions,
  ): Promise<readonly StoredEvent[]>;

  /** The `stream_seq` the next append to this stream must carry (`last + 1`, so 1 when empty). */
  nextStreamSequence(streamType: StreamType, streamId: Id): Promise<number>;

  readAt(position: number): Promise<StoredEvent | null>;

  /** Events whose dispatch is due, earliest-pending-per-stream first, in position order. */
  readPendingDispatch(request: PendingDispatchRequest): Promise<readonly StoredEvent[]>;

  /** How many events are waiting to be dispatched (queue depth, for tests and metrics). */
  countPendingDispatch(): Promise<number>;
}
