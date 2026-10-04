/**
 * The onboarding wizard, composed for `apps/server` — product/06, product/17 (WP-21).
 *
 * Two halves, and they are separate because two different processes want them:
 *
 *  - {@link createOnboardingCommands} is what the **API** role calls — start a discovery run, test
 *    an integration. It borrows the pool per request and starts no worker.
 *  - {@link composeOnboardingRecording} is what a **worker** role registers: the `artifact.created`
 *    handler for a `DiscoveryDraft` and the `onboarding.discovery` job behind it, which is what
 *    writes `readiness_evaluations` and the drafted pages — and, since WP-64, the readiness
 *    re-check after a merge, on the same queue.
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
  BusinessInterviewAnswers,
  BusinessInterviewResult,
  DiscoveryRecordOptions,
  IntegrationActionExecutor,
  Jobs,
  Logger,
  OnboardingRuntime,
  PipelineIntegrationsPort,
  PlatformReadinessProbe,
  PlatformReadinessSignals,
  ReadinessCiEvents,
  ReadinessRecheckOptions,
  RediscoveryGate,
  RepositoryFileSource,
  StartDiscoveryResult,
  StartRediscoveryResult,
} from '@platform/application';
import {
  composeSecretRedactors,
  createOnboardingRuntime,
  gitReads,
  integrationsForProject,
  noRunScopedSecrets,
  readRediscoveryGate,
  recordBusinessInterview,
  startProjectDiscovery,
  startProjectRediscovery,
} from '@platform/application';
import type { Id, IntegrationType, IsoDateTime, JsonObject } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import {
  eventing as eventingAdapters,
  knowledge as knowledgeAdapters,
  pipeline as pipelineAdapters,
  redaction as redactionAdapters,
  secrets as secretAdapters,
} from '@platform/infrastructure';
import type { BoundProject, IntegrationProber, IntegrationRegistry } from '@platform/integrations';
import { accountOnlyFieldsOf, createIntegrationProber } from '@platform/integrations';
import type pg from 'pg';
import { injectedSecretRedactorForEnvironment } from './agent.js';
import { createProjectSettingsPort, repositoryPathOf } from './pipeline.js';
import { claimIdempotentAttemptInTransaction } from './queries/onboarding-queries.js';

const nowIso = (): IsoDateTime => new Date().toISOString() as IsoDateTime;

export interface OnboardingCommands {
  /** product/06 step 2. Idempotent on the project (`startProjectDiscovery` says why). */
  startDiscovery(input: {
    readonly projectId: Id;
    readonly userId: Id;
  }): Promise<StartDiscoveryResult>;
  /**
   * A maintainer's re-evaluate (WP-94, Q107 (a)): a new one-off discovery task beside the first,
   * refused by name while one runs, before the first exists, or after the bounded attempts.
   */
  startRediscovery(input: {
    readonly projectId: Id;
    readonly userId: Id;
  }): Promise<StartRediscoveryResult>;
  /**
   * product/06 step 3, the business interview (WP-64): one queued knowledge proposal per answered
   * section. Needs no job runtime — it writes rows and asks for nothing to run.
   */
  recordInterview(input: {
    readonly projectId: Id;
    readonly userId: Id;
    readonly answers: BusinessInterviewAnswers;
    /**
     * The `human_actions` row, written in the proposals' own transaction and refused when this
     * caller's key already performed the interview (`claimIdempotentAttemptInTransaction`). The
     * pages and the redaction count are added to `params` here, where they are known.
     */
    readonly audit: {
      readonly action: string;
      readonly key: string;
      readonly params: JsonObject;
    };
  }): Promise<BusinessInterviewResult>;
  /** product/06 step 1's "the platform validates access". `null` for an id nobody has. */
  testIntegration(integrationId: Id): Promise<{
    readonly ok: boolean;
    readonly checkedAt: string;
    readonly detail: string;
    /** `connection`, and `run_credential` for a static run credential (WP-137). */
    readonly checks: readonly {
      readonly name: string;
      readonly ok: boolean;
      readonly detail: string;
    }[];
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
  /**
   * The environment a run is given (WP-64), so an interview answer that repeats the model
   * credential is redacted before it reaches a row — the pair `createKnowledgeCommands` composes for
   * a maintainer's edit, which is the same kind of write: a person's text becoming a page.
   */
  readonly runEnvironment: {
    readonly env: Readonly<Record<string, string>>;
    readonly secretEnvNames: readonly string[];
  };
  readonly logger: Logger;
}

