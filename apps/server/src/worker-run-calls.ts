/**
 * **What a remote run needs from the core while it runs, composed** (WP-282) — the collaborators of
 * `createRemoteRunCalls` (`@platform/application`), for every process that serves the API, beside
 * `composeRemoteRuns` (`worker-protocol.ts`):
 *
 * - **the run's redactor, rebuilt from stored state** ({@link createRemoteRunRedactors}, TD-031 §10a,
 *   backlog 745) — the project's binding redactors (git, task management, communication, both
 *   observability types: every sealed secret of every binding, a static run token and a deploy key
 *   among them), this process's model credential by exact value, and `stack.platformRedactor` (the
 *   process's run-scoped registry and the pattern rules, which carry every recorded minted-credential
 *   shape). What it cannot rebuild, stated: a minted token's exact value lives only in the minting
 *   process's memory; elsewhere it is replaced by its recorded shape.
 * - **the platform tools** — the production `PlatformToolPort` through `composePipelinePlatformTools`,
 *   the very composition the server's runner is given, so a remote run's `open_mr` is the same code
 *   over the same executor (TD-031 §10b);
 * - **the approvals port** — `unattendedToolApprovals`, BD-025's unattended default, which the
 *   server's runner composes too;
 * - **the deploy key** ({@link createRemoteRunDeployKeys}) — WP-146's oracle over the project's sealed
 *   key, for a run whose `runs.credential_source` is `deploy_key` and nothing else.
 *
 * The bindings are resolved per run and kept for {@link REMOTE_RUN_BINDINGS_TTL_MS}: a transcript
 * batch arrives every few seconds and a binding load decrypts every secret of the project, so a
 * short cache is the difference between one decryption per run and one per batch. A credential
 * re-sealed inside the window is redacted by its old value until the window passes — stated, and
 * bounded by the window.
 */
import {
  composeSecretRedactors,
  createRemoteRunCalls,
  injectedSecretRedactorForEnvironment,
  integrationsForProject,
  type Logger,
  markTransactions,
  noRunScopedSecrets,
  observabilityForProject,
  type PipelineIntegrationsPort,
  type RemoteRunCalls,
  type RemoteRunDeployKeys,
  type RemoteRunRedactors,
  type RunDeployKeySigner,
  type SecretRedactor,
} from '@platform/application';
import { type Id, type RunDisplay, runDisplaySchema } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import {
  type eventing as eventingAdapters,
  launcher as launcherAdapters,
  pipeline as pipelineAdapters,
  secrets as secretAdapters,
} from '@platform/infrastructure';
import type pg from 'pg';
import { agentRunEnvironment, unattendedToolApprovals } from './agent.js';
import {
  composePipelinePlatformTools,
  createProjectIntegrationsPort,
  type IntegrationStack,
} from './pipeline.js';
import { ticketTitleOf } from './queries/pipeline-queries.js';

/** How long a run's resolved bindings are reused (module docblock). */
export const REMOTE_RUN_BINDINGS_TTL_MS = 30_000;

/** The most runs whose bindings one process keeps at once; the oldest is dropped past it. */
export const REMOTE_RUN_BINDINGS_MAX_ENTRIES = 512;

interface AgentCredentials {
  readonly providerMode: 'api' | 'local';
  readonly modelApiKey: string | null;
  readonly modelOauthToken: string | null;
}

