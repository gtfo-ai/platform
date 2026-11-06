/**
 * `GET /api/projects/:id/spend`'s projection against a real PostgreSQL 18 (S-25.7, research/21 F8).
 *
 * The Budgets tab shows where a project's money went in one window — per stage and its top tasks —
 * and every figure is a sum over `cost_entries`, the ledger's own rows. What only a real database
 * shows: `numeric(12,6)` sums arriving as strings, the window boundary on the partition key, the
 * estimate split (`is_estimate`), the scoping to one project, and the title projection out of
 * `tasks.ticket_snapshot`, which publishes `null` for a snapshot whose `title` is not a string.
 *
 * **And the ledger's own rows as they are** (review of PR #86): an ask runs outside any stage and
 * the ledger books it under the placeholder `'(none)'`, which is not a stage id. Every answer here
 * is parsed with the published `projectSpendResponseSchema`, and one case goes through the real
 * route with the zod serializer the server uses, because a projection that returns a value its own
 * response schema refuses is a 500 on the Budgets tab — which is what the first version did.
 */
import { createRequire } from 'node:module';
import { type IsoDateTime, projectSpendResponseSchema } from '@platform/contracts';
import { db } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toApiError } from '../../../apps/server/src/errors.js';
import { projectSpend } from '../../../apps/server/src/queries/cost-queries.js';
import { registerProjectRoutes } from '../../../apps/server/src/routes/projects.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

/**
 * Fastify and its zod compilers, resolved **from `apps/server`**, for the reason
 * `read-api.integration.test.ts` measured: the root does not depend on them.
 */
const fromServer = createRequire(new URL('../../../apps/server/package.json', import.meta.url));
const fastify = fromServer('fastify') as () => Parameters<typeof registerProjectRoutes>[0];
const { serializerCompiler, validatorCompiler } = fromServer('fastify-type-provider-zod') as {
  // biome-ignore lint/suspicious/noExplicitAny: the compilers' own types live in apps/server's graph.
  readonly serializerCompiler: any;
  // biome-ignore lint/suspicious/noExplicitAny: as above.
  readonly validatorCompiler: any;
};

/** The DTO a projection result becomes on the wire, parsed by the published schema. */
const published = (spend: Awaited<ReturnType<typeof projectSpend>>) =>
  projectSpendResponseSchema.parse({
    window: 'month',
    window_start: windowStart,
    ...spend,
    stages: [...spend.stages],
    top_tasks: [...spend.top_tasks],
  });

let database: MigratedDatabase;
let pool: pg.Pool;
let drizzled: ReturnType<typeof drizzle<typeof db.schema>>;
let projectId: string;
let bigTaskId: string;
let smallTaskId: string;
let windowStart: IsoDateTime;

const one = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => {
  const result = await pool.query<T>(text, values);
  return result.rows[0] as T;
};

