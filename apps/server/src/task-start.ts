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
import {
  IntegrationError,
  MANUAL_START_ACTION,
  searchTicketsForStart,
  silentLogger,
  startTicketManually,
} from '@platform/application';
import type { Id, JsonObject, TicketSearchItem } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import {
  eventing as eventingAdapters,
  pipeline as pipelineAdapters,
} from '@platform/infrastructure';
import { BindingLoadError } from '@platform/integrations';
import type pg from 'pg';
import { createProjectSettingsPort } from './pipeline.js';
import { recordHumanActionInTransaction } from './queries/onboarding-queries.js';

/** What the typeahead's search answers the route (`GET …/ticket-search`). */
export type TicketSearchServed =
  | { readonly status: 'ok'; readonly items: readonly TicketSearchItem[] }
  | { readonly status: 'no_binding' }
  | { readonly status: 'unsupported' }
  /** The tracker could not be read in time, or at all; `reason` is the platform's words. */
  | { readonly status: 'unavailable'; readonly reason: string };

/**
 * How long a typeahead search may take before the person is answered without it. The read itself
 * is not cancelled — it holds the binding's rate-limit slot until its own transport timeout — but
 * the dialog never waits behind a slow or queued tracker: it falls back to the plain key.
 */
export const TICKET_SEARCH_DEADLINE_MS = 5_000;

export interface TaskStartCommands {
  /** The *Start a ticket* typeahead: never throws for a tracker that failed (`unavailable`). */
  search(input: { readonly projectId: Id; readonly query: string }): Promise<TicketSearchServed>;
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
  /** The search's deadline; {@link TICKET_SEARCH_DEADLINE_MS} when absent (a seam for the test). */
  readonly searchDeadlineMs?: number;
}

/**
 * The search, bounded by a deadline and with a tracker's failure answered as `unavailable` — an
 * `IntegrationError` (refused, rate-limited past its retries, timed out) or a binding that cannot
 * be built (`BindingLoadError`). Anything else is a fault and propagates. The reason names the
 * error's code, never the provider's text.
 */
export const boundedTicketSearch = async (
  perform: () => Promise<TicketSearchServed>,
  options: { readonly deadlineMs: number; readonly logger: Logger; readonly projectId: Id },
): Promise<TicketSearchServed> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = perform();
  const deadline = new Promise<TicketSearchServed>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          status: 'unavailable',
          reason: `the tracker did not answer within ${options.deadlineMs} ms`,
        }),
      options.deadlineMs,
    );
  });
  // A search that loses the race still settles later; its failure is logged, never unhandled.
  pending.catch((error: unknown) => {
    options.logger.warn(
      { project_id: options.projectId, err: error },
      'a ticket search failed after its answer was given',
    );
  });
  try {
    return await Promise.race([pending, deadline]);
  } catch (error) {
    if (!(error instanceof IntegrationError) && !(error instanceof BindingLoadError)) {
      throw error;
    }
    options.logger.warn(
      { project_id: options.projectId, err: error },
      'a ticket search could not read the tracker',
    );
    return {
      status: 'unavailable',
      reason: `the tracker could not be searched${error instanceof IntegrationError ? ` (${error.code})` : ''}`,
    };
  } finally {
    clearTimeout(timer);
  }
};

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
  search: async ({ projectId, query }) =>
    boundedTicketSearch(
      async () =>
        searchTicketsForStart(
          { integrations: options.integrations, settings: createProjectSettingsPort(options.pool) },
          { projectId, query },
        ),
      {
        deadlineMs: options.searchDeadlineMs ?? TICKET_SEARCH_DEADLINE_MS,
        logger: options.logger ?? silentLogger,
        projectId,
      },
    ),
  start: async ({ projectId, ticketKey, userId, audit }) =>
    startTicketManually(
      {
        unitOfWork: options.eventing.unitOfWork,
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
