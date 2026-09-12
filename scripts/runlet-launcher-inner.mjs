#!/usr/bin/env node
/**
 * The **whole** run, inside one container — the process `runlet-launcher-check.mjs` starts.
 *
 * ## Why this runs in a container and the check does not
 *
 * Two measurements, both taken while writing this:
 *
 *  1. **A Unix socket created inside the Docker VM cannot be connected to from a macOS host.** The
 *     host can `stat` the socket on a bind-backed volume and gets `ECONNREFUSED` when it connects,
 *     because the listener is on the other side of the file sharing layer. WP-13's
 *     `runlet-container-check.mjs` drives its own check from a container for the same reason.
 *  2. **The shim refuses to start on a bind-backed control volume on macOS**: it `chmod 0600`s its
 *     socket after binding, and `chmod` on a socket there answers `EINVAL`, so the container exits 1
 *     with `EINVAL: invalid argument, chmod '/ctl/ctl.sock'`. That refusal is *correct* — a socket
 *     whose mode the platform could not set is a socket whose access control it cannot state — so the
 *     control volume has to be a plain named volume, which a host process cannot read at all.
 *
 * Together those two say: the launcher and the runner must both be inside the Docker VM, mounting the
 * control volume, which is precisely TD-021's own deployment and Q52's in-process composition. So this
 * process composes `buildLauncher` (the launcher half, holding the Docker client — TD-021 allows
 * exactly one component to) **and** WP-15g's `createWorkspaceClaudeRunner` over `createRunletSpawn`
 * (the runner half), runs one stage, and prints one JSON line.
 *
 * ## What is real here
 *
 * `LauncherService`, `DockerWorkspaceProvider`, the daemon, the mirror fetch over the network, the
 * clone, the run container with technical/05's hardening flags, the run shim as its entrypoint, the
 * control socket, `createRunletSpawn`, the Agent SDK's own `query()`, `createClaudeRunner`,
 * `createWorkspaceClaudeRunner`'s release-on-every-ending, and `endRun`'s teardown.
 *
 * ## What is not
 *
 * The model (a fake CLI **executable**), the `platform-runtime` image (`node:24-alpine` with this
 * repository read-only at `/repo`), the egress **filter** (`alpine:3.21` with no proxy in it — the
 * topology is real, the filtering is not), and the run is read-only so no git credential is minted.
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
const FAKE_CLI = '/repo/test/fixtures/runlet/fake-claude-cli';

const { buildLauncher } = await import(
  new URL('../apps/launcher/src/runtime.ts', import.meta.url).href
);
const { noSecretsRedactor, WorkspaceError } = await import(
  new URL('../packages/application/src/index.ts', import.meta.url).href
);
const {
  runlet: runletAdapters,
  runner: runnerAdapters,
  workspace: workspaceAdapters,
} = await import(new URL('../packages/infrastructure/src/index.ts', import.meta.url).href);

const notes = [];
const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (fields, message) => notes.push(`warn: ${message} ${JSON.stringify(fields)}`),
  error: (fields, message) => notes.push(`error: ${message} ${JSON.stringify(fields)}`),
};

/** A launcher with no git provider wired to it; the run below is read-only, so nothing asks. */
const refusingCredentials = {
  async mint() {
    throw new WorkspaceError(
      'invalid_spec',
      'this check mints no credential: the run is read-only',
    );
  },
  async revoke() {},
};

const launcher = buildLauncher({
  env: {
    DOCKER_HOST: required('DOCKER_HOST'),
    APP_WORKSPACE_CONTROL_VOLUME: required('CHECK_CONTROL_VOLUME'),
    APP_WORKSPACE_CONTROL_ROOT: '/run/agentic/ctl',
    APP_WORKSPACE_CACHE_VOLUME: required('CHECK_CACHE_VOLUME'),
    APP_WORKSPACE_RUNTIME_IMAGE: required('CHECK_RUNTIME_IMAGE'),
    APP_WORKSPACE_EGRESS_IMAGE: required('CHECK_EGRESS_IMAGE'),
    APP_WORKSPACE_GIT_IMAGE: required('CHECK_GIT_IMAGE'),
    // The stand-in for `platform-runtime`: the shim runs from TypeScript source in the checkout the
    // *host* mounts into every run container. The launcher warns about it at startup, on purpose.
    APP_WORKSPACE_RUNTIME_SOURCE_DIR: required('CHECK_REPO_ROOT'),
    APP_WORKSPACE_HELPER_NETWORK: required('CHECK_NETWORK'),
    APP_WORKSPACE_EGRESS_NETWORK: required('CHECK_NETWORK'),
    APP_WORKSPACE_EXPORT_DIR: '/tmp/exports',
    APP_WORKSPACE_RETENTION_SWEEP_MS: '3600000',
  },
  credentials: refusingCredentials,
  /**
   * Q51, and here it is **not** a stand-in: this container runs as root, so the shim's `0600` socket
   * is reachable, and the uid the provider is told about is the uid the *run container* uses. A
   * deployment where the runner is not uid 1000 is what the check refuses, and it still would.
   */
  uid: 1000,
  logger,
});

