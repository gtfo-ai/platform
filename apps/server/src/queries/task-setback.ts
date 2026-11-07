/**
 * **A task that went back, and a task that stopped** (S-25.11, product/10's Task detail amendment of
 * 2026-11-07): the task read's `returns`/`latest_return` and `stop`, projected off the `task_stages`
 * rows the pipeline already writes. Pure, so every branch is unit-tested (`task-setback.test.ts`);
 * `pipeline-queries.ts` reads the rows and calls it.
 *
 * What each field rests on, and what it does not claim:
 *
 * - **A return** is a row closed `returned` (`transitions.ts`' `return` case writes `returned_to`
 *   and `return_reason` on it). The reason's *text* is not published — on a CI return it is the
 *   failing jobs' logs — only whether there is one.
 * - **The CI failure** is the row's `signature`, `ciFailureSignature`'s
 *   `ci:<status>:<jobs, sorted>@<head>`, which only a failing CI settlement writes (`jobs.ts`'
 *   `ciConvergence`, on the attempt it settles). A row without one is not called a CI failure.
 * - **The loop a return spent is not recorded on its row.** The interpreter spends the edge's loop
 *   (`returnLoopFor`), but a person's return spends `human_rounds` and the dependency gate's spends
 *   `dependency_policy` from whatever stage the task was at — so the edge alone would guess. The one
 *   case the row proves is a `ci_gate` return carrying a CI signature: only the gate's own failed
 *   settlement writes that, and it returns through the interpreter (`ci_fix`). Every other return
 *   publishes `loop: null`, and the page then says no round count rather than a wrong one. The
 *   residual: a person's return out of an escalation **over** such a row (it rewrites the row and
 *   keeps the signature) still reads as a CI fix — BACKLOG 1296.
 * - **A stop** is the current stage's latest attempt of a `needs_human` task: closed `returned` while
 *   the task did not move is a spent loop (`returnToStage` escalates and leaves the counter at its
 *   limit — the only writer of that shape: `spendLoop`'s exhaustion closes the row `escalated`);
 *   `converged` is the same failure repeated; `undecided` is a check that got no answer.
 */
import type {
  AgentRole,
  TaskCiFailure,
  TaskReturn,
  TaskStageOutcome,
  TaskStop,
} from '@platform/contracts';
import { MAX_TASK_STOP_RECORDED_CHARS } from '@platform/contracts';
import { type CompiledPipeline, returnLoopFor } from '@platform/domain';

/** The columns of one `task_stages` row this module reads. */
export interface SetbackStageRow {
  readonly stage: string;
  readonly attempt: number;
  /** `task_stages.state`, already parsed by the caller. */
  readonly state: string;
  readonly outcome: TaskStageOutcome | null;
  readonly exitedAt: string | null;
  readonly returnedTo: string | null;
  /**
   * `task_stages.return_reason` — or, from a read that bounds it, its first
   * {@link MAX_TASK_STOP_RECORDED_CHARS} + 1 characters (enough to know it was cut).
   */
  readonly returnReason: string | null;
  readonly signature: string | null;
}

/** The task's columns this module reads. */
export interface SetbackTask {
  readonly state: string;
  readonly currentStage: string | null;
}

const CI_FAILURE_STATUSES = new Set<TaskCiFailure['status']>(['failed', 'canceled', 'skipped']);
const MAX_JOBS_CHARS = 4_000;
const CI_GATE = 'ci_gate';

/**
 * `ci:<status>:<jobs>@<head>` → the status and the jobs as joined. A status outside the CI gate's
 * terminal-failure set, or a string of another shape, is **not** a CI failure (`null`): the column
 * also carries the review's signature (`saga.ts`), which is not this one's business.
 */
