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
 *   2. `printenv` inside the container shows the variables WP-23's dogfood run found missing,
 *      and — since WP-56, which gave them their first reader — the working calendar's;
 *   3. `/metrics` **can be authenticated**: 401 without the credential, 200 with it. Neither name
 *      was in the old eighteen-key map, so on a compose instance the endpoint was served
 *      unauthenticated and could not be made otherwise;
 *   4. an instance configured with only `APP_SECRET_KEY_FILE` **starts**. Until WP-50 compose
 *      refused it outright: `${APP_SECRET_KEY:?…}` fails on unset *or empty*, so doing what TD-020
 *      says with Docker secrets gave compose's own error instead of an instance;
 *   5. **the `runner` service is up on a stock `.env` and running no agent, and the `app` service
 *      is running no agent even when `.env` says otherwise** (WP-53, TD-028). Both halves are here
 *      for the reason WP-51's host case is: the *policy* is exercised by the unit tier, and the only
 *      thing that can say it reached the **process** is an instance. The negative half is the pin —
 *      `app` is pinned to no launcher, so an operator who puts the token in `.env` (which is exactly
 *      what the runner needs them to do) must not thereby make the API container subscribe
 *      `stage.execute` with no control volume to serve it from.
 *
 * ## Why here and not in the e2e tier
 *
 * The same reason `scripts/web-compose-check.mjs` is a script: a `verify` target is run by CI's
 * lint and unit jobs, which have no daemon, and the e2e job has a daemon but **not these images** —
 * it builds `platform-runtime` and `platform-egress` only, and building `platform` (801 MB since WP-82) plus
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
 * ## It ends, and says why (WP-126, PROGRESS backlog 349)
 *
 * The WP-118 follow-up gave `web-compose-check.mjs` deadlines after it died on CI with exit 13 and
 * no `FAIL:` line; this script had none of them. It now has the same shape, from
 * `scripts/compose-check-support.mjs`: a refusal below Node 24 naming `.nvmrc`; every HTTP call —
 * the health probe, every API step, both `/metrics` reads — bounded by a ref'd deadline that fails
 * naming the request; `docker version` and `docker image inspect` bounded too (every `docker
 * compose` call already was, by `execFile`'s timeout); on a failure, the stage it was in,
 * `compose ps --all` and the app's last log lines **before** the teardown; and a `beforeExit`
 * backstop for a wait nothing bounded. No retry was added.
 *
 * ## The port is the daemon's, and the origin is not the port (WP-126, backlog 348)
 *
 * `.env` says `APP_PORT=0`, so the daemon chooses the host port and the check reads it back with
 * `docker compose port app 8080` after **every** `up` — an `up` that changes `.env` recreates
 * `app`, and a recreated container gets a new ephemeral port. There is no override file for this:
 * `0` is a value an operator can write in `.env`, and compose accepts it (measured, Compose 2.38.2
 * and v5.5.1). The port being unknown before `up`, `APP_BASE_URL` cannot carry it, so it is a fixed
 * reserved-domain origin and the client sends that `Origin` while connecting to `127.0.0.1:<port>`
 * — which is an instance behind a TLS-terminating reverse proxy, the arrangement the operator
 * guide's §7 asks for (*"TLS is yours — put a reverse proxy in front"*).
 *
 * ## What is shared with another project on the daemon
 *
 * Since WP-126 the default network is the project's own (`<project>_default`), so this check's
 * `app` resolves `db` to this check's database. `agentic-run-egress` is **not** per project:
 * `compose.yml` names it globally because the launcher is handed it by name, and this check starts
 * a launcher, so it shares that network with any other instance's launcher on the daemon; no
 * `runner`, `app` or `db` is on it. `ctl` and `repo-cache` are given names of their own below.
 *
 * ## The `local`-mode leg (WP-133)
 *
 * After the stock instance is torn down, a second project (`<project>-lm`) is started the way the
 * product owner's first test starts one: `-f compose.yml -f compose.local.yml`, an obviously fake
 * `CLAUDE_CODE_OAUTH_TOKEN` and the launcher pair in `.env` — see {@link localLeg}. Its first run, on
 * an image of the tree before WP-133, **failed** (b): the runner logged *"composed without an agent
 * runner"* naming `CLAUDE_CODE_OAUTH_TOKEN` while its environment carried the token, because the
 * composition root dropped it. It also stops `runner`, `app` and `db` and holds each to the
 * `stop_grace_period` `compose.yml` gives it.
 *
 * Usage:
 *   node scripts/compose-stock-check.mjs                     against `platform:dev`, both legs
 *   node scripts/compose-stock-check.mjs --leg local         only the `local`-mode instance
 *   node scripts/compose-stock-check.mjs --tag ci            against images built as `:ci`
 *   node scripts/compose-stock-check.mjs --project-suffix x  a compose project of its own
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  boundedFetch,
  createStages,
  describeInstance,
  installExitBackstop,
  publishedPort,
  refuseOldNode,
  stopGracePeriodSeconds,
  Unsettled,
  waitForOk,
} from './compose-check-support.mjs';

