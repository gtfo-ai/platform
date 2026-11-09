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
 *    pulse while an agent is working, the loop badges (*Review round 2 of 3*), the conflict badge;
 *  - for a task that went back, why and what happens next in short form (S-25.11, `./setback.ts`):
 *    *CI failed · fixing, round 2/3* while the agent is on it — the loop badge of that round is then
 *    not drawn a second time — or *CI did not finish* when it stopped;
 *  - for a task stopped for a person (`needs_human`) with no structured stop, why it waits
 *    (S-25.15 part B, `./escalation-short.ts`): *Waiting for: Vojtěch Kaizr’s Jira ticket*, a
 *    reason key's short words, or *Needs a person · Refinement*;
 *  - while its CI check waits on a manual job a person must start (S-26.8b part 2, BACKLOG 1300, the
 *    item's `gate_wait`), *CI held · start the job* in that slot, and the task is *Needs you* through
 *    the one rule (`ui/task-status.ts`' `ciHeldNow`, active tasks only);
 *  - **why it waits** (S-26.8b part 2, the M26 UX spec § 4, `./waiting-words.tsx`): an open offer
 *    nobody takes now is the `waiting` activity's sub-label in short form — *Waiting · Vojtěch’s
 *    machine is offline*, *your machine* when it is the reader's — and nothing for `reason: null`;
 *  - while it is **queued**, its place and what holds it (S-25.16, the item's `queue_wait`,
 *    `./queue-words.ts`): *2nd in queue · 5 of 5 places taken* in place of the state's word.
 *
 * The menu's commands are the task page's, through the same `useTaskCommands` hook, so each sends
 * the same body with the same `Idempotency-Key` semantics: *Pause*, *Resume* and *Cancel* with the
 * page's reasons, *Return to stage…* with the stage and the person's reason. Cancel and Return are
 * Dialogs (a human's destructive or multi-field action, research/19 § 3.9); Pause and Resume are one
 * press. *Open ticket* and *Open merge request* are `ActionMenuLinkItem`s, so their `href` is `safeHref`'s.
 *
 * **The owner** (S-26.8b, the M26 UX spec § 3): the owner's avatar only — initials, with *Owner:
 * Vojtěch* as its accessible name and its tooltip — at the card's top right beside the menu (and in
 * the row's trailing slot). A card nobody owns shows nothing: an empty slot is not noise. The ◆ and
 * the *Needs you* column do not change with the owner.
 *
 * The card is **not** wrapped in a link: the title is the link into the task, and the menu carries
 * its own items — an anchor inside an anchor is invalid HTML. The title is the card's (and the
 * row's) stretched link instead (S-23.26, `ui/row-link.ts`): a click anywhere on either opens the
 * task, and the menu, the ticket's own link and the badges keep their clicks above it.
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
import { Avatar } from '../ui/avatar.js';
import { Counter } from '../ui/counter.js';
import { cx } from '../ui/cx.js';
import { Dialog } from '../ui/dialog.js';
import { stageLabel, titleCase } from '../ui/humanize.js';
import { Badge, Button, ErrorNotice, formatElapsed, formatUsd } from '../ui/kit.js';
import { PhaseTrack, phaseStagesFor } from '../ui/phase-track.js';
import { ROW_LINK_HOST, rowLink } from '../ui/row-link.js';
import { Select } from '../ui/select.js';
import { StatusIcon } from '../ui/status.js';
import { ciHeldNow, needsYou as needsYouOf, taskStateLabel } from '../ui/task-status.js';
import { UntrustedText } from '../ui/untrusted.js';
// A tooltip is text the browser renders, not markup — but it is still provider text, and
// `sanitiseUntrusted` is what strips the bidi overrides and control characters that make a line
// read backwards (CVE-2021-42574). `ExternalLink`'s own refusal tooltip does the same.
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import { loopRoundLabel } from '../ui/words/loops.js';
import { OWNER_WORDS } from '../ui/words/owners.js';
import { BOARD_COST_TITLE, unmeasuredRunsShortText, unmeasuredRunsText } from './cost-text.js';
import { escalationShort } from './escalation-short.js';
import { CI_HELD_SHORT } from './gate-wait-words.js';
import { PauseDialog } from './pause-dialog.js';
import { queueShort } from './queue-words.js';
import { openReturn, setbackShort } from './setback.js';
import { WaitingWords, waitingPlain, waitingShort, waitingTail } from './waiting-words.js';

/** One live run of the agents read, as the card reads it. */
export type AgentEntry = AgentsResponse['items'][number];

// ── What a card says ─────────────────────────────────────────────────────────

/** Questions plus approvals the task is waiting on. */
export const asksOf = (task: TaskListItem): number => task.open_questions + task.pending_approvals;

/**
 * Whether the task waits on a person — `ui/task-status.ts`' one definition, which the task page
 * reads too, so the card's ◆ and the page's state never disagree.
 */
export const needsYou = (task: TaskListItem): boolean => needsYouOf(needsYouInputOf(task));

/** What the one rule reads off a board item: its state, pause, asks and open CI wait. */
const needsYouInputOf = (task: TaskListItem) => ({
  state: task.state,
  paused_reason: task.paused_reason,
  open_asks: asksOf(task),
  gate_wait: task.gate_wait,
});

/** The state's word on the card and the row — the task header's, from the same rule. */
export const cardStateLabel = (task: TaskListItem): string => taskStateLabel(needsYouInputOf(task));

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
 * The loop badges, as rounds (S-25.4, product/10's Board amendment): *Review round 2 of 3* when the
 * task's frozen limit is known, *Review round 2* when it is not (`loop_limits: null`, or a loop the
 * limits do not name). A loop not yet gone round is not shown.
 */
export const loopBadges = (task: TaskListItem): readonly { loop: string; text: string }[] =>
  Object.entries(task.iteration_counters)
    .filter(([, count]) => count > 0)
    .map(([loop, count]) => ({
      loop,
      text: loopRoundLabel(loop, count, task.loop_limits?.[loop]),
    }));

/**
 * The card's short form of a held manual job (S-26.8b part 2), else of a return or a stop
 * (S-25.11), or `null`.
 */
export const cardSetback = (task: TaskListItem): string | null =>
  ciHeldNow(task)
    ? CI_HELD_SHORT
    : setbackShort(task, task.stages, task.latest_return, task.stop, task.loop_limits);

/**
 * Why a stopped task waits (S-25.15 part B, `./escalation-short.ts`): "Waiting for: Vojtěch
 * Kaizr’s Jira ticket", a key's short words, or "Needs a person · Refinement" — from the item's
 * `escalation_reason`, every name through `UntrustedText`.
 */
export const EscalationLine = ({ task }: { readonly task: TaskListItem }): ReactElement => {
  const stop = escalationShort({ ...task, reason: task.escalation_reason }, { stage: true });
  return (
    <span
      data-card-setback="escalated"
      data-card-escalation={stop.kind}
      className="text-xs text-attention"
    >
      <WaitingWords parts={stop.parts} />
    </span>
  );
};

/**
 * The short form's line, or nothing: a held job, a return or a structured stop (S-25.11), else —
 * for a task stopped for a person with none of those — why it waits ({@link EscalationLine}).
 */
export const SetbackLine = ({ task }: { readonly task: TaskListItem }): ReactElement | null => {
  const text = cardSetback(task);
  if (text === null && task.state === 'needs_human') {
    return <EscalationLine task={task} />;
  }
  const held = ciHeldNow(task);
  // The fixing line asks nothing of the reader, so it is muted; a stop or a held job keeps the
  // attention tone.
  const fixing = !held && openReturn(task, task.stages, task.latest_return) !== null;
  return text === null ? null : (
    <span
      data-card-setback={held ? 'ci_held' : fixing ? 'fixing' : 'stopped'}
      className={cx('text-xs', fixing ? 'text-fg-muted' : 'text-attention')}
    >
      {/* Platform words; a CI failure's job names are not in the short form. */}
      {text}
    </span>
  );
};

/** The live run's newest entry, in `activityOf`'s words. */
const latestOf = (agent: AgentEntry): LatestEntry | null =>
  agent.activity === null
    ? null
    : { kind: agent.activity.kind, tool_name: agent.activity.tool_name, at: agent.activity.at };

/**
 * What the task is doing: from its live run when an agent holds one, else from its state — and
 * while it waits for a machine, why (S-26.8b part 2): the `waiting` activity's sub-label is the
 * short form's tail, every name sanitised (a `PhaseTrack` takes a string).
 */
export const cardActivity = (
  task: TaskListItem,
  agent: AgentEntry | undefined,
  nowMs: number,
  viewerId: string | null = null,
): ActivityResult => {
  const doing = baseActivity(task, agent, nowMs);
  const tail = doing.activity === 'waiting' ? waitingTail(task.waiting, viewerId) : null;
  return tail === null ? doing : { activity: 'waiting', detail: waitingPlain(tail) };
};

const baseActivity = (
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
            start_failure: agent.run.start_failure,
            stop_reason: agent.run.stop_reason,
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
 * What the caller may do in this project — the tasks page's `can_cancel_task`,
 * `can_return_to_stage`, `can_pause_task` and `can_resume_task`, the routes' own `can()` over the
 * caller's role (S-23.9a; pause and resume since S-23.23).
 */
export interface MenuCapabilities {
  readonly cancel: boolean;
  readonly returnToStage: boolean;
  /** Left out, not consulted (the board always passes it). */
  readonly pause?: boolean;
  readonly resume?: boolean;
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
 * done or cancelled, no return for a task that entered no stage or was merged, and none of cancel,
 * return, pause or resume to a caller whose role the route would refuse.
 */
export const menuCommandsFor = (task: TaskListItem, may: MenuCapabilities): MenuCommands => {
  const ended = ENDED.has(task.state);
  const stages = [...new Set(task.stages.map((row) => row.stage))];
  const merged = MERGED_STATES.has(task.state) || stages.includes('merged_gate');
  return {
    pause:
      may.pause !== false &&
      !ended &&
      !merged &&
      task.state !== 'paused' &&
      task.state !== 'needs_human',
    resume: may.resume !== false && (task.state === 'paused' || task.state === 'needs_human'),
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
      title={`Touches the same files as ${sanitiseUntrusted(conflict.other_ticket_key)}: ${conflict.path_count} overlapping file(s)${
        conflict.truncated
          ? ', and the comparison did not read every file of both merge requests, so there may be more'
          : ''
      }. The comparison runs when either task reaches the up-to-date check, and both tasks are warned when it finds an overlap; a task with no badge has not been compared yet.`}
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
    {...rowLink('font-semibold break-words text-fg hover:text-link hover:underline')}
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
  // S-25.11: the round the setback line already says is not drawn a second time.
  const said = openReturn(task, task.stages, task.latest_return)?.loop ?? null;
  const loops = loopBadges(task).filter((badge) => badge.loop !== said);
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

/**
 * Why the task waits, in short form (the M26 UX spec § 4): "Waiting · Vojtěch’s machine is
 * offline", every name through `UntrustedText` — or nothing when nothing waits or somebody can
 * take it now.
 */
export const WaitingLine = ({
  task,
  viewerId,
}: {
  readonly task: TaskListItem;
  readonly viewerId: string | null;
}): ReactElement | null => {
  const parts = waitingShort(task.waiting, viewerId);
  return parts === null ? null : (
    <span data-card-waiting={task.waiting?.reason ?? ''} className="text-xs text-fg-muted">
      <WaitingWords parts={parts} />
    </span>
  );
};

/** The phase strip and, below it, what is happening — or the state's word when no agent is. */
export const Phase = ({
  task,
  agent,
  nowMs,
  viewerId = null,
}: {
  readonly task: TaskListItem;
  readonly agent: AgentEntry | undefined;
  readonly nowMs: number;
  /** The reader, for *your machine*. */
  readonly viewerId?: string | null;
}): ReactElement => {
  const stages = phaseStagesFor(null, task.stages, task.current_stage ?? null);
  const activity = cardActivity(task, agent, nowMs, viewerId);
  const live = agent !== undefined;
  // The waiting words take the state word's place only when nobody is needed: a task with an
  // open ask keeps its *Needs you* (the one rule's word) whatever its run waits for.
  const waiting = !needsYou(task) && waitingShort(task.waiting, viewerId) !== null;
  const queue = task.state === 'queued' ? (task.queue_wait ?? null) : null;
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
          {waiting ? (
            <WaitingLine task={task} viewerId={viewerId} />
          ) : queue !== null ? (
            // S-25.16: why it has not started — "2nd in queue · 5 of 5 places taken".
            <span data-card-queue={queue.status} className="text-fg-muted">
              {queueShort(queue)}
            </span>
          ) : (
            <span className="text-fg-muted">{cardStateLabel(task)}</span>
          )}
        </span>
      )}
    </div>
  );
};

// ── The menu and its dialogs ─────────────────────────────────────────────────

type OpenDialog = 'pause' | 'cancel' | 'return' | null;

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
              // S-25.23: a dialog asks for an optional why, which the pause records.
              setOpen('pause');
            }}
          >
            Pause…
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
          <ActionMenuLinkItem url={task.mr_ref.url} label="Open merge request" />
        )}
      </ActionMenu>
      {open === 'pause' ? (
        <PauseDialog
          ticketKey={key}
          pending={commands.pause.isPending}
          error={commands.pause.isError ? commands.pause.error : null}
          onClose={() => {
            setOpen(null);
            commands.pause.reset();
          }}
          onPause={(reason) => {
            commands.pause.mutate(reason, {
              onSuccess: async () => {
                setOpen(null);
                await refresh();
              },
            });
          }}
        />
      ) : null}
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

