/**
 * One task on the board (research/19 § 5.2 "Board", TD-033 decisions 6–7): the card of the board
 * view and the row of the list view, and the `···` menu both carry.
 *
 * What a glance must tell — **which phase, and does it need me**:
 *
 *  - the title first (the ticket's own words, untrusted), the ticket key muted, the template's icon;
 *  - a `PhaseTrack` of the stages the task has **entered** (`phaseStagesFor` over the page's stage
 *    rows, nothing upcoming invented), with the stage's name and — while an agent works on it — the
 *    activity's sub-label from the agents read; otherwise the state's word beside its status icon;
 *  - time in the current stage · the measured cost (and the runs it leaves out);
 *  - the needs-you ◆ and the count of what waits (open questions, pending approvals), the amber
 *    pulse while an agent is working, the loop badges (*Review 2/3*), the conflict badge.
 *
 * The menu's commands are the task page's, through the same `useTaskCommands` hook, so each sends
 * the same body with the same `Idempotency-Key` semantics: *Pause*, *Resume* and *Cancel* with the
 * page's reasons, *Return to stage…* with the stage and the person's reason. Cancel and Return are
 * Dialogs (a human's destructive or multi-field action, research/19 § 3.9); Pause and Resume are one
 * press. *Open ticket* and *Open MR* are `ActionMenuLinkItem`s, so their `href` is `safeHref`'s.
 *
 * The card is **not** wrapped in a link: the title is the link into the task, and the menu carries
 * its own items — an anchor inside an anchor is invalid HTML.
 */
import type { AgentsResponse, TaskListItem, TaskState } from '@platform/contracts';
import { BeakerIcon } from '@primer/octicons-react/BeakerIcon';
import { BugIcon } from '@primer/octicons-react/BugIcon';
import { DiamondIcon } from '@primer/octicons-react/DiamondIcon';
import { IssueOpenedIcon } from '@primer/octicons-react/IssueOpenedIcon';
import { PauseIcon } from '@primer/octicons-react/PauseIcon';
import { PlayIcon } from '@primer/octicons-react/PlayIcon';
import { RocketIcon } from '@primer/octicons-react/RocketIcon';
import { ToolsIcon } from '@primer/octicons-react/ToolsIcon';
import type { Icon } from '@primer/octicons-react/types';
import { UndoIcon } from '@primer/octicons-react/UndoIcon';
import { XCircleIcon } from '@primer/octicons-react/XCircleIcon';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactElement, type ReactNode, useId, useState } from 'react';
import { useTaskCommands } from '../app/queries.js';
import {
  ActionMenu,
  ActionMenuItem,
  ActionMenuLinkItem,
  ActionMenuSeparator,
} from '../ui/action-menu.js';
import {
  ACTIVITY_META,
  type ActivityResult,
  activityOf,
  type LatestEntry,
} from '../ui/activity.js';
import { Counter } from '../ui/counter.js';
import { cx } from '../ui/cx.js';
import { Dialog } from '../ui/dialog.js';
import { loopLabel, stageLabel, TASK_STATE_LABEL, titleCase } from '../ui/humanize.js';
import { Badge, Button, ErrorNotice, formatElapsed, formatUsd } from '../ui/kit.js';
import { PhaseTrack, phaseStagesFor } from '../ui/phase-track.js';
import { StatusIcon } from '../ui/status.js';
import { needsYou as needsYouOf } from '../ui/task-status.js';
import { UntrustedText } from '../ui/untrusted.js';
// A tooltip is text the browser renders, not markup — but it is still provider text, and
// `sanitiseUntrusted` is what strips the bidi overrides and control characters that make a line
// read backwards (CVE-2021-42574). `ExternalLink`'s own refusal tooltip does the same.
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import { BOARD_COST_TITLE, unmeasuredRunsShortText, unmeasuredRunsText } from './cost-text.js';

/** One live run of the agents read, as the card reads it. */
export type AgentEntry = AgentsResponse['items'][number];

// ── What a card says ─────────────────────────────────────────────────────────

/** Questions plus approvals the task is waiting on. */
export const asksOf = (task: TaskListItem): number => task.open_questions + task.pending_approvals;

/**
 * Whether the task waits on a person — `ui/task-status.ts`' one definition, which the task page
 * reads too, so the card's ◆ and the page's state never disagree.
 */
