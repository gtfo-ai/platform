/**
 * Composing the knowledge indexer into `apps/server` — WP-18a, TD-026.
 *
 * WP-16 built `KnowledgeIndexer`, its ports and one adapter, and wired no job: nothing could hand
 * the indexer a tree, because the only `VaultSource` read a checkout on the server's own filesystem
 * and this process has none. TD-026 decided where the tree comes from — a **platform-side bare
 * mirror**, cloned and fetched by this process with the `git` binary under
 * `APP_KNOWLEDGE_MIRROR_ROOT` — and this file is the composition: the store, the vault, the indexer,
 * the `knowledge.index` queue and the two trigger handlers.
 *
 * ## Three ways it refuses, all by name
 *
 * `APP_KNOWLEDGE_MIRROR_ROOT` unset, `git` not on this process' PATH, and a project with no git
 * binding are three different absences, and each gets its own sentence rather than an empty index
 * (standing rules 18 and 31). The first two compose {@link unavailableVaultSource} — a refusal, not
 * a null object, exactly like `unavailableClaudeRunner` beside it — so the job still exists, still
 * runs, and reports `vault_unavailable` naming the missing piece; the indexer's own rule then leaves
 * whatever is already indexed exactly where it is. `/readyz` is unaffected: an index nobody can
 * build does not make a process an incomplete event consumer.
 *
 * The third is per project and per call: `createGitMirrorCredentials` answers `null` for a project
 * with no git binding and throws for one whose binding cannot be read, which the adapter turns into
 * two different reasons.
 *
 * ## The Librarian's half (WP-18b)
 *
 * The same composition now also starts the three queues of `createLibrarianRuntime` — the curation
 * that turns a `LibrarianProposals` artifact into `kb_proposals` rows, the apply pass that commits
 * them through the git provider, and the nightly hygiene schedule — plus the `decideKnowledgeProposal`
 * command the API routes call. They are here rather than in `composePipeline` for the reason the
 * index job is: technical/07's knowledge base is a projection of the project's **default branch**
 * and a governance queue over it, not a step of a ticket's journey.
 *
 * Two collaborators it borrows from the pipeline, and both are deliberate rather than convenient:
 * the **integrations loader**, because a knowledge commit is a provider mutation and must go
 * through the same `IntegrationActionExecutor` (shadow mode, idempotency, rate limits, audit) as
 * every other one; and the **redactor**, which is TD-012 step 2 composed *after* this process'
 * run-environment secrets, so a proposal repeating the model credential it was given cannot reach a
 * row or a commit.
 *
 * ## Why the credential is read here and not through the pipeline's loader
 *
 * `createPipelineIntegrationsLoader` hands back provider **ports** — HTTP clients that deliberately
 * never expose the plaintext credential, because every call they mediate goes through
 * `IntegrationActionExecutor`. A `git clone` is not one of those calls (see `git-vault.ts` §
 * "What the fetch is not"), so the mirror takes the same rows through
 * `createGitMirrorCredentials`, which stops one step earlier and hands the secret to one subprocess
 * and nowhere else.
 */

import { randomUUID } from 'node:crypto';
import type {
  DecideProposalInput,
  DecideProposalResult,
  EventHandler,
  Jobs,
  KnowledgeIndexProject,
  LibrarianArtifact,
  Logger,
  PipelineIntegrationsPort,
  ProposalCursor,
  StoredKnowledgeProposal,
  VaultSource,
} from '@platform/application';
import {
  composeSecretRedactors,
  createKnowledgeIndexer,
  createKnowledgeIndexRuntime,
  createLibrarianRuntime,
  decideKnowledgeProposal,
  thresholdsFromConfig,
} from '@platform/application';
import type { Id, IsoDateTime, TaskMode } from '@platform/contracts';
import {
  type eventing as eventingAdapters,
  knowledge as knowledgeAdapters,
  redaction as redactionAdapters,
  secrets as secretAdapters,
} from '@platform/infrastructure';
import type { IntegrationRegistry } from '@platform/integrations';
import { createGitMirrorCredentials } from '@platform/integrations';
import type pg from 'pg';
import { injectedSecretRedactorForEnvironment } from './agent.js';

