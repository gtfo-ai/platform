#!/usr/bin/env node
/**
 * `node scripts/launcher-control-plane-check.mjs` — **WP-53's acceptance criteria (1), (3) and (7)**
 * against a Docker daemon and the real `platform-runtime` image.
 *
 * ## Why this is a script and not a `verify` target
 *
 * It needs a daemon, three images and about a minute, so making it one would put it in CI's lint or
 * unit job (`scripts/verify-targets.ts` derives one from the other) and neither has a daemon. It
 * lands beside `runlet-container-check.mjs` (TD-025's own Docker verification) and
 * `runlet-launcher-check.mjs` (WP-15g's) for the same reason.
 *
 * ## Who has actually run this, which is the part a reader needs
 *
 * **No CI job runs it**, and criterion (1) of WP-53 — *a run starts, streams and ends through the
 * control plane and the shim's socket* — rests on it alone. As of WP-53 it had been run **four
 * times in the implementer's shell and once in the orchestrator's**, on Docker Desktop
 * (`linux/arm64`) against `platform-runtime:dev`, 18/18 each time. **No reviewer has reproduced
 * it**: Docker was out of bounds for that review, so the criterion is confirmed by the two people
 * who wrote and merged it and by nobody else. That is weaker than a tier and should not be read as
 * if it were one; `docs/technical/PROGRESS.md` under WP-53 says the same thing, and the row's status
 * line carries it beside the CI ids.
 *
 * It follows `pnpm eval`'s shipped pattern for a check this repository cannot run for itself: with
 * no daemon or no image it **exits non-zero naming what is missing**, rather than printing a green
 * line about a measurement nobody took (WP-22's precedent, PROGRESS backlog 27). A skip counts as a
 * failure here for the same reason it does there.
 *
 * ## What is different from `runlet-launcher-check.mjs`, and why it is a second script
 *
 * That one composes the launcher **and** the runner in one process, which is Q52's in-process mode
 * and is still a valid deployment (TD-028 decision 1). It therefore cannot show that the two planes
 * are separate. This one runs **three containers**:
 *
 *  - a launcher container (`launcher-control-plane-launcher.mjs`) holding the Docker client and
 *    exposing TD-028's control plane;
 *  - a **second** launcher container configured with a CLI path the run image does not carry, which
 *    is what makes backlog **34**'s *"a wrong path fails by name on the platform side"* a measurement
 *    rather than a claim;
 *  - a runner container (`launcher-control-plane-runner.mjs`) holding **no** Docker client, which
 *    reaches the first over HTTP and opens the run's Unix socket off the shared `ctl` volume.
 *
 * ## What it does not prove
 *
 * The model: the run image's `claude` is real and a real run of it needs a credential this check
 * deliberately does not have, so the **executable** is `test/fixtures/runlet/fake-claude-cli` from
 * the read-only checkout mount. What backlog 34 is about is the **path**, and both halves of that
 * are measured: the launcher answers the run image's own `/usr/local/bin/claude` (having verified it
 * with `test -x` inside the image), and the substitution reaches `SpawnOptions.command`, which is
 * the string the shim execs. It also does not prove the egress *filter*, or the compose file.
 *
 * ## What WP-82 added
 *
 *  - **Backlog 136, measured**: a create replayed across a launcher restart
 *    ({@link measureReplayAcrossRestart}). On Docker Engine 29.7.2 / API 1.55 (Docker Desktop,
 *    `linux/arm64`) the replay is refused at the **network** — `409 network with name run-<id>
 *    already exists`, surfaced to the runner as `workspace_failed` — before `#prepare` runs, so the
 *    live run's shim token is untouched, the rollback removes nothing (it made nothing), and no
 *    second container starts. The first run's container keeps running with no launcher holding a
 *    handle for it: the orphan is real, and until WP-103 nothing in the platform reaped it (the
 *    reaper's own measurement is below).
 *  - **Backlog 34's residual**: `--runner-image platform:dev` runs the runner half from the product
 *    image's own tree, which since WP-82 carries no `@anthropic-ai/claude-agent-sdk-linux-*`
 *    package, and the run still completes — the measurement `docker/app.Dockerfile` cites.
 *
 * ## What WP-103 added (PROGRESS backlog 286, TD-028 decision 12)
 *
 *  - **The three producers, measured before the fix was chosen** (numbers in backlog 286):
 *    a launcher stopped ({@link measureRestartDuringCreate} with `stop`) or killed (`kill`) while
 *    a create is in flight — the runner is told `engine_unavailable` and the run's network, its
 *    workspace volume and the helper the create was running are left, with no run container; a
 *    create that outlives the client's timeout with the launcher alive
 *    ({@link measureCreateOutlivingTimeout}) — before WP-103 every one of the stage's three
 *    attempts completed and left a running run container, since WP-103 the launcher abandons each
 *    and the check asserts nothing is left; and whether an unattached shim exits
 *    ({@link observeUnattachedShims}, `--observe-shim-ms`) — it did not in ten minutes.
 *  - **The reaper against the daemon** ({@link reapThroughTheVerbs}): the production pass over the
 *    launcher's real read verb and destroy, removing the two runs the restarts left, keeping a live
 *    one, and then removing it as an unknown run once the grace is zero.
 *
 * ## Environment
 *
 *     DOCKER_HOST=unix:///var/run/docker.sock node scripts/launcher-control-plane-check.mjs
 *     DOCKER_HOST=unix:///var/run/docker.sock node scripts/launcher-control-plane-check.mjs --runner-image platform:dev
 */