/**
 * The **one** project bound to an integration — its repository path and its stored default branch —
 * or `null` when none is, or when more than one is, which a static integration refuses at the binding
 * write and which the probe then reports as not checkable rather than choosing (WP-137, TD-028
 * decision 13 item 3). The default branch is the one an operator's own run token is checked behind
 * (WP-141, decision 13a item 2): the platform's stored value, never the provider's.
 */
export const boundProjectReader =
  (pool: Pick<pg.Pool, 'query'>) =>
  async (integrationId: string): Promise<BoundProject | null> => {
    const { rows } = await pool.query<{ repo_url: string; default_branch: string }>(
      `select p.repo_url, p.default_branch from bindings b join projects p on p.id = b.project_id
        where b.integration_id = $1 order by b.created_at limit 2`,
      [integrationId],
    );
    const only = rows.length === 1 ? rows[0] : undefined;
    return only === undefined
      ? null
      : { path: repositoryPathOf(only.repo_url), defaultBranch: only.default_branch };
  };

export class OnboardingUnavailableError extends Error {
  override readonly name = 'OnboardingUnavailableError';
}

export const createOnboardingCommands = (options: OnboardingCommandOptions): OnboardingCommands => {
  const ids = { next: (): Id => randomUUID() as Id };
  const prober: IntegrationProber = createIntegrationProber({
    repository: secretAdapters.createPostgresBindingRepository(options.pool, accountOnlyFieldsOf),
    secrets: secretAdapters.createPostgresSecretStore({
      sql: options.pool,
      key: secretAdapters.deriveSecretKey(options.secretKey),
    }),
    registry: options.registry,
    executor: options.executor,
    // TD-012 step 2 over the probe's detail, beside the account's own exact-match redactor.
    platformRedactor: redactionAdapters.patternRedactor(),
    // WP-137: where a static run credential's user is checked — the one project bound to the
    // integration (a static integration may have one), as its repository path; WP-141: and the
    // default branch an operator's own run token is checked behind.
    boundProjectOf: boundProjectReader(options.pool),
  });
  // TD-012 over interview answers: the run environment's credentials first, then the pattern rules.
  const interviewRedactor = composeSecretRedactors(
    injectedSecretRedactorForEnvironment(options.runEnvironment, options.logger),
    redactionAdapters.patternRedactor(),
  );

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
    startRediscovery: async ({ projectId, userId }) => {
      const { jobs } = options;
      if (jobs === null) {
        throw new OnboardingUnavailableError(
          'this process runs no job workers, so it cannot run discovery again: the task would be created and its stage would never execute. Ask an instance that runs the workers',
        );
      }
      return startProjectRediscovery(
        {
          unitOfWork: options.eventing.unitOfWork,
          store: pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES }),
          settings: createProjectSettingsPort(options.pool),
          readiness: knowledgeAdapters.createPostgresReadinessStore(options.pool),
          jobs,
          ids,
          clock: { now: nowIso },
          baseUrl: options.baseUrl,
          logger: options.logger,
        },
        { projectId, requestedByUserId: userId },
      );
    },
    recordInterview: async ({ projectId, userId, answers, audit }) =>
      recordBusinessInterview(
        {
          unitOfWork: options.eventing.unitOfWork,
          eventStore: options.eventing.store,
          proposals: new knowledgeAdapters.PostgresProposalStore(options.pool),
          knowledge: new knowledgeAdapters.PostgresKnowledgeStore(options.pool),
          clock: { now: nowIso },
          ids,
          redactor: interviewRedactor,
          project: async (id) => readProject(options.pool, id),
        },
        {
          projectId,
          userId,
          answers,
          claim: async (tx, recorded) =>
            claimIdempotentAttemptInTransaction(eventingAdapters.postgresTransaction(tx).client, {
              userId,
              action: audit.action,
              key: audit.key,
              params: {
                ...audit.params,
                sections: recorded.pages.map((page) => page.section),
                pages: recorded.pages.map((page) => ({
                  proposal_id: page.proposalId,
                  section: page.section,
                  target_path: page.targetPath,
                  status: page.status,
                  truncated: page.truncated,
                })),
                redactions: recorded.redactions,
              },
            }),
        },
      ),
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
  /** The mirror's named-file reader (`composeKnowledgeIndexing`), for the re-check's R8 (WP-64). */
  readonly files: RepositoryFileSource;
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

/**
 * The artifact, the run that produced it and its task's ticket key — the key is what tells a
 * re-evaluation from the first discovery (WP-94), so the evaluation names its source.
 */