/** A task of `project`, with a run to hang ledger rows on. */
const seedTask = async (
  project: string,
  key: string,
  snapshot: unknown,
  mode: 'normal' | 'shadow' = 'normal',
): Promise<{ taskId: string; runId: string }> => {
  const task = await one<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state, mode,
                        ticket_snapshot)
     values ($1, 'fake-jira', $2, 'https://jira.example.test/browse/' || $2, 'feature', 'active',
             $3, $4::jsonb) returning id`,
    [project, key, mode, snapshot === null ? null : JSON.stringify(snapshot)],
  );
  const run = await one<{ id: string }>(
    `insert into runs (task_id, project_id, role, model, prompt_version, status)
     values ($1, $2, 'developer', 'claude-opus-5', 'feature@1+developer', 'completed')
     returning id`,
    [task.id, project],
  );
  return { taskId: task.id, runId: run.id };
};

/** One ledger row; `daysAgo` places it before or inside the window. */
const charge = async (
  row: { taskId: string; runId: string; project: string },
  stage: string,
  model: string,
  usd: number,
  isEstimate: boolean,
  daysAgo = 0,
): Promise<void> => {
  await pool.query(
    `insert into cost_entries (run_id, task_id, project_id, stage, model, usd, is_estimate,
                               created_at)
     values ($1, $2, $3, $4, $5, $6, $7, now() - make_interval(days => $8))`,
    [row.runId, row.taskId, row.project, stage, model, usd, isEstimate, daysAgo],
  );
};

beforeAll(async () => {
  database = await createMigratedDatabase('project-spend');
  pool = createTestPool(database.connectionString, { options: '-c role=platform_app', max: 4 });
  drizzled = drizzle(pool, { schema: db.schema });

  const org = await one<{ id: string }>(
    "insert into organizations (name) values ('s') returning id",
  );
  const project = await one<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
    [org.id],
  );
  projectId = project.id;
  const other = await one<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'web', 'Web', 'https://git.example.test/acme/web.git') returning id`,
    [org.id],
  );

  const big = await seedTask(projectId, 'ACME-1', { title: 'Checkout flow' });
  const small = await seedTask(projectId, 'ACME-2', { title: 42 }, 'shadow');
  const elsewhere = await seedTask(other.id, 'WEB-1', { title: 'Not this project' });
  bigTaskId = big.taskId;
  smallTaskId = small.taskId;
  const at = (row: { taskId: string; runId: string }, owner = projectId) => ({
    ...row,
    project: owner,
  });

  // Inside the window: two stages, one reported and one priced figure on the developer stage.
  await charge(at(big), 'implementation', 'claude-opus-5', 1.5, false);
  await charge(at(big), 'implementation', 'claude-haiku-5', 0.25, true);
  await charge(at(big), 'refinement', 'claude-sonnet-5', 0.4, false);
  await charge(at(small), 'implementation', 'claude-opus-5', 0.1, true);
  // An ask of the big task: no stage, so the ledger's placeholder (`cost/ledger.ts`).
  await charge(at(big), '(none)', 'claude-fable-5-1', 0.05, false);
  // Outside it: before the window, and another project's spend inside it.
  await charge(at(big), 'refinement', 'claude-sonnet-5', 9, false, 3);
  await charge(at(elsewhere, other.id), 'implementation', 'claude-opus-5', 7, false);

  const boundary = await one<{ start: Date }>("select now() - interval '1 day' as start");
  windowStart = boundary.start.toISOString() as IsoDateTime;
});

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('the project spend projection (S-25.7)', () => {
  it('sums the project’s ledger rows in the window per stage, most first, with the estimated part', async () => {
    const spend = published(await projectSpend(drizzled, projectId, windowStart));
    expect(spend.stages).toEqual([
      { stage: 'implementation', usd: 1.85, estimated_usd: 0.35 },
      { stage: 'refinement', usd: 0.4, estimated_usd: 0 },
      // The ask's `'(none)'` is published as no stage, never as a stage id it is not.
      { stage: null, usd: 0.05, estimated_usd: 0 },
    ]);
    // The whole is its stages: the 9 before the window and the other project's 7 are in neither.
    expect(spend.usd).toBeCloseTo(2.3, 6);
    expect(spend.estimated_usd).toBeCloseTo(0.35, 6);
  });

  it('names the most expensive tasks, with the ticket and a title only when it is a string', async () => {
    const spend = published(await projectSpend(drizzled, projectId, windowStart));
    expect(spend.top_tasks).toEqual([
      {
        task_id: bigTaskId,
        ticket_key: 'ACME-1',
        ticket_title: 'Checkout flow',
        mode: 'normal',
        // Its ask is its spend too.
        usd: 2.2,
        estimated_usd: 0.25,
      },
      {
        task_id: smallTaskId,
        ticket_key: 'ACME-2',
        // The snapshot's `title` is a number: published as null, never as "42".
        ticket_title: null,
        mode: 'shadow',
        usd: 0.1,
        estimated_usd: 0.1,
      },
    ]);
  });

  it('answers a window nothing was booked in with zeros and empty lists, never an error', async () => {
    const later = await one<{ start: Date }>("select now() + interval '1 hour' as start");
    const spend = await projectSpend(drizzled, projectId, later.start.toISOString() as IsoDateTime);
    expect(spend).toEqual({ usd: 0, estimated_usd: 0, stages: [], top_tasks: [] });
    expect(() => published(spend)).not.toThrow();
  });

  it('moves the boundary with the window start: a longer window takes the older row in', async () => {
    const week = await one<{ start: Date }>("select now() - interval '7 days' as start");
    const spend = await projectSpend(drizzled, projectId, week.start.toISOString() as IsoDateTime);
    expect(spend.stages.find((line) => line.stage === 'refinement')?.usd).toBeCloseTo(9.4, 6);
  });

  it('answers 200 through the real route, serialized by the server’s zod compiler, with an ask in the window', async () => {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler(async (error: unknown, _request, reply) => {
      const mapped = toApiError(error, 'test-request');
      return reply.status(mapped.statusCode).send(mapped.body);
    });
    app.addHook('onRequest', async (request) => {
      request.actor = {
        userId: '00000000-0000-4000-8000-0000000000a1',
        email: 'admin@example.test',
        name: 'Admin',
        role: 'admin',
        sessionId: 'session-1',
      };
    });
    // The spend route reads nothing the redactor guards (`invalid_stored_config` is another route's).
    await registerProjectRoutes(app, { database: drizzled, redactor: {} as never });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/spend?window=month`,
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = projectSpendResponseSchema.parse(response.json());
      expect(body.window).toBe('month');
      expect(body.stages.find((line) => line.stage === null)?.usd).toBeCloseTo(0.05, 6);
      // The other direction: a bad window is the caller's 400, not a 500.
      const refused = await app.inject({
        method: 'GET',
        url: `/api/projects/${projectId}/spend?window=fortnight`,
      });
      expect(refused.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
