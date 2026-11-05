#!/usr/bin/env node
/**
 * `node scripts/worker-compose-check.mjs` — **WP-284 (4)'s Docker leg**: a core and a worker bundle
 * on one daemon, the worker logged in with the device flow scripted.
 *
 * **Written in S-22.8 and not yet run**: Docker was paused on the machine that wrote it, so every
 * line below is a design until the first run measures it (the PR says so). Run it with the four
 * images built (`node scripts/build-images.mjs`):
 *
 *     DOCKER_HOST=unix:///var/run/docker.sock node scripts/worker-compose-check.mjs [--tag dev]
 *
 * ## What it brings up
 *
 *  - **the core**: `compose.yml` with `ROLE=all`, the `runner` scaled to 0 (a `workers_only` core,
 *    BD-032 decision 3: no claimant composed for the server), `APP_WORKER_IMAGE_DIGESTS` pinned to
 *    the local images' ids — what the launcher on the same daemon resolves (TD-031 decision 4; a
 *    registry digest is an image id only under the containerd store, TODO V-WM8);
 *  - **the worker bundle**: `compose.worker.yml` **as shipped**, its `.env` naming the local images
 *    by their tags and `APP_CORE_URL=http://app:8080`; the `remote-worker` container joined to the
 *    core's network after `up` (two compose projects on one daemon share no network by default).
 *
 * ## What it asserts
 *
 *  1. the launcher token is **generated at first start** (`launcher-token`, 0600, 43 base64url
 *     characters) and **kept** across a second `up`;
 *  2. the worker refuses `DATABASE_URL` and `APP_SECRET_KEY` **by name** (a one-off `run` with each);
 *  3. the **device flow**, scripted: the code the worker logs is approved through
 *     `POST /api/workers/device/approve` as the bootstrap administrator; the worker stores its
 *     credential and its `/readyz` reads `core_handshake: ok` (asked from inside its container: the
 *     listener is on the compose network only, never published);
 *  4. `GET /api/worker/v1/compose.yml`, with no credential and no header, pins every image by digest and names
 *     no `latest`, and its SHA-256 is the handshake's `compose_bundle_digest` (backlog 743);
 *  5. the worker's launcher answers `deployKeyCarriage: relayed` on its health;
 *  6. **canaries**: the Claude token is in no container's configured environment but the
 *     `remote-worker`'s, and in no log line of the bundle; no worker container carries a
 *     `DATABASE_URL` or an `APP_SECRET_KEY`;
 *  6b. **the local page** (WP-292 (6), written in S-22.13 and **not yet run** — Docker was paused on
 *     the machine that wrote it): the page's address is in the worker's log once, its token in the
 *     fragment; the publish is `127.0.0.1` only (`docker compose port`); the page and
 *     `/api/local/state` answer on `127.0.0.1` with the token, `401` without it and `421` for a
 *     foreign `Host`; the same port on the host's **other** address answers nothing; and a container
 *     on the worker's run egress network — where a run container lives (TD-025) — reaches neither
 *     the worker's name nor its address on the UI port;
 *  7. nothing is left: both projects are taken down with their volumes.
 *
 * ## What it does not do yet, stated (BACKLOG 761)
 *
 * WP-284 (4)'s **two credential-shape runs to Ready** — a static-token HTTPS project and a
 * deploy-key project whose mirror fetch and push the core signs through the worker — need two
 * stand-ins this repository does not have in Docker form: a provider the core can run a pipeline
 * against (the fake git and tracker live in the test process; a real GitLab binding would call
 * gitlab.com), and a **stage-aware** fake CLI in the run image (`test/fixtures/runlet/fake-claude-cli`
 * answers no stage's artifact). The fake-worker e2e (`test/e2e/worker/remote-worker.e2e.test.ts`)
 * runs both shapes to Ready through the production worker composition and launcher service over the
 * fake provider; the daemon half — V-WM8's helper socket on a mounted volume through the proxy — is
 * `scripts/deploy-key-check.mjs`'s `relayed` phase.
 *
 * Not a `verify` target, for the reason none of the Docker checks are: it needs a daemon. With no
 * daemon or no image it exits 1 naming what is missing; a skip is never a pass.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
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
  waitForOk,
} from './compose-check-support.mjs';

refuseOldNode('worker-compose-check');

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const optionValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const TAG = optionValue('--tag', process.env.PLATFORM_TAG ?? 'dev');
const SUFFIX = optionValue('--project-suffix', process.env.GITHUB_RUN_ID ?? 'local');
const CORE = `agentic-worker-check-core-${SUFFIX}`;
const BUNDLE = `agentic-worker-check-bundle-${SUFFIX}`;

/** Obviously fake (BD-002), past every floor, and in no shape a pattern rule knows. */
const SECRET_KEY = 'wp284-worker-compose-check-not-a-real-secret-0000';
const ADMIN_EMAIL = 'operator@example.test';
const ADMIN_PASSWORD = 'wp284-not-a-real-password';
const CLAUDE_TOKEN = 'FAKE-wp284-claude-oauth-token-not-a-credential-0001';
const ORIGIN = 'http://worker-compose-check.example.test';
/** The host port the bundle publishes the worker's page on (`APP_WORKER_UI_PORT`), off the default. */
const UI_PORT = 37357;
const TIMEOUT_MS = 15 * 60 * 1000;
const DOCKER_QUERY_MS = 60_000;

