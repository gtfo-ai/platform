/**
 * The task page's header (S-23.9b, research/19 § 3 item 1 and § 5.2 "Task"): what the task is,
 * where it is, and the **one** thing to do now.
 *
 * - The title is the ticket's own title (untrusted, BD-022) with the key after it in muted text, as
 *   GitHub shows `#573`; a task whose ticket title was never read shows its key alone.
 * - A `StateLabel` — its icon and its word from `ui/task-status.ts`' one rule, the board's column
 *   and card's (S-25.4) — and one meta line: the ticket and merge request links, the template, the
 *   stage in words, what it has cost so far and how long ago it was opened; then the `PhaseTrack`.
 * - **One primary action, chosen by the state** ({@link taskPrimaryAction}): *Hand back…* while a
 *   take-over is in force, *Answer* for an open question (it moves focus into the callout's answer
 *   box), *Review plan* for a pending approval (it moves focus onto the callout's approval card,
 *   where the plan is shown open beside *Approve* and *Reject…* — S-25.1; there is no second,
 *   subject-less approve dialog), *Raise this task's cap…* for a task its own cap paused
 *   when the caller may raise it, *Resume* for a paused or escalated task — or none.
 *   Everything else is in the `···` menu, and a command with fields or no undo opens a dialog
 *   (`./task-dialogs.tsx`).
 *
 * **Which commands are here.** technical/09's screens table gives this screen `answer, approve,
 * retry, take over, feedback`; product/10 adds return-to-stage and rework. All of them are present:
 * pause, resume, cancel, answer, decide, retry-stage, return-to-stage, rework, feedback (the
 * Overview), take over and hand back (WP-44), raising the task's own cap (WP-131) and the record's
 * download (WP-122). A command the server refuses for every caller is not offered: no Pause or
 * Take over on a merged task (WP-194), and no return or rework there either (its way out is the
 * retrospective), no take-over of a finished one, no stage command on a task that has entered no
 * stage. Some are left out **by choice**: no Pause or Take over on a queued task (nothing runs
 * yet), no Take over on a task a person paused (the pause already stops it), no Cancel once the
 * task is merged or in its retrospective (the change is in the default branch; what is left is the
 * record) — and Resume only for a task that is **paused** or **waiting for a person**. The server's
 * resume admits more than that (`RESUMABLE_TASK_STATES` includes `waiting_approval`), but resuming
 * past an open question or a pending approval would skip it, so the page never offers it (BACKLOG
 * 854 has the server half).
 *
 * **And only what the caller's role may do** (S-23.23): the read carries `can_pause`, `can_resume`,
 * `can_cancel`, `can_return`, `can_rework` and `can_decide_approval` — each the command route's own
 * permission over the caller's effective role — and a command whose flag is false is not offered
 * (no menu item, never the primary). The callout says who may decide what the caller cannot.
 */
import type { TaskDetailResponse, TaskState } from '@platform/contracts';
import { ArrowLeftIcon } from '@primer/octicons-react/ArrowLeftIcon';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { taskExportPath } from '../api/endpoints.js';
import type { useTaskCommands } from '../app/queries.js';
import {
  ActionMenu,
  ActionMenuDownloadItem,
  ActionMenuItem,
  ActionMenuSeparator,
} from '../ui/action-menu.js';
import { activityOf } from '../ui/activity.js';
import { stageLabel, titleCase } from '../ui/humanize.js';
import { Badge, Button, formatElapsed, formatUsd } from '../ui/kit.js';
import { PageHeader } from '../ui/page-header.js';
import { PhaseTrack, phaseStagesFor } from '../ui/phase-track.js';
import { StateLabel } from '../ui/status.js';
import { taskStateLabel, taskStatus } from '../ui/task-status.js';
import { DownloadLink, ExternalLink, UntrustedText } from '../ui/untrusted.js';
import { approvalCardId } from './approval-card.js';
import { reviewVerb } from './approval-text.js';
import { liveStageRun } from './live-stage.js';
import { takeOverFinished } from './take-over.js';
import { answerInputId } from './task-callout.js';
import type { TaskDialog } from './task-dialogs.js';
import { TicketClaimAndQa } from './ticket-claim.js';

