/**
 * Migration 0071's two indexes are the ones the reads they were built for actually use — WP-115,
 * PROGRESS backlog 307 and 312.
 *
 * Each case seeds the **larger** of the two sizes WP-115 measured, with set-based SQL, runs
 * `analyze`, captures the SQL the shipped code sends (the PostgreSQL pipeline store's
 * `bugTraces.latest`, and the two drizzle reads of `apps/server/src/queries/project-queries.ts`
 * through a query logger) and asks the planner for its plan — `EXPLAIN` without `ANALYZE`, and no
 * planner setting changed, so the assertion is about the choice the planner makes on its own. It
 * asserts an index **name**, never a time: a wall-clock bound is a hardware assertion (standing rule
 * 2), and the measured numbers live in the migration's header and in PROGRESS.
 *
 * Seeded once, read twice: a traced ticket and a never-traced one (the non-bug edit, which is most
 * of what the re-trace handler sees), and both `human_actions` reads.
 */
import { randomUUID } from 'node:crypto';
import type { Transaction } from '@platform/application';
import type { Id } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import { pipeline } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import {
  findLastConfigExport,
  listProjectAudit,
} from '../../../apps/server/src/queries/project-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;

beforeAll(async () => {
  database = await createMigratedDatabase('payload-lookup-indexes');
  pool = createTestPool(database.connectionString, { max: 2 });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

interface Captured {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const planOf = async (query: Captured): Promise<string> => {
  const { rows } = await pool.query<{ 'QUERY PLAN': string }>(
    `explain ${query.sql}`,
    query.params as unknown[],
  );
  return rows.map((row) => row['QUERY PLAN']).join('\n');
};

/**
 * One project stream of `total` events over the last 89 days, `traces` of them traces.
 *
 * Seeded with the triggers off (`session_replication_role = replica`, this transaction only):
 * with `events`' two row triggers on (the stream-sequence guard and the dispatch enqueue) this case
 * took 53 s, with them off 1.6 s (measured on this tree; which of the two costs what was not
 * separated). Neither trigger's bookkeeping is read here — the index and the plan are. Setting
 * `session_replication_role` needs a **superuser**: the Testcontainers PostgreSQL the tier starts
 * runs as one; a `TEST_DATABASE_URL` whose user is not would fail here (WP-115 review round 1).
 */
const seedStream = async (projectId: string, total: number, traces: number): Promise<void> => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await seedRows(client, projectId, total, traces);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};

const seedRows = async (
  client: pg.PoolClient,
  projectId: string,
  total: number,
  traces: number,
): Promise<void> => {
  await client.query(
    `insert into events (stream_type, stream_id, stream_seq, type, payload, actor, occurred_at)
     select 'project', $1::uuid, g,
            case when g % $3 = 0 then 'ticket.bug.traced' else 'ticket.updated' end,
            case when g % $3 = 0 then jsonb_build_object(
                   'project_id', $1::text,
                   'ticket', jsonb_build_object('provider', 'jira-cloud', 'key', 'BUG-' || (g / $3)),
                   'filed_at', '2026-07-01T00:00:00.000Z', 'outcome', 'no_link')
                 else jsonb_build_object(
                   'project_id', $1::text,
                   'ticket', jsonb_build_object('provider', 'jira-cloud', 'key', 'PROJ-' || (g % 1000)),
                   'changes', jsonb_build_object('summary', repeat('x', 400)))
            end,
            '{"kind":"system","component":"wp115-seed"}'::jsonb,
            now() - interval '90 days' + (g::double precision / $2) * interval '89 days'
       from generate_series(1, $2) g
      order by g`,
    [projectId, total, Math.floor(total / traces)],
  );
};

describe('events_bug_trace_ticket_idx (backlog 307)', () => {
  it('serves the re-trace lookup at 10^5 project events, for a traced and a never-traced ticket', async () => {
    const projectId = randomUUID() as Id;
    // The project under test at the larger size, beside nine others' traces (the installation's).
    await seedStream(projectId, 100_000, 100);
    for (let i = 0; i < 9; i += 1) {
      await seedStream(randomUUID(), 1_000, 100);
    }
    await pool.query('analyze events');

    const captured: Captured[] = [];
    const client = {
      query: async (sql: string, params: readonly unknown[]) => {
        captured.push({ sql, params });
        return { rows: [] };
      },
    };
    const store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
    const tx = { adapter: 'postgres', client } as unknown as Transaction;
    for (const key of ['BUG-7', 'PROJ-123']) {
      await store.bugTraces.latest(tx, { projectId, provider: 'jira-cloud', key });
    }
    expect(captured).toHaveLength(2);

    // An index on a partitioned table is one index per partition, each named after its partition
    // and attached to the parent's — so the plan is checked for those.
    const attached = await pool.query<{ relname: string }>(
      `select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
        where i.inhparent = to_regclass('public.events_bug_trace_ticket_idx')`,
    );
    expect(
      attached.rows.length,
      'events_bug_trace_ticket_idx has no partition index',
    ).toBeGreaterThan(0);
    for (const query of captured) {
      const plan = await planOf(query);
      expect(
        attached.rows.some((row) => plan.includes(row.relname)),
        `the plan uses no partition of events_bug_trace_ticket_idx:\n${plan}`,
      ).toBe(true);
      // And neither index the read used before 0071 (rule 10: assert which branch ran).
      expect(plan).not.toMatch(/type_occurred_at_idx|stream_type_stream_id_stream_seq_idx/);
      // WP-115 review round 1 (orchestrator): the ticket key is **in** the index condition, not a
      // filter after it — a partial index on the stream alone would still be chosen and read every
      // trace of the project, which is the cost 307 exists to remove.
      expect(plan, `the ticket key is not in the index condition:\n${plan}`).toMatch(
        /Index Cond: .*->> 'key'::text\) = /,
      );
    }
  }, 120_000);
});

describe('human_actions_project_idx (backlog 312)', () => {
  it('serves findLastConfigExport and listProjectAudit at 10^6 rows', async () => {
    const projects = Array.from({ length: 50 }, () => randomUUID());
    // 95 % task commands (params name a task), 4 % settings writes, 1 % exports, over 50 projects.
    await pool.query(
      `insert into human_actions (action, params, created_at)
       select case when g % 20 <> 0 then 'task.retry'
                   when g % 100 = 0 then 'project.config.export'
                   else 'project.settings.write' end,
              case when g % 20 <> 0 then jsonb_build_object('task_id', gen_random_uuid()::text)
                   when g % 100 = 0 then jsonb_build_object(
                     'project_id', ($2::text[])[1 + (g / 100) % 50], 'status', 'exported',
                     'config_hash', md5(g::text), 'merge_request_iid', g)
                   else jsonb_build_object('project_id', ($2::text[])[1 + (g / 20) % 50],
                     'section', 'autonomy') end,
              now() - interval '365 days' + (g::double precision / $1) * interval '364 days'
         from generate_series(1, $1) g`,
      [1_000_000, projects],
    );
    await pool.query('analyze human_actions');

    const captured: Captured[] = [];
    const db = drizzle(pool, {
      logger: {
        logQuery: (sql: string, params: unknown[]) => {
          captured.push({ sql, params });
        },
      },
    }) as unknown as Database;
    const projectId = projects[6] as string;
    const last = await findLastConfigExport(db, projectId);
    expect(last?.status, 'the seeded project has an export to find').toBe('exported');
    const audit = await listProjectAudit(db, projectId, 50);
    expect(audit.items).toHaveLength(50);
    expect(captured).toHaveLength(2);

    for (const query of captured) {
      const plan = await planOf(query);
      expect(plan, `the plan does not use human_actions_project_idx:\n${plan}`).toContain(
        'human_actions_project_idx',
      );
      expect(plan).not.toContain('Seq Scan on human_actions');
    }
  }, 180_000);
});
