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
  EventHandler,
  Jobs,
  KnowledgeIndexProject,
  Logger,
  VaultSource,
} from '@platform/application';
import { createKnowledgeIndexer, createKnowledgeIndexRuntime } from '@platform/application';
import type { Id } from '@platform/contracts';
import {
  type eventing as eventingAdapters,
  knowledge as knowledgeAdapters,
  secrets as secretAdapters,
} from '@platform/infrastructure';
import type { IntegrationRegistry } from '@platform/integrations';
import { createGitMirrorCredentials } from '@platform/integrations';
import type pg from 'pg';

export interface ComposeKnowledgeOptions {
  readonly pool: pg.Pool;
  readonly eventing: ReturnType<typeof eventingAdapters.createEventing>;
  readonly jobs: Jobs;
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

  return { handlers: runtime.handlers, missing, stop: runtime.stop };
};