/** The header's one primary action. */
export type TaskPrimaryAction =
  | 'hand_back'
  | 'answer'
  | 'approve'
  | 'raise_budget'
  | 'resume'
  | null;

/**
 * Which action is primary, by what the task is waiting for: the person who holds it, then the
 * agent's question, then a maintainer's approval, then the cap that paused it, then a resume — the
 * first that applies.
 */
export const taskPrimaryAction = (input: {
  readonly state: TaskState;
  /** The take-over in force has a stage it can be handed back to. */
  readonly canHandBack: boolean;
  readonly openQuestions: number;
  readonly pendingApprovals: number;
  /** The task's own cap paused it and the caller may raise it. */
  readonly canRaise?: boolean;
  /**
   * Whether the caller may decide an approval and resume the task (S-23.23, the read's
   * `can_decide_approval` and `can_resume`). Left out, they are not consulted — the page always
   * passes them; a caller who may not is never offered the action as the page's primary.
   */
  readonly canDecide?: boolean;
  readonly canResume?: boolean;
}): TaskPrimaryAction => {
  if (input.canHandBack) {
    return 'hand_back';
  }
  if (input.openQuestions > 0) {
    return 'answer';
  }
  if (input.pendingApprovals > 0 && input.canDecide !== false) {
    return 'approve';
  }
  if (input.canRaise === true) {
    return 'raise_budget';
  }
  return input.canResume !== false && (input.state === 'paused' || input.state === 'needs_human')
    ? 'resume'
    : null;
};

/**
 * States the page offers a resume from — by choice, a subset of what the server admits: a resume
 * past an open question or approval would skip it (see the module note, BACKLOG 854).
 */
const RESUMABLE: ReadonlySet<TaskState> = new Set<TaskState>(['paused', 'needs_human']);

