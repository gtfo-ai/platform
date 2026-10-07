/**
 * **A run cancelled before its CLI was asked for says why** — WP-154 (b′), PROGRESS backlog 502,
 * against a real PostgreSQL 18.
 *
 * The unit tiers hold the rule over the in-memory store
 * (`packages/application/src/pipeline/human-commands.test.ts` › "records why it did not start, on
 * run.finished and on the row (WP-154 (b′), backlog 502)"). What only a database can show is the whole
 * path a person sees: the command ends the row in place with the cause on `runs.exit_detail`, the
 * `run.finished` it appends carries the same object in the `events` table — read back and parsed by
 * the published schema, as a replay would — and `GET /api/runs/:id`, the real route over the real
 * projection (`startFailureOf`), publishes it as `start_failure`, which is what makes the run page
 * show its not-started panel. Both directions (standing rule 42): the same cancel after the marker
 * records no cause anywhere.
 */
import { createRequire } from 'node:module';
import {
  cancelRunCommand,
  type HumanCommandDependencies,
  INITIAL_TASK_VERSION,
  type PipelineStore,
  type StoredTask,
  type Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, Slug } from '@platform/contracts';
import { runFinishedEvent, runRecordSchema } from '@platform/contracts';
import { FEATURE_TEMPLATE, SHIPPED_TEMPLATES } from '@platform/domain';
import { db, eventing, pipeline, redaction } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toApiError } from '../../../apps/server/src/errors.js';
import { databaseRunQueries, registerRunRoutes } from '../../../apps/server/src/routes/runs.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

const NOW = '2026-10-07T09:00:00.000Z' as IsoDateTime;

let database: MigratedDatabase;
let pool: pg.Pool;
let projectId: Id;
let userId: Id;
let store: PipelineStore;
let counter = 0;
const nextId = (): Id => {
  counter += 1;
  return `00000000-0000-4000-8154-${counter.toString(16).padStart(12, '0')}` as Id;
};

/** Resolved from `apps/server`, the package that depends on them (read-api's reasoning). */
const fromServer = createRequire(new URL('../../../apps/server/package.json', import.meta.url));
const fastify = fromServer('fastify') as () => Parameters<typeof registerRunRoutes>[0];
const { serializerCompiler, validatorCompiler } = fromServer('fastify-type-provider-zod') as {
  // biome-ignore lint/suspicious/noExplicitAny: the compilers' own types live in apps/server's graph.
  readonly serializerCompiler: any;
  // biome-ignore lint/suspicious/noExplicitAny: as above.
  readonly validatorCompiler: any;
};

beforeAll(async () => {
  database = await createMigratedDatabase('cancel-before-cli-spawn');
  pool = createTestPool(database.connectionString, { max: 6 });
  store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('cancel-before-cli-spawn') returning id",
  );
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
    [org.rows[0]?.id],
  );
  projectId = project.rows[0]?.id as Id;
  const user = await pool.query<{ id: string }>(
    `insert into users (email, name) values ('operator@example.test', 'Operator') returning id`,
  );
  userId = user.rows[0]?.id as Id;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

/**
 * A committed task at `implementation`, its stage row, and one `running` run with **no lease**, so
 * a cancel ends it in place (TD-028 decision 11) — with or without the CLI spawn marker.
 */
const seedRun = async (reachedCli: boolean): Promise<Id> => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  try {
    await client.query('begin');
    const tx = { adapter: 'postgres', client } as unknown as Transaction;
    const taskId = nextId();
    const stored = {
      task: {
        id: taskId,
        projectId,
        ticket: {
          provider: 'fake-jira',
          key: `ACME-${counter}`,
          url: `https://jira.example.test/browse/ACME-${counter}`,
        },
        template: 'feature',
        mode: 'normal',
        state: 'active',
        currentStage: 'implementation' as Slug,
        stageAttempts: { implementation: 1 },
        iterationCounters: {},
        limits: {
          code_review: 3,
          business_review: 2,
          ci_fix: 3,
          human_rounds: 3,
          refinement_questions: 2,
          architecture_revisions: 2,
          rebase: 2,
          rebase_rechecks: 10,
          dependency_policy: 2,
        },
        sequence: 1,
      },
      template: FEATURE_TEMPLATE,
      pipelineDial: null,
      priorityRank: 2,
      createdAt: NOW,
      branch: null,
      mr: null,
      workpad: null,
      costActualUsd: 0,
      estimateUsd: null,
      estimateBasis: null,
      estimateSamples: null,
      ticketSnapshot: null,
      ticketSnapshotAt: null,
      ticketSignalAt: null,
      reviewSubject: null,
      historySample: null,
      riskClasses: [],
      coverage: null,
      dependencies: null,
      requiredReviewers: null,
      reviewThreads: null,
      readyHeadSha: null,
      ciHeadSha: null,
      ciExcusedPaths: [],
      requestedByUserId: null,
      version: INITIAL_TASK_VERSION,
    } as unknown as StoredTask;
    await store.tasks.insert(tx, stored);
    // The stage row the run links to: `GET /api/runs/:id` refuses a stage run with no link.
    await client.query(
      `insert into task_stages (task_id, stage, attempt, state) values ($1, 'implementation', 1, 'running')`,
      [taskId],
    );
    const runId = nextId();
    await store.runs.insert(tx, {
      id: runId,
      taskId,
      projectId,
      stage: 'implementation' as Slug,
      role: 'developer',
      mode: 'normal',
      attempt: 1,
      model: 'claude-opus-5',
      effort: 'high',
      promptVersion: 'test@1',
      systemPrompt: null,
      userPrompt: null,
      redactionCount: 0,
      contextPack: null,
      settings: null,
      reserveUsd: 15,
      promptsWithheld: null,
      providerMode: 'api',
      status: 'running',
      terminalReason: null,
      sessionId: null,
      numTurns: 0,
      usage: null,
      cost: null,
      wallMs: 0,
      createdAt: NOW,
      startedAt: NOW,
    });
    if (reachedCli) {
      await client.query('update runs set cli_spawn_requested_at = $2 where id = $1', [runId, NOW]);
    }
    await client.query('commit');
    return runId;
  } finally {
    await client.end();
  }
};

