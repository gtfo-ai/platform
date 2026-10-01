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
 * ## It mints the run's git credential (WP-76)
 *
 * TD-028's WP-76 amendment, closing PROGRESS backlog 133: the launcher cannot mint — it holds no
 * binding, no secret key and no database — so **this process** does, in
 * {@link createRunGitCredentialMinter}: the project's git binding through the binding loader, the
 * mint and the revoke through `IntegrationActionExecutor` (`runCredentialWrites`), the scope the
 * spec's (`read` for a read-only run, `push` otherwise) and `read` for any run of a **shadow** task
 * (Q98 (a)). The value is registered with the process's run-scoped secrets the moment it exists, so
 * the transcript, the artifact and every audit row this process writes redact it (decision 8).
 *
 * ## It constructs no Docker client
 *
 * Everything here is a `fetch` and a Unix socket. `apps/launcher/src/docker-access.test.ts` reads
 * every tracked source off disk and would fail if that changed, which is what makes TD-021's
 * "exactly one component reaches the daemon" a checkable property of this repository rather than a
 * sentence in a decision record.
 */
import type {
  Logger,
  OrphanWorkspaceReaper,
  PipelineIntegrationsPort,
  RunScopedSecrets,
  RunSpec,
  UnitOfWork,
} from '@platform/application';
import {
  integrationsForProject,
  mintingIntegrationFor,
  noRunScopedSecrets,
  RUN_CREDENTIAL_TTL_SECONDS,
  runCredentialRevocations,
  runCredentialWrites,
  runGitCredentialSecretName,
  startOrphanWorkspaceReaper,
} from '@platform/application';
import { taskModeSchema } from '@platform/contracts';
import {
  launcher as launcherAdapters,
  recovery as recoveryAdapters,
  runner as runnerAdapters,
  workspace as workspaceAdapters,
} from '@platform/infrastructure';
import type pg from 'pg';
import type { Metrics } from './metrics.js';
import {
  createProjectIntegrationsPort,
  type IntegrationStack,
  repositoryPathOf,
} from './pipeline.js';

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

/**
 * The run's git credential, minted through the executor — TD-028's WP-76 amendment, decisions 1,
 * 2, 5, 7 and 8, composed.
 *
 * `tasks.mode` is read here rather than taken from `RunSpec.mode`, which is the run's richer mode
 * (`review_only`, `discovery`, …): the executor's shadow guard is about the **task**, and decision 1
 * says so. A shadow task's run is minted `read` whatever the spec asks, because a shadow task must
 * never push (Q98 (a) — a `read` mint is the one mutation the executor lets it perform). The
 * provisioner accepts that narrower answer for a writing spec and would refuse a wider one.
 *
 * Both calls resolve their integration per call (Q55): the revoke's scope carries the run's own
 * credential as a run-scoped secret, so an error a provider returns on revocation is redacted. The
 * mint goes through the project's git binding; the revoke through the integration that minted,
 * whether or not the project still binds it (TD-028 decision 10, WP-80).
 */
