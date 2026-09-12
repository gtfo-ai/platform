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
 * **The agent runner is composed when it *can* be, and refuses by name when it cannot** (WP-15g,
 * Q59(b)). `composeAgentRunner` (`./agent.ts`) builds the real `createClaudeRunner` — the adapter
 * over the SDK's own `query()` — with the production transcript sink, the unattended approvals port
 * and a per-run injected-secret redactor, over a {@link PipelineComposition.workspaces} provisioner.
 * That provisioner is **absent by default**, because reaching a run container needs the
 * `platform-launcher` container and this build has no transport to it (Q52) — and TD-021's WP-15g
 * amendment forbids *this* process from holding a Docker client, so it may not simply build one.
 *
 * When it is absent the process gets {@link unavailableClaudeRunner}, which is a **refusal**, not a
 * default: `start()` throws {@link RunnerUnavailableError}, so an agent stage fails loudly in its own
 * job and `stage-executor.ts` escalates the task. It deliberately does not fabricate a failed
 * `RunOutcome` — that would make the pipeline record `run.failed` and transition on a verdict for a
 * run that never happened, which is the fail-*open* direction (standing rule 20).
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
  IntegrationActionExecutor,
  IntegrationAuditLog,
  Jobs,
  Logger,
  PipelineRuntime,
  PlatformToolPort,
  ProjectSettings,
  ProjectSettingsPort,
  WebhookIngress,
} from '@platform/application';
import {
  costHandlers,
  createBudgetGuard,
  createContextPackAssembler,
  createIntegrationActionExecutor,
  createPipelineRuntime,
  createRunStopReasons,
  createStageRunPlanner,
  createWebhookIngress,
  defaultProjectSettings,
  startIntakeReconciliation,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import type { ConfigValues } from '@platform/domain';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import type {
  eventing as eventingAdapters,
  jobs as jobsAdapters,
  runner as runnerAdapters,
} from '@platform/infrastructure';
import {
  cost as costAdapters,
  integrations as integrationAdapters,
  knowledge as knowledgeAdapters,
  pipeline as pipelineAdapters,
  redaction as redactionAdapters,
  secrets as secretAdapters,
} from '@platform/infrastructure';
import type { IntegrationRegistry } from '@platform/integrations';
import {
  createInboundIntegrationLoader,
  createPipelineIntegrationsLoader,
  createPipelineProviderRegistry,
  type PipelineProviderRegistryOptions,
} from '@platform/integrations';
import { ROLE_PROMPTS } from '@platform/prompts';
import type pg from 'pg';
import { agentRunEnvironment, composeAgentRunner } from './agent.js';
import { composePlatformTools } from './platform-tools.js';

/** Thrown by {@link unavailableClaudeRunner}: this build has no transport to the launcher (Q52). */
export class RunnerUnavailableError extends Error {
  override readonly name = 'RunnerUnavailableError';

  constructor(stage: string | null) {
    super(
      `no ClaudeRunner is composed in this process, so stage ${JSON.stringify(stage ?? 'unknown')} cannot run an agent. It is a configuration state, not a missing feature: a run needs a workspace provisioner, which needs the platform-launcher container (Q52's transport), and TD-021 forbids this process from holding a Docker client of its own. The startup log names which piece is missing. Every other part of the pipeline runs and is audited.`,
    );
  }
}

/**
 * The runner a process gets when its configuration cannot produce one.
 *
 * A **refusal**, not a null object: `start()` throws, so the stage ends with a named error instead
 * of the pipeline being handed a fabricated outcome it would transition on.
 *
 * **It stays, and it is conditional on configuration rather than on the build** — Q59(b), decided on
 * WP-15g. A process with a workspace provisioner (and, in `api` mode, a model credential) composes
 * the real runner; a process without one composes this and logs which piece is missing, and still
 * runs the gates, the status mapping, the workpad and every outbound provider call. Refusing to
 * compose the pipeline at all would be louder and would stop the part of the loop that works without
 * an agent.
 *
 * **Where the throw lands is WP-15c's answer to the question WP-15b left** (Q59): until that work
 * package it landed nowhere — transaction 1 had already created the `runs` row, so the run stayed
 * `running` for ever and the task sat at a stage nothing would move, with the failure visible only in
 * pg-boss. `stage-executor.ts` now catches it, fails the run it created and escalates the task to
 * `needs_human`. A task parked on a throwing job therefore needs **no state of its own**: the state
 * that means *a human must act* already exists, and a new one would be a third spelling of "stuck"
 * that no template, query or screen knows. Since WP-15g that catch also asks whether the failure was
 * a *transport* one and retries a bounded number of times if it was (Q59(a)) — this error is not:
 * a missing collaborator is terminal, because the next attempt would find it missing too.
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
   *
   * A **factory over the platform tools**, not a runner, since WP-17: `createClaudeRunner` takes a
   * `PlatformToolPort`, so the only way `kb_search` reaches a run is for whoever builds the runner
   * to be handed the port this file composed. Passing a ready-made runner instead would leave the
   * tools with no consumer, which is precisely the shape PROGRESS backlog 11 is about.
   */
  readonly runner?: (tools: PlatformToolPort) => ClaudeRunner;
  /**
   * The run workspace provisioner (WP-15g): what turns a `RunSpec` into a process the SDK can spawn
   * and a workspace that is freed on every ending.
   *
   * **This is the seam that decides whether a process runs agents at all**, and it is absent in every
   * production path today: provisioning needs the `platform-launcher` container, the transport to it
   * is Q52, and TD-021's WP-15g amendment forbids this process from constructing a Docker client
   * instead. Absent therefore composes {@link unavailableClaudeRunner} and logs which piece is
   * missing (Q59(b)).
   *
   * It is also the seam the e2e tier uses, and that is the point rather than a convenience: a
   * provisioner whose `spawn` is WP-12's fake CLI leaves **everything else** — the real
   * `createClaudeRunner`, the real SDK `query()`, the real transcript sink, the real redactor — as
   * production code, so the tier can assert that the ticket's own words reached the bytes the CLI
   * received. {@link PipelineComposition.runner} cannot: it replaces the runner itself, which is
   * exactly the assertion `FakeClaudeRunner` can never fail (standing rule 82).
   */
  readonly workspaces?: runnerAdapters.RunWorkspaceProvisioner;
  /**
   * Wraps the `Jobs` the pipeline enqueues through — a **labelled seam**, and the only caller is
   * the e2e tier (WP-15c).
   *
   * `HandlerContext.afterCommit` is at-most-once (TD-004), so a process that dies between the
   * intake handler's commit and its enqueue leaves a matched ticket with no task row and nothing
   * that starts it (PROGRESS backlog 20). There is no other way to ask a running instance "what
   * happens when that wake-up is lost?", and the answer is the whole of this work package's last
   * acceptance criterion — so the loss is reproduced by dropping the enqueue rather than by
   * killing a process at a microsecond boundary, which is the same loss and is deterministic.
   *
   * Nothing in production passes it: `startRuntime()` with no options composes the real `Jobs`.
   */
  readonly jobs?: (jobs: Jobs) => Jobs;
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
  /**
   * How often the intake reconciliation runs, and the age a match must reach before it is
   * re-emitted (`APP_INTAKE_RECONCILE_INTERVAL_MS`). `0` starts no pass at all.
   */
  readonly intakeReconcileIntervalMs: number;
  /** Built once per process by {@link composeIntegrationStack}; the ingress shares it. */
  readonly stack: IntegrationStack;
  /**
   * What a run is given of the model provider (BD-004, TD-021 phase 1): the provider mode, the model
   * credential that becomes a `RunSpec.env` entry named in `secretEnvNames`, and the `local`-mode
   * binary path. Read from `ServerConfig` by the composition root.
   */
  readonly agent: {
    readonly providerMode: 'api' | 'local';
    readonly modelApiKey: string | null;
    readonly claudeBinary: string | null;
  };
  readonly logger: Logger;
}

