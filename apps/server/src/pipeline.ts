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
 * ## What this build composes, and the one thing it still cannot (WP-15b)
 *
 * **The audit sink and the idempotency store are built here, from the pool, and no caller may
 * supply them.** WP-15a took both as an argument because `integration_actions` had no
 * `project_id`, `redaction_count` or `attempts` column and nothing implemented the ports; migration
 * `0013` and `@platform/infrastructure`'s `integrations/` adapters closed that, and the argument
 * went with it. An audit sink a caller may omit is one that is absent in production (standing rule
 * 31), and a required field only proves it was *supplied* (rule 35) — so the e2e tier now asserts
 * the `integration_actions` rows **this** function's adapter wrote.
 *
 * **`ClaudeRunner` is still missing and is named rather than defaulted.** WP-12 built the runner and
 * WP-14 the launcher, and there is no transport between them: `apps/launcher` is its own container
 * (TD-021) and the RPC surface is **Q52**, deliberately unbuilt. {@link unavailableClaudeRunner} is
 * what a process gets instead, and it is a **refusal**, not a default: `start()` throws
 * {@link RunnerUnavailableError} naming Q52, so an agent stage fails loudly in its own job. It
 * deliberately does not fabricate a failed `RunOutcome` — that would make the pipeline record
 * `run.failed` and transition on a verdict for a run that never happened, which is the fail-*open*
 * direction (standing rule 20).
 *
 * The rest of the pipeline — intake, gates, status mapping, the workpad, every outbound provider
 * call — runs, and every one of those calls is now audited. That is why the pipeline is composed
 * unconditionally and `/readyz` can finally read `ok` on `ROLE=all`: a process that registers every
 * handler `EVENT_CONSUMPTION` declares consumed is a complete consumer, which is the only question
 * `sweepReadiness` asks.
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
  integrations as integrationAdapters,
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

/** Thrown by {@link unavailableClaudeRunner}: this build has no transport to the launcher (Q52). */
export class RunnerUnavailableError extends Error {
  override readonly name = 'RunnerUnavailableError';

  constructor(stage: string | null) {
    super(
      `no ClaudeRunner is composed in this build, so stage ${JSON.stringify(stage ?? 'unknown')} cannot run an agent: apps/launcher is a separate container (TD-021) and the runner-to-launcher transport is Q52, deliberately unbuilt. Every other part of the pipeline runs and is audited; pass StartRuntimeOptions.pipeline.runner to supply one.`,
    );
  }
}

/**
 * The runner a process gets when nothing supplies one.
 *
 * A **refusal**, not a null object: `start()` throws, so the `stage.execute` job fails with a named
 * error instead of the pipeline being handed a fabricated outcome it would transition on. The cost
 * is stated rather than hidden — a task that reaches an agent stage stops there, visibly, and
 * nothing downstream is told the run "failed" as though it had been attempted.
 */
export const unavailableClaudeRunner = (): ClaudeRunner => ({
  start: (spec) => {
    throw new RunnerUnavailableError(spec.stage ?? null);
  },
});

/**
 * What a caller may still put into this composition — and what it may not.
 *
 * Nothing here is an audit or a redaction collaborator any more: those are built below, from the
 * pool, because an optional security dependency is an absent one (standing rule 31) and because a
 * test that supplies its own audit sink proves nothing about the production one (rule 35).
 */
export interface PipelineComposition {
  /**
   * Replaces {@link unavailableClaudeRunner}. Absent is the state `main.ts` and `pnpm dev` are in
   * until Q52 is answered.
   */
  readonly runner?: ClaudeRunner;
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
  const ids = { next: (): Id => randomUUID() as Id };

  /**
   * BD-003's audit sink, built here and **not** accepted from a caller (standing rule 31/35).
   *
   * It owns the `UnitOfWork` because the row and its `integration.action.performed` / `.failed`
   * event have to commit together, and the read side because it allocates the integration stream's
   * sequence before opening that transaction — the envelope a `NormalisedEvent` deliberately stops
   * short of. `postgres-audit-log.ts` carries the reasoning and the conflict retry.
   */
  const auditLog = integrationAdapters.createPostgresIntegrationAuditLog({
    unitOfWork: options.eventing.unitOfWork,
    eventStore: options.eventing.store,
    ids,
    logger: options.logger,
  });

  const executor = createIntegrationActionExecutor({
    auditLog,
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
    /**
     * Also unconditional. WP-07 made the executor's option optional and nothing ever supplied one,
     * so until this line every retried job re-performed a mutation the provider had already seen.
     *
     * **What no test covers, said here rather than left to be assumed** (standing rules 3, 11): the
     * *adapter* has a shared contract suite against the fake and against PostgreSQL, and *this line*
     * has nothing — deleting it leaves every tier green. No pipeline action ships an
     * `IdempotencyPlan` (`packages/integrations/src/providers/slack/digest.ts` is the only one in
     * the repository, and Slack is not in the shipped registry), so there is no call to replay and
     * nothing to observe. The work package that gives a pipeline action an idempotency key owns the
     * assertion; the backlog carries it.
     */
    idempotencyStore: integrationAdapters.createPostgresIdempotencyStore({ sql: options.pool }),
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
      runner: composition.runner ?? unavailableClaudeRunner(),
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
