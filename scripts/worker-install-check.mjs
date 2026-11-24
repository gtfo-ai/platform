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
 *  - **a second core** (S-29.2): the same `app` as a second compose project on the next port, so one
 *    machine holds a worker for each core, as the owner's Mac does for two platforms;
 *  - **the workers, installed by the served scripts** with `--no-open` and `HOME` pointed at a fresh
 *    folder under the system's temporary directory (`DOCKER_CONFIG` kept, so the CLI keeps its
 *    context): the first core's into `~/agentic-worker` as today, the second core's beside it with
 *    `--name` into `~/agentic-worker-<name>`. `APP_BASE_URL` is how both this host (the installer's own
 *    `curl`) and a container (the worker and its updater) reach the core: the default bridge's
 *    gateway on a Linux engine — an address of the host every bridge network routes to, as
 *    `worker-update-check.mjs` measured — and `host.docker.internal` on Docker Desktop, which the
 *    host must then resolve too (refused by name when it does not; `--host-address` overrides).
 *
 * ## The project names
 *
 * `install.sh` installs a first worker as the compose project `agentic-worker`, the same as a
 * developer's own worker on the same daemon (the owner's runs there). So this check **refuses to
 * start** when the daemon has any container, volume or network of that project or of the second
 * worker's (`agentic-worker-<name>`, {@link NAME_B}), or any of the names below — it never joins,
 * stops or removes somebody's worker, and a refusal is a `FAIL`, never a skip. Everything else is its
 * own: the cores' projects (`agentic-install-check-core-<suffix>`, `…-core2-<suffix>`), the registry,
 * the first worker's page port ({@link UI_PORT}, off the default 7357), and its named control volume,
 * repository cache volume and run network, which the installer saves from its shell into `.env`
 * (`APP_WORKER_CONTROL_VOLUME`, `APP_WORKER_CACHE_VOLUME`, `APP_WORKER_RUN_NETWORK`,
 * `APP_WORKER_UI_PORT`). The second worker is given **nothing** on the shell but a label: its names
 * and its page port (the first free one from 7357) are the installer's own, read back from its `.env`.
 * On a CI runner the daemon is the job's own.
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
 *  4. **the second worker** (S-29.2, the second core's script with `--name` and a free-text
 *     `APP_WORKER_LABEL` holding spaces, `#`, double quotes and `$`): exits 0; its `.env` holds
 *     `COMPOSE_PROJECT_NAME`, its three names and the first free page port, and the label
 *     single-quoted; its services run and are healthy beside the first's, both pages answer, the
 *     container's `APP_WORKER_LABEL` and the page's `identity.label` are the label byte for byte (what
 *     Compose made of the quoted line, BACKLOG 1643), and its updater's host-bundle mount names its
 *     folder (the fourth place resolution looks; printed as Docker reports it);
 *  5. **a re-run of each core's script** (no option) finds its own install and recreates nothing of
 *     either, and **a hand `docker compose up -d`** in the second folder, with nothing on the shell,
 *     is the second project (`COMPOSE_PROJECT_NAME` in its `.env` beats the bundle's `name:`, the
 *     owner's measurement of 2026-11-24 that the docs page does not state) and recreates nothing;
 *  6. **`--uninstall --purge --name <name>`** from the *first* core's script removes the second worker
 *     — its containers, volumes, run network, repository cache and folder — and leaves the first
 *     running, its containers the same;
 *  7. **`--uninstall --purge`** of the first (the same piped line) exits 0 and leaves **nothing**: no
 *     container, volume or network of the project, neither named volume nor the run network, and no
 *     folder. Each launcher's repository cache volume is made first (`docker volume create`; only a
 *     run's first clone makes it, and none runs here), so each purge's removal of it is exercised;
 *  8. nothing of the check is left: both cores down with their volumes, the registry and the pushed
 *     image references removed — whatever happened (`finally`).
 *
 * Every exec and request is bounded, each stage by its own bound, and the bounds sum under the
 * workflow job's 45 min (see {@link INSTALL_MS}'s neighbours); a failure prints the command's output with every secret value
 * the check holds replaced by its name. Not a `verify` target, for the reason none of the Docker
 * checks are: it needs a daemon. With no daemon or no image it exits 1 naming what is missing.
 */
