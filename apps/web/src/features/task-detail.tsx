/**
 * Task detail (product/10 § "Task detail").
 *
 * Left: the stage timeline. Centre: artifacts, runs, questions and approvals. Right: the checks
 * panel, cost and links. Live on the `task:<id>` topic.
 *
 * **What the Checks panel shows, and what it cannot.** product/10 lists thirteen merge-readiness
 * checks (acceptance criteria, CI, rebase, review threads, business verdict, tamper check, coverage
 * delta, dependency status, risk classes, budget vs estimate, questions pending…). `taskDetail`
 * publishes five of them — questions, approvals, risk classes, and since WP-28 **cost against the
 * estimate**, which is product/10's *"budget vs estimate"* row and was the one this note used to
 * describe as *"cost against nothing"*. The panel shows those five and says plainly that the rest
 * arrive with WP-15 and WP-38 rather than drawing empty ticks that read as "passed".
 *
 * **Which commands are here, and which are named absences.** technical/09's screens table gives
 * this screen `answer, approve, retry, take over, feedback`; product/10 adds return-to-stage and
 * rework. Present: pause, resume, cancel, answer, decide, **retry-stage**, **return-to-stage**,
 * **rework** and **feedback**. Absent on purpose, and this list is the declaration rather than a
 * hope:
 *
 * - **take over** and **hand back**. The routes exist since WP-27 and so does the response this
 *   note used to say was missing: `takeOverResponseSchema` carries the branch, the session id, the
 *   resume commands and what became of the workspace, which is product/10's "pause pipeline, get
 *   branch + resume command, export workspace" in a shape a screen can render. What is absent is
 *   this screen's half — somewhere to show those four lines, and a stage picker for the hand-back —
 *   and it is a row of its own rather than a line in this file (standing rule 83: the sentence that
 *   described the gap is false the moment the gap closes, and this is that sentence).
 *
 * **Ask the task is here since WP-31** — `features/ask-thread.tsx`, between the approvals and the
 * artifacts. This note used to say that `taskDetailResponseSchema` had nowhere to carry a thread so
 * a question would post into a void; both halves are false now, and the sentence nearest the fix is
 * the one nobody re-reads (standing rule 83). The thread is a query of its own
 * (`GET /api/tasks/:id/asks`) rather than a field of the task DTO, for the reason that note
 * implied: an ask is answered by a run that takes a minute, on its own schedule.
 */
import type { ApprovalRecord, QuestionRecord, TaskRecord } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import { type ReactElement, useState } from 'react';
import { useProjects, useTask, useTaskAudit, useTaskCommands } from '../app/queries.js';
import { useServices } from '../app/services.js';
import { useTopics } from '../realtime/provider.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  formatDateTime,
  formatElapsed,
  formatUsd,
  Loading,
  Metric,
  SectionHeading,
} from '../ui/kit.js';
import { ExternalLink, UntrustedProse, UntrustedText } from '../ui/untrusted.js';
import { AskThread } from './ask-thread.js';
import { FeedbackForm } from './feedback.js';

/**
 * What the task's estimate rests on, as one sentence — the same four states the workpad prints.
 *
 * Platform text only: the numbers are the platform's own and no provider string reaches it, which
 * is why it is a plain string rather than an `UntrustedText`. The point of the line is that "the
 * estimator has not run" and "it ran and found nothing to estimate from" are different facts about
 * a project, and a blank field says neither (Q71 (b)).
 */
