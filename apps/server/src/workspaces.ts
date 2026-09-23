/**
 * The production `RunWorkspaceProvisioner`, composed — **WP-53**, and the one line that ends
 * *"no production agent run has ever executed"*.
 *
 * ## What was missing, and it was not code
 *
 * `apps/server/src/agent.ts` has taken a `RunWorkspaceProvisioner` since WP-15g and **nothing gave
 * it one**, so `startRuntime` composed `unavailableClaudeRunner`, whose `start` throws. TD-021's
 * WP-15g amendment forbids this process from holding a Docker client, and there was no other way
 * to reach one: the launcher is a complete `WorkspaceProvider` service in its own container with
 * no transport to it (Q52). TD-028 decided that transport — an authenticated HTTP control plane on
 * an `internal: true` network — and this file is where the platform side of it is assembled.
 *
 * ## Two conditions, and neither of them is `ROLE`
 *
 * `APP_LAUNCHER_URL` and `APP_LAUNCHER_TOKEN`. A process with both composes a provisioner and
 * therefore subscribes `stage.execute`; a process with neither composes none and does not (TD-028
 * decision 5). A process with **one** of them is a configuration mistake and is refused by name
 * rather than silently treated as "no launcher" — standing rule 18: an operator who set the URL and
 * forgot the token must not get the same silence as one who set neither.
 *
 * ## It constructs no Docker client
 *
 * Everything here is a `fetch` and a Unix socket. `apps/launcher/src/docker-access.test.ts` reads
 * every tracked source off disk and would fail if that changed, which is what makes TD-021's
 * "exactly one component reaches the daemon" a checkable property of this repository rather than a
 * sentence in a decision record.
 */
import type { Logger, RunSpec } from '@platform/application';
import {
  launcher as launcherAdapters,
  runner as runnerAdapters,
  workspace as workspaceAdapters,
} from '@platform/infrastructure';
import type pg from 'pg';
import { repositoryPathOf } from './pipeline.js';

/**
 * TD-021: *"a run-scoped credential that expires next day"*.
 *
 * A constant rather than a knob: it is a security property of a minted push token, and the only
 * operator interest in changing it points the wrong way. `LauncherService.startRun` is what passes
 * it to the broker.
 */
const RUN_CREDENTIAL_TTL_SECONDS = 24 * 60 * 60;

/**
 * BD-025's namespace: the only refs a run's credential may push.
 *
 * One pattern, and the same string `product/19 §19`'s hand-back and the take-over export use for the
 * branch they create. It is not configuration: widening it is widening what an agent may write to a
 * repository, which BD-025 puts with the platform rather than with a project.
 */
const RUN_BRANCH_PATTERNS = ['agentic/*'] as const;

/**
 * `projects.repo_url` and `projects.default_branch`, plus what is derived from them.
 *
 * One query per run, on the connection pool every other projection uses. It is **not** cached: a
 * repository URL that moved between two runs of the same project is exactly the case where a cache
 * would clone from the old host, and a run is measured in minutes while this query is measured in
 * milliseconds.
 */
export const createRunWorkspaceProjectSource = (
  pool: pg.Pool,
): launcherAdapters.RunWorkspaceProjectSource => ({
  forRun: async (spec: RunSpec): Promise<launcherAdapters.RunWorkspaceProject> => {
    const { rows } = await pool.query<{ repo_url: string; default_branch: string }>(
      'select repo_url, default_branch from projects where id = $1',
      [spec.projectId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(
        `project ${spec.projectId} has no row, so run ${spec.runId} has no repository to check out`,
      );
    }
    return {
      repoUrl: row.repo_url,
      defaultBranch: row.default_branch,
      projectPath: repositoryPathOf(row.repo_url),
      // `egressHostOfRepoUrl` is the platform's one parse of a repository URL's host (lowercased,
      // port and credentials removed) and it throws rather than answering an empty string. The same
      // derivation `buildWorkspaceSpec` uses for the egress allow-list, so the host the credential
      // is scoped to and the host the container may reach cannot disagree.
      gitHost: workspaceAdapters.egressHostOfRepoUrl(row.repo_url),
      branchPatterns: [...RUN_BRANCH_PATTERNS],
      /**
       * Empty, and that is the whole truth rather than a placeholder.
       *
       * `agenticConfigSchema` has **no** key for a container variable — `buildWorkspaceSpec`'s
       * docblock explains why (BD-025's narrow-never-widen rule is satisfied by there being nothing
       * to widen), and Q62 is where "should a project be able to?" is filed. Passing `{}` here is
       * therefore the shipped policy, not a gap: a project cannot put a variable in its run
       * container at all.
       */
      containerEnv: {},
    };
  },
});

export interface ComposeRunWorkspacesOptions {
  readonly pool: pg.Pool;
  /** `APP_LAUNCHER_URL`. */
  readonly launcherUrl: string | null;
  /** `APP_LAUNCHER_TOKEN`. */
  readonly launcherToken: string | null;
  /** `APP_WORKSPACE_CONTROL_ROOT` — where *this* process mounts TD-025 §2's volume. */
  readonly controlRoot: string;
  /** `APP_MODEL_EGRESS_HOSTS`. */
  readonly modelEgressHosts: readonly string[];
  readonly logger: Logger;
}

/**
 * `undefined` when this process is not configured to run agents, a provisioner when it is.
 *
 * The **refusal** case is the interesting one: a half-configured process throws at composition,
 * which is TD-028 decision 7's *"a worker configured with a launcher it cannot reach says so by
 * name at composition"*. It is a throw and not a warning because the two halves are one setting: a
 * URL with no token produces a launcher that refuses every request, and the operator would see that
 * as "the launcher is broken" rather than as "I forgot a variable".
 */
export const composeRunWorkspaces = (
  options: ComposeRunWorkspacesOptions,
): runnerAdapters.RunWorkspaceProvisioner | undefined => {
  const url = options.launcherUrl;
  const token = options.launcherToken;
  if (url === null && token === null) {
    return undefined;
  }
  if (url === null || token === null) {
    throw new Error(
      `invalid server configuration: ${url === null ? 'APP_LAUNCHER_TOKEN is set but APP_LAUNCHER_URL is not' : 'APP_LAUNCHER_URL is set but APP_LAUNCHER_TOKEN is not'}; the launcher control plane needs both (TD-028) and one of them alone runs no agent while looking as if it would`,
    );
  }
  options.logger.info(
    {
      launcher_url: url,
      control_root: options.controlRoot,
      model_egress_hosts: options.modelEgressHosts,
    },
    'this process runs agent stages: it provisions run workspaces through the launcher control plane',
  );
  return launcherAdapters.createLauncherRunWorkspaceProvisioner({
    client: launcherAdapters.createLauncherControlClient({
      baseUrl: url,
      token,
      logger: options.logger,
    }),
    projects: createRunWorkspaceProjectSource(options.pool),
    controlRoot: options.controlRoot,
    modelEgressHosts: options.modelEgressHosts,
    credentialTtlSeconds: RUN_CREDENTIAL_TTL_SECONDS,
    clock: runnerAdapters.systemClock,
    logger: options.logger,
  });
};
