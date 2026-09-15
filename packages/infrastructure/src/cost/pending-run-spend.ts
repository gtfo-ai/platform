/**
 * The one statement of *"what does a run the ledger has not recorded count for?"*, as SQL.
 *
 * Four caps ask it — the organisation and project budgets (`postgres-cost-store.ts`), the shadow
 * budget (`postgres-shadow-store.ts`), the maintenance budget (`postgres-maintenance-store.ts`)
 * and the history bootstrap's (`postgres-history-bootstrap-store.ts`) — and each has its own
 * scope, its own window and its own `from` clause, so what is shared here is the **valuation** and
 * the **filter**, not a query. A function that owned the whole query would have forced every
 * caller into a second round trip for a number the caller is already selecting a row for.
 *
 * The rule the two fragments implement, and the measurement that earned it, are stated once in
 * `packages/application/src/cost/pending.ts`. In short: a live run counts the reservation the
 * admitting stage was going to spend anyway, an ended run counts the figure its **own**
 * transaction wrote (`usd_reported` *or* `usd_estimated`, both set by `RunRepository.finish`
 * beside `run.finished`), and a run the ledger has already charged counts nothing here because
 * `cost_entries` has it.
 *
 * **`usd_estimated` joined that `coalesce` at WP-47** (backlog 110), and it closed a hole one whole
 * provider mode wide: `finish` writes `usd_reported` only when the cost is **not** an estimate, and
 * `is_estimate` is `spec.providerMode === 'local'` — so under BD-004 `local` mode *every* run
 * committed **0** to every cap between its own commit and its ledger row. The column that would
 * have carried it, `runs.usd_estimated`, was `not null default 0` with no writer anywhere in the
 * tree. Both halves are fixed: migration 0035 makes it nullable (a 0 there read as a free run) and
 * `finish` writes it. The order is BD-011's: the provider's figure first, the platform's own
 * pricing second, and `0` only for a run **nobody measured** — which is a real state the lease
 * sweep produces and which no ledger row is ever written for.
 *
 * **Why `not exists` and not a join**: a run has one ledger row per model, so a join would
 * multiply the reservation by the number of models, and `cost_entries` is partitioned by
 * `created_at` — a lookup by `run_id` uses `cost_entries_run_idx` on every partition, which is
 * what the `not exists` asks for and what a `left join … group by` would not.
 */
import { ACTIVE_RUN_STATUSES } from '@platform/domain';

/** `ACTIVE_RUN_STATUSES` as a query parameter, for `r.status = any($n::run_status[])`. */
export const ACTIVE_RUN_STATUSES_PARAM: readonly string[] = [...ACTIVE_RUN_STATUSES];

/**
 * What one run of the pending set is worth, as a `sum(...)` argument over the alias `r`.
 *
 * @param statuses the `$n` holding {@link ACTIVE_RUN_STATUSES_PARAM}
 * @param reserve the `$n` holding what a run of the admitting stage may spend
 */
export const pendingRunUsdSql = (statuses: string, reserve: string): string =>
  `case when r.status = any(${statuses}::run_status[]) then ${reserve}::numeric
        else coalesce(r.usd_reported, r.usd_estimated, 0) end`;

/**
 * The `where` term that keeps a run the ledger has already charged out of the pending set.
 *
 * The alias is `c_pending` rather than `c` so a caller that already has a `cost_entries c` in
 * scope cannot shadow it into a correlated subquery that is always true.
 */
export const UNLEDGERED_RUN_SQL =
  'not exists (select 1 from cost_entries c_pending where c_pending.run_id = r.id)';

/**
 * The `where` term that bounds the pending set to a cap's window.
 *
 * A **live** run is always in the window — it is spending now, whatever instant the window
 * started — so the term is about ended runs only. A cap whose scope is a one-off batch (the
 * history bootstrap) passes no window at all: the batch *is* the bound.
 *
 * @param since the `$n` holding the window start
 */
export const PENDING_RUN_WINDOW_SQL = (since: string): string =>
  `(r.ended_at is null or r.ended_at >= ${since}::timestamptz)`;
