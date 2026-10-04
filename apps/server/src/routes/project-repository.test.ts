/**
 * The default-branch pair, driven through Fastify against plain functions (WP-139).
 *
 * The integration tier holds the statement (`onboarding-queries` — the lock, the live-task count,
 * the one column) and the e2e tier the run that checks out the branch. What this file owns is what
 * the route decides: the capability each method asks for (criterion 2: 403 below maintainer), the
 * refusal a live task earns (409, no audit row), the one `human_actions` row an accepted change
 * leaves (before and after), the replay, and what the read publishes of the provider's answer.
 */
import type { JsonObject, ProjectRecord, UserRole } from '@platform/contracts';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import { memoryAttemptRecords } from './idempotency-memory.js';
import {
  type ProviderRepositoryAnswer,
  registerProjectRepositoryRoutes,
  SET_DEFAULT_BRANCH_ACTION,
} from './project-repository.js';

const PROJECT = '00000000-0000-4000-8000-000000000e01';
const USER = '00000000-0000-4000-8000-000000000e03';

const record = (branch: string): ProjectRecord => ({
  id: PROJECT,
  key: 'autix',
  name: 'Autix',
  repo_url: 'https://gitlab.example.test/acme/autix.git',
  default_branch: branch,
  agentic_dir: '.agentic',
  knowledge_dir: '.agentic/knowledge',
  autonomy_level: 'supervised',
  readiness_level: 0,
  status: 'active',
  created_at: '2026-10-04T05:00:00.000Z',
  updated_at: '2026-10-04T05:00:00.000Z',
});

interface World {
  role: UserRole | null;
  branch: string;
  liveTasks: number;
  exists: boolean;
  provider: ProviderRepositoryAnswer | null;
}

let app: FastifyInstance;
let world: World;
let writes: { projectId: string; branch: string }[];
let actions: { action: string; params: JsonObject }[];
let attempts: Map<string, { bodyDigest: string | null; params: JsonObject }>;

const build = async (): Promise<void> => {
  writes = [];
  actions = [];
  attempts = new Map();
  world = {
    role: 'maintainer',
    branch: 'main',
    liveTasks: 0,
    exists: true,
    provider: {
      status: 'ok',
      provider: {
        provider: 'gitlab',
        default_branch: 'develop',
        ci_config: { kind: 'repository', path: '.gitlab-ci.yml' },
      },
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
    request.actor = {
      userId: USER,
      email: 'operator@example.test',
      name: 'Operator',
      // The organisation role is `member` so the project role is what decides (`rbac.ts`).
      role: 'member',
      sessionId: 'session-1',
    };
  });
  await registerProjectRepositoryRoutes(app, {
    queries: {
      projectRole: async () => world.role,
      projectRepository: async () =>
        world.exists ? { defaultBranch: world.branch, liveTasks: world.liveTasks } : null,
      project: async () => (world.exists ? record(world.branch) : null),
      writeDefaultBranch: async (projectId, branch) => {
        if (!world.exists) {
          return { status: 'not_found' };
        }
        if (world.liveTasks > 0) {
          return { status: 'live_tasks', count: world.liveTasks };
        }
        writes.push({ projectId, branch });
        const before = world.branch;
        world.branch = branch;
        return { status: 'written', before, project: record(branch) };
      },
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
    providerRepository: async () =>
      world.provider ?? { status: 'unavailable', reason: 'unreachable in this test' },
  });
  await app.ready();
};

beforeEach(build);

const put = (body: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'PUT',
    url: `/api/projects/${PROJECT}/default-branch`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });

const errorCode = (raw: string): string =>
  (JSON.parse(raw) as { error?: { code?: string } }).error?.code ?? '';