// `image.yml` sets up `.nvmrc`'s Node; this is the named refusal for a caller that did not.
refuseOldNode('compose-stock-check');

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const optionValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const PROJECT = `agentic-stock-check-${optionValue('--project-suffix', process.env.GITHUB_RUN_ID ?? 'local')}`;
/** The `local`-mode leg's project (WP-133): a second instance, never the stock one reconfigured. */
const LOCAL_PROJECT = `${PROJECT}-lm`;
const TAG = optionValue('--tag', process.env.PLATFORM_TAG ?? 'dev');
/**
 * `--leg stock|local|all` (WP-133): which instance to start. `all`, the default, is what `image.yml`
 * runs — the stock instance, torn down, then the `local`-mode one.
 */
const LEG = optionValue('--leg', 'all');
const known = new Set(['--tag', '--project-suffix', '--leg']);
const unknown = args.filter((argument) => argument.startsWith('--') && !known.has(argument));
if (unknown.length > 0 || !['stock', 'local', 'all'].includes(LEG)) {
  console.error(
    `FAIL: compose-stock-check — unknown option(s): ${[...unknown, ...(['stock', 'local', 'all'].includes(LEG) ? [] : [`--leg ${LEG}`])].join(', ')}\n` +
      'usage: compose-stock-check.mjs [--tag <tag>] [--project-suffix <suffix>] [--leg stock|local|all]',
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
/**
 * TD-028's shared secret for the configured phase (WP-53). Obviously fake, and past the 32-character
 * floor both halves of the instance refuse below.
 */
const LAUNCHER_TOKEN = 'wp53-compose-stock-check-not-a-real-launcher-token';
/**
 * BD-004 `local` mode's credential for the WP-133 leg — **obviously fake** (standing rule 93: not the
 * shape `claude setup-token` prints). Nothing in this leg sends it anywhere: no run starts, so no
 * request reaches a model host. It is spelled here so the leg can look for it in every log line and
 * every row the instance wrote, and it is never printed — every check names it, none quotes it.
 */
const FAKE_OAUTH_TOKEN = 'FAKE-wp133-compose-oauth-token-not-a-credential';
/** `APP_RUN_REGISTRY_HOSTS` for this instance (WP-82): declared so the runner can be asked for it. */
const RUN_REGISTRY_HOST = 'registry.example.test';
const TIMEOUT_MS = 15 * 60 * 1000;
/** `docker version` and `docker image inspect`: a local daemon answers both in well under a second. */
const DOCKER_QUERY_MS = 60_000;
/**
 * The origin `.env` gives the instance (`APP_BASE_URL`), and the `Origin` every mutating request
 * carries — a reserved domain, never resolved: the check connects to the published port.
 */
const ORIGIN = 'http://compose-stock-check.example.test';

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) {
    failures.push(name);
  }
};

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

/** What the check is waiting for right now, named in every failure it reports. */
const stages = createStages();

/**
 * A cookie jar and the two headers every mutating request needs (technical/08's cross-site guard).
 * The `Origin` is the instance's configured one, {@link ORIGIN}; the URL is wherever the daemon
 * published it. Every request is bounded and named (`boundedFetch`).
 */
class Client {
  #baseUrl;
  #cookies = new Map();

  constructor(baseUrl) {
    this.#baseUrl = baseUrl;
  }

  async json(path, init = {}) {
    const cookie = [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const { response, body: text } = await boundedFetch(stages, `${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        origin: ORIGIN,
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
    let body = text;
    try {
      body = JSON.parse(text);
    } catch {
      // A non-JSON body is kept as text; the caller reports it.
    }
    return { status: response.status, body };
  }
}

/** The daemon and the two images, which both legs need before anything starts. */
const preflight = async () => {
  try {
    const { stdout } = await run('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: DOCKER_QUERY_MS,
    });
    console.log(`docker daemon ${stdout.trim()}`);
  } catch (error) {
    console.error(`FAIL: compose-stock-check — no Docker daemon: ${String(error)}`);
    process.exit(1);
  }

  // The images have to be on the daemon: this starts an instance rather than building one, so a
  // missing image is a failure that names the command, never a skip (WP-22, PROGRESS backlog 27).
  for (const image of [`platform:${TAG}`, `platform-launcher:${TAG}`]) {
    try {
      const { stdout } = await run('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], {
        timeout: DOCKER_QUERY_MS,
      });
      console.log(`${image} ${stdout.trim()}`);
    } catch {
      console.error(
        `FAIL: compose-stock-check — ${image} is not on this daemon; ` +
          `build it with \`node scripts/build-images.mjs --tag ${TAG}\``,
      );
      process.exit(1);
    }
  }
};