import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
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
const REGISTRY_CONTAINER = `agentic-install-check-registry-${SUFFIX}`;
/** The project `install.sh` brings a first worker up as (see the header). */
const PROJECT = 'agentic-worker';
const CORE_PORT = Number(optionValue('--core-port', '38789'));
/** The two cores: the first core's worker is today's install, the second's a named one beside it. */
const CORES = [
  { label: 'core', project: `agentic-install-check-core-${SUFFIX}`, port: CORE_PORT },
  { label: 'core2', project: `agentic-install-check-core2-${SUFFIX}`, port: CORE_PORT + 1 },
];
/** The first worker's page port, off the default and off the other worker checks' (37357, 37358). */
const UI_PORT = 37359;
/** The first installer's shell: the worker's own named objects and page port (saved into `.env`). */
const WORKER_NAMES = {
  APP_WORKER_CONTROL_VOLUME: `agentic-install-check-${SUFFIX}-ctl`,
  APP_WORKER_CACHE_VOLUME: `agentic-install-check-${SUFFIX}-repo-cache`,
  APP_WORKER_RUN_NETWORK: `agentic-install-check-${SUFFIX}-run-egress`,
  APP_WORKER_UI_PORT: String(UI_PORT),
};
/** The second worker's `--name` (S-29.2): inside the installer's pattern, this run's own. */
const NAME_B = `ic-${SUFFIX.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`
  .slice(0, 24)
  .replace(/-+$/, '');
const PROJECT_B = `agentic-worker-${NAME_B}`;
/** What the installer names the second worker's objects (TD-031 2026-11-24, item 1). */
const NAMES_B = {
  control: `${PROJECT_B}-ctl`,
  cache: `${PROJECT_B}-repo-cache`,
  network: `${PROJECT_B}-run-egress`,
};
/** A free-text label: spaces, `#`, double quotes and `$` (BACKLOG 1643), with nothing the cut changes. */
const LABEL_B = 'Install check "B" #2 $HOME & co';
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
/** Where the updater mounts its worker's folder (`HOST_BUNDLE_MOUNT`, `apps/server/src/updater`). */
const HOST_BUNDLE_MOUNT = '/var/lib/platform/host-bundle';

/** Obviously fake (BD-002), past every floor, and in no shape a pattern rule knows. */
const SECRET_KEY = 'install-check-not-a-real-secret-key-00000000000000';
const ADMIN_EMAIL = 'operator@example.test';
const ADMIN_PASSWORD = 'install-check-not-a-real-password';
const SECRETS = { SECRET_KEY, ADMIN_PASSWORD };

/**
 * The bounds, each a stage's own, so a wedged one ends with a `FAIL` line naming it. Their sum stays
 * under the workflow job's 45 min (`docker-checks.yml`): registry 1 + its answer 1 + four pushes 6 +
 * both cores up (together) 3 + their health 2 + first install 5 + health 1.5 + its re-run 3 + health
 * 1.5 + second install 3 + health 1.5 + two re-runs 4 + the hand up 1 + health 1.5 + second
 * uninstall 2 + first uninstall 2 + cores down (together) 2 = 41 min, the rest for the docker
 * queries (measured green before S-29.2: about 1 min to the core's first answer — registry, four
 * pushes and the core — and about 2.5 min in all).
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
/** A second worker: the images are on the daemon, so the installer's own wait. */
const SECOND_INSTALL_MS = 3 * 60_000;
/** A re-run: nothing to pull, the same wait. */
const RERUN_MS = 3 * 60_000;
/** A re-run of a worker already checked once: the same, a little shorter. */
const QUICK_RERUN_MS = 2 * 60_000;
/** A person's own `docker compose up -d` in a folder: nothing to create. */
const HAND_UP_MS = 60_000;
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
    cwd: options.cwd ?? REPO,
    ...(options.env === undefined ? {} : { env: options.env }),
  });

