/**
 * The device flow and the people's worker surface, driven through Fastify against the in-memory
 * store (WP-280). The store itself is held to its contract by
 * `test/contract/worker-store.contract.test.ts` (this double) and
 * `test/integration/server/worker-store.integration.test.ts` (PostgreSQL).
 *
 * What this file owns is what the routes decide: the RFC 8628 answers and `no-store`, the one-time
 * credential, the client address a limit keys on (a forged header from an untrusted peer is limited
 * by its socket address), the second confirmation, which refusal maps to which status, own versus
 * every worker, and revocation's effects on the credential and on the worker's live runs.
 */
import {
  type UserRole,
  WORKER_API_PREFIX,
  WORKER_USER_CODE_ALPHABET,
  type WorkerIdleReason,
  workerCredentialSchema,
  workerDeviceResponseSchema,
  workerDeviceTokenResponseSchema,
} from '@platform/contracts';
import {
  DEVICE_CODE_STALE_AFTER_MS,
  MAX_OUTSTANDING_DEVICE_CODES_PER_ADDRESS,
} from '@platform/domain';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { TrustProxySetting } from '../client-address.js';
import { toApiError } from '../errors.js';
import type { IdleCandidate, WorkerIdleReader } from '../queries/worker-idle.js';
import { createMemoryWorkerStore, type MemoryWorkerStore } from '../queries/worker-store-memory.js';
import { authenticateWorkerCredential } from '../workers/secrets.js';
import { registerWorkerDeviceRoutes } from './worker-device.js';
import { registerWorkerRoutes } from './workers.js';

const ALICE = '00000000-0000-4000-8000-0000000280a1';
const BOB = '00000000-0000-4000-8000-0000000280b0';
const ADMIN = '00000000-0000-4000-8000-0000000280ad';
const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);
const TASK = '00000000-0000-4000-8000-0000002315a1';
const PROJECT = '00000000-0000-4000-8000-0000002315b1';
const RUN_LIVE = '00000000-0000-4000-8000-0000002315c1';
const RUN_DONE = '00000000-0000-4000-8000-0000002315c2';

interface World {
  actor: { userId: string; role: UserRole } | null;
  clock: number;
}

let app: FastifyInstance | undefined;