import process from 'node:process';
import './ts-source-resolver.mjs';

const { startDockerFixture, RUNTIME_IMAGE, EGRESS_IMAGE, GIT_IMAGE, REPO_ROOT, docker } =
  await import(new URL('../test/e2e/support/docker-workspace.ts', import.meta.url).href);

const RUN_ID = '9f3a1c2e-0000-4000-8000-0000000053a1';
const IDEMPOTENCY_RUN_ID = '9f3a1c2e-0000-4000-8000-0000000053a2';
const BAD_RUN_ID = '9f3a1c2e-0000-4000-8000-0000000053a3';
/** Backlog 136's run (WP-82): created, the launcher restarted, then created again. */
const REPLAY_RUN_ID = '9f3a1c2e-0000-4000-8000-00000000136a';
/** Backlog 286's runs (WP-103): a launcher stopped, then killed, while each was being created. */
const RESTART_STOP_RUN_ID = '9f3a1c2e-0000-4000-8000-00000000286a';
const RESTART_KILL_RUN_ID = '9f3a1c2e-0000-4000-8000-00000000286b';
/** …and the three start attempts of one stage against a create that outlives the client. */
const TIMEOUT_RUN_IDS = [
  '9f3a1c2e-0000-4000-8000-00000000286c',
  '9f3a1c2e-0000-4000-8000-00000000286d',
  '9f3a1c2e-0000-4000-8000-00000000286e',
];
/** The shortened client bound for 286 (b), below the create's own duration on this machine. */
const SHORT_CLIENT_TIMEOUT_MS = 1_500;
const ALL_286_RUN_IDS = [RESTART_STOP_RUN_ID, RESTART_KILL_RUN_ID, ...TIMEOUT_RUN_IDS];
const TOKEN = 'FAKE-wp53-launcher-token-000000000000';
const PORT = '7780';
const LAUNCHER_NAME = 'agentic-wp53-launcher';
const BAD_LAUNCHER_NAME = 'agentic-wp53-launcher-badcli';

/**
 * `--runner-image <ref>` (WP-82, backlog 34's residual): run the runner half inside that image,
 * from the image's **own** `/app` tree and `node_modules`, instead of the run image with the
 * checkout mounted. `platform:dev` is what `compose.yml`'s `runner` service is, so this is the form
 * that says whether the product image needs the Agent SDK's per-platform binary package.
 */
const cliArgs = process.argv.slice(2);
const FLAGS = ['--runner-image', '--observe-shim-ms'];
const flagValue = (flag) => {
  const index = cliArgs.indexOf(flag);
  return index === -1 ? undefined : (cliArgs[index + 1] ?? null);
};
const RUNNER_IMAGE = flagValue('--runner-image') ?? null;
/**
 * `--observe-shim-ms <n>` (WP-103, backlog 286 (c)): how long the oldest unattached run container
 * is watched for before the check reads its state again. Two minutes by default; the WP-103 notes
 * record a longer run.
 */
const observeRaw = flagValue('--observe-shim-ms');
const OBSERVE_SHIM_MS = observeRaw === undefined ? 120_000 : Number(observeRaw);
const unknownArgs = cliArgs.filter(
  (arg, index) => !(FLAGS.includes(arg) || (index > 0 && FLAGS.includes(cliArgs[index - 1]))),
);
if (
  unknownArgs.length > 0 ||
  flagValue('--runner-image') === null ||
  !Number.isSafeInteger(OBSERVE_SHIM_MS) ||
  OBSERVE_SHIM_MS < 0
) {
  process.stderr.write(
    `usage: launcher-control-plane-check.mjs [--runner-image <ref>] [--observe-shim-ms <n>] (got ${cliArgs.join(' ')})\n`,
  );
  process.exit(2);
}

const DOCKER_HOST = process.env['DOCKER_HOST'];
if (!DOCKER_HOST) {
  process.stderr.write(
    'DOCKER_HOST is required and has no default (TD-021, WP-15g): try DOCKER_HOST=unix:///var/run/docker.sock\n',
  );
  process.exit(2);
}
const INNER_SOCKET = DOCKER_HOST.startsWith('unix://') ? DOCKER_HOST.slice('unix://'.length) : null;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
};

const launcherArgs = (name, fixture, extra) => [
  'run',
  '-d',
  '--rm',
  '--name',
  name,
  // Root, so the daemon socket is usable and the shim's `0600` control socket (uid 1000, created
  // inside the run container) is reachable. The uid the *provider* is told about is still 1000.
  '--user',
  '0:0',
  '--network',
  fixture.network,
  '-e',
  'DOCKER_HOST=unix:///var/run/docker.sock',
  '-e',
  `CHECK_CONTROL_VOLUME=${fixture.controlVolume}`,
  '-e',
  `CHECK_CACHE_VOLUME=${fixture.cacheVolume}`,
  '-e',
  `CHECK_RUNTIME_IMAGE=${RUNTIME_IMAGE}`,
  '-e',
  `CHECK_EGRESS_IMAGE=${EGRESS_IMAGE}`,
  '-e',
  `CHECK_GIT_IMAGE=${GIT_IMAGE}`,
  '-e',
  `CHECK_REPO_ROOT=${REPO_ROOT}`,
  '-e',
  `CHECK_NETWORK=${fixture.network}`,
  '-e',
  `CHECK_LAUNCHER_TOKEN=${TOKEN}`,
  '-e',
  `CHECK_LAUNCHER_PORT=${PORT}`,
  '-e',
  'HOME=/tmp',
  ...extra,
  '-v',
  `${INNER_SOCKET}:/var/run/docker.sock`,
  // At the host's own path: the launcher validates a bind source against its own filesystem and the
  // path it hands the daemon for every run container is the host's.
  '-v',
  `${REPO_ROOT}:${REPO_ROOT}:ro`,
  '-v',
  `${fixture.controlVolume}:/run/agentic/ctl`,
  '-w',
  REPO_ROOT,
  // `--entrypoint node`, because `RUNTIME_IMAGE` is `platform-runtime` and its entrypoint is the run
  // shim. This container is the *platform* side and only borrows the image for its Node runtime.
  '--entrypoint',
  'node',
  RUNTIME_IMAGE,
  `${REPO_ROOT}/scripts/launcher-control-plane-launcher.mjs`,
];

