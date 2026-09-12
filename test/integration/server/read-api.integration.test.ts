/**
 * The read projections and the transcript bridge against a real PostgreSQL 18 (WP-15h).
 *
 * Two things cannot be shown anywhere else. First, **the SQL**: a `numeric(12,6)` that arrives as a
 * string, a `jsonb` payload that has to survive a round trip through `transcriptEventSchema`, a
 * partitioned `run_messages` paged by `seq`, and the `left join` that gives a run its stage. Second,
 * **the cross-process half of the SSE bridge**: two `PostgresBroadcast` instances on one database
 * are two processes as far as `LISTEN`/`NOTIFY` is concerned, so the run that appends the row and
 * the hub that serves the stream are genuinely separated here — which is the claim
 * `apps/server/src/sse/transcript-bridge.ts` makes and a unit test with a fake broadcast cannot
 * make for it.
 *
 * The rows are seeded with SQL rather than driven through the pipeline on purpose: the pipeline's
 * own rows are asserted end to end in `test/e2e/server/run-api.e2e.test.ts`, which is the tier the
 * plan row names ("never against a seeded table"). What a seeded table buys *here* is the cases
 * that tier cannot reach — a `blob_id` nothing writes, a run linked to no stage, a page boundary.
 */
import { RUN_TRANSCRIPT_TOPIC, runTopic } from '@platform/application';
import type { TranscriptEvent } from '@platform/contracts';
import { broadcast as broadcastAdapter, db, runner } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findRun,
  findRunContextPack,
  findRunPrompt,
  findTaskDetail,
  listRunMessages,
} from '../../../apps/server/src/queries/pipeline-queries.js';
import { SseHub, type SseTransport } from '../../../apps/server/src/sse/hub.js';
import { startTranscriptBridge } from '../../../apps/server/src/sse/transcript-bridge.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let drizzled: ReturnType<typeof drizzle<typeof db.schema>>;

let projectId: string;
let taskId: string;
let runId: string;
/** A run inserted with no `task_stage_id`, the shape every run stored before WP-15h has. */
let unlinkedRunId: string;
/** A run with one ordinary entry and one whose payload is claimed to live in `blobs`. */
let blobRunId: string;

const AT = '2026-09-12T10:00:00.000Z';

const entry = (seq: number, text: string, run = runId): TranscriptEvent => ({
  run_id: run,
  seq,
  created_at: AT,
  redaction_count: seq,
  kind: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text }],
});

const streamBlock = (seq: number, run = runId): TranscriptEvent => ({
  run_id: run,
  seq,
  created_at: AT,
  redaction_count: 0,
  kind: 'stream_block',
  block_index: 0,
  block: { type: 'text', text: 'partial' },
  first_delta_at: AT,
  last_delta_at: AT,
});

