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
 * ## Environment
 *
 *     DOCKER_HOST=unix:///var/run/docker.sock node scripts/launcher-control-plane-check.mjs
 */
import process from 'node:process';
import './ts-source-resolver.mjs';

const { startDockerFixture, RUNTIME_IMAGE, EGRESS_IMAGE, GIT_IMAGE, REPO_ROOT, docker } =
  await import(new URL('../test/e2e/support/docker-workspace.ts', import.meta.url).href);

const RUN_ID = '9f3a1c2e-0000-4000-8000-0000000053a1';
const IDEMPOTENCY_RUN_ID = '9f3a1c2e-0000-4000-8000-0000000053a2';
const BAD_RUN_ID = '9f3a1c2e-0000-4000-8000-0000000053a3';
const TOKEN = 'FAKE-wp53-launcher-token-000000000000';
const PORT = '7780';
const LAUNCHER_NAME = 'agentic-wp53-launcher';
const BAD_LAUNCHER_NAME = 'agentic-wp53-launcher-badcli';

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

let fixture;
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

  driven = await docker(
    [
      'run',
      '--rm',
      '--name',
      `agentic-wp53-runner-${RUN_ID.slice(0, 8)}`,
      // **No docker socket.** This is the property the whole split exists for: the process that
      // runs the agent reaches the daemon through nothing at all.
      '--user',
      '0:0',
      '--network',
      fixture.network,
      '-e',
      `CHECK_RUN_ID=${RUN_ID}`,
      '-e',
      `CHECK_IDEMPOTENCY_RUN_ID=${IDEMPOTENCY_RUN_ID}`,
      '-e',
      `CHECK_BAD_RUN_ID=${BAD_RUN_ID}`,
      '-e',
      `CHECK_LAUNCHER_URL=http://${LAUNCHER_NAME}:${PORT}`,
      '-e',
      `CHECK_BAD_LAUNCHER_URL=http://${BAD_LAUNCHER_NAME}:${PORT}`,
      '-e',
      `CHECK_LAUNCHER_TOKEN=${TOKEN}`,
      '-e',
      `CHECK_REPO_URL=${fixture.repoUrl}`,
      '-e',
      `CHECK_REPO_HOST=${fixture.repoContainer}`,
      '-e',
      'HOME=/tmp',
      '-v',
      `${REPO_ROOT}:${REPO_ROOT}:ro`,
      // TD-025 §2's static mount, on the runner side. This is the data plane.
      '-v',
      `${fixture.controlVolume}:/run/agentic/ctl`,
      '-w',
      REPO_ROOT,
      '--entrypoint',
      'node',
      RUNTIME_IMAGE,
      `${REPO_ROOT}/scripts/launcher-control-plane-runner.mjs`,
    ],
    { allowFailure: true },
  );

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
  for (const runId of [RUN_ID, IDEMPOTENCY_RUN_ID, BAD_RUN_ID]) {
    await docker(['volume', 'rm', '-f', `ws-${runId}`], { allowFailure: true });
  }
}

const failed = results.filter((result) => !result.ok);
process.stdout.write(
  `\n${failed.length === 0 ? 'PASS' : 'FAIL'}: launcher-control-plane-check (${results.length - failed.length}/${results.length} checks)\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
