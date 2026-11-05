/**
 * **The worker's *Error reporting* setting** — WP-295 criterion (3), TD-023's 2026-11-05 amendment §3.
 *
 * A whole `startRemoteWorker` against a fake core (connected, so its id and credential are known),
 * its local page reached the way a browser reaches it, and the real SDK client with the SDK's own
 * transport hook recording each envelope — no network:
 *
 * - *Save* stores `sentry-dsn` `0600` and the next error line is sent there, with the worker's
 *   Claude token, `wkr_` credential and page token replaced and its id, platform and build tagged;
 *   *Send a test error* sends one; a second DSN receives the next event and the first nothing, with
 *   no restart; *Remove* turns it off.
 * - The setting holds the page's rules like every local write — `Host` (421), the bearer (401),
 *   `Origin` and JSON (403) — refuses a malformed DSN `422` without echoing it, and answers the DSN's
 *   host, never the DSN.
 * - `SENTRY_DSN` in the environment wins over a stored one: the page says so and *Save* and
 *   *Remove* answer `409`.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  WORKER_PROTOCOL_VERSION,
  workerLocalErrorReportingTestResponseSchema,
  workerLocalStateSchema,
} from '@platform/contracts';
import type { launcher as launcherAdapters } from '@platform/infrastructure';
import { createTransport } from '@sentry/node';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { ReportingTransport } from '../error-reporting.js';
import { loadRemoteWorkerConfig } from './config.js';
import type { CoreFetch } from './core-client.js';
import { CREDENTIAL_FILE } from './credential.js';
import { type RemoteWorkerRuntime, startRemoteWorker } from './runtime.js';
import { SENTRY_DSN_FILE } from './setup-files.js';
import { UI_TOKEN_FILE } from './ui-token.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'remote-worker-error-reporting-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// A DSN's public key, built at run time so the source holds no key-shaped literal.
const DSN_PUBLIC = '0123456789abcdef'.repeat(2);
const DSN_A = `https://${DSN_PUBLIC}@a.sentry.example.test/1`;
const DSN_B = `https://${DSN_PUBLIC}@b.sentry.example.test/2`;
const CLAUDE_TOKEN = 'FAKE-claude-oauth-token-wp295-worker-0001';
const WORKER_ID = '00000000-0000-4000-8000-000000000295';
// `wkr_<26 base32>_<43 base64url>` and the page's 43-character token, built at run time.
const CREDENTIAL = `wkr_${'a'.repeat(26)}_FAKE${'0'.repeat(39)}`;
const UI_TOKEN = `FAKE${'1'.repeat(39)}`;
const DIGEST = `sha256:${'c'.repeat(64)}`;
const PUBLISHED = 7357;
const HOST = `127.0.0.1:${PUBLISHED}`;

/** A core that handshakes the stored credential and answers every claim with nothing. */
const fakeCore = (): CoreFetch => async (url, init) => {
  const verb = new URL(url).pathname.replace('/api/worker/v1/', '');
  const json = (status: number, body: unknown): Response =>
    new Response(body === null ? null : JSON.stringify(body), { status });
  if (verb === 'handshake') {
    return json(200, {
      protocol: { current: WORKER_PROTOCOL_VERSION, accepted: [WORKER_PROTOCOL_VERSION] },
      digests: {
        platform: DIGEST,
        platform_launcher: DIGEST,
        platform_runtime: DIGEST,
        platform_egress: DIGEST,
      },
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
  }
  if (verb === 'claims') {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 20);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return json(204, null);
  }
  return json(404, { error: { code: 'not_found', message: verb } });
};

/** The SDK's transport hook, recording each serialised envelope and the host it was for. */
const recordingTransport = () => {
  const sent: { readonly host: string; readonly body: string }[] = [];
  const transport: ReportingTransport = (options) =>
    createTransport(options, async (request) => {
      sent.push({
        host: new URL(options.url).host,
        body:
          typeof request.body === 'string' ? request.body : new TextDecoder().decode(request.body),
      });
      return { statusCode: 200 };
    });
  return { sent, transport };
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

const start = async (options: {
  readonly sentryDsn?: string | null;
  readonly storedDsn?: string;
}) => {
  const stateDir = mkdtempSync(path.join(scratch, 'state-'));
  writeFileSync(path.join(stateDir, CREDENTIAL_FILE), `${CREDENTIAL}\n`, { mode: 0o600 });
  writeFileSync(path.join(stateDir, UI_TOKEN_FILE), `${UI_TOKEN}\n`, { mode: 0o600 });
  if (options.storedDsn !== undefined) {
    writeFileSync(path.join(stateDir, SENTRY_DSN_FILE), `${options.storedDsn}\n`, { mode: 0o600 });
  }
  const recorder = recordingTransport();
  worker = await startRemoteWorker({
    config: {
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
      logLevel: 'info',
      commit: 'abcdef1',
      version: '0.4.0',
      sentryDsn: options.sentryDsn ?? null,
      ui: {
        enabled: true,
        host: '127.0.0.1',
        listenPort: 0,
        publishedPort: PUBLISHED,
        auth: 'token',
      },
    },
    coreFetch: fakeCore(),
    launcher: {
      health: async () => ({ images: { run: DIGEST, egress: DIGEST } }),
    } as unknown as launcherAdapters.LauncherControlClient,
    logDestination: { write: () => undefined },
    webRoot: path.join(scratch, 'no-web-bundle'),
    sleep: async () => {},
    errorReportingTransport: recorder.transport,
  });
  await worker.listen();
  const running = worker;
  await until('the handshake', () => running.localState().connection === 'connected');
  const port = Number(new URL(running.uiAddress() ?? '').port);
  return { worker: running, recorder, stateDir, port };
};

/** One raw request, with the `Host` and headers a browser (or an attacker) would send. */
const request = (
  port: number,
  input: {
    readonly path: string;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
  },
): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(input.body ?? {});
    const outgoing = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: input.path,
        headers: {
          host: HOST,
          origin: `http://${HOST}`,
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
          authorization: `Bearer ${UI_TOKEN}`,
          ...input.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end(payload);
  });

const save = (port: number, dsn: string | null, headers: Record<string, string> = {}) =>
  request(port, { path: '/api/local/error-reporting', body: { dsn }, headers });

/** The envelopes that carry `marker` — so a line the worker logs on its own is never counted. */
const carrying = (sent: readonly { host: string; body: string }[], marker: string) =>
  sent.filter((entry) => entry.body.includes(marker));

describe('the worker’s Error reporting setting (WP-295 (3))', () => {
  it('saves a DSN, reports redacted and tagged, sends a test error, swaps DSNs without a restart, and removes', async () => {
    const { worker: running, recorder, stateDir, port } = await start({});
    expect(running.localState().error_reporting).toEqual({ source: null, host: null });

    const saved = await save(port, `  ${DSN_A} `);
    expect(saved.status).toBe(200);
    // The DSN's host is answered, never the DSN (it carries the project's key).
    expect(saved.text).not.toContain(DSN_PUBLIC);
    expect(workerLocalStateSchema.parse(JSON.parse(saved.text)).error_reporting).toEqual({
      source: 'file',
      host: 'a.sentry.example.test',
    });
    const file = path.join(stateDir, SENTRY_DSN_FILE);
    expect(readFileSync(file, 'utf8')).toBe(`${DSN_A}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // Every secret this worker holds, planted in an error line's message and stack.
    const error = new Error(`refused MARKER-1 ${CLAUDE_TOKEN} ${CREDENTIAL} ${UI_TOKEN}`);
    error.stack = `${error.message}\n    at ${CLAUDE_TOKEN} (/app/${CREDENTIAL}/${UI_TOKEN}.ts:1:1)`;
    running.logger.error({ err: error }, 'the core refused this worker');
    await running.errorReporter.flush();
    const [first] = carrying(recorder.sent, 'MARKER-1');
    expect(first?.host).toBe('a.sentry.example.test');
    for (const secret of [CLAUDE_TOKEN, CREDENTIAL, UI_TOKEN]) {
      expect(first?.body).not.toContain(secret);
    }
    expect(first?.body).toContain('[REDACTED:integration:claude_code_oauth_token_');
    const event = JSON.parse(first?.body.trim().split('\n').at(-1) ?? '{}') as {
      tags: Record<string, string>;
    };
    expect(event.tags).toEqual({
      role: 'remote-worker',
      worker_id: WORKER_ID,
      core_url: 'https://core.example.test',
      version: '0.4.0',
      commit: 'abcdef1',
    });

    const test = await request(port, { path: '/api/local/error-reporting/test' });
    expect(test.status).toBe(200);
    expect(workerLocalErrorReportingTestResponseSchema.parse(JSON.parse(test.text))).toMatchObject({
      delivered: true,
    });
    expect(carrying(recorder.sent, 'ErrorReportingTestError')).toHaveLength(1);

    // A second DSN, no restart: the next event goes there, and nothing more to the first.
    expect((await save(port, DSN_B)).status).toBe(200);
    running.logger.error({ err: new Error('MARKER-2') }, 'after the change');
    await running.errorReporter.flush();
    expect(carrying(recorder.sent, 'MARKER-2').map((entry) => entry.host)).toEqual([
      'b.sentry.example.test',
    ]);

    // *Remove*: off, the file gone, and the next error line sends nothing.
    const removed = await save(port, null);
    expect(removed.status).toBe(200);
    expect(workerLocalStateSchema.parse(JSON.parse(removed.text)).error_reporting).toEqual({
      source: null,
      host: null,
    });
    expect(() => statSync(file)).toThrow();
    running.logger.error({ err: new Error('MARKER-3') }, 'after the removal');
    expect(carrying(recorder.sent, 'MARKER-3')).toHaveLength(0);
    expect((await request(port, { path: '/api/local/error-reporting/test' })).status).toBe(409);
  });

  it('holds the page’s rules on both verbs and refuses a malformed DSN without echoing it', async () => {
    const { worker: running, stateDir, port } = await start({});
    const statuses = {
      host: (await save(port, DSN_A, { host: `evil.example.test:${PUBLISHED}` })).status,
      bearer: (await save(port, DSN_A, { authorization: 'Bearer nope' })).status,
      noOrigin: (await save(port, DSN_A, { origin: '' })).status,
      origin: (await save(port, DSN_A, { origin: 'http://evil.example.test' })).status,
      json: (await save(port, DSN_A, { 'content-type': 'text/plain' })).status,
      crossSite: (await save(port, DSN_A, { 'sec-fetch-site': 'cross-site' })).status,
      testHost: (
        await request(port, {
          path: '/api/local/error-reporting/test',
          headers: { host: `evil.example.test:${PUBLISHED}` },
        })
      ).status,
      testOrigin: (
        await request(port, {
          path: '/api/local/error-reporting/test',
          headers: { origin: 'http://evil.example.test' },
        })
      ).status,
    };
    expect(statuses).toEqual({
      host: 421,
      bearer: 401,
      noOrigin: 403,
      origin: 403,
      json: 403,
      crossSite: 403,
      testHost: 421,
      testOrigin: 403,
    });
    for (const refused of [
      `http://${DSN_PUBLIC}@sentry.example.test/1`,
      `https://${DSN_PUBLIC}:${DSN_PUBLIC}@sentry.example.test/1`,
      'not a dsn',
    ]) {
      const answer = await save(port, refused);
      expect(answer.status).toBe(422);
      expect(answer.text).not.toContain(DSN_PUBLIC);
      expect(JSON.parse(answer.text)).toMatchObject({ error: { code: 'invalid_dsn' } });
    }
    expect(
      (await request(port, { path: '/api/local/error-reporting', body: { dsn: 1 } })).status,
    ).toBe(400);
    // Nothing was stored by any refused request.
    expect(() => statSync(path.join(stateDir, SENTRY_DSN_FILE))).toThrow();
    expect(running.localState().error_reporting).toEqual({ source: null, host: null });
    expect(running.errorReporter.dsn()).toBeNull();
  });

  it('lets SENTRY_DSN in the environment win: the page says so, and Save and Remove answer 409', async () => {
    const { worker: running, recorder, port } = await start({ sentryDsn: DSN_A, storedDsn: DSN_B });
    expect(running.localState().error_reporting).toEqual({
      source: 'environment',
      host: 'a.sentry.example.test',
    });
    for (const dsn of [DSN_B, null]) {
      const answer = await save(port, dsn);
      expect(answer.status).toBe(409);
      expect(JSON.parse(answer.text)).toMatchObject({ error: { code: 'set_in_environment' } });
    }
    // *Send a test error* changes nothing, so it is offered: it goes to the environment's DSN.
    expect((await request(port, { path: '/api/local/error-reporting/test' })).status).toBe(200);
    expect(carrying(recorder.sent, 'ErrorReportingTestError').map((entry) => entry.host)).toEqual([
      'a.sentry.example.test',
    ]);
  });
});

describe('SENTRY_DSN on the worker (WP-295 (3))', () => {
  const env = {
    APP_LAUNCHER_URL: 'http://launcher:7780',
    APP_LAUNCHER_TOKEN: 'FAKE-launcher-token-000000000000000000',
    APP_WORKSPACE_CONTROL_ROOT: '/run/agentic/ctl',
  };
  it('is unset by default, canonical when set, and a malformed one refuses the start without echoing it', () => {
    expect(loadRemoteWorkerConfig(env).sentryDsn).toBeNull();
    expect(loadRemoteWorkerConfig({ ...env, SENTRY_DSN: ` ${DSN_A} ` }).sentryDsn).toBe(DSN_A);
    const refused = `http://${DSN_PUBLIC}@sentry.example.test/1`;
    expect(() => loadRemoteWorkerConfig({ ...env, SENTRY_DSN: refused })).toThrow(
      /SENTRY_DSN must be a Sentry DSN/,
    );
    try {
      loadRemoteWorkerConfig({ ...env, SENTRY_DSN: refused });
    } catch (error) {
      expect((error as Error).message).not.toContain(DSN_PUBLIC);
    }
  });
});
