/**
 * The reads behind `GET /api/projects` and `GET /api/projects/:id/readiness` (WP-15h part 2).
 *
 * Projections onto the published DTOs, like `pipeline-queries.ts` beside them, and with the same
 * rule about a column nothing writes.
 *
 * ## `readiness_evaluations` has a writer since WP-21, and the refusal is now the *absence* of a run
 *
 * `readinessResponseSchema` publishes a level, the instant it was evaluated and the **criteria** —
 * what passed, the evidence and what it unlocks. Only `readiness_evaluations` (migration 0008) can
 * hold those, and until WP-21 **nothing in this repository inserted into it**, so this read answered
 * `409 readiness_not_evaluated` with the row count for every project. `PostgresReadinessStore` is
 * that writer now: the `onboarding.discovery` job records an evaluation when a Discovery agent's
 * draft is stored, and {@link findProjectReadiness} answers `recorded: true` from the newest row.
 *
 * **The 409 did not disappear — its meaning narrowed**, and that is deliberate. A project whose
 * discovery has not run yet still has no evaluation, and the alternatives are both worse:
 * `projects.readiness_level` is `not null default 0`, so a projection *could* answer
 * `{level: 0, evaluated_at: now, criteria: []}` — and two of those three would be invented
 * (`evaluated_at` would be the time of the *read*, and an empty criteria list renders as "nothing
 * passed", which is a claim about the project). The row count stays in the message so an operator
 * can still tell "nothing has evaluated this project" from "this reader cannot read what is there".
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
import type {
  AutonomyLevel,
  AutonomyPolicies,
  AutonomyResponse,
  Id,
  IsoDateTime,
  PoliciesConfig,
  ProjectAuditResponse,
  ProjectSummary,
  ProjectsResponse,
  ReadinessResponse,
} from '@platform/contracts';
import {
  autonomyResponseSchema,
  materialisedAutonomySchema,
  projectAuditResponseSchema,
  readinessResponseSchema,
} from '@platform/contracts';
import {
  AUTONOMY_PRESET_VERSION,
  applyAutonomyPreset,
  autonomyOverridesFromConfig,
  autonomyRank,
  describePresetOverrides,
  effectiveAutonomyPreset,
  findReadinessCriterion,
  fromWireAutonomyPolicies,
  nextReadinessImprovements,
  suggestedAutonomyCap,
  toWireAutonomyPolicies,
} from '@platform/domain';
import { db as dbAdapters } from '@platform/infrastructure';
import { and, asc, desc, eq, gte, inArray, notInArray, sql } from 'drizzle-orm';
import { CLOSED_TASK_STATES } from './pipeline-queries.js';

const {
  costRollupDaily,
  humanActions,
  organizations,
  projects,
  readinessEvaluations,
  tasks,
  users,
} = dbAdapters.schema;

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
  /** The project exists and nothing has evaluated it; `rows` is how many evaluations it has. */
  | { readonly found: true; readonly recorded: false; readonly rows: number }
  | { readonly found: true; readonly recorded: true; readonly response: ReadinessResponse };