const runSpec = runnerAdapters.runSpecFixture({
  runId: RUN_ID,
  // Read-only, so the launcher mints no credential: `runIsReadOnly` reads `tools`.
  tools: ['Read', 'Grep', 'Glob'],
  // The fake CLI's `result` carries no `structured_output`; asking for an artifact would be a
  // different ending (`error_max_structured_output_retries`) and a different subject.
  artifactType: null,
  providerMode: 'local',
  claudeCodePath: FAKE_CLI,
  env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/tmp' },
  secretEnvNames: [],
});

const workspaceSpec = workspaceAdapters.buildWorkspaceSpec({
  spec: runSpec,
  repoUrl: required('CHECK_REPO_URL'),
  defaultBranch: 'main',
  // No model host: the CLI is a local executable, and this is what makes the allow-list one host.
  platformEgressHosts: [],
  now: new Date(),
});

const transcript = [];
const releases = [];
let handle = null;
let attachment = null;
let credential = 'not-minted';

const provisioner = {
  provision: async () => {
    const started = await launcher.service.startRun(workspaceSpec, {
      project: 'acme/api',
      host: required('CHECK_REPO_HOST'),
      branchPatterns: ['agentic/*'],
      ttlSeconds: 3600,
    });
    handle = started.handle;
    attachment = started.attachment;
    credential = started.credential === null ? 'none' : 'minted';
    return {
      workdir: started.attachment.workdir,
      spawn: runletAdapters.createRunletSpawn({
        socketPath: started.attachment.socketPath,
        token: started.attachment.token,
        clock: runnerAdapters.systemClock,
        logger,
      }),
      release: async (ending) => {
        releases.push(ending);
        const ended = await launcher.service.endRun(started.handle, { export: null });
        if (ended.failures.length > 0) {
          notes.push(`endRun failures: ${ended.failures.join('; ')}`);
        }
      },
    };
  },
};

const runner = runnerAdapters.createWorkspaceClaudeRunner({
  provisioner,
  logger,
  build: ({ spawn }) =>
    runnerAdapters.createClaudeRunner({
      sink: { append: async (event) => transcript.push(event) },
      // BD-025's unattended default, as `apps/server/src/agent.ts` composes it.
      approvals: {
        requestApproval: async () => ({ decision: 'deny', reason: 'unattended', questionId: null }),
      },
      tools: runnerAdapters.recordingTools(),
      clock: runnerAdapters.systemClock,
      logger,
      injectedSecretRedactorFor: () => noSecretsRedactor(),
      spawnClaudeCodeProcess: spawn,
    }),
});

const report = {
  ok: false,
  status: null,
  terminalReason: null,
  costUsd: null,
  outcomeError: null,
  kinds: [],
  text: '',
  socketPath: null,
  workdir: null,
  credential,
  releases,
  containerId: null,
  notes,
};

try {
  const outcome = await runner.start(runSpec).outcome;
  report.status = outcome.status;
  report.terminalReason = outcome.terminalReason;
  report.costUsd = outcome.cost.usd;
  report.outcomeError = outcome.error;
  report.ok = outcome.status === 'completed' && outcome.terminalReason === 'success';
} catch (error) {
  report.outcomeError = String(error?.stack ?? error);
}
report.kinds = transcript.map((entry) => entry.kind);
report.text = JSON.stringify(transcript);
report.socketPath = attachment?.socketPath ?? null;
report.workdir = attachment?.workdir ?? null;
report.credential = credential;

// Whether the teardown really removed the container is asked of the **daemon by the host**, which has
// the CLI: `runlet-launcher-check.mjs` runs `docker container inspect ws-<run-id>` after this process
// exits. It is deliberately not asked here — a second `DockerEngine` in this file would break the
// one-file claim `apps/launcher/src/docker-access.test.ts` enforces over the repository, and the
// claim is worth more than the convenience.
report.containerId = handle?.containerId ?? null;

launcher.stop();
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exit(report.ok ? 0 : 1);
