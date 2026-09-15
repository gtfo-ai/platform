/**
 * The reads behind the Shadow screen — product/10:20, product/19 §13 (WP-34).
 *
 * Projections onto the published DTOs, like `project-queries.ts` beside them, and under the same
 * rule: **refuse rather than default, and never invent a field.**
 *
 * ## The aggregate is computed, not stored
 *
 * product/19 §13's second sentence — *"predicted cost per ticket by size, similarity distribution,
 * list of 'high similarity + low cost' tickets as the launch candidates"* — is
 * `summariseShadowBatch` (`packages/domain/src/shadow/comparison.ts`) over the rows this file
 * reads. Nothing about it is persisted. A fifth number kept in step with four others is a number
 * that stops being in step, and `shadow_reports` is already the record.
 *
 * ## Three nulls that mean three different things, and the screen prints three sentences
 *
 * `ShadowBatchTicket.similarity` is `null` when: the task has no report yet (it is still running),
 * the report has no `overlap` because the ticket had no human merge request, or the report has no
 * `overlap` because this shadow task produced no merge request of its own. A reader tells them
 * apart from `task_state`, `human_mr` and `report.notes`, which is why all three travel.
 *
 * `refused_reason` is a **fourth** thing again: the ticket never became a task (Q82 (a)), so there
 * is nothing to be running or reporting.
 *
 * ## A report the schema refuses is dropped, not coerced
 *
 * `shadow_reports.comparison` is `jsonb`, so a row this build did not write — or one written by an
 * older one — can be any document. It is parsed with `shadowReportDataSchema` and a failure leaves
 * `report: null`, which the screen renders as *"this report cannot be read by this build"* rather
 * than as a half-populated comparison. `/context-pack`'s precedent (WP-15h): publishing a field the
 * store cannot answer is publishing a fact.
 */
import type {
  Id,
  ShadowBatchesResponse,
  ShadowBatchResponse,
  ShadowBatchSummary,
  ShadowBatchTicket,
  ShadowHumanMrSource,
  ShadowReportData,
  Size,
} from '@platform/contracts';
import { shadowBatchResponseSchema, shadowReportDataSchema } from '@platform/contracts';
import { summariseShadowBatch } from '@platform/domain';
import { db as dbAdapters } from '@platform/infrastructure';
import { desc, eq, inArray } from 'drizzle-orm';

export type Database = dbAdapters.Database;

const { shadowBatches, shadowBatchTickets, shadowReports, tasks } = dbAdapters.schema;

