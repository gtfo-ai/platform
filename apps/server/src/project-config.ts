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
  Logger,
  PipelineIntegrationsPort,
  RepositoryConfigRefresh,
  RepositoryFileSource,
} from '@platform/application';
import { exportProjectConfig } from '@platform/application';
import type { Id } from '@platform/contracts';
import type pg from 'pg';
import { createRepositoryConfigRefresher } from './knowledge.js';

export interface ProjectConfigCommands {
  export(request: ConfigExportRequest): Promise<ConfigExportReport>;
  refresh(projectId: Id): Promise<RepositoryConfigRefresh>;
}

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
  };
};
