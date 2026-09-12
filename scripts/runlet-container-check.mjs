#!/usr/bin/env node
/**
 * `node scripts/runlet-container-check.mjs` — the Docker half of WP-13's verification (TD-025).
 *
 * TD-025 left two facts to check "on the target Docker version" and the work package asks for a
 * report rather than a claim, so this script *is* the measurement: it runs each check against the
 * daemon on this machine and prints what it found. `docs/research/12-run-shim-verification.md`
 * records a run of it, with the version it ran on and the separation between what was measured
 * here and what is inferred about the deployment WP-14 and WP-22 will build.
 *
 * It is deliberately **not** a `verify` target: it needs a Docker daemon, two images and about a
 * minute. Adding it to `verify` would add it to CI (`scripts/verify-targets.ts`), and CI's lint and
 * unit jobs have no daemon.
 *
 * Checks:
 *   1. `volume-subpath` mounts one sub-directory of a shared named volume and hides its siblings.
 *   2. A missing sub-path fails the container start loudly (so the launcher must create it first).
 *   3. Embedded DNS resolves a container by name on an `internal: true` network…
 *   4. …while an external name does not resolve and there is no default route.
 *   5. A real SDK `query()` completes through the shim running in a **hardened** container, over a
 *      Unix socket on the control volume, driven from a second container — TD-025 §2's layout.
 *   6. Killing the runner container leaves no agent behind: the shim SIGTERMs, waits its grace and
 *      SIGKILLs, and the run container exits by itself.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VOLUME = 'agentic-runlet-check-ctl';
const NETWORK = 'agentic-runlet-check-net';
const SHIM = 'agentic-runlet-check-shim';
const PEER = 'agentic-runlet-check-peer';
const RUN_ID = 'run-x';
const TOKEN = 'run-token-container-check-0000000';
const IMAGE = process.env['RUNLET_CHECK_IMAGE'] ?? 'node:24-alpine';
const ALPINE = process.env['RUNLET_CHECK_ALPINE'] ?? 'alpine:3.21';
/**
 * The **real** run image, when there is one (WP-22).
 *
 * With it set, the shim container is `platform-runtime` started from its own entrypoint with **no
 * `/repo` bind mount** — the arrangement technical/05 requires of a run container and the one this
 * script could not produce before the image existed. Two things follow, and they are the whole of
 * the difference:
 *
 *  - the fake CLI cannot come from the repository, because the repository is not mounted. It is
 *    copied onto the control volume instead, and the driver container mounts that volume's run
 *    sub-directory at `/ctl` as well as the whole volume at `/run/agentic/ctl`, so
 *    `/ctl/fake-claude-cli` is the same path on both sides — which matters because the SDK checks
 *    `existsSync` on the executable **on the runner's side** before handing the command to
 *    `spawnClaudeCodeProcess`;
 *  - the child's `cwd` is `/tmp` rather than `/repo`, for the same reason.
 *
 * Unset, everything below behaves exactly as it did at WP-13: `node:24-alpine` plus `/repo`.
 */
const RUNTIME_IMAGE = process.env['RUNLET_CHECK_RUNTIME_IMAGE'] ?? null;
const SHIM_IMAGE = RUNTIME_IMAGE ?? IMAGE;
/** Where the fake CLI lives, as **both** containers see it. */
const FAKE_CLI =
  RUNTIME_IMAGE === null ? '/repo/test/fixtures/runlet/fake-claude-cli' : '/ctl/fake-claude-cli';
const CHILD_CWD = RUNTIME_IMAGE === null ? '/repo' : '/tmp';

/** The hardening flags of technical/05 § "Hardening flags (per run container)". */
const HARDENING = [
  '--user',
  '1000:1000',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  '--read-only',
  '--tmpfs',
  '/tmp',
  '--pids-limit',
  '256',
  '--memory',
  '512m',
  '--network',
  'none',
  '--init',
];