const stages = createStages();
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
};

const compose =
  (project, file, directory) =>
  async (composeArgs, extraEnv = {}) =>
    run(
      'docker',
      [
        'compose',
        '-p',
        project,
        '--project-directory',
        directory,
        '-f',
        path.join(REPO, file),
        ...composeArgs,
      ],
      {
        cwd: REPO,
        env: { ...process.env, PLATFORM_TAG: TAG, ...extraEnv },
        maxBuffer: 64 * 1024 * 1024,
        timeout: TIMEOUT_MS,
      },
    );

const imageId = async (image) =>
  (
    await run('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], {
      timeout: DOCKER_QUERY_MS,
    })
  ).stdout.trim();

const preflight = async () => {
  try {
    const { stdout } = await run('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: DOCKER_QUERY_MS,
    });
    console.log(`docker daemon ${stdout.trim()}`);
  } catch (error) {
    console.error(`FAIL: worker-compose-check — no Docker daemon: ${String(error)}`);
    process.exit(1);
  }
  const ids = {};
  for (const image of ['platform', 'platform-launcher', 'platform-runtime', 'platform-egress']) {
    try {
      ids[image] = await imageId(`${image}:${TAG}`);
    } catch {
      console.error(
        `FAIL: worker-compose-check — ${image}:${TAG} is not on this daemon; build it with \`node scripts/build-images.mjs --tag ${TAG}\``,
      );
      process.exit(1);
    }
  }
  return ids;
};

