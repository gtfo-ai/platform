/**
 * The history bootstrap, composed for `apps/server` — product/06 step 3b, product/19 §18 (WP-35).
 *
 * One command, one gate and one runtime. The command records the intent and enqueues; the runtime
 * is the worker that reads the provider, creates the mining tasks and records what they find.
 * Everything after the `tasks` rows exist is the pipeline's — `stage.execute` runs the stages, the
 * cost ledger charges them, the transcript sink stores them — which is the whole reason the mining
 * is a task rather than a second path.
 *
 * It is shaped like `shadow.ts` and `onboarding.ts` next door for the same reason: which
 * collaborators exist is a property of the `ROLE`, and a route whose collaborator is absent answers
 * `503` by name rather than disappearing. `jobs` is what decides whether the command can work at
 * all — without a queue the batch row would sit at `collecting` for ever, which is worse than a
 * refusal.
 */
import { randomUUID } from 'node:crypto';
import type {
  HistoryBootstrapEstimateResult,
  HistoryBootstrapRuntime,
  Jobs,
  Logger,
  PipelineIntegrationsPort,
  StartHistoryBootstrapResult,
} from '@platform/application';
import {
  composeSecretRedactors,
  createHistoryBootstrapRuntime,
  estimateFor,
  HISTORY_BOOTSTRAP_BLOCKED_DETAIL,
  historyBootstrapBlocker,
  historyBootstrapSettings,
  startHistoryBootstrap,
} from '@platform/application';
import type { HistorySample, Id } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import {
  bootstrap as bootstrapAdapters,
  type eventing as eventingAdapters,
  knowledge as knowledgeAdapters,
  pipeline as pipelineAdapters,
  redaction as redactionAdapters,
} from '@platform/infrastructure';
import type pg from 'pg';
import { injectedSecretRedactorForEnvironment } from './agent.js';
import { OnboardingUnavailableError } from './onboarding.js';
import { createProjectSettingsPort } from './pipeline.js';
import type { Database } from './queries/bootstrap-queries.js';
import { hasGitBinding } from './queries/bootstrap-queries.js';

export interface HistoryBootstrapCommands {
  start(input: {
    readonly projectId: Id;
    readonly mergeRequests: number | null;
    readonly userId: Id;
  }): Promise<StartHistoryBootstrapResult>;
}

export interface HistoryBootstrapCommandOptions {
  readonly pool: pg.Pool;
  readonly database: Database;
  readonly eventing: ReturnType<typeof eventingAdapters.createEventing>;
  /** `null` on a process that runs no workers; the command refuses by name. */
  readonly jobs: Jobs | null;
  readonly logger?: Logger;
}

const nowIso = (): never => new Date().toISOString() as never;

export const createHistoryBootstrapCommands = (
  options: HistoryBootstrapCommandOptions,
): HistoryBootstrapCommands => ({
  start: async ({ projectId, mergeRequests, userId }) => {
    const { jobs } = options;
    if (jobs === null) {
      throw new OnboardingUnavailableError(
        'this process runs no job workers, so it cannot start a history bootstrap: the batch would be recorded and nothing would ever read the history. Ask an instance that runs the workers',
      );
    }
    return startHistoryBootstrap(
      {
        unitOfWork: options.eventing.unitOfWork,
        store: new bootstrapAdapters.PostgresHistoryBootstrapStore(),
        settings: createProjectSettingsPort(options.pool),
        jobs,
        ids: { next: (): Id => randomUUID() as Id },
        clock: { now: nowIso },
        hasGitBinding: async (id) => hasGitBinding(options.database, id),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      },
      { projectId, mergeRequests, requestedByUserId: userId },
    );
  },
});

export interface HistoryBootstrapGateResult {
  readonly canStart: boolean;
  readonly blockedReason: string | null;
  readonly estimate: HistoryBootstrapEstimateResult;
}

/**
 * Whether this project may start a bootstrap, and what one would cost — the read endpoint's half.
 *
 * It asks the application's own predicate and its own estimator rather than re-reading the
 * configuration here, so the screen and the command cannot disagree (standing rule 9). The two
 * facts the predicate cannot read off the settings — a git binding and a live batch — are looked up
 * here, where the database is.
 */
