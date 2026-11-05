/**
 * **The worker process around its runs** — WP-283 (1) and (3): the device login and the credential
 * file, the handshake, and the local listener (`/readyz`'s `core_handshake`, `POST /internal/drain`,
 * `GET /internal/state`), against a fake core that answers with the contract schemas.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  WORKER_PROTOCOL_VERSION,
  workerClaimRequestSchema,
  workerHandshakeRequestSchema,
} from '@platform/contracts';
import type { launcher as launcherAdapters } from '@platform/infrastructure';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { RemoteWorkerConfig } from './config.js';
import type { CoreFetch } from './core-client.js';
import { CREDENTIAL_FILE } from './credential.js';
import { type RemoteWorkerRuntime, startRemoteWorker } from './runtime.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'remote-worker-runtime-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const CLAUDE_TOKEN = 'FAKE-claude-oauth-token-wp283-runtime-000001';
const WORKER_ID = '00000000-0000-4000-8000-0000000283f1';
const CREDENTIAL = `wkr_${'a'.repeat(26)}_${'B'.repeat(43)}`;
const DIGEST = `sha256:${'c'.repeat(64)}`;
const DIGESTS = {
  platform: DIGEST,
  platform_launcher: DIGEST,
  platform_runtime: DIGEST,
  platform_egress: DIGEST,
};

const config = (stateDir: string): RemoteWorkerConfig => ({
  coreUrl: 'https://core.example.test',
  claudeToken: CLAUDE_TOKEN,
  launcherUrl: 'http://launcher:7780',
  launcherToken: 'FAKE-launcher-token-000000000000000000',
  controlRoot: scratch,
  stateDir,
  concurrency: 1,
  imageDigests: [DIGEST],
  host: '127.0.0.1',
  port: 0,
  logLevel: 'silent',
  commit: null,
});

const launcher = {
  health: async () => ({ images: { run: DIGEST, egress: DIGEST } }),
} as unknown as launcherAdapters.LauncherControlClient;

/** A core that approves the device code on the second poll and then answers 204 to every claim. */
const fakeCore = (
  options: {
    readonly handshake?: number;
    /** `true`: a claim holds until the worker calls it off, as the core's 25 s hold does. */
    readonly holdClaims?: boolean;
  } = {},
) => {
  const verbs: string[] = [];
  const bodies: string[] = [];
  let polls = 0;
  const fetch: CoreFetch = async (url, init) => {
    const verb = new URL(url).pathname.replace('/api/worker/v1/', '');
    verbs.push(verb);
    bodies.push(String(init.body ?? ''));
    const json = (status: number, body: unknown): Response =>
      new Response(body === null ? null : JSON.stringify(body), { status });
    switch (verb) {
      case 'device':
        return json(200, {
          device_code: 'D'.repeat(43),
          user_code: 'BCDF-GHJK',
          verification_uri: 'https://core.example.test/workers/approve',
          interval: 5,
          expires_in: 600,
        });
      case 'device/token':
        polls += 1;
        return polls === 1
          ? json(400, { error: 'slow_down' })
          : json(200, { worker_id: WORKER_ID, credential: CREDENTIAL });
      case 'handshake':
        workerHandshakeRequestSchema.parse(JSON.parse(String(init.body)));
        if (options.handshake === 401) {
          return json(401, { error: { code: 'unauthenticated', message: 'revoked' } });
        }
        return json(200, {
          protocol: { current: WORKER_PROTOCOL_VERSION, accepted: [WORKER_PROTOCOL_VERSION] },
          digests: DIGESTS,
          compose_bundle_digest: 'e'.repeat(64),
          worker: {
            id: WORKER_ID,
            name: 'alice-laptop',
            concurrency: 1,
            paused_until: null,
            paused_reason: null,
          },
          server_time: '2026-11-05T10:00:00.000Z',
        });
      case 'claims':
        workerClaimRequestSchema.parse(JSON.parse(String(init.body)));
        if (options.holdClaims === true) {
          await new Promise<never>((_, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            );
          });
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 20);
          init.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        return json(204, null);
      default:
        return json(404, { error: { code: 'not_found', message: verb } });
    }
  };
  return { fetch, verbs, bodies };
};

