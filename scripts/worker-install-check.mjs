#!/usr/bin/env node
/**
 * `node scripts/worker-install-check.mjs` — **the one-command install against a real core and a real
 * daemon** (S-22.20, backlog 1021; the second worker, S-29.2). The unit tier runs `install.sh`
 * against a stub `docker` and `curl` (`apps/server/src/workers/install-script.test.ts`); this runs
 * the line a person runs:
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
 *  - **two cores**: `compose.yml`'s `app` (and what it depends on — no runner, no launcher) twice, as
 *    two projects on two fixed ports, each `APP_BASE_URL` the address below with its own port,
 *    advertising those four digests (`APP_IMAGE_REPOSITORY` + `APP_WORKER_IMAGE_DIGESTS`), so the
 *    script each serves names it and the bundle each serves pins them. To the installer they are two
 *    cores: its mark records the core's address;
 *  - **the first core's worker, installed by its served script** into a fresh folder under the
 *    system's temporary directory (`--dir`), with `--no-open`;
 *  - **the second core's worker** (S-29.2), installed by the second core's line with no option but
 *    `--no-open`, as a person runs it: the first worker has the project `agentic-worker`, so the
 *    script names this one after its platform — `~/agentic-worker-<slug>`, the project
 *    `agentic-worker-<slug>`, its own control volume, cache volume, run network and the first free
 *    page port, written into that folder's `.env` with `COMPOSE_PROJECT_NAME`. `~` is a fresh folder
 *    of this run (the installer's `HOME`), so nothing of a person's home is read or written.
 *
 * `APP_BASE_URL` is how both this host (the installer's own `curl`) and a container (the worker and
 * its updater) reach a core: the default bridge's gateway on a Linux engine — an address of the host
 * every bridge network routes to, as `worker-update-check.mjs` measured — and `host.docker.internal`
 * on Docker Desktop, which the host must then resolve too (refused by name when it does not;
 * `--host-address` overrides).
 *
 * ## The project names
 *
 * `install.sh` names the first worker on a machine `agentic-worker`, the same as a developer's own
 * worker on the same daemon (the owner's runs there), and the second after its platform. So this
 * check **refuses to start** when the daemon has any container, volume or network of
 * `agentic-worker`, or any of the first worker's names below — and refuses the second install when
 * the daemon has anything of the project the second core's script would name — it never joins,
 * stops or removes somebody's worker, and a refusal is a `FAIL`, never a skip. Everything else is its
 * own: the cores' projects (`agentic-install-check-core-<suffix>`, `…-core2-<suffix>`), the
 * registry, the first worker's page port ({@link UI_PORT}, off the default 7357), and its named
 * control volume, repository cache volume and run network, which the installer passes from its shell
 * to `docker compose` (`APP_WORKER_CONTROL_VOLUME`, `APP_WORKER_CACHE_VOLUME`,
 * `APP_WORKER_RUN_NETWORK`, `APP_WORKER_UI_PORT`). On a CI runner the daemon is the job's own.
 *
 * ## What it asserts
 *
 *  1. each core serves `install.sh` (200) with its own address filled in, and `compose.yml` pinning
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
 *  4. **the second worker** (S-29.2 (6)): the second core's line exits 0 into
 *     `~/agentic-worker-<slug>`, whose `.env` holds `COMPOSE_PROJECT_NAME`, the three derived names
 *     and a page port (and no `APP_WORKER_LABEL`: the name is the platform's); its project's services
 *     are healthy and its page answers while the first's still do, the first's containers untouched;
 *     a re-run of each line recreates nothing in either project; a hand `docker compose up -d` in the
 *     second folder (no `-p`, no `COMPOSE_*` in its environment) hits the second project and
 *     recreates nothing in either; and the second line's `--uninstall --purge` leaves nothing of the
 *     second worker (no container, volume or network of its project, nor its derived names, nor its
 *     folder) while the first keeps running healthy, its page answering;
 *  5. **`--uninstall --purge`** (the first line) exits 0 and leaves **nothing**: no container,
 *     volume or network of the project, neither named volume nor the run network, and no folder.
 *     The launcher's repository cache volume is made first (`docker volume create`; only a run's
 *     first clone makes it, and none runs here), so the purge's removal of it is exercised;
 *  6. nothing of the check is left: the cores down with their volumes, the second worker's objects,
 *     the registry and the pushed image references removed — whatever happened (`finally`).
 *
 * Every exec and request is bounded, each stage by its own bound; the bounds sum to 29.5 min, under
 * the workflow job's 30 (see {@link INSTALL_MS}'s neighbours), and the measured run is a few minutes.
 * A failure prints the command's output with every secret value the check holds replaced by its
 * name. Not a `verify` target, for the reason none of the Docker checks are: it needs a daemon. With
 * no daemon or no image it exits 1 naming what is missing.
 */
