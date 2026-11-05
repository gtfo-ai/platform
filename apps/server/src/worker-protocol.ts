/**
 * **The worker protocol's composition** (WP-281) — the core's half of TD-031's remote claimant,
 * composed for every process that serves the API (`ROLE=api` and `all`), whatever its worker half.
 *
 * A worker's request reaches **any** API replica, so nothing here is the pipeline runtime's: an
 * `ROLE=api` process composes no pipeline. What the protocol writes is composed from the same
 * factories the pipeline's composition uses (`pipeline.ts`), so a remote run settles exactly as a
 * server run does:
 *
 * - **settle** — `settleRun` over a PostgreSQL pipeline store, the platform's pattern redactor
 *   (`stack.platformRedactor`, the stage executor's) — since WP-282 under the run's project binding
 *   redactors, rebuilt from stored state (backlog 745) — the project settings port, the working
 *   calendar, this process's `agentRunEnvironment` (the settle redactor's values) and the late-cost
 *   recorder over the cost store — the stage executor's settle collaborators, one for one;
 * - **the package** — `createRemoteRunPackager` over the run-workspace project source, the git
 *   credential minter, `PLATFORM_SKILLS` and the egress hosts the server's provisioner is given
 *   (`workspaces.ts`), so a run's isolation is decided by one mapping whichever claimant runs it;
 * - **revocation** — `revokeRunCredentialsNow` over the run-credential store, from the mint's audit
 *   row, because the process a release or a finish reaches is not necessarily the one that minted.
 *
 * Every transaction is marked (`markTransactions`), as the pipeline runtime marks its own, so a
 * provider call made from inside one is refused rather than reviewed for.
 */
