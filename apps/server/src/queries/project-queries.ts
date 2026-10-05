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
import type { AutonomyOverrideSource } from '@platform/domain';
import {
  AUTONOMY_PRESET_VERSION,
  applyAutonomyPreset,
  autonomyOverridesFromConfig,
  autonomyRank,
  capAutonomy,
  capMaterialisedAutonomy,
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
import * as z from 'zod';
import { organisationSettingsForRequest } from '../config-layers.js';
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
 * fourteen criteria (BD-022) — so it is served exactly as stored and rendered as text. `detected_by`
 * is the row's (who answered it), floored at the table's `platform` for R9, R11 and R12.
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
      notices: readinessEvaluations.notices,
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
  const notChecked = new Set<string>();
  for (const entry of stored) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const criterion = typeof record.id === 'string' ? findReadinessCriterion(record.id) : undefined;
    if (criterion === undefined || typeof record.passed !== 'boolean') continue;
    // BD-026's 2026-10-06 amendment: the store's reading — a literal `true` beside `passed: false`.
    const notCheckedHere = record.not_checked === true && !record.passed;
    criteria.push({
      id: criterion.id,
      passed: record.passed,
      evidence: typeof record.evidence === 'string' ? record.evidence : '',
      unlocks: criterion.unlocks,
      // Who answered **this** row (WP-64): the stored value, which only the platform writes — a
      // re-check answers R8 and an observed R3 itself — and never `agent` for a criterion the
      // table says the platform answers.
      detected_by:
        criterion.detectedBy === 'platform' || record.detected_by === 'platform'
          ? 'platform'
          : 'agent',
      not_checked: notCheckedHere,
    });
    if (record.passed) {
      passed.add(criterion.id);
    }
    if (notCheckedHere) {
      notChecked.add(criterion.id);
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
      // A not-checked criterion is not an improvement (BD-026's 2026-10-06 amendment).
      next_improvements: nextReadinessImprovements(passed, 3, notChecked).map((criterion) => ({
        id: criterion.id,
        title: criterion.title,
        unlocks: criterion.unlocks,
      })),
      // WP-143: the platform's own notices, as stored; a shape this build does not know is dropped.
      notices: noticesOf(newest.notices),
    }),
  };
};

/** One stored notice, or `null` for an entry this build does not know (it is dropped, WP-143). */
const storedNoticeSchema = readinessResponseSchema.shape.notices
  .unwrap()
  .element.or(z.unknown().transform(() => null));

