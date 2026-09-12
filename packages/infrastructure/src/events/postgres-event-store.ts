/**
 * The PostgreSQL event store, dispatch queue and handler-execution log (TD-005).
 *
 * The read side is connection-scoped; every writer is bound to a transaction, because TD-005's
 * whole guarantee is that state, events and dispatch bookkeeping commit together.
 *
 * Three things here are load-bearing and easy to "simplify" wrongly:
 *
 * - **Nothing locks `event_streams`.** The `events_enforce_stream_seq` trigger takes that row lock
 *   inside its own upsert, so appends to one stream already serialise; the application role holds
 *   SELECT only there, and every row-lock mode would return `42501` (migration 0005).
 * - **`claim` is `FOR UPDATE SKIP LOCKED` on `event_dispatch`**, held for the whole dispatch. It is
 *   what stops two workers from running one event's handlers at once, without either of them
 *   waiting.
 * - **`claimHandler` is an upsert with a `WHERE` that excludes terminal rows.** `ON CONFLICT DO
 *   UPDATE` locks the conflicting row even when the `WHERE` rejects it, so a second claimant blocks
 *   until the first commits and then sees `succeeded` and skips — the idempotency guard and the
 *   mutual exclusion are the same statement.
 */
import {
  type AppendOptions,
  type DispatchClaim,
  type DispatchQueue,
  EVENTS_APPENDED_TOPIC,
  type EventAppender,
  type EventStore,
  type HandlerExecutionReader,
  type HandlerExecutionRecord,
  type HandlerExecutionStatus,
  type HandlerExecutionWriter,
  type HandlerRef,
  PartitionWindowError,
  type PendingDispatchRequest,
  type ReadRangeRequest,
  type ReadStreamOptions,
  type RetryBackoff,
  type StoredEvent,
  type TransactionalBroadcast,
} from '@platform/application';
import type { DomainEvent, Id, StreamType } from '@platform/contracts';
import {
  type EventRow,
  eventColumns,
  type SqlExecutor,
  toStoredEvent,
  translateAppendError,
} from './sql.js';

/** The connection-scoped read side. */
export class PostgresEventStore implements EventStore, HandlerExecutionReader {
  readonly #sql: SqlExecutor;

  constructor(sql: SqlExecutor) {
    this.#sql = sql;
  }

  async readStream(
    streamType: StreamType,
    streamId: Id,
    options: ReadStreamOptions = {},
  ): Promise<readonly StoredEvent[]> {
    const limit = options.limit === undefined ? 'all' : '$4';
    const values: unknown[] = [streamType, streamId, options.fromSeq ?? 1];
    if (options.limit !== undefined) {
      values.push(options.limit);
    }
    const { rows } = await this.#sql.query<EventRow>(
      `select ${eventColumns()}
         from events
        where stream_type = $1 and stream_id = $2 and stream_seq >= $3
        order by stream_seq
        limit ${limit}`,
      values,
    );
    return rows.map(toStoredEvent);
  }

  /**
   * `event_streams.last_seq + 1`. Reading the counter rather than `max(stream_seq)` is O(1) and
   * gives the same answer: the counter rolls back with a failed append, exactly like the events do.
   */
  async nextStreamSequence(streamType: StreamType, streamId: Id): Promise<number> {
    const { rows } = await this.#sql.query<{ next: string | number }>(
      `select coalesce(
                (select last_seq from event_streams where stream_type = $1 and stream_id = $2),
                0) + 1 as next`,
      [streamType, streamId],
    );
    return Number(rows[0]?.next ?? 1);
  }

  async readAt(position: number): Promise<StoredEvent | null> {
    const { rows } = await this.#sql.query<EventRow>(
      `select ${eventColumns()} from events where position = $1`,
      [position],
    );
    const row = rows[0];
    return row === undefined ? null : toStoredEvent(row);
  }

  /**
   * A window of the log, from `events` itself.
   *
   * Deliberately **not** a join onto `event_dispatch`: a backfill exists precisely for events whose
   * dispatch already completed, and those have no queue row left. The partition pruning that
   * `readPendingDispatch` gets from `occurred_at` is unavailable here — a position range says
   * nothing about a month — so this scans the partitions and is a maintenance read, not a hot path.
   */
  async readRange(request: ReadRangeRequest): Promise<readonly StoredEvent[]> {
    const values: unknown[] = [request.fromPosition, request.limit];
    const bounds: string[] = ['position > $1'];
    if (request.toPosition !== undefined) {
      values.push(request.toPosition);
      bounds.push(`position <= $${values.length}`);
    }
    if (request.types !== undefined) {
      values.push([...request.types]);
      bounds.push(`type = any($${values.length}::text[])`);
    }
    const { rows } = await this.#sql.query<EventRow>(
      `select ${eventColumns()}
         from events
        where ${bounds.join(' and ')}
        order by position
        limit $2`,
      values,
    );
    return rows.map(toStoredEvent);
  }

  /**
   * The sweep. `row_number()` keeps at most one event per stream in the result, so two workers
   * sweeping at the same time can never take two events of one stream — ordering per stream holds
   * before the per-event claim is even reached.
   *
   * The due filter is applied *after* the head is chosen, not inside the window: a stream whose
   * earliest event is waiting out a retry backoff must yield nothing, not offer its second event
   * to a dispatcher that would only refuse it.
   */
  async readPendingDispatch(request: PendingDispatchRequest): Promise<readonly StoredEvent[]> {
    const { rows } = await this.#sql.query<EventRow>(
      `with head as (
         select d.event_position,
                d.occurred_at,
                d.available_at,
                row_number() over (
                  partition by d.stream_type, d.stream_id order by d.stream_seq) as rn
           from event_dispatch d
       )
       select ${eventColumns('e')}
         from head h
         join events e on e.occurred_at = h.occurred_at and e.position = h.event_position
        where h.rn = 1 and h.available_at <= now()
        order by e.position
        limit $1`,
      [request.limit],
    );
    return rows.map(toStoredEvent);
  }

  async countPendingDispatch(): Promise<number> {
    const { rows } = await this.#sql.query<{ pending: string | number }>(
      'select count(*) as pending from event_dispatch',
    );
    return Number(rows[0]?.pending ?? 0);
  }

  async read(position: number): Promise<readonly HandlerExecutionRecord[]> {
    const { rows } = await this.#sql.query<{
      event_position: string | number;
      handler: string;
      priority: number;
      status: string;
      attempts: number;
      error: string | null;
    }>(
      `select event_position, handler, priority, status, attempts, error
         from handler_executions
        where event_position = $1
        order by priority, handler`,
      [position],
    );
    return rows.map((row) => ({
      eventPosition: Number(row.event_position),
      handler: row.handler,
      priority: row.priority,
      status: row.status as HandlerExecutionStatus,
      attempts: row.attempts,
      error: row.error,
    }));
  }
}

