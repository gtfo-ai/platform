/**
 * The task page's **Overview** tab (S-23.9b, research/19 § 5.2 "Task"): the pipeline as a live
 * graph (S-23.5's `TaskFlow`), the stage that is running now, the stage timeline, then *Ask the
 * task* and the feedback form.
 *
 * **The stage timeline** lists the newest attempt first, each leading to its latest run (WP-154 (a)
 * and (b), `./stage-timeline.ts`), and says for each how long it took, what its runs cost and —
 * for an attempt that sent the task back — that it did, drawn with the loop glyph rather than as a
 * failure. The cost is the sum of the attempt's **measured** runs; an attempt whose runs nobody
 * measured says *not measured* rather than `$0.00` (standing rule 16), and one with no run says
 * nothing about money at all.
 */
import type { RunRecord, TaskDetailResponse, TaskStageState } from '@platform/contracts';
import { UndoIcon } from '@primer/octicons-react/UndoIcon';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import type { useTaskCommands } from '../app/queries.js';
import { STAGE_STATE_LABEL, stageLabel } from '../ui/humanize.js';
import {
  Badge,
  EmptyState,
  formatDateTime,
  formatElapsed,
  formatUsd,
  NOT_MEASURED,
  SectionHeading,
} from '../ui/kit.js';
import { type Status, StatusIcon } from '../ui/status.js';
import { Timeline, TimelineItem } from '../ui/timeline.js';
import { UntrustedText } from '../ui/untrusted.js';
import { TaskFlow } from '../viz/flow/flow-view.js';
import { AskThread } from './ask-thread.js';
import { BreakdownPanel } from './breakdown-panel.js';
import { FeedbackForm } from './feedback.js';
import { LiveStagePanel, liveStageRun } from './live-stage.js';
import { stageOutcomeSentence } from './stage-outcome.js';
import { type TimelineLink, timelineEntries } from './stage-timeline.js';
import { MERGED_NO_TAKE_OVER } from './take-over.js';
import { EPIC_SPLIT_TEMPLATE } from './task-checks-text.js';

type StageRow = TaskDetailResponse['stages'][number];

const STAGE_STATUS: Readonly<Record<TaskStageState, Status>> = {
  pending: 'queued',
  running: 'running',
  completed: 'success',
  returned: 'waiting',
  skipped: 'skipped',
  failed: 'failure',
};

/** How long an attempt took, or has been going: entry to exit, or to now while it is open. */
export const stageDuration = (stage: StageRow, nowMs: number): string => {
  const end = stage.exited_at === null ? nowMs : Date.parse(stage.exited_at);
  return formatElapsed(stage.entered_at, Number.isNaN(end) ? nowMs : end);
};

/**
 * What one attempt's runs cost: the sum of the measured ones, `not measured` when it had runs and
 * none was measured, `null` when it had none — so a gate never reads as a free run.
 */
export const stageCostText = (stage: StageRow, runs: readonly RunRecord[]): string | null => {
  const own = runs.filter((run) => run.stage === stage.stage && run.attempt === stage.attempt);
  if (own.length === 0) {
    return null;
  }
  const measured = own.flatMap((run) => (run.cost === null ? [] : [run.cost.usd]));
  if (measured.length === 0) {
    return NOT_MEASURED;
  }
  const sum = formatUsd(measured.reduce((total, usd) => total + usd, 0));
  const unmeasured = own.length - measured.length;
  return unmeasured === 0 ? sum : `${sum}, ${unmeasured} not measured`;
};

/** Where one timeline entry leads (WP-154 (b)): its latest run, the not-started panel, or nowhere. */
const TimelineRunLink = ({ link }: { readonly link: TimelineLink }): ReactElement => {
  if (link.kind === 'none') {
    return <p className="text-[11px] text-fg-muted">No run for this stage.</p>;
  }
  const label =
    link.kind === 'not_started'
      ? 'Why the run did not start'
      : link.live
        ? 'Open the run (live)'
        : 'Open the run';
  return (
    <Link
      to="/runs/$runId"
      params={{ runId: link.runId }}
      className="text-[11px] text-link underline"
    >
      {label}
    </Link>
  );
};