/** `numeric` arrives as a string; `null` stays `null` (a batch with no cap has no cap). */
const usd = (value: string | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

const source = (raw: string | null): ShadowHumanMrSource | null =>
  raw === 'ticket_link' || raw === 'title_scan' ? raw : null;

const readReport = (raw: unknown): ShadowReportData | null => {
  const parsed = shadowReportDataSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

const SIZES: readonly Size[] = ['S', 'M', 'L', 'XL'];
const asSize = (raw: string | null): Size | null => SIZES.find((size) => size === raw) ?? null;

export interface BatchRowShape {
  readonly id: string;
  readonly projectId: string;
  readonly budgetUsd: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

/** One `shadow_batch_tickets` row joined to its task, as the query selects it. */
export interface TicketRowShape {
  readonly ticketKey: string;
  readonly taskId: string | null;
  readonly baseSha: string | null;
  readonly humanMrRef: unknown;
  readonly humanMrSource: string | null;
  readonly refusedReason: string | null;
  readonly taskState: string | null;
  readonly size: string | null;
  readonly costActual: string | null;
  readonly estimateUsd: string | null;
}

/** `shadow_reports.comparison`, parsed; a document this build cannot read becomes `null`. */
export const readShadowReport = (raw: unknown): ShadowReportData | null => readReport(raw);

/**
 * `GET /api/projects/:project_id/shadow-batches` — one row per batch, newest first.
 *
 * `spent_usd` is summed from the batch's own tasks (`tasks.cost_actual`) rather than from
 * `cost_entries`, deliberately and with the cost stated: the ledger is the record and the column is
 * the running total the stage executor maintains, so this figure can lag a run that has finished
 * and whose ledger rows have not been folded yet. It is the same number the board and the task page
 * already show for a task, which is what a reader comparing the two screens expects; the **budget**
 * is enforced against the ledger *and* against the shadow runs the ledger has not recorded yet
 * (`ShadowStore.shadowSpendSince`, whose two numbers and their reasoning are in
 * `packages/application/src/cost/pending.ts`), because a cap that lagged a run would admit one
 * more rather than show a number a moment late.
 */
export const listShadowBatches = async (
  database: Database,
  projectId: string,
  gate: { readonly canStart: boolean; readonly blockedReason: string | null },
): Promise<ShadowBatchesResponse> => {
  const batches = await database
    .select({
      id: shadowBatches.id,
      projectId: shadowBatches.projectId,
      budgetUsd: shadowBatches.budgetUsd,
      createdAt: shadowBatches.createdAt,
      completedAt: shadowBatches.completedAt,
    })
    .from(shadowBatches)
    .where(eq(shadowBatches.projectId, projectId))
    .orderBy(desc(shadowBatches.createdAt), desc(shadowBatches.id))
    .limit(50);

  const items: ShadowBatchSummary[] = [];
  for (const batch of batches) {
    items.push(await summaryOf(database, batch));
  }
  return {
    items,
    can_start: gate.canStart,
    blocked_reason: gate.blockedReason,
  };
};

/**
 * The batch summary, as a pure function of its own row and its tickets'.
 *
 * Separated from the query for `project-queries.ts`'s reason: everything worth asserting is the
 * arithmetic — the `numeric` conversion, the spend sum over a `left join` that answers `null` for a
 * refused ticket, and the two counts — and a projection driven only through a container is a
 * projection asserted once, slowly.
 */
export const shadowBatchSummaryFrom = (
  batch: BatchRowShape,
  rows: readonly { readonly refusedReason: string | null; readonly costActual: string | null }[],
): ShadowBatchSummary => ({
  id: batch.id as Id,
  project_id: batch.projectId as Id,
  created_at: batch.createdAt.toISOString() as ShadowBatchSummary['created_at'],
  completed_at:
    batch.completedAt === null
      ? null
      : (batch.completedAt.toISOString() as ShadowBatchSummary['created_at']),
  budget_usd: usd(batch.budgetUsd),
  spent_usd: rows.reduce((total, row) => total + Number(row.costActual ?? 0), 0),
  tickets: rows.length,
  refused: rows.filter((row) => row.refusedReason !== null).length,
});

const summaryOf = async (database: Database, batch: BatchRowShape): Promise<ShadowBatchSummary> => {
  const rows = await database
    .select({
      taskId: shadowBatchTickets.taskId,
      refusedReason: shadowBatchTickets.refusedReason,
      costActual: tasks.costActual,
    })
    .from(shadowBatchTickets)
    .leftJoin(tasks, eq(tasks.id, shadowBatchTickets.taskId))
    .where(eq(shadowBatchTickets.batchId, batch.id));
  return shadowBatchSummaryFrom(batch, rows);
};

/** One ticket of a batch, as a pure function of its joined row and the report it may have. */
export const shadowTicketFrom = (
  row: TicketRowShape,
  report: ShadowReportData | null,
): ShadowBatchTicket => ({
  ticket_key: row.ticketKey,
  task_id: row.taskId === null ? null : (row.taskId as Id),
  task_state: (row.taskState ?? null) as ShadowBatchTicket['task_state'],
  refused_reason: row.refusedReason,
  base_sha: row.baseSha,
  human_mr: (row.humanMrRef ?? null) as ShadowBatchTicket['human_mr'],
  human_mr_source: source(row.humanMrSource),
  size: asSize(row.size ?? null),
  cost_usd: Number(row.costActual ?? 0),
  predicted_cost_usd: usd(row.estimateUsd),
  similarity: report?.overlap?.files_jaccard ?? null,
  report,
});

/**
 * product/19 §13's aggregate over the batch's tickets — `summariseShadowBatch`, fed.
 *
 * A **refused** ticket is excluded entirely: it never became a task, so it is not a measurement of
 * anything. A ticket is *"reported"* when a `shadow_reports` row exists, **whether or not it carries
 * a comparison** — a ticket with no human merge request has been measured, and counting it as
 * unreported would leave the batch looking unfinished for ever.
 */
export const shadowAggregateFrom = (tickets: readonly ShadowBatchTicket[]) =>
  summariseShadowBatch(
    tickets
      .filter((ticket) => ticket.task_id !== null)
      .map((ticket) => ({
        ticketKey: ticket.ticket_key,
        taskId: ticket.task_id as string,
        size: ticket.size,
        costUsd: ticket.cost_usd,
        predictedCostUsd: ticket.predicted_cost_usd,
        similarity: ticket.similarity,
        reported: ticket.report !== null,
      })),
  );

/**
 * The project a batch belongs to, or `null` — what `scopeToProject` resolves the read's guard with.
 *
 * One column, read before the permission is decided, so the answer is deliberately *not*
 * {@link findShadowBatch}: a guard that had to assemble the whole response first would be reading a
 * project's rows to find out whether the caller may read them.
 */
export const findShadowBatchProjectId = async (
  database: Database,
  batchId: string,
): Promise<string | null> => {
  const rows = await database
    .select({ projectId: shadowBatches.projectId })
    .from(shadowBatches)
    .where(eq(shadowBatches.id, batchId))
    .limit(1);
  return rows[0]?.projectId ?? null;
};

export type ShadowBatchRead =
  | { readonly found: false }
  | { readonly found: true; readonly response: ShadowBatchResponse };

/** `GET /api/shadow-batches/:batch_id` — the batch, its tickets and the computed aggregate. */
export const findShadowBatch = async (
  database: Database,
  batchId: string,
): Promise<ShadowBatchRead> => {
  const found = await database
    .select({
      id: shadowBatches.id,
      projectId: shadowBatches.projectId,
      budgetUsd: shadowBatches.budgetUsd,
      createdAt: shadowBatches.createdAt,
      completedAt: shadowBatches.completedAt,
    })
    .from(shadowBatches)
    .where(eq(shadowBatches.id, batchId))
    .limit(1);
  const batch = found[0];
  if (batch === undefined) {
    return { found: false };
  }

  const rows = await database
    .select({
      ticketKey: shadowBatchTickets.ticketKey,
      taskId: shadowBatchTickets.taskId,
      baseSha: shadowBatchTickets.baseSha,
      humanMrRef: shadowBatchTickets.humanMrRef,
      humanMrSource: shadowBatchTickets.humanMrSource,
      refusedReason: shadowBatchTickets.refusedReason,
      taskState: tasks.state,
      size: tasks.size,
      costActual: tasks.costActual,
      estimateUsd: tasks.estimateUsd,
    })
    .from(shadowBatchTickets)
    .leftJoin(tasks, eq(tasks.id, shadowBatchTickets.taskId))
    .where(eq(shadowBatchTickets.batchId, batchId))
    .orderBy(shadowBatchTickets.createdAt, shadowBatchTickets.ticketKey);

  const taskIds = rows
    .map((row) => row.taskId)
    .filter((taskId): taskId is string => taskId !== null);
  const reportRows =
    taskIds.length === 0
      ? []
      : await database
          .select({ taskId: shadowReports.taskId, comparison: shadowReports.comparison })
          .from(shadowReports)
          .where(inArray(shadowReports.taskId, taskIds));
  const reports = new Map(reportRows.map((row) => [row.taskId, readReport(row.comparison)]));

  const tickets = rows.map((row) =>
    shadowTicketFrom(row, row.taskId === null ? null : (reports.get(row.taskId) ?? null)),
  );
  const aggregate = shadowAggregateFrom(tickets);

  return {
    found: true,
    // Parsed on the way out for the reason every other projection is: the DTO is the contract, and
    // a shape this file assembled wrongly must fail here rather than in a browser.
    response: shadowBatchResponseSchema.parse({
      batch: await summaryOf(database, batch),
      tickets,
      aggregate,
    }) satisfies ShadowBatchResponse,
  };
};
