/**
 * `ShadowStore` on PostgreSQL — `shadow_batches` and `shadow_batch_tickets` (migration 0029), and
 * `shadow_reports` (migration 0008, which had no writer for twenty-six migrations), WP-34.
 *
 * Four things deserve reading before they are changed.
 *
 * **`insertReport` answers whether it wrote.** `on conflict (task_id) do nothing` plus
 * `returning task_id`, so `rowCount` is the answer: the `shadow_report` job is at-least-once and a
 * second delivery must not append a second `shadow.report.created`. It is the same shape the
 * idempotency store uses, in the one place a domain event's uniqueness rests on a table.
 *
 * **`completeIfDone` is one statement, and the predicate is the idempotency.** `completed_at is
 * null` is inside the `where`, so two concurrent reports finishing a batch produce exactly one
 * write and exactly one `true` — the row lock decides, not a read the caller did first.
 *
 * **`shadowSpendSince` joins `cost_entries` to `tasks`.** It is the only query in the platform that
 * groups spend by `tasks.mode`, which is why it lives here rather than on `CostStore`. It sums the
 * ledger rather than `tasks.cost_actual` for WP-19's reason: the entries are the record and the
 * column is a running total. `coalesce(sum(...), 0)` — a project with no shadow spend has spent
 * nothing, which is the one place a zero is the right answer rather than an invented one.
 *
 * **`checkoutBaseFor` reads through the batch.** A shadow task belongs to exactly one batch
 * (`shadow_batch_tickets.task_id` is unique in practice because `startShadowBatch` writes one row
 * per task), and the base is the batch's record of what the comparison is anchored at. `limit 1` is
 * belt and braces rather than a choice: if two rows ever named one task, answering the newest
 * quietly would be worse than the query being wrong loudly, so the order is explicit.
 */

import type {
  ShadowBatchRow,
  ShadowBatchTicketRow,
  ShadowReportRow,
  ShadowStore,
  Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, MergeRequestRef, ShadowHumanMrSource } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

interface BatchRow extends Record<string, unknown> {
  readonly id: string;
  readonly project_id: string;
  readonly requested_by: string | null;
  readonly budget_usd: string | null;
  readonly created_at: Date;
  readonly completed_at: Date | null;
}

interface TicketRow extends Record<string, unknown> {
  readonly ticket_key: string;
  readonly task_id: string | null;
  readonly base_sha: string | null;
  readonly human_mr_ref: unknown;
  readonly human_mr_source: string | null;
  readonly human_mr_merged_at: Date | null;
  readonly human_mr_candidates: number | null;
  readonly refused_reason: string | null;
}

interface ReportRow extends Record<string, unknown> {
  readonly task_id: string;
  readonly human_mr_ref: unknown;
  readonly comparison: unknown;
  readonly created_at: Date;
}

const instant = (value: Date): IsoDateTime => value.toISOString() as IsoDateTime;

/**
 * `numeric` arrives as a string (`pg` does not coerce it, so a value wider than a double is not
 * silently rounded on the way out). `null` stays `null`: a batch with no cap is not a batch with a
 * cap of zero.
 */
const usd = (value: string | null): number | null => (value === null ? null : Number(value));

const mergeRequest = (raw: unknown): MergeRequestRef | null =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as MergeRequestRef) : null;

const humanMrSource = (raw: string | null): ShadowHumanMrSource | null =>
  raw === 'ticket_link' || raw === 'title_scan' ? raw : null;

const toBatch = (row: BatchRow): ShadowBatchRow => ({
  id: row.id as Id,
  projectId: row.project_id as Id,
  requestedBy: row.requested_by === null ? null : (row.requested_by as Id),
  budgetUsd: usd(row.budget_usd),
  createdAt: instant(row.created_at),
  completedAt: row.completed_at === null ? null : instant(row.completed_at),
});

const toTicket = (row: TicketRow): ShadowBatchTicketRow => ({
  ticketKey: row.ticket_key,
  taskId: row.task_id === null ? null : (row.task_id as Id),
  baseSha: row.base_sha,
  humanMr: mergeRequest(row.human_mr_ref),
  humanMrSource: humanMrSource(row.human_mr_source),
  // `timestamptz` arrives as a `Date`; the row's contract is the ISO string the report hands to
  // product/19 §16's arithmetic, so it is rendered here rather than at the reader.
  mergedAt: row.human_mr_merged_at === null ? null : instant(row.human_mr_merged_at),
  candidates: row.human_mr_candidates,
  refusedReason: row.refused_reason,
});

export class PostgresShadowStore implements ShadowStore {
  async createBatch(
    tx: Transaction,
    batch: {
      readonly id: Id;
      readonly projectId: Id;
      readonly requestedBy: Id | null;
      readonly budgetUsd: number | null;
    },
  ): Promise<void> {
    await sqlOf(tx).query(
      `insert into shadow_batches (id, project_id, requested_by, budget_usd)
       values ($1, $2, $3, $4)`,
      [batch.id, batch.projectId, batch.requestedBy, batch.budgetUsd],
    );
  }

