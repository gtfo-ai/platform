/**
 * The re-evaluate pair, driven through Fastify against plain functions (WP-94, Q107 (a)).
 *
 * The e2e tier drives the command against a real instance and asserts the run, the ledger row and
 * the level. What this file owns is what the route decides: the capability each method asks for
 * (a member is refused 403 — criterion 2), the `Idempotency-Key` policy, which application answer
 * maps to which status, and what lands in the one `human_actions` row.
 */
import type { JsonObject, UserRole } from '@platform/contracts';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import type { OnboardingCommands } from '../onboarding.js';
import { memoryAttemptRecords } from './idempotency-memory.js';
import {
  REDISCOVERY_START_ACTION,
  type RediscoveryGateReader,
  registerRediscoveryRoutes,
} from './rediscovery.js';

const PROJECT = '00000000-0000-4000-8000-000000000d01';
const TASK = '00000000-0000-4000-8000-000000000d02';
const USER = '00000000-0000-4000-8000-000000000d03';

type StartResult = Awaited<ReturnType<OnboardingCommands['startRediscovery']>>;

interface World {
  role: UserRole | null;
  signedIn: boolean;
  projectExists: boolean;
  result: StartResult;
  gate: Awaited<ReturnType<RediscoveryGateReader>>;
}

let app: FastifyInstance;
let world: World;
let calls: unknown[];
let actions: { action: string; params: JsonObject; taskId?: string | null }[];
let attempts: Map<string, { bodyDigest: string | null; params: JsonObject }>;

const build = async (): Promise<void> => {
  calls = [];
  actions = [];
  attempts = new Map();
  world = {
    role: 'maintainer',
    signedIn: true,
    projectExists: true,
    result: { status: 'started', taskId: TASK as never, ceilingUsd: 2, detail: 'queued again' },
    gate: {
      ceilingUsd: 2,
      lastDiscovery: { taskId: TASK, state: 'done', costUsd: 0.84 },
      blocker: null,
    },
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
        // The organisation role is `member` so the project role is what decides (`rbac.ts`).
        role: 'member',
        sessionId: 'session-1',
      };
    }
  });
  await registerRediscoveryRoutes(app, {
    queries: {
      projectRole: async () => world.role,
      projectExists: async () => world.projectExists,
      ...memoryAttemptRecords(attempts),
      recordAction: async (input) => {
        actions.push({ action: input.action, params: input.params, taskId: input.taskId ?? null });
        const key = input.params.idempotency_key;
        const digest = input.params.body_digest;
        if (typeof key === 'string') {
          attempts.set(`${input.userId}|${input.action}|${key}`, {
            bodyDigest: typeof digest === 'string' ? digest : null,
            params: input.params,
          });
        }
      },
    },
    commands: {
      startRediscovery: async (input) => {
        calls.push(input);
        return world.result;
      },
    },
    gate: async () => world.gate,
  });
  await app.ready();
};

beforeEach(build);