/** Polls the launcher container's log for the line it prints once it is listening. */
const waitForListening = async (name) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const logs = await docker(['logs', name], { allowFailure: true });
    if (logs.stdout.includes('"listening"')) {
      return true;
    }
    const state = await docker(['container', 'inspect', '-f', '{{.State.Running}}', name], {
      allowFailure: true,
    });
    if (state.ok && state.stdout.trim() !== 'true') {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
};

/**
 * The daemon, probed by name before anything is created.
 *
 * `startDockerFixture`'s `ensureImages` already refuses a missing `platform-*` image and names the
 * build command, so that half of "a skip counts as a failure" was covered; a missing **daemon** was
 * not — it surfaced as whatever `docker` printed, from inside a `catch` that reports "the check ran
 * to completion". This is `compose-stock-check.mjs`'s probe, for the same reason it has one.
 */
const assertDaemon = async () => {
  try {
    const { stdout } = await docker(['version', '--format', '{{.Server.Version}}']);
    process.stdout.write(`docker daemon ${stdout.trim()}\n`);
  } catch (error) {
    process.stderr.write(
      `FAIL: launcher-control-plane-check — no Docker daemon: ${String(error)}\n`,
    );
    process.exit(1);
  }
};

/**
 * The runner container. **No docker socket**: the property the whole split exists for is that the
 * process that runs the agent reaches the daemon through nothing at all.
 *
 * By default it borrows the run image for its Node runtime and runs this checkout's sources; with
 * `--runner-image` it runs the product image's own tree, with only this script mounted beside it.
 */
const runRunner = async (extraEnv, options = {}) => {
  const env = {
    CHECK_RUN_ID: RUN_ID,
    CHECK_IDEMPOTENCY_RUN_ID: IDEMPOTENCY_RUN_ID,
    CHECK_BAD_RUN_ID: BAD_RUN_ID,
    CHECK_LAUNCHER_URL: `http://${LAUNCHER_NAME}:${PORT}`,
    CHECK_BAD_LAUNCHER_URL: `http://${BAD_LAUNCHER_NAME}:${PORT}`,
    CHECK_LAUNCHER_TOKEN: TOKEN,
    CHECK_REPO_URL: fixture.repoUrl,
    CHECK_REPO_HOST: fixture.repoContainer,
    HOME: '/tmp',
    ...extraEnv,
  };
  const source =
    RUNNER_IMAGE === null
      ? ['-v', `${REPO_ROOT}:${REPO_ROOT}:ro`, '-w', REPO_ROOT]
      : [
          '-v',
          `${REPO_ROOT}/scripts/launcher-control-plane-runner.mjs:/app/scripts/launcher-control-plane-runner.mjs:ro`,
          '-w',
          '/app',
        ];
  const script =
    RUNNER_IMAGE === null
      ? `${REPO_ROOT}/scripts/launcher-control-plane-runner.mjs`
      : '/app/scripts/launcher-control-plane-runner.mjs';
  return docker(
    [
      'run',
      // Detached (WP-103) without `--rm`, so its one JSON line can still be read after it exits;
      // the caller removes it.
      ...(options.detach === true ? ['-d'] : ['--rm']),
      '--name',
      options.name ?? `agentic-wp53-runner-${RUN_ID.slice(0, 8)}`,
      '--user',
      '0:0',
      '--network',
      fixture.network,
      ...Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
      ...source,
      // TD-025 §2's static mount, on the runner side. This is the data plane.
      '-v',
      `${fixture.controlVolume}:/run/agentic/ctl`,
      '--entrypoint',
      'node',
      RUNNER_IMAGE ?? RUNTIME_IMAGE,
      script,
    ],
    { allowFailure: true },
  );
};

const lastJsonLine = (result) => {
  try {
    const lines = result.stdout.split('\n').filter((line) => line.trim().length > 0);
    return JSON.parse(lines.at(-1) ?? 'null');
  } catch {
    return null;
  }
};

/** What the daemon holds for one run id, asked by the host. */
const runObjects = async (runId) => {
  const containers = await docker(
    [
      'ps',
      '-a',
      '--filter',
      `label=com.agentic.run=${runId}`,
      '--format',
      '{{.Names}} {{.ID}} {{.State}}',
    ],
    { allowFailure: true },
  );
  const networks = await docker(
    [
      'network',
      'ls',
      '--filter',
      `label=com.agentic.run=${runId}`,
      '--format',
      '{{.Name}} {{.ID}}',
    ],
    { allowFailure: true },
  );
  const lines = (text) =>
    text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .sort();
  return { containers: lines(containers.stdout), networks: lines(networks.stdout) };
};

