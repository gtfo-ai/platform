/**
 * The first production `RunWorkspaceProvisioner` — WP-53, and the thing whose absence made every
 * green result about a run in this repository a result about a test's fake.
 *
 * Until this file, `apps/server/src/agent.ts` took a provisioner it was *given*, nothing gave it
 * one, and `startRuntime` therefore composed `unavailableClaudeRunner`. So **no production agent
 * run had ever executed**, and eleven findings were latent behind that one fact (TD-028 § Context).
 * This is the composition that ends it: a `RunSpec` in, a live control socket and a `SpawnedProcess`
 * factory out, with the Docker daemon on the other side of TD-028's HTTP control plane.
 *
 * ## It holds no Docker client, and that is checked rather than promised
 *
 * TD-021's WP-15g amendment forbids the process that composes the pipeline or serves `/webhooks/*`
 * from constructing one. Everything this file touches is `client.ts` (a `fetch`) and
 * `createRunletSpawn` (a Unix socket on a volume). `apps/launcher/src/docker-access.test.ts` reads
 * every tracked source off disk and would fail if that changed.
 *
 * ## Four things it decides, each of which was a filed defect
 *
 *  - **`spec.checkoutRef` reaches `WorkspaceSpec.repo.checkoutBranch`** (PROGRESS backlog **71**).
 *    The planner has filled that field since WP-34 and it reached nothing; the one mapping is
 *    {@link runWorkspaceSpecFor}. The *"the branch is not on the remote"* half was already answered
 *    at the provider — `#clone` runs `git checkout "$B" || git checkout -b "$B"` — so a task's first
 *    run clones the default branch and creates the task branch rather than failing.
 *  - **The CLI's path comes from the run image** (backlog **34**). The launcher answers it on
 *    `create`; this file puts it on the workspace so `createWorkspaceClaudeRunner` can substitute it
 *    into the spec beside `workspacePath`. Nothing here guesses a path.
 *  - **Both provider modes need the model host in the egress allow-list.** `buildWorkspaceSpec`'s
 *    docblock says *"the model host (or none, in `local` provider mode), … the binary is on the host
 *    and talks to nothing"*, which was true when `local` meant an operator's own binary. Since WP-22
 *    it is not: `compose.local.yml` says *"the CLI does not run in this container: it runs in the
 *    per-run `platform-runtime` container"*, and WP-53 measured that the pinned CLI reads
 *    `CLAUDE_CODE_OAUTH_TOKEN` and authenticates against the **same** API (`401 OAuth access token
 *    is invalid`). So the host is on the list in both modes, and the sentence is corrected there.
 *  - **The socket path is checked against this process' own control root.** The launcher computes it
 *    from *its* `APP_WORKSPACE_CONTROL_ROOT`; the runner mounts the same volume and may have mounted
 *    it somewhere else. A mismatch is a compose mistake, and without this check it surfaces as
 *    `ECONNREFUSED` thirty seconds into a run instead of as a named refusal before one starts.
 */
import type {
  Logger,
  RunnerClock,
  RunSpec,
  WorkspaceHandle,
  WorkspaceSpec,
} from '@platform/application';
import { silentLogger, WorkspaceError } from '@platform/application';
import { createRunletSpawn } from '../runlet/spawn-adapter.js';
import type {
  ProvisionedRunWorkspace,
  RunWorkspaceEnding,
  RunWorkspaceProvisioner,
} from '../runner/workspace-runner.js';
import { buildWorkspaceSpec } from '../workspace/spec.js';
import type { LauncherControlClient } from './client.js';

/**
 * What the platform knows about a run's project that the launcher does not.
 *
 * The launcher has no database connection and no route to one (`compose.yml`'s launcher service
 * joins neither the default network nor `db`), so every one of these travels on the create request.
 */
export interface RunWorkspaceProject {
  /** `projects.repo_url` — what the mirror fetches from and what an export pushes to. */
  readonly repoUrl: string;
  /** `projects.default_branch`. */
  readonly defaultBranch: string;
  /** The provider's project handle (`acme/web`), for the run-scoped credential's scope. */
  readonly projectPath: string;
  /** The git host the workspace may ask a credential for. Lowercase, no port. */
  readonly gitHost: string;
  /** BD-025's namespace for what this run may push. */
  readonly branchPatterns: readonly string[];
  /** Non-secret project variables for the container's environment (BD-025 §3). */
  readonly containerEnv: Readonly<Record<string, string>>;
}

/** Where {@link RunWorkspaceProject} comes from. `apps/server` reads it from `projects`. */
export interface RunWorkspaceProjectSource {
  forRun(spec: RunSpec): Promise<RunWorkspaceProject>;
}

export interface LauncherProvisionerOptions {
  readonly client: LauncherControlClient;
  readonly projects: RunWorkspaceProjectSource;
  /**
   * `APP_WORKSPACE_CONTROL_ROOT` **as this process mounts it** — TD-025 §2's static mount.
   *
   * Required, with no default, for standing rule 55's reason: a default here would silently accept
   * a launcher whose control root is somewhere else and produce a connection to a path that is not
   * the one the shim is listening on.
   */
  readonly controlRoot: string;
  /**
   * Hosts the run must reach besides its git host — the model provider, or a proxy in front of it.
   *
   * Configuration rather than a constant, because an instance behind an egress proxy names a
   * different host. Empty is legal and **fails closed**: the run container reaches only its git
   * host, and the CLI's first request is refused by the egress sidecar rather than silently
   * succeeding, which is the direction technical/05 asks for.
   */
  readonly modelEgressHosts: readonly string[];
  /** TD-021's "expires next day" for the run-scoped git credential. */
  readonly credentialTtlSeconds: number;
  readonly clock: RunnerClock;
  readonly logger?: Logger;
}

