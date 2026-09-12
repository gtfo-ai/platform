/**
 * `CostStore` on PostgreSQL — the tables of technical/03 § "Cost and governance" (WP-19).
 *
 * Every method takes the `Transaction` handle the application ring passes around and narrows it
 * with `postgresTransaction`, so the ledger row, the rollup, the budget window and the events all
 * commit with the `handler_executions` claim that says the handler ran. That is what makes the
 * projection exactly-once without a unique key doing the work (TD-005).
 *
 * ## Money is a string on the wire
 *
 * `numeric(12,6)` comes back from `pg` as a **string** because `numeric` holds more than a double;
 * everything read here goes through one `usd` helper, and the domain rounds to the six decimals the
 * column can hold exactly (`roundUsd`).
 *
 * ## The one lock
 *
 * `budgets.applicable` **ensures the window row exists and takes it `for update`**, which is what
 * serialises two runs finishing at once: the fold is read-modify-write on `spent_usd`, and standing
 * rule 79 was earned on exactly that shape (a derived total, a second writer, and a lost update
 * nobody could see from the row). The insert-then-lock order matters — locking a row that does not
 * exist yet locks nothing, so two first-ever entries of one window would both start from zero.
 */
import type {
  BudgetRepository,
  BudgetSubject,
  CostStore,
  ModelUsageRow,
  RunCostRow,
  StoredBudget,
  Transaction,
  WindowStartOf,
} from '@platform/application';
import type { Id, IsoDateTime, Size } from '@platform/contracts';
import { refinedSpecDataSchema } from '@platform/contracts';
import type { PriceRates, RollupDelta, TaskCostSample } from '@platform/domain';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

/** Raised when a write that had to change a row changed none. */
export class CostRowMissingError extends Error {
  override readonly name = 'CostRowMissingError';
}

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

const usd = (value: string | number | null): number =>
  value === null ? 0 : typeof value === 'number' ? value : Number(value);

const usdOrNull = (value: string | number | null): number | null =>
  value === null ? null : usd(value);

const iso = (value: Date | string | null): IsoDateTime | null =>
  value === null ? null : (new Date(value).toISOString() as IsoDateTime);

interface RunContextRow extends Record<string, unknown> {
  run_id: string;
  task_id: string;
  project_id: string;
  org_id: string;
  template: string;
  stage: string | null;
  model: string;
  started_at: Date | string | null;
}

interface PriceRow extends Record<string, unknown> {
  id: string;
  model_id: string;
  input: string;
  output: string;
  cache_write_5m: string;
  cache_write_1h: string;
  cache_read: string;
}

/**
 * A budget definition. Spelled out rather than derived with `Omit`: these row types carry an index
 * signature for the driver, and `Omit` over one collapses every named field to `unknown`.
 */
interface BudgetDefinitionRow extends Record<string, unknown> {
  id: string;
  scope: StoredBudget['scope'];
  scope_id: string | null;
  project_id: string | null;
  window: StoredBudget['window'];
  limit_usd: string;
  notify_pct: number[];
}

interface BudgetRow extends BudgetDefinitionRow {
  spent_usd: string | null;
  notified_pct: number[] | null;
  sequence: string | number | null;
}

const toStoredBudget = (row: BudgetRow, windowStart: IsoDateTime): StoredBudget => ({
  id: row.id as Id,
  scope: row.scope,
  scopeId: row.scope_id as Id | null,
  projectId: row.project_id as Id | null,
  window: row.window,
  limitUsd: usd(row.limit_usd),
  notifyPct: row.notify_pct,
  windowStart,
  spentUsd: usd(row.spent_usd),
  notifiedPct: row.notified_pct ?? [],
  // Read from the log rather than stored on the row, exactly as `PipelineStore` reads a task's:
  // the `events` table is the one authority for an aggregate's sequence (standing rule 9).
  sequence: row.sequence === null ? 1 : Number(row.sequence) + 1,
});

/** The budgets that apply to a subject, as a `WHERE` fragment over `budgets`. */
const scopeFilter = (subject: BudgetSubject): { text: string; values: unknown[] } =>
  subject.taskId === null
    ? {
        text: `(b.scope = 'org' or (b.scope = 'project' and b.scope_id = $1))`,
        values: [subject.projectId],
      }
    : {
        text: `(b.scope = 'org' or (b.scope = 'project' and b.scope_id = $1)
                or (b.scope = 'task' and b.scope_id = $2))`,
        values: [subject.projectId, subject.taskId],
      };

