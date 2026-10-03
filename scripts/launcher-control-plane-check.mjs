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
 * Since WP-118 the real `claude` runs once as well, with a fake key and no model host, which proves
 * its traffic reaches the sidecar and nothing about the model.
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
 * ## What WP-118 added (PROGRESS backlog 342, TD-025's amendment)
 *
 *  - **The CLI's own environment, by name.** The runner's spec now carries what a production spec
 *    carries — the model credential and nothing else (until WP-118 it carried a `PATH` and a `HOME`
 *    of its own, which is what let the fake CLI start while the container's variables stopped at the
 *    shim). `fake-claude-cli` reports the names in its `/proc/self/environ` (never values, except
 *    `GIT_CONFIG_COUNT` and each `GIT_CONFIG_KEY_<n>`), and the check asserts the proxy names, `HOME`,
 *    `CLAUDE_CONFIG_DIR`, `PATH`, no `RUNLET_*` and one git list of two. On the pre-fix tree the fake
 *    CLI could not start at all (exit 127: `#!/usr/bin/env node` with no `PATH`); with a `PATH`
 *    planted in the spec it reported fourteen names and none of the container's.
 *  - **The image's real `claude`** ({@link measureRealCli}), with an obviously fake key and no model
 *    host on the allow-list, so the sidecar refuses the `CONNECT` and logs the host: nothing can
 *    reach Anthropic. On the pre-fix tree the CLI retried seven times (`api_retry`, `error:
 *    unknown`) until the wall clock stopped it and the sidecar logged **no request at all**.
 *
 * ## What WP-127 added (PROGRESS backlog 339 and 346)
 *
 *  - **A stop during a create, with its exit code and whole log.** The launcher containers are no
 *    longer `--rm`, and the stop was `docker stop -t 10` (until WP-132, below), because a bare
 *    `docker stop` measured 3.1 s on Docker Desktop 29.8.1, which is what WP-103 recorded as
 *    "about three seconds". Measured: the close waits for the create, the create outlasts ten
 *    seconds, and the daemon kills the launcher (exit 137) — not a rejected close, not an early
 *    exit. WP-127's record accepted that ending or a drained, answered create; WP-132's accepts only
 *    the second.
 *  - **The image's real `claude` with no route to the model** ({@link measureNoRoute}): the run's
 *    egress sidecar is stopped before the CLI starts. Measured with both limits past the CLI's own
 *    give-up: ten `api_retry` entries, the delay doubling from 0.6 s to about 35 s, and the give-up
 *    about three minutes after the first request. By default the stall is 45 s and the check
 *    asserts the run ends `stalled`, its error naming the route.
 *
 * ## What WP-132 added (PROGRESS backlog 425)
 *
 *  - **The launcher stopped the way compose stops it.** Its container is started with
 *    `--stop-timeout` equal to `compose.yml`'s `stop_grace_period` for the service (read off the
 *    file) and stopped with a bare `docker stop`, which is compose's path. A stop during a create
 *    must now drain it inside that grace and answer it; a stop with nothing in flight must exit in
 *    well under it.
 *
 * ## What WP-133 added (PROGRESS backlog 137, its `local`-mode half)
 *
 *  - **The real `claude` the way `compose.local.yml` runs it** ({@link measureRealCli} with
 *    `mode: 'local'`): the run's environment from the server's own `agentRunEnvironment` for `local`
 *    mode with an obviously fake `CLAUDE_CODE_OAUTH_TOKEN`, and the run's egress list built from
 *    `SERVER_CONFIG_DEFAULTS.modelEgressHosts` — the list a stock instance gives every run. Unlike the
 *    `api` leg it **reaches** `api.anthropic.com`, which refuses the token; every other host the CLI
 *    asks for is refused by the sidecar and named in its log ({@link refusedHostsOf}). Measured on
 *    Docker Desktop 29.8.1 against `claude` 2.1.267: two `api_retry` entries with `error_status` 401
 *    (`authentication_failed`), *"Failed to authenticate. API Error: 401 Invalid bearer token"*, the
 *    run over in 2.3 s, and **no host refused** — so the shipped list is enough to authenticate. The
 *    token's value is asserted absent from the runner's record, the sidecar's log and the launcher's.
 *
 * ## Environment
 *
 *     DOCKER_HOST=unix:///var/run/docker.sock node scripts/launcher-control-plane-check.mjs
 *     DOCKER_HOST=unix:///var/run/docker.sock node scripts/launcher-control-plane-check.mjs --runner-image platform:dev
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import './ts-source-resolver.mjs';

const { startDockerFixture, RUNTIME_IMAGE, EGRESS_IMAGE, GIT_IMAGE, REPO_ROOT, docker } =
  await import(new URL('../test/e2e/support/docker-workspace.ts', import.meta.url).href);
/**
 * The model hosts a stock instance gives every run (`APP_MODEL_EGRESS_HOSTS`'s default), read off the
 * server's own configuration so the `local` leg runs under the list an operator gets (WP-133).
 */
