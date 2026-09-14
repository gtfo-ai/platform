/**
 * The three shadow-mode routes, driven end to end through Fastify against **plain functions**
 * (WP-34, WP-15i's shape).
 *
 * The e2e tier drives the same command against a real instance and asserts the rows a batch leaves
 * behind. What it cannot do is drive it often, so the decisions this file owns are held here: the
 * `Idempotency-Key` policy, the replay refusal, which capability each route asks for, which
 * application refusal maps to which status, and what lands in the `human_actions` row.
 *
 * **What this tier cannot see**, stated rather than implied: whether a batch's *tasks* exist. The
 * command is a stub, so "two tasks were created" is the e2e's assertion and "the route called
 * `startBatch` once with these keys, and wrote one audit row" is this file's.
 */
import type { JsonObject, UserRole } from '@platform/contracts';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import { OnboardingUnavailableError } from '../onboarding.js';
import type { ShadowCommands } from '../shadow.js';
import { registerShadowRoutes, SHADOW_START_ACTION } from './shadow.js';

const PROJECT = '00000000-0000-4000-8000-000000000a01';
/** The project the batch belongs to — deliberately **not** {@link PROJECT}. */
const BATCH_PROJECT = '00000000-0000-4000-8000-000000000a05';
const BATCH = '00000000-0000-4000-8000-000000000a02';
const TASK = '00000000-0000-4000-8000-000000000a03';
const USER = '00000000-0000-4000-8000-000000000a04';

interface World {
  role: UserRole | null;
  signedIn: boolean;
  projectExists: boolean;
  result: Awaited<ReturnType<ShadowCommands['startBatch']>> | null;
  throws: Error | null;
  gate: { canStart: boolean; blockedReason: string | null } | null;
  batchFound: boolean;
  commands: ShadowCommands | null;
}

const started = () =>
  ({
    status: 'started' as const,
    batchId: BATCH as never,
    tickets: [
      { ticketKey: 'ACME-1', taskId: TASK as never, refusedReason: null },
      { ticketKey: 'ACME-2', taskId: null, refusedReason: 'no merge base' },
    ],
  }) satisfies Awaited<ReturnType<ShadowCommands['startBatch']>>;

const emptyBatch = {
  batch: {
    id: BATCH,
    project_id: PROJECT,
    created_at: '2026-09-14T10:00:00.000Z',
    completed_at: null,
    budget_usd: null,
    spent_usd: 0,
    tickets: 0,
    refused: 0,
  },
  tickets: [],
  aggregate: {
    cost_by_size: [],
    similarity_distribution: [],
    launch_candidates: [],
    reported: 0,
    compared: 0,
  },
};

let app: FastifyInstance;
let world: World;
let calls: { name: string; input: unknown }[];
let actions: { userId: string; action: string; params: JsonObject }[];
let attempts: Map<string, string | null>;
let roleCalls: { projectId: string; userId: string }[];

const build = async (): Promise<void> => {
  calls = [];
  actions = [];
  attempts = new Map();
  roleCalls = [];
  world = {
    role: 'maintainer',
    signedIn: true,
    projectExists: true,
    result: null,
    throws: null,
    gate: { canStart: true, blockedReason: null },
    batchFound: true,
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
    startBatch: async (input) => {
      calls.push({ name: 'startBatch', input });
      if (world.throws !== null) {
        const thrown = world.throws;
        world.throws = null;
        throw thrown;
      }
      return world.result ?? started();
    },
  };

  await registerShadowRoutes(app, {
    shadow: world.commands,
    gate: async () => world.gate as NonNullable<World['gate']>,
    queries: {
      projectRole: async (projectId, userId) => {
        roleCalls.push({ projectId, userId });
        return world.role;
      },
      projectExists: async () => world.projectExists,
      // The batch's project is a column, not a path segment: `scopeToProject` reads it and the
      // guard scopes by what it left behind.
      projectOfBatch: async () => (world.batchFound ? BATCH_PROJECT : null),
      previousAttempt: async (query) => {
        const digest = attempts.get(`${query.userId}|${query.action}|${query.key}`);
        return digest === undefined ? null : { bodyDigest: digest };
      },
      recordAction: async (input) => {
        actions.push({ userId: input.userId, action: input.action, params: input.params });
        const key = input.params.idempotency_key;
        const digest = input.params.body_digest;
        if (typeof key === 'string') {
          attempts.set(
            `${input.userId}|${input.action}|${key}`,
            typeof digest === 'string' ? digest : null,
          );
        }
      },
      // The published envelope exactly: the response schema is strict, so an extra key here would
      // be a 500 rather than a dropped field (which is the point of `verify`'s strictness rule).
      listBatches: async (_projectId, gate) => ({
        items: [],
        can_start: gate.canStart,
        blocked_reason: gate.blockedReason,
      }),
      findBatch: async () =>
        world.batchFound
          ? ({ found: true, response: emptyBatch } as never)
          : ({ found: false } as never),
    },
  });
  await app.ready();
};

