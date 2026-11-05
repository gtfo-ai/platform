/**
 * The task page's **needs-you callout** (S-23.9b; research/19 § 3 item 2 and § 5.2 "Task"): what a
 * person must do on this task, first on the page, with the action **inline**.
 *
 * Five things put it there, in this order:
 *
 * - **open questions** — each answered here, with the same `answer` command the inbox sends; the
 *   agent wrote the question, so it is rendered as text (BD-022);
 * - **pending approvals** — approved or rejected here (`decide`);
 * - **the task waiting for a person** (`needs_human`) — what stopped it, as the stage row's own
 *   outcome sentence, and the three ways out (return, rework, retry), which open the same dialogs as
 *   the header's `···` menu. The sentence is the escalated attempt's recorded word, not the
 *   escalation's brief: the task projection does not publish the brief (BACKLOG 850);
 * - **a budget pause** — whose cap is spent, and where it is raised (the header's primary raises
 *   a task's own cap);
 * - **a proposed breakdown waiting for a maintainer** — the epic split's panel, with its decision.
 *   A breakdown with nothing left to decide, or a caller who may not decide it, is on the Overview.
 *
 * None of it is shown for a task nothing waits on, so its absence is itself an answer.
 */
import type {
  ApprovalRecord,
  QuestionRecord,
  TaskDetailResponse,
  TaskRecord,
} from '@platform/contracts';
import { type ReactElement, useState } from 'react';
import type { useTaskCommands } from '../app/queries.js';
import { Flash } from '../ui/flash.js';
import { APPROVAL_KIND_LABEL, QUESTION_STATUS_LABEL, stageLabel } from '../ui/humanize.js';
import { Badge, Button, Card, ErrorNotice, formatDateTime, formatUsd } from '../ui/kit.js';
import { UntrustedProse, UntrustedText } from '../ui/untrusted.js';
import { BreakdownPanel } from './breakdown-panel.js';
import { stageOutcomeSentence } from './stage-outcome.js';
import { latestStageRow } from './task-checks-text.js';
import type { TaskDialog } from './task-dialogs.js';

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
            className="flex-1 rounded-md border border-line-input bg-inset px-2 py-1 text-sm"
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

const ApprovalCard = ({
  approval,
  onDecide,
  pending,
}: {
  readonly approval: ApprovalRecord;
  readonly onDecide: (decision: 'approve' | 'reject') => void;
  readonly pending: boolean;
}): ReactElement => (
  <Card className="flex flex-wrap items-center gap-2">
    <Badge tone="accent">{APPROVAL_KIND_LABEL[approval.kind]}</Badge>
    <span className="text-xs text-fg-muted">{`requested ${formatDateTime(approval.requested_at)}`}</span>
    <div className="ml-auto flex gap-2">
      <Button
        disabled={pending}
        onClick={() => {
          onDecide('approve');
        }}
      >
        Approve
      </Button>
      <Button
        tone="danger"
        disabled={pending}
        onClick={() => {
          onDecide('reject');
        }}
      >
        Reject
      </Button>
    </div>
  </Card>
);

/**
 * What the person handling an escalation is told (PROGRESS backlog 483): the server accepts a return
 * and a rework out of `needs_human`, and the person who knows which stage should run again is the
 * one reading this. A merged task never goes back to work (WP-152, backlog 497): its way out is the
 * retrospective, and a return, a rework or a hand-back before the merge is refused.
 */
const EscalationText = ({ merged }: { readonly merged: boolean }): ReactElement =>
  merged ? (
    <p>
      This task was merged and is waiting for a person. Resume it to run its retrospective — a task
      stopped at the merge gate resumes there too — or retry the retrospective or librarian stage it
      stopped at; it cannot be sent back before the merge.
    </p>
  ) : (
    <p>
      This task is waiting for a person. Send it back to a stage it has run, with a note the stage
      is given, rework it from there, or retry the stage it stopped at.
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

/** Whether the callout has anything to say — the page draws nothing in its place otherwise. */
export const calloutReasons = (input: {
  readonly state: TaskRecord['state'];
  readonly openQuestions: number;
  readonly pendingApprovals: number;
  readonly breakdownWaiting: boolean;
  readonly pausedReason?: TaskRecord['paused_reason'];
}): readonly ('question' | 'approval' | 'escalation' | 'budget' | 'breakdown')[] => [
  ...(input.openQuestions > 0 ? (['question'] as const) : []),
  ...(input.pendingApprovals > 0 ? (['approval'] as const) : []),
  ...(input.state === 'needs_human' ? (['escalation'] as const) : []),
  // A budget pause waits on whoever may raise the cap (`ui/task-status.ts`' needs-you).
  ...(input.state === 'paused' && input.pausedReason === 'budget' ? (['budget'] as const) : []),
  ...(input.breakdownWaiting ? (['breakdown'] as const) : []),
];

const calloutTitle = (
  first: ReturnType<typeof calloutReasons>[number],
  questions: number,
  approvals: readonly ApprovalRecord[],
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
    case 'escalation':
      return 'This task needs a person';
    case 'budget':
      return 'This task is paused for its budget';
    case 'breakdown':
      return 'The proposed breakdown is waiting for your decision';
  }
};

export const TaskCallout = ({
  detail,
  merged,
  hasStages,
  breakdownWaiting,
  commands,
  onOpen,
}: {
  readonly detail: TaskDetailResponse;
  readonly merged: boolean;
  /** Whether the stage commands have a stage to address (the task's own history). */
  readonly hasStages: boolean;
  readonly breakdownWaiting: boolean;
  readonly commands: TaskCommands;
  readonly onOpen: (dialog: TaskDialog) => void;
}): ReactElement | null => {
  const { task, stages } = detail;
  const openQuestions = detail.questions.filter((question) => question.status === 'open');
  const pendingApprovals = detail.approvals.filter((approval) => approval.status === 'pending');
  const reasons = calloutReasons({
    state: task.state,
    openQuestions: openQuestions.length,
    pendingApprovals: pendingApprovals.length,
    breakdownWaiting,
    pausedReason: task.paused_reason,
  });
  const [first] = reasons;
  if (first === undefined) {
    return null;
  }
  const reason = reasons.includes('escalation') ? escalationReason(task, stages) : null;
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
              {commands.answer.isError ? <ErrorNotice title="That answer was refused." /> : null}
            </div>
          )}
          {pendingApprovals.length === 0 ? null : (
            <div className="flex flex-col gap-2">
              {pendingApprovals.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  pending={commands.decide.isPending}
                  onDecide={(decision) => {
                    commands.decide.mutate({ approvalId: approval.id, decision });
                  }}
                />
              ))}
              {commands.decide.isError ? <ErrorNotice title="That decision was refused." /> : null}
            </div>
          )}
          {reasons.includes('escalation') ? (
            <div className="flex flex-col gap-2">
              <EscalationText merged={merged} />
              {reason === null ? null : (
                <p data-escalation-reason="">
                  {/* The row's word through the platform's own table; still rendered as text. */}
                  <UntrustedText value={reason} />
                </p>
              )}
              {hasStages ? (
                <div className="flex flex-wrap gap-2">
                  {merged ? null : (
                    <>
                      <Button
                        onClick={() => {
                          onOpen('return');
                        }}
                      >
                        Return to stage…
                      </Button>
                      <Button
                        onClick={() => {
                          onOpen('rework');
                        }}
                      >
                        Rework…
                      </Button>
                    </>
                  )}
                  <Button
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
