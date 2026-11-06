#!/usr/bin/env node
/**
 * `node scripts/worker-install-check.mjs` — **the one-command install against a real core and a real
 * daemon** (S-22.20, backlog 1021). The unit tier runs `install.sh` against a stub `docker` and `curl`
 * (`apps/server/src/workers/install-script.test.ts`); this runs the line a person runs:
 *
 *     curl -fsSL '<core>/api/worker/v1/install.sh' | sh -s -- --dir <folder> --no-open
 *
 * Run it with the four images built (`node scripts/build-images.mjs`):
 *
 *     node scripts/worker-install-check.mjs [--tag dev] [--project-suffix local] [--host-address <a>]
 *         [--core-port 38789]
 *
 * ## What it brings up
 *
 *  - **a local registry** (`registry:2`, a free port, published on every interface as
 *    `worker-compose-check.mjs` explains) holding the four `:<tag>` images this run built, pushed
 *    under `localhost:<port>/acme/…` and untagged again, so the installer's `docker compose up`
 *    **pulls them by registry digest** — the images of this build, never `ghcr.io`'s `latest`;
 *  - **the core**: `compose.yml`'s `app` (and what it depends on — no runner, no launcher), on a fixed
 *    port, `APP_BASE_URL` the address below, advertising those four digests
 *    (`APP_IMAGE_REPOSITORY` + `APP_WORKER_IMAGE_DIGESTS`), so the script it serves names it and the
 *    bundle it serves pins them;
 *  - **the worker, installed by the served script** into a fresh folder under the system's temporary
 *    directory, with `--no-open`. `APP_BASE_URL` is how both this host (the installer's own `curl`)
 *    and a container (the worker and its updater) reach the core: the default bridge's gateway on a
 *    Linux engine — an address of the host every bridge network routes to, as
 *    `worker-update-check.mjs` measured — and `host.docker.internal` on Docker Desktop, which the
 *    host must then resolve too (refused by name when it does not; `--host-address` overrides).
 *
 * ## The project name
 *
 * `install.sh` fixes the compose project name: `agentic-worker`, the same as a developer's own worker
 * on the same daemon (the owner's runs there). So this check **refuses to start** when the daemon has
 * any container, volume or network of that project, or any of the names below — it never joins,
 * stops or removes somebody's worker, and a refusal is a `FAIL`, never a skip. Everything else is its
 * own: the core's project (`agentic-install-check-core-<suffix>`), the registry, the page port
 * ({@link UI_PORT}, off the default 7357), and the worker's named control volume, repository cache
 * volume and run network, which the installer passes from its shell to `docker compose`
 * (`APP_WORKER_CONTROL_VOLUME`, `APP_WORKER_CACHE_VOLUME`, `APP_WORKER_RUN_NETWORK`,
 * `APP_WORKER_UI_PORT`). On a CI runner the daemon is the job's own.
 *
 * ## What it asserts
 *
 *  1. the core serves `install.sh` (200) with its own address filled in, and `compose.yml` pinning
 *     the four registry digests;
 *  2. **the install**: the piped line exits 0; every container of the project is running — the
 *     `remote-worker`, the `launcher`, the **`updater`** and both socket proxies — and each that
 *     declares a healthcheck (the worker, the launcher, the updater) is `healthy`; the four
 *     one-shots (`launcher-token`, `pull-runtime-image`, `pull-egress-image`, `pull-git-image`) are
 *     there and exited 0, and no service is there that neither list names; the worker, the updater,
 *     the launcher and the run and egress pulls run the registry digests the core advertises; the
 *     local page and `/api/local/state` answer `200` on `127.0.0.1:<port>`;
 *  3. **the re-run** of the same line exits 0, says the worker is already installed, and **recreates
 *     nothing**: every container id (and creation time) is the one before; the services are healthy
 *     and the page answers again;
 *  4. **`--uninstall --purge`** (the same piped line) exits 0 and leaves **nothing**: no container,
 *     volume or network of the project, neither named volume nor the run network, and no folder.
 *     The launcher's repository cache volume is made first (`docker volume create`; only a run's
 *     first clone makes it, and none runs here), so the purge's removal of it is exercised;
 *  5. nothing of the check is left: the core down with its volumes, the registry and the pushed image
 *     references removed — whatever happened (`finally`).
 *
 * Every exec and request is bounded, each stage by its own bound, and the bounds sum under the
 * workflow job's 30 min (see {@link INSTALL_MS}'s neighbours); a failure prints the command's output with every secret value
 * the check holds replaced by its name. Not a `verify` target, for the reason none of the Docker
 * checks are: it needs a daemon. With no daemon or no image it exits 1 naming what is missing.
 */
