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
 * That provisioner is **absent unless this process is configured to reach the launcher** —
 * `APP_LAUNCHER_URL` and `APP_LAUNCHER_TOKEN`, TD-028's control plane, built at WP-53
 * (`apps/server/src/workspaces.ts`). TD-021's WP-15g amendment forbids *this* process from holding a
 * Docker client, so it may not simply build one instead.
 *
 * When it is absent the process gets {@link unavailableClaudeRunner}, which is a **refusal**, not a
 * default: `start()` throws {@link RunnerUnavailableError}. Since WP-53 it is also a throw that such
 * a process should not reach, because it no longer subscribes `stage.execute` or `task.ask` (TD-028
 * decision 5) and those jobs queue for a process that can perform them. The refusal stays for the
 * paths that bypass the queue. It deliberately does not fabricate a failed
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
import { hostname } from 'node:os';
import type {
  ClaudeRunner,
  IntegrationActionExecutor,
  IntegrationAuditLog,
  Jobs,
  LiveRuns,
  Logger,
  PipelineIntegrationsPort,
  PipelineRuntime,
  PlatformToolPort,
  ProjectSettings,
  ProjectSettingsPort,
  RunScopedSecrets,
  SecretRedactor,
  WebhookIngress,
  WorkingCalendar,
} from '@platform/application';
import {
  composeSecretRedactors,
  costHandlers,
  createAskRunPlanner,
  createBudgetGuard,
  createContextPackAssembler,
  createDeadLetterEscalation,
  createIntegrationActionExecutor,
  createIntegrationEgressPolicy,
  createLateCostRecorder,
  createPipelineRuntime,
  createRunScopedSecrets,
  createRunStopReasons,
  createStageRunPlanner,
  createWebhookIngress,
  defaultProjectSettings,
  humanTimeHandlers,
  RUN_CREDENTIAL_TTL_SECONDS,
  registerMaintenanceSchedule,
  runCredentialRecoveryHorizonMs,
  runLimitsDefaults,
  silentLogger,
  startIntakeReconciliation,
  statsHandlers,
} from '@platform/application';
import type { Id, IsoDateTime, MaterialisedAutonomy } from '@platform/contracts';
import { materialisedAutonomySchema } from '@platform/contracts';
import type { ConfigValues } from '@platform/domain';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import type {
  eventing as eventingAdapters,
  jobs as jobsAdapters,
  runner as runnerAdapters,
} from '@platform/infrastructure';
import {
  ask as askAdapters,
  bootstrap as bootstrapAdapters,
  cost as costAdapters,
  dependencies as dependencyAdapters,
  humanTime as humanTimeAdapters,
  integrations as integrationAdapters,
  knowledge as knowledgeAdapters,
  maintenance as maintenanceAdapters,
  notify as notifyAdapters,
  pipeline as pipelineAdapters,
  recovery as recoveryAdapters,
  redaction as redactionAdapters,
  secrets as secretAdapters,
  shadow as shadowAdapters,
  stats as statsAdapters,
} from '@platform/infrastructure';
import type { IntegrationRegistry } from '@platform/integrations';
import {
  createBoundSkillsReader,
  createInboundIntegrationLoader,
  createPipelineIntegrationsLoader,
  createPipelineProviderRegistry,
  type PipelineProviderRegistryOptions,
} from '@platform/integrations';
import { PLATFORM_SKILLS, ROLE_PROMPTS } from '@platform/prompts';
import type pg from 'pg';
import { agentRunEnvironment, composeAgentRunner } from './agent.js';
import { composePlatformTools } from './platform-tools.js';

/**
 * Who this process is, for the run lease it holds while a stage executes (WP-47, `lease.ts`).
 *
 * Unique among **live** processes rather than stable across restarts, which is what the lease needs
 * and the opposite of what a stable id would give: a restarted process must not inherit the lease
 * its predecessor held, or the run that predecessor was driving would never be swept. Hostname for
 * the operator reading the column, a random suffix so two containers on one host cannot collide.
 */
export const RUN_LEASE_OWNER = `${hostname()}:${randomUUID().slice(0, 8)}`;

/** `Actor.component` on everything the run-lease sweep writes; it appears in the run's own log. */
export const RUN_LEASE_SWEEP_COMPONENT = 'pipeline.run-lease.sweep';

/** Thrown by {@link unavailableClaudeRunner}: this process is configured to run no agent (TD-028). */
export class RunnerUnavailableError extends Error {
  override readonly name = 'RunnerUnavailableError';