/** A small TTL cache keyed by run id, bounded by {@link REMOTE_RUN_BINDINGS_MAX_ENTRIES}. */
const ttlCache = <T>(ttlMs: number, now: () => number) => {
  const entries = new Map<string, { readonly at: number; readonly value: Promise<T> }>();
  return async (key: string, load: () => Promise<T>): Promise<T> => {
    const at = now();
    const hit = entries.get(key);
    if (hit !== undefined && at - hit.at < ttlMs) {
      return hit.value;
    }
    for (const [stale, entry] of entries) {
      if (at - entry.at >= ttlMs) entries.delete(stale);
    }
    while (entries.size >= REMOTE_RUN_BINDINGS_MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    const value = load();
    entries.set(key, { at, value });
    // A failed load is not kept: the next call asks again.
    value.catch(() => entries.delete(key));
    return value;
  };
};

/**
 * The project's binding redactors composed before `base` — every binding the project has, each
 * carrying its own sealed secrets (TD-012 step 1) and the pattern rules (step 2).
 */
export const projectBindingRedactor = async (
  integrations: PipelineIntegrationsPort,
  projectId: Id,
  base: SecretRedactor,
): Promise<SecretRedactor> => {
  const scope = noRunScopedSecrets();
  const project = await integrationsForProject(integrations, projectId, scope);
  const errors = await observabilityForProject(integrations, projectId, 'errors', scope);
  const logs = await observabilityForProject(integrations, projectId, 'logs', scope);
  const bindings = [
    project.git?.redactor,
    project.taskManagement?.redactor,
    project.communication?.redactor,
    errors?.redactor,
    logs?.redactor,
  ].filter((redactor): redactor is SecretRedactor => redactor !== undefined);
  return composeSecretRedactors(...bindings, base);
};

export const createRemoteRunRedactors = (options: {
  readonly integrations: PipelineIntegrationsPort;
  readonly stack: Pick<IntegrationStack, 'platformRedactor'>;
  readonly agent: AgentCredentials;
  readonly logger: Logger;
  readonly now?: () => number;
}): RemoteRunRedactors & {
  /** Bindings and the platform's rules only — what `settleRun` composes its own step 1 over. */
  readonly baseFor: (run: {
    readonly runId: Id;
    readonly projectId: Id;
  }) => Promise<SecretRedactor>;
} => {
  const cache = ttlCache<SecretRedactor>(REMOTE_RUN_BINDINGS_TTL_MS, options.now ?? Date.now);
  const baseFor = async (run: { readonly runId: Id; readonly projectId: Id }) =>
    cache(run.runId, () =>
      projectBindingRedactor(options.integrations, run.projectId, options.stack.platformRedactor),
    );
  return {
    baseFor,
    forRun: async (run) => {
      // This process's own model credential by exact value: the worker's is redacted on the worker,
      // and the core never knows it (TD-031 §10a); a name with no value here would only warn.
      const environment = agentRunEnvironment(options.agent);
      return composeSecretRedactors(
        injectedSecretRedactorForEnvironment(environment, options.logger, { runId: run.runId }),
        await baseFor(run),
      );
    },
  };
};

/**
 * WP-146's oracle for a remote run's deploy key: only for a run the minter recorded as given one
 * (`runs.credential_source = 'deploy_key'`, written at packaging), over the project's sealed key.
 */
export const createRemoteRunDeployKeys = (options: {
  readonly pool: pg.Pool;
  readonly integrations: PipelineIntegrationsPort;
  readonly logger: Logger;
  readonly now?: () => number;
}): RemoteRunDeployKeys => {
  const cache = ttlCache<RunDeployKeySigner | null>(
    REMOTE_RUN_BINDINGS_TTL_MS,
    options.now ?? Date.now,
  );
  return {
    // Never cached (backlog 753): the claim's eligibility reads it once; a signature reads it again.
    remoteRunCredential: (projectId) => remoteRunCredentialOf(options.pool)(projectId),
    forRun: async (run) => {
      const { rows } = await options.pool.query<{ credential_source: string | null }>(
        'select credential_source from runs where id = $1',
        [run.runId],
      );
      if (rows[0]?.credential_source !== 'deploy_key') {
        return null;
      }
      return cache(run.runId, async () => {
        const project = await integrationsForProject(
          options.integrations,
          run.projectId,
          noRunScopedSecrets(),
        );
        const key = project.git?.deployKeyRunCredential;
        if (key === undefined || key.refusal !== null || key.privateKey === '') {
          options.logger.warn(
            { run_id: run.runId, project_id: run.projectId },
            'a remote run was given a deploy key its project no longer holds usably; ssh-sign refuses',
          );
          return null;
        }
        return launcherAdapters.createDeployKeyOracle({
          privateKey: key.privateKey,
          publicKey: key.publicKey,
        });
      });
    },
  };
};

/**
 * The git integration's `remote_run_credential` for a project (WP-282, Q124 (a)), read **exactly as
 * the claim reads it** (`WORKER_ELIGIBLE` in `postgres-run-offers.ts`): `allow` when no live git
 * binding of the project declares a non-minted run credential without `remote_run_credential:
 * allow` — every such binding must allow, and absent is `deny`. A project whose bindings all mint
 * answers `allow`, which the packager never asks about (it asks only for a static or deploy-key
 * credential).
 */
export const remoteRunCredentialOf =
  (pool: Pick<pg.Pool, 'query'>) =>
  async (projectId: string): Promise<'allow' | 'deny'> => {
    const { rows } = await pool.query<{ refused: boolean }>(
      `select exists (
         select 1
           from bindings b
           join integrations i on i.id = b.integration_id
          where b.project_id = $1
            and i.type = 'git'
            and i.retired_at is null
            and coalesce(i.config ->> 'run_credential', 'minted') <> 'minted'
            and coalesce(i.config ->> 'remote_run_credential', 'deny') <> 'allow'
       ) as refused`,
      [projectId],
    );
    return rows[0]?.refused === false ? 'allow' : 'deny';
  };

/** The display block's title bound (`runDisplaySchema`). */
const DISPLAY_TITLE_MAX_CHARS = 500;

/**
 * The worker's local page's names for a run (WP-292, TD-031's worker-UI amendment §3): the project's
 * key and the task's ticket key and title. The title is read from `tasks.ticket_snapshot`, which is
 * **bounded and redacted at its write** (WP-15f) — the same words the task page shows — and cut to
 * the block's bound. `null` for a run whose task or project is gone.
 */
export const runDisplayOf =
  (pool: Pick<pg.Pool, 'query'>) =>
  async (taskId: string): Promise<RunDisplay | null> => {
    const { rows } = await pool.query<{
      project_key: string;
      ticket_key: string;
      ticket_snapshot: unknown;
    }>(
      `select p.key as project_key, t.ticket_key, t.ticket_snapshot
         from tasks t join projects p on p.id = t.project_id
        where t.id = $1`,
      [taskId],
    );
    const row = rows[0];
    if (row === undefined) return null;
    const title = ticketTitleOf(row.ticket_snapshot);
    const parsed = runDisplaySchema.safeParse({
      projectKey: row.project_key,
      ticketKey: row.ticket_key,
      title: title === null ? null : title.slice(0, DISPLAY_TITLE_MAX_CHARS),
    });
    return parsed.success ? parsed.data : null;
  };

/**
 * The names `GET offers` lists each offer by (WP-293, TD-031's claim-scope amendment §4): the
 * {@link runDisplayOf} rule — the project's key, the ticket's key, the title from the **redacted**
 * ticket snapshot cut to the block's bound — for many tasks in one statement. A task whose names do
 * not fit the block is absent from the map, and its offer is listed without names.
 */
export const offerDisplaysOf =
  (pool: Pick<pg.Pool, 'query'>) =>
  async (taskIds: readonly string[]): Promise<ReadonlyMap<string, RunDisplay>> => {
    const displays = new Map<string, RunDisplay>();
    if (taskIds.length === 0) return displays;
    const { rows } = await pool.query<{
      id: string;
      project_key: string;
      ticket_key: string;
      ticket_snapshot: unknown;
    }>(
      `select t.id, p.key as project_key, t.ticket_key, t.ticket_snapshot
         from tasks t join projects p on p.id = t.project_id
        where t.id = any($1::uuid[])`,
      [[...taskIds]],
    );
    for (const row of rows) {
      const title = ticketTitleOf(row.ticket_snapshot);
      const parsed = runDisplaySchema.safeParse({
        projectKey: row.project_key,
        ticketKey: row.ticket_key,
        title: title === null ? null : title.slice(0, DISPLAY_TITLE_MAX_CHARS),
      });
      if (parsed.success) displays.set(row.id, parsed.data);
    }
    return displays;
  };

export interface ComposeRemoteRunCallsOptions {
  readonly pool: pg.Pool;
  readonly eventing: ReturnType<typeof eventingAdapters.createEventing>;
  readonly stack: IntegrationStack;
  readonly secretKey: string;
  readonly agent: AgentCredentials;
  readonly logger: Logger;
}

export const composeRemoteRunCalls = (
  options: ComposeRemoteRunCallsOptions,
): {
  readonly calls: RemoteRunCalls;
  readonly redactors: ReturnType<typeof createRemoteRunRedactors>;
} => {
  const unitOfWork = markTransactions(options.eventing.unitOfWork);
  const pipelineStore = pipelineAdapters.createPostgresPipelineStore({
    templates: SHIPPED_TEMPLATES,
    logger: options.logger,
  });
  const integrations = createProjectIntegrationsPort({
    pool: options.pool,
    secretKey: options.secretKey,
    stack: options.stack,
  });
  const redactors = createRemoteRunRedactors({
    integrations,
    stack: options.stack,
    agent: options.agent,
    logger: options.logger,
  });
  const calls = createRemoteRunCalls({
    unitOfWork,
    store: pipelineAdapters.createPostgresRemoteRunCallStore(),
    pipeline: pipelineStore,
    runPlans: secretAdapters.createEnvelopeRunPlanSealer(
      secretAdapters.deriveSecretKey(options.secretKey),
    ),
    redactors,
    tools: composePipelinePlatformTools({
      pool: options.pool,
      logger: options.logger,
      unitOfWork,
      tasks: pipelineStore.tasks,
      integrations,
      // The tools read only the model credential (`agentRunEnvironment`); no binary is run here.
      agent: { ...options.agent, claudeBinary: null },
    }),
    approvals: unattendedToolApprovals(options.logger),
    deployKeys: createRemoteRunDeployKeys({
      pool: options.pool,
      integrations,
      logger: options.logger,
    }),
    maxSignatures: launcherAdapters.MAX_DEPLOY_KEY_SIGNATURES,
    logger: options.logger,
  });
  return { calls, redactors };
};