const lines = (stdout) =>
  stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/** One core's compose: `compose.yml`'s `app` as its own project, from its own folder's `.env`. */
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

/** How a container — and, for the installer, this host — reaches a core (see the header). */
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

/** Everything of a compose project on the daemon: containers, volumes, networks. */
const projectObjects = async (project) => {
  const filter = `label=com.docker.compose.project=${project}`;
  const containers = lines((await docker(['ps', '--all', '--quiet', '--filter', filter])).stdout);
  const volumes = lines((await docker(['volume', 'ls', '--quiet', '--filter', filter])).stdout);
  const networks = lines(
    (await docker(['network', 'ls', '--format', '{{.Name}}', '--filter', filter])).stdout,
  );
  return { containers, volumes, networks };
};

const exists = (kind, name) =>
  docker([kind, 'inspect', name]).then(
    () => true,
    () => false,
  );

/** Which of a worker's own named objects exist (by exact name). */
const namedObjectsPresent = async (names) => {
  const present = [];
  for (const volume of [names.control, names.cache]) {
    if (await exists('volume', volume)) present.push(`volume ${volume}`);
  }
  if (await exists('network', names.network)) present.push(`network ${names.network}`);
  return present;
};
const NAMES_A = {
  control: WORKER_NAMES.APP_WORKER_CONTROL_VOLUME,
  cache: WORKER_NAMES.APP_WORKER_CACHE_VOLUME,
  network: WORKER_NAMES.APP_WORKER_RUN_NETWORK,
};