  constructor(stage: string | null) {
    super(
      `no ClaudeRunner is composed in this process, so stage ${JSON.stringify(stage ?? 'unknown')} cannot run an agent. It is a configuration state, not a missing feature: a run needs a workspace provisioner, which needs APP_LAUNCHER_URL and APP_LAUNCHER_TOKEN pointing at the platform-launcher container (TD-028), because TD-021 forbids this process from holding a Docker client of its own. The startup log names which piece is missing. Every other part of the pipeline runs and is audited.`,
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
   * Replaces {@link unavailableClaudeRunner}. Absent is the state `pnpm dev` is in unless an
   * operator points it at a launcher; since WP-53 `startRuntime` composes a real one from
   * `APP_LAUNCHER_URL` and `APP_LAUNCHER_TOKEN` (`apps/server/src/workspaces.ts`).
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
   * **This is the seam that decides whether a process runs agents at all.** Since WP-53 a production
   * path fills it: `composeRunWorkspaces` builds one over TD-028's control plane when
   * `APP_LAUNCHER_URL` and `APP_LAUNCHER_TOKEN` are both set, which in the shipped compose topology
   * is the `runner` service and deliberately not `app`. TD-021's WP-15g amendment is why it is a
   * provisioner and not a `WorkspaceProvider`: this process may not construct a Docker client.
   * Absent composes {@link unavailableClaudeRunner}, logs which piece is missing (Q59(b)) and
   * subscribes neither agent-run queue.
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
   * Wraps the `Jobs` **this whole process** enqueues through — a **labelled seam**, and the only
   * caller is the e2e tier (WP-15c, widened at WP-36).
   *
   * `HandlerContext.afterCommit` is at-most-once (TD-004), so a process that dies between a
   * commit and its enqueue leaves a row nothing will ever move: a matched ticket with no task
   * (PROGRESS backlog 20), a history bootstrap stuck at `collecting` (101), a question `pending`
   * for ever (84). There is no other way to ask a running instance *"what happens when that
   * wake-up is lost?"*, so the loss is reproduced by dropping the enqueue rather than by killing a
   * process at a microsecond boundary — the same loss, deterministically.
   *
   * **It is applied by `startRuntime`, not by `composePipeline`**, which is the WP-36 change: until
   * then it wrapped only the pipeline's own `Jobs`, so a command composed beside the pipeline —
   * `startHistoryBootstrap`, `startProjectDiscovery` — enqueued through an instance the seam could
   * not see, and the class's other three sites were unreproducible through it.
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

/**
 * How an ask's thread and its prompt name the person who asked.
 *
 * The display **name**, never `users.email`: it reaches the platform's own prompt as a marker
 * attribute and a mirrored ticket comment, and an address is the one field of an account a person
 * did not choose to publish (WP-27's rule at `actorLabel`, applied one work package later).
 *
 * A user the row no longer has is `a platform user`, not an empty string: the marker alphabet
 * refuses an empty attribute and the prompt should say *somebody asked* rather than nothing.
 */
const askerLabel = async (pool: pg.Pool, userId: string): Promise<string> => {
  const { rows } = await pool.query<{ name: string }>('select name from users where id = $1', [
    userId,
  ]);
  const name = rows[0]?.name?.trim() ?? '';
  // The marker alphabet is `A-Z a-z 0-9 . _ - /` (`SAFE_ATTRIBUTE_VALUE`), and a person's name is
  // not held to it — `assemblePrompt` refuses rather than escapes, which would fail every ask by a
  // user with a space in their name. So the label is folded here, where the fallback is a decision
  // rather than a crash.
  const folded = name.replaceAll(/[^A-Za-z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '');
  return folded === '' ? 'a-platform-user' : folded.slice(0, 120);
};

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
   * The register of runs this process is executing (WP-27).
   *
   * Built by the composition root and passed to **both** halves — the runner is wrapped with it
   * here, and `createTaskCommands` is given the same instance — because a steer and a take-over
   * reach into a session the executor is holding. A second register would be a second, empty
   * answer to "is that run here", and every steer would be refused on a process that was running
   * the run.
   */
  readonly liveRuns: LiveRuns;
  /**
   * What a run is given of the model provider (BD-004, TD-021 phase 1): the provider mode, the model
   * credential that becomes a `RunSpec.env` entry named in `secretEnvNames`, and the `local`-mode
   * binary path. Read from `ServerConfig` by the composition root.
   */
  readonly agent: {
    readonly providerMode: 'api' | 'local';
    readonly modelApiKey: string | null;
    /** `CLAUDE_CODE_OAUTH_TOKEN` — `local` mode's credential (PROGRESS backlog 128, WP-53). */
    readonly modelOauthToken: string | null;
    readonly claudeBinary: string | null;
  };
  /**
   * The organisation's IANA zone, from `TZ` (Q38) — what `features.digest.at` and quiet hours are
   * read in (WP-32).
   *
   * Passed from `ServerConfig` rather than read here, and **never** defaulted to the host's zone:
   * a digest that means 09:00 has to say whose 09:00, and `config.ts` already seeds this from `TZ`
   * with UTC as the documented fallback.
   */
  readonly timezone: string;
  /**
   * The organisation's working calendar (WP-56), from `ServerConfig.workingCalendar` — what every
   * question, approval and take-over deadline is resolved on. Its zone is the same `TZ` as
   * {@link timezone}'s, by the loader's own rule.
   */
  readonly calendar: WorkingCalendar;
  /** `APP_BASE_URL` — the link an ask's mirrored ticket comment points back at (WP-31). */
  readonly baseUrl: string;
  /**
   * `APP_DEPENDENCY_REGISTRY_HOSTS` — the package registries the dependency gate may ask for a
   * licence (WP-38, Q84, PROGRESS backlog 48).
   *
   * Empty is the shipped default and is a decision rather than an omission: the platform calls a
   * host an operator declared or it calls nothing, and the Checks panel prints *"licence not
   * checked"* with the setting that would change it. The composition below logs which of the two it
   * did, because "switched off" and "never composed" must not look the same in a log either.
   */
  readonly dependencyRegistryHosts: readonly string[];
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
  /**
   * The run credentials this process minted (WP-76, TD-028's WP-76 amendment decision 8) — one
   * registry per process, composed into the executor's redactor here, the binding loader's platform
   * redactor, the run transcript and the artifact write, so a value minted *after* each of those
   * redactors was built is still replaced by all of them.
   */
  readonly runSecrets: RunScopedSecrets;
  /**
   * {@link platformRedactorFor} over {@link runSecrets}, built **once, here** — the redactor the
   * executor, every binding loader built from this stack and the stage executor's artifact write
   * are given. Built from the stack's own registry so the three sinks and the minter cannot be
   * handed two different registries (WP-76 review round 2).
   */
  readonly platformRedactor: SecretRedactor;
}

/**
 * TD-012 step 2 plus the run credentials this process minted (WP-76, TD-028's WP-76 amendment
 * decision 8) — the one redactor the executor, the binding loader's platform half and the stage
 * executor's artifact write are given. The registry is read at call time, so a credential minted
 * after any of the three was built is still replaced; `run-secrets-composition.test.ts` holds each
 * of the three call sites to this function and drives the executor's end to end.
 */
export const platformRedactorFor = (runSecrets: RunScopedSecrets): SecretRedactor =>
  composeSecretRedactors(runSecrets.redactor, redactionAdapters.patternRedactor());

export interface ComposeIntegrationStackOptions {
  readonly pool: pg.Pool;
  readonly eventing: ReturnType<typeof eventingAdapters.createEventing>;
  readonly registry?: (options: PipelineProviderRegistryOptions) => IntegrationRegistry;
  /**
   * `APP_INTEGRATION_HOSTS` — the hosts this process may dial for a binding (WP-51, backlog 48).
   *
   * **Required and not optional**, unlike most of this file's knobs: an optional list would be an
   * absent one on the day a composition root forgot it, and the two possible defaults are "open"
   * (the defect) and "closed" (indistinguishable, here, from a working policy). Empty is a legal
   * value and means *no provider call leaves this process*; `['*']` is how an operator declares it
   * open. `createIntegrationEgressPolicy` carries the whole argument.
   */
  readonly integrationHosts: readonly string[];
  readonly logger: Logger;
}

export const composeIntegrationStack = (
  options: ComposeIntegrationStackOptions,
): IntegrationStack => {
  const ids = { next: (): Id => randomUUID() as Id };
  /**
   * The run credentials this process mints (WP-76, TD-028's WP-76 amendment decision 8) — **the
   * one registry of the process**, built here and nowhere else (`run-secrets-composition.test.ts`
   * counts the construction sites), so the minter (`composeRunWorkspaces`, handed
   * `stack.runSecrets`) and every redactor below read the same values. Memory: it reaches nothing
   * another process writes (backlog 154).
   */
  const runSecrets = createRunScopedSecrets({ now: () => Date.now() });
  const platformRedactor = platformRedactorFor(runSecrets);

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

  const egress = createIntegrationEgressPolicy(options.integrationHosts);
  options.logger.info(
    { hosts: egress.declared, open: egress.open },
    egress.open
      ? 'APP_INTEGRATION_HOSTS declares "*", so a binding may name any host: every provider call this process makes goes wherever the integration row says'
      : egress.declared.length === 0
        ? 'no provider host is declared (APP_INTEGRATION_HOSTS), so no provider call leaves this process and POST /api/integrations refuses every host'
        : 'a provider binding may name only these hosts; a call to any other is refused before it is made',
  );

  const executor = createIntegrationActionExecutor({
    auditLog,
    /**
     * The operator's list, read once per process (WP-51).
     *
     * The check is at *call* time and not only at the write, because `integrations.config` outlives
     * the list that admitted it: a row inserted before this setting existed, narrowed out of it
     * afterwards, or written with `psql`, would otherwise keep dialling a host nobody declared.
     */
    egress,
    /**
     * TD-012 **step 2** — the gitleaks-derived pattern rules — and not `noSecretsRedactor()`.
     *
     * The executor is one per process and an exact-match redactor is per *binding*, so the two
     * halves of TD-012 land in different places by construction: step 1 is composed by the binding
     * loader and applied by the adapter that emits the string, step 2 is applied here over the
     * audit row's payload, result and error. Passing a no-op would be the defect standing rule 31
     * is named for, one ring further out than WP-11 put it.
     *
     * Plus the run credentials this process minted (WP-76): a revoke that fails with the token in
     * the provider's answer, or any other row that quotes one, is redacted to the run's name.
     */
    redactor: platformRedactor,
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
  return {
    executor,
    auditLog,
    registry: registryOf({ executor, clock: { now: nowIso } }),
    runSecrets,
    platformRedactor,
  };
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
 * project's own `.agentic/pipeline.yml` is read from the default branch, and a template a project
 * declared but this process could not read would park every task one stage short of `done` — so it
 * is absent rather than guessed. **Since WP-18a the missing piece is a caller, not a tree**: this
 * process can read the default branch without a checkout (`knowledge.ts` composes a `VaultSource`
 * over a bare mirror), but that read answers the four *indexed vault* paths and nothing else, and
 * settling a project's pipeline from it is a work package of its own.
 */
export const createProjectSettingsPort = (
  pool: pg.Pool,
  /** Optional so the two call sites that have no logger keep their one argument. */
  logger: Logger = silentLogger,
): ProjectSettingsPort => ({
  forProject: async (projectId: Id): Promise<ProjectSettings> => {
    const { rows } = await pool.query<{ config: unknown; autonomy_policies: unknown }>(
      'select config, autonomy_policies from projects where id = $1',
      [projectId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`project ${projectId} has no row; the pipeline cannot settle its settings`);
    }
    return defaultProjectSettings(projectId, {
      templates: SHIPPED_TEMPLATES,
      config: (row.config ?? {}) as ConfigValues,
      // Parsed, not cast — this column decides whether a plan waits for a human, and a document
      // that does not match the current schema must not be read as one that does. A row that fails
      // is `null`, which is the *stated* "never materialised" branch the gate names, and it is
      // logged rather than thrown: failing here would fail the `stage.execute` job into a retry
      // loop over a configuration problem no retry can fix.
      autonomy: parseMaterialisedAutonomy(row.autonomy_policies, projectId, logger),
    });
  },
});

/** `projects.autonomy_policies` through its published schema, or `null` with a named log line. */
const parseMaterialisedAutonomy = (
  value: unknown,
  projectId: Id,
  logger: Logger,
): MaterialisedAutonomy | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = materialisedAutonomySchema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  logger.warn(
    {
      project_id: projectId,
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
    },
    'projects.autonomy_policies does not match the current schema; this project is read as having no materialised dial (re-apply the preset)',
  );
  return null;
};

export interface ComposedPipeline {
  readonly runtime: PipelineRuntime;
  /**
   * The binding loader this process composed, for the one other thing that calls a provider on a
   * project's behalf: the Librarian's knowledge commit (WP-18b).
   *
   * Exposed rather than rebuilt, so that both go through the same `IntegrationActionExecutor` — one
   * idempotency store, one rate-limit budget, one audit log per account (the same argument
   * `runtime.ts` makes for building the stack once).
   */
  readonly integrations: PipelineIntegrationsPort;
  /**
   * What this process could not compose for an agent run, by name, or empty when it composed one.
   *
   * Returned rather than only logged so `/readyz`'s neighbours and the e2e tier can read the same
   * answer the log line carries; `runtime.ts` is what warns on it.
   */
  readonly agentMissing: readonly string[];
  /**
   * The nine in-process MCP tools this process composed, exposed so a caller can see what a run
   * would be given. `kb_search` and `get_task_context` (WP-54) are real; the other seven refuse
   * and say why (`./platform-tools.ts`).
   */
  readonly platformTools: PlatformToolPort;
  stop(): Promise<void>;
}

/**
 * The binding loader — `bindings` joined to `integrations`, credentials decrypted from `secrets`,
 * adapters built **per call** so the redactor carries the call's run-scoped credentials (WP-15a,
 * Q55).
 *
 * Extracted at WP-34 because a **second** composition root needs it: the shadow batch command is
 * the API half of a feature whose reads (the ticket, the merged merge requests, the merge base) are
 * provider calls, and it is composed for a process that may run no pipeline at all. Two loaders
 * would be two sets of adapters over one account — the duplication `composeIntegrationStack`'s own
 * docblock argues against — so both call this.
 */
export const createProjectIntegrationsPort = (options: {
  readonly pool: pg.Pool;
  readonly secretKey: string;
  /** The process's one stack: its registry, its executor and its `platformRedactor` (WP-76). */
  readonly stack: IntegrationStack;
}): PipelineIntegrationsPort =>
  createPipelineIntegrationsLoader({
    repository: secretAdapters.createPostgresBindingRepository(options.pool),
    secrets: secretAdapters.createPostgresSecretStore({
      sql: options.pool,
      key: secretAdapters.deriveSecretKey(options.secretKey),
    }),
    registry: options.stack.registry,
    executor: options.stack.executor,
    // TD-012 step 2, beside each binding's own exact-match redactor — the same line
    // `composeWebhookIngress` passes, and now for the second sink: WP-15f writes the ticket's text
    // to `tasks.ticket_snapshot`, which is read into every prompt. No task DTO serves it yet.
    // WP-76: and the run credentials this process minted, so a CI log or a review thread handled
    // here while one is live has it replaced (another process's are out of reach: backlog 154).
    platformRedactor: options.stack.platformRedactor,
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

export const composePipeline = async (
  options: ComposePipelineOptions,
): Promise<ComposedPipeline> => {
  const { composition, stack } = options;
  const ids = { next: (): Id => randomUUID() as Id };
  /**
   * The `Jobs` everything below enqueues through.
   *
   * {@link PipelineComposition.jobs}'s seam is **already applied** by `startRuntime`, which wraps
   * the one instance every composition of that process shares — the pipeline, the command
   * factories, the two crons and the three worker runtimes. It was applied here until WP-36, and
   * that made it blind to every enqueue the pipeline does not make (PROGRESS backlog 101's site);
   * the worker runtimes were still taking the unwrapped instance until round 2 (backlog **106**),
   * which is why the list is now held by `apps/server/src/pipeline-census.test.ts` rather than by
   * this sentence.
   */
  const jobs = options.jobs;

  const integrations = createProjectIntegrationsPort({
    pool: options.pool,
    secretKey: options.secretKey,
    stack,
  });

  const stopReasons = createRunStopReasons();
  const settings = createProjectSettingsPort(options.pool, options.logger);
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
    runSecrets: stack.runSecrets,
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
  // One knowledge store for the two planners' packs and listings (WP-58): the pack's documents and
  // the `paths:` listing it validates against are read from the same index.
  const knowledgeStore = new knowledgeAdapters.PostgresKnowledgeStore(options.pool);

  const dependencyMetadata =
    options.dependencyRegistryHosts.length === 0
      ? null
      : dependencyAdapters.createDependencyMetadataClient({
          allowedHosts: options.dependencyRegistryHosts,
          logger: options.logger,
        });
  options.logger.info(
    { hosts: options.dependencyRegistryHosts },
    dependencyMetadata === null
      ? 'no package-registry host is declared (APP_DEPENDENCY_REGISTRY_HOSTS), so the dependency gate gates and reports every licence as not checked'
      : 'the dependency gate will ask these package registries for a licence and a last release',
  );

  /**
   * One store instance, because two things read it: the pipeline runtime and the maintenance
   * schedule below, which creates a chore task through the same repository every other task is
   * created through (WP-36).
   */
  const store = pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
  /** WP-77: one instance for the recovery pass that finds and the duty that re-validates. */
  const runCredentialStore = recoveryAdapters.createPostgresRunCredentialStore();
  const maintenanceStore = new maintenanceAdapters.PostgresMaintenanceStore();

  const runtime = createPipelineRuntime({
    store,
    settings,
    jobs,
    integrations,
    ids,
    clock: { now: nowIso },
    // WP-77: where the `revoke_run_credential` duty re-validates — the store the recovery pass below
    // finds with, so the duty asks the pass's own question for its one address.
    runCredentials: runCredentialStore,
    // WP-32: the notification outbox, and the zone the digest and quiet hours are read in. Both are
    // required by `PipelineRuntimeOptions` rather than optional, because a process that composed
    // the pipeline without them would run the notify band on nothing.
    notifications: notifyAdapters.createPostgresNotificationStore(),
    // WP-34: shadow mode's batches, tickets and reports. Required rather than optional for the
    // reason `notifications` is — `EVENT_CONSUMPTION` declares `shadow.report.created` handled, so
    // a process that composed the pipeline without it would sweep an event it promised a consumer
    // for. A deployment that runs no shadow batch simply never produces one.
    shadow: new shadowAdapters.PostgresShadowStore(),
    /**
     * WP-35: the history bootstrap's per-batch cap, asked at admission for a task on that template
     * and for no other. **Optional** on the port and supplied here, which is the difference from
     * `shadow`: the bootstrap registers no handler on this runtime, so a process without it
     * promises no consumer for anything — what absence would cost is the cap, and a process that
     * cannot read a batch's spend must not pretend it is unspent.
     */
    bootstrap: new bootstrapAdapters.PostgresHistoryBootstrapStore(),
    /**
     * WP-36: `features.maintenance.budget_usd`, asked at the admission of a chore **this platform
     * scheduled** and of nothing else. Optional on the port and supplied here for the reason
     * `bootstrap` is: a process that cannot read what the month's chores have spent must not
     * pretend it is unspent.
     */
    maintenance: maintenanceStore,
    timezone: options.timezone,
    /**
     * WP-56: the calendar a question's, an approval's and a take-over's deadline is resolved on —
     * `APP_WORKING_DAYS`/`APP_WORKING_HOURS`/`APP_HOLIDAYS` in `TZ`, parsed by nothing before this.
     */
    calendar: options.calendar,
    /**
     * TD-012 **step 2** over the untrusted text the pipeline's handlers store (WP-40 round 2).
     *
     * The same composition `routes/commands.ts`, `routes/settings.ts` and the ask executor are
     * given, and for the same reason: a handler that writes a model's words into a row of its own
     * runs inside the dispatcher's transaction, where no binding — and therefore no step-1
     * exact-match redactor — can be resolved. `epic-split.ts` states what that leaves and where it
     * is caught.
     *
     * WP-76: plus the run credentials this process minted. The stage executor builds a run's
     * redactor before the workspace — and its credential — exists, and writes the artifact after
     * the workspace was released; the registry is read at call time and holds a value until it
     * expires, so the artifact of the run that was handed a token cannot store it.
     */
    redactor: stack.platformRedactor,
    unitOfWork: options.eventing.unitOfWork,
    logger: options.logger,
    stageConcurrency: options.stageConcurrency,
    /**
     * TD-028 decision 5: this process takes `stage.execute` jobs **only if it can perform one**.
     *
     * The condition is exactly the one `composeAgentRunner` already answers — a workspace
     * provisioner, and in `api` mode a model credential — so there is one definition of "runs
     * agents" rather than two. `composition.runner` (the e2e tiers' `FakeClaudeRunner` seam) counts
     * as a runner for the same reason it counts everywhere else in this file: it *is* one.
     */
    runsAgents: composition.runner !== undefined || agent.runner !== null,
    baseUrl: options.baseUrl,
    /**
     * The registry client, composed **only** when an operator declared a host (WP-38, Q84).
     *
     * Absent is the shipped state and the gate works identically without it: every package is
     * reported `not_checked`, which the panel prints. This is the one place that decision is made,
     * so an instance cannot reach a registry by accident.
     */
    ...(dependencyMetadata === null ? {} : { dependencyMetadata }),
    /**
     * Ask-the-task (WP-31) — a run with a task and no stage, on the same runner, the same budget
     * guard and the same stop-reason register the stage executor is given.
     *
     * The **runner is the same instance**, wrapped in `liveRuns` like every other run this process
     * starts: an ask is a run, so `POST /api/runs/:id/steer` and a take-over reach it exactly as
     * they reach a stage's. What is different is the planner — an ask has no stage and its prompt
     * is built from the audit trail (`createAskRunPlanner`) — and the tools, which
     * `PLATFORM_TOOLS_BY_ROLE.ask` narrows to `get_task_context` and `kb_search`.
     */
    ask: {
      asks: askAdapters.createPostgresAskStore(),
      // The same map the inbound normaliser decides `verified` from; the ask handler needs the
      // platform user id, which `ExternalIdentity` does not carry.
      identities: integrationAdapters.createPostgresIdentityDirectory({ sql: options.pool }),
      runner: options.liveRuns.observe(
        composition.runner?.(platformTools) ?? agent.runner ?? unavailableClaudeRunner(),
      ),
      planner: createAskRunPlanner({
        workspacePath: (taskId: Id) => `/workspaces/${taskId}`,
        providerMode: options.agent.providerMode,
        claudeCodePath: options.agent.claudeBinary,
        env: runEnvironment.env,
        secretEnvNames: runEnvironment.secretEnvNames,
        prompts: ROLE_PROMPTS,
        skills: PLATFORM_SKILLS,
        nonce: { next: () => randomUUID().replaceAll('-', '') },
        contextPacks: createContextPackAssembler({
          store: knowledgeStore,
          logger: options.logger,
        }),
        headPaths: (projectId: Id) => knowledgeStore.readPathWitnesses(projectId),
        clock: { now: nowIso },
        logger: options.logger,
      }),
      // TD-012 step 2 over the question and the answer — the same composition `routes/commands.ts`
      // and `routes/settings.ts` are given.
      redactor: redactionAdapters.patternRedactor(),
      askedByLabel: async (userId: Id) => askerLabel(options.pool, userId),
      budgets: createBudgetGuard({ store: costStore }),
    },
    execution: {
      // Wrapped so that every run this process starts is findable while it lasts (WP-27). The wrap
      // is outermost on purpose: it must see the handle the executor is given, whichever of the
      // three runners below produced it — including `unavailableClaudeRunner`, whose `start` throws
      // and therefore registers nothing.
      runner: options.liveRuns.observe(
        composition.runner?.(platformTools) ?? agent.runner ?? unavailableClaudeRunner(),
      ),
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
        // The shipped defaults. A project's own `prompts/<stage>.md` override is still absent
        // rather than half-read (product/13): WP-18a's default-branch read exists, but it returns
        // the indexed vault paths, and a prompt override is not one of them.
        prompts: ROLE_PROMPTS,
        // The ten platform skills (WP-14a). The planner reads them for their **digest** — the run's
        // `prompt_version` carries one, so a `SKILL.md` edited without a version bump is visible in
        // the audit — while the bytes reach the workspace from the launcher's own copy of this same
        // package.
        skills: PLATFORM_SKILLS,
        /**
         * Which provider skills this project's bindings name (WP-54, PROGRESS backlog 40): the
         * binding rows and each shipped provider's `AgentTooling.skill`, from the catalogue —
         * nothing decrypted, nothing built. A provider skill no binding names is not provisioned, and neither are the
         * command patterns it brings.
         */
        boundSkills: createBoundSkillsReader({
          repository: secretAdapters.createPostgresBindingRepository(options.pool),
          logger: options.logger,
        }),
        /**
         * The data-block nonce (BD-022). `randomUUID` is a CSPRNG — 122 bits — rendered as the 32
         * hex characters `NONCE_PATTERN` requires; the delimiter contract rests on a document's
         * author being unable to predict it, so this is the one collaborator here with no default
         * (standing rule 31).
         */
        nonce: { next: () => randomUUID().replaceAll('-', '') },
        contextPacks: createContextPackAssembler({
          store: knowledgeStore,
          logger: options.logger,
        }),
        /**
         * The path witnesses of the indexed commit (WP-58, PROGRESS backlogs 170 and 175): one
         * tracked path per vault glob, stored beside the documents (`kb_index_state.path_witnesses`,
         * migration 0042), so a `paths:`-scoped page validates against the commit it was indexed
         * from. One small row read per run; `null` until the project's first index write after 0042.
         */
        headPaths: (projectId: Id) => knowledgeStore.readPathWitnesses(projectId),
        clock: { now: nowIso },
        logger: options.logger,
      }),
      stopReasons,
      // BD-010's org and project budgets, read from the projection the ledger writes. A deployment
      // with no `budgets` rows is unaffected: `applicable` matches nothing and nothing blocks.
      budgets: createBudgetGuard({ store: costStore }),
      /**
       * The run lease this process holds while a stage is in flight (WP-47, backlog **109**).
       *
       * {@link RUN_LEASE_OWNER} is built once per process; the executor claims the lease in the
       * transaction that creates the `runs` row and renews it on a heartbeat, so the sweep below can
       * tell a run nothing is driving from one that is working. Without it a process that dies
       * mid-run leaves a row `running` for ever, holding its stage's per-run budget against every
       * future window of its project and its organisation.
       */
      lease: { owner: RUN_LEASE_OWNER },
      /**
       * What a run's spend does when a human's cancel or the sweep ended the row first (Q70 (b),
       * backlog **50**). Until WP-47 it did nothing at all: the ender wrote zeros, the ledger took
       * its `no_spend` branch, and cancelling was the one human action that spent a project's
       * budget without charging it.
       */
      lateCost: createLateCostRecorder({
        store: costStore,
        runs: store.runs,
        context: (correlationId, causeEventId) => ({
          ids,
          actor: { kind: 'system', component: 'cost-ledger' },
          clock: { now: nowIso },
          correlationId,
          causeEventId,
        }),
        logger: options.logger,
      }),
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
  /**
   * The human-time projection (WP-29), composed here for the same reason the ledger is: a process
   * that registers the pipeline must register it too, because `EVENT_CONSUMPTION` now declares
   * `run.steered` handled and `sweepReadiness` refuses to sweep a process that cannot handle it.
   *
   * It borrows no connection of its own — the projector runs inside the dispatcher's handler
   * transaction — and it enqueues nothing, so `POOL_RESERVATIONS` is unchanged.
   */
  for (const handler of humanTimeHandlers({
    store: humanTimeAdapters.createPostgresHumanTimeStore(),
    logger: options.logger,
  })) {
    options.eventing.bus.register(handler);
  }
  /**
   * The statistics projection (WP-41), composed here for the same reason the two above are: a
   * process that registers the pipeline must register it too, because `EVENT_CONSUMPTION` declares
   * the four metric events handled and `sweepReadiness` refuses to sweep a process that cannot
   * handle them.
   *
   * It borrows no connection of its own — the projector runs inside the dispatcher's handler
   * transaction — and it enqueues nothing, so `POOL_RESERVATIONS` is unchanged.
   */
  for (const handler of statsHandlers({
    store: statsAdapters.createPostgresStatsStore(),
    logger: options.logger,
  })) {
    options.eventing.bus.register(handler);
  }
  /**
   * What a poisoned event does to its task (WP-49), registered here rather than passed to
   * `createEventing`: the bus is built before this function has a `PipelineStore` to escalate with,
   * which is the same ordering that makes every handler above a `register` call.
   *
   * It is not a handler and not a job. It runs inside the dispatcher's transaction, so the dead
   * letter and the escalation commit together — `packages/application/src/events/dead-letter.ts`
   * has the argument — and it borrows no connection of its own, so `POOL_RESERVATIONS` is
   * unchanged.
   */
  options.eventing.bus.onDeadLetter(
    createDeadLetterEscalation({
      store,
      context: (correlationId, causeEventId) => ({
        ids,
        actor: { kind: 'system', component: 'dispatcher' },
        clock: { now: nowIso },
        correlationId,
        causeEventId,
      }),
      logger: options.logger,
    }),
  );
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
    /**
     * The other sites of the same class (WP-36 and WP-48, PROGRESS backlog **101**): a history
     * bootstrap left `collecting` with no chunks or with a mining run whose findings were never
     * recorded (**106**), an artifact nothing curated (**36**), an ask left `pending` with no run
     * (**84**) and one whose run is already over (**121**). They ride this timer rather than one of
     * their own — one pass, one interval, one pooled connection — and
     * `packages/application/src/recovery/stranded.ts` carries the table, including why entry 20's
     * recovery is the reconciler above rather than a row of it.
     */
    stranded: {
      store: recoveryAdapters.createPostgresStrandedWorkStore(),
      unitOfWork: options.eventing.unitOfWork,
      /**
       * The third site (WP-47, backlog **109**): a run no process is renewing the lease of.
       *
       * It ends the row rather than re-enqueuing a wake-up — there is nothing left to wake — so it
       * needs the pipeline store, the event log and a system actor, which is why it is a block of
       * its own rather than two more methods on the stranded store.
       * `packages/application/src/recovery/run-lease.ts` carries what a missing heartbeat does and
       * does not license anybody to conclude.
       */
      runs: {
        store: recoveryAdapters.createPostgresExpiredRunStore(),
        pipeline: store,
        unitOfWork: options.eventing.unitOfWork,
        eventStore: options.eventing.store,
        wallClockMs: runLimitsDefaults.wallClockMs,
        context: (correlationId) => ({
          ids,
          actor: { kind: 'system', component: RUN_LEASE_SWEEP_COMPONENT },
          clock: { now: nowIso },
          correlationId,
          causeEventId: null,
        }),
      },
      /**
       * WP-77, backlog **155**: a terminal run whose git credential nothing confirmed revoked — its
       * runner died between mint and revoke (the site above ends that run's row; this one revokes
       * what it held), or its teardown revoke failed. One `pipeline.outbound` duty per address,
       * bounded by the audit row it writes; `packages/application/src/recovery/run-credential.ts`
       * carries the predicate and what it does not reach. The horizon is derived from the TTL the
       * runner mints with, so the two cannot drift apart.
       */
      credentials: {
        store: runCredentialStore,
        horizonMs: runCredentialRecoveryHorizonMs(RUN_CREDENTIAL_TTL_SECONDS),
      },
      /**
       * WP-56 round 2, backlog **161** and **162**: a question, approval or take-over whose timer
       * was lost (its `afterCommit` arm died with the process) is expired through the
       * `deadline.sweep` job's own path, and a row written before deadlines existed is given its
       * first one, counted from the pass rather than from when it was asked.
       * `packages/application/src/recovery/deadline.ts` carries both choices.
       */
      /**
       * WP-59 review round 1, backlog **178**: a merge request a rework let go of whose close
       * wake-up was lost or failed. Re-driven once through the `close_superseded_mr` duty, then
       * abandoned with an error line; `packages/application/src/recovery/superseded-mr.ts`.
       */
      supersededMergeRequests: {
        store: recoveryAdapters.createPostgresSupersededMergeRequestStore(),
      },
      deadlines: {
        store: recoveryAdapters.createPostgresDeadlineRecoveryStore(),
        settings,
        sweep: {
          unitOfWork: options.eventing.unitOfWork,
          store,
          jobs,
          calendar: options.calendar,
          ids,
          // The expiry commands store no free text, so this is the type's requirement rather than
          // a sink; the pattern rules are the composition `maintenance` below is given.
          redactor: redactionAdapters.patternRedactor(),
        },
      },
    },
    logger: options.logger,
  });
  if (reconciler === null) {
    options.logger.warn(
      { setting: 'APP_INTAKE_RECONCILE_INTERVAL_MS=0' },
      'the recovery pass is switched off: a matched ticket whose intake enqueue is lost is never started (PROGRESS backlog 20), a stranded history bootstrap (101) or pending ask (84) is never recovered, a run whose process died stays "running" for ever, holding its stage budget against every future window (109), a run credential whose revoke never happened stays live to its expiry (155), a question, approval or take-over whose timer was lost — or that predates deadlines — waits for ever (161, 162), and a merge request a rework superseded whose close was lost stays open (178)',
    );
  }

  /**
   * The maintenance schedule (WP-36), composed here beside the reconciler and
   * `registerPartitionMaintenance` rather than inside `createPipelineRuntime`, because it is a
   * schedule the **process** owns rather than a step of a ticket's journey.
   *
   * It is one more pooled connection, counted in `POOL_RESERVATIONS.pipeline`.
   */
  const maintenance = await registerMaintenanceSchedule({
    unitOfWork: options.eventing.unitOfWork,
    store,
    maintenance: maintenanceStore,
    settings,
    jobs,
    ids,
    clock: { now: nowIso },
    projects: async (limit) => {
      const { rows } = await options.pool.query<{ id: string }>(
        'select id from projects order by created_at desc limit $1',
        [limit],
      );
      return rows.map((row) => row.id as Id);
    },
    timezone: options.timezone,
    baseUrl: options.baseUrl,
    // TD-012 step 2 over the brief: a chore's evidence is repository paths, package names and a
    // registry's own strings, and the column it lands in is read into every prompt of the task.
    redactor: redactionAdapters.patternRedactor(),
    logger: options.logger,
  });

  return {
    runtime,
    integrations,
    platformTools,
    agentMissing: agent.runner === null ? agent.missing : [],
    stop: async () => {
      if (reconciler !== null) {
        await reconciler.stop();
      }
      await maintenance.stop();
      await runtime.stop();
    },
  };
};
