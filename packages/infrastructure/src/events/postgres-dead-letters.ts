/**
 * The dead-letter store over PostgreSQL (WP-95, PROGRESS backlog 126) — the list migration 0037's
 * partial index was built for, and the re-queue its header documented as a hand-typed `update`.
 *
 * Two statements matter here:
 *
 * - **The list reads `event_dispatch` joined to `events`**, never `events` alone: a dead letter is a
 *   fact about the queue row (`dead_lettered_at`), and the log does not know it. The join carries
 *   `occurred_at` because it is part of `events`' primary key, so the probe prunes to one partition.
 *   The task is resolved the way the dead-letter sink resolves it (`taskOfEvent`: the task stream,
 *   else `correlation_id`) and only when the row exists, so the list never names a task the sink
 *   could not have escalated.
 * - **The arbiter is the locking read** (standing rule 9): `select … where dead_lettered_at is not
 *   null for update of d` takes the queue row's lock, so of two concurrent re-queues the second
 *   blocks until the first commits, then re-evaluates its predicate against the committed row,
 *   finds it no longer dead-lettered, gets nothing back and answers `pending`. The `update`'s own
 *   `dead_lettered_at is not null` is a **second check** under a lock this transaction already
 *   holds — belt and braces, not the decision. A dispatcher that holds the row (`claim`'s `FOR
 *   UPDATE SKIP LOCKED`) makes the locking read wait for its transaction, and a claim that comes
 *   after sees the row queued again — the sequencing the dispatcher's own comment anticipates
 *   (`claim`: *"a concurrent requeue could slip between the two reads"*, which is why it reads the
 *   flag with the lock).
 */
import type {
  DeadLetterPage,
  DeadLetterPageRequest,
  DeadLetterRequeueOutcome,
  DeadLetterRow,
  DeadLetterStore,
  Transaction,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { postgresTransaction } from './postgres-unit-of-work.js';
import type { SqlExecutor } from './sql.js';

interface DeadLetterSqlRow extends Record<string, unknown> {
  position: string | number;
  event_type: string;
  stream_type: string;
  stream_id: string;
  occurred_at: Date | string;
  dead_lettered_at: Date | string;
  handler: string | null;
  attempts: number;
  error: string | null;
  task_id: string | null;
  ticket_key: string | null;
  project_key: string | null;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/**
 * The columns every dead-letter read selects, over `d` (the queue row) and `e` (the event).
 *
 * The task join is the sink's rule in SQL. A `correlation_id` that is not a task id — technical/03
 * defines it as the task an event belongs to, but nothing enforces that — joins nothing, which is
 * the sink's own ending for it ("loads no row").
 */
const SELECT = `
  select d.event_position as position,
         e.type as event_type,
         d.stream_type,
         d.stream_id,
         d.occurred_at,
         d.dead_lettered_at,
         d.dead_letter_handler as handler,
         d.attempts,
         d.error,
         t.id as task_id,
         t.ticket_key,
         p.key as project_key
    from event_dispatch d
    join events e on e.occurred_at = d.occurred_at and e.position = d.event_position
    left join tasks t
      on t.id = case when d.stream_type = 'task' then d.stream_id else e.correlation_id end
    left join projects p on p.id = t.project_id`;

const toRow = (row: DeadLetterSqlRow): DeadLetterRow => ({
  position: Number(row.position),
  eventType: row.event_type,
  streamType: row.stream_type,
  streamId: row.stream_id as Id,
  occurredAt: iso(row.occurred_at),
  deadLetteredAt: iso(row.dead_lettered_at),
  handler: row.handler,
  attempts: row.attempts,
  error: row.error,
  task:
    row.task_id === null || row.ticket_key === null || row.project_key === null
      ? null
      : { id: row.task_id as Id, ticketKey: row.ticket_key, projectKey: row.project_key },
});

export class PostgresDeadLetterStore implements DeadLetterStore {
  readonly #sql: SqlExecutor;

  constructor(sql: SqlExecutor) {
    this.#sql = sql;
  }

  readonly list = async (request: DeadLetterPageRequest): Promise<DeadLetterPage> => {
    const values: unknown[] = [request.limit];
    const bounds = ['d.dead_lettered_at is not null'];
    if (request.beforePosition !== undefined) {
      values.push(request.beforePosition);
      bounds.push(`d.event_position < $${values.length}`);
    }
    const [page, count] = await Promise.all([
      this.#sql.query<DeadLetterSqlRow>(
        `${SELECT}
          where ${bounds.join(' and ')}
          order by d.event_position desc
          limit $1`,
        values,
      ),
      this.#sql.query<{ total: string | number }>(
        'select count(*) as total from event_dispatch where dead_lettered_at is not null',
      ),
    ]);
    return { items: page.rows.map(toRow), total: Number(count.rows[0]?.total ?? 0) };
  };

  readonly requeue = async (
    tx: Transaction,
    position: number,
  ): Promise<DeadLetterRequeueOutcome> => {
    const { client } = postgresTransaction(tx);
    // The arbiter (module note): this locking read decides which of two concurrent re-queues
    // proceeds. It is also read **before** the update because the update clears the two columns
    // the audit row has to name (the handler and the instant).
    const locked = await client.query<DeadLetterSqlRow>(
      `${SELECT}
        where d.event_position = $1 and d.dead_lettered_at is not null
        for update of d`,
      [position],
    );
    const before = locked.rows[0];
    if (before !== undefined) {
      // `dead_lettered_at is not null` again: a second check under the lock held since the read.
      const updated = await client.query<{ requeued_at: Date | string }>(
        `update event_dispatch
            set attempts = 0,
                dead_lettered_at = null,
                dead_letter_handler = null,
                available_at = now()
          where event_position = $1 and dead_lettered_at is not null
        returning now() as requeued_at`,
        [position],
      );
      const at = updated.rows[0];
      if (at !== undefined) {
        return { status: 'requeued', row: toRow(before), requeuedAt: iso(at.requeued_at) };
      }
    }
    // Not dead-lettered (or another transaction re-queued it first): which state is it in?
    const present = await client.query('select 1 from event_dispatch where event_position = $1', [
      position,
    ]);
    if ((present.rowCount ?? 0) > 0) {
      return { status: 'pending' };
    }
    const logged = await client.query('select 1 from events where position = $1', [position]);
    return (logged.rowCount ?? 0) > 0 ? { status: 'dispatched' } : { status: 'unknown' };
  };
}