export interface ComposeKnowledgeOptions {
  readonly pool: pg.Pool;
  readonly eventing: ReturnType<typeof eventingAdapters.createEventing>;
  readonly jobs: Jobs;
  /**
   * The pipeline's own binding loader, so a knowledge commit goes through the one executor this
   * process composed (`composePipeline` returns it).
   *
   * `null` for a process that composed no pipeline: the librarian queues are then not started at
   * all, because every one of them ends in a provider call or in a decision about one.
   */
  readonly integrations: PipelineIntegrationsPort | null;
  /** TD-012 step 1 over this process' run environment; composed with the pattern rules here. */
  readonly runEnvironment: {
    readonly env: Readonly<Record<string, string>>;
    readonly secretEnvNames: readonly string[];
  };
  /** IANA zone the nightly hygiene schedule is read in (`APP_TIMEZONE`). */
  readonly timezone: string;
  /** `APP_SECRET_KEY`, already validated by `config.ts`. */
  readonly secretKey: string;
  /** The process's one provider registry, from the shared {@link IntegrationStack}. */
  readonly registry: IntegrationRegistry;
  /** `APP_KNOWLEDGE_MIRROR_ROOT`. `null` is unset, and it never defaults to a path (TD-026 §5). */
  readonly mirrorRoot: string | null;
  readonly logger: Logger;
}

export interface ComposedKnowledgeIndexing {
  /** Registered on the `EventBus` by the composition root, before the outbox worker starts. */
  readonly handlers: readonly EventHandler[];
  /**
   * What this process could not compose for an index run, by name, or empty when it composed a real
   * vault source. Returned rather than only logged, so `runtime.ts` and a test read the same answer
   * (the shape `ComposedPipeline.agentMissing` uses).
   */
  readonly missing: readonly string[];
  stop(): Promise<void>;
}

/**
 * What the API routes may ask the Librarian to do.
 *
 * One method today. It is an object rather than a bare function so that `buildApp` takes the same
 * shape it takes for `webhooks` — a collaborator a role composes or does not — and so that the next
 * command (a rebuild, a bootstrap) lands beside it instead of in a second parameter.
 */
export interface KnowledgeCommands {
  decide(input: DecideProposalInput): Promise<DecideProposalResult>;
  /** A page of a project's proposals, newest first — `GET /api/projects/:id/kb/proposals`. */
  list(
    projectId: Id,
    query: { readonly limit: number; readonly before?: ProposalCursor },
  ): Promise<readonly StoredKnowledgeProposal[]>;
}

export interface KnowledgeCommandOptions {
  readonly pool: pg.Pool;
  readonly eventing: ReturnType<typeof eventingAdapters.createEventing>;
  /**
   * The job runtime, or `null` on a process that runs no workers (`ROLE=api`).
   *
   * Not an omission: `decide.ts` takes a nullable `Jobs` on purpose and states the cost — with one,
   * an approved proposal is committed in seconds; without one, the decision is still recorded and
   * the nightly hygiene pass picks it up. What must not happen is the *decision* being lost, and
   * that is written inside the transaction before anything is enqueued.
   */
  readonly jobs: Jobs | null;
  readonly runEnvironment: {
    readonly env: Readonly<Record<string, string>>;
    readonly secretEnvNames: readonly string[];
  };
  readonly logger: Logger;
}

/**
 * The Librarian's commands, for whichever process serves the API.
 *
 * Composed separately from the queues because the two answer to different capabilities: a process
 * that serves the API can read the proposal queue and record a decision on it with nothing but the
 * pool, while *applying* one needs a job runtime and an integrations loader. A deployment split into
 * `ROLE=api` and `ROLE=worker` therefore keeps a working knowledge screen.
 */
export const createKnowledgeCommands = (options: KnowledgeCommandOptions): KnowledgeCommands => {
  const proposals = new knowledgeAdapters.PostgresProposalStore(options.pool);
  const clock = { now: () => new Date().toISOString() as IsoDateTime };
  const ids = { next: (): Id => randomUUID() as Id };
  const redactor = composeSecretRedactors(
    injectedSecretRedactorForEnvironment(options.runEnvironment, options.logger),
    redactionAdapters.patternRedactor(),
  );
  return {
    decide: async (input) =>
      decideKnowledgeProposal(
        {
          unitOfWork: options.eventing.unitOfWork,
          eventStore: options.eventing.store,
          proposals,
          clock,
          ids,
          redactor,
          jobs: options.jobs,
          logger: options.logger,
        },
        input,
      ),
    list: async (projectId, query) => proposals.list(projectId, query),
  };
};

