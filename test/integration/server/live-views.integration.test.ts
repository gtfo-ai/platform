/**
 * The live views' reads against PostgreSQL 18 (S-23.15): the agents list's `seat` and `activity`,
 * a worker's `running`, and a task's compiled stage graph from its **frozen** columns.
 *
 * What only this tier can show:
 *
 *  - **The activity query extracts facts, never text.** Entries are written through the production
 *    transcript sink with a canary in an assistant's text, a thinking block, a tool's input and a
 *    progress summary, and with a hostile tool name; the serialised answer contains none of them,
 *    and each run's line is classified from its **newest** entry across a partitioned table.
 *  - **The seat joins**: a claimed server offer, a worker's claimed offer naming a machine whose
 *    name is read off `workers`, an open offer (the queue: `null`), and a run with no offer.
 *  - **A worker's `running`** through the claimed offer alone (`run_offers.worker_id` with
 *    `runs.worker_id` null) — the branch the contract suite's seeds, which write `runs.worker_id`,
 *    do not reach.
 *  - **A task's graph is its snapshot**: a `feature` task frozen with the chore template,
 *    `qa_stage` and its own limits draws the chore pipeline with `qa`, those limits and the model
 *    its implementation run actually used.
 */
import type { Id, TranscriptEvent } from '@platform/contracts';
import { agentsResponseSchema, pipelineGraphSchema } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import { db, runner } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProjectSettingsPort } from '../../../apps/server/src/pipeline.js';
import { databasePipelineGraphReaders } from '../../../apps/server/src/queries/pipeline-graph-queries.js';
import { listRunningAgents } from '../../../apps/server/src/queries/pipeline-queries.js';
import { createPostgresWorkerStore } from '../../../apps/server/src/queries/worker-queries.js';
import { recentInstant } from '../../support/recent-instant.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let drizzled: ReturnType<typeof drizzle<typeof db.schema>>;

const AT = recentInstant();
const CANARY = 'CANARY-S2315-do-not-publish';
const HOSTILE_TOOL = `Read ${CANARY} <script>`;

let projectId: string;
let taskId: string;
let workerId: string;
const runIds: Record<string, string> = {};

const one = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
  (await pool.query<T>(text, values)).rows[0] as T;

const envelope = (run: string, seq: number) => ({
  run_id: run as Id,
  seq,
  created_at: AT,
  redaction_count: 0,
});