import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
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
const CORE_PORT = Number(optionValue('--core-port', '38789'));
/** The two cores: the first one's worker is installed with `--dir`, the second's as a person does. */
const CORES = [
  { project: `agentic-install-check-core-${SUFFIX}`, port: CORE_PORT, directory: '' },
  { project: `agentic-install-check-core2-${SUFFIX}`, port: CORE_PORT + 1, directory: '' },
];
const REGISTRY_CONTAINER = `agentic-install-check-registry-${SUFFIX}`;
/** The project `install.sh` brings the first worker on a machine up as (see the header). */
const PROJECT = 'agentic-worker';
/** The first worker's page port, off the default and off the other worker checks' (37357, 37358). */
const UI_PORT = 37359;
/** The first installer's shell: the worker's own named objects and page port (passed to compose). */
const WORKER_NAMES = {
  APP_WORKER_CONTROL_VOLUME: `agentic-install-check-${SUFFIX}-ctl`,
  APP_WORKER_CACHE_VOLUME: `agentic-install-check-${SUFFIX}-repo-cache`,
  APP_WORKER_RUN_NETWORK: `agentic-install-check-${SUFFIX}-run-egress`,
  APP_WORKER_UI_PORT: String(UI_PORT),
};
/** A named install's own objects (decision 9 item 1): `<project>-ctl|-repo-cache|-run-egress`. */
const derivedNames = (project) => ({
  volumes: [`${project}-ctl`, `${project}-repo-cache`],
  networks: [`${project}-run-egress`],
});
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
 * under the workflow job's 30 min (`docker-checks.yml`): registry 1 + its answer 1 + four pushes 4 +
 * two cores up 4 + their health 2 + install 3.5 + four health waits 4 + three re-runs 3 + the second
 * install 2 + the hand up 1 + two uninstalls 2 + two cores down 2 = 29.5 min, the rest for the docker
 * queries (measured green before S-29.2: about 1 min to the core's first answer — registry, four
 * pushes and the core — and about 2.5 min in all; the second install pulls nothing).
 */
const DOCKER_QUERY_MS = 60_000;
const REGISTRY_MS = 60_000;
const PUSH_MS = 60_000;
const CORE_UP_MS = 2 * 60_000;
const CORE_DOWN_MS = 60_000;
/** A first install: the pull and the installer's own wait. */
const INSTALL_MS = 3.5 * 60_000;
/** The second core's install: nothing to pull, the installer's own wait. */
const SECOND_INSTALL_MS = 2 * 60_000;
/** A re-run: nothing to pull, nothing to start. */
const RERUN_MS = 60_000;
/** A hand `docker compose up -d` in the second worker's folder, which must change nothing. */
const HAND_UP_MS = 60_000;
/** `--uninstall --purge`: one `compose down --volumes` and a volume removal. */
const UNINSTALL_MS = 60_000;
/** How long every service may take to read healthy once the installer has returned. */
const HEALTHY_MS = 60_000;
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
    cwd: options.cwd ?? REPO,
    ...(options.env === undefined ? {} : { env: options.env }),
  });

const lines = (stdout) =>
  stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/** One core's compose, as its own project on its own port. */
const coreCompose = (instance, composeArgs, timeoutMs = DOCKER_QUERY_MS) =>
  run(
    'docker',
    [
      'compose',
      '-p',
      instance.project,
      '--project-directory',
      instance.directory,
      '-f',
      path.join(REPO, 'compose.yml'),
      ...composeArgs,
    ],
    {
      cwd: REPO,
      env: {
        ...process.env,
        PLATFORM_TAG: TAG,
        APP_PORT: String(instance.port),
        APP_WORKSPACE_CONTROL_VOLUME: `${instance.project}-ctl`,
        APP_WORKSPACE_CACHE_VOLUME: `${instance.project}-repo-cache`,
      },
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
    },
  );

