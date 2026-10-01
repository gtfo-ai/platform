/**
 * The failed-jobs read against real pg-boss on PostgreSQL 18 (WP-108, PROGRESS backlog 325).
 *
 * A worker throws on every attempt of a job enqueued with no retries, so pg-boss moves it to
 * `failed` by its own rules; the read then answers its queue, attempts, retry limit, instants and
 * the thrown message — and **nothing of the payload**, which carries a marker the assertion looks
 * for in the whole answer. The route's redaction and bound are `apps/server/src/routes/
 * failed-jobs.test.ts`'s; this file is the half that shows the SQL reads pg-boss's own record.
 */
import { JOB_QUEUES } from '@platform/application';
import { db, jobs } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { strictPoolLogger } from '../support/postgres.js';

const WAIT_TIMEOUT_MS = 30_000;
const PAYLOAD_MARKER = 'payload-marker-never-published';

let database: MigratedDatabase;
let handle: ReturnType<typeof db.createDatabasePool>;

beforeAll(async () => {
  database = await createMigratedDatabase('failed-jobs');
  handle = db.createDatabasePool(
    {
      url: database.connectionString,
      appRole: 'platform_app',
      poolMax: 6,
      connectionTimeoutMs: db.DATABASE_CONFIG_DEFAULTS.connectionTimeoutMs,
      partitionMonthsAhead: 3,
      transcriptRetentionDays: null,
    },
    strictPoolLogger,
  );
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await database?.drop();
});

describe('readFailedJobs (WP-108, backlog 325)', () => {
  it('reads nothing on a queue with no failures, and a job pg-boss failed — without its payload', async () => {
    expect(await jobs.readFailedJobs(handle.pool, 'pgboss', { limit: 10 })).toEqual({
      items: [],
      total: 0,
    });

    const runtime = jobs.createPgBossJobs({
      database: jobs.asJobsDatabase(handle.pool),
      pollingIntervalSeconds: 0.5,
    });
    await runtime.start();
    let tried = 0;
    try {
      await runtime.jobs.work({
        queue: JOB_QUEUES.pipelineOutbound,
        handler: async () => {
          tried += 1;
          throw new Error('the provider answered 502 twice in a row');
        },
      });
      const sent = await runtime.jobs.enqueue({
        queue: JOB_QUEUES.pipelineOutbound,
        data: { duty: 'workpad', note: PAYLOAD_MARKER },
        retryLimit: 0,
      });
      expect(sent.status).toBe('enqueued');

      const deadline = Date.now() + WAIT_TIMEOUT_MS;
      let page = await jobs.readFailedJobs(handle.pool, 'pgboss', { limit: 10 });
      while (page.total === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        page = await jobs.readFailedJobs(handle.pool, 'pgboss', { limit: 10 });
      }
      expect(tried).toBe(1);
      expect(page.total).toBe(1);
      expect(page.items).toHaveLength(1);
      const [failed] = page.items;
      expect(failed).toMatchObject({
        id: (sent as { readonly jobId: string }).jobId,
        queue: JOB_QUEUES.pipelineOutbound,
        attempts: 1,
        retryLimit: 0,
        error: 'the provider answered 502 twice in a row',
      });
      expect(Date.parse(failed?.failedAt ?? '')).toBeGreaterThanOrEqual(
        Date.parse(failed?.createdAt ?? ''),
      );
      expect(JSON.stringify(page)).not.toContain(PAYLOAD_MARKER);
      // The limit bounds the page, never the total.
      expect(await jobs.readFailedJobs(handle.pool, 'pgboss', { limit: 1 })).toMatchObject({
        total: 1,
      });
    } finally {
      await runtime.stop();
    }
  });
});