/**
 * The one executor, the one audit sink and the one provider registry a process has.
 *
 * It is built here rather than inside {@link composePipeline} because the **webhook ingress needs
 * the same three** — a provider adapter is built through its registration whichever direction the
 * call goes — and two executors in one process would mean two idempotency stores and two
 * rate-limit budgets for one account, which is the defect `shipped-registry.ts` already records for
 * Jira's inner executor. One per process, shared.
 */
export interface IntegrationStack {
  readonly executor: IntegrationActionExecutor;
  readonly registry: IntegrationRegistry;
  readonly auditLog: IntegrationAuditLog;
}

export interface ComposeIntegrationStackOptions {
  readonly pool: pg.Pool;
  readonly eventing: ReturnType<typeof eventingAdapters.createEventing>;
  readonly registry?: (options: PipelineProviderRegistryOptions) => IntegrationRegistry;
  readonly logger: Logger;
}

export const composeIntegrationStack = (
  options: ComposeIntegrationStackOptions,
): IntegrationStack => {
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
     * **It is load-bearing since WP-15d, and asserted** (standing rules 3, 11, 35). The note here
     * used to say the opposite and was right at the time: no pipeline action shipped an
     * `IdempotencyPlan`, so deleting this line left every tier green. The two ticket writes now
     * carry one, keyed by the event that caused the wake-up, because they are made from a
     * `pipeline.outbound` job and a job is at-least-once. The test that re-delivers one wake-up
     * through this process's own `Jobs` adapter and reads the production audit log back is
     * `test/e2e/pipeline/outbound-shape.e2e.test.ts` › *"replays the ticket write out of the idempotency store this instance composed"*
     * — deleting this line fails it (measured: the `replayed` row never appears).
     */
    idempotencyStore: integrationAdapters.createPostgresIdempotencyStore({ sql: options.pool }),
  });

  const registryOf = options.registry ?? createPipelineProviderRegistry;
  return { executor, auditLog, registry: registryOf({ executor, clock: { now: nowIso } }) };
};

