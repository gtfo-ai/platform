#!/usr/bin/env node
/**
 * `node scripts/runlet-launcher-check.mjs` — **WP-15g's second acceptance criterion**: the real
 * launcher, the real run container, the real run shim, the real `createRunletSpawn` and the platform's
 * own runner, meeting each other once, with a fake CLI instead of a model.
 *
 * ## Why this is a script and not a test
 *
 * It needs a Docker daemon, three images and about a minute, so making it a `verify` target would put
 * it in CI's lint or unit job (`scripts/verify-targets.ts` derives one from the other) and neither has
 * a daemon. It lands beside `runlet-container-check.mjs` (TD-025's own Docker verification) for the
 * same reason; `docs/research/12-run-shim-verification.md` is where a run of that one is written up.
 *
 * ## The two halves, and why the work happens in a container
 *
 * This process sets the world up — network, volumes, a git daemon serving a fixture repository — and
 * then starts **one** container that composes the launcher *and* the runner
 * (`runlet-launcher-inner.mjs`), which is TD-021's own deployment and Q52's in-process composition.
 * Two measurements forced that arrangement, and both are recorded in the inner script: a Unix socket
 * created inside the Docker VM cannot be connected to from a macOS host, and the shim refuses to start
 * on a bind-backed control volume because `chmod` on a socket there answers `EINVAL`.
 *
 * ## Why a launcher process may hold a Docker client when `apps/server` may not
 *
 * TD-021's WP-15g amendment: *no process that composes the pipeline or serves `/webhooks/*` may
 * construct a Docker client.* Neither process here does either, and the inner one **is** a launcher:
 * it calls `buildLauncher` — `apps/launcher`'s own composition root — rather than assembling a
 * provider of its own. `apps/launcher/src/docker-access.test.ts` keeps that true across the
 * repository, off disk.
 *
 * ## What it does not prove
 *
 * The real `claude` binary, the `platform-runtime` image (WP-22 owns it), the egress **filter**, or
 * anything about a model. The run is read-only, so the credential path is not exercised either — that
 * is `broker.test.ts`'s and WP-14's e2e's.
 *
 * ## Environment
 *
 * `DOCKER_HOST` is **required** and has no default since WP-15g (standing rule 55: absence of
 * configuration must not grant the unfiltered daemon). On Docker Desktop:
 *
 *     DOCKER_HOST=unix:///var/run/docker.sock node scripts/runlet-launcher-check.mjs
 */
import process from 'node:process';
import './ts-source-resolver.mjs';

const { startDockerFixture, RUNTIME_IMAGE, EGRESS_IMAGE, GIT_IMAGE, REPO_ROOT, docker } =
  await import(new URL('../test/e2e/support/docker-workspace.ts', import.meta.url).href);