beforeAll(async () => {
  database = await createMigratedDatabase('live-views');
  pool = createTestPool(database.connectionString, { options: '-c role=platform_app', max: 6 });
  drizzled = drizzle(pool, { schema: db.schema });

  const org = await one<{ id: string }>(
    "insert into organizations (name) values ('lv') returning id",
  );
  projectId = (
    await one<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'lv', 'Live views', 'https://git.example.test/acme/lv.git') returning id`,
      [org.id],
    )
  ).id;
  // A `feature` task whose snapshot is the **chore** template, with QA and its own limits frozen.
  taskId = (
    await one<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                          current_stage, template_snapshot, qa_stage, iteration_limits)
       values ($1, 'fake-jira', 'LV-1', 'https://jira.example.test/browse/LV-1', 'feature',
               'active', 'implementation', $2::jsonb, true, '{"code_review": 5}'::jsonb)
       returning id`,
      [projectId, JSON.stringify(SHIPPED_TEMPLATES.chore)],
    )
  ).id;
  const stage = await one<{ id: string }>(
    `insert into task_stages (task_id, stage, attempt, state)
     values ($1, 'implementation', 1, 'running') returning id`,
    [taskId],
  );
  const user = await one<{ id: string }>(
    "insert into users (email, name) values ('lv@example.test', 'Live') returning id",
  );
  workerId = (
    await one<{ id: string }>(
      `insert into workers (id, user_id, name, credential_hash)
       values (gen_random_uuid(), $1, 'alice-laptop', $2) returning id`,
      [user.id, 'ab'.padEnd(64, '0')],
    )
  ).id;

  const run = async (name: string, model = 'claude-opus-5'): Promise<string> => {
    const row = await one<{ id: string }>(
      `insert into runs (task_id, task_stage_id, project_id, role, model, effort, prompt_version,
                         status)
       values ($1, $2, $3, 'developer', $4, 'low', 'chore@1+developer', 'running') returning id`,
      [taskId, stage.id, projectId, model],
    );
    runIds[name] = row.id;
    return row.id;
  };
  const offer = async (
    runId: string,
    state: 'open' | 'claimed',
    kind: 'server' | 'worker' | null,
    worker: string | null,
  ) =>
    pool.query(
      `insert into run_offers (id, run_id, task_id, project_id, stage, attempt, kind, state,
                               lease_epoch, claimant_kind, worker_id, offered_at, claimed_at)
       values (gen_random_uuid(), $1, $2, $3, 'implementation', 1, 'ask', $4, $5, $6, $7, now(),
               $8)`,
      [
        runId,
        taskId,
        projectId,
        state,
        state === 'claimed' ? 1 : 0,
        kind,
        worker,
        state === 'claimed' ? new Date() : null,
      ],
    );

  // The newest run is the implementation run the graph reads its model off.
  await offer(await run('server', 'claude-sonnet-5'), 'claimed', 'server', null);
  await offer(await run('worker'), 'claimed', 'worker', workerId);
  await offer(await run('queued'), 'open', null, null);
  await run('silent');
  await run('implementation', 'claude-haiku-4-5');

  const sink = runner.createPostgresTranscriptSink({ sql: pool });
  const write = async (events: TranscriptEvent[]) => {
    for (const event of events) {
      await sink.append(event);
    }
  };
  // server: text, then a tool call whose input carries the canary — newest wins: `tool`.
  await write([
    {
      ...envelope(runIds.server as string, 1),
      kind: 'assistant',
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: `I will now say ${CANARY}` }],
    },
    {
      ...envelope(runIds.server as string, 2),
      kind: 'assistant',
      model: 'claude-sonnet-5',
      content: [
        { type: 'thinking', thinking: `thinking about ${CANARY}` },
        { type: 'tool_use', tool_use_id: 'tu-1', tool_name: 'Read', input: { path: CANARY } },
      ],
    },
  ]);
  // worker: a hostile tool name in a stream block, then a PreToolUse ask — newest wins.
  await write([
    {
      ...envelope(runIds.worker as string, 1),
      kind: 'stream_block',
      block_index: 0,
      block: { type: 'tool_use', tool_use_id: 'tu-2', tool_name: HOSTILE_TOOL, input: {} },
      first_delta_at: AT,
      last_delta_at: AT,
    },
    {
      ...envelope(runIds.worker as string, 2),
      kind: 'hook',
      hook: 'PreToolUse',
      tool_name: HOSTILE_TOOL,
      tool_use_id: 'tu-2',
      decision: 'ask',
      reason: `asked because ${CANARY}`,
    },
  ]);
  // queued: only a text entry.
  await write([
    {
      ...envelope(runIds.queued as string, 1),
      kind: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: `${CANARY} in plain text` }],
    },
  ]);
  // implementation: a progress line whose summary is the canary.
  await write([
    {
      ...envelope(runIds.implementation as string, 1),
      kind: 'progress',
      summary: `${CANARY} halfway`,
      truncated: false,
    },
  ]);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('GET /api/org/agents — seat and activity (S-23.15)', () => {
  it('classifies each run by its newest entry and publishes no text, input or hostile name', async () => {
    const agents = agentsResponseSchema.parse(await listRunningAgents(drizzled));
    const byRun = new Map(agents.items.map((item) => [item.run.id, item]));
    expect(byRun.get(runIds.server as string)?.activity).toEqual({
      kind: 'tool',
      tool_name: 'Read',
      at: AT,
    });
    expect(byRun.get(runIds.worker as string)?.activity).toEqual({
      kind: 'waiting_permission',
      tool_name: 'other',
      at: AT,
    });
    expect(byRun.get(runIds.queued as string)?.activity?.kind).toBe('text');
    expect(byRun.get(runIds.implementation as string)?.activity?.kind).toBe('progress');
    expect(byRun.get(runIds.silent as string)?.activity).toBeNull();

    // The canary is in the progress summary the run record already publishes (`latest_progress`,
    // same visibility); outside that field, nothing of any entry's text reaches the answer.
    const withoutProgress = agents.items.map((item) => ({
      ...item,
      run: { ...item.run, latest_progress: null },
    }));
    expect(JSON.stringify(withoutProgress)).not.toContain(CANARY);
    expect(JSON.stringify(agents)).not.toContain('<script>');
  });

  it('seats a server claim, a named worker’s claim, and leaves the queue and an offerless run unseated', async () => {
    const agents = await listRunningAgents(drizzled);
    const seat = (name: string) => agents.items.find((item) => item.run.id === runIds[name])?.seat;
    expect(seat('server')).toEqual({ kind: 'server', worker_id: null, worker_name: null });
    expect(seat('worker')).toEqual({
      kind: 'worker',
      worker_id: workerId,
      worker_name: 'alice-laptop',
    });
    expect(seat('queued')).toBeNull();
    expect(seat('silent')).toBeNull();
  });
});

