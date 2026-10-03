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
import { createTaskRequestSchema, type TaskRecord } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import { type ReactElement, useState } from 'react';
import { useProjectByKey, useProjectTasks, useStartTask } from '../app/queries.js';
import { useServices } from '../app/services.js';
import { useTopics } from '../realtime/provider.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  formatElapsed,
  formatUsd,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { ExternalLink, UntrustedText } from '../ui/untrusted.js';
// A tooltip is text the browser renders, not markup — but it is still provider text, and
// `sanitiseUntrusted` is what strips the bidi overrides and control characters that make a line
// read backwards (CVE-2021-42574). `ExternalLink`'s own refusal tooltip does the same.
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import { BOARD_COST_TITLE, unmeasuredRunsShortText, unmeasuredRunsText } from './cost-text.js';

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
 * What an empty board says — **only what exists** (WP-122, PROGRESS backlog 379). The pick-up rules
 * a binding has are a label, a status, an epic or a query (`ticketMatchRuleSchema`); the hint used
 * to name *"a component"*, which no rule is, and *"a manual start"*, which no screen offered. The
 * form is named only to a caller it is shown to.
 */
export const emptyBoardHint = (canStart: boolean): string =>
  canStart
    ? "Tasks appear here when a ticket matches this project's intake rule — a label, a status, an epic or a query — or when you start one by its key above."
    : "Tasks appear here when a ticket matches this project's intake rule — a label, a status, an epic or a query. A member of the project can also start one by its key.";

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
        product/10's "ticket key + title" (Q48, WP-95). The title is the ticket's own words as the
        platform stored them — `tasks.ticket_snapshot`, bounded and redacted at the write — so it is
        provider text and goes through `UntrustedText` (BD-022). `null` means the platform has not
        read the ticket yet, and the card says so rather than drawing an empty line or guessing one
        from the branch name.
      */}
      {task.ticket_title === null ? (
        <p className="text-xs text-fg-muted" data-ticket-title="unread">
          Ticket not read yet
        </p>
      ) : (
        <p className="text-sm font-medium" data-ticket-title="read">
          <UntrustedText value={task.ticket_title} />
        </p>
      )}
      <p className="text-sm">
        <Badge tone={task.state === 'needs_human' ? 'warning' : 'neutral'}>{task.state}</Badge>
      </p>
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-fg-muted">
        <span>{task.current_stage ?? 'no stage'}</span>
        <span>·</span>
        {/*
          The measured total, and what it leaves out (WP-134, PROGRESS backlog 408): the card is the
          third place `cost_actual_usd` appears, after the task page and the notification, and it
          printed the bare figure as *"Provider-reported cost"* — false in local provider mode and
          silent about a run nobody measured. The words are `./cost-text.ts`'s, shared with the page.
        */}
        <span title={BOARD_COST_TITLE} data-task-cost="measured">
          {formatUsd(task.cost_actual_usd)}
        </span>
        {task.unmeasured_runs > 0 ? (
          <span
            title={unmeasuredRunsText(task.unmeasured_runs)}
            data-unmeasured-runs={task.unmeasured_runs}
          >
            {unmeasuredRunsShortText(task.unmeasured_runs)}
          </span>
        ) : null}
        <span>·</span>
        <span title="Time since the task was last updated.">
          {formatElapsed(task.updated_at, nowMs)}
        </span>
        {iterations.map(([stage, count]) => (
          <Badge key={stage} tone="warning">{`${stage} ${count}`}</Badge>
        ))}
      </div>
      {/*
        product/04 S6b's *"the board warns when two active tasks touch the same files"* and
        product/18's *"touches the same files as PROJ-98"* (WP-26's event, WP-41's field; PROGRESS
        backlog 63). Two residuals are in the tooltip rather than in a comment only this file's
        reader sees, because both are visible on the screen:

         - the warning is appended on **both** tasks of a pair since WP-59 (backlog 65), but only
           when a rebase gate compares them — so the *absence* of a badge means "not compared yet",
           not "clear";
         - `truncated` means the comparison did not read every file (backlog 64), so a count of
           zero under it is "nothing found in what was compared".

        The peer's ticket key is provider text (BD-022) and goes through `UntrustedText`.
      */}
      {task.conflict === null || task.conflict === undefined ? null : (
        <p className="text-[11px]">
          <Badge tone="warning">
            <span
              title={`Touches the same files as ${sanitiseUntrusted(task.conflict.other_ticket_key)}: ${task.conflict.path_count} overlapping path(s)${
                task.conflict.truncated
                  ? ', and the comparison did not read every file of both merge requests, so there may be more'
                  : ''
              }. The comparison runs when either task enters the rebase gate, and both tasks are warned when it finds an overlap; a task with no badge has not been compared yet.`}
            >
              {'touches '}
              <UntrustedText value={task.conflict.other_ticket_key} />
              {` · ${task.conflict.path_count} file${task.conflict.path_count === 1 ? '' : 's'}`}
            </span>
          </Badge>
        </p>
      )}
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

