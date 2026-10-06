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
import {
  describeStartFailure,
  RunStartError,
  silentLogger,
  WorkspaceError,
  type WorkspaceSpec,
} from '@platform/application';
import { RUNLET_PROTOCOL_VERSION } from '@platform/contracts';
import { launcher as launcherAdapters, workspace } from '@platform/infrastructure';
import { PLATFORM_SKILLS } from '@platform/prompts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bearerOf, type ControlPlane, startControlPlane, tokenMatches } from './control-plane.js';
import { LauncherService } from './service.js';

const TOKEN = 'FAKE-launcher-token-0000000000000000';
const SECRET = 'FAKE-carried';

let dir: string;
let provider: workspace.FakeWorkspaceProvider;
let service: LauncherService;
let plane: ControlPlane;

/** Flipped by the one case that needs a create to fail; reset in `beforeEach`. */
let mirrorFails = false;
/** What the failing mirror throws, when a case needs a particular refusal (WP-127). */
let mirrorFailure: WorkspaceError | null = null;
/**
 * Held by the WP-103 cases that need a create to be **in flight** when its request closes: the
 * provider's `create` waits on it, and `started` resolves once it has begun waiting.
 */
let createGate: { readonly wait: Promise<void>; readonly started: () => void } | null = null;

/**
 * The fake provider with one failure the launcher cannot refuse by schema: the mirror fetch.
 *
 * A subclass rather than a `Proxy` (the note on {@link createdRuns} says why). Until WP-76 this case
 * failed the create through the launcher's own credential source, which no longer exists — the
 * runner mints and the request carries the value — so the first real step that can fail is the
 * fetch the carried credential is for.
 */
class MirrorFailingProvider extends workspace.FakeWorkspaceProvider {
  override async updateMirror(
    input: Parameters<workspace.FakeWorkspaceProvider['updateMirror']>[0],
  ): ReturnType<workspace.FakeWorkspaceProvider['updateMirror']> {
    if (mirrorFails) {
      throw mirrorFailure ?? new WorkspaceError('workspace_failed', 'the mirror fetch failed');
    }
    return super.updateMirror(input);
  }

  override async create(
    spec: Parameters<workspace.FakeWorkspaceProvider['create']>[0],
  ): ReturnType<workspace.FakeWorkspaceProvider['create']> {
    if (createGate !== null) {
      createGate.started();
      await createGate.wait;
    }
    return super.create(spec);
  }
}

/** A gate for one create, and the two moments a case needs from it. */
const holdCreates = (): { begun: Promise<void>; release: () => void } => {
  let release = (): void => undefined;
  let begun = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const begunPromise = new Promise<void>((resolve) => {
    begun = resolve;
  });
  createGate = { wait, started: begun };
  return { begun: begunPromise, release };
};

/** Polls a condition the control plane reaches asynchronously, after a response it never wrote. */
const eventually = async (condition: () => boolean, what: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`never happened: ${what}`);
};

const clientFor = (token = TOKEN): launcherAdapters.LauncherControlClient =>
  launcherAdapters.createLauncherControlClient({
    baseUrl: `http://127.0.0.1:${String(plane.port)}`,
    token,
  });

const specFor = (runId: string, overrides: workspace.WorkspaceSpecOverrides = {}): WorkspaceSpec =>
  workspace.workspaceSpecFixture({
    runId,
    readOnly: false,
    ...overrides,
    // The credential's host must be one the run may reach (`createRunRequestSchema`).
    egress: { hosts: ['api.anthropic.com', 'vcs.example.com'], ...overrides.egress },
  });

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

/** What the runner mints and carries (WP-76) — obviously fake (BD-002). */
const credentialRequest = {
  host: 'vcs.example.com',
  username: 'oauth2',
  password: `${SECRET}-run-credential`,
  scope: 'push',
  expiresAt: '2026-09-11T00:00:00.000Z',
} as const;

