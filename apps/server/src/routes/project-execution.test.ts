/**
 * The execution-settings pair, driven through Fastify against plain functions (WP-278 criterion 1,
 * TD-031 decision 8): the capability each method asks (`project.read`, `project.settings.write` —
 * admin), the strict body, TD-031 §8's defaults when nothing is stored, the one `human_actions` row
 * an accepted write leaves (before and after) and none for a refused one, the replay under an
 * `Idempotency-Key`, and the notice the settings screen shows on an instance with no server claimant.
 */
import type { JsonObject, UserRole } from '@platform/contracts';
import type { ExecutionSettings } from '@platform/domain';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import { memoryAttemptRecords } from './idempotency-memory.js';
import {
  executionDocument,
  REMOTE_CREDENTIAL_REFUSED_NOTICE,
  registerProjectExecutionRoutes,
  SET_EXECUTION_ACTION,
} from './project-execution.js';

const PROJECT = '00000000-0000-4000-8000-000000002781';
const USER = '00000000-0000-4000-8000-000000002783';
const URL = `/api/projects/${PROJECT}/execution`;

const BODY = {
  mode: 'workers_only',
  prefer: 'workers',
  fallback_after_seconds: null,
  assignee_window_seconds: 60,
  offer_timeout_seconds: 3_600,
} as const;

interface World {
  role: UserRole | null;
  exists: boolean;
  stored: ExecutionSettings | null;
  claimant: boolean;
}

let app: FastifyInstance;
let world: World;
let writes: ExecutionSettings[];
let actions: { action: string; params: JsonObject }[];

const build = async (): Promise<void> => {
  writes = [];
  actions = [];
  const attempts = new Map<string, { bodyDigest: string | null; params: JsonObject }>();
  world = { role: 'admin', exists: true, stored: null, claimant: true };
  app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(async (error, _request, reply) => {
    const mapped = toApiError(error, 'test-request');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  app.addHook('onRequest', async (request) => {
    request.actor = {
      userId: USER,
      email: 'admin@example.test',
      name: 'Admin',
      // The organisation role is `member` so the project role is what decides (`rbac.ts`).
      role: 'member',
      sessionId: 'session-1',
    };
  });
  await registerProjectExecutionRoutes(app, {
    queries: {
      projectRole: async () => world.role,
      projectExists: async () => world.exists,
      execution: async () => world.stored,
      writeExecution: async (_projectId, settings) => {
        if (!world.exists) return { status: 'not_found' };
        writes.push(settings);
        const before = world.stored;
        world.stored = settings;
        return { status: 'written', before };
      },
      serverClaimantRunning: async () => world.claimant,
      ...memoryAttemptRecords(attempts),
      recordAction: async (input) => {
        actions.push({ action: input.action, params: input.params });
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
  });
  await app.ready();
};

beforeEach(build);

describe('GET /api/projects/:id/execution', () => {
  it('answers TD-031 §8’s defaults when nothing is stored', async () => {
    const response = await app.inject({ method: 'GET', url: URL });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      mode: 'hybrid',
      prefer: 'server',
      fallback_after_seconds: null,
      assignee_window_seconds: 120,
      offer_timeout_seconds: 86_400,
      effective_fallback_after_seconds: 15,
      stored: false,
      server_claimant: 'running',
      notice: null,
    });
  });

  it('is a viewer’s read', async () => {
    world.role = 'viewer';
    expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(200);
  });

  it('says so when the instance has no server claimant', async () => {
    world.claimant = false;
    const body = (await app.inject({ method: 'GET', url: URL })).json();
    expect(body.server_claimant).toBe('none');
    expect(body.notice).toMatch(/treated as workers only/);
  });

  it('answers 404 for a project that does not exist', async () => {
    world.exists = false;
    expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(404);
  });
});

describe('PUT /api/projects/:id/execution', () => {
  it('writes the whole setting and leaves one human_actions row with before and after', async () => {
    const response = await app.inject({ method: 'PUT', url: URL, payload: BODY });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      performed: true,
      execution: { ...BODY, effective_fallback_after_seconds: 300, stored: true },
    });
    expect(writes).toEqual([
      {
        mode: 'workers_only',
        prefer: 'workers',
        fallbackAfterSeconds: null,
        assigneeWindowSeconds: 60,
        offerTimeoutSeconds: 3_600,
      },
    ]);
    expect(actions).toEqual([
      {
        action: SET_EXECUTION_ACTION,
        params: { project_id: PROJECT, before: null, after: { ...BODY } },
      },
    ]);
  });

  it('is an administrator’s: a maintainer is refused 403 and nothing is written', async () => {
    world.role = 'maintainer';
    const response = await app.inject({ method: 'PUT', url: URL, payload: BODY });
    expect(response.statusCode).toBe(403);
    expect(writes).toEqual([]);
    expect(actions).toEqual([]);
  });

  it.each([
    { ...BODY, mode: 'everywhere' },
    { ...BODY, offer_timeout_seconds: 30 },
    { ...BODY, assignee_window_seconds: 3_601 },
    { ...BODY, fallback_after_seconds: -1 },
    { ...BODY, unknown: true },
    { mode: 'hybrid' },
  ])('refuses a body the strict schema refuses (%j), writing nothing', async (payload) => {
    const response = await app.inject({ method: 'PUT', url: URL, payload });
    expect(response.statusCode).toBe(400);
    expect(writes).toEqual([]);
    expect(actions).toEqual([]);
  });

  it('answers 404 for a project that does not exist, with no audit row', async () => {
    world.exists = false;
    const response = await app.inject({ method: 'PUT', url: URL, payload: BODY });
    expect(response.statusCode).toBe(404);
    expect(actions).toEqual([]);
  });

  it('performs a replay under the same Idempotency-Key once, and refuses another body under it', async () => {
    const headers = { 'idempotency-key': 'execution-1' };
    const first = await app.inject({ method: 'PUT', url: URL, payload: BODY, headers });
    const again = await app.inject({ method: 'PUT', url: URL, payload: BODY, headers });
    expect(first.json().performed).toBe(true);
    expect(again.statusCode).toBe(200);
    expect(again.json().performed).toBe(false);
    expect(writes).toHaveLength(1);
    expect(actions).toHaveLength(1);
    const other = await app.inject({
      method: 'PUT',
      url: URL,
      payload: { ...BODY, mode: 'hybrid' },
      headers,
    });
    expect(other.statusCode).toBe(409);
    expect(writes).toHaveLength(1);
  });

  it('records what the setting was before a change', async () => {
    await app.inject({ method: 'PUT', url: URL, payload: BODY });
    await app.inject({ method: 'PUT', url: URL, payload: { ...BODY, mode: 'server_only' } });
    expect(actions[1]?.params).toMatchObject({
      before: { mode: 'workers_only' },
      after: { mode: 'server_only' },
    });
  });
});

describe('the execution setting says why remote workers take none of a project’s runs (WP-283)', () => {
  it('names the run credential when it keeps workers off, and says nothing of it otherwise', () => {
    expect(executionDocument(null, true, true).notice).toContain(REMOTE_CREDENTIAL_REFUSED_NOTICE);
    expect(executionDocument(null, true, false).notice ?? '').not.toContain('Remote workers');
    // A `server_only` project is closed to workers by its own setting already.
    const serverOnly = {
      mode: 'server_only',
      prefer: 'server',
      fallbackAfterSeconds: null,
      assigneeWindowSeconds: 120,
      offerTimeoutSeconds: 86_400,
    } as ExecutionSettings;
    expect(executionDocument(serverOnly, true, true).notice ?? '').not.toContain('Remote workers');
  });
});
