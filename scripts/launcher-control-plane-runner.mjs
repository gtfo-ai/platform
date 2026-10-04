#!/usr/bin/env node
/**
 * The **runner half** of `launcher-control-plane-check.mjs`, inside its own container.
 *
 * This is the process `compose.yml`'s `runner` service is: it holds **no Docker client**, it talks
 * to the launcher over TD-028's authenticated HTTP control plane, and it opens the run's Unix
 * socket itself off the `ctl` volume it has mounted (TD-025 §2, the data plane, unchanged).
 * Everything below `createLauncherRunWorkspaceProvisioner` is production code — the real
 * `createWorkspaceClaudeRunner`, the real `createClaudeRunner`, the real Agent SDK `query()`, the
 * real `createRunletSpawn` — and the only thing that is not the model is the CLI executable.
 *
 * It prints one JSON line and exits; `launcher-control-plane-check.mjs` reads it. With
 * `CHECK_PHASE` set (WP-82) it runs one half of backlog 136's measurement instead — see
 * {@link PHASE}.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import process from 'node:process';
import './ts-source-resolver.mjs';

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`${name} is required\n`);
    process.exit(2);
  }
  return value;
};

const RUN_ID = required('CHECK_RUN_ID');
const IDEMPOTENCY_RUN_ID = required('CHECK_IDEMPOTENCY_RUN_ID');
const CONTROL_ROOT = '/run/agentic/ctl';
/** The fake CLI, inside the run container, under the read-only checkout mount. */
const FAKE_CLI = '/repo/test/fixtures/runlet/fake-claude-cli';
/**
 * The model credential a production spec carries, **obviously fake and shaped past Anthropic's key
 * pattern** (standing rule 93: no `sk-ant-` prefix). The real-CLI leg's run allows no model host,
 * so nothing it sends leaves the sidecar either.
 */
const FAKE_MODEL_KEY = 'FAKE-wp118-model-key-not-a-credential';
/** The run's git credential in the `git-credential` phase — obviously fake, shaped past any real one. */
const FAKE_GIT_TOKEN = 'FAKE-wp118-git-token-not-a-credential';
/**
 * BD-004 `local` mode's credential for the WP-133 leg — **obviously fake** and shaped past the
 * subscription token's own prefix (standing rule 93). The leg allows the production model host, so
 * this value does reach `api.anthropic.com`, which refuses it: that refusal is the evidence the CLI
 * got there. It must appear in nothing this script prints, which the check asserts.
 */
const FAKE_OAUTH_TOKEN = 'FAKE-wp133-oauth-token-not-a-credential';

const { noSecretsRedactor, runOrphanWorkspaceReap } = await import(
  new URL('../packages/application/src/index.ts', import.meta.url).href
);
const { launcher: launcherAdapters, runner: runnerAdapters } = await import(
  new URL('../packages/infrastructure/src/index.ts', import.meta.url).href
);

const notes = [];
/**
 * What the CLI wrote on stderr, as the runner logs it — already redacted there. Recorded for the
 * real-CLI legs. At WP-118 it was **empty**: the launcher provisioner's transport passed no
 * `onStderr`, so a containerised CLI's stderr reached nothing (PROGRESS backlog 344). Since WP-127
 * the runner sets its own sink on the spawn: a run that ends before its first stream message logs
 * what the CLI wrote as one `warn` line, any other run at `debug` (`runner/stderr-log.ts`).
 */
const cliStderr = [];
const STDERR_BEFORE_STREAM =
  'the CLI wrote on stderr and the run ended before its first stream message';
const logger = {
  debug: (fields, message) => {
    if (message === 'claude code stderr' && typeof fields?.stderr === 'string') {
      cliStderr.push(fields.stderr);
    }
  },
  info: () => undefined,
  warn: (fields, message) => {
    if (message === STDERR_BEFORE_STREAM && typeof fields?.stderr === 'string') {
      cliStderr.push(fields.stderr);
    }
    notes.push(`warn: ${message} ${JSON.stringify(fields)}`);
  },
  error: (fields, message) => notes.push(`error: ${message} ${JSON.stringify(fields)}`),
};

const baseUrl = required('CHECK_LAUNCHER_URL');
const token = required('CHECK_LAUNCHER_TOKEN');
/**
 * `CHECK_CLIENT_TIMEOUT_MS` (WP-103, backlog 286 (b)): the client's outer bound, shortened so a
 * create outlives it with the launcher alive — the shape a first mirror fetch of a large repository
 * takes against the production default of ten minutes. Absent is the production default.
 */
const clientTimeoutMs =
  process.env['CHECK_CLIENT_TIMEOUT_MS'] === undefined
    ? undefined
    : Number(process.env['CHECK_CLIENT_TIMEOUT_MS']);
const real = launcherAdapters.createLauncherControlClient({
  baseUrl,
  token,
  logger,
  ...(clientTimeoutMs === undefined ? {} : { timeoutMs: clientTimeoutMs }),
});

/** Every create response, so the check can read what actually crossed the control plane. */
const creates = [];
const client = {
  ...real,
  createRun: async (payload) => {
    const response = await real.createRun(payload);
    creates.push({ spec: payload.spec, response });
    return response;
  },
};

const projectSource = {
  forRun: async () => ({
    repoUrl: required('CHECK_REPO_URL'),
    defaultBranch: 'main',
    projectPath: 'acme/api',
    gitHost: required('CHECK_REPO_HOST'),
    branchPatterns: ['agentic/*'],
    containerEnv: {},
  }),
};

/**
 * The check's run is read-only against an anonymous `git://` fixture, so it asks for a `read`
 * credential and is told there is none — the path a public repository takes (TD-028's WP-76
 * amendment, decision 6): the create carries `credential: null` and the mirror fetch is anonymous.
 * A minted credential against a credentialled server is `docker-workspace.e2e.test.ts`'s (WP-76).
 */
const credentials = {
  mint: async () => ({
    kind: 'unavailable',
    reason: 'this check runs a read-only spec against an anonymous git:// fixture',
  }),
};

const provisioner = launcherAdapters.createLauncherRunWorkspaceProvisioner({
  client,
  credentials,
  projects: projectSource,
  controlRoot: CONTROL_ROOT,
  // No model host: the CLI is a local executable in the run container, so the allow-list is exactly
  // the git host the fixture serves from.
  modelEgressHosts: [],
  runRegistryHosts: [],
  credentialTtlSeconds: 3_600,
  clock: runnerAdapters.systemClock,
  logger,
});

/**
 * The run spec, and two of its fields are the point.
 *
 * `providerMode: 'api'` with `claudeCodePath: null` is **PROGRESS backlog 34's case**: before WP-53
 * `pathToClaudeCodeExecutable` was honoured only in `local` mode, so a containerised `api` run
 * execed the SDK's own bundled binary — a path on the *platform's* filesystem that the shim then
 * `exec`s inside the container.
 *
 * `checkoutRef` is **backlog 71's**: the planner has filled that field since WP-34 and it reached
 * nothing. The fixture repository has only `main`, so this also exercises the *"the branch is not
 * on the remote"* half — `#clone` falls back to `git checkout -b`.
 */
