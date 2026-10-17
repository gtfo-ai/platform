/**
 * The stranded-stage store's reading of a failed `stage.execute` job, in the unit tier (WP-166 (b),
 * PROGRESS backlog 529).
 *
 * What the SQL selects is the integration tier's (`test/integration/recovery/
 * stranded-stage-store.integration.test.ts`). What is held here is what a recording client can see:
 * given the columns the SQL answers, an expired last try — by either writer WP-156 measured — is read
 * as `expired`, and the brief the application writes from it says the try ran past the queue's limit
 * rather than *"an error whose class was not recorded"* or *"threw Error"*. A thrown last try reads
 * as it did.
 */
import type { StrandedStage, Transaction } from '@platform/application';
import { failedJobBrief, failedJobReason } from '@platform/application';
import type { IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { EXPIRY_SIGNATURES } from './postgres-expired-job-store.js';
import {
  createPostgresStrandedStageStore,
  isExpiredJobOutput,
} from './postgres-stranded-stage-store.js';

const answering = (rows: readonly Record<string, unknown>[]): Transaction =>
  ({
    adapter: 'postgres',
    client: { query: async () => ({ rows, rowCount: rows.length }) },
  }) as unknown as Transaction;

const QUERY = {
  olderThan: '2026-10-02T10:00:00.000Z' as IsoDateTime,
  endingBefore: '2026-10-02T09:00:00.000Z' as IsoDateTime,
  limit: 50,
};

/** One stranded row whose newest failed job carries `failed`'s columns. */
const rowWith = (failed: {
  readonly failed_name?: string | null;
  readonly failed_value_message?: string | null;
  readonly failed_message?: string | null;
}): Record<string, unknown> => ({
  task_id: '00000000-0000-4000-8000-000000000001',
  project_id: '00000000-0000-4000-8000-000000000002',
  stage: 'ci_gate',
  attempt: 1,
  entered_at: '2026-10-02T07:00:00.000000Z',
  attempted_at: '2026-10-02T07:05:00.000Z',
  ended_status: null,
  ended_reason: null,
  failed_at: '2026-10-02T08:00:00.000Z',
  failed_tries: 3,
  failed_name: null,
  failed_code: null,
  failed_cause_name: null,
  failed_cause_code: null,
  failed_value_message: null,
  failed_message: null,
  ...failed,
});

const read = async (row: Record<string, unknown>): Promise<StrandedStage> => {
  const store = createPostgresStrandedStageStore({ jobsSchema: 'pgboss' });
  const [found] = await store.strandedStages(answering([row]), QUERY);
  if (found === undefined) throw new Error('the store answered no row');
  return found;
};

const texts = (row: StrandedStage): string => {
  if (row.failedJob === null) throw new Error('no failed job');
  return `${failedJobReason(row, row.failedJob, '2026-10-02T07:05:00.000Z' as IsoDateTime)}\n${failedJobBrief(row, row.failedJob, 'ACME-1')}`;
};

describe('the stranded-stage store reads an expired stage.execute job as expired (backlog 529)', () => {
  it.each([
    ['the supervisor’s timeout', { failed_value_message: 'job timed out' }],
    ['the supervisor’s heartbeat', { failed_value_message: 'job heartbeat timeout' }],
    [
      'the worker timer',
      { failed_name: 'Error', failed_message: 'handler execution exceeded 7200s' },
    ],
  ] as const)('%s: expired, and the brief says it ran past its limit', async (_writer, columns) => {
    const row = await read(rowWith(columns));
    expect(row.failedJob?.expired).toBe(true);
    const text = texts(row);
    expect(text).toContain('ran past the queue’s limit of 2 hours, so the queue expired it');
    expect(text).not.toContain('not recorded');
    expect(text).not.toContain('threw');
    expect(text).not.toContain('throwing');
  });

  it('a thrown last try is not expired, and reads as it did', async () => {
    const row = await read(
      rowWith({ failed_name: 'Error', failed_message: 'connect ECONNREFUSED 10.0.0.1:443' }),
    );
    expect(row.failedJob?.expired).toBe(false);
    expect(texts(row)).toContain('the last one threw Error;');
    const unrecorded = await read(rowWith({}));
    expect(unrecorded.failedJob?.expired).toBe(false);
    expect(texts(unrecorded)).toContain('threw an error whose class was not recorded');
  });

  it('matches the signatures exactly: another class, another message or a longer one is a throw', () => {
    const output = (fields: {
      readonly failed_name?: string | null;
      readonly failed_value_message?: string | null;
      readonly failed_message?: string | null;
    }) => ({ failed_name: null, failed_value_message: null, failed_message: null, ...fields });
    // The signatures this store matches are the expired-job store's own, imported (rule 7).
    expect(EXPIRY_SIGNATURES.supervisor).toEqual(['job timed out', 'job heartbeat timeout']);
    expect(
      isExpiredJobOutput(
        output({ failed_name: 'TypeError', failed_message: 'handler execution exceeded 7200s' }),
      ),
    ).toBe(false);
    expect(
      isExpiredJobOutput(
        output({ failed_name: 'Error', failed_message: 'handler execution exceeded 7200s, then' }),
      ),
    ).toBe(false);
    expect(isExpiredJobOutput(output({ failed_value_message: 'job timed out!' }))).toBe(false);
    // The supervisor's message on a thrown error's `message` is not the supervisor's shape.
    expect(
      isExpiredJobOutput(output({ failed_name: 'Error', failed_message: 'job timed out' })),
    ).toBe(false);
  });
});