/**
 * The webhook ingress (WP-15c) — the thing that makes production start a ticket.
 *
 * It shares the process's {@link IntegrationStack}, because a provider adapter is built through its
 * registration whichever direction the call goes, and takes the **inbound** loader: the URL names
 * an account, and which projects a delivery is about is a question for that account's bindings.
 */
export interface ComposeWebhookIngressOptions {
  readonly pool: pg.Pool;
  readonly eventing: ReturnType<typeof eventingAdapters.createEventing>;
  /** `APP_SECRET_KEY`, already validated by `config.ts`. */
  readonly secretKey: string;
  readonly stack: IntegrationStack;
  readonly logger: Logger;
}

export const composeWebhookIngress = (options: ComposeWebhookIngressOptions): WebhookIngress =>
  createWebhookIngress({
    loader: createInboundIntegrationLoader({
      repository: secretAdapters.createPostgresBindingRepository(options.pool),
      secrets: secretAdapters.createPostgresSecretStore({
        sql: options.pool,
        key: secretAdapters.deriveSecretKey(options.secretKey),
      }),
      registry: options.stack.registry,
      // TD-012 step 2, beside the account's own exact-match redactor. The delivery is written to
      // `inbox(headers, payload)`, which migration 0014 explains is why.
      platformRedactor: redactionAdapters.patternRedactor(),
    }),
    inbox: integrationAdapters.createPostgresInboxStore({ sql: options.pool }),
    audit: integrationAdapters.createPostgresInboundAuditLog({ sql: options.pool }),
    identities: integrationAdapters.createPostgresIdentityDirectory({ sql: options.pool }),
    unitOfWork: options.eventing.unitOfWork,
    eventStore: options.eventing.store,
    ids: { next: (): Id => randomUUID() as Id },
    clock: { now: nowIso },
    timer: { now: () => Date.now() },
    logger: options.logger,
  });

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
  /**
   * What this process could not compose for an agent run, by name, or empty when it composed one.
   *
   * Returned rather than only logged so `/readyz`'s neighbours and the e2e tier can read the same
   * answer the log line carries; `runtime.ts` is what warns on it.
   */
  readonly agentMissing: readonly string[];
  /**
   * The nine in-process MCP tools this process composed, exposed so a caller can see what a run
   * would be given. `kb_search` is real; the other eight refuse and say why
   * (`./platform-tools.ts`).
   */
  readonly platformTools: PlatformToolPort;
  stop(): Promise<void>;
}

