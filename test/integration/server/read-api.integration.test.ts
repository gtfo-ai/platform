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
import { RUN_TRANSCRIPT_TOPIC, runTopic, type Transaction } from '@platform/application';
import type { ContextPackRecord, Id, IsoDateTime, TranscriptEvent } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import {
  broadcast as broadcastAdapter,
  db,
  pipeline as pipelineAdapters,
  runner,
} from '@platform/infrastructure';
import { findShippedProvider } from '@platform/integrations';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findIntegrationRow,
  listIntegrationRows,
  toIntegrationSummary,
} from '../../../apps/server/src/queries/integration-queries.js';
import { findKbHealth } from '../../../apps/server/src/queries/knowledge-queries.js';
import {
  findArtifactBody,
  findRun,
  findRunContextPack,
  findRunPrompt,
  findTaskDetail,
  listInbox,
  listProjectTasks,
  listRunMessages,
  listRunningAgents,
} from '../../../apps/server/src/queries/pipeline-queries.js';
import {
  findProjectReadiness,
  listProjectSummaries,
} from '../../../apps/server/src/queries/project-queries.js';
import { SseHub, type SseTransport } from '../../../apps/server/src/sse/hub.js';
import { startTranscriptBridge } from '../../../apps/server/src/sse/transcript-bridge.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool, withClient } from '../support/postgres.js';

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
/** A BD-004 `local`-mode run: priced by the platform, never reported by a provider (WP-47). */
let localRunId: string;

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
                        current_stage, cost_actual, risk_classes)
     values ($1, 'fake-jira', 'ACME-1', 'https://jira.example.test/browse/ACME-1', 'feature',
             'active', 'refinement', 1.25, '{payments}') returning id`,
    [projectId],
  );
  taskId = task.id;
  const stage = await one<{ id: string }>(
    `insert into task_stages (task_id, stage, attempt, state, outcome)
     values ($1, 'refinement', 1, 'completed', 'approve') returning id`,
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

  /**
   * A BD-004 `local`-mode run: the platform priced it, the provider reported nothing (WP-47).
   *
   * Its whole point is `usd_estimated`, which had **no writer anywhere in the tree** before WP-47
   * and was `not null default 0` — so every run of one whole provider mode read as `$0.00` on
   * `GET /api/runs/:id` and committed nothing to any cap until its ledger row landed.
   */
  const localRun = await one<{ id: string }>(
    `insert into runs (task_id, task_stage_id, project_id, role, model, effort, prompt_version,
                       provider_mode, status, terminal_reason, started_at, ended_at, num_turns,
                       input_tokens, output_tokens, usd_estimated, wall_ms)
     values ($1, $2, $3, 'developer', 'claude-opus-5', 'medium', 'feature@1+developer',
             'local', 'completed', 'success', now(), now(), 2, 1000, 500, 0.06, 500) returning id`,
    [taskId, stage.id, projectId],
  );
  localRunId = localRun.id;
  /**
   * The ledger's own rows for the two runs, which is what `cost_estimated_usd` is a projection over
   * since WP-47 (backlog 75): one **priced** (`is_estimate`) and one **reported**, so the boundary
   * the criterion names is a real pair of rows rather than a construction.
   */
  await pool.query(
    `insert into cost_entries (run_id, task_id, project_id, stage, model, usd, is_estimate)
     values ($1, $2, $3, 'refinement', 'claude-opus-5', 0.4, false),
            ($4, $2, $3, 'refinement', 'claude-opus-5', 0.06, true)`,
    [runId, taskId, projectId, localRunId],
  );

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
    /**
     * **The `local`-mode run reads its own figure** — WP-47, backlog 110, criterion 4.
     *
     * Before this work package `runs.usd_estimated` had no writer and was `not null default 0`, so
     * this answered `{ usd: 0, is_estimate: true }`: a zero, on the operator-facing screen, for
     * every run in the one provider mode BD-004 offers to somebody without an API key. And the
     * number is the one the ledger charged the same run (0.06 in `cost_entries`), which is the
     * comparison the criterion asks for — the wire and the books agree.
     */
    const local = await findRun(drizzled, localRunId);
    expect(local?.cost).toEqual({ usd: 0.06, is_estimate: true, price_list_id: null });
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

/**
 * **The read that refuses a row written before its column existed** (WP-52 round 3).
 *
 * `findArtifactBody`'s two branches turn on `artifacts.redaction_count is null`, which means *"no
 * redactor ran over this row"* — the state every artifact on an upgraded instance is in for ever,
 * because migration 0038 adds the column nullable behind a `NOT VALID` check. A `null` in that
 * column is a thing only a database can produce honestly, which is why this is the integration tier
 * and not a stub: `pipeline-queries.test.ts`'s own docblock refuses a stubbed Drizzle handle, and
 * no integration test builds the real router, so the query's branches are asserted here and the
 * **route's 409** in `apps/server/src/routes/tasks.test.ts`, which drives the real router against
 * plain functions (it moved there from `test/e2e/server/run-api.e2e.test.ts` at WP-52 round 4 —
 * that file's own note says why). The run-api e2e now carries a different 409, `/context-pack`'s
 * `context_pack_not_recorded` (WP-57).
 *
 * The pre-0038 row is produced the only honest way: the same drop / insert / re-add-`NOT VALID`
 * dance `migrations.integration.test.ts` already establishes, which reproduces exactly what an
 * upgrade leaves behind — a row the constraint was never validated against.
 */
describe('one artifact’s body', () => {
  it('serves a redacted row and refuses one written before anything redacted it', async () => {
    const insertArtifact = async (text: string, values: readonly unknown[]): Promise<string> => {
      const result = await pool.query<{ id: string }>(text, [...values]);
      return result.rows[0]?.id as string;
    };

    const redactedId = await insertArtifact(
      `insert into artifacts (task_id, type, version, markdown, data, schema_version,
                              produced_by_run_id, redaction_count)
       values ($1, 'RefinedSpec', 1, null, '{"goal":"ship it"}'::jsonb, '1', $2, 2) returning id`,
      [taskId, runId],
    );

    // The row this build writes: served, with the count it recorded.
    const served = await findArtifactBody(drizzled, redactedId);
    expect(served.found).toBe(true);
    expect(served.found === true && served.redacted).toBe(true);
    if (served.found === true && served.redacted === true) {
      expect(served.body.artifact_type).toBe('RefinedSpec');
      expect(served.body.task_id).toBe(taskId);
      expect(served.body.redaction_count).toBe(2);
      expect(served.body.data).toEqual({ goal: 'ship it' });
    }

    /**
     * …and the row an upgrade left behind: refused, with the instant a human is told.
     *
     * The constraint dance runs on the **owner** connection, not on `pool` — and finding that out
     * was worth the round trip: `pool` connects as `platform_app` (`-c role=platform_app`), which
     * PostgreSQL answers with *"must be owner of table artifacts"*. **That is what was measured**:
     * the application role cannot drop this constraint. It is not the same as "the branch cannot be
     * bypassed from inside the server", which additionally rests on the check still rejecting every
     * INSERT and UPDATE — true, and pinned independently by
     * `test/integration/db/grants.integration.test.ts`, but not established here.
     *
     * `try`/`finally` because the constraint is real schema: a failure between the drop and the
     * re-add would leave this file's remaining cases running against a table with no check.
     */
    const legacyId = await withClient(database.connectionString, async (client) => {
      await client.query(
        'alter table artifacts drop constraint artifacts_redaction_count_recorded',
      );
      try {
        const inserted = await client.query<{ id: string }>(
          `insert into artifacts (task_id, type, version, data, schema_version)
           values ($1, 'RefinedSpec', 2, '{"goal":"from before"}'::jsonb, '1') returning id`,
          [taskId],
        );
        return inserted.rows[0]?.id as string;
      } finally {
        await client.query(
          `alter table artifacts add constraint artifacts_redaction_count_recorded
           check (redaction_count is not null and redaction_count >= 0) not valid`,
        );
      }
    });

    const refused = await findArtifactBody(drizzled, legacyId);
    expect(refused.found).toBe(true);
    expect(refused.found === true && refused.redacted).toBe(false);
    // The refusal carries the instant rather than the body: it is what the 409 tells a reader, and
    // a branch that returned nothing at all would make the message a guess.
    if (refused.found === true && refused.redacted === false) {
      expect(refused.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }

    // The third answer, which is a different fact from either (standing rule 18).
    expect(await findArtifactBody(drizzled, '00000000-0000-4000-8000-00000000dead')).toEqual({
      found: false,
    });
  });
});

describe('the prompt and context-pack reads, and the rows that predate their writers', () => {
  it('reports a run with no stored prompt as unrecorded, not as a run with an empty prompt', async () => {
    expect(await findRunPrompt(drizzled, runId)).toEqual({ found: true, recorded: false });
    expect(await findRunPrompt(drizzled, '00000000-0000-4000-8000-00000000dead')).toEqual({
      found: false,
    });
  });

  /**
   * **The refusal survives for the case it was written for, with its row count** (WP-57, criterion
   * 2). A run whose header is null — every run created before migration 0041 — is unrecorded however
   * many rows it has, and the count is what separates "never recorded" (`0`) from "rows written
   * outside `RunRepository.insert`" (`2`). The first version of this case asserted `budget_tokens`
   * as the *sum of the rows*, which is the fabricated field this refusal exists to prevent; it is
   * still asserted **with rows present**, the direction a test can get wrong silently (rule 42).
   */
  it('refuses a pack whose run has no recorded header, with the row count, even when rows exist', async () => {
    expect(await findRunContextPack(drizzled, runId)).toEqual({
      found: true,
      recorded: false,
      rows: 0,
    });

    await pool.query(
      `insert into run_context_pack (run_id, tier, source_path, reason, score, tokens, validated,
                                     kb_commit_sha, ordinal)
       values ($1, 0, 'knowledge/index.md', null, null, 120, true, 'abc123', 0),
              ($1, 1, 'knowledge/payments.md', 'paths', 0.5, 80, false, 'abc123', 0)`,
      [runId],
    );
    try {
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

  it('refuses a new tier-1 row without a reason or a score, and any row without an ordinal', async () => {
    // 0041's `NOT VALID` check is enforced on every insert after it: the two nulls a projection
    // would otherwise have to invent cannot be written any more.
    await expect(
      pool.query(
        `insert into run_context_pack (run_id, tier, source_path, reason, score, tokens, ordinal)
         values ($1, 1, 'knowledge/a.md', null, null, 10, 0)`,
        [runId],
      ),
    ).rejects.toThrow(/run_context_pack_row_complete/);
    await expect(
      pool.query(
        `insert into run_context_pack (run_id, tier, source_path, tokens)
         values ($1, 0, 'knowledge/index.md', 10)`,
        [runId],
      ),
    ).rejects.toThrow(/run_context_pack_row_complete/);
    // The header is a pair: a budget without a total is refused rather than stored.
    await expect(
      pool.query('update runs set context_budget_tokens = 100 where id = $1', [runId]),
    ).rejects.toThrow(/runs_context_pack_header_paired/);
  });

  /**
   * **What the store writes is what the endpoint serves, byte for byte** — written through the
   * production `RunRepository.insert`, read through the production projection. The planner-built
   * half of criterion 1 is `test/e2e/pipeline/context-pack.e2e.test.ts`; this case owns the values a
   * fixture vault does not produce: a score with more digits than a `real` keeps, a tier-1 entry
   * recorded `validated: false` that is **not** in the total, an order that is neither by path nor
   * by score, and a commit.
   */
  it('serves the record RunRepository.insert stored, in order, and an empty pack as empty', async () => {
    const store = pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
    const pack: ContextPackRecord = {
      tier0: [
        { path: '.agentic/knowledge/index.md', tokens: 300 },
        { path: 'CLAUDE.md', tokens: 120 },
      ],
      tier1: [
        {
          path: '.agentic/knowledge/zeta.md',
          reason: 'trigger',
          score: 0.123456789012345,
          tokens: 900,
          validated: true,
        },
        {
          path: '.agentic/knowledge/alpha.md',
          reason: 'paths',
          score: 1,
          tokens: 400,
          validated: false,
        },
      ],
      budget_tokens: 12_000,
      total_tokens: 1_320,
      kb_commit: 'f1c7ea4',
    };
    const empty: ContextPackRecord = {
      tier0: [],
      tier1: [],
      budget_tokens: 12_000,
      total_tokens: 0,
      kb_commit: null,
    };
    const written = [
      '00000000-0000-4000-8000-0000000c0a01',
      '00000000-0000-4000-8000-0000000c0a02',
    ];
    // An organisation, a project and a task of its own, and runs that are already `completed`: the
    // list projections the other cases assert count the shared project's rows (the take-over block
    // below says what a fixture that moves another test's arithmetic costs).
    const org = await pool.query<{ id: string }>(
      "insert into organizations (name) values ('context-pack') returning id",
    );
    const ownProject = await pool.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'pack', 'Pack', 'https://git.example.test/acme/pack.git') returning id`,
      [org.rows[0]?.id],
    );
    const ownProjectId = ownProject.rows[0]?.id as string;
    const own = await pool.query<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                          current_stage)
       values ($1, 'fake-jira', 'ACME-57', 'https://jira.example.test/browse/ACME-57', 'feature',
               'cancelled', 'refinement') returning id`,
      [ownProjectId],
    );
    const ownTaskId = own.rows[0]?.id as string;
    const client = await pool.connect();
    try {
      await client.query('begin');
      const tx = { adapter: 'postgres', client } as unknown as Transaction;
      for (const [index, record] of [pack, empty].entries()) {
        await store.runs.insert(tx, {
          id: written[index] as Id,
          taskId: ownTaskId as Id,
          projectId: ownProjectId as Id,
          stage: null,
          role: 'developer',
          mode: 'normal',
          attempt: 1,
          model: 'claude-opus-5',
          effort: 'high',
          promptVersion: 'test',
          status: 'completed',
          terminalReason: null,
          sessionId: null,
          numTurns: 0,
          usage: null,
          cost: null,
          wallMs: 0,
          createdAt: AT as IsoDateTime,
          startedAt: AT as IsoDateTime,
          systemPrompt: null,
          userPrompt: null,
          redactionCount: 0,
          contextPack: record,
        });
      }
      await client.query('commit');
    } finally {
      client.release();
    }

    expect(await findRunContextPack(drizzled, written[0] as string)).toEqual({
      found: true,
      recorded: true,
      pack,
    });
    // Empty is not unwritten: a budget and no rows is a pack, and it is served as one.
    expect(await findRunContextPack(drizzled, written[1] as string)).toEqual({
      found: true,
      recorded: true,
      pack: empty,
    });
    // And the difference is in the rows, not only in the header.
    const { rows } = await pool.query<{ run_id: string; count: string }>(
      `select run_id, count(*) from run_context_pack where run_id = any($1::uuid[]) group by run_id`,
      [written],
    );
    expect(rows.map((row) => [row.run_id, Number(row.count)])).toEqual([[written[0], 4]]);
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
    /**
     * **The priced part of the spend, not the sum** — WP-47, backlog 75, criterion 6.
     *
     * The task has two ledger rows, one reported (0.4) and one estimated (0.06), so the boundary is
     * asserted in both directions at once: this is 0.06 and **not** 0.46, and it is **not** the 0
     * that `tasks.cost_estimated` published for every task the product ever served. The column is
     * gone (migration 0035) and the number is a projection over `cost_entries where is_estimate`.
     */
    expect(detail?.task.cost_estimated_usd).toBe(0.06);
    expect(detail?.task.risk_classes).toEqual(['payments']);
    // `task_stages.state` is the contracts' vocabulary since WP-55 and is published as stored;
    // the projection parses it rather than mapping it. An unknown word cannot reach this read on a
    // migrated database — `task_stages_state_known` refuses it at the write, which
    // `test/integration/db/task-stage-vocabulary.integration.test.ts` asserts.
    expect(detail?.stages).toEqual([
      {
        stage: 'refinement',
        attempt: 1,
        state: 'completed',
        entered_at: expect.any(String),
        exited_at: null,
        outcome: 'approve',
      },
    ]);
    expect([...(detail?.runs ?? [])].map((run) => run.id).sort()).toEqual(
      [runId, blobRunId, localRunId].sort(),
    );
    expect(detail?.runs).toHaveLength(3);
    expect(detail?.runs.every((run) => run.stage === 'refinement')).toBe(true);
    // WP-27: no take-over on this task, and the field says so rather than being absent — the
    // projection reads the event log and this task's log has no `task.taken_over`.
    expect(detail?.taken_over).toBeNull();
    // WP-29: a task with no recorded minutes, and the fields say which of the two "zeroes" it is —
    // no entries at all, rather than entries that measured nothing.
    expect(detail?.human_time).toEqual({
      total_minutes: 0,
      by_kind: { review: 0, question: 0, approval: 0, steer: 0 },
      by_user: null,
      entries: 0,
    });
    expect(await findTaskDetail(drizzled, '00000000-0000-4000-8000-00000000dead')).toBeNull();
  });

  /**
   * **product/18:32's *"per user breakdown off by default"*, both directions** (WP-29).
   *
   * The rows are seeded here rather than folded from events **because this is a test of the read**:
   * the fold from real provider deliveries and a real run is the e2e tier's, which is where WP-29's
   * criterion 8 puts it. What is asserted here is the projection — the four kinds, the sum, the two
   * identity shapes and the setting that decides whether anybody is named.
   */
  describe('the human-time summary', () => {
    const KINDS = ['review', 'question', 'approval', 'steer'] as const;

    beforeAll(async () => {
      const user = await pool.query<{ id: string }>(
        `insert into users (email, name) values ('ada@example.invalid', 'Ada Lovelace')
         returning id`,
      );
      await pool.query(
        `insert into human_time_entries
           (task_id, kind, user_id, external_author, started_at, ended_at, minutes)
         values ($1, 'review', $2, null, $3, $4, 90),
                ($1, 'review', null, 'gitlab:grace', $3, $4, 12.5),
                ($1, 'question', $2, null, $3, $4, 15),
                ($1, 'approval', $2, null, $3, $4, 10),
                ($1, 'steer', $2, null, $3, $4, 5)`,
        [taskId, user.rows[0]?.id, '2026-09-12T09:00:00.000Z', '2026-09-12T10:30:00.000Z'],
      );
    });

    afterAll(async () => {
      await pool.query('delete from human_time_entries where task_id = $1', [taskId]);
      await pool.query("update projects set config = '{}'::jsonb where id = $1", [projectId]);
    });

    it('sums the four kinds and publishes no names by default', async () => {
      const detail = await findTaskDetail(drizzled, taskId);
      expect(detail?.human_time).toEqual({
        total_minutes: 132.5,
        by_kind: { review: 102.5, question: 15, approval: 10, steer: 5 },
        // Off by default — and `null` rather than `[]`, which is the answer when the breakdown is
        // on and nobody has spent a minute.
        by_user: null,
        entries: 5,
      });
      // Every kind the enum has is a key, so a kind added later cannot be silently absent.
      expect(Object.keys(detail?.human_time.by_kind ?? {}).sort()).toEqual([...KINDS].sort());
    });

    it('names the two identity shapes when the project turns the breakdown on', async () => {
      await pool.query(`update projects set config = $2::jsonb where id = $1`, [
        projectId,
        JSON.stringify({ version: 1, features: { human_time: { per_user_breakdown: true } } }),
      ]);
      const detail = await findTaskDetail(drizzled, taskId);

      expect(detail?.human_time.total_minutes).toBe(132.5);
      expect(detail?.human_time.by_user).toEqual([
        {
          user_id: expect.any(String),
          user_name: 'Ada Lovelace',
          external_author: null,
          minutes: 120,
        },
        // The unmapped reviewer: `user_id: null`, named by the provider account instead, and the
        // total above holds all the same (WP-29 criterion 5).
        { user_id: null, user_name: null, external_author: 'gitlab:grace', minutes: 12.5 },
      ]);
    });

    it('reads the breakdown as off when the stored configuration does not parse', async () => {
      // Strict schemas refuse rather than drop, and on the **read** side the conservative answer is
      // the one that publishes fewer names (standing rule 20's split).
      await pool.query(`update projects set config = $2::jsonb where id = $1`, [
        projectId,
        JSON.stringify({
          version: 1,
          features: { human_time: { per_user_breakdown: true } },
          nope: 1,
        }),
      ]);
      expect((await findTaskDetail(drizzled, taskId))?.human_time.by_user).toBeNull();
    });
  });

  /**
   * The take-over projection (WP-27) — the one part of this DTO that reads the **event log**.
   *
   * It has to: `tasks` records that a task is `paused` and not why, and the session id of an
   * interrupted run is on no row. Each case below moves exactly one of the three things the
   * projection reads — the task's state, the newest event on the stream, and the payload — so a
   * projection that ignored any of them fails by name rather than by a `null` that could mean
   * anything (standing rule 42).
   */
  describe('the take-over it reads off the log', () => {
    /**
     * A task of its own, inserted **paused**, because this projection is the only one here that
     * reads the state and the event log together.
     *
     * Inserted rather than updated, and that is not a style choice: `packages/infrastructure/src/
     * pipeline/tasks-column-ownership.test.ts` is a census over every `update tasks set` statement
     * in the repository — tests included — and one here would make this file a second writer of
     * `tasks.state`, which is exactly the class that census exists to refuse. The `events` rows are
     * appended and never deleted for the same kind of reason: the table is append-only for the
     * application role (TD-005), and a `delete` answers `permission denied`. So each case appends
     * the next sequence and asserts what the **newest** event makes true, which is how the
     * projection is specified anyway.
     */
    let pausedTaskId: string;

    const append = async (seq: number, type: string, payload: Record<string, unknown>) => {
      await pool.query(
        `insert into events (stream_type, stream_id, stream_seq, type, payload, actor)
         values ('task', $1, $2, $3, $4::jsonb, '{"kind":"system","component":"test"}'::jsonb)`,
        [
          pausedTaskId,
          seq,
          type,
          JSON.stringify({ project_id: pausedProjectId, task_id: pausedTaskId, ...payload }),
        ],
      );
    };

    /**
     * A project of its own too, so that this task is invisible to the list projections above.
     *
     * Not fastidiousness: `listProjectTasks`'s keyset cases count the rows of `projectId`, and a
     * fifth task added here made one of them fail by name. A fixture that changes another test's
     * arithmetic is a fixture that will keep doing it.
     */
    let pausedProjectId: string;

    beforeAll(async () => {
      const org = await pool.query<{ id: string }>(
        "insert into organizations (name) values ('takeover') returning id",
      );
      const project = await pool.query<{ id: string }>(
        `insert into projects (org_id, key, name, repo_url)
         values ($1, 'takeover', 'Take-over', 'https://git.example.test/acme/takeover.git')
         returning id`,
        [org.rows[0]?.id],
      );
      pausedProjectId = project.rows[0]?.id as string;
      const row = await pool.query<{ id: string }>(
        `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                            current_stage)
         values ($1, 'fake-jira', 'ACME-9', 'https://jira.example.test/browse/ACME-9', 'feature',
                 'paused', 'refinement') returning id`,
        [pausedProjectId],
      );
      pausedTaskId = row.rows[0]?.id as string;
    });

    it('publishes nothing for a paused task whose log has no take-over', async () => {
      // The negative that makes the positives mean something: `paused` alone is not a take-over —
      // a budget pause is one too, and the row cannot tell them apart (standing rule 42).
      expect((await findTaskDetail(drizzled, pausedTaskId))?.taken_over).toBeNull();
    });

    it('publishes the branch, the session and the commands a person runs', async () => {
      await append(1, 'task.taken_over', {
        branch: 'agentic/ACME-9',
        session_id: 'sess-1',
        stage: 'refinement',
      });
      expect((await findTaskDetail(drizzled, pausedTaskId))?.taken_over).toEqual({
        at: expect.any(String),
        branch: 'agentic/ACME-9',
        session_id: 'sess-1',
        stage: 'refinement',
        resume_commands: ['git fetch && git checkout agentic/ACME-9', 'claude --resume sess-1'],
      });
    });

    it('is withdrawn by a later hand-back, because the newest of the two is the answer', async () => {
      await append(2, 'task.handed_back', {
        branch: 'agentic/ACME-9',
        stage: 'code_review',
        summary: 'done by hand',
      });
      expect((await findTaskDetail(drizzled, pausedTaskId))?.taken_over).toBeNull();
    });

    it('publishes nothing for a take-over whose payload carries no branch', async () => {
      // The branch is the whole point of the record; a blank one would send a reader to
      // `git checkout ` and would be worse than an absent card. Appended **after** the hand-back,
      // so this take-over is the newest event and the previous case's answer cannot be the reason.
      await append(3, 'task.taken_over', { session_id: 'sess-2', stage: 'refinement' });
      expect((await findTaskDetail(drizzled, pausedTaskId))?.taken_over).toBeNull();
    });

    it('publishes nothing for a task that is not paused, whatever its log says', async () => {
      // The `active` task the rest of this file uses, whose own log has never had a take-over.
      expect((await findTaskDetail(drizzled, taskId))?.taken_over).toBeNull();
    });
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
         values ($1, 'architecture', 1, 'running') returning id`,
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

