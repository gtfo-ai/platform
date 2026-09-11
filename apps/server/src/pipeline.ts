/**
 * Composing the pipeline into `apps/server` — WP-15a, the binding loader nobody's work package
 * owned.
 *
 * Twenty-three work packages built a pipeline that walks a ticket from `ticket.matched` to
 * `task.completed`, and the only thing that ever composed it was a test harness:
 * `createPipelineRuntime` had no production caller and `PipelineIntegrations` had no production
 * constructor, so **nothing read the `bindings` table**. This file is that caller. Everything below
 * it is the real thing — the Postgres `PipelineStore`, the pg-boss `Jobs`, the event store's
 * `UnitOfWork`, the binding loader over `bindings`/`integrations`/`secrets`.
 *
 * ## What this build cannot compose, named rather than defaulted
 *
 * Two of the pipeline's collaborators have **no production adapter in this repository**, and a
 * default for either would be standing rule 18's shape — a configuration whose absent case quietly
 * produces a permissive result:
 *
 *  - **`ClaudeRunner`.** WP-12 built the runner and WP-14 the launcher, and there is no transport
 *    between them: `apps/launcher` is deployed as its own container (TD-021) and the RPC surface is
 *    **Q52**, deliberately unbuilt. A runner needs a workspace, so the pipeline cannot execute an
 *    agent stage without one.
 *  - **`IntegrationAuditLog` and `IdempotencyStore`.** WP-07 shipped the ports and the executor;
 *    nothing persists them. `integration_actions` (migration 0007) has no `project_id`,
 *    `redaction_count` or `attempts` column, so an adapter needs a migration as well as code.
 *
 * So {@link PipelineComposition} is **required** to start the pipeline, and a process that is not
 * given one logs which piece is missing and runs without it rather than starting a pipeline that
 * would drop every audit row on the floor. That is the fail-closed direction: no task advances,
 * loudly, instead of every task advancing unrecorded.
 *
 * ## Order
 *
 * The handlers must be registered on the bus **before** `eventing.worker.start()`, or the first
 * sweep dispatches events to a bus that has no pipeline on it and records them as handled. The
 * composition root calls this before it starts the worker, and `runtime.ts` says so where it does.
 */
import { randomUUID } from 'node:crypto';
import type {
  ClaudeRunner,
  IdempotencyStore,
  IntegrationAuditLog,
  Logger,
  PipelineRuntime,
  ProjectSettings,
  ProjectSettingsPort,
} from '@platform/application';
import {
  basicStageRunPlanner,
  createIntegrationActionExecutor,
  createPipelineRuntime,
  createRunStopReasons,
  defaultProjectSettings,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import type { ConfigValues } from '@platform/domain';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import type { eventing as eventingAdapters, jobs as jobsAdapters } from '@platform/infrastructure';
import {
  pipeline as pipelineAdapters,
  redaction as redactionAdapters,
  secrets as secretAdapters,
} from '@platform/infrastructure';
import type { IntegrationRegistry } from '@platform/integrations';
import {
  createPipelineIntegrationsLoader,
  createPipelineProviderRegistry,
  type PipelineProviderRegistryOptions,
} from '@platform/integrations';
import type pg from 'pg';

/**
 * The collaborators this build has no production adapter for.
 *
 * Required, not optional: standing rule 31 — an optional security dependency is an absent one, and
 * `auditLog` is the whole of BD-003 for outbound provider calls.
 */
export interface PipelineComposition {
  readonly runner: ClaudeRunner;
  readonly auditLog: IntegrationAuditLog;
  /**
   * Absent means **no replay protection**: a retried job re-performs a mutation the provider has
   * already seen. WP-07 made the executor's option optional and nothing has ever supplied one, so
   * saying so here is the honest form — the executor's own docblock carries the consequence.
   */
  readonly idempotency?: IdempotencyStore;
  /**
   * Replaces the shipped provider registry.
   *
   * The `e2e-fake-claude` tier registers the fakes here — which is what makes it an e2e of the
   * *loader* rather than of a provider: the rows, the decryption, the config validation and the
   * redactor composition are all production code, and only the thing on the far side of the HTTP
   * call is a double.
   */
  readonly registry?: (options: PipelineProviderRegistryOptions) => IntegrationRegistry;
}

export interface ComposePipelineOptions {
  readonly composition: PipelineComposition;
  readonly pool: pg.Pool;
  readonly eventing: ReturnType<typeof eventingAdapters.createEventing>;
  readonly jobs: ReturnType<typeof jobsAdapters.createPgBossJobs>['jobs'];
  /** `APP_SECRET_KEY`, already validated by `config.ts`. */
  readonly secretKey: string;
  readonly stageConcurrency: number;
  readonly logger: Logger;
}

const nowIso = (): IsoDateTime => new Date().toISOString() as IsoDateTime;

/**
 * The repository path a git binding is bound to, from `projects.repo_url` (technical/03).
 *
 * It lives on the **project**, not the integration: `integrations` is the account (a GitLab
 * instance serving many repositories) and `acme/api` is this project's. Parsing the URL rather than
 * reading a provider-specific config field keeps the loader provider-neutral, which is BD-017's
 * whole claim; a second provider with another notion of a project path changes this function, not
 * the pipeline.
 */
export const repositoryPathOf = (repoUrl: string): string => {
  const authority = repoUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^/@]+@/, '');
  // Two spellings reach this column, and they separate the host from the path differently:
  // `https://host/acme/api.git` and git's scp-style `host:acme/api.git`. A `:` followed by digits
  // is a port (`ssh://host:2222/acme/api`), not the scp separator — reading it as one would make
  // the repository path `2222/acme/api`.
  const slash = authority.indexOf('/');
  const colon = authority.indexOf(':');
  const scpStyle =
    colon >= 0 && (slash < 0 || colon < slash) && !/^:\d+(\/|$)/.test(authority.slice(colon));
  const start = scpStyle ? colon : slash;
  const path =
    start < 0
      ? ''
      : authority
          .slice(start + 1)
          .replace(/\.git$/i, '')
          .replace(/^\/+|\/+$/g, '');
  if (path === '') {
    throw new Error(
      `projects.repo_url ${JSON.stringify(repoUrl)} has no repository path; the git binding cannot be addressed`,
    );
  }
  return path;
};