import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
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
  refuseOldNode,
  waitForOk,
} from './compose-check-support.mjs';

refuseOldNode('worker-install-check');

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const optionValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const TAG = optionValue('--tag', process.env.PLATFORM_TAG ?? 'dev');
const SUFFIX = optionValue('--project-suffix', process.env.GITHUB_RUN_ID ?? 'local');
const CORE = `agentic-install-check-core-${SUFFIX}`;
const REGISTRY_CONTAINER = `agentic-install-check-registry-${SUFFIX}`;
/** The project `install.sh` brings the worker up as — fixed by the script (see the header). */
const PROJECT = 'agentic-worker';
const CORE_PORT = Number(optionValue('--core-port', '38789'));
/** The worker's page port, off the default and off the other worker checks' (37357, 37358). */
const UI_PORT = 37359;
/** The installer's shell: the worker's own named objects and page port (passed to compose). */
const WORKER_NAMES = {
  APP_WORKER_CONTROL_VOLUME: `agentic-install-check-${SUFFIX}-ctl`,
  APP_WORKER_CACHE_VOLUME: `agentic-install-check-${SUFFIX}-repo-cache`,
  APP_WORKER_RUN_NETWORK: `agentic-install-check-${SUFFIX}-run-egress`,
  APP_WORKER_UI_PORT: String(UI_PORT),
};
/** The services that keep running. */
const LONG_RUNNING = [
  'remote-worker',
  'launcher',
  'updater',
  'docker-socket-proxy',
  'updater-docker-proxy',
];
/** The one-shots, each of which must exist and have exited 0 — one missing from the bundle fails. */
const ONE_SHOTS = ['launcher-token', 'pull-egress-image', 'pull-git-image', 'pull-runtime-image'];
/** The services whose healthcheck must read `healthy` (the image's, or the bundle's own). */
const HEALTHCHECKED = ['remote-worker', 'launcher', 'updater'];
const IMAGES = {
  platform: 'platform',
  platform_launcher: 'platform-launcher',
  platform_runtime: 'platform-runtime',
  platform_egress: 'platform-egress',
};

/** Obviously fake (BD-002), past every floor, and in no shape a pattern rule knows. */
const SECRET_KEY = 'install-check-not-a-real-secret-key-00000000000000';
const ADMIN_EMAIL = 'operator@example.test';
const ADMIN_PASSWORD = 'install-check-not-a-real-password';
const SECRETS = { SECRET_KEY, ADMIN_PASSWORD };

/**
 * The bounds, each a stage's own, so a wedged one ends with a `FAIL` line naming it. Their sum stays
 * under the workflow job's 30 min (`docker-checks.yml`): registry 1 + its answer 1 + four pushes 6 +
 * core up 3 + its health 1 + install 5 + health 1.5 + re-run 3 + health 1.5 + uninstall 2 + core down
 * 2 = 27 min, the rest for the docker queries (measured green: about 1 min to the core's first answer
 * — registry, four pushes and the core — and about 2.5 min in all).
 */
const DOCKER_QUERY_MS = 60_000;
const REGISTRY_MS = 60_000;
const PUSH_MS = 90_000;
const CORE_UP_MS = 3 * 60_000;
const CORE_DOWN_MS = 2 * 60_000;
/** The installer's own wait for the worker (`AGENTIC_INSTALL_WAIT_SECONDS`), inside the run's bound. */
const INSTALLER_WAIT_SECONDS = 180;
/** A first install: the pull and the installer's own wait. */
const INSTALL_MS = 5 * 60_000;
/** A re-run: nothing to pull, the same wait. */
const RERUN_MS = 3 * 60_000;
/** `--uninstall --purge`: one `compose down --volumes` and a volume removal. */
const UNINSTALL_MS = 2 * 60_000;
/** How long every service may take to read healthy once the installer has returned. */
const HEALTHY_MS = 90_000;
/** A host-name lookup: the installer's address for the core. */
const LOOKUP_MS = 10_000;