export const needsYou = (task: TaskListItem): boolean =>
  needsYouOf({ state: task.state, paused_reason: task.paused_reason, open_asks: asksOf(task) });

/** "2 open questions and 1 approval waiting" — the count badge's reading. */
export const asksLabel = (task: TaskListItem): string => {
  const parts: string[] = [];
  if (task.open_questions > 0) {
    parts.push(`${task.open_questions} open question${task.open_questions === 1 ? '' : 's'}`);
  }
  if (task.pending_approvals > 0) {
    parts.push(
      `${task.pending_approvals} approval${task.pending_approvals === 1 ? '' : 's'} waiting`,
    );
  }
  return parts.join(' and ');
};

/** When the task entered its current stage: the latest attempt's row, or `null`. */
export const stageEnteredAt = (task: TaskListItem): string | null => {
  const current = task.current_stage ?? null;
  if (current === null) {
    return null;
  }
  let latest: TaskListItem['stages'][number] | null = null;
  for (const row of task.stages) {
    if (row.stage === current && (latest === null || row.attempt >= latest.attempt)) {
      latest = row;
    }
  }
  return latest?.entered_at ?? null;
};

/**
 * The loop badges: *Review 2/3* when the task's frozen limit is known, the count alone when it
 * is not (`loop_limits: null`, or a loop the limits do not name). A loop not yet gone round is not
 * shown.
 */
export const loopBadges = (task: TaskListItem): readonly { loop: string; text: string }[] =>
  Object.entries(task.iteration_counters)
    .filter(([, count]) => count > 0)
    .map(([loop, count]) => {
      const limit = task.loop_limits?.[loop];
      return {
        loop,
        text: `${loopLabel(loop)} ${count}${limit === undefined ? '' : `/${limit}`}`,
      };
    });

/** The live run's newest entry, in `activityOf`'s words. */
const latestOf = (agent: AgentEntry): LatestEntry | null =>
  agent.activity === null
    ? null
    : { kind: agent.activity.kind, tool_name: agent.activity.tool_name, at: agent.activity.at };

/** What the task is doing: from its live run when an agent holds one, else from its state. */
export const cardActivity = (
  task: TaskListItem,
  agent: AgentEntry | undefined,
  nowMs: number,
): ActivityResult =>
  activityOf({
    run:
      agent === undefined
        ? null
        : {
            status: agent.run.status,
            terminal_reason: agent.run.terminal_reason ?? null,
            started_at: agent.run.started_at ?? null,
          },
    latest: agent === undefined ? null : latestOf(agent),
    role: agent?.role ?? null,
    task_state: task.state,
    open_asks: asksOf(task),
    now: nowMs,
  });

/** An agent is at work on it: a live run in `running`, which the card pulses for. */
export const agentWorking = (agent: AgentEntry | undefined): boolean =>
  agent !== undefined && agent.run.status === 'running';

// ── Which commands the menu offers ───────────────────────────────────────────

/** Over: nothing but the links. `merged` and `retro` are not — a cancel is still the domain's. */
const ENDED: ReadonlySet<TaskState> = new Set(['done', 'cancelled']);

/** Past the merge: nothing to pause, and never sent back to a stage before it. */
const MERGED_STATES: ReadonlySet<TaskState> = new Set(['merged', 'retro']);

/**
 * What the caller may do in this project — the tasks page's `can_cancel_task` and
 * `can_return_to_stage`, the routes' own `can()` over the caller's role.
 */
export interface MenuCapabilities {
  readonly cancel: boolean;
  readonly returnToStage: boolean;
}

export interface MenuCommands {
  readonly pause: boolean;
  readonly resume: boolean;
  readonly cancel: boolean;
  /** The stages a return may name: the ones the task entered, in the order first entered. */
  readonly returnTo: readonly string[];
}

/**
 * What the menu offers for a state, and for what the caller may do. The server is the judge — each
 * command is refused by the aggregate with a named 409, and by the role with a 403 — so this only
 * keeps the menu from offering what cannot be meant: no pause of a paused task or of one that
 * entered `merged_gate` (as the task page), no resume of a running one, a cancel until the task is
 * done or cancelled, no return for a task that entered no stage or was merged, and neither cancel
 * nor return to a caller whose role the route would refuse.
 */
