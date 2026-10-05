/**
 * The `AskStore` contract against a real PostgreSQL 18 (technical/10 integration tier).
 *
 * The same suite runs against the in-memory store in the contract tier; this is the half that
 * proves the interchange — the `(project_id, ticket_comment_id)` unique index, the three `check`
 * constraints migration 0024 states (an answer and its instant move together, a refusal carries a
 * reason), and the two projections, which are a **join** here and seeded arrays in the fake.
 *
 * Each case runs inside one transaction that is rolled back afterwards, so they are isolated
 * without a database per case.
 */
import type { Transaction } from '@platform/application';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import { ask, pipeline } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAskStoreContract } from '../../contract/support/ask-store-suite.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient } from '../support/postgres.js';

let database: MigratedDatabase;
let projectId: string;
let taskId: string;
let userId: string;
let runId: string;
let auditId: string;

beforeAll(async () => {
  database = await createMigratedDatabase('asks');
  const client = createTestClient(database.connectionString);
  await client.connect();
  try {
    const org = await client.query<{ id: string }>(
      "insert into organizations (name) values ('asks') returning id",
    );
    const project = await client.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
      [org.rows[0]?.id],
    );
    projectId = project.rows[0]?.id as string;
    const user = await client.query<{ id: string }>(
      `insert into users (email, name, role) values ('ada@example.test', 'Ada', 'member')
       returning id`,
    );
    userId = user.rows[0]?.id as string;
    const task = await client.query<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode, state)
       values ($1, 'fake-jira', 'ACME-1', 'https://tickets.example.test/browse/ACME-1',
               'feature', 'normal', 'queued') returning id`,
      [projectId],
    );
    taskId = task.rows[0]?.id as string;
    const run = await client.query<{ id: string }>(
      `insert into runs (task_id, project_id, role, mode, model, prompt_version, status,
                         usd_reported, created_at)
       values ($1, $2, 'product_manager', 'normal', 'claude-sonnet-5', 'p1+x', 'completed',
               0.12, now()) returning id`,
      [taskId, projectId],
    );
    runId = run.rows[0]?.id as string;
    const audit = await client.query<{ id: string }>(
      `insert into human_actions (task_id, user_id, action, params)
       values ($1, $2, 'task.pause', '{"reason":"waiting on the API team"}'::jsonb) returning id`,
      [taskId, userId],
    );
    auditId = audit.rows[0]?.id as string;
  } finally {
    await client.end();
  }
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

runAskStoreContract({
  name: 'postgres',
  create: async () => {
    const client = createTestClient(database.connectionString);
    await client.connect();
    await client.query('begin');
    return {
      store: ask.createPostgresAskStore(),
      tx: { adapter: 'postgres', client } as unknown as Transaction,
      projectId: projectId as never,
      taskId: taskId as never,
      userId: userId as never,
      runId: runId as never,
      auditId: auditId as never,
      cleanup: async () => {
        await client.query('rollback');
        await client.end();
      },
    };
  },
});

/**
 * WP-119 (pre-review round): the projection the ask's prompt reads states a run's figure — the
 * provider's, else the platform's own pricing — and `null` for a run nobody measured. Until then it
 * read `usd_reported` alone, so both an unmeasured and a `local`-mode run reached the model as
 * `cost_usd: 0`, a free run (standing rule 16).
 */
describe('the ask’s run projection (WP-119)', () => {
  it('publishes a priced run’s estimate and a run nobody measured as null, never 0', async () => {
    const client = createTestClient(database.connectionString);
    await client.connect();
    await client.query('begin');
    try {
      const insert = async (columns: string, values: string): Promise<string> => {
        const { rows } = await client.query<{ id: string }>(
          `insert into runs (task_id, project_id, role, mode, model, prompt_version, status
                             ${columns}, created_at)
           values ($1, $2, 'developer', 'normal', 'claude-sonnet-5', 'p1+x', 'stalled'
                   ${values}, now()) returning id`,
          [taskId, projectId],
        );
        return rows[0]?.id as string;
      };
      const unmeasured = await insert('', '');
      const priced = await insert(', usd_estimated', ', 0.07');
      const lines = await ask
        .createPostgresAskStore()
        .runsForTask(
          { adapter: 'postgres', client } as unknown as Transaction,
          taskId as never,
          10,
        );
      expect(lines.find((line) => line.runId === unmeasured)?.costUsd).toBeNull();
      expect(lines.find((line) => line.runId === priced)?.costUsd).toBe(0.07);
      expect(lines.find((line) => line.runId === runId)?.costUsd).toBe(0.12);
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });
});

/**
 * WP-149 (PROGRESS backlog 445): an ask's hand-back bound is counted from its runs —
 * `runs.ask_id` (migration 0082), written by the ask executor's `runs.insert` — never from the
 * `task.ask` payload. Per ask, and nothing but `shutdown` counts.
 */
describe('an ask’s shutdown endings, counted from its runs (WP-149)', () => {
  it('counts the runs the insert linked to one ask that ended shutdown, and nothing else', async () => {
    const client = createTestClient(database.connectionString);
    await client.connect();
    await client.query('begin');
    try {
      const tx = { adapter: 'postgres', client } as unknown as Transaction;
      const asks = ask.createPostgresAskStore();
      const store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
      const askIds: string[] = [];
      for (const question of ['why a column?', 'why not a table?']) {
        const { rows } = await client.query<{ id: string }>('select gen_random_uuid() as id');
        const id = rows[0]?.id as string;
        await asks.insert(tx, {
          id: id as never,
          taskId: taskId as never,
          projectId: projectId as never,
          source: 'ui',
          askedByUserId: userId as never,
          askedByIdentity: null,
          ticketCommentId: null,
          question,
          redactionCount: 0,
          createdAt: '2026-06-01T09:00:00.000Z' as never,
        });
        askIds.push(id);
      }
      const endedRun = async (askId: string | null, reason: 'shutdown' | 'crash') => {
        const { rows } = await client.query<{ id: string }>('select gen_random_uuid() as id');
        const id = rows[0]?.id as never;
        await store.runs.insert(tx, {
          id,
          taskId: taskId as never,
          projectId: projectId as never,
          ...(askId === null ? {} : { askId: askId as never }),
          stage: null,
          role: 'ask',
          mode: 'ask',
          attempt: 1,
          model: 'claude-sonnet-5',
          effort: 'medium',
          promptVersion: 'ask@1',
          systemPrompt: null,
          userPrompt: null,
          redactionCount: 0,
          contextPack: null,
          settings: null,
          reserveUsd: null,
          promptsWithheld: null,
          status: 'running',
          terminalReason: null,
          sessionId: null,
          numTurns: 0,
          usage: null,
          cost: null,
          wallMs: 0,
          createdAt: '2026-06-01T09:00:00.000Z' as never,
          startedAt: '2026-06-01T09:00:01.000Z' as never,
        });
        await store.runs.finish(tx, {
          runId: id,
          status: 'failed',
          terminalReason: reason,
          sessionId: null,
          numTurns: 0,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            cache_read_tokens: 0,
          },
          cost: null,
          wallMs: 10,
        });
      };
      const [first, second] = askIds as [string, string];
      await endedRun(first, 'shutdown');
      await endedRun(first, 'shutdown');
      await endedRun(first, 'crash');
      await endedRun(second, 'shutdown');
      // A run that names no ask — every stage run, and every run before 0082 — counts for none.
      await endedRun(null, 'shutdown');
      expect(await store.runs.askShutdownEndings(tx, first as never)).toBe(2);
      expect(await store.runs.askShutdownEndings(tx, second as never)).toBe(1);
      const { rows } = await client.query<{ n: number }>(
        'select count(*)::int as n from runs where ask_id = $1',
        [first],
      );
      expect(rows[0]?.n).toBe(3);
    } finally {
      await client.query('rollback');
      await client.end();
    }
  });
});