/**
 * product/04 S0's manual **Start** (WP-122, PROGRESS backlog 379): a ticket named by its key, for a
 * ticket no intake rule matches.
 *
 * Rendered only for a caller who holds `task.create` in this project (`can_start_task`, the
 * server's own `can()` over the effective role); the route refuses everyone else regardless. The
 * key is checked against the contract's character set **before** it is sent, so a typo is a
 * sentence here rather than a `400`, and the server's refusal — no tracker bound, the ticket
 * already has a task, the tracker does not know the key — is shown as the server said it. A
 * success is a recorded match, not a task: intake creates the task, and the project topic puts it
 * on the board.
 */
export const StartTicketForm = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const start = useStartTask();
  const [key, setKey] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  return (
    <form
      aria-label="Start a ticket by its key"
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = createTaskRequestSchema.safeParse({ ticket_key: key.trim() });
        if (!parsed.success) {
          setInvalid(
            'A ticket key is letters, digits, ".", "_" and "-", at most 64 characters — for example ACME-123.',
          );
          return;
        }
        setInvalid(null);
        setStarted(null);
        start.mutate(
          { projectId, ticket_key: parsed.data.ticket_key },
          {
            onSuccess: (answer) => {
              setStarted(answer.ticket.key);
              setKey('');
            },
          },
        );
      }}
    >
      <Field
        label="Start a ticket"
        hint="For a ticket no intake rule matches. The WIP limits, the dial and one task per ticket still apply."
        placeholder="ACME-123"
        value={key}
        onChange={(event) => setKey(event.target.value)}
      />
      <Button type="submit" tone="primary" disabled={start.isPending || key.trim() === ''}>
        Start
      </Button>
      {invalid === null ? null : <ErrorNotice title="That is not a ticket key." detail={invalid} />}
      {start.isError ? (
        <ErrorNotice title="The ticket was not started." detail={String(start.error)} />
      ) : null}
      {started === null ? null : (
        <p role="status" className="basis-full text-xs text-fg-muted">
          {'Started '}
          <UntrustedText value={started} />
          {' — its task appears on the board once intake has created it.'}
        </p>
      )}
    </form>
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
  const canStart = tasks.data?.can_start_task === true;

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
            <Link
              to="/projects/$key/shadow"
              params={{ key: project.key }}
              className="text-accent underline"
            >
              Shadow
            </Link>
            <Link
              to="/projects/$key/settings"
              params={{ key: project.key }}
              className="text-accent underline"
            >
              Settings
            </Link>
          </div>
        }
      >
        <UntrustedText value={project.name} />
      </SectionHeading>

      {tasks.isError ? (
        <ErrorNotice title="Tasks could not be loaded." detail={String(tasks.error)} />
      ) : null}

      {canStart ? <StartTicketForm projectId={project.id} /> : null}

      {tasks.isSuccess && items.length === 0 ? (
        <EmptyState title="The board is empty" hint={emptyBoardHint(canStart)} />
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