import { randomUUID } from 'node:crypto';
import {
  createAskExecutor,
  createBudgetGuard,
  createClaimAdmission,
  createLateCostRecorder,
  createRemoteRuns,
  createRunStopReasons,
  type Jobs,
  type Logger,
  MAX_TRANSCRIPT_ENTRIES_PER_RUN,
  markTransactions,
  type RemoteRuns,
  RUN_CREDENTIAL_TTL_SECONDS,
  revokeRunCredentialsNow,
  type SecretRedactor,
  settleRun,
  type WorkingCalendar,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { type CommandContext, SHIPPED_TEMPLATES } from '@platform/domain';
import {
  ask as askAdapters,
  cost as costAdapters,
  type eventing as eventingAdapters,
  launcher as launcherAdapters,
  pipeline as pipelineAdapters,
  recovery as recoveryAdapters,
  redaction as redactionAdapters,
  runner as runnerAdapters,
  secrets as secretAdapters,
} from '@platform/infrastructure';
import { PLATFORM_SKILLS } from '@platform/prompts';
import type pg from 'pg';
import { agentRunEnvironment } from './agent.js';
import {
  createProjectIntegrationsPort,
  createProjectSettingsPort,
  type IntegrationStack,
  unavailableClaudeRunner,
} from './pipeline.js';
import { remoteRunCredentialOf, runDisplayOf } from './worker-run-calls.js';
import { runTokens } from './workers/secrets.js';
import { createRunGitCredentialMinter, createRunWorkspaceProjectSource } from './workspaces.js';

export interface ComposeRemoteRunsOptions {
  readonly pool: pg.Pool;
  readonly eventing: ReturnType<typeof eventingAdapters.createEventing>;
  /** Where a settle enqueues a start failure's retry (the enqueue-only sender on `ROLE=api`). */
  readonly jobs: Jobs;
  readonly stack: IntegrationStack;
  readonly secretKey: string;
  readonly calendar: WorkingCalendar;
  readonly agent: {
    readonly providerMode: 'api' | 'local';
    readonly modelApiKey: string | null;
    readonly modelOauthToken: string | null;
  };
  readonly modelEgressHosts: readonly string[];
  readonly runRegistryHosts: readonly string[];
  /**
   * The run's redactor base rebuilt from stored state (WP-282, backlog 745): the project's binding
   * redactors over `stack.platformRedactor` — what a settle answered by a replica that never minted
   * this run's credential redacts the artifact with, beside the run's own step 1 that `settleRun`
   * composes. Absent, the platform's rules alone (the WP-281 behaviour).
   */
  readonly runRedactors?: {
    readonly baseFor: (run: {
      readonly runId: Id;
      readonly projectId: Id;
    }) => Promise<SecretRedactor>;
  };
  readonly logger: Logger;
}

const nowIso = (): IsoDateTime => new Date().toISOString() as IsoDateTime;

/**
 * The settle's base redactor for a remote run (backlog 745): the run's project bindings over the
 * platform's rules (`runRedactors.baseFor`), read outside any transaction before the settle opens its
 * own. A binding that fails to load must not keep a finished run from settling, so it falls back to
 * the platform's rules — the WP-281 behaviour — and says so; with no `runRedactors`, the platform's
 * rules alone.
 */
/**
 * The escalation's words for a remote run the worker stopped at the core's transcript bound (backlog
 * 754, S-22.14): the worker's closed stop word is `cancelled`, so the core names the bound itself when
 * the run ended cancelled with its transcript within one batch (1 000 rows, the worker's) of it.
 */
export const transcriptBoundDetail = async (
  pool: Pick<pg.Pool, 'query'>,
  request: { readonly runId: Id; readonly outcome: object },
): Promise<string | null> => {
  if ((request.outcome as { readonly status?: unknown }).status !== 'cancelled') return null;
  const { rows } = await pool.query<{ count: string }>(
    'select count(*)::text as count from run_messages where run_id = $1',
    [request.runId],
  );
  return Number(rows[0]?.count ?? 0) > MAX_TRANSCRIPT_ENTRIES_PER_RUN - 1_000
    ? `the core holds at most ${MAX_TRANSCRIPT_ENTRIES_PER_RUN} transcript entries of a remote run (transcript_full), so its worker stopped it`
    : null;
};

export const remoteSettleRedactorFor =
  (options: {
    readonly pool: Pick<pg.Pool, 'query'>;
    readonly platformRedactor: SecretRedactor;
    readonly runRedactors:
      | {
          readonly baseFor: (run: {
            readonly runId: Id;
            readonly projectId: Id;
          }) => Promise<SecretRedactor>;
        }
      | undefined;
    readonly logger: Logger;
  }) =>
  async (runId: Id): Promise<SecretRedactor> => {
    if (options.runRedactors === undefined) {
      return options.platformRedactor;
    }
    try {
      const { rows } = await options.pool.query<{ project_id: Id }>(
        'select project_id from runs where id = $1',
        [runId],
      );
      const projectId = rows[0]?.project_id;
      return projectId === undefined
        ? options.platformRedactor
        : await options.runRedactors.baseFor({ runId, projectId });
    } catch (error) {
      options.logger.error(
        { err: error, run_id: runId },
        'a remote run’s binding redactors could not be rebuilt for its settle; it settles with the platform’s pattern rules',
      );
      return options.platformRedactor;
    }
  };

export const composeRemoteRuns = (options: ComposeRemoteRunsOptions): RemoteRuns => {
  const unitOfWork = markTransactions(options.eventing.unitOfWork);
  const ids = { next: (): Id => randomUUID() as Id };
  const store = pipelineAdapters.createPostgresPipelineStore({
    templates: SHIPPED_TEMPLATES,
    logger: options.logger,
  });
  const context =
    (component: string) =>
    (correlationId: Id): CommandContext => ({
      ids,
      actor: { kind: 'system', component },
      clock: { now: nowIso },
      correlationId,
      causeEventId: null,
    });
  const costStore = costAdapters.createPostgresCostStore();
  const lateCost = createLateCostRecorder({
    store: costStore,
    runs: store.runs,
    tasks: store.tasks,
    context: (correlationId, causeEventId) => ({
      ids,
      actor: { kind: 'system', component: 'cost-ledger' },
      clock: { now: nowIso },
      correlationId,
      causeEventId,
    }),
    logger: options.logger,
  });
  const settings = createProjectSettingsPort(options.pool, options.logger);
  const integrations = createProjectIntegrationsPort({
    pool: options.pool,
    secretKey: options.secretKey,
    stack: options.stack,
  });
  const credentialStore = recoveryAdapters.createPostgresRunCredentialStore();
  const settleRedactorFor = remoteSettleRedactorFor({
    pool: options.pool,
    platformRedactor: options.stack.platformRedactor,
    runRedactors: options.runRedactors,
    logger: options.logger,
  });
  const runPlans = secretAdapters.createEnvelopeRunPlanSealer(
    secretAdapters.deriveSecretKey(options.secretKey),
  );
  const runEnvironment = agentRunEnvironment(options.agent);
  /**
   * **An ask's ending, for a worker that ran it** (WP-283, backlog 741, TD-031 decision 13): the
   * ask executor's own `settle`, which reads everything from stored state. It is composed here for
   * that one method — the routes plan nothing and run nothing, so its runner and planner refuse by
   * name if anything ever asked them.
   */
  const askExecutor = createAskExecutor({
    unitOfWork,
    asks: askAdapters.createPostgresAskStore(),
    store,
    runner: unavailableClaudeRunner(),
    planner: {
      plan: async () => {
        throw new Error('the worker protocol settles asks; it never plans one');
      },
    },
    stopReasons: createRunStopReasons(),
    settings: async (projectId) => settings.forProject(projectId),
    context: context('ask'),
    redactor: redactionAdapters.patternRedactor(),
    askedByLabel: async (userId) => {
      const { rows } = await options.pool.query<{ name: string }>(
        'select name from users where id = $1',
        [userId],
      );
      return rows[0]?.name ?? 'a platform user';
    },
    jobs: options.jobs,
    runPlans,
    runEnvironment,
    eventStore: options.eventing.store,
    logger: options.logger,
  });
  return createRemoteRuns({
    unitOfWork,
    store,
    eventStore: options.eventing.store,
    context: context('worker-protocol'),
    runPlans,
    packager: launcherAdapters.createRemoteRunPackager({
      projects: createRunWorkspaceProjectSource(options.pool),
      credentials: createRunGitCredentialMinter({
        pool: options.pool,
        integrations,
        runSecrets: options.stack.runSecrets,
        now: () => new Date(runnerAdapters.systemClock.now()).toISOString(),
      }),
      skills: PLATFORM_SKILLS,
      modelEgressHosts: options.modelEgressHosts,
      runRegistryHosts: options.runRegistryHosts,
      credentialTtlSeconds: RUN_CREDENTIAL_TTL_SECONDS,
      clock: runnerAdapters.systemClock,
      // WP-282 (Q124 (a)): a static token or a deploy key reaches a worker only behind the opt-in.
      remoteRunCredential: async (spec) => remoteRunCredentialOf(options.pool)(spec.projectId),
      // WP-292: the worker's local page names the run by its project, ticket and redacted title.
      display: async (spec) => runDisplayOf(options.pool)(spec.taskId),
      logger: options.logger,
    }),
    credentials: {
      revoke: async (runId, scope) => {
        await revokeRunCredentialsNow(
          {
            unitOfWork,
            integrations,
            store: credentialStore,
            clock: { now: nowIso },
            logger: options.logger,
          },
          runId,
          scope,
        );
      },
    },
    tokens: runTokens,
    settle: async (request) =>
      settleRun(
        {
          unitOfWork,
          store,
          // The stage executor's own: a pipeline system actor ends a remote run as it ends a server one.
          context: context('pipeline'),
          calendar: options.calendar,
          lateCost,
          redactor: await settleRedactorFor(request.runId),
          settings: async (projectId, tx) => settings.forProject(projectId, tx),
          eventStore: options.eventing.store,
          jobs: options.jobs,
          runEnvironment,
          logger: options.logger,
        },
        { ...request, endingDetail: await transcriptBoundDetail(options.pool, request) },
      ),
    settleAsk: async (request) => askExecutor.settle(request),
    lateCost,
    // TD-031 §2 (backlog 744): the stage executor's budget questions, asked again at a worker's claim.
    admission: createClaimAdmission({
      store,
      settings: async (projectId, tx) => settings.forProject(projectId, tx),
      budgets: createBudgetGuard({ store: costStore }),
      eventStore: options.eventing.store,
      context: context('pipeline'),
      logger: options.logger,
    }),
    // WP-293: a pick's `worker.take_offer` row, in the claim's transaction.
    takeAudit: pipelineAdapters.createPostgresWorkerTakeAudit(),
    logger: options.logger,
  });
};
