/**
 * TD-028's control plane, driven end to end — the **real** listener, the **real** HTTP client from
 * `@platform/infrastructure`, and a real {@link LauncherService} over `FakeWorkspaceProvider`.
 *
 * Nothing here is a stub of the thing under test: the client serialises, the server parses, the
 * service creates, and the assertions are about what crossed. That matters more than usual for this
 * surface because it is the one thing in the product that **creates containers**, and the two
 * properties WP-53 criterion 7 names — *authenticated* and *idempotent on the run id* — are both
 * properties of a round trip rather than of a function.
 *
 * What it cannot see, stated rather than left to be discovered: the daemon. `FakeWorkspaceProvider`
 * makes no container, so "a replayed create started only one container" is asserted as *"the
 * provider was asked to create once"*. The claim against a real daemon is
 * `scripts/launcher-control-plane-check.mjs`'s.
 */
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { silentLogger, type WorkspaceSpec } from '@platform/application';
import { launcher as launcherAdapters, workspace } from '@platform/infrastructure';
import { PLATFORM_SKILLS } from '@platform/prompts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bearerOf, type ControlPlane, startControlPlane, tokenMatches } from './control-plane.js';
import { LauncherService } from './service.js';

const TOKEN = 'FAKE-launcher-token-0000000000000000';
const SECRET = 'FAKE-mint';

let dir: string;
let provider: workspace.FakeWorkspaceProvider;
let service: LauncherService;
let plane: ControlPlane;

/** Flipped by the one case that needs a create to fail; reset in `beforeEach`. */
let mintFails = false;

const credentials: workspace.RunCredentialSource = {
  async mint(request) {
    if (mintFails) {
      throw new Error('the git provider refused to mint');
    }
    return {
      username: 'agentic',
      value: `${SECRET}-${request.project}`,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      revokeId: null,
    };
  },
  async revoke() {
    // Nothing is minted outside this process.
  },
};

const clientFor = (token = TOKEN): launcherAdapters.LauncherControlClient =>
  launcherAdapters.createLauncherControlClient({
    baseUrl: `http://127.0.0.1:${String(plane.port)}`,
    token,
  });

const specFor = (runId: string, overrides: Partial<WorkspaceSpec> = {}): WorkspaceSpec =>
  workspace.workspaceSpecFixture({ runId, readOnly: false, ...overrides });

/**
 * The run ids the provider was asked to **create** a workspace for, in order.
 *
 * Read off `FakeWorkspaceProvider.events` — its own seam — rather than through a `Proxy` over the
 * instance: a proxy's `get` trap returns an unbound method, and the fake's state lives in private
 * `#` fields, so the first call through one fails with *"Cannot read private member #mirrors from
 * an object whose class did not declare it"*. Measured here rather than reasoned about.
 */
const createdRuns = (): string[] =>
  provider.events.filter((event) => event.kind === 'create').map((event) => event.runId);

const credentialRequest = {
  project: 'acme/web',
  host: 'vcs.example.com',
  branchPatterns: ['agentic/*'],
  ttlSeconds: 86_400,
};

beforeEach(async () => {
  mintFails = false;
  dir = await workspace.shortTempDir('agentic-control-plane-');
  provider = new workspace.FakeWorkspaceProvider({
    controlRoot: path.join(dir, 'ctl'),
    skills: PLATFORM_SKILLS,
  });
  service = new LauncherService({
    provider,
    broker: new workspace.RunCredentialBroker(credentials, silentLogger),
    clock: { now: () => Date.now(), setTimer: () => () => undefined },
    logger: silentLogger,
    exportDir: path.join(dir, 'exports'),
    retentionSweepMs: 60_000,
  });
  plane = await startControlPlane({
    service,
    token: TOKEN,
    host: '127.0.0.1',
    port: 0,
    controlRoot: path.join(dir, 'ctl'),
    runtimeImage: 'platform-runtime:test',
    claudeCodePath: '/usr/local/bin/claude',
    logger: silentLogger,
  });
});

