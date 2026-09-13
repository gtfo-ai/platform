#!/usr/bin/env node
/**
 * `node scripts/web-compose-check.mjs` — the Docker half of WP-15j's verification.
 *
 * The row's last criterion is a statement about the **product image**, not about the router: that
 * `docker compose up` serves the SPA at `/` and the API under `/api` from one origin. Every other
 * criterion is asserted by a test tier against a directory a test created; this one can only be
 * measured by asking a running container for `/`, because what it really checks is that the path
 * `docker/app.Dockerfile` writes the bundle to is the path the process inside that image reads —
 * a mismatch no host-side test can see.
 *
 * It is deliberately **not** a `verify` target, for the reason `scripts/runlet-container-check.mjs`
 * is not: adding a step to `verify` adds it to CI's lint/unit jobs (`scripts/verify-targets.ts`),
 * and those have no daemon. **It is not therefore unrun**: `.github/workflows/image.yml` calls it
 * from the `build` job, on both architectures, against the `platform` image that job has just
 * built (`--tag ci --no-build`), with `down -v` in an `always` step — the same arrangement
 * `runlet-container-check.mjs` has in `ci.yml`, and the reason is the same (a check nothing runs
 * decays into a check nobody can run). A **skip counts as a failure** (WP-22's precedent): with no
 * daemon this exits 1 naming what is missing, rather than printing a green line about a
 * measurement nobody took.
 *
 * Usage:
 *   node scripts/web-compose-check.mjs                      build `platform:dev` and check it
 *   node scripts/web-compose-check.mjs --tag ci --no-build   check an image already built
 *   node scripts/web-compose-check.mjs --project-suffix pr7  a compose project of its own
 *
 * What it does, in order:
 *   1. builds `platform:${PLATFORM_TAG:-dev}` (unless `--no-build`) and starts `db`, `migrate` and
 *      `app` under a project name and a published port of its own, so two runs on one daemon — a
 *      developer's instance, or two CI jobs — cannot collide;
 *   2. compares the bytes of `GET /` with `/app/apps/web/dist/index.html` **inside the container**;
 *   3. follows the shell's own `<script src>` and asserts the asset is served with a JavaScript
 *      content type and a year-long cache;
 *   4. asserts a deep link answers the shell and that `/api/version`, an unserved `/api/…` path and
 *      `/healthz` answer as the API, never as HTML;
 *   5. asserts what the image puts **on the wire** — the hashed asset arrives `content-encoding:
 *      gzip` for a client that accepts it and decodes to the same bytes, `Vary` is declared, and
 *      the shell carries `x-frame-options` and the **whole** Content-Security-Policy, compared
 *      byte for byte (rounds 2 and 3). The asset rather than the shell for the coding assertion:
 *      this bundle's `index.html` is below the 1 024-byte coding threshold;
 *   6. `docker compose down -v`, always, including on a failure.
 */
import { execFile } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const optionValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
/**
 * A project name of its own per run.
 *
 * The default is the name a developer's second terminal would also choose, which is what makes a
 * collision visible instead of a silently shared instance; CI passes the run id, so two jobs of
 * one workflow — and two attempts of one job — never share containers, networks or volumes.
 */
const PROJECT = `agentic-web-check-${optionValue('--project-suffix', process.env.GITHUB_RUN_ID ?? 'local')}`;
const TAG = optionValue('--tag', process.env.PLATFORM_TAG ?? 'dev');
const BUILD = !args.includes('--no-build');
const known = new Set(['--tag', '--project-suffix', '--no-build']);
const unknown = args.filter((argument) => argument.startsWith('--') && !known.has(argument));
if (unknown.length > 0) {
  console.error(
    `FAIL: web-compose-check — unknown option(s): ${unknown.join(', ')}\n` +
      'usage: web-compose-check.mjs [--tag <tag>] [--no-build] [--project-suffix <suffix>]',
  );
  process.exit(1);
}
/**
 * The policy `apps/server/src/web/csp.ts` serves, copied rather than imported.
 *
 * This script is plain Node and the image workflow runs it on the runner's own interpreter, with
 * no Node version this repository pins, so importing a `.ts` module would make an image job depend
 * on type stripping being enabled there. The copy is **pinned instead of trusted**:
 * `apps/server/src/web/csp.test.ts` reads this file off disk and fails when the two differ.
 */
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
  "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; " +
  "frame-ancestors 'none'";

/** Obviously fake, and long enough for `APP_SECRET_KEY`'s 32-character floor. */
const SECRET_KEY = 'wp15j-web-compose-check-not-a-real-secret-0000';
const TIMEOUT_MS = 15 * 60 * 1000;

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) {
    failures.push(name);
  }
};

const freePort = async () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const compose = async (args, env) =>
  run(
    'docker',
    // `--env-file /dev/null` rather than the default `.env`: this check measures the file in the
    // repository, not whatever a developer has in their working copy. Verified against Docker
    // Compose v5.5.1, which reads it as an empty environment rather than refusing it.
    ['compose', '-p', PROJECT, '--env-file', '/dev/null', '-f', 'compose.yml', ...args],
    {
      cwd: REPO,
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
      timeout: TIMEOUT_MS,
    },
  );

