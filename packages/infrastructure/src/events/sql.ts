/**
 * The narrow SQL surface the event-store adapters need, plus the two translations that turn
 * PostgreSQL's error codes into the typed errors `@platform/application` declares.
 */

import {
  CorruptEventError,
  PartitionWindowError,
  type StoredEvent,
  StreamConflictError,
} from '@platform/application';
import { type DomainEvent, domainEventSchemasByType } from '@platform/contracts';

/** What both `pg.Pool` and `pg.PoolClient` provide, and all these adapters use. */
export interface SqlExecutor {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

const EVENT_COLUMN_NAMES = [
  'position',
  'id',
  'stream_type',
  'stream_id',
  'stream_seq',
  'type',
  'payload',
  'actor',
  'cause_event_id',
  'cause_event_position',
  'correlation_id',
  'occurred_at',
] as const;

/**
 * Columns every read of `events` selects, in one place so the row mapper cannot drift.
 *
 * `alias` is not cosmetic: the sweep joins `events` to a CTE that also carries `occurred_at`, and
 * an unqualified list makes the reference ambiguous — a runtime error a unit test with a stubbed
 * executor cannot see.
 */
export const eventColumns = (alias?: string): string => {
  const prefix = alias === undefined ? '' : `${alias}.`;
  return EVENT_COLUMN_NAMES.map((column) => `${prefix}${column}`).join(', ');
};

export interface EventRow extends Record<string, unknown> {
  readonly position: string | number;
  readonly id: string;
  readonly stream_type: string;
  readonly stream_id: string;
  readonly stream_seq: number;
  readonly type: string;
  readonly payload: unknown;
  readonly actor: unknown;
  readonly cause_event_id: string | null;
  readonly cause_event_position: string | number | null;
  readonly correlation_id: string | null;
  readonly occurred_at: Date | string;
}

/**
 * Rebuilds the catalogue event from its row and **parses it**.
 *
 * Parsing on the way out is deliberate: an event whose payload no longer matches the schema it was
 * written with is a fact worth failing on, not one to hand to a handler that will misread it. The
 * failure names the position, which is enough to find the row.
 */
export const toStoredEvent = (row: EventRow): StoredEvent => {
  const position = Number(row.position);
  const candidate = {
    id: row.id,
    stream_type: row.stream_type,
    stream_id: row.stream_id,
    stream_seq: row.stream_seq,
    correlation_id: row.correlation_id,
    cause_event_id: row.cause_event_id,
    actor: row.actor,
    occurred_at: toIso(row.occurred_at),
    type: row.type,
    payload: row.payload,
  };

  const schema = domainEventSchemasByType[row.type as DomainEvent['type']];
  if (schema === undefined) {
    throw new CorruptEventError(position, `"${row.type}" is not a catalogue event type`);
  }
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CorruptEventError(
      position,
      `${issue?.path.join('.') ?? '(root)'}: ${issue?.message ?? 'invalid'}`,
    );
  }

  return {
    position,
    causeEventPosition: row.cause_event_position === null ? null : Number(row.cause_event_position),
    event: parsed.data as DomainEvent,
  };
};

/** `timestamptz` arrives as a `Date` from `pg`; the wire format is RFC 3339 with an offset. */
const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

interface PostgresError {
  readonly code?: string;
  readonly message?: string;
}

const asPostgresError = (error: unknown): PostgresError =>
  typeof error === 'object' && error !== null ? (error as PostgresError) : {};

/** `23505` from the sequence guard, `23514` from a missing partition — everything else is rethrown. */
export const translateAppendError = (error: unknown, event: DomainEvent): never => {
  const { code, message = '' } = asPostgresError(error);

  // migration 0005's events_enforce_stream_seq() raises unique_violation with this wording. The
  // message is matched as well as the code so an unrelated unique index is not mistaken for a
  // concurrency conflict.
  if (code === '23505' && /^stream .* is at sequence/.test(message)) {
    throw new StreamConflictError(event.stream_type, event.stream_id, event.stream_seq, {
      cause: error,
    });
  }
  // "no partition of relation "events" found for row" — technical/03 ships no DEFAULT partition
  // and never creates a past month, so a back-dated append is loud rather than mis-filed.
  if (code === '23514' && /no partition of relation/.test(message)) {
    throw new PartitionWindowError(event.occurred_at, { cause: error });
  }
  throw error;
};