const commands = (): HumanCommandDependencies => ({
  unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
  store,
  context: (correlationId) => ({
    ids: { next: () => crypto.randomUUID() as Id },
    actor: { kind: 'system', component: 'test' },
    clock: { now: () => NOW },
    correlationId,
    causeEventId: null,
  }),
  jobs: null,
  eventStore: new eventing.PostgresEventStore(pool),
  redactor: redaction.patternRedactor(),
  defaultTaskCapUsd: 50,
  models: { isListed: async () => true },
  settings: {
    read: async () => {
      throw new Error('a cancel reads no settings');
    },
  } as unknown as HumanCommandDependencies['settings'],
});

/** The run's `run.finished`, read back from `events` and parsed as a replay would parse it. */
const finishedEvent = async (runId: Id) => {
  const { rows } = await pool.query<Record<string, unknown>>(
    `select id, stream_type, stream_id, stream_seq, correlation_id, cause_event_id, actor,
            occurred_at, type, payload
       from events where type = 'run.finished' and payload->>'run_id' = $1`,
    [runId],
  );
  return rows.map((row) =>
    runFinishedEvent.parse({
      ...row,
      stream_seq: Number(row.stream_seq),
      occurred_at: (row.occurred_at as Date).toISOString(),
    }),
  );
};

/** `GET /api/runs/:id` through the real route over the real projection, as an administrator. */
const getRun = async (runId: Id) => {
  const app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(async (error: unknown, _request, reply) => {
    const mapped = toApiError(error, 'cancel-before-cli-spawn');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  app.addHook('onRequest', async (request) => {
    request.actor = {
      userId,
      email: 'operator@example.test',
      name: 'Operator',
      role: 'admin',
      sessionId: 'session-1',
    };
  });
  await registerRunRoutes(app, {
    queries: databaseRunQueries(drizzle(pool, { schema: db.schema })),
  });
  await app.ready();
  try {
    const response = await app.inject({ method: 'GET', url: `/api/runs/${runId}` });
    expect(response.statusCode, response.body).toBe(200);
    return runRecordSchema.parse(response.json());
  } finally {
    await app.close();
  }
};

describe('a run cancelled before its CLI spawn marker, against PostgreSQL (WP-154 (b′))', () => {
  it('records why it did not start on the row, on run.finished and through GET /api/runs/:id', async () => {
    const runId = await seedRun(false);
    const outcome = await cancelRunCommand(commands(), { runId, userId });
    expect(outcome.commandId).toBeNull();

    const cause = {
      kind: 'not_started',
      diagnosis:
        'cancelled by a person before its CLI was asked to start: no process was holding the run, so it was ended as a record',
      detail: null,
      truncated: false,
      attempt: 1,
      retryable: false,
    };
    const { rows } = await pool.query<{ status: string; exit_detail: unknown }>(
      'select status::text as status, exit_detail from runs where id = $1',
      [runId],
    );
    expect(rows).toEqual([{ status: 'cancelled', exit_detail: cause }]);

    const events = await finishedEvent(runId);
    expect(events.map((event) => event.payload.start_failure)).toEqual([cause]);

    const published = await getRun(runId);
    expect(published.status).toBe('cancelled');
    expect(published.start_failure).toEqual(cause);
    // The measured zero WP-150 gave it, unchanged.
    expect(published.cost).toEqual({ usd: 0, is_estimate: false, price_list_id: null });
  });

  it('records no cause for the same cancel once the CLI was asked for', async () => {
    const runId = await seedRun(true);
    await cancelRunCommand(commands(), { runId, userId });
    const events = await finishedEvent(runId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.start_failure).toBeUndefined();
    expect((await getRun(runId)).start_failure).toBeNull();
  });
});
