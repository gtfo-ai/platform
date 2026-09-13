/**
 * A whole `apps/server` instance serves the browser application (WP-15j criterion 1).
 *
 * The unit tier drives `buildApp` with a web root handed to it. That proves the fallback works and
 * proves **nothing** about the composition root, where the row's real claim lives: that a process
 * started the way a container starts it — from an environment, through `loadServerConfig` and
 * `startRuntime` — reads `APP_WEB_ROOT` and serves what is there. Standing rule 35: making a
 * collaborator available proves it is supplied, not that it is used.
 *
 * `APP_WEB_ROOT` is set to a fixture this test writes rather than left at the bundled default,
 * because `apps/web/dist` exists only in a checkout where somebody has run the Vite build, and a
 * test whose subject appears and disappears with `pnpm bundle:check` asserts nothing on the run
 * where it is missing. The default itself is held to `docker/app.Dockerfile` by
 * `apps/server/src/web/bundle-path.test.ts`, and to the image by `scripts/web-compose-check.mjs`.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Instance, startInstance } from '../support/instance.js';

const SHELL = '<!doctype html><html lang="en"><body><div id="root"></div></body></html>\n';
/** Over the 1 024-byte coding threshold, so this file can also measure the bytes on the wire. */
const ASSET = `export const from = ${JSON.stringify('the bundle on disk '.repeat(120))};\n`;

let base: string;
let instance: Instance;

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'wp15j-e2e-'));
  mkdirSync(join(base, 'assets'), { recursive: true });
  writeFileSync(join(base, 'index.html'), SHELL);
  writeFileSync(join(base, 'assets', 'index-E2E00001.js'), ASSET);
  instance = await startInstance({ env: { APP_WEB_ROOT: base } });
}, 180_000);

afterAll(async () => {
  await instance?.stop();
  await rm(base, { recursive: true, force: true });
});

describe('the SPA on the same origin as the API', () => {
  it('answers / with the shell that is on disk', async () => {
    const response = await fetch(`${instance.baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe(SHELL);
  });

  it('answers a deep link with the same shell, so a reload does not 404', async () => {
    for (const path of ['/agents', '/projects/ACME/tasks/7', '/runs/abc', '/settings']) {
      const response = await fetch(`${instance.baseUrl}${path}`);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe(SHELL);
    }
  });

  it('serves the hashed asset the shell would ask for', async () => {
    const response = await fetch(`${instance.baseUrl}/assets/index-E2E00001.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(await response.text()).toBe(ASSET);
  });

  it('codes the asset on the wire and refuses to be framed', async () => {
    // The unit tier drives `buildApp`; this is the same property through a whole process started
    // from an environment — the composition root, a real socket and a real HTTP client (round 2).
    const response = await fetch(`${instance.baseUrl}/assets/index-E2E00001.js`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('vary')).toBe('accept-encoding');
    // `fetch` decodes the payload and keeps the header, so this compares the **decoded** bytes
    // with the file's: a coding that lost a byte fails here rather than in a browser.
    expect(await response.text()).toBe(ASSET);

    const shell = await fetch(`${instance.baseUrl}/`);
    expect(shell.headers.get('x-frame-options')).toBe('DENY');
    // Spelled out rather than imported from `csp.ts`, so a directive weakened there is a decision
    // somebody makes here too; the measurement that chose each one is that module's docblock, and
    // the browser-level proof that the bundle runs under it is `test/web-e2e/csp.spec.ts`.
    expect(shell.headers.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; " +
        "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; " +
        "form-action 'self'; frame-ancestors 'none'",
    );
  });

  it('leaves the API, the probes and the stream exactly as they were', async () => {
    const version = await fetch(`${instance.baseUrl}/api/version`);
    expect(version.status).toBe(200);
    expect(version.headers.get('content-type')).toContain('application/json');

    expect((await fetch(`${instance.baseUrl}/healthz`)).status).toBe(200);

    // An `/api/*` path no route serves still answers the JSON 404 the census classifies by.
    const missing = await fetch(`${instance.baseUrl}/api/wp15j-no-such-endpoint`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: 'not_found', message: 'no such endpoint' },
    });

    // …and a guarded endpoint still refuses an anonymous caller rather than answering with HTML.
    const guarded = await fetch(`${instance.baseUrl}/api/org/users`);
    expect(guarded.status).toBe(401);
  });
});