export const menuCommandsFor = (task: TaskListItem, may: MenuCapabilities): MenuCommands => {
  const ended = ENDED.has(task.state);
  const stages = [...new Set(task.stages.map((row) => row.stage))];
  const merged = MERGED_STATES.has(task.state) || stages.includes('merged_gate');
  return {
    pause: !ended && !merged && task.state !== 'paused' && task.state !== 'needs_human',
    resume: task.state === 'paused' || task.state === 'needs_human',
    cancel: may.cancel && !ended,
    returnTo: !may.returnToStage || ended || merged || task.state === 'queued' ? [] : stages,
  };
};

// ── Pieces ───────────────────────────────────────────────────────────────────

const TEMPLATE_ICON: Readonly<Record<string, Icon>> = {
  feature: RocketIcon,
  bug: BugIcon,
  chore: ToolsIcon,
  spike: BeakerIcon,
};

/** The template's Octicon, named for assistive tech; any other template has the issue glyph. */
export const TemplateIcon = ({ template }: { readonly template: string }): ReactElement => {
  const Glyph = Object.hasOwn(TEMPLATE_ICON, template)
    ? (TEMPLATE_ICON[template] as Icon)
    : IssueOpenedIcon;
  return (
    <span
      data-template={template}
      title={titleCase(template)}
      className="inline-flex shrink-0 text-fg-muted"
    >
      <span aria-hidden="true" className="inline-flex">
        <Glyph size={16} />
      </span>
      <span className="sr-only">{titleCase(template)}</span>
    </span>
  );
};

/** The needs-you ◆ and, when something is open, its count. */
export const NeedsYouMarker = ({ task }: { readonly task: TaskListItem }): ReactElement | null => {
  if (!needsYou(task)) {
    return null;
  }
  const asks = asksOf(task);
  return (
    <span data-needs-you="" className="inline-flex items-center gap-1 text-running">
      <span aria-hidden="true" className="inline-flex">
        <DiamondIcon size={12} />
      </span>
      <span className="sr-only">Needs you</span>
      {asks > 0 ? (
        <span data-asks={asks}>
          <Counter count={asks} tone="primary" label={asksLabel(task)} />
        </span>
      ) : null}
    </span>
  );
};

/**
 * product/04 S6b's *"the board warns when two active tasks touch the same files"* (WP-26's event,
 * WP-41's field). The peer's key is provider text and goes through `UntrustedText`; the tooltip
 * states both residuals — the warning appears only once a rebase gate compared the pair, and a
 * truncated comparison read less than every file.
 */
const ConflictBadge = ({
  conflict,
}: {
  readonly conflict: NonNullable<TaskListItem['conflict']>;
}): ReactElement => (
  <Badge tone="warning">
    {/* A long peer key gives way at the badge's edge on a narrow row, rather than past the box. */}
    <span
      className="min-w-0 truncate"
      title={`Touches the same files as ${sanitiseUntrusted(conflict.other_ticket_key)}: ${conflict.path_count} overlapping path(s)${
        conflict.truncated
          ? ', and the comparison did not read every file of both merge requests, so there may be more'
          : ''
      }. The comparison runs when either task enters the rebase gate, and both tasks are warned when it finds an overlap; a task with no badge has not been compared yet.`}
    >
      {'touches '}
      <UntrustedText value={conflict.other_ticket_key} />
      {` · ${conflict.path_count} file${conflict.path_count === 1 ? '' : 's'}`}
    </span>
  </Badge>
);

/** The title as the link into the task; the key when the ticket has not been read. */
const TitleLink = ({
  task,
  projectKey,
}: {
  readonly task: TaskListItem;
  readonly projectKey: string;
}): ReactElement => (
  <Link
    to="/projects/$key/tasks/$taskId"
    params={{ key: projectKey, taskId: task.id }}
    className="font-semibold break-words text-fg hover:text-link hover:underline"
    data-ticket-title={task.ticket_title === null ? 'unread' : 'read'}
  >
    {/*
      The title is the ticket's own words as the platform stored them (`tasks.ticket_snapshot`,
      bounded and redacted at the write), so it is provider text (BD-022). `null` means the ticket
      has not been read; the link then names the ticket by its key and says so beside it.
    */}
    <UntrustedText value={task.ticket_title ?? task.ticket.key} />
  </Link>
);