const readArtifact = async (
  pool: pg.Pool,
  input: { readonly taskId: Id; readonly artifactId: Id },
): Promise<{ data: never; runId: Id | null; ticketKey: string } | null> => {
  const { rows } = await pool.query<{
    data: unknown;
    produced_by_run_id: string | null;
    ticket_key: string;
  }>(
    `select a.data, a.produced_by_run_id, t.ticket_key
       from artifacts a join tasks t on t.id = a.task_id
      where a.id = $1 and a.task_id = $2`,
    [input.artifactId, input.taskId],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : {
        data: row.data as never,
        runId: (row.produced_by_run_id as Id | null) ?? null,
        ticketKey: row.ticket_key,
      };
};

/**
 * Whether a re-evaluation may start, and what it may cost — the read endpoint's half (WP-94).
 *
 * Composed on every API process, like the history bootstrap's gate: the answer is about the
 * project's settings, its discovery tasks and its latest evaluation, none of which needs a worker.
 */
export const createRediscoveryGate =
  (options: {
    readonly pool: pg.Pool;
    readonly eventing: ReturnType<typeof eventingAdapters.createEventing>;
  }) =>
  async (projectId: string): Promise<RediscoveryGate> =>
    readRediscoveryGate(
      {
        unitOfWork: options.eventing.unitOfWork,
        store: pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES }),
        settings: createProjectSettingsPort(options.pool),
        readiness: knowledgeAdapters.createPostgresReadinessStore(options.pool),
        // The wall clock: "started 12 minutes ago" is a sentence for the person reading the gate now.
        clock: { now: () => new Date().toISOString() },
        // WP-124, backlog 366: the recovery pass's ending for a task whose findings were lost.
        findingsUnrecorded: async (taskId) => {
          const { rows } = await options.pool.query<{ ended_at: Date; detail: string }>(
            `select r.ended_at, r.detail
               from discovery_record_recoveries r
               join artifacts a on a.id = r.artifact_id
              where a.task_id = $1 and r.ended_at is not null
              order by r.ended_at desc
              limit 1`,
            [taskId],
          );
          const row = rows[0];
          return row === undefined
            ? null
            : { at: new Date(row.ended_at).toISOString() as IsoDateTime, reason: row.detail };
        },
      },
      projectId as Id,
    );

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
      // WP-142 (backlog 441): R9 asks about the **stored** default branch — the one intake checks
      // and every merge request targets — never the provider's default.
      const stored = await options.pool.query<{ default_branch: string }>(
        'select default_branch from projects where id = $1',
        [projectId],
      );
      const branch = stored.rows[0]?.default_branch;
      if (branch !== undefined) {
        defaultBranchProtected = await gitReads(resolved).branchProtected(branch, {
          projectId,
          taskId: null,
        });
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
 * R3's evidence for the re-check — `ci.pipeline.finished` events carrying a merge request (WP-64).
 *
 * Read off the append-only `events` table, which is the one place a pipeline event is kept: it
 * needs no projection of its own, and the window keeps the read inside the `(type, occurred_at)`
 * index and the partitions it names. `mr` is `nullish` on the payload, so a JSON `null` and an
 * absent key both mean "no merge request", which is what `jsonb_typeof = 'object'` asks.
 */
export const createReadinessCiEvents = (pool: pg.Pool): ReadinessCiEvents => ({
  mergeRequestPipelinesSince: async (projectId, since) => {
    const { rows } = await pool.query<{ count: number }>(
      `select count(*)::int as count
         from events
        where type = 'ci.pipeline.finished'
          and occurred_at >= $2
          and payload->>'project_id' = $1
          and jsonb_typeof(payload->'mr') = 'object'`,
      [projectId, since],
    );
    return rows[0]?.count ?? 0;
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

  const recheck: ReadinessRecheckOptions = {
    unitOfWork: options.eventing.unitOfWork,
    eventStore: options.eventing.store,
    readiness: record.readiness,
    // The same probe discovery uses: R9, R11 and R12 are answered one way whoever asks.
    signals: record.signals,
    files: options.files,
    ciEvents: createReadinessCiEvents(options.pool),
    clock: { now: nowIso },
    ids: { next: (): Id => randomUUID() as Id },
    project: async (projectId) => readProject(options.pool, projectId),
    logger: options.logger,
  };

  const runtime = createOnboardingRuntime({ record, recheck, jobs: options.jobs });
  return { runtime };
};
