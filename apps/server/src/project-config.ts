/**
 * The configuration export and the repository re-read, composed for `apps/server` (WP-63).
 *
 * The API half of Q94: `POST …/config/export` proposes the settings layer as `.agentic/config.yml`
 * in a merge request, and `POST …/config/refresh` re-reads the file from the default branch. Both
 * go through the platform's own bare mirror (`composeKnowledgeMirror`, the same one the index reads)
 * and the export's two provider calls through the process's one `IntegrationActionExecutor`
 * (`createProjectIntegrationsPort`, the shadow command's composition), so a configuration commit is
 * audited, rate-limited and shadow-guarded like a knowledge commit.
 *
 * Composed for every process that serves the API. A process with no mirror still composes it: the
 * reader then refuses by name (`APP_KNOWLEDGE_MIRROR_ROOT`, `git`), and the routes answer `409`
 * with that sentence rather than disappearing.
 */
import type {
  ConfigExportReport,
  ConfigExportRequest,
  Jobs,
  Logger,
  PipelineIntegrationsPort,
  RepositoryConfigRefresh,
  RepositoryFileSource,
} from '@platform/application';
import {
  enqueueKnowledgeIndex,
  exportProjectConfig,
  gitReads,
  IntegrationError,
  integrationsForProject,
  noRunScopedSecrets,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import type pg from 'pg';
import { createRepositoryConfigRefresher } from './knowledge.js';
import type { ProviderRepositoryAnswer } from './routes/project-repository.js';

export interface ProjectConfigCommands {
  export(request: ConfigExportRequest): Promise<ConfigExportReport>;
  refresh(projectId: Id): Promise<RepositoryConfigRefresh>;
  /**
   * What the project's git provider says about its repository — the default branch and the CI
   * configuration's location (WP-139), through the process's one executor. Never throws for a
   * provider's refusal: it answers `unavailable` with the reason, because the caller is a form that
   * then asks the person.
   */
  repository(projectId: Id): Promise<ProviderRepositoryAnswer>;
  /**
   * Asks for one knowledge index run of the project (WP-142): what a change of the default branch
   * requests after it commits. `false` when this process holds no job client.
   */
  requestKnowledgeIndex(projectId: Id): Promise<boolean>;
}

/** Bounds a provider string before it reaches a DTO (the schema's 255; BD-022). */
const bounded = (value: string): string => value.slice(0, 255);

export const createProjectConfigCommands = (options: {
  readonly pool: pg.Pool;
  readonly integrations: PipelineIntegrationsPort;
  readonly files: RepositoryFileSource;
  /**
   * `APP_SECRET_KEY`: the re-read redacts against the project's binding credentials (WP-107) and,
   * since WP-121, every other credential the platform holds for it.
   */
  readonly secretKey: string;
  readonly logger: Logger;
  /** The process's job client (WP-142), or `null` when it holds none. */
  readonly jobs: Jobs | null;
}): ProjectConfigCommands => {
  const refresh = createRepositoryConfigRefresher({
    pool: options.pool,
    files: options.files,
    secretKey: options.secretKey,
    logger: options.logger,
  });
  return {
    export: async (request) =>
      exportProjectConfig(
        { integrations: options.integrations, files: options.files, logger: options.logger },
        request,
      ),
    refresh: async (projectId) => refresh({ projectId }),
    requestKnowledgeIndex: async (projectId) => {
      if (options.jobs === null) {
        return false;
      }
      await enqueueKnowledgeIndex(options.jobs, { projectId, reason: 'default_branch_changed' });
      return true;
    },
    repository: async (projectId) => {
      try {
        const bindings = await integrationsForProject(
          options.integrations,
          projectId,
          noRunScopedSecrets(),
        );
        if (bindings.git === null) {
          return {
            status: 'unavailable',
            reason: 'this project has no git binding, so the platform cannot ask its provider',
          };
        }
        const settings = await gitReads(bindings).repositorySettings({ projectId, taskId: null });
        if (settings === null) {
          return { status: 'unavailable', reason: 'this project has no git binding' };
        }
        const ci = settings.ciConfig;
        return {
          status: 'ok',
          provider: {
            provider: bindings.git.ref.provider,
            default_branch:
              settings.defaultBranch === null ? null : bounded(settings.defaultBranch),
            ci_config:
              ci.kind === 'repository'
                ? { kind: 'repository', path: bounded(ci.path) }
                : ci.kind === 'external'
                  ? { kind: 'external', location: bounded(ci.location) }
                  : { kind: 'unknown', reason: ci.reason.slice(0, 1024) },
          },
        };
      } catch (error) {
        // A provider's refusal (or a binding that cannot load) is the form's question to the
        // person, named; anything else is a fault and propagates (rule 20).
        if (!(error instanceof IntegrationError)) {
          throw error;
        }
        options.logger.warn(
          { project_id: projectId, err: error },
          'the git provider could not answer the repository settings read',
        );
        return {
          status: 'unavailable',
          reason: `the git provider could not answer (${error.code}): ${error.message}`.slice(
            0,
            1024,
          ),
        };
      }
    },
  };
};