const stages = createStages();
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const redact = (text) =>
  Object.entries(SECRETS).reduce(
    (current, [name, value]) => current.split(value).join(`[${name}]`),
    String(text ?? ''),
  );

const docker = (dockerArgs, options = {}) =>
  run('docker', dockerArgs, {
    timeout: options.timeoutMs ?? DOCKER_QUERY_MS,
    maxBuffer: 64 * 1024 * 1024,
    cwd: REPO,
  });

const lines = (stdout) =>
  stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const core = (composeArgs, timeoutMs = DOCKER_QUERY_MS) =>
  run(
    'docker',
    [
      'compose',
      '-p',
      CORE,
      '--project-directory',
      coreDirectory,
      '-f',
      path.join(REPO, 'compose.yml'),
      ...composeArgs,
    ],
    {
      cwd: REPO,
      env: {
        ...process.env,
        PLATFORM_TAG: TAG,
        APP_PORT: String(CORE_PORT),
        APP_WORKSPACE_CONTROL_VOLUME: `${CORE}-ctl`,
        APP_WORKSPACE_CACHE_VOLUME: `${CORE}-repo-cache`,
      },
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
    },
  );

/** The core's compose, its output and errors redacted, for what a failure prints. */
const redactedCore = async (composeArgs) => {
  try {
    const { stdout, stderr } = await core(composeArgs);
    return { stdout: redact(stdout), stderr: redact(stderr) };
  } catch (error) {
    throw new Error(redact(`${String(error)}\n${error?.stdout ?? ''}${error?.stderr ?? ''}`));
  }
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '::', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

/** How a container — and, for the installer, this host — reaches the core (see the header). */
const resolveHostAddress = async () => {
  let address = optionValue('--host-address', '');
  if (address === '') {
    const { stdout: system } = await docker(['info', '--format', '{{.OperatingSystem}}']);
    address = /docker desktop/i.test(system)
      ? 'host.docker.internal'
      : (
          await docker([
            'network',
            'inspect',
            'bridge',
            '--format',
            '{{(index .IPAM.Config 0).Gateway}}',
          ])
        ).stdout.trim();
  }
  if (!/^[\w.-]+$/.test(address)) {
    throw new Error(`the host address for containers is not a host name or address: '${address}'`);
  }
  try {
    await stages.within(`resolving ${address}`, LOOKUP_MS, () => lookup(address));
  } catch {
    throw new Error(
      `this host does not resolve '${address}', and the installer's own curl must reach the core there ` +
        'as the worker does; pass --host-address with a name both resolve',
    );
  }
  return address;
};

/** Everything of the project on the daemon: containers, volumes, networks. */
const projectObjects = async () => {
  const filter = `label=com.docker.compose.project=${PROJECT}`;
  const containers = lines((await docker(['ps', '--all', '--quiet', '--filter', filter])).stdout);
  const volumes = lines((await docker(['volume', 'ls', '--quiet', '--filter', filter])).stdout);
  const networks = lines(
    (await docker(['network', 'ls', '--format', '{{.Name}}', '--filter', filter])).stdout,
  );
  return { containers, volumes, networks };
};

/** Which of the worker's own named objects exist (by exact name). */
const namedObjectsPresent = async () => {
  const present = [];
  for (const volume of [
    WORKER_NAMES.APP_WORKER_CONTROL_VOLUME,
    WORKER_NAMES.APP_WORKER_CACHE_VOLUME,
  ]) {
    if (
      await docker(['volume', 'inspect', volume]).then(
        () => true,
        () => false,
      )
    ) {
      present.push(`volume ${volume}`);
    }
  }
  if (
    await docker(['network', 'inspect', WORKER_NAMES.APP_WORKER_RUN_NETWORK]).then(
      () => true,
      () => false,
    )
  ) {
    present.push(`network ${WORKER_NAMES.APP_WORKER_RUN_NETWORK}`);
  }
  return present;
};

/** One row per container of the project: id, service, state, health, exit code, creation, image. */
const containerRows = async () => {
  const { containers } = await projectObjects();
  if (containers.length === 0) return [];
  // The whole document, read here: a `--format` template that names `.State.Health` fails outright
  // for a container with no healthcheck (`map has no entry for key "Health"`, measured on 28.0.4).
  const { stdout } = await docker(['container', 'inspect', ...containers]);
  return JSON.parse(stdout)
    .map((container) => ({
      id: container.Id,
      service: container.Config?.Labels?.['com.docker.compose.service'] ?? '',
      state: container.State?.Status ?? '',
      health: container.State?.Health?.Status ?? 'none',
      exitCode: String(container.State?.ExitCode ?? ''),
      created: container.Created ?? '',
      image: container.Config?.Image ?? '',
    }))
    .sort((a, b) => a.service.localeCompare(b.service));
};

/**
 * Whether every long-running service runs, every healthchecked one is healthy, every one-shot exists
 * and exited 0, and no service is there that neither list names.
 */
const serviceProblems = (rows) => {
  const problems = [];
  for (const service of LONG_RUNNING) {
    const row = rows.find((candidate) => candidate.service === service);
    if (row === undefined) problems.push(`${service}: missing`);
    else if (row.state !== 'running') problems.push(`${service}: ${row.state}`);
    else if (HEALTHCHECKED.includes(service) && row.health !== 'healthy') {
      problems.push(`${service}: ${row.health}`);
    }
  }
  for (const service of ONE_SHOTS) {
    const row = rows.find((candidate) => candidate.service === service);
    if (row === undefined) problems.push(`${service}: missing`);
    else if (row.state !== 'exited' || row.exitCode !== '0') {
      problems.push(`${service}: ${row.state} (exit ${row.exitCode})`);
    }
  }
  for (const row of rows) {
    if (!LONG_RUNNING.includes(row.service) && !ONE_SHOTS.includes(row.service)) {
      problems.push(`${row.service}: a service this check does not know`);
    }
  }
  return problems;
};

/** Polls until {@link serviceProblems} is empty, or the bound; answers the last rows and problems. */
const waitHealthy = async (what) => {
  stages.set(what);
  const deadline = Date.now() + HEALTHY_MS;
  for (;;) {
    const rows = await containerRows();
    const problems = serviceProblems(rows);
    if (problems.length === 0 || Date.now() > deadline) return { rows, problems };
    await sleep(3_000);
  }
};

/** Compose's per-layer pull lines (hundreds per install), dropped from what the check prints. */
const withoutPullProgress = (text) =>
  text
    .split('\n')
    .filter(
      (line) =>
        !/^\s*[0-9a-f]{12} (Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)/.test(
          line,
        ),
    )
    .join('\n');

/** The person's line, run by a shell with `pipefail`, so a failed download is not an empty script. */
const pipeLine = async (url, scriptArgs, timeoutMs) => {
  const line = `curl -fsSL '${url}' | sh -s -- ${scriptArgs.join(' ')}`;
  console.log(`$ ${line}`);
  const env = {
    ...process.env,
    ...WORKER_NAMES,
    AGENTIC_INSTALL_WAIT_SECONDS: String(INSTALLER_WAIT_SECONDS),
  };
  // The installer unsets what would re-pin it; nothing of this process's own compose settings leaks.
  delete env.PLATFORM_TAG;
  try {
    const { stdout, stderr } = await run(
      'bash',
      [
        '-o',
        'pipefail',
        '-c',
        'url=$1; shift; curl -fsSL "$url" | sh -s -- "$@"',
        'install-line',
        url,
        ...scriptArgs,
      ],
      { env, cwd: tmpdir(), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
    );
    const output = redact(`${stdout}${stderr}`);
    console.log(withoutPullProgress(output).replace(/^/gm, '  | '));
    return { ok: true, output };
  } catch (error) {
    const ended = error?.killed
      ? `killed (${error.signal ?? 'signal'}) after ${timeoutMs / 1000} s`
      : `exit ${String(error?.code ?? 'unknown')}`;
    const output = redact(`${error?.stdout ?? ''}${error?.stderr ?? ''}`);
    console.log(withoutPullProgress(output).replace(/^/gm, '  | '));
    return { ok: false, output, ended };
  }
};

/** The page and its state answer 200 on loopback, as the installer's address names it. */
const pageAnswers = async () => {
  const answers = [];
  for (const route of ['/', '/api/local/state']) {
    try {
      const { response } = await boundedFetch(stages, `http://127.0.0.1:${UI_PORT}${route}`);
      answers.push(`${route} ${response.status}`);
    } catch (error) {
      answers.push(`${route} ${String(error)}`);
    }
  }
  return { ok: answers.every((answer) => / 200$/.test(answer)), detail: answers.join(', ') };
};

const summary = (rows) => rows.map((row) => `${row.service}=${row.state}/${row.health}`).join(' ');

let coreDirectory = '';

const main = async () => {
  try {
    const { stdout } = await docker(['version', '--format', '{{.Server.Version}}']);
    console.log(`docker daemon ${stdout.trim()}`);
  } catch (error) {
    console.error(`FAIL: worker-install-check — no Docker daemon: ${String(error)}`);
    process.exit(1);
  }
  for (const image of Object.values(IMAGES)) {
    try {
      await docker(['image', 'inspect', `${image}:${TAG}`, '--format', '{{.Id}}']);
    } catch {
      console.error(
        `FAIL: worker-install-check — ${image}:${TAG} is not on this daemon; build it with \`node scripts/build-images.mjs --tag ${TAG}\``,
      );
      process.exit(1);
    }
  }
  // The project name is the script's (see the header): refuse rather than touch somebody's worker.
  const before = await projectObjects();
  const named = await namedObjectsPresent();
  const existing = [
    ...before.containers.map((id) => `container ${id.slice(0, 12)}`),
    ...before.volumes.map((name) => `volume ${name}`),
    ...before.networks.map((name) => `network ${name}`),
    ...named,
  ];
  if (existing.length > 0) {
    console.error(
      `FAIL: worker-install-check — this daemon already has the compose project ${PROJECT} (or this check's ` +
        `names): ${existing.join(', ')}. install.sh installs as ${PROJECT} and nothing renames it, so the ` +
        'check refuses to run here rather than touch that worker; run it on a daemon with no worker (CI does)',
    );
    process.exit(1);
  }
  const hostAddress = await resolveHostAddress().catch((error) => {
    console.error(`FAIL: worker-install-check — ${error.message}`);
    process.exit(1);
  });
  const coreUrl = `http://${hostAddress}:${CORE_PORT}`;
  console.log(`the core is ${coreUrl} to this host and to the worker's containers`);

  const directory = await mkdtemp(path.join(tmpdir(), 'worker-install-check-'));
  coreDirectory = path.join(directory, 'core');
  /** The installer's folder: absent, so the first run makes it (a person's `~/agentic-worker`). */
  const workerDirectory = path.join(directory, 'agentic-worker');
  await mkdir(coreDirectory, { recursive: true });
  const pushed = [];
  let installed = false;
  try {
    // ── The registry and this build's images ──────────────────────────────────────────────
    stages.set('the local registry');
    const registryPort = await freePort();
    await docker(
      ['run', '-d', '--name', REGISTRY_CONTAINER, '-p', `${registryPort}:5000`, 'registry:2'],
      {
        timeoutMs: REGISTRY_MS,
      },
    );
    await waitForOk(stages, `http://127.0.0.1:${registryPort}/v2/`, { totalMs: 60_000 });
    const namespace = `localhost:${registryPort}/acme`;
    const digests = {};
    for (const [key, image] of Object.entries(IMAGES)) {
      const tagged = `${namespace}/${image}:install-check`;
      stages.set(`docker push ${tagged}`);
      pushed.push(tagged);
      await docker(['image', 'tag', `${image}:${TAG}`, tagged]);
      await docker(['image', 'push', '--quiet', tagged], { timeoutMs: PUSH_MS });
      // The registry's own answer (under the containerd store it is not the local id).
      const { response } = await boundedFetch(
        stages,
        `http://127.0.0.1:${registryPort}/v2/acme/${image}/manifests/install-check`,
        {
          method: 'HEAD',
          headers: {
            accept: [
              'application/vnd.oci.image.index.v1+json',
              'application/vnd.oci.image.manifest.v1+json',
              'application/vnd.docker.distribution.manifest.list.v2+json',
              'application/vnd.docker.distribution.manifest.v2+json',
            ].join(', '),
          },
        },
      );
      const digest = response.headers.get('docker-content-digest');
      if (digest === null || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
        throw new Error(`the registry names no digest for ${tagged}`);
      }
      // Untagged, so the installer's `docker compose up` pulls the digest reference.
      await docker(['image', 'rm', tagged]);
      digests[key] = digest;
      pushed.push(`${namespace}/${image}@${digest}`);
    }
    const reference = (key) => `${namespace}/${IMAGES[key]}@${digests[key]}`;

    // ── The core ──────────────────────────────────────────────────────────────────────────
    await writeFile(
      path.join(coreDirectory, '.env'),
      [
        `APP_SECRET_KEY=${SECRET_KEY}`,
        `APP_BASE_URL=${coreUrl}`,
        `APP_BOOTSTRAP_ADMIN_EMAIL=${ADMIN_EMAIL}`,
        `APP_BOOTSTRAP_ADMIN_PASSWORD=${ADMIN_PASSWORD}`,
        `APP_IMAGE_REPOSITORY=${namespace}`,
        `APP_WORKER_IMAGE_DIGESTS=${Object.entries(digests)
          .map(([key, digest]) => `${key}=${digest}`)
          .join(',')}`,
        '',
      ].join('\n'),
    );
    stages.set('core: docker compose up');
    await core(['up', '-d', '--no-build', '--wait', 'app'], CORE_UP_MS);
    await waitForOk(stages, `http://127.0.0.1:${CORE_PORT}/healthz`, { totalMs: 60_000 });

    // 1. What the core serves.
    stages.set('the served script and bundle');
    const script = await boundedFetch(stages, `${coreUrl}/api/worker/v1/install.sh`);
    check(
      'the core serves install.sh with its own address filled in',
      script.response.status === 200 &&
        script.body.includes(`CORE_URL='${coreUrl}'`) &&
        !script.body.includes('@@AGENTIC_CORE_URL@@'),
      String(script.response.status),
    );
    const bundle = await boundedFetch(stages, `${coreUrl}/api/worker/v1/compose.yml`);
    check(
      'the core serves compose.yml pinning this build’s four registry digests',
      bundle.response.status === 200 &&
        Object.keys(IMAGES).every((key) => bundle.body.includes(reference(key))),
      String(bundle.response.status),
    );

    // 2. The install.
    const installUrl = `${coreUrl}/api/worker/v1/install.sh`;
    const installArgs = ['--dir', workerDirectory, '--no-open'];
    stages.set('the install');
    installed = true;
    const first = await pipeLine(installUrl, installArgs, INSTALL_MS);
    check('the install line exits 0', first.ok, first.ended);
    check(
      'the installer says the worker is running',
      first.output.includes('The worker is running.'),
    );
    // What the services read the moment the installer said "running" (it waits for the worker,
    // the updater and the page; the launcher's health is not among them). A note, not an assertion.
    console.log(`note  when the installer returned: ${summary(await containerRows())}`);
    const afterInstall = await waitHealthy('the installed worker’s services');
    check(
      'every service runs, the worker, launcher and updater are healthy, the one-shots exited 0',
      afterInstall.problems.length === 0,
      afterInstall.problems.join('; ') || summary(afterInstall.rows),
    );
    const updater = afterInstall.rows.find((row) => row.service === 'updater');
    check(
      'the updater is installed, running and healthy',
      updater?.state === 'running' && updater.health === 'healthy',
      updater === undefined ? 'missing' : `${updater.state}/${updater.health}`,
    );
    // Each service on the registry digest the core advertises for it — this run's build.
    for (const [service, key] of [
      ['remote-worker', 'platform'],
      ['updater', 'platform'],
      ['launcher', 'platform_launcher'],
      ['pull-runtime-image', 'platform_runtime'],
      ['pull-egress-image', 'platform_egress'],
    ]) {
      const row = afterInstall.rows.find((candidate) => candidate.service === service);
      check(
        `${service} runs the registry digest the core advertises (${key})`,
        row?.image === reference(key),
        row?.image ?? 'missing',
      );
    }
    const page = await pageAnswers();
    check(`the local page answers on 127.0.0.1:${UI_PORT}`, page.ok, page.detail);

    // 3. The re-run: a repair that recreates nothing.
    stages.set('the re-run');
    const second = await pipeLine(installUrl, installArgs, RERUN_MS);
    check('the re-run exits 0', second.ok, second.ended);
    check(
      'the re-run says the worker is already installed and recreates nothing',
      second.output.includes('already installed'),
    );
    const afterRerun = await waitHealthy('the re-run worker’s services');
    const identity = (rows) => rows.map((row) => `${row.service} ${row.id} ${row.created}`);
    check(
      'no container was recreated: every id and creation time is the one before',
      JSON.stringify(identity(afterRerun.rows)) === JSON.stringify(identity(afterInstall.rows)),
      afterRerun.rows.length === afterInstall.rows.length
        ? `${afterRerun.rows.length} containers`
        : `${afterInstall.rows.length} → ${afterRerun.rows.length} containers`,
    );
    check(
      'after the re-run every service runs and is healthy',
      afterRerun.problems.length === 0,
      afterRerun.problems.join('; ') || summary(afterRerun.rows),
    );
    const pageAgain = await pageAnswers();
    check('the local page answers after the re-run', pageAgain.ok, pageAgain.detail);

    // 4. Uninstall and purge. The launcher makes its repository cache volume at a run's first
    // clone, and no run happens here, so it is made by hand: the purge's own removal of it (a
    // volume Compose does not own) is then exercised rather than skipped.
    stages.set('the uninstall');
    await docker(['volume', 'create', WORKER_NAMES.APP_WORKER_CACHE_VOLUME]);
    check(
      `the launcher's cache volume ${WORKER_NAMES.APP_WORKER_CACHE_VOLUME} exists before the purge`,
      await docker(['volume', 'inspect', WORKER_NAMES.APP_WORKER_CACHE_VOLUME]).then(
        () => true,
        () => false,
      ),
    );
    const removed = await pipeLine(
      installUrl,
      ['--uninstall', '--purge', '--dir', workerDirectory],
      UNINSTALL_MS,
    );
    check('the uninstall line exits 0', removed.ok, removed.ended);
    const left = await projectObjects();
    const leftNamed = await namedObjectsPresent();
    const leftOver = [
      ...left.containers.map((id) => `container ${id.slice(0, 12)}`),
      ...left.volumes.map((name) => `volume ${name}`),
      ...left.networks.map((name) => `network ${name}`),
      ...leftNamed,
    ];
    check(
      `the purge removed the cache volume ${WORKER_NAMES.APP_WORKER_CACHE_VOLUME}`,
      !leftNamed.includes(`volume ${WORKER_NAMES.APP_WORKER_CACHE_VOLUME}`),
    );
    check(
      `no container, volume or network of ${PROJECT} is left, nor the named volumes and run network`,
      leftOver.length === 0,
      leftOver.join(', '),
    );
    const folderLeft = await stat(workerDirectory).then(
      () => true,
      () => false,
    );
    check('the worker’s folder is removed', !folderLeft);
    installed = !(leftOver.length === 0 && !folderLeft);
  } catch (error) {
    failures.push(`${stages.current}: ${redact(String(error?.stderr ?? '') || String(error))}`);
    await describeInstance(redactedCore, 'core ').catch(() => undefined);
    const rows = await containerRows().catch(() => []);
    if (rows.length > 0) console.error(`--- ${PROJECT}: ${summary(rows)}`);
  } finally {
    stages.set('cleanup');
    if (installed) {
      // Only what this run brought up: the project did not exist before it (refused above).
      const left = await projectObjects().catch(() => ({
        containers: [],
        volumes: [],
        networks: [],
      }));
      if (left.containers.length > 0) {
        const { stdout } = await docker([
          'compose',
          '-p',
          PROJECT,
          'logs',
          '--no-color',
          '--tail',
          '60',
        ]).catch(() => ({ stdout: '' }));
        if (failures.length > 0) console.error(redact(stdout));
        await docker(['container', 'rm', '-f', ...left.containers]).catch(() => undefined);
      }
      for (const network of [...left.networks, WORKER_NAMES.APP_WORKER_RUN_NETWORK]) {
        await docker(['network', 'rm', network]).catch(() => undefined);
      }
      for (const volume of [
        ...left.volumes,
        WORKER_NAMES.APP_WORKER_CONTROL_VOLUME,
        WORKER_NAMES.APP_WORKER_CACHE_VOLUME,
      ]) {
        await docker(['volume', 'rm', volume]).catch(() => undefined);
      }
    }
    await core(['down', '-v', '--remove-orphans'], CORE_DOWN_MS).catch(() => undefined);
    await docker(['container', 'rm', '-f', REGISTRY_CONTAINER]).catch(() => undefined);
    for (const image of pushed) await docker(['image', 'rm', image]).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
};

const settled = installExitBackstop('worker-install-check', stages);
await main();
settled();
if (failures.length > 0) {
  console.log(`FAIL: worker-install-check — ${failures.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log('PASS: worker-install-check');
}
