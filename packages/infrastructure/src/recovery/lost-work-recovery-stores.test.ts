/**
 * The two WP-124 recovery stores' wiring, in the unit tier (PROGRESS backlog 366).
 *
 * What the SQL **answers** is the integration tier's (`test/integration/recovery/
 * lost-work-recovery-stores.integration.test.ts`, against PostgreSQL 18 and real pg-boss). What is
 * held here is what a recording client can see: each method reads the queue the predicate's "no job
 * owed" half names, maps the rows it is answered with, reports a conditional write's outcome from
 * the row count, and the pg-boss schema is refused unless it is a bare identifier.
 */
import type { Transaction } from '@platform/application';
import { JOB_QUEUES } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createPostgresDiscoveryRecordRecoveryStore } from './postgres-discovery-record-recovery-store.js';
import { createPostgresKnowledgeApplyRecoveryStore } from './postgres-knowledge-apply-recovery-store.js';

interface Call {
  readonly text: string;
  readonly values: readonly unknown[];
}

const recording = (answer: { rows?: readonly Record<string, unknown>[]; rowCount?: number }) => {
  const calls: Call[] = [];
  const tx = {
    adapter: 'postgres',
    client: {
      query: async (text: string, values: readonly unknown[] = []) => {
        calls.push({ text, values });
        return { rows: answer.rows ?? [], rowCount: answer.rowCount ?? answer.rows?.length ?? 0 };
      },
    },
  } as unknown as Transaction;
  return { tx, calls };
};

const QUERY = {
  olderThan: '2026-10-02T10:00:00.000Z' as IsoDateTime,
  endingBefore: '2026-10-02T09:00:00.000Z' as IsoDateTime,
  limit: 50,
};
const P1 = '00000000-0000-4000-8000-0000000000f1' as Id;
const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;

describe('the knowledge-apply recovery store (WP-124)', () => {
  const store = createPostgresKnowledgeApplyRecoveryStore({ jobsSchema: 'pgboss' });

  it('reads stranded proposals against the knowledge.apply queue, and maps the attempt', async () => {
    const { tx, calls } = recording({
      rows: [
        { id: P1, project_id: PROJECT, attempted_at: null },
        { id: P1, project_id: PROJECT, attempted_at: new Date('2026-10-02T08:00:00.000Z') },
      ],
    });
    const found = await store.strandedApplies(tx, QUERY);
    expect(calls[0]?.values).toEqual([
      JOB_QUEUES.knowledgeApply,
      QUERY.olderThan,
      QUERY.endingBefore,
      QUERY.limit,
    ]);
    expect(calls[0]?.text).toContain('pgboss.job');
    expect(found).toEqual([
      { proposalId: P1, projectId: PROJECT, recoveryAttemptedAt: null },
      { proposalId: P1, projectId: PROJECT, recoveryAttemptedAt: '2026-10-02T08:00:00.000Z' },
    ]);
  });

  it('answers the ids its conditional mark and ending wrote', async () => {
    const marked = recording({ rows: [{ id: P1 }] });
    expect(
      await store.markApplyAttempt(marked.tx, { proposalIds: [P1], at: QUERY.olderThan }),
    ).toEqual([P1]);
    expect(marked.calls[0]?.text).toContain('apply_recovery_attempted_at = $3');
    const ended = recording({ rows: [] });
    expect(await store.endApply(ended.tx, { proposalIds: [P1], reason: 'gave up' })).toEqual([]);
    expect(ended.calls[0]?.text).toContain("status = 'apply_failed'");
    expect(ended.calls[0]?.values).toEqual([JOB_QUEUES.knowledgeApply, [P1], 'gave up']);
  });

  it('refuses a pg-boss schema that is not a bare identifier', () => {
    expect(() =>
      createPostgresKnowledgeApplyRecoveryStore({ jobsSchema: 'pgboss; drop' }),
    ).toThrow();
  });
});

describe('the discovery-record recovery store (WP-124)', () => {
  const store = createPostgresDiscoveryRecordRecoveryStore({ jobsSchema: 'pgboss' });
  const ARTIFACT = '00000000-0000-4000-8000-0000000000e1' as Id;
  const TASK = '00000000-0000-4000-8000-0000000000d1' as Id;

  it('reads stranded drafts against the onboarding.discovery queue, with the announcing event', async () => {
    const { tx, calls } = recording({
      rows: [
        {
          artifact_id: ARTIFACT,
          project_id: PROJECT,
          task_id: TASK,
          event_id: null,
          attempted_at: '2026-10-02T08:00:00.000Z',
        },
      ],
    });
    const found = await store.strandedDiscoveryRecords(tx, QUERY);
    expect(calls[0]?.values[0]).toBe(JOB_QUEUES.discoveryRecord);
    expect(found).toEqual([
      {
        artifactId: ARTIFACT,
        projectId: PROJECT,
        taskId: TASK,
        artifactEventId: null,
        recoveryAttemptedAt: '2026-10-02T08:00:00.000Z',
      },
    ]);
  });

  it('answers whether its conditional mark and ending wrote, from the row count', async () => {
    expect(
      await store.markDiscoveryRecordAttempt(recording({ rowCount: 1 }).tx, {
        artifactId: ARTIFACT,
        at: QUERY.olderThan,
      }),
    ).toBe(true);
    expect(
      await store.markDiscoveryRecordAttempt(recording({ rowCount: 0 }).tx, {
        artifactId: ARTIFACT,
        at: QUERY.olderThan,
      }),
    ).toBe(false);
    const ended = recording({ rowCount: 1 });
    expect(
      await store.endDiscoveryRecord(ended.tx, {
        artifactId: ARTIFACT,
        reason: 'lost',
        at: QUERY.olderThan,
      }),
    ).toBe(true);
    expect(ended.calls[0]?.values).toEqual([
      JOB_QUEUES.discoveryRecord,
      ARTIFACT,
      QUERY.olderThan,
      'lost',
    ]);
  });
});
