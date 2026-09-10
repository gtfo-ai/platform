/**
 * How this package emits domain events.
 *
 * Every event shape already exists in `@platform/contracts` (WP-01, transcribed from
 * technical/02's catalogue); nothing is redefined here. This module only supplies the envelope an
 * aggregate can fill in — the aggregate knows its stream and its sequence number, the caller
 * supplies ids, actor and clock — and then *parses* the result with the catalogue schema. Parsing
 * on the way out means a payload that drifts from the contract fails in this package's own unit
 * tests rather than at the database boundary.
 *
 * `actor` lives in the envelope, not in payloads (technical/02, as implemented in WP-01).
 */
import {
  type Actor,
  type DomainEvent,
  type DomainEventType,
  domainEventSchemasByType,
  type EventOfType,
  type EventPayload,
  type Id,
  type IsoDateTime,
  type StreamType,
} from '@platform/contracts';
import type { Clock } from './clock.js';
import type { IdSource } from './ids.js';

/** Everything a command needs that the aggregate cannot know by itself. */
export interface CommandContext {
  readonly ids: IdSource;
  readonly actor: Actor;
  readonly clock: Clock;
  /** The task the events belong to, for cross-stream correlation (technical/03). */
  readonly correlationId?: Id | null;
  /** The event that caused this one, when the command runs inside a handler. */
  readonly causeEventId?: Id | null;
}

/**
 * The `stream_seq` an aggregate's **first** event carries.
 *
 * One, not zero, and it is a constraint rather than a convention: `events_stream_seq_positive`
 * (migration 0005) is `check (stream_seq >= 1)` and the `events_stream_seq_guard` trigger expects
 * `last + 1`, so a stream that opened at 0 would be refused by the database. Every aggregate here
 * started at 0 until WP-15 appended one to a real store for the first time — the aggregates were
 * unit-tested against themselves and the store against hand-built fixtures, and nothing had ever
 * put the two together.
 */
export const FIRST_STREAM_SEQ = 1;

/** The aggregate's position in the log: which stream, and the sequence number to use. */
export interface EventStreamPosition {
  readonly streamType: StreamType;
  readonly streamId: Id;
  readonly streamSeq: number;
}

/**
 * Builds one catalogue event and validates it against its schema.
 *
 * @throws {import('zod').ZodError} when the payload does not match the catalogue.
 */
export const buildEvent = <T extends DomainEventType>(
  type: T,
  payload: EventPayload<T>,
  stream: EventStreamPosition,
  context: CommandContext,
): EventOfType<T> => {
  const candidate = {
    id: context.ids.next(),
    stream_type: stream.streamType,
    stream_id: stream.streamId,
    stream_seq: stream.streamSeq,
    correlation_id: context.correlationId ?? null,
    cause_event_id: context.causeEventId ?? null,
    actor: context.actor,
    occurred_at: context.clock.now(),
    type,
    payload,
  };
  // `domainEventSchemasByType` is a lookup over the discriminated union, so its value type is the
  // union of all members; the `type` key narrows it for the reader but not for TypeScript.
  return domainEventSchemasByType[type].parse(candidate) as EventOfType<T>;
};

/**
 * Accumulates the events of one command, keeping the stream sequence contiguous.
 *
 * The clock is read **once**, when the recorder is created: everything one command produces
 * happens in one transaction (technical/02's transactional outbox), so every event it emits — and
 * every timestamp the aggregate stores alongside them — carries the same instant. `occurredAt`
 * exposes it so an aggregate's `started_at` cannot drift from its own `run.started` event.
 *
 * Aggregates never hold mutable state; this recorder is the one mutable thing, local to a single
 * command call, and it is consumed immediately.
 */
export const eventRecorder = (
  stream: { readonly streamType: StreamType; readonly streamId: Id },
  startSeq: number,
  context: CommandContext,
) => {
  const events: DomainEvent[] = [];
  const occurredAt = context.clock.now();
  const frozen: CommandContext = { ...context, clock: { now: () => occurredAt } };
  let seq = startSeq;
  return {
    emit<T extends DomainEventType>(type: T, payload: EventPayload<T>): void {
      events.push(
        buildEvent(
          type,
          payload,
          { streamType: stream.streamType, streamId: stream.streamId, streamSeq: seq },
          frozen,
        ),
      );
      seq += 1;
    },
    /** The instant every event of this command carries. */
    get occurredAt(): IsoDateTime {
      return occurredAt;
    },
    get events(): readonly DomainEvent[] {
      return events;
    },
    get sequence(): number {
      return seq;
    },
  };
};

/** The result every aggregate command returns: the next state and the events it produced. */
export interface Decision<TAggregate> {
  readonly aggregate: TAggregate;
  readonly events: readonly DomainEvent[];
}