beforeAll(async () => {
  database = await createMigratedDatabase('read-api');
  pool = createTestPool(database.connectionString, { options: '-c role=platform_app', max: 6 });
  drizzled = drizzle(pool, { schema: db.schema });

  const one = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => {
    const result = await pool.query<T>(text, values);
    return result.rows[0] as T;
  };

  const org = await one<{ id: string }>(
    "insert into organizations (name) values ('r') returning id",
  );
  const project = await one<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
    [org.id],
  );
  projectId = project.id;
  const task = await one<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                        current_stage, cost_actual, cost_estimated, risk_classes)
     values ($1, 'fake-jira', 'ACME-1', 'https://jira.example.test/browse/ACME-1', 'feature',
             'active', 'refinement', 1.25, 2.5, '{payments}') returning id`,
    [projectId],
  );
  taskId = task.id;
  const stage = await one<{ id: string }>(
    `insert into task_stages (task_id, stage, attempt, state, outcome)
     values ($1, 'refinement', 1, 'exited', 'completed') returning id`,
    [taskId],
  );
  const run = await one<{ id: string }>(
    `insert into runs (task_id, task_stage_id, project_id, role, model, effort, prompt_version,
                       status, terminal_reason, started_at, ended_at, num_turns, input_tokens,
                       output_tokens, usd_reported, wall_ms, redaction_count)
     values ($1, $2, $3, 'product_manager', 'claude-opus-5', 'medium', 'feature@1+product_manager',
             'completed', 'success', now(), now(), 3, 1200, 400, 0.4, 900, 2) returning id`,
    [taskId, stage.id, projectId],
  );
  runId = run.id;
  await pool.query(
    `insert into run_model_usage (run_id, model, input_tokens, output_tokens, usd_estimated)
     values ($1, 'claude-opus-5', 1200, 400, 0.39)`,
    [runId],
  );
  const unlinked = await one<{ id: string }>(
    `insert into runs (task_id, project_id, role, model, prompt_version, status)
     values ($1, $2, 'developer', 'claude-opus-5', 'feature@1+developer', 'created') returning id`,
    [taskId, projectId],
  );
  unlinkedRunId = unlinked.id;

  const sink = runner.createPostgresTranscriptSink({ sql: pool });
  for (const event of [
    entry(0, 'the first entry, seq zero'),
    entry(1, 'the second'),
    streamBlock(2),
    entry(3, 'the fourth'),
  ]) {
    await sink.append(event);
  }

  const blobRun = await one<{ id: string }>(
    `insert into runs (task_id, task_stage_id, project_id, role, model, prompt_version, status)
     values ($1, $2, $3, 'developer', 'claude-opus-5', 'feature@1+developer', 'completed')
     returning id`,
    [taskId, stage.id, projectId],
  );
  blobRunId = blobRun.id;
  await sink.append(entry(0, 'an ordinary entry', blobRunId));
  const blob = await one<{ id: string }>(
    `insert into blobs (sha256, size, media_type, storage, data)
     values ('0000', 2, 'application/json', 'db', '\\x7b7d'::bytea) returning id`,
  );
  await pool.query(
    `insert into run_messages (run_id, seq, created_at, kind, payload, blob_id, size_bytes)
     values ($1, 1, $2::timestamptz, 'assistant', '{"stub": true}'::jsonb, $3, 2)`,
    [blobRunId, AT, blob.id],
  );
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('the run projection', () => {
  it('builds the published record, stage included, from the columns that hold it', async () => {
    const run = await findRun(drizzled, runId);
    // The stage is the joined `task_stages` row, not a column of `runs` — the whole reason
    // `RunRepository.insert` now writes `task_stage_id`.
    expect(run?.stage).toBe('refinement');
    expect(run?.project_id).toBe(projectId);
    expect(run?.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 400,
      cache_write_5m_tokens: 0,
      cache_write_1h_tokens: 0,
      cache_read_tokens: 0,
    });
    // `numeric` arrives as a string; the DTO publishes a number, and `is_estimate` is read off
    // whether the provider reported a figure at all (BD-011).
    expect(run?.cost).toEqual({ usd: 0.4, is_estimate: false, price_list_id: null });
    expect(run?.model_usage).toEqual([
      {
        model: 'claude-opus-5',
        input_tokens: 1200,
        output_tokens: 400,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        cache_read_tokens: 0,
        usd: 0.39,
      },
    ]);
  });

  it('is null for a run that does not exist, and refuses one with no stage by name', async () => {
    expect(await findRun(drizzled, '00000000-0000-4000-8000-00000000dead')).toBeNull();
    await expect(findRun(drizzled, unlinkedRunId)).rejects.toThrow(/is not linked to a stage/);
  });
});

describe('the transcript page', () => {
  it('starts at seq 0 and pages forward with an exclusive cursor', async () => {
    // Both ends of the boundary (standing rule 42): the first page must contain `seq: 0` — an
    // `after = 0` default would silently drop the first entry of every run — and the last page
    // must report `next_seq: null` rather than a cursor that returns nothing.
    const first = await listRunMessages(drizzled, runId, { limit: 2, partials: true });
    expect(first.items.map((item) => item.seq)).toEqual([0, 1]);
    expect(first.nextSeq).toBe(1);

    const second = await listRunMessages(drizzled, runId, {
      limit: 2,
      after: first.nextSeq as number,
      partials: true,
    });
    expect(second.items.map((item) => item.seq)).toEqual([2, 3]);
    expect(second.nextSeq).toBeNull();

    const empty = await listRunMessages(drizzled, runId, { limit: 2, after: 3, partials: true });
    expect(empty.items).toEqual([]);
    expect(empty.nextSeq).toBeNull();
  });

  it('round-trips the payload through the published schema', async () => {
    const page = await listRunMessages(drizzled, runId, { limit: 10, partials: true });
    expect(page.items[0]).toEqual(entry(0, 'the first entry, seq zero'));
  });

  it('drops coalesced blocks for ?partials=0, and keeps them otherwise', async () => {
    const without = await listRunMessages(drizzled, runId, { limit: 10, partials: false });
    expect(without.items.map((item) => item.kind)).toEqual(['assistant', 'assistant', 'assistant']);
    const with_ = await listRunMessages(drizzled, runId, { limit: 10, partials: true });
    expect(with_.items.map((item) => item.kind)).toContain('stream_block');
  });

  it('refuses a row whose payload lives in a blob rather than serving the stub', async () => {
    // Nothing writes `blob_id` (PROGRESS backlog 7), so this is the only place a reader meets one.
    // A projection written against a column that is null by accident is one that breaks the first
    // time the feature it was never tested against ships.
    //
    // The row is inserted rather than updated, and that is the database's decision rather than a
    // style choice: `run_messages` is `append_only` in `platform_table_policy` and `platform_app`
    // holds no `update` on it — the first version of this case found that out with
    // `permission denied for table run_messages`.
    await expect(
      listRunMessages(drizzled, blobRunId, { limit: 10, partials: true }),
    ).rejects.toThrow(/blob_id/);

    // …and a page that stops before the row is still served, so the refusal is about that row and
    // not about the run (standing rule 10: assert which branch ran).
    const before = await listRunMessages(drizzled, blobRunId, { limit: 1, partials: true });
    expect(before.items.map((item) => item.seq)).toEqual([0]);
    expect(before.nextSeq).toBe(0);
  });
});

describe('the two reads whose columns nothing writes', () => {
  it('reports a run with no stored prompt as unrecorded, not as a run with an empty prompt', async () => {
    expect(await findRunPrompt(drizzled, runId)).toEqual({ found: true, recorded: false });
    expect(await findRunPrompt(drizzled, '00000000-0000-4000-8000-00000000dead')).toEqual({
      found: false,
    });
  });

  /**
   * **Rows do not make the pack readable, and the first version of this case pinned the opposite.**
   *
   * It asserted `budget_tokens: 200` — the *sum of the rows* — for a record whose budget has no
   * column anywhere. That is a fabricated field, published by an endpoint whose own refusal says it
   * cannot be filled, and `apps/web/src/features/run-detail.tsx` renders it as a fact: the first
   * real producer would have shipped "budget equals total" for every run with nothing to contradict
   * it. The honest behaviour is the one asserted below, and it is asserted **with rows present**,
   * which is the direction a test can get wrong silently (standing rule 42).
   */
  it('cannot read a context pack even when the rows exist, because the budget has no column', async () => {
    expect(await findRunContextPack(drizzled, runId)).toEqual({
      found: true,
      recorded: false,
      rows: 0,
    });

    await pool.query(
      `insert into run_context_pack (run_id, tier, source_path, reason, score, tokens, validated,
                                     kb_commit_sha)
       values ($1, 0, 'knowledge/index.md', null, null, 120, true, 'abc123'),
              ($1, 1, 'knowledge/payments.md', 'paths', 0.5, 80, false, 'abc123')`,
      [runId],
    );
    try {
      // Still unrecorded — and the count is what tells an operator which of the two reasons they
      // are looking at: 0 is "no producer yet", 2 is "a producer exists and the schema gap remains".
      expect(await findRunContextPack(drizzled, runId)).toEqual({
        found: true,
        recorded: false,
        rows: 2,
      });
    } finally {
      await pool.query('delete from run_context_pack where run_id = $1', [runId]);
    }
    expect(await findRunContextPack(drizzled, '00000000-0000-4000-8000-00000000dead')).toEqual({
      found: false,
    });
  });
});

describe('the task projection', () => {
  it('reads the task with its stages, artifacts, approvals and runs', async () => {
    // The unlinked run makes the whole task unprojectable, which is the point: a composite DTO that
    // silently dropped the row it could not describe would report a task with fewer runs than it
    // has, and nobody would ever find out.
    await expect(findTaskDetail(drizzled, taskId)).rejects.toThrow(/is not linked to a stage/);
    await pool.query('delete from runs where id = $1', [unlinkedRunId]);

    const detail = await findTaskDetail(drizzled, taskId);
    expect(detail?.task.ticket).toEqual({
      provider: 'fake-jira',
      key: 'ACME-1',
      url: 'https://jira.example.test/browse/ACME-1',
    });
    expect(detail?.task.cost_actual_usd).toBe(1.25);
    expect(detail?.task.risk_classes).toEqual(['payments']);
    // `task_stages.state` is free-form text; the DTO publishes a fixed vocabulary, so the mapping
    // is asserted rather than assumed.
    expect(detail?.stages).toEqual([
      {
        stage: 'refinement',
        attempt: 1,
        state: 'completed',
        entered_at: expect.any(String),
        exited_at: null,
        outcome: 'completed',
      },
    ]);
    expect([...(detail?.runs ?? [])].map((run) => run.id).sort()).toEqual(
      [runId, blobRunId].sort(),
    );
    expect(detail?.runs).toHaveLength(2);
    expect(detail?.runs.every((run) => run.stage === 'refinement')).toBe(true);
    expect(await findTaskDetail(drizzled, '00000000-0000-4000-8000-00000000dead')).toBeNull();
  });
});

/**
 * The bridge across two `LISTEN`/`NOTIFY` sessions, which is what "a different process" means here.
 *
 * `publisher` is the worker's broadcast — the one the transcript sink announces through — and
 * `subscriber` is the API process's. They share a database and nothing else.
 */
describe('the transcript bridge, across two broadcast connections', () => {
  it('turns an appended row into a frame on the run’s topic, in the other process', async () => {
    const publisher = new broadcastAdapter.PostgresBroadcast({
      connectionString: database.connectionString,
      publisher: pool,
    });
    const subscriber = new broadcastAdapter.PostgresBroadcast({
      connectionString: database.connectionString,
      publisher: pool,
    });
    const hub = new SseHub({
      bufferSize: 16,
      maxQueuedFrames: 64,
      maxTopicsPerConnection: 4,
      maxBufferedTopics: 8,
      retryMs: 1_000,
      pingIntervalMs: 0,
      maxConnections: 2,
      shutdownDrainMs: 500,
    });
    const sent: { id?: string; event?: string; data: unknown }[] = [];
    const transport: SseTransport = {
      send: async (message) => {
        sent.push(message);
      },
      comment: () => undefined,
      close: () => undefined,
      isConnected: true,
    };

    const bridge = await startTranscriptBridge({
      hub,
      broadcast: subscriber,
      read: async (run, after, limit) => {
        const page = await listRunMessages(drizzled, run, {
          limit,
          ...(after === null ? {} : { after }),
          partials: true,
        });
        return page.items;
      },
    });

    try {
      // A run of its own, so the rows this case publishes are its own.
      const stage = await pool.query<{ id: string }>(
        `insert into task_stages (task_id, stage, attempt, state)
         values ($1, 'architecture', 1, 'entered') returning id`,
        [taskId],
      );
      const live = await pool.query<{ id: string }>(
        `insert into runs (task_id, task_stage_id, project_id, role, model, prompt_version, status)
         values ($1, $2, $3, 'architect', 'claude-opus-5', 'feature@1+architect', 'running')
         returning id`,
        [taskId, stage.rows[0]?.id, projectId],
      );
      const liveRunId = live.rows[0]?.id as string;

      hub.open({
        id: 'stream-1',
        userId: '00000000-0000-4000-8000-0000000000aa',
        topics: [runTopic(liveRunId)],
        transport,
      });

      // The sink is the **production** one, announcing through the publisher's connection.
      const sink = runner.createPostgresTranscriptSink({
        sql: pool,
        announce: async (hint) => publisher.publish({ topic: RUN_TRANSCRIPT_TOPIC, payload: hint }),
      });
      await sink.append(entry(0, 'hello from the worker', liveRunId));
      await sink.append(entry(1, 'and again', liveRunId));

      const deadline = Date.now() + 15_000;
      while (sent.filter((message) => message.event === 'assistant').length < 2) {
        if (Date.now() > deadline) {
          throw new Error(`only ${sent.length} frames arrived: ${JSON.stringify(sent)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const transcript = sent.filter((message) => message.event === 'assistant');
      // The id is `<topic>:<seq>` with the **row's** seq, so a reconnecting client's
      // `Last-Event-ID` and the REST endpoint's `?after=` name the same position.
      expect(transcript.map((message) => message.id)).toEqual([
        `run:${liveRunId}:0`,
        `run:${liveRunId}:1`,
      ]);
      const first = transcript[0]?.data as { data: TranscriptEvent } | undefined;
      expect(first?.data).toEqual(entry(0, 'hello from the worker', liveRunId));
    } finally {
      await bridge.stop();
      await hub.shutdown();
      await subscriber.close();
      await publisher.close();
    }
  }, 60_000);
});
