#!/usr/bin/env node
/**
 * `node scripts/deploy-key-check.mjs` — **WP-146's real-daemon leg** (TD-028 decision 13b), against a
 * Docker daemon, the real `platform-egress` sidecar and a launcher composed exactly as
 * `launcher-control-plane-check.mjs` composes one.
 *
 * ## What it runs
 *
 *  - a **local SSH git server standing in for `altssh.gitlab.com`** — `alpine` with `openssh-server`
 *    and `git`, `sshd -p 443`, one bare repository at `/acme/api.git`, the check's throwaway deploy
 *    key as the only `authorized_keys` line of user `git` (shell `git-shell`). Stated: its host key is
 *    its own, generated at start, and is pinned under the alias `gitlab.com` exactly as gitlab.com's
 *    documented keys are in production; and it is reached by its container name, so the run's egress
 *    list names `altssh-standin-…` where production names `altssh.gitlab.com`;
 *  - the launcher (`launcher-control-plane-launcher.mjs`) with the sidecar at `LogLevel Connect`, so
 *    every `CONNECT` the run makes is in the sidecar's log;
 *  - the runner (`launcher-control-plane-runner.mjs`, phase `deploy-key`): the production
 *    provisioner holding the key, a writing run whose repository URL is the ordinary
 *    `https://gitlab.com/acme/api.git`.
 *
 * ## What it asserts
 *
 *  1. the launcher's mirror helper fetched over SSH (the run's checkout exists at all — the
 *     repository is reachable by nothing else), the run container's `git push` of
 *     `agentic/wp146-check` landed on the stand-in, and `git ls-remote` read it back;
 *  2. the sidecar's log names **one** host and port for the run: `CONNECT altssh-standin-…:443` —
 *     no port 22, no `gitlab.com` (the `insteadOf` pair took every git URL to SSH);
 *  3. the **canaries**: a fragment of the private key is in no file of the run container (but `/repo`,
 *     the check's own read-only source mount, which a production run container does not have) and no
 *     `/proc/<pid>/environ` — searched as the agent (uid 1000) *and* as root by the host (`docker exec -u
 *     0`) while the run is live — not in the container's configured environment, not in the
 *     launcher's log, the runner's output, the sidecar's log or the stand-in's;
 *  4. nothing is left: every container, network and volume this check made is removed by the check.
 *
 * Not a `verify` target, for the reason none of the Docker checks are: it needs a daemon. With no
 * daemon or no image it exits non-zero naming what is missing.
 *
 *     DOCKER_HOST=unix:///var/run/docker.sock node scripts/deploy-key-check.mjs
 *     DOCKER_HOST=unix:///var/run/docker.sock node scripts/deploy-key-check.mjs --plant   # must FAIL
 *
 * `--plant` is the canary of the canaries: the run writes the key fragment to its own `/tmp`, and the
 * two searches must then report it (the check FAILs on exactly those two lines).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { hostsSeenBySidecar } from './real-model-preflight.mjs';
import './ts-source-resolver.mjs';

const execute = promisify(execFile);
const {
  startDockerFixture,
  RUNTIME_IMAGE,
  EGRESS_IMAGE,
  GIT_IMAGE,
  ALPINE_IMAGE,
  REPO_ROOT,
  docker,
} = await import(new URL('../test/e2e/support/docker-workspace.ts', import.meta.url).href);

const RUN_ID = '9f3a1c2e-0000-4000-8000-00000000146a';
const IDLE_RUN_ID = '9f3a1c2e-0000-4000-8000-00000000146b';
const TOKEN = 'FAKE-wp146-launcher-token-0000000000';
const PORT = '7780';
const LAUNCHER_NAME = 'agentic-wp146-launcher';
const RUNNER_NAME = 'agentic-wp146-runner';
const FRAGMENT_LENGTH = 24;
const DOCKER_HOST = process.env['DOCKER_HOST'];
if (DOCKER_HOST === undefined || !DOCKER_HOST.startsWith('unix://')) {
  process.stderr.write('FAIL: deploy-key-check — set DOCKER_HOST=unix:///var/run/docker.sock\n');
  process.exit(1);
}
const INNER_SOCKET = DOCKER_HOST.slice('unix://'.length);

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  process.stdout.write(
    `${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}\n`,
  );
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  const { stdout } = await docker(['version', '--format', '{{.Server.Version}}']);
  process.stdout.write(`docker daemon ${stdout.trim()}\n`);
} catch (error) {
  process.stderr.write(`FAIL: deploy-key-check — no Docker daemon: ${String(error)}\n`);
  process.exit(1);
}

const scratch = await mkdtemp(path.join(tmpdir(), 'wp146-'));
const keyFile = path.join(scratch, 'k');
await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'wp146-check', '-f', keyFile]);
const privateKey = await readFile(keyFile, 'utf8');
const publicKey = (await readFile(`${keyFile}.pub`, 'utf8'))
  .trim()
  .split(' ')
  .slice(0, 2)
  .join(' ');
await rm(scratch, { recursive: true, force: true });
/** The same fragment the runner searches for: 24 characters of the base64 that carries the seed. */
const fragment = (privateKey.trim().split('\n')[4] ?? '').slice(4, 4 + FRAGMENT_LENGTH);
const carries = (text) =>
  typeof text === 'string' && fragment.length > 0 && text.includes(fragment);