const loadBudgets = async (
  sql: SqlExecutor,
  where: { text: string; values: unknown[] },
  windowStartOf: WindowStartOf,
): Promise<readonly StoredBudget[]> => {
  const { rows } = await sql.query<BudgetDefinitionRow>(
    `select b.id, b.scope, b.scope_id, b.window, b.limit_usd, b.notify_pct,
            (select p.id from projects p where p.id = b.scope_id) as project_id
       from budgets b
      where ${where.text}
      order by b.scope, b.window`,
    where.values,
  );
  const result: StoredBudget[] = [];
  for (const row of rows) {
    const windowStart = windowStartOf(row.window);
    // Insert-then-lock: a `for update` on a row that does not exist yet locks nothing, so the
    // first two entries of a window would both read zero and one would be lost.
    await sql.query(
      `insert into budget_windows (budget_id, window_start) values ($1, $2)
         on conflict (budget_id, window_start) do nothing`,
      [row.id, windowStart],
    );
    const { rows: windowRows } = await sql.query<{
      spent_usd: string;
      notified_pct: number[];
      sequence: string | number | null;
    }>(
      `select w.spent_usd, w.notified_pct,
              (select max(e.stream_seq) from events e
                where e.stream_type = 'budget' and e.stream_id = w.budget_id) as sequence
         from budget_windows w
        where w.budget_id = $1 and w.window_start = $2
        for update`,
      [row.id, windowStart],
    );
    const windowRow = windowRows[0];
    result.push(
      toStoredBudget(
        {
          ...row,
          spent_usd: windowRow?.spent_usd ?? null,
          notified_pct: windowRow?.notified_pct ?? null,
          sequence: windowRow?.sequence ?? null,
        },
        windowStart,
      ),
    );
  }
  return result;
};

const budgetRepository: BudgetRepository = {
  applicable: async (tx, subject, windowStartOf) =>
    loadBudgets(sqlOf(tx), scopeFilter(subject), windowStartOf),

  saveWindow: async (tx, row) => {
    await sqlOf(tx).query(
      `insert into budget_windows (budget_id, window_start, spent_usd, notified_pct, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (budget_id, window_start) do update
          set spent_usd = excluded.spent_usd,
              notified_pct = excluded.notified_pct,
              updated_at = now()`,
      [row.budgetId, row.windowStart, row.spentUsd, [...row.notifiedPct]],
    );
  },
};