/** What a project and its named objects leave on the daemon, one phrase each. */
const leftOf = async (project, names) => {
  const left = await projectObjects(project);
  return [
    ...left.containers.map((id) => `container ${id.slice(0, 12)}`),
    ...left.volumes.map((name) => `volume ${name}`),
    ...left.networks.map((name) => `network ${name}`),
    ...(await namedObjectsPresent(names)),
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
      env: container.Config?.Env ?? [],
      mounts: container.Mounts ?? [],
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

/** The home folder every installer run gets (set in `main`), so `~/agentic-worker*` is this run's. */
let homeDirectory = '';

/**
 * The person's line, run by a shell with `pipefail`, so a failed download is not an empty script.
 * `shellEnv` is what the person's shell holds beyond `HOME` (the first worker's names, a label).
 */
const pipeLine = async (url, scriptArgs, timeoutMs, shellEnv = {}) => {
  const line = `curl -fsSL '${url}' | sh -s -- ${scriptArgs.join(' ')}`;
  console.log(`$ ${line}`);
  const env = {
    ...process.env,
    ...shellEnv,
    HOME: homeDirectory,
    // The CLI's own configuration (its context, on Docker Desktop) stays where it was.
    DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? path.join(homedir(), '.docker'),
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
const identity = (rows) => rows.map((row) => `${row.service} ${row.id} ${row.created}`);
const sameContainers = (before, after) =>
  JSON.stringify(identity(after)) === JSON.stringify(identity(before));
const containerCount = (before, after) =>
  after.length === before.length
    ? `${after.length} containers`
    : `${before.length} → ${after.length} containers`;

/** The value a `.env` line sets (bare or single-quoted), read as the installer writes it. */
const envLinesOf = (text) =>
  Object.fromEntries(
    text
      .split('\n')
      .map((line) => /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line))
      .filter((match) => match !== null)
      .map((match) => [match[1], match[2]]),
  );

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
  // The project names are the script's (see the header): refuse rather than touch somebody's worker.
  const existing = [...(await leftOf(PROJECT, NAMES_A)), ...(await leftOf(PROJECT_B, NAMES_B))];
  if (existing.length > 0) {
    console.error(
      `FAIL: worker-install-check — this daemon already has the compose project ${PROJECT} or ${PROJECT_B} ` +
        `(or this check's names): ${existing.join(', ')}. install.sh installs a first worker as ${PROJECT}, ` +
        'so the check refuses to run here rather than touch that worker; run it on a daemon with no worker (CI does)',
    );
    process.exit(1);
  }
  const hostAddress = await resolveHostAddress().catch((error) => {
    console.error(`FAIL: worker-install-check — ${error.message}`);
    process.exit(1);
  });

  const directory = await mkdtemp(path.join(tmpdir(), 'worker-install-check-'));
  homeDirectory = path.join(directory, 'home');
  /** The installers' folders: absent, so each first run makes it (a person's `~/agentic-worker…`). */
  const workerDirectory = path.join(homeDirectory, 'agentic-worker');
  const workerDirectoryB = path.join(homeDirectory, PROJECT_B);
  const cores = CORES.map((core) => ({
    ...core,
    directory: path.join(directory, core.label),
    url: `http://${hostAddress}:${core.port}`,
  }));
  for (const core of cores) {
    await mkdir(core.directory, { recursive: true });
    console.log(`the ${core.label} is ${core.url} to this host and to the workers' containers`);
  }
  await mkdir(homeDirectory, { recursive: true });
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

    // ── The two cores ─────────────────────────────────────────────────────────────────────
    for (const core of cores) {
      await writeFile(
        path.join(core.directory, '.env'),
        [
          `APP_SECRET_KEY=${SECRET_KEY}`,
          `APP_BASE_URL=${core.url}`,
          `APP_BOOTSTRAP_ADMIN_EMAIL=${ADMIN_EMAIL}`,
          `APP_BOOTSTRAP_ADMIN_PASSWORD=${ADMIN_PASSWORD}`,
          `APP_IMAGE_REPOSITORY=${namespace}`,
          `APP_WORKER_IMAGE_DIGESTS=${Object.entries(digests)
            .map(([key, digest]) => `${key}=${digest}`)
            .join(',')}`,
          '',
        ].join('\n'),
      );
    }
    stages.set('cores: docker compose up');
    await Promise.all(
      cores.map((core) =>
        coreCompose(core, ['up', '-d', '--no-build', '--wait', 'app'], CORE_UP_MS),
      ),
    );
    for (const core of cores) {
      await waitForOk(stages, `http://127.0.0.1:${core.port}/healthz`, { totalMs: 60_000 });
    }
    const [coreA, coreB] = cores;

    // 1. What the core serves.
    stages.set('the served script and bundle');
    const script = await boundedFetch(stages, `${coreA.url}/api/worker/v1/install.sh`);
    check(
      'the core serves install.sh with its own address filled in',
      script.response.status === 200 &&
        script.body.includes(`CORE_URL='${coreA.url}'`) &&
        !script.body.includes('@@AGENTIC_CORE_URL@@') &&
        !script.body.includes('@@AGENTIC_PLATFORM_SLUG@@'),
      String(script.response.status),
    );
    console.log(
      `note  the platform's slug the core rendered: ${/^PLATFORM_SLUG='([^']*)'$/m.exec(script.body)?.[1] ?? '(none)'}`,
    );
    const bundle = await boundedFetch(stages, `${coreA.url}/api/worker/v1/compose.yml`);
    check(
      'the core serves compose.yml pinning this build’s four registry digests',
      bundle.response.status === 200 &&
        Object.keys(IMAGES).every((key) => bundle.body.includes(reference(key))),
      String(bundle.response.status),
    );

    // 2. The install: today's, into ~/agentic-worker.
    const installUrl = `${coreA.url}/api/worker/v1/install.sh`;
    const installUrlB = `${coreB.url}/api/worker/v1/install.sh`;
    stages.set('the install');
    installed = true;
    const first = await pipeLine(installUrl, ['--no-open'], INSTALL_MS, WORKER_NAMES);
    check('the install line exits 0', first.ok, first.ended);
    check(
      'the installer says the worker is running',
      first.output.includes('The worker is running.'),
    );
    check(
      `the first worker is today's install: ${workerDirectory}, project ${PROJECT}`,
      first.output.includes(`Its folder: ${workerDirectory} (compose project ${PROJECT})`),
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
    const second = await pipeLine(installUrl, ['--no-open'], RERUN_MS, WORKER_NAMES);
    check('the re-run exits 0', second.ok, second.ended);
    check(
      'the re-run says the worker is already installed and recreates nothing',
      second.output.includes('already installed'),
    );
    const afterRerun = await waitHealthy('the re-run worker’s services');
    check(
      'no container was recreated: every id and creation time is the one before',
      sameContainers(afterInstall.rows, afterRerun.rows),
      containerCount(afterInstall.rows, afterRerun.rows),
    );
    check(
      'after the re-run every service runs and is healthy',
      afterRerun.problems.length === 0,
      afterRerun.problems.join('; ') || summary(afterRerun.rows),
    );
    const pageAgain = await pageAnswers();
    check('the local page answers after the re-run', pageAgain.ok, pageAgain.detail);

    // 4. The second core's worker, beside the first (S-29.2): --name and a label, nothing else.
    stages.set('the second worker');
    const installB = await pipeLine(
      installUrlB,
      ['--name', NAME_B, '--no-open'],
      SECOND_INSTALL_MS,
      {
        APP_WORKER_LABEL: LABEL_B,
      },
    );
    check('the second core’s install line with --name exits 0', installB.ok, installB.ended);
    check(
      `the second worker is installed in ${workerDirectoryB} as ${PROJECT_B}`,
      installB.output.includes(`Its folder: ${workerDirectoryB} (compose project ${PROJECT_B})`),
    );
    const envB = await readFile(path.join(workerDirectoryB, '.env'), 'utf8').catch(() => '');
    const settingsB = envLinesOf(envB);
    const portB = Number(settingsB.APP_WORKER_UI_PORT);
    check(
      'its .env names its project, volumes and network, a free page port and the label, single-quoted',
      settingsB.COMPOSE_PROJECT_NAME === PROJECT_B &&
        settingsB.APP_WORKER_CONTROL_VOLUME === NAMES_B.control &&
        settingsB.APP_WORKER_CACHE_VOLUME === NAMES_B.cache &&
        settingsB.APP_WORKER_RUN_NETWORK === NAMES_B.network &&
        Number.isInteger(portB) &&
        portB >= 7357 &&
        portB !== UI_PORT &&
        settingsB.APP_WORKER_LABEL === `'${LABEL_B}'`,
      envB.trim().replace(/\n/g, ' | '),
    );
    const afterInstallB = await waitHealthy('the second worker’s services', PROJECT_B);
    check(
      'the second worker’s services run, are healthy and its one-shots exited 0',
      afterInstallB.problems.length === 0,
      afterInstallB.problems.join('; ') || summary(afterInstallB.rows),
    );
    const workerB = afterInstallB.rows.find((row) => row.service === 'remote-worker');
    const labelInContainer = (workerB?.env ?? [])
      .find((entry) => entry.startsWith('APP_WORKER_LABEL='))
      ?.slice('APP_WORKER_LABEL='.length);
    check(
      'Compose read the quoted label byte for byte: the container’s APP_WORKER_LABEL is the label',
      labelInContainer === LABEL_B,
      JSON.stringify(labelInContainer ?? null),
    );
    try {
      const { body } = await boundedFetch(stages, `http://127.0.0.1:${portB}/api/local/state`);
      const label = JSON.parse(body)?.identity?.label;
      check(
        'the second page’s identity.label is the label',
        label === LABEL_B,
        JSON.stringify(label),
      );
    } catch (error) {
      check('the second page’s identity.label is the label', false, String(error));
    }
    const updaterB = afterInstallB.rows.find((row) => row.service === 'updater');
    const mountB = updaterB?.mounts.find((mount) => mount.Destination === HOST_BUNDLE_MOUNT);
    console.log(
      `note  the second updater's host bundle, as Docker reports it: ${mountB?.Source ?? 'none'}`,
    );
    const realB = await realpath(workerDirectoryB).catch(() => workerDirectoryB);
    check(
      'the second updater mounts its own folder (where resolution looks fourth)',
      mountB !== undefined && [workerDirectoryB, realB].includes(mountB.Source),
      mountB?.Source ?? 'no mount',
    );
    const pagesBoth = [await pageAnswers(UI_PORT), await pageAnswers(portB)];
    check(
      `both pages answer, 127.0.0.1:${UI_PORT} and 127.0.0.1:${portB}`,
      pagesBoth.every((answer) => answer.ok),
      pagesBoth.map((answer) => answer.detail).join(' / '),
    );
    const rowsA = (await waitHealthy('the first worker beside the second')).rows;
    check(
      'the second install recreated nothing of the first',
      sameContainers(afterRerun.rows, rowsA),
      containerCount(afterRerun.rows, rowsA),
    );

    // 5. A re-run of each core's script finds its own install; a hand `up` is the second project.
    stages.set('the re-runs of both');
    const rerunA = await pipeLine(installUrl, ['--no-open'], QUICK_RERUN_MS);
    const rerunB = await pipeLine(installUrlB, ['--no-open'], QUICK_RERUN_MS);
    check('both re-runs exit 0', rerunA.ok && rerunB.ok, rerunA.ended ?? rerunB.ended);
    check(
      'each re-run found its own install',
      rerunA.output.includes(`(compose project ${PROJECT})`) &&
        rerunB.output.includes(`(compose project ${PROJECT_B})`) &&
        rerunA.output.includes('already installed') &&
        rerunB.output.includes('already installed'),
    );
    const afterRerunsA = await waitHealthy('the first worker after both re-runs');
    const afterRerunsB = await waitHealthy('the second worker after both re-runs', PROJECT_B);
    check(
      'the re-runs recreated nothing of either worker',
      sameContainers(rowsA, afterRerunsA.rows) &&
        sameContainers(afterInstallB.rows, afterRerunsB.rows),
      `${containerCount(rowsA, afterRerunsA.rows)}; ${containerCount(afterInstallB.rows, afterRerunsB.rows)}`,
    );
    stages.set('a hand docker compose up -d in the second folder');
    const handEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !key.startsWith('APP_') && !key.startsWith('COMPOSE_') && !key.startsWith('PLATFORM_'),
      ),
    );
    // What Compose makes of the folder with nothing on the shell: the project its .env names, and
    // the label read off the single-quoted line (the installer's own run had it on the shell too).
    const config = await docker(['compose', 'config', '--format', 'json'], {
      cwd: workerDirectoryB,
      env: handEnv,
    }).then(
      ({ stdout }) => JSON.parse(stdout),
      (error) => ({ error: redact(`${error?.stderr ?? ''}${String(error)}`) }),
    );
    check(
      `Compose reads the second folder as ${PROJECT_B}, not the bundle's name: agentic-worker`,
      config?.name === PROJECT_B,
      String(config?.name ?? config?.error),
    );
    // `compose config` prints a literal `$` as `$$`, so that its output reads back as the same model
    // (measured on CI's Compose: `$HOME` came back `$$HOME` while the container held `$HOME`).
    const configLabel = config?.services?.['remote-worker']?.environment?.APP_WORKER_LABEL;
    check(
      'and reads the single-quoted label in its .env byte for byte (BACKLOG 1643)',
      typeof configLabel === 'string' && configLabel.replaceAll('$$', '$') === LABEL_B,
      JSON.stringify(configLabel ?? null),
    );
    const hand = await docker(['compose', 'up', '-d'], {
      cwd: workerDirectoryB,
      env: handEnv,
      timeoutMs: HAND_UP_MS,
    }).then(
      () => ({ ok: true, detail: 'exit 0' }),
      (error) => ({ ok: false, detail: redact(`${error?.stderr ?? ''}${String(error)}`) }),
    );
    check('docker compose up -d in the second folder exits 0', hand.ok, hand.detail);
    const afterHandA = await containerRows();
    const afterHandB = await waitHealthy('the second worker after the hand up', PROJECT_B);
    check(
      `the hand up is ${PROJECT_B} (its .env's COMPOSE_PROJECT_NAME) and recreates nothing of either`,
      sameContainers(afterRerunsB.rows, afterHandB.rows) &&
        sameContainers(afterRerunsA.rows, afterHandA),
      `${containerCount(afterRerunsB.rows, afterHandB.rows)}; first ${containerCount(afterRerunsA.rows, afterHandA)}`,
    );

    // 6. The first core's script removes the second worker by its name, and only it.
    stages.set('the second worker’s uninstall');
    await docker(['volume', 'create', NAMES_B.cache]);
    const removedB = await pipeLine(
      installUrl,
      ['--uninstall', '--purge', '--name', NAME_B],
      UNINSTALL_MS,
    );
    check('--uninstall --purge --name exits 0', removedB.ok, removedB.ended);
    const leftB = await leftOf(PROJECT_B, NAMES_B);
    check(
      `nothing of ${PROJECT_B} is left: no container, volume, network or repository cache`,
      leftB.length === 0,
      leftB.join(', '),
    );
    const folderBLeft = await stat(workerDirectoryB).then(
      () => true,
      () => false,
    );
    check('the second worker’s folder is removed', !folderBLeft);
    const afterRemoveB = await waitHealthy('the first worker after the second is removed');
    check(
      'the first worker still runs, healthy, its containers the same',
      afterRemoveB.problems.length === 0 && sameContainers(afterRerunsA.rows, afterRemoveB.rows),
      afterRemoveB.problems.join('; ') || containerCount(afterRerunsA.rows, afterRemoveB.rows),
    );

    // 7. Uninstall and purge the first. The launcher makes its repository cache volume at a run's
    // first clone, and no run happens here, so it is made by hand: the purge's own removal of it (a
    // volume Compose does not own) is then exercised rather than skipped.
    stages.set('the uninstall');
    await docker(['volume', 'create', WORKER_NAMES.APP_WORKER_CACHE_VOLUME]);
    check(
      `the launcher's cache volume ${WORKER_NAMES.APP_WORKER_CACHE_VOLUME} exists before the purge`,
      await exists('volume', WORKER_NAMES.APP_WORKER_CACHE_VOLUME),
    );
    const removed = await pipeLine(installUrl, ['--uninstall', '--purge'], UNINSTALL_MS);
    check('the uninstall line exits 0', removed.ok, removed.ended);
    const leftOver = await leftOf(PROJECT, NAMES_A);
    check(
      `the purge removed the cache volume ${WORKER_NAMES.APP_WORKER_CACHE_VOLUME}`,
      !leftOver.includes(`volume ${WORKER_NAMES.APP_WORKER_CACHE_VOLUME}`),
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
    installed = !(leftOver.length === 0 && leftB.length === 0 && !folderLeft);
  } catch (error) {
    failures.push(`${stages.current}: ${redact(String(error?.stderr ?? '') || String(error))}`);
    for (const core of cores) {
      await describeInstance(redactedCore(core), `${core.label} `).catch(() => undefined);
    }
    for (const project of [PROJECT, PROJECT_B]) {
      const rows = await containerRows(project).catch(() => []);
      if (rows.length > 0) console.error(`--- ${project}: ${summary(rows)}`);
    }
  } finally {
    stages.set('cleanup');
    if (installed) {
      // Only what this run brought up: neither project existed before it (refused above).
      for (const [project, names] of [
        [PROJECT, NAMES_A],
        [PROJECT_B, NAMES_B],
      ]) {
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
        for (const network of [...left.networks, names.network]) {
          await docker(['network', 'rm', network]).catch(() => undefined);
        }
        for (const volume of [...left.volumes, names.control, names.cache]) {
          await docker(['volume', 'rm', volume]).catch(() => undefined);
        }
      }
    }
    await Promise.all(
      cores.map((core) =>
        coreCompose(core, ['down', '-v', '--remove-orphans'], CORE_DOWN_MS).catch(() => undefined),
      ),
    );
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
