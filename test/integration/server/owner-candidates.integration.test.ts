/**
 * `GET /api/projects/:id/owner-candidates` against a real PostgreSQL 18 (S-26.1's follow-up, the
 * M26 UX spec § 2's *Assign…* picker).
 *
 *  1. **Through the real route** over the real reads (`findProjectRole`, `findOwnerCandidates`): 401
 *     with no session, 403 for a member, and 200 for a maintainer by membership — the list leaving
 *     out a disabled user and every non-member (an organisation viewer with no membership, a project
 *     viewer, a member of another project only), sorted by name and then id.
 *  2. **The list is the owner command's own answer**: for every fixture user, the real
 *     `setTaskOwnerCommand` on the real store, asked by a maintainer, accepts that user as a new
 *     owner exactly when the list names them, and refuses everyone else `owner_not_project_member`.
 */
import { createRequire } from 'node:module';
import {
  INITIAL_TASK_VERSION,
  OwnerChangeRefusedError,
  type PipelineStore,
  type StoredTask,
  setTaskOwnerCommand,
  type Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, Slug } from '@platform/contracts';
import { FEATURE_TEMPLATE, SHIPPED_TEMPLATES } from '@platform/domain';
import { db, eventing, pipeline } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../../../apps/server/src/auth/rbac.js';
import { toApiError } from '../../../apps/server/src/errors.js';
import { findProjectRole } from '../../../apps/server/src/queries/identity-queries.js';
import { findOwnerCandidates } from '../../../apps/server/src/queries/owner-candidate-queries.js';
import { ownerCandidateWriteBack } from '../../../apps/server/src/queries/pipeline-queries.js';
import { registerOwnerCandidateRoutes } from '../../../apps/server/src/routes/owner-candidates.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

const NOW = '2026-11-07T09:00:00.000Z' as IsoDateTime;

/**
 * Fastify and its zod compilers, resolved **from `apps/server`**, which is the package that depends
 * on them — the reason and the shape are `read-api.integration.test.ts`'s (WP-85 review round 1).
 */
type ServerApp = Parameters<typeof registerOwnerCandidateRoutes>[0];
const fromServer = createRequire(new URL('../../../apps/server/package.json', import.meta.url));
const fastify = fromServer('fastify') as () => ServerApp;
const { serializerCompiler, validatorCompiler } = fromServer('fastify-type-provider-zod') as {
  // biome-ignore lint/suspicious/noExplicitAny: the compilers' own types live in apps/server's graph.
  readonly serializerCompiler: any;
  // biome-ignore lint/suspicious/noExplicitAny: as above.
  readonly validatorCompiler: any;
};

/**
 * Every way a user can stand towards the project, and whether the owner command takes them. Names
 * are lowercase ASCII so the order is the same under any collation; `bo` twice for the id tiebreak.
 */
const FIXTURES = [
  { key: 'ada', orgRole: 'member', membership: null, status: 'active', owns: true },
  { key: 'bo1', name: 'bo', orgRole: 'viewer', membership: 'member', status: 'active', owns: true },
  { key: 'bo2', name: 'bo', orgRole: 'member', membership: null, status: 'active', owns: true },
  { key: 'cy', orgRole: 'viewer', membership: 'maintainer', status: 'active', owns: true },
  { key: 'dee', orgRole: 'member', membership: null, status: 'disabled', owns: false },
  { key: 'eve', orgRole: 'viewer', membership: null, status: 'active', owns: false },
  { key: 'fay', orgRole: 'viewer', membership: 'viewer', status: 'active', owns: false },
  { key: 'gus', orgRole: 'viewer', membership: 'other', status: 'active', owns: false },
  { key: 'hal', orgRole: 'viewer', membership: 'member', status: 'disabled', owns: false },
  { key: 'ivy', orgRole: 'admin', membership: null, status: 'active', owns: true },
  { key: 'max', orgRole: 'member', membership: 'member', status: 'active', owns: true },
] as const;

type FixtureKey = (typeof FIXTURES)[number]['key'];

