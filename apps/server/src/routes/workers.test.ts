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
import { createMemoryWorkerStore, type MemoryWorkerStore } from '../queries/worker-store-memory.js';
import { authenticateWorkerCredential } from '../workers/secrets.js';
import { registerWorkerDeviceRoutes } from './worker-device.js';
import { registerWorkerRoutes } from './workers.js';

const ALICE = '00000000-0000-4000-8000-0000000280a1';
const BOB = '00000000-0000-4000-8000-0000000280b0';
const ADMIN = '00000000-0000-4000-8000-0000000280ad';
const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);

interface World {
  actor: { userId: string; role: UserRole } | null;
  clock: number;
}

let app: FastifyInstance | undefined;

const build = async (
  options: { trustProxy?: TrustProxySetting; header?: string | null } = {},
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
  await registerWorkerRoutes(instance, { store, projectRole: async () => null, now });
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

  it('revokes: the credential stops authenticating and the live runs’ leases expire, once', async () => {
    const { app: instance, store, world } = await build();
    const alice = await register(instance, world, ALICE);
    store.seedRun({
      id: 'run-live',
      workerId: alice.workerId,
      status: 'running',
      leaseExpiresAt: null,
    });
    store.seedRun({
      id: 'run-done',
      workerId: alice.workerId,
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
    expect(store.runs.get('run-live')?.leaseExpiresAt).not.toBeNull();
    expect(store.runs.get('run-done')?.leaseExpiresAt).toBeNull();
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
      id: 'run-live',
      workerId: alice.workerId,
      status: 'starting',
      leaseExpiresAt: null,
    });
    store.setUserMayAct(ALICE, false);
    expect(await authenticateWorkerCredential(store, alice.credential)).toBeNull();
    expect(await store.expireUserWorkerLeases(ALICE)).toBe(1);
    expect(store.runs.get('run-live')?.leaseExpiresAt).not.toBeNull();
  });
});