/**
 * The five list projections WP-15h part 2 added, against real SQL.
 *
 * What only a database can show here: a `date` column compared as a string, a `count(*)::int` that
 * arrives as a number rather than a string, a `numeric(14,6)` summed in JavaScript, a keyset over a
 * `(timestamptz, uuid)` pair where the timestamps are equal, and a `jsonb` health block parsed back
 * through the published schema. The e2e tier asserts the same endpoints over rows the pipeline
 * wrote; this tier asserts the cases that tier cannot reach.
 */
describe('the list projections', () => {
  /** A second task, created in the same statement as a third, so the two share `created_at`. */
  let twinA: string;
  let twinB: string;
  let orgId: string;

  beforeAll(async () => {
    const org = await pool.query<{ org_id: string }>('select org_id from projects where id = $1', [
      projectId,
    ]);
    orgId = org.rows[0]?.org_id as string;

    // Two tasks in one statement: `now()` is the transaction's clock, so both rows carry the same
    // `created_at` to the microsecond — the case a timestamp-only cursor loses silently.
    const twins = await pool.query<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                          current_stage)
       values ($1, 'fake-jira', 'ACME-2', 'https://jira.example.test/browse/ACME-2', 'feature',
               'done', 'retro'),
              ($1, 'fake-jira', 'ACME-3', 'https://jira.example.test/browse/ACME-3', 'bug',
               'queued', null)
       returning id`,
      [projectId],
    );
    [twinA, twinB] = [twins.rows[0]?.id as string, twins.rows[1]?.id as string];

    await pool.query(
      `insert into questions (task_id, stage, text, blocking, status)
       values ($1, 'refinement', 'Which payment provider?', true, 'open'),
              ($1, 'refinement', 'Answered already', true, 'answered')`,
      [taskId],
    );
    await pool.query(
      `insert into approvals (task_id, kind, status)
       values ($1, 'plan', 'pending'), ($1, 'budget', 'approved')`,
      [taskId],
    );
  }, 60_000);

  it('lists the runs that have not ended, and no others', async () => {
    // A run of its own, unlinked: the seed's unlinked run is *deleted* by the task-projection case
    // above, so relying on it would make this assertion depend on another test's cleanup.
    const mine = await pool.query<{ id: string }>(
      `insert into runs (task_id, project_id, role, model, prompt_version, status)
       values ($1, $2, 'developer', 'claude-opus-5', 'feature@1+developer', 'starting')
       returning id`,
      [taskId, projectId],
    );
    const startingRunId = mine.rows[0]?.id as string;

    // A run with no stage is refused by name rather than dropped from the list — a list that
    // silently omitted it would show fewer agents than are working (standing rule 10).
    await expect(listRunningAgents(drizzled)).rejects.toThrow(/is not linked to a stage/);

    const stage = await pool.query<{ id: string }>(
      `insert into task_stages (task_id, stage, attempt, state)
       values ($1, 'implementation', 1, 'running') returning id`,
      [taskId],
    );
    await pool.query('update runs set task_stage_id = $2 where id = $1', [
      startingRunId,
      stage.rows[0]?.id,
    ]);

    const agents = await listRunningAgents(drizzled);
    const ids = agents.items.map((item) => item.run.id);
    // Both directions (standing rule 42): the two non-terminal runs are present and the two
    // `completed` ones are absent, so neither "everything" nor "nothing" would pass.
    expect(ids).toContain(startingRunId);
    expect(ids).not.toContain(runId);
    expect(ids).not.toContain(blobRunId);
    expect(agents.items.every((item) => item.run.status !== 'completed')).toBe(true);

    const item = agents.items.find((entry) => entry.run.id === startingRunId);
    expect(item?.project_id).toBe(projectId);
    expect(item?.task_id).toBe(taskId);
    expect(item?.role).toBe('developer');
    expect(item?.run.stage).toBe('implementation');
    // Never started, so it has produced nothing — a fact, not a missing value.
    expect(item?.last_output_at).toBeNull();

    await pool.query('delete from runs where id = $1', [startingRunId]);
  });

  it('lists the open questions and the pending approvals, oldest first', async () => {
    const inbox = await listInbox(drizzled);
    expect(inbox.questions.map((question) => question.text)).toEqual(['Which payment provider?']);
    expect(inbox.questions[0]?.stage).toBe('refinement');
    // Both directions: the answered question and the decided approval are *absent*, and the
    // pending ones are present — a filter that dropped everything would satisfy only one of them.
    expect(inbox.approvals.map((approval) => approval.kind)).toEqual(['plan']);
    expect(inbox.approvals[0]?.status).toBe('pending');
  });

  it('pages a project’s tasks by a keyset, through two rows with the same created_at', async () => {
    const all = await listProjectTasks(drizzled, projectId, { limit: 50 });
    expect(all?.items.length).toBe(3);
    expect(all?.next).toBeUndefined();

    // One row at a time across the twins. **This is the case that found a real defect**: the cursor
    // used to carry the `created_at` node-postgres had parsed into a `Date`, which is milliseconds
    // while the column is microseconds, so the keyset excluded the very row it came from and this
    // loop saw 2 of 3. A short page and the last page are indistinguishable, so nothing else would
    // ever have noticed. The cursor is now the database's own rendering.
    const seen: string[] = [];
    let cursor = undefined as { createdAt: string; id: string } | undefined;
    for (let page = 0; page < 4; page += 1) {
      const next = await listProjectTasks(drizzled, projectId, {
        limit: 1,
        ...(cursor === undefined ? {} : { before: cursor }),
      });
      seen.push(...(next?.items ?? []).map((task) => task.id));
      if (next?.next === undefined) {
        break;
      }
      cursor = next.next;
    }
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect(seen).toContain(twinA);
    expect(seen).toContain(twinB);
    expect(seen).toContain(taskId);

    // And the cursor really is finer than a millisecond, or the case above would be asserting the
    // fix against data that never exercises it (standing rule 4 — audit the instrument).
    const firstPage = await listProjectTasks(drizzled, projectId, { limit: 1 });
    expect(firstPage?.next?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });

  it('answers null for a project that does not exist, rather than an empty page', async () => {
    // An empty page and a uuid that names nothing are different facts, and the `where` cannot tell
    // them apart — so without the existence check this endpoint would answer `200 {items: []}` for
    // an id its siblings (`/config`, `/budgets`, `/readiness`) all answer 404 for. Both directions
    // (standing rule 42): the unknown id is null **and** a real project with no matching task is
    // still a page, or "return null whenever the page is empty" would pass.
    expect(
      await listProjectTasks(drizzled, '00000000-0000-4000-8000-00000000dead', { limit: 50 }),
    ).toBeNull();
    expect(
      (await listProjectTasks(drizzled, projectId, { limit: 50, state: 'cancelled' }))?.items,
    ).toEqual([]);
  });

  it('filters the task page by state and by stage', async () => {
    const done = await listProjectTasks(drizzled, projectId, { limit: 50, state: 'done' });
    expect(done?.items.map((task) => task.ticket.key)).toEqual(['ACME-2']);
    const bugs = await listProjectTasks(drizzled, projectId, { limit: 50, template: 'bug' });
    expect(bugs?.items.map((task) => task.ticket.key)).toEqual(['ACME-3']);
    const refining = await listProjectTasks(drizzled, projectId, {
      limit: 50,
      stage: 'refinement',
    });
    expect(refining?.items.map((task) => task.ticket.key)).toEqual(['ACME-1']);
    // A filter that matches nothing is an empty page, not an unfiltered one.
    expect(
      (await listProjectTasks(drizzled, projectId, { limit: 50, state: 'cancelled' }))?.items,
    ).toEqual([]);
  });

  it('summarises a project’s open work and its thirty-day spend', async () => {
    const at = '2026-09-30T12:00:00.000Z' as IsoDateTime;
    await pool.query(
      `insert into cost_rollup_daily (org_id, project_id, template, stage, model, day, mode, usd)
       values ($1, $2, 'feature', 'refinement', 'claude-opus-5', '2026-09-30', 'actual', 1.5),
              ($1, $2, 'feature', 'refinement', 'claude-opus-5', '2026-09-01', 'actual', 0.25),
              ($1, $2, 'feature', 'refinement', 'claude-opus-5', '2026-08-31', 'actual', 99)`,
      [orgId, projectId],
    );

    const summaries = await listProjectSummaries(drizzled, at);
    const project = summaries.items.find((entry) => entry.id === projectId);
    // Three tasks, one of them `done` — `merged` and `retro` would still count, `done` does not.
    expect(project?.open_tasks).toBe(2);
    // Both ends of the window (standing rule 42): the 1st is the thirtieth day back and is
    // included; 31 August is the thirty-first and is not. Without the second assertion a reader
    // that ignored the cutoff entirely would pass.
    expect(project?.spent_usd_30d).toBe(1.75);
    expect(project?.key).toBe('api');
    expect(project?.readiness_level).toBe(0);
  });

  /**
   * **Both states, on either side of the row WP-21's evaluator writes.**
   *
   * The refusal used to be a statement about the *build* — nothing wrote `readiness_evaluations` at
   * all — and this case asserted it in both directions for that reason. WP-21 narrowed it to a
   * statement about the *project*, so the second half now asserts the **success** branch, and the
   * two together are what stop either from being satisfied vacuously (standing rule 42).
   */
  it('refuses a project nothing has evaluated and answers one that has been', async () => {
    expect(await findProjectReadiness(drizzled, projectId)).toEqual({
      found: true,
      recorded: false,
      rows: 0,
    });
    await pool.query(
      `insert into readiness_evaluations (project_id, level, criteria, source)
       values ($1, 1, $2::jsonb, 'discovery')`,
      [
        projectId,
        JSON.stringify([
          { id: 'R1', passed: true, evidence: 'ran the suite', detected_by: 'agent', unlocks: '' },
          { id: 'R3', passed: true, evidence: 'CI runs on MRs', detected_by: 'agent', unlocks: '' },
          // An id no release has: dropped rather than served with an invented `unlocks`.
          { id: 'R99', passed: true, evidence: 'invented', detected_by: 'agent', unlocks: '' },
        ]),
      ],
    );
    try {
      const answered = await findProjectReadiness(drizzled, projectId);
      expect(answered.found).toBe(true);
      expect(answered.found && answered.recorded).toBe(true);
      const response = answered.found && answered.recorded ? answered.response : null;
      expect(response?.level).toBe(1);
      expect(response?.source).toBe('discovery');
      expect(response?.criteria.map((entry) => entry.id)).toEqual(['R1', 'R3']);
      // `unlocks` comes from the platform's table, not from the stored copy — the row above wrote
      // an empty string and the read publishes product/17's sentence.
      expect(response?.criteria[0]?.unlocks).toContain('Implementation self-check');
      // R1 and R3 pass, so the next rung is level 2 and the advice names its criteria.
      expect(response?.next_improvements.map((entry) => entry.id)).toEqual(['R2', 'R4', 'R5']);
    } finally {
      await pool.query('delete from readiness_evaluations where project_id = $1', [projectId]);
    }
    expect(await findProjectReadiness(drizzled, '00000000-0000-4000-8000-00000000dead')).toEqual({
      found: false,
    });
  });

  it('publishes an integration without its credentials, and withholds a config it cannot read', async () => {
    const planted = 'FAKE-gitlab-token-DO-NOT-USE-integration-tier';
    await pool.query(
      `insert into integrations (org_id, type, provider, name, config)
       values ($1, 'git', 'gitlab', 'acme gitlab', $2::jsonb),
              ($1, 'git', 'unshipped-forge', 'acme other', $3::jsonb)`,
      [
        orgId,
        JSON.stringify({ base_url: 'https://gitlab.example.test', token: planted }),
        JSON.stringify({ base_url: 'https://forge.example.test', token: planted }),
      ],
    );

    const rows = await listIntegrationRows(drizzled);
    const summaries = rows.map((row) =>
      toIntegrationSummary(row, findShippedProvider(row.provider)),
    );
    const gitlab = summaries.find((summary) => summary.provider === 'gitlab');
    const other = summaries.find((summary) => summary.provider === 'unshipped-forge');

    // Both directions on the credential (standing rules 35 and 42): it is gone from the response,
    // and the configuration beside it survived — so this is not a reader that publishes nothing.
    expect(JSON.stringify(summaries)).not.toContain(planted);
    expect(gitlab?.config).toEqual({ base_url: 'https://gitlab.example.test' });
    expect(gitlab?.health).toEqual({ status: 'unknown', checked_at: null, detail: null });
    // A provider this build does not ship: fail closed, because its credential fields are unknown.
    expect(other?.config).toEqual({});
    expect(other?.name).toBe('acme other');

    const one = await findIntegrationRow(drizzled, rows[0]?.id ?? '');
    expect(one?.id).toBe(rows[0]?.id);
    expect(
      await findIntegrationRow(drizzled, '00000000-0000-4000-8000-00000000dead'),
    ).toBeUndefined();
  });

  it('reads the newest knowledge health report, an empty one as empty, and null when no pass has run', async () => {
    expect(await findKbHealth(drizzled, projectId)).toBeNull();
    // A report that found nothing is a report, not an absent one (WP-57, criterion 5): the route
    // answers the first with 200 and `findings: []`, the null above with 409.
    await pool.query(
      `insert into kb_health_reports (project_id, commit_sha, documents, findings, source, created_at)
       values ($1, 'older', 1, '[]'::jsonb, 'hygiene', '2026-09-01T00:00:00Z')`,
      [projectId],
    );
    const clean = await findKbHealth(drizzled, projectId);
    expect(clean?.findings).toEqual([]);
    expect(clean?.documents).toBe(1);

    // `invalid` (WP-57) is a kind of the stored report, which the Librarian artifact does not carry.
    const findings = [
      {
        kind: 'invalid',
        path: 'knowledge/broken.md',
        detail:
          'the parser refused it at line 3, so no context pack includes it: frontmatter: a tab character',
      },
      { kind: 'expired', path: 'knowledge/payments.md', detail: 'not touched since March' },
    ];
    await pool.query(
      `insert into kb_health_reports (project_id, commit_sha, documents, findings, source, created_at)
       values ($1, 'newer', 4, $2::jsonb, 'hygiene', '2026-09-02T00:00:00Z')`,
      [projectId, JSON.stringify(findings)],
    );

    const report = await findKbHealth(drizzled, projectId);
    expect(report?.commit_sha).toBe('newer');
    expect(report?.documents).toBe(4);
    expect(report?.findings).toEqual(findings);
    expect(report?.source).toBe('hygiene');

    // A row whose stored findings no longer match the published shape is refused by name rather
    // than served as something it is not.
    await pool.query(
      `insert into kb_health_reports (project_id, commit_sha, documents, findings, source, created_at)
       values ($1, 'broken', 1, $2::jsonb, 'hygiene', '2026-09-03T00:00:00Z')`,
      [projectId, JSON.stringify([{ kind: 'stale', path: 'knowledge/a.md', detail: 'x' }])],
    );
    await expect(findKbHealth(drizzled, projectId)).rejects.toThrow(/findings/);
  });
});