let database: MigratedDatabase;
let pool: pg.Pool;
let store: PipelineStore;
let app: ServerApp;
let projectId: Id;
let actor: Actor | undefined;
const users = new Map<FixtureKey, { readonly id: Id; readonly name: string }>();
let counter = 0;

const query = async <R extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<R[]> => (await pool.query<R>(text, values)).rows;

const idOf = (key: FixtureKey): Id => {
  const user = users.get(key);
  if (user === undefined) {
    throw new Error(`fixture ${key} was not inserted`);
  }
  return user.id;
};

const actAs = (key: FixtureKey, role: Actor['role']): void => {
  actor = {
    userId: idOf(key),
    email: `${key}@example.test`,
    name: key,
    role,
    sessionId: `session-${key}`,
  };
};

beforeAll(async () => {
  database = await createMigratedDatabase('owner-candidates');
  pool = createTestPool(database.connectionString, { max: 4 });
  store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
  const [org] = await query<{ id: string }>(
    "insert into organizations (name) values ('owner-candidates') returning id",
  );
  const project = async (key: string): Promise<Id> =>
    (
      (
        await query<{ id: string }>(
          `insert into projects (org_id, key, name, repo_url)
           values ($1, $2, $2, 'https://git.example.test/acme/' || $2 || '.git') returning id`,
          [org?.id, key],
        )
      )[0] as { id: string }
    ).id as Id;
  projectId = await project('cand');
  const otherProjectId = await project('else');
  for (const fixture of FIXTURES) {
    const name = 'name' in fixture ? fixture.name : fixture.key;
    const [row] = await query<{ id: string }>(
      'insert into users (email, name, role, status) values ($1, $2, $3, $4) returning id',
      [`${fixture.key}@example.test`, name, fixture.orgRole, fixture.status],
    );
    users.set(fixture.key, { id: row?.id as Id, name });
    if (fixture.membership !== null) {
      const other = fixture.membership === 'other';
      await query('insert into project_members (project_id, user_id, role) values ($1, $2, $3)', [
        other ? otherProjectId : projectId,
        row?.id,
        other ? 'maintainer' : fixture.membership,
      ]);
    }
  }

  const drizzled = drizzle(pool, { schema: db.schema });
  app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(async (error: unknown, _request, reply) => {
    const mapped = toApiError(error, 'test-request');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  app.addHook('onRequest', async (request) => {
    if (actor !== undefined) {
      request.actor = actor;
    }
  });
  await registerOwnerCandidateRoutes(app, {
    queries: {
      projectRole: async (project, userId) => findProjectRole(drizzled, project, userId),
      candidates: async (project) => findOwnerCandidates(drizzled, project),
      // S-26.3: each candidate's `writes_back`; this project has no binding, so every one is false
      // (the opted-in cases are `test/integration/pipeline/task-owner-write-back.integration.test.ts`).
      writeBack: async (input, userIds) => ownerCandidateWriteBack(drizzled, input, userIds),
    },
  });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await database?.drop();
});

const candidates = async () =>
  app.inject({ method: 'GET', url: `/api/projects/${projectId}/owner-candidates` });

/** The fixtures the owner command takes, as the route must list them: by name, then by id. */
const expectedItems = () =>
  FIXTURES.filter((fixture) => fixture.owns)
    .map((fixture) => ({
      user_id: idOf(fixture.key),
      name: users.get(fixture.key)?.name ?? '',
      writes_back: false,
    }))
    .sort((a, b) =>
      a.name === b.name ? (a.user_id < b.user_id ? -1 : 1) : a.name < b.name ? -1 : 1,
    );

describe('GET /api/projects/:id/owner-candidates over the real reads', () => {
  it('answers 401 with no session and 403 for a member', async () => {
    actor = undefined;
    const anonymous = await candidates();
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe('unauthenticated');
    // `max` is a member twice over (the organisation and the project); `bo1` a promoted viewer.
    for (const [key, role] of [
      ['max', 'member'],
      ['bo1', 'viewer'],
    ] as const) {
      actAs(key, role);
      const refused = await candidates();
      expect(refused.statusCode, key).toBe(403);
      expect(refused.json().error.code, key).toBe('forbidden');
    }
  });

  it('answers a maintainer with every member, leaving out a disabled user and the non-members', async () => {
    // `cy` is an organisation viewer the project makes a maintainer: the effective role decides.
    actAs('cy', 'viewer');
    const response = await candidates();
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { user_id: string; name: string }[] };
    expect(body).toEqual({ items: expectedItems() });
    const listed = new Set(body.items.map((item) => item.user_id));
    for (const key of ['dee', 'hal', 'eve', 'fay', 'gus'] as const) {
      expect(listed.has(idOf(key)), key).toBe(false);
    }
    // The two `bo`s, one name, ordered by id.
    const bos = body.items.filter((item) => item.name === 'bo').map((item) => item.user_id);
    expect(bos).toEqual([idOf('bo1'), idOf('bo2')].sort());
  });

  it('answers 404 for a project that does not exist', async () => {
    actAs('ivy', 'admin');
    const response = await app.inject({
      method: 'GET',
      url: '/api/projects/00000000-0000-4000-8000-00000000dead/owner-candidates',
    });
    expect(response.statusCode).toBe(404);
  });
});

/** One connection, one transaction, committed with what `work` answers. */
const within = async <T>(work: (tx: Transaction) => Promise<T>): Promise<T> => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  await client.query('begin');
  try {
    const answer = await work({ adapter: 'postgres', client } as unknown as Transaction);
    await client.query('commit');
    return answer;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
};

/** A committed live task of the project, nobody owning it. */
const committedTask = async (): Promise<Id> => {
  counter += 1;
  const taskId =
    `00000000-0000-4000-8000-${(0x26d000 + counter).toString(16).padStart(12, '0')}` as Id;
  const stored = {
    task: {
      id: taskId,
      projectId,
      ticket: {
        provider: 'jira-cloud',
        key: `CAND-${counter}`,
        url: `https://jira.example.test/browse/CAND-${counter}`,
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
    qaStage: false,
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
  await within((tx) => store.tasks.insert(tx, stored));
  return taskId;
};

describe('the list is what the owner command accepts', () => {
  it('names exactly the users a maintainer’s POST /api/tasks/:id/owner takes as the new owner', async () => {
    actAs('cy', 'viewer');
    const listed = new Set(
      ((await candidates()).json() as { items: { user_id: string }[] }).items.map(
        (item) => item.user_id,
      ),
    );
    const unitOfWork = new eventing.PostgresUnitOfWork({ pool });
    const accepted = new Set<string>();
    for (const fixture of FIXTURES) {
      // A fresh unowned task per target, so every attempt is the same question: may this person
      // become the owner?
      const taskId = await committedTask();
      try {
        const result = await setTaskOwnerCommand(
          {
            unitOfWork,
            store,
            ids: {
              next: (): Id => {
                counter += 1;
                return `00000000-0000-4000-8000-${(0x26e000 + counter).toString(16).padStart(12, '0')}` as Id;
              },
            },
            clock: { now: () => NOW },
          },
          {
            taskId,
            actorUserId: idOf('cy'),
            actorRole: 'maintainer',
            targetUserId: idOf(fixture.key),
          },
        );
        expect(result, fixture.key).toEqual({ changed: true, ownerUserId: idOf(fixture.key) });
        accepted.add(idOf(fixture.key));
      } catch (error) {
        // The only refusal a maintainer can meet on a live task is the target's.
        expect(error, fixture.key).toBeInstanceOf(OwnerChangeRefusedError);
        expect((error as OwnerChangeRefusedError).reason, fixture.key).toBe(
          'owner_not_project_member',
        );
      }
    }
    expect([...accepted].sort()).toEqual([...listed].sort());
    // Calibrated: both sides are neither everyone nor no one.
    expect(accepted.size).toBe(FIXTURES.filter((fixture) => fixture.owns).length);
    expect(accepted.size).toBeLessThan(FIXTURES.length);
  });
});
