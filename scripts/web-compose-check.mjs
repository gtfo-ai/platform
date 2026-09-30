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
 *
 * **A failure names its cause** (WP-118 follow-up). Every wait has a deadline on a *ref'd* timer, so
 * the event loop cannot empty under a pending `fetch` and end the process as an "unsettled
 * top-level await" (exit 13) that says nothing, which is how this check failed on CI twice, on the
 * runner's Node 22 (the mechanism is at {@link MINIMUM_NODE_MAJOR}). A failed run prints the stage
 * it was in, then `compose ps` and the app container's last log lines, before the teardown.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The repository's Node (`.nvmrc`, `engines`), refused below it rather than run on it.
 *
 * Node 22's bundled undici (6.28.1 in 22.23.3) compiles its HTTP parser asynchronously on the
 * process's **first** connection and attaches that socket's listeners only afterwards, so a peer
 * that closes the connection inside the window is never observed: the `fetch` stays pending with
 * no handle behind it and the process exits 13. `docker-proxy` closes exactly that connection:
 * the first `/healthz` probe, sent before the app listens. Measured with a server that closes on
 * accept: 11 of 20 fresh Node 22.23.3 processes exited 13, 0 of 20 on Node 24.21.0, whose undici
 * compiles the parser synchronously. `image.yml` now sets this Node up; this is the named refusal
 * for a caller that did not.
 */
const MINIMUM_NODE_MAJOR = 24;
if (Number(process.versions.node.split('.')[0]) < MINIMUM_NODE_MAJOR) {
  console.error(
    `FAIL: web-compose-check — Node ${process.versions.node} is below this repository's ` +
      `${MINIMUM_NODE_MAJOR} (.nvmrc): its fetch loses a first connection the peer closes early`,
  );
  process.exit(1);
}
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

/**
 * The configuration this check needs, as an override file of its own (WP-50).
 *
 * Until WP-50 these three values reached the container by *interpolation*: `compose.yml` wrote
 * `APP_SECRET_KEY: ${APP_SECRET_KEY:?…}` on the service, so exporting the variable was enough.
 * The service takes `env_file: .env` now — which is the fix, because a hand-written list silently
 * dropped twenty other names — and interpolation no longer reaches it. A check must not need a
 * `.env` in the checkout (BD-002 says one is never there), and it cannot move the project
 * directory either: this script **builds**, and the build context is the project directory.
 *
 * So it writes what it needs on the service. `environment:` wins over `env_file:`, so this also
 * restores the isolation `--env-file /dev/null` used to give on its own: a developer's `.env` can
 * no longer decide the secret, the origin or the log level this instance runs with.
 */
const OVERRIDE = path.join(
  mkdtempSync(path.join(tmpdir(), 'web-compose-check-')),
  'compose.web-check.yml',
);

const compose = async (args, env) =>
  run(
    'docker',
    // `--env-file /dev/null` rather than the default `.env`: this check measures the file in the
    // repository, not whatever a developer has in their working copy. Verified against Docker
    // Compose v5.5.1, which reads it as an empty environment rather than refusing it. Note it
    // bounds *interpolation* only — a service's own `env_file` is resolved against the project
    // directory and is unaffected, which is why the override above pins what matters.
    [
      'compose',
      '-p',
      PROJECT,
      '--env-file',
      '/dev/null',
      '-f',
      'compose.yml',
      '-f',
      OVERRIDE,
      ...args,
    ],
    {
      cwd: REPO,
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
      timeout: TIMEOUT_MS,
    },
  );

/** What the check is waiting for right now, named in every failure it reports. */
let stage = 'starting';

/** A wait that outlived its deadline: never "not ready yet", always a failure. */
class Unsettled extends Error {}

/**
 * `work()` within `ms`, or a rejection naming `what`.
 *
 * The timer is deliberately **ref'd**: it is what keeps the event loop alive under a promise that
 * nothing else is behind, so a wedged request is reported by name instead of the process ending
 * on an unsettled top-level await.
 */
