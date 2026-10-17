/**
 * `GET /api/runs/:run_id/settings` and the run record's `settings_hash`, driven through the real
 * router against plain functions (WP-112, PROGRESS backlog 309).
 *
 * The real router, guards, response schemas and error handler, with no database — the seam
 * `routes/runs.ts` gained at WP-112 for the reason `tasks.test.ts` gives for its own: a refusal
 * (`409 settings_not_recorded`) is only worth something if a tier that runs on every change can
 * fail when it goes. What this tier cannot see is whether `findRunSettings` reads the columns
 * correctly; that is `test/integration/server/read-api.integration.test.ts`, against a migrated
 * database and a row the WP-91 writer never touched.
 */
import { defaultProjectSettings, type ProjectSettings } from '@platform/application';
import type { Id, RunRecord, UserRole } from '@platform/contracts';
import {
  runPromptResponseSchema,
  runReadResponseSchema,
  runSettingsResponseSchema,
} from '@platform/contracts';
import { stageAgentDefaults } from '@platform/domain';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import type { RunPrompt, RunSettings } from '../queries/pipeline-queries.js';
import { type RunQueries, registerRunRoutes, retryDefaultsReader } from './runs.js';

const RUN = '00000000-0000-4000-8000-0000000000e1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const PROJECT = '00000000-0000-4000-8000-0000000000c1';
const USER = '00000000-0000-4000-8000-0000000000d1';
const AT = '2026-09-30T09:00:00.000Z';
const HASH = '0123456789abcdef'.repeat(4);

interface World {
  signedIn: boolean;
  orgRole: UserRole;
  role: UserRole | null;
  settings: RunSettings;
  run: RunRecord | null;
  prompt: RunPrompt;
  /** The project's settings **now**, which `retry_defaults` is resolved from (WP-167). */
  projectSettings: ProjectSettings;
  /** Every run id a read was asked about, by read. */
  readonly reads: string[];
}

const record = (settingsHash: string | null): RunRecord => ({
  id: RUN,
  task_id: TASK,
  project_id: PROJECT,
  stage: 'implementation',
  role: 'developer',
  mode: 'normal',
  attempt: 1,
  session_id: null,
  model: 'claude-test',
  effort: 'high',
  provider_mode: 'api',
  prompt_version: 'test@1',
  status: 'completed',
  terminal_reason: 'success',
  started_at: AT,
  ended_at: AT,
  last_output_at: AT,
  num_turns: 1,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_read_tokens: 0,
  },
  model_usage: [],
  cost: { usd: 0, is_estimate: false, price_list_id: null },
  wall_ms: 0,
  redaction_count: 0,
  settings_hash: settingsHash,
  start_failure: null,
  saved_work: null,
  latest_progress: null,
});

const SNAPSHOT = {
  format: 1,
  effective: { version: 1, checklists: { review: ['no secrets in logs'] } },
  autonomy: null,
  task_budget_usd: 5,
  templates: ['bug', 'feature'],
  repository: null,
};

const build = async (): Promise<{ app: FastifyInstance; world: World }> => {
  const world: World = {
    signedIn: true,
    orgRole: 'viewer',
    role: 'member',
    settings: { found: true, recorded: true, settingsHash: HASH, snapshot: SNAPSHOT },
    run: record(HASH),
    prompt: { found: false },
    projectSettings: defaultProjectSettings(PROJECT as Id),
    reads: [],
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
        role: world.orgRole,
        sessionId: 'session-1',
      };
    }
  });
  const unused = async (): Promise<never> => {
    throw new Error('not read by these cases');
  };
  const queries: RunQueries = {
    runProjectId: async () => PROJECT,
    projectRole: async () => world.role,
    run: async (runId) => {
      world.reads.push(`run ${runId}`);
      return world.run;
    },
    settings: async (runId) => {
      world.reads.push(`settings ${runId}`);
      return world.settings;
    },
    messages: unused,
    prompt: async (runId) => {
      world.reads.push(`prompt ${runId}`);
      return world.prompt;
    },
    commands: unused,
    contextPack: unused,
    retryDefaults: retryDefaultsReader({ forProject: async () => world.projectSettings }),
  };
  await registerRunRoutes(app, { queries });
  await app.ready();
  return { app, world };
};

