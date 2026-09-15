/**
 * The statistics projector's persistence port — `stats_task_delivery` and `stats_event_daily`
 * (migration 0034), behind an interface this ring can name.
 *
 * Transaction-bound like `CostStore`, `HumanTimeStore` and `PipelineStore`, and for the same
 * reason: every row commits together with the `handler_executions` claim that says the handler ran
 * (TD-005), so a redelivered event cannot double-count and a backfill over a range the dispatcher
 * already served is a no-op.
 *
 * ## What it deliberately cannot do
 *
 * There is no delete, no truncate and no *set* on a counter — only `addCounter`, which adds. A
 * projection is rebuilt by replaying the log into it (`events/replay.ts`), which the claim makes
 * idempotent; a port that could set a counter would offer a second way to rebuild that nothing
 * checks against the first.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import type { Transaction } from '../ports/transaction.js';
import type { StatsCounter } from './metrics.js';

export interface StatsStore {
  /**
   * The task that owns this merge request, or `null`.
   *
   * **Not optional, and the reason is what a production payload looks like**: every `mr.*` event
   * carries `task_id` as *nullish*, and the git adapter that produces one from a webhook cannot
   * know which task it belongs to — so on a real instance it is **always null** and the association
   * has to be read from `tasks.mr_ref`. A projector that trusted the payload would write no
   * delivery row on any instance while passing every test that handed it one (standing rule 1).
   *
   * The same lookup `HumanTimeStore` makes and the same predicate `TaskRepository.findByMergeRequest`
   * uses, so the projections and the saga can never disagree about which task a merge request
   * belongs to (standing rule 9).
   */
  readonly taskForMergeRequest: (
    tx: Transaction,
    subject: { readonly projectId: Id; readonly iid: number },
  ) => Promise<Id | null>;

  /**
   * The organisation timezone the project belongs to, or `null` when it has none.
   *
   * The same read the cost ledger and the human-time projector make, and for the same reason: the
   * civil day a counter lands in must be cut by the calendar the budgets and `cost_rollup_daily`
   * already use (Q12, standing rule 9).
   */
  readonly organisationTimezone: (tx: Transaction, projectId: Id) => Promise<string | null>;

  /**
   * Records that this task's merge request merged, at `mergedAt`.
   *
   * **The first merge is the delivery**: a second call for the same task changes nothing (`on
   * conflict do nothing`). A merge request that is reopened and merged again is one delivered task,
   * and taking the later instant would move a delivery between buckets after a reader had seen it.
   */
  readonly recordDelivery: (
    tx: Transaction,
    delivery: { readonly taskId: Id; readonly projectId: Id; readonly mergedAt: IsoDateTime },
  ) => Promise<void>;

  /** Adds to one `(project, civil day, metric)` counter, inserting the row when it is the first. */
  readonly addCounter: (
    tx: Transaction,
    delta: {
      readonly projectId: Id;
      /** A civil date, `YYYY-MM-DD`, already cut in the organisation's zone. */
      readonly day: string;
      readonly metric: StatsCounter;
      readonly count: number;
      readonly total: number;
    },
  ) => Promise<void>;
}