export const composePipeline = async (
  options: ComposePipelineOptions,
): Promise<ComposedPipeline> => {
  const { composition, stack } = options;
  const ids = { next: (): Id => randomUUID() as Id };
  const { executor, registry } = stack;
  /**
   * The labelled seam of {@link PipelineComposition.jobs}, applied once and used everywhere below,
   * so that a test disarming an enqueue disarms the same object the pipeline really enqueues
   * through. Absent — every production path — is the identity.
   */
  const jobs = composition.jobs === undefined ? options.jobs : composition.jobs(options.jobs);

  const integrations = createPipelineIntegrationsLoader({
    repository: secretAdapters.createPostgresBindingRepository(options.pool),
    secrets: secretAdapters.createPostgresSecretStore({
      sql: options.pool,
      key: secretAdapters.deriveSecretKey(options.secretKey),
    }),
    registry,
    executor,
    // TD-012 step 2, beside each binding's own exact-match redactor — the same line
    // `composeWebhookIngress` passes, and now for the second sink: WP-15f writes the ticket's text
    // to `tasks.ticket_snapshot`, which is read into every prompt. No task DTO serves it yet.
    platformRedactor: redactionAdapters.patternRedactor(),
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
  /**
   * The cost ledger (WP-19), composed here so that a process which registers the pipeline registers
   * it too: `EVENT_CONSUMPTION` declares `run.finished`, `run.failed` and `artifact.created`
   * handled, and `sweepReadiness` refuses to sweep a process that cannot handle them.
   *
   * It borrows no connection of its own — both handlers run inside the dispatcher's handler
   * transaction — and the budget guard it hands the stage executor is read inside the executor's
   * own admission transaction, so `POOL_RESERVATIONS` is unchanged.
   */
  const costStore = costAdapters.createPostgresCostStore();
  const platformTools = composePlatformTools({ pool: options.pool, logger: options.logger });

  /**
   * The agent runner (WP-15g), and the one line that decides whether this process runs agents.
   *
   * `composition.runner` stays ahead of it: it is the older seam and six e2e files drive the pipeline
   * through `FakeClaudeRunner` with it. Everything else goes through `composeAgentRunner`, whose
   * refusal is a *named* list rather than a boolean.
   */
  const agent = composeAgentRunner({
    pool: options.pool,
    provisioner: composition.workspaces,
    tools: platformTools,
    providerMode: options.agent.providerMode,
    modelApiKey: options.agent.modelApiKey,
    // The SSE half of TD-007 (WP-15h): the transcript sink announces each stored entry's position
    // on the broadcast, and whichever process holds the `run:<id>` stream reads the rows back
    // (`sse/transcript-bridge.ts`). It is the same broadcast the outbox worker wakes on, so a
    // deployment that already runs one runs no second transport.
    broadcast: options.eventing.broadcast,
    logger: options.logger,
  });
  const runEnvironment = agentRunEnvironment(options.agent);

  const runtime = createPipelineRuntime({
    store: pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES }),
    settings,
    jobs,
    integrations,
    ids,
    clock: { now: nowIso },
    unitOfWork: options.eventing.unitOfWork,
    logger: options.logger,
    stageConcurrency: options.stageConcurrency,
    execution: {
      runner: composition.runner?.(platformTools) ?? agent.runner ?? unavailableClaudeRunner(),
      planner: createStageRunPlanner({
        /**
         * Where the *planner* thinks the workspace is.
         *
         * It is a placeholder and it is overwritten: a run executes inside the container, whose
         * checkout is at `/work/repo` (TD-021), and `createWorkspaceClaudeRunner` replaces this with
         * the provisioned `workdir` before the spec reaches the SDK. It cannot be computed here,
         * because the answer belongs to the workspace and there is none until a run starts. Kept as
         * a task-derived path rather than a constant so that a spec read in isolation — a test, an
         * audit row — still says which task it belonged to.
         */
        workspacePath: (taskId: Id) => `/workspaces/${taskId}`,
        // BD-004 and TD-021 phase 1: the mode decides whether `claudeCodePath` is honoured at all,
        // and the key travels as a named secret so TD-012 step 1 covers it in this run's transcript.
        providerMode: options.agent.providerMode,
        claudeCodePath: options.agent.claudeBinary,
        env: runEnvironment.env,
        secretEnvNames: runEnvironment.secretEnvNames,
        // The shipped defaults. A project's own `prompts/<stage>.md` override needs the default
        // branch read WP-18 wires, so it is absent rather than half-read (product/13).
        prompts: ROLE_PROMPTS,
        /**
         * The data-block nonce (BD-022). `randomUUID` is a CSPRNG — 122 bits — rendered as the 32
         * hex characters `NONCE_PATTERN` requires; the delimiter contract rests on a document's
         * author being unable to predict it, so this is the one collaborator here with no default
         * (standing rule 31).
         */
        nonce: { next: () => randomUUID().replaceAll('-', '') },
        contextPacks: createContextPackAssembler({
          store: new knowledgeAdapters.PostgresKnowledgeStore(options.pool),
          logger: options.logger,
        }),
        clock: { now: nowIso },
        logger: options.logger,
      }),
      stopReasons,
      // BD-010's org and project budgets, read from the projection the ledger writes. A deployment
      // with no `budgets` rows is unaffected: `applicable` matches nothing and nothing blocks.
      budgets: createBudgetGuard({ store: costStore }),
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
  for (const handler of costHandlers({
    store: costStore,
    context: (correlationId, causeEventId) => ({
      ids,
      actor: { kind: 'system', component: 'cost-ledger' },
      clock: { now: nowIso },
      correlationId,
      causeEventId,
    }),
    logger: options.logger,
  })) {
    options.eventing.bus.register(handler);
  }
  await runtime.start();

  /**
   * The recovery of PROGRESS backlog **20**, composed here beside `registerPartitionMaintenance`
   * rather than inside `createPipelineRuntime`.
   *
   * It is a maintenance schedule the *process* owns, not a step of a ticket's journey: `saga.ts`'s
   * `pipeline.intake` decides and the `pipeline.outbound` job creates the task, with
   * `HandlerContext.afterCommit` between them — which is at-most-once (TD-004) — so a process that
   * dies in that window leaves a matched ticket with **no task row**, and nothing re-emits it,
   * retries it or logs it. A pass finds those tickets and appends a **new** `ticket.matched`;
   * `packages/application/src/pipeline/intake-reconcile.ts` carries why the recovery is
   * task-shaped rather than a replay of the delivery (which `inbox(provider, delivery_id)`
   * deduplicates) or of the event (which `handler_executions` skips).
   *
   * It is one more pooled connection, counted in `POOL_RESERVATIONS.pipeline`.
   */
  const reconciler = await startIntakeReconciliation({
    store: pipelineAdapters.createPostgresIntakeReconciliationStore({ sql: options.pool }),
    eventStore: options.eventing.store,
    unitOfWork: options.eventing.unitOfWork,
    jobs,
    ids,
    clock: { now: nowIso },
    intervalMs: options.intakeReconcileIntervalMs,
    logger: options.logger,
  });
  if (reconciler === null) {
    options.logger.warn(
      { setting: 'APP_INTAKE_RECONCILE_INTERVAL_MS=0' },
      'intake reconciliation is switched off: a matched ticket whose intake enqueue is lost is never started (PROGRESS backlog 20)',
    );
  }

  return {
    runtime,
    platformTools,
    agentMissing: agent.runner === null ? agent.missing : [],
    stop: async () => {
      if (reconciler !== null) {
        await reconciler.stop();
      }
      await runtime.stop();
    },
  };
};