describe('GET /api/runs/:run_id/settings (WP-112)', () => {
  let app: FastifyInstance;
  let world: World;
  const url = `/api/runs/${RUN}/settings`;

  beforeEach(async () => {
    ({ app, world } = await build());
  });

  it('serves the stored snapshot and its hash to a member of the run’s project', async () => {
    const reply = await app.inject({ method: 'GET', url });
    expect(reply.statusCode, reply.body).toBe(200);
    expect(runSettingsResponseSchema.parse(reply.json())).toEqual({
      settings_hash: HASH,
      snapshot: SNAPSHOT,
    });
    expect(world.reads).toEqual([`settings ${RUN}`]);
  });

  it('serves the over-cap marker as stored, rather than a document it does not have', async () => {
    const marker = { format: 1, truncated: true, bytes: 300_000 };
    world.settings = { found: true, recorded: true, settingsHash: HASH, snapshot: marker };
    const reply = await app.inject({ method: 'GET', url });
    expect(reply.statusCode, reply.body).toBe(200);
    expect(reply.json()).toEqual({ settings_hash: HASH, snapshot: marker });
  });

  it('refuses a run created before WP-91 by name, with no document', async () => {
    world.settings = { found: true, recorded: false };
    const reply = await app.inject({ method: 'GET', url });
    expect(reply.statusCode, reply.body).toBe(409);
    const body = reply.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('settings_not_recorded');
    expect(body.error.message).toContain('before WP-91');
    expect(reply.body).not.toContain('"snapshot"');
  });

  it('answers 404 for a run the read cannot find, which is a third fact', async () => {
    world.settings = { found: false };
    const reply = await app.inject({ method: 'GET', url });
    expect(reply.statusCode, reply.body).toBe(404);
  });

  it('refuses an anonymous caller before it reads anything', async () => {
    world.signedIn = false;
    const reply = await app.inject({ method: 'GET', url });
    expect(reply.statusCode).toBe(401);
    expect(world.reads).toEqual([]);
  });

  it('is gated at transcript.read: a viewer is refused, and the record stays readable to them', async () => {
    // The document carries text an operator typed, so it is `member`; the hash on the record says
    // only whether two runs were planned alike, so it stays with `run.read` (`viewer`).
    world.role = null;
    const refused = await app.inject({ method: 'GET', url });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(world.reads).toEqual([]);
    const recordReply = await app.inject({ method: 'GET', url: `/api/runs/${RUN}` });
    expect(recordReply.statusCode, recordReply.body).toBe(200);
    expect(runReadResponseSchema.parse(recordReply.json()).settings_hash).toBe(HASH);
  });

  it('publishes a run nobody measured as cost null through the real router, never a zero (WP-119)', async () => {
    world.run = { ...record(HASH), status: 'stalled', terminal_reason: 'stalled', cost: null };
    const reply = await app.inject({ method: 'GET', url: `/api/runs/${RUN}` });
    expect(reply.statusCode, reply.body).toBe(200);
    expect(Object.hasOwn(reply.json() as object, 'cost')).toBe(true);
    expect((reply.json() as { cost: unknown }).cost).toBeNull();
    expect(runReadResponseSchema.parse(reply.json()).cost).toBeNull();
  });

  /**
   * WP-131 (PROGRESS backlog 404): a `run_model_usage` row with **neither** figure — a model
   * `price_list` has no row for, in `local` mode — is published as `usd: null`, never `0`, and the
   * route's response schema (`runReadResponseSchema`, whose `model_usage` is the read DTO's own
   * `runModelUsageRecordSchema`) serialises it rather than refusing it. The projection that writes
   * the `null` is held by `test/integration/server/read-api.integration.test.ts`.
   */
  it('publishes a model nobody priced with usd null through the real router, never a zero (WP-131)', async () => {
    world.run = {
      ...record(HASH),
      model_usage: [
        {
          model: 'claude-unpriced',
          input_tokens: 10,
          output_tokens: 5,
          cache_write_5m_tokens: 0,
          cache_write_1h_tokens: 0,
          cache_read_tokens: 0,
          usd: null,
        },
      ],
    };
    const reply = await app.inject({ method: 'GET', url: `/api/runs/${RUN}` });
    expect(reply.statusCode, reply.body).toBe(200);
    const usage = (reply.json() as { model_usage: { usd: unknown }[] }).model_usage;
    expect(usage).toHaveLength(1);
    expect(Object.hasOwn(usage[0] as object, 'usd')).toBe(true);
    expect(usage[0]?.usd).toBeNull();
    expect(runReadResponseSchema.parse(reply.json()).model_usage[0]?.usd).toBeNull();
  });

  it('publishes a run record’s null hash as null, not as an absent field', async () => {
    world.run = record(null);
    const reply = await app.inject({ method: 'GET', url: `/api/runs/${RUN}` });
    expect(reply.statusCode, reply.body).toBe(200);
    expect(Object.hasOwn(reply.json() as object, 'settings_hash')).toBe(true);
    expect((reply.json() as { settings_hash: unknown }).settings_hash).toBeNull();
  });
});

