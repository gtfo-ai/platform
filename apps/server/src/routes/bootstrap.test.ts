/**
 * The two history-bootstrap routes, driven end to end through Fastify against **plain functions**
 * (WP-35, WP-15i's shape).
 *
 * The e2e tier drives the same command against a real instance and asserts the rows a bootstrap
 * leaves behind. What it cannot do is drive it often, so the decisions this file owns are held
 * here: the `Idempotency-Key` policy, the replay refusal, which capability each route asks for,
 * which application refusal maps to which status, and what lands in the `human_actions` row.
 *
 * **What this tier cannot see**, stated rather than implied: whether a bootstrap's *tasks* exist or
 * whether anything was mined. The command is a stub, so "ten mining runs happened" is the e2e's
 * assertion and "the route called `start` once with this N, and wrote one audit row" is this file's.
 */
import type { JsonObject, UserRole } from '@platform/contracts';
import { MAX_BOOTSTRAP_MERGE_REQUESTS } from '@platform/contracts';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import type { HistoryBootstrapCommands } from '../bootstrap.js';
import { toApiError } from '../errors.js';
import { OnboardingUnavailableError } from '../onboarding.js';
import { BOOTSTRAP_START_ACTION, registerBootstrapRoutes } from './bootstrap.js';

const PROJECT = '00000000-0000-4000-8000-000000000b01';
const BATCH = '00000000-0000-4000-8000-000000000b02';
const USER = '00000000-0000-4000-8000-000000000b03';

const ESTIMATE = {
  mergeRequests: 200,
  batchSize: 20,
  batches: 10,
  estimatedUsd: 20,
  capUsd: 20,
  stopsAtCap: false,
  days: 183,
};

interface World {
  role: UserRole | null;
  signedIn: boolean;
  projectExists: boolean;
  result: Awaited<ReturnType<HistoryBootstrapCommands['start']>> | null;
  throws: Error | null;
  commands: HistoryBootstrapCommands | null;
}

let app: FastifyInstance;
let world: World;
let calls: { name: string; input: unknown }[];
let actions: { userId: string; action: string; params: JsonObject }[];
/** The `human_actions` rows the fake recorder wrote, keyed `user|action|key` — the lookup's scope. */
let attempts: Map<string, { bodyDigest: string | null; params: JsonObject }>;
let listed: (number | null)[];

const build = async (): Promise<void> => {
  calls = [];
  actions = [];
  attempts = new Map();
  listed = [];
  world = {
    role: 'maintainer',
    signedIn: true,
    projectExists: true,
    result: null,
    throws: null,
    commands: null,
  };

  app = fastify();
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
        role: world.role ?? 'admin',
        sessionId: 'session-1',
      };
    }
  });

  world.commands = {
    start: async (input) => {
      calls.push({ name: 'start', input });
      if (world.throws !== null) {
        const thrown = world.throws;
        world.throws = null;
        throw thrown;
      }
      return (
        world.result ?? { status: 'started' as const, batchId: BATCH as never, estimate: ESTIMATE }
      );
    },
  };

  await registerBootstrapRoutes(app, {
    bootstrap: world.commands,
    queries: {
      projectRole: async () => world.role,
      projectExists: async () => world.projectExists,
      previousAttempt: async (query) =>
        attempts.get(`${query.userId}|${query.action}|${query.key}`) ?? null,
      recordAction: async (input) => {
        actions.push({ userId: input.userId, action: input.action, params: input.params });
        const key = input.params.idempotency_key;
        const digest = input.params.body_digest;
        if (typeof key === 'string') {
          attempts.set(`${input.userId}|${input.action}|${key}`, {
            bodyDigest: typeof digest === 'string' ? digest : null,
            params: input.params,
          });
        }
      },
      // The published envelope exactly: the response schema is strict, so an extra key here would
      // be a 500 rather than a dropped field.
      listBootstraps: async (_projectId, mergeRequests) => {
        listed.push(mergeRequests);
        return {
          items: [],
          can_start: true,
          blocked_reason: null,
          estimate: {
            merge_requests: mergeRequests ?? ESTIMATE.mergeRequests,
            batch_size: ESTIMATE.batchSize,
            batches: ESTIMATE.batches,
            estimated_usd: ESTIMATE.estimatedUsd,
            cap_usd: ESTIMATE.capUsd,
            stops_at_cap: ESTIMATE.stopsAtCap,
            days: ESTIMATE.days,
          },
          max_merge_requests: MAX_BOOTSTRAP_MERGE_REQUESTS,
        };
      },
    },
  });
  await app.ready();
};