const specFor = (runId) =>
  runnerAdapters.runSpecFixture({
    runId,
    tools: ['Read', 'Grep', 'Glob'],
    artifactType: null,
    providerMode: 'api',
    claudeCodePath: null,
    checkoutRef: 'agentic/wp53-check',
    // WP-118: the environment **production** gives a run — `agentRunEnvironment`, the model
    // credential and nothing else. Until WP-118 this spec carried `PATH` and `HOME` of its own, which
    // no production spec does, and that is what let the fake CLI start while the container's
    // variables stopped at the shim (PROGRESS backlog 342).
    env: { ANTHROPIC_API_KEY: FAKE_MODEL_KEY },
    secretEnvNames: ['ANTHROPIC_API_KEY'],
  });

/**
 * The fake CLI's environment report — the second text block of its `assistant` message
 * (`fake-claude-cli environ source=… names=… git=…`), read out of the transcript. Names only.
 */
const environReport = (transcriptText) => {
  const match = /fake-claude-cli environ source=(\S+) names=([\w,]*) git=([\w.=?|-]*)/.exec(
    transcriptText,
  );
  if (match === null) {
    return null;
  }
  const git = Object.fromEntries(
    (match[3] ?? '')
      .split('|')
      .filter((pair) => pair.includes('='))
      .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
  );
  return { source: match[1], names: (match[2] ?? '').split(',').filter(Boolean), git };
};

/**
 * Which of the SDK's per-platform `claude` packages this process could resolve — PROGRESS backlog
 * **34**'s residual, WP-82. The SDK resolves its **own** binary only when
 * `pathToClaudeCodeExecutable` is unset, and a containerised run always sets it (the launcher's
 * answer), so a runner with **no** package for its own platform that still completes a run is the
 * measurement `docker/app.Dockerfile` needed before it dropped the package (207 MiB). Read off the
 * pnpm store directory beside this tree, so it answers for whichever tree this script runs from —
 * the checkout mount or, under `--runner-image`, the product image's own `/app`.
 */
const sdkPlatformPackages = () => {
  try {
    return readdirSync(new URL('../node_modules/.pnpm/', import.meta.url)).filter((entry) =>
      entry.startsWith('@anthropic-ai+claude-agent-sdk-'),
    );
  } catch (error) {
    return [`unreadable: ${error?.code ?? String(error)}`];
  }
};

/**
 * PROGRESS backlog **136**, WP-82: the two halves of *a create replayed across a launcher restart*.
 *
 * `launcher-control-plane-check.mjs` runs this script twice with `CHECK_PHASE` set, and restarts the
 * launcher container in between: `replay-create` provisions a run and leaves it running (it never
 * releases it, which is what a runner whose response was lost looks like), `replay-retry` asks the
 * **restarted** launcher — which has forgotten the handle — to create the same run id again. Each
 * phase prints what the runner saw and a digest of `/ctl/<run-id>/token` (never the token), so the
 * host can say whether the retry rewrote the live run's shim token.
 */
const tokenDigest = (runId) => {
  try {
    return createHash('sha256')
      .update(readFileSync(`${CONTROL_ROOT}/${runId}/token`))
      .digest('hex')
      .slice(0, 16);
  } catch (error) {
    return `absent: ${error?.code ?? String(error)}`;
  }
};

const PHASE = process.env['CHECK_PHASE'] ?? 'main';
if (PHASE === 'replay-create' || PHASE === 'replay-retry') {
  const runId = required('CHECK_REPLAY_RUN_ID');
  const phase = { phase: PHASE, ok: false, tokenBefore: tokenDigest(runId), notes };
  try {
    await provisioner.provision(specFor(runId));
    const created = creates.filter((entry) => entry.spec.runId === runId).at(-1);
    phase.ok = true;
    phase.replayed = created?.response.replayed ?? null;
    phase.containerId = created?.response.handle.containerId ?? null;
    phase.networkId = created?.response.handle.networkId ?? null;
  } catch (error) {
    phase.errorCode = error?.code ?? null;
    phase.errorMessage = String(error?.message ?? error).slice(0, 600);
    // WP-103: what `fetch failed` was underneath — a reset, a closed socket — for 286 (a).
    const inner = error?.cause?.cause;
    phase.errorCause = inner === undefined ? null : `${inner?.code ?? ''} ${inner?.message ?? ''}`;
  }
  phase.tokenAfter = tokenDigest(runId);
  process.stdout.write(`${JSON.stringify(phase)}\n`);
  process.exit(0);
}

/**
 * WP-103, backlog 286 (b): the stage executor's three start attempts against a create that outlives
 * the client's timeout. Each attempt is a **new run id** — `recordUnstarted` fails the run row and
 * the stage is re-enqueued, so the next attempt inserts a new `runs` row (`stage-executor.ts`,
 * `MAX_RUN_START_ATTEMPTS`) — which is what this reproduces: one provision per id, in order, each
 * with the shortened client. What each attempt was told is printed; what the daemon holds afterwards
 * is the host's question.
 */
if (PHASE === 'timeout-attempts') {
  const runIds = required('CHECK_ATTEMPT_RUN_IDS').split(',');
  const attempts = [];
  for (const runId of runIds) {
    const started = Date.now();
    const attempt = { runId, ok: false };
    try {
      const workspace = await provisioner.provision(specFor(runId));
      attempt.ok = true;
      // Released, so a create that beat the timeout is not counted as an orphan it is not.
      await workspace.release({ kind: 'not_started' });
    } catch (error) {
      attempt.errorCode = error?.code ?? null;
      attempt.errorMessage = String(error?.message ?? error).slice(0, 300);
    }
    attempt.ms = Date.now() - started;
    attempts.push(attempt);
  }
  process.stdout.write(`${JSON.stringify({ phase: PHASE, attempts, notes })}\n`);
  process.exit(0);
}

/**
 * WP-103 (TD-028 decision 12): **the production pass**, `runOrphanWorkspaceReap`, against this
 * launcher — its real read verb and its real destroy — with the one piece a check has no database
 * for, the `runs` rows, given as `CHECK_REAP_STATES` (`<run-id>=<status>` pairs; a terminal one
 * ended an hour ago, an id not named has no row). `CHECK_REAP_UNKNOWN_GRACE_MS` shortens the
 * unknown-run grace so the check need not wait an hour.
 */
