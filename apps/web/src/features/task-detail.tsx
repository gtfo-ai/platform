/**
 * Task detail (product/10 § "Task detail"), laid out as a pull request page (S-23.9b, research/19
 * § 5.2 "Task"): what it is, where it is, what to do now. Live on the `task:<id>` topic.
 *
 * - **Header** (`./task-header.tsx`): the ticket's title and key, its state, one meta line, the
 *   phase strip, the one primary action the state calls for and the `···` menu of everything else.
 * - **Needs-you callout** (`./task-callout.tsx`): an open question, a pending approval, an
 *   escalation or a breakdown waiting for a decision, with the action inline.
 * - **Tabs** in `?tab=` (`./task-tab.ts`): *Overview* (the flow, the live stage, the stage timeline,
 *   Ask the task and feedback — `./task-overview.tsx`), *Artifacts* (`./task-artifacts.tsx`, also
 *   selected by `?artifact=`), *Runs* (`./task-runs.tsx`) and *Activity* (`./task-activity.tsx`).
 * - **Right rail** (`./task-checks.tsx`): the merge box of product/10:38's eleven checks, the cost
 *   against the cap, the links.
 *
 * The dialogs the menu and the callout open are one set, held here (`./task-dialogs.tsx`), so the
 * stage a person picked and an untick of the gate-feedback box outlive a dialog's closing.
 *
 * **Ask the task is here since WP-31** — `features/ask-thread.tsx`, on the Overview. The thread is
 * a query of its own (`GET /api/tasks/:id/asks`) rather than a field of the task DTO: an ask is
 * answered by a run that takes a minute, on its own schedule.
 */
import { Link, useSearch } from '@tanstack/react-router';
import { type ReactElement, useState } from 'react';
import {
  useProjects,
  useTakeOverCommands,
  useTask,
  useTaskBreakdown,
  useTaskCommands,
} from '../app/queries.js';
import { useServices } from '../app/services.js';
import { useTopics } from '../realtime/provider.js';
import { Flash } from '../ui/flash.js';
import { ErrorNotice, Loading } from '../ui/kit.js';
import { UnderlineNav } from '../ui/underline-nav.js';
import { HandBackForm, TakenOverDetails, TakeOverAnswer } from './take-over.js';
import { TaskActivity } from './task-activity.js';
import { TaskArtifacts } from './task-artifacts.js';
import { TaskCallout } from './task-callout.js';
import { TaskChecksRail } from './task-checks.js';
import { EPIC_SPLIT_TEMPLATE } from './task-checks-text.js';
import {
  retryOutcomeText,
  type TaskDialog,
  TaskDialogs,
  useStageCommandForm,
} from './task-dialogs.js';
import { TaskHeader } from './task-header.js';
import { TaskOverview } from './task-overview.js';
import { TaskRuns } from './task-runs.js';
import {
  currentTaskTab,
  TASK_TAB_LABEL,
  TASK_TABS,
  type TaskSearch,
  taskTabSearch,
} from './task-tab.js';