/**
 * PROGRESS backlog **136** (WP-82), measured: a create replayed across a launcher restart.
 *
 * The runner creates a run and never releases it; the launcher container is stopped the way compose
 * stops it (`docker stop`, SIGTERM) and started again with the same configuration, so its
 * idempotency map is empty; the runner then creates the **same run id** again. What is recorded is
 * the object that collides first, what the runner is told, whether `/ctl/<run-id>/token` was
 * rewritten, and what is still running afterwards. It is the case where the first create had
 * **completed** before the restart (the response lost, or the runner retrying); a restart *during*
 * a create leaves a different partial state and is not what this measures.
 *
 * Everything the replay leaves is removed by `fixture.cleanup()` — the existing sweep, which removes
 * every container and network labelled `com.agentic.run` — and the host asserts afterwards that the
 * run's objects are gone.
 */
const measureReplayAcrossRestart = async () => {
  const phaseEnv = { CHECK_REPLAY_RUN_ID: REPLAY_RUN_ID };
  const first = lastJsonLine(await runRunner({ ...phaseEnv, CHECK_PHASE: 'replay-create' }));
  const beforeRestart = await runObjects(REPLAY_RUN_ID);
  await docker(['stop', LAUNCHER_NAME], { allowFailure: true });
  await docker(['rm', '-f', LAUNCHER_NAME], { allowFailure: true });
  await docker(launcherArgs(LAUNCHER_NAME, fixture, []));
  const restarted = await waitForListening(LAUNCHER_NAME);
  const afterRestart = await runObjects(REPLAY_RUN_ID);
  const retry = lastJsonLine(await runRunner({ ...phaseEnv, CHECK_PHASE: 'replay-retry' }));
  const afterRetry = await runObjects(REPLAY_RUN_ID);
  const launcherLog = await docker(['logs', LAUNCHER_NAME], { allowFailure: true });
  return { first, beforeRestart, restarted, afterRestart, retry, afterRetry, launcherLog };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const linesOf = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();

/** `/ctl` as the daemon holds it, listed from a throwaway container (the host cannot read it). */
const controlDirectories = async () => {
  const listing = await docker(
    [
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${fixture.controlVolume}:/ctl:ro`,
      '--entrypoint',
      'ls',
      GIT_IMAGE,
      '-1',
      '/ctl',
    ],
    { allowFailure: true },
  );
  return linesOf(listing.stdout);
};

/**
 * Everything the daemon holds for one run id (WP-103): containers with their state, the networks,
 * the two named volumes, and whether `/ctl/<run-id>` is there.
 */
const runObjectsFull = async (runId) => {
  const containers = await docker(
    [
      'ps',
      '-a',
      '--filter',
      `label=com.agentic.run=${runId}`,
      '--format',
      '{{.Names}} {{.State}} {{.Label "com.agentic.role"}}',
    ],
    { allowFailure: true },
  );
  const networks = await docker(
    ['network', 'ls', '--filter', `label=com.agentic.run=${runId}`, '--format', '{{.Name}}'],
    { allowFailure: true },
  );
  const volumes = await docker(
    ['volume', 'ls', '--filter', `label=com.agentic.run=${runId}`, '--format', '{{.Name}}'],
    { allowFailure: true },
  );
  return {
    containers: linesOf(containers.stdout),
    networks: linesOf(networks.stdout),
    volumes: linesOf(volumes.stdout),
    controlDirectory: (await controlDirectories()).includes(runId),
  };
};

/** Polls until the daemon holds a `run-<id>` network: the first object `create` makes. */
const waitForRunNetwork = async (runId, timeoutMs) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await docker(
      ['network', 'ls', '--filter', `label=com.agentic.run=${runId}`, '--format', '{{.Name}}'],
      { allowFailure: true },
    );
    if (found.stdout.trim().length > 0) {
      return Date.now() - started;
    }
    await sleep(100);
  }
  return null;
};

/** Polls until what the daemon holds for these runs has not changed for `quietMs`. */
const waitUntilSettled = async (runIds, { quietMs, timeoutMs }) => {
  const started = Date.now();
  let last = '';
  let lastChange = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snapshot = JSON.stringify(
      await Promise.all(runIds.map(async (runId) => runObjects(runId))),
    );
    if (snapshot !== last) {
      last = snapshot;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= quietMs) {
      return Date.now() - started;
    }
    await sleep(1_000);
  }
  return null;
};

/** Stops (`docker stop`, SIGTERM then SIGKILL after 10 s — compose's default) or kills it. */
const takeLauncherDown = async (how) => {
  // Followed from before the signal, because the container is `--rm`: once it exits its log is gone.
  const following = docker(['logs', '-f', LAUNCHER_NAME], { allowFailure: true });
  const started = Date.now();
  await docker([how === 'stop' ? 'stop' : 'kill', LAUNCHER_NAME], { allowFailure: true });
  const tookMs = Date.now() - started;
  const logged = await following;
  await docker(['rm', '-f', LAUNCHER_NAME], { allowFailure: true });
  const tail = `${logged.stdout}\n${logged.stderr}`
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-8)
    .map((line) => line.slice(0, 300));
  return { tookMs, tail };
};

const bringLauncherUp = async () => {
  await docker(['rm', '-f', LAUNCHER_NAME], { allowFailure: true });
  await docker(launcherArgs(LAUNCHER_NAME, fixture, []));
  return waitForListening(LAUNCHER_NAME);
};

/**
 * PROGRESS backlog **286** (a), WP-103: a launcher restart **during** a create.
 *
 * A runner provisions `runId` in a detached container and never releases it; the host waits for
 * the run's network — the first object `create` makes — and then takes the launcher down, either
 * the way compose restarts it (`docker stop`: SIGTERM, which `startLauncher`'s `close` answers by
 * waiting for in-flight requests, then SIGKILL after ten seconds) or the way a crash or an OOM kill
 * does (`docker kill`). What is recorded is what the runner was told, and what the daemon holds for
 * the run after the launcher is gone and again after it is back.
 */
const measureRestartDuringCreate = async (runId, how) => {
  const runnerName = `agentic-wp103-runner-${how}`;
  await docker(['rm', '-f', runnerName], { allowFailure: true });
  await runRunner(
    { CHECK_REPLAY_RUN_ID: runId, CHECK_PHASE: 'replay-create' },
    { detach: true, name: runnerName },
  );
  const networkAfterMs = await waitForRunNetwork(runId, 120_000);
  const { tookMs: downMs, tail: launcherTail } = await takeLauncherDown(how);
  await docker(['wait', runnerName], { allowFailure: true });
  const told = lastJsonLine(await docker(['logs', runnerName], { allowFailure: true }));
  await docker(['rm', '-f', runnerName], { allowFailure: true });
  // Long enough for anything the dead launcher had started (a helper, the sidecar) to finish.
  await sleep(5_000);
  const afterDown = await runObjectsFull(runId);
  const restarted = await bringLauncherUp();
  const afterRestart = await runObjectsFull(runId);
  return { how, networkAfterMs, downMs, launcherTail, told, afterDown, restarted, afterRestart };
};

/**
 * PROGRESS backlog **286** (b), WP-103: a create that outlives the client's timeout with the
 * launcher alive, over the stage executor's three start attempts (three run ids, see the runner's
 * `timeout-attempts` phase). The launcher is left alone; the host waits until nothing changes on
 * the daemon for these runs and then counts what is left.
 */
const measureCreateOutlivingTimeout = async () => {
  const told = lastJsonLine(
    await runRunner(
      {
        CHECK_PHASE: 'timeout-attempts',
        CHECK_ATTEMPT_RUN_IDS: TIMEOUT_RUN_IDS.join(','),
        CHECK_CLIENT_TIMEOUT_MS: String(SHORT_CLIENT_TIMEOUT_MS),
      },
      { name: 'agentic-wp103-runner-timeout' },
    ),
  );
  const settledAfterMs = await waitUntilSettled(TIMEOUT_RUN_IDS, {
    quietMs: 8_000,
    timeoutMs: 180_000,
  });
  const objects = {};
  for (const runId of TIMEOUT_RUN_IDS) {
    objects[runId] = await runObjectsFull(runId);
  }
  const runningRunContainers = TIMEOUT_RUN_IDS.filter((runId) =>
    objects[runId].containers.some((line) => line.startsWith(`ws-${runId} running`)),
  ).length;
  const logged = await docker(['logs', LAUNCHER_NAME], { allowFailure: true });
  const launcherLog = `${logged.stdout}\n${logged.stderr}`
    .split('\n')
    .filter((line) => TIMEOUT_RUN_IDS.some((runId) => line.includes(runId)));
  return { told, settledAfterMs, objects, runningRunContainers, launcherLog };
};

/**
 * PROGRESS backlog **286** (c), WP-103: whether an unattached shim ever exits. Every run container
 * of the 286 runs that is still up is inspected, the host waits until the oldest has been up for
 * `observeMs`, and inspects again. `StartedAt` is the daemon's; the age is the host's clock minus
 * it, which on Docker Desktop is the same clock.
 */
const observeUnattachedShims = async (observeMs) => {
  const inspect = async () => {
    const rows = [];
    for (const runId of [REPLAY_RUN_ID, ...ALL_286_RUN_IDS]) {
      const result = await docker(
        ['container', 'inspect', '-f', '{{.State.Status}} {{.State.StartedAt}}', `ws-${runId}`],
        { allowFailure: true },
      );
      if (result.ok) {
        const [status, startedAt] = result.stdout.trim().split(' ');
        rows.push({ runId, status, ageMs: Date.now() - Date.parse(startedAt) });
      }
    }
    return rows;
  };
  const first = await inspect();
  const oldest = Math.max(0, ...first.map((row) => row.ageMs));
  if (first.length > 0 && oldest < observeMs) {
    await sleep(observeMs - oldest);
  }
  const second = await inspect();
  return { first, second };
};

/**
 * WP-103, criterion 2 against the daemon: the **production pass** (`runOrphanWorkspaceReap`) in a
 * runner container, over the launcher's real read verb and real destroy (the runner's `reap`
 * phase), with the `runs` rows given. First pass: the two runs a stop and a kill left are terminal
 * and the 136 replay's run is `running` — two removed, one kept. Second pass: the replay's run has
 * no row and the unknown grace is 0 — removed as unknown, sidecar and all.
 */
const reapThroughTheVerbs = async () => {
  const pass = async (env) =>
    lastJsonLine(
      await runRunner({ CHECK_PHASE: 'reap', ...env }, { name: 'agentic-wp103-runner-reap' }),
    );
  const firstTold = await pass({
    CHECK_REAP_STATES: [
      `${RESTART_STOP_RUN_ID}=failed`,
      `${RESTART_KILL_RUN_ID}=failed`,
      `${REPLAY_RUN_ID}=running`,
    ].join(','),
  });
  const after = {};
  for (const runId of [RESTART_STOP_RUN_ID, RESTART_KILL_RUN_ID]) {
    after[runId] = await runObjectsFull(runId);
  }
  const replayObjects = await runObjectsFull(REPLAY_RUN_ID);
  const replayContainerRunning = replayObjects.containers.some((line) =>
    line.startsWith(`ws-${REPLAY_RUN_ID} running`),
  );
  const secondTold = await pass({ CHECK_REAP_STATES: '', CHECK_REAP_UNKNOWN_GRACE_MS: '0' });
  return {
    first: { told: firstTold, after, replayContainerRunning },
    second: { told: secondTold, after: await runObjectsFull(REPLAY_RUN_ID) },
  };
};

let fixture;
let replay = null;
let orphans = null;
let report = null;
let driven = null;
await assertDaemon();
try {
  if (INNER_SOCKET === null) {
    throw new Error(
      `this check bind-mounts the daemon socket, so DOCKER_HOST must be a unix:// path (got ${DOCKER_HOST})`,
    );
  }
  // A **plain** named volume for the control channel: the shim `chmod`s its socket, which answers
  // EINVAL on a bind-backed volume on macOS (measured at WP-15g).
  fixture = await startDockerFixture({ controlVolumeBind: false });

  await docker(['rm', '-f', LAUNCHER_NAME, BAD_LAUNCHER_NAME], { allowFailure: true });
  await docker(launcherArgs(LAUNCHER_NAME, fixture, []));
  await docker(launcherArgs(BAD_LAUNCHER_NAME, fixture, ['-e', 'CHECK_CLI_PATH=/nowhere/claude']));

  const up = await waitForListening(LAUNCHER_NAME);
  record('the launcher container exposes the control plane', up, `${LAUNCHER_NAME}:${PORT}`);
  const badUp = await waitForListening(BAD_LAUNCHER_NAME);
  record(
    'a second launcher is up with a CLI path the run image does not carry',
    badUp,
    `${BAD_LAUNCHER_NAME}:${PORT}`,
  );

  driven = await runRunner({});

  try {
    const lines = driven.stdout.split('\n').filter((line) => line.trim().length > 0);
    report = JSON.parse(lines.at(-1) ?? '{}');
  } catch {
    report = null;
  }

  if (report === null) {
    record(
      'the runner container produced a report',
      false,
      `stdout: ${driven.stdout}\nstderr: ${driven.stderr}`,
    );
  } else {
    record(
      'the control plane refuses a wrong token, terminally',
      report.wrongTokenCode === 'invalid_spec',
      `code: ${report.wrongTokenCode}`,
    );
    record(
      'the runner reached the launcher over the network and read its configuration',
      report.health?.status === 'ok' && report.health?.controlRoot === '/run/agentic/ctl',
      JSON.stringify(report.health ?? null),
    );
    record(
      'the launcher answered the CLI path the run image really carries (backlog 34)',
      report.claudeCodePath === '/usr/local/bin/claude' &&
        report.health?.claudeCodePath === '/usr/local/bin/claude',
      `${report.claudeCodePath} (health: ${report.health?.claudeCodePath})`,
    );
    record(
      'a wrong CLI path fails by name on the platform side, before a container exists',
      typeof report.wrongCliPathError === 'string' &&
        report.wrongCliPathError.includes('/nowhere/claude') &&
        report.wrongCliPathError.includes(RUNTIME_IMAGE),
      String(report.wrongCliPathError),
    );
    record(
      'the workspace’s CLI path reached the bytes the SDK spawned with (rule 82)',
      report.spawnCommand === '/repo/test/fixtures/runlet/fake-claude-cli',
      `command: ${report.spawnCommand}`,
    );
    record(
      'the control socket is on the shared ctl volume, under the runner’s own root',
      typeof report.socketPath === 'string' &&
        report.socketPath.startsWith('/run/agentic/ctl/') &&
        report.socketPath.includes(RUN_ID) &&
        report.workdir === '/work/repo',
      `${report.socketPath} in ${report.workdir}`,
    );
    record(
      '`spec.checkoutRef` reached the workspace spec (backlog 71)',
      report.checkoutBranch === 'agentic/wp53-check',
      `checkoutBranch: ${report.checkoutBranch}`,
    );
    record(
      'the run is read-only and was minted nothing, so the launcher holds no git credential',
      report.credentialScope === null,
      `credentialScope: ${report.credentialScope}`,
    );
    record(
      'a run started, streamed and ended through the control plane and the shim’s socket',
      report.status === 'completed' && report.terminalReason === 'success',
      `${report.status}/${report.terminalReason}${
        report.ok === true
          ? ''
          : ` | ${report.outcomeError ?? ''} | ${(report.notes ?? []).join(' | ')}`
      }`,
    );
    record(
      'the CLI’s own output reached the platform’s transcript',
      typeof report.text === 'string' && report.text.includes('the shim carried this'),
      `entries: ${(report.kinds ?? []).join(', ')}`,
    );
    record(
      'the workspace was released with the run’s own ending',
      Array.isArray(report.releases) &&
        report.releases.length === 1 &&
        report.releases[0]?.kind === 'ended' &&
        report.releases[0]?.status === 'completed',
      JSON.stringify(report.releases ?? []),
    );
    record(
      'a replayed create answers the stored handle (TD-028 decision 4)',
      report.replayed === true && report.replayedHandleMatches === true,
      `replayed: ${report.replayed}, same handle: ${report.replayedHandleMatches}`,
    );
  }

  if (report !== null) {
    record(
      'the runner found no Agent SDK platform binary package for its own platform (backlog 34)',
      RUNNER_IMAGE === null ||
        !(report.sdkPlatformPackages ?? ['?']).some((entry) =>
          entry.startsWith('@anthropic-ai+claude-agent-sdk-linux-'),
        ),
      `${RUNNER_IMAGE ?? RUNTIME_IMAGE + ' + checkout'}: ${JSON.stringify(report.sdkPlatformPackages ?? null)}`,
    );
  }

  // Backlog 136, measured (WP-82). What is asserted is what was measured on Docker Engine 29.7.2 /
  // API 1.55 — the replay is refused at the network (409), rolls nothing back, leaves the live
  // token alone and starts no second container — so a daemon that behaves differently fails this
  // check instead of silently falsifying the sentences that quote it. That the first container
  // outlives the replay is recorded as an observation: it is the orphan, which the reaper below
  // removes as an unknown run (WP-103).
  replay = await measureReplayAcrossRestart();
  const firstContainer = replay.first?.containerId ?? null;
  record(
    'backlog 136: the first create succeeded and its run container was running before the restart',
    replay.first?.ok === true &&
      replay.beforeRestart.containers.some((line) => line.startsWith(`ws-${REPLAY_RUN_ID} `)),
    JSON.stringify({ first: replay.first, objects: replay.beforeRestart }),
  );
  record(
    'backlog 136: the launcher restarted with an empty idempotency map',
    replay.restarted,
    JSON.stringify({ objects: replay.afterRestart }),
  );
  record(
    'backlog 136: the replayed create was refused, not performed a second time',
    replay.retry !== null && replay.retry.ok === false,
    JSON.stringify({
      ok: replay.retry?.ok,
      replayed: replay.retry?.replayed,
      errorCode: replay.retry?.errorCode,
      errorMessage: replay.retry?.errorMessage,
    }),
  );
  record(
    'backlog 136: the refused replay left the live run’s shim token as it was',
    replay.retry !== null &&
      replay.retry.tokenBefore === replay.retry.tokenAfter &&
      replay.retry.tokenAfter === replay.first?.tokenAfter,
    `before the replay ${replay.retry?.tokenBefore}, after ${replay.retry?.tokenAfter}, at first create ${replay.first?.tokenAfter} — ${
      replay.retry?.tokenBefore === replay.retry?.tokenAfter ? 'unchanged' : 'REWRITTEN OR REMOVED'
    }`,
  );
  const runContainers = replay.afterRetry.containers.filter((line) =>
    line.startsWith(`ws-${REPLAY_RUN_ID} `),
  );
  record(
    'backlog 136: the replay left no second run container',
    runContainers.length <= 1,
    JSON.stringify(replay.afterRetry),
  );
  record(
    'backlog 136: whether the first run container outlived the replay (observation)',
    true,
    `first ${firstContainer?.slice(0, 12)}; now ${JSON.stringify(runContainers)}`,
  );
  process.stdout.write(
    `--- backlog 136 launcher log after the restart ---\n${replay.launcherLog.stdout}\n${replay.launcherLog.stderr}\n`,
  );

  // Backlog 286 (WP-103). Criterion 1 measured these before the fix was chosen (the numbers are in
  // the entry); what is asserted now is what the fix changed, and what it deliberately did not.
  orphans = {
    stop: await measureRestartDuringCreate(RESTART_STOP_RUN_ID, 'stop'),
    kill: await measureRestartDuringCreate(RESTART_KILL_RUN_ID, 'kill'),
    timeout: await measureCreateOutlivingTimeout(),
  };
  // (c) is observed on the unattached run containers still up: the 136 replay's first run, which
  // nothing ever attached to after the restart.
  orphans.shims = await observeUnattachedShims(OBSERVE_SHIM_MS);
  orphans.reap = await reapThroughTheVerbs();
  process.stdout.write(`--- backlog 286 measurement ---\n${JSON.stringify(orphans, null, 2)}\n`);
  for (const how of ['stop', 'kill']) {
    const measured = orphans[how];
    record(
      `backlog 286 (a): a launcher ${how === 'stop' ? 'stopped' : 'killed'} during a create is not answered, and leaves objects behind (measured)`,
      measured.networkAfterMs !== null &&
        measured.restarted &&
        measured.told?.ok === false &&
        measured.told?.errorCode === 'engine_unavailable' &&
        measured.afterDown.networks.length === 1 &&
        !measured.afterDown.containers.some((line) => line.startsWith('ws-')),
      JSON.stringify({
        told: measured.told?.errorCode,
        cause: measured.told?.errorCause,
        down_ms: measured.downMs,
        launcher: measured.launcherTail.filter((line) => line.startsWith('launcher ')).slice(-3),
        after_down: measured.afterDown,
      }),
    );
  }
  const abandoned = orphans.timeout.launcherLog.filter((line) =>
    line.includes('a create request closed before its answer was written'),
  ).length;
  record(
    'backlog 286 (b): three creates that outlived the client each told the runner engine_unavailable',
    (orphans.timeout.told?.attempts ?? []).every(
      (attempt) => attempt.errorCode === 'engine_unavailable',
    ) && (orphans.timeout.told?.attempts ?? []).length === TIMEOUT_RUN_IDS.length,
    JSON.stringify((orphans.timeout.told?.attempts ?? []).map((attempt) => attempt.ms)),
  );
  record(
    'backlog 286 (b): the launcher abandoned every one, so no run container, network or control directory is left (WP-103)',
    orphans.timeout.settledAfterMs !== null &&
      orphans.timeout.runningRunContainers === 0 &&
      abandoned === TIMEOUT_RUN_IDS.length &&
      TIMEOUT_RUN_IDS.every(
        (runId) =>
          orphans.timeout.objects[runId].containers.length === 0 &&
          orphans.timeout.objects[runId].networks.length === 0 &&
          !orphans.timeout.objects[runId].controlDirectory,
      ),
    JSON.stringify({ abandoned, objects: orphans.timeout.objects }),
  );
  record(
    'backlog 286 (c): an unattached shim is still running when last looked at (observation)',
    orphans.shims.second.length > 0 &&
      orphans.shims.second.every((row) => row.status === 'running'),
    JSON.stringify(orphans.shims.second),
  );
  const { first: reapFirst, second: reapSecond } = orphans.reap;
  record(
    'the restarted launcher lists, off the daemon, the runs a stop and a kill left (TD-028 decision 12)',
    [RESTART_STOP_RUN_ID, RESTART_KILL_RUN_ID, REPLAY_RUN_ID].every((runId) =>
      (reapFirst.told?.listedBefore ?? []).includes(runId),
    ),
    JSON.stringify(reapFirst.told?.listedBefore ?? null),
  );
  record(
    'the reaper removed the two terminal runs and kept the live one (criterion 2)',
    JSON.stringify((reapFirst.told?.destroyed ?? []).map((entry) => entry.runId).sort()) ===
      JSON.stringify([RESTART_STOP_RUN_ID, RESTART_KILL_RUN_ID].sort()) &&
      reapFirst.told?.report?.kept?.run_live === 1 &&
      reapFirst.replayContainerRunning,
    JSON.stringify({
      report: reapFirst.told?.report,
      replay_running: reapFirst.replayContainerRunning,
    }),
  );
  for (const runId of [RESTART_STOP_RUN_ID, RESTART_KILL_RUN_ID]) {
    const left = reapFirst.after[runId];
    record(
      `a reaped run has no container, network or control directory left, and keeps its volume (${runId.slice(-4)})`,
      left.containers.length === 0 &&
        left.networks.length === 0 &&
        !left.controlDirectory &&
        left.volumes.includes(`ws-${runId}`),
      JSON.stringify(left),
    );
  }
  record(
    'an unknown run past its grace is removed with its sidecar, network and control directory',
    JSON.stringify((reapSecond.told?.destroyed ?? []).map((entry) => entry.runId)) ===
      JSON.stringify([REPLAY_RUN_ID]) &&
      reapSecond.told?.report?.reaped?.unknown === 1 &&
      reapSecond.after.containers.length === 0 &&
      reapSecond.after.networks.length === 0 &&
      !reapSecond.after.controlDirectory,
    JSON.stringify({ report: reapSecond.told?.report, after: reapSecond.after }),
  );

  if (report?.ok !== true) {
    const shimLog = await docker(['logs', `ws-${RUN_ID}`], { allowFailure: true });
    const launcherLog = await docker(['logs', LAUNCHER_NAME], { allowFailure: true });
    process.stderr.write(
      `--- run container log ---\n${shimLog.stdout}\n${shimLog.stderr}\n--- launcher log ---\n${launcherLog.stdout}\n${launcherLog.stderr}\n--- runner stderr ---\n${driven?.stderr ?? ''}\n`,
    );
  }

  // Asked of the **daemon by the host**, which the runner container deliberately cannot do: a
  // second create for one run id must not have left a second container, and teardown must have
  // removed the ones that were made.
  for (const [label, runId] of [
    ['the run', RUN_ID],
    ['the replayed run', IDEMPOTENCY_RUN_ID],
  ]) {
    const container = await docker(['container', 'inspect', `ws-${runId}`], { allowFailure: true });
    record(`${label}’s container is gone after the run ended`, !container.ok, `ws-${runId}`);
  }
  const badContainer = await docker(['container', 'inspect', `ws-${BAD_RUN_ID}`], {
    allowFailure: true,
  });
  record(
    'the run whose CLI path was wrong never got a container at all',
    !badContainer.ok,
    `ws-${BAD_RUN_ID}`,
  );
  const volume = await docker(['volume', 'inspect', `ws-${RUN_ID}`], { allowFailure: true });
  record(
    'the workspace volume outlives the run, per retention',
    volume.ok,
    volume.ok ? 'kept' : 'the volume was removed with the container',
  );
} catch (error) {
  record('the check ran to completion', false, String(error?.stack ?? error));
} finally {
  await docker(['rm', '-f', LAUNCHER_NAME, BAD_LAUNCHER_NAME], { allowFailure: true });
  await fixture?.cleanup();
  // The two run volumes retention deliberately keeps; this is a check, not an instance.
  for (const runId of [RUN_ID, IDEMPOTENCY_RUN_ID, BAD_RUN_ID, REPLAY_RUN_ID, ...ALL_286_RUN_IDS]) {
    await docker(['volume', 'rm', '-f', `ws-${runId}`], { allowFailure: true });
  }
}
if (replay !== null) {
  // WP-82 criterion (4): whatever the replay left, the existing sweep removed.
  const left = await runObjects(REPLAY_RUN_ID);
  record(
    'backlog 136: the existing sweep removed everything the replay left',
    left.containers.length === 0 && left.networks.length === 0,
    JSON.stringify(left),
  );
}

const failed = results.filter((result) => !result.ok);
process.stdout.write(
  `\n${failed.length === 0 ? 'PASS' : 'FAIL'}: launcher-control-plane-check (${results.length - failed.length}/${results.length} checks)\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
