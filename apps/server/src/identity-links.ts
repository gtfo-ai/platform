/**
 * The composition of a person's own account link (S-26.6): the PostgreSQL store, the recorder the
 * webhook ingress shares, and the *I wrote it on …* read through the process's one executor.
 *
 * Composed for every process that serves the API (`runtime.ts`). The thread read needs the
 * integration stack; a process with none composes the rest and answers the read
 * `503 link_thread_unavailable` by name.
 */
import { randomUUID } from 'node:crypto';
import {
  createIdentityLinkRecorder,
  createIdentityLinks,
  type IdentityLinkRecorder,
  IntegrationError,
  type Logger,
  type PipelineIntegrationsPort,
  readLinkThread,
  type UnitOfWork,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { integrations as integrationAdapters } from '@platform/infrastructure';
import { BindingLoadError } from '@platform/integrations';
import type pg from 'pg';
import type { IdentityLinkCommands } from './routes/me-identities.js';

const MAX_REASON_CHARS = 1_024;

const nowIso = (): IsoDateTime => new Date().toISOString() as IsoDateTime;
const ids = { next: (): Id => randomUUID() as Id };

/** The recorder the webhook ingress records a comment's link code with (`pipeline.ts`). */
export const composeIdentityLinkRecorder = (options: {
  readonly pool: pg.Pool;
  readonly logger: Logger;
}): IdentityLinkRecorder =>
  createIdentityLinkRecorder({
    store: integrationAdapters.createPostgresIdentityLinkStore({ sql: options.pool }),
    ids,
    clock: { now: nowIso },
    logger: options.logger,
  });

export const createIdentityLinkCommands = (options: {
  readonly pool: pg.Pool;
  readonly unitOfWork: UnitOfWork;
  /** `null` when this process composed no integration stack: the thread read answers `503`. */
  readonly integrations: PipelineIntegrationsPort | null;
  readonly logger: Logger;
}): IdentityLinkCommands => {
  const store = integrationAdapters.createPostgresIdentityLinkStore({ sql: options.pool });
  const links = createIdentityLinks({
    store,
    unitOfWork: options.unitOfWork,
    ids,
    clock: { now: nowIso },
    logger: options.logger,
  });
  return {
    issue: async (userId) => links.issue(userId as Id),
    confirm: async (userId, matchId) => links.confirm(userId as Id, matchId as Id),
    state: async (userId) => store.readState(userId as Id),
    readThread: async (projectId, target) => {
      if (options.integrations === null) {
        return {
          kind: 'unavailable',
          reason: 'this process composed no integrations, so it reads no thread',
        };
      }
      try {
        return await readLinkThread(
          {
            integrations: options.integrations,
            recorder: links.recorder,
            unitOfWork: options.unitOfWork,
          },
          { projectId: projectId as Id, target },
        );
      } catch (error) {
        if (!(error instanceof IntegrationError) && !(error instanceof BindingLoadError)) {
          throw error;
        }
        options.logger.warn(
          { project_id: projectId, err: error },
          'a thread could not be read for a link code',
        );
        const code = error instanceof IntegrationError ? ` (${error.code})` : '';
        return {
          kind: 'unavailable',
          reason: `the thread could not be read${code}: ${error.message}`.slice(
            0,
            MAX_REASON_CHARS,
          ),
        };
      }
    },
  };
};