/** `projects` row the indexer needs. One query, two readers — the job's and the mirror's. */
interface ProjectVaultRow {
  readonly key: string;
  readonly repo_url: string;
  readonly default_branch: string;
  readonly knowledge_dir: string;
}

const readProject = async (pool: pg.Pool, projectId: Id): Promise<ProjectVaultRow | null> => {
  const { rows } = await pool.query<ProjectVaultRow>(
    'select key, repo_url, default_branch, knowledge_dir from projects where id = $1',
    [projectId],
  );
  return rows[0] ?? null;
};

export const composeKnowledgeIndexing = async (
  options: ComposeKnowledgeOptions,
): Promise<ComposedKnowledgeIndexing> => {
  const missing: string[] = [];
  let vault: VaultSource;

  if (options.mirrorRoot === null) {
    missing.push('APP_KNOWLEDGE_MIRROR_ROOT');
    vault = knowledgeAdapters.unavailableVaultSource(
      'APP_KNOWLEDGE_MIRROR_ROOT is not set, so this process composed no knowledge vault source: it has nowhere to keep the per-project bare mirror the index is read from (TD-026). Nothing was indexed and nothing was removed; set the variable to a writable data volume.',
    );
  } else {
    // TD-026 makes the `git` binary a dependency of the platform process. Probed once at
    // composition and named when it is absent, rather than surfacing as an `ENOENT` inside the
    // first index run (standing rule 18; the shape `createCtagsSymbolExtractor` uses).
    const probe = await knowledgeAdapters.probeGit();
    if (!probe.available) {
      missing.push('git');
      vault = knowledgeAdapters.unavailableVaultSource(
        `the knowledge index needs the "git" binary on this process' PATH and it is not usable: ${probe.detail}. Nothing was indexed and nothing was removed.`,
      );
    } else {
      const credentials = createGitMirrorCredentials({
        repository: secretAdapters.createPostgresBindingRepository(options.pool),
        secrets: secretAdapters.createPostgresSecretStore({
          sql: options.pool,
          key: secretAdapters.deriveSecretKey(options.secretKey),
        }),
        registry: options.registry,
      });
      options.logger.info(
        { git: probe.detail, mirror_root: options.mirrorRoot },
        'knowledge mirror ready',
      );
      vault = knowledgeAdapters.createGitVaultSource({
        mirrorRoot: options.mirrorRoot,
        logger: options.logger,
        target: async (projectId) => {
          const project = await readProject(options.pool, projectId);
          if (project === null) {
            throw new Error(`project ${projectId} has no row; its repository is unknown`);
          }
          const credential = await credentials.forProject(projectId);
          // `null` is "no git binding", which the adapter reports as a refusal of its own. A
          // binding that cannot be read throws, and the two must not be spelled alike.
          return credential === null
            ? null
            : {
                repoUrl: project.repo_url,
                defaultBranch: project.default_branch,
                credential,
              };
        },
      });
    }
  }

  const indexer = createKnowledgeIndexer({
    vault,
    store: new knowledgeAdapters.PostgresKnowledgeStore(options.pool),
    unitOfWork: options.eventing.unitOfWork,
    eventStore: options.eventing.store,
    clock: { now: () => new Date().toISOString() as `${string}T${string}` },
    ids: { next: (): Id => randomUUID() as Id },
    logger: options.logger,
  });

  const runtime = createKnowledgeIndexRuntime({
    jobs: options.jobs,
    indexer,
    logger: options.logger,
    project: async (projectId): Promise<KnowledgeIndexProject | null> => {
      const project = await readProject(options.pool, projectId);
      return project === null
        ? null
        : { projectKey: project.key, knowledgeDir: project.knowledge_dir };
    },
  });

  await runtime.start();

  const clock = { now: () => new Date().toISOString() as IsoDateTime };
  const ids = { next: (): Id => randomUUID() as Id };
  const knowledgeStore = new knowledgeAdapters.PostgresKnowledgeStore(options.pool);
  const proposals = new knowledgeAdapters.PostgresProposalStore(options.pool);
  /**
   * TD-012 over proposal text, both steps and in order.
   *
   * Step 1 is this process' **run environment** — the model credential a Librarian run was handed,
   * which is exactly the value a model repeating its environment would put in a page — and step 2
   * is the shipped pattern rules. Composed left to right, so the exact match wins where both would
   * fire and the placeholder names the variable (`[REDACTED:integration:anthropic_api_key]`).
   */
  const proposalRedactor = composeSecretRedactors(
    injectedSecretRedactorForEnvironment(options.runEnvironment, options.logger),
    redactionAdapters.patternRedactor(),
  );

  const librarianProject = async (projectId: Id) => {
    const { rows } = await options.pool.query<{ knowledge_dir: string; config: unknown }>(
      'select knowledge_dir, config from projects where id = $1',
      [projectId],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          knowledgeDir: row.knowledge_dir,
          thresholds: thresholdsFromConfig(
            (row.config ?? {}) as Parameters<typeof thresholdsFromConfig>[0],
          ),
        };
  };

  /**
   * The librarian's own queues, started only when this process composed a pipeline.
   *
   * A process with no pipeline has no integrations loader, so the apply pass could not commit and
   * the curation would queue proposals nothing could act on. Refusing to start the queues is
   * louder than a worker that dequeues and logs.
   */
  let librarian: Awaited<ReturnType<typeof createLibrarianRuntime>> | null = null;
  if (options.integrations === null) {
    // Not added to `missing`: that list is what an *index run* lacks, and the job's refusal quotes
    // it. This is a different absence with a different consequence, so it gets its own line rather
    // than making the index report name something it does not use.
    options.logger.warn(
      { missing: 'the pipeline’s integrations loader' },
      'this process composed no pipeline, so the librarian queues are not started: no proposal is curated, committed or decided here',
    );
  } else {
    librarian = createLibrarianRuntime({
      timezone: options.timezone,
      curation: {
        unitOfWork: options.eventing.unitOfWork,
        eventStore: options.eventing.store,
        proposals,
        knowledge: knowledgeStore,
        jobs: options.jobs,
        clock,
        ids,
        redactor: proposalRedactor,
        logger: options.logger,
        project: librarianProject,
        artifact: async ({ taskId, artifactId }): Promise<LibrarianArtifact | null> => {
          const { rows } = await options.pool.query<{
            data: unknown;
            produced_by_run_id: string | null;
            mode: string;
          }>(
            `select a.data, a.produced_by_run_id, t.mode
               from artifacts a
               join tasks t on t.id = a.task_id
              where a.id = $1 and a.task_id = $2`,
            [artifactId, taskId],
          );
          const row = rows[0];
          return row === undefined
            ? null
            : {
                data: (row.data ?? null) as LibrarianArtifact['data'],
                runId: row.produced_by_run_id as Id | null,
                taskMode: row.mode as TaskMode,
              };
        },
      },
      apply: {
        unitOfWork: options.eventing.unitOfWork,
        eventStore: options.eventing.store,
        proposals,
        knowledge: knowledgeStore,
        integrations: options.integrations,
        jobs: options.jobs,
        clock,
        ids,
        logger: options.logger,
        project: async (projectId) => {
          const project = await readProject(options.pool, projectId);
          return project === null
            ? null
            : {
                knowledgeDir: project.knowledge_dir,
                defaultBranch: project.default_branch,
              };
        },
        ticketKeys: async (taskIds) => {
          if (taskIds.length === 0) return new Map();
          const { rows } = await options.pool.query<{ id: string; ticket_key: string }>(
            'select id, ticket_key from tasks where id = any($1::uuid[])',
            [[...taskIds]],
          );
          return new Map(rows.map((row) => [row.id as Id, row.ticket_key]));
        },
      },
      hygiene: {
        unitOfWork: options.eventing.unitOfWork,
        proposals,
        jobs: options.jobs,
        clock,
        ids,
        logger: options.logger,
        projects: async (limit) => {
          const { rows } = await options.pool.query<{ id: string }>(
            'select id from projects order by created_at desc limit $1',
            [limit],
          );
          return rows.map((row) => row.id as Id);
        },
      },
    });
    // The handlers are returned rather than registered here — `runtime.ts` puts every one of them on
    // the bus before the outbox worker's first sweep, exactly as it does for the index triggers.
    await librarian.start();
  }

  return {
    handlers: [...runtime.handlers, ...(librarian?.handlers ?? [])],
    missing,
    stop: async () => {
      await librarian?.stop();
      await runtime.stop();
    },
  };
};