beforeEach(build);

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT}/history-bootstraps`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });

const errorCode = (raw: string): string =>
  (JSON.parse(raw) as { error?: { code?: string } }).error?.code ?? '';

describe('POST /api/projects/:project_id/history-bootstraps', () => {
  it('starts a bootstrap and records exactly one human action carrying the estimate', async () => {
    const response = await post({ merge_requests: 40 }, { 'idempotency-key': 'boot-1' });
    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.body) as { batch_id: string; estimate: { batches: number } };
    expect(body.batch_id).toBe(BATCH);
    expect(body.estimate.batches).toBe(10);
    expect(calls).toEqual([
      { name: 'start', input: { projectId: PROJECT, mergeRequests: 40, userId: USER } },
    ]);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe(BOOTSTRAP_START_ACTION);
    // What an operator was told it would cost, in the audit row — so a spend nobody expected can be
    // traced to the figure they were shown.
    expect(actions[0]?.params).toMatchObject({
      project_id: PROJECT,
      batch_id: BATCH,
      estimated_usd: 20,
      cap_usd: 20,
    });
  });

  it('passes a body with no N through as null, so the project’s own default applies', async () => {
    await post({}, { 'idempotency-key': 'boot-1' });
    expect(calls[0]?.input).toMatchObject({ mergeRequests: null });
  });

  it('requires an Idempotency-Key, because a repeat would mine the same history twice', async () => {
    const response = await post({ merge_requests: 40 });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response.body)).toBe('idempotency_key_required');
    expect(calls).toEqual([]);
  });

  it('refuses a different body under a used key, and performs nothing', async () => {
    await post({ merge_requests: 40 }, { 'idempotency-key': 'boot-1' });
    const second = await post({ merge_requests: 80 }, { 'idempotency-key': 'boot-1' });
    expect(second.statusCode).toBe(409);
    expect(errorCode(second.body)).toBe('idempotency_key_reused');
    expect(calls).toHaveLength(1);
    expect(actions).toHaveLength(1);
  });

  it('answers a replay from the recorded attempt, and mines nothing a second time', async () => {
    const first = await post({ merge_requests: 40 }, { 'idempotency-key': 'boot-1' });
    const replay = await post({ merge_requests: 40 }, { 'idempotency-key': 'boot-1' });
    expect(replay.statusCode).toBe(202);
    // The same answer, read back from the row rather than recomputed — the batch the caller
    // already has, with the estimate they were already shown.
    expect(JSON.parse(replay.body)).toEqual(JSON.parse(first.body));
    // The countable effects, which is what "performs nothing twice" means (standing rule 79): one
    // call to the command, one audit row. `already_running` would not have covered this — it is
    // live-only, and a completed batch would have let the second $20 mining through.
    expect(calls).toHaveLength(1);
    expect(actions).toHaveLength(1);
  });

  it('refuses a replay whose recorded attempt predates the estimate, rather than inventing one', async () => {
    // A `human_actions` row written by a build that recorded only part of the estimate. Answering
    // it would publish numbers this process cannot know; the command was performed, so it cannot
    // be re-run either. Naming it is the only honest answer (`routes/commands.ts`' rule).
    await post({ merge_requests: 40 }, { 'idempotency-key': 'boot-old' });
    const recorded = attempts.get(`${USER}|${BOOTSTRAP_START_ACTION}|boot-old`);
    const { batch_size: _dropped, ...withoutBatchSize } = recorded?.params ?? {};
    attempts.set(`${USER}|${BOOTSTRAP_START_ACTION}|boot-old`, {
      bodyDigest: recorded?.bodyDigest ?? null,
      params: withoutBatchSize,
    });

    const replay = await post({ merge_requests: 40 }, { 'idempotency-key': 'boot-old' });
    expect(replay.statusCode).toBe(409);
    expect(errorCode(replay.body)).toBe('idempotency_key_reused');
    expect(calls).toHaveLength(1);
    expect(actions).toHaveLength(1);
  });

  it('refuses an anonymous caller before validating the body', async () => {
    world.signedIn = false;
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/history-bootstraps`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(response.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it('refuses a member: mining spends money and writes knowledge proposals', async () => {
    world.role = 'member';
    const response = await post({ merge_requests: 40 }, { 'idempotency-key': 'boot-1' });
    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('answers 404 for a project that does not exist, before calling the command', async () => {
    world.projectExists = false;
    const response = await post({ merge_requests: 40 }, { 'idempotency-key': 'boot-1' });
    expect(response.statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  it('accepts N at the documented maximum and refuses one past it at the boundary', async () => {
    const atMax = await post(
      { merge_requests: MAX_BOOTSTRAP_MERGE_REQUESTS },
      { 'idempotency-key': 'boot-max' },
    );
    expect(atMax.statusCode).toBe(202);

    const past = await post(
      { merge_requests: MAX_BOOTSTRAP_MERGE_REQUESTS + 1 },
      { 'idempotency-key': 'boot-past' },
    );
    expect(past.statusCode).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('maps each application refusal to a 409 naming it', async () => {
    for (const blocker of ['feature_disabled', 'no_git_binding', 'already_running'] as const) {
      world.result = { status: 'blocked', blocker, detail: `because ${blocker}` };
      const response = await post({ merge_requests: 40 }, { 'idempotency-key': `key-${blocker}` });
      expect(response.statusCode).toBe(409);
      expect(errorCode(response.body)).toBe(`bootstrap_${blocker}`);
    }
    // …and a refused command writes **no** audit row: `human_actions` records what happened.
    expect(actions).toEqual([]);
  });

  it('answers 503 when this process composed no commands, rather than 404', async () => {
    // A second instance rather than a second registration on the same one: the path exists and this
    // process cannot serve it, which is `routes/shadow.ts`'s and `routes/kb.ts`'s answer.
    const bare = fastify();
    bare.setValidatorCompiler(validatorCompiler);
    bare.setSerializerCompiler(serializerCompiler);
    bare.setErrorHandler(async (error, _request, reply) => {
      const mapped = toApiError(error, 'test-request');
      return reply.status(mapped.statusCode).send(mapped.body);
    });
    bare.addHook('onRequest', async (request) => {
      request.actor = {
        userId: USER,
        email: 'operator@example.test',
        name: 'Operator',
        role: 'maintainer',
        sessionId: 'session-1',
      };
    });
    await registerBootstrapRoutes(bare, {
      bootstrap: null,
      queries: {
        projectRole: async () => 'maintainer',
        projectExists: async () => true,
        previousAttempt: async () => null,
        recordAction: async () => {},
        listBootstraps: async () => ({
          items: [],
          can_start: false,
          blocked_reason: 'this process cannot read the project’s settings',
          estimate: {
            merge_requests: 1,
            batch_size: 20,
            batches: 1,
            estimated_usd: 2,
            cap_usd: 20,
            stops_at_cap: false,
            days: 183,
          },
          max_merge_requests: MAX_BOOTSTRAP_MERGE_REQUESTS,
        }),
      },
    });
    await bare.ready();
    const response = await bare.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/history-bootstraps`,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'boot-1' },
      payload: JSON.stringify({ merge_requests: 40 }),
    });
    expect(response.statusCode).toBe(503);
    expect(errorCode(response.body)).toBe('bootstrap_unavailable');
    // …and the **read** still answers, with the gate saying why nothing may start.
    const read = await bare.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT}/history-bootstraps`,
    });
    expect(read.statusCode).toBe(200);
    expect((JSON.parse(read.body) as { can_start: boolean }).can_start).toBe(false);
    await bare.close();
  });

  it('answers 503 when the command itself says the process runs no workers', async () => {
    world.throws = new OnboardingUnavailableError('this process runs no job workers');
    const response = await post({ merge_requests: 40 }, { 'idempotency-key': 'boot-1' });
    expect(response.statusCode).toBe(503);
    expect(errorCode(response.body)).toBe('bootstrap_unavailable');
  });
});

describe('GET /api/projects/:project_id/history-bootstraps', () => {
  const get = (query = '') =>
    app.inject({ method: 'GET', url: `/api/projects/${PROJECT}/history-bootstraps${query}` });

  it('publishes the gate and the estimate, so the screen states the reason rather than guessing', async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      can_start: boolean;
      estimate: { merge_requests: number };
      max_merge_requests: number;
    };
    expect(body.can_start).toBe(true);
    expect(body.estimate.merge_requests).toBe(200);
    expect(body.max_merge_requests).toBe(MAX_BOOTSTRAP_MERGE_REQUESTS);
    // No N in the query is `null`, which the projection turns into the project's own.
    expect(listed).toEqual([null]);
  });

  it('asks the server for the estimate of the N in the query', async () => {
    const response = await get('?merge_requests=40');
    expect(response.statusCode).toBe(200);
    expect(listed).toEqual([40]);
    expect(
      (JSON.parse(response.body) as { estimate: { merge_requests: number } }).estimate
        .merge_requests,
    ).toBe(40);
  });

  it('refuses an N past the maximum in the query too', async () => {
    const response = await get(`?merge_requests=${MAX_BOOTSTRAP_MERGE_REQUESTS + 1}`);
    expect(response.statusCode).toBe(400);
    expect(listed).toEqual([]);
  });

  it('refuses an anonymous caller', async () => {
    world.signedIn = false;
    expect((await get()).statusCode).toBe(401);
  });

  it('answers 404 for a project that does not exist', async () => {
    world.projectExists = false;
    expect((await get()).statusCode).toBe(404);
    expect(listed).toEqual([]);
  });

  it('lets a viewer read, because reading a batch is a project read', async () => {
    world.role = 'viewer';
    expect((await get()).statusCode).toBe(200);
  });
});
