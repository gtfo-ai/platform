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
 * ## Allocating a stream sequence outside a saga
 *
 * `NormalisedEvent` carries `type`, `payload` and `actor` and stops there **on purpose**: a
 * normaliser has no way to know where in a stream its event lands. Somebody has to supply the
 * envelope, and here that somebody is this adapter. The stream is the **integration**
 * (`stream_type: 'integration'`, `stream_id: integrations.id`), which is what technical/02 means by
 * "Producer: adapters" and matches the `{kind: 'integration'}` actor the drafts already carry;
 * `correlation_id` is the task, which is exactly what technical/03 says that envelope field is for.
 *
 * The sequence comes from `EventStore.nextStreamSequence`, read **before** the transaction opens,
 * the way `knowledge/indexer.ts` does it. Two things make that safe rather than optimistic
 * hand-waving:
 *
 *  1. the `events_enforce_stream_seq` trigger takes the `event_streams` row lock inside its own
 *     upsert (migration 0005), so a stale sequence is a `StreamConflictError` and never a silently
 *     mis-ordered stream — this is the *whole* reason the port documents that error;
 *  2. a conflict is **retried** here, up to {@link DEFAULT_MAX_SEQUENCE_ATTEMPTS} times, with the
 *     sequence re-read each time. Nothing was committed, so the retry re-inserts the row rather
 *     than duplicating it. Two outbound calls on one integration genuinely do race — two stage
 *     workers, two processes — and without the retry the *audit* would be the thing that failed
 *     the action.
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
  type EventStore,
  type IntegrationActionEntry,
  type IntegrationAuditLog,
  integrationActionEventDrafts,
  type Logger,
  StreamConflictError,
  silentLogger,
  type UnitOfWork,
} from '@platform/application';
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';

/**
 * How many times a `StreamConflictError` is re-read and retried before the action fails.
 *
 * Four is a bound, not a tuning: the conflict window is a single trigger-held row lock, so a
 * retry that loses again has lost to a *different* concurrent writer each time. An unbounded loop
 * would turn a genuinely stuck stream into a hang inside a provider call.
 */
export const DEFAULT_MAX_SEQUENCE_ATTEMPTS = 4;

export interface PostgresIntegrationAuditLogOptions {
  readonly unitOfWork: UnitOfWork;
  /** Read side, for `nextStreamSequence`. Connection-scoped, outside the transaction. */
  readonly eventStore: Pick<EventStore, 'nextStreamSequence'>;
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

  const writeOnce = async (entry: IntegrationActionEntry): Promise<void> => {
    const drafts = integrationActionEventDrafts(entry);
    // `would_have` and `replayed` write a row and no event, so they never read a sequence and can
    // never conflict on one.
    const firstSeq =
      drafts.length === 0
        ? 0
        : await options.eventStore.nextStreamSequence('integration', entry.integrationId);

    await options.unitOfWork.transaction(async (scope) => {
      await postgresTransaction(scope.tx).client.query(INSERT_ACTION, [
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
