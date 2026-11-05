/**
 * **The worker bundle's healthchecks, run** — backlog 980 and 981, from the first self-update on Autix:
 *
 *  - `remote-worker` started a second before `launcher`, probed it, failed, and claimed nothing for
 *    seven minutes. The worker now asks again with backoff; the launcher has a healthcheck over its
 *    control plane's `GET /v1/health` (`docker compose ps`, the apply's `up --wait`), and
 *    `remote-worker` still starts on `service_started`, so its page comes up without a launcher;
 *  - `updater` inherited the `platform` image's `curl …/healthz` and was `unhealthy` for ever (a
 *    streak of 122): `ROLE=updater` serves no HTTP. It now writes a heartbeat file the check reads.
 *
 * Each check is read off the shipped template and **executed** with `sh` — the launcher's against a
 * local server that answers only the right bearer token, the updater's against a fresh, a stale and a
 * missing heartbeat — so a quoting slip in the YAML fails here rather than as an `unhealthy` worker.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HEARTBEAT_FILE, writeHeartbeat } from '../updater/heartbeat.js';
import { readWorkerComposeTemplate } from './compose.js';

const template = readWorkerComposeTemplate()?.text as string;
const scratch = mkdtempSync(path.join(tmpdir(), 'worker-healthchecks-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The block of one service: its lines up to the next service at the same indent. */
const service = (name: string): string => {
  const start = template.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = template.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z][a-z-]*:\n/);
  return end < 0 ? rest : rest.slice(0, end + 1);
};

/** A service's `CMD-SHELL` healthcheck as the shell receives it: folded, and compose's `$$` → `$`. */
const shellCheckOf = (name: string): string => {
  const block = service(name);
  const match = /\n {4}healthcheck:\n {6}test:\n {8}- CMD-SHELL\n((?: {8}.*\n| {10}.*\n)+)/.exec(
    block,
  );
  expect(match, `${name} has a CMD-SHELL healthcheck`).not.toBeNull();
  const lines = ((match as RegExpExecArray)[1] as string)
    .split('\n')
    .filter((line) => line.length > 0);
  const first = (lines[0] as string).trim();
  const command =
    first === '- >-'
      ? lines
          .slice(1)
          .map((line) => line.trim())
          .join(' ')
      : first.replace(/^- /, '');
  return command.replaceAll('$$', '$');
};

const sh = (command: string): number =>
  spawnSync('sh', ['-c', command], { encoding: 'utf8', timeout: 10_000 }).status ?? -1;

describe('the launcher’s healthcheck, and the worker beside it (backlog 980)', () => {
  it('starts remote-worker once the launcher has started, never waiting for it to be healthy', () => {
    // The page — the first-run wizard included — must come up when the launcher never gets healthy
    // and say so; the worker's re-probe closes the start-order window instead.
    const worker = service('remote-worker');
    expect(worker).toMatch(/\n {6}launcher:\n {8}condition: service_started\n/);
    expect(worker).not.toContain('service_healthy');
  });

  it('asks the control plane’s /v1/health with the launcher token, which is never in an argument', async () => {
    const check = shellCheckOf('launcher');
    const launcher = service('launcher');
    // The token file and the port are the launcher's own: its mounted token volume, its port.
    expect(launcher).toContain('launcher-token:/var/lib/platform/launcher-token:ro');
    expect(launcher).toContain('APP_LAUNCHER_PORT: 7780');
    expect(check).toContain('http://127.0.0.1:7780/v1/health');
    // The header goes in on stdin from the shell's own `printf`, so no process's argv carries it.
    expect(check).toMatch(/^printf 'Authorization: Bearer %s\\n' "\$\(cat [^)]+\)" \| curl /);
    expect(check).toContain('-H @-');

    const token = 'FAKE-launcher-token-backlog980-0000000000';
    const tokenFile = path.join(scratch, 'token');
    writeFileSync(tokenFile, `${token}\n`);
    const seen: (string | undefined)[] = [];
    let answer = 200;
    const server = createServer((request, response) => {
      seen.push(request.headers.authorization);
      const authorised = request.headers.authorization === `Bearer ${token}`;
      response.writeHead(
        request.url === '/v1/health' && authorised ? answer : authorised ? 404 : 401,
      );
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const local = check
      .replace('/var/lib/platform/launcher-token/token', tokenFile)
      .replace('127.0.0.1:7780', `127.0.0.1:${port}`);
    try {
      // `spawnSync` would block the thread this server answers on, so these run asynchronously.
      const run = (command: string) =>
        new Promise<number>((resolve) => {
          const child = spawn('sh', ['-c', command], { stdio: 'ignore' });
          child.on('exit', (code) => resolve(code ?? -1));
        });
      expect(await run(local)).toBe(0);
      expect(seen.at(-1)).toBe(`Bearer ${token}`);
      // A launcher that answers anything but 2xx is not healthy …
      answer = 503;
      expect(await run(local)).not.toBe(0);
      // … nor is one asked with the wrong token (the check reads the file, not a constant).
      answer = 200;
      writeFileSync(tokenFile, 'FAKE-some-other-token\n');
      expect(await run(local)).not.toBe(0);
      expect(seen.at(-1)).toBe('Bearer FAKE-some-other-token');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // And one that is not listening at all is not healthy.
    expect(sh(local)).not.toBe(0);
  });
});

describe('the updater’s healthcheck reads the heartbeat it writes (backlog 981)', () => {
  it('reads the heartbeat file in the updater’s own state directory', () => {
    const updater = service('updater');
    expect(updater).toContain('APP_UPDATE_STATE_DIR: /var/lib/platform/updates');
    expect(shellCheckOf('updater')).toContain(`/var/lib/platform/updates/${HEARTBEAT_FILE}`);
  });

  it('is healthy on a fresh beat, and unhealthy on a stale, a missing or a garbled one', async () => {
    const stateDir = mkdtempSync(path.join(scratch, 'updates-'));
    const check = shellCheckOf('updater').replace('/var/lib/platform/updates', stateDir);

    await writeHeartbeat(stateDir, new Date());
    expect(sh(check)).toBe(0);
    // A beat written two minutes ago is past its due second (three 30 s intervals).
    await writeHeartbeat(stateDir, new Date(Date.now() - 120_000));
    expect(sh(check)).not.toBe(0);
    writeFileSync(path.join(stateDir, HEARTBEAT_FILE), 'not a number\n');
    expect(sh(check)).not.toBe(0);
    rmSync(path.join(stateDir, HEARTBEAT_FILE));
    expect(sh(check)).not.toBe(0);
  });
});
