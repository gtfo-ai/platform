/**
 * The reads behind `GET /api/projects` and `GET /api/projects/:id/readiness` (WP-15h part 2).
 *
 * Projections onto the published DTOs, like `pipeline-queries.ts` beside them, and with the same
 * rule about a column nothing writes.
 *
 * ## `readiness_evaluations` has no writer, so the endpoint refuses by name
 *
 * `readinessResponseSchema` publishes a level, the instant it was evaluated and the **criteria** —
 * "what passed, what it unlocks, and the evidence". Only `readiness_evaluations` (migration 0008)
 * could hold that, and **nothing in this repository inserts into it**: BD-027's readiness ladder is
 * its own work package. `projects.readiness_level` exists and is `not null default 0`, so a
 * projection *could* answer `{level: 0, evaluated_at: now, criteria: []}` — and every part of that
 * after the level would be invented. `evaluated_at` would be the time of the read rather than of an
 * evaluation, and an empty `criteria` list renders as "nothing passed", which is a claim about the
 * project rather than about the schema. {@link findProjectReadiness} therefore reports the row count
 * and the route refuses, which is the precedent `findRunContextPack` set at part 1.
 *
 * ## `spent_usd_30d` is the rollup, not the ledger
 *
 * `cost_rollup_daily` is keyed by a **calendar day in the organisation's timezone** (WP-19, Q12), so
 * the thirty days are counted in that calendar too: the arithmetic is on the `YYYY-MM-DD` key, never
 * on an instant minus 30 × 86 400 000 ms, which is off by an hour twice a year and can move the
 * boundary by a day. Summing the rollup rather than `cost_entries` is deliberate and is what the
 * rollup is for — it is the projection WP-19 keeps reconciled with the entries.
 */
import { rollupDay } from '@platform/application';
import type { Id, IsoDateTime, ProjectSummary, ProjectsResponse } from '@platform/contracts';
import { db as dbAdapters } from '@platform/infrastructure';
import { and, asc, eq, gte, inArray, notInArray, sql } from 'drizzle-orm';
import { CLOSED_TASK_STATES } from './pipeline-queries.js';

const { costRollupDaily, organizations, projects, readinessEvaluations, tasks } = dbAdapters.schema;

export type Database = dbAdapters.Database;

/** How many days of the rollup `ProjectSummary.spent_usd_30d` covers, today included. */
export const SPEND_WINDOW_DAYS = 30;

/** `YYYY-MM-DD` minus `days`, in the calendar the key is written in — no timezone involved. */
export const dayMinus = (day: string, days: number): string => {
  const at = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(at)) {
    throw new TypeError(`expected a YYYY-MM-DD rollup key, got "${day}"`);
  }
  return new Date(at - days * 86_400_000).toISOString().slice(0, 10);
};

/**
 * `GET /api/projects` — every project, with its open work and its recent spend.
 *
 * Unscoped by organisation, which is what every other organisation-wide read in this server does
 * (`listUsers`, `listAuditEntries`): the platform is a single-organisation self-hosted deployment
 * (product/01), `organizations` has one row, and inventing a filter on a column no route has ever
 * filtered on would make this endpoint the only one with an opinion about it. Written up in
 * `PROGRESS.md` as the assumption it is.
 */
export const listProjectSummaries = async (
  database: Database,
  at: IsoDateTime,
): Promise<ProjectsResponse> => {
  const rows = await database
    .select({
      id: projects.id,
      key: projects.key,
      name: projects.name,
      repoUrl: projects.repoUrl,
      defaultBranch: projects.defaultBranch,
      agenticDir: projects.agenticDir,
      knowledgeDir: projects.knowledgeDir,
      autonomyLevel: projects.autonomyLevel,
      readinessLevel: projects.readinessLevel,
      status: projects.status,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
      timezone: organizations.timezone,
    })
    .from(projects)
    .innerJoin(organizations, eq(organizations.id, projects.orgId))
    .orderBy(asc(projects.key));
  if (rows.length === 0) {
    return { items: [] };
  }

  const ids = rows.map((row) => row.id);
  const openRows = await database
    .select({ projectId: tasks.projectId, open: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(inArray(tasks.projectId, ids), notInArray(tasks.state, [...CLOSED_TASK_STATES])))
    .groupBy(tasks.projectId);
  const open = new Map(openRows.map((row) => [row.projectId, row.open]));

  // One query for every project, then summed per project against **that project's** cutoff: two
  // organisations in different zones would have cutoffs a day apart, so the widest one is fetched
  // and the narrowing happens per row rather than in the `where`.
  const cutoffs = new Map(
    rows.map(
      (row) => [row.id, dayMinus(rollupDay(at, row.timezone), SPEND_WINDOW_DAYS - 1)] as const,
    ),
  );
  const earliest = [...cutoffs.values()].sort()[0] ?? dayMinus(rollupDay(at, 'UTC'), 0);
  const spendRows = await database
    .select({
      projectId: costRollupDaily.projectId,
      day: costRollupDaily.day,
      usd: costRollupDaily.usd,
    })
    .from(costRollupDaily)
    .where(and(inArray(costRollupDaily.projectId, ids), gte(costRollupDaily.day, earliest)));
  const spent = new Map<string, number>();
  for (const row of spendRows) {
    if (row.day < (cutoffs.get(row.projectId) ?? earliest)) {
      continue;
    }
    spent.set(row.projectId, (spent.get(row.projectId) ?? 0) + Number(row.usd));
  }

  const items: ProjectSummary[] = rows.map((row) => ({
    id: row.id as Id,
    key: row.key,
    name: row.name,
    repo_url: row.repoUrl,
    default_branch: row.defaultBranch,
    agentic_dir: row.agenticDir,
    knowledge_dir: row.knowledgeDir,
    autonomy_level: row.autonomyLevel,
    readiness_level: row.readinessLevel,
    status: row.status,
    created_at: row.createdAt.toISOString() as IsoDateTime,
    updated_at: row.updatedAt.toISOString() as IsoDateTime,
    // A project with no task and a project with no charged day are both zero, and both are facts:
    // the ledger inserts a rollup row on the first charge (WP-19).
    open_tasks: open.get(row.id) ?? 0,
    spent_usd_30d: spent.get(row.id) ?? 0,
  }));
  return { items };
};

export type ProjectReadiness =
  | { readonly found: false }
  /** The project exists; `rows` is how many evaluations it has (`0` while nothing writes them). */
  | { readonly found: true; readonly recorded: false; readonly rows: number };

/**
 * `GET /api/projects/:id/readiness` — and, like the context pack, it has **no success branch**.
 *
 * The row count goes with the refusal so the two states are distinguishable: `0` is "no producer
 * yet", anything else is "a producer exists and this reader was never written for it". Giving this
 * endpoint an answer is the readiness evaluator (BD-027), not a reader.
 */
export const findProjectReadiness = async (
  database: Database,
  projectId: string,
): Promise<ProjectReadiness> => {
  const exists = await database
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (exists.length === 0) {
    return { found: false };
  }
  const rows = await database
    .select({ id: readinessEvaluations.id })
    .from(readinessEvaluations)
    .where(eq(readinessEvaluations.projectId, projectId));
  return { found: true, recorded: false, rows: rows.length };
};
