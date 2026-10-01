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

  /**
   * WP-114, PROGRESS backlog 324: the list reaches its oldest row. Five more failed jobs are cloned
   * from the one above at chosen instants — two of them in the **same microsecond**, so the id is
   * what orders them, and every instant carries microseconds a `Date` would truncate.
   */
  it('pages a total above one page to its last row, in order, each row once (WP-114)', async () => {
    const instants = [
      '2026-09-30T08:00:00.000001Z',
      '2026-09-30T08:00:00.000002Z',
      '2026-09-30T08:00:00.000002Z',
      '2026-09-30T08:00:00.999999Z',
      '2026-09-29T23:59:59.500000Z',
    ];
    await handle.pool.query(
      `insert into pgboss.job
       select (jsonb_populate_record(null::pgboss.job,
                 to_jsonb(j) || jsonb_build_object('id', gen_random_uuid(), 'completed_on', at))).*
         from pgboss.job j, unnest($1::timestamptz[]) as at
        where j.state = 'failed'`,
      [instants],
    );
    const seen: { id: string; at: string }[] = [];
    let before: { at: string; id: string } | undefined;
    let total = -1;
    for (let page = 0; page < 10; page += 1) {
      const read = await jobs.readFailedJobs(handle.pool, 'pgboss', {
        limit: 2,
        ...(before === undefined ? {} : { before }),
      });
      total = read.total;
      seen.push(...read.items.map((item) => ({ id: item.id, at: item.position.at })));
      const last = read.items.at(-1);
      if (read.items.length < 2 || last === undefined) {
        break;
      }
      before = last.position;
    }
    expect(total).toBe(6);
    expect(seen).toHaveLength(6);
    expect(new Set(seen.map((row) => row.id)).size).toBe(6);
    // Newest first, and the microseconds are the database's rendering, not a truncated `Date`.
    const ats = seen.map((row) => row.at);
    expect([...ats].sort().reverse()).toEqual(ats);
    expect(ats).toContain('2026-09-30T08:00:00.999999Z');
    expect(ats.filter((at) => at === '2026-09-30T08:00:00.000002Z')).toHaveLength(2);
    // A page past the last answers no rows and still the whole count.
    const after = await jobs.readFailedJobs(handle.pool, 'pgboss', {
      limit: 2,
      before: { at: '2000-01-01T00:00:00.000000Z', id: '00000000-0000-4000-8000-000000000000' },
    });
    expect(after).toEqual({ items: [], total: 6 });
  });
});
