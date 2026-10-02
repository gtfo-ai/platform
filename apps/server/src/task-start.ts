/**
 * product/04's manual "Start", composed for `apps/server` (WP-122, PROGRESS backlog 379).
 *
 * The command is `startTicketManually` (`packages/application/src/pipeline/manual-start.ts`), which
 * carries the argument: it reads the ticket outside any transaction through the project's
 * task-management binding and the process's one `IntegrationActionExecutor`, then appends the same
 * `ticket.matched` intake consumes. This file supplies the Postgres collaborators and the one thing
 * the route cannot: the `human_actions` row written **in the append's transaction**, which also
 * completes the `Idempotency-Key` the route claimed (`recordHumanActionInTransaction`).
 *
 * Composed on every process that serves the API. It needs **no** job client — the event is in the
 * outbox the moment it commits, and whichever process dispatches it runs intake — so, unlike a
 * shadow batch or a discovery, an API-only replica serves it whole.
 */
import { randomUUID } from 'node:crypto';
import type { Logger, ManualStartRecord, PipelineIntegrationsPort } from '@platform/application';
import { MANUAL_START_ACTION, startTicketManually } from '@platform/application';
import type { Id, JsonObject } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import {
  eventing as eventingAdapters,
  pipeline as pipelineAdapters,
} from '@platform/infrastructure';
import type pg from 'pg';
import { createProjectSettingsPort } from './pipeline.js';
import { recordHumanActionInTransaction } from './queries/onboarding-queries.js';

export interface TaskStartCommands {
  start(input: {
    readonly projectId: Id;
    readonly ticketKey: string;
    readonly userId: Id;
    /** The claimed key and its digest, recorded on the audit row that completes the claim. */
    readonly audit: { readonly key: string; readonly digest: string | null };
  }): Promise<ManualStartRecord>;
}

export interface TaskStartCommandOptions {
  readonly pool: pg.Pool;
  readonly eventing: ReturnType<typeof eventingAdapters.createEventing>;
  /** The project's bindings, resolved per call — the port the pipeline and the shadow batch use. */
  readonly integrations: PipelineIntegrationsPort;
  readonly logger?: Logger;
}

/** The audit row's `params`: what was started and under which key — never the ticket's text. */
export const manualStartAuditParams = (input: {
  readonly projectId: string;
  readonly started: ManualStartRecord;
  readonly key: string;
  readonly digest: string | null;
}): JsonObject => ({
  project_id: input.projectId,
  event_id: input.started.eventId,
  ticket: {
    provider: input.started.ticket.provider,
    key: input.started.ticket.key,
    url: input.started.ticket.url,
  },
  idempotency_key: input.key,
  body_digest: input.digest,
});

export const createTaskStartCommands = (options: TaskStartCommandOptions): TaskStartCommands => ({
  start: async ({ projectId, ticketKey, userId, audit }) =>
    startTicketManually(
      {
        unitOfWork: options.eventing.unitOfWork,
        eventStore: options.eventing.store,
        store: pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES }),
        settings: createProjectSettingsPort(options.pool),
        integrations: options.integrations,
        ids: { next: (): Id => randomUUID() as Id },
        clock: { now: () => new Date().toISOString() },
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      },
      {
        projectId,
        ticketKey,
        userId,
        record: async (scope, started) =>
          recordHumanActionInTransaction(eventingAdapters.postgresTransaction(scope.tx).client, {
            userId,
            action: MANUAL_START_ACTION,
            params: manualStartAuditParams({
              projectId,
              started,
              key: audit.key,
              digest: audit.digest,
            }),
          }),
      },
    ),
});
