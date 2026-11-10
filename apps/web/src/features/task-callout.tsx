/**
 * The task page's **needs-you callout** (S-23.9b; research/19 § 3 item 2 and § 5.2 "Task"): what a
 * person must do on this task, first on the page, with the action **inline**.
 *
 * Five things put it there, in this order:
 *
 * - **open questions** — each answered here, with the same `answer` command the inbox sends; the
 *   agent wrote the question, so it is rendered as text (BD-022);
 * - **pending approvals** — each **with what it approves** (S-25.1, `./approval-card.tsx`): the
 *   plan shown open, the reasons it was asked, what each answer does next and how to stop being
 *   asked; approved here, or rejected through a confirmation with a reason (`decide`), by a caller
 *   who may decide them (`can_decide_approval`); anyone else is told a maintainer decides;
 * - **the task waiting for a person** (`needs_human`) — what stopped it, as the stage row's own
 *   outcome sentence, and the three ways out (return, rework, retry), which open the same dialogs as
 *   the header's `···` menu. It leads with **the escalation's own brief** (the read's
 *   `escalation`, BACKLOG 850) — what stopped the task and the way out, as the platform wrote it
 *   when it stopped — and falls back to the escalated attempt's recorded word when there is none.
 *   A ticket somebody else holds (S-25.14, the escalation's reason key `ticket_assigned_elsewhere`)
 *   is a structured stop of its own (`./ticket-held-elsewhere.tsx`): whose ticket it is, from the
 *   task's `tracker_assignee`, leads, the ways out are in the box, and the brief is under *Details*.
 *   Beside a structured stop (`detail.stop`), whose next step says to retry the stage, the
 *   *Retry stage…* here is the page's one amber primary (S-25.15, `./page-primary.ts`);
 * - **a budget pause** — whose cap is spent, and where it is raised (the header's primary raises
 *   a task's own cap);
 * - **a proposed breakdown waiting for a maintainer** — the epic split's panel, with its decision.
 *   A breakdown with nothing left to decide, or a caller who may not decide it, is on the Overview.
 *
 * None of it is shown for a task nothing waits on, so its absence is itself an answer — except one
 * sentence that asks nothing (S-25.11, product/10's 2026-11-07 amendment): while a task that went
 * back is being worked on at the stage it went back to, the slot says why it went back, who acts and
 * which round it is (`./setback.ts`), as information with no action. And a task that stopped after
 * going back says which way it stopped — the rounds used up, the same failure again, or a check that
 * got no answer (nothing failed; the sentence the platform recorded follows) — and the next step.
 *
 * **While the CI check waits, it says what it waits for** (S-25.12, the read's `gate_wait`,
 * `./gate-wait.tsx`): a pipeline **held at a manual job** is a sixth reason the callout is there —
 * *Needs you* at once, with the job linked and "Start it there and the task continues" — and a
 * pipeline still running is said in the slot as information ("CI is running (pipeline n, 12 min so
 * far; the task gives up after 60)"). A CI check that stopped with no answer is worded from the
 * attempt's `last_gate_wait` when it recorded one ("CI did not finish within 60 minutes: pipeline n
 * was still held at the manual job X."; "…so Retry did not wait again."); only an attempt with no
 * read (before the worker session's #89) quotes the recorded sentence after *What the platform saw
 * last:*.
 *
 * **At Ready, over a pipeline the provider still shows blocked** (S-27.2, TD-036 decision 7,
 * `./ci-manual-not-run.tsx`): when the latest CI pass left blocking manual jobs nobody started and
 * the record says the pipeline is still `manual`, the slot says, as information and never *Needs
 * you*: "GitLab shows pipeline n, the latest for this commit, as blocked at the manual job X. If
 * this project requires pipelines to succeed, GitLab won’t merge it until X has run: start it on
 * GitLab." It never says the merge request can be merged (BD-007: a person merges).
 *
 * **While its run waits for a machine nobody has** (S-26.8b part 2, the M26 UX spec § 4,
 * `./waiting-notice.tsx`): why, in the long form, and the next steps the reader may take — *Take
 * it* / *Assign…* through the header's owner control, *Open Workers* for the machine's owner,
 * *Open Instance* or *Link account…* for an administrator. Information, never *Needs you*: it is
 * drawn above whatever else the slot says, and nothing for `reason: null`.
 *
 * **While it is queued, what holds it and what frees it** (S-25.16, the read's `queue_wait`,
 * `./queue-wait-notice.tsx`): the limit that is full, how many of the tasks holding it wait for a
 * person, those tasks as links, this task's place in the queue and *Change the limit* for a reader
 * who may. Neutral information, never *Needs you*.
 *
 * **While a person has paused it, who, when and why** (S-25.20, the read's `manual_pause`): who
 * paused it — or that a *Cancel run* did — when, what they gave as the reason, and *Resume* for a
 * reader who may. Neutral information, never *Needs you*.
 *
 * **The escalation's order** (S-25.20): the cause leads (the brief, or the stop's sentence), then
 * its next step, and the options sentence ("This task is waiting for a person. Send it back…")
 * comes last, beside the buttons it describes — AUT-6655 read generic-first.
 */