/**
 * WP-121 (migration 0073, PROGRESS backlog 363): the run's prompt record says why the project's
 * prompt files are missing from it — through the real router and its response schema.
 */
describe('GET /api/runs/:run_id/prompt carries what was withheld (WP-121)', () => {
  let app: FastifyInstance;
  let world: World;
  const url = `/api/runs/${RUN}/prompt`;

  beforeEach(async () => {
    ({ app, world } = await build());
    world.role = 'member';
  });

  it('serves the withheld record the run was created with, and null when nothing was withheld', async () => {
    const withheld = {
      reason: 'the credentials of integration "acme sentry" (sentry, 0f) cannot be decrypted',
      integrations: [{ integration: 'integration "acme sentry" (sentry, 0f)', reason: 'old key' }],
    };
    const recorded = {
      found: true as const,
      recorded: true as const,
      promptVersion: 'test@1',
      systemPrompt: 'the role prompt',
      userPrompt: 'the task block',
    };
    world.prompt = { ...recorded, promptsWithheld: withheld };
    const reply = await app.inject({ method: 'GET', url });
    expect(reply.statusCode, reply.body).toBe(200);
    expect(runPromptResponseSchema.parse(reply.json()).prompts_withheld).toEqual(withheld);

    world.prompt = { ...recorded, promptsWithheld: null };
    const none = await app.inject({ method: 'GET', url });
    expect(none.statusCode, none.body).toBe(200);
    expect(Object.hasOwn(none.json() as object, 'prompts_withheld')).toBe(true);
    expect(runPromptResponseSchema.parse(none.json()).prompts_withheld).toBeNull();
  });
});

/**
 * WP-167 ruling (a), backlog 514: `retry_defaults` is the stage's configured model and effort,
 * resolved **at the read** by `configuredStageAgent` — the function the retry's listing check admits
 * a model with (`packages/application/src/pipeline/human-commands.test.ts` › "retry a run: the
 * model list (WP-159)" › the WP-167 case holds the check's half).
 */
describe('GET /api/runs/:run_id publishes retry_defaults (WP-167)', () => {
  let app: FastifyInstance;
  let world: World;
  const url = `/api/runs/${RUN}`;
  const read = async () => {
    const reply = await app.inject({ method: 'GET', url });
    expect(reply.statusCode, reply.body).toBe(200);
    return runReadResponseSchema.parse(reply.json());
  };

  beforeEach(async () => {
    ({ app, world } = await build());
  });

  it('answers the template default for a stage the project does not configure', async () => {
    const defaults = stageAgentDefaults('implementation');
    expect((await read()).retry_defaults).toEqual({
      model: defaults.model,
      effort: defaults.effort,
    });
  });

  it('follows a changed `stages.<stage>.model` and effort, read by read, not the run’s own', async () => {
    const pinned = (model: string, effort: 'low' | 'high') =>
      defaultProjectSettings(PROJECT as Id, {
        config: { ...world.projectSettings.config, stages: { implementation: { model, effort } } },
      });
    world.projectSettings = pinned('claude-custom-pinned', 'low');
    const first = await read();
    expect(first.retry_defaults).toEqual({ model: 'claude-custom-pinned', effort: 'low' });
    // The run itself ran something else: the field is the configuration, never `record.model`.
    expect(first.model).toBe('claude-test');
    world.projectSettings = pinned('claude-custom-moved', 'high');
    expect((await read()).retry_defaults).toEqual({ model: 'claude-custom-moved', effort: 'high' });
  });

  it('is null for an ask run, which has no stage to run again', async () => {
    world.run = { ...record(HASH), stage: null, role: 'ask' };
    const body = await read();
    expect(Object.hasOwn(body, 'retry_defaults')).toBe(true);
    expect(body.retry_defaults).toBeNull();
  });
});