const docker = async (args, { allowFailure = false } = {}) => {
  try {
    const { stdout, stderr } = await run('docker', args, { maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    if (!allowFailure) {
      throw error;
    }
    return {
      ok: false,
      stdout: String(error.stdout ?? '').trim(),
      stderr: String(error.stderr ?? error.message).trim(),
    };
  }
};

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  process.stdout.write(
    `${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail.replace(/\n/g, '\n      ')}\n`,
  );
};

/** Polls a container's state with a deadline. No busy loop, no unbounded wait (standing rule 25). */
const waitForContainerExit = async (name, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await docker(['inspect', '-f', '{{.State.Status}}:{{.State.ExitCode}}', name], {
      allowFailure: true,
    });
    if (state.ok && state.stdout.startsWith('exited')) {
      return state.stdout;
    }
    if (Date.now() > deadline) {
      return `still ${state.stdout || 'unknown'} after ${timeoutMs} ms`;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

const cleanup = async () => {
  for (const name of [SHIM, PEER]) {
    await docker(['rm', '-f', '-v', name], { allowFailure: true });
  }
  await docker(['volume', 'rm', VOLUME], { allowFailure: true });
  await docker(['network', 'rm', NETWORK], { allowFailure: true });
};

const prepareVolume = async () => {
  await docker(['volume', 'create', VOLUME]);
  await docker([
    'run',
    '--rm',
    '-v',
    `${VOLUME}:/ctl`,
    // The repository, read-only, so the fake CLI can be copied onto the volume. This is the
    // *preparation* container — the launcher's `#prepare` equivalent — and never the run
    // container, which is the one technical/05 forbids a host mount.
    '-v',
    `${REPO}:/repo:ro`,
    ALPINE,
    'sh',
    '-c',
    `mkdir -p /ctl/${RUN_ID} /ctl/other-run && printf %s '${TOKEN}' > /ctl/${RUN_ID}/token && ` +
      `printf %s 'another run' > /ctl/other-run/secret && ` +
      'cp /repo/test/fixtures/runlet/fake-claude-cli /ctl/' +
      `${RUN_ID}/fake-claude-cli && chmod 755 /ctl/${RUN_ID}/fake-claude-cli && ` +
      `chown -R 1000:1000 /ctl/${RUN_ID} && ` +
      `chmod 700 /ctl/${RUN_ID} && chmod 600 /ctl/${RUN_ID}/token`,
  ]);
};

const checkSubpath = async () => {
  const listed = await docker([
    'run',
    '--rm',
    '--mount',
    `type=volume,source=${VOLUME},target=/ctl,volume-subpath=${RUN_ID}`,
    ALPINE,
    'sh',
    '-c',
    'ls /ctl',
  ]);
  const isolated = listed.stdout.includes('token') && !listed.stdout.includes('secret');
  record(
    'volume-subpath mounts one run directory and hides its siblings',
    isolated,
    `container sees: ${listed.stdout.split('\n').join(', ')}`,
  );

  const missing = await docker(
    [
      'run',
      '--rm',
      '--mount',
      `type=volume,source=${VOLUME},target=/ctl,volume-subpath=does-not-exist`,
      ALPINE,
      'true',
    ],
    { allowFailure: true },
  );
  record(
    'a missing sub-path fails the container start rather than creating it',
    !missing.ok && /no such file or directory/i.test(missing.stderr),
    missing.stderr.split('\n')[0] ?? '(no message)',
  );
};

const checkInternalNetwork = async () => {
  await docker(['network', 'create', '--internal', NETWORK]);
  await docker(['run', '-d', '--name', PEER, '--network', NETWORK, ALPINE, 'sleep', '120']);
  const probe = await docker([
    'run',
    '--rm',
    '--network',
    NETWORK,
    ALPINE,
    'sh',
    '-c',
    `nslookup ${PEER} >/tmp/a 2>&1; echo "peer=$?"; nslookup example.com >/tmp/b 2>&1; ` +
      // busybox `ip route show default` does not honour the selector — it prints the link route
      // too, and a `wc -l` over it reads 1 where the answer is 0. Match the line instead.
      'grep -c SERVFAIL /tmp/b; ip route | grep -c "^default"; cat /tmp/a',
  ]);
  const lines = probe.stdout.split('\n');
  const peerResolved = lines[0] === 'peer=0';
  const externalFailed = Number(lines[1] ?? 0) > 0;
  const noDefaultRoute = Number(lines[2] ?? 1) === 0;
  record(
    'embedded DNS resolves a container by name on an internal network',
    peerResolved,
    lines.slice(3).join(' ').trim() || probe.stdout,
  );
  record(
    'an internal network resolves nothing external and has no default route',
    externalFailed && noDefaultRoute,
    `external lookup SERVFAILs: ${externalFailed}; default routes: ${lines[2]}`,
  );
  await docker(['rm', '-f', '-v', PEER], { allowFailure: true });
};

const startShimContainer = async (extraEnv = []) =>
  docker([
    'run',
    '-d',
    '--name',
    SHIM,
    ...HARDENING,
    // The whole difference between the two arrangements: with the real image there is no host
    // mount and no command, because the shim **is** the image's entrypoint.
    ...(RUNTIME_IMAGE === null ? ['-v', `${REPO}:/repo:ro`] : []),
    '--mount',
    `type=volume,source=${VOLUME},target=/ctl,volume-subpath=${RUN_ID}`,
    '-e',
    'RUNLET_CONTROL_SOCKET=/ctl/ctl.sock',
    '-e',
    'RUNLET_CREDENTIAL_SOCKET=/ctl/cred.sock',
    '-e',
    'RUNLET_TOKEN_FILE=/ctl/token',
    '-e',
    'HOME=/tmp',
    ...extraEnv,
    '-w',
    CHILD_CWD,
    SHIM_IMAGE,
    ...(RUNTIME_IMAGE === null
      ? [
          'node',
          '--import',
          '/repo/scripts/ts-source-resolver.mjs',
          '/repo/apps/runlet/src/index.ts',
        ]
      : []),
  ]);

const waitForSocket = async (timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = await docker(
      [
        'run',
        '--rm',
        '-v',
        `${VOLUME}:/ctl`,
        ALPINE,
        'sh',
        '-c',
        `test -S /ctl/${RUN_ID}/ctl.sock && echo yes || echo no`,
      ],
      { allowFailure: true },
    );
    if (probe.stdout === 'yes') {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

const checkHardenedQuery = async () => {
  await docker(['rm', '-f', '-v', SHIM], { allowFailure: true });
  await startShimContainer();
  const listening = await waitForSocket();
  if (!listening) {
    record('the shim listens inside a hardened container', false, await shimLogs());
    return;
  }
  const driven = await docker(
    [
      'run',
      '--rm',
      '--name',
      PEER,
      '--user',
      '1000:1000',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--network',
      'none',
      '--tmpfs',
      '/tmp',
      '-e',
      'HOME=/tmp',
      '-e',
      `RUNLET_SOCKET=/run/agentic/ctl/${RUN_ID}/ctl.sock`,
      '-e',
      `RUNLET_TOKEN=${TOKEN}`,
      '-e',
      `RUNLET_FAKE_CLI=${FAKE_CLI}`,
      '-e',
      `RUNLET_CHILD_CWD=${CHILD_CWD}`,
      '-v',
      `${REPO}:/repo:ro`,
      '-v',
      `${VOLUME}:/run/agentic/ctl`,
      // The run's own sub-directory, at the path the *shim* sees it, so the executable the SDK
      // checks for on this side is the one the shim will execute on the other.
      ...(RUNTIME_IMAGE === null
        ? []
        : ['--mount', `type=volume,source=${VOLUME},target=/ctl,volume-subpath=${RUN_ID}`]),
      '-w',
      '/repo',
      IMAGE,
      'node',
      '/repo/scripts/runlet-container-driver.mjs',
    ],
    { allowFailure: true },
  );
  let parsed = null;
  try {
    parsed = JSON.parse(driven.stdout.split('\n').at(-1) ?? '{}');
  } catch {
    parsed = null;
  }
  record(
    'an SDK query() completes through the shim in a hardened container',
    parsed?.ok === true && parsed.result === 'the shim carried this',
    parsed === null ? `${driven.stdout}\n${driven.stderr}`.slice(0, 600) : JSON.stringify(parsed),
  );
  record(
    'the run container exits by itself once the CLI is done',
    (await waitForContainerExit(SHIM)) === 'exited:0',
    await shimLogs(),
  );
};

const shimLogs = async () => {
  const logs = await docker(['logs', SHIM], { allowFailure: true });
  return `${logs.stdout}\n${logs.stderr}`.trim().split('\n').slice(-3).join(' | ');
};

const checkKillOnDisconnect = async () => {
  await docker(['rm', '-f', '-v', SHIM], { allowFailure: true });
  await startShimContainer(['-e', 'RUNLET_KILL_GRACE_MS=500']);
  if (!(await waitForSocket())) {
    record('kill on disconnect', false, await shimLogs());
    return;
  }
  // A peer that authenticates, spawns a child which ignores SIGTERM, and is then killed outright —
  // a runner crash, not a graceful teardown.
  const peer = docker(
    [
      'run',
      '--rm',
      '--name',
      PEER,
      '--user',
      '1000:1000',
      '--network',
      'none',
      '--tmpfs',
      '/tmp',
      '-e',
      'HOME=/tmp',
      '-e',
      `RUNLET_SOCKET=/run/agentic/ctl/${RUN_ID}/ctl.sock`,
      '-e',
      `RUNLET_TOKEN=${TOKEN}`,
      '-e',
      `RUNLET_FAKE_CLI=${FAKE_CLI}`,
      '-e',
      `RUNLET_CHILD_CWD=${CHILD_CWD}`,
      '-e',
      'RUNLET_SCENARIO=ignore-term',
      '-v',
      `${REPO}:/repo:ro`,
      '-v',
      `${VOLUME}:/run/agentic/ctl`,
      ...(RUNTIME_IMAGE === null
        ? []
        : ['--mount', `type=volume,source=${VOLUME},target=/ctl,volume-subpath=${RUN_ID}`]),
      '-w',
      '/repo',
      IMAGE,
      'node',
      '/repo/scripts/runlet-container-driver.mjs',
    ],
    { allowFailure: true },
  );
  // Give the child time to exist, then kill the runner container the hard way.
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  const before = await docker(['top', SHIM], { allowFailure: true });
  await docker(['kill', '-s', 'KILL', PEER], { allowFailure: true });
  await peer.catch(() => undefined);

  const exit = await waitForContainerExit(SHIM);
  record(
    'a runner that disappears leaves no agent behind',
    exit === 'exited:0',
    `run container ${exit}; it had ${before.stdout.split('\n').length - 1} processes before the kill; ` +
      `${await shimLogs()}`,
  );
};

const main = async () => {
  const version = await docker([
    'version',
    '-f',
    '{{.Server.Version}} (API {{.Server.APIVersion}})',
  ]);
  process.stdout.write(
    `docker server ${version.stdout}\nimages: shim=${SHIM_IMAGE}, driver=${IMAGE}, ${ALPINE}\n` +
      `fake cli: ${FAKE_CLI} (cwd ${CHILD_CWD})\n\n`,
  );
  await cleanup();
  await prepareVolume();
  await checkSubpath();
  await checkInternalNetwork();
  await checkHardenedQuery();
  await checkKillOnDisconnect();
  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  return failed.length === 0;
};

let ok = false;
try {
  ok = await main();
} finally {
  if (!process.argv.includes('--keep')) {
    // Never silenced: a cleanup whose failure you cannot see is how this session leaked 48
    // processes (standing rule 25).
    await cleanup();
  }
}
process.exit(ok ? 0 : 1);
