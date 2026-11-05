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
const fakeCore = (options: { readonly handshake?: number } = {}) => {
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
    expect(readFileSync(file, 'utf8').trim()).toBe(CREDENTIAL);
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
    expect(await ready.json()).toEqual({ status: 'ok', checks: { core_handshake: 'ok' } });

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
    expect(await ready.json()).toEqual({ status: 'down', checks: { core_handshake: 'revoked' } });
  });
});