const within = async (what, ms, work) => {
  stage = what;
  let timer;
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Unsettled(`${what} did not settle within ${ms / 1000} s`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const REQUEST_MS = 30_000;
/** One request and its whole body, bounded. */
const get = (url, init) =>
  within(`GET ${url}`, REQUEST_MS, async () => {
    const response = await fetch(url, init);
    return { response, body: await response.text() };
  });

/**
 * Waits for the container to answer its own liveness probe before anything is concluded.
 *
 * A probe that is *refused or closed* is the app not listening yet, and is tried again; a probe
 * that does not settle is not that, and fails the check by name rather than being retried.
 */
const waitForHealth = async (baseUrl) => {
  const deadline = Date.now() + 180_000;
  for (;;) {
    let answered;
    try {
      answered = await within(`GET ${baseUrl}/healthz (waiting for the app)`, 10_000, () =>
        fetch(`${baseUrl}/healthz`),
      );
    } catch (error) {
      if (error instanceof Unsettled) {
        throw error;
      }
      // refused or closed: not listening yet
    }
    await answered?.body?.cancel();
    if (answered?.ok) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`the app container never answered /healthz on ${baseUrl}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
};

/**
 * What the instance looked like when the check failed: every service's state (a dead app shows
 * its exit code there) and the app's last log lines. Best effort: it reports, it never decides.
 */
const describeInstance = async (env) => {
  for (const args of [
    ['ps', '--all'],
    ['logs', '--no-color', '--tail', '80', 'app'],
  ]) {
    try {
      const { stdout, stderr } = await compose(args, env);
      console.error(`--- docker compose ${args.join(' ')}\n${stdout}${stderr}`);
    } catch (error) {
      console.error(`--- docker compose ${args.join(' ')} failed: ${String(error)}`);
    }
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
  // `APP_PORT` and `PLATFORM_TAG` are still interpolation — they are read by compose itself, in
  // the port publisher and the image reference. The three the *process* reads go on the service.
  const env = { APP_PORT: String(port), PLATFORM_TAG: TAG };
  writeFileSync(
    OVERRIDE,
    [
      'services:',
      '  app:',
      '    environment:',
      `      APP_SECRET_KEY: ${SECRET_KEY}`,
      `      APP_BASE_URL: ${baseUrl}`,
      '      LOG_LEVEL: warn',
      '',
    ].join('\n'),
    'utf8',
  );

  try {
    console.log(
      `${BUILD ? 'building and starting' : 'starting'} ${PROJECT} from platform:${TAG} on ${baseUrl} …`,
    );
    stage = 'docker compose up';
    await compose(['up', '-d', ...(BUILD ? ['--build'] : []), 'app'], env);
    await waitForHealth(baseUrl);

    const { response: shell, body: shellBody } = await get(`${baseUrl}/`);
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

    stage = 'reading index.html inside the container';
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
      const { response } = await get(`${baseUrl}${asset}`);
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

    const { response: deepLink, body: deepBody } = await get(`${baseUrl}/projects/ACME/tasks/7`);
    check(
      'a deep link answers the shell',
      deepLink.status === 200 && deepBody === shellBody,
      `status ${deepLink.status}`,
    );

    const { response: version } = await get(`${baseUrl}/api/version`);
    check(
      'GET /api/version answers the API',
      version.status === 200 &&
        (version.headers.get('content-type') ?? '').includes('application/json'),
      `status ${version.status}, ${version.headers.get('content-type') ?? 'no content-type'}`,
    );

    const { response: missing, body: missingBody } = await get(
      `${baseUrl}/api/wp15j-no-such-endpoint`,
    );
    check(
      'an unserved /api path answers the JSON 404, not the shell',
      missing.status === 404 && missingBody.includes('"not_found"'),
      `status ${missing.status}, body ${missingBody.slice(0, 60)}`,
    );

    const { response: health, body: healthBody } = await get(`${baseUrl}/healthz`);
    check(
      'GET /healthz is untouched',
      health.status === 200 && healthBody.includes('"ok"'),
      `status ${health.status}`,
    );

    // What the image puts on the wire (review round 2). The subject is the **asset**, not the
    // shell: this bundle's `index.html` is ~721 bytes, below the 1 024-byte threshold both halves
    // of this origin use, so the shell is legitimately uncoded and the bytes worth measuring are
    // the ones the browser spends its download on. The decoded body is compared to the same file
    // fetched plainly, so a coding that dropped or altered a byte fails here, not in a browser
    // (`fetch` decodes the payload and keeps the header).
    if (asset !== undefined) {
      const { body: plain } = await get(`${baseUrl}${asset}`, {
        headers: { 'accept-encoding': 'identity' },
      });
      const { response: coded, body: codedBody } = await get(`${baseUrl}${asset}`, {
        headers: { 'accept-encoding': 'gzip' },
      });
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
    const where = error instanceof Unsettled ? '' : ` (while: ${stage})`;
    check('the instance came up and answered', false, `${String(error)}${where}`);
  } finally {
    if (failures.length > 0) {
      await describeInstance(env);
    }
    stage = 'docker compose down';
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

/**
 * The backstop for a wait nothing bounded: the loop emptied while `main()` was still pending. It
 * names the stage and exits 1 instead of Node's bare "unsettled top-level await" (exit 13). The
 * teardown cannot run from here, which `image.yml`'s `always` step covers.
 */
let finished = false;
process.on('beforeExit', () => {
  if (!finished) {
    console.error(
      `FAIL: web-compose-check — the event loop emptied while waiting on: ${stage} ` +
        '(an awaited promise had nothing behind it)',
    );
    process.exit(1);
  }
});
await main();
finished = true;
