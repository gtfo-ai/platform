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
 *   (`stack.platformRedactor`, the stage executor's), the project settings port, the working
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
  createLateCostRecorder,
  createRemoteRuns,
  type Jobs,
  type Logger,
  markTransactions,
  type RemoteRuns,
  RUN_CREDENTIAL_TTL_SECONDS,
  revokeRunCredentialsNow,
  settleRun,
  type WorkingCalendar,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { type CommandContext, SHIPPED_TEMPLATES } from '@platform/domain';
import {
  cost as costAdapters,
  type eventing as eventingAdapters,
  launcher as launcherAdapters,
  pipeline as pipelineAdapters,
  recovery as recoveryAdapters,
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
} from './pipeline.js';
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
  readonly logger: Logger;
}

const nowIso = (): IsoDateTime => new Date().toISOString() as IsoDateTime;

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
  return createRemoteRuns({
    unitOfWork,
    store,
    eventStore: options.eventing.store,
    context: context('worker-protocol'),
    runPlans: secretAdapters.createEnvelopeRunPlanSealer(
      secretAdapters.deriveSecretKey(options.secretKey),
    ),
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
      logger: options.logger,
    }),
    credentials: {
      revoke: async (runId) => {
        await revokeRunCredentialsNow(
          {
            unitOfWork,
            integrations,
            store: credentialStore,
            clock: { now: nowIso },
            logger: options.logger,
          },
          runId,
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
          redactor: options.stack.platformRedactor,
          settings: async (projectId, tx) => settings.forProject(projectId, tx),
          eventStore: options.eventing.store,
          jobs: options.jobs,
          runEnvironment: agentRunEnvironment(options.agent),
          logger: options.logger,
        },
        request,
      ),
    lateCost,
    logger: options.logger,
  });
};
