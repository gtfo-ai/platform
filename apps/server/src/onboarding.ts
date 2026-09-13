/**
 * The onboarding wizard, composed for `apps/server` — product/06, product/17 (WP-21).
 *
 * Two halves, and they are separate because two different processes want them:
 *
 *  - {@link createOnboardingCommands} is what the **API** role calls — start a discovery run, test
 *    an integration. It borrows the pool per request and starts no worker.
 *  - {@link composeOnboardingRecording} is what a **worker** role registers: the `artifact.created`
 *    handler for a `DiscoveryDraft` and the `onboarding.discovery` job behind it, which is what
 *    writes `readiness_evaluations` and the drafted pages.
 *
 * It is the shape `knowledge.ts` next door already uses (`createKnowledgeCommands` /
 * `composeKnowledgeIndexing`), for the same reason: which collaborators exist is a property of the
 * `ROLE`, and a route whose collaborator is absent says `503` by name rather than disappearing.
 *
 * ## The readiness probe reads a provider, so it never runs inside a transaction
 *
 * R9 is *"is the default branch protected?"*, which is a git-provider API call — the same
 * `isBranchProtected` the intake check makes before it starts a task. `integrationsForProject`
 * refuses to resolve bindings inside an open transaction (WP-15d), so this probe is called from the
 * job's read phase, before the transaction that writes. The refusal is mechanical, not reviewed for.
 *
 * ## A provider read that fails is `null`, not `false`
 *
 * The probe answers `defaultBranchProtected: null` when there is no git binding or the read threw,
 * and `evaluateReadiness` renders that as *"the platform could not ask"* rather than as
 * "unprotected". A provider outage must not write a record that says something untrue about a
 * repository, and readiness is a document a human reads (standing rule 18's shape for a *read*).
 */
import { randomUUID } from 'node:crypto';
import type {
  DiscoveryRecordOptions,
  IntegrationActionExecutor,
  Jobs,
  Logger,
  OnboardingRuntime,
  PipelineIntegrationsPort,
  PlatformReadinessProbe,
  PlatformReadinessSignals,
  StartDiscoveryResult,
} from '@platform/application';
import {
  composeSecretRedactors,
  createOnboardingRuntime,
  gitReads,
  integrationsForProject,
  noRunScopedSecrets,
  startProjectDiscovery,
} from '@platform/application';
import type { Id, IntegrationType, IsoDateTime } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import {
  type eventing as eventingAdapters,
  knowledge as knowledgeAdapters,
  pipeline as pipelineAdapters,
  redaction as redactionAdapters,
  secrets as secretAdapters,
} from '@platform/infrastructure';
import type { IntegrationProber, IntegrationRegistry } from '@platform/integrations';
import { createIntegrationProber } from '@platform/integrations';
import type pg from 'pg';
import { injectedSecretRedactorForEnvironment } from './agent.js';
import { createProjectSettingsPort } from './pipeline.js';

const nowIso = (): IsoDateTime => new Date().toISOString() as IsoDateTime;

export interface OnboardingCommands {
  /** product/06 step 2. Idempotent on the project (`startProjectDiscovery` says why). */
  startDiscovery(input: {
    readonly projectId: Id;
    readonly userId: Id;
  }): Promise<StartDiscoveryResult>;
  /** product/06 step 1's "the platform validates access". `null` for an id nobody has. */
  testIntegration(integrationId: Id): Promise<{
    readonly ok: boolean;
    readonly checkedAt: string;
    readonly detail: string;
  } | null>;
}

export interface OnboardingCommandOptions {
  readonly pool: pg.Pool;
  readonly eventing: ReturnType<typeof eventingAdapters.createEventing>;
  /**
   * The job runtime, or `null` on a process that runs no workers.
   *
   * Unlike the Librarian's decide command, a discovery start **needs** one: the whole command is
   * "create a task and enqueue its stage", and without a queue the task would sit `active` at a
   * stage nothing runs. So the command refuses rather than half-performing.
   */
  readonly jobs: Jobs | null;
  /** `APP_BASE_URL` — the project page that stands in for a ticket URL. */
  readonly baseUrl: string;
  /** `APP_SECRET_KEY`, already validated by `config.ts`. */
  readonly secretKey: string;
  readonly registry: IntegrationRegistry;
  /**
   * The process's one `IntegrationActionExecutor` (`composeIntegrationStack`).
   *
   * Required: `POST /api/integrations/:id/test` is the product's only HTTP-triggered outbound
   * provider call, and CLAUDE.md's rule is that **every** outbound call goes through the executor —
   * so without it the wizard's probe would be the one unaudited, unrate-limited call in the
   * platform. Sharing the process's executor rather than building a second one is the same
   * argument `composeIntegrationStack` makes for the ingress: two executors mean two rate-limit
   * budgets for one account.
   */
  readonly executor: IntegrationActionExecutor;
  readonly logger: Logger;
}