if (PHASE === 'reap') {
  const now = Date.now();
  const states = (process.env['CHECK_REAP_STATES'] ?? '')
    .split(',')
    .filter((pair) => pair.includes('='))
    .map((pair) => {
      const [runId, status] = pair.split('=');
      return { runId, status, endedAt: new Date(now - 3_600_000).toISOString() };
    });
  const destroyed = [];
  const listedBefore = (await real.listRuns()).runs.map((run) => run.runId);
  const report = await runOrphanWorkspaceReap({
    inventory: {
      list: async () => (await real.listRuns()).runs,
      destroy: async (runId) => {
        const answer = await real.destroyRun(runId);
        destroyed.push({ runId, found: answer.found });
        return answer;
      },
    },
    store: {
      runStates: async (_tx, runIds) =>
        states
          .filter((row) => runIds.includes(row.runId))
          .map((row) => ({
            ...row,
            endedAt: ['created', 'starting', 'running'].includes(row.status) ? null : row.endedAt,
          })),
    },
    unitOfWork: { transaction: async (fn) => fn({ tx: null }) },
    clock: { now: () => now },
    graceMs: 60_000,
    unknownGraceMs: Number(process.env['CHECK_REAP_UNKNOWN_GRACE_MS'] ?? 3_600_000),
    logger,
  });
  const listedAfter = (await real.listRuns()).runs.map((run) => run.runId);
  process.stdout.write(
    `${JSON.stringify({ phase: PHASE, listedBefore, destroyed, report, listedAfter, notes })}\n`,
  );
  process.exit(0);
}

/**
 * WP-146 (TD-028 decision 13b): **a deploy-key run fetches and pushes over SSH** through the
 * production provisioner and launcher, with a key the runner holds and the run container never does.
 * `scripts/deploy-key-check.mjs` runs this phase against a local SSH git server standing in for
 * `altssh.gitlab.com` (`CHECK_SSH_HOST`, port 443, its own host key pinned under the alias
 * `gitlab.com` — stated: not gitlab.com's key). The minter is the one piece this check has no
 * provider for: it answers a `deploy_key` credential with the key from `CHECK_DEPLOY_PRIVATE_KEY`
 * (passed by name, a throwaway key the check generated). Then, through the run's own spawn and with
 * exactly the CLI's environment, the run container commits, `git push`es `agentic/wp146-check` to
 * the repository's ordinary `https://gitlab.com/…` URL (rewritten to SSH by the one `insteadOf`
 * pair) and lists the remote; and, as the agent, searches its own filesystem and every
 * `/proc/<pid>/environ` it can read for a fragment of the private key, passed as an **argument** so
 * the search pattern is in no environment. Nothing of the key is printed.
 */
if (PHASE === 'deploy-key') {
  const runId = required('CHECK_DEPLOY_KEY_RUN_ID');
  const privateKey = required('CHECK_DEPLOY_PRIVATE_KEY');
  const publicKey = required('CHECK_DEPLOY_PUBLIC_KEY');
  const sshHost = required('CHECK_SSH_HOST');
  const hostKey = required('CHECK_SSH_HOST_KEY');
  const fragment = required('CHECK_DEPLOY_KEY_FRAGMENT_LENGTH');
  const keyLines = privateKey.trim().split('\n');
  // A fragment of the **seed** — `openssh-key-v1` puts the 64-byte private field at bytes ~161–225,
  // which is the fourth base64 line of 70 (`keyLines[4]`, the armour being `keyLines[0]`); the lines
  // before it are the container's fixed header, the check integers and the public key.
  const probe = (keyLines[4] ?? '').slice(4, 4 + Number(fragment));
  let signed = 0;
  const minted = {
    username: 'git',
    password: privateKey,
    scope: 'push',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    source: 'deploy_key',
    ssh: {
      publicKey,
      route: {
        httpsPrefix: 'https://gitlab.com/',
        sshPrefix: `ssh://git@${sshHost}:443/`,
        connectHost: sshHost,
        connectPort: 443,
        hostKeyAlias: 'gitlab.com',
        knownHosts: [`gitlab.com ${hostKey}`],
      },
    },
    revoke: async () => undefined,
  };
  const deployKeyProvisioner = launcherAdapters.createLauncherRunWorkspaceProvisioner({
    client,
    credentials: { mint: async () => ({ kind: 'minted', credential: minted }) },
    projects: {
      forRun: async () => ({
        repoUrl: 'https://gitlab.com/acme/api.git',
        defaultBranch: 'main',
        projectPath: 'acme/api',
        gitHost: 'gitlab.com',
        branchPatterns: ['agentic/*'],
        containerEnv: {},
      }),
    },
    controlRoot: CONTROL_ROOT,
    modelEgressHosts: [],
    runRegistryHosts: [],
    credentialTtlSeconds: 3_600,
    clock: runnerAdapters.systemClock,
    logger,
  });
  const phase = { phase: PHASE, ok: false, notes };
  let workspace = null;
  let told = false;
  const inContainer = async (env, script, args = [], onOutput = () => undefined) => {
    const child = workspace.spawn({
      command: '/bin/sh',
      args: ['-c', script, 'sh', ...args],
      cwd: workspace.workdir,
      env,
      signal: new AbortController().signal,
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
      onOutput(out);
    });
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    child.stdin.end();
    return { code: await exited, out };
  };
  try {
    const spec = runnerAdapters.runSpecFixture({
      runId,
      tools: ['Read', 'Edit', 'Bash'],
      artifactType: null,
      providerMode: 'api',
      claudeCodePath: null,
      checkoutRef: 'agentic/wp146-check',
      env: { ANTHROPIC_API_KEY: FAKE_MODEL_KEY },
      secretEnvNames: ['ANTHROPIC_API_KEY'],
    });
    workspace = await deployKeyProvisioner.provision(spec);
    const created = creates.filter((entry) => entry.spec.runId === runId).at(-1);
    phase.egressHosts = created?.spec.egress.hosts ?? null;
    phase.connectPorts = created?.spec.egress.connectPorts ?? null;
    const env = runnerAdapters.cliEnvironment(spec, workspace.cliEnvironment ?? null);
    phase.gitSshCommand = env.GIT_SSH_COMMAND ?? null;
    phase.gitConfigKeys = Object.entries(env)
      .filter(([name]) => name.startsWith('GIT_CONFIG_KEY_'))
      .map(([, value]) => value);
    // **One** child: the shim owns exactly one per run and exits when it does (TD-025 §1). It pushes,
    // lists the remote, searches as the agent, prints a marker — on which this runner tells the host
    // to search as root — and waits, bounded, for the host's `touch` of a file in its own /tmp.
    const run = await inContainer(
      env,
      [
        'set -e',
        'git config user.email wp146@example.invalid',
        'git config user.name wp146-check',
        'echo wp146 > wp146.txt',
        'git add wp146.txt',
        'git commit -q -m "wp146 deploy-key check"',
        'git push -q origin HEAD:refs/heads/agentic/wp146-check 2>&1',
        'echo "FETCHED=$(git ls-remote origin refs/heads/agentic/wp146-check | cut -c1-40)"',
        'echo "HEAD=$(git rev-parse HEAD)"',
        'set +e',
        // `--plant` (the check's own canary): the fragment written where the search must find it.
        ...(process.env['CHECK_PLANT_FRAGMENT'] === '1' ? ['printf "%s" "$1" > /tmp/planted'] : []),
        // The canary, as the agent: files it can read (not /proc, /sys, /dev) and every environ it can.
        // Every top-level directory but the kernel's and the check's source mount, each walked on its
        // own: `grep -r /` with `--exclude-dir=proc` still walked into `/proc` (measured, it read
        // `/proc/<pid>/task/<pid>/pagemap` for ten minutes).
        'FILES=$(for d in /*; do case "$d" in /proc|/sys|/dev|/repo) ;; *) grep -rlsF -- "$1" "$d" 2>/dev/null ;; esac; done | wc -l)',
        'ENVIRON=0',
        'for f in /proc/[0-9]*/environ; do if tr "\\0" "\\n" < "$f" 2>/dev/null | grep -qF -- "$1"; then ENVIRON=$((ENVIRON+1)); fi; done',
        'READABLE=$(for f in /proc/[0-9]*/environ; do cat "$f" >/dev/null 2>&1 && echo x; done | wc -l)',
        'echo "FILES=$FILES ENVIRON=$ENVIRON READABLE=$READABLE"',
        'echo "AGENT=$(ls -l /ctl/ssh-agent.sock 2>/dev/null | cut -c1-10) KNOWN=$(wc -l < /ctl/known_hosts)"',
        'echo SEARCH-DONE',
        // `/repo` is the check's read-only source mount (the shim runs from source here), which no
        // production run container has; it is excluded from both searches, stated in the script.
        'i=0; while [ ! -e /tmp/wp146-continue ] && [ $i -lt 600 ]; do sleep 0.5; i=$((i+1)); done',
      ].join('\n'),
      [probe],
      (soFar) => {
        if (soFar.includes('SEARCH-DONE') && !told) {
          told = true;
          process.stdout.write('{"phase":"deploy-key","inspect":"now"}\n');
        }
      },
    );
    phase.pushExit = run.code;
    phase.pushedHead = /HEAD=([0-9a-f]{40})/.exec(run.out)?.[1] ?? null;
    phase.fetchedHead = /FETCHED=([0-9a-f]{40})/.exec(run.out)?.[1] ?? null;
    phase.pushOutput = run.out.slice(0, 600);
    const counts = /FILES=(\d+) ENVIRON=(\d+) READABLE=(\d+)/.exec(run.out);
    phase.keyFilesInContainer = counts === null ? null : Number(counts[1]);
    phase.keyEnvironsInContainer = counts === null ? null : Number(counts[2]);
    phase.environsReadable = counts === null ? null : Number(counts[3]);
    phase.agentSocket = /AGENT=(\S*)/.exec(run.out)?.[1] ?? null;
    phase.knownHostsLines = Number(/KNOWN=(\d+)/.exec(run.out)?.[1] ?? -1);
    signed = notes.filter((note) => note.includes('ssh')).length;
    phase.ok =
      run.code === 0 &&
      phase.pushedHead !== null &&
      phase.pushedHead === phase.fetchedHead &&
      phase.keyFilesInContainer === 0 &&
      phase.keyEnvironsInContainer === 0;
  } catch (error) {
    phase.error = String(error?.message ?? error).slice(0, 600);
  } finally {
    await workspace?.release({ kind: 'not_started' });
  }
  phase.sshNotes = signed;
  const printed = JSON.stringify(phase);
  // Never the key: the printed line is searched for the fragment before it leaves this process.
  process.stdout.write(
    `${printed.includes(probe) ? '{"phase":"deploy-key","ok":false,"error":"the report carried the key"}' : printed}\n`,
  );
  process.exit(0);
}