let worker: RemoteWorkerRuntime | undefined;
afterEach(async () => {
  await worker?.stop();
  worker = undefined;
});

const until = async (what: string, check: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 500; tries += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('the remote worker process (WP-283 (1), (3))', () => {
  it('logs in with the device flow, stores the credential 0600, handshakes, claims, and answers its local listener', async () => {
    const stateDir = mkdtempSync(path.join(scratch, 'state-'));
    const core = fakeCore();
    const waits: number[] = [];
    const lines: string[] = [];
    worker = await startRemoteWorker({
      config: { ...config(stateDir), logLevel: 'info' },
      coreFetch: core.fetch,
      launcher,
      logDestination: { write: (line: string) => lines.push(line) },
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const address = await worker.listen();
    expect((await fetch(`${address}/readyz`)).status).toBe(503);
    await until('the first claim', () => core.verbs.includes('claims'));

    // RFC 8628 §3.5: `slow_down` adds five seconds to the interval.
    expect(waits.slice(0, 2)).toEqual([5_000, 10_000]);
    const file = path.join(stateDir, CREDENTIAL_FILE);
    // The credential, and the core it belongs to on the second line (WP-294).
    expect(readFileSync(file, 'utf8')).toBe(`${CREDENTIAL}\nhttps://core.example.test\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // The code a person types is logged; the credential and the Claude token are not.
    expect(lines.join('\n')).toContain('BCDF-GHJK');
    expect(lines.join('\n')).not.toContain(CREDENTIAL);
    expect(lines.join('\n')).not.toContain(CLAUDE_TOKEN);
    expect(core.bodies.join('\n')).not.toContain(CLAUDE_TOKEN);
    // The claim reports the digests this worker holds (its pins and its launcher's images).
    const claim = workerClaimRequestSchema.parse(
      JSON.parse(core.bodies[core.verbs.indexOf('claims')] as string),
    );
    expect(claim).toEqual({ free_slots: 1, image_digests: [DIGEST], paused: false });

    const ready = await fetch(`${address}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      status: 'ok',
      checks: { core_handshake: 'ok', launcher: 'ok' },
    });

    const drained = await fetch(`${address}/internal/drain`, { method: 'POST' });
    expect(drained.status).toBe(202);
    const state = (await (await fetch(`${address}/internal/state`)).json()) as Record<
      string,
      unknown
    >;
    expect(state).toMatchObject({
      role: 'remote-worker',
      connection: 'connected',
      worker_id: WORKER_ID,
      worker_name: 'alice-laptop',
      draining: true,
      idle: true,
      runs: [],
    });
    const claimsAtDrain = core.verbs.filter((verb) => verb === 'claims').length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(core.verbs.filter((verb) => verb === 'claims').length).toBe(claimsAtDrain);
  });

  it('reports as held only what its launcher resolves locally: nothing until the images are pulled (backlog 704)', async () => {
    const stateDir = mkdtempSync(path.join(scratch, 'state-'));
    writeFileSync(path.join(stateDir, CREDENTIAL_FILE), `${CREDENTIAL}\n`, { mode: 0o600 });
    const core = fakeCore();
    let pulled = false;
    const RUN_ID_DIGEST = `sha256:${'d'.repeat(64)}`;
    worker = await startRemoteWorker({
      config: config(stateDir),
      coreFetch: core.fetch,
      launcher: {
        health: async () => ({
          images: pulled ? { run: RUN_ID_DIGEST, egress: RUN_ID_DIGEST } : null,
        }),
      } as unknown as launcherAdapters.LauncherControlClient,
      sleep: async () => {},
    });
    const claims = () =>
      core.verbs
        .map((verb, index) => (verb === 'claims' ? core.bodies[index] : null))
        .filter((body): body is string => body !== null)
        .map((body) => workerClaimRequestSchema.parse(JSON.parse(body)).image_digests);
    await until('a claim with nothing held', () => claims().length > 0);
    expect(claims()[0]).toEqual([]);
    pulled = true;
    await until('a claim after the pull', () => claims().some((held) => held.length > 0));
    // The pinned reference's registry digest and the daemon's id, both of the resolved images.
    expect(claims().find((held) => held.length > 0)).toEqual([DIGEST, RUN_ID_DIGEST]);
  });

  it('also holds every name its launcher reports the images by — ids and registry digests (S-22.14)', async () => {
    const stateDir = mkdtempSync(path.join(scratch, 'state-'));
    writeFileSync(path.join(stateDir, CREDENTIAL_FILE), `${CREDENTIAL}\n`, { mode: 0o600 });
    const core = fakeCore();
    const REGISTRY = `sha256:${'e'.repeat(64)}`;
    const ID = `sha256:${'f'.repeat(64)}`;
    worker = await startRemoteWorker({
      config: config(stateDir),
      coreFetch: core.fetch,
      launcher: {
        health: async () => ({
          images: { run: REGISTRY, egress: REGISTRY },
          heldImageDigests: [REGISTRY, ID],
        }),
      } as unknown as launcherAdapters.LauncherControlClient,
      sleep: async () => {},
    });
    const claims = () =>
      core.verbs
        .map((verb, index) => (verb === 'claims' ? core.bodies[index] : null))
        .filter((body): body is string => body !== null)
        .map((body) => workerClaimRequestSchema.parse(JSON.parse(body)).image_digests);
    await until('a claim', () => claims().length > 0);
    expect(claims()[0]).toEqual([DIGEST, REGISTRY, ID]);
  });

  describe('a launcher that does not answer at start is asked again (backlog 980)', () => {
    const claimedDigests = (core: ReturnType<typeof fakeCore>) =>
      core.verbs
        .map((verb, index) => (verb === 'claims' ? core.bodies[index] : null))
        .filter((body): body is string => body !== null)
        .map((body) => workerClaimRequestSchema.parse(JSON.parse(body)).image_digests);

    it.each([
      ['refuses the connection', 'refused'],
      ['accepts it and never answers', 'hangs'],
    ] as const)(
      'holds its images and claims once a launcher that %s at start answers',
      async (_, failure) => {
        const stateDir = mkdtempSync(path.join(scratch, 'state-'));
        writeFileSync(path.join(stateDir, CREDENTIAL_FILE), `${CREDENTIAL}\n`, { mode: 0o600 });
        // Every claim is held until the worker calls it off — the core's 25 s hold — so a claim
        // holding images can only follow from the launcher being asked again, not from the next cycle.
        const core = fakeCore({ holdClaims: true });
        const lines: string[] = [];
        let up = false;
        let probes = 0;
        const RUN = `sha256:${'d'.repeat(64)}`;
        worker = await startRemoteWorker({
          config: { ...config(stateDir), logLevel: 'info' },
          coreFetch: core.fetch,
          launcher: {
            health: async () => {
              probes += 1;
              if (!up) {
                if (failure === 'hangs') return new Promise<never>(() => {});
                throw new Error(
                  'the launcher control plane could not be reached at http://launcher:7780/v1/health',
                );
              }
              return { images: { run: RUN, egress: RUN } };
            },
          } as unknown as launcherAdapters.LauncherControlClient,
          logDestination: { write: (line: string) => lines.push(line) },
          launcherProbeTimeoutMs: 20,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
        });
        const address = await worker.listen();
        await until('a claim holding nothing', () => claimedDigests(core).length > 0);
        expect(claimedDigests(core)).toEqual([[]]);
        const ready = await fetch(`${address}/readyz`);
        expect(ready.status).toBe(503);
        expect(await ready.json()).toEqual({
          status: 'down',
          checks: { core_handshake: 'ok', launcher: 'unreachable' },
        });
        // Asked again with backoff while it does not answer, not once at start.
        await until('a re-probe', () => probes >= 3);

        up = true;
        await until('a claim holding the images', () =>
          claimedDigests(core).some((held) => held.length > 0),
        );
        expect(claimedDigests(core).at(-1)).toEqual([DIGEST, RUN]);
        const readyAgain = await fetch(`${address}/readyz`);
        expect(readyAgain.status).toBe(200);
        expect(await readyAgain.json()).toEqual({
          status: 'ok',
          checks: { core_handshake: 'ok', launcher: 'ok' },
        });
        // The outage is logged once when it starts and once when it ends — not once per probe.
        const said = (text: string) => lines.filter((line) => line.includes(text)).length;
        expect(said('did not answer its health check')).toBe(1);
        expect(said('answers its health check again')).toBe(1);
        // The called-off claim is not a failure: no backoff line for it.
        expect(said('a claim failed')).toBe(0);
      },
    );
  });

  it('says its launcher is not answering until it does, then takes work, with no restart (S-22.19, R-L3)', async () => {
    const stateDir = mkdtempSync(path.join(scratch, 'state-'));
    writeFileSync(path.join(stateDir, CREDENTIAL_FILE), `${CREDENTIAL}\n`, { mode: 0o600 });
    const core = fakeCore();
    let up = false;
    worker = await startRemoteWorker({
      config: config(stateDir),
      coreFetch: core.fetch,
      // A launcher that comes up after its worker (the self-update race).
      launcher: {
        health: async () => {
          if (!up) throw new Error('connect ECONNREFUSED launcher:7780');
          return { images: { run: DIGEST, egress: DIGEST } };
        },
      } as unknown as launcherAdapters.LauncherControlClient,
      launcherProbeTimeoutMs: 20,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    });
    await until('connected, its launcher refused', () => {
      const local = worker?.localState();
      return local?.connection === 'connected' && local.claim_blockers.length > 0;
    });
    expect(worker.localState().claim_blockers).toEqual(['launcher_unreachable']);
    up = true;
    await until(
      'the page says it takes work',
      () => worker?.localState().claim_blockers.length === 0,
    );
    expect(core.verbs.filter((verb) => verb === 'handshake')).toHaveLength(1);
    expect(worker.localState()).toMatchObject({ connection: 'connected', launcher: 'ok' });
  });

  it('names a hold, and another build’s images, in the local blockers (S-22.19)', async () => {
    const stateDir = mkdtempSync(path.join(scratch, 'state-'));
    writeFileSync(path.join(stateDir, CREDENTIAL_FILE), `${CREDENTIAL}\n`, { mode: 0o600 });
    const core = fakeCore();
    const OLD = `sha256:${'0'.repeat(64)}`;
    worker = await startRemoteWorker({
      config: { ...config(stateDir), imageDigests: [OLD] },
      coreFetch: core.fetch,
      launcher: {
        health: async () => ({ images: { run: OLD, egress: OLD } }),
      } as unknown as launcherAdapters.LauncherControlClient,
      sleep: async () => {},
    });
    const address = await worker.listen();
    await until('a claim', () => core.verbs.includes('claims'));
    expect(worker.localState().claim_blockers).toEqual(['images_outdated']);
    await fetch(`${address}/internal/drain`, { method: 'POST' });
    expect(worker.localState().claim_blockers).toEqual(['draining', 'images_outdated']);
  });

  it('reuses a stored credential, and stops claiming when the core refuses it (revoked)', async () => {
    const stateDir = mkdtempSync(path.join(scratch, 'state-'));
    const core = fakeCore({ handshake: 401 });
    writeFileSync(path.join(stateDir, CREDENTIAL_FILE), `${CREDENTIAL}\n`, { mode: 0o600 });
    worker = await startRemoteWorker({
      config: config(stateDir),
      coreFetch: core.fetch,
      launcher,
      sleep: async () => {},
    });
    const address = await worker.listen();
    await until('the handshake', () => worker?.state().connection === 'revoked');
    expect(core.verbs).not.toContain('device');
    expect(core.verbs).not.toContain('claims');
    const ready = await fetch(`${address}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({
      status: 'down',
      checks: { core_handshake: 'revoked', launcher: 'ok' },
    });
  });
});