beforeEach(build);

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT}/shadow-batches`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });

const errorCode = (raw: string): string =>
  (JSON.parse(raw) as { error?: { code?: string } }).error?.code ?? '';

describe('POST /api/projects/:project_id/shadow-batches', () => {
  it('creates a batch and records exactly one human action', async () => {
    const response = await post(
      { ticket_keys: ['ACME-1', 'ACME-2'] },
      { 'idempotency-key': 'batch-1' },
    );
    expect(response.statusCode).toBe(202);
    const body = JSON.parse(response.body) as { started: number; refused: number };
    expect(body.started).toBe(1);
    expect(body.refused).toBe(1);
    expect(calls).toEqual([
      {
        name: 'startBatch',
        input: { projectId: PROJECT, ticketKeys: ['ACME-1', 'ACME-2'], userId: USER },
      },
    ]);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe(SHADOW_START_ACTION);
    expect(actions[0]?.params).toMatchObject({ project_id: PROJECT, batch_id: BATCH, started: 1 });
  });

  it('requires an Idempotency-Key, because a repeat would create a second batch of N tasks', async () => {
    const response = await post({ ticket_keys: ['ACME-1'] });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response.body)).toBe('idempotency_key_required');
    expect(calls).toEqual([]);
  });

  it('refuses a different body under a used key, and performs nothing', async () => {
    await post({ ticket_keys: ['ACME-1'] }, { 'idempotency-key': 'batch-1' });
    const second = await post({ ticket_keys: ['ACME-2'] }, { 'idempotency-key': 'batch-1' });
    expect(second.statusCode).toBe(409);
    expect(errorCode(second.body)).toBe('idempotency_key_reused');
    // The countable effect: one call to the command and one audit row, not two.
    expect(calls).toHaveLength(1);
    expect(actions).toHaveLength(1);
  });

  it('accepts a replay of the same body under the same key', async () => {
    await post({ ticket_keys: ['ACME-1'] }, { 'idempotency-key': 'batch-1' });
    const replay = await post({ ticket_keys: ['ACME-1'] }, { 'idempotency-key': 'batch-1' });
    expect(replay.statusCode).toBe(202);
  });

  it('refuses an anonymous caller before validating the body', async () => {
    world.signedIn = false;
    // No body at all: a guard that ran at `preHandler` would answer 400 here.
    const response = await app.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/shadow-batches`,
    });
    expect(`${response.statusCode} ${errorCode(response.body)}`).toBe('401 unauthenticated');
  });

  it('refuses a member: starting a batch is a maintainer’s decision', async () => {
    world.role = 'member';
    const response = await post({ ticket_keys: ['ACME-1'] }, { 'idempotency-key': 'batch-1' });
    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('refuses an unknown project with 404 rather than starting anything', async () => {
    world.projectExists = false;
    const response = await post({ ticket_keys: ['ACME-1'] }, { 'idempotency-key': 'batch-1' });
    expect(response.statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  it('turns a blocked project into a 409 naming which gate refused', async () => {
    world.result = {
      status: 'blocked',
      blocker: 'shadow_not_allowed',
      detail: 'the dial does not allow it',
    };
    const response = await post({ ticket_keys: ['ACME-1'] }, { 'idempotency-key': 'batch-1' });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response.body)).toBe('shadow_shadow_not_allowed');
    // A refused command writes no `human_actions` row: the log is of what happened.
    expect(actions).toEqual([]);
  });

  it('turns a process with no queue into a 503 by name', async () => {
    world.throws = new OnboardingUnavailableError('no workers here');
    const response = await post({ ticket_keys: ['ACME-1'] }, { 'idempotency-key': 'batch-1' });
    expect(response.statusCode).toBe(503);
    expect(errorCode(response.body)).toBe('shadow_unavailable');
  });

  it('refuses an empty list and a list past the cap', async () => {
    const empty = await post({ ticket_keys: [] }, { 'idempotency-key': 'a' });
    expect(empty.statusCode).toBe(400);
    const tooMany = await post(
      { ticket_keys: Array.from({ length: 26 }, (_, index) => `ACME-${index}`) },
      { 'idempotency-key': 'b' },
    );
    expect(tooMany.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it('refuses an unknown key in the body, because request bodies are strict', async () => {
    const response = await post(
      { ticket_keys: ['ACME-1'], budget_usd: 99 },
      { 'idempotency-key': 'batch-1' },
    );
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/projects/:project_id/shadow-batches', () => {
  it('publishes the gate, so the screen states the reason rather than offering a button', async () => {
    world.gate = { canStart: false, blockedReason: 'shadow mode is off for this project' };
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT}/shadow-batches`,
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      can_start: false,
      blocked_reason: 'shadow mode is off for this project',
    });
  });

  it('is readable by a viewer — it is a read, not the command', async () => {
    world.role = 'viewer';
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT}/shadow-batches`,
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses an anonymous caller', async () => {
    world.signedIn = false;
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT}/shadow-batches`,
    });
    expect(`${response.statusCode} ${errorCode(response.body)}`).toBe('401 unauthenticated');
  });
});

describe('GET /api/shadow-batches/:batch_id', () => {
  it('answers the batch, its tickets and its aggregate', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/shadow-batches/${BATCH}` });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ batch: { id: BATCH } });
  });

  it('answers 404 for a batch nobody has, from the resolver and before the read', async () => {
    world.batchFound = false;
    const response = await app.inject({ method: 'GET', url: `/api/shadow-batches/${BATCH}` });
    expect(response.statusCode).toBe(404);
    // `scopeToProject` refuses first, so no permission was decided for a row that does not exist.
    expect(roleCalls).toEqual([]);
  });

  it('decides the permission against the batch’s own project, not the caller’s organisation', async () => {
    // Round 1 asked `project.read` at the organisation minimum and cited `GET /api/runs/:id` as the
    // same position, which runs have not been in since WP-15h. Without the resolver a membership in
    // the batch's project could not promote the caller, and nothing named which project was read.
    const response = await app.inject({ method: 'GET', url: `/api/shadow-batches/${BATCH}` });
    expect(response.statusCode).toBe(200);
    expect(roleCalls).toEqual([{ projectId: BATCH_PROJECT, userId: USER }]);
  });

  it('refuses an anonymous caller', async () => {
    world.signedIn = false;
    const response = await app.inject({ method: 'GET', url: `/api/shadow-batches/${BATCH}` });
    expect(`${response.statusCode} ${errorCode(response.body)}`).toBe('401 unauthenticated');
  });
});