/** A core's compose, its output and errors redacted, for what a failure prints. */
const redactedCore = (instance) => async (composeArgs) => {
  try {
    const { stdout, stderr } = await coreCompose(instance, composeArgs);
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

/** Everything of a project on the daemon: containers, volumes, networks. */
const projectObjects = async (project = PROJECT) => {
  const filter = `label=com.docker.compose.project=${project}`;
  const containers = lines((await docker(['ps', '--all', '--quiet', '--filter', filter])).stdout);
  const volumes = lines((await docker(['volume', 'ls', '--quiet', '--filter', filter])).stdout);
  const networks = lines(
    (await docker(['network', 'ls', '--format', '{{.Name}}', '--filter', filter])).stdout,
  );
  return { containers, volumes, networks };
};

/** Which of the given volumes and networks exist (by exact name). */
const objectsPresent = async ({ volumes, networks }) => {
  const present = [];
  for (const volume of volumes) {
    if (
      await docker(['volume', 'inspect', volume]).then(
        () => true,
        () => false,
      )
    ) {
      present.push(`volume ${volume}`);
    }
  }
  for (const network of networks) {
    if (
      await docker(['network', 'inspect', network]).then(
        () => true,
        () => false,
      )
    ) {
      present.push(`network ${network}`);
    }
  }
  return present;
};

/** Which of the first worker's own named objects exist (by exact name). */
const namedObjectsPresent = () =>
  objectsPresent({
    volumes: [WORKER_NAMES.APP_WORKER_CONTROL_VOLUME, WORKER_NAMES.APP_WORKER_CACHE_VOLUME],
    networks: [WORKER_NAMES.APP_WORKER_RUN_NETWORK],
  });

/** What is left of a project and its own named objects, one entry per object. */
const leftOf = async (project, named) => {
  const left = await projectObjects(project);
  return [
    ...left.containers.map((id) => `container ${id.slice(0, 12)}`),
    ...left.volumes.map((name) => `volume ${name}`),
    ...left.networks.map((name) => `network ${name}`),
    ...(await objectsPresent(named)),
  ];
};

/** One row per container of a project: id, service, state, health, exit code, creation, image. */
const containerRows = async (project = PROJECT) => {
  const { containers } = await projectObjects(project);
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
const waitHealthy = async (what, project = PROJECT) => {
  stages.set(what);
  const deadline = Date.now() + HEALTHY_MS;
  for (;;) {
    const rows = await containerRows(project);
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

/** The installer's `HOME`: a folder of this run, so no person's `~/agentic-worker*` is read. */
let installHome = '';

/**
 * The person's line, run by a shell with `pipefail`, so a failed download is not an empty script.
 * `settings` is what the person's shell sets (the first worker's names; none for the second, whose
 * names are the installer's). The installer's own wait stays inside the run's bound.
 */
const pipeLine = async (url, scriptArgs, timeoutMs, settings = WORKER_NAMES) => {
  const line = `curl -fsSL '${url}' | sh -s -- ${scriptArgs.join(' ')}`;
  console.log(`$ ${line}`);
  const env = {
    ...process.env,
    ...settings,
    HOME: installHome,
    // The docker CLI keeps its context (Docker Desktop's socket) under the real home's .docker.
    DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? path.join(homedir(), '.docker'),
    AGENTIC_INSTALL_WAIT_SECONDS: String(Math.max(30, Math.floor(timeoutMs / 1000) - 30)),
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

/** The page and its state answer 200 on loopback, on the given port. */
const pageAnswers = async (port = UI_PORT) => {
  const answers = [];
  for (const route of ['/', '/api/local/state']) {
    try {
      const { response } = await boundedFetch(stages, `http://127.0.0.1:${port}${route}`);
      answers.push(`${route} ${response.status}`);
    } catch (error) {
      answers.push(`${route} ${String(error)}`);
    }
  }
  return { ok: answers.every((answer) => / 200$/.test(answer)), detail: answers.join(', ') };
};

const summary = (rows) => rows.map((row) => `${row.service}=${row.state}/${row.health}`).join(' ');
/** Each container's service, id and creation time: equal before and after means none was recreated. */
const identity = (rows) => rows.map((row) => `${row.service} ${row.id} ${row.created}`);
const sameContainers = (before, after) =>
  JSON.stringify(identity(after)) === JSON.stringify(identity(before));
const countChange = (before, after) =>
  after.length === before.length
    ? `${after.length} containers`
    : `${before.length} → ${after.length} containers`;

/** The value a `.env` sets for a name (the last line wins), or `undefined`. */
const envValue = (text, name) =>
  [...text.matchAll(new RegExp(`^${name}=(.*)$`, 'gm'))].map((match) => match[1]).at(-1);

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
  const before = await leftOf(PROJECT, {
    volumes: [WORKER_NAMES.APP_WORKER_CONTROL_VOLUME, WORKER_NAMES.APP_WORKER_CACHE_VOLUME],
    networks: [WORKER_NAMES.APP_WORKER_RUN_NETWORK],
  });
  if (before.length > 0) {
    console.error(
      `FAIL: worker-install-check — this daemon already has the compose project ${PROJECT} (or this check's ` +
        `names): ${before.join(', ')}. install.sh installs the first worker on a machine as ${PROJECT}, so ` +
        'the check refuses to run here rather than touch that worker; run it on a daemon with no worker (CI does)',
    );
    process.exit(1);
  }
  const hostAddress = await resolveHostAddress().catch((error) => {
    console.error(`FAIL: worker-install-check — ${error.message}`);
    process.exit(1);
  });
  const coreUrls = CORES.map((instance) => `http://${hostAddress}:${instance.port}`);
  console.log(
    `the cores are ${coreUrls.join(' and ')} to this host and to the workers' containers`,
  );

  const directory = await mkdtemp(path.join(tmpdir(), 'worker-install-check-'));
  for (const [index, instance] of CORES.entries()) {
    instance.directory = path.join(directory, `core-${index + 1}`);
    await mkdir(instance.directory, { recursive: true });
  }
  installHome = path.join(directory, 'home');
  await mkdir(installHome, { recursive: true });
  /** The first installer's folder: absent, so the first run makes it (a person's `~/agentic-worker`). */
  const workerDirectory = path.join(directory, 'agentic-worker');
  const pushed = [];
  let installed = false;
  /** The second worker's project, once the second core's script names it. */
  let secondProject = '';
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

    // ── The two cores ─────────────────────────────────────────────────────────────────────
    for (const [index, instance] of CORES.entries()) {
      await writeFile(
        path.join(instance.directory, '.env'),
        [
          `APP_SECRET_KEY=${SECRET_KEY}`,
          `APP_BASE_URL=${coreUrls[index]}`,
          `APP_BOOTSTRAP_ADMIN_EMAIL=${ADMIN_EMAIL}`,
          `APP_BOOTSTRAP_ADMIN_PASSWORD=${ADMIN_PASSWORD}`,
          `APP_IMAGE_REPOSITORY=${namespace}`,
          `APP_WORKER_IMAGE_DIGESTS=${Object.entries(digests)
            .map(([key, digest]) => `${key}=${digest}`)
            .join(',')}`,
          '',
        ].join('\n'),
      );
      stages.set(`core ${index + 1}: docker compose up`);
      await coreCompose(instance, ['up', '-d', '--no-build', '--wait', 'app'], CORE_UP_MS);
      await waitForOk(stages, `http://127.0.0.1:${instance.port}/healthz`, { totalMs: 60_000 });
    }

    // 1. What the cores serve.
    stages.set('the served scripts and bundles');
    const scripts = [];
    for (const [index, coreUrl] of coreUrls.entries()) {
      const script = await boundedFetch(stages, `${coreUrl}/api/worker/v1/install.sh`);
      scripts.push(script.body);
      check(
        `core ${index + 1} serves install.sh with its own address filled in`,
        script.response.status === 200 &&
          script.body.includes(`CORE_URL='${coreUrl}'`) &&
          !script.body.includes('@@AGENTIC_CORE_URL@@') &&
          !script.body.includes('@@AGENTIC_INSTANCE_SLUG@@'),
        String(script.response.status),
      );
      const bundle = await boundedFetch(stages, `${coreUrl}/api/worker/v1/compose.yml`);
      check(
        `core ${index + 1} serves compose.yml pinning this build’s four registry digests`,
        bundle.response.status === 200 &&
          Object.keys(IMAGES).every((key) => bundle.body.includes(reference(key))),
        String(bundle.response.status),
      );
    }
    const slug = /^CORE_SLUG='([a-z0-9][a-z0-9-]{0,23})'$/m.exec(scripts[1] ?? '')?.[1] ?? '';
    check('the second core renders its platform’s slug into install.sh', slug !== '', slug);
    secondProject = `${PROJECT}-${slug}`;
    const secondNames = derivedNames(secondProject);
    const secondDirectory = path.join(installHome, secondProject);
    const secondTaken = await leftOf(secondProject, secondNames);
    if (secondTaken.length > 0) {
      secondProject = '';
      throw new Error(
        `this daemon already has what the second worker would be named: ${secondTaken.join(', ')}; ` +
          'the check refuses to touch it',
      );
    }

    // 2. The install.
    const installUrl = `${coreUrls[0]}/api/worker/v1/install.sh`;
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
    check(
      'no container was recreated: every id and creation time is the one before',
      sameContainers(afterInstall.rows, afterRerun.rows),
      countChange(afterInstall.rows, afterRerun.rows),
    );
    check(
      'after the re-run every service runs and is healthy',
      afterRerun.problems.length === 0,
      afterRerun.problems.join('; ') || summary(afterRerun.rows),
    );
    const pageAgain = await pageAnswers();
    check('the local page answers after the re-run', pageAgain.ok, pageAgain.detail);

    // 4. The second core's worker beside the first (S-29.2 (6)), installed as a person runs the
    // line: no option but --no-open, nothing set in the shell.
    const secondUrl = `${coreUrls[1]}/api/worker/v1/install.sh`;
    stages.set('the second core’s install');
    const beside = await pipeLine(secondUrl, ['--no-open'], SECOND_INSTALL_MS, {});
    check('the second core’s install line exits 0', beside.ok, beside.ended);
    check(
      `it names the second worker after its platform (${slug}) because the first has ${PROJECT}`,
      beside.output.includes(`named after its platform: ${slug}, in ${secondDirectory}`),
    );
    const secondEnv = await readFile(path.join(secondDirectory, '.env'), 'utf8').catch(() => '');
    const secondPort = Number(envValue(secondEnv, 'APP_WORKER_UI_PORT') ?? Number.NaN);
    check(
      `its .env names its project, its own volumes, network and page port, and no label`,
      envValue(secondEnv, 'COMPOSE_PROJECT_NAME') === secondProject &&
        envValue(secondEnv, 'APP_WORKER_CONTROL_VOLUME') === `${secondProject}-ctl` &&
        envValue(secondEnv, 'APP_WORKER_CACHE_VOLUME') === `${secondProject}-repo-cache` &&
        envValue(secondEnv, 'APP_WORKER_RUN_NETWORK') === `${secondProject}-run-egress` &&
        Number.isInteger(secondPort) &&
        secondPort >= 7357 &&
        secondPort !== UI_PORT &&
        envValue(secondEnv, 'APP_WORKER_LABEL') === undefined,
      secondEnv.replace(/\n/g, ' '),
    );
    const secondInstalled = await waitHealthy('the second worker’s services', secondProject);
    check(
      'the second worker’s services run and are healthy, its one-shots exited 0',
      secondInstalled.problems.length === 0,
      secondInstalled.problems.join('; ') || summary(secondInstalled.rows),
    );
    const secondPage = await pageAnswers(secondPort);
    check(
      `the second worker’s page answers on 127.0.0.1:${secondPort}`,
      secondPage.ok,
      secondPage.detail,
    );
    const firstBeside = await containerRows();
    check(
      'the second install touched none of the first worker’s containers',
      sameContainers(afterRerun.rows, firstBeside),
      countChange(afterRerun.rows, firstBeside),
    );
    const pageBeside = await pageAnswers();
    check(
      'the first worker’s page still answers beside the second',
      pageBeside.ok,
      pageBeside.detail,
    );

    // A re-run of each line recreates nothing in either project.
    stages.set('the second core’s re-run');
    const secondAgain = await pipeLine(secondUrl, ['--no-open'], RERUN_MS, {});
    check(
      'the second core’s re-run exits 0 and says its worker is already installed',
      secondAgain.ok && secondAgain.output.includes('already installed'),
      secondAgain.ended,
    );
    stages.set('the first core’s re-run beside the second');
    const firstAgain = await pipeLine(installUrl, installArgs, RERUN_MS);
    check(
      'the first core’s re-run exits 0 and says its worker is already installed',
      firstAgain.ok && firstAgain.output.includes('already installed'),
      firstAgain.ended,
    );
    const firstRows = await containerRows();
    const secondRows = await containerRows(secondProject);
    check(
      'the re-runs recreated nothing in either project',
      sameContainers(afterRerun.rows, firstRows) &&
        sameContainers(secondInstalled.rows, secondRows),
      `${countChange(afterRerun.rows, firstRows)}; ${countChange(secondInstalled.rows, secondRows)}`,
    );

    // A hand `docker compose up -d` in the second folder: its .env's COMPOSE_PROJECT_NAME beats the
    // bundle's `name: agentic-worker`, so it is the second project, unchanged — not the first.
    stages.set('a hand docker compose up -d in the second folder');
    const handEnv = { ...process.env };
    for (const name of Object.keys(handEnv)) {
      if (name.startsWith('COMPOSE_') || name === 'PLATFORM_TAG') delete handEnv[name];
    }
    const hand = await docker(['compose', 'up', '-d'], {
      cwd: secondDirectory,
      env: handEnv,
      timeoutMs: HAND_UP_MS,
    }).then(
      () => ({ ok: true, detail: undefined }),
      (error) => ({ ok: false, detail: redact(`${error?.stderr ?? ''}`).slice(-400) }),
    );
    check('a hand docker compose up -d in the second folder exits 0', hand.ok, hand.detail);
    const firstAfterHand = await containerRows();
    const secondAfterHand = await containerRows(secondProject);
    check(
      `it hit ${secondProject} and recreated nothing in either project`,
      sameContainers(firstRows, firstAfterHand) && sameContainers(secondRows, secondAfterHand),
      `${countChange(firstRows, firstAfterHand)}; ${countChange(secondRows, secondAfterHand)}`,
    );

    // Uninstalling the second leaves the first running.
    stages.set('the second core’s uninstall');
    const secondRemoved = await pipeLine(secondUrl, ['--uninstall', '--purge'], UNINSTALL_MS, {});
    check('the second core’s uninstall line exits 0', secondRemoved.ok, secondRemoved.ended);
    const secondLeft = await leftOf(secondProject, secondNames);
    check(
      `nothing of ${secondProject} is left, nor its own volumes and run network`,
      secondLeft.length === 0,
      secondLeft.join(', '),
    );
    check(
      'the second worker’s folder is removed',
      !(await stat(secondDirectory).then(
        () => true,
        () => false,
      )),
    );
    const firstAlone = await waitHealthy('the first worker after the second’s uninstall');
    check(
      'the first worker keeps running healthy, none of its containers recreated',
      firstAlone.problems.length === 0 && sameContainers(firstRows, firstAlone.rows),
      firstAlone.problems.join('; ') || countChange(firstRows, firstAlone.rows),
    );
    const pageAlone = await pageAnswers();
    check('the first worker’s page still answers', pageAlone.ok, pageAlone.detail);

    // 5. Uninstall and purge. The launcher makes its repository cache volume at a run's first
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
    for (const [index, instance] of CORES.entries()) {
      await describeInstance(redactedCore(instance), `core ${index + 1} `).catch(() => undefined);
    }
    for (const project of [PROJECT, secondProject].filter(Boolean)) {
      const rows = await containerRows(project).catch(() => []);
      if (rows.length > 0) console.error(`--- ${project}: ${summary(rows)}`);
    }
  } finally {
    stages.set('cleanup');
    // Only what this run brought up: neither project existed before it (refused above).
    const owned = [];
    if (installed) {
      owned.push({
        project: PROJECT,
        volumes: [WORKER_NAMES.APP_WORKER_CONTROL_VOLUME, WORKER_NAMES.APP_WORKER_CACHE_VOLUME],
        networks: [WORKER_NAMES.APP_WORKER_RUN_NETWORK],
      });
    }
    if (secondProject !== '')
      owned.push({ project: secondProject, ...derivedNames(secondProject) });
    for (const { project, volumes, networks } of owned) {
      const left = await projectObjects(project).catch(() => ({
        containers: [],
        volumes: [],
        networks: [],
      }));
      if (left.containers.length > 0) {
        const { stdout } = await docker([
          'compose',
          '-p',
          project,
          'logs',
          '--no-color',
          '--tail',
          '60',
        ]).catch(() => ({ stdout: '' }));
        if (failures.length > 0) console.error(redact(stdout));
        await docker(['container', 'rm', '-f', ...left.containers]).catch(() => undefined);
      }
      for (const network of [...left.networks, ...networks]) {
        await docker(['network', 'rm', network]).catch(() => undefined);
      }
      for (const volume of [...left.volumes, ...volumes]) {
        await docker(['volume', 'rm', volume]).catch(() => undefined);
      }
    }
    for (const instance of CORES) {
      if (instance.directory === '') continue;
      await coreCompose(instance, ['down', '-v', '--remove-orphans'], CORE_DOWN_MS).catch(
        () => undefined,
      );
    }
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