export const estimateBasisText = (task: TaskRecord): string => {
  const samples = task.estimate_samples ?? 0;
  const tasks = samples === 1 ? '1 finished task' : `${samples} finished tasks`;
  switch (task.estimate_basis) {
    case 'project_history':
      return `From ${tasks} in this project.`;
    case 'org_history':
      return `From ${tasks} elsewhere in this organisation — this project has none of its own yet.`;
    case 'unknown':
      return 'No estimate: this project has no finished task to estimate from. The per-task budget cap is what bounds the spend meanwhile.';
    default:
      return task.estimate_usd === null
        ? 'Not estimated yet: a task is estimated when refinement completes.'
        : 'Estimated before this platform recorded where the figure came from.';
  }
};

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
        <span className="text-xs text-fg-muted">{question.stage}</span>
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
            aria-label={`Answer question ${question.id}`}
            value={answer}
            onChange={(event) => {
              setAnswer(event.target.value);
            }}
            className="flex-1 rounded-md border border-line bg-surface px-2 py-1 text-sm"
            placeholder="Answer…"
          />
          <Button type="submit" tone="primary" disabled={pending || answer.trim() === ''}>
            Answer
          </Button>
        </form>
      ) : (
        <p className="text-sm text-fg-muted">
          {question.status}
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
 * Who did what to this task — `GET /api/tasks/:task_id/audit` (WP-31, PROGRESS backlog 52).
 *
 * WP-30 put the *project's* settings audit on the settings page and a task command's row never
 * appeared on it: `human_actions` has no `project_id` column, so the predicate that page uses
 * (`params->>'project_id'`) matches none of WP-15i's eleven commands or WP-27's three. This is the
 * other half, and it is the read an ask's own answer is built from — one projection, two readers.
 *
 * `org.audit.read` is **maintainer** (Q36), so a member sees a sentence rather than an error: a
 * 403 here is *"you may not read this"*, which is a different fact from a failure (standing rule
 * 18) and is the one thing an `ErrorNotice` would state wrongly.
 */
const TaskActivity = ({ taskId }: { readonly taskId: string }): ReactElement => {
  const audit = useTaskAudit(taskId);
  return (
    <div>
      <SectionHeading>Who did what</SectionHeading>
      {audit.isPending ? <Loading label="Loading this task's activity…" /> : null}
      {audit.error === null || audit.error === undefined ? null : (
        <EmptyState
          title="Not shown"
          hint="Every human action on this task is recorded; reading the record needs the maintainer role."
        />
      )}
      {audit.data === undefined || audit.data.items.length > 0 ? null : (
        <EmptyState
          title="Nothing yet"
          hint="Pausing, answering, approving, retrying and taking over are all recorded here."
        />
      )}
      <ul className="flex flex-col gap-1">
        {(audit.data?.items ?? []).map((entry) => (
          <li key={entry.id}>
            <Card className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium">{entry.action}</span>
              <span className="text-fg-muted">{entry.user_id ?? 'unknown user'}</span>
              <span className="ml-auto text-fg-muted">{formatDateTime(entry.created_at)}</span>
              {/*
                `params` is client-supplied JSON carrying the caller's own `Idempotency-Key`, so it
                is untrusted like everything else this screen renders (BD-022).
              */}
              <UntrustedText
                className="basis-full text-fg-muted"
                value={JSON.stringify(entry.params)}
              />
            </Card>
          </li>
        ))}
      </ul>
    </div>
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
  <Card className="flex flex-col gap-2">
    <div className="flex items-center gap-2">
      <Badge tone="accent">{approval.kind}</Badge>
      <span className="text-xs text-fg-muted">{approval.status}</span>
      <span className="ml-auto text-xs text-fg-muted">{formatDateTime(approval.requested_at)}</span>
    </div>
    {approval.status === 'pending' ? (
      <div className="flex gap-2">
        <Button
          tone="primary"
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
    ) : (
      <p className="text-sm text-fg-muted">
        {approval.reason === null || approval.reason === undefined ? null : (
          <UntrustedText value={approval.reason} />
        )}
      </p>
    )}
  </Card>
);

/**
 * Retry, return-to-stage and rework — the three commands that move a task between stages.
 *
 * The stage list comes from the task's **own** history rather than from the pipeline template:
 * the template is WP-15's, and a select built on it today would offer one option, "unknown". A
 * task that has entered no stage yet gets the empty state instead of a control that can only fail.
 *
 * Each command's required fields are the published ones — `retryStageRequestSchema` takes an
 * optional reason, `returnToStageRequestSchema` requires one, `reworkRequestSchema` requires
 * instructions — so the submit button of each form is disabled until its own contract is
 * satisfiable, rather than sending a request the server will answer with a 400.
 */
const StageCommands = ({
  stages,
  commands,
}: {
  readonly stages: readonly { readonly stage: string }[];
  readonly commands: ReturnType<typeof useTaskCommands>;
}): ReactElement => {
  const options = [...new Set(stages.map((entry) => entry.stage))];
  const [stage, setStage] = useState(options[0] ?? '');
  const [reason, setReason] = useState('');
  const [instructions, setInstructions] = useState('');

  if (options.length === 0) {
    return (
      <EmptyState
        title="No stage to act on yet"
        hint="Retry, return and rework address a stage the task has entered. A queued task has none."
      />
    );
  }

  const selected = options.includes(stage) ? stage : (options[0] ?? '');

  return (
    <Card className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-xs text-fg-muted" htmlFor="stage-command">
        Stage
        <select
          id="stage-command"
          value={selected}
          onChange={(event) => {
            setStage(event.target.value);
          }}
          className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-fg"
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={commands.retryStage.isPending}
          onClick={() => {
            commands.retryStage.mutate({
              stage: selected,
              ...(reason.trim() === '' ? {} : { reason }),
            });
          }}
        >
          Retry stage
        </Button>
        <Button
          disabled={commands.returnToStage.isPending || reason.trim() === ''}
          onClick={() => {
            commands.returnToStage.mutate({ stage: selected, reason });
            setReason('');
          }}
        >
          Return to stage
        </Button>
      </div>
      <input
        aria-label="Reason"
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
        }}
        placeholder="Reason (required to return, optional to retry)"
        className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
      />

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          commands.rework.mutate({ stage: selected, instructions });
          setInstructions('');
        }}
      >
        <input
          aria-label="Rework instructions"
          value={instructions}
          onChange={(event) => {
            setInstructions(event.target.value);
          }}
          placeholder="What should be reworked?"
          className="flex-1 rounded-md border border-line bg-surface px-2 py-1 text-sm"
        />
        <Button type="submit" disabled={commands.rework.isPending || instructions.trim() === ''}>
          Rework
        </Button>
      </form>

      {commands.retryStage.isError || commands.returnToStage.isError || commands.rework.isError ? (
        <ErrorNotice title="That stage command was refused." />
      ) : null}
    </Card>
  );
};

