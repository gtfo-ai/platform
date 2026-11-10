/**
 * `GET /api/projects/:project_id/ci/manual-jobs` (S-28.7) through Fastify, with the real reader
 * (`manual-jobs-seen.ts`) over a git double: the capability it asks, the named refusals, the bound
 * on the heads it reads, the cache, a head that cannot be read, and provider text redacted.
 */
import {
  allowAnyIntegrationHost,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  exactSecretRedactor,
  type GitProviderPort,
  IntegrationError,
  type PipelineIntegrationsPort,
  type PipelineStatus,
  silentLogger,
  staticPipelineIntegrations,
} from '@platform/application';
import type { Id, IsoDateTime, UserRole } from '@platform/contracts';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import {
  createManualJobsSeenReader,
  looksLikeDeploy,
  manualJobsSeenOf,
} from '../manual-jobs-seen.js';
import { registerProjectCiJobsRoutes } from './project-ci-jobs.js';

const PROJECT = '00000000-0000-4000-8000-000000000f21';
const USER = '00000000-0000-4000-8000-000000000f23';
const TOKEN = 'FAKE-gitlab-token-DO-NOT-USE';

type Job = PipelineStatus['jobs'][number];
const job = (id: string, name: string, status: Job['status'], extra: Partial<Job> = {}): Job => ({
  id,
  name,
  status,
  stage: 'test',
  allow_failure: false,
  ...extra,
});

interface World {
  role: UserRole | null;
  git: 'bound' | 'none';
  composed: boolean;
  heads: number;
  failing: Set<string>;
  reads: string[];
}

let app: FastifyInstance;
let world: World;
let clock: number;

const pipelines: Record<string, Job[]> = {
  a: [
    job('1', 'build_composer', 'manual', { stage: 'build-deps' }),
    job('2', 'phpstan', 'success'),
    job('3', 'nette-tester', 'manual', { stage: 'test_optional', allow_failure: true }),
  ],
  b: [
    job('4', 'build_composer', 'success', { stage: 'build-deps' }),
    job('5', 'codeception', 'manual'),
    job('6', 'deploy:tenants:hetzner', 'manual', { stage: 'deploy', trigger: true }),
    job('7', `leak ${TOKEN}`, 'manual'),
  ],
};