describe('a process that composed no pipeline', () => {
  /** The same routes, with both optional collaborators absent (`ROLE=api` without workers). */
  const bare = async (): Promise<FastifyInstance> => {
    const instance = fastify();
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    instance.setErrorHandler(async (error, _request, reply) => {
      const mapped = toApiError(error, 'test-request');
      return reply.status(mapped.statusCode).send(mapped.body);
    });
    instance.addHook('onRequest', async (request) => {
      request.actor = {
        userId: USER,
        email: 'operator@example.test',
        name: 'Operator',
        role: 'admin',
        sessionId: 'session-1',
      };
    });
    await registerShadowRoutes(instance, {
      shadow: null,
      gate: null,
      queries: {
        projectRole: async () => 'maintainer',
        projectExists: async () => true,
        previousAttempt: async () => null,
        recordAction: async () => {},
        projectOfBatch: async () => null,
        listBatches: async (_projectId, gate) => ({
          items: [],
          can_start: gate.canStart,
          blocked_reason: gate.blockedReason,
        }),
        findBatch: async () => ({ found: false }) as never,
      },
    });
    await instance.ready();
    return instance;
  };

  it('answers 503 by name for the command', async () => {
    const instance = await bare();
    const response = await instance.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/shadow-batches`,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'batch-1' },
      payload: JSON.stringify({ ticket_keys: ['ACME-1'] }),
    });
    expect(`${response.statusCode} ${errorCode(response.body)}`).toBe('503 shadow_unavailable');
    await instance.close();
  });

  it('says why a batch cannot be started rather than guessing that one can', async () => {
    // Fail-closed: a screen that offered the button would send the caller into the 503 above.
    const instance = await bare();
    const response = await instance.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT}/shadow-batches`,
    });
    const body = JSON.parse(response.body) as { can_start: boolean; blocked_reason: string };
    expect(body.can_start).toBe(false);
    expect(body.blocked_reason).toContain('cannot read the project’s settings');
    await instance.close();
  });
});
