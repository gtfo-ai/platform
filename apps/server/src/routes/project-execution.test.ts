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
import type { UnassignedTakerExclusion } from '../queries/offer-waiting.js';
import type { ProjectWorkerRow } from '../queries/worker-queries.js';
import { memoryAttemptRecords } from './idempotency-memory.js';
import {
  executionDocument,
  projectWorkerOf,
  REMOTE_CREDENTIAL_REFUSED_NOTICE,
  registerProjectExecutionRoutes,
  SET_EXECUTION_ACTION,
  waitingOf,
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
  /** The organisation role (`users.role`): an administrator sees every worker (S-22.19). */
  orgRole: UserRole;
  exists: boolean;
  stored: ExecutionSettings | null;
  claimant: boolean;
  workers: ProjectWorkerRow[];
  /** Whose workers the route asked for: `null` every worker. */
  askedFor: (string | null)[];
  offers: { open: number; never: number; later: number };
  /** S-26.5: the answer `othersTakeUnassigned` gives, and whom it was asked for. */
  others: boolean;
  othersAskedFor: UnassignedTakerExclusion[];
}

const RUN_IMAGE = `sha256:${'a'.repeat(64)}`;
const EGRESS_IMAGE = `sha256:${'b'.repeat(64)}`;
const OTHER_USER = '00000000-0000-4000-8000-000000002784';

/** A connected worker holding the core's images, whose user may run in {@link PROJECT}. */
const workerRow = (overrides: Partial<ProjectWorkerRow> = {}): ProjectWorkerRow => ({
  id: '00000000-0000-4000-8000-0000000027a1',
  name: 'alice-laptop',
  userId: USER,
  userEmail: 'alice@example.test',
  userName: 'Alice',
  createdAt: new Date('2026-11-05T09:00:00.000Z'),
  lastSeenAt: new Date(),
  protocolVersion: 3,
  imageDigests: [RUN_IMAGE, EGRESS_IMAGE],
  state: 'active',
  revokedAt: null,
  pausedUntil: null,
  pausedReason: null,
  pausedUntilEstimated: false,
  manuallyPausedAt: null,
  claimProjects: null,
  claimPolicy: 'everything',
  concurrency: 1,
  running: [],
  claimFacts: {
    online: true,
    ownerMayAct: true,
    usagePaused: false,
    hold: null,
    eligibleProjects: 1,
    lastClaimedAt: null,
  },
  mayRunInProject: true,
  ...overrides,
});

let app: FastifyInstance;
let world: World;
let writes: ExecutionSettings[];
let actions: { action: string; params: JsonObject }[];