import {
  type ApprovalView,
  type QuestionRecord,
  RUN_CANCEL_PAUSE_REASON,
  type TaskDetailResponse,
  type TaskManualPause,
  type TaskRecord,
} from '@platform/contracts';
import { type ReactElement, useState } from 'react';
import type { useTaskCommands } from '../app/queries.js';
import { Flash } from '../ui/flash.js';
import { APPROVAL_KIND_LABEL, QUESTION_STATUS_LABEL, stageLabel } from '../ui/humanize.js';
import { Badge, Button, Card, ErrorNotice, formatDateTime, formatUsd } from '../ui/kit.js';
import { ExternalLink, UntrustedProse, UntrustedText } from '../ui/untrusted.js';
import { ApprovalCard } from './approval-card.js';
import { BreakdownPanel } from './breakdown-panel.js';
import { ReadyBlockedNotice, readyBlockedPipeline } from './ci-manual-not-run.js';
import { CiWaitStop, GateWaitNotice, gateWaitHeld, openGateWait } from './gate-wait.js';
import { type TaskPrimaryAction, taskPagePrimary } from './page-primary.js';
import { QueueWaitNotice } from './queue-wait-notice.js';
import { openReturn, returnWords, stopWords } from './setback.js';
import { stageOutcomeSentence } from './stage-outcome.js';
import { latestStageRow } from './task-checks-text.js';
import type { TaskDialog } from './task-dialogs.js';
import type { OwnerControl } from './task-owner.js';
import { HeldElsewhere } from './ticket-held-elsewhere.js';
import { heldElsewhereStop } from './ticket-held-words.js';
import { WaitingNotice } from './waiting-notice.js';
import { waitingReason } from './waiting-words.js';

type TaskCommands = ReturnType<typeof useTaskCommands>;

/** The id of a question's answer box, so the header's *Answer* can move focus into it. */
export const answerInputId = (questionId: string): string => `answer-${questionId}`;