let fixture = null;
let standin = null;
try {
  fixture = await startDockerFixture();
  standin = `altssh-standin-${fixture.network.slice(-8)}`;

  // ── the stand-in ──────────────────────────────────────────────────────────
  const serverScript = [
    'set -e',
    'apk add --no-cache git openssh-server >/dev/null 2>&1',
    'adduser -D -h /home/git -s /usr/bin/git-shell git',
    // `adduser -D` locks the account (`!`), and sshd refuses a locked account's key login.
    "sed -i 's/^git:!/git:*/' /etc/shadow",
    'mkdir -p /home/git/.ssh',
    'printf "%s\\n" "$DEPLOY_PUB" > /home/git/.ssh/authorized_keys',
    'chown -R git:git /home/git/.ssh && chmod 700 /home/git/.ssh && chmod 600 /home/git/.ssh/authorized_keys',
    'mkdir -p /acme && git init --bare -q --initial-branch=main /acme/api.git',
    'mkdir -p /seed && cd /seed && git init -q --initial-branch=main',
    'git config user.email standin@example.invalid && git config user.name standin',
    'printf "# deploy-key stand-in\\n" > README.md && git add -A && git commit -q -m seed',
    'git push -q /acme/api.git main && chown -R git:git /acme',
    'ssh-keygen -A >/dev/null',
    'echo STANDIN-READY',
    'exec /usr/sbin/sshd -D -e -p 443',
  ].join('\n');
  await docker([
    'run',
    '-d',
    '--name',
    standin,
    '--label',
    'agentic.check=wp146',
    '--network',
    fixture.network,
    '-e',
    `DEPLOY_PUB=${publicKey}`,
    ALPINE_IMAGE,
    'sh',
    '-c',
    serverScript,
  ]);
  let hostKey = null;
  for (let attempt = 0; attempt < 180 && hostKey === null; attempt += 1) {
    const logs = await docker(['logs', standin], { allowFailure: true });
    if (`${logs.stdout}\n${logs.stderr}`.includes('Server listening')) {
      const key = await docker(['exec', standin, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub'], {
        allowFailure: true,
      });
      hostKey = key.ok ? key.stdout.trim().split(' ').slice(0, 2).join(' ') : null;
    } else {
      await sleep(500);
    }
  }
  record('the SSH stand-in listens on 443 with an Ed25519 host key', hostKey !== null, standin);
  if (hostKey === null) throw new Error('the stand-in never started');

  // ── the launcher ──────────────────────────────────────────────────────────
  await docker([
    'run',
    '-d',
    '--name',
    LAUNCHER_NAME,
    '--user',
    '0:0',
    '--network',
    fixture.network,
    ...Object.entries({
      DOCKER_HOST: 'unix:///var/run/docker.sock',
      CHECK_CONTROL_VOLUME: fixture.controlVolume,
      CHECK_CACHE_VOLUME: fixture.cacheVolume,
      CHECK_RUNTIME_IMAGE: RUNTIME_IMAGE,
      CHECK_EGRESS_IMAGE: EGRESS_IMAGE,
      CHECK_GIT_IMAGE: GIT_IMAGE,
      CHECK_REPO_ROOT: REPO_ROOT,
      CHECK_NETWORK: fixture.network,
      CHECK_LAUNCHER_TOKEN: TOKEN,
      CHECK_LAUNCHER_PORT: PORT,
      CHECK_EGRESS_LOG_ALLOWED_CONNECTS: '1',
      HOME: '/tmp',
    }).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
    '-v',
    `${INNER_SOCKET}:/var/run/docker.sock`,
    '-v',
    `${REPO_ROOT}:${REPO_ROOT}:ro`,
    '-v',
    `${fixture.controlVolume}:/run/agentic/ctl`,
    '-w',
    REPO_ROOT,
    '--entrypoint',
    'node',
    RUNTIME_IMAGE,
    `${REPO_ROOT}/scripts/launcher-control-plane-launcher.mjs`,
  ]);
  let listening = false;
  for (let attempt = 0; attempt < 60 && !listening; attempt += 1) {
    const logs = await docker(['logs', LAUNCHER_NAME], { allowFailure: true });
    listening = logs.stdout.includes('"listening"');
    if (!listening) await sleep(500);
  }
  record('the launcher listens', listening);
  if (!listening) throw new Error('the launcher never listened');

  // ── the runner ────────────────────────────────────────────────────────────
  // Passed **by name** below: the daemon copies the value out of this process' environment, so the
  // key is on no command line. Removed from it as soon as the runner exists.
  process.env['CHECK_DEPLOY_PRIVATE_KEY'] = privateKey;
  await docker([
    'run',
    '-d',
    '--name',
    RUNNER_NAME,
    '--user',
    '0:0',
    '--network',
    fixture.network,
    ...Object.entries({
      CHECK_PHASE: 'deploy-key',
      CHECK_RUN_ID: RUN_ID,
      CHECK_IDEMPOTENCY_RUN_ID: IDLE_RUN_ID,
      CHECK_DEPLOY_KEY_RUN_ID: RUN_ID,
      CHECK_LAUNCHER_URL: `http://${LAUNCHER_NAME}:${PORT}`,
      CHECK_LAUNCHER_TOKEN: TOKEN,
      CHECK_REPO_URL: 'https://gitlab.com/acme/api.git',
      CHECK_REPO_HOST: 'gitlab.com',
      CHECK_DEPLOY_PUBLIC_KEY: publicKey,
      CHECK_SSH_HOST: standin,
      CHECK_SSH_HOST_KEY: hostKey,
      CHECK_DEPLOY_KEY_FRAGMENT_LENGTH: String(FRAGMENT_LENGTH),
      // `--plant`: the run writes the fragment to its /tmp, and both searches must then fail — the
      // canary of the canary (standing rule 29: the counter must be seen to move).
      CHECK_PLANT_FRAGMENT: process.argv.includes('--plant') ? '1' : '0',
      HOME: '/tmp',
    }).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
    '-e',
    'CHECK_DEPLOY_PRIVATE_KEY',
    '-v',
    `${REPO_ROOT}:${REPO_ROOT}:ro`,
    '-w',
    REPO_ROOT,
    '-v',
    `${fixture.controlVolume}:/run/agentic/ctl`,
    '--entrypoint',
    'node',
    RUNTIME_IMAGE,
    `${REPO_ROOT}/scripts/launcher-control-plane-runner.mjs`,
  ]);
  delete process.env['CHECK_DEPLOY_PRIVATE_KEY'];
  const sidecar = `egress-${RUN_ID}`;
  let following = null;
  for (let attempt = 0; attempt < 240 && following === null; attempt += 1) {
    if ((await docker(['container', 'inspect', sidecar], { allowFailure: true })).ok) {
      following = docker(['logs', '-f', sidecar], { allowFailure: true });
    } else {
      await sleep(500);
    }
  }
  // The live run, as root, from the host: every file, every environ, the configured environment.
  let rootSearch = null;
  let configuredEnv = null;
  for (let attempt = 0; attempt < 1200 && rootSearch === null; attempt += 1) {
    const logs = await docker(['logs', RUNNER_NAME], { allowFailure: true });
    if (logs.stdout.includes('"inspect":"now"')) {
      const searched = await docker(
        [
          'exec',
          '-u',
          '0',
          `ws-${RUN_ID}`,
          'sh',
          '-c',
          [
            // Every top-level directory but the kernel's and the check's source mount, each walked on its
            // own: `grep -r /` with `--exclude-dir=proc` still walked into `/proc` (measured, it read
            // `/proc/<pid>/task/<pid>/pagemap` for ten minutes).
            'FILES=$(for d in /*; do case "$d" in /proc|/sys|/dev|/repo) ;; *) grep -rlsF -- "$1" "$d" 2>/dev/null ;; esac; done | wc -l)',
            'ENVIRON=0',
            'for f in /proc/[0-9]*/environ; do if tr "\\0" "\\n" < "$f" 2>/dev/null | grep -qF -- "$1"; then ENVIRON=$((ENVIRON+1)); fi; done',
            'PROCS=$(ls -d /proc/[0-9]* | wc -l)',
            'echo "FILES=$FILES ENVIRON=$ENVIRON PROCS=$PROCS"',
          ].join('\n'),
          'sh',
          fragment,
        ],
        { allowFailure: true },
      );
      rootSearch = searched.stdout;
      const inspected = await docker(
        ['container', 'inspect', '-f', '{{json .Config.Env}}', `ws-${RUN_ID}`],
        { allowFailure: true },
      );
      configuredEnv = inspected.stdout;
      await docker(['exec', `ws-${RUN_ID}`, 'touch', '/tmp/wp146-continue'], {
        allowFailure: true,
      });
    } else if (
      (
        await docker(['container', 'inspect', '-f', '{{.State.Running}}', RUNNER_NAME], {
          allowFailure: true,
        })
      ).stdout.trim() !== 'true'
    ) {
      break;
    } else {
      await sleep(500);
    }
  }
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    const state = await docker(['container', 'inspect', '-f', '{{.State.Running}}', RUNNER_NAME], {
      allowFailure: true,
    });
    if (state.stdout.trim() !== 'true') break;
    await sleep(500);
  }
  const runnerLog = await docker(['logs', RUNNER_NAME], { allowFailure: true });
  const lines = runnerLog.stdout.split('\n').filter((line) => line.trim().startsWith('{'));
  let told = null;
  try {
    told = JSON.parse(lines.at(-1) ?? 'null');
  } catch {
    told = null;
  }
  const sidecarLogged = following === null ? null : await following;
  const sidecarText =
    sidecarLogged === null ? '' : `${sidecarLogged.stdout}\n${sidecarLogged.stderr}`;
  const seen = hostsSeenBySidecar(sidecarText.split('\n'));
  const connects = [
    ...new Set(
      sidecarText
        .split('\n')
        .map((line) => /Request \(file descriptor \d+\): CONNECT (\S+)/.exec(line)?.[1])
        .filter((target) => target !== undefined),
    ),
  ];
  const standinRepo = await docker(
    [
      'exec',
      '-u',
      'git',
      standin,
      'git',
      '-C',
      '/acme/api.git',
      'rev-parse',
      'refs/heads/agentic/wp146-check',
    ],
    { allowFailure: true },
  );
  const launcherLog = await docker(['logs', LAUNCHER_NAME], { allowFailure: true });
  const standinLog = await docker(['logs', standin], { allowFailure: true });

  record(
    'the run was provisioned through the mirror over SSH, and its egress list adds the SSH host on 443 only',
    told !== null &&
      told.error === undefined &&
      (told.egressHosts ?? []).includes(standin) &&
      JSON.stringify(told.connectPorts) === '[443]',
    JSON.stringify({ error: told?.error, egress: told?.egressHosts, ports: told?.connectPorts }),
  );
  record(
    'the CLI’s git goes over SSH: GIT_SSH_COMMAND with the agent socket and the CONNECT helper, and one insteadOf pair',
    typeof told?.gitSshCommand === 'string' &&
      told.gitSshCommand.includes('IdentityAgent=/ctl/ssh-agent.sock') &&
      told.gitSshCommand.includes('HostKeyAlias=gitlab.com') &&
      told.gitSshCommand.includes('connect --proxy') &&
      JSON.stringify(told.gitConfigKeys) ===
        JSON.stringify([`url.ssh://git@${standin}:443/.insteadOf`, 'core.fsmonitor']),
    JSON.stringify({ keys: told?.gitConfigKeys }),
  );
  record(
    'the run container pushed agentic/wp146-check to the stand-in and read it back',
    told?.pushExit === 0 &&
      typeof told.pushedHead === 'string' &&
      told.pushedHead === told.fetchedHead &&
      standinRepo.ok &&
      standinRepo.stdout.trim() === told.pushedHead,
    JSON.stringify({
      exit: told?.pushExit,
      pushed: told?.pushedHead,
      fetched: told?.fetchedHead,
      standin: standinRepo.stdout.trim(),
      output: told?.pushOutput,
    }),
  );
  record(
    'the sidecar logged CONNECT to the stand-in on 443 and nothing else — no port 22, no gitlab.com',
    connects.length === 1 && connects[0] === `${standin}:443` && seen.refused.length === 0,
    JSON.stringify({ connects, seen }),
  );
  record(
    'the run container lists the agent socket and the platform-written known_hosts',
    typeof told?.agentSocket === 'string' &&
      told.agentSocket.startsWith('s') &&
      told.knownHostsLines === 1,
    JSON.stringify({ socket: told?.agentSocket, knownHosts: told?.knownHostsLines }),
  );
  const asAgent = told?.keyFilesInContainer === 0 && told?.keyEnvironsInContainer === 0;
  record(
    'canary, as the agent: the key is in no file and no environ it can read',
    asAgent && (told?.environsReadable ?? 0) > 0,
    JSON.stringify({
      files: told?.keyFilesInContainer,
      environs: told?.keyEnvironsInContainer,
      readable: told?.environsReadable,
    }),
  );
  const rootCounts = /FILES=(\d+) ENVIRON=(\d+) PROCS=(\d+)/.exec(rootSearch ?? '');
  record(
    'canary, as root from the host: the key is in no file and no /proc/*/environ of the live run container',
    rootCounts !== null &&
      rootCounts[1] === '0' &&
      rootCounts[2] === '0' &&
      Number(rootCounts[3]) > 0,
    rootSearch ?? 'the run container was never searched',
  );
  record(
    'canary: the key is in neither the container’s configured environment nor any log',
    configuredEnv !== null &&
      configuredEnv.length > 0 &&
      !carries(configuredEnv) &&
      !carries(`${launcherLog.stdout}${launcherLog.stderr}`) &&
      !carries(`${runnerLog.stdout}${runnerLog.stderr}`) &&
      !carries(sidecarText) &&
      !carries(`${standinLog.stdout}${standinLog.stderr}`),
    `searched ${[configuredEnv, launcherLog.stdout, runnerLog.stdout, sidecarText].map((text) => (text ?? '').length).join('/')} bytes`,
  );
  if (told?.ok !== true) {
    process.stderr.write(
      `--- runner ---\n${runnerLog.stdout.slice(-4000)}\n${runnerLog.stderr.slice(-4000)}\n--- launcher ---\n${launcherLog.stdout.slice(-4000)}\n--- stand-in ---\n${standinLog.stderr.slice(-2000)}\n`,
    );
  }
} catch (error) {
  record('the check ran to completion', false, String(error?.stack ?? error));
} finally {
  await docker(['rm', '-f', RUNNER_NAME, LAUNCHER_NAME, ...(standin === null ? [] : [standin])], {
    allowFailure: true,
  });
  await fixture?.cleanup();
  await docker(['volume', 'rm', '-f', `ws-${RUN_ID}`], { allowFailure: true });
}
const left = await docker(['ps', '-a', '--filter', `name=${RUN_ID}`, '--format', '{{.Names}}'], {
  allowFailure: true,
});
record('nothing of the run is left on the daemon', left.stdout.trim() === '', left.stdout.trim());

const failed = results.filter((result) => !result.ok);
process.stdout.write(
  `\n${failed.length === 0 ? 'PASS' : 'FAIL'}: deploy-key-check (${results.length - failed.length}/${results.length} checks)\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
