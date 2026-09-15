#!/usr/bin/env node
/**
 * `node scripts/compose-stock-check.mjs` — WP-50's live half: the operator's own path, run.
 *
 * ## What it measures, and why a running instance is the only thing that can
 *
 * The defect this exists for is PROGRESS backlog **54**: `compose.yml` wrote the `app` service's
 * environment out by hand, so twenty of the names the server reads never reached the process, and
 * **a stock instance could not complete the product's front door**. `APP_INTEGRATION_SECRET_ENV`
 * sat in compose's environment, where it interpolated `${…}` in the file and nowhere else, so
 * `POST /api/integrations` refused every credential name with `secret_name_not_permitted …
 * (declared: none)` — a refusal that reads as the operator's mistake when it is the compose file's.
 *
 * `test/e2e/compose/compose-config.e2e.test.ts` asks `docker compose config` what the environment
 * resolves to and compares it with what `loadServerConfig` reads, in both directions. That is the
 * *arrangement*. This script is the *consequence*: a real instance, started the way
 * `docs/operator-guide.md` §2 starts one — `cp .env.example .env`, edit the values the guide names,
 * one `docker compose up`, **no override file** — which then creates an integration through the
 * API. Nothing client-side can answer that, because the thing that was broken was what the process
 * had in its environment.
 *
 * Four properties, each an operator-visible one:
 *
 *   1. one `docker compose up` on a stock `.env` reaches a **created integration** (201), while a
 *      credential variable the operator did not declare and a **host** the operator did not
 *      declare are each still refused 403, by name — so both allow-lists are applied rather than
 *      switched off. The host half is WP-51's and was added as a ci-fix: that row made
 *      `APP_INTEGRATION_HOSTS` empty-means-closed, this list did not learn it, and a stock
 *      instance stopped being able to create an integration at all — backlog 54's symptom,
 *      reopened one row after it was closed, and visible nowhere but here (rule 71);
 *   2. `printenv` inside the container shows the variables WP-23's dogfood run found missing;
 *   3. `/metrics` **can be authenticated**: 401 without the credential, 200 with it. Neither name
 *      was in the old eighteen-key map, so on a compose instance the endpoint was served
 *      unauthenticated and could not be made otherwise;
 *   4. an instance configured with only `APP_SECRET_KEY_FILE` **starts**. Until WP-50 compose
 *      refused it outright: `${APP_SECRET_KEY:?…}` fails on unset *or empty*, so doing what TD-020
 *      says with Docker secrets gave compose's own error instead of an instance.
 *
 * ## Why here and not in the e2e tier
 *
 * The same reason `scripts/web-compose-check.mjs` is a script: a `verify` target is run by CI's
 * lint and unit jobs, which have no daemon, and the e2e job has a daemon but **not these images** —
 * it builds `platform-runtime` and `platform-egress` only, and building `platform` (1.1 GB) plus
 * `platform-launcher` there would duplicate work `image.yml` already does on two architectures.
 * So this runs where the images exist: `.github/workflows/image.yml`, against the artefact that
 * workflow is about to publish. **A skip counts as a failure** (WP-22's precedent): with no daemon
 * or no image it exits 1 naming what is missing, rather than printing a green line about a
 * measurement nobody took.
 *
 * ## The project directory is a temporary one, and that is what makes it the operator's path
 *
 * Compose resolves both its interpolation `.env` and a service's `env_file` against the **project
 * directory**, so `--project-directory` puts a `.env` this script wrote where the operator's would
 * be, without writing into the checkout (which must never hold a `.env`, BD-002) and without an
 * override file of any kind. It implies `--no-build`: a build context would be the temporary
 * directory, so the images have to exist, which is exactly the arrangement `image.yml` calls this
 * in and is checked before anything starts.
 *
 * Usage:
 *   node scripts/compose-stock-check.mjs                     against `platform:dev`
 *   node scripts/compose-stock-check.mjs --tag ci            against images built as `:ci`
 *   node scripts/compose-stock-check.mjs --project-suffix x  a compose project of its own
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
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
const PROJECT = `agentic-stock-check-${optionValue('--project-suffix', process.env.GITHUB_RUN_ID ?? 'local')}`;
const TAG = optionValue('--tag', process.env.PLATFORM_TAG ?? 'dev');
const known = new Set(['--tag', '--project-suffix']);
const unknown = args.filter((argument) => argument.startsWith('--') && !known.has(argument));
if (unknown.length > 0) {
  console.error(
    `FAIL: compose-stock-check — unknown option(s): ${unknown.join(', ')}\n` +
      'usage: compose-stock-check.mjs [--tag <tag>] [--project-suffix <suffix>]',
  );
  process.exit(1);
}

/** Obviously fake, and past `APP_SECRET_KEY`'s 32-character floor (BD-002). */
const SECRET_KEY = 'wp50-compose-stock-check-not-a-real-secret-000';
const ADMIN_EMAIL = 'operator@example.test';
const ADMIN_PASSWORD = 'wp50-not-a-real-password';
const METRICS_USER = 'metrics';
const METRICS_PASSWORD = 'wp50-not-a-real-metrics-password';
const PROVIDER_TOKEN = 'wp50-not-a-real-sentry-token';
/**
 * The host the integration below is configured with, and therefore the one value this instance's
 * `APP_INTEGRATION_HOSTS` declares (WP-51).
 *
 * Spelled once because three things must agree: the `.env` line, the `base_url` of the
 * integration that must be **created**, and the `evil-` prefix of the one that must be
 * **refused**. Two of the three drifting apart is how this check would go quietly one-sided.
 */
