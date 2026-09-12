/**
 * The price-table maintenance job — WP-19, TD-004's cron family, BD-011's consequence:
 * *"Price table must be maintained."*
 *
 * ## What it does, and the much larger thing it deliberately does not
 *
 * It does **not** fetch prices. There is no verified machine-readable price feed in this build —
 * migration 0009's rows cite a documentation page a human read (research/04 § 3), the platform has
 * no credential for the vendor's site, and a job that scraped a page and wrote `price_list` would
 * be writing money into an append-only ledger's inputs from an unvalidated source. A wrong price is
 * not a visible failure: it is a plausible number in every invoice reconciliation afterwards.
 *
 * What it does is the maintenance a machine *can* do correctly and a human will not do reliably:
 *
 *  1. **Close superseded windows.** technical/03 says a price row is "never mutated; a new price
 *     gets a new row and the previous row's `effective_to` is closed". An operator who inserts a
 *     new row and forgets the `update` leaves two rows in force at once, and `pricesAt` would pick
 *     one of them by `effective_from desc` — right today, and silently wrong the moment somebody
 *     backdates a row. This closes each superseded row at its successor's `effective_from`.
 *  2. **Name the models the ledger could not price.** A model id that appears in
 *     `run_model_usage` with no `usd_estimated` is a model the platform ran and cannot cost
 *     (`cost/ledger.ts` refuses rather than zeroing — standing rule 16). The count and the ids are
 *     the signal an operator needs to add a price row, and nothing else in the platform surfaces
 *     it.
 *
 * Both are idempotent, which is what lets it run on a cron from every replica: the close is a
 * no-op once applied, and the report is a read.
 */
import type { Jobs, JobWorker } from '@platform/application';
import type { SqlExecutor } from '../events/sql.js';

/** TD-004's cron family; the name is this work package's, in the same dotted grammar. */
export const PRICE_LIST_MAINTENANCE_JOB = 'price.list.maintain';

/**
 * Daily at 04:10 in the organisation's zone — after the partition maintenance at 03:20, so two
 * schema-touching jobs never contend, and long before any working day starts.
 */
export const PRICE_LIST_MAINTENANCE_CRON = '10 4 * * *';

/** How many unpriced model ids the report names before it only counts them. */
export const UNPRICED_MODEL_SAMPLE = 20;

export interface PriceListMaintenanceResult {
  /** Rows whose `effective_to` was closed because a newer row supersedes them. */
  readonly closed: number;
  /** Distinct models the ledger ran and could not price. */
  readonly unpricedModels: readonly string[];
  /** How many `run_model_usage` rows carry neither a reported nor an estimated cost. */
  readonly unpricedRows: number;
}

/**
 * One pass. Exported separately from the registration so a test can run it without a queue, and so
 * an operator can run it by hand.
 */
export const maintainPriceList = async (sql: SqlExecutor): Promise<PriceListMaintenanceResult> => {
  /**
   * Close each superseded row at its successor's `effective_from`.
   *
   * **Two rows of one model cannot share an `effective_from`** — `price_list` is
   * `unique (model_id, effective_from)` (migration 0007) — so `lead()` can never return a row's own
   * instant and the update cannot close a window onto itself (`effective_to = effective_from`),
   * which `price_list_window_ordered` would refuse anyway. The guarantee is the unique index's, not
   * this statement's, and it is stated here because the statement reads as if it needed one.
   */
  const closed = await sql.query(
    `update price_list p
        set effective_to = next.effective_from
       from (
         select id,
                lead(effective_from) over (partition by model_id order by effective_from)
                  as effective_from
           from price_list
       ) next
      where p.id = next.id
        and next.effective_from is not null
        and (p.effective_to is null or p.effective_to <> next.effective_from)`,
  );

  const { rows } = await sql.query<{ model: string; rows: string | number }>(
    `select model, count(*) as rows
       from run_model_usage
      where usd_estimated is null and usd_reported is null
      group by model
      order by count(*) desc`,
  );

  return {
    closed: closed.rowCount ?? 0,
    unpricedModels: rows.slice(0, UNPRICED_MODEL_SAMPLE).map((row) => row.model),
    unpricedRows: rows.reduce((sum, row) => sum + Number(row.rows), 0),
  };
};

export interface PriceListMaintenanceRegistration {
  readonly db: SqlExecutor;
  /**
   * Zone the daily cron is read in. Explicit for the same reason the partition maintenance is:
   * "04:10" has to be somebody's 04:10, and taking it from the container's clock is how a
   * redeployment silently moves a maintenance window.
   */
  readonly timezone: string;
  readonly onResult?: (result: PriceListMaintenanceResult) => void;
}

/**
 * Declares the queue, registers the daily schedule and subscribes the handler.
 *
 * Idempotent: safe on every boot and from every replica — the queue and the schedule are keyed, and
 * the `exclusive` policy keeps two replicas from running one pass twice.
 */
export const registerPriceListMaintenance = async (
  jobs: Jobs,
  registration: PriceListMaintenanceRegistration,
): Promise<JobWorker> => {
  await jobs.defineQueue({
    name: PRICE_LIST_MAINTENANCE_JOB,
    policy: 'exclusive',
    retryLimit: 2,
    retryDelaySeconds: 300,
  });

  await jobs.scheduleCron({
    queue: PRICE_LIST_MAINTENANCE_JOB,
    cron: PRICE_LIST_MAINTENANCE_CRON,
    timezone: registration.timezone,
  });

  return jobs.work({
    queue: PRICE_LIST_MAINTENANCE_JOB,
    handler: async () => {
      registration.onResult?.(await maintainPriceList(registration.db));
    },
  });
};