/** A refused resume, said under the card or row it was pressed on (a pause's is in its dialog). */
const Refusal = ({
  commands,
}: {
  readonly commands: ReturnType<typeof useTaskCommands>;
}): ReactElement | null => {
  const error = commands.resume.error;
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
          <Select
            id={stageId}
            value={stage}
            onChange={(event) => {
              setStage(event.target.value);
            }}
          >
            {stages.map((option) => (
              <option key={option} value={option}>
                {stageLabel(option)}
              </option>
            ))}
          </Select>
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
  /** The signed-in person, for *your machine* in the waiting words; `null` reads as nobody's. */
  readonly viewerId?: string | null;
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

/**
 * The owner's avatar, or nothing. The name is a person's own text, so the tooltip — a native
 * `title=`, which the row link's lift keeps hoverable — is sanitised like every other on the card.
 */
export const OwnerAvatar = ({ task }: { readonly task: TaskListItem }): ReactElement | null => {
  const owner = task.owner ?? null;
  if (owner === null) {
    return null;
  }
  const name = sanitiseUntrusted(
    owner.name.trim() === '' ? OWNER_WORDS['owner.nameless'] : owner.name,
  );
  const label = OWNER_WORDS['owner.card'](name);
  return (
    <span data-card-owner={owner.user_id} title={label} className="inline-flex">
      <Avatar name={name} size={20} label={label} />
    </span>
  );
};

export const TaskCard = ({
  task,
  projectKey,
  projectId,
  may,
  agent,
  nowMs,
  viewerId = null,
}: TaskViewProps) => {
  const commands = useTaskCommands(task.id);
  return (
    <article
      data-board-card={task.id}
      data-agent-working={agentWorking(agent) ? 'true' : undefined}
      aria-label={sanitiseUntrusted(task.ticket.key)}
      className={cx(
        ROW_LINK_HOST,
        // The ring a keyboard focus draws round the card follows its corners.
        'flex flex-col gap-2 rounded-lg border bg-default p-3 shadow-sm [--row-link-radius:var(--radius-lg)]',
        agentWorking(agent) ? 'border-running/60' : 'border-line',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <KeyLine task={task} />
        <span className="-mt-1 -mr-1 flex shrink-0 items-center gap-1.5">
          <WorkingDot agent={agent} />
          <NeedsYouMarker task={task} />
          <OwnerAvatar task={task} />
          <TaskMenu task={task} projectId={projectId} may={may} commands={commands} />
        </span>
      </div>
      <p className="text-sm">
        <TitleLink task={task} projectKey={projectKey} />
      </p>
      <Phase task={task} agent={agent} nowMs={nowMs} viewerId={viewerId} />
      <SetbackLine task={task} />
      <MetaLine task={task} nowMs={nowMs} />
      <Badges task={task} />
      <Refusal commands={commands} />
    </article>
  );
};

/** The same task as an Issues-style row (the list view). */
export const TaskRow = ({
  task,
  projectKey,
  projectId,
  may,
  agent,
  nowMs,
  viewerId = null,
}: TaskViewProps) => {
  const commands = useTaskCommands(task.id);
  const activity = cardActivity(task, agent, nowMs, viewerId);
  return (
    <li
      data-board-row={task.id}
      data-agent-working={agentWorking(agent) ? 'true' : undefined}
      className={cx(ROW_LINK_HOST, 'flex min-h-12 items-start gap-3 px-4 py-2.5')}
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
              ? cardStateLabel(task)
              : `${stageLabel(task.current_stage)} · ${cardStateLabel(task)}`}
          </span>
          <MetaLine task={task} nowMs={nowMs} />
        </span>
        <WaitingLine task={task} viewerId={viewerId} />
        <SetbackLine task={task} />
        <Refusal commands={commands} />
      </div>
      <span className="flex shrink-0 items-center gap-1.5">
        <WorkingDot agent={agent} />
        <NeedsYouMarker task={task} />
        <OwnerAvatar task={task} />
        <TaskMenu task={task} projectId={projectId} may={may} commands={commands} />
      </span>
    </li>
  );
};