const build = async (
  options: {
    trustProxy?: TrustProxySetting;
    header?: string | null;
    coreDigests?: () => { run: string; egress: string } | null;
    idle?: WorkerIdleReader;
  } = {},
): Promise<{ app: FastifyInstance; store: MemoryWorkerStore; world: World }> => {
  const store = createMemoryWorkerStore();
  for (const [id, email] of [
    [ALICE, 'alice@example.test'],
    [BOB, 'bob@example.test'],
    [ADMIN, 'admin@example.test'],
  ] as const) {
    store.addUser({ id, email, name: null });
  }
  const world: World = { actor: { userId: ALICE, role: 'member' }, clock: T0 };
  const instance = fastify({
    ...(options.trustProxy === undefined
      ? {}
      : {
          trustProxy:
            typeof options.trustProxy === 'boolean' ? options.trustProxy : [...options.trustProxy],
        }),
  });
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
  instance.setErrorHandler(async (error, _request, reply) => {
    const mapped = toApiError(error, 'test-request');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  instance.addHook('onRequest', async (request) => {
    if (world.actor !== null) {
      request.actor = {
        userId: world.actor.userId,
        email: 'someone@example.test',
        name: 'Someone',
        role: world.actor.role,
        sessionId: 'session-1',
      };
    }
  });
  const now = (): Date => new Date(world.clock);
  await registerWorkerDeviceRoutes(instance, {
    store,
    baseUrl: 'https://agentic.example.test/',
    trustProxy: options.trustProxy ?? false,
    trustedClientIpHeader: options.header ?? null,
    now,
  });
  await registerWorkerRoutes(instance, {
    store,
    projectRole: async () => null,
    now,
    ...(options.coreDigests === undefined ? {} : { coreDigests: options.coreDigests }),
    ...(options.idle === undefined ? {} : { idle: options.idle }),
  });
  app = instance;
  return { app: instance, store, world };
};

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const startDevice = async (
  instance: FastifyInstance,
  extra: { remoteAddress?: string; headers?: Record<string, string> } = {},
) =>
  instance.inject({
    method: 'POST',
    url: `${WORKER_API_PREFIX}/device`,
    payload: {},
    ...(extra.remoteAddress === undefined ? {} : { remoteAddress: extra.remoteAddress }),
    headers: { 'user-agent': 'agentic-worker/1 (FAKE)', ...extra.headers },
  });

/** The approval page's read: the code travels in the body, never the URL (WP-280 review). */
const lookupCode = async (instance: FastifyInstance, userCode: string) =>
  instance.inject({
    method: 'POST',
    url: '/api/workers/device/lookup',
    payload: { user_code: userCode },
  });

const poll = async (instance: FastifyInstance, deviceCode: string) =>
  instance.inject({
    method: 'POST',
    url: `${WORKER_API_PREFIX}/device/token`,
    payload: { device_code: deviceCode },
  });

const approve = async (instance: FastifyInstance, userCode: string, confirmStale = false) =>
  instance.inject({
    method: 'POST',
    url: '/api/workers/device/approve',
    payload: {
      decision: 'approve',
      user_code: userCode,
      name: 'alice-laptop',
      confirm_stale: confirmStale,
    },
  });

describe('POST device (RFC 8628 §3.2)', () => {
  it('answers a code pair, the absolute verification uri, interval 5 and expires_in 600, no-store', async () => {
    const { app: instance, store } = await build();
    const response = await startDevice(instance);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = workerDeviceResponseSchema.parse(response.json());
    expect(body.verification_uri).toBe('https://agentic.example.test/workers/approve');
    expect(body.interval).toBe(5);
    expect(body.expires_in).toBe(600);
    expect(body.user_code).toMatch(
      new RegExp(`^[${WORKER_USER_CODE_ALPHABET}]{4}-[${WORKER_USER_CODE_ALPHABET}]{4}$`),
    );
    expect(store.codeCount()).toBe(1);
  });

  it('answers 429 past twenty pending codes for one address, and another address is not limited', async () => {
    const { app: instance } = await build();
    for (let index = 0; index < MAX_OUTSTANDING_DEVICE_CODES_PER_ADDRESS; index += 1) {
      expect((await startDevice(instance, { remoteAddress: '198.51.100.7' })).statusCode).toBe(200);
    }
    const limited = await startDevice(instance, { remoteAddress: '198.51.100.7' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('device_code_limit');
    expect(limited.headers['retry-after']).toBe('60');
    expect((await startDevice(instance, { remoteAddress: '198.51.100.8' })).statusCode).toBe(200);
  });

  it('limits a forged header from an untrusted peer by its socket address', async () => {
    // The header is configured, but the peer is not in APP_TRUST_PROXY's list: rotating the header
    // gives the caller no new bucket.
    const { app: instance } = await build({
      trustProxy: ['203.0.113.0/24'],
      header: 'cf-connecting-ip',
    });
    for (let index = 0; index < MAX_OUTSTANDING_DEVICE_CODES_PER_ADDRESS; index += 1) {
      const response = await startDevice(instance, {
        remoteAddress: '198.51.100.9',
        headers: { 'cf-connecting-ip': `192.0.2.${index + 1}` },
      });
      expect(response.statusCode).toBe(200);
    }
    const limited = await startDevice(instance, {
      remoteAddress: '198.51.100.9',
      headers: { 'cf-connecting-ip': '192.0.2.200' },
    });
    expect(limited.statusCode).toBe(429);
  });

  it('keys on the trusted header when the peer is trusted, so one proxy carries many clients', async () => {
    const { app: instance } = await build({
      trustProxy: ['203.0.113.0/24'],
      header: 'cf-connecting-ip',
    });
    for (let index = 0; index < MAX_OUTSTANDING_DEVICE_CODES_PER_ADDRESS + 5; index += 1) {
      const response = await startDevice(instance, {
        remoteAddress: '203.0.113.10',
        headers: { 'cf-connecting-ip': `192.0.2.${index + 1}` },
      });
      expect(response.statusCode).toBe(200);
    }
    // …and the address the approval page shows is the client's, not the proxy's.
    const last = await startDevice(instance, {
      remoteAddress: '203.0.113.10',
      headers: { 'cf-connecting-ip': '192.0.2.250' },
    });
    const lookup = await lookupCode(
      instance,
      workerDeviceResponseSchema.parse(last.json()).user_code,
    );
    expect(lookup.json().requested_ip).toBe('192.0.2.250');
  });
});

describe('the whole device flow', () => {
  it('pending → slow_down → approved → the credential once → expired_token', async () => {
    const { app: instance, store, world } = await build();
    const device = workerDeviceResponseSchema.parse((await startDevice(instance)).json());

    world.clock += 5_000;
    const pending = await poll(instance, device.device_code);
    expect(pending.statusCode).toBe(400);
    expect(pending.json()).toEqual({ error: 'authorization_pending' });
    expect(pending.headers['cache-control']).toBe('no-store');

    world.clock += 1_000;
    expect((await poll(instance, device.device_code)).json()).toEqual({ error: 'slow_down' });

    const lookup = await lookupCode(instance, device.user_code.toLowerCase().replace('-', ' '));
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json()).toMatchObject({
      user_code: device.user_code,
      requested_ip: '127.0.0.1',
      user_agent: 'agentic-worker/1 (FAKE)',
      age_seconds: 6,
      needs_confirmation: false,
    });

    const approved = await approve(instance, device.user_code);
    expect(approved.statusCode).toBe(200);
    expect(approved.json().decision).toBe('approve');
    expect(store.audit.map((entry) => entry.action)).toEqual(['worker.device.approve']);
    expect(JSON.stringify(store.audit)).not.toContain(device.user_code);

    // The interval grew to 10 s with the slow_down; the next poll after it collects the credential.
    world.clock += 10_000;
    const issued = await poll(instance, device.device_code);
    expect(issued.statusCode).toBe(200);
    expect(issued.headers['cache-control']).toBe('no-store');
    const token = workerDeviceTokenResponseSchema.parse(issued.json());
    expect(workerCredentialSchema.safeParse(token.credential).success).toBe(true);

    world.clock += 10_000;
    expect((await poll(instance, device.device_code)).json()).toEqual({ error: 'expired_token' });

    const subject = await authenticateWorkerCredential(store, token.credential);
    expect(subject).toMatchObject({ workerId: token.worker_id, userId: ALICE, usable: true });
  });

  it('answers access_denied for a denied code, and expired_token for an unknown one', async () => {
    const { app: instance, world } = await build();
    const device = workerDeviceResponseSchema.parse((await startDevice(instance)).json());
    const denied = await instance.inject({
      method: 'POST',
      url: '/api/workers/device/approve',
      payload: { decision: 'deny', user_code: device.user_code },
    });
    expect(denied.statusCode).toBe(200);
    world.clock += 5_000;
    expect((await poll(instance, device.device_code)).json()).toEqual({ error: 'access_denied' });
    expect((await poll(instance, 'x'.repeat(43))).json()).toEqual({ error: 'expired_token' });
  });

  it('expires a code after ten minutes, for the poll and for the approval page', async () => {
    const { app: instance, world } = await build();
    const device = workerDeviceResponseSchema.parse((await startDevice(instance)).json());
    world.clock += 600_000;
    expect((await poll(instance, device.device_code)).json()).toEqual({ error: 'expired_token' });
    const lookup = await lookupCode(instance, device.user_code);
    expect(lookup.statusCode).toBe(404);
    const late = await approve(instance, device.user_code, true);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('device_code_expired');
  });

  it('needs a second confirmation to approve a code older than five minutes', async () => {
    const { app: instance, store, world } = await build();
    const device = workerDeviceResponseSchema.parse((await startDevice(instance)).json());
    world.clock += DEVICE_CODE_STALE_AFTER_MS + 1_000;
    const lookup = await lookupCode(instance, device.user_code);
    expect(lookup.json().needs_confirmation).toBe(true);
    const first = await approve(instance, device.user_code, false);
    expect(first.statusCode).toBe(409);
    expect(first.json().error.code).toBe('device_code_needs_confirmation');
    expect(store.audit).toEqual([]);
    const second = await approve(instance, device.user_code, true);
    expect(second.statusCode).toBe(200);
    expect(store.audit[0]?.params.stale_confirmed).toBe(true);
    expect(second.json().performed).toBe(true);
    // A retry of the same approval is answered with it, and writes no second audit row…
    const again = await approve(instance, device.user_code, true);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ performed: false, decided_at: second.json().decided_at });
    expect(store.audit).toHaveLength(1);
    // …while a different decision on the decided code is refused.
    const renamed = await instance.inject({
      method: 'POST',
      url: '/api/workers/device/approve',
      payload: { decision: 'deny', user_code: device.user_code },
    });
    expect(renamed.json().error.code).toBe('device_code_already_decided');
  });

  it('refuses a malformed code as not found, and a decision with no session as 401', async () => {
    const { app: instance, world } = await build();
    expect((await approve(instance, 'AAAA-AAAA')).json().error.code).toBe('device_code_not_found');
    expect((await lookupCode(instance, 'AAAA-AAAA')).statusCode).toBe(404);
    world.actor = null;
    for (const request of [
      { method: 'GET' as const, url: '/api/workers' },
      { method: 'DELETE' as const, url: `/api/workers/${ALICE}` },
    ]) {
      expect((await instance.inject(request)).statusCode).toBe(401);
    }
    expect((await lookupCode(instance, 'BCDF-GHJK')).statusCode).toBe(401);
    expect((await approve(instance, 'BCDF-GHJK')).statusCode).toBe(401);
  });

  it('issues nothing when the approver can no longer act by the time the machine polls', async () => {
    const { app: instance, store, world } = await build();
    const device = workerDeviceResponseSchema.parse((await startDevice(instance)).json());
    await approve(instance, device.user_code);
    store.setUserMayAct(ALICE, false);
    world.clock += 5_000;
    expect((await poll(instance, device.device_code)).json()).toEqual({ error: 'access_denied' });
    expect(await store.listWorkers(null)).toEqual([]);
  });
});

/** Registers a worker for `owner` through the routes and returns its id and credential. */
const register = async (
  instance: FastifyInstance,
  world: World,
  owner: string,
): Promise<{ workerId: string; credential: string }> => {
  const saved = world.actor;
  world.actor = { userId: owner, role: 'member' };
  const device = workerDeviceResponseSchema.parse((await startDevice(instance)).json());
  await approve(instance, device.user_code);
  world.clock += 10_000;
  const token = workerDeviceTokenResponseSchema.parse(
    (await poll(instance, device.device_code)).json(),
  );
  world.actor = saved;
  return { workerId: token.worker_id, credential: token.credential };
};

describe('GET /api/workers and DELETE /api/workers/:id', () => {
  it('lists own workers for a member and every worker for an administrator', async () => {
    const { app: instance, world } = await build();
    const alice = await register(instance, world, ALICE);
    const bob = await register(instance, world, BOB);

    world.actor = { userId: ALICE, role: 'member' };
    const own = (await instance.inject({ method: 'GET', url: '/api/workers' })).json();
    expect(own.scope).toBe('own');
    expect(own.items.map((item: { id: string }) => item.id)).toEqual([alice.workerId]);
    expect(own.items[0]).toMatchObject({ name: 'alice-laptop', state: 'active', revoked_at: null });

    world.actor = { userId: ADMIN, role: 'admin' };
    const all = (await instance.inject({ method: 'GET', url: '/api/workers' })).json();
    expect(all.scope).toBe('all');
    expect(new Set(all.items.map((item: { id: string }) => item.id))).toEqual(
      new Set([alice.workerId, bob.workerId]),
    );
  });

  it('lists the live runs each visible worker holds, by id only (S-23.15)', async () => {
    const { app: instance, store, world } = await build();
    const alice = await register(instance, world, ALICE);
    const bob = await register(instance, world, BOB);
    store.seedRun({
      id: RUN_LIVE,
      workerId: alice.workerId,
      taskId: TASK,
      projectId: PROJECT,
      status: 'running',
      leaseExpiresAt: null,
    });
    store.seedRun({
      id: RUN_DONE,
      workerId: alice.workerId,
      taskId: TASK,
      projectId: PROJECT,
      status: 'completed',
      leaseExpiresAt: null,
    });
    const bobsRun = '00000000-0000-4000-8000-0000002315c3';
    store.seedRun({
      id: bobsRun,
      workerId: bob.workerId,
      taskId: TASK,
      projectId: PROJECT,
      status: 'starting',
      leaseExpiresAt: null,
    });

    world.actor = { userId: ALICE, role: 'member' };
    const own = (await instance.inject({ method: 'GET', url: '/api/workers' })).json();
    expect(own.items).toHaveLength(1);
    expect(own.items[0].running).toEqual([
      { run_id: RUN_LIVE, task_id: TASK, project_id: PROJECT },
    ]);
    // Bob's run is not in a member's answer about her own workers (scope `own` unchanged).
    expect(JSON.stringify(own)).not.toContain(bobsRun);

    world.actor = { userId: ADMIN, role: 'admin' };
    const all = (await instance.inject({ method: 'GET', url: '/api/workers' })).json();
    const bobs = all.items.find((item: { id: string }) => item.id === bob.workerId);
    expect(bobs.running).toEqual([{ run_id: bobsRun, task_id: TASK, project_id: PROJECT }]);
  });

  it('says why each worker takes no work, in the vocabulary’s order, and when it last claimed (S-22.19)', async () => {
    const RUN_IMAGE = `sha256:${'a'.repeat(64)}`;
    const EGRESS_IMAGE = `sha256:${'b'.repeat(64)}`;
    const OLD_IMAGE = `sha256:${'0'.repeat(64)}`;
    let digests: { run: string; egress: string } | null = { run: RUN_IMAGE, egress: EGRESS_IMAGE };
    const { app: instance, store, world } = await build({ coreDigests: () => digests });
    const alice = await register(instance, world, ALICE);
    const read = async () => {
      world.actor = { userId: ALICE, role: 'member' };
      const [item] = (await instance.inject({ method: 'GET', url: '/api/workers' })).json().items;
      return item as {
        claim_blockers: string[];
        can_claim: boolean;
        last_claimed_at: string | null;
      };
    };
    // Approved and never heard from: not connected, no images reported, no project for it.
    expect(await read()).toMatchObject({
      claim_blockers: ['offline', 'images_missing', 'no_eligible_project'],
      can_claim: false,
      last_claimed_at: null,
    });
    store.addProject({ id: PROJECT, key: 'ACME', name: 'Acme' }, [ALICE]);
    await store.recordContact({
      workerId: alice.workerId,
      protocolVersion: 3,
      imageDigests: [RUN_IMAGE, EGRESS_IMAGE],
    });
    expect(await read()).toMatchObject({ claim_blockers: [], can_claim: true });

    // Another build's images than the core's — and nothing said while the core cannot name its own.
    await store.recordContact({
      workerId: alice.workerId,
      protocolVersion: 3,
      imageDigests: [OLD_IMAGE, EGRESS_IMAGE],
    });
    expect((await read()).claim_blockers).toEqual(['images_outdated']);
    // A core that cannot name its own images answers every claim 503 (review of PR #54).
    digests = null;
    expect(await read()).toMatchObject({
      claim_blockers: ['platform_images_unresolved'],
      can_claim: false,
    });
    digests = { run: RUN_IMAGE, egress: EGRESS_IMAGE };
    await store.recordContact({
      workerId: alice.workerId,
      protocolVersion: 1,
      imageDigests: [RUN_IMAGE, EGRESS_IMAGE],
    });
    expect((await read()).claim_blockers).toEqual(['protocol_outdated']);
    await store.recordContact({ workerId: alice.workerId, protocolVersion: 3, imageDigests: null });

    // The owner's hold: a drain's when its newest pause row says so, the owner's pause otherwise.
    const hold = async (paused: boolean, via: 'worker_ui' | 'worker_ui_drain') =>
      store.setManualPause({ workerId: alice.workerId, paused, via, now: new Date(world.clock) });
    await hold(true, 'worker_ui_drain');
    expect((await read()).claim_blockers).toEqual(['draining']);
    await hold(false, 'worker_ui');
    await hold(true, 'worker_ui');
    expect((await read()).claim_blockers).toEqual(['paused']);
    await hold(false, 'worker_ui');
    store.setPausedUntil(alice.workerId, new Date(Date.now() + 3_600_000));
    expect((await read()).claim_blockers).toEqual(['usage_limited']);
    store.setPausedUntil(alice.workerId, null);

    // No project gives it work: its only one runs on the server only, or keeps its token off workers.
    store.setProjectMode(PROJECT, 'server_only');
    expect((await read()).claim_blockers).toEqual(['no_eligible_project']);
    store.setProjectMode(PROJECT, 'workers_only');
    expect((await read()).can_claim).toBe(true);
    store.refuseRemoteCredential(PROJECT);
    expect((await read()).claim_blockers).toEqual(['no_eligible_project']);

    const claimedAt = new Date(T0 + 60_000);
    store.recordClaim(alice.workerId, claimedAt);
    expect((await read()).last_claimed_at).toBe(claimedAt.toISOString());

    store.setUserMayAct(ALICE, false);
    expect((await read()).claim_blockers).toEqual(['owner_disabled', 'no_eligible_project']);
    store.setUserMayAct(ALICE, true);

    world.actor = { userId: ALICE, role: 'member' };
    await instance.inject({ method: 'DELETE', url: `/api/workers/${alice.workerId}` });
    expect((await read()).claim_blockers).toEqual(['revoked']);
  });

  it('says pick only, counts its every project, and a scope naming none that admits workers as none (S-22.19)', async () => {
    const RUN_IMAGE = `sha256:${'a'.repeat(64)}`;
    const EGRESS_IMAGE = `sha256:${'b'.repeat(64)}`;
    const {
      app: instance,
      store,
      world,
    } = await build({
      coreDigests: () => ({ run: RUN_IMAGE, egress: EGRESS_IMAGE }),
    });
    const alice = await register(instance, world, ALICE);
    const OTHER = '00000000-0000-4000-8000-0000002315b2';
    store.addProject({ id: PROJECT, key: 'ACME', name: 'Acme' }, [ALICE]);
    store.addProject({ id: OTHER, key: 'OPS', name: 'Ops' }, [ALICE]);
    store.setProjectMode(OTHER, 'server_only');
    await store.recordContact({
      workerId: alice.workerId,
      protocolVersion: 3,
      imageDigests: [RUN_IMAGE, EGRESS_IMAGE],
    });
    const blockers = async () => {
      world.actor = { userId: ALICE, role: 'member' };
      return (await instance.inject({ method: 'GET', url: '/api/workers' })).json().items[0]
        .claim_blockers;
    };
    // Pick only claims nothing by itself: not "no project gives it work", and not "can claim".
    // Since S-26.4 it is the policy, over every project.
    await store.setClaimScope({ workerId: alice.workerId, projectIds: null, policy: 'pick_only' });
    expect(await blockers()).toEqual(['pick_only']);
    await store.setClaimScope({
      workerId: alice.workerId,
      projectIds: [OTHER],
      policy: 'everything',
    });
    expect(await blockers()).toEqual(['no_eligible_project']);
    await store.setClaimScope({ workerId: alice.workerId, projectIds: [OTHER, PROJECT] });
    expect(await blockers()).toEqual([]);
    // A policy narrower than everything is no blocker: a *mine* machine is idle by choice (S-26.4).
    for (const policy of ['mine', 'mine_and_unassigned'] as const) {
      await store.setClaimScope({ workerId: alice.workerId, projectIds: null, policy });
      expect(await blockers()).toEqual([]);
    }
    // A worker row a build before migration 0108 wrote (no policy, every project): everything.
    store.clearClaimPolicy(alice.workerId);
    expect(await blockers()).toEqual([]);
  });

  it('says why a ready machine runs nothing — the reader’s answer, asked for active rows with their blockers (S-28.6)', async () => {
    const RUN_IMAGE = `sha256:${'a'.repeat(64)}`;
    const EGRESS_IMAGE = `sha256:${'b'.repeat(64)}`;
    const digests = { run: RUN_IMAGE, egress: EGRESS_IMAGE };
    const asked: IdleCandidate[][] = [];
    const told: { digests: unknown }[] = [];
    let answer: WorkerIdleReason | null = {
      kind: 'project_limit',
      project_id: PROJECT,
      project_key: 'ACME',
      limit_kind: 'max_tasks_in_pipeline',
      count: 5,
      limit: 5,
      queued: 4,
      organisation_bound: false,
    };
    const idle: WorkerIdleReader = async (candidates, coreDigests) => {
      asked.push([...candidates]);
      told.push({ digests: coreDigests });
      return new Map(candidates.map((candidate) => [candidate.workerId, answer]));
    };
    const { app: instance, store, world } = await build({ coreDigests: () => digests, idle });
    const alice = await register(instance, world, ALICE);
    store.addProject({ id: PROJECT, key: 'ACME', name: 'Acme' }, [ALICE]);
    await store.recordContact({
      workerId: alice.workerId,
      protocolVersion: 3,
      imageDigests: [RUN_IMAGE, EGRESS_IMAGE],
    });
    const read = async () => {
      world.actor = { userId: ALICE, role: 'member' };
      return (await instance.inject({ method: 'GET', url: '/api/workers' })).json().items[0] as {
        idle_reason: WorkerIdleReason | null;
      };
    };
    expect((await read()).idle_reason).toEqual(answer);
    expect(asked.at(-1)).toEqual([
      {
        workerId: alice.workerId,
        blocked: false,
        running: 0,
        concurrency: 1,
        claimPolicy: 'mine_and_unassigned',
      },
    ]);
    expect(told.at(-1)?.digests).toEqual(digests);
    // A blocker is told to the reader, which answers `null` for it — the blocker's words win.
    await store.setManualPause({
      workerId: alice.workerId,
      paused: true,
      via: 'worker_ui',
      now: new Date(world.clock),
    });
    answer = null;
    expect((await read()).idle_reason).toBeNull();
    expect(asked.at(-1)?.[0]?.blocked).toBe(true);
    // A revoked machine is never asked, and says nothing.
    answer = { kind: 'nothing_queued' };
    await instance.inject({ method: 'DELETE', url: `/api/workers/${alice.workerId}` });
    expect((await read()).idle_reason).toBeNull();
    expect(asked.at(-1)).toEqual([]);
  });

  it('says nothing about idleness when no reader is composed (S-28.6)', async () => {
    const { app: instance, world } = await build();
    await register(instance, world, ALICE);
    world.actor = { userId: ALICE, role: 'member' };
    const [item] = (await instance.inject({ method: 'GET', url: '/api/workers' })).json().items;
    expect(item.idle_reason).toBeNull();
  });

  describe('what a machine takes: PUT /api/workers/:id/claim-policy (S-26.4)', () => {
    const OTHER_PROJECT = '00000000-0000-4000-8000-0000002315b3';
    const put = (instance: FastifyInstance, workerId: string, payload: Record<string, unknown>) =>
      instance.inject({ method: 'PUT', url: `/api/workers/${workerId}/claim-policy`, payload });
    const policyAudits = (store: MemoryWorkerStore) =>
      store.audit.filter((row) => row.action === 'worker.claim_policy');

    it('lists every worker’s policy as it reads, and the offers its policy leaves for others', async () => {
      const digests = { run: `sha256:${'a'.repeat(64)}`, egress: `sha256:${'b'.repeat(64)}` };
      let core: typeof digests | null = digests;
      const { app: instance, store, world } = await build({ coreDigests: () => core });
      const alice = await register(instance, world, ALICE);
      const read = async () => {
        world.actor = { userId: ALICE, role: 'member' };
        return (await instance.inject({ method: 'GET', url: '/api/workers' })).json().items[0] as {
          claim_policy: string;
          policy_skipped_offers: number | null;
        };
      };
      // A new worker takes its owner's tasks and unassigned ones; nothing counted yet.
      expect(await read()).toMatchObject({
        claim_policy: 'mine_and_unassigned',
        policy_skipped_offers: null,
      });
      store.seedPolicySkippedOffers(alice.workerId, 3);
      expect((await read()).policy_skipped_offers).toBe(3);
      // A core that cannot name its images counts nothing.
      core = null;
      expect((await read()).policy_skipped_offers).toBeNull();
      // A row before migration 0108 reads as `everything`.
      store.clearClaimPolicy(alice.workerId);
      expect((await read()).claim_policy).toBe('everything');
    });

    it('is a state assertion by the worker’s own user: one audit row per change, none for a repeat', async () => {
      const { app: instance, store, world } = await build();
      store.addProject({ id: PROJECT, key: 'ACME', name: 'Acme' }, [ALICE]);
      const alice = await register(instance, world, ALICE);
      world.actor = { userId: ALICE, role: 'member' };
      const first = await put(instance, alice.workerId, {
        claim_policy: 'mine',
        claim_project_ids: [PROJECT],
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toEqual({
        worker_id: alice.workerId,
        claim_policy: 'mine',
        claim_project_ids: [PROJECT],
        performed: true,
      });
      expect(policyAudits(store)).toEqual([
        {
          userId: ALICE,
          action: 'worker.claim_policy',
          params: {
            worker_id: alice.workerId,
            claim_policy: 'mine',
            project_ids: [PROJECT],
            via: 'workers_screen',
          },
        },
      ]);
      // The same pair again: nothing written.
      const again = await put(instance, alice.workerId, {
        claim_policy: 'mine',
        claim_project_ids: [PROJECT],
      });
      expect(again.json()).toMatchObject({ performed: false });
      expect(policyAudits(store)).toHaveLength(1);
      // The policy alone moves: one more row.
      const everything = await put(instance, alice.workerId, {
        claim_policy: 'everything',
        claim_project_ids: [PROJECT],
      });
      expect(everything.json()).toMatchObject({ claim_policy: 'everything', performed: true });
      expect(policyAudits(store)).toHaveLength(2);
      expect(store.worker(alice.workerId)?.claimPolicy).toBe('everything');
    });

    it('refuses an administrator 403 and anybody else 404, writing nothing', async () => {
      const { app: instance, store, world } = await build();
      const alice = await register(instance, world, ALICE);
      const body = { claim_policy: 'everything', claim_project_ids: null };
      world.actor = { userId: ADMIN, role: 'admin' };
      const admin = await put(instance, alice.workerId, body);
      expect(admin.statusCode).toBe(403);
      expect(admin.json().error.code).toBe('claim_policy_owner_only');
      world.actor = { userId: BOB, role: 'member' };
      expect((await put(instance, alice.workerId, body)).statusCode).toBe(404);
      expect((await put(instance, '00000000-0000-4000-8000-0000002315ff', body)).statusCode).toBe(
        404,
      );
      expect(policyAudits(store)).toEqual([]);
      expect(store.worker(alice.workerId)?.claimPolicy).toBe('mine_and_unassigned');
      // The administrator still reads it.
      world.actor = { userId: ADMIN, role: 'admin' };
      const listed = (await instance.inject({ method: 'GET', url: '/api/workers' })).json().items;
      expect(listed.find((item: { id: string }) => item.id === alice.workerId)?.claim_policy).toBe(
        'mine_and_unassigned',
      );
    });

    it('refuses [] (pick only is a policy) and a project the user may not run, writing nothing', async () => {
      const { app: instance, store, world } = await build();
      store.addProject({ id: PROJECT, key: 'ACME', name: 'Acme' }, [ALICE]);
      store.addProject({ id: OTHER_PROJECT, key: 'OPS', name: 'Ops' }, [BOB]);
      const alice = await register(instance, world, ALICE);
      world.actor = { userId: ALICE, role: 'member' };
      const empty = await put(instance, alice.workerId, {
        claim_policy: 'pick_only',
        claim_project_ids: [],
      });
      expect(empty.statusCode).toBe(422);
      expect(empty.json().error.code).toBe('claim_scope_empty');
      const foreign = await put(instance, alice.workerId, {
        claim_policy: 'mine',
        claim_project_ids: [PROJECT, OTHER_PROJECT],
      });
      expect(foreign.statusCode).toBe(422);
      expect(foreign.json().error.code).toBe('project_not_eligible');
      expect(foreign.json().error.message).toContain(OTHER_PROJECT);
      expect(policyAudits(store)).toEqual([]);
      expect(store.worker(alice.workerId)).toMatchObject({
        claimPolicy: 'mine_and_unassigned',
        claimProjects: null,
      });
      // Pick only over every project is the spelling that is admitted.
      const pickOnly = await put(instance, alice.workerId, {
        claim_policy: 'pick_only',
        claim_project_ids: null,
      });
      expect(pickOnly.json()).toMatchObject({ claim_policy: 'pick_only', performed: true });
    });
  });

  it('revokes: the credential stops authenticating and the live runs’ leases expire, once', async () => {
    const { app: instance, store, world } = await build();
    const alice = await register(instance, world, ALICE);
    store.seedRun({
      id: RUN_LIVE,
      workerId: alice.workerId,
      taskId: TASK,
      projectId: PROJECT,
      status: 'running',
      leaseExpiresAt: null,
    });
    store.seedRun({
      id: RUN_DONE,
      workerId: alice.workerId,
      taskId: TASK,
      projectId: PROJECT,
      status: 'completed',
      leaseExpiresAt: null,
    });

    world.actor = { userId: ALICE, role: 'member' };
    const revoked = await instance.inject({
      method: 'DELETE',
      url: `/api/workers/${alice.workerId}`,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({
      worker_id: alice.workerId,
      performed: true,
      expired_runs: 1,
    });
    expect(store.runs.get(RUN_LIVE)?.leaseExpiresAt).not.toBeNull();
    expect(store.runs.get(RUN_DONE)?.leaseExpiresAt).toBeNull();
    expect(await authenticateWorkerCredential(store, alice.credential)).toBeNull();
    expect(store.audit.filter((entry) => entry.action === 'worker.revoke')).toHaveLength(1);

    const replay = await instance.inject({
      method: 'DELETE',
      url: `/api/workers/${alice.workerId}`,
    });
    expect(replay.json()).toMatchObject({ performed: false, expired_runs: 0 });
    expect(store.audit.filter((entry) => entry.action === 'worker.revoke')).toHaveLength(1);
    const listed = (await instance.inject({ method: 'GET', url: '/api/workers' })).json();
    expect(listed.items[0]).toMatchObject({ state: 'revoked' });
  });

  it('answers 404 for somebody else’s worker to a member, and lets an administrator revoke it', async () => {
    const { app: instance, world } = await build();
    const bob = await register(instance, world, BOB);
    world.actor = { userId: ALICE, role: 'member' };
    const refused = await instance.inject({
      method: 'DELETE',
      url: `/api/workers/${bob.workerId}`,
    });
    expect(refused.statusCode).toBe(404);
    world.actor = { userId: ADMIN, role: 'admin' };
    const done = await instance.inject({ method: 'DELETE', url: `/api/workers/${bob.workerId}` });
    expect(done.json().performed).toBe(true);
  });

  it('stops authenticating a deactivated user’s worker and expires its live runs’ leases', async () => {
    const { app: instance, store, world } = await build();
    const alice = await register(instance, world, ALICE);
    store.seedRun({
      id: RUN_LIVE,
      workerId: alice.workerId,
      taskId: TASK,
      projectId: PROJECT,
      status: 'starting',
      leaseExpiresAt: null,
    });
    store.setUserMayAct(ALICE, false);
    expect(await authenticateWorkerCredential(store, alice.credential)).toBeNull();
    expect(await store.expireUserWorkerLeases(ALICE)).toBe(1);
    expect(store.runs.get(RUN_LIVE)?.leaseExpiresAt).not.toBeNull();
  });
});