describe('GET /api/workers — running (S-23.15)', () => {
  it('lists a run the worker holds through its claimed offer alone', async () => {
    const store = createPostgresWorkerStore(drizzled);
    const [worker] = await store.listWorkers(null);
    expect(worker?.id).toBe(workerId);
    expect(worker?.running).toEqual([{ runId: runIds.worker, taskId, projectId }]);
  });
});

describe('GET /api/tasks/:id/pipeline — the frozen snapshot (S-23.15)', () => {
  it('draws the task’s snapshot with its qa_stage, its frozen limits and the model its run used', async () => {
    const readers = databasePipelineGraphReaders(drizzled, createProjectSettingsPort(pool));
    const result = await readers.taskGraph(taskId);
    expect(result.kind).toBe('graph');
    if (result.kind !== 'graph') return;
    const graph = pipelineGraphSchema.parse(result.graph);
    expect(graph.template).toBe('feature');
    const ids = graph.nodes.map((node) => node.id);
    // The chore snapshot, not the feature template the column names.
    expect(ids).not.toContain('architecture');
    expect(ids).not.toContain('business_review');
    // `qa_stage` frozen true: the rebase gate passes into `qa`.
    expect(graph.edges).toContainEqual({
      from: 'rebase_gate',
      to: 'qa',
      kind: 'pass',
      on_event: null,
      loop: null,
    });
    const node = (id: string) => graph.nodes.find((entry) => entry.id === id);
    expect(node('code_review')?.loop_limit).toBe(5);
    expect(node('ci_gate')?.loop_limit).toBe(3);
    // The latest implementation run's model; a stage that never ran takes the configured default.
    expect(node('implementation')).toMatchObject({ model: 'claude-haiku-4-5', effort: 'low' });
    expect(node('code_review')?.model).toBe('claude-opus-5');

    expect(await readers.taskGraph('00000000-0000-4000-8000-000000000000')).toEqual({
      kind: 'not_found',
    });
  });

  it('refuses a frozen dial this release cannot read rather than drawing the template without it', async () => {
    // A task of its own, written with the unreadable dial: rows are inserted, never rewritten,
    // here (`tasks-column-ownership.test.ts` gives `pipeline_dial` one writing statement).
    const unreadable = await one<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                          current_stage, pipeline_dial)
       values ($1, 'fake-jira', 'LV-2', 'https://jira.example.test/browse/LV-2', 'feature',
               'active', 'refinement', '{"level": "sideways"}'::jsonb) returning id`,
      [projectId],
    );
    const readers = databasePipelineGraphReaders(drizzled, createProjectSettingsPort(pool));
    expect((await readers.taskGraph(unreadable.id)).kind).toBe('not_compilable');
  });

  it('lists a project’s enabled templates from its settings', async () => {
    const readers = databasePipelineGraphReaders(drizzled, createProjectSettingsPort(pool));
    const result = await readers.projectGraphs(projectId, null);
    expect(result.kind === 'graphs' && result.items.map((graph) => graph.template)).toEqual([
      'feature',
      'bug',
      'chore',
      'discovery',
    ]);
    expect(await readers.projectGraphs(projectId, 'nightly')).toEqual({
      kind: 'unknown_template',
      template: 'nightly',
    });
  });
});
