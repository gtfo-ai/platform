/**
 * What the task page's stage timeline lists, and where each entry leads (WP-154 rulings (a) and
 * (b), PROGRESS backlog 455 items (2) and (3)).
 *
 * - **Newest first.** The projection keeps its order — oldest first by `entered_at`, then
 *   `attempt` (`apps/server/src/queries/pipeline-queries.ts`), because the export and other readers
 *   depend on it — and the page reverses it, so the stage a person is asking about is at the top.
 * - **Each entry leads to the latest run of its `(stage, attempt)`.** `runs.task_stage_id` is
 *   resolved from exactly that pair when the run is created, so `RunRecord.stage` and
 *   `RunRecord.attempt` name the stage row; the task's runs arrive oldest first, so the last match
 *   is the latest (a start retry or a person's retry of the same attempt is a newer run). A run that
 *   did not start leads to the same run page, which shows its not-started panel in place of a
 *   transcript. A stage with **no** run — a gate, or an agent stage nothing has started yet — says
 *   so and leads nowhere. An ask run (`stage: null`) belongs to no stage and is never matched.
 */
import type { RunRecord, TaskDetailResponse } from '@platform/contracts';

type StageRow = TaskDetailResponse['stages'][number];

/** Where a timeline entry leads. */
export type TimelineLink =
  | { readonly kind: 'run'; readonly runId: string; readonly live: boolean }
  | { readonly kind: 'not_started'; readonly runId: string }
  | { readonly kind: 'none' };

export interface TimelineEntry {
  readonly stage: StageRow;
  readonly link: TimelineLink;
}

const LIVE: readonly RunRecord['status'][] = ['created', 'starting', 'running'];

/** The newest run of one stage attempt, or `null` when none ran. */
export const latestRunOf = (
  runs: readonly RunRecord[],
  stage: Pick<StageRow, 'stage' | 'attempt'>,
): RunRecord | null =>
  runs.reduce<RunRecord | null>(
    (latest, run) => (run.stage === stage.stage && run.attempt === stage.attempt ? run : latest),
    null,
  );

const linkOf = (run: RunRecord | null): TimelineLink => {
  if (run === null) {
    return { kind: 'none' };
  }
  if (run.start_failure !== null) {
    return { kind: 'not_started', runId: run.id };
  }
  return { kind: 'run', runId: run.id, live: LIVE.includes(run.status) };
};

/** The timeline, newest first, each entry with where it leads. */
export const timelineEntries = (
  stages: readonly StageRow[],
  runs: readonly RunRecord[],
): readonly TimelineEntry[] =>
  [...stages].reverse().map((stage) => ({ stage, link: linkOf(latestRunOf(runs, stage)) }));