  async addTicket(tx: Transaction, batchId: Id, ticket: ShadowBatchTicketRow): Promise<void> {
    await sqlOf(tx).query(
      `insert into shadow_batch_tickets
         (batch_id, ticket_key, task_id, base_sha, human_mr_ref, human_mr_source,
          human_mr_merged_at, human_mr_candidates, refused_reason)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
      [
        batchId,
        ticket.ticketKey,
        ticket.taskId,
        ticket.baseSha,
        ticket.humanMr === null ? null : JSON.stringify(ticket.humanMr),
        ticket.humanMrSource,
        ticket.mergedAt,
        ticket.candidates,
        ticket.refusedReason,
      ],
    );
  }

  async batch(tx: Transaction, batchId: Id): Promise<ShadowBatchRow | null> {
    const { rows } = await sqlOf(tx).query<BatchRow>(
      'select id, project_id, requested_by, budget_usd, created_at, completed_at from shadow_batches where id = $1',
      [batchId],
    );
    const row = rows[0];
    return row === undefined ? null : toBatch(row);
  }

  async listBatches(
    tx: Transaction,
    projectId: Id,
    limit: number,
  ): Promise<readonly ShadowBatchRow[]> {
    const { rows } = await sqlOf(tx).query<BatchRow>(
      `select id, project_id, requested_by, budget_usd, created_at, completed_at
         from shadow_batches where project_id = $1 order by created_at desc, id desc limit $2`,
      [projectId, limit],
    );
    return rows.map(toBatch);
  }

  async tickets(tx: Transaction, batchId: Id): Promise<readonly ShadowBatchTicketRow[]> {
    const { rows } = await sqlOf(tx).query<TicketRow>(
      `select ticket_key, task_id, base_sha, human_mr_ref, human_mr_source,
              human_mr_merged_at, human_mr_candidates, refused_reason
         from shadow_batch_tickets where batch_id = $1 order by created_at, ticket_key`,
      [batchId],
    );
    return rows.map(toTicket);
  }

  async batchOfTask(tx: Transaction, taskId: Id): Promise<ShadowBatchRow | null> {
    const { rows } = await sqlOf(tx).query<BatchRow>(
      `select b.id, b.project_id, b.requested_by, b.budget_usd, b.created_at, b.completed_at
         from shadow_batches b
         join shadow_batch_tickets t on t.batch_id = b.id
        where t.task_id = $1
        order by b.created_at desc
        limit 1`,
      [taskId],
    );
    const row = rows[0];
    return row === undefined ? null : toBatch(row);
  }

  async insertReport(
    tx: Transaction,
    report: Omit<ShadowReportRow, 'createdAt'>,
  ): Promise<boolean> {
    const { rowCount } = await sqlOf(tx).query(
      `insert into shadow_reports (task_id, human_mr_ref, comparison)
       values ($1, $2::jsonb, $3::jsonb)
       on conflict (task_id) do nothing`,
      [
        report.taskId,
        report.humanMr === null ? null : JSON.stringify(report.humanMr),
        JSON.stringify(report.comparison),
      ],
    );
    return (rowCount ?? 0) > 0;
  }

  async reports(tx: Transaction, batchId: Id): Promise<readonly ShadowReportRow[]> {
    const { rows } = await sqlOf(tx).query<ReportRow>(
      `select r.task_id, r.human_mr_ref, r.comparison, r.created_at
         from shadow_reports r
         join shadow_batch_tickets t on t.task_id = r.task_id
        where t.batch_id = $1
        order by r.created_at, r.task_id`,
      [batchId],
    );
    return rows.map((row) => ({
      taskId: row.task_id as Id,
      humanMr: mergeRequest(row.human_mr_ref),
      comparison: row.comparison,
      createdAt: instant(row.created_at),
    }));
  }

  async completeIfDone(tx: Transaction, batchId: Id, at: IsoDateTime): Promise<boolean> {
    const { rowCount } = await sqlOf(tx).query(
      `update shadow_batches set completed_at = $2
        where id = $1
          and completed_at is null
          and exists (select 1 from shadow_batch_tickets where batch_id = $1 and task_id is not null)
          and not exists (
            select 1 from shadow_batch_tickets t
             where t.batch_id = $1
               and t.task_id is not null
               and not exists (select 1 from shadow_reports r where r.task_id = t.task_id)
          )`,
      [batchId, at],
    );
    return (rowCount ?? 0) > 0;
  }

  async shadowSpendSince(tx: Transaction, projectId: Id, since: IsoDateTime): Promise<number> {
    const { rows } = await sqlOf(tx).query<{ usd: string }>(
      `select coalesce(sum(c.usd), 0)::text as usd
         from cost_entries c
         join tasks t on t.id = c.task_id
        where c.project_id = $1 and t.mode = 'shadow' and c.created_at >= $2`,
      [projectId, since],
    );
    return Number(rows[0]?.usd ?? 0);
  }

  async checkoutBaseFor(tx: Transaction, taskId: Id): Promise<string | null> {
    const { rows } = await sqlOf(tx).query<{ base_sha: string | null }>(
      'select base_sha from shadow_batch_tickets where task_id = $1 order by created_at limit 1',
      [taskId],
    );
    return rows[0]?.base_sha ?? null;
  }
}