const { SERVER_CONFIG_DEFAULTS } = await import(
  new URL('../apps/server/src/config.ts', import.meta.url).href
);
const STOCK_MODEL_EGRESS_HOSTS = [...SERVER_CONFIG_DEFAULTS.modelEgressHosts];

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
/**
 * A run a killed create left with **only its network** (WP-118 pre-review round): the host makes
 * the network exactly as `create` labels it, so the case does not depend on where a kill lands.
 */
const NETWORK_ONLY_RUN_ID = '9f3a1c2e-0000-4000-8000-00000000286f';
/** WP-118 review round 1: the CLI's git asks the shim for a credential through the helper. */
const GIT_CREDENTIAL_RUN_ID = '9f3a1c2e-0000-4000-8000-00000000342b';
/** WP-118's run of the image's real `claude` (PROGRESS backlog 342, consequence (a)). */
const REAL_CLI_RUN_ID = '9f3a1c2e-0000-4000-8000-00000000342a';
/** WP-133's run of the real `claude` in BD-004 `local` mode (PROGRESS backlog 137). */
const LOCAL_CLI_RUN_ID = '9f3a1c2e-0000-4000-8000-00000000133a';
/**
 * The same obviously fake subscription token `launcher-control-plane-runner.mjs` gives that run,
 * spelled here so the check can look for it in what the run left behind — the sidecar's log and the
 * launcher's. Never printed: every record names it, none quotes it.
 */
const FAKE_OAUTH_TOKEN = 'FAKE-wp133-oauth-token-not-a-credential';
/** WP-127's run of the real `claude` whose sidecar is stopped before it starts (backlog 346). */
const NO_ROUTE_RUN_ID = '9f3a1c2e-0000-4000-8000-00000000346a';
/** The shortened client bound for 286 (b), below the create's own duration on this machine. */
const SHORT_CLIENT_TIMEOUT_MS = 1_500;
const ALL_286_RUN_IDS = [RESTART_STOP_RUN_ID, RESTART_KILL_RUN_ID, ...TIMEOUT_RUN_IDS];
/** How long the real CLI may retry before the runner's wall clock stops it (WP-118). */
const REAL_CLI_WALL_CLOCK_MS = 60_000;
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
const FLAGS = [
  '--runner-image',
  '--observe-shim-ms',
  '--no-route-stall-ms',
  '--no-route-wall-ms',
  '--launcher-stop-grace-s',
];
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
/**
 * `--no-route-stall-ms <n>` and `--no-route-wall-ms <n>` (WP-127, backlog 346): the stall and the
 * wall clock of the run whose sidecar is stopped. By default the stall is short and the wall clock
 * long, so the check asserts the run ends `stalled` across the CLI's retries; the WP-127 notes
 * record the run with both set past the CLI's own give-up, which is how its retry sequence was
 * measured.
 */
const numberFlag = (flag, fallback) => {
  const raw = flagValue(flag);
  return raw === undefined ? fallback : Number(raw);
};
const NO_ROUTE_STALL_MS = numberFlag('--no-route-stall-ms', 45_000);
const NO_ROUTE_WALL_MS = numberFlag('--no-route-wall-ms', 300_000);
/**
 * The launcher's stop grace **as `compose.yml` declares it** (WP-132, PROGRESS backlog 425): the
 * `stop_grace_period` of the `launcher` service, read off the file so the check stops the launcher
 * the way that file makes compose stop it, and a change to the number is a change this check sees.
 *
 * How compose applies it, measured on Compose 5.5.1 / Engine 29.8.1 (Docker Desktop): a service
 * with `stop_grace_period: 30s` is created with `Config.StopTimeout` 30, and `docker compose stop`
 * then gave a process that drains for 20 s its 20 s (exit 0); a service with **no**
 * `stop_grace_period` was killed after **3 s** (exit 137) — and so was a bare `docker stop` of a
 * container with no `StopTimeout`, 3.2 s. So the launcher container is started with
 * `--stop-timeout <grace>` and stopped with a bare `docker stop`, which is the path compose takes.
 * `--launcher-stop-grace-s <n>` overrides it for a measurement (the WP-132 notes ran it at 90).
 */