/** A cookie jar and the cross-site headers every mutating request needs (technical/08). */
class Client {
  #baseUrl;
  #cookies = new Map();
  constructor(baseUrl) {
    this.#baseUrl = baseUrl;
  }
  async json(route, init = {}) {
    const cookie = [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const { response, body: text } = await boundedFetch(stages, `${this.#baseUrl}${route}`, {
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
      // kept as text
    }
    return { status: response.status, body, text };
  }
}

const main = async () => {
  const ids = await preflight();
  const coreDirectory = await mkdtemp(path.join(tmpdir(), 'worker-check-core-'));
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), 'worker-check-bundle-'));
  const core = compose(CORE, 'compose.yml', coreDirectory);
  const bundle = compose(BUNDLE, 'compose.worker.yml', bundleDirectory);
  const digests = [
    `platform=${ids.platform}`,
    `platform_launcher=${ids['platform-launcher']}`,
    `platform_runtime=${ids['platform-runtime']}`,
    `platform_egress=${ids['platform-egress']}`,
  ].join(',');
  try {
    // ── The core: workers_only, no runner ───────────────────────────────────────────────────
    await writeFile(
      path.join(coreDirectory, '.env'),
      [
        `APP_SECRET_KEY=${SECRET_KEY}`,
        `APP_BASE_URL=${ORIGIN}`,
        `APP_BOOTSTRAP_ADMIN_EMAIL=${ADMIN_EMAIL}`,
        `APP_BOOTSTRAP_ADMIN_PASSWORD=${ADMIN_PASSWORD}`,
        `APP_WORKER_IMAGE_DIGESTS=${digests}`,
        'APP_PORT=0',
        '',
      ].join('\n'),
    );
    stages.set('core: docker compose up');
    await core(['up', '-d', '--no-build', '--scale', 'runner=0'], composeEnvironment(CORE));
    const coreUrl = `http://127.0.0.1:${await publishedPort(core)}`;
    await waitForOk(stages, `${coreUrl}/healthz`);
    const admin = new Client(coreUrl);
    const signedIn = await admin.json('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    check('the bootstrap administrator signs in', signedIn.status === 200, String(signedIn.status));

    // ── The bundle, as shipped ──────────────────────────────────────────────────────────────
    await writeFile(
      path.join(bundleDirectory, '.env'),
      [
        'APP_CORE_URL=http://app:8080',
        `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_TOKEN}`,
        `PLATFORM_IMAGE=platform:${TAG}`,
        `PLATFORM_LAUNCHER_IMAGE=platform-launcher:${TAG}`,
        `PLATFORM_RUNTIME_IMAGE=platform-runtime:${TAG}`,
        `PLATFORM_EGRESS_IMAGE=platform-egress:${TAG}`,
        `APP_WORKER_CONTROL_VOLUME=${BUNDLE}-ctl`,
        `APP_WORKER_CACHE_VOLUME=${BUNDLE}-repo-cache`,
        `APP_WORKER_UI_PORT=${UI_PORT}`,
        '',
      ].join('\n'),
    );
    stages.set('bundle: docker compose up');
    await bundle(['up', '-d', '--no-build']);
    const workerContainer = (await bundle(['ps', '-q', 'remote-worker'])).stdout.trim();
    await run('docker', ['network', 'connect', `${CORE}_default`, workerContainer], {
      timeout: DOCKER_QUERY_MS,
    });

    // 1. The launcher token: generated once, kept.
    const readToken = async () =>
      (
        await bundle([
          'exec',
          '-T',
          'remote-worker',
          'sh',
          '-c',
          'stat -c %a /var/lib/platform/launcher-token/token && cat /var/lib/platform/launcher-token/token',
        ])
      ).stdout
        .trim()
        .split('\n');
    const [mode, token] = await readToken();
    check(
      'the launcher token is generated at first start, 0600',
      mode === '600' && /^[A-Za-z0-9_-]{43}$/.test(token ?? ''),
      mode,
    );
    await bundle(['up', '-d', '--no-build']);
    const [, again] = await readToken();
    check('the launcher token is kept across a second up', again === token);

    // 2. The worker refuses a database URL and a secret key by name.
    for (const name of ['DATABASE_URL', 'APP_SECRET_KEY']) {
      let refused = '';
      try {
        await bundle([
          'run',
          '--rm',
          '--no-deps',
          '-e',
          `${name}=postgres://not-for-a-worker`,
          'remote-worker',
        ]);
      } catch (error) {
        refused = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      }
      check(
        `the worker refuses ${name} by name`,
        refused.includes(`${name} is set`),
        refused.slice(0, 200),
      );
    }

    // 3. The device flow, scripted.
    stages.set('the worker’s device code in its log');
    let userCode = null;
    for (let tries = 0; tries < 60 && userCode === null; tries += 1) {
      const { stdout } = await bundle(['logs', 'remote-worker']);
      userCode = /"user_code":"([A-Z]{4}-[A-Z]{4})"/.exec(stdout)?.[1] ?? null;
      if (userCode === null) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    check('the worker logs a device code', userCode !== null);
    const approved = await admin.json('/api/workers/device/approve', {
      method: 'POST',
      body: JSON.stringify({
        decision: 'approve',
        user_code: userCode,
        name: 'check-laptop',
        confirm_stale: false,
      }),
    });
    check(
      'the code is approved',
      approved.status === 200,
      JSON.stringify(approved.body).slice(0, 200),
    );
    stages.set('the worker’s /readyz');
    let ready = '';
    for (let tries = 0; tries < 60; tries += 1) {
      try {
        ready = (
          await bundle([
            'exec',
            '-T',
            'remote-worker',
            'curl',
            '-fsS',
            'http://127.0.0.1:8080/readyz',
          ])
        ).stdout;
        if (ready.includes('"core_handshake":"ok"')) break;
      } catch {
        // not yet
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    check(
      'the worker’s /readyz reads core_handshake: ok',
      ready.includes('"core_handshake":"ok"'),
      ready.trim(),
    );
    const credential = (
      await bundle([
        'exec',
        '-T',
        'remote-worker',
        'cat',
        '/var/lib/platform/worker-state/credential',
      ])
    ).stdout.trim();
    check(
      'the credential is stored in worker-state',
      /^wkr_[a-z2-7]{26}_[A-Za-z0-9_-]{43}$/.test(credential),
    );

    // 4. compose.yml, pinned by digest, its SHA-256 the handshake's bundle digest.
    const worker = new Client(coreUrl);
    const headers = { 'x-worker-protocol': '1', authorization: `Bearer ${credential}` };
    // Public, with no header at all (TD-031's 2026-11-05 amendment): a person's first-install download.
    const file = await worker.json('/api/worker/v1/compose.yml');
    const images = [...String(file.text).matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map(
      (match) => match[1],
    );
    check(
      'compose.yml pins every image by digest and names no latest',
      file.status === 200 &&
        images.length > 0 &&
        images.every(
          (image) => /@sha256:[0-9a-f]{64}\}?$/.test(image) && !image.includes('latest'),
        ),
      images.join(' '),
    );
    const handshake = await worker.json('/api/worker/v1/handshake', {
      method: 'POST',
      headers,
      body: JSON.stringify({ image_digests: [], commit: null }),
    });
    check(
      'the handshake’s compose_bundle_digest is the served file’s SHA-256 (backlog 743)',
      handshake.body?.compose_bundle_digest ===
        createHash('sha256').update(String(file.text), 'utf8').digest('hex'),
    );

    // 5. The launcher relays.
    const health = (
      await bundle([
        'exec',
        '-T',
        'remote-worker',
        'sh',
        '-c',
        'curl -fsS -H "authorization: Bearer $(cat /var/lib/platform/launcher-token/token)" http://launcher:7780/v1/health',
      ])
    ).stdout;
    check(
      'the worker’s launcher applies the relayed carriage',
      health.includes('"deployKeyCarriage":"relayed"'),
      health.slice(0, 200),
    );

    // 6. Canaries.
    const containers = (await bundle(['ps', '-q', '--all'])).stdout
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const id of containers) {
      const { stdout } = await run(
        'docker',
        ['inspect', '--format', '{{.Name}} {{json .Config.Env}}', id],
        {
          timeout: DOCKER_QUERY_MS,
        },
      );
      const isWorker = stdout.includes('remote-worker');
      check(
        `${stdout.split(' ')[0]}: the Claude token only where it belongs`,
        isWorker || !stdout.includes(CLAUDE_TOKEN),
      );
      check(
        `${stdout.split(' ')[0]}: no DATABASE_URL, no APP_SECRET_KEY`,
        !/DATABASE_URL=|APP_SECRET_KEY=/.test(stdout),
      );
    }
    const logs = (await bundle(['logs'])).stdout;
    check('the Claude token is in no log line of the bundle', !logs.includes(CLAUDE_TOKEN));
    check('the worker credential is in no log line of the bundle', !logs.includes(credential));

    // 6b. The local page (WP-292 (6)).
    stages.set('the worker’s local page');
    const uiToken = /#token=([A-Za-z0-9_-]{43})/.exec(logs)?.[1] ?? null;
    check('the worker logs its page’s address with the token in the fragment', uiToken !== null);
    const published = (await bundle(['port', 'remote-worker', '7357'])).stdout.trim();
    check(
      'the page is published on 127.0.0.1 only',
      published === `127.0.0.1:${UI_PORT}`,
      published,
    );
    const page = `http://127.0.0.1:${UI_PORT}`;
    const asked = async (route, headers = {}) => {
      const { response, body } = await boundedFetch(stages, `${page}${route}`, { headers });
      return { status: response.status, body, headers: response.headers };
    };
    const html = await asked('/');
    check(
      'the page is served on 127.0.0.1',
      html.status === 200 && html.body.includes('id="root"'),
    );
    const state = await asked('/api/local/state', { authorization: `Bearer ${uiToken}` });
    check(
      'the page’s state answers with the token, naming the worker',
      state.status === 200 && state.body.includes('"worker_name":"check-laptop"'),
      `${state.status} ${state.body.slice(0, 120)}`,
    );
    check(
      'the page’s state carries no secret',
      !state.body.includes(CLAUDE_TOKEN) &&
        !state.body.includes(credential) &&
        !state.body.includes(String(uiToken)),
    );
    check(
      'the page answers no CORS header and sets no cookie',
      [...state.headers.keys()].every(
        (name) => !name.startsWith('access-control-') && name !== 'set-cookie',
      ),
    );
    check('without the token the state is 401', (await asked('/api/local/state')).status === 401);
    check(
      'a foreign Host is 421',
      (
        await run('curl', [
          '-s',
          '-o',
          '/dev/null',
          '-w',
          '%{http_code}',
          '-H',
          'host: rebinding.example.test',
          `${page}/api/local/state`,
        ])
      ).stdout.trim() === '421',
    );
    const other = Object.values(networkInterfaces())
      .flat()
      .find((address) => address?.family === 'IPv4' && !address.internal)?.address;
    if (other === undefined) {
      check('the host has another address to try the page on', false, 'none found');
    } else {
      let reached = 'no answer';
      try {
        const response = await fetch(`http://${other}:${UI_PORT}/`, {
          signal: AbortSignal.timeout(5_000),
        });
        reached = `answered ${response.status}`;
      } catch {
        // refused or timed out: the page is not on this address
      }
      check(
        `the page is not reachable on the host’s other address (${other})`,
        reached === 'no answer',
        reached,
      );
    }
    const workerAddress = (
      await run(
        'docker',
        [
          'inspect',
          '--format',
          '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
          workerContainer,
        ],
        { timeout: DOCKER_QUERY_MS },
      )
    ).stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const probe = (
      await run(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'agentic-worker-run-egress',
          '--entrypoint',
          'node',
          `platform:${TAG}`,
          '-e',
          `const targets = ${JSON.stringify(['remote-worker', ...workerAddress])};
         Promise.all(targets.map((host) => fetch('http://' + host + ':7357/', { signal: AbortSignal.timeout(5000) })
           .then((r) => host + ' reached ' + r.status, () => host + ' unreachable')))
           .then((lines) => console.log(lines.join('\\n')));`,
        ],
        { timeout: DOCKER_QUERY_MS },
      )
    ).stdout;
    check(
      'a container on the run egress network reaches no UI port of the worker',
      !probe.includes(' reached '),
      probe.trim().replaceAll('\n', '; '),
    );
  } catch (error) {
    failures.push(`${stages.current}: ${String(error)}`);
    await describeInstance(core, 'core').catch(() => undefined);
    await describeInstance(bundle, 'bundle').catch(() => undefined);
  } finally {
    // 7. Nothing is left.
    await bundle(['down', '-v', '--remove-orphans']).catch(() => undefined);
    await core(['down', '-v', '--remove-orphans'], composeEnvironment(CORE)).catch(() => undefined);
    await rm(coreDirectory, { recursive: true, force: true });
    await rm(bundleDirectory, { recursive: true, force: true });
  }
};

const settled = installExitBackstop('worker-compose-check', stages);
await main();
settled();
if (failures.length > 0) {
  console.log(`FAIL: worker-compose-check — ${failures.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log('PASS: worker-compose-check');
}
