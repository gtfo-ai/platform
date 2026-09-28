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
  RepositoryFileSource,
  StoredKnowledgeProposal,
  VaultSource,
} from '@platform/application';
import {
  composeSecretRedactors,
  createKnowledgeIndexer,
  createKnowledgeIndexRuntime,
  createLibrarianRuntime,
  decideKnowledgeProposal,
  enqueueReadinessRecheck,
  projectConfigWithRepository,
  refreshRepositoryConfig,
  shouldRecheckAfterIndex,
  thresholdsFromConfig,
} from '@platform/application';
import type { Id, IsoDateTime, TaskMode } from '@platform/contracts';
import { materialisedAutonomySchema } from '@platform/contracts';
import type { ConfigValues } from '@platform/domain';
import {
  config as configAdapters,
  type eventing as eventingAdapters,
  knowledge as knowledgeAdapters,
  redaction as redactionAdapters,
  secrets as secretAdapters,
} from '@platform/infrastructure';
import type { IntegrationRegistry } from '@platform/integrations';
import { accountOnlyFieldsOf, createGitMirrorCredentials } from '@platform/integrations';
import type pg from 'pg';
import { injectedSecretRedactorForEnvironment } from './agent.js';
import {
  REPOSITORY_CONFIG_COLUMNS,
  type RepositoryConfigColumns,
  repositorySnapshotFrom,
} from './config-layers.js';

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
  /**
   * `APP_KNOWLEDGE_MIRROR_MAX_BYTES` (WP-65, Q63): the ceiling eviction by last use keeps the
   * mirrors under after each index run. `null` is no ceiling, and nothing is ever evicted.
   */
  readonly mirrorMaxBytes: number | null;
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
  /**
   * The mirror's named-file reader, for the readiness re-check's R8 (WP-64) — the same reader the
   * repository-configuration refresher uses, so one process has one mirror.
   */
  readonly files: RepositoryFileSource;
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
   * The job client, or `null` on a composition root that builds none. Since WP-72 `ROLE=api`
   * holds the enqueue-only sender (`enqueue-only-jobs.ts`), so on the shipped roles this is never
   * `null` and an approval is committed by whichever worker takes `knowledge.apply`.
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
 * `ROLE=api` and `ROLE=worker` therefore keeps a working knowledge screen — and since WP-72 the
 * approval it records is committed in seconds by the worker, which
 * `test/e2e/topology/two-processes.e2e.test.ts` asserts through the two processes.
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

/** What {@link composeKnowledgeMirror} needs: the pool, the credential store and the root. */
export interface ComposeKnowledgeMirrorOptions {
  readonly pool: pg.Pool;
  readonly secretKey: string;
  readonly registry: IntegrationRegistry;
  readonly mirrorRoot: string | null;
  readonly logger: Logger;
}

export interface ComposedKnowledgeMirror {
  /** The knowledge vault read — the four indexed kinds of path. */
  readonly vault: VaultSource;
  /** The named files outside them: `.agentic/config.yml`, `CLAUDE.md` (WP-63) and `AGENTS.md` (WP-64). */
  readonly files: RepositoryFileSource;
  /** What could not be composed, by name; empty when both are real. */
  readonly missing: readonly string[];
}

/**
 * The platform's bare mirror, composed once per process for its two readers (TD-026, WP-63).
 *
 * Extracted at WP-63 because a second reader arrived: the repository layer of the effective
 * configuration and the configuration export read `.agentic/config.yml` and `CLAUDE.md` through the
 * **same** mirror, credential and default-branch rule as the index. Both readers refuse by the same
 * names when the mirror cannot be composed.
 */
