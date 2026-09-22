/**
 * `GET /api/artifacts/:artifact_id` and its **three endings**, driven through the real router
 * against plain functions (WP-52 round 4).
 *
 * ## Why this file exists, which is the interesting part
 *
 * The 409 `artifact_not_redacted` refusal is the only thing standing between a body written before
 * migration 0038 — when nothing redacted an artifact (PROGRESS backlog 35, measured) — and
 * `artifact.read`, which is `viewer`. Round 3 asserted it in the **e2e** tier, which was the only
 * place the *route's status* could be seen: no integration test builds the real router, and
 * `routes/tasks.ts` took a `Database` rather than injected queries.
 *
 * That assertion then failed **one full-tier run in two** on the orchestrator's machine at a
 * one-minute load of 9.45, reporting `expected 200 to be 409` with an **empty** response body — a
 * combination this route's code cannot produce, since both endings either throw or return a defined
 * object. It did not reproduce here: three runs of the file alone and two full-tier passes, green,
 * at loads 3.2 to 9. So the mechanism was **not established**, and none is claimed (standing rule 86
 * — a prediction written into the tree becomes an observation; standing rule 76 — a flake's *rate*
 * can be the only random thing about it).
 *
 * What *is* established is that the assertion does not belong there. A refusal this load-bearing has
 * to be assertable in a tier that runs it often and deterministically, so `registerTaskRoutes` gained
 * the injected-query seam `asks.ts`, `breakdown.ts` and `commands.ts` already use, and the three
 * endings are asserted here: the real router, the real guards, the real response schemas and the
 * real error handler, with no database, no container and no network. The e2e keeps the half only it
 * can state — a body the pipeline really produced, served without the run's credential.
 *
 * **What this tier cannot see**, stated rather than implied: whether `findArtifactBody` reads the
 * column correctly. That is `test/integration/server/read-api.integration.test.ts`, which drives the
 * real SQL and produces the `null` the only honest way. Neither half alone is enough — the
 * integration half is blind to a route that ignores the verdict, and this half is blind to a query
 * that reports the wrong one.
 */
import type { UserRole } from '@platform/contracts';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import type { ArtifactBody } from '../queries/pipeline-queries.js';
import { registerTaskRoutes, type TaskQueries } from './tasks.js';

const ARTIFACT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const PROJECT = '00000000-0000-4000-8000-0000000000c1';
const USER = '00000000-0000-4000-8000-0000000000d1';

interface World {
  body: ArtifactBody;
  role: UserRole | null;
  signedIn: boolean;
  /** Every artifact id the route asked about — so "it read the row" is assertable. */
  readonly asked: string[];
  /** Every artifact id the **scope** resolved a project for. */
  readonly scopedFor: string[];
  /** Every `(projectId, userId)` the permission guard was asked about. */
  readonly guardedFor: { projectId: string; userId: string }[];
  /** Every task id the *task* scope resolved — empty unless a route was wired to the wrong one. */
  readonly taskScopedFor: string[];
}

