/**
 * An approval as the task and inbox reads publish it: the record, **its subject and its reasons**
 * (TD-035 decision 4, BD-006's 2026-11-06 amendment). One function for both reads, so the page that
 * decides and the list that points at it name the same plan.
 *
 * ## What it answers, and what it refuses to invent
 *
 * - **Recorded** (migration 0103 on): the plan gate's `subject_artifact_id`, with the version read
 *   through it (artifacts are written once), and the budget gate's `subject_detail` snapshot. The
 *   reasons are the stored list.
 * - **Derived** — a plan approval written before 0103 — only through TD-035 decision 5's one exact
 *   chain: `artifacts.produced_by_run_id → runs.task_stage_id → task_stages(task, stage, attempt)`
 *   of the approval, with **exactly one** `ImplementationPlan` at its end, labelled `basis:
 *   'derived'`. The decide command asks the same question of the store
 *   (`ApprovalRepository.planSubject`), and `test/integration/server/approval-subject.integration.test.ts`
 *   holds the two to one answer.
 * - **Anything else is `null`** — *not recorded* — and the UI says so. Never "the task's latest
 *   plan": that approves whatever is newest rather than what was asked about, which is the
 *   owner's exact complaint. Reasons are **never** derived: the policy may have changed since.
 *
 * A stored `subject_detail` or `reasons` value outside the vocabulary is **refused** (the parse
 * throws, a 500), never defaulted: only this build's gates write those columns, through the same
 * strict schemas.
 */
import {
  type ApprovalSubject,
  type ApprovalView,
  approvalReasonsSchema,
  budgetApprovalSubjectDetailSchema,
  type Id,
} from '@platform/contracts';
import { db as dbAdapters } from '@platform/infrastructure';
import { and, eq, inArray } from 'drizzle-orm';

const { approvals, artifacts, runs, taskStages } = dbAdapters.schema;

type Database = dbAdapters.Database;
/** One `approvals` row as Drizzle reads it. */
export type ApprovalRow = typeof approvals.$inferSelect;

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

/** The key a derived plan is found under: the stage attempt that asked. */
const attemptKey = (taskId: string, stage: string, attempt: number): string =>
  `${taskId}\0${stage}\0${attempt}`;

/** A recorded plan's version, read through its id. */
export interface RecordedPlanRow {
  readonly id: string;
  readonly version: number;
}

/** A plan at the end of TD-035 decision 5's chain, with the stage attempt it was produced at. */
export interface ChainedPlanRow {
  readonly id: string;
  readonly version: number;
  readonly taskId: string;
  readonly stage: string;
  readonly attempt: number;
}

/** Every approval row, as the reads publish it, in the order given. */
export const approvalViewsFor = async (
  database: Database,
  rows: readonly ApprovalRow[],
): Promise<ApprovalView[]> => {
  const recordedIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.kind === 'plan' && row.subjectArtifactId !== null ? [row.subjectArtifactId] : [],
      ),
    ),
  ];
  // A plan approval with no recorded subject and a stage attempt to follow the chain from.
  const derivableTasks = [
    ...new Set(
      rows
        .filter(
          (row) =>
            row.kind === 'plan' &&
            row.subjectArtifactId === null &&
            row.stage !== null &&
            row.attempt !== null,
        )
        .map((row) => row.taskId),
    ),
  ];

  const [recorded, chained] = await Promise.all([
    recordedIds.length === 0
      ? Promise.resolve([])
      : database
          .select({ id: artifacts.id, version: artifacts.version })
          .from(artifacts)
          .where(inArray(artifacts.id, recordedIds)),
    derivableTasks.length === 0
      ? Promise.resolve([])
      : database
          .select({
            id: artifacts.id,
            version: artifacts.version,
            taskId: taskStages.taskId,
            stage: taskStages.stage,
            attempt: taskStages.attempt,
          })
          .from(artifacts)
          .innerJoin(runs, eq(runs.id, artifacts.producedByRunId))
          .innerJoin(taskStages, eq(taskStages.id, runs.taskStageId))
          .where(
            and(
              inArray(artifacts.taskId, derivableTasks),
              eq(artifacts.type, 'ImplementationPlan'),
              eq(taskStages.taskId, artifacts.taskId),
            ),
          ),
  ]);
  return assembleApprovalViews(rows, recorded, chained);
};

/**
 * The decision half of {@link approvalViewsFor}, over rows already read — pure, so every branch of
 * "recorded, derived or not recorded" is a unit case (`approval-views.test.ts`) and the SQL that
 * feeds it is the integration tier's.
 */
export const assembleApprovalViews = (
  rows: readonly ApprovalRow[],
  recorded: readonly RecordedPlanRow[],
  chained: readonly ChainedPlanRow[],
): ApprovalView[] => {
  const versionOf = new Map(recorded.map((row) => [row.id, row.version]));
  const plansAt = new Map<string, RecordedPlanRow[]>();
  for (const row of chained) {
    const key = attemptKey(row.taskId, row.stage, row.attempt);
    plansAt.set(key, [...(plansAt.get(key) ?? []), { id: row.id, version: row.version }]);
  }

  const subjectOf = (row: ApprovalRow): ApprovalSubject | null => {
    if (row.kind === 'budget') {
      return row.subjectDetail === null
        ? null
        : { kind: 'budget', ...budgetApprovalSubjectDetailSchema.parse(row.subjectDetail) };
    }
    if (row.kind !== 'plan' || row.stage === null || row.attempt === null) {
      return null;
    }
    if (row.subjectArtifactId !== null) {
      const version = versionOf.get(row.subjectArtifactId);
      // The foreign key sets the column null when the artifact goes, so a miss here is a row read
      // between two statements of a delete — not recorded, rather than a version invented.
      return version === undefined
        ? null
        : {
            kind: 'plan',
            artifact_id: row.subjectArtifactId as Id,
            artifact_version: version,
            stage: row.stage,
            attempt: row.attempt,
            basis: 'recorded',
          };
    }
    const found = plansAt.get(attemptKey(row.taskId, row.stage, row.attempt)) ?? [];
    const [only] = found;
    // Exactly one, or nothing: two plans from one attempt is a chain that does not pin one.
    return found.length !== 1 || only === undefined
      ? null
      : {
          kind: 'plan',
          artifact_id: only.id as Id,
          artifact_version: only.version,
          stage: row.stage,
          attempt: row.attempt,
          basis: 'derived',
        };
  };

  return rows.map((row) => ({
    id: row.id as Id,
    task_id: row.taskId as Id,
    kind: row.kind,
    status: row.status,
    requested_at: iso(row.requestedAt) as string,
    deadline_at: iso(row.deadlineAt),
    decided_by_user_id: row.decidedByUserId as Id | null,
    decided_at: iso(row.decidedAt),
    reason: row.reason,
    subject: subjectOf(row),
    reasons: row.reasons === null ? null : approvalReasonsSchema.parse(row.reasons),
  }));
};