export const createRunGitCredentialMinter = (options: {
  readonly pool: pg.Pool;
  readonly integrations: PipelineIntegrationsPort;
  readonly runSecrets: RunScopedSecrets;
}): launcherAdapters.RunGitCredentialMinter => {
  /** `integrations.retired_at` as text, or `null` for a live (or absent) row — WP-114. */
  const retiredAtOf = async (integrationId: string): Promise<string | null> => {
    const { rows } = await options.pool.query<{ retired_at: Date | null }>(
      'select retired_at from integrations where id = $1',
      [integrationId],
    );
    const at = rows[0]?.retired_at ?? null;
    return at === null ? null : new Date(at).toISOString();
  };
  return {
    mint: async ({ spec, project, scope, ttlSeconds }) => {
      const { rows } = await options.pool.query<{ mode: string }>(
        'select mode from tasks where id = $1',
        [spec.taskId],
      );
      if (rows[0] === undefined) {
        throw new Error(
          `task ${spec.taskId} has no row, so run ${spec.runId}'s credential cannot be minted under its mode`,
        );
      }
      const mode = taskModeSchema.parse(rows[0].mode);
      const context = {
        runId: spec.runId,
        taskId: spec.taskId,
        projectId: spec.projectId,
        mode,
      };
      const minted = await runCredentialWrites(
        await integrationsForProject(options.integrations, spec.projectId, noRunScopedSecrets()),
        // WP-114, backlog 386: read after the mint's audit row committed, on the pool (no open
        // transaction), so a retire that committed first is seen and the token is revoked in hand.
        { isRetired: async (integrationId) => (await retiredAtOf(integrationId)) !== null },
      ).mint({
        ...context,
        scope: mode === 'shadow' ? 'read' : scope,
        branchPatterns: project.branchPatterns,
        ttlSeconds,
      });
      if (minted.kind === 'unavailable') {
        return minted;
      }
      const { credential, handle } = minted;
      const revoke = async (): Promise<void> => {
        // TD-028 decision 10 (WP-80): through the integration that **minted**, bound or not — a
        // project unbound or re-bound while the run was live still has the token revoked on the host
        // that issued it. The value itself is the call's run-scoped secret, not a registry lookup: the
        // revocation's own scope must name the token whatever the registry holds by then (WP-76
        // review round 2).
        const minting = await mintingIntegrationFor(options.integrations, handle.integrationId, {
          runScopedSecrets: [
            { name: runGitCredentialSecretName(spec.runId), value: credential.value },
          ],
        });
        if (minting === null) {
          // A retired integration is answered `null` too (WP-114); say which it is (backlog 386).
          const retiredAt = await retiredAtOf(handle.integrationId);
          throw new Error(
            retiredAt === null
              ? `the integration ${handle.integrationId} that minted run ${spec.runId}'s credential no longer exists, so there is no host its address may be sent to; it lives until ${credential.expiresAt} (TD-028 decision 10, PROGRESS backlog 156)`
              : `the integration ${handle.integrationId} that minted run ${spec.runId}'s credential was retired at ${retiredAt} and its credentials are deleted, so nothing can revoke it; it lives until ${credential.expiresAt} (delete it at the provider; PROGRESS backlog 386)`,
          );
        }
        await runCredentialRevocations(minting).revoke(handle, context);
      };
      // Before anything else can see it: from this line every redactor over the registry replaces it.
      // It cannot refuse here: the registry's one refusal is a value shorter than `MIN_SECRET_LENGTH`,
      // and `runCredentialWrites.mint` has already refused — and revoked — such a value before
      // returning (review round 2 deleted an untested revoke that this line could never reach).
      options.runSecrets.add(spec.runId, credential.value, credential.expiresAt);
      return {
        kind: 'minted',
        credential: {
          // GitLab: "any non-blank value as a username"; a provider that names none gets one.
          username: credential.username ?? 'agentic',
          password: credential.value,
          scope: credential.scope,
          expiresAt: credential.expiresAt,
          revoke,
        },
      };
    },
  };
};

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
  /** `APP_RUN_REGISTRY_HOSTS` (WP-82): empty is closed. */
  readonly runRegistryHosts: readonly string[];
  /**
   * The process's one integration stack (WP-76). The run's git credential is minted through its
   * executor against the project's git binding, and registered with **its** `runSecrets` — the
   * registry its executor, its loaders and the artifact write redact with. Taken whole rather than
   * as a loader and a registry, so the two cannot come from different places (review round 2).
   */
  readonly stack: IntegrationStack;
  /** `APP_SECRET_KEY` — the binding loader decrypts the git binding's credential with it. */
  readonly secretKey: string;
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
      run_registry_hosts: options.runRegistryHosts,
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
    credentials: createRunGitCredentialMinter({
      pool: options.pool,
      integrations: createProjectIntegrationsPort({
        pool: options.pool,
        secretKey: options.secretKey,
        stack: options.stack,
      }),
      runSecrets: options.stack.runSecrets,
    }),
    controlRoot: options.controlRoot,
    modelEgressHosts: options.modelEgressHosts,
    runRegistryHosts: options.runRegistryHosts,
    credentialTtlSeconds: RUN_CREDENTIAL_TTL_SECONDS,
    clock: runnerAdapters.systemClock,
    logger: options.logger,
  });
};

export interface ComposeOrphanWorkspaceReaperOptions {
  readonly launcherUrl: string | null;
  readonly launcherToken: string | null;
  readonly unitOfWork: UnitOfWork;
  /**
   * `APP_INTAKE_RECONCILE_INTERVAL_MS` — the recovery pass's interval and grace, reused rather than
   * given a knob of its own: one interval for every recovery row (`recovery/stranded.ts`), and `0`
   * switches this off with the rest.
   */
  readonly intervalMs: number;
  readonly metrics: Pick<Metrics, 'orphanRunWorkspaces'>;
  readonly logger: Logger;
}

/**
 * The runner-side reaper of TD-028 decision 12 (WP-103, PROGRESS backlog 286), or `null` when this
 * process has no launcher to ask — it is composed exactly where {@link composeRunWorkspaces}
 * composes a provisioner, because the launcher client is the thing it needs and only a process
 * configured to run agents holds one. A half configuration was already refused there.
 *
 * Its own client rather than the provisioner's: the provisioner exposes no client, and a second
 * `fetch` wrapper over the same URL and token costs nothing and keeps the provisioner's surface what
 * it was. `packages/application/src/recovery/orphan-workspaces.ts` carries the decision.
 */
export const composeOrphanWorkspaceReaper = (
  options: ComposeOrphanWorkspaceReaperOptions,
): OrphanWorkspaceReaper | null => {
  if (options.launcherUrl === null || options.launcherToken === null) {
    return null;
  }
  const client = launcherAdapters.createLauncherControlClient({
    baseUrl: options.launcherUrl,
    token: options.launcherToken,
    logger: options.logger,
  });
  const reaper = startOrphanWorkspaceReaper({
    inventory: {
      list: async () => (await client.listRuns()).runs,
      destroy: async (runId) => client.destroyRun(runId),
    },
    store: recoveryAdapters.createPostgresOrphanWorkspaceRunStore(),
    unitOfWork: options.unitOfWork,
    clock: runnerAdapters.systemClock,
    intervalMs: options.intervalMs,
    metrics: {
      reaped: (reason) => options.metrics.orphanRunWorkspaces.inc({ outcome: `removed_${reason}` }),
      failed: () => options.metrics.orphanRunWorkspaces.inc({ outcome: 'remove_failed' }),
    },
    logger: options.logger,
  });
  options.logger.info(
    { interval_ms: options.intervalMs, armed: reaper !== null },
    reaper === null
      ? 'the orphaned-workspace pass is off: APP_INTAKE_RECONCILE_INTERVAL_MS is 0, so a run workspace no process owns is not removed (PROGRESS backlog 286)'
      : 'the orphaned-workspace pass is armed: run workspaces the launcher labelled for a run that has ended, or for no run at all, are removed (WP-103)',
  );
  return reaper;
};