export class OnboardingUnavailableError extends Error {
  override readonly name = 'OnboardingUnavailableError';
}

export const createOnboardingCommands = (options: OnboardingCommandOptions): OnboardingCommands => {
  const ids = { next: (): Id => randomUUID() as Id };
  const prober: IntegrationProber = createIntegrationProber({
    repository: secretAdapters.createPostgresBindingRepository(options.pool),
    secrets: secretAdapters.createPostgresSecretStore({
      sql: options.pool,
      key: secretAdapters.deriveSecretKey(options.secretKey),
    }),
    registry: options.registry,
    executor: options.executor,
    // TD-012 step 2 over the probe's detail, beside the account's own exact-match redactor.
    platformRedactor: redactionAdapters.patternRedactor(),
  });

  return {
    startDiscovery: async ({ projectId, userId }) => {
      const { jobs } = options;
      if (jobs === null) {
        throw new OnboardingUnavailableError(
          'this process runs no job workers, so it cannot start a discovery run: the task would be created and its stage would never execute. Ask an instance that runs the workers',
        );
      }
      return startProjectDiscovery(
        {
          unitOfWork: options.eventing.unitOfWork,
          store: pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES }),
          settings: createProjectSettingsPort(options.pool),
          jobs,
          ids,
          clock: { now: nowIso },
          baseUrl: options.baseUrl,
          logger: options.logger,
        },
        { projectId, requestedByUserId: userId },
      );
    },
    testIntegration: async (integrationId) => prober.test(integrationId),
  };
};

export interface ComposeOnboardingOptions {
  readonly pool: pg.Pool;
  readonly eventing: ReturnType<typeof eventingAdapters.createEventing>;
  readonly jobs: Jobs;
  /** The loader `composePipeline` built, so the R9 read goes through the one executor. */
  readonly integrations: PipelineIntegrationsPort;
  readonly runEnvironment: {
    readonly env: Readonly<Record<string, string>>;
    readonly secretEnvNames: readonly string[];
  };
  readonly logger: Logger;
}

export interface ComposedOnboarding {
  readonly runtime: OnboardingRuntime;
}

/** `projects` columns the record job re-reads when it fires (TD-004: a job re-reads). */
const readProject = async (
  pool: pg.Pool,
  projectId: Id,
): Promise<{ knowledgeDir: string } | null> => {
  const { rows } = await pool.query<{ knowledge_dir: string }>(
    'select knowledge_dir from projects where id = $1',
    [projectId],
  );
  const row = rows[0];
  return row === undefined ? null : { knowledgeDir: row.knowledge_dir };
};

