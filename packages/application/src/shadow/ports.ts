/**
 * What shadow mode stores, behind a port — WP-34.
 *
 * Separate from `PipelineStore` for the reason `CostStore` is: a shadow batch is a set somebody
 * selected on one day (`shadow_batches`, `shadow_batch_tickets`, migration 0029) and the report is
 * a row of its own (`shadow_reports`, migration 0008, which had no writer until this work package).
 * None of them is part of a task's own state, so none of them belongs on the aggregate's store —
 * and a composition root that runs the API without the pipeline composes the reads and not the
 * writes.
 *
 * Everything here takes the caller's transaction. Two writes in this module have to be atomic with
 * something else — the batch's tickets with the tasks they created, and the report with the event
 * that announces it — and a store that opened its own transaction could not give them that.
 */
import type { Id, IsoDateTime, MergeRequestRef, ShadowHumanMrSource } from '@platform/contracts';
import type { Transaction } from '../ports/transaction.js';

/** One ticket of a batch, as it is written and as it is read back. */
export interface ShadowBatchTicketRow {
  readonly ticketKey: string;
  /** Null exactly when {@link refusedReason} is not (migration 0029's check constraint). */
  readonly taskId: Id | null;
  /** Q82 (a): the commit the comparison is anchored at. */
  readonly baseSha: string | null;
  readonly humanMr: MergeRequestRef | null;
  readonly humanMrSource: ShadowHumanMrSource | null;
  /**
   * When the human merge request was merged, or `null` when there is none (or the provider
   * published none).
   *
   * Carried because product/19 §16's review window runs *"to merge or last activity"* and the
   * report duty has no other way to learn it: the match is made once, at batch time, and a report
   * written hours later would otherwise have to pay a fourth provider read to ask again. Without
   * it `reviewerMinutesFromDiscussions` was always given `until: null`, so the *"to merge"* half of
   * the arithmetic never applied and every figure under-counted a merge that followed the last
   * comment (WP-34 review round 2).
   */
  readonly mergedAt: string | null;
  /**
   * How many merged merge requests the scan matched for this ticket, or `null` when no scan ran.
   *
   * `1` for a match made from a link on the ticket, which is authoritative. It is on the row
   * because the report's `notes` states it: *"the most recently merged wins"* understates the
   * human's size when a ticket was delivered across several merge requests, and a reader cannot
   * judge that from a number that does not travel (WP-34 review round 2).
   */
  readonly candidates: number | null;
  readonly refusedReason: string | null;
}

export interface ShadowBatchRow {
  readonly id: Id;
  readonly projectId: Id;
  readonly requestedBy: Id | null;
  /** `features.shadow_mode.budget_usd` as it stood when the batch was created. */
  readonly budgetUsd: number | null;
  readonly createdAt: IsoDateTime;
  readonly completedAt: IsoDateTime | null;
}

/** The report the platform computed for one shadow task (`shadow_reports`). */
export interface ShadowReportRow {
  readonly taskId: Id;
  readonly humanMr: MergeRequestRef | null;
  /** `shadowReportDataSchema`, parsed before it is written and after it is read. */
  readonly comparison: unknown;
  readonly createdAt: IsoDateTime;
}

export interface ShadowStore {
  /** Creates the batch row. The tickets are written by {@link addTicket}, same transaction. */
  createBatch(
    tx: Transaction,
    batch: {
      readonly id: Id;
      readonly projectId: Id;
      readonly requestedBy: Id | null;
      readonly budgetUsd: number | null;
    },
  ): Promise<void>;

  addTicket(tx: Transaction, batchId: Id, ticket: ShadowBatchTicketRow): Promise<void>;

  batch(tx: Transaction, batchId: Id): Promise<ShadowBatchRow | null>;

  listBatches(tx: Transaction, projectId: Id, limit: number): Promise<readonly ShadowBatchRow[]>;

  tickets(tx: Transaction, batchId: Id): Promise<readonly ShadowBatchTicketRow[]>;

  /** The batch a task belongs to, or `null` for a shadow task nobody batched (there is no such path today). */
  batchOfTask(tx: Transaction, taskId: Id): Promise<ShadowBatchRow | null>;

  /**
   * Writes the report if the task does not already have one, and answers whether it did.
   *
   * `false` is what makes the report duty idempotent: the job is at-least-once, `shadow_reports` is
   * keyed by `task_id`, and a second run must not append a second `shadow.report.created`.
   */
  insertReport(tx: Transaction, report: Omit<ShadowReportRow, 'createdAt'>): Promise<boolean>;

  reports(tx: Transaction, batchId: Id): Promise<readonly ShadowReportRow[]>;

  /**
   * Marks the batch finished when every ticket of it that became a task has a report.
   *
   * Answers `true` only on the write that actually changed the row, so the consumer of
   * `shadow.report.created` performs nothing twice (`completed_at is null` is in the predicate).
   */
  completeIfDone(tx: Transaction, batchId: Id, at: IsoDateTime): Promise<boolean>;

  /**
   * What this project's **shadow** tasks have spent since an instant, from `cost_entries`.
   *
   * The ledger rather than `tasks.cost_actual`, for the reason WP-19 gives everywhere else: the
   * entries are the record and the task column is a running total the executor maintains. It is the
   * number the separate shadow budget is checked against, and the reason it is here rather than on
   * `CostStore` is that it is the only query in the platform that groups spend by `tasks.mode`.
   */
  shadowSpendSince(tx: Transaction, projectId: Id, since: IsoDateTime): Promise<number>;

  /**
   * The commit a shadow task's workspace should be checked out at — Q82 (a), PROGRESS backlog 71.
   *
   * Null for a task that is not part of a batch, and for a batch entry with no base. The stage
   * executor asks it only for a task whose `mode` is `shadow`, so an ordinary delivery pays no
   * query for it.
   */
  checkoutBaseFor(tx: Transaction, taskId: Id): Promise<string | null>;
}
