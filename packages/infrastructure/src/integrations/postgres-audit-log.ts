/**
 * `IntegrationAuditLog` on PostgreSQL — BD-003's outbound audit, finally persisted (WP-15b).
 *
 * WP-07 shipped the port, the executor and a memory fake; nothing implemented it, so every
 * composition root that wanted a pipeline had to be handed one by its caller and `apps/server` was
 * handed none. This is the adapter, and `apps/server/src/pipeline.ts` builds it unconditionally —
 * an audit sink a caller may omit is an audit sink that is absent in production (standing rule 31).
 *
 * ## One transaction, two writes
 *
 * The port says it: the `integration_actions` row **and** the events of
 * `integrationActionEventDrafts` commit together, "so the audit and the log can never disagree".
 * That is why this adapter owns a `UnitOfWork` rather than taking a `Transaction` from a caller —
 * the executor calls `record()` from outside any transaction of the platform's, in the middle of a
 * provider call, and BD-003 wants the pair atomic anyway.
 *
 * **A third write, for one action** (WP-80): an `ok` `mint_credential` entry carries the minted
 * value's non-secret shape, and it is upserted into `minted_credential_shapes` in the same
 * transaction — TD-012's M5 amendment asks for the shape *beside the mint's audit row, in its
 * transaction*, so no process can read a mint on record whose shape is not. Since WP-107 (TD-012's
 * M6 amendment (1)) the same transaction publishes `MINTED_CREDENTIAL_SHAPES_TOPIC` on the
 * transactional broadcast, so every process re-reads the shapes on the commit rather than at its
 * next timer read.
 *
 * ## Allocating a stream sequence outside a saga
 *
 * `NormalisedEvent` carries `type`, `payload` and `actor` and stops there **on purpose**: a
 * normaliser has no way to know where in a stream its event lands. Somebody has to supply the
 * envelope, and here that somebody is this adapter. The stream is the **integration**
 * (`stream_type: 'integration'`, `stream_id: integrations.id`), which is what technical/02 means by
 * "Producer: adapters" and matches the `{kind: 'integration'}` actor the drafts already carry;
 * `correlation_id` is the task, which is exactly what technical/03 says that envelope field is for.
 *
 * **The sequence is read inside the transaction, under a per-stream advisory lock** (BACKLOG 970).
 * Every successful provider call on a binding — every read included — appends to that one stream,
 * so it is the hottest stream the platform has: two processes running a gate entry's duties side by
 * side write to it many times a second. It used to be read **before** the transaction opened and a
 * lost race retried, up to four times; under CI's load four losses in a row happened, the audit
 * threw, and a provider call that had **succeeded** reached its caller as a failure — so the job
 * retried and made the call a second time (a read of the merge request's diff, measured in
 * `test/e2e/topology/two-processes.e2e.test.ts`; for a mutation without an idempotency key, a
 * second effect). Now:
 *
 *  1. the transaction takes `pg_advisory_xact_lock` on `integration_stream/<integration id>` before
 *     it reads `event_streams.last_seq`, so two writers of one stream **wait** for each other instead
 *     of racing — the lock is released at commit, and under READ COMMITTED the next holder's read
 *     sees the previous holder's sequence. The application role holds `SELECT` only on
 *     `event_streams` and must not lock its row (technical/03), which is why the lock is advisory;
 *     the transaction is two inserts long, so serialising it costs one round trip per writer;
 *  2. the read goes through the **transaction's own connection**, never a second one from the pool,
 *     so the lock adds no connection to the pool floor;
 *  3. the `events_enforce_stream_seq` trigger still guards the append (migration 0005), and a
 *     `StreamConflictError` is still **retried**, up to {@link DEFAULT_MAX_SEQUENCE_ATTEMPTS} times:
 *     every writer of an `integration` stream is this adapter, so a conflict now needs a writer
 *     that bypasses the lock — the retry is the defence, not the mechanism. Nothing was committed,
 *     so a retry re-inserts the row rather than duplicating it.
 *
 * When the retries run out the error propagates, and that is deliberate (BD-003, standing rule 20):
 * an action whose row could not be written must not be reported as audited. The executor's own
 * docblock owns the consequence — a provider call that succeeded and could not be recorded is
 * surfaced to the caller.
 *
 * Statuses `would_have` and `replayed` produce **no** event (the provider was never called), so no
 * sequence is read for them at all: the cheap path is also the one that cannot conflict.
 */
import {
  type IntegrationActionEntry,
  type IntegrationAuditLog,
  integrationActionEventDrafts,
  type Logger,
  MINTED_CREDENTIAL_SHAPES_TOPIC,
  StreamConflictError,
  silentLogger,
  type UnitOfWork,
} from '@platform/application';
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

/**
 * How many times a `StreamConflictError` is re-read and retried before the action fails.
 *
 * A bound, not a tuning, and no longer the thing that keeps two writers apart — the stream lock is
 * (the module docblock). An unbounded loop would turn a genuinely stuck stream into a hang inside a
 * provider call.
 */
export const DEFAULT_MAX_SEQUENCE_ATTEMPTS = 4;

export interface PostgresIntegrationAuditLogOptions {
  readonly unitOfWork: UnitOfWork;
  /**
   * The stream's next sequence, read on the transaction's connection after the stream lock is
   * held. **A test seam**: production passes nothing and gets {@link readNextSequence}; a test
   * stages a stale answer here to drive the trigger's `StreamConflictError` and the retry.
   */
  readonly readSequence?: (sql: SqlExecutor, integrationId: Id) => Promise<number>;
  /** Event ids. The composition root's generator, so a test can make them deterministic. */
  readonly ids: { next(): Id };
  readonly maxSequenceAttempts?: number;
  readonly logger?: Logger;
}