/**
 * WP-118 review round 1: **the CLI's git asks the shim for the run's credential**, end to end.
 *
 * A run minted a (fake) `read` credential — the one piece this check has no provider for — is
 * provisioned through the production provisioner and launcher. Then, through the run's own spawn
 * transport and with **exactly the environment the CLI gets** (`cliEnvironment` over the launcher's
 * answer), the run container execs `git credential fill` for the run's git host: git reads the
 * workspace's `credential.helper` from that environment, runs `agentic-runlet credential --socket
 * /ctl/cred.sock get`, the helper asks the shim's `cred.get`, the shim asks this runner, and the
 * answer comes back. Before review round 1 the helper looked for `RUNLET_CREDENTIAL_SOCKET`, which
 * the CLI's environment never carries, and answered nothing. The token is compared here and never
 * printed.
 */
if (PHASE === 'git-credential') {
  const runId = required('CHECK_GIT_CREDENTIAL_RUN_ID');
  const minted = {
    username: 'agentic-wp118',
    password: FAKE_GIT_TOKEN,
    scope: 'read',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    revoke: async () => undefined,
  };
  const minting = launcherAdapters.createLauncherRunWorkspaceProvisioner({
    client,
    credentials: { mint: async () => ({ kind: 'minted', credential: minted }) },
    projects: projectSource,
    controlRoot: CONTROL_ROOT,
    modelEgressHosts: [],
    runRegistryHosts: [],
    credentialTtlSeconds: 3_600,
    clock: runnerAdapters.systemClock,
    logger,
  });
  const phase = { phase: PHASE, ok: false, notes };
  let workspace = null;
  try {
    const spec = specFor(runId);
    workspace = await minting.provision(spec);
    const env = runnerAdapters.cliEnvironment(spec, workspace.cliEnvironment ?? null);
    phase.helper = env.GIT_CONFIG_VALUE_0 ?? null;
    const child = workspace.spawn({
      // The spawn frame takes an absolute command (TD-025 §1); the image's git.
      command: '/usr/bin/git',
      args: ['credential', 'fill'],
      cwd: workspace.workdir,
      env,
      signal: new AbortController().signal,
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      phase.error = String(error?.message ?? error);
    });
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    child.stdin.write(`protocol=https\nhost=${required('CHECK_REPO_HOST')}\n\n`);
    child.stdin.end();
    phase.exitCode = await exited;
    const fields = Object.fromEntries(
      out
        .split('\n')
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    phase.username = fields.username ?? null;
    phase.passwordMatches = fields.password === FAKE_GIT_TOKEN;
    phase.passwordLength = (fields.password ?? '').length;
    phase.ok = phase.exitCode === 0 && phase.passwordMatches;
  } catch (error) {
    phase.error = String(error?.message ?? error).slice(0, 600);
  } finally {
    await workspace?.release({ kind: 'not_started' });
  }
  process.stdout.write(`${JSON.stringify(phase)}\n`);
  process.exit(0);
}

/**
 * WP-118, PROGRESS backlog 342 (consequence (a)): the run image's **real** `claude`, started through
 * the production path — the launcher's own `claudeCodePath`, the real SDK, the real shim — with the
 * obviously fake model key. The run allows **no model host** (the git host alone keeps a sidecar in
 * front of it), so a CLI that uses the proxy is refused *by the sidecar*, which logs the host it was
 * asked for; the host follows that log (`launcher-control-plane-check.mjs`). No request can reach
 * Anthropic, with or without a credential. The wall clock bounds a CLI that retries.
 */
if (PHASE === 'real-cli') {
  const runId = required('CHECK_REAL_CLI_RUN_ID');
  /*
   * WP-133 (PROGRESS backlog 137, its `local`-mode half): `CHECK_REAL_CLI_MODE=local` runs the same
   * CLI the way `compose.local.yml` makes an instance run it — the spec's environment from the
   * server's own `agentRunEnvironment` (so `CLAUDE_CODE_OAUTH_TOKEN` and nothing else), `providerMode`
   * `local`, and the run's egress list from `CHECK_REAL_CLI_MODEL_HOSTS`, which the check fills from
   * `SERVER_CONFIG_DEFAULTS.modelEgressHosts` — the list a stock instance gives every run. So unlike
   * the `api` leg this one **reaches** the model host, and the sidecar's log holds every *other*
   * host the CLI asked for (an allowed `CONNECT` is below the sidecar's log level).
   */
  const local = process.env['CHECK_REAL_CLI_MODE'] === 'local';
  const modelHosts = (process.env['CHECK_REAL_CLI_MODEL_HOSTS'] ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  const { agentRunEnvironment } = local
    ? await import(new URL('../apps/server/src/agent.ts', import.meta.url).href)
    : { agentRunEnvironment: null };
  const runEnvironment = local
    ? agentRunEnvironment({
        providerMode: 'local',
        modelApiKey: null,
        modelOauthToken: FAKE_OAUTH_TOKEN,
      })
    : null;
  const runProvisioner = local
    ? launcherAdapters.createLauncherRunWorkspaceProvisioner({
        client,
        credentials,
        projects: projectSource,
        controlRoot: CONTROL_ROOT,
        modelEgressHosts: modelHosts,
        runRegistryHosts: [],
        credentialTtlSeconds: 3_600,
        clock: runnerAdapters.systemClock,
        logger,
      })
    : provisioner;
  const transcript = [];
  const phase = {
    phase: PHASE,
    mode: local ? 'local' : 'api',
    ok: false,
    claudeCodePath: null,
    status: null,
    // Names only: the keys of the run's environment and the names its redactor is told about.
    envNames: runEnvironment === null ? ['ANTHROPIC_API_KEY'] : Object.keys(runEnvironment.env),
    secretEnvNames: runEnvironment === null ? ['ANTHROPIC_API_KEY'] : runEnvironment.secretEnvNames,
    egressHosts: null,
    notes,
  };
  try {
    const runner = runnerAdapters.createWorkspaceClaudeRunner({
      provisioner: {
        provision: async (spec) => {
          const workspace = await runProvisioner.provision(spec);
          phase.egressHosts =
            creates.filter((entry) => entry.spec.runId === spec.runId).at(-1)?.spec.egress?.hosts ??
            null;
          phase.claudeCodePath = workspace.claudeCodePath ?? null;
          return workspace;
        },
      },
      logger,
      build: (transport) =>
        runnerAdapters.createClaudeRunner({
          sink: { append: async (event) => transcript.push(event) },
          approvals: {
            requestApproval: async () => ({
              decision: 'deny',
              reason: 'unattended',
              questionId: null,
            }),
          },
          tools: runnerAdapters.recordingTools(),
          clock: runnerAdapters.systemClock,
          logger,
          injectedSecretRedactorFor: () => noSecretsRedactor(),
          spawnClaudeCodeProcess: transport.spawn,
          ...(transport.cliEnvironment === undefined
            ? {}
            : { workspaceEnvironment: transport.cliEnvironment }),
        }),
    });
    const spec = runnerAdapters.runSpecFixture({
      ...specFor(runId),
      // A file tool, so the run has a checkout — and therefore the git host on its allow-list and a
      // sidecar in front of it. A spec with no file tool and no shell gets neither (WP-74), and its
      // CLI has no proxy to find whatever the environment says.
      tools: ['Read'],
      ...(runEnvironment === null
        ? {}
        : {
            providerMode: 'local',
            env: runEnvironment.env,
            secretEnvNames: runEnvironment.secretEnvNames,
          }),
      limits: {
        ...runnerAdapters.runSpecFixture().limits,
        wallClockMs: Number(process.env['CHECK_REAL_CLI_WALL_CLOCK_MS'] ?? 90_000),
        stallTimeoutMs: Number(process.env['CHECK_REAL_CLI_WALL_CLOCK_MS'] ?? 90_000),
      },
    });
    const outcome = await runner.start(spec).outcome;
    phase.ok = true;
    phase.status = outcome.status;
    phase.terminalReason = outcome.terminalReason;
    phase.outcomeError = outcome.error ?? null;
  } catch (error) {
    phase.error = String(error?.message ?? error).slice(0, 600);
  }
  // Both fake credentials are replaced by their names, and `leaked` is computed on the **raw**
  // record first, so a credential that reached any field of it is a failure rather than a mask.
  const raw = JSON.stringify({ phase, stderr: cliStderr, transcript });
  phase.leaked = raw.includes(FAKE_MODEL_KEY) || raw.includes(FAKE_OAUTH_TOKEN);
  const redact = (text) =>
    text
      .split(FAKE_MODEL_KEY)
      .join('[FAKE_MODEL_KEY]')
      .split(FAKE_OAUTH_TOKEN)
      .join('[FAKE_OAUTH_TOKEN]');
  phase.stderr = redact(cliStderr.join('')).slice(-4_000);
  phase.transcript = redact(JSON.stringify(transcript)).slice(-4_000);
  phase.notes = notes.map(redact);
  process.stdout.write(`${redact(JSON.stringify(phase))}\n`);
  process.exit(0);
}

/**
 * WP-140 (PROGRESS backlog 137's post-login half, Q115): the run image's **real** `claude` for **one
 * turn** with the product owner's subscription token, the way `compose.local.yml` runs it.
 *
 * The token is this container's `CLAUDE_CODE_OAUTH_TOKEN`, which the host passes **by name**
 * (`docker run -e CLAUDE_CODE_OAUTH_TOKEN`, so the value is never on a command line) and only under
 * `--real-model`. The spec is the smallest a run can be: no tool, no platform tool, no skill, no
 * MCP server, no artifact, `maxTurns: 1`, the fixed prompt, a two-minute wall clock — and the model
 * and effort of the shipped `intake` stage, the cheapest a pipeline runs. No tool means no checkout
 * (WP-74), so the run's egress list is the model hosts alone and no git or integration host is on it.
 * The run's redactor is production's (`injectedSecretRedactorFor`), and the record is checked for
 * the value **before** it is printed, then printed with the value replaced by the variable's name.
 */
if (PHASE === 'real-model') {
  const runId = required('CHECK_REAL_CLI_RUN_ID');
  const value = process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? '';
  const { REAL_MODEL_PROMPT, REAL_MODEL_WALL_CLOCK_MS } = await import(
    new URL('./real-model-preflight.mjs', import.meta.url).href
  );
  const { STAGE_AGENT_DEFAULTS } = await import(
    new URL('../packages/domain/src/index.ts', import.meta.url).href
  );
  const { injectedSecretRedactorFor } = await import(
    new URL('../packages/application/src/index.ts', import.meta.url).href
  );
  const { agentRunEnvironment } = await import(
    new URL('../apps/server/src/agent.ts', import.meta.url).href
  );
  const modelHosts = (process.env['CHECK_REAL_CLI_MODEL_HOSTS'] ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  const runEnvironment = agentRunEnvironment({
    providerMode: 'local',
    modelApiKey: null,
    modelOauthToken: value.length > 0 ? value : null,
  });
  const runProvisioner = launcherAdapters.createLauncherRunWorkspaceProvisioner({
    client,
    credentials,
    projects: projectSource,
    controlRoot: CONTROL_ROOT,
    modelEgressHosts: modelHosts,
    runRegistryHosts: [],
    credentialTtlSeconds: 3_600,
    clock: runnerAdapters.systemClock,
    logger,
  });
  const intake = STAGE_AGENT_DEFAULTS.intake;
  const transcript = [];
  const phase = {
    phase: PHASE,
    mode: 'local',
    ok: false,
    tokenLength: value.length,
    model: intake.model,
    effort: intake.effort,
    prompt: REAL_MODEL_PROMPT,
    claudeCodePath: null,
    status: null,
    envNames: Object.keys(runEnvironment.env),
    secretEnvNames: runEnvironment.secretEnvNames,
    egressHosts: null,
    checkout: null,
    notes,
  };
  const started = Date.now();
  try {
    const spec = runnerAdapters.runSpecFixture({
      ...specFor(runId),
      stage: 'intake',
      model: intake.model,
      effort: intake.effort,
      providerMode: 'local',
      systemPromptAppend:
        'This is a connectivity pre-flight of the platform. Use no tools. Answer in one word.',
      userPrompt: REAL_MODEL_PROMPT,
      contextPack: [],
      tools: [],
      disallowedTools: [],
      platformTools: [],
      protectedPaths: [],
      agents: {},
      mcpServers: {},
      skills: [],
      artifactType: null,
      env: runEnvironment.env,
      secretEnvNames: runEnvironment.secretEnvNames,
      limits: {
        ...runnerAdapters.runSpecFixture().limits,
        maxTurns: 1,
        maxBudgetUsd: 1,
        wallClockMs: REAL_MODEL_WALL_CLOCK_MS,
        stallTimeoutMs: REAL_MODEL_WALL_CLOCK_MS,
      },
    });
    const runner = runnerAdapters.createWorkspaceClaudeRunner({
      provisioner: {
        provision: async (provisioned) => {
          const workspace = await runProvisioner.provision(provisioned);
          const created = creates.filter((entry) => entry.spec.runId === provisioned.runId).at(-1);
          phase.egressHosts = created?.spec.egress?.hosts ?? null;
          phase.checkout = created === undefined ? null : created.spec.repo !== null;
          phase.claudeCodePath = workspace.claudeCodePath ?? null;
          return workspace;
        },
      },
      logger,
      build: (transport) =>
        runnerAdapters.createClaudeRunner({
          sink: { append: async (event) => transcript.push(event) },
          approvals: {
            requestApproval: async () => ({
              decision: 'deny',
              reason: 'unattended',
              questionId: null,
            }),
          },
          tools: runnerAdapters.recordingTools(),
          clock: runnerAdapters.systemClock,
          logger,
          injectedSecretRedactorFor: (run) => injectedSecretRedactorFor(run, logger),
          spawnClaudeCodeProcess: transport.spawn,
          ...(transport.cliEnvironment === undefined
            ? {}
            : { workspaceEnvironment: transport.cliEnvironment }),
        }),
    });
    const outcome = await runner.start(spec).outcome;
    phase.ok = true;
    phase.status = outcome.status;
    phase.terminalReason = outcome.terminalReason;
    phase.outcomeError = outcome.error ?? null;
    phase.outcome = {
      numTurns: outcome.numTurns,
      usage: outcome.usage,
      modelUsage: outcome.modelUsage,
      cost: outcome.cost,
      costUnmeasured: outcome.costUnmeasured === true,
      wallMs: outcome.wallMs,
      redactionCount: outcome.redactionCount,
    };
  } catch (error) {
    // Redacted before it is cut, so a token straddling the cut cannot print as a partial prefix.
    phase.error = (
      value.length > 0
        ? String(error?.message ?? error)
            .split(value)
            .join('[CLAUDE_CODE_OAUTH_TOKEN]')
        : String(error?.message ?? error)
    ).slice(0, 600);
  }
  phase.elapsedMs = Date.now() - started;
  // What the CLI's own `result` said — subtype (as the platform reads it), turns, usage, the cost
  // it **reported** (a subscription is not billed per token, so this is not money spent).
  const result = transcript.filter((entry) => entry?.kind === 'result').at(-1) ?? null;
  phase.result =
    result === null
      ? null
      : {
          subtype: result.terminal_reason,
          num_turns: result.num_turns,
          duration_ms: result.duration_ms,
          usage: result.usage,
          model_usage: result.model_usage,
          total_cost_usd_reported: result.cost?.usd ?? null,
        };
  // What the CLI says it was given: its `init` lists the tools the model may call.
  const init =
    transcript.find((entry) => entry?.kind === 'system' && entry?.subtype === 'init') ?? null;
  phase.init =
    init === null
      ? null
      : {
          tools: init.data?.tools ?? null,
          model: init.model ?? null,
          api_key_source: init.data?.api_key_source ?? null,
          claude_code_version: init.data?.claude_code_version ?? null,
        };
  phase.apiRetries = transcript
    .filter((entry) => entry?.kind === 'system' && entry?.subtype === 'api_retry')
    .map((entry) => entry.data ?? null);
  // The model's answer, text blocks only — model output, so it is data and is only printed.
  phase.reply = transcript
    .filter((entry) => entry?.kind === 'assistant')
    .flatMap((entry) => entry.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text))
    .join(' ')
    .slice(0, 400);
  // `leaked` on the **raw** record, before anything is replaced, so a value that reached any field
  // is a failure rather than a mask; then the value is replaced by its name for printing.
  const raw = JSON.stringify({ phase, stderr: cliStderr, transcript });
  phase.leaked = value.length > 0 && raw.includes(value);
  const redact = (text) =>
    value.length > 0 ? text.split(value).join('[CLAUDE_CODE_OAUTH_TOKEN]') : text;
  phase.stderr = redact(cliStderr.join('')).slice(-4_000);
  phase.transcript = redact(JSON.stringify(transcript)).slice(-6_000);
  phase.notes = notes.map(redact);
  process.stdout.write(`${redact(JSON.stringify(phase))}\n`);
  process.exit(0);
}

/**
 * WP-127, PROGRESS backlog 346: the image's **real** `claude` with **no route to the model** — its
 * run's egress sidecar stopped after the workspace is provisioned and before the CLI starts, so its
 * `HTTPS_PROXY` names a container that is gone. The run allows no model host either, so nothing it
 * sends could reach Anthropic had the sidecar been up.
 *
 * The gate: once provisioned, this prints `{"provisioned": …}` and waits (bounded) for the host to
 * stop the sidecar and create `/tmp/sidecar-stopped` in this container (`docker exec`). What is
 * printed is the CLI's retry sequence off the transcript — attempt, delay, status, error and when —
 * the outcome, and the runner's stderr line, so the check can say how long the CLI retries, what its
 * backoff caps at and how it gives up, and that the shipped stall now ends the run naming the route.
 */
if (PHASE === 'no-route') {
  const runId = required('CHECK_NO_ROUTE_RUN_ID');
  const gateMs = Number(process.env['CHECK_NO_ROUTE_GATE_MS'] ?? 120_000);
  const transcript = [];
  const phase = { phase: PHASE, ok: false, gate: null, status: null, notes };
  const started = Date.now();
  try {
    const runner = runnerAdapters.createWorkspaceClaudeRunner({
      provisioner: {
        provision: async (spec) => {
          const workspace = await provisioner.provision(spec);
          process.stdout.write(`${JSON.stringify({ provisioned: spec.runId })}\n`);
          const deadline = Date.now() + gateMs;
          const { existsSync } = await import('node:fs');
          while (!existsSync('/tmp/sidecar-stopped') && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          phase.gate = existsSync('/tmp/sidecar-stopped') ? 'sidecar stopped' : 'timed out';
          return workspace;
        },
      },
      logger,
      build: (transport) =>
        runnerAdapters.createClaudeRunner({
          sink: { append: async (event) => transcript.push(event) },
          approvals: {
            requestApproval: async () => ({
              decision: 'deny',
              reason: 'unattended',
              questionId: null,
            }),
          },
          tools: runnerAdapters.recordingTools(),
          clock: runnerAdapters.systemClock,
          logger,
          injectedSecretRedactorFor: () => noSecretsRedactor(),
          spawnClaudeCodeProcess: transport.spawn,
          ...(transport.cliEnvironment === undefined
            ? {}
            : { workspaceEnvironment: transport.cliEnvironment }),
        }),
    });
    const spec = runnerAdapters.runSpecFixture({
      ...specFor(runId),
      tools: ['Read'],
      limits: {
        ...runnerAdapters.runSpecFixture().limits,
        wallClockMs: Number(required('CHECK_NO_ROUTE_WALL_MS')),
        stallTimeoutMs: Number(required('CHECK_NO_ROUTE_STALL_MS')),
      },
    });
    const outcome = await runner.start(spec).outcome;
    phase.ok = true;
    phase.status = outcome.status;
    phase.terminalReason = outcome.terminalReason;
    phase.error = outcome.error;
  } catch (error) {
    phase.error = String(error?.message ?? error).slice(0, 600);
  }
  phase.wallMs = Date.now() - started;
  const redact = (text) => text.split(FAKE_MODEL_KEY).join('[FAKE_MODEL_KEY]');
  phase.retries = transcript
    .filter((event) => event.kind === 'system' && event.subtype === 'api_retry')
    .map((event) => ({
      at: event.created_at,
      attempt: event.data?.attempt ?? null,
      max_retries: event.data?.max_retries ?? null,
      retry_delay_ms: event.data?.retry_delay_ms ?? null,
      error_status: event.data?.error_status ?? null,
      error: event.data?.error ?? null,
    }));
  phase.kinds = transcript.map((event) =>
    event.kind === 'system' ? `system/${event.subtype}` : event.kind,
  );
  phase.last = redact(
    JSON.stringify(
      transcript
        .filter((event) => event.kind !== 'system' || event.subtype !== 'api_retry')
        .slice(-3),
    ),
  ).slice(-3_000);
  phase.stderr = redact(cliStderr.join('')).slice(-2_000);
  phase.leaked = JSON.stringify(phase).includes(FAKE_MODEL_KEY);
  process.stdout.write(`${JSON.stringify(phase)}\n`);
  process.exit(0);
}

/**
 * WP-144 (PROGRESS backlog 432): **the runner's own stop hands a live run back**, against a real
 * daemon. A run of the fake CLI that never finishes (`--scenario signal-report`) is started through
 * the production provisioner and runner, and once its session is live it is stopped exactly as
 * `LiveRuns.stopAll` stops it on SIGTERM — `handle.stop({ reason: 'shutdown' })`. What is printed is
 * how it ended and how long the stop took **including the workspace's release** (the launcher's
 * destroy), which is the row's 10 s budget; the host then asks the daemon what is left.
 */
if (PHASE === 'shutdown') {
  const runId = required('CHECK_SHUTDOWN_RUN_ID');
  const phase = {
    phase: PHASE,
    ok: false,
    live: false,
    status: null,
    terminalReason: null,
    costUnmeasured: null,
    stopMs: null,
    releases: [],
    notes,
  };
  try {
    const transcript = [];
    const runner = runnerAdapters.createWorkspaceClaudeRunner({
      provisioner: {
        provision: async (spec) => {
          const workspace = await provisioner.provision(spec);
          return {
            ...workspace,
            claudeCodePath: FAKE_CLI,
            release: async (ending) => {
              phase.releases.push(ending?.kind ?? String(ending));
              await workspace.release(ending);
            },
          };
        },
      },
      logger,
      build: ({ spawn, cliEnvironment }) =>
        runnerAdapters.createClaudeRunner({
          sink: { append: async (event) => transcript.push(event) },
          approvals: {
            requestApproval: async () => ({
              decision: 'deny',
              reason: 'unattended',
              questionId: null,
            }),
          },
          tools: runnerAdapters.recordingTools(),
          clock: runnerAdapters.systemClock,
          logger,
          injectedSecretRedactorFor: () => noSecretsRedactor(),
          // The one change from the main run: the fake CLI is told never to finish, so the session
          // is live when the stop lands — the shape of a run a `docker compose stop runner` meets.
          spawnClaudeCodeProcess: Object.assign(
            (options) =>
              spawn({ ...options, args: [...(options.args ?? []), '--scenario', 'signal-report'] }),
            { setStderrSink: spawn.setStderrSink },
          ),
          ...(cliEnvironment === undefined ? {} : { workspaceEnvironment: cliEnvironment }),
        }),
    });
    const handle = runner.start(specFor(runId));
    for (let waited = 0; waited < 240 && transcript.length === 0; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    phase.live = transcript.length > 0;
    const stopping = Date.now();
    await handle.stop({ reason: 'shutdown' });
    const outcome = await handle.outcome;
    phase.stopMs = Date.now() - stopping;
    phase.status = outcome.status;
    phase.terminalReason = outcome.terminalReason;
    phase.costUnmeasured = outcome.costUnmeasured === true;
    phase.ok = true;
  } catch (error) {
    phase.error = String(error?.message ?? error).slice(0, 600);
  }
  process.stdout.write(`${JSON.stringify(phase)}\n`);
  process.exit(0);
}

const report = {
  sdkPlatformPackages: sdkPlatformPackages(),
  environ: null,
  ok: false,
  health: null,
  wrongTokenCode: null,
  status: null,
  terminalReason: null,
  claudeCodePath: null,
  socketPath: null,
  workdir: null,
  checkoutBranch: null,
  egressHosts: null,
  credentialScope: undefined,
  replayed: null,
  replayedHandleMatches: null,
  spawnCommand: null,
  wrongCliPathError: null,
  releases: [],
  kinds: [],
  text: '',
  outcomeError: null,
  notes,
};

try {
  // 1. The surface is authenticated. Asserted first, because every later claim rests on the token
  //    being what admits a caller.
  const wrong = launcherAdapters.createLauncherControlClient({
    baseUrl,
    token: `${token}-wrong`,
    logger,
  });
  try {
    await wrong.health();
    report.wrongTokenCode = 'ACCEPTED';
  } catch (error) {
    report.wrongTokenCode = error?.code ?? String(error);
  }

  // 2. Health — which is also what proves the internal network reaches the launcher at all.
  report.health = await real.health();

  // 3. One run, end to end, through the production provisioner.
  const transcript = [];
  const releases = [];
  const runner = runnerAdapters.createWorkspaceClaudeRunner({
    provisioner: {
      provision: async (spec) => {
        const workspace = await provisioner.provision(spec);
        report.claudeCodePath = workspace.claudeCodePath;
        report.workdir = workspace.workdir;
        return {
          ...workspace,
          // The CLI the run image carries is real `claude`, and a real run of it needs a model
          // credential this check deliberately does not have. The **path** is what backlog 34 is
          // about, and it is recorded above from the launcher's own answer; what executes is the
          // fake CLI in the read-only checkout mount.
          claudeCodePath: FAKE_CLI,
          release: async (ending) => {
            releases.push(ending);
            await workspace.release(ending);
          },
        };
      },
    },
    logger,
    build: ({ spawn, cliEnvironment }) =>
      runnerAdapters.createClaudeRunner({
        sink: { append: async (event) => transcript.push(event) },
        approvals: {
          requestApproval: async () => ({
            decision: 'deny',
            reason: 'unattended',
            questionId: null,
          }),
        },
        tools: runnerAdapters.recordingTools(),
        clock: runnerAdapters.systemClock,
        logger,
        injectedSecretRedactorFor: () => noSecretsRedactor(),
        // The seam this check reads: `SpawnOptions.command` is the string the SDK hands the
        // transport and the shim `exec`s in the container — the bytes the CLI received (rule 82).
        // The transport's stderr seam is kept (WP-127), so the wrapper does not hide it.
        spawnClaudeCodeProcess: Object.assign(
          (options) => {
            report.spawnCommand = options.command;
            return spawn(options);
          },
          { setStderrSink: spawn.setStderrSink },
        ),
        // WP-118: what `apps/server/src/agent.ts` forwards — the launcher's answer.
        ...(cliEnvironment === undefined ? {} : { workspaceEnvironment: cliEnvironment }),
      }),
  });

  const outcome = await runner.start(specFor(RUN_ID)).outcome;
  report.status = outcome.status;
  report.terminalReason = outcome.terminalReason;
  report.kinds = transcript.map((entry) => entry.kind);
  report.text = JSON.stringify(transcript);
  report.releases = releases;
  report.environ = environReport(report.text);

  const created = creates.find((entry) => entry.spec.runId === RUN_ID);
  report.socketPath = created?.response.attachment.socketPath ?? null;
  report.checkoutBranch = created?.spec.repo?.checkoutBranch ?? null;
  report.egressHosts = created?.spec.egress.hosts ?? null;
  report.credentialScope = created?.response.credentialScope;

  /**
   * 4. TD-028 decision 4, against a real daemon: a second `create` for a run that already has a
   *    handle answers the **stored** handle rather than starting a second container. The unit tier
   *    can assert that the provider was asked once; only a daemon can be asked whether a second
   *    container exists, which `launcher-control-plane-check.mjs` does after this process exits.
   */
  const first = await provisioner.provision(specFor(IDEMPOTENCY_RUN_ID));
  const second = await provisioner.provision(specFor(IDEMPOTENCY_RUN_ID));
  const replay = creates.filter((entry) => entry.spec.runId === IDEMPOTENCY_RUN_ID);
  report.replayed = replay.at(-1)?.response.replayed ?? null;
  report.replayedHandleMatches =
    JSON.stringify(replay[0]?.response.handle) === JSON.stringify(replay[1]?.response.handle);
  void second;
  await first.release({ kind: 'not_started' });

  /**
   * 5. A wrong CLI path fails **by name, on the platform side** (backlog 34's whole cost).
   *
   * Asked of a **second launcher container** configured with a path the run image does not carry,
   * because it is the launcher that verifies the path against the image. This is the failure an
   * operator gets from a mistyped `APP_WORKSPACE_RUNTIME_CLI_PATH` or an image that does not carry
   * the binary, and what it replaces is `exit code: null` from a shim with no diagnosis at all.
   */
  const badUrl = process.env['CHECK_BAD_LAUNCHER_URL'];
  if (badUrl !== undefined && badUrl.length > 0) {
    const badProvisioner = launcherAdapters.createLauncherRunWorkspaceProvisioner({
      client: launcherAdapters.createLauncherControlClient({ baseUrl: badUrl, token, logger }),
      credentials,
      projects: projectSource,
      controlRoot: CONTROL_ROOT,
      modelEgressHosts: [],
      runRegistryHosts: [],
      credentialTtlSeconds: 3_600,
      clock: runnerAdapters.systemClock,
      logger,
    });
    try {
      await badProvisioner.provision(specFor(required('CHECK_BAD_RUN_ID')));
      report.wrongCliPathError = 'ACCEPTED';
    } catch (error) {
      report.wrongCliPathError = `${error?.code ?? '?'}: ${error?.message ?? String(error)}`;
    }
  }

  report.ok =
    outcome.status === 'completed' &&
    outcome.terminalReason === 'success' &&
    report.replayedHandleMatches === true;
} catch (error) {
  report.outcomeError = String(error?.stack ?? error);
}

process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(report.ok ? 0 : 1);