describe('PUT /api/projects/:project_id/default-branch (WP-139)', () => {
  it('changes the branch and records one human action with the branch before and after', async () => {
    const response = await put({ default_branch: 'develop' }, { 'idempotency-key': 'b-1' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      performed: true,
      project: { default_branch: 'develop' },
    });
    expect(writes).toEqual([{ projectId: PROJECT, branch: 'develop' }]);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action: SET_DEFAULT_BRANCH_ACTION,
      params: { project_id: PROJECT, before: 'main', after: 'develop', idempotency_key: 'b-1' },
    });
  });

  it('replays a repeat under the same key without a second write or audit row', async () => {
    await put({ default_branch: 'develop' }, { 'idempotency-key': 'b-2' });
    const again = await put({ default_branch: 'develop' }, { 'idempotency-key': 'b-2' });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({
      performed: false,
      project: { default_branch: 'develop' },
    });
    expect(writes).toHaveLength(1);
    expect(actions).toHaveLength(1);
    const different = await put({ default_branch: 'dev' }, { 'idempotency-key': 'b-2' });
    expect(different.statusCode).toBe(409);
    expect(errorCode(different.body)).toBe('idempotency_key_reused');
  });

  it('refuses 409 project_has_live_tasks while a task is not finished, and writes nothing', async () => {
    world.liveTasks = 2;
    const response = await put({ default_branch: 'develop' }, { 'idempotency-key': 'b-3' });
    expect(response.statusCode).toBe(409);
    expect(errorCode(response.body)).toBe('project_has_live_tasks');
    expect(response.body).toContain('2 tasks that are not finished');
    expect(writes).toEqual([]);
    expect(actions).toEqual([]);
    // The refusal released the key: once the tasks are finished, the same key performs.
    world.liveTasks = 0;
    const later = await put({ default_branch: 'develop' }, { 'idempotency-key': 'b-3' });
    expect(later.statusCode).toBe(200);
    expect(actions).toHaveLength(1);
  });

  it('refuses a member and a viewer 403, and lets a maintainer and an admin change it', async () => {
    for (const role of ['member', 'viewer'] as const) {
      world.role = role;
      const response = await put({ default_branch: 'develop' });
      expect(response.statusCode, role).toBe(403);
    }
    expect(writes).toEqual([]);
    expect(actions).toEqual([]);
    for (const role of ['maintainer', 'admin'] as const) {
      world.role = role;
      const response = await put({ default_branch: `release/${role}` });
      expect(response.statusCode, role).toBe(200);
    }
    expect(actions).toHaveLength(2);
  });

  it('refuses a name that is not a git branch, and a body with another key, before writing', async () => {
    for (const body of [
      { default_branch: '' },
      { default_branch: 'has space' },
      { default_branch: '../main' },
      { default_branch: 'develop', knowledge_dir: 'x' },
    ]) {
      const response = await put(body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(writes).toEqual([]);
  });

  it('answers 404 for a project that does not exist', async () => {
    world.exists = false;
    const response = await put({ default_branch: 'develop' });
    expect(response.statusCode).toBe(404);
    expect(actions).toEqual([]);
  });
});

describe('GET /api/projects/:project_id/repository (WP-139)', () => {
  it('publishes the stored branch beside the provider’s, and the live-task count', async () => {
    world.liveTasks = 1;
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT}/repository`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      default_branch: 'main',
      provider: {
        provider: 'gitlab',
        default_branch: 'develop',
        ci_config: { kind: 'repository', path: '.gitlab-ci.yml' },
      },
      provider_unavailable: null,
      live_tasks: 1,
    });
  });

  it('says why when the provider cannot be asked, rather than inventing a branch', async () => {
    world.provider = {
      status: 'unavailable',
      reason: 'this project has no git binding, so the platform cannot ask its provider',
    };
    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${PROJECT}/repository`,
    });
    expect(response.json()).toMatchObject({
      default_branch: 'main',
      provider: null,
      provider_unavailable:
        'this project has no git binding, so the platform cannot ask its provider',
    });
  });

  it('is readable by a viewer', async () => {
    world.role = 'viewer';
    expect(
      (await app.inject({ method: 'GET', url: `/api/projects/${PROJECT}/repository` })).statusCode,
    ).toBe(200);
  });
});