export const TaskHeader = ({
  detail,
  projectKey,
  nowMs,
  stageOptions,
  commands,
  onOpen,
}: {
  readonly detail: TaskDetailResponse;
  /** The board's key, when the projects read has it: the back link. */
  readonly projectKey: string | null;
  readonly nowMs: number;
  /** Whether the stage commands have a stage to address. */
  readonly stageOptions: number;
  readonly commands: ReturnType<typeof useTaskCommands>;
  readonly onOpen: (dialog: TaskDialog) => void;
}): ReactElement => {
  const { task, stages, runs, questions, approvals, taken_over: takenOver } = detail;
  const openQuestions = questions.filter((question) => question.status === 'open');
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');
  // The task entered `merged_gate` (WP-152's test, the server's own fact): since WP-165 the server
  // refuses Pause and Take over on it (`409 task_merged`), so neither is offered (WP-194).
  const merged = stages.some((entry) => entry.stage === 'merged_gate');
  const finished = takeOverFinished(task.state);
  // WP-131 review round 2: only a task **its own cap** paused, and only for a caller the route
  // would admit (`can_raise_budget`, `budget.write`). A project's or an organisation's pause is
  // raised where that cap is set, and the route refuses it too (409 `not_paused_by_task_cap`).
  const canRaise =
    detail.can_raise_budget &&
    task.state === 'paused' &&
    task.paused_reason === 'budget' &&
    task.paused_budget_scope === 'task';
  const primary = taskPrimaryAction({
    state: task.state,
    canHandBack: takenOver !== null && takenOver.hand_back_stages.length > 0,
    openQuestions: openQuestions.length,
    pendingApprovals: pendingApprovals.length,
    canRaise,
    canDecide: detail.can_decide_approval,
    canResume: detail.can_resume,
  });
  const needsYouInput = {
    state: task.state,
    paused_reason: task.paused_reason,
    open_asks: openQuestions.length + pendingApprovals.length,
    taken_over: takenOver !== null,
  };
  const liveRun = liveStageRun(runs);
  const doing = activityOf({
    run: liveRun,
    role: liveRun?.role ?? null,
    task_state: task.state,
    open_asks: openQuestions.length + pendingApprovals.length,
    now: nowMs,
  });
  const currentStage = task.current_stage ?? null;
  // A task that has entered no stage has no strip to draw; the Overview says it has none.
  const phase = phaseStagesFor(null, stages, currentStage);
  const queued = task.state === 'queued';
  // S-23.23: and only what the caller's role may do — the read's `can_*` flags, each the command
  // route's own permission. A command the caller may not use is left out of the menu.
  const canPause = detail.can_pause && !merged && !finished && !queued && task.state !== 'paused';
  const canResume = detail.can_resume && RESUMABLE.has(task.state);
  const canTakeOver =
    takenOver === null &&
    !finished &&
    !merged &&
    !queued &&
    !(task.state === 'paused' && task.paused_reason === 'manual');
  // Merged or in its retrospective: the change is in the default branch, so no cancel is offered.
  const canCancel =
    detail.can_cancel && !finished && task.state !== 'merged' && task.state !== 'retro';
  const canReturn = detail.can_return && !merged;
  const canRework = detail.can_rework && !merged;

  const resume = (): void => {
    commands.resume.mutate('resumed from the UI');
  };

  const primaryButton =
    primary === 'hand_back' ? (
      <Button
        tone="primary"
        onClick={() => {
          onOpen('hand_back');
        }}
      >
        Hand back…
      </Button>
    ) : primary === 'answer' ? (
      <Button
        tone="primary"
        onClick={() => {
          const [first] = openQuestions;
          if (first !== undefined) {
            const box = document.getElementById(answerInputId(first.id));
            box?.scrollIntoView({ block: 'center' });
            box?.focus();
          }
        }}
      >
        Answer
      </Button>
    ) : primary === 'approve' ? (
      <Button
        tone="primary"
        onClick={() => {
          // The same card the callout draws (S-25.1): the plan is there, open, beside its buttons —
          // so this moves the reader to it rather than deciding from a dialog that shows nothing.
          const [first] = pendingApprovals;
          if (first !== undefined) {
            const card = document.getElementById(approvalCardId(first.id));
            card?.scrollIntoView({ block: 'start' });
            card?.focus();
          }
        }}
      >
        {reviewVerb(pendingApprovals[0]?.kind ?? 'plan')}
      </Button>
    ) : primary === 'raise_budget' ? (
      <Button
        tone="primary"
        onClick={() => {
          onOpen('raise_budget');
        }}
      >
        Raise this task's cap…
      </Button>
    ) : primary === 'resume' ? (
      <Button tone="primary" disabled={commands.resume.isPending} onClick={resume}>
        Resume
      </Button>
    ) : null;

  // A finished task with nothing to download has nothing in the menu, so it draws no `···`.
  const anyItem =
    canPause ||
    canResume ||
    canTakeOver ||
    stageOptions > 0 ||
    canRaise ||
    detail.can_export ||
    canCancel;
  const menu = !anyItem ? null : (
    <ActionMenu label="Task actions">
      {canPause ? (
        <ActionMenuItem
          disabled={commands.pause.isPending}
          onSelect={() => {
            commands.pause.mutate('paused from the UI');
          }}
        >
          Pause
        </ActionMenuItem>
      ) : null}
      {canResume && primary !== 'resume' ? (
        <ActionMenuItem disabled={commands.resume.isPending} onSelect={resume}>
          Resume
        </ActionMenuItem>
      ) : null}
      {canTakeOver ? (
        <ActionMenuItem
          onSelect={() => {
            onOpen('take_over');
          }}
        >
          Take over…
        </ActionMenuItem>
      ) : null}
      {stageOptions === 0 ? null : (
        <>
          <ActionMenuSeparator />
          <ActionMenuItem
            onSelect={() => {
              onOpen('retry');
            }}
          >
            Retry stage…
          </ActionMenuItem>
          {/* A merged task never goes back before the merge (WP-152): the callout says so too. */}
          {canReturn ? (
            <ActionMenuItem
              onSelect={() => {
                onOpen('return');
              }}
            >
              Return to stage…
            </ActionMenuItem>
          ) : null}
          {canRework ? (
            <ActionMenuItem
              onSelect={() => {
                onOpen('rework');
              }}
            >
              Rework…
            </ActionMenuItem>
          ) : null}
        </>
      )}
      {canRaise && primary !== 'raise_budget' ? (
        <ActionMenuItem
          onSelect={() => {
            onOpen('raise_budget');
          }}
        >
          Raise this task's cap…
        </ActionMenuItem>
      ) : null}
      {/*
        product/09's *"Export as JSON per task"* (WP-112's route, WP-122's link, backlog 381):
        offered only to a caller the route would admit (`can_export`, `task.export`), through
        `DownloadLink` — the one renderer that may write a URL attribute.
      */}
      {detail.can_export ? (
        <>
          <ActionMenuSeparator />
          <ActionMenuDownloadItem
            render={<DownloadLink path={taskExportPath(task.id)} label="Download JSON" />}
          />
        </>
      ) : null}
      {!canCancel ? null : (
        <>
          <ActionMenuSeparator />
          <ActionMenuItem
            tone="danger"
            onSelect={() => {
              onOpen('cancel');
            }}
          >
            Cancel task…
          </ActionMenuItem>
        </>
      )}
    </ActionMenu>
  );

  const title =
    task.ticket_title === null || task.ticket_title.trim() === '' ? null : task.ticket_title;

  return (
    <PageHeader
      back={
        projectKey === null ? undefined : (
          <Link
            to="/projects/$key"
            params={{ key: projectKey }}
            className="inline-flex items-center gap-1 hover:text-fg hover:underline"
          >
            <ArrowLeftIcon size={16} />
            Back to the board
          </Link>
        )
      }
      title={
        title === null ? (
          <UntrustedText value={task.ticket.key} />
        ) : (
          <>
            <UntrustedText value={title} />{' '}
            <span className="font-normal text-fg-muted">
              <UntrustedText value={task.ticket.key} />
            </span>
          </>
        )
      }
      actions={
        <>
          {primaryButton}
          {menu}
        </>
      }
      state={
        // S-25.4: the icon and the word from the one rule the board's column and card read.
        <StateLabel status={taskStatus(needsYouInput)}>{taskStateLabel(needsYouInput)}</StateLabel>
      }
      meta={
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            {/*
              S-25.4 (product/10's Header amendment): the ticket and the merge request beside the
              key, rather than at the bottom of the right rail. Provider URLs, through
              `ExternalLink` (`safeHref`): a link that is not http(s) is shown struck through.
            */}
            <span data-task-links="" className="inline-flex flex-wrap items-center gap-x-2">
              <ExternalLink url={task.ticket.url} label="Ticket" className="text-link underline" />
              {task.mr_ref === null || task.mr_ref === undefined ? null : (
                <ExternalLink
                  url={task.mr_ref.url}
                  label="Merge request"
                  className="text-link underline"
                />
              )}
            </span>
            <span>{`· ${titleCase(task.template)}`}</span>
            {currentStage === null ? null : <span>{`· ${stageLabel(currentStage)}`}</span>}
            <span>{`· ${formatUsd(task.cost_actual_usd)} so far`}</span>
            <span>{`· opened ${formatElapsed(task.created_at, nowMs)} ago`}</span>
            {task.mode === 'shadow' ? <Badge tone="warning">shadow</Badge> : null}
          </p>
          {/* WP-182 ruling (c): the ticket claim and the human QA stage (BD-031 rulings 3 and 5). */}
          <TicketClaimAndQa task={task} />
          {phase.length === 0 ? null : (
            <PhaseTrack stages={phase} activity={doing.activity} detail={doing.detail} />
          )}
        </div>
      }
    />
  );
};