export const TaskDetailScreen = ({ taskId }: { readonly taskId: string }): ReactElement => {
  useTopics([`task:${taskId}`]);
  const detail = useTask(taskId);
  const commands = useTaskCommands(taskId);
  const takeOverCommands = useTakeOverCommands(taskId);
  const projects = useProjects();
  const { now } = useServices();
  // `strict: false` because two routes render this screen (`/tasks/$taskId` and
  // `/projects/$key/tasks/$taskId`) and both declare the same search schema (`taskSearchSchema`);
  // a strict read would have to name one of them.
  const search = useSearch({ strict: false }) as TaskSearch;
  const [dialog, setDialog] = useState<TaskDialog | null>(null);
  const form = useStageCommandForm(detail.data?.stages ?? [], detail.data?.gate_feedback ?? null);
  const epic = detail.data?.task.template === EPIC_SPLIT_TEMPLATE;
  const breakdown = useTaskBreakdown(taskId, epic);

  if (detail.isPending) {
    return <Loading label="Loading task…" />;
  }
  if (detail.isError) {
    return <ErrorNotice title="Task could not be loaded." error={detail.error} />;
  }

  const { task, stages, artifacts, runs, taken_over: takenOver } = detail.data;
  // The route may be entered without a project key (from the inbox or the agents view), so the
  // link back to the board is resolved from the task's own project rather than from the URL.
  const projectKey =
    projects.data?.items.find((project) => project.id === task.project_id)?.key ?? null;
  const nowMs = now();
  const artifactIds = artifacts.map((artifact) => artifact.id);
  const tab = currentTaskTab(search, artifactIds);
  // An unknown id opens nothing rather than erroring: the parameter is a *reference* to one of this
  // task's own artifacts, and a link that outlived the row is a closed panel.
  const openArtifactId = artifactIds.find((id) => id === search.artifact) ?? null;
  const merged = stages.some((entry) => entry.stage === 'merged_gate');
  // A breakdown is the callout's when a maintainer has something left to decide on it.
  const breakdownWaiting =
    epic &&
    breakdown.data?.can_decide === true &&
    breakdown.data.items.some((item) => item.status === 'queued');
  const answered = takeOverCommands.takeOver.data;
  const pendingApproval =
    detail.data.approvals.find((approval) => approval.status === 'pending') ?? null;
  const counts: Partial<Record<(typeof TASK_TABS)[number], number>> = {
    artifacts: artifacts.length,
    runs: runs.length,
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <TaskHeader
        detail={detail.data}
        projectKey={projectKey}
        nowMs={nowMs}
        stageOptions={form.options.length}
        commands={commands}
        onOpen={setDialog}
      />

      {commands.pause.isError || commands.resume.isError ? (
        <ErrorNotice title="That command was refused." />
      ) : null}
      {/* Backlog 494: what a retry did, announced rather than only drawn. */}
      {commands.retryStage.data === undefined ? null : (
        <p role="status" className="text-sm text-fg-muted">
          {retryOutcomeText(commands.retryStage.data)}
        </p>
      )}

      <TaskCallout
        detail={detail.data}
        merged={merged}
        hasStages={form.options.length > 0}
        breakdownWaiting={breakdownWaiting}
        commands={commands}
        onOpen={setDialog}
      />

      {takenOver !== null ? (
        <section aria-label="Taken over">
          <Flash tone="warning" title="Taken over by a human">
            <div className="flex flex-col gap-3 pt-1">
              <TakenOverDetails
                state={task.state}
                takenOver={takenOver}
                runs={runs}
                answered={answered}
              />
              {/*
                With a stage to hand back to, the hand-back is the header's primary *Hand back…*;
                with none (WP-165, Q117 (a)) the form's own empty state names the way out here.
              */}
              {takenOver.hand_back_stages.length > 0 ? null : (
                <HandBackForm
                  taskId={task.id}
                  takenOver={takenOver}
                  merged={merged}
                  commands={takeOverCommands}
                />
              )}
            </div>
          </Flash>
        </section>
      ) : answered === undefined ? null : (
        <section aria-label="Taken over">
          <Flash tone="success" title="You took this task over">
            <TakeOverAnswer answered={answered} />
          </Flash>
        </section>
      )}

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <UnderlineNav
            label="Task"
            items={TASK_TABS.map((id) => ({
              id,
              label: TASK_TAB_LABEL[id],
              current: tab === id,
              ...(counts[id] === undefined ? {} : { counter: counts[id] }),
              render: (props) => (
                <Link
                  to="."
                  search={(previous: Record<string, unknown>) => taskTabSearch(previous, id)}
                  // Every tab is this route with another search, and the router's own active
                  // test is partial by default — so the Overview's `{}` would match every tab.
                  // Exact, and `aria-current` is the one `UnderlineNav` decided.
                  activeOptions={{ exact: true }}
                  {...props}
                />
              ),
            }))}
          />
          {tab === 'overview' ? (
            <TaskOverview
              detail={detail.data}
              merged={merged}
              breakdownWaiting={breakdownWaiting}
              commands={commands}
              nowMs={nowMs}
            />
          ) : tab === 'artifacts' ? (
            <TaskArtifacts taskId={taskId} artifacts={artifacts} openArtifactId={openArtifactId} />
          ) : tab === 'runs' ? (
            <TaskRuns runs={runs} nowMs={nowMs} />
          ) : (
            <TaskActivity taskId={taskId} />
          )}
        </div>
        <TaskChecksRail detail={detail.data} />
      </div>

      <TaskDialogs
        open={dialog}
        onOpenChange={setDialog}
        taskId={taskId}
        capUsd={task.budget_cap_usd}
        takenOver={takenOver}
        merged={merged}
        approval={pendingApproval}
        form={form}
        commands={commands}
        takeOverCommands={takeOverCommands}
      />
    </div>
  );
};