const PROVIDER_HOST = 'sentry.example.test';
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
 * `.env.example` with a value set, the way an operator edits the file.
 *
 * In place rather than appended: a duplicate key in an env file is a rule nobody should have to
 * remember, and the guide tells an operator to *edit* the line that is already there.
 */
const withValue = (text, name, value) => {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  return pattern.test(text) ? text.replace(pattern, line) : `${text}\n${line}\n`;
};

/** A cookie jar and the two headers every mutating request needs (technical/08's cross-site guard). */
class Client {
  #baseUrl;
  #cookies = new Map();

  constructor(baseUrl) {
    this.#baseUrl = baseUrl;
  }

  async json(path, init = {}) {
    const cookie = [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        origin: this.#baseUrl,
        'x-requested-with': 'XMLHttpRequest',
        ...(cookie === '' ? {} : { cookie }),
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers ?? {}),
      },
      redirect: 'manual',
    });
    for (const raw of response.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const separator = pair?.indexOf('=') ?? -1;
      if (pair !== undefined && separator > 0) {
        this.#cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
    }
    const text = await response.text();
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      // A non-JSON body is kept as text; the caller reports it.
    }
    return { status: response.status, body };
  }
}

const main = async () => {
  try {
    const { stdout } = await run('docker', ['version', '--format', '{{.Server.Version}}']);
    console.log(`docker daemon ${stdout.trim()}`);
  } catch (error) {
    console.error(`FAIL: compose-stock-check — no Docker daemon: ${String(error)}`);
    process.exit(1);
  }

  // The images have to be on the daemon: this starts an instance rather than building one, so a
  // missing image is a failure that names the command, never a skip (WP-22, PROGRESS backlog 27).
  for (const image of [`platform:${TAG}`, `platform-launcher:${TAG}`]) {
    try {
      const { stdout } = await run('docker', ['image', 'inspect', image, '--format', '{{.Id}}']);
      console.log(`${image} ${stdout.trim()}`);
    } catch {
      console.error(
        `FAIL: compose-stock-check — ${image} is not on this daemon; ` +
          `build it with \`node scripts/build-images.mjs --tag ${TAG}\``,
      );
      process.exit(1);
    }
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const projectDirectory = await mkdtemp(path.join(tmpdir(), 'compose-stock-'));
  const compose = async (composeArgs, extraEnv = {}) =>
    run(
      'docker',
      [
        'compose',
        '-p',
        PROJECT,
        '--project-directory',
        projectDirectory,
        '-f',
        path.join(REPO, 'compose.yml'),
        ...composeArgs,
      ],
      {
        cwd: REPO,
        env: { ...process.env, PLATFORM_TAG: TAG, ...extraEnv },
        maxBuffer: 64 * 1024 * 1024,
        timeout: TIMEOUT_MS,
      },
    );

  const waitForHealth = async () => {
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
        const { stdout } = await compose(['logs', '--tail', '40', 'app']).catch(() => ({
          stdout: '',
        }));
        throw new Error(`the app container never answered /healthz on ${baseUrl}\n${stdout}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  };

  try {
    // ── The operator's own file: `cp .env.example .env`, then the values §2 names ──────────────
    const example = await readFile(path.join(REPO, '.env.example'), 'utf8');
    let env = example;
    for (const [name, value] of [
      ['APP_SECRET_KEY', SECRET_KEY],
      ['APP_BOOTSTRAP_ADMIN_EMAIL', ADMIN_EMAIL],
      ['APP_BOOTSTRAP_ADMIN_PASSWORD', ADMIN_PASSWORD],
      ['APP_BASE_URL', baseUrl],
      ['APP_PORT', String(port)],
      // §4's two lines: the credential under its tool-native name, and the allow-list that permits
      // it. Both were unreachable from `.env` before WP-50, which is the whole finding.
      ['SENTRY_AUTH_TOKEN', PROVIDER_TOKEN],
      ['APP_INTEGRATION_SECRET_ENV', 'SENTRY_AUTH_TOKEN'],
      /*
       * §4's **third** line, and the reason this script exists (WP-51 ci-fix).
       *
       * `APP_INTEGRATION_HOSTS` is the second operator-declared allow-list and it is empty — and
       * therefore closed — in `.env.example`, exactly as the credential one is. WP-51 added it and
       * this list did not learn it, so the row that closed backlog 48 reopened backlog 54's
       * symptom one row later: a stock instance answered `POST /api/integrations` with
       * `403 integration_host_not_permitted` and the image build went red on both architectures.
       * The value is the host the integration below is configured with, which is what §4 tells an
       * operator to declare — *the host of each integration you create*, not a wildcard, so the
       * negative case a few lines further down still has something to be refused by.
       */
      ['APP_INTEGRATION_HOSTS', PROVIDER_HOST],
      // §7's optional basic auth on /metrics.
      ['APP_METRICS_USERNAME', METRICS_USER],
      ['APP_METRICS_PASSWORD', METRICS_PASSWORD],
      ['LOG_LEVEL', 'warn'],
      // The two volumes `compose.yml` names **globally** rather than per project (the launcher
      // addresses `ctl` by the name the daemon knows, so a project prefix would break it). Left at
      // their defaults, this script's `down -v` would delete a developer's own `agentic-ctl`.
      ['APP_WORKSPACE_CONTROL_VOLUME', `${PROJECT}-ctl`],
      ['APP_WORKSPACE_CACHE_VOLUME', `${PROJECT}-repo-cache`],
    ]) {
      env = withValue(env, name, value);
    }
    await writeFile(path.join(projectDirectory, '.env'), env, 'utf8');

    console.log(`starting ${PROJECT} from platform:${TAG} on ${baseUrl} …`);
    await compose(['up', '-d', '--no-build']);
    await waitForHealth();

    const services = await compose(['ps', '-a', '--format', '{{.Service}} {{.State}}']);
    check(
      'one `docker compose up` brings the instance up',
      ['app', 'db', 'launcher', 'migrate', 'docker-socket-proxy'].every((service) =>
        services.stdout.includes(service),
      ),
      services.stdout.trim().replace(/\n/g, ' | '),
    );

    // 2. The environment inside the container — the measurement WP-23's dogfood run took by hand.
    const printenv = await compose([
      'exec',
      '-T',
      'app',
      'printenv',
      'APP_INTEGRATION_SECRET_ENV',
      'APP_METRICS_USERNAME',
      'APP_TRUST_PROXY',
      'APP_DB_POOL_MAX',
      'APP_SSE_BUFFER_SIZE',
      'SENTRY_AUTH_TOKEN',
      // Appended last on purpose: the two index assertions below read the first two values, and
      // `printenv` answers in argument order.
      'APP_INTEGRATION_HOSTS',
    ]).catch((error) => ({ stdout: String(error) }));
    const printed = printenv.stdout.trim().split('\n');
    check(
      'the container has the variables `.env` sets',
      printed.length === 7 &&
        printed[0] === 'SENTRY_AUTH_TOKEN' &&
        printed[1] === METRICS_USER &&
        printed[6] === PROVIDER_HOST,
      printed.length === 7 ? `${printed.length} of 7 present` : printenv.stdout.trim(),
    );

    // 3. /metrics can be authenticated.
    const anonymous = await fetch(`${baseUrl}/metrics`);
    check(
      'GET /metrics refuses an anonymous caller',
      anonymous.status === 401,
      `status ${anonymous.status}`,
    );
    const authorised = await fetch(`${baseUrl}/metrics`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${METRICS_USER}:${METRICS_PASSWORD}`).toString('base64')}`,
      },
    });
    check(
      'GET /metrics answers the credential `.env` set',
      authorised.status === 200,
      `status ${authorised.status}`,
    );

    // 1. A created integration, with no override file anywhere.
    const client = new Client(baseUrl);
    const signedIn = await client.json('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    check(
      'the bootstrap administrator can sign in',
      signedIn.status === 200,
      `status ${signedIn.status}`,
    );

    const created = await client.json('/api/integrations', {
      method: 'POST',
      headers: { 'idempotency-key': `wp50-stock-check-${port}` },
      body: JSON.stringify({
        type: 'errors',
        provider: 'sentry',
        name: 'stock check sentry',
        config: { organisation: 'acme', base_url: `https://${PROVIDER_HOST}` },
        secret_refs: { auth_token: 'SENTRY_AUTH_TOKEN' },
      }),
    });
    check(
      'POST /api/integrations creates one from a name declared in `.env`',
      created.status === 201,
      `status ${created.status}, ${JSON.stringify(created.body).slice(0, 160)}`,
    );

    // The positive above means nothing without this one (rule 42): the allow-list is applied, not
    // disabled — a name the operator did not declare is still refused, and by name.
    const refused = await client.json('/api/integrations', {
      method: 'POST',
      headers: { 'idempotency-key': `wp50-stock-check-forbidden-${port}` },
      body: JSON.stringify({
        type: 'errors',
        provider: 'sentry',
        name: 'stock check forbidden',
        config: { organisation: 'acme', base_url: `https://${PROVIDER_HOST}` },
        secret_refs: { auth_token: 'APP_SECRET_KEY' },
      }),
    });
    check(
      'an undeclared variable name is still refused 403, and no secret is in the refusal',
      refused.status === 403 && !JSON.stringify(refused.body).includes(SECRET_KEY),
      `status ${refused.status}, ${JSON.stringify(refused.body).slice(0, 160)}`,
    );

    /*
     * The same shape for the **host** allow-list (WP-51), and the host is an *adjacent* one.
     *
     * `evil.example.com` would be refused by any implementation and would prove nothing (standing
     * rule 43); `evil-<declared>` is refused only by exact matching, which is what the policy
     * claims to do. It is asserted **here**, against the image, because the unit and integration
     * tiers exercise the policy object and this is the only place that exercises the *instance*:
     * the list has to reach the process through `.env` before any of it is true, and the failure
     * that put this line here was exactly that — the policy worked and the variable was empty.
     */
    const refusedHost = await client.json('/api/integrations', {
      method: 'POST',
      headers: { 'idempotency-key': `wp51-stock-check-host-${port}` },
      body: JSON.stringify({
        type: 'errors',
        provider: 'sentry',
        name: 'stock check undeclared host',
        config: { organisation: 'acme', base_url: `https://evil-${PROVIDER_HOST}` },
        secret_refs: { auth_token: 'SENTRY_AUTH_TOKEN' },
      }),
    });
    const hostBody = JSON.stringify(refusedHost.body);
    check(
      'an undeclared host is refused 403 `integration_host_not_permitted`, naming the setting',
      refusedHost.status === 403 &&
        hostBody.includes('integration_host_not_permitted') &&
        hostBody.includes('APP_INTEGRATION_HOSTS'),
      `status ${refusedHost.status}, ${hostBody.slice(0, 160)}`,
    );

    // 4. TD-020's `_FILE` half, which compose used to refuse outright. The file goes on a named
    // volume rather than into the container's writable layer: `up` recreates the container when
    // its environment changes, and a `/tmp` file would go with it.
    const keyFile = path.join(projectDirectory, 'app_secret_key');
    await writeFile(keyFile, `${SECRET_KEY}\n`, 'utf8');
    await compose(['cp', keyFile, 'app:/var/lib/app/exports/app_secret_key']);
    let fileEnv = withValue(env, 'APP_SECRET_KEY', '');
    fileEnv = withValue(fileEnv, 'APP_SECRET_KEY_FILE', '/var/lib/app/exports/app_secret_key');
    await writeFile(path.join(projectDirectory, '.env'), fileEnv, 'utf8');
    await compose(['up', '-d', '--no-build']);
    await waitForHealth();
    const secretInEnv = await compose(['exec', '-T', 'app', 'printenv', 'APP_SECRET_KEY']).catch(
      () => ({ stdout: '' }),
    );
    const stillSignedIn = await new Client(baseUrl).json('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    check(
      'an instance configured with only APP_SECRET_KEY_FILE starts and signs a session',
      stillSignedIn.status === 200 && secretInEnv.stdout.trim() === '',
      `status ${stillSignedIn.status}, APP_SECRET_KEY in env: ${secretInEnv.stdout.trim() === '' ? 'no' : 'yes'}`,
    );
  } catch (error) {
    check('the instance came up and answered', false, String(error));
  } finally {
    await compose(['down', '-v', '--remove-orphans']).catch((error) => {
      console.error(`cleanup failed: ${String(error)}`);
    });
    await rm(projectDirectory, { recursive: true, force: true }).catch(() => {});
  }

  if (failures.length > 0) {
    console.error(`FAIL: compose-stock-check (${failures.length}): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('PASS: compose-stock-check');
};

await main();