const build = async (): Promise<{ app: FastifyInstance; world: World }> => {
  const world: World = {
    body: { found: false },
    role: 'viewer',
    signedIn: true,
    asked: [],
    scopedFor: [],
    guardedFor: [],
    taskScopedFor: [],
  };

  const app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(async (error, _request, reply) => {
    const mapped = toApiError(error, 'test-request');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  app.addHook('onRequest', async (request) => {
    if (world.signedIn) {
      request.actor = {
        userId: USER,
        email: 'operator@example.test',
        name: 'Operator',
        role: 'member',
        sessionId: 'session-1',
      };
    }
  });

  const queries: TaskQueries = {
    taskDetail: async () => null,
    taskProjectId: async (taskId) => {
      world.taskScopedFor.push(taskId);
      return PROJECT;
    },
    projectRole: async (projectId, userId) => {
      world.guardedFor.push({ projectId, userId });
      return world.role;
    },
    artifactProjectId: async (artifactId) => {
      world.scopedFor.push(artifactId);
      return PROJECT;
    },
    artifactBody: async (artifactId) => {
      world.asked.push(artifactId);
      return world.body;
    },
  };
  await registerTaskRoutes(app, { queries });
  await app.ready();
  return { app, world };
};

const redactedBody = (redactionCount: number): ArtifactBody => ({
  found: true,
  redacted: true,
  body: {
    id: ARTIFACT,
    task_id: TASK,
    artifact_type: 'RefinedSpec',
    version: 1,
    schema_version: '1',
    produced_by_run_id: null,
    created_at: '2026-09-01T09:00:00.000Z',
    redaction_count: redactionCount,
    markdown: null,
    data: { goal: 'ship the footer' },
  },
});

describe('GET /api/artifacts/:artifact_id', () => {
  let app: FastifyInstance;
  let world: World;

  beforeEach(async () => {
    ({ app, world } = await build());
  });

  it('serves a row the platform redacted at the write', async () => {
    world.body = redactedBody(2);
    const reply = await app.inject({ method: 'GET', url: `/api/artifacts/${ARTIFACT}` });
    expect(reply.statusCode, reply.body).toBe(200);
    const body = reply.json() as { redaction_count: number; data: { goal: string } };
    expect(body.redaction_count).toBe(2);
    expect(body.data.goal).toBe('ship the footer');
    // The route read the row it was asked about, rather than answering from the path.
    expect(world.asked).toEqual([ARTIFACT]);
  });

  it('serves a row whose redactor ran and replaced nothing, which is not the same as null', async () => {
    // Standing rule 18, at the route: `0` is a measurement and `null` is an absence, and only one
    // of them is refused. Without this case the refusal below could be "any falsy count".
    world.body = redactedBody(0);
    const reply = await app.inject({ method: 'GET', url: `/api/artifacts/${ARTIFACT}` });
    expect(reply.statusCode, reply.body).toBe(200);
    expect((reply.json() as { redaction_count: number }).redaction_count).toBe(0);
  });

  /**
   * **The branch this route rests on.** A reviewer's canary that made the query serve such a row
   * instead of refusing it left the whole cheap tier green before this file existed.
   */
  it('refuses a row written before anything redacted it, by name and with no document', async () => {
    world.body = { found: true, redacted: false, createdAt: '2026-08-01T09:00:00.000Z' };
    const reply = await app.inject({ method: 'GET', url: `/api/artifacts/${ARTIFACT}` });
    expect(reply.statusCode, reply.body).toBe(409);
    const body = reply.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('artifact_not_redacted');
    // The message names *why*, and carries the instant rather than the document.
    expect(body.error.message).toContain('before migration 0038');
    expect(body.error.message).toContain('2026-08-01');
    expect(reply.body).not.toContain('ship the footer');
  });

  it('answers 404 for an artifact that does not exist, which is a third fact', async () => {
    world.body = { found: false };
    const reply = await app.inject({ method: 'GET', url: `/api/artifacts/${ARTIFACT}` });
    expect(reply.statusCode, reply.body).toBe(404);
  });

  it('refuses an anonymous caller before it reads anything', async () => {
    world.signedIn = false;
    world.body = redactedBody(1);
    const reply = await app.inject({ method: 'GET', url: `/api/artifacts/${ARTIFACT}` });
    expect(reply.statusCode).toBe(401);
    // Both directions: the guard ran *before* the read, so a refused caller leaves no trace of the
    // row it asked about (standing rule 42).
    expect(world.asked).toEqual([]);
  });

  /**
   * **"Permissioned like its task", asserted as the thing it actually is.**
   *
   * The first version of this case expected a 403 for a caller with no project role and was wrong
   * about the mechanism: membership **promotes and never demotes** (`auth/rbac.ts`), so a null
   * project role falls back to the organisation role — and `artifact.read` is `viewer`, the floor,
   * which every signed-in caller already has. So a 403 on this route is **unreachable for a
   * signed-in user**, and writing a case that faked one would have pinned a fiction.
   *
   * What is real, and what the criterion's wording means, is *which project is consulted*: the
   * scope resolves it from the **artifact's own row**, never from the request, so a caller cannot
   * name a project they do have a role on and read another's artifact through it.
   */
  it('scopes by the artifact’s own project, and asks the guard about that project', async () => {
    world.body = redactedBody(1);
    const reply = await app.inject({ method: 'GET', url: `/api/artifacts/${ARTIFACT}` });
    expect(reply.statusCode, reply.body).toBe(200);
    expect(world.scopedFor).toEqual([ARTIFACT]);
    expect(world.guardedFor).toEqual([{ projectId: PROJECT, userId: USER }]);
    // …and the task route's own resolver was not the one consulted, which is what would happen if
    // the artifact route had been registered under the task scope by mistake.
    expect(world.taskScopedFor).toEqual([]);
  });

  it('rejects an id that is not a uuid without reading anything', async () => {
    const reply = await app.inject({ method: 'GET', url: '/api/artifacts/not-a-uuid' });
    expect(reply.statusCode).toBe(400);
    expect(world.asked).toEqual([]);
  });
});
