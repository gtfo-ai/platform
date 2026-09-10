/**
 * The project board (product/10 § "Board (project)").
 *
 * Columns are task states rather than pipeline stages, and that is a deliberate narrowing of
 * product/10 for this work package: the column list there is "stages from the project's pipeline
 * template plus Queued / Needs human / Done (7d)", and the pipeline template is WP-15's — a board
 * built on it today would have one column, "unknown". `taskStateSchema` is published and stable, so
 * the columns come from it, and the *stage* a task sits in is shown on the card. Follow-up when
 * WP-15 lands the template.
 *
 * Drag is not supported by design: the pipeline owns state (product/10).
 */
import type { TaskRecord } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useProjectByKey, useProjectTasks } from '../app/queries.js';
import { useServices } from '../app/services.js';
import { useTopics } from '../realtime/provider.js';
import {
  Badge,
  Card,
  EmptyState,
  ErrorNotice,
  formatElapsed,
  formatUsd,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { ExternalLink, UntrustedText } from '../ui/untrusted.js';

/** The columns, in pipeline order. Every state appears exactly once, so no task can be invisible. */
export const BOARD_COLUMNS = [
  { id: 'queued', title: 'Queued', states: ['queued'] },
  { id: 'active', title: 'Active', states: ['active', 'returned'] },
  {
    id: 'waiting',
    title: 'Needs human',
    states: ['waiting_answers', 'waiting_approval', 'needs_human', 'paused'],
  },
  { id: 'review', title: 'Ready to merge', states: ['ready_for_merge', 'merged', 'retro'] },
  { id: 'done', title: 'Done', states: ['done', 'cancelled'] },
] as const;

export const columnFor = (state: string): string =>
  BOARD_COLUMNS.find((column) => (column.states as readonly string[]).includes(state))?.id ??
  'active';

/**
 * One card.
 *
 * The card is **not** wrapped in a link: it carries links of its own (ticket, MR), and an anchor
 * inside an anchor is invalid HTML whose keyboard behaviour browsers disagree about. The ticket key
 * is the link into the task.
 */
const TaskCard = ({
  task,
  projectKey,
  nowMs,
}: {
  readonly task: TaskRecord;
  readonly projectKey: string;
  readonly nowMs: number;
}): ReactElement => {
  const iterations = Object.entries(task.iteration_counters).filter(([, count]) => count > 0);
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <Link
          to="/projects/$key/tasks/$taskId"
          params={{ key: projectKey, taskId: task.id }}
          className="font-mono text-xs font-semibold hover:underline"
        >
          <UntrustedText value={task.ticket.key} />
        </Link>
        <Badge tone="neutral">{task.template}</Badge>
      </div>
      {/*
        product/10 asks for "ticket key + title" here. `ticketRefSchema` publishes provider, key and
        url and **no title**, and inventing one client-side would mean guessing. The state and the
        stage take its place until the contract carries one (Q48).
      */}
      <p className="text-sm">
        <Badge tone={task.state === 'needs_human' ? 'warning' : 'neutral'}>{task.state}</Badge>
      </p>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-muted">
        <span>{task.current_stage ?? 'no stage'}</span>
        <span>·</span>
        <span title="Provider-reported cost so far for this task.">
          {formatUsd(task.cost_actual_usd)}
        </span>
        <span>·</span>
        <span title="Time since the task was last updated.">
          {formatElapsed(task.updated_at, nowMs)}
        </span>
        {iterations.map(([stage, count]) => (
          <Badge key={stage} tone="warning">{`${stage} ${count}`}</Badge>
        ))}
      </div>
      <div className="flex flex-wrap gap-2 text-[11px]">
        {/* Both URLs came from a ticket or git provider: `ExternalLink` is the only renderer
            allowed to produce an `href`, and it refuses any scheme but http(s). */}
        <ExternalLink url={task.ticket.url} label="Open ticket" className="text-accent underline" />
        {task.mr_ref === null || task.mr_ref === undefined ? null : (
          <ExternalLink url={task.mr_ref.url} label="Open MR" className="text-accent underline" />
        )}
      </div>
    </Card>
  );
};

export const BoardScreen = ({ projectKey }: { readonly projectKey: string }): ReactElement => {
  const { project, isPending, isError, error } = useProjectByKey(projectKey);
  const tasks = useProjectTasks(project?.id ?? null);
  const { now } = useServices();
  useTopics(project === null ? [] : [`project:${project.id}`]);

  if (isPending) {
    return <Loading label="Loading project…" />;
  }
  if (isError) {
    return <ErrorNotice title="Project could not be loaded." detail={String(error)} />;
  }
  if (project === null) {
    return (
      <EmptyState
        title="No such project"
        hint={`No project has the key "${projectKey}". Check the link, or pick one from the dashboard.`}
      />
    );
  }

  const nowMs = now();
  const items = tasks.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <SectionHeading
        actions={
          <div className="flex gap-3 text-xs">
            <Link
              to="/projects/$key/knowledge"
              params={{ key: project.key }}
              className="text-accent underline"
            >
              Knowledge
            </Link>
            <Link
              to="/projects/$key/pipeline"
              params={{ key: project.key }}
              className="text-accent underline"
            >
              Pipeline
            </Link>
            <Link
              to="/projects/$key/budgets"
              params={{ key: project.key }}
              className="text-accent underline"
            >
              Budgets
            </Link>
          </div>
        }
      >
        <UntrustedText value={project.name} />
      </SectionHeading>

      {tasks.isError ? (
        <ErrorNotice title="Tasks could not be loaded." detail={String(tasks.error)} />
      ) : null}

      {tasks.isSuccess && items.length === 0 ? (
        <EmptyState
          title="The board is empty"
          hint="Tasks appear here when a ticket matches this project's intake rules — a label, a component or a manual start from a ticket key. Nothing is picked up until a rule matches."
        />
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        {BOARD_COLUMNS.map((column) => {
          const columnTasks = items.filter((task) => columnFor(task.state) === column.id);
          return (
            <section key={column.id} aria-label={column.title} className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold tracking-wide text-fg-muted uppercase">
                {column.title} ({columnTasks.length})
              </h3>
              {columnTasks.map((task) => (
                <TaskCard key={task.id} task={task} projectKey={project.key} nowMs={nowMs} />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
};