const build = async (): Promise<void> => {
  writes = [];
  actions = [];
  const attempts = new Map<string, { bodyDigest: string | null; params: JsonObject }>();
  world = {
    role: 'admin',
    orgRole: 'member',
    exists: true,
    stored: null,
    claimant: true,
    workers: [],
    askedFor: [],
    offers: { open: 0, never: 0, later: 0 },
    others: false,
    othersAskedFor: [],
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
      email: 'admin@example.test',
      name: 'Admin',
      // The organisation role is `member` so the project role is what decides (`rbac.ts`).
      role: world.orgRole,
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
      workersFor: async (_projectId, userId) => {
        world.askedFor.push(userId);
        return world.workers.filter((row) => userId === null || row.userId === userId);
      },
      waitingOffers: async () => world.offers,
      othersTakeUnassigned: async (_projectId, exclude) => {
        world.othersAskedFor.push(exclude);
        return world.others;
      },
      coreDigests: () => ({ run: RUN_IMAGE, egress: EGRESS_IMAGE }),
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
      workers: [],
      waiting: {
        open: 0,
        closed_to_workers: { credential_refused: 0, server_only: 0, server_first: 0 },
      },
      others_take_unassigned: false,
    });
  });

  /**
   * S-26.5 criterion 5: whether the server or another person's machine takes unassigned tasks by
   * itself — a yes or no asked for the reader, so it names no machine (the integration tier holds
   * the SQL, `offer-waiting.integration.test.ts`).
   */
  it('says whether anybody else takes unassigned tasks, asked for the reader, naming nobody', async () => {
    world.role = 'viewer';
    world.others = true;
    const body = (await app.inject({ method: 'GET', url: URL })).json();
    expect(body.others_take_unassigned).toBe(true);
    expect(world.othersAskedFor).toEqual([{ userId: USER }]);
    expect(body.workers).toEqual([]);
    world.others = false;
    expect((await app.inject({ method: 'GET', url: URL })).json().others_take_unassigned).toBe(
      false,
    );
  });

  /**
   * BACKLOG 1456: the Workers screen's card for one machine asks for that machine, so its owner's
   * other machines count; the id must be one this read lists to the reader.
   */
  it('asks for one machine with ?worker_id=, its owner’s other machines counted — only a machine the reader can see', async () => {
    const LAPTOP = '00000000-0000-4000-8000-0000000027a1';
    const DESKTOP = '00000000-0000-4000-8000-0000000027a2';
    const BOBS = '00000000-0000-4000-8000-0000000027a3';
    world.role = 'viewer';
    world.workers = [
      workerRow({ id: LAPTOP }),
      workerRow({ id: DESKTOP, name: 'alice-desktop' }),
      workerRow({ id: BOBS, name: 'bob-laptop', userId: OTHER_USER }),
    ];
    world.others = true;
    const asked = await app.inject({ method: 'GET', url: `${URL}?worker_id=${LAPTOP}` });
    expect(asked.statusCode).toBe(200);
    expect(asked.json().others_take_unassigned).toBe(true);
    expect(world.othersAskedFor).toEqual([{ workerId: LAPTOP }]);
    // Absent: today's question, for the reader — every machine of theirs excluded.
    await app.inject({ method: 'GET', url: URL });
    expect(world.othersAskedFor.at(-1)).toEqual({ userId: USER });
    // Another person's machine is not a member's to ask about, nor an id that names none: 404.
    for (const id of [BOBS, '00000000-0000-4000-8000-0000000027ff']) {
      const refused = await app.inject({ method: 'GET', url: `${URL}?worker_id=${id}` });
      expect(refused.statusCode).toBe(404);
    }
    expect(world.othersAskedFor).toHaveLength(2);
    // An administrator sees every machine, so may ask for Bob's.
    world.orgRole = 'admin';
    const admin = await app.inject({ method: 'GET', url: `${URL}?worker_id=${BOBS}` });
    expect(admin.statusCode).toBe(200);
    expect(world.othersAskedFor.at(-1)).toEqual({ workerId: BOBS });
    // Not a uuid, or a key the read does not take: 400.
    expect((await app.inject({ method: 'GET', url: `${URL}?worker_id=laptop` })).statusCode).toBe(
      400,
    );
    expect((await app.inject({ method: 'GET', url: `${URL}?machine=${LAPTOP}` })).statusCode).toBe(
      400,
    );
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

describe('who would run this project, and what waits (S-22.19, N2)', () => {
  const input = {
    projectId: PROJECT,
    settings: {
      mode: 'hybrid',
      prefer: 'server',
      fallbackAfterSeconds: null,
      assigneeWindowSeconds: 120,
      offerTimeoutSeconds: 86_400,
    } as ExecutionSettings,
    credentialRefused: false,
    coreDigests: { run: RUN_IMAGE, egress: EGRESS_IMAGE },
    now: new Date(),
  };

  it('takes the runs by itself, only when picked, or not at all — and says why', () => {
    expect(projectWorkerOf(workerRow(), input)).toMatchObject({
      takes: 'automatically',
      blockers: [],
      project_reason: null,
    });
    expect(
      projectWorkerOf(workerRow({ claimProjects: [{ id: PROJECT, key: 'ACME' }] }), input).takes,
    ).toBe('automatically');
    // Pick only, and a scope that names another project: the owner may still pick its runs.
    // A legacy `[]` reads as the policy `pick_only` (S-26.4); a policy of its own does the same.
    for (const row of [
      { claimProjects: [], claimPolicy: 'pick_only' as const },
      { claimProjects: null, claimPolicy: 'pick_only' as const },
      { claimProjects: [{ id: OTHER_USER, key: 'OPS' }] },
    ]) {
      expect(projectWorkerOf(workerRow(row), input)).toMatchObject({
        takes: 'picked_only',
        project_reason: 'scope_excludes',
      });
    }
    // A policy narrower than everything still takes the project by itself: which tasks is per task.
    for (const claimPolicy of ['mine', 'mine_and_unassigned'] as const) {
      expect(projectWorkerOf(workerRow({ claimPolicy }), input)).toMatchObject({
        takes: 'automatically',
        project_reason: null,
      });
    }
    expect(projectWorkerOf(workerRow({ mayRunInProject: false }), input)).toMatchObject({
      takes: 'no',
      project_reason: 'role',
    });
    expect(projectWorkerOf(workerRow(), { ...input, credentialRefused: true }).project_reason).toBe(
      'credential_refused',
    );
    expect(
      projectWorkerOf(workerRow(), {
        ...input,
        settings: { ...input.settings, mode: 'server_only' },
      }),
    ).toMatchObject({ takes: 'no', project_reason: 'server_only' });
    // The worker's own blocker is `no` whatever the project says — and not the project's to name.
    expect(
      projectWorkerOf(workerRow({ imageDigests: [`sha256:${'0'.repeat(64)}`] }), input),
    ).toMatchObject({ takes: 'no', blockers: ['images_outdated'], project_reason: null });
    expect(
      projectWorkerOf(
        workerRow({
          claimFacts: {
            online: true,
            ownerMayAct: true,
            usagePaused: false,
            hold: null,
            eligibleProjects: 0,
            lastClaimedAt: null,
          },
        }),
        input,
      ).blockers,
    ).toEqual([]);
  });

  it('counts each waiting run under the first reason no worker may take it', () => {
    expect(waitingOf({ open: 5, never: 1, later: 2 }, false)).toEqual({
      open: 5,
      closed_to_workers: { credential_refused: 0, server_only: 1, server_first: 2 },
    });
    expect(waitingOf({ open: 5, never: 1, later: 2 }, true)).toEqual({
      open: 5,
      closed_to_workers: { credential_refused: 4, server_only: 1, server_first: 0 },
    });
  });

  it('lists every worker to an administrator and only your own to anyone else', async () => {
    world.workers = [
      workerRow(),
      workerRow({
        id: '00000000-0000-4000-8000-0000000027a2',
        name: 'bob-desktop',
        userId: OTHER_USER,
      }),
    ];
    world.offers = { open: 3, never: 1, later: 0 };
    world.role = 'viewer';
    const own = (await app.inject({ method: 'GET', url: URL })).json();
    expect(own.workers.map((worker: { name: string }) => worker.name)).toEqual(['alice-laptop']);
    expect(own.workers[0]).toMatchObject({
      takes: 'automatically',
      owner: { id: USER, name: 'Alice', email: 'alice@example.test' },
    });
    expect(own.waiting).toEqual({
      open: 3,
      closed_to_workers: { credential_refused: 0, server_only: 1, server_first: 0 },
    });
    world.orgRole = 'admin';
    const all = (await app.inject({ method: 'GET', url: URL })).json();
    expect(all.workers.map((worker: { name: string }) => worker.name)).toEqual([
      'alice-laptop',
      'bob-desktop',
    ]);
    expect(world.askedFor).toEqual([USER, null]);
  });
});