afterEach(async () => {
  await plane.close();
  service.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('authentication (TD-028 decision 3)', () => {
  it('answers health to a caller with the token', async () => {
    await expect(clientFor().health()).resolves.toMatchObject({
      status: 'ok',
      runtimeImage: 'platform-runtime:test',
      claudeCodePath: '/usr/local/bin/claude',
    });
  });

  it.each([
    ['a wrong token', 'FAKE-launcher-token-9999999999999999'],
    ['a token that is a prefix of the right one', TOKEN.slice(0, 10)],
  ])('refuses %s, and the refusal is terminal', async (_label, token) => {
    // `invalid_spec` rather than a retryable code: a wrong token is a statement about
    // configuration and would be wrong again on the next attempt (standing rule 18).
    await expect(clientFor(token).health()).rejects.toMatchObject({ code: 'invalid_spec' });
  });

  it('refuses a request with no Authorization header at all', async () => {
    const response = await fetch(`http://127.0.0.1:${String(plane.port)}/v1/health`);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'unauthorized',
    );
  });

  it('compares in constant time over digests, so the expected length is not observable', () => {
    // `timingSafeEqual` throws on a length mismatch, which would make "the token is 36 characters"
    // readable from whether the call threw. Digesting first makes both sides 32 bytes.
    expect(tokenMatches('a', 'a')).toBe(true);
    expect(tokenMatches('a', 'a-much-longer-expected-token')).toBe(false);
    expect(bearerOf('Bearer abc')).toBe('abc');
    expect(bearerOf('bearer   abc')).toBe('abc');
    expect(bearerOf('Basic abc')).toBeNull();
    expect(bearerOf(undefined)).toBeNull();
  });
});

describe('create (TD-028 decision 4: idempotent on the run id)', () => {
  it('creates a workspace and answers its control-socket coordinates', async () => {
    const runId = randomUUID();
    const created = await clientFor().createRun({
      spec: specFor(runId),
      credential: credentialRequest,
    });
    expect(created.handle.runId).toBe(runId);
    expect(created.attachment.socketPath).toContain(runId);
    expect(created.attachment.workdir).toBe('/work/repo');
    expect(created.credentialMinted).toBe(true);
    expect(created.replayed).toBe(false);
    expect(createdRuns()).toEqual([runId]);
  });

  it('answers the stored handle on a replay rather than starting a second container', async () => {
    const runId = randomUUID();
    const first = await clientFor().createRun({
      spec: specFor(runId),
      credential: credentialRequest,
    });
    const second = await clientFor().createRun({
      spec: specFor(runId),
      credential: credentialRequest,
    });
    expect(second.handle).toEqual(first.handle);
    expect(second.attachment).toEqual(first.attachment);
    expect(second.replayed).toBe(true);
    // The countable effect, and the reason this is not an assertion about a boolean.
    expect(createdRuns()).toEqual([runId]);
  });

  it('collapses two concurrent creates of one run onto the first', async () => {
    // At-least-once delivery is this platform's assumption everywhere; a redelivery that arrives
    // while the first create is still cloning must not produce a second container.
    const runId = randomUUID();
    const client = clientFor();
    const [a, b] = await Promise.all([
      client.createRun({ spec: specFor(runId), credential: credentialRequest }),
      client.createRun({ spec: specFor(runId), credential: credentialRequest }),
    ]);
    expect(a.handle).toEqual(b.handle);
    expect(createdRuns()).toEqual([runId]);
  });

  it('lets a run be created again after a create that failed', async () => {
    // A failed create left nothing behind (`LauncherService.startRun` destroys what it made), so
    // replaying the rejection for ever would park a task on a fault that has passed. The failure
    // is a real one: the credential source refuses, which is `startRun`'s first step.
    const runId = randomUUID();
    mintFails = true;
    await expect(
      clientFor().createRun({ spec: specFor(runId), credential: credentialRequest }),
    ).rejects.toMatchObject({ code: 'workspace_failed' });
    expect(createdRuns()).toEqual([]);
    mintFails = false;
    await expect(
      clientFor().createRun({ spec: specFor(runId), credential: credentialRequest }),
    ).resolves.toMatchObject({ replayed: false });
    expect(createdRuns()).toEqual([runId]);
  });

  it('refuses a spec that does not validate, by name and as a terminal failure', async () => {
    const response = await fetch(`http://127.0.0.1:${String(plane.port)}/v1/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ spec: { runId: 'not-a-uuid' }, credential: credentialRequest }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; detail: string | null } };
    expect(body.error.code).toBe('bad_request');
    expect(body.error.detail).not.toBeNull();
  });

  it('refuses a body larger than the bound, without buffering it', async () => {
    const response = await fetch(`http://127.0.0.1:${String(plane.port)}/v1/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: 'x'.repeat(launcherAdapters.CONTROL_PLANE_MAX_BODY_BYTES + 1_024),
    }).catch(() => null);
    // The connection is destroyed mid-body, so either a 400 arrives or the fetch fails — both are
    // the bound working, and asserting only the first would make the test depend on a race.
    expect(response === null || response.status === 400).toBe(true);
  });
});

describe('end', () => {
  it('destroys the workspace and clears the create record', async () => {
    const runId = randomUUID();
    const created = await clientFor().createRun({
      spec: specFor(runId),
      credential: credentialRequest,
    });
    const ended = await clientFor().endRun(runId, { handle: created.handle, export: null });
    expect(ended.failures).toEqual([]);
    expect(await clientFor().health()).toMatchObject({ runs: 0 });
  });

  it('refuses a handle that names a different run from the path', async () => {
    const runId = randomUUID();
    const created = await clientFor().createRun({
      spec: specFor(runId),
      credential: credentialRequest,
    });
    await expect(
      clientFor().endRun(randomUUID(), { handle: created.handle, export: null }),
    ).rejects.toMatchObject({ code: 'invalid_spec' });
  });

  it('succeeds for a run this process never created, because a launcher may have restarted', async () => {
    // The handle travels on the request precisely so that this works: the in-memory map is what
    // *this* process created, not a record of what is running.
    const runId = randomUUID();
    const created = await clientFor().createRun({
      spec: specFor(runId),
      credential: credentialRequest,
    });
    await clientFor().endRun(runId, { handle: created.handle, export: null });
    await expect(
      clientFor().endRun(runId, { handle: created.handle, export: null }),
    ).resolves.toMatchObject({ failures: [] });
  });
});

describe('routing', () => {
  it('answers a path it has no operation for with `not_found`', async () => {
    const response = await fetch(`http://127.0.0.1:${String(plane.port)}/v1/nope`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(404);
  });

  it('checks the token before it looks at the path, so an unknown path leaks nothing', async () => {
    const response = await fetch(`http://127.0.0.1:${String(plane.port)}/v1/nope`);
    expect(response.status).toBe(401);
  });
});