/**
 * The `WorkspaceSpec` of one run.
 *
 * Exported so the unit tier can assert the mapping without a control plane: it is the whole of
 * backlog **71**'s fix and the whole of where a run's isolation is decided.
 */
export const runWorkspaceSpecFor = (input: {
  readonly spec: RunSpec;
  readonly project: RunWorkspaceProject;
  readonly modelEgressHosts: readonly string[];
  readonly now: Date;
}): WorkspaceSpec =>
  buildWorkspaceSpec({
    spec: input.spec,
    repoUrl: input.project.repoUrl,
    defaultBranch: input.project.defaultBranch,
    // PROGRESS backlog 71, in one line. `null` is the first run of a task: the branch is not on the
    // remote yet and `#clone` creates it.
    checkoutBranch: input.spec.checkoutRef,
    platformEgressHosts: input.modelEgressHosts,
    containerEnv: input.project.containerEnv,
    now: input.now,
  });

/**
 * Refuses a socket path that is not under this process' control root.
 *
 * Exported for the same reason the spec builder is: it is a security-relevant boundary check on a
 * string another process chose, and the unit tier asserts both directions.
 */
export const assertControlSocketUnderRoot = (socketPath: string, controlRoot: string): void => {
  const root = controlRoot.endsWith('/') ? controlRoot : `${controlRoot}/`;
  // `/../` **and** a trailing `/..`: the first spelling was the only one refused until WP-53's
  // review, so `<root>/x/..` — which resolves to the root's parent — was accepted. Both are checked
  // on the raw string rather than resolved, because this is a string another process chose and a
  // `path.resolve` here would answer about *this* process' filesystem.
  const climbs = socketPath.includes('/../') || socketPath.endsWith('/..');
  if (!socketPath.startsWith(root) || climbs) {
    throw new WorkspaceError(
      'invalid_spec',
      `the launcher answered with a control socket at ${socketPath}, which is not under this process' control root ${controlRoot}: the two containers mount the ctl volume at different paths (APP_WORKSPACE_CONTROL_ROOT)`,
    );
  }
};

export const createLauncherRunWorkspaceProvisioner = (
  options: LauncherProvisionerOptions,
): RunWorkspaceProvisioner => {
  const logger = options.logger ?? silentLogger;
  if (!options.controlRoot.startsWith('/')) {
    throw new WorkspaceError(
      'invalid_spec',
      `APP_WORKSPACE_CONTROL_ROOT must be an absolute path (got ${options.controlRoot})`,
    );
  }

  return {
    provision: async (spec: RunSpec): Promise<ProvisionedRunWorkspace> => {
      const project = await options.projects.forRun(spec);
      const workspaceSpec = runWorkspaceSpecFor({
        spec,
        project,
        modelEgressHosts: options.modelEgressHosts,
        now: new Date(options.clock.now()),
      });
      const created = await options.client.createRun({
        spec: workspaceSpec,
        credential: {
          project: project.projectPath,
          host: project.gitHost,
          branchPatterns: [...project.branchPatterns],
          ttlSeconds: options.credentialTtlSeconds,
        },
      });
      assertControlSocketUnderRoot(created.attachment.socketPath, options.controlRoot);
      logger.info(
        {
          run_id: spec.runId,
          project_id: spec.projectId,
          checkout_branch: workspaceSpec.repo.checkoutBranch,
          read_only: workspaceSpec.readOnly,
          credential: created.credentialMinted,
          replayed: created.replayed,
        },
        'the run workspace is provisioned through the launcher control plane',
      );
      return {
        workdir: created.attachment.workdir,
        claudeCodePath: created.claudeCodePath,
        spawn: createRunletSpawn({
          socketPath: created.attachment.socketPath,
          token: created.attachment.token,
          clock: options.clock,
          logger,
        }),
        release: async (ending: RunWorkspaceEnding) =>
          releaseRun({
            client: options.client,
            handle: created.handle,
            ending,
            logger,
          }),
      };
    },
  };
};

/**
 * Gives the workspace back, on every one of `createWorkspaceClaudeRunner`'s eight endings.
 *
 * The take-over is the only ending that carries anything beyond the fact of it, and it is read off
 * the `ended` arm rather than from a flag: a run that never started has no tree to commit and a
 * crashed one is a fault rather than a hand-over (`RunWorkspaceEnding`'s own docblock).
 *
 * **It does not throw.** `createWorkspaceClaudeRunner` calls this in a `finally` and logs what it
 * catches, but a throw here would still replace nothing useful — the run's own outcome is what the
 * caller needs — while the container stop is the launcher's guarantee either way (`endRun` runs
 * `destroy` in a `finally`). What a failure must not be is *silent*, so it is logged with the run
 * id and the ending.
 */
const releaseRun = async (input: {
  readonly client: LauncherControlClient;
  readonly handle: WorkspaceHandle;
  readonly ending: RunWorkspaceEnding;
  readonly logger: Logger;
}): Promise<void> => {
  const takeOver = input.ending.kind === 'ended' ? (input.ending.takeOver ?? null) : null;
  try {
    const ended = await input.client.endRun(input.handle.runId, {
      handle: input.handle,
      export:
        takeOver === null
          ? null
          : {
              branch: takeOver.branch,
              commitMessage: takeOver.commitMessage,
              tarball: takeOver.tarball,
              keepUntil: takeOver.keepUntil,
            },
    });
    if (ended.failures.length > 0) {
      input.logger.warn(
        { run_id: input.handle.runId, failures: ended.failures },
        'the run ended with failures after its container was stopped',
      );
    }
  } catch (error) {
    input.logger.error(
      { err: error, run_id: input.handle.runId, ending: input.ending.kind },
      'the launcher could not be told that this run ended; its container may still be running',
    );
  }
};