beforeEach(async () => {
  mirrorFails = false;
  createGate = null;
  dir = await workspace.shortTempDir('agentic-control-plane-');
  provider = new MirrorFailingProvider({
    controlRoot: path.join(dir, 'ctl'),
    skills: PLATFORM_SKILLS,
  });
  service = new LauncherService({
    provider,
    broker: new workspace.RunCredentialBroker(silentLogger),
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
    expect(created.credentialScope).toBe('push');
    expect(created.replayed).toBe(false);
    expect(createdRuns()).toEqual([runId]);
  });

  /**
   * WP-74 criterion (5): a spec with no repository crosses the wire with no credential, the
   * launcher runs no mirror update and holds nothing, and the handle — `cacheKey: null` —
   * survives the create-then-end round trip unchanged through both ends' schemas.
   */
  it('creates and ends a workspace with no checkout, and its handle crosses the wire unchanged', async () => {
    const runId = randomUUID();
    // Even a writable spec: what decides the credential here is the missing repository, not
    // `readOnly` — a writing spec *with* a repository must carry one.
    const spec = { ...workspace.repoLessWorkspaceSpecFixture({ runId }), readOnly: false };
    const created = await clientFor().createRun({ spec, credential: null });
    expect(created.handle.cacheKey).toBeNull();
    expect(created.credentialScope).toBeNull();
    expect(provider.events.map((event) => event.kind)).toEqual(['create', 'attach']);
    const ended = await clientFor().endRun(runId, { handle: created.handle, export: null });
    expect(ended.failures).toEqual([]);
    // The end request's handle passed `endRunRequestSchema` on the launcher's side — a schema
    // that refused `cacheKey: null` would have answered `bad_request` — and reached `destroy`.
    expect(provider.events.map((event) => event.kind)).toEqual([
      'create',
      'attach',
      'stop',
      'remove',
    ]);
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
    // is a real one: the mirror fetch fails, which is `startRun`'s first provider step.
    const runId = randomUUID();
    mirrorFails = true;
    await expect(
      clientFor().createRun({ spec: specFor(runId), credential: credentialRequest }),
    ).rejects.toMatchObject({ code: 'workspace_failed' });
    expect(createdRuns()).toEqual([]);
    mirrorFails = false;
    await expect(
      clientFor().createRun({ spec: specFor(runId), credential: credentialRequest }),
    ).resolves.toMatchObject({ replayed: false });
    expect(createdRuns()).toEqual([runId]);
  });

  it('carries a refusal’s reason code and commit to the runner, so the task can name them (WP-127)', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    mirrorFails = true;
    mirrorFailure = new WorkspaceError('invalid_spec', 'refused, with words that stay here', {
      reason: 'checkout_commit_missing',
      commit: sha,
    });
    try {
      await expect(
        clientFor().createRun({ spec: specFor(randomUUID()), credential: credentialRequest }),
      ).rejects.toMatchObject({
        code: 'invalid_spec',
        reason: 'checkout_commit_missing',
        commit: sha,
      });
    } finally {
      mirrorFails = false;
      mirrorFailure = null;
    }
  });

  /**
   * WP-151 review round 1: a run image whose shim speaks another protocol than the requesting
   * runner is refused with **both numbers as integers** across the control plane — not only inside
   * the launcher's message, which the runner stores as untrusted words — so the run's
   * platform-written diagnosis names them, as it does for the shim's own refusal.
   */
  it('carries a run-image protocol refusal’s two numbers to the runner as integers, into the diagnosis (WP-151)', async () => {
    const runId = randomUUID();
    const other = RUNLET_PROTOCOL_VERSION + 1;
    const failure = await clientFor()
      .createRun({ spec: specFor(runId, { runletProtocol: other }), credential: credentialRequest })
      .then(() => null)
      .catch((error: unknown) => error as WorkspaceError);
    expect(failure).toBeInstanceOf(WorkspaceError);
    expect(failure).toMatchObject({
      code: 'invalid_spec',
      reason: 'runtime_image_protocol_mismatch',
      protocols: { runner: other, shim: RUNLET_PROTOCOL_VERSION },
    });
    expect(describeStartFailure(new RunStartError('x', { retryable: false, cause: failure }))).toBe(
      `RunStartError: invalid_spec, runtime_image_protocol_mismatch, runner protocol ${String(other)}, shim protocol ${String(RUNLET_PROTOCOL_VERSION)}`,
    );
    expect(createdRuns()).not.toContain(runId);
  });

  it('carries a failed helper’s redacted output tail to the runner (backlog 453)', async () => {
    const output = "mkdir: can't create directory '/ctl/run': Permission denied";
    mirrorFails = true;
    mirrorFailure = new WorkspaceError('workspace_failed', 'helper mirror-run exited 1', {
      detail: output,
      output: `${'line '.repeat(500)}${output}`,
    });
    try {
      const failure = await clientFor()
        .createRun({ spec: specFor(randomUUID()), credential: credentialRequest })
        .then(() => null)
        .catch((error: unknown) => error as WorkspaceError);
      expect(failure).toMatchObject({
        code: 'workspace_failed',
        message: 'helper mirror-run exited 1',
        outputTruncated: true,
      });
      expect(failure?.output?.endsWith(output)).toBe(true);
    } finally {
      mirrorFails = false;
      mirrorFailure = null;
    }
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

  it('carries an only-if-changed export to the workspace and its answer back (backlog 467)', async () => {
    const runId = randomUUID();
    const created = await clientFor().createRun({
      spec: specFor(runId),
      credential: credentialRequest,
    });
    const ended = await clientFor().endRun(runId, {
      handle: created.handle,
      export: {
        branch: 'agentic/task-1',
        commitMessage: 'wip: unfinished attempt 1 of implementation (error_max_turns)',
        tarball: false,
        onlyIfChanged: true,
      },
    });
    // Answered at all only because the flag crossed both hops; untouched, so nothing was pushed.
    expect(ended.exported).toMatchObject({ changed: false, pushed: false });
    expect(ended.keepUntil).toBeNull();
  });
});

/**
 * TD-028 decision 12 (WP-103, PROGRESS backlog 286): the read verb, destroy by run id, and a create
 * whose requester went away. "A restarted launcher" is a **second control plane** over the same
 * provider — a new process' empty idempotency map in front of the same daemon.
 */
describe('orphans (WP-103)', () => {
  const restart = async (): Promise<void> => {
    await plane.close();
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
  };

  it('lists the runs the provider labelled, read from the provider rather than from its memory', async () => {
    const runId = randomUUID();
    await clientFor().createRun({ spec: specFor(runId), credential: credentialRequest });
    await restart();
    // The restarted process remembers nothing — `runs` is the idempotency map's size — and still
    // answers the run, because the answer is the provider's (the daemon's, in production).
    expect(await clientFor().health()).toMatchObject({ runs: 0 });
    const listed = await clientFor().listRuns();
    expect(listed.runs.map((run) => run.runId)).toEqual([runId]);
    expect(listed.runs[0]?.running).toBe(true);
  });

  it('destroys a run it holds no handle for, by id alone, and a second destroy still succeeds', async () => {
    const runId = randomUUID();
    await clientFor().createRun({ spec: specFor(runId), credential: credentialRequest });
    await restart();
    await expect(clientFor().destroyRun(runId)).resolves.toEqual({ found: true });
    expect(provider.isRunning(runId)).toBe(false);
    expect(provider.events.filter((event) => event.runId === runId).map((e) => e.kind)).toEqual([
      'create',
      'attach',
      'stop',
      'remove',
    ]);
    expect((await clientFor().listRuns()).runs).toEqual([]);
    // Idempotent on the run id (decision 4): nothing left is a success, and nothing is stopped twice.
    await expect(clientFor().destroyRun(runId)).resolves.toEqual({ found: false });
    expect(provider.events.filter((event) => event.kind === 'remove')).toHaveLength(1);
  });

  it('refuses both verbs without the token, and destroys nothing', async () => {
    const runId = randomUUID();
    await clientFor().createRun({ spec: specFor(runId), credential: credentialRequest });
    const base = `http://127.0.0.1:${String(plane.port)}/v1/runs`;
    expect((await fetch(base)).status).toBe(401);
    const destroy = await fetch(`${base}/${runId}/destroy`, { method: 'POST', body: '{}' });
    expect(destroy.status).toBe(401);
    await expect(
      clientFor('FAKE-launcher-token-9999999999999999').listRuns(),
    ).rejects.toMatchObject({ code: 'invalid_spec' });
    expect(provider.isRunning(runId)).toBe(true);
  });

  it('refuses a destroy whose body carries anything, because a handle is not this verb’s input', async () => {
    const runId = randomUUID();
    await clientFor().createRun({ spec: specFor(runId), credential: credentialRequest });
    const response = await fetch(
      `http://127.0.0.1:${String(plane.port)}/v1/runs/${runId}/destroy`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ handle: { runId } }),
      },
    );
    expect(response.status).toBe(400);
    expect(provider.isRunning(runId)).toBe(true);
  });

  it('removes what a create made when its request closed before the answer (backlog 286 (b))', async () => {
    const runId = randomUUID();
    const gate = holdCreates();
    const aborted = new AbortController();
    const request = fetch(`http://127.0.0.1:${String(plane.port)}/v1/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ spec: specFor(runId), credential: credentialRequest }),
      signal: aborted.signal,
    }).catch(() => null);
    await gate.begun;
    // The runner's `AbortSignal.timeout`, in miniature: the client gives up while the launcher is
    // still creating.
    aborted.abort();
    expect(await request).toBeNull();
    // The client's promise rejects before the launcher's socket sees the close — measured here: a
    // create released on the same tick finished first and was answered to nobody, which is the
    // window the runner-side reaper covers. A real create runs for seconds past the timeout
    // (backlog 286 (b): the three measured ran on for about fifteen), so the case holds the create
    // long enough for the close to arrive; a slow close fails this case, it cannot pass it.
    await new Promise((resolve) => setTimeout(resolve, 250));
    gate.release();
    await eventually(
      () => provider.events.some((event) => event.runId === runId && event.kind === 'remove'),
      'the abandoned create’s workspace was removed',
    );
    expect(createdRuns()).toEqual([runId]);
    expect(provider.isRunning(runId)).toBe(false);
    expect((await clientFor().listRuns()).runs).toEqual([]);
  });

  it('keeps what a create made while a replay of it is still waiting for the answer', async () => {
    // The negative (standing rule 42): the first requester left, a redelivery of the same run did
    // not, so somebody will hold the handle and nothing is abandoned.
    const runId = randomUUID();
    const gate = holdCreates();
    const aborted = new AbortController();
    const first = fetch(`http://127.0.0.1:${String(plane.port)}/v1/runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ spec: specFor(runId), credential: credentialRequest }),
      signal: aborted.signal,
    }).catch(() => null);
    await gate.begun;
    aborted.abort();
    expect(await first).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const replay = clientFor().createRun({ spec: specFor(runId), credential: credentialRequest });
    // The replay must be parsed and waiting before the create is released, and nothing observable
    // says when it is; a late replay fails this case loudly (the fake refuses a second create of
    // one run id), it cannot pass it by accident.
    await new Promise((resolve) => setTimeout(resolve, 150));
    gate.release();
    await expect(replay).resolves.toMatchObject({ replayed: true });
    expect(provider.isRunning(runId)).toBe(true);
    expect(provider.events.some((event) => event.kind === 'remove')).toBe(false);
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
