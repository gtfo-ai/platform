/**
 * The configuration export and re-read, driven through Fastify against plain functions (WP-63,
 * the shape `shadow.test.ts` uses).
 *
 * What this file holds: the `Idempotency-Key` policy (required on the export, a replay performs
 * nothing twice, a different body under a used key is refused), the capability, the refusal to
 * status mapping, and the `human_actions` row — one per performed command, none for a refusal. What
 * it cannot see is the merge request: the command is a stub here, and the branch and the commit a
 * provider really receives are `test/e2e/onboarding/config-export.e2e.test.ts`'s assertion.
 */
import type {
  ConfigExportReport,
  ConfigExportRequest,
  RepositoryConfigRefresh,
  RepositoryConfigSnapshot,
} from '@platform/application';
import type { JsonObject, UserRole } from '@platform/contracts';
import { agenticConfigSchema } from '@platform/contracts';
import { config as configAdapters } from '@platform/infrastructure';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import { type MemoryAttempt, memoryAttemptRecords } from './idempotency-memory.js';
import {
  CONFIG_EXPORT_ACTION,
  CONFIG_REFRESH_ACTION,
  configExportIdOf,
  type ExportableProject,
  exportHeaderLines,
  registerProjectConfigRoutes,
  renderExport,
} from './project-config.js';

const PROJECT = '00000000-0000-4000-8000-000000000c01';
const USER = '00000000-0000-4000-8000-000000000c02';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const HASH = '0123456789abcdef0123456789abcdef';
const SETTINGS = { version: 1, stages: { refinement: { model: 'claude-opus-5' } } };

interface World {
  role: UserRole | null;
  project: ExportableProject | null;
  report: ConfigExportReport;
  refresh: RepositoryConfigRefresh;
  stored: RepositoryConfigSnapshot | null;
}

let app: FastifyInstance;
let world: World;
let exports: ConfigExportRequest[];
let refreshes: string[];
let actions: { userId: string; action: string; params: JsonObject }[];
let attempts: Map<string, MemoryAttempt>;

const exported = (): ConfigExportReport => ({
  status: 'exported',
  branch: 'agentic/config/0123456789ab-aaaaaaaaaaaa',
  commitSha: 'abc1234',
  mergeRequestUrl: 'https://git.example.test/acme/api/-/merge_requests/9',
  mergeRequestIid: 9,
  paths: ['.agentic/config.yml', 'CLAUDE.md'],
  notes: [],
});

beforeEach(async () => {
  exports = [];
  refreshes = [];
  actions = [];
  attempts = new Map();
  world = {
    role: 'maintainer',
    project: {
      config: SETTINGS,
      configHash: HASH,
      defaultBranch: 'main',
      knowledgeDir: '.agentic/knowledge',
    },
    report: exported(),
    refresh: {
      status: 'recorded',
      snapshot: { status: 'absent', commitSha: SHA, readAt: '2026-09-26T10:00:00.000Z' as never },
      promptsWithheld: null,
    },
    stored: null,
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
      role: world.role ?? 'viewer',
      sessionId: 'session-1',
    };
  });
  await registerProjectConfigRoutes(app, {
    queries: {
      projectRole: async () => world.role,
      exportableProject: async () => world.project,
      ...memoryAttemptRecords(attempts),
      recordAction: async (input) => {
        actions.push({ userId: input.userId, action: input.action, params: input.params });
        // What the real writer does: the audit row completes the key's record.
        const key = input.params.idempotency_key;
        const digest = input.params.body_digest;
        if (typeof key === 'string') {
          attempts.set(`${input.userId}|${input.action}|${key}`, {
            bodyDigest: typeof digest === 'string' ? digest : null,
            params: input.params,
          });
        }
      },
      readRepository: async () => world.stored,
      // What `findLastConfigExport` does, over the rows this test's writer recorded (WP-91).
      lastExport: async (projectId) => {
        const row = [...actions]
          .reverse()
          .find(
            (action) =>
              action.action === 'project.config.export' && action.params.project_id === projectId,
          );
        if (row === undefined) return null;
        const p = row.params;
        return {
          status: p.status as 'exported' | 'unchanged' | 'open',
          configHash: String(p.config_hash),
          branch: typeof p.branch === 'string' ? p.branch : null,
          mergeRequestUrl: typeof p.merge_request_url === 'string' ? p.merge_request_url : null,
          mergeRequestIid: typeof p.merge_request_iid === 'number' ? p.merge_request_iid : null,
          exportedAt: '2026-09-29T10:00:00.000Z',
        };
      },
    },
    commands: {
      export: async (request) => {
        exports.push(request);
        return world.report;
      },
      refresh: async (projectId) => {
        refreshes.push(projectId);
        return world.refresh;
      },
    },
    redactText: (value) => value.replaceAll('glpat-FAKE', '[REDACTED]'),
  });
});