/** Transaction-bound append. Publishes the wake-up hint on the same transaction (TD-005). */
export class PostgresEventAppender implements EventAppender {
  readonly #sql: SqlExecutor;
  readonly #broadcast: TransactionalBroadcast;

  constructor(sql: SqlExecutor, broadcast: TransactionalBroadcast) {
    this.#sql = sql;
    this.#broadcast = broadcast;
  }

  async append(
    events: readonly DomainEvent[],
    options: AppendOptions = {},
  ): Promise<readonly StoredEvent[]> {
    if (events.length === 0) {
      return [];
    }
    const appended: StoredEvent[] = [];
    for (const event of events) {
      assertInPartitionWindow(event);
      appended.push(await this.#appendOne(event, options.causeEventPosition ?? null));
    }
    // One hint per committing transaction: PostgreSQL collapses identical notifications from one
    // transaction into a single delivery, so this stays a hint however many events were appended.
    await this.#broadcast.publish({ topic: EVENTS_APPENDED_TOPIC, payload: {} });
    return appended;
  }

  async #appendOne(event: DomainEvent, causeEventPosition: number | null): Promise<StoredEvent> {
    try {
      const { rows } = await this.#sql.query<{ position: string | number }>(
        `insert into events (id, stream_type, stream_id, stream_seq, type, payload, actor,
                             cause_event_id, cause_event_position, correlation_id, occurred_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11::timestamptz)
         returning position`,
        [
          event.id,
          event.stream_type,
          event.stream_id,
          event.stream_seq,
          event.type,
          JSON.stringify(event.payload),
          JSON.stringify(event.actor),
          event.cause_event_id ?? null,
          causeEventPosition,
          event.correlation_id ?? null,
          event.occurred_at,
        ],
      );
      return { position: Number(rows[0]?.position), causeEventPosition, event };
    } catch (error) {
      return translateAppendError(error, event);
    }
  }
}

/**
 * Rejects an obviously back-dated append before it reaches the database.
 *
 * technical/03 creates the current month and `APP_DB_PARTITION_MONTHS_AHEAD` months ahead, never a
 * past one, and ships no DEFAULT partition, so a back-dated `occurred_at` is a `23514` — translated
 * by `translateAppendError`. This check only catches the blatant case early, to name the real
 * problem (a caller-supplied timestamp) instead of a constraint number.
 *
 * The bound is the **previous** month, not the current one, and that is not slack: an event built
 * at 23:59:59.9 on the last day of a month and appended a moment later belongs in a partition that
 * still exists, and rejecting it here would be a false failure once a month. Anything the database
 * can still file, the database decides on.
 */
const assertInPartitionWindow = (event: DomainEvent): void => {
  const at = Date.parse(event.occurred_at);
  const now = new Date();
  const floor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  if (Number.isNaN(at) || at < floor) {
    throw new PartitionWindowError(event.occurred_at);
  }
};