const QuestionCard = ({
  question,
  onAnswer,
  pending,
}: {
  readonly question: QuestionRecord;
  readonly onAnswer: (answer: string) => void;
  readonly pending: boolean;
}): ReactElement => {
  const [answer, setAnswer] = useState('');
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Badge tone={question.blocking ? 'warning' : 'neutral'}>
          {question.blocking ? 'blocking' : 'non-blocking'}
        </Badge>
        <span className="text-xs text-fg-muted">{stageLabel(question.stage)}</span>
        <span className="ml-auto text-xs text-fg-muted">{formatDateTime(question.asked_at)}</span>
      </div>
      {/* Written by an agent: rendered, never executed (BD-022). */}
      <UntrustedProse value={question.text} />
      {question.options === null || question.options === undefined ? null : (
        <ul className="flex flex-wrap gap-2">
          {question.options.map((option) => (
            <li key={option}>
              <Button
                onClick={() => {
                  setAnswer(option);
                }}
              >
                <UntrustedText value={option} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {question.status === 'open' ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onAnswer(answer);
          }}
        >
          <input
            id={answerInputId(question.id)}
            aria-label={`Answer question ${question.id}`}
            value={answer}
            onChange={(event) => {
              setAnswer(event.target.value);
            }}
            className="min-w-0 flex-1 rounded-md border border-line-input bg-inset px-2 py-1 text-sm"
            placeholder="Answer…"
          />
          {/* Not the beacon: the header's *Answer* is this page's one primary action. */}
          <Button type="submit" disabled={pending || answer.trim() === ''}>
            Answer
          </Button>
        </form>
      ) : (
        <p className="text-sm text-fg-muted">
          {QUESTION_STATUS_LABEL[question.status]}
          {question.answer === null || question.answer === undefined ? null : (
            <>
              {' — '}
              <UntrustedText value={question.answer} />
            </>
          )}
        </p>
      )}
    </Card>
  );
};

/**
 * What the person handling an escalation is told (PROGRESS backlog 483): the server accepts a return
 * and a rework out of `needs_human`, and the person who knows which stage should run again is the
 * one reading this. A merged task never goes back to work (WP-152, backlog 497): its way out is the
 * retrospective, and a return, a rework or a hand-back before the merge is refused.
 */
const EscalationText = ({
  merged,
  maySendBack,
  mayResume,
}: {
  readonly merged: boolean;
  /** The caller may return or rework (S-23.23); a member is told a maintainer does that. */
  readonly maySendBack: boolean;
  /** The caller may resume (`can_resume`); otherwise the sentence offers no Resume. */
  readonly mayResume: boolean;
}): ReactElement =>
  merged ? (
    mayResume ? (
      <p>
        This task was merged and is waiting for a person. Resume it to run its retrospective — a
        task stopped at the merge check resumes there too — or retry the retrospective or librarian
        stage it stopped at; it cannot be sent back before the merge.
      </p>
    ) : (
      <p>
        This task was merged and is waiting for a person who may resume it into its retrospective;
        it cannot be sent back before the merge.
      </p>
    )
  ) : maySendBack ? (
    <p>
      This task is waiting for a person. Send it back to a stage it has run, with a note the stage
      is given, rework it from there, or retry the stage it stopped at.
    </p>
  ) : (
    <p>
      This task is waiting for a person. Retry the stage it stopped at; sending it back to an
      earlier stage or reworking it is a maintainer’s decision.
    </p>
  );

/** The escalated attempt's recorded word, as a sentence — or nothing when the row has none. */
const escalationReason = (
  task: TaskRecord,
  stages: TaskDetailResponse['stages'],
): string | null => {
  const row =
    task.current_stage === null || task.current_stage === undefined
      ? null
      : latestStageRow(stages, task.current_stage);
  return row === null || row.outcome === null ? null : stageOutcomeSentence(row.outcome);
};

/**
 * Why a budget pause waits, and on whom (WP-131): only a task's **own** cap is raised from this page
 * (the header's *Raise this task's cap…*, for a caller with `budget.write`); a project's or an
 * organisation's is raised where that cap is set.
 */
export const budgetReason = (
  task: Pick<TaskRecord, 'paused_budget_scope' | 'budget_cap_usd'>,
  canRaise: boolean,
): string => {
  switch (task.paused_budget_scope) {
    case 'task':
      return canRaise
        ? `It has spent its cap of ${formatUsd(task.budget_cap_usd)}. Raise the cap and it resumes at the stage it stopped at.`
        : `It has spent its cap of ${formatUsd(task.budget_cap_usd)}. A person who may change budgets can raise it.`;
    case 'project':
      return 'Its project has spent its budget. It resumes once the project’s budget is raised, where that cap is set.';
    case 'organization':
      return 'The organisation has spent its budget. It resumes once the organisation’s budget is raised, where that cap is set.';
    default:
      return 'A budget it counts against is spent.';
  }
};

/**
 * The platform's own words for a pause, which the notice never prints as a person's *why*: the fixed
 * *paused from the UI* the Pause buttons sent before S-25.23 gave them a dialog (still on the rows
 * of tasks paused then), and — **on a run cancel's row only** — the *the run was cancelled* a run
 * cancel records (S-25.23), since the notice's first sentence already says a run cancel paused it.
 * A person who typed those same words into the pause dialog still sees them.
 */
const UI_PAUSE_REASONS: ReadonlySet<string> = new Set(['paused from the UI']);

/** The person's own reason, or `null` for none or for the words the platform wrote. */
export const pauseWhy = (pause: TaskManualPause | null): string | null => {
  if (pause === null || pause.reason === null) {
    return null;
  }
  const reason = pause.reason.trim();
  if (UI_PAUSE_REASONS.has(reason)) {
    return null;
  }
  return pause.via === 'run_cancel' && reason === RUN_CANCEL_PAUSE_REASON ? null : pause.reason;
};

/**
 * **A task a person paused** (S-25.20, the read's `manual_pause`): who paused it, when, why if they
 * said, and how it goes on — neutral information, never *Needs you*: a person chose it. A *Cancel
 * run* pauses the task too, and the notice says that is what happened. With no row to say who, it
 * says so rather than naming anybody.
 */
const PausedNotice = ({
  pause,
  mayResume,
  pending,
  onResume,
}: {
  readonly pause: TaskManualPause | null;
  readonly mayResume: boolean;
  readonly pending: boolean;
  readonly onResume: () => void;
}): ReactElement => {
  const why = pauseWhy(pause);
  const who = pause?.by?.name ?? null;
  return (
    <section aria-label="Paused" data-testid="paused-notice">
      <Flash tone="info" title="Paused by a person">
        <div className="flex flex-col gap-2 pt-1">
          <p data-paused-by={pause === null ? 'unknown' : pause.via}>
            {pause === null ? (
              'A person paused this task; the record does not say who.'
            ) : (
              <>
                {pause.via === 'run_cancel' ? 'Paused when ' : 'Paused by '}
                {/* A person's own name (BD-022). */}
                {who === null ? 'a person' : <UntrustedText value={who} />}
                {pause.via === 'run_cancel'
                  ? ` cancelled its run, ${formatDateTime(pause.at)}. Cancelling a run pauses its task.`
                  : `, ${formatDateTime(pause.at)}.`}
              </>
            )}
          </p>
          {why === null || pause === null ? null : (
            <p data-paused-why="">
              {'Why: '}
              {/* What the person typed, redacted by the command (BD-022). */}
              <UntrustedText value={why} />
              {pause.reason_cut ? ' (shortened)' : null}
            </p>
          )}
          <p>
            {mayResume
              ? 'Nothing runs until it is resumed: it goes on at the stage it stopped at, with no round used.'
              : 'Nothing runs until a member of the project resumes it.'}
          </p>
          {mayResume ? (
            <div>
              <Button data-paused-action="resume" disabled={pending} onClick={onResume}>
                Resume
              </Button>
            </div>
          ) : null}
        </div>
      </Flash>
    </section>
  );
};

/** Whether the callout has anything to say — the page draws nothing in its place otherwise. */
export const calloutReasons = (input: {
  readonly state: TaskRecord['state'];
  readonly openQuestions: number;
  readonly pendingApprovals: number;
  readonly breakdownWaiting: boolean;
  readonly pausedReason?: TaskRecord['paused_reason'];
  /** The CI check waits on a pipeline held at a manual job (S-25.12, `gateWaitHeld`). */
  readonly ciHeld?: boolean;
}): readonly ('question' | 'approval' | 'ci_held' | 'escalation' | 'budget' | 'breakdown')[] => [
  ...(input.openQuestions > 0 ? (['question'] as const) : []),
  ...(input.pendingApprovals > 0 ? (['approval'] as const) : []),
  // A held manual job only a person can start (`ui/task-status.ts`' needs-you, `ci_held`).
  ...(input.ciHeld === true ? (['ci_held'] as const) : []),
  ...(input.state === 'needs_human' ? (['escalation'] as const) : []),
  // A budget pause waits on whoever may raise the cap (`ui/task-status.ts`' needs-you).
  ...(input.state === 'paused' && input.pausedReason === 'budget' ? (['budget'] as const) : []),
  ...(input.breakdownWaiting ? (['breakdown'] as const) : []),
];

const calloutTitle = (
  first: ReturnType<typeof calloutReasons>[number],
  questions: number,
  approvals: readonly ApprovalView[],
): string => {
  switch (first) {
    case 'question':
      return questions === 1
        ? 'An agent is waiting for your answer'
        : `${questions} questions are waiting for your answer`;
    case 'approval': {
      const [approval] = approvals;
      return approvals.length === 1 && approval !== undefined
        ? `The ${APPROVAL_KIND_LABEL[approval.kind].toLowerCase()} is waiting for you`
        : `${approvals.length} approvals are waiting for you`;
    }
    case 'ci_held':
      return 'CI is waiting for a person';
    case 'escalation':
      return 'This task needs a person';
    case 'budget':
      return 'This task is paused for its budget';
    case 'breakdown':
      return 'The proposed breakdown is waiting for your decision';
  }
};

interface TaskCalloutProps {
  readonly detail: TaskDetailResponse;
  /** The board's key, when the projects read has it: a reason's *how to stop being asked* links. */
  readonly projectKey: string | null;
  /** The header's owner control: the waiting notice's *Take it* / *Assign…*. */
  readonly owner?: OwnerControl;
  /** The project's name, for the waiting words' "in Autix". */
  readonly projectName?: string | null;
  readonly merged: boolean;
  /** Whether the stage commands have a stage to address (the task's own history). */
  readonly hasStages: boolean;
  readonly breakdownWaiting: boolean;
  readonly commands: TaskCommands;
  readonly onOpen: (dialog: TaskDialog) => void;
  /** The page's clock, for the minutes a CI wait has run; the read's own instant without it. */
  readonly nowMs?: number;
  /**
   * The page's one primary (`./page-primary.ts`), asked once by the page and shared with the
   * header: `retry_stage` draws *Retry stage…* amber, `take` the held-elsewhere box's *Take it*.
   * Left out (a callout drawn on its own), the same function answers it from these props.
   */
  readonly primary?: TaskPrimaryAction;
  /** S-28.7: the manual job names the project already chose for (the CI wait's offer). */
  readonly chosenJobs?: ReadonlySet<string>;
}

export const TaskCallout = (props: TaskCalloutProps): ReactElement => {
  const { detail, owner, projectName = null, nowMs } = props;
  // S-26.8b part 2: why the run waits for a machine — information, drawn above the rest.
  return waitingReason(detail.task.waiting) === null ? (
    <CalloutSlot {...props} />
  ) : (
    <>
      <WaitingNotice
        detail={detail}
        owner={owner}
        projectName={projectName}
        nowMs={nowMs ?? Date.parse(detail.task.updated_at)}
      />
      <CalloutSlot {...props} />
    </>
  );
};

const CalloutSlot = ({
  detail,
  projectKey,
  owner,
  merged,
  hasStages,
  breakdownWaiting,
  commands,
  onOpen,
  nowMs,
  primary: given,
  chosenJobs,
}: TaskCalloutProps): ReactElement | null => {
  const { task, stages } = detail;
  const primary =
    given !== undefined
      ? given
      : taskPagePrimary(detail, {
          ownerOffers: owner?.offers ?? [],
          stageOptions: hasStages ? 1 : 0,
          merged,
        });
  // Only while the task is active: a paused task's CI check is not checking (review of PR #101).
  const gateWait = openGateWait(detail);
  const provider = task.mr_ref?.provider ?? null;
  const openQuestions = detail.questions.filter((question) => question.status === 'open');
  const pendingApprovals = detail.approvals.filter((approval) => approval.status === 'pending');
  const reasons = calloutReasons({
    state: task.state,
    openQuestions: openQuestions.length,
    pendingApprovals: pendingApprovals.length,
    breakdownWaiting,
    pausedReason: task.paused_reason,
    ciHeld: gateWaitHeld(gateWait),
  });
  const [first] = reasons;
  // S-25.14: the ticket is somebody else's — the callout says whose, with the ways out in the box.
  const heldElsewhere = reasons.includes('escalation') && heldElsewhereStop(detail);
  if (first === undefined) {
    // S-25.20: a task a person paused says who, when and why, and how it goes on — information.
    if (task.state === 'paused' && task.paused_reason === 'manual') {
      return (
        <PausedNotice
          pause={detail.manual_pause ?? null}
          mayResume={detail.can_resume}
          pending={commands.resume.isPending}
          onResume={() => {
            commands.resume.mutate('resumed from the UI');
          }}
        />
      );
    }
    // S-25.16: a queued task says what holds it and what frees it — information, no action.
    if (task.state === 'queued' && detail.queue_wait !== null && detail.queue_wait !== undefined) {
      return (
        <QueueWaitNotice
          wait={detail.queue_wait}
          ticketKey={task.ticket.key}
          projectKey={projectKey}
          canChangeLimits={detail.can_change_limits}
          mayDecide={detail.can_cancel}
        />
      );
    }
    if (gateWait !== null) {
      // S-25.12: CI is still running — information, no action; nothing is asked of the reader.
      return (
        <section aria-label="What happens next" data-testid="gate-wait-notice">
          <Flash tone="info">
            <GateWaitNotice
              wait={gateWait}
              provider={provider}
              projectKey={projectKey}
              nowMs={nowMs}
              started={detail.ci_manual_started ?? null}
              {...(chosenJobs === undefined ? {} : { chosen: chosenJobs })}
            />
          </Flash>
        </section>
      );
    }
    // S-27.2 (TD-036 decision 7): Ready over a pipeline the provider still shows blocked.
    const blocked = readyBlockedPipeline(detail);
    if (blocked !== null) {
      return (
        <section aria-label="What happens next" data-testid="ready-blocked-notice">
          <Flash tone="info">
            <ReadyBlockedNotice notRun={blocked} provider={provider} />
          </Flash>
        </section>
      );
    }
    const open = openReturn(task, stages, detail.returns.at(-1) ?? null);
    if (open === null) {
      return null;
    }
    // S-25.11: the agent is on it, so nothing is asked of the reader — information, no action.
    const words = returnWords(open, task, detail.loop_limits);
    return (
      <section aria-label="What happens next" data-testid="setback-notice">
        <Flash tone="info">
          <p data-setback="fixing" data-setback-recorded={words.recorded ? 'yes' : 'no'}>
            {/* Platform words around the job names the row recorded (provider text). */}
            <UntrustedText value={words.sentence} />
          </p>
        </Flash>
      </section>
    );
  }
  const stop = reasons.includes('escalation') ? detail.stop : null;
  // BACKLOG 850: the escalation's own brief. With no structured stop it is the one *why* and
  // replaces the row's word; beside a structured stop (S-25.11/12: a spent loop, a repeated failure,
  // a check with no answer) the stop's sentence leads and the brief sits collapsed under *Details*,
  // in place of the stop's *What the platform saw last:* line — never two headlines (review of #111).
  const escalation = reasons.includes('escalation') ? detail.escalation : null;
  const briefLeads = escalation !== null && stop === null;
  const briefDetails = escalation !== null && stop !== null ? escalation : null;
  const reason =
    reasons.includes('escalation') && stop === null && escalation === null
      ? escalationReason(task, stages)
      : null;
  // The brief's text, as untrusted prose: a brief can hold paragraphs (`\n\n`).
  const briefText = (value: NonNullable<typeof escalation>): ReactElement => (
    <>
      <UntrustedProse value={value.brief} />
      {value.brief_original_chars === null ? null : <p className="text-sm">(shortened)</p>}
    </>
  );
  const stopped = stop === null ? null : stopWords(stop, detail.loop_limits);
  // S-25.12: a CI check that got no answer, worded from the attempt's structured read when it
  // recorded one; the recorded sentence is only the fallback for an attempt with none.
  const lastRead =
    stop !== null && stop.cause === 'no_answer' && stop.stage === 'ci_gate'
      ? detail.last_gate_wait
      : null;
  return (
    <section aria-label="Needs you" data-testid="needs-you-callout">
      <Flash tone="beacon" title={calloutTitle(first, openQuestions.length, pendingApprovals)}>
        <div className="flex flex-col gap-3 pt-1">
          {openQuestions.length === 0 ? null : (
            <div className="flex flex-col gap-2">
              {openQuestions.map((question) => (
                <QuestionCard
                  key={question.id}
                  question={question}
                  pending={commands.answer.isPending}
                  onAnswer={(answer) => {
                    commands.answer.mutate({ questionId: question.id, answer });
                  }}
                />
              ))}
              {commands.answer.isError ? (
                <ErrorNotice title="That answer was refused." error={commands.answer.error} />
              ) : null}
            </div>
          )}
          {pendingApprovals.length === 0 ? null : (
            <div className="flex flex-col gap-2">
              {pendingApprovals.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  taskId={task.id}
                  artifacts={detail.artifacts}
                  projectKey={projectKey}
                  mayDecide={detail.can_decide_approval}
                  commands={commands}
                />
              ))}
              {commands.decide.isError ? (
                <ErrorNotice title="That decision was refused." error={commands.decide.error} />
              ) : null}
            </div>
          )}
          {reasons.includes('ci_held') && gateWait !== null ? (
            <GateWaitNotice
              wait={gateWait}
              provider={provider}
              projectKey={projectKey}
              nowMs={nowMs}
              started={detail.ci_manual_started ?? null}
              {...(chosenJobs === undefined ? {} : { chosen: chosenJobs })}
            />
          ) : null}
          {heldElsewhere ? (
            <HeldElsewhere
              detail={detail}
              owner={owner}
              commands={commands}
              onOpen={onOpen}
              primary={primary}
            />
          ) : reasons.includes('escalation') ? (
            <div className="flex flex-col gap-2">
              {!briefLeads || escalation === null ? null : (
                <div data-escalation-brief="" className="flex flex-col gap-1">
                  <p className="font-medium">Why it stopped ({formatDateTime(escalation.at)}):</p>
                  {/* Platform words that may quote a provider or a run (BD-022). */}
                  {briefText(escalation)}
                </div>
              )}
              {stop !== null && lastRead !== null ? (
                <CiWaitStop stop={stop} read={lastRead} provider={provider} />
              ) : stop === null || stopped === null ? null : (
                <div className="flex flex-col gap-1" data-stop={stop.cause}>
                  <p data-stop-sentence="">
                    <UntrustedText value={stopped.sentence} />
                  </p>
                  {stopped.recordedLead === null || briefDetails !== null ? null : (
                    <p data-stop-recorded="">
                      {stopped.recordedLead}
                      {stop.recorded === null ? null : (
                        <>
                          {' '}
                          {/* The sentence the platform wrote, quoting provider text (BD-022). */}
                          <UntrustedText value={stop.recorded} />
                          {stop.recorded_cut ? ' (shortened)' : null}
                        </>
                      )}
                    </p>
                  )}
                  <p data-stop-next="">
                    {stopped.next}
                    {task.mr_ref === null || task.mr_ref === undefined ? null : (
                      <>
                        {' '}
                        <ExternalLink
                          url={task.mr_ref.url}
                          label="Open the merge request"
                          className="text-link underline"
                        />
                      </>
                    )}
                  </p>
                </div>
              )}
              {briefDetails === null ? null : (
                <details data-escalation-details="">
                  <summary className="cursor-pointer text-sm">Details</summary>
                  <div className="pt-1">{briefText(briefDetails)}</div>
                </details>
              )}
              {reason === null ? null : (
                <p data-escalation-reason="">
                  {/* The row's word through the platform's own table; still rendered as text. */}
                  <UntrustedText value={reason} />
                </p>
              )}
              {/* S-25.20: the cause and its next step first; the options sentence last. */}
              <EscalationText
                merged={merged}
                maySendBack={detail.can_return || detail.can_rework}
                mayResume={detail.can_resume}
              />
              {hasStages ? (
                <div className="flex flex-wrap gap-2">
                  {merged || !detail.can_return ? null : (
                    <Button
                      onClick={() => {
                        onOpen('return');
                      }}
                    >
                      Return to stage…
                    </Button>
                  )}
                  {merged || !detail.can_rework ? null : (
                    <Button
                      onClick={() => {
                        onOpen('rework');
                      }}
                    >
                      Rework…
                    </Button>
                  )}
                  {/* S-25.15: the stop's next step is "retry the stage", so it is the page's primary. */}
                  <Button
                    tone={primary === 'retry_stage' ? 'primary' : 'default'}
                    data-callout-action="retry"
                    onClick={() => {
                      onOpen('retry');
                    }}
                  >
                    Retry stage…
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {reasons.includes('budget') ? (
            <p data-budget-reason="">{budgetReason(task, detail.can_raise_budget)}</p>
          ) : null}
          {breakdownWaiting ? <BreakdownPanel taskId={task.id} enabled /> : null}
        </div>
      </Flash>
    </section>
  );
};