const build = async (): Promise<void> => {
  world = {
    role: 'maintainer',
    git: 'bound',
    composed: true,
    heads: 2,
    failing: new Set(),
    reads: [],
  };
  clock = 0;
  const port = {
    ref: { integrationId: '00000000-0000-4000-8000-00000000a001', provider: 'gitlab', type: 'git' },
    capabilities: () => ({}),
    getPipelineStatus: async (_project: string, sha: string) => {
      world.reads.push(sha);
      if (world.failing.has(sha)) {
        throw new IntegrationError('unavailable', 'gitlab', 'connection refused', {
          action: 'get_pipeline_status',
        });
      }
      const jobs = pipelines[sha.slice(0, 1)];
      return jobs === undefined
        ? null
        : {
            id: sha.slice(0, 1),
            head_sha: sha,
            status: 'manual',
            url: null,
            jobs,
            coverage_pct: null,
            finished_at: null,
          };
    },
  } as unknown as GitProviderPort;
  const integrations = () =>
    staticPipelineIntegrations({
      executor: createIntegrationActionExecutor({
        egress: allowAnyIntegrationHost(),
        auditLog: createMemoryAuditLog(),
        redactor: exactSecretRedactor([]),
        timer: createVirtualTimer({ autoAdvance: true }),
        clock: { now: () => '2026-11-10T09:00:00.000Z' as IsoDateTime },
      }),
      git:
        world.git === 'none'
          ? null
          : {
              port,
              ref: port.ref,
              project: 'acme/api',
              redactor: exactSecretRedactor([{ name: 'gitlab_token', value: TOKEN }]),
            },
      taskManagement: null,
      communication: null,
    });
  const reader = createManualJobsSeenReader({
    // Built per call, so a test may change the binding between two requests.
    integrations: {
      ...integrations(),
      forProject: async (projectId, scope) => integrations().forProject(projectId, scope),
    } satisfies PipelineIntegrationsPort,
    recentHeads: async (_projectId, limit) =>
      [
        'a'.repeat(40),
        'b'.repeat(40),
        'c'.repeat(40),
        'd'.repeat(40),
        'e'.repeat(40),
        'f'.repeat(40),
      ]
        .slice(0, Math.min(limit + 1, world.heads))
        .map((headSha, index) => ({ taskId: `task-${String(index)}` as Id, headSha })),
    logger: silentLogger,
    now: () => clock,
  });
  app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(async (error, _request, reply) => {
    const mapped = toApiError(error, 'test-request');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  app.addHook('onRequest', async (request) => {
    if (world.role !== null) {
      request.actor = {
        userId: USER,
        email: 'operator@example.test',
        name: 'Operator',
        role: 'viewer',
        sessionId: 'session-1',
      };
    }
  });
  await registerProjectCiJobsRoutes(app, {
    projectRole: async () => world.role,
    projectExists: async (projectId) => projectId === PROJECT,
    manualJobsSeen: async (projectId) =>
      world.composed ? reader.read(projectId) : Promise.reject(new Error('unreachable')),
  });
};

beforeEach(async () => {
  await build();
});

const get = () => app.inject({ method: 'GET', url: `/api/projects/${PROJECT}/ci/manual-jobs` });

describe('GET /api/projects/:project_id/ci/manual-jobs (S-28.7)', () => {
  it('lists each manual job once with its stage, whether it blocks, a trigger and a deploy hint', async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.heads_read).toBe(2);
    expect(body.heads_unread).toBe(0);
    expect(body.jobs).toEqual([
      {
        name: 'build_composer',
        stage: 'build-deps',
        blocking: true,
        trigger: false,
        deploy_like: false,
        seen_in: 1,
      },
      {
        name: 'nette-tester',
        stage: 'test_optional',
        blocking: false,
        trigger: false,
        deploy_like: false,
        seen_in: 1,
      },
      {
        name: 'codeception',
        stage: 'test',
        blocking: true,
        trigger: false,
        deploy_like: false,
        seen_in: 1,
      },
      {
        name: 'deploy:tenants:hetzner',
        stage: 'deploy',
        blocking: true,
        trigger: true,
        deploy_like: true,
        seen_in: 1,
      },
      {
        name: 'leak [REDACTED:integration:gitlab_token]',
        stage: 'test',
        blocking: true,
        trigger: false,
        deploy_like: false,
        seen_in: 1,
      },
    ]);
    // The redaction is the binding redactor's own placeholder (TD-012), so the token is gone.
    // Every name seen, whatever its status — the typo check reads this.
    expect(body.names_seen).toContain('phpstan');
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('reads at most five heads, and keeps the answer for a minute', async () => {
    world.heads = 6;
    await get();
    expect(world.reads).toHaveLength(5);
    await get();
    expect(world.reads, 'cached').toHaveLength(5);
    clock += 61_000;
    await get();
    expect(world.reads).toHaveLength(10);
  });

  it('counts a head it could not read instead of failing the answer', async () => {
    world.failing.add('b'.repeat(40));
    const body = (await get()).json();
    expect(body.heads_read).toBe(1);
    expect(body.heads_unread).toBe(1);
    expect(body.jobs.map((each: { name: string }) => each.name)).toEqual([
      'build_composer',
      'nette-tester',
    ]);
  });

  it('refuses by name: no git binding, no integrations, an anonymous caller, a member', async () => {
    world.git = 'none';
    const none = await get();
    expect(none.statusCode).toBe(409);
    expect(none.json().error.code).toBe('no_git_binding');
    await build();
    world.role = 'member';
    expect((await get()).statusCode).toBe(403);
    world.role = null;
    expect((await get()).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'GET', url: `/api/projects/${USER}/ci/manual-jobs` })).statusCode,
    ).toBe(401);
  });

  it('says whether the caller may save: an administrator may, a maintainer reads only', async () => {
    expect((await get()).json().can_save).toBe(false);
    world.role = 'admin';
    expect((await get()).json().can_save).toBe(true);
  });

  it('does not keep a missing binding: a git host bound a moment later is read', async () => {
    world.git = 'none';
    expect((await get()).statusCode).toBe(409);
    world.git = 'bound';
    expect((await get()).statusCode).toBe(200);
    expect(world.reads.length).toBeGreaterThan(0);
  });

  it('answers 503 manual_jobs_unavailable on a process with no integrations', async () => {
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
        role: 'viewer',
        sessionId: 'session-1',
      };
    });
    await registerProjectCiJobsRoutes(app, {
      projectRole: async () => 'maintainer',
      projectExists: async () => true,
      manualJobsSeen: null,
    });
    const response = await get();
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('manual_jobs_unavailable');
  });
});

describe('manualJobsSeenOf and looksLikeDeploy', () => {
  it('merges one job seen in several pipelines, blocking anywhere is blocking', () => {
    const seen = manualJobsSeenOf(
      [
        { jobs: [job('1', 'e2e', 'manual', { allow_failure: true })] },
        { jobs: [job('2', 'e2e', 'manual')] },
      ],
      0,
      (text) => text,
    );
    expect(seen.jobs).toEqual([
      {
        name: 'e2e',
        stage: 'test',
        blocking: true,
        trigger: false,
        deploy_like: false,
        seen_in: 2,
      },
    ]);
  });

  it('reads a deployment from the name or the stage, and not from a test', () => {
    expect(looksLikeDeploy('deploy:tenants:hetzner', 'deploy')).toBe(true);
    expect(looksLikeDeploy('sentry-release-commit', 'release')).toBe(true);
    expect(looksLikeDeploy('codeception', 'test')).toBe(false);
  });
});