/** Transaction-bound queue operations. `claim` holds its row until the transaction ends. */
export class PostgresDispatchQueue implements DispatchQueue {
  readonly #sql: SqlExecutor;

  constructor(sql: SqlExecutor) {
    this.#sql = sql;
  }

  async claim(position: number): Promise<DispatchClaim> {
    const locked = await this.#sql.query(
      'select 1 from event_dispatch where event_position = $1 for update skip locked',
      [position],
    );
    if ((locked.rowCount ?? 0) > 0) {
      return 'claimed';
    }
    // Nothing came back for one of two reasons; only a second, lock-free look tells them apart.
    const present = await this.#sql.query(
      'select 1 from event_dispatch where event_position = $1',
      [position],
    );
    return (present.rowCount ?? 0) > 0 ? 'busy' : 'completed';
  }

  async complete(position: number): Promise<void> {
    await this.#sql.query('delete from event_dispatch where event_position = $1', [position]);
  }

  async retryLater(position: number, error: string, backoff: RetryBackoff): Promise<void> {
    // `attempts` on the right-hand side is the pre-update value, so the first retry waits
    // `baseMs`, the second twice that, and so on up to `maxMs`.
    await this.#sql.query(
      `update event_dispatch
          set attempts = attempts + 1,
              error = $2,
              available_at = now() + (least(
                $3::double precision * power(2, least(attempts, 10)),
                $4::double precision) * interval '1 millisecond')
        where event_position = $1`,
      [position, error, backoff.baseMs, backoff.maxMs],
    );
  }

  async hasEarlierPending(
    streamType: StreamType,
    streamId: Id,
    streamSeq: number,
  ): Promise<boolean> {
    const { rows } = await this.#sql.query<{ blocked: boolean }>(
      `select exists (
         select 1 from event_dispatch
          where stream_type = $1 and stream_id = $2 and stream_seq < $3) as blocked`,
      [streamType, streamId, streamSeq],
    );
    return rows[0]?.blocked === true;
  }
}

/** Transaction-bound idempotency bookkeeping. */
export class PostgresHandlerExecutions implements HandlerExecutionWriter {
  readonly #sql: SqlExecutor;

  constructor(sql: SqlExecutor) {
    this.#sql = sql;
  }

  async claim(position: number, handler: HandlerRef): Promise<boolean> {
    const { rowCount } = await this.#sql.query(
      `insert into handler_executions
              (event_position, handler, priority, status, attempts, started_at)
       values ($1, $2, $3, 'running', 1, now())
       on conflict (event_position, handler) do update
          set status = 'running',
              priority = excluded.priority,
              attempts = handler_executions.attempts + 1,
              started_at = now(),
              finished_at = null,
              error = null
        where handler_executions.status not in ('succeeded', 'stopped')
       returning attempts`,
      [position, handler.handler, handler.priority],
    );
    return (rowCount ?? 0) > 0;
  }

  async complete(position: number, handler: HandlerRef): Promise<void> {
    await this.#sql.query(
      `insert into handler_executions
              (event_position, handler, priority, status, attempts, started_at, finished_at)
       values ($1, $2, $3, 'succeeded', 1, now(), now())
       on conflict (event_position, handler) do update
          set status = 'succeeded', finished_at = now(), error = null`,
      [position, handler.handler, handler.priority],
    );
  }

  async recordFailure(position: number, handler: HandlerRef, error: string): Promise<void> {
    await this.#sql.query(
      `insert into handler_executions
              (event_position, handler, priority, status, attempts, error, started_at, finished_at)
       values ($1, $2, $3, 'failed', 1, $4, now(), now())
       on conflict (event_position, handler) do update
          set status = 'failed',
              attempts = handler_executions.attempts + 1,
              error = $4,
              finished_at = now()
        where handler_executions.status not in ('succeeded', 'stopped')`,
      [position, handler.handler, handler.priority, error],
    );
  }

  async markStopped(
    position: number,
    remaining: readonly HandlerRef[],
    reason: string,
  ): Promise<void> {
    if (remaining.length === 0) {
      return;
    }
    // The update on conflict matters: a handler left `failed` by an earlier attempt must become
    // terminal, or the next redelivery — where the policy handler is skipped as already succeeded
    // — would let it run after all.
    await this.#sql.query(
      `insert into handler_executions
              (event_position, handler, priority, status, attempts, error, started_at, finished_at)
       select $1, r.handler, r.priority, 'stopped', 0, $2, now(), now()
         from unnest($3::text[], $4::int[]) as r(handler, priority)
       on conflict (event_position, handler) do update
          set status = 'stopped', error = $2, finished_at = now()
        where handler_executions.status not in ('succeeded', 'stopped')`,
      [
        position,
        reason,
        remaining.map((entry) => entry.handler),
        remaining.map((entry) => entry.priority),
      ],
    );
  }
}