/** Time in stage · cost — the card's one meta line. */
export const MetaLine = ({
  task,
  nowMs,
}: {
  readonly task: TaskListItem;
  readonly nowMs: number;
}): ReactElement => {
  const entered = stageEnteredAt(task);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
      {entered === null ? (
        <span title="Time since the task was last updated." data-time="updated">
          {`updated ${formatElapsed(task.updated_at, nowMs)} ago`}
        </span>
      ) : (
        <span title="Time since the task entered its current stage." data-time="in-stage">
          {`${formatElapsed(entered, nowMs)} in stage`}
        </span>
      )}
      <span aria-hidden="true">·</span>
      {/*
        The measured total, and what it leaves out (WP-134): the words are `./cost-text.ts`'s,
        shared with the task page.
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
    </span>
  );
};

/** The loop badges and the conflict badge, or nothing. */
const Badges = ({ task }: { readonly task: TaskListItem }): ReactElement | null => {
  const loops = loopBadges(task);
  const conflict = task.conflict ?? null;
  if (loops.length === 0 && conflict === null) {
    return null;
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {loops.map((badge) => (
        <span key={badge.loop} data-loop={badge.loop}>
          <Badge tone="warning">{badge.text}</Badge>
        </span>
      ))}
      {conflict === null ? null : <ConflictBadge conflict={conflict} />}
    </span>
  );
};

/** The phase strip and, below it, what is happening — or the state's word when no agent is. */
export const Phase = ({
  task,
  agent,
  nowMs,
}: {
  readonly task: TaskListItem;
  readonly agent: AgentEntry | undefined;
  readonly nowMs: number;
}): ReactElement => {
  const stages = phaseStagesFor(null, task.stages, task.current_stage ?? null);
  const activity = cardActivity(task, agent, nowMs);
  const live = agent !== undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {stages.length === 0 ? null : (
        <PhaseTrack
          size="sm"
          stages={stages}
          {...(live ? { activity: activity.activity, detail: activity.detail } : {})}
        />
      )}
      {live ? null : (
        <span data-task-state={task.state} className="inline-flex items-center gap-1 text-xs">
          <StatusIcon status={ACTIVITY_META[activity.activity].icon} decorative size={12} />
          <span className="text-fg-muted">{TASK_STATE_LABEL[task.state]}</span>
        </span>
      )}
    </div>
  );
};

// ── The menu and its dialogs ─────────────────────────────────────────────────

type OpenDialog = 'cancel' | 'return' | null;

/**
 * The card's `···`. Each command is the task page's — the same hook, the same body — and a success
 * also re-reads the board's page, which the task page's hook does not know about.
 */
export const TaskMenu = ({
  task,
  projectId,
  may,
  commands,
}: {
  readonly task: TaskListItem;
  readonly projectId: string;
  readonly may: MenuCapabilities;
  readonly commands: ReturnType<typeof useTaskCommands>;
}): ReactElement => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<OpenDialog>(null);
  const offered = menuCommandsFor(task, may);
  const key = task.ticket.key;
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['project', projectId, 'tasks'] });
  };

  return (
    <>
      <ActionMenu label={`Actions for ${sanitiseUntrusted(key)}`}>
        {offered.pause ? (
          <ActionMenuItem
            leadingIcon={<PauseIcon size={16} />}
            disabled={commands.pause.isPending}
            onSelect={() => {
              commands.pause.mutate('paused from the UI', { onSuccess: refresh });
            }}
          >
            Pause
          </ActionMenuItem>
        ) : null}
        {offered.resume ? (
          <ActionMenuItem
            leadingIcon={<PlayIcon size={16} />}
            disabled={commands.resume.isPending}
            onSelect={() => {
              commands.resume.mutate('resumed from the UI', { onSuccess: refresh });
            }}
          >
            Resume
          </ActionMenuItem>
        ) : null}
        {offered.returnTo.length === 0 ? null : (
          <ActionMenuItem
            leadingIcon={<UndoIcon size={16} />}
            onSelect={() => {
              setOpen('return');
            }}
          >
            Return to stage…
          </ActionMenuItem>
        )}
        {offered.cancel ? (
          <ActionMenuItem
            tone="danger"
            leadingIcon={<XCircleIcon size={16} />}
            onSelect={() => {
              setOpen('cancel');
            }}
          >
            Cancel…
          </ActionMenuItem>
        ) : null}
        {offered.pause || offered.resume || offered.cancel || offered.returnTo.length > 0 ? (
          <ActionMenuSeparator />
        ) : null}
        {/* Both URLs came from a ticket or git provider: the link item's `href` is `safeHref`'s. */}
        <ActionMenuLinkItem url={task.ticket.url} label="Open ticket" />
        {task.mr_ref === null || task.mr_ref === undefined ? null : (
          <ActionMenuLinkItem url={task.mr_ref.url} label="Open MR" />
        )}
      </ActionMenu>
      {open === 'cancel' ? (
        <CancelDialog
          ticketKey={key}
          pending={commands.cancel.isPending}
          error={commands.cancel.isError ? commands.cancel.error : null}
          onClose={() => {
            setOpen(null);
            commands.cancel.reset();
          }}
          onConfirm={() => {
            commands.cancel.mutate('cancelled from the UI', {
              onSuccess: async () => {
                setOpen(null);
                await refresh();
              },
            });
          }}
        />
      ) : null}
      {open === 'return' ? (
        <ReturnDialog
          ticketKey={key}
          stages={offered.returnTo}
          current={task.current_stage ?? null}
          pending={commands.returnToStage.isPending}
          error={commands.returnToStage.isError ? commands.returnToStage.error : null}
          onClose={() => {
            setOpen(null);
            commands.returnToStage.reset();
          }}
          onConfirm={(stage, reason) => {
            commands.returnToStage.mutate(
              { stage, reason },
              {
                onSuccess: async () => {
                  setOpen(null);
                  await refresh();
                },
              },
            );
          }}
        />
      ) : null}
    </>
  );
};