export const TaskDetailScreen = ({ taskId }: { readonly taskId: string }): ReactElement => {
  useTopics([`task:${taskId}`]);
  const detail = useTask(taskId);
  const commands = useTaskCommands(taskId);
  const projects = useProjects();
  const { now } = useServices();

  if (detail.isPending) {
    return <Loading label="Loading task…" />;
  }
  if (detail.isError) {
    return <ErrorNotice title="Task could not be loaded." detail={String(detail.error)} />;
  }

  const { task, stages, artifacts, questions, approvals, runs } = detail.data;
  // The route may be entered without a project key (from the inbox or the agents view), so the
  // link back to the board is resolved from the task's own project rather than from the URL.
  const projectKey =
    projects.data?.items.find((project) => project.id === task.project_id)?.key ?? null;
  const nowMs = now();
  const openQuestions = questions.filter((question) => question.status === 'open');
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_1fr_18rem]">
      <aside className="flex flex-col gap-2">
        <SectionHeading>Stage timeline</SectionHeading>
        {stages.length === 0 ? (
          <EmptyState
            title="No stages yet"
            hint="Stages appear as the pipeline enters them. A queued task has none."
          />
        ) : (
          <ol className="flex flex-col gap-2">
            {stages.map((stage) => (
              <li key={`${stage.stage}:${stage.attempt}`}>
                <Card className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{stage.stage}</span>
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
                      {stage.state}
                    </Badge>
                    {stage.attempt > 1 ? (
                      <Badge tone="warning">{`try ${stage.attempt}`}</Badge>
                    ) : null}
                  </div>
                  <p className="text-[11px] text-fg-muted">
                    {formatDateTime(stage.entered_at)}
                    {stage.exited_at === null ? ' · running' : ''}
                  </p>
                  {stage.outcome === null ? null : (
                    <p className="text-xs">
                      <UntrustedText value={stage.outcome} />
                    </p>
                  )}
                </Card>
              </li>
            ))}
          </ol>
        )}
      </aside>

      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">
            <UntrustedText value={task.ticket.key} />
          </h1>
          <Badge tone="accent">{task.state}</Badge>
          <Badge>{task.template}</Badge>
          {task.mode === 'shadow' ? <Badge tone="warning">shadow</Badge> : null}
          <div className="ml-auto flex gap-2">
            <Button
              disabled={commands.pause.isPending}
              onClick={() => {
                commands.pause.mutate('paused from the UI');
              }}
            >
              Pause
            </Button>
            <Button
              disabled={commands.resume.isPending}
              onClick={() => {
                commands.resume.mutate('resumed from the UI');
              }}
            >
              Resume
            </Button>
            <Button
              tone="danger"
              disabled={commands.cancel.isPending}
              onClick={() => {
                commands.cancel.mutate('cancelled from the UI');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>

        {commands.pause.isError || commands.resume.isError || commands.cancel.isError ? (
          <ErrorNotice title="That command was refused." />
        ) : null}

        <div>
          <SectionHeading>Stage commands</SectionHeading>
          <StageCommands stages={stages} commands={commands} />
        </div>

        <div>
          <SectionHeading>Questions</SectionHeading>
          {openQuestions.length === 0 ? (
            <EmptyState
              title="No open questions"
              hint="When an agent needs a decision it asks here, in the ticket and in Slack at the same time. The first answer wins."
            />
          ) : (
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
            </div>
          )}
        </div>

        {pendingApprovals.length === 0 ? null : (
          <div>
            <SectionHeading>Approvals</SectionHeading>
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
            </div>
          </div>
        )}

        <AskThread taskId={task.id} />

        <TaskActivity taskId={task.id} />

        <div>
          <SectionHeading>Artifacts</SectionHeading>
          {artifacts.length === 0 ? (
            <EmptyState
              title="No artifacts yet"
              hint="Every stage that produces a document — Refined Spec, Plan, RCA, Review Verdict, Retro — lists it here with its version history."
            />
          ) : (
            <ul className="flex flex-col gap-1">
              {artifacts.map((artifact) => (
                <li key={artifact.id}>
                  <Card className="flex items-center gap-2">
                    <span className="text-sm font-medium">{artifact.artifact_type}</span>
                    <Badge>{`v${artifact.version}`}</Badge>
                    {artifact.url === null || artifact.url === undefined ? null : (
                      <ExternalLink
                        url={artifact.url}
                        label="Open"
                        className="ml-auto text-xs text-accent underline"
                      />
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <SectionHeading>Runs</SectionHeading>
          {runs.length === 0 ? (
            <EmptyState
              title="No runs yet"
              hint="A run is one agent working one stage. Open one to watch its transcript live."
            />
          ) : (
            <ul className="flex flex-col gap-1">
              {runs.map((run) => (
                <li key={run.id}>
                  <Card className="flex flex-wrap items-center gap-2">
                    <Link
                      to="/runs/$runId"
                      params={{ runId: run.id }}
                      className="text-sm font-medium hover:underline"
                    >
                      {run.stage} · {run.role}
                    </Link>
                    <Badge
                      tone={
                        run.status === 'completed'
                          ? 'success'
                          : run.status === 'running'
                            ? 'accent'
                            : run.status === 'failed'
                              ? 'danger'
                              : 'neutral'
                      }
                    >
                      {run.status}
                    </Badge>
                    <span className="text-xs text-fg-muted">
                      <UntrustedText value={run.model} />
                    </span>
                    <span className="ml-auto text-xs text-fg-muted">
                      {formatUsd(run.cost.usd)} · {formatElapsed(run.started_at, nowMs)}
                    </span>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>

        <FeedbackForm
          heading="Feedback on this task"
          hint="Goes to the Retrospective and the Librarian: what the agents got right or wrong here becomes a knowledge-base proposal (product/10)."
          pending={commands.feedback.isPending}
          failed={commands.feedback.isError}
          accepted={commands.feedback.isSuccess}
          onSubmit={(input) => {
            commands.feedback.mutate({ scope: 'task', ...input });
          }}
        />
      </section>

      <aside className="flex flex-col gap-3">
        <SectionHeading>Checks</SectionHeading>
        <Card className="flex flex-col gap-3">
          <Metric
            label="Cost so far"
            value={formatUsd(task.cost_actual_usd)}
            definition="Provider-reported cost of every run on this task; estimated in local provider mode (BD-011)."
          />
          {/*
            **The estimate, and the sentence this replaced** (WP-28, standing rule 83).
            This metric used to read `task.cost_estimated_usd` under the definition *"Predicted cost
            from the price table before the work ran"*. Both halves were wrong: that field is
            `tasks.cost_estimated`, which is the part of what a task has **already** spent that was
            priced rather than reported (BD-011) — and no writer in this build ever moves it, so the
            screen printed `$0.00` and called it a prediction. The prediction is `estimate_usd`, made
            at refinement from the project's finished tasks, and its absence is *named* rather than
            rendered as a zero (Q71 (b)).
          */}
          <Metric
            label="Estimate"
            value={task.estimate_usd === null ? 'none' : formatUsd(task.estimate_usd)}
            definition="Predicted at refinement from this project's finished tasks, before the work ran; above the project's threshold it waits for a budget approval (product/09)."
          />
          <p className="-mt-2 text-[11px] text-fg-muted">{estimateBasisText(task)}</p>
          <Metric
            label="Estimate accuracy"
            value={
              task.estimate_accuracy === null ? 'not yet' : `${task.estimate_accuracy.toFixed(2)}×`
            }
            definition="What the task has spent, divided by the estimate (product/19 §10): 1.00× is on the nose, 2.00× is twice what was predicted. Computed from those two numbers and nothing else."
          />
          <Metric
            label="Questions pending"
            value={String(openQuestions.length)}
            definition="Open questions blocking or accompanying this task."
          />
          <Metric
            label="Approvals pending"
            value={String(pendingApprovals.length)}
            definition="Plan, budget, knowledge or rework approvals awaiting a maintainer."
          />
          <div>
            <p className="text-xs text-fg-muted">Risk classes</p>
            <div className="flex flex-wrap gap-1 pt-1">
              {task.risk_classes.length === 0 ? (
                <span className="text-xs text-fg-muted">none</span>
              ) : (
                task.risk_classes.map((risk) => (
                  <Badge key={risk} tone="warning">
                    {risk}
                  </Badge>
                ))
              )}
            </div>
          </div>
          <p className="text-[11px] text-fg-muted">
            CI, rebase status, review threads, coverage delta and dependency status are not on this
            panel yet: the pipeline that produces them lands with WP-15 and WP-38. They are absent
            rather than shown as passing.
          </p>
        </Card>

        <Card className="flex flex-col gap-2 text-sm">
          {/* Provider-supplied URLs; `ExternalLink` refuses any scheme but http(s). */}
          <ExternalLink url={task.ticket.url} label="Ticket" className="text-accent underline" />
          {task.mr_ref === null || task.mr_ref === undefined ? null : (
            <ExternalLink
              url={task.mr_ref.url}
              label="Merge request"
              className="text-accent underline"
            />
          )}
          {projectKey === null ? null : (
            <Link
              to="/projects/$key"
              params={{ key: projectKey }}
              className="text-accent underline"
            >
              Back to the board
            </Link>
          )}
        </Card>
      </aside>
    </div>
  );
};