/** The artifact and the run that produced it, for one task. */
const readArtifact = async (
  pool: pg.Pool,
  input: { readonly taskId: Id; readonly artifactId: Id },
): Promise<{ data: never; runId: Id | null } | null> => {
  const { rows } = await pool.query<{ data: unknown; produced_by_run_id: string | null }>(
    'select data, produced_by_run_id from artifacts where id = $1 and task_id = $2',
    [input.artifactId, input.taskId],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : { data: row.data as never, runId: (row.produced_by_run_id as Id | null) ?? null };
};

/**
 * The platform's own three readiness answers.
 *
 * Every read is wrapped: a probe that threw would fail the whole `onboarding.discovery` job and
 * leave a project with no evaluation at all, which is worse than an evaluation that says the
 * platform could not find out. The failure is logged with the project id and the criterion.
 */
export const createPlatformReadinessProbe = (options: {
  readonly pool: pg.Pool;
  readonly integrations: PipelineIntegrationsPort;
  readonly logger: Logger;
}): PlatformReadinessProbe => ({
  read: async (projectId: Id): Promise<PlatformReadinessSignals> => {
    let defaultBranchProtected: boolean | null = null;
    try {
      const resolved = await integrationsForProject(
        options.integrations,
        projectId,
        // Outside a run, so the call's scope holds no minted credential (Q55) — the same argument
        // `runIntakeCheck` makes for its own two reads.
        noRunScopedSecrets(),
      );
      const reads = gitReads(resolved);
      const callContext = { projectId, taskId: null };
      const head = await reads.defaultBranch(callContext);
      if (head !== null) {
        defaultBranchProtected = await reads.branchProtected(head.branch, callContext);
      }
    } catch (error) {
      options.logger.warn(
        { project_id: projectId, criterion: 'R9', error: (error as Error).message },
        'the readiness probe could not ask the git provider about the default branch; R9 is recorded as undetermined',
      );
    }

    const bound = await options.pool.query<{ type: string }>(
      `select i.type from bindings b join integrations i on i.id = b.integration_id
        where b.project_id = $1`,
      [projectId],
    );

    // `kb_documents.path` is repository-relative; the criterion is about the *vault*, so the
    // knowledge directory is stripped here — `knowledgeCompleteness` compares vault-relative paths.
    const project = await options.pool.query<{ knowledge_dir: string }>(
      'select knowledge_dir from projects where id = $1',
      [projectId],
    );
    const knowledgeDir = (project.rows[0]?.knowledge_dir ?? '.agentic/knowledge').replace(
      /\/+$/,
      '',
    );
    const indexed = await options.pool.query<{ path: string; built: boolean }>(
      `select d.path, (s.fts_built_at is not null) as built
         from kb_documents d
         left join kb_index_state s on s.project_id = d.project_id
        where d.project_id = $1`,
      [projectId],
    );
    // Never indexed and indexed-but-empty are different facts (the knowledge ports' own rule), and
    // only the first is `null`: an empty vault really is 0 % complete.
    const state = await options.pool.query<{ built: boolean }>(
      'select (fts_built_at is not null) as built from kb_index_state where project_id = $1',
      [projectId],
    );
    const everIndexed = state.rows[0]?.built === true;

    return {
      defaultBranchProtected,
      boundIntegrationTypes: bound.rows.map((row) => row.type as IntegrationType),
      indexedKnowledgePaths: everIndexed
        ? indexed.rows.map((row) =>
            row.path.startsWith(`${knowledgeDir}/`)
              ? row.path.slice(knowledgeDir.length + 1)
              : row.path,
          )
        : null,
    };
  },
});

/**
 * Registers the `DiscoveryDraft` trigger and starts the `onboarding.discovery` worker.
 *
 * One more pooled connection — the worker holds one during its single transaction — counted in
 * `POOL_RESERVATIONS.onboarding`.
 */
export const composeOnboardingRecording = async (
  options: ComposeOnboardingOptions,
): Promise<ComposedOnboarding> => {
  const record: DiscoveryRecordOptions = {
    unitOfWork: options.eventing.unitOfWork,
    eventStore: options.eventing.store,
    readiness: knowledgeAdapters.createPostgresReadinessStore(options.pool),
    proposals: new knowledgeAdapters.PostgresProposalStore(options.pool),
    knowledge: new knowledgeAdapters.PostgresKnowledgeStore(options.pool),
    signals: createPlatformReadinessProbe({
      pool: options.pool,
      integrations: options.integrations,
      logger: options.logger,
    }),
    clock: { now: nowIso },
    ids: { next: (): Id => randomUUID() as Id },
    // TD-012 over everything the discovery run wrote: the run's own injected credentials first,
    // then the platform's pattern rules. The same pair `createKnowledgeCommands` composes.
    redactor: composeSecretRedactors(
      injectedSecretRedactorForEnvironment(options.runEnvironment, options.logger),
      redactionAdapters.patternRedactor(),
    ),
    project: async (projectId) => readProject(options.pool, projectId),
    artifact: async (input) => readArtifact(options.pool, input),
    logger: options.logger,
  };

  const runtime = createOnboardingRuntime({ record, jobs: options.jobs });
  return { runtime };
};