/** A refused pause or resume, said under the card or row it was pressed on. */
const Refusal = ({
  commands,
}: {
  readonly commands: ReturnType<typeof useTaskCommands>;
}): ReactElement | null => {
  const error = commands.pause.error ?? commands.resume.error;
  return error === null ? null : <ErrorNotice title="That command was refused." error={error} />;
};

const CancelDialog = ({
  ticketKey,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  readonly ticketKey: string;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}): ReactElement => (
  <Dialog
    open
    onOpenChange={(next) => {
      if (!next) {
        onClose();
      }
    }}
    title={`Cancel ${sanitiseUntrusted(ticketKey)}?`}
    description="Cancelling ends the task for good: an agent working on it is stopped, nothing more runs, and it cannot be resumed. What it has spent stays on the record."
    footer={
      <>
        <Button onClick={onClose}>Keep the task</Button>
        <Button tone="danger" disabled={pending} onClick={onConfirm}>
          Cancel task
        </Button>
      </>
    }
  >
    {error === null ? undefined : <ErrorNotice title="The task was not cancelled." error={error} />}
  </Dialog>
);

const ReturnDialog = ({
  ticketKey,
  stages,
  current,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  readonly ticketKey: string;
  readonly stages: readonly string[];
  readonly current: string | null;
  readonly pending: boolean;
  readonly error: unknown;
  readonly onClose: () => void;
  readonly onConfirm: (stage: string, reason: string) => void;
}): ReactElement => {
  // The stage before the current one is the usual answer; the first entered when there is none.
  const before = current === null ? -1 : stages.indexOf(current) - 1;
  const [stage, setStage] = useState(stages[Math.max(0, before)] ?? stages[0] ?? '');
  const [reason, setReason] = useState('');
  const stageId = useId();
  const reasonId = useId();
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      title={`Return ${sanitiseUntrusted(ticketKey)} to a stage`}
      description="The task goes back to the stage you pick and runs it again from there. The stage is given your reason."
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            tone="primary"
            disabled={pending || reason.trim() === '' || stage === ''}
            onClick={() => {
              onConfirm(stage, reason);
            }}
          >
            Return to stage
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={stageId} className="text-sm font-medium">
            Stage
          </label>
          <select
            id={stageId}
            value={stage}
            onChange={(event) => {
              setStage(event.target.value);
            }}
            className="h-8 rounded-md border border-line-input bg-inset px-2 text-sm text-fg"
          >
            {stages.map((option) => (
              <option key={option} value={option}>
                {stageLabel(option)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={reasonId} className="text-sm font-medium">
            Reason
          </label>
          <textarea
            id={reasonId}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            rows={3}
            placeholder="What the stage should do differently"
            className="rounded-md border border-line-input bg-inset px-3 py-1.5 text-sm text-fg placeholder:text-fg-subtle"
          />
        </div>
        {error === null ? null : <ErrorNotice title="The task was not returned." error={error} />}
      </div>
    </Dialog>
  );
};

// ── The card and the row ─────────────────────────────────────────────────────

interface TaskViewProps {
  readonly task: TaskListItem;
  readonly projectKey: string;
  readonly projectId: string;
  readonly may: MenuCapabilities;
  readonly agent: AgentEntry | undefined;
  readonly nowMs: number;
}

/** The ticket key, muted, beside the template's icon. */
const KeyLine = ({ task }: { readonly task: TaskListItem }): ReactElement => (
  <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
    <TemplateIcon template={task.template} />
    <UntrustedText value={task.ticket.key} className="truncate font-mono" />
    {task.ticket_title === null ? <span>· Ticket not read yet</span> : null}
  </span>
);

/** The amber dot of an agent at work: the beacon's pulse, stopped by reduced motion. */
const WorkingDot = ({ agent }: { readonly agent: AgentEntry | undefined }): ReactNode =>
  agentWorking(agent) ? (
    <StatusIcon status="running" size={12} label="An agent is working on it" />
  ) : null;

export const TaskCard = ({ task, projectKey, projectId, may, agent, nowMs }: TaskViewProps) => {
  const commands = useTaskCommands(task.id);
  return (
    <article
      data-board-card={task.id}
      data-agent-working={agentWorking(agent) ? 'true' : undefined}
      aria-label={sanitiseUntrusted(task.ticket.key)}
      className={cx(
        'flex flex-col gap-2 rounded-lg border bg-default p-3 shadow-sm',
        agentWorking(agent) ? 'border-running/60' : 'border-line',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <KeyLine task={task} />
        <span className="-mt-1 -mr-1 flex shrink-0 items-center gap-1.5">
          <WorkingDot agent={agent} />
          <NeedsYouMarker task={task} />
          <TaskMenu task={task} projectId={projectId} may={may} commands={commands} />
        </span>
      </div>
      <p className="text-sm">
        <TitleLink task={task} projectKey={projectKey} />
      </p>
      <Phase task={task} agent={agent} nowMs={nowMs} />
      <MetaLine task={task} nowMs={nowMs} />
      <Badges task={task} />
      <Refusal commands={commands} />
    </article>
  );
};

/** The same task as an Issues-style row (the list view). */
export const TaskRow = ({ task, projectKey, projectId, may, agent, nowMs }: TaskViewProps) => {
  const commands = useTaskCommands(task.id);
  const activity = cardActivity(task, agent, nowMs);
  return (
    <li
      data-board-row={task.id}
      data-agent-working={agentWorking(agent) ? 'true' : undefined}
      className="flex min-h-12 items-start gap-3 px-4 py-2.5 hover:bg-subtle"
    >
      <div className="flex h-5 shrink-0 items-center">
        <StatusIcon
          status={ACTIVITY_META[activity.activity].icon}
          label={ACTIVITY_META[activity.activity].label}
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 text-sm">
          <TitleLink task={task} projectKey={projectKey} />
          <Badges task={task} />
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <KeyLine task={task} />
          <span className="text-xs text-fg-muted">
            {task.current_stage === null || task.current_stage === undefined
              ? TASK_STATE_LABEL[task.state]
              : `${stageLabel(task.current_stage)} · ${TASK_STATE_LABEL[task.state]}`}
          </span>
          <MetaLine task={task} nowMs={nowMs} />
        </span>
        <Refusal commands={commands} />
      </div>
      <span className="flex shrink-0 items-center gap-1.5">
        <WorkingDot agent={agent} />
        <NeedsYouMarker task={task} />
        <TaskMenu task={task} projectId={projectId} may={may} commands={commands} />
      </span>
    </li>
  );
};