const INSERT_ACTION = `insert into integration_actions
    (integration_id, project_id, task_id, direction, action, payload, result, status,
     duration_ms, redaction_count, attempts, created_at)
  values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12)`;

/**
 * Serialises the writers of one integration stream for the rest of the transaction (BACKLOG 970).
 * The key's prefix is this lock's own, so it shares no key with another advisory lock.
 */
const LOCK_STREAM = `select pg_advisory_xact_lock(hashtextextended('integration_stream/' || $1, 0))`;

const NEXT_SEQUENCE = `select coalesce(
    (select last_seq from event_streams where stream_type = 'integration' and stream_id = $1),
    0) + 1 as next`;

/** The integration stream's next sequence, on the caller's connection — inside its transaction. */
export const readNextSequence = async (sql: SqlExecutor, integrationId: Id): Promise<number> => {
  const { rows } = await sql.query<{ next: string | number }>(NEXT_SEQUENCE, [integrationId]);
  return Number(rows[0]?.next ?? 1);
};

/**
 * The minted credential's shape, upserted **in the audit row's transaction** (WP-80, TD-012's M5
 * amendment, migration 0057). One row per distinct shape per integration; a later mint of the same
 * shape moves `expires_at` forward and never back, so a short-lived mint cannot shorten the window
 * a longer-lived one of the same shape still needs.
 */
const UPSERT_SHAPE = `insert into minted_credential_shapes
    (integration_id, prefix, charset, length, expires_at)
  values ($1, $2, $3, $4, $5::timestamptz)
  on conflict (integration_id, prefix, charset, length) do update
    set expires_at = greatest(minted_credential_shapes.expires_at, excluded.expires_at),
        updated_at = now()`;

/**
 * The envelope this adapter puts around each draft.
 *
 * Parsed with the catalogue schema before it reaches `append`, so a draft the `events` table would
 * reject fails here — in the adapter that built it — rather than as a constraint violation three
 * frames away. The memory fake does the same (its divergence register says so), which is the point:
 * the two implementations of this port refuse the same documents.
 */
const envelope = (
  entry: IntegrationActionEntry,
  draft: ReturnType<typeof integrationActionEventDrafts>[number],
  id: Id,
  streamSeq: number,
): DomainEvent =>
  domainEventSchemasByType[draft.type].parse({
    id,
    stream_type: 'integration',
    stream_id: entry.integrationId,
    stream_seq: streamSeq,
    // technical/03: "the task the event belongs to, for cross-stream correlation". An action with
    // no task (a health check, an inbound normalisation) correlates with nothing, which is `null`.
    correlation_id: entry.taskId,
    cause_event_id: null,
    actor: draft.actor,
    occurred_at: entry.occurredAt,
    type: draft.type,
    payload: draft.payload,
  }) as DomainEvent;

export const createPostgresIntegrationAuditLog = (
  options: PostgresIntegrationAuditLogOptions,
): IntegrationAuditLog => {
  const logger = options.logger ?? silentLogger;
  const maxAttempts = options.maxSequenceAttempts ?? DEFAULT_MAX_SEQUENCE_ATTEMPTS;
  if (maxAttempts < 1) {
    throw new TypeError(`maxSequenceAttempts must be at least 1, got ${maxAttempts}`);
  }

  const readSequence = options.readSequence ?? readNextSequence;

  const writeOnce = async (entry: IntegrationActionEntry): Promise<void> => {
    const drafts = integrationActionEventDrafts(entry);

    await options.unitOfWork.transaction(async (scope) => {
      const sql = postgresTransaction(scope.tx).client;
      // `would_have` and `replayed` write a row and no event, so they take no lock, read no
      // sequence and can never conflict on one.
      let firstSeq = 0;
      if (drafts.length > 0) {
        await sql.query(LOCK_STREAM, [entry.integrationId]);
        firstSeq = await readSequence(sql, entry.integrationId);
      }
      await sql.query(INSERT_ACTION, [
        entry.integrationId,
        entry.projectId,
        entry.taskId,
        entry.direction,
        entry.action,
        JSON.stringify(entry.payload),
        entry.result === null ? null : JSON.stringify(entry.result),
        entry.status,
        entry.durationMs,
        entry.redactionCount,
        entry.attempts,
        entry.occurredAt,
      ]);
      const shape = entry.status === 'ok' ? entry.credentialShape : undefined;
      if (shape !== undefined) {
        await sql.query(UPSERT_SHAPE, [
          entry.integrationId,
          shape.shape.prefix,
          shape.shape.charset,
          shape.shape.length,
          shape.expiresAt,
        ]);
        // WP-107 (TD-012's M6 amendment (1)): every process re-reads the shapes on this hint, which
        // `pg_notify` delivers only if this transaction commits — never a shape that rolled back.
        await scope.broadcast.publish({ topic: MINTED_CREDENTIAL_SHAPES_TOPIC, payload: {} });
      }
      if (drafts.length > 0) {
        await scope.events.append(
          drafts.map((draft, index) =>
            envelope(entry, draft, options.ids.next(), firstSeq + index),
          ),
        );
      }
    });
  };

  return {
    record: async (entry) => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await writeOnce(entry);
          return;
        } catch (error) {
          if (!(error instanceof StreamConflictError) || attempt >= maxAttempts) {
            throw error;
          }
          logger.warn(
            {
              integration_id: entry.integrationId,
              action: entry.action,
              attempt,
              max_attempts: maxAttempts,
            },
            'another writer took the integration stream sequence; re-reading it and retrying the audit write',
          );
        }
      }
    },
  };
};
