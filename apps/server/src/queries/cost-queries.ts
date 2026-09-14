/**
 * The budget reads of technical/08, and — since WP-30 — the one **write** that is not the ledger's.
 *
 * The reads are projections onto the published DTO, like `pipeline-queries.ts`: the route's response
 * schema re-validates the shape on the way out, and `packages/application`'s `CostStore` is the
 * *charging* side — it takes a transaction handle because the ledger's four writes have to commit
 * together, which a read route neither has nor wants. {@link writeBudget} is neither: it is an
 * operator setting a cap, one statement, outside any ledger transaction.
 *
 * What it must not do is invent a window. `budget_windows` holds a row per `(budget, window_start)`
 * and a budget that has not been charged in the current window has **no row**: that is a spend of
 * zero, which is a fact (the ledger inserts the row on the first charge) rather than a guess. The
 * window itself is computed with the same `budgetWindowStart` the ledger uses, in the organisation's
 * timezone, so the dashboard and the budget agree on when the month turned (BD-010, Q12).
 */
import { budgetWindowStart, resolveBudgetTimezone } from '@platform/application';
import type { BudgetRecord, Id, IsoDateTime } from '@platform/contracts';
import { db as dbAdapters } from '@platform/infrastructure';
import type { SQL } from 'drizzle-orm';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';

const { budgets, budgetWindows, organizations, projects } = dbAdapters.schema;

export type Database = dbAdapters.Database;

/** Postgres `numeric` arrives as a string; the DTOs publish numbers. */
const usd = (value: string | null): number => (value === null ? 0 : Number(value));

/**
 * The zone this project's budget windows are read in, or `undefined` when the project does not exist.
 *
 * It answers with {@link resolveBudgetTimezone}'s verdict rather than the raw column, because the
 * raw column can hold a value `budgetWindowStart` **refuses** (a fixed offset has no DST rules) and
 * this is a *read*: throwing would answer 500 in exactly the state the ledger deliberately fails
 * open for, so the dashboard would die on the misconfiguration it exists to show. One substitution
 * for the ledger, the guard and this (standing rule 9 — one obligation, one arbiter).
 */
export const findProjectTimezone = async (
  database: Database,
  projectId: string,
): Promise<{ readonly timezone: string; readonly substituted: boolean } | undefined> => {
  const rows = await database
    .select({ timezone: organizations.timezone })
    .from(projects)
    .innerJoin(organizations, eq(organizations.id, projects.orgId))
    .where(eq(projects.id, projectId))
    .limit(1);
  const row = rows[0];
  return row === undefined ? undefined : resolveBudgetTimezone(row.timezone);
};

/**
 * The half both budget reads share: the window each definition is in, and the spend recorded for it.
 *
 * The two endpoints differ in **which budgets** they ask for and in where the timezone comes from,
 * and in nothing else — so the arithmetic lives here once. Two copies of it is how a project read
 * and an organisation read come to disagree about when the month turned, which is the one thing
 * BD-010 and Q12 exist to prevent.
 */
const budgetsWithSpend = async (
  database: Database,
  scope: SQL | undefined,
  at: IsoDateTime,
  timezone: string,
): Promise<readonly BudgetRecord[]> => {
  const definitions = await database
    .select({
      id: budgets.id,
      scope: budgets.scope,
      scopeId: budgets.scopeId,
      window: budgets.window,
      limitUsd: budgets.limitUsd,
      notifyPct: budgets.notifyPct,
    })
    .from(budgets)
    .where(scope);
  if (definitions.length === 0) {
    return [];
  }

  const wanted = definitions.map((definition) => ({
    ...definition,
    windowStart: budgetWindowStart(definition.window, at, timezone),
  }));
  const rows = await database
    .select({
      budgetId: budgetWindows.budgetId,
      windowStart: budgetWindows.windowStart,
      spentUsd: budgetWindows.spentUsd,
    })
    .from(budgetWindows)
    .where(
      inArray(
        budgetWindows.budgetId,
        wanted.map((budget) => budget.id),
      ),
    );
  const spent = new Map(
    rows.map((row) => [`${row.budgetId}@${row.windowStart.toISOString()}`, row.spentUsd]),
  );

  return wanted.map((budget) => ({
    id: budget.id as Id,
    scope: budget.scope,
    scope_id: budget.scopeId as Id | null,
    window: budget.window,
    limit_usd: usd(budget.limitUsd),
    notify_pct: budget.notifyPct,
    // Absent means the ledger has not charged this window yet, which is a spend of zero.
    spent_usd: usd(spent.get(`${budget.id}@${budget.windowStart}`) ?? null),
    window_start: budget.windowStart,
  }));
};

/**
 * The budgets that apply to a project: its own, and the organisation's.
 *
 * It reads with Drizzle rather than through `CostStore.budgets`, and that is a decision rather than a
 * duplication nobody noticed: the store's loader **writes** — it inserts the window row and takes it
 * `for update`, which is what serialises two runs charging one budget — and a `GET` may not insert
 * rows or hold row locks. The store is the charge path; this is the read path, and the shapes they
 * need differ for the same reason `pipeline-queries.ts` projects `runs` itself.
 */