/**
 * `GET /api/projects/:id/readiness` — the newest evaluation, or the reason there is none.
 *
 * **`unlocks` and `title` come from `READINESS_CRITERIA`, not from the row.** The stored criterion
 * carries the platform's text already (`PostgresReadinessStore` writes it), and this read prefers
 * the table's current wording over the copy: a release that improves what a criterion says it
 * unlocks should improve it everywhere, and the value proposition is platform prose that no model
 * ever wrote. `evidence` is the opposite — it is the Discovery agent's own words for eleven of the
 * fourteen criteria (BD-022) — so it is served exactly as stored and rendered as text.
 *
 * A criterion in the row that the current table does not have (a release that dropped one) is
 * **dropped** rather than served with an invented `unlocks`; a criterion the table has and the row
 * does not is **not** invented either, because a criterion nobody evaluated is not a criterion that
 * failed. The level is the stored one: it is what the evaluator decided from the criteria it had.
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
    .select({
      id: readinessEvaluations.id,
      level: readinessEvaluations.level,
      criteria: readinessEvaluations.criteria,
      evaluatedAt: readinessEvaluations.evaluatedAt,
      source: readinessEvaluations.source,
    })
    .from(readinessEvaluations)
    .where(eq(readinessEvaluations.projectId, projectId))
    .orderBy(desc(readinessEvaluations.evaluatedAt), desc(readinessEvaluations.id));
  const newest = rows[0];
  if (newest === undefined) {
    return { found: true, recorded: false, rows: 0 };
  }

  const stored = Array.isArray(newest.criteria) ? newest.criteria : [];
  const criteria: ReadinessResponse['criteria'] = [];
  const passed = new Set<string>();
  for (const entry of stored) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const criterion = typeof record.id === 'string' ? findReadinessCriterion(record.id) : undefined;
    if (criterion === undefined || typeof record.passed !== 'boolean') continue;
    criteria.push({
      id: criterion.id,
      passed: record.passed,
      evidence: typeof record.evidence === 'string' ? record.evidence : '',
      unlocks: criterion.unlocks,
      detected_by: criterion.detectedBy,
    });
    if (record.passed) {
      passed.add(criterion.id);
    }
  }

  return {
    found: true,
    recorded: true,
    response: readinessResponseSchema.parse({
      level: Number(newest.level),
      evaluated_at: newest.evaluatedAt.toISOString(),
      source: newest.source,
      criteria,
      // product/17 § "Onboarding wizard": "the initial level and the three cheapest criteria to
      // improve next". Derived here rather than stored, so a release that reorders the ladder
      // changes the advice without a re-evaluation.
      next_improvements: nextReadinessImprovements(passed).map((criterion) => ({
        id: criterion.id,
        title: criterion.title,
        unlocks: criterion.unlocks,
      })),
    }),
  };
};

/**
 * `GET /api/projects/:id/autonomy` — the dial as it is actually in force (WP-30, BD-027).
 *
 * Four columns and one derivation, and the derivation is the point of the endpoint: *Custom* is
 * `describePresetOverrides(<the materialised preset>, <the effective preset>)` — measured against
 * the copy the project was given and never against this release's table, which is BD-027:14's whole
 * consequence. A project whose dial was never materialised answers `materialised: false` with this
 * release's preset for its level, **marked as such**, rather than pretending it has one.
 */