const stockLeg = async () => {
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

  /**
   * Where the daemon published `app` this time: re-read after every `up`, because an `up` that
   * changed `.env` recreates the container and a new container gets a new ephemeral port.
   */
  let baseUrl = '';
  const up = async () => {
    stages.set('docker compose up');
    await compose(['up', '-d', '--no-build']);
    stages.set('docker compose port app 8080');
    baseUrl = `http://127.0.0.1:${await publishedPort(compose)}`;
    console.log(`${PROJECT} publishes app on ${baseUrl}`);
    await waitForOk(stages, `${baseUrl}/healthz`);
  };

  try {
    // ── The operator's own file: `cp .env.example .env`, then the values §2 names ──────────────
    const example = await readFile(path.join(REPO, '.env.example'), 'utf8');
    let env = example;
    for (const [name, value] of [
      ['APP_SECRET_KEY', SECRET_KEY],
      ['APP_BOOTSTRAP_ADMIN_EMAIL', ADMIN_EMAIL],
      ['APP_BOOTSTRAP_ADMIN_PASSWORD', ADMIN_PASSWORD],
      ['APP_BASE_URL', ORIGIN],
      // The daemon chooses the host port (backlog 348); `up()` reads it back.
      ['APP_PORT', '0'],
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
      // WP-82: the run registry list, which the **runner** reads to build a run's egress list.
      ['APP_RUN_REGISTRY_HOSTS', RUN_REGISTRY_HOST],
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

    console.log(`starting ${PROJECT} from platform:${TAG} …`);
    await up();

    /*
     * The service list, **in both directions and with each one's state** — WP-53.
     *
     * It was `['app', …].every(s => stdout.includes(s))`, which is one-directional twice over: it
     * could not see a service that had been *added* (WP-53 added `runner`, and this line stayed
     * green), and it could not see one that was **restarting**. Both matter here: a `runner` that
     * crash-loops on a stock `.env` is exactly the shape of defect this script exists for, and a
     * substring test over a service list is precisely how it would hide.
     */
    const services = await compose(['ps', '-a', '--format', '{{.Service}} {{.State}}']);
    const state = new Map(
      services.stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const [service = '', ...rest] = line.trim().split(/\s+/);
          return [service, rest.join(' ')];
        }),
    );
    check(
      'one `docker compose up` brings up exactly the services `compose.yml` ships',
      [...state.keys()].sort().join(' ') === 'app db docker-socket-proxy launcher migrate runner',
      services.stdout.trim().replace(/\n/g, ' | '),
    );
    /*
     * A `restarting` verdict with nothing but the word in it costs whoever reads it a reproduction:
     * the container is gone by the time the check's `finally` has run, so its log is gone with it.
     * Measured — WP-53's first extended run reported `launcher restarting` and the reason (a blank
     * `APP_LAUNCHER_TOKEN` failing a `.min(1)` schema) had to be derived by hand. So the last lines
     * of every service that is not where it should be are read **before** the verdict.
     */
    const unhealthy = [...state]
      .filter(([service, value]) =>
        service === 'migrate' ? !value.startsWith('exited') : value !== 'running',
      )
      .map(([service]) => service);
    for (const service of unhealthy) {
      const { stdout } = await compose(['logs', '--tail', '20', '--no-log-prefix', service]).catch(
        () => ({ stdout: '(no log)' }),
      );
      console.error(`--- ${service} is not running; its last 20 lines ---\n${stdout}`);
    }
    check(
      'every long-lived service is running, and none is restarting',
      ['app', 'db', 'launcher', 'runner', 'docker-socket-proxy'].every(
        (service) => state.get(service) === 'running',
      ) &&
        // Prefix-matched, because a one-shot service's `.State` is `exited` on some daemon versions
        // and `exited (0)` on others; the long-lived ones are matched exactly, which is what makes
        // `restarting` a failure rather than a substring of something that passes.
        state.get('migrate')?.startsWith('exited') === true,
      [...state].map(([service, value]) => `${service} ${value}`).join(' | '),
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

    // 2a. WP-82: the run registry list reaches the process that builds a run's workspace spec —
    // `runner` — rather than only the compose arrangement `compose-config.e2e.test.ts` reads.
    const registry = await compose([
      'exec',
      '-T',
      'runner',
      'printenv',
      'APP_RUN_REGISTRY_HOSTS',
    ]).catch((error) => ({ stdout: String(error) }));
    check(
      'the runner container has the run registry list `.env` sets (WP-82)',
      registry.stdout.trim() === RUN_REGISTRY_HOST,
      registry.stdout.trim(),
    );

    // 2b. The working calendar reaches the process (WP-56). `APP_WORKING_DAYS`/`APP_WORKING_HOURS`
    // were shipped in `.env.example` from WP-05 and read by nothing; `loadServerConfig` reads them
    // now, and a stock `.env` must carry the documented values into the container, not blanks.
    const calendar = await compose([
      'exec',
      '-T',
      'app',
      'printenv',
      'APP_WORKING_DAYS',
      'APP_WORKING_HOURS',
    ]).catch((error) => ({ stdout: String(error) }));
    check(
      'the container has the working calendar `.env.example` documents',
      calendar.stdout.trim() === '1,2,3,4,5\n09:00-17:00',
      JSON.stringify(calendar.stdout.trim()),
    );

    // 3. /metrics can be authenticated.
    const { response: anonymous } = await boundedFetch(stages, `${baseUrl}/metrics`);
    check(
      'GET /metrics refuses an anonymous caller',
      anonymous.status === 401,
      `status ${anonymous.status}`,
    );
    const { response: authorised } = await boundedFetch(stages, `${baseUrl}/metrics`, {
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
      headers: { 'idempotency-key': `wp50-stock-check-${PROJECT}` },
      body: JSON.stringify({
        type: 'errors',
        provider: 'sentry',
        name: 'stock check sentry',
        config: { organization: 'acme', base_url: `https://${PROVIDER_HOST}` },
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
      headers: { 'idempotency-key': `wp50-stock-check-forbidden-${PROJECT}` },
      body: JSON.stringify({
        type: 'errors',
        provider: 'sentry',
        name: 'stock check forbidden',
        config: { organization: 'acme', base_url: `https://${PROVIDER_HOST}` },
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
      headers: { 'idempotency-key': `wp51-stock-check-host-${PROJECT}` },
      body: JSON.stringify({
        type: 'errors',
        provider: 'sentry',
        name: 'stock check undeclared host',
        config: { organization: 'acme', base_url: `https://evil-${PROVIDER_HOST}` },
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
    await up();
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

    /*
     * 5. **TD-028 decision 5 against the image** (WP-53), in both directions.
     *
     * *Stock:* `.env.example` ships both launcher variables empty and `compose.yml` pins neither on
     * the `runner` service, so a stock instance has no launcher on either container. The property
     * that matters is not "the variable is empty" — it is that the process **said so**: a worker
     * that composes no agent runner logs which piece is missing and subscribes neither
     * `stage.execute` nor `task.ask`. A container that is merely up proves nothing.
     *
     * *Configured:* the same `.env` with both variables set. The `runner` must now carry them, and
     * `app` must **still not** — that pin is the negative half, and it is the one an operator can
     * break by doing exactly what the guide tells them (putting the token in `.env`). It is the same
     * shape as the `evil-<host>` case above: the adjacent, plausible mistake, refused live.
     */
    const runnerStock = await compose([
      'exec',
      '-T',
      'runner',
      'printenv',
      'ROLE',
      'APP_WORKSPACE_CONTROL_ROOT',
    ]).catch((error) => ({ stdout: String(error) }));
    const runnerStockLines = runnerStock.stdout.trim().split('\n');
    check(
      'the runner service is the same image under ROLE=runner, with the control volume mounted',
      runnerStockLines[0] === 'runner' && runnerStockLines[1] === '/run/agentic/ctl',
      runnerStock.stdout.trim().replace(/\n/g, ' | '),
    );
    const runnerStockLog = await compose(['logs', '--no-log-prefix', 'runner']).catch(() => ({
      stdout: '',
    }));
    check(
      'on a stock `.env` the runner composes no agent runner and names what is missing',
      runnerStockLog.stdout.includes('composed without an agent runner') &&
        runnerStockLog.stdout.includes('APP_LAUNCHER_URL') &&
        runnerStockLog.stdout.includes('APP_LAUNCHER_TOKEN'),
      runnerStockLog.stdout
        .split('\n')
        .filter((line) => line.includes('agent runner'))
        .join(' | ')
        .slice(0, 240) || '(no such line)',
    );

    let configured = withValue(fileEnv, 'APP_LAUNCHER_URL', 'http://launcher:7780');
    configured = withValue(configured, 'APP_LAUNCHER_TOKEN', LAUNCHER_TOKEN);
    await writeFile(path.join(projectDirectory, '.env'), configured, 'utf8');
    await up();
    /*
     * `printenv NAME…` answers one line per name, **and the lines may be empty** — which is exactly
     * the case `app` is in, because WP-53 pins both names to the empty string there. So the trailing
     * newline is removed and nothing else is trimmed: `stdout.trim()` on an all-empty answer
     * collapses `"\n\n"` to `""` and splits to a **one**-element array, which read as "the second
     * variable is unset" when it is set and empty. Measured on the first run of this extension.
     */
    const printedLines = (stdout) => stdout.replace(/\n$/, '').split('\n');
    const configuredEnv = await Promise.all(
      ['runner', 'app'].map(async (service) =>
        compose(['exec', '-T', service, 'printenv', 'APP_LAUNCHER_URL', 'APP_LAUNCHER_TOKEN'])
          .then((result) => printedLines(result.stdout))
          // `printenv` exits non-zero only when a name is **unset**; both are set on both services.
          .catch(() => ['<unset>', '<unset>']),
      ),
    );
    const [runnerEnv = [], appEnv = []] = configuredEnv;
    check(
      'the runner carries the launcher URL and token `.env` set',
      runnerEnv[0] === 'http://launcher:7780' && runnerEnv[1] === LAUNCHER_TOKEN,
      `url ${runnerEnv[0] ?? '?'}, token ${runnerEnv[1] === LAUNCHER_TOKEN ? 'set' : (runnerEnv[1] ?? '?')}`,
    );
    check(
      'the app service still carries neither, so the API container takes no agent job',
      appEnv[0] === '' && appEnv[1] === '',
      `url ${JSON.stringify(appEnv[0] ?? null)}, token ${JSON.stringify(appEnv[1] ?? null)}`,
    );
    /*
     * The configured runner's own statement, **asserted as the absence of the refusal** rather than
     * as the presence of the confirmation.
     *
     * `composeRunWorkspaces` logs *"it provisions run workspaces through the launcher control
     * plane"* at **info**, and this instance runs at `LOG_LEVEL=warn` — the level the operator guide
     * tells an operator to run at, and therefore the level this check must measure at. So the
     * observable at warn is the **warning that is no longer emitted**: a process that composed an
     * agent runner does not log that it composed none. Paired with the environment assertion above
     * (which is the positive half), that is a statement about the process rather than about a
     * variable. Asserting the info line would have meant raising the log level for the check, which
     * would stop it being the operator's own instance.
     */
    const runnerLog = await compose(['logs', '--no-log-prefix', 'runner']).catch(() => ({
      stdout: '',
    }));
    check(
      'the configured runner no longer says it composed no agent runner',
      !runnerLog.stdout.includes('composed without an agent runner'),
      runnerLog.stdout
        .split('\n')
        .filter((line) => line.includes('agent runner'))
        .join(' | ')
        .slice(0, 240) || '(no such line, which is the assertion)',
    );
    const appLog = await compose(['logs', '--no-log-prefix', 'app']).catch(() => ({ stdout: '' }));
    check(
      'and the app service still says it composes none, with `.env` carrying the token',
      appLog.stdout.includes('composed without an agent runner'),
      appLog.stdout
        .split('\n')
        .filter((line) => line.includes('agent runner'))
        .join(' | ')
        .slice(0, 240) || '(no such line)',
    );
  } catch (error) {
    const where = error instanceof Unsettled ? '' : ` (while: ${stages.current})`;
    check('the instance came up and answered', false, `${String(error)}${where}`);
  } finally {
    if (failures.length > 0) {
      await describeInstance(compose);
    }
    stages.set('docker compose down');
    await compose(['down', '-v', '--remove-orphans']).catch((error) => {
      console.error(`cleanup failed: ${String(error)}`);
    });
    await rm(projectDirectory, { recursive: true, force: true }).catch(() => {});
  }
};

/**
 * WP-133's leg: **BD-004 `local` mode**, the arrangement the product owner's first run uses —
 * `docker compose -f compose.yml -f compose.local.yml up` with `CLAUDE_CODE_OAUTH_TOKEN` in `.env` and
 * the launcher configured — on a project of its own, from the same `.env.example`.
 *
 * Three properties, plus the stop graces WP-133 set (PROGRESS backlog 137 and WP-132's discovered
 * work), and none of them needs a model credential: the token is obviously fake and no run starts.
 *
 *   (a) `app`, `runner` and `launcher` are up — `app` and `runner` **healthy** by the image's own
 *       `HEALTHCHECK`, the launcher listening on its control plane;
 *   (b) the runner **composes an agent runner** — it says it provisions run workspaces through the
 *       launcher, it never says it composed none, and the launcher answers it — while `app` still
 *       composes none (the pin, under the override too);
 *   (c) a run's environment, built by the runner's own `agentRunEnvironment` from the runner's own
 *       configuration, carries the token **by name** — `CLAUDE_CODE_OAUTH_TOKEN`, and nothing else —
 *       and the token's value is in no service's log and in no row of the database.
 *
 * Then each of `runner`, `app` and `db` is stopped the way an upgrade stops it, and must exit 0
 * inside the `stop_grace_period` `compose.yml` gives it — never the daemon's kill (exit 137).
 *
 * The leg runs at `LOG_LEVEL=info`, unlike the stock leg: (b)'s positive line is an `info` line, and
 * (c)'s "in no log" is a stronger statement over the more verbose log.
 */
const localLeg = async () => {
  const projectDirectory = await mkdtemp(path.join(tmpdir(), 'compose-local-'));
  const compose = async (composeArgs) =>
    run(
      'docker',
      [
        'compose',
        '-p',
        LOCAL_PROJECT,
        '--project-directory',
        projectDirectory,
        '-f',
        path.join(REPO, 'compose.yml'),
        '-f',
        path.join(REPO, 'compose.local.yml'),
        ...composeArgs,
      ],
      {
        cwd: REPO,
        env: { ...process.env, PLATFORM_TAG: TAG },
        maxBuffer: 64 * 1024 * 1024,
        timeout: TIMEOUT_MS,
      },
    );
  const failedBefore = failures.length;
  try {
    const example = await readFile(path.join(REPO, '.env.example'), 'utf8');
    let env = example;
    for (const [name, value] of [
      ['APP_SECRET_KEY', SECRET_KEY],
      ['APP_BOOTSTRAP_ADMIN_EMAIL', ADMIN_EMAIL],
      ['APP_BOOTSTRAP_ADMIN_PASSWORD', ADMIN_PASSWORD],
      ['APP_BASE_URL', ORIGIN],
      ['APP_PORT', '0'],
      ['LOG_LEVEL', 'info'],
      // The runner's two halves, as `.env.example` names them for this topology.
      ['APP_LAUNCHER_URL', 'http://launcher:7780'],
      ['APP_LAUNCHER_TOKEN', LAUNCHER_TOKEN],
      // `compose.local.yml`'s `:?` refuses to resolve without it.
      ['CLAUDE_CODE_OAUTH_TOKEN', FAKE_OAUTH_TOKEN],
      ['APP_WORKSPACE_CONTROL_VOLUME', `${LOCAL_PROJECT}-ctl`],
      ['APP_WORKSPACE_CACHE_VOLUME', `${LOCAL_PROJECT}-repo-cache`],
    ]) {
      env = withValue(env, name, value);
    }
    await writeFile(path.join(projectDirectory, '.env'), env, 'utf8');

    console.log(`starting ${LOCAL_PROJECT} (local mode) from platform:${TAG} …`);
    stages.set('docker compose up (local mode)');
    await compose(['up', '-d', '--no-build']);
    stages.set('docker compose port app 8080 (local mode)');
    const baseUrl = `http://127.0.0.1:${await publishedPort(compose)}`;
    console.log(`${LOCAL_PROJECT} publishes app on ${baseUrl}`);
    await waitForOk(stages, `${baseUrl}/healthz`);

    // (a) The image's `HEALTHCHECK` (`curl /healthz`, every 15 s after a 20 s start period) is what
    // `docker compose ps` reports; it is polled, bounded, rather than read once.
    const readStates = async () => {
      const { stdout } = await compose([
        'ps',
        '-a',
        '--format',
        '{{.Service}}|{{.State}}|{{.Health}}',
      ]);
      return new Map(
        stdout
          .trim()
          .split('\n')
          .filter((line) => line.includes('|'))
          .map((line) => {
            const [service = '', state = '', health = ''] = line.trim().split('|');
            return [service, { state, health }];
          }),
      );
    };
    stages.set('waiting for app and runner to report healthy (local mode)');
    let states = await readStates();
    const deadline = Date.now() + 120_000;
    while (
      Date.now() < deadline &&
      !['app', 'runner'].every((service) => states.get(service)?.health === 'healthy')
    ) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      states = await readStates();
    }
    const describe = [...states]
      .map(
        ([service, value]) =>
          `${service} ${value.state}${value.health === '' ? '' : ` (${value.health})`}`,
      )
      .join(' | ');
    const launcherLog = await compose(['logs', '--no-color', '--no-log-prefix', 'launcher']).catch(
      () => ({ stdout: '' }),
    );
    check(
      'local mode: app and runner are healthy by the image’s own healthcheck, and the launcher is listening (WP-133 a)',
      states.get('app')?.health === 'healthy' &&
        states.get('runner')?.health === 'healthy' &&
        states.get('launcher')?.state === 'running' &&
        launcherLog.stdout.includes('the launcher control plane is listening'),
      describe,
    );

    // (b) The runner's own statement at info, and the absence of the refusal.
    const runnerLog = await compose(['logs', '--no-color', '--no-log-prefix', 'runner']).catch(
      () => ({
        stdout: '',
      }),
    );
    check(
      'local mode: the runner composes an agent runner — it provisions through the launcher and never says it composed none (WP-133 b)',
      runnerLog.stdout.includes('this process runs agent stages') &&
        !runnerLog.stdout.includes('composed without an agent runner'),
      runnerLog.stdout
        .split('\n')
        .filter((line) => line.includes('agent runner') || line.includes('runs agent stages'))
        .map((line) => line.slice(0, 160))
        .join(' | ') || '(no such line)',
    );
    const appLog = await compose(['logs', '--no-color', '--no-log-prefix', 'app']).catch(() => ({
      stdout: '',
    }));
    check(
      'local mode: the app service still composes none, under the override too',
      appLog.stdout.includes('composed without an agent runner'),
      appLog.stdout.includes('composed without an agent runner') ? 'it says so' : '(no such line)',
    );

    /*
     * (c) The run environment **the runner process builds**: the image's own `loadServerConfig` over
     * the container's own environment, and the server's own `agentRunEnvironment` over that — the
     * one function that decides what a run container is given (`apps/server/src/agent.ts`). It
     * prints names and booleans only; the value is compared inside the container, never printed.
     * The same probe asks the launcher's health through the runner's own client and configuration,
     * so (b) is also a request that crossed the `launcher-api` network and its token check.
     */
    const probe = [
      "const { loadServerConfig } = await import('/app/apps/server/src/config.ts');",
      "const { agentRunEnvironment } = await import('/app/apps/server/src/agent.ts');",
      "const { launcher } = await import('/app/packages/infrastructure/src/index.ts');",
      'const config = loadServerConfig(process.env);',
      'const run = agentRunEnvironment(config);',
      'const quiet = { debug() {}, info() {}, warn() {}, error() {} };',
      "let health = 'not asked';",
      'try {',
      '  await launcher.createLauncherControlClient({ baseUrl: config.launcherUrl, token: config.launcherToken, logger: quiet }).health();',
      "  health = 'ok';",
      '} catch (error) {',
      "  health = `refused: ${error?.code ?? error?.name ?? 'error'}`;",
      '}',
      'const token = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";',
      'process.stdout.write(JSON.stringify({',
      '  provider_mode: config.providerMode,',
      '  env_names: Object.keys(run.env),',
      '  secret_env_names: run.secretEnvNames,',
      '  value_is_the_container_token: token.length > 0 && run.env.CLAUDE_CODE_OAUTH_TOKEN === token,',
      "  api_key_blank: (process.env.ANTHROPIC_API_KEY ?? '') === '',",
      '  launcher: health,',
      '}));',
    ].join('\n');
    stages.set('the run-environment probe in the runner (local mode)');
    const probed = await compose([
      'exec',
      '-T',
      'runner',
      'node',
      '--import',
      './scripts/ts-source-resolver.mjs',
      '--input-type=module',
      '-e',
      probe,
    ]).catch((error) => ({ stdout: '', stderr: String(error) }));
    let answer = null;
    try {
      answer = JSON.parse(probed.stdout.trim().split('\n').at(-1) ?? '');
    } catch {
      // Reported below, from what the probe printed.
    }
    check(
      'local mode: a run’s environment carries CLAUDE_CODE_OAUTH_TOKEN by name and nothing else, from the runner’s own configuration (WP-133 c)',
      answer?.provider_mode === 'local' &&
        JSON.stringify(answer?.env_names) === '["CLAUDE_CODE_OAUTH_TOKEN"]' &&
        JSON.stringify(answer?.secret_env_names) === '["CLAUDE_CODE_OAUTH_TOKEN"]' &&
        answer?.value_is_the_container_token === true &&
        answer?.api_key_blank === true,
      answer === null
        ? `${probed.stdout}${probed.stderr ?? ''}`
            .split(FAKE_OAUTH_TOKEN)
            .join('[token]')
            .slice(0, 400)
        : JSON.stringify(answer),
    );
    check(
      'local mode: the runner’s own client and token reach the launcher’s control plane (WP-133 b)',
      answer?.launcher === 'ok',
      String(answer?.launcher ?? 'no answer'),
    );

    // (c), the negative half: the value in no log line of any service and in no row.
    stages.set('reading every log and the database for the token (local mode)');
    const allLogs = await compose(['logs', '--no-color']).catch((error) => ({
      stdout: '',
      stderr: String(error),
    }));
    const dump = await compose([
      'exec',
      '-T',
      'db',
      'pg_dump',
      '--data-only',
      '-U',
      'app',
      'app',
    ]).catch((error) => ({ stdout: '', stderr: String(error) }));
    const seen = [
      ['a service log', `${allLogs.stdout}${allLogs.stderr ?? ''}`.includes(FAKE_OAUTH_TOKEN)],
      ['a database row', dump.stdout.includes(FAKE_OAUTH_TOKEN)],
    ]
      .filter(([, found]) => found)
      .map(([where]) => where);
    check(
      'local mode: the token’s value is in no service’s log and no database row (WP-133 c)',
      seen.length === 0 && allLogs.stdout.length > 0 && dump.stdout.includes('COPY public.'),
      seen.length === 0
        ? `${allLogs.stdout.split('\n').length} log lines, ${dump.stdout.length} bytes of rows read`
        : `seen in ${seen.join(' and ')}`,
    );

    /*
     * The stop graces (WP-133, folding WP-132's discovered work), the way an upgrade stops each:
     * `docker compose stop <service>`, which signals with the image's stop signal and kills at the
     * service's `stop_grace_period`. Each must exit **0** — the process's own clean ending — inside
     * its grace. The durations are printed: they are the readings the graces were set from.
     */
    const composeText = await readFile(path.join(REPO, 'compose.yml'), 'utf8');
    for (const service of ['runner', 'app', 'db']) {
      stages.set(`docker compose stop ${service} (local mode)`);
      const grace = stopGracePeriodSeconds(composeText, service);
      const started = Date.now();
      await compose(['stop', service]);
      const seconds = (Date.now() - started) / 1000;
      const { stdout } = await compose([
        'ps',
        '-a',
        '--format',
        '{{.Service}} {{.ExitCode}}',
        service,
      ]);
      const exitCode = stdout.trim().split(/\s+/).at(-1);
      check(
        `local mode: \`docker compose stop ${service}\` ends it cleanly inside its stop_grace_period (WP-133)`,
        grace !== null && exitCode === '0' && seconds < grace,
        `${seconds.toFixed(1)} s, exit ${exitCode}, grace ${grace === null ? 'none' : `${grace} s`}`,
      );
    }
  } catch (error) {
    const where = error instanceof Unsettled ? '' : ` (while: ${stages.current})`;
    check(
      'the local-mode instance came up and answered',
      false,
      `${String(error).split(FAKE_OAUTH_TOKEN).join('[token]')}${where}`,
    );
  } finally {
    if (failures.length > failedBefore) {
      await describeInstance(compose, 'local mode: ');
    }
    stages.set('docker compose down (local mode)');
    await compose(['down', '-v', '--remove-orphans']).catch((error) => {
      console.error(`cleanup failed: ${String(error).split(FAKE_OAUTH_TOKEN).join('[token]')}`);
    });
    await rm(projectDirectory, { recursive: true, force: true }).catch(() => {});
  }
};

const main = async () => {
  await preflight();
  if (LEG !== 'local') {
    await stockLeg();
  }
  if (LEG !== 'stock') {
    await localLeg();
  }
  if (failures.length > 0) {
    console.error(`FAIL: compose-stock-check (${failures.length}): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(`PASS: compose-stock-check (leg ${LEG})`);
};

// The backstop for a wait nothing bounded (`compose-check-support.mjs`).
const finished = installExitBackstop('compose-stock-check', stages);
await main();
finished();