/** Waits for the container to answer its own liveness probe before anything is concluded. */
const waitForHealth = async (baseUrl) => {
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      throw new Error(`the app container never answered /healthz on ${baseUrl}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
};

const main = async () => {
  try {
    const { stdout } = await run('docker', ['version', '--format', '{{.Server.Version}}']);
    console.log(`docker daemon ${stdout.trim()}`);
  } catch (error) {
    console.error(`FAIL: web-compose-check — no Docker daemon: ${String(error)}`);
    process.exit(1);
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    APP_PORT: String(port),
    APP_SECRET_KEY: SECRET_KEY,
    APP_BASE_URL: baseUrl,
    PLATFORM_TAG: TAG,
    LOG_LEVEL: 'warn',
  };

  try {
    console.log(
      `${BUILD ? 'building and starting' : 'starting'} ${PROJECT} from platform:${TAG} on ${baseUrl} …`,
    );
    await compose(['up', '-d', ...(BUILD ? ['--build'] : []), 'app'], env);
    await waitForHealth(baseUrl);

    const shell = await fetch(`${baseUrl}/`);
    const shellBody = await shell.text();
    check('GET / answers 200', shell.status === 200, `status ${shell.status}`);
    check(
      'GET / answers HTML',
      (shell.headers.get('content-type') ?? '').startsWith('text/html'),
      shell.headers.get('content-type') ?? 'no content-type',
    );
    check(
      'GET / is never cached long-term',
      (shell.headers.get('cache-control') ?? '').includes('no-cache'),
      shell.headers.get('cache-control') ?? 'no cache-control',
    );

    const inImage = await compose(
      ['exec', '-T', 'app', 'cat', '/app/apps/web/dist/index.html'],
      env,
    );
    check(
      'GET / is byte-for-byte the index.html in the image',
      inImage.stdout === shellBody,
      `${shellBody.length} bytes served, ${inImage.stdout.length} bytes in the image`,
    );

    const asset = /<script[^>]+src="([^"]+)"/.exec(shellBody)?.[1];
    check('the shell names a bundled script', asset !== undefined, asset ?? 'none found');
    if (asset !== undefined) {
      const response = await fetch(`${baseUrl}${asset}`);
      check(`GET ${asset} answers 200`, response.status === 200, `status ${response.status}`);
      check(
        `GET ${asset} is JavaScript`,
        (response.headers.get('content-type') ?? '').includes('javascript'),
        response.headers.get('content-type') ?? 'no content-type',
      );
      check(
        `GET ${asset} is immutable`,
        (response.headers.get('cache-control') ?? '').includes('immutable'),
        response.headers.get('cache-control') ?? 'no cache-control',
      );
    }

    const deepLink = await fetch(`${baseUrl}/projects/ACME/tasks/7`);
    const deepBody = await deepLink.text();
    check(
      'a deep link answers the shell',
      deepLink.status === 200 && deepBody === shellBody,
      `status ${deepLink.status}`,
    );

    const version = await fetch(`${baseUrl}/api/version`);
    check(
      'GET /api/version answers the API',
      version.status === 200 &&
        (version.headers.get('content-type') ?? '').includes('application/json'),
      `status ${version.status}, ${version.headers.get('content-type') ?? 'no content-type'}`,
    );

    const missing = await fetch(`${baseUrl}/api/wp15j-no-such-endpoint`);
    const missingBody = await missing.text();
    check(
      'an unserved /api path answers the JSON 404, not the shell',
      missing.status === 404 && missingBody.includes('"not_found"'),
      `status ${missing.status}, body ${missingBody.slice(0, 60)}`,
    );

    const health = await fetch(`${baseUrl}/healthz`);
    check(
      'GET /healthz is untouched',
      health.status === 200 && (await health.text()).includes('"ok"'),
      `status ${health.status}`,
    );

    // What the image puts on the wire (review round 2). The subject is the **asset**, not the
    // shell: this bundle's `index.html` is ~721 bytes, below the 1 024-byte threshold both halves
    // of this origin use, so the shell is legitimately uncoded and the bytes worth measuring are
    // the ones the browser spends its download on. The decoded body is compared to the same file
    // fetched plainly, so a coding that dropped or altered a byte fails here, not in a browser
    // (`fetch` decodes the payload and keeps the header).
    if (asset !== undefined) {
      const plain = await (
        await fetch(`${baseUrl}${asset}`, { headers: { 'accept-encoding': 'identity' } })
      ).text();
      const coded = await fetch(`${baseUrl}${asset}`, { headers: { 'accept-encoding': 'gzip' } });
      const codedBody = await coded.text();
      check(
        `GET ${asset} is gzipped for a client that accepts it, and decodes to the same bytes`,
        (coded.headers.get('content-encoding') ?? '') === 'gzip' && codedBody === plain,
        `content-encoding ${coded.headers.get('content-encoding') ?? 'none'}, ${codedBody.length} bytes decoded`,
      );
      check(
        `GET ${asset} declares Vary: accept-encoding`,
        (coded.headers.get('vary') ?? '').toLowerCase().includes('accept-encoding'),
        coded.headers.get('vary') ?? 'no vary',
      );
    }
    check(
      'GET / refuses to be framed and carries the whole policy',
      (shell.headers.get('x-frame-options') ?? '') === 'DENY' &&
        shell.headers.get('content-security-policy') === CONTENT_SECURITY_POLICY,
      `${shell.headers.get('x-frame-options') ?? 'no x-frame-options'}; ${
        shell.headers.get('content-security-policy') ?? 'no content-security-policy'
      }`,
    );
  } catch (error) {
    check('the instance came up and answered', false, String(error));
  } finally {
    await compose(['down', '-v'], env).catch((error) => {
      console.error(`cleanup failed: ${String(error)}`);
    });
  }

  if (failures.length > 0) {
    console.error(`FAIL: web-compose-check (${failures.length}): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('PASS: web-compose-check');
};

await main();
