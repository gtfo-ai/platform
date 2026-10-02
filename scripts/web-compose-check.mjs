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
 *      `app` under a project name of its own, on a host port the daemon chooses and the check reads
 *      back (`APP_PORT=0`, then `docker compose port`; PROGRESS backlog 348). **What that isolates,
 *      and what it does not** (WP-126, backlog 347): the containers, the volumes and — since
 *      `compose.yml` stopped pinning the default network's name — the default network
 *      (`<project>_default`), so this check's `app` resolves `db` to this check's database and to
 *      no other project's; `scripts/compose-isolation-check.mjs` asserts exactly that with two
 *      projects on one daemon. Not isolated: `agentic-run-egress`, which `compose.yml` names
 *      globally on purpose (the launcher is handed it by name); this check starts no launcher, so
 *      it never creates or joins it, but the stock check does;
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
 * runner's Node 22 (the mechanism is at `refuseOldNode`). A failed run prints the stage it was in,
 * then `compose ps` and the app container's last log lines, before the teardown. Since WP-126 the
 * deadlines, the Node guard and the backstop live in `scripts/compose-check-support.mjs`, shared
 * with the stock and isolation checks.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  boundedFetch,
  composeEnvironment,
  createStages,
  describeInstance,
  installExitBackstop,
  publishedPort,
  refuseOldNode,
  Unsettled,
  waitForOk,
} from './compose-check-support.mjs';

// `image.yml` sets up `.nvmrc`'s Node; this is the named refusal for a caller that did not.
refuseOldNode('web-compose-check');

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
 * This script is plain Node, run by `image.yml` with nothing installed, so importing a `.ts`
 * module would make an image job depend on type stripping and on the repository's `.js`
 * specifiers resolving. The copy is **pinned instead of trusted**:
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

/**
 * Compose's own interpolation (`composeEnvironment`): the daemon chooses the host port (backlog
 * 348), and the two globally named volumes get this project's names, so `down -v` can never name
 * a developer's `agentic-ctl`. `PLATFORM_TAG` names the image. The three values the *process*
 * reads go on the service, above.
 */
const ENV = { ...composeEnvironment(PROJECT), PLATFORM_TAG: TAG };

const compose = async (args) =>
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
      env: { ...process.env, ...ENV },
      maxBuffer: 64 * 1024 * 1024,
      timeout: TIMEOUT_MS,
    },
  );

/** What the check is waiting for right now, named in every failure it reports. */
const stages = createStages();
/** One request and its whole body, bounded. */
const get = (url, init) => boundedFetch(stages, url, init);

/**
 * The origin the instance is configured with, which is **not** the URL the check reaches it on.
 *
 * The daemon chooses the host port (`APP_PORT=0`) and the check reads it back once `app` is up,
 * so the port is unknown when the override is written. Nothing this check asserts depends on the
 * origin — every request is a `GET`, which the cross-site guard does not read — so it is a fixed,
 * reserved-domain value: an instance behind a reverse proxy is configured exactly this way.
 */
const BASE_URL = 'http://web-compose-check.example.test';

const main = async () => {
  try {
    const { stdout } = await run('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: 60_000,
    });
    console.log(`docker daemon ${stdout.trim()}`);
  } catch (error) {
    console.error(`FAIL: web-compose-check — no Docker daemon: ${String(error)}`);
    process.exit(1);
  }

  writeFileSync(
    OVERRIDE,
    [
      'services:',
      '  app:',
      '    environment:',
      `      APP_SECRET_KEY: ${SECRET_KEY}`,
      `      APP_BASE_URL: ${BASE_URL}`,
      '      LOG_LEVEL: warn',
      '',
    ].join('\n'),
    'utf8',
  );

  try {
    console.log(
      `${BUILD ? 'building and starting' : 'starting'} ${PROJECT} from platform:${TAG} …`,
    );
    stages.set('docker compose up');
    await compose(['up', '-d', ...(BUILD ? ['--build'] : []), 'app']);
    stages.set('docker compose port app 8080');
    const baseUrl = `http://127.0.0.1:${await publishedPort(compose)}`;
    console.log(`${PROJECT} publishes app on ${baseUrl}`);
    await waitForOk(stages, `${baseUrl}/healthz`);

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

    stages.set('reading index.html inside the container');
    const inImage = await compose(['exec', '-T', 'app', 'cat', '/app/apps/web/dist/index.html']);
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
    const where = error instanceof Unsettled ? '' : ` (while: ${stages.current})`;
    check('the instance came up and answered', false, `${String(error)}${where}`);
  } finally {
    if (failures.length > 0) {
      await describeInstance(compose);
    }
    stages.set('docker compose down');
    await compose(['down', '-v']).catch((error) => {
      console.error(`cleanup failed: ${String(error)}`);
    });
  }

  if (failures.length > 0) {
    console.error(`FAIL: web-compose-check (${failures.length}): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('PASS: web-compose-check');
};

// The backstop for a wait nothing bounded (`compose-check-support.mjs`).
const finished = installExitBackstop('web-compose-check', stages);
await main();
finished();
