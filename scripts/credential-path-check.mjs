#!/usr/bin/env node
/**
 * `node scripts/credential-path-check.mjs` — **backlog 481's Docker check** (technical/05's
 * 2026-10-06 amendment): with the provider's `credential.useHttpPath` beside the helper, the
 * `platform-runtime` image's real `git` sends the repository path for `git ls-remote` and `git push`,
 * the run credential goes to the project's repository and nowhere else on the same host, and a
 * repository configuration or a `git -c` that switches the path off gets nothing.
 *
 * The work happens in one throwaway container (`credential-path-inner.mjs`, which says what is and
 * is not real); this process starts it with the repository mounted read-only and judges its one
 * JSON line. It uses the run image only for its `git`, `node` and `openssl` — the shim, the helper
 * and the broker run **from source** — so it measures this checkout without rebuilding an image.
 * Every token is obviously fake.
 *
 * Not a `verify` target, for the reason none of the Docker checks are: it needs a daemon.
 *
 *     node scripts/credential-path-check.mjs
 *
 * `WORKSPACE_E2E_RUNTIME_IMAGE` names the image (default `platform-runtime:dev`, as the e2e tier's).
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = process.env['WORKSPACE_E2E_RUNTIME_IMAGE'] ?? 'platform-runtime:dev';

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
};

let report = null;
try {
  const { stdout } = await execute(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      '1000:1000',
      // The stand-in git host listens on 443, so the helper sees a host with no port.
      '--sysctl',
      'net.ipv4.ip_unprivileged_port_start=0',
      '--add-host',
      'git.example.test:127.0.0.1',
      '--network',
      'bridge',
      '-v',
      `${REPO_ROOT}:/src:ro`,
      '--entrypoint',
      'node',
      IMAGE,
      '--import',
      '/src/scripts/ts-source-resolver.mjs',
      '/src/scripts/credential-path-inner.mjs',
    ],
    { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
  );
  report = JSON.parse(stdout.trim().split('\n').at(-1) ?? 'null');
} catch (error) {
  record('the check container ran', false, String(error?.message ?? error).slice(0, 600));
}

if (report !== null) {
  const carried = (prefix) =>
    report.requests.filter((request) => request.path.startsWith(prefix) && request.token);
  const asked = (prefix) => report.requests.filter((request) => request.path.startsWith(prefix));
  record(
    'the project’s repository: ls-remote and push each carried the run token once',
    carried('/acme/api.git/').length === 2,
    JSON.stringify(asked('/acme/api.git/')),
  );
  record(
    'another repository on the same host: asked five times, never with the run token',
    asked('/other/repo.git/').length === 5 && carried('/other/repo.git/').length === 0,
    JSON.stringify(asked('/other/repo.git/')),
  );
  record(
    'the broker refused each ask by reason — another repository four times, a missing path once',
    JSON.stringify([...report.refusals].sort()) ===
      JSON.stringify([
        'another_repository',
        'another_repository',
        'another_repository',
        'another_repository',
        'no_path',
      ]),
    JSON.stringify(report.refusals),
  );
  record('no log line carries the token', report.tokenInLog === false);
}

const failed = results.filter((result) => !result.ok);
process.stdout.write(
  `\n${failed.length === 0 ? 'PASS' : 'FAIL'}: credential-path-check (${results.length - failed.length}/${results.length} checks)\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