/**
 * `ProjectSettingsPort` over `projects.config`.
 *
 * technical/03 calls that column "effective configuration … per key, which layer of the precedence
 * chain produced it", so the merge technical/12 describes has already happened by the time a row
 * exists; this reads it rather than recomputing it. The templates are the shipped three: a
 * project's own `.agentic/pipeline.yml` is read from the default branch, which needs a workspace
 * (WP-16's context work), and a template a project declared but this process could not read would
 * park every task one stage short of `done` — so it is absent rather than guessed.
 */
export const createProjectSettingsPort = (pool: pg.Pool): ProjectSettingsPort => ({
  forProject: async (projectId: Id): Promise<ProjectSettings> => {
    const { rows } = await pool.query<{ config: unknown }>(
      'select config from projects where id = $1',
      [projectId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`project ${projectId} has no row; the pipeline cannot settle its settings`);
    }
    return defaultProjectSettings(projectId, {
      templates: SHIPPED_TEMPLATES,
      config: (row.config ?? {}) as ConfigValues,
    });
  },
});

export interface ComposedPipeline {
  readonly runtime: PipelineRuntime;
  stop(): Promise<void>;
}

export const composePipeline = async (
  options: ComposePipelineOptions,
): Promise<ComposedPipeline> => {
  const { composition } = options;

  const executor = createIntegrationActionExecutor({
    auditLog: composition.auditLog,
    /**
     * TD-012 **step 2** — the gitleaks-derived pattern rules — and not `noSecretsRedactor()`.
     *
     * The executor is one per process and an exact-match redactor is per *binding*, so the two
     * halves of TD-012 land in different places by construction: step 1 is composed by the binding
     * loader and applied by the adapter that emits the string, step 2 is applied here over the
     * audit row's payload, result and error. Passing a no-op would be the defect standing rule 31
     * is named for, one ring further out than WP-11 put it.
     */
    redactor: redactionAdapters.patternRedactor(),
    timer: {
      now: () => Date.now(),
      sleep: async (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }),
    },
    clock: { now: nowIso },
    ...(composition.idempotency === undefined ? {} : { idempotencyStore: composition.idempotency }),
  });

  const registryOf = composition.registry ?? createPipelineProviderRegistry;
  const registry = registryOf({ executor, clock: { now: nowIso } });

  const integrations = createPipelineIntegrationsLoader({
    repository: secretAdapters.createPostgresBindingRepository(options.pool),
    secrets: secretAdapters.createPostgresSecretStore({
      sql: options.pool,
      key: secretAdapters.deriveSecretKey(options.secretKey),
    }),
    registry,
    executor,
    gitProjectPath: async (projectId) => {
      const { rows } = await options.pool.query<{ repo_url: string }>(
        'select repo_url from projects where id = $1',
        [projectId],
      );
      const repoUrl = rows[0]?.repo_url;
      if (repoUrl === undefined) {
        throw new Error(`project ${projectId} has no row; its repository path is unknown`);
      }
      return repositoryPathOf(repoUrl);
    },
  });

  const ids = { next: (): Id => randomUUID() as Id };
  const stopReasons = createRunStopReasons();
  const settings = createProjectSettingsPort(options.pool);

  const runtime = createPipelineRuntime({
    store: pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES }),
    settings,
    jobs: options.jobs,
    integrations,
    ids,
    clock: { now: nowIso },
    unitOfWork: options.eventing.unitOfWork,
    logger: options.logger,
    stageConcurrency: options.stageConcurrency,
    execution: {
      runner: composition.runner,
      planner: basicStageRunPlanner({
        workspacePath: (taskId) => `/workspaces/${taskId}`,
      }),
      stopReasons,
      context: (correlationId) => ({
        ids,
        actor: { kind: 'system', component: 'pipeline' },
        clock: { now: nowIso },
        correlationId,
        causeEventId: null,
      }),
    },
  });

  for (const handler of runtime.handlers) {
    options.eventing.bus.register(handler);
  }
  await runtime.start();

  return { runtime, stop: async () => runtime.stop() };
};