export const createPostgresCostStore = (): CostStore => ({
  runContext: async (tx, runId) => {
    const { rows } = await sqlOf(tx).query<RunContextRow>(
      `select r.id as run_id, r.task_id, r.project_id, p.org_id, t.template,
              s.stage, r.model, r.started_at
         from runs r
         join tasks t on t.id = r.task_id
         join projects p on p.id = r.project_id
         left join task_stages s on s.id = r.task_stage_id
        where r.id = $1`,
      [runId],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      runId: row.run_id as Id,
      taskId: row.task_id as Id,
      projectId: row.project_id as Id,
      orgId: row.org_id as Id,
      template: row.template,
      stage: row.stage,
      model: row.model,
      startedAt: iso(row.started_at),
    } satisfies RunCostRow;
  },

  pricesAt: async (tx, models, at) => {
    if (models.length === 0) {
      return [];
    }
    const { rows } = await sqlOf(tx).query<PriceRow>(
      `select distinct on (model_id)
              id, model_id, input, output, cache_write_5m, cache_write_1h, cache_read
         from price_list
        where model_id = any($1::text[])
          and effective_from <= $2
          and (effective_to is null or effective_to > $2)
        order by model_id, effective_from desc`,
      [[...models], at],
    );
    return rows.map(
      (row): PriceRates => ({
        priceListId: row.id,
        modelId: row.model_id,
        input: usd(row.input),
        output: usd(row.output),
        cacheWrite5m: usd(row.cache_write_5m),
        cacheWrite1h: usd(row.cache_write_1h),
        cacheRead: usd(row.cache_read),
      }),
    );
  },

  /**
   * Appends the ledger rows.
   *
   * `do nothing` on the unique key is **asymmetric with `applyRollups`, which folds every delta it
   * is given**: a caller that passed two entries for one `(run_id, model)` would have one dropped
   * here and both summed there, breaking `sum(entries) = sum(rollups)`. That is why the fold is in
   * the *derivation* (`foldByModel`, `@platform/domain`) rather than left to this constraint — the
   * invariant holds before either write is attempted, and this clause is the backstop for a caller
   * that bypassed the derivation, not the guarantee.
   */
  appendEntries: async (tx, entries) => {
    const sql = sqlOf(tx);
    for (const entry of entries) {
      await sql.query(
        `insert into cost_entries
           (run_id, task_id, project_id, stage, model, input_tokens, output_tokens,
            cache_write_5m, cache_write_1h, cache_read, usd, is_estimate, price_list_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         on conflict on constraint cost_entries_run_model_unique do nothing`,
        [
          entry.runId,
          entry.taskId,
          entry.projectId,
          entry.stage,
          entry.model,
          entry.usage.input_tokens,
          entry.usage.output_tokens,
          entry.usage.cache_write_5m_tokens,
          entry.usage.cache_write_1h_tokens,
          entry.usage.cache_read_tokens,
          entry.usd,
          entry.isEstimate,
          entry.priceListId,
        ],
      );
    }
  },

  saveModelUsage: async (tx, rows: readonly ModelUsageRow[]) => {
    const sql = sqlOf(tx);
    for (const row of rows) {
      await sql.query(
        `insert into run_model_usage
           (run_id, model, input_tokens, output_tokens, cache_write_5m, cache_write_1h,
            cache_read, usd_estimated, usd_reported)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (run_id, model) do update
            set input_tokens = excluded.input_tokens,
                output_tokens = excluded.output_tokens,
                cache_write_5m = excluded.cache_write_5m,
                cache_write_1h = excluded.cache_write_1h,
                cache_read = excluded.cache_read,
                usd_estimated = excluded.usd_estimated,
                usd_reported = excluded.usd_reported`,
        [
          row.runId,
          row.model,
          row.usage.input_tokens,
          row.usage.output_tokens,
          row.usage.cache_write_5m_tokens,
          row.usage.cache_write_1h_tokens,
          row.usage.cache_read_tokens,
          row.usdEstimated,
          row.usdReported,
        ],
      );
    }
  },

  applyRollups: async (tx, deltas: readonly RollupDelta[]) => {
    const sql = sqlOf(tx);
    for (const delta of deltas) {
      await sql.query(
        `insert into cost_rollup_daily
           (org_id, project_id, template, stage, model, day, mode, runs, input_tokens,
            output_tokens, cache_write_5m, cache_write_1h, cache_read, usd, wall_ms, turns,
            updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now())
         on conflict (project_id, day, template, stage, model, mode) do update
            set runs = cost_rollup_daily.runs + excluded.runs,
                input_tokens = cost_rollup_daily.input_tokens + excluded.input_tokens,
                output_tokens = cost_rollup_daily.output_tokens + excluded.output_tokens,
                cache_write_5m = cost_rollup_daily.cache_write_5m + excluded.cache_write_5m,
                cache_write_1h = cost_rollup_daily.cache_write_1h + excluded.cache_write_1h,
                cache_read = cost_rollup_daily.cache_read + excluded.cache_read,
                usd = cost_rollup_daily.usd + excluded.usd,
                wall_ms = cost_rollup_daily.wall_ms + excluded.wall_ms,
                turns = cost_rollup_daily.turns + excluded.turns,
                updated_at = now()`,
        [
          delta.orgId,
          delta.projectId,
          delta.template,
          delta.stage,
          delta.model,
          delta.day,
          delta.mode,
          delta.runs,
          delta.usage.input_tokens,
          delta.usage.output_tokens,
          delta.usage.cache_write_5m_tokens,
          delta.usage.cache_write_1h_tokens,
          delta.usage.cache_read_tokens,
          delta.usd,
          delta.wallMs,
          delta.turns,
        ],
      );
    }
  },

  organisationTimezone: async (tx, projectId) => {
    const { rows } = await sqlOf(tx).query<{ timezone: string | null }>(
      `select o.timezone
         from projects p join organizations o on o.id = p.org_id
        where p.id = $1`,
      [projectId],
    );
    return rows[0]?.timezone ?? null;
  },

  estimateHistory: async (tx, projectId, limit) => {
    const { rows } = await sqlOf(tx).query<{
      size: Size;
      cost_actual: string;
      same_project: boolean;
    }>(
      `select t.size, t.cost_actual, (t.project_id = $1) as same_project
         from tasks t
         join projects p on p.id = t.project_id
        where t.size is not null
          and t.cost_actual > 0
          and t.completed_at is not null
          and p.org_id = (select org_id from projects where id = $1)
        order by t.completed_at desc
        limit $2`,
      [projectId, limit],
    );
    const org: TaskCostSample[] = rows.map((row) => ({
      size: row.size,
      costUsd: usd(row.cost_actual),
    }));
    const project = rows
      .filter((row) => row.same_project)
      .map((row) => ({ size: row.size, costUsd: usd(row.cost_actual) }));
    return { project, org };
  },

  refinedSize: async (tx, taskId) => {
    const { rows } = await sqlOf(tx).query<{ data: unknown }>(
      `select data from artifacts
        where task_id = $1 and type = 'RefinedSpec'
        order by version desc
        limit 1`,
      [taskId],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    // An artifact is model output (BD-022): parsed, never trusted. A document that does not parse
    // has no size, which the caller spells as "no estimate" rather than as a default.
    const parsed = refinedSpecDataSchema.safeParse(row.data);
    return parsed.success ? parsed.data.size : null;
  },

  saveEstimate: async (tx, taskId, estimate) => {
    const result = await sqlOf(tx).query(
      `update tasks set size = $2, estimate_usd = $3, updated_at = now() where id = $1`,
      [taskId, estimate.size, estimate.estimateUsd],
    );
    if (result.rowCount === 0) {
      throw new CostRowMissingError(`no task ${taskId} to write an estimate to`);
    }
  },

  taskEstimate: async (tx, taskId) => {
    const { rows } = await sqlOf(tx).query<{ size: Size | null; estimate_usd: string | null }>(
      `select size, estimate_usd from tasks where id = $1`,
      [taskId],
    );
    const row = rows[0];
    return row === undefined ? null : { size: row.size, estimateUsd: usdOrNull(row.estimate_usd) };
  },

  budgets: budgetRepository,
});
