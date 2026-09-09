/**
 * Typed errors of the application ring.
 *
 * `CLAUDE.md`: errors are typed, never swallowed. `packages/domain` throws `DomainError`; this
 * ring adds the failures that only exist once state is persisted and dispatched — a stream that
 * moved under us, an event outside the partition window, a stored row that no longer matches the
 * catalogue, a handler registration that breaks TD-005's priority bands.
 */

export type ApplicationErrorCode =
  | 'stream_conflict'
  | 'outside_partition_window'
  | 'corrupt_event'
  | 'handler_registration'
  | 'dispatcher_stopped';

export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;

  constructor(code: ApplicationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

/**
 * Another writer appended to the stream first.
 *
 * The `events_stream_seq_guard` trigger (migration 0005) raises `23505` when `stream_seq` is not
 * `last + 1`; that is the whole optimistic-concurrency protocol of TD-005, so the caller reloads
 * the aggregate and retries rather than looping on a lock.
 */
export class StreamConflictError extends ApplicationError {
  readonly streamType: string;
  readonly streamId: string;
  readonly streamSeq: number;

  constructor(streamType: string, streamId: string, streamSeq: number, options?: ErrorOptions) {
    super(
      'stream_conflict',
      `stream ${streamType}/${streamId} already has an event at sequence ${streamSeq}`,
      options,
    );
    this.streamType = streamType;
    this.streamId = streamId;
    this.streamSeq = streamSeq;
  }
}

/**
 * `occurred_at` fell outside the range of the created monthly partitions.
 *
 * WP-03 creates the current month and `APP_DB_PARTITION_MONTHS_AHEAD` months ahead, never a past
 * month, and deliberately ships no DEFAULT partition — so a back-dated append is a loud `23514`
 * rather than a silently mis-filed audit row.
 */
export class PartitionWindowError extends ApplicationError {
  readonly occurredAt: string;

  constructor(occurredAt: string, options?: ErrorOptions) {
    super(
      'outside_partition_window',
      `no monthly partition holds occurred_at=${occurredAt}; the event log is never back-dated (technical/03)`,
      options,
    );
    this.occurredAt = occurredAt;
  }
}

/** A stored row no longer parses against the catalogue in `@platform/contracts`. */
export class CorruptEventError extends ApplicationError {
  readonly position: number;

  constructor(position: number, detail: string, options?: ErrorOptions) {
    super('corrupt_event', `event at position ${position} does not match its schema: ${detail}`, {
      ...options,
    });
    this.position = position;
  }
}

/** A handler registration broke the rules of TD-005 (name, priority band, duplicate). */
export class HandlerRegistrationError extends ApplicationError {
  readonly handler: string;

  constructor(handler: string, detail: string) {
    super('handler_registration', `handler "${handler}": ${detail}`);
    this.handler = handler;
  }
}

/** Work was submitted to an `EventBus` that is draining or stopped. */
export class DispatcherStoppedError extends ApplicationError {
  constructor() {
    super('dispatcher_stopped', 'the event bus is stopping; no new dispatch is accepted');
  }
}
