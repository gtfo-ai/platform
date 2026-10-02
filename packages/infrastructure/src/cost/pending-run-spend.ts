/**
 * The one statement of *"what does a run the ledger has not recorded count for?"*, as SQL.
 *
 * Five caps ask it — the organisation and project budgets (`postgres-cost-store.ts`), the shadow
 * budget (`postgres-shadow-store.ts`), the maintenance budget (`postgres-maintenance-store.ts`)
 * and the history bootstrap's (`postgres-history-bootstrap-store.ts`) — and the task cap reads the
 * held half of it ({@link unmeasuredEndedRunSql}, in `RunRepository.heldFor`). Each has its own
 * scope, its own window and its own `from` clause, so what is shared here is the **valuation** and
 * the **filter**, not a query. A function that owned the whole query would have forced every
 * caller into a second round trip for a number the caller is already selecting a row for.
 *
 * The rule the fragments implement, and the measurements that earned it, are stated once in
 * `packages/application/src/cost/pending.ts`. In short: a live run counts the reservation the
 * admitting stage was going to spend anyway, an ended run counts the figure its **own**
 * transaction wrote (`usd_reported` *or* `usd_estimated`, both set by `RunRepository.finish`
 * beside `run.finished`), an ended run **nobody measured** is **held** at the reservation it was
 * admitted at (`runs.reserve_usd`, WP-131), and a run the ledger has already charged counts nothing
 * here because `cost_entries` has it.
 *
 * **`usd_estimated` joined that `coalesce` at WP-47** (backlog 110), and it closed a hole one whole
 * provider mode wide: `finish` writes `usd_reported` only when the cost is **not** an estimate, and
 * `is_estimate` is `spec.providerMode === 'local'` — so under BD-004 `local` mode *every* run
 * committed **0** to every cap between its own commit and its ledger row. Migration 0035 made the
 * column nullable (a 0 there read as a free run) and `finish` writes it. The order is BD-011's: the
 * provider's figure first, the platform's own pricing second.
 *
 * **The third answer, both columns null, is a hold since WP-131** (PROGRESS backlog 402). Until
 * then this module valued it at `0`, and every cap admitted past its limit by up to one per-run cap
 * per run that ended unmeasured — a lease-swept run, a cancel ended in place, a stop or a crash that
 * read no `result` (WP-47, WP-101, WP-119). The ruling on 402 holds it at **its own** cap,
 * `runs.reserve_usd` (migration 0072), which is the figure the admission reserved for it while it was
 * live; a row written before 0072 carries `null` there and is held at the **admitting** stage's
 * reserve instead — a guess in the fail-closed direction (standing rule 20), the only figure this
 * query has for a run whose own was never recorded. It is returned **apart** from the pending sum
 * ({@link committedRunsSql}'s `held_usd` and `held_runs`), because a hold is not spend and an
 * operator raising a cap is told the two separately (standing rule 16).
 *
 * **There is no exclusion.** A run counts `0` only when its row *proves* no CLI process was spawned,
 * and the one such row this build writes already proves it with a measurement: a run that could not
 * be started is finished by the stage executor's `recordUnstarted` with `usd_reported = 0`
 * (`NO_COST`, *"nothing was spent, because nothing ran"*), so it is not in the held set at all. A
 * run swept or cancelled before its process spawned anything leaves both columns null like any
 * other, and nothing on the row tells the two apart — so it is held.
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
 * An **ended** run nobody measured — terminal, and both cost columns null — over the alias `r`.
 * Or, since the WP-131 pre-review round (backlog 407), terminal with `figure_is_floor` set: a
 * `cost_unreported` stop, whose `0` in the cost column is the runner's floor and not a figure.
 *
 * The set {@link committedRunsSql} holds and `RunRepository.heldFor` sums for the task cap. One
 * spelling for both, so the five ledger-backed caps and the task cap cannot disagree about which runs
 * a hold is for.
 *
 * @param statuses the `$n` holding {@link ACTIVE_RUN_STATUSES_PARAM}
 */
export const unmeasuredEndedRunSql = (statuses: string): string =>
  `(not (r.status = any(${statuses}::run_status[]))
         and ((r.usd_reported is null and r.usd_estimated is null) or r.figure_is_floor))`;

/**
 * What one run of the pending set is worth, as a `sum(...)` argument over the alias `r`.
 *
 * A run nobody measured is worth `0` **here** and is counted by {@link heldRunUsdSql} instead, so the
 * two sums are disjoint and their total is the ruling's
 * `coalesce(usd_reported, usd_estimated, reserve_usd, $reserve)` for an ended run.
 *
 * @param statuses the `$n` holding {@link ACTIVE_RUN_STATUSES_PARAM}
 * @param reserve the `$n` holding what a run of the admitting stage may spend
 */
export const pendingRunUsdSql = (statuses: string, reserve: string): string =>
  `case when r.status = any(${statuses}::run_status[]) then ${reserve}::numeric
        when r.figure_is_floor then 0
        else coalesce(r.usd_reported, r.usd_estimated, 0) end`;

/**
 * What one run is **held** at, as a `sum(...)` argument over the alias `r` (WP-131): its own
 * `reserve_usd` when it ended unmeasured, the admitting reserve when that column is `null` (a run
 * written before migration 0072), and `0` for every other run.
 *
 * @param statuses the `$n` holding {@link ACTIVE_RUN_STATUSES_PARAM}
 * @param reserve the `$n` holding what a run of the admitting stage may spend
 */
export const heldRunUsdSql = (statuses: string, reserve: string): string =>
  `case when ${unmeasuredEndedRunSql(statuses)}
        then coalesce(r.reserve_usd, ${reserve}::numeric) else 0 end`;

/**
 * The three numbers a cap reads off the runs of its scope, as a select list over the alias `r`:
 * `pending_usd` (live reservations and ended figures the ledger has not charged), `held_usd` and
 * `held_runs` (the runs nobody measured). The caller supplies the `from runs r …` and the `where`.
 *
 * @param statuses the `$n` holding {@link ACTIVE_RUN_STATUSES_PARAM}
 * @param reserve the `$n` holding what a run of the admitting stage may spend
 */
export const committedRunsSql = (statuses: string, reserve: string): string =>
  `coalesce(sum(${pendingRunUsdSql(statuses, reserve)}), 0)::text as pending_usd,
   coalesce(sum(${heldRunUsdSql(statuses, reserve)}), 0)::text as held_usd,
   (count(*) filter (where ${unmeasuredEndedRunSql(statuses)}))::int as held_runs`;

/** The row {@link committedRunsSql} selects. */
export type CommittedRunsRow = {
  readonly pending_usd?: string | null;
  readonly held_usd?: string | null;
  readonly held_runs?: number | string | null;
};

/** {@link committedRunsSql}'s row as the port's numbers; an absent row commits nothing. */
export const committedRunsOf = (
  row: CommittedRunsRow | undefined,
): { readonly pendingUsd: number; readonly heldUsd: number; readonly heldRuns: number } => ({
  pendingUsd: Number(row?.pending_usd ?? 0),
  heldUsd: Number(row?.held_usd ?? 0),
  heldRuns: Number(row?.held_runs ?? 0),
});

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