const post = (headers: Record<string, string> = { 'idempotency-key': 'again-1' }) =>
  app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT}/rediscovery`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: '{}',
  });

const errorCode = (raw: string): string =>
  (JSON.parse(raw) as { error?: { code?: string } }).error?.code ?? '';

describe('POST /api/projects/:project_id/rediscovery', () => {
  it('starts a re-evaluation and records one human action carrying the ceiling', async () => {
    const response = await post();
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual({
      task_id: TASK,
      started: true,
      detail: 'queued again',
    });
    expect(calls).toEqual([{ projectId: PROJECT, userId: USER }]);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action: REDISCOVERY_START_ACTION,
      params: { project_id: PROJECT, task_id: TASK, ceiling_usd: 2, idempotency_key: 'again-1' },
      taskId: TASK,
    });
  });

  it('refuses a member: running discovery again spends money (criterion 2)', async () => {
    world.role = 'member';
    const response = await post();
    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([]);
    expect(actions).toEqual([]);
  });

  it('refuses a viewer on the command and serves them the gate', async () => {
    world.role = 'viewer';
    expect((await post()).statusCode).toBe(403);
    const read = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT}/rediscovery` });
    expect(read.statusCode).toBe(200);
  });

  it('refuses an anonymous caller on both methods', async () => {
    world.signedIn = false;
    expect((await post()).statusCode).toBe(401);
    const read = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT}/rediscovery` });
    expect(read.statusCode).toBe(401);
  });

  it('requires an Idempotency-Key, because a repeat would spend a second discovery budget', async () => {
    const response = await post({});
    expect(response.statusCode).toBe(400);
    expect(errorCode(response.body)).toBe('idempotency_key_required');
    expect(calls).toEqual([]);
  });

  it('answers a replay from the audit row and performs nothing a second time', async () => {
    await post();
    const replay = await post();
    expect(replay.statusCode).toBe(200);
    expect(JSON.parse(replay.body)).toMatchObject({ task_id: TASK, started: false });
    expect(calls).toHaveLength(1);
    expect(actions).toHaveLength(1);
  });

  it('answers the live task with started: false and audits nothing while one runs', async () => {
    world.result = { status: 'in_flight', taskId: TASK as never, detail: 'has not finished' };
    const response = await post();
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      task_id: TASK,
      started: false,
      detail: 'has not finished',
    });
    expect(actions).toEqual([]);
    // The key was given back, so the same key performs once the run has ended.
    world.result = { status: 'started', taskId: TASK as never, ceilingUsd: 2, detail: 'queued' };
    expect((await post()).statusCode).toBe(202);
  });

  it('maps each refusal to a typed 409 and audits none', async () => {
    for (const code of [
      'discovery_not_started',
      'discovery_unavailable',
      'rediscovery_attempts_spent',
    ] as const) {
      world.result = { status: 'refused', code, detail: `refused: ${code}` };
      const response = await post({ 'idempotency-key': `key-${code}` });
      expect(response.statusCode, code).toBe(409);
      expect(errorCode(response.body), code).toBe(code);
    }
    expect(actions).toEqual([]);
  });

  it('answers 404 for a project that does not exist, before calling the command', async () => {
    world.projectExists = false;
    expect((await post()).statusCode).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe('GET /api/projects/:project_id/rediscovery', () => {
  it('publishes the gate, the ceiling and the last discovery’s cost', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT}/rediscovery`,
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      can_start: true,
      blocker: null,
      ceiling_usd: 2,
      last_discovery: {
        task_id: TASK,
        state: 'done',
        cost_usd: 0.84,
        findings_unrecorded: null,
        escalation: null,
      },
    });
  });

  it('publishes why a parked discovery waits for a person (WP-155)', async () => {
    const escalation = {
      at: '2026-10-07T10:00:00.000Z',
      reason: 'run_failed',
      brief: 'The Discovery agent’s run failed; read its transcript.',
    };
    world.gate = {
      ceilingUsd: 2,
      lastDiscovery: { taskId: TASK, state: 'needs_human', costUsd: 0.84, escalation },
      blocker: { code: 'discovery_in_flight', detail: 'parked for a human', taskId: TASK },
    };
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT}/rediscovery`,
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).last_discovery.escalation).toEqual(escalation);
  });

  it('publishes why the last discovery’s findings were never recorded, when the recovery gave up (WP-124)', async () => {
    world.gate = {
      ceilingUsd: 2,
      lastDiscovery: {
        taskId: TASK,
        state: 'done',
        costUsd: 0.84,
        findingsUnrecorded: { at: '2026-10-02T10:00:00.000Z', reason: 'never recorded' },
      },
      blocker: null,
    };
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT}/rediscovery`,
    });
    expect(JSON.parse(response.body).last_discovery.findings_unrecorded).toEqual({
      at: '2026-10-02T10:00:00.000Z',
      reason: 'never recorded',
    });
  });

  it('publishes a blocker with the live task, and can_start false', async () => {
    world.gate = {
      ceilingUsd: 2,
      lastDiscovery: null,
      blocker: { code: 'discovery_in_flight', detail: 'running', taskId: TASK },
    };
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT}/rediscovery`,
    });
    expect(JSON.parse(response.body)).toMatchObject({
      can_start: false,
      blocker: { code: 'discovery_in_flight', detail: 'running', task_id: TASK },
    });
  });
});