export const ciFailureOf = (signature: string | null): TaskCiFailure | null => {
  if (signature === null || !signature.startsWith('ci:')) {
    return null;
  }
  const rest = signature.slice('ci:'.length);
  const colon = rest.indexOf(':');
  if (colon === -1) {
    return null;
  }
  const status = rest.slice(0, colon);
  if (!CI_FAILURE_STATUSES.has(status as TaskCiFailure['status'])) {
    return null;
  }
  const tail = rest.slice(colon + 1);
  // A signature written before WP-60's round 3 carries no `@<head>`.
  const at = tail.lastIndexOf('@');
  const jobs = at === -1 ? tail : tail.slice(0, at);
  return {
    status: status as TaskCiFailure['status'],
    jobs: jobs.length > MAX_JOBS_CHARS ? `${jobs.slice(0, MAX_JOBS_CHARS - 1)}…` : jobs,
  };
};

/** The role of `stage` in the task's compiled pipeline, or `null` (not an agent stage, no pipeline). */
const roleOf = (pipeline: CompiledPipeline | null, stage: string | null): AgentRole | null => {
  if (pipeline === null || stage === null) {
    return null;
  }
  const entry = pipeline.stages.find((candidate) => candidate.id === stage);
  return entry === undefined || entry.kind !== 'agent' ? null : entry.role;
};

/** The loop the row proves its return spent — see the module note — or `null`. */
const provenLoopOf = (row: SetbackStageRow, ci: TaskCiFailure | null): string | null =>
  row.stage === CI_GATE && ci !== null && row.returnedTo !== null
    ? returnLoopFor(row.stage, row.returnedTo)
    : null;

/** Every return the rows record, oldest first (by when it went back). */
export const returnsOf = (
  rows: readonly SetbackStageRow[],
  pipeline: CompiledPipeline | null,
): TaskReturn[] =>
  rows
    .filter(
      (row): row is SetbackStageRow & { readonly exitedAt: string } =>
        row.state === 'returned' && row.exitedAt !== null,
    )
    .toSorted((a, b) => Date.parse(a.exitedAt) - Date.parse(b.exitedAt))
    .map((row) => {
      const ci = row.stage === CI_GATE ? ciFailureOf(row.signature) : null;
      return {
        from_stage: row.stage,
        attempt: row.attempt,
        to_stage: row.returnedTo,
        to_role: roleOf(pipeline, row.returnedTo),
        at: row.exitedAt,
        outcome: row.outcome,
        reason_recorded: row.returnReason !== null && row.returnReason.length > 0,
        ci_failure: ci,
        loop: provenLoopOf(row, ci),
      };
    });

/** Why a `needs_human` task stopped, when its current attempt's row says so; `null` otherwise. */
export const stopOf = (task: SetbackTask, rows: readonly SetbackStageRow[]): TaskStop | null => {
  const stage = task.currentStage;
  if (task.state !== 'needs_human' || stage === null) {
    return null;
  }
  const latest = rows
    .filter((row) => row.stage === stage)
    .reduce<SetbackStageRow | null>(
      (newest, row) => (newest === null || row.attempt > newest.attempt ? row : newest),
      null,
    );
  if (latest === null) {
    return null;
  }
  const ci = stage === CI_GATE ? ciFailureOf(latest.signature) : null;
  const base = { stage, attempt: latest.attempt, ci_failure: ci };
  if (latest.state === 'returned') {
    return {
      ...base,
      cause: 'tries_spent',
      loop: provenLoopOf(latest, ci),
      recorded: null,
      recorded_cut: false,
    };
  }
  if (latest.state === 'failed' && latest.outcome === 'converged') {
    return { ...base, cause: 'same_failure', loop: null, recorded: null, recorded_cut: false };
  }
  if (latest.state === 'failed' && latest.outcome === 'undecided') {
    const text =
      latest.returnReason === null || latest.returnReason.length === 0 ? null : latest.returnReason;
    const cut = text !== null && text.length > MAX_TASK_STOP_RECORDED_CHARS;
    return {
      ...base,
      cause: 'no_answer',
      loop: null,
      recorded: cut ? text.slice(0, MAX_TASK_STOP_RECORDED_CHARS) : text,
      recorded_cut: cut,
    };
  }
  return null;
};