const composeLauncherStopGraceS = () => {
  const text = readFileSync(new URL('../compose.yml', import.meta.url), 'utf8');
  const start = text.indexOf('\n  launcher:\n');
  const rest = start === -1 ? '' : text.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  const block = end === -1 ? rest : rest.slice(0, end + 1);
  const match = /^ {4}stop_grace_period: (\d+)s$/m.exec(block);
  return match === null ? null : Number(match[1]);
};
const LAUNCHER_STOP_GRACE_S = numberFlag('--launcher-stop-grace-s', composeLauncherStopGraceS());
const unknownArgs = cliArgs.filter(
  (arg, index) => !(FLAGS.includes(arg) || (index > 0 && FLAGS.includes(cliArgs[index - 1]))),
);
if (
  unknownArgs.length > 0 ||
  flagValue('--runner-image') === null ||
  !Number.isSafeInteger(OBSERVE_SHIM_MS) ||
  OBSERVE_SHIM_MS < 0 ||
  ![NO_ROUTE_STALL_MS, NO_ROUTE_WALL_MS].every((ms) => Number.isSafeInteger(ms) && ms > 0) ||
  !Number.isSafeInteger(LAUNCHER_STOP_GRACE_S) ||
  LAUNCHER_STOP_GRACE_S <= 0
) {
  process.stderr.write(
    `usage: launcher-control-plane-check.mjs [--runner-image <ref>] [--observe-shim-ms <n>] [--no-route-stall-ms <n>] [--no-route-wall-ms <n>] [--launcher-stop-grace-s <n>] (got ${cliArgs.join(' ')}; compose.yml's launcher stop_grace_period: ${String(composeLauncherStopGraceS())})\n`,
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
  // No `--rm` (WP-127, backlog 339): a stopped launcher's exit code and whole log are read before
  // it is removed by name — every path that takes one down or starts one removes it with `rm -f`.
  '--name',
  name,
  // What compose sets from the service's `stop_grace_period` (WP-132, measured above), so a bare
  // `docker stop` below takes the path `docker compose stop` takes.
  '--stop-timeout',
  String(LAUNCHER_STOP_GRACE_S),
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
  // Timed (WP-132): a stop with **nothing in flight** must not cost the grace, or every
  // `docker compose stop` would wait the whole of it.
  const idleStopStarted = Date.now();
  await docker(['stop', LAUNCHER_NAME], { allowFailure: true });
  const idleStopMs = Date.now() - idleStopStarted;
  await docker(['rm', '-f', LAUNCHER_NAME], { allowFailure: true });
  await docker(launcherArgs(LAUNCHER_NAME, fixture, []));
  const restarted = await waitForListening(LAUNCHER_NAME);
  const afterRestart = await runObjects(REPLAY_RUN_ID);
  const retry = lastJsonLine(await runRunner({ ...phaseEnv, CHECK_PHASE: 'replay-retry' }));
  const afterRetry = await runObjects(REPLAY_RUN_ID);
  const launcherLog = await docker(['logs', LAUNCHER_NAME], { allowFailure: true });
  return {
    first,
    beforeRestart,
    idleStopMs,
    restarted,
    afterRestart,
    retry,
    afterRetry,
    launcherLog,
  };
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

/**
 * Stops (a bare `docker stop`: SIGTERM, then SIGKILL after the container's `StopTimeout`, which is
 * `compose.yml`'s `stop_grace_period` for the launcher — {@link LAUNCHER_STOP_GRACE_S}, WP-132) or
 * kills it. Until WP-132 this was `docker stop -t 10`, compose's documented default, because a bare
 * `docker stop` measured 3.1 s on Docker Desktop 29.8.1 (backlog 339); WP-132 measured why — a
 * container with no `StopTimeout` gets about three seconds on that daemon, through compose too —
 * and gave the launcher a grace of its own (backlog 425).
 *
 * WP-127 (backlog 339): the container is no longer `--rm`, so its **exit code** is read off the
 * daemon after it stops and its **whole** log is kept (`log`); `tail` is the last eight lines, as
 * WP-103 recorded them.
 */
const takeLauncherDown = async (how) => {
  const started = Date.now();
  await docker(how === 'stop' ? ['stop', LAUNCHER_NAME] : ['kill', LAUNCHER_NAME], {
    allowFailure: true,
  });
  const tookMs = Date.now() - started;
  const state = await docker(
    ['container', 'inspect', '-f', '{{.State.ExitCode}} {{.State.OOMKilled}}', LAUNCHER_NAME],
    { allowFailure: true },
  );
  const logged = await docker(['logs', LAUNCHER_NAME], { allowFailure: true });
  await docker(['rm', '-f', LAUNCHER_NAME], { allowFailure: true });
  const log = `${logged.stdout}\n${logged.stderr}`
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(0, 600));
  const [exitCode, oomKilled] = state.stdout.trim().split(' ');
  return {
    tookMs,
    exitCode: state.ok ? Number(exitCode) : null,
    oomKilled: oomKilled === 'true',
    log,
    tail: log.slice(-8).map((line) => line.slice(0, 300)),
  };
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
 * waiting for in-flight requests, then SIGKILL after the container's own grace — `compose.yml`'s,
 * since WP-132) or the way a crash or an OOM kill
 * does (`docker kill`). What is recorded is what the runner was told, and what the daemon holds for
 * the run after the launcher is gone and again after it is back — and, since WP-127 (backlog 339),
 * the launcher's exit code and its whole log.
 */
const measureRestartDuringCreate = async (runId, how) => {
  const runnerName = `agentic-wp103-runner-${how}`;
  await docker(['rm', '-f', runnerName], { allowFailure: true });
  await runRunner(
    { CHECK_REPLAY_RUN_ID: runId, CHECK_PHASE: 'replay-create' },
    { detach: true, name: runnerName },
  );
  const networkAfterMs = await waitForRunNetwork(runId, 120_000);
  const {
    tookMs: downMs,
    tail: launcherTail,
    exitCode: launcherExitCode,
    log: launcherLog,
  } = await takeLauncherDown(how);
  await docker(['wait', runnerName], { allowFailure: true });
  const told = lastJsonLine(await docker(['logs', runnerName], { allowFailure: true }));
  await docker(['rm', '-f', runnerName], { allowFailure: true });
  // Long enough for anything the dead launcher had started (a helper, the sidecar) to finish.
  await sleep(5_000);
  const afterDown = await runObjectsFull(runId);
  const restarted = await bringLauncherUp();
  const afterRestart = await runObjectsFull(runId);
  return {
    how,
    networkAfterMs,
    downMs,
    launcherExitCode,
    launcherLog,
    launcherTail,
    told,
    afterDown,
    restarted,
    afterRestart,
  };
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
  // The first object a create makes, and nothing after it — deterministic, unlike a kill's timing.
  await docker([
    'network',
    'create',
    '--internal',
    '--label',
    `com.agentic.run=${NETWORK_ONLY_RUN_ID}`,
    '--label',
    'com.agentic.role=network',
    '--label',
    `com.agentic.instance=${fixture.controlVolume}`,
    `run-${NETWORK_ONLY_RUN_ID}`,
  ]);
  const pass = async (env) =>
    lastJsonLine(
      await runRunner({ CHECK_PHASE: 'reap', ...env }, { name: 'agentic-wp103-runner-reap' }),
    );
  const firstTold = await pass({
    CHECK_REAP_STATES: [
      `${RESTART_STOP_RUN_ID}=failed`,
      `${RESTART_KILL_RUN_ID}=failed`,
      `${NETWORK_ONLY_RUN_ID}=failed`,
      `${REPLAY_RUN_ID}=running`,
    ].join(','),
  });
  const after = {};
  for (const runId of [RESTART_STOP_RUN_ID, RESTART_KILL_RUN_ID, NETWORK_ONLY_RUN_ID]) {
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

/**
 * WP-118, PROGRESS backlog 342 (a): the run image's **real** `claude` through the production path,
 * with an obviously fake model key and **no model host allowed** — so a CLI that uses the proxy is
 * refused by the sidecar, which logs the host at tinyproxy's `Notice` level (*"Proxying refused on
 * filtered domain"*), and nothing reaches Anthropic. An allowed `CONNECT` would not be in the log
 * at all: the sidecar's `LogLevel Notice` is above tinyproxy's `Connect` level (`egress.ts`).
 *
 * The sidecar's log is followed from the moment its container exists, because `release` removes
 * it: `docker logs -f` returns when the container is gone, with everything it wrote.
 */
const measureRealCli = async (leg = {}) => {
  const runId = leg.runId ?? REAL_CLI_RUN_ID;
  const sidecar = `egress-${runId}`;
  const runner = runRunner(
    {
      CHECK_PHASE: 'real-cli',
      CHECK_REAL_CLI_RUN_ID: runId,
      CHECK_REAL_CLI_WALL_CLOCK_MS: String(REAL_CLI_WALL_CLOCK_MS),
      ...(leg.mode === undefined ? {} : { CHECK_REAL_CLI_MODE: leg.mode }),
      ...(leg.modelHosts === undefined
        ? {}
        : { CHECK_REAL_CLI_MODEL_HOSTS: leg.modelHosts.join(',') }),
    },
    { name: leg.name ?? 'agentic-wp118-runner-real-cli' },
  );
  let following = null;
  let lastInspect = null;
  for (let attempt = 0; attempt < 240 && following === null; attempt += 1) {
    const exists = await docker(['container', 'inspect', sidecar], { allowFailure: true });
    if (exists.ok) {
      following = docker(['logs', '-f', sidecar], { allowFailure: true });
      break;
    }
    lastInspect = exists.stderr.slice(0, 200);
    await sleep(500);
  }
  const told = lastJsonLine(await runner);
  const logged = following === null ? null : await following;
  if (following === null) {
    process.stdout.write(`the sidecar ${sidecar} was never seen: ${lastInspect}\n`);
  }
  const sidecarLog =
    logged === null
      ? null
      : `${logged.stdout}\n${logged.stderr}`
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => line.slice(0, 300));
  return { told, sidecarLog, refusedHosts: refusedHostsOf(sidecarLog) };
};

/**
 * Every host the sidecar refused, read off its log (WP-133): tinyproxy writes *"Proxying refused on
 * filtered domain "<host>""* at `Notice` for each refused request, which is the level the rendered
 * configuration logs at (`egress.ts`). An **allowed** `CONNECT` is logged at `Connect`, below that,
 * so a host on the run's list never appears here — the leg that allows the model host proves it
 * reached it by the model's own refusal of the fake credential instead.
 */
const refusedHostsOf = (sidecarLog) =>
  sidecarLog === null
    ? null
    : [
        ...new Set(
          sidecarLog.flatMap((line) => {
            const match = /filtered domain "?([^"\s]+)"?/.exec(line);
            return match === null ? [] : [match[1].toLowerCase()];
          }),
        ),
      ].sort();