export const findProjectAutonomy = async (
  database: Database,
  projectId: string,
): Promise<AutonomyResponse | null> => {
  const rows = await database
    .select({
      level: projects.autonomyLevel,
      policies: projects.autonomyPolicies,
      readinessLevel: projects.readinessLevel,
      config: projects.config,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : autonomyResponseFrom(row);
};

/** The four columns {@link autonomyResponseFrom} reads, as the row shape it is given. */
export interface AutonomyRow {
  readonly level: AutonomyLevel;
  /** `projects.autonomy_policies` as stored — **unparsed**, because it is state from a past release. */
  readonly policies: unknown;
  readonly readinessLevel: number;
  readonly config: unknown;
}

/**
 * The dial's projection, as a pure function of the row — WP-30, BD-027.
 *
 * Separated from the query because everything interesting about it is a **decision**, and a decision
 * reached only through a database is a decision asserted once, slowly. Three of them:
 *
 * - *Custom* is `describePresetOverrides(<the materialised preset>, <the effective preset>)` —
 *   measured against the copy the project was given and never against this release's table, which is
 *   BD-027:14's whole consequence. A reader that compared against the level would relabel every
 *   project *Custom* the day a release edits a preset, without a policy having moved.
 * - A project whose dial was never materialised answers `materialised: false` with this release's
 *   preset for its level, **marked as such** — never silently, which is standing rule 16.
 * - `preset_outdated` is two questions, not one: the stored version may be behind *or* the stored
 *   values may differ from what this release ships under the same version number. A release that
 *   edited a preset and forgot to bump is a mistake the UI should still be able to show.
 */
export const autonomyResponseFrom = (row: AutonomyRow): AutonomyResponse => {
  // Parsed, never cast: the column is stored state and a document that does not match the current
  // schema is read as "not materialised" rather than as whatever happens to be in it.
  const stored = materialisedAutonomySchema.safeParse(row.policies);
  const materialised = stored.success ? stored.data : null;
  const baseline =
    materialised === null
      ? applyAutonomyPreset(row.level)
      : fromWireAutonomyPolicies(materialised.policies);
  const configPolicies = (row.config as { policies?: PoliciesConfig } | null)?.policies;
  const effective =
    materialised === null
      ? { ...baseline, ...autonomyOverridesFromConfig(configPolicies) }
      : effectiveAutonomyPreset(materialised, configPolicies);
  const overrides = describePresetOverrides(baseline, effective);
  const level = materialised?.level ?? row.level;
  const suggestedCap = suggestedAutonomyCap(row.readinessLevel);

  return autonomyResponseSchema.parse({
    level,
    materialised: materialised !== null,
    preset_version: materialised?.preset_version ?? AUTONOMY_PRESET_VERSION,
    current_preset_version: AUTONOMY_PRESET_VERSION,
    preset_outdated:
      materialised !== null &&
      (materialised.preset_version !== AUTONOMY_PRESET_VERSION ||
        !samePolicies(
          materialised.policies,
          toWireAutonomyPolicies(applyAutonomyPreset(materialised.level)),
        )),
    applied_at: materialised?.applied_at ?? null,
    applied_by: materialised?.applied_by ?? null,
    policies: toWireAutonomyPolicies(effective),
    is_custom: overrides.length > 0,
    overrides: overrides.map((override) => ({
      policy: override.policy,
      preset: override.preset ?? null,
      effective: override.effective ?? null,
    })),
    readiness_level: row.readinessLevel,
    suggested_cap: suggestedCap,
    // A *statement*, never a refusal: readiness caps the suggestion and the maintainer overrides it
    // visibly (product/18, Q21). The screen renders this as a note beside the chosen position.
    above_suggested_cap: autonomyRank(level) > autonomyRank(suggestedCap),
  });
};

/** Value equality over the fifteen policy fields; `JSON.stringify` would depend on key order. */
const samePolicies = (left: AutonomyPolicies, right: AutonomyPolicies): boolean =>
  (Object.keys(left) as (keyof AutonomyPolicies)[]).every((key) => left[key] === right[key]);

/**
 * `GET /api/projects/:id/audit` — the settings changes made on this project (PROGRESS backlog 52).
 *
 * `human_actions` has no `project_id` column: the wizard's commands put it in `params`, which is
 * where every reader of the table was always going to look (the insert's own docblock says so). So
 * the predicate is `params->>'project_id'`, and the scope it produces is honest — the **project's
 * settings**, not every action ever taken on its tasks, which name a task instead.
 *
 * Newest first and bounded by the caller: this is a page on a settings screen, not an export.
 */
export const listProjectAudit = async (
  database: Database,
  projectId: string,
  limit: number,
): Promise<ProjectAuditResponse> => {
  const rows = await database
    .select({
      id: humanActions.id,
      action: humanActions.action,
      userId: humanActions.userId,
      email: users.email,
      params: humanActions.params,
      createdAt: humanActions.createdAt,
    })
    .from(humanActions)
    .leftJoin(users, eq(users.id, humanActions.userId))
    .where(sql`${humanActions.params} ->> 'project_id' = ${projectId}`)
    .orderBy(desc(humanActions.createdAt))
    .limit(limit);
  return projectAuditResponseSchema.parse({
    items: rows.map((row) => ({
      id: row.id,
      action: row.action,
      user_id: row.userId,
      // `null` when the account was deleted (`on delete set null`) — never a placeholder name.
      user_email: row.email ?? null,
      params: row.params,
      created_at: row.createdAt.toISOString(),
    })),
  });
};
