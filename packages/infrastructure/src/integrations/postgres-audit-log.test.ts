/**
 * The unit tier of the Postgres `IntegrationAuditLog` — everything about it that is not the
 * database.
 *
 * Three behaviours live only here, because the integration tier cannot make them happen on demand:
 * the envelope this adapter puts around a `NormalisedEvent`, the `StreamConflictError` retry (a
 * real race is not reproducible to order), and the fact that a retried transaction inserts the row
 * **once**. The harness models the one property of a transaction that matters for that last
 * question — writes are discarded when the body throws — and nothing else.
 *
 * `test/integration/integrations/audit-log.integration.test.ts` then runs the same adapter against
 * a migrated PostgreSQL 18 with the shared port suite.
 */
import {
  type IntegrationActionEntry,
  StreamConflictError,
  type TransactionScope,
  type UnitOfWork,
} from '@platform/application';
import type { DomainEvent, Id, IsoDateTime, StreamType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../events/sql.js';
import { createPostgresIntegrationAuditLog } from './postgres-audit-log.js';

const INTEGRATION = '00000000-0000-4000-8000-0000000000a1' as Id;
const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;

const entry = (overrides: Partial<IntegrationActionEntry> = {}): IntegrationActionEntry => ({
  integrationId: INTEGRATION,
  provider: 'fake-task-management',
  projectId: PROJECT,
  taskId: TASK,
  direction: 'out',
  action: 'add_comment',
  mutating: true,
  status: 'ok',
  payload: { body: 'hello' },
  result: { comment_id: '7' },
  error: null,
  durationMs: 12,
  occurredAt: '2026-09-11T10:00:00.000Z' as IsoDateTime,
  redactionCount: 0,
  attempts: 1,
  ...overrides,
});

interface Harness {
  readonly log: ReturnType<typeof createPostgresIntegrationAuditLog>;
  /** Statements of *committed* transactions only. */
  readonly committed: readonly { text: string; values: readonly unknown[] }[];
  readonly appended: readonly DomainEvent[];
  readonly sequenceReads: readonly { streamType: StreamType; streamId: Id }[];
}

/**
 * @param conflicts how many appends raise `StreamConflictError` before one succeeds.
 */
const harnessWith = (conflicts: number, maxSequenceAttempts?: number): Harness => {
  const committed: { text: string; values: readonly unknown[] }[] = [];
  const appended: DomainEvent[] = [];
  const sequenceReads: { streamType: StreamType; streamId: Id }[] = [];
  let remaining = conflicts;
  let nextSeq = 7;

  const unitOfWork: UnitOfWork = {
    transaction: async (fn) => {
      const pending: { text: string; values: readonly unknown[] }[] = [];
      const pendingEvents: DomainEvent[] = [];
      const sql: SqlExecutor = {
        query: async (text, values = []) => {
          pending.push({ text, values });
          return { rows: [], rowCount: 1 };
        },
      };
      const scope = {
        tx: { adapter: 'postgres', client: sql },
        events: {
          append: async (events: readonly DomainEvent[]) => {
            if (remaining > 0) {
              remaining -= 1;
              // What migration 0005's trigger raises when the sequence was taken meanwhile.
              nextSeq += 1;
              const first = events[0] as DomainEvent;
              throw new StreamConflictError(first.stream_type, first.stream_id, first.stream_seq);
            }
            pendingEvents.push(...events);
            return [];
          },
        },
      } as unknown as TransactionScope;

      // Rollback is the only transactional property this test needs: a body that throws leaves
      // nothing behind, which is what makes "the row was inserted once" a real question.
      const result = await fn(scope);
      committed.push(...pending);
      appended.push(...pendingEvents);
      return result;
    },
  };

  return {
    log: createPostgresIntegrationAuditLog({
      unitOfWork,
      eventStore: {
        nextStreamSequence: async (streamType, streamId) => {
          sequenceReads.push({ streamType, streamId });
          return nextSeq;
        },
      },
      ids: { next: () => `00000000-0000-4000-8000-00000000e00${sequenceReads.length}` as Id },
      ...(maxSequenceAttempts === undefined ? {} : { maxSequenceAttempts }),
    }),
    committed,
    appended,
    sequenceReads,
  };
};

describe('createPostgresIntegrationAuditLog', () => {
  it('writes the row and the event in one transaction, on the integration stream', async () => {
    const harness = harnessWith(0);
    await harness.log.record(entry());

    expect(harness.committed).toHaveLength(1);
    expect(harness.committed[0]?.text).toMatch(/insert into integration_actions/);
    expect(harness.appended).toHaveLength(1);
    expect(harness.appended[0]).toMatchObject({
      type: 'integration.action.performed',
      stream_type: 'integration',
      stream_id: INTEGRATION,
      stream_seq: 7,
      // technical/03: the envelope's correlation is the task, which is how an audit event is found
      // from the task that caused it.
      correlation_id: TASK,
      actor: { kind: 'integration', integration_id: INTEGRATION, provider: 'fake-task-management' },
      occurred_at: '2026-09-11T10:00:00.000Z',
    });
  });

  it('writes every column the entry carries, including the three migration 0013 added', async () => {
    const harness = harnessWith(0);
    await harness.log.record(entry({ redactionCount: 3, attempts: 2 }));

    const values = harness.committed[0]?.values ?? [];
    // Positional, because that is what the statement is: integration, project, task, direction,
    // action, payload, result, status, duration, redaction_count, attempts, created_at.
    expect(values[1]).toBe(PROJECT);
    expect(values[9]).toBe(3);
    expect(values[10]).toBe(2);
  });

  it('records a redaction count of zero as zero rather than dropping the column', async () => {
    // The other half of the boundary (standing rule 42). A zero is the *signal* that a row which
    // should have hidden something did not, so an adapter that omitted the column when the count
    // was falsy would destroy exactly the evidence the column exists for — and the migration's
    // `drop default` turns that omission into an error rather than a silent zero.
    const harness = harnessWith(0);
    await harness.log.record(entry({ redactionCount: 0 }));
    expect(harness.committed[0]?.values[9]).toBe(0);
  });

  it('reads no stream sequence for a status that produces no event', async () => {
    for (const status of ['would_have', 'replayed'] as const) {
      const harness = harnessWith(0);
      await harness.log.record(entry({ status }));
      expect(harness.committed).toHaveLength(1);
      expect(harness.appended).toEqual([]);
      expect(harness.sequenceReads).toEqual([]);
    }
  });

  it('drafts integration.action.failed for a failed call, with the redacted error', async () => {
    const harness = harnessWith(0);
    await harness.log.record(
      entry({ status: 'failed', result: null, error: '[REDACTED:integration:jira] refused' }),
    );
    expect(harness.appended[0]).toMatchObject({
      type: 'integration.action.failed',
      payload: { error: '[REDACTED:integration:jira] refused' },
    });
  });

  it('re-reads the sequence and retries when another writer took it, inserting the row once', async () => {
    const harness = harnessWith(2);
    await harness.log.record(entry());

    expect(harness.sequenceReads).toHaveLength(3);
    expect(harness.sequenceReads.every((read) => read.streamType === 'integration')).toBe(true);
    // The retry must not leave two audit rows behind for one action.
    expect(harness.committed).toHaveLength(1);
    expect(harness.appended).toHaveLength(1);
    expect(harness.appended[0]?.stream_seq).toBe(9);
  });

  it('gives up after the bound and lets the conflict reach the caller', async () => {
    // BD-003: an action whose row could not be written must not be reported as audited. The
    // executor turns this into a failed action rather than a silent success.
    const harness = harnessWith(99, 3);
    await expect(harness.log.record(entry())).rejects.toBeInstanceOf(StreamConflictError);
    expect(harness.committed).toEqual([]);
    expect(harness.sequenceReads).toHaveLength(3);
  });

  it('refuses a bound below one at construction', () => {
    expect(() => harnessWith(0, 0)).toThrow(TypeError);
  });

  it('refuses a draft the catalogue would reject before it opens a transaction', async () => {
    const harness = harnessWith(0);
    await expect(harness.log.record(entry({ durationMs: -1 }))).rejects.toThrow();
    expect(harness.committed).toEqual([]);
  });
});