/** The stored `notices` column, as published: a malformed or unknown entry is dropped (WP-143). */
const noticesOf = (raw: unknown): ReadinessResponse['notices'] =>
  storedNoticeSchema
    .array()
    .catch([])
    .parse(raw)
    .filter((entry): entry is ReadinessResponse['notices'][number] => entry !== null);

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
      orgSettings: organizations.settings,
    })
    .from(projects)
    .innerJoin(organizations, eq(organizations.id, projects.orgId))
    .where(eq(projects.id, projectId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  // WP-93: the organisation's maximum, parsed — a document that does not parse is the 409 every
  // route answers it with, never a dial published as though no maximum existed.
  const { orgSettings, ...columns } = row;
  return autonomyResponseFrom({
    ...columns,
    organisationMaximum: organisationSettingsForRequest(orgSettings).autonomy?.maximum ?? null,
  });
};

/** The four columns {@link autonomyResponseFrom} reads, as the row shape it is given. */
export interface AutonomyRow {
  readonly level: AutonomyLevel;
  /** `projects.autonomy_policies` as stored — **unparsed**, because it is state from a past release. */
  readonly policies: unknown;
  readonly readinessLevel: number;
  readonly config: unknown;
  /** The organisation's `autonomy.maximum` (WP-93), or `null` when it states none. */
  readonly organisationMaximum?: AutonomyLevel | null;
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
  const chosen = stored.success ? stored.data : null;
  const organisationMaximum = row.organisationMaximum ?? null;
  // WP-93: what is **in force** is the dial capped at the organisation's maximum — the settings
  // port's `cappedAutonomy`, so the screen and the pipeline read one answer. `level` below stays
  // the project's own choice, and `level_in_force` says what runs.
  const materialised =
    chosen === null ? null : capMaterialisedAutonomy(chosen, organisationMaximum ?? undefined);
  const level = chosen?.level ?? row.level;
  const levelInForce = capAutonomy(level, organisationMaximum ?? 'autonomous');
  const baseline =
    materialised === null
      ? applyAutonomyPreset(levelInForce)
      : fromWireAutonomyPolicies(materialised.policies);
  // The whole document, not only `policies`: since WP-62 two of the four override keys live under
  // `pipeline.limits` (Q78, `AUTONOMY_POLICY_OVERRIDE_KEYS`).
  const config = (row.config ?? undefined) as AutonomyOverrideSource | undefined;
  const effective =
    materialised === null
      ? { ...baseline, ...autonomyOverridesFromConfig(config) }
      : effectiveAutonomyPreset(materialised, config);
  const overrides = describePresetOverrides(baseline, effective);
  const suggestedCap = suggestedAutonomyCap(row.readinessLevel);

  return autonomyResponseSchema.parse({
    level,
    materialised: materialised !== null,
    preset_version: chosen?.preset_version ?? AUTONOMY_PRESET_VERSION,
    current_preset_version: AUTONOMY_PRESET_VERSION,
    preset_outdated:
      chosen !== null &&
      (chosen.preset_version !== AUTONOMY_PRESET_VERSION ||
        !samePolicies(chosen.policies, toWireAutonomyPolicies(applyAutonomyPreset(chosen.level)))),
    applied_at: chosen?.applied_at ?? null,
    applied_by: chosen?.applied_by ?? null,
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
    organisation_maximum: organisationMaximum,
    level_in_force: levelInForce,
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
 *
 * **Indexed** (migration 0071, WP-115, PROGRESS backlog 312): `human_actions_project_idx` is
 * `(params->>'project_id', created_at desc)`, partial on rows that carry the key, so this is one
 * index range of the project's rows stopped by the limit — 53 buffers and 0.04 ms at 10^6 rows,
 * where it was a sequential scan of the whole installation's audit (16 700 buffers, 26 ms).
 * `test/integration/db/payload-lookup-indexes.integration.test.ts` holds the planner to it.
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

/** The `human_actions.action` a configuration export records (`routes/project-config.ts`). */
const CONFIG_EXPORT_ACTION_NAME = 'project.config.export';

/** A recorded export's params, parsed rather than cast: the row is stored state (rule 16). */
const recordedExportParamsSchema = z.object({
  status: z.enum(['exported', 'unchanged', 'open']),
  config_hash: z.string().min(1),
  branch: z.string().min(1).nullable().optional(),
  merge_request_url: z.string().min(1).nullable().optional(),
  merge_request_iid: z.int().positive().nullable().optional(),
});

/**
 * The project's newest recorded configuration export (WP-91, PROGRESS backlog 225), or `null`.
 *
 * `human_actions` has no `project_id` column, so the predicate is `params->>'project_id'` —
 * `listProjectAudit`'s, above, for the same reason. A row whose params do not parse is **skipped
 * to the next** rather than read as "never exported": an older release's row that lacks a field is
 * not evidence that no export happened, and the newest row that does parse is. The scan is bounded.
 * It reads `listProjectAudit`'s index (migration 0071) and filters the action on the project's rows
 * newest first: 62 buffers and 0.03 ms at 10^6 rows (a project with 1 200 settings rows), where it
 * was a sequential scan of the installation (16 700 buffers, 22 ms) — PROGRESS backlog 312. Its
 * bound is the project's own settings rows, not the installation: a project that never exported
 * walks all of them (1 011 buffers, 0.2 ms for 1 000 rows).
 */
export const findLastConfigExport = async (
  database: Database,
  projectId: string,
): Promise<{
  readonly status: 'exported' | 'unchanged' | 'open';
  readonly configHash: string;
  readonly branch: string | null;
  readonly mergeRequestUrl: string | null;
  readonly mergeRequestIid: number | null;
  readonly exportedAt: string;
} | null> => {
  const rows = await database
    .select({ params: humanActions.params, createdAt: humanActions.createdAt })
    .from(humanActions)
    .where(
      and(
        eq(humanActions.action, CONFIG_EXPORT_ACTION_NAME),
        sql`${humanActions.params} ->> 'project_id' = ${projectId}`,
      ),
    )
    .orderBy(desc(humanActions.createdAt))
    .limit(10);
  for (const row of rows) {
    const parsed = recordedExportParamsSchema.safeParse(row.params);
    if (!parsed.success) continue;
    return {
      status: parsed.data.status,
      configHash: parsed.data.config_hash,
      branch: parsed.data.branch ?? null,
      mergeRequestUrl: parsed.data.merge_request_url ?? null,
      mergeRequestIid: parsed.data.merge_request_iid ?? null,
      exportedAt: row.createdAt.toISOString(),
    };
  }
  return null;
};

/**
 * How many of this project's knowledge curations wait on its stored settings — curations the
 * settings refused (`knowledge_curations.settings_refused_at`) that nothing has curated or given up
 * on since (WP-125, PROGRESS backlog 356). What `GET …/config`'s `409 invalid_stored_config` names,
 * so the refusal an operator reads says what else waits on the fix: the recovery pass re-offers each
 * of them at its interval until the document parses. Served by the partial index migration 0076
 * made for it.
 */
export const countCurationsWaitingOnSettings = async (
  database: Database,
  projectId: string,
): Promise<number> => {
  const { rows } = await database.execute<{ waiting: number }>(sql`
    select count(*)::int as waiting
      from knowledge_curations c
      join artifacts a on a.id = c.artifact_id
      join tasks t on t.id = a.task_id
     where t.project_id = ${projectId}
       and c.settings_refused_at is not null
       and c.curated_at is null
       and c.abandoned_at is null`);
  return Number(rows[0]?.waiting ?? 0);
};