export const createHistoryBootstrapGate =
  (options: {
    readonly pool: pg.Pool;
    readonly database: Database;
    readonly eventing: ReturnType<typeof eventingAdapters.createEventing>;
  }) =>
  async (projectId: string, mergeRequests: number | null): Promise<HistoryBootstrapGateResult> => {
    const settings = await createProjectSettingsPort(options.pool).forProject(projectId as Id);
    const store = new bootstrapAdapters.PostgresHistoryBootstrapStore();
    const live = await options.eventing.unitOfWork.transaction(async (scope) =>
      store.liveBatch(scope.tx, projectId as Id),
    );
    const blocker = historyBootstrapBlocker(settings, {
      hasGitBinding: await hasGitBinding(options.database, projectId),
      liveBatch: live !== null,
    });
    return {
      canStart: blocker === null,
      blockedReason: blocker === null ? null : HISTORY_BOOTSTRAP_BLOCKED_DETAIL[blocker],
      // The caller's N, or the project's own — never a constant repeated here.
      estimate: estimateFor(
        settings,
        mergeRequests ?? historyBootstrapSettings(settings).mergeRequests,
      ),
    };
  };

export interface ComposeHistoryBootstrapOptions {
  readonly pool: pg.Pool;
  readonly eventing: ReturnType<typeof eventingAdapters.createEventing>;
  readonly jobs: Jobs;
  readonly integrations: PipelineIntegrationsPort;
  /**
   * TD-012 over everything the collection and the recorder write.
   *
   * The pair `composeOnboardingRecording` composes: the run environment's injected credentials
   * first, then the platform's pattern rules. A collection happens outside every run, so there is
   * no *run-scoped* credential in scope (Q55's other half) — what there **is** is the account's own
   * git and ticket tokens, which the binding loader's redactor removes at the transport, and the
   * pattern rules, which catch whatever a reviewer pasted into a comment six months ago.
   */
  readonly runEnvironment: {
    readonly env: Readonly<Record<string, string>>;
    readonly secretEnvNames: readonly string[];
  };
  readonly baseUrl: string;
  readonly logger: Logger;
}

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

const readArtifact = async (
  pool: pg.Pool,
  input: { readonly taskId: Id; readonly artifactId: Id },
): Promise<{ data: unknown; runId: Id | null } | null> => {
  const { rows } = await pool.query<{ data: unknown; produced_by_run_id: string | null }>(
    'select data, produced_by_run_id from artifacts where id = $1 and task_id = $2',
    [input.artifactId, input.taskId],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : { data: row.data, runId: (row.produced_by_run_id as Id | null) ?? null };
};

/**
 * The sample a mining run was shown, read back off the task row.
 *
 * It is the platform's own record of what it put in that prompt, and it is what makes a mined
 * citation checkable: `curateHistoryFindings` refuses a proposal whose link is not in
 * `evidence_links`. A task whose row has lost it produces **no** proposals rather than unevidenced
 * ones — the recorder says so by name.
 */
const readSample = async (pool: pg.Pool, taskId: Id): Promise<HistorySample | null> => {
  const { rows } = await pool.query<{ history_sample: HistorySample | null }>(
    'select history_sample from tasks where id = $1',
    [taskId],
  );
  return rows[0]?.history_sample ?? null;
};

/**
 * Registers the `HistoryFindings` trigger and starts the `bootstrap.history` worker.
 *
 * One more pooled connection — the worker holds one during each of its transactions — counted in
 * `POOL_RESERVATIONS.bootstrap`.
 */
export const composeHistoryBootstrap = (
  options: ComposeHistoryBootstrapOptions,
): HistoryBootstrapRuntime => {
  const ids = { next: (): Id => randomUUID() as Id };
  const clock = { now: nowIso };
  const store = new bootstrapAdapters.PostgresHistoryBootstrapStore();
  const redactor = composeSecretRedactors(
    injectedSecretRedactorForEnvironment(options.runEnvironment, options.logger),
    redactionAdapters.patternRedactor(),
  );
  return createHistoryBootstrapRuntime({
    jobs: options.jobs,
    logger: options.logger,
    collect: {
      unitOfWork: options.eventing.unitOfWork,
      store: pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES }),
      bootstrap: store,
      settings: createProjectSettingsPort(options.pool),
      integrations: options.integrations,
      jobs: options.jobs,
      ids,
      clock,
      baseUrl: options.baseUrl,
      redactor,
      logger: options.logger,
    },
    record: {
      unitOfWork: options.eventing.unitOfWork,
      bootstrap: store,
      proposals: new knowledgeAdapters.PostgresProposalStore(options.pool),
      knowledge: new knowledgeAdapters.PostgresKnowledgeStore(options.pool),
      eventStore: options.eventing.store,
      project: async (projectId) => readProject(options.pool, projectId),
      artifact: async (input) => readArtifact(options.pool, input),
      sample: async (taskId) => readSample(options.pool, taskId),
      redactor,
      ids,
      clock,
      logger: options.logger,
    },
  });
};