export const composeKnowledgeMirror = async (
  options: ComposeKnowledgeMirrorOptions,
): Promise<ComposedKnowledgeMirror> => {
  if (options.mirrorRoot === null) {
    const reason =
      'APP_KNOWLEDGE_MIRROR_ROOT is not set, so this process composed no knowledge vault source: it has nowhere to keep the per-project bare mirror the index is read from (TD-026). Nothing was indexed and nothing was removed; set the variable to a writable data volume.';
    return {
      vault: knowledgeAdapters.unavailableVaultSource(reason),
      files: knowledgeAdapters.unavailableRepositoryFileSource(
        'APP_KNOWLEDGE_MIRROR_ROOT is not set, so this process has no mirror of the repository to read .agentic/config.yml, CLAUDE.md or AGENTS.md from (TD-026); set the variable to a writable data volume',
      ),
      missing: ['APP_KNOWLEDGE_MIRROR_ROOT'],
    };
  }
  // TD-026 makes the `git` binary a dependency of the platform process. Probed once at
  // composition and named when it is absent, rather than surfacing as an `ENOENT` inside the
  // first index run (standing rule 18; the shape `createCtagsSymbolExtractor` uses).
  const probe = await knowledgeAdapters.probeGit();
  if (!probe.available) {
    return {
      vault: knowledgeAdapters.unavailableVaultSource(
        `the knowledge index needs the "git" binary on this process' PATH and it is not usable: ${probe.detail}. Nothing was indexed and nothing was removed.`,
      ),
      files: knowledgeAdapters.unavailableRepositoryFileSource(
        `reading the repository needs the "git" binary on this process' PATH and it is not usable: ${probe.detail}`,
      ),
      missing: ['git'],
    };
  }
  const credentials = createGitMirrorCredentials({
    repository: secretAdapters.createPostgresBindingRepository(options.pool, accountOnlyFieldsOf),
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
  const mirror = {
    mirrorRoot: options.mirrorRoot,
    logger: options.logger,
    target: async (projectId: Id) => {
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
  };
  return {
    vault: knowledgeAdapters.createGitVaultSource(mirror),
    files: knowledgeAdapters.createGitRepositoryFileSource(mirror),
    missing: [],
  };
};

/** The repository-configuration refresher over this process' mirror (WP-63). */
export const createRepositoryConfigRefresher = (options: {
  readonly pool: pg.Pool;
  readonly files: RepositoryFileSource;
  readonly logger: Logger;
}) => {
  // TD-012 step 2: the pattern rules. A reading carries no run-scoped credential (Q55), and the
  // only text it stores is a refusal's key paths — which a strict schema fills with typed keys.
  const redactor = redactionAdapters.patternRedactor();
  return (request: { readonly projectId: Id; readonly commitSha?: string }) =>
    refreshRepositoryConfig(
      {
        source: options.files,
        codec: configAdapters.yamlConfigCodec,
        store: configAdapters.createPostgresRepositoryConfigStore(options.pool),
        redactText: (value) => redactor.redactText(value).value,
        clock: { now: () => new Date().toISOString() as IsoDateTime },
        logger: options.logger,
      },
      request,
    );
};

export const composeKnowledgeIndexing = async (
  options: ComposeKnowledgeOptions,
): Promise<ComposedKnowledgeIndexing> => {
  const composedMirror = await composeKnowledgeMirror(options);
  const missing = [...composedMirror.missing];
  const vault = composedMirror.vault;
  const refreshConfig = createRepositoryConfigRefresher({
    pool: options.pool,
    files: composedMirror.files,
    logger: options.logger,
  });

  const indexer = createKnowledgeIndexer({
    vault,
    store: new knowledgeAdapters.PostgresKnowledgeStore(options.pool),
    unitOfWork: options.eventing.unitOfWork,
    eventStore: options.eventing.store,
    clock: { now: () => new Date().toISOString() as `${string}T${string}` },
    ids: { next: (): Id => randomUUID() as Id },
    logger: options.logger,
  });

  /**
   * **Eviction by last use** (WP-65, Q63), after an index run — the moment a mirror may have grown
   * (a first clone, a fetch). Nothing happens without `APP_KNOWLEDGE_MIRROR_MAX_BYTES`. The mirror
   * just read is never a candidate, nor is any used in the last hour; see `mirror-storage.ts` for
   * the rest. A failure here is the ceiling's, not the index run's: named and left.
   */
  const evictMirrors = async (projectId: Id): Promise<void> => {
    if (options.mirrorRoot === null || options.mirrorMaxBytes === null) {
      return;
    }
    try {
      const eviction = await knowledgeAdapters.evictKnowledgeMirrors({
        root: options.mirrorRoot,
        ceilingBytes: options.mirrorMaxBytes,
        now: new Date(),
        keepProjectId: projectId,
      });
      if (eviction === null) {
        return;
      }
      for (const evicted of eviction.evicted) {
        options.logger.info(
          {
            project_id: evicted.projectId,
            bytes: evicted.bytes,
            last_used_at: evicted.lastUsedAt,
            ceiling_bytes: options.mirrorMaxBytes,
          },
          'knowledge mirror evicted: the least recently used mirror was removed to keep the mirrors under APP_KNOWLEDGE_MIRROR_MAX_BYTES; its next index run re-clones it',
        );
      }
      if (eviction.stillOver) {
        options.logger.warn(
          { bytes: eviction.bytesAfter, ceiling_bytes: options.mirrorMaxBytes },
          'knowledge mirrors are over APP_KNOWLEDGE_MIRROR_MAX_BYTES and every remaining mirror is in use or was used within the hour; nothing more was removed',
        );
      }
    } catch (cause) {
      options.logger.warn(
        { err: cause, project_id: projectId },
        'knowledge mirror eviction failed; the index run is unaffected',
      );
    }
  };

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
    // WP-63: the repository layer re-read at the commit the index run read. WP-64: when the run
    // read a **new** default-branch commit (a merge), the readiness re-check at the same commit —
    // enqueued here, after the index write, so R12 is scored from the merged commit's vault
    // (`onboarding/recheck.ts` has the ordering argument). Outside every transaction: the index
    // run's own has committed.
    afterIndex: async (projectId, commitSha, run) => {
      try {
        await refreshConfig({ projectId, commitSha });
      } finally {
        // Independent of the configuration read: a file that could not be re-read must not cost
        // the merge its re-check. The refresh's own error still reaches the index job's log.
        if (shouldRecheckAfterIndex(run)) {
          await enqueueReadinessRecheck(options.jobs, { projectId, commitSha });
        }
        await evictMirrors(projectId);
      }
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
    // The settings with the repository's own file over them (WP-63): `knowledge_apply` is a key
    // the repository may state, and the Librarian must read the layer every run reads.
    const { rows } = await options.pool.query<
      {
        knowledge_dir: string;
        config: unknown;
        autonomy_policies: unknown;
      } & Partial<RepositoryConfigColumns>
    >(
      `select p.knowledge_dir, p.config, p.autonomy_policies, ${REPOSITORY_CONFIG_COLUMNS}
         from projects p
         left join project_repository_config r on r.project_id = p.id
        where p.id = $1`,
      [projectId],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const config = projectConfigWithRepository(
      (row.config ?? {}) as ConfigValues,
      repositorySnapshotFrom(row),
    ).values;
    // The dial decides `auto_apply` where the document is silent (WP-62). Parsed, never cast, and a
    // row that fails is read as "never materialised" — the platform default, which is *off* — with
    // a named line, the same answer `createProjectSettingsPort` gives the pipeline.
    const autonomy = materialisedAutonomySchema.safeParse(row.autonomy_policies);
    if (row.autonomy_policies !== null && !autonomy.success) {
      options.logger.warn(
        { project_id: projectId },
        'projects.autonomy_policies does not match the current schema; knowledge auto-apply falls back to the platform default (re-apply the preset)',
      );
    }
    return {
      knowledgeDir: row.knowledge_dir,
      thresholds: thresholdsFromConfig(
        config as Parameters<typeof thresholdsFromConfig>[0],
        autonomy.success ? autonomy.data : null,
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
            ticket_key: string;
          }>(
            // `ticket_key` since WP-40: a spike's research page is filed at `research/<key>.md`,
            // and it comes from the same join that already answers the task's mode.
            `select a.data, a.produced_by_run_id, t.mode, t.ticket_key
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
                ticketKey: row.ticket_key,
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
    files: composedMirror.files,
    stop: async () => {
      await librarian?.stop();
      await runtime.stop();
    },
  };
};
