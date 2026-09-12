/**
 * The read behind `GET /api/projects/:project_id/budgets` (technical/08, WP-19).
 *
 * A projection onto the published DTO, like `pipeline-queries.ts`: the route's response schema
 * re-validates the shape on the way out, and `packages/application`'s `CostStore` is the *write*
 * side — it takes a transaction handle because the ledger's four writes have to commit together,
 * which a read route neither has nor wants.
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
import { and, eq, inArray, or } from 'drizzle-orm';

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
    .where(
      or(
        eq(budgets.scope, 'org'),
        and(eq(budgets.scope, 'project'), eq(budgets.scopeId, projectId)),
      ),
    );
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