const post = (path: string, body: unknown, key?: string) =>
  app.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT}${path}`,
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    payload: JSON.stringify(body),
  });

describe('POST …/config/export', () => {
  it('requires an Idempotency-Key, and a maintainer', async () => {
    expect((await post('/config/export', {})).json().error.code).toBe('idempotency_key_required');
    world.role = 'member';
    expect((await post('/config/export', {}, 'k1')).statusCode).toBe(403);
    expect(exports).toEqual([]);
    expect(actions).toEqual([]);
  });

  it('exports the settings layer, rendered and read back, and records one audit row', async () => {
    const response = await post('/config/export', { base_hash: HASH }, 'k1');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'exported',
      performed: true,
      config_hash: HASH,
      branch: 'agentic/config/0123456789ab-aaaaaaaaaaaa',
    });
    expect(exports).toHaveLength(1);
    const request = exports[0] as ConfigExportRequest;
    // The file is the settings document, parsed back to exactly it.
    const parsed = configAdapters.yamlConfigCodec.parse(request.content);
    expect(parsed.ok && agenticConfigSchema.parse(parsed.value)).toEqual(SETTINGS);
    expect(request.content.startsWith(`# ${exportHeaderLines(HASH)[0]}`)).toBe(true);
    // The key is digested, never used as a branch or a provider key (standing rule 70).
    expect(request.exportId).toBe(configExportIdOf(USER, 'k1'));
    expect(request.exportId).not.toContain('k1');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action: CONFIG_EXPORT_ACTION,
      params: { project_id: PROJECT, status: 'exported', idempotency_key: 'k1' },
    });
  });

  it('answers a replay from the first attempt without calling the provider again', async () => {
    await post('/config/export', {}, 'k1');
    const replay = await post('/config/export', {}, 'k1');
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ status: 'exported', performed: false });
    expect(exports).toHaveLength(1);
    expect(actions).toHaveLength(1);
    // …while a different body under the used key is refused, and a new key exports again.
    const reused = await post('/config/export', { base_hash: HASH }, 'k1');
    expect(reused.json().error.code).toBe('idempotency_key_reused');
    await post('/config/export', {}, 'k2');
    expect(exports).toHaveLength(2);
    expect(exports[1]?.exportId).not.toBe(exports[0]?.exportId);
  });

  it('refuses a stale base_hash, an unconfigured project and an unavailable export — none audited', async () => {
    expect((await post('/config/export', { base_hash: 'old' }, 'k1')).json().error.code).toBe(
      'config_conflict',
    );
    world.project = { ...(world.project as ExportableProject), config: {}, configHash: null };
    expect((await post('/config/export', {}, 'k2')).json().error.code).toBe('nothing_to_export');
    world.project = { ...(world.project as ExportableProject), config: SETTINGS, configHash: HASH };
    world.report = { status: 'unavailable', reason: 'no mirror: glpat-FAKE-leak' };
    const unavailable = await post('/config/export', {}, 'k3');
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json().error.code).toBe('config_export_unavailable');
    expect(unavailable.json().error.message).not.toContain('glpat-FAKE');
    world.project = null;
    expect((await post('/config/export', {}, 'k4')).statusCode).toBe(404);
    expect(actions).toEqual([]);
  });

  it('records an export that needed no merge request, with the reason', async () => {
    world.report = { status: 'unchanged', reason: 'the default branch already carries it' };
    const response = await post('/config/export', {}, 'k1');
    expect(response.json()).toMatchObject({
      status: 'unchanged',
      branch: null,
      notes: ['the default branch already carries it'],
    });
    expect(actions).toHaveLength(1);
  });
});

/**
 * WP-91 (backlog 225): the second press hands the command the first export's merge request, as
 * its audit row recorded it, and an `open` answer is recorded and replayed as `open`.
 */
