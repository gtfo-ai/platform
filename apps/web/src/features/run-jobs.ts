/**
 * The run page's **job list** (research/19 § 5.2 "Run", S-23.10): the task's runs in the order its
 * stages were entered, each with the status icon of `ui/status.tsx` — the list an Actions job page
 * has down its left side and this page lacked.
 *
 * Pure, so the order and the words are held by the unit tier.
 */
import type { RunRecord, RunStatus } from '@platform/contracts';
import { ROLE_LABEL, stageLabel } from '../ui/humanize.js';
import type { Status } from '../ui/status.js';

/** A run's status as one of the status vocabulary's icons — exhaustive, so a new status needs one. */
export const RUN_STATUS_ICON: Readonly<Record<RunStatus, Status>> = {
  created: 'queued',
  starting: 'running',
  running: 'running',
  completed: 'success',
  failed: 'failure',
  cancelled: 'cancelled',
  budget_exceeded: 'failure',
  timed_out: 'failure',
  stalled: 'failure',
};

/** Still going: claimed or not, its CLI asked for or not (`starting` is live too, WP-275b). */
export const isLiveRun = (status: RunStatus): boolean =>
  status === 'created' || status === 'starting' || status === 'running';

/** Ended without doing its job — when *Re-run* becomes the page's primary action. */
export const isFailedRun = (status: RunStatus): boolean => RUN_STATUS_ICON[status] === 'failure';

type JobRun = Pick<RunRecord, 'id' | 'stage' | 'attempt' | 'started_at' | 'role'>;

/**
 * The runs in stage order: by the position at which the task **first entered** each run's stage
 * (the task's `stages` rows are oldest first), then by attempt, then by when the run started. A run
 * whose stage the rows do not name comes after the ones they do, and a run with no stage (an ask)
 * comes last — neither is dropped.
 */
export const jobsInStageOrder = <Run extends JobRun>(
  runs: readonly Run[],
  stages: readonly { readonly stage: string }[],
): readonly Run[] => {
  const position = new Map<string, number>();
  for (const row of stages) {
    if (!position.has(row.stage)) {
      position.set(row.stage, position.size);
    }
  }
  const rank = (run: JobRun): number =>
    run.stage === null ? Number.MAX_SAFE_INTEGER : (position.get(run.stage) ?? position.size);
  const started = (run: JobRun): number => {
    const at =
      run.started_at === null || run.started_at === undefined
        ? Number.NaN
        : Date.parse(run.started_at);
    return Number.isNaN(at) ? Number.MAX_SAFE_INTEGER : at;
  };
  return [...runs].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      left.attempt - right.attempt ||
      started(left) - started(right) ||
      left.id.localeCompare(right.id),
  );
};

/** "Implementation", "Implementation · attempt 2", or the role of a run with no stage. */
export const jobLabel = (run: Pick<RunRecord, 'stage' | 'attempt' | 'role'>): string => {
  const name = run.stage === null ? ROLE_LABEL[run.role] : stageLabel(run.stage);
  return run.attempt > 1 ? `${name} · attempt ${run.attempt}` : name;
};