const StageTimeline = ({
  stages,
  runs,
  nowMs,
}: {
  readonly stages: TaskDetailResponse['stages'];
  readonly runs: readonly RunRecord[];
  readonly nowMs: number;
}): ReactElement => (
  <div className="flex flex-col gap-2">
    <SectionHeading>Stage timeline</SectionHeading>
    {stages.length === 0 ? (
      <EmptyState
        title="No stages yet"
        hint="Stages appear as the pipeline enters them. A queued task has none."
      />
    ) : (
      // WP-154 (a) and (b): newest first, each entry leading to its latest run.
      <Timeline label="Timeline, newest first">
        {timelineEntries(stages, runs).map(({ stage, link }) => {
          const cost = stageCostText(stage, runs);
          return (
            <TimelineItem
              key={`${stage.stage}:${stage.attempt}`}
              data-testid="timeline-entry"
              badge={
                stage.state === 'returned' ? (
                  <span className="inline-flex text-attention">
                    <UndoIcon size={16} />
                  </span>
                ) : (
                  <StatusIcon status={STAGE_STATUS[stage.state]} decorative />
                )
              }
              time={
                <>
                  {formatDateTime(stage.entered_at)}
                  {` · ${stageDuration(stage, nowMs)}`}
                  {stage.exited_at === null ? ' · running' : ''}
                  {cost === null ? '' : ` · ${cost}`}
                </>
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{stageLabel(stage.stage)}</span>
                <Badge
                  tone={
                    stage.state === 'completed'
                      ? 'success'
                      : stage.state === 'failed'
                        ? 'danger'
                        : stage.state === 'returned'
                          ? 'warning'
                          : 'neutral'
                  }
                >
                  {STAGE_STATE_LABEL[stage.state]}
                </Badge>
                {stage.attempt > 1 ? <Badge tone="warning">{`try ${stage.attempt}`}</Badge> : null}
              </div>
              {stage.outcome === null ? null : (
                <p className="text-xs text-fg-muted">
                  <UntrustedText value={stageOutcomeSentence(stage.outcome)} />
                </p>
              )}
              <TimelineRunLink link={link} />
            </TimelineItem>
          );
        })}
      </Timeline>
    )}
  </div>
);

export const TaskOverview = ({
  detail,
  merged,
  breakdownWaiting,
  commands,
  nowMs,
}: {
  readonly detail: TaskDetailResponse;
  readonly merged: boolean;
  /** The breakdown is in the needs-you callout, so the Overview does not draw it a second time. */
  readonly breakdownWaiting: boolean;
  readonly commands: ReturnType<typeof useTaskCommands>;
  readonly nowMs: number;
}): ReactElement => {
  const { task, stages, runs, artifacts, taken_over: takenOver } = detail;
  const liveRun = liveStageRun(runs);
  const finished = task.state === 'done' || task.state === 'cancelled';
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* S-23.5: the task's pipeline as a live graph. */}
      <TaskFlow taskId={task.id} />
      {/* Backlogs 455 (1) and 496: the live stage, its elapsed time and its latest progress line. */}
      {liveRun === null ? null : <LiveStagePanel key={liveRun.id} run={liveRun} />}
      {/*
        WP-194 (backlog 563): the server refuses a merged task's pause and take-over, so the menu
        offers neither, and this says why.
      */}
      {merged && takenOver === null && !finished ? (
        <p className="text-xs text-fg-muted">{MERGED_NO_TAKE_OVER}</p>
      ) : null}
      <StageTimeline stages={stages} runs={runs} nowMs={nowMs} />
      {task.template === EPIC_SPLIT_TEMPLATE && !breakdownWaiting ? (
        <BreakdownPanel taskId={task.id} enabled />
      ) : null}
      <AskThread taskId={task.id} artifacts={artifacts} />
      <FeedbackForm
        heading="Feedback on this task"
        hint="Goes to the Retrospective and the Librarian: what the agents got right or wrong here becomes a knowledge-base proposal."
        pending={commands.feedback.isPending}
        failed={commands.feedback.isError}
        accepted={commands.feedback.isSuccess}
        onSubmit={(input) => {
          commands.feedback.mutate({ scope: 'task', ...input });
        }}
      />
    </div>
  );
};