/**
 * WP-127, PROGRESS backlog **346**: the real `claude` with **no route to the model**. The runner
 * provisions the run and waits; the host stops the run's egress sidecar — the container its
 * `HTTPS_PROXY` names — and lets the runner start the CLI. What comes back is the CLI's retry
 * sequence and how the run ended, under {@link NO_ROUTE_STALL_MS} and {@link NO_ROUTE_WALL_MS}.
 */
const measureNoRoute = async () => {
  const runnerName = 'agentic-wp127-runner-no-route';
  const sidecar = `egress-${NO_ROUTE_RUN_ID}`;
  await docker(['rm', '-f', runnerName], { allowFailure: true });
  await runRunner(
    {
      CHECK_PHASE: 'no-route',
      CHECK_NO_ROUTE_RUN_ID: NO_ROUTE_RUN_ID,
      CHECK_NO_ROUTE_STALL_MS: String(NO_ROUTE_STALL_MS),
      CHECK_NO_ROUTE_WALL_MS: String(NO_ROUTE_WALL_MS),
    },
    { detach: true, name: runnerName },
  );
  let stopped = null;
  for (let attempt = 0; attempt < 240 && stopped === null; attempt += 1) {
    const logs = await docker(['logs', runnerName], { allowFailure: true });
    if (logs.stdout.includes('"provisioned"')) {
      const stop = await docker(['stop', '-t', '1', sidecar], { allowFailure: true });
      stopped = { ok: stop.ok, detail: (stop.stderr || stop.stdout).trim().slice(0, 200) };
      await docker(['exec', runnerName, 'touch', '/tmp/sidecar-stopped'], { allowFailure: true });
      break;
    }
    const state = await docker(['container', 'inspect', '-f', '{{.State.Running}}', runnerName], {
      allowFailure: true,
    });
    if (state.ok && state.stdout.trim() !== 'true') {
      break;
    }
    await sleep(500);
  }
  // Bounded: the run's own wall clock plus the interrupt's grace and the release.
  const waited = await Promise.race([
    docker(['wait', runnerName], { allowFailure: true }).then(() => 'exited'),
    sleep(NO_ROUTE_WALL_MS + 120_000).then(() => 'timed out'),
  ]);
  const told = lastJsonLine(await docker(['logs', runnerName], { allowFailure: true }));
  await docker(['rm', '-f', runnerName], { allowFailure: true });
  return { stopped, waited, told };
};

