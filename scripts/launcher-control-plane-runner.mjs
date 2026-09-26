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
 * It prints one JSON line and exits; `launcher-control-plane-check.mjs` reads it.
 */
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

const { noSecretsRedactor } = await import(
  new URL('../packages/application/src/index.ts', import.meta.url).href
);
const { launcher: launcherAdapters, runner: runnerAdapters } = await import(
  new URL('../packages/infrastructure/src/index.ts', import.meta.url).href
);

const notes = [];
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (fields, message) => notes.push(`warn: ${message} ${JSON.stringify(fields)}`),
  error: (fields, message) => notes.push(`error: ${message} ${JSON.stringify(fields)}`),
};

const baseUrl = required('CHECK_LAUNCHER_URL');
const token = required('CHECK_LAUNCHER_TOKEN');
const real = launcherAdapters.createLauncherControlClient({ baseUrl, token, logger });

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
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/tmp' },
    secretEnvNames: [],
  });

const report = {
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
    build: ({ spawn }) =>
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
        spawnClaudeCodeProcess: (options) => {
          report.spawnCommand = options.command;
          return spawn(options);
        },
      }),
  });

  const outcome = await runner.start(specFor(RUN_ID)).outcome;
  report.status = outcome.status;
  report.terminalReason = outcome.terminalReason;
  report.kinds = transcript.map((entry) => entry.kind);
  report.text = JSON.stringify(transcript);
  report.releases = releases;

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
