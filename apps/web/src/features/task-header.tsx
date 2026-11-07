/**
 * The task page's header (S-23.9b, research/19 § 3 item 1 and § 5.2 "Task"): what the task is,
 * where it is, and the **one** thing to do now.
 *
 * - The title is the ticket's own title (untrusted, BD-022) with the key after it in muted text, as
 *   GitHub shows `#573`; a task whose ticket title was never read shows its key alone.
 * - A `StateLabel` — its icon and its word from `ui/task-status.ts`' one rule, the board's column
 *   and card's (S-25.4) — and one meta line: the ticket and merge request links, the template, the
 *   stage in words, what it has cost so far and how long ago it was opened; then the `PhaseTrack`.
 *   Its *Now* line says, for a task that went back (S-25.11, `./setback.ts`), the board card's
 *   short form — "CI failed · fixing, round 2/3" while the agent is on it, "CI did not finish" when
 *   it stopped — in place of the activity's sub-label; and while the CI check waits (S-25.12, the
 *   read's `gate_wait`, `./gate-wait.tsx`), what it waits for: "CI running · 12 min of 60", or
 *   "CI waits for someone to start the manual job X". A held manual job is *Needs you* at once,
 *   through the one rule (`ciHeldNow` over the read's `gate_wait`, active tasks only). And while
 *   its run waits for a machine nobody has (S-26.8b part 2, `./waiting-words.tsx`), why, in the
 *   long form: "Waiting for Vojtěch’s machine. It’s offline (last seen 2 h ago)." — the callout
 *   says it again with the next steps.
 * - **One primary action, chosen by the state** — the page's, decided once by `./page-primary.ts`
 *   and shared with the callout (S-25.15): *Hand back…* while a take-over is in force, *Answer*
 *   for an open question (it moves focus into the callout's answer box), *Review plan* for a
 *   pending approval (it moves focus onto the callout's approval card, where the plan is shown
 *   open beside *Approve* and *Reject…* — S-25.1; there is no second, subject-less approve
 *   dialog), *Raise this task's cap…* for a task its own cap paused when the caller may raise it,
 *   *Start the job in GitLab* — a link to the held job's page (or its pipeline's) — while the CI
 *   check waits on a manual job (S-25.12), *Resume* for a paused or escalated task — or none.
 *   Two stops have no *Resume* here because the callout's own button is the page's primary: a
 *   ticket somebody else holds (S-25.14, *Take it* when the reader may take it, nothing otherwise,
 *   `./ticket-held-elsewhere.tsx`), and a structured stop whose next step is "retry the stage"
 *   (S-25.15, the callout's *Retry stage…*); *Resume* is then in the `···` menu.
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
 * past an open question or a pending approval would skip it, so the page never offers it; since
 * S-27.1 the server refuses a resume past a pending approval too (`409 approval_pending`, BACKLOG
 * 854).
 *
 * **The owner** (S-26.8b, the M26 UX spec § 2, `./task-owner.tsx`): beside the ticket's links, the
 * owner's avatar and name, *Unassigned*, or the tracker assignee the platform cannot link; and the
 * one **secondary** owner button — *Take it* or *Unassign*, as the read's `can_take` /
 * `can_unassign` allow — with every owner action in the `···` menu too. Never the primary.
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
import { buttonClassName } from '../ui/button.js';
import { stageLabel, titleCase } from '../ui/humanize.js';
import { Badge, Button, formatElapsed, formatUsd } from '../ui/kit.js';
import { PageHeader } from '../ui/page-header.js';
import { PhaseTrack, phaseStagesFor } from '../ui/phase-track.js';
import { StateLabel } from '../ui/status.js';
import { taskStateLabel, taskStatus } from '../ui/task-status.js';
import { DownloadLink, ExternalLink, UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import { trackerName } from '../ui/words/owners.js';
import { approvalCardId } from './approval-card.js';
import { reviewVerb } from './approval-text.js';
import {
  gateWaitHeld,
  gateWaitJobUrl,
  gateWaitShort,
  openGateWait,
  providerName,
} from './gate-wait.js';
import { liveStageRun } from './live-stage.js';
import type { TaskPrimaryAction } from './page-primary.js';
import { setbackShort } from './setback.js';
import { takeOverFinished } from './take-over.js';
import { answerInputId } from './task-callout.js';
import type { TaskDialog } from './task-dialogs.js';
import { type OwnerControl, OwnerFeedback, OwnerLine, OwnerMenuItems } from './task-owner.js';
import { TicketClaimAndQa } from './ticket-claim.js';
import { waitingLong, waitingPlain } from './waiting-words.js';

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
  owner,
  primary,
  projectName = null,
}: {
  readonly detail: TaskDetailResponse;
  /**
   * The page's one primary (`./page-primary.ts`' `taskPagePrimary`, asked once by the page and
   * shared with the callout). `take` and `retry_stage` are the callout's buttons: none here.
   */
  readonly primary: TaskPrimaryAction;
  /** The board's key, when the projects read has it: the back link. */
  readonly projectKey: string | null;
  /** The page's one owner control (`./task-owner.tsx`), shared with the callout's next steps. */
  readonly owner: OwnerControl;
  /** The project's name, for the waiting words' "in Autix". */
  readonly projectName?: string | null;
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
  // S-25.12: a pipeline held at a manual job waits for a person, and the one next step is the job.
  // Only while the task is active: a paused task's CI check is not checking (review of PR #101).
  const gateWait = openGateWait(detail);
  const ciHeld = gateWaitHeld(gateWait);
  // S-26.8b part 2: why the run waits for a machine, in the long form.
  const waiting = waitingLong(task.waiting, {
    viewerId: owner.viewer?.id ?? null,
    nowMs,
    project: projectName,
    tracker: trackerName(task.ticket.provider),
  });
  const heldJobUrl = gateWait !== null && ciHeld ? gateWaitJobUrl(gateWait) : null;
  const needsYouInput = {
    state: task.state,
    paused_reason: task.paused_reason,
    open_asks: openQuestions.length + pendingApprovals.length,
    taken_over: takenOver !== null,
    // The one rule reads the open CI wait itself, and only for an active task (`ciHeldNow`).
    gate_wait: detail.gate_wait,
  };
  const liveRun = liveStageRun(runs);
  const doing = activityOf({
    run: liveRun,
    role: liveRun?.role ?? null,
    task_state: task.state,
    open_asks: openQuestions.length + pendingApprovals.length,
    now: nowMs,
  });
  // S-25.12: while the CI check waits, what it waits for; else (S-25.11) why it went back, or
  // why it stopped, in the board card's words.
  const setback =
    gateWait === null
      ? setbackShort(task, stages, detail.returns.at(-1) ?? null, detail.stop, detail.loop_limits)
      : // Provider text (the job's name) on its way into a string prop: bidi and controls removed.
        sanitiseUntrusted(gateWaitShort(gateWait, nowMs));
  // The `waiting` activity's sub-label is why (names sanitised: `PhaseTrack` takes a string).
  const now =
    setback ?? (doing.activity === 'waiting' && waiting !== null ? waitingPlain(waiting) : null);
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
        Give it back to the agent…
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
    ) : primary === 'start_job' && heldJobUrl !== null ? (
      // The held job's own page (or its pipeline's), through `safeHref` inside `ExternalLink`.
      <ExternalLink
        url={heldJobUrl}
        label={`Start the job in ${providerName(task.mr_ref?.provider)}`}
        className={buttonClassName('primary')}
      />
    ) : primary === 'resume' ? (
      <Button tone="primary" disabled={commands.resume.isPending} onClick={resume}>
        Resume
      </Button>
    ) : null;

  // A finished task with nothing to download has nothing in the menu, so it draws no `···`.
  const commandItems = canPause || (canResume && primary !== 'resume') || canTakeOver;
  const anyItem =
    owner.offers.length > 0 ||
    canPause ||
    canResume ||
    canTakeOver ||
    stageOptions > 0 ||
    canRaise ||
    detail.can_export ||
    canCancel;
  const menu = !anyItem ? null : (
    <ActionMenu label="Task actions">
      {/* S-26.8b: the owner's actions first, as the line's one button offers the first of them. */}
      <OwnerMenuItems control={owner} />
      {owner.offers.length > 0 && commandItems ? <ActionMenuSeparator /> : null}
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
          Work on it yourself…
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
            {/* S-26.8b: who owns it, beside the ticket, and the one secondary owner control. */}
            <span aria-hidden="true">·</span>
            <OwnerLine detail={detail} control={owner} />
            <span>{`· ${titleCase(task.template)}`}</span>
            {currentStage === null ? null : <span>{`· ${stageLabel(currentStage)}`}</span>}
            <span>{`· ${formatUsd(task.cost_actual_usd)} so far`}</span>
            <span>{`· opened ${formatElapsed(task.created_at, nowMs)} ago`}</span>
            {task.mode === 'shadow' ? <Badge tone="warning">shadow</Badge> : null}
          </p>
          <OwnerFeedback detail={detail} control={owner} />
          {/* WP-182 ruling (c): the ticket claim and the human QA stage (BD-031 rulings 3 and 5). */}
          <TicketClaimAndQa task={task} />
          {phase.length === 0 ? null : (
            <PhaseTrack stages={phase} activity={doing.activity} detail={now ?? doing.detail} />
          )}
        </div>
      }
    />
  );
};