const RUN_ID = '9f3a1c2e-0000-4000-8000-00000000f00d';
const DOCKER_HOST = process.env['DOCKER_HOST'];
if (!DOCKER_HOST) {
  process.stderr.write(
    'DOCKER_HOST is required and has no default (TD-021, WP-15g): try DOCKER_HOST=unix:///var/run/docker.sock\n',
  );
  process.exit(2);
}
/** The daemon socket the *inner* container talks to. Only the unix form can be bind-mounted. */
const INNER_SOCKET = DOCKER_HOST.startsWith('unix://') ? DOCKER_HOST.slice('unix://'.length) : null;

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`);
};

let fixture;
try {
  if (INNER_SOCKET === null) {
    throw new Error(
      `this check bind-mounts the daemon socket into one container, so DOCKER_HOST must be a unix:// path (got ${DOCKER_HOST})`,
    );
  }
  // A **plain** named volume for the control channel: the shim `chmod`s its socket, which answers
  // EINVAL on a bind-backed volume on macOS. See `DockerFixtureOptions.controlVolumeBind`.
  fixture = await startDockerFixture({ controlVolumeBind: false });

  const driven = await docker(
    [
      'run',
      '--rm',
      '--name',
      `agentic-launcher-check-${RUN_ID.slice(0, 8)}`,
      // Root, so the daemon socket is usable and the shim's `0600` control socket (uid 1000, created
      // inside the run container) is reachable. The uid the *provider* is told about is still 1000,
      // which is the uid the run container runs as — Q51's constraint is about that pair.
      '--user',
      '0:0',
      '--network',
      'none',
      '-e',
      'DOCKER_HOST=unix:///var/run/docker.sock',
      '-e',
      `CHECK_RUN_ID=${RUN_ID}`,
      '-e',
      `CHECK_CONTROL_VOLUME=${fixture.controlVolume}`,
      '-e',
      `CHECK_CACHE_VOLUME=${fixture.cacheVolume}`,
      '-e',
      `CHECK_RUNTIME_IMAGE=${RUNTIME_IMAGE}`,
      '-e',
      // `platform-egress`, not a stand-in: since WP-22 `create` refuses a run whose sidecar is not
      // running when it returns, and an image with no long-lived process exits immediately — which
      // is the failure this check would otherwise report as "the control socket was never reached".
      `CHECK_EGRESS_IMAGE=${EGRESS_IMAGE}`,
      '-e',
      `CHECK_GIT_IMAGE=${GIT_IMAGE}`,
      // The path the **host** must mount into every run container, so it is the host's path even
      // though this container reads the same tree at `/repo`.
      '-e',
      `CHECK_REPO_ROOT=${REPO_ROOT}`,
      '-e',
      `CHECK_NETWORK=${fixture.network}`,
      '-e',
      `CHECK_REPO_URL=${fixture.repoUrl}`,
      '-e',
      `CHECK_REPO_HOST=${fixture.repoContainer}`,
      '-e',
      'HOME=/tmp',
      '-v',
      `${INNER_SOCKET}:/var/run/docker.sock`,
      // **At the host's own path**, not at `/repo`: the launcher validates a bind source against its
      // own filesystem (`assertSafeBindSource`, which also requires `pnpm-workspace.yaml` in it), and
      // the path it hands the daemon for every run container is the host's. Mounting it anywhere else
      // makes the check fail with `bind source does not exist` — measured.
      '-v',
      `${REPO_ROOT}:${REPO_ROOT}:ro`,
      '-v',
      `${fixture.controlVolume}:/run/agentic/ctl`,
      '-w',
      REPO_ROOT,
      // **`--entrypoint node`**, because `RUNTIME_IMAGE` is `platform-runtime` since WP-22 and its
      // entrypoint is the run shim: without this the container starts `agentic-runlet node …` and
      // answers `unknown mode "node"`. This container is the *platform* side — launcher and runner
      // in one process — and only borrows the image for its Node runtime and its checkout mount.
      '--entrypoint',
      'node',
      RUNTIME_IMAGE,
      `${REPO_ROOT}/scripts/runlet-launcher-inner.mjs`,
    ],
    { allowFailure: true },
  );

  let report = null;
  try {
    const lines = driven.stdout.split('\n').filter((line) => line.trim().length > 0);
    report = JSON.parse(lines.at(-1) ?? '{}');
  } catch {
    report = null;
  }
  if (report === null) {
    record(
      'the launcher container produced a report',
      false,
      `stdout: ${driven.stdout}\nstderr: ${driven.stderr}`,
    );
  } else {
    record(
      'the launcher created a run and the runner reached its control socket',
      typeof report.socketPath === 'string' &&
        report.socketPath.includes(RUN_ID) &&
        report.workdir === '/work/repo',
      `${report.socketPath} in ${report.workdir}`,
    );
    record(
      'the run is read-only, so the launcher minted no git credential',
      report.credential === 'none',
      `credential: ${report.credential}`,
    );
    record(
      'a real run completed through the shim and a fake CLI executable',
      report.ok === true,
      `${report.status}/${report.terminalReason}, ${report.costUsd} USD${
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
  }

  if (report?.ok !== true) {
    // The run container's log is where the shim's own words are, and it outlives the container only
    // until `endRun` removes it — so this is best-effort and printed rather than recorded.
    const shimLog = await docker(['logs', `ws-${RUN_ID}`], { allowFailure: true });
    process.stderr.write(
      `--- run container log ---\n${shimLog.stdout}\n${shimLog.stderr}\n--- inner container stderr ---\n${driven.stderr}\n`,
    );
  }

  // `container inspect`, not `inspect`: the bare form also resolves volumes, and `ws-<run-id>` is both
  // a container **and** the volume retention deliberately keeps (technical/05 §5). The first version
  // of this check asked the wrong question and failed on a correct teardown.
  const container = await docker(['container', 'inspect', `ws-${RUN_ID}`], { allowFailure: true });
  record(
    'the run container is gone after the run ended',
    !container.ok,
    container.ok ? 'the container is still there' : 'no such container',
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
  await fixture?.cleanup();
}

const failed = results.filter((result) => !result.ok);
process.stdout.write(
  `\n${failed.length === 0 ? 'PASS' : 'FAIL'}: runlet-launcher-check (${results.length - failed.length}/${results.length} checks)\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