/** The names the fake CLI reported, and what the check asserts of them (WP-118 criterion 2). */
const environFindings = (environ) => {
  const names = new Set(environ?.names ?? []);
  const git = environ?.git ?? {};
  const keys = Object.entries(git)
    .filter(([name]) => name.startsWith('GIT_CONFIG_KEY_'))
    .map(([, value]) => value)
    .sort();
  return {
    names,
    proxy: ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'].filter((name) => !names.has(name)),
    container: ['HOME', 'CLAUDE_CONFIG_DIR', 'PATH'].filter((name) => !names.has(name)),
    runlet: [...names].filter((name) => name.startsWith('RUNLET_')),
    git: { count: git.GIT_CONFIG_COUNT ?? null, keys },
  };
};

let fixture;
let replay = null;
let realCli = null;
let localCli = null;
let noRoute = null;
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

  // WP-118 (PROGRESS backlog 342): which of the container's variables reached the process the
  // shim started. The spec carries the model credential and nothing else, as production's does.
  const environ = report === null ? null : environFindings(report.environ);
  process.stdout.write(
    `--- backlog 342: the CLI's environment (names) ---\n${JSON.stringify(report?.environ ?? null)}\n`,
  );
  record(
    'backlog 342: the CLI started from a production-shaped spec and reported its environment',
    report?.environ?.source === '/proc/self/environ',
    report?.environ === null || report?.environ === undefined
      ? `no report in the transcript; the run ended ${report?.status}/${report?.terminalReason}`
      : `${report.environ.names.length} names`,
  );
  record(
    'backlog 342: the CLI’s environment carries HTTPS_PROXY, HTTP_PROXY and NO_PROXY (the run has a sidecar)',
    environ !== null && report?.environ != null && environ.proxy.length === 0,
    `missing: ${JSON.stringify(environ?.proxy ?? null)}`,
  );
  record(
    'backlog 342: the CLI’s environment carries HOME, CLAUDE_CONFIG_DIR and PATH',
    environ !== null && report?.environ != null && environ.container.length === 0,
    `missing: ${JSON.stringify(environ?.container ?? null)}`,
  );
  record(
    'backlog 342: no RUNLET_* name reached the CLI',
    environ !== null && report?.environ != null && environ.runlet.length === 0,
    `RUNLET_*: ${JSON.stringify(environ?.runlet ?? null)}`,
  );
  record(
    'backlog 342: one git list, GIT_CONFIG_COUNT=2, credential.helper and core.fsmonitor',
    environ !== null &&
      environ.git.count === '2' &&
      JSON.stringify(environ.git.keys) === JSON.stringify(['core.fsmonitor', 'credential.helper']),
    JSON.stringify(environ?.git ?? null),
  );

  // WP-118 review round 1: the credential helper the CLI's git runs finds the shim.
  const gitCredential = lastJsonLine(
    await runRunner(
      { CHECK_PHASE: 'git-credential', CHECK_GIT_CREDENTIAL_RUN_ID: GIT_CREDENTIAL_RUN_ID },
      { name: 'agentic-wp118-runner-git-credential' },
    ),
  );
  record(
    'the CLI’s git, with the CLI’s environment, gets the run credential from the shim’s cred.get (WP-118 review)',
    gitCredential?.ok === true &&
      gitCredential.username === 'agentic-wp118' &&
      gitCredential.passwordMatches === true,
    JSON.stringify({
      helper: gitCredential?.helper,
      exitCode: gitCredential?.exitCode,
      username: gitCredential?.username,
      passwordMatches: gitCredential?.passwordMatches,
      error: gitCredential?.error,
      notes: gitCredential?.notes,
    }),
  );

  realCli = await measureRealCli();
  process.stdout.write(
    `--- backlog 342 (a): the real CLI ---\n${JSON.stringify(realCli, null, 2)}\n`,
  );
  record(
    'backlog 342 (a): the real CLI’s CONNECT api.anthropic.com reached the sidecar',
    (realCli.sidecarLog ?? []).some(
      (line) => line.includes('filtered domain') && line.includes('api.anthropic.com'),
    ),
    `claudeCodePath ${realCli.told?.claudeCodePath}; sidecar: ${JSON.stringify((realCli.sidecarLog ?? []).filter((line) => line.includes('api.anthropic.com')).slice(0, 2))}`,
  );
  record(
    'backlog 342 (a): how the real CLI ended with a fake key and no model host (observation)',
    realCli.told !== null,
    JSON.stringify({
      status: realCli.told?.status,
      terminalReason: realCli.told?.terminalReason,
      error: realCli.told?.error,
      stderr: (realCli.told?.stderr ?? '').slice(-400),
    }),
  );

  // WP-133 (backlog 137, its `local`-mode half): the real CLI as `compose.local.yml` runs it — the
  // server's own `agentRunEnvironment` for `local` mode with an obviously fake subscription token,
  // under the stock model host list. It reaches `api.anthropic.com`, which refuses the token; every
  // host it asked for that is not on the run's list is in the sidecar's log.
  localCli = await measureRealCli({
    runId: LOCAL_CLI_RUN_ID,
    mode: 'local',
    modelHosts: STOCK_MODEL_EGRESS_HOSTS,
    name: 'agentic-wp133-runner-local-cli',
  });
  const localText = JSON.stringify(localCli.told ?? {});
  process.stdout.write(
    `--- backlog 137 (local): the real CLI with a fake subscription token ---\n${JSON.stringify(
      {
        mode: localCli.told?.mode,
        status: localCli.told?.status,
        terminalReason: localCli.told?.terminalReason,
        outcomeError: localCli.told?.outcomeError,
        error: localCli.told?.error,
        egressHosts: localCli.told?.egressHosts,
        refusedHosts: localCli.refusedHosts,
        sidecarLog: localCli.sidecarLog,
        stderr: (localCli.told?.stderr ?? '').slice(-1_500),
        transcript: (localCli.told?.transcript ?? '').slice(-2_500),
      },
      null,
      2,
    )}\n`,
  );
  record(
    'backlog 137 (local): the run carries the server’s local-mode environment — CLAUDE_CODE_OAUTH_TOKEN by name, and nothing else (WP-133)',
    JSON.stringify(localCli.told?.envNames) === '["CLAUDE_CODE_OAUTH_TOKEN"]' &&
      JSON.stringify(localCli.told?.secretEnvNames) === '["CLAUDE_CODE_OAUTH_TOKEN"]',
    JSON.stringify({
      env: localCli.told?.envNames,
      secretEnvNames: localCli.told?.secretEnvNames,
    }),
  );
  record(
    'backlog 137 (local): the run’s egress list is the stock model hosts and the git host (WP-133)',
    JSON.stringify([...(localCli.told?.egressHosts ?? [])].sort()) ===
      JSON.stringify([...STOCK_MODEL_EGRESS_HOSTS, fixture.repoContainer].sort()),
    JSON.stringify({ egress: localCli.told?.egressHosts, stock: STOCK_MODEL_EGRESS_HOSTS }),
  );
  record(
    'backlog 137 (local): the CLI reached the model host and was refused the fake subscription token (WP-133)',
    // The CLI's own `api_retry` carries the status the model API answered: 401 is the API refusing
    // the token, which it can only do once the request has crossed the sidecar to it.
    (localCli.told?.transcript ?? '').includes('"error_status":401'),
    JSON.stringify({
      status: localCli.told?.status,
      outcomeError: (localCli.told?.outcomeError ?? '').slice(0, 300),
      error: (localCli.told?.error ?? '').slice(0, 300),
    }),
  );
  record(
    'backlog 137 (local): the sidecar refused no host — every host the CLI asked for is on the run’s list (WP-133)',
    Array.isArray(localCli.refusedHosts) && localCli.refusedHosts.length === 0,
    JSON.stringify({ refused: localCli.refusedHosts, lines: (localCli.sidecarLog ?? []).length }),
  );
  const launcherAfterLocal = await docker(['logs', LAUNCHER_NAME], { allowFailure: true });
  const tokenSeen = [
    ['the runner’s record', localCli.told?.leaked === true || localText.includes(FAKE_OAUTH_TOKEN)],
    [
      'the sidecar’s log',
      (localCli.sidecarLog ?? []).some((line) => line.includes(FAKE_OAUTH_TOKEN)),
    ],
    [
      'the launcher’s log',
      `${launcherAfterLocal.stdout}${launcherAfterLocal.stderr}`.includes(FAKE_OAUTH_TOKEN),
    ],
  ]
    .filter(([, seen]) => seen)
    .map(([where]) => where);
  record(
    'backlog 137 (local): the token’s value is in no record and no log line, only its name (WP-133)',
    localCli.told !== null && localCli.told?.leaked === false && tokenSeen.length === 0,
    tokenSeen.length === 0
      ? `leaked: ${String(localCli.told?.leaked)}`
      : `seen in ${tokenSeen.join(', ')}`,
  );

  // WP-127 (backlog 346): the real CLI with its sidecar stopped. The retry sequence is printed
  // whole; what is asserted is that the run ended `stalled` naming the route, which is what the
  // shipped stall does once an `api_retry` is not progress — when the stall is shorter than the
  // wall clock (the default flags). With both past the CLI's give-up, the ending is the CLI's own.
  noRoute = await measureNoRoute();
  process.stdout.write(
    `--- backlog 346: the real CLI with no route to the model ---\n${JSON.stringify(noRoute, null, 2)}\n`,
  );
  record(
    'backlog 346: the sidecar was stopped before the CLI started, and the CLI retried the model API',
    noRoute.stopped?.ok === true &&
      noRoute.told?.gate === 'sidecar stopped' &&
      (noRoute.told?.retries ?? []).length > 0 &&
      noRoute.told?.leaked === false,
    JSON.stringify({
      stopped: noRoute.stopped,
      gate: noRoute.told?.gate,
      retries: (noRoute.told?.retries ?? []).length,
      last: (noRoute.told?.retries ?? []).at(-1) ?? null,
      error: noRoute.told?.error,
    }),
  );
  if (NO_ROUTE_STALL_MS < NO_ROUTE_WALL_MS) {
    record(
      'backlog 346: the retries did not hold the run open; it ended stalled, naming the route (WP-127)',
      noRoute.told?.status === 'stalled' &&
        typeof noRoute.told?.error === 'string' &&
        noRoute.told.error.includes('no route to the model host') &&
        noRoute.told.wallMs < NO_ROUTE_WALL_MS,
      JSON.stringify({
        status: noRoute.told?.status,
        error: noRoute.told?.error,
        wall_ms: noRoute.told?.wallMs,
        stall_ms: NO_ROUTE_STALL_MS,
      }),
    );
  } else {
    record(
      'backlog 346: with no platform stop before its give-up, the CLI gave up and the run’s error names the route (WP-127)',
      noRoute.told?.status === 'failed' &&
        typeof noRoute.told?.error === 'string' &&
        noRoute.told.error.startsWith('the CLI gave up after retrying') &&
        noRoute.told.error.includes('no route to the model host'),
      JSON.stringify({
        status: noRoute.told?.status,
        terminalReason: noRoute.told?.terminalReason,
        error: noRoute.told?.error,
        wall_ms: noRoute.told?.wallMs,
        stderr: (noRoute.told?.stderr ?? '').slice(-400),
      }),
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
  // WP-132 (backlog 425): with nothing in flight the close has nothing to wait for, so a grace
  // set for a create costs an ordinary stop nothing. Bounded at a fifth of the grace, far above the
  // sub-second it should take, so a close that waited on something idle fails here by name.
  record(
    `backlog 425: a launcher stopped with nothing in flight exits well inside its ${LAUNCHER_STOP_GRACE_S} s grace (WP-132)`,
    replay.idleStopMs < (LAUNCHER_STOP_GRACE_S * 1000) / 5,
    JSON.stringify({ idle_stop_ms: replay.idleStopMs, grace_s: LAUNCHER_STOP_GRACE_S }),
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
      how === 'stop'
        ? 'backlog 286 (a) and 425: a launcher stopped during a create answers it, under compose.yml’s own grace (WP-132)'
        : 'backlog 286 (a): a launcher killed during a create is not answered, and leaves objects behind (measured)',
      measured.networkAfterMs !== null &&
        measured.restarted &&
        // WP-132 (backlog 425): under the launcher's own `stop_grace_period` a stop during a create
        // is drained and the create **answered** — the only ending accepted for a stop. A kill
        // still leaves its objects for the reaper.
        ((how === 'stop' && measured.told?.ok === true) ||
          (how === 'kill' &&
            measured.told?.ok === false &&
            measured.told?.errorCode === 'engine_unavailable' &&
            measured.afterDown.networks.length === 1 &&
            !measured.afterDown.containers.some((line) => line.startsWith('ws-')))),
      JSON.stringify({
        told: measured.told?.errorCode,
        cause: measured.told?.errorCause,
        down_ms: measured.downMs,
        launcher: measured.launcherTail.filter((line) => line.startsWith('launcher ')).slice(-3),
        after_down: measured.afterDown,
      }),
    );
  }
  // WP-127, backlog 339 (b), and WP-132, backlog 425: what a stop does to an in-flight create. The
  // close waits for the create. WP-127 measured that under ten seconds the daemon killed the
  // launcher before its close resolved (exit 137, no close line), and with a 90 s grace the close
  // resolved 12.1 s after the signal (at load 14). Since WP-132 the launcher has a grace of its own,
  // set from that measurement with margin (`compose.yml`), so the one ending accepted is the
  // drained one: SIGTERM logged, the close resolved inside the grace, exit 0, the create answered.
  {
    const log = orphans.stop.launcherLog;
    const has = (prefix) => log.some((line) => line.startsWith(prefix));
    const closedAfterMs = Number(
      /^launcher closed after (\d+) ms/.exec(
        log.find((line) => line.startsWith('launcher closed after')) ?? '',
      )?.[1] ?? Number.NaN,
    );
    const drained =
      orphans.stop.launcherExitCode === 0 &&
      Number.isFinite(closedAfterMs) &&
      closedAfterMs < LAUNCHER_STOP_GRACE_S * 1000 &&
      orphans.stop.told?.ok === true;
    record(
      `backlog 339 and 425: a launcher stopped during a create drains it inside its ${LAUNCHER_STOP_GRACE_S} s grace and answers it (WP-132)`,
      has('launcher signal: SIGTERM') &&
        !has('launcher close rejected') &&
        !has('launcher uncaught') &&
        !has('launcher unhandled') &&
        drained,
      JSON.stringify({
        ending: drained
          ? 'drained'
          : orphans.stop.launcherExitCode === 137
            ? 'killed at the grace'
            : 'neither',
        grace_s: LAUNCHER_STOP_GRACE_S,
        closed_after_ms: Number.isFinite(closedAfterMs) ? closedAfterMs : null,
        network_after_ms: orphans.stop.networkAfterMs,
        exit: orphans.stop.launcherExitCode,
        down_ms: orphans.stop.downMs,
        log: log.filter((line) => line.startsWith('launcher ')).slice(-4),
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
    [RESTART_STOP_RUN_ID, RESTART_KILL_RUN_ID, NETWORK_ONLY_RUN_ID, REPLAY_RUN_ID].every((runId) =>
      (reapFirst.told?.listedBefore ?? []).includes(runId),
    ),
    JSON.stringify(reapFirst.told?.listedBefore ?? null),
  );
  record(
    'the reaper removed the three terminal runs, one of them only a network, and kept the live one (criterion 2)',
    JSON.stringify((reapFirst.told?.destroyed ?? []).map((entry) => entry.runId).sort()) ===
      JSON.stringify([RESTART_STOP_RUN_ID, RESTART_KILL_RUN_ID, NETWORK_ONLY_RUN_ID].sort()) &&
      (reapFirst.told?.destroyed ?? []).every((entry) => entry.found === true) &&
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
    'a run a killed create left with only its network is listed and reaped: no network left (WP-118 pre-review)',
    reapFirst.after[NETWORK_ONLY_RUN_ID].networks.length === 0 &&
      reapFirst.after[NETWORK_ONLY_RUN_ID].containers.length === 0,
    JSON.stringify(reapFirst.after[NETWORK_ONLY_RUN_ID]),
  );
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
  await docker(['network', 'rm', `run-${NETWORK_ONLY_RUN_ID}`], { allowFailure: true });
  await fixture?.cleanup();
  // The two run volumes retention deliberately keeps; this is a check, not an instance.
  for (const runId of [
    RUN_ID,
    IDEMPOTENCY_RUN_ID,
    BAD_RUN_ID,
    REPLAY_RUN_ID,
    REAL_CLI_RUN_ID,
    LOCAL_CLI_RUN_ID,
    NO_ROUTE_RUN_ID,
    GIT_CREDENTIAL_RUN_ID,
    ...ALL_286_RUN_IDS,
  ]) {
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