describe('POST …/config/export with a previous export on record', () => {
  it('hands the command the recorded merge request, and records the iid for the next press', async () => {
    await post('/config/export', {}, 'k1');
    expect(exports[0]?.previous).toBeNull();
    expect(actions[0]?.params.merge_request_iid).toBe(9);

    world.report = {
      status: 'open',
      branch: 'agentic/config/0123456789ab-aaaaaaaaaaaa',
      mergeRequestIid: 9,
      mergeRequestUrl: 'https://git.example.test/acme/api/-/merge_requests/9',
      configHash: HASH,
      notes: ['merge request !9 already proposes this configuration and is still open'],
    };
    const second = await post('/config/export', {}, 'k2');
    expect(second.statusCode).toBe(200);
    expect(exports[1]?.previous).toEqual({
      iid: 9,
      url: 'https://git.example.test/acme/api/-/merge_requests/9',
      branch: 'agentic/config/0123456789ab-aaaaaaaaaaaa',
      configHash: HASH,
    });
    expect(second.json()).toMatchObject({
      status: 'open',
      performed: false,
      commit_sha: null,
      merge_request_url: 'https://git.example.test/acme/api/-/merge_requests/9',
      notes: ['merge request !9 already proposes this configuration and is still open'],
    });
    expect(actions[1]).toMatchObject({ params: { status: 'open', merge_request_iid: 9 } });
    // A replay of that press answers `open` too, from its row.
    const replay = await post('/config/export', {}, 'k2');
    expect(replay.json()).toMatchObject({ status: 'open', performed: false });
    expect(exports).toHaveLength(2);
  });

  it('asks nothing about a previous export that opened no merge request', async () => {
    world.report = { status: 'unchanged', reason: 'the default branch already carries it' };
    await post('/config/export', {}, 'k1');
    world.report = exported();
    await post('/config/export', {}, 'k2');
    expect(exports[1]?.previous).toBeNull();
  });
});

describe('POST …/config/refresh', () => {
  it('re-reads the default branch and answers the reading, including a refusal’s key paths', async () => {
    world.refresh = {
      status: 'recorded',
      snapshot: {
        status: 'invalid',
        commitSha: SHA,
        readAt: '2026-09-26T10:00:00.000Z' as never,
        detail: 'stages.refinement.max_turns (expected number)',
      },
      promptsWithheld: null,
    };
    const response = await post('/config/refresh', {});
    expect(response.statusCode).toBe(200);
    expect(response.json().repository).toMatchObject({
      status: 'invalid',
      commit_sha: SHA,
      detail: 'stages.refinement.max_turns (expected number)',
    });
    expect(refreshes).toEqual([PROJECT]);
    expect(actions[0]).toMatchObject({ action: CONFIG_REFRESH_ACTION });
  });

  /**
   * WP-107 (PROGRESS backlog 358): an integration whose credentials will not decrypt is named on the
   * answer, which is a 200 carrying the stored configuration — never the default-branch 409 — and a
   * reading that withheld nothing carries no such field.
   */
  it('names the integration whose credentials would not decrypt, on a 200 that carries the configuration', async () => {
    const reason =
      'the credentials of integration "acme sentry" (sentry, 00000000-0000-4000-8000-00000000a358) (secret … is sealed under key "v1:old") cannot be decrypted, so the prompt files cannot be redacted against them and none are stored until they can (TD-012, WP-107)';
    world.refresh = {
      status: 'recorded',
      snapshot: {
        status: 'valid',
        commitSha: SHA,
        readAt: '2026-09-26T10:00:00.000Z' as never,
        values: { commands: { allow: ['pnpm test'] } },
        notApplied: [],
      },
      promptsWithheld: reason,
    };
    const response = await post('/config/refresh', {});
    expect(response.statusCode).toBe(200);
    expect(response.json().prompts_withheld).toBe(reason);
    expect(response.json().repository).toMatchObject({ status: 'valid', commit_sha: SHA });
    expect(actions[0]).toMatchObject({ action: CONFIG_REFRESH_ACTION });

    world.refresh = { ...world.refresh, promptsWithheld: null };
    expect((await post('/config/refresh', {})).json()).not.toHaveProperty('prompts_withheld');
  });

  it('refuses by name when the branch cannot be read, and writes nothing', async () => {
    world.refresh = { status: 'unavailable', reason: 'APP_KNOWLEDGE_MIRROR_ROOT is not set' };
    const response = await post('/config/refresh', {});
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('repository_unreadable');
    expect(response.json().error.message).toContain('APP_KNOWLEDGE_MIRROR_ROOT');
    expect(actions).toEqual([]);
  });

  it('answers a replay under the same key from the stored reading, reading nothing', async () => {
    await post('/config/refresh', {}, 'r1');
    world.stored = {
      status: 'absent',
      commitSha: SHA,
      readAt: '2026-09-26T10:00:00.000Z' as never,
    };
    const replay = await post('/config/refresh', {}, 'r1');
    expect(replay.json().repository.status).toBe('absent');
    expect(refreshes).toHaveLength(1);
  });
});

describe('renderExport', () => {
  it('refuses to propose a file that would not read back as the document', () => {
    expect(() => renderExport(agenticConfigSchema.parse(SETTINGS), HASH)).not.toThrow();
  });
});