export const listProjectBudgets = async (
  database: Database,
  projectId: string,
  at: IsoDateTime,
  timezone: string,
): Promise<readonly BudgetRecord[]> =>
  budgetsWithSpend(
    database,
    or(eq(budgets.scope, 'org'), and(eq(budgets.scope, 'project'), eq(budgets.scopeId, projectId))),
    at,
    timezone,
  );

/** What {@link writeBudget} did, so the route can answer and audit the same fact. */
export type WriteBudgetOutcome = 'created' | 'updated' | 'removed' | 'absent';

export interface WriteBudgetResult {
  readonly outcome: WriteBudgetOutcome;
  readonly id: string | null;
  /** The cap that was in force before this write, or `null` when there was none. */
  readonly previousLimitUsd: number | null;
}

/**
 * The **write** behind `PUT /api/projects/:id/budgets` and `PUT /api/org/budgets` — BD-010's caps.
 *
 * Until WP-30 `insert into budgets` occurred in exactly two files and both were tests, so the
 * organisation and project caps WP-19's admission guard reads were inert on any real instance: the
 * guard asked an empty table and always answered "nothing blocks". This is the writer.
 *
 * **Upsert on the natural key.** `budgets` carries `unique nulls not distinct (scope, scope_id,
 * "window")`, which is exactly "one cap per scope per window", so the same window sent twice
 * replaces rather than duplicating. `on conflict do update` rather than delete-then-insert, because
 * `budget_windows` cascades from `budgets` and a delete would throw away the spend already recorded
 * for the current window — an operator raising a cap must not reset the meter.
 *
 * **A null limit removes the cap.** That deletes the `budgets` row and, through the cascade, its
 * `budget_windows` projection; the spend itself is untouched, because the ledger's truth is
 * `cost_entries` and the window rows are a rebuildable projection over it (technical/03).
 *
 * It does **not** take a transaction handle. The route writes one budget and one `human_actions`
 * row, and the audit row is written by the route's shared command helper after this returns — the
 * same shape every other command in `routes/commands.ts` uses.
 */
export const writeBudget = async (
  database: Database,
  input: {
    readonly scope: 'org' | 'project';
    /** `null` for the organisation scope, which has exactly one subject. */
    readonly scopeId: string | null;
    readonly window: 'day' | 'week' | 'month' | 'total';
    readonly limitUsd: number | null;
    readonly notifyPct?: readonly number[];
    readonly createdBy: string | null;
  },
): Promise<WriteBudgetResult> => {
  const matches = and(
    eq(budgets.scope, input.scope),
    input.scopeId === null ? isNull(budgets.scopeId) : eq(budgets.scopeId, input.scopeId),
    eq(budgets.window, input.window),
  );
  if (input.limitUsd === null) {
    const removed = await database
      .delete(budgets)
      .where(matches)
      .returning({ id: budgets.id, limitUsd: budgets.limitUsd });
    const row = removed[0];
    return row === undefined
      ? { outcome: 'absent', id: null, previousLimitUsd: null }
      : { outcome: 'removed', id: row.id, previousLimitUsd: usd(row.limitUsd) };
  }

  const existing = await database
    .select({ id: budgets.id, limitUsd: budgets.limitUsd })
    .from(budgets)
    .where(matches)
    .limit(1);
  const rows = await database
    .insert(budgets)
    .values({
      scope: input.scope,
      scopeId: input.scopeId,
      window: input.window,
      limitUsd: input.limitUsd.toFixed(6),
      ...(input.notifyPct === undefined ? {} : { notifyPct: [...input.notifyPct] }),
      createdBy: input.createdBy,
    })
    .onConflictDoUpdate({
      target: [budgets.scope, budgets.scopeId, budgets.window],
      set: {
        limitUsd: input.limitUsd.toFixed(6),
        ...(input.notifyPct === undefined ? {} : { notifyPct: [...input.notifyPct] }),
        updatedAt: new Date(),
      },
    })
    .returning({ id: budgets.id });
  const id = rows[0]?.id ?? null;
  const previous = existing[0];
  return {
    outcome: previous === undefined ? 'created' : 'updated',
    id,
    // What the cap was, for the audit row: product/18:5 asks what **changed**, not only that
    // something did, and `outcome` alone cannot say what a raise was raised from.
    previousLimitUsd: previous === undefined ? null : usd(previous.limitUsd),
  };
};

/**
 * `GET /api/org/budgets` — the organisation's own caps, with the spend of the current window.
 *
 * The project read answers "every budget that applies to this project", which includes the
 * organisation's; this answers "the organisation's", which is the set the org settings screen edits.
 * The difference is the predicate and where the timezone comes from — the window arithmetic is
 * literally {@link budgetsWithSpend}, shared rather than repeated (review round 2). The
 * organisation's zone is the one the ledger charges in (Q12), and a zone `budgetWindowStart` would
 * refuse is substituted rather than thrown, for the reason `findProjectTimezone` states.
 */
export const listOrgBudgets = async (
  database: Database,
  at: IsoDateTime,
): Promise<readonly BudgetRecord[]> => {
  const zone = await database
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .limit(1);
  const { timezone } = resolveBudgetTimezone(zone[0]?.timezone ?? null);
  return budgetsWithSpend(database, eq(budgets.scope, 'org'), at, timezone);
};
