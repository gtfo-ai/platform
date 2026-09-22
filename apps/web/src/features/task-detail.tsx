/**
 * Task detail (product/10 § "Task detail").
 *
 * Left: the stage timeline. Centre: artifacts, runs, questions and approvals. Right: the checks
 * panel, cost and links. Live on the `task:<id>` topic.
 *
 * **What the Checks panel shows, and what it cannot.** product/10:38 lists **eleven**
 * merge-readiness checks — acceptance criteria met, CI green, rebase status, review threads
 * open/resolved, business verdict, tamper check, coverage delta, dependency status, risk classes and
 * required reviewers, budget vs estimate, questions pending. This panel renders **five**: the
 * coverage delta (WP-39), the dependency status (WP-38), risk classes **and required reviewers**
 * (WP-37's routing, WP-38's record of it), cost against the estimate — product/10's *"budget vs
 * estimate"* (WP-28) — and questions pending, with approvals beside it. The other six are named on
 * the screen with what exists for each, and the whole list is held to product/10:38 by
 * `apps/web/src/features/checks-panel.test.tsx` › "the Checks panel against product/10:38" **in
 * both directions**, so neither this paragraph nor that sentence can go stale on its own (WP-38,
 * criterion 5).
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
import type {
  ApprovalRecord,
  HumanTimeKind,
  HumanTimeSummary,
  QuestionRecord,
  TaskCoverage,
  TaskDependencies,
  TaskRecord,
  TaskReviewers,
} from '@platform/contracts';
import { Link, useSearch } from '@tanstack/react-router';
import { type ReactElement, useState } from 'react';
import {
  useArtifactBody,
  useProjects,
  useTask,
  useTaskAudit,
  useTaskCommands,
} from '../app/queries.js';
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
  formatMinutes,
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

/**
 * What the minutes are made of — product/19 §16's four kinds, in the order the document lists them.
 *
 * A **measured zero** and *nothing recorded* are different facts, and this line is where they are
 * told apart: the metric above prints "none recorded" only when there is no entry at all, and a
 * review window the platform measured at zero length (one comment, nothing after it) says so here.
 * The kinds with no minutes are left out rather than printed as zeros.
 */
export const humanTimeBreakdown = (humanTime: HumanTimeSummary): string => {
  if (humanTime.entries === 0) {
    return 'No human activity recorded on this task yet — no review comment, question, approval or steer.';
  }
  const parts = HUMAN_TIME_KIND_LABELS.flatMap(([kind, label]) => {
    const minutes = humanTime.by_kind[kind] ?? 0;
    return minutes === 0 ? [] : [`${label} ${formatMinutes(minutes)}`];
  });
  const entries = humanTime.entries === 1 ? '1 entry' : `${humanTime.entries} entries`;
  return parts.length === 0
    ? `${entries}, none of which measured any time — a review with a single comment is a window of zero length.`
    : `${parts.join(' · ')} over ${entries}.`;
};

/**
 * The coverage delta, as the one figure the Checks panel prints — product/18:38, WP-39.
 *
 * Four answers, and telling them apart is the whole job (standing rules 16 and 18):
 *
 *  - **`not measured`** — no pipeline has finished on this task's merge request yet, or the
 *    project's `coverage source` is off. The platform has not looked.
 *  - **`not reported`** — it looked, and this project's CI publishes no coverage number.
 *  - **a bare percentage** — the change's own coverage, with no base to compare it against.
 *  - **a signed delta in percentage points** — the number product/18:38 asks for.
 *
 * Never `0.0` for any of the first two. `+0.0 pp` on a merge-readiness panel reads as *"the agent
 * added no coverage"*, which is a claim about the change rather than about the pipeline, and it is
 * the sentence this feature exists not to print. A **measured** zero does print as `0.0 pp`, which
 * is a different fact and one the line beneath spells out in full.
 */
export const coverageValueText = (coverage: TaskCoverage | null): string => {
  if (coverage === null) {
    return 'not measured';
  }
  if (coverage.head_pct === null) {
    return 'not reported';
  }
  if (coverage.delta_pct === null) {
    return `${coverage.head_pct.toFixed(1)} %`;
  }
  // `toFixed` carries its own minus sign; the plus is the one that has to be added, and a delta
  // without a sign is the thing a maintainer cannot read at a glance.
  return `${coverage.delta_pct > 0 ? '+' : ''}${coverage.delta_pct.toFixed(1)} pp`;
};

/**
 * What the delta was measured against, in one sentence — the base **named**, never implied.
 *
 * standing rule 63's shape on a screen: a delta is meaningless without its base, so the branch, the
 * two percentages and the revision are printed rather than left for a maintainer to assume. The
 * staleness is stated too, because the base is the default branch's head *at the moment of the
 * measurement* and the branch may have moved since.
 *
 * It contains a **branch name and two revisions, which are repository text somebody chose**
 * (BD-022), so the caller renders it through `UntrustedText` like every other provider string.
 */
export const coverageBasisText = (coverage: TaskCoverage | null): string => {
  if (coverage === null) {
    return 'No pipeline has finished on this task’s merge request yet, or this project’s coverage source is off.';
  }
  const at = formatDateTime(coverage.measured_at);
  if (coverage.head_pct === null) {
    return `The pipeline for ${shortSha(coverage.head_sha)} finished and reported no coverage, so there is no number to compare — not a change that covers nothing.`;
  }
  const head = `${coverage.head_pct.toFixed(1)} % on ${shortSha(coverage.head_sha)}`;
  if (coverage.base_pct === null || coverage.base_branch === null) {
    return `${head}. The default branch has no coverage of its own to compare it with, so this is a number and not a delta.`;
  }
  return `${head}, against ${coverage.base_pct.toFixed(1)} % on ${coverage.base_branch} at ${shortSha(coverage.base_sha ?? '')} as it stood on ${at}. One percentage for the whole change: per-file coverage needs the CI's coverage artifact, which this platform does not download.`;
};

/**
 * The dependency item's value — product/04:58, product/10:38's *"dependency status"* (WP-38).
 *
 * Four answers and none of them is a zero standing in for a missing one (standing rule 16, the same
 * rule `coverageValueText` was written to):
 *
 *  - `not checked` — the gate has not run. No implementation stage has completed on this task, so
 *    no diff exists to read: it is **not** "no dependencies were added";
 *  - `none added` — it ran and the diff touched no manifest or lockfile;
 *  - `1 added` / `3 added` — packages were added; the decision and the licences are on the line
 *    beneath and in the question the gate raised;
 *  - `blocked` / `waiting` — the policy stopped the task or is asking a human about it, which is the
 *    fact a maintainer looking at a merge request needs first.
 */
export const dependencyValueText = (dependencies: TaskDependencies | null): string => {
  if (dependencies === null) {
    return 'not checked';
  }
  if (dependencies.added.length === 0) {
    return dependencies.unread.length === 0 ? 'none added' : 'none read';
  }
  const added = `${dependencies.added.length} added`;
  switch (dependencies.decision) {
    case 'block':
      return `${added} · blocked`;
    case 'ask':
      // **`ask` with no question is not `waiting`.** The gate decides in a job, and a task that
      // stopped being active before that job fired gets the packages on this panel and nobody
      // asked — rare in production, where a stage takes minutes, and measured in the e2e tier where
      // a whole template walks in a second. Printing "waiting" for it would name a human who is not
      // coming (standing rule 18).
      return dependencies.question_id === null ? `${added} · not asked` : `${added} · waiting`;
    default:
      return added;
  }
};

/**
 * What the gate found, in one sentence: the packages, their licences and what it could not read.
 *
 * It contains **package names, manifest paths and a registry's licence string** — third-party text
 * somebody else wrote (BD-022) — so the caller renders it through `UntrustedText` like every other
 * provider string on this screen. *"licence not checked"* is a statement about this instance rather
 * than about the package: no registry host is declared (`APP_DEPENDENCY_REGISTRY_HOSTS`), so the
 * platform asked nobody.
 */
export const dependencyBasisText = (dependencies: TaskDependencies | null): string => {
  if (dependencies === null) {
    return 'No implementation stage has completed on this task yet, so no diff has been read.';
  }
  const unread =
    dependencies.unread.length === 0
      ? ''
      : ` ${dependencies.unread.length} manifest${dependencies.unread.length === 1 ? '' : 's'} could not be read on this build: ${dependencies.unread
          .map((entry) => `${entry.path} (${entry.ecosystem})`)
          .join(', ')}.`;
  if (dependencies.added.length === 0) {
    return `The change touches no dependency this build can read.${unread}`;
  }
  const packages = dependencies.added
    .map((entry) => {
      const licence =
        entry.metadata.status === 'checked'
          ? (entry.metadata.license ?? 'licence not published')
          : entry.metadata.status === 'not_checked'
            ? 'licence not checked'
            : entry.metadata.status === 'unsupported'
              ? 'no registry for this ecosystem'
              : 'registry unavailable';
      const published =
        entry.metadata.last_published_at === null
          ? ''
          : `, last release ${entry.metadata.last_published_at.slice(0, 10)}`;
      const allowed = entry.allowlisted ? ', allow-listed' : '';
      return `${entry.ecosystem}:${entry.name} (${licence}${published}${allowed})`;
    })
    .join(', ');
  const truncated = dependencies.truncated ? ' The list was cut, so there may be more.' : '';
  const unasked =
    dependencies.decision === 'ask' && dependencies.question_id === null
      ? ' The task had already moved past the point where the platform parks it, so nobody was asked — decide here before you merge.'
      : '';
  return `${packages}.${truncated}${unasked}${unread}`;
};

/**
 * The required-reviewer item — product/10:38's *"risk classes and required reviewers"* (WP-38).
 *
 * `null` is the routing not having run (no merge request, or the task has not reached the rebase
 * gate); an empty `handles` is the routing having run and found nobody, which is a fact about the
 * project's `CODEOWNERS` and `policies.reviewers` rather than about the platform. An `unresolved`
 * handle is the case the audit trail cannot record at all — the platform routed somebody this
 * provider has no account for and assigned nobody for them.
 */
export const reviewersValueText = (reviewers: TaskReviewers | null): string => {
  if (reviewers === null) {
    return 'not routed';
  }
  if (reviewers.handles.length === 0) {
    return 'none';
  }
  const unresolved =
    reviewers.unresolved.length === 0 ? '' : `, ${reviewers.unresolved.length} unresolved`;
  return `${reviewers.assigned.length} of ${reviewers.handles.length} assigned${unresolved}`;
};

/** Who, by name — untrusted handles out of `CODEOWNERS` or the project's configuration. */
export const reviewersBasisText = (reviewers: TaskReviewers | null): string => {
  if (reviewers === null) {
    return 'The rebase gate has not routed this merge request yet.';
  }
  const source =
    reviewers.source === 'codeowners'
      ? 'CODEOWNERS on the default branch'
      : reviewers.source === 'project_config'
        ? 'the project’s reviewers setting'
        : reviewers.source === 'requester'
          ? 'the human who asked for the task'
          : 'nothing';
  if (reviewers.handles.length === 0) {
    return `No CODEOWNERS match, no project reviewers and no mapped requester, so this merge request was assigned to nobody.`;
  }
  const unresolved =
    reviewers.unresolved.length === 0
      ? ''
      : ` No account on this provider for ${reviewers.unresolved.join(', ')}, so nobody was assigned for them.`;
  const truncated = reviewers.truncated
    ? ' More were routed than one merge request may carry.'
    : '';
  return `${reviewers.handles.join(', ')}, from ${source}.${unresolved}${truncated}`;
};

/** Seven characters, the way git prints one; the full sha is on the merge request. */
const shortSha = (sha: string): string => (sha.length > 7 ? sha.slice(0, 7) : sha);

/** product/19 §16's order, and the labels a person reads rather than the enum's own spelling. */
const HUMAN_TIME_KIND_LABELS: readonly (readonly [HumanTimeKind, string])[] = [
  ['review', 'review'],
  ['question', 'questions'],
  ['approval', 'approvals'],
  ['steer', 'steers'],
];

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

/**
 * One artifact's body, as React text nodes — WP-52, PROGRESS backlog 85.
 *
 * Every artifact on every task screen used to be a row a reader could see and not open: the task
 * projection published `url: null` as a literal and no route served a body. Both halves landed
 * together, because a read surface over `artifacts.data` before TD-012 applied at the write was a
 * way for a credential to leave the building (backlog 35, measured).
 *
 * **It renders JSON, not markup, and not a link.** The document is a model's structured output
 * (BD-022), so it goes through `UntrustedText` inside a `<pre>`: no markdown step, no sanitiser, no
 * `href` — and `apps/web/src/no-html.test.ts` fails the build if any of those appear. `<pre>` is a
 * layout decision about whitespace, not a rendering mode; the text is still a text node.
 *
 * An artifact stored **before** migration 0038 — when nothing redacted one — is refused by the API
 * with 409 `artifact_not_redacted` rather than served. The refusal arrives here as an ordinary
 * error and says so; it is not a rendering case.
 *
 * So every body this panel renders has passed TD-012 — **except a `ShadowReport`**, which the
 * platform assembles from its own rows rather than a run producing it, and which is therefore
 * written through an empty redactor with neither step applied (PROGRESS backlog **131**). Its
 * exposure is unchanged, and the evidence for that is the **endpoint** rather than the Shadow
 * screen — `GET /api/shadow-batches/:id` serves the whole document at `project.read`, while the
 * screen renders only three of its fields. The clause is here because the sentence above it was
 * written without it, not because this panel does anything different with one.
 */
const ArtifactBody = ({
  taskId,
  artifactId,
}: {
  readonly taskId: string;
  readonly artifactId: string;
}): ReactElement => {
  const body = useArtifactBody(taskId, artifactId);
  if (body.isPending) {
    return <Loading label="Loading artifact…" />;
  }
  if (body.isError) {
    return <ErrorNotice title="Artifact could not be loaded." detail={String(body.error)} />;
  }
  const artifact = body.data;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-fg-muted">
        {artifact.artifact_type} v{artifact.version} · schema {artifact.schema_version} ·{' '}
        {formatDateTime(artifact.created_at)} ·{' '}
        {`${artifact.redaction_count} redaction${artifact.redaction_count === 1 ? '' : 's'}`}
      </p>
      {artifact.markdown === null ? null : <UntrustedProse value={artifact.markdown} />}
      <pre className="overflow-x-auto rounded bg-bg-subtle p-2 text-xs">
        <UntrustedText value={JSON.stringify(artifact.data, null, 2)} />
      </pre>
    </div>
  );
};

export const TaskDetailScreen = ({ taskId }: { readonly taskId: string }): ReactElement => {
  useTopics([`task:${taskId}`]);
  const detail = useTask(taskId);
  const commands = useTaskCommands(taskId);
  const projects = useProjects();
  const { now } = useServices();
  // `strict: false` because two routes render this screen (`/tasks/$taskId` and
  // `/projects/$key/tasks/$taskId`) and both declare the same search schema; a strict read would
  // have to name one of them.
  const search = useSearch({ strict: false }) as { readonly artifact?: string };

  if (detail.isPending) {
    return <Loading label="Loading task…" />;
  }
  if (detail.isError) {
    return <ErrorNotice title="Task could not be loaded." detail={String(detail.error)} />;
  }

  const {
    task,
    stages,
    artifacts,
    questions,
    approvals,
    runs,
    human_time: humanTime,
  } = detail.data;
  // The route may be entered without a project key (from the inbox or the agents view), so the
  // link back to the board is resolved from the task's own project rather than from the URL.
  const projectKey =
    projects.data?.items.find((project) => project.id === task.project_id)?.key ?? null;
  const nowMs = now();
  // An unknown id opens nothing rather than erroring: the parameter is a *reference* to one of this
  // task's own artifacts, and a link that outlived the row is a closed panel.
  const openArtifactId = artifacts.find((artifact) => artifact.id === search.artifact)?.id ?? null;
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

        <AskThread taskId={task.id} artifacts={artifacts} />

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
                  <Card className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{artifact.artifact_type}</span>
                      <Badge>{`v${artifact.version}`}</Badge>
                      {/*
                       * A router `Link`, never an `href` (WP-52): the body is rendered on this
                       * screen rather than downloaded, and `?artifact=<id>` is what makes it
                       * addressable — the ask thread's `artifact` citation sets the same parameter.
                       * `url` on the DTO says where the *API* serves it, which is what an OpenAPI
                       * consumer needs and what a browser must not be sent to.
                       */}
                      <Link
                        to="."
                        search={(previous: Record<string, unknown>) => ({
                          ...previous,
                          artifact: openArtifactId === artifact.id ? undefined : artifact.id,
                        })}
                        className="ml-auto text-xs text-accent underline"
                      >
                        {openArtifactId === artifact.id ? 'Close' : 'Open'}
                      </Link>
                    </div>
                    {openArtifactId === artifact.id ? (
                      <ArtifactBody taskId={taskId} artifactId={artifact.id} />
                    ) : null}
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
          {/*
            **product/09:29's *"total cost of delivery"*, in the only honest form this build can
            print it** (WP-29, Q73). The dollars and the minutes are two numbers side by side and
            nothing here adds them: a single figure needs an hourly rate, no product document or
            configuration key supplies one, and a default would be rendered on every task page as
            though it had been measured.
          */}
          <Metric
            label="Human time"
            value={
              humanTime.entries === 0
                ? 'none recorded'
                : `${formatUsd(task.cost_actual_usd)} tokens · ${formatMinutes(humanTime.total_minutes)} human`
            }
            definition="Human minutes derived from events, never from tracking (product/19 §16): review from the first human comment on the merge request to the merge, capped at 8 h per calendar day and excluding gaps over 2 h; 30 min per question; 10 min flat per approval; 5 min flat per steer. The dollars and the minutes are shown side by side and are never added: that would need an hourly rate this platform does not have."
          />
          <p className="-mt-2 text-[11px] text-fg-muted">{humanTimeBreakdown(humanTime)}</p>
          {humanTime.by_user === null ? null : (
            <ul className="-mt-1 flex flex-col gap-0.5">
              {humanTime.by_user.map((entry) => (
                <li
                  key={entry.user_id ?? entry.external_author ?? 'unattributed'}
                  className="flex justify-between text-[11px] text-fg-muted"
                >
                  {/*
                    `user_name` is a platform user's own name and `external_author` is a provider
                    account id — somebody else's text either way (BD-022), so both go through
                    `UntrustedText` like every other string this app renders.
                  */}
                  <UntrustedText
                    value={entry.user_name ?? entry.external_author ?? 'unmapped account'}
                  />
                  <span>{formatMinutes(entry.minutes)}</span>
                </li>
              ))}
            </ul>
          )}
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
          {/*
            **The coverage delta** (WP-39, product/18:38 and product/10:38's Checks item). The value
            is four different answers and never a zero standing in for a missing number
            (`coverageValueText`); the line beneath names the base it was measured against, because a
            delta whose base nobody states is a number a maintainer cannot act on (standing rule 63).
          */}
          <Metric
            label="Coverage delta"
            value={coverageValueText(task.coverage)}
            definition="What this project's CI reports for the change, minus what it reports for the default branch, in percentage points (product/18:38). Shown when the pipeline reports coverage; 'not reported' means it does not, which is never the same as zero."
          />
          {/*
            The sentence carries a **branch name and two revisions** — repository text somebody
            chose (BD-022) — so it goes through `UntrustedText` like every other provider string on
            this screen, rather than being interpolated as though the platform had written it.
          */}
          <p className="-mt-2 text-[11px] text-fg-muted">
            <UntrustedText value={coverageBasisText(task.coverage)} />
          </p>
          {/*
            **The dependency status** (WP-38, product/04:58 and product/10:38's Checks item). The
            value is never a zero standing in for a missing number and never a blank standing in for
            an unasked question: "not checked" is the gate not having run, "none added" is it having
            run, and "licence not checked" is this instance having declared no registry host
            (standing rules 16 and 18).
          */}
          <Metric
            label="Dependencies"
            value={dependencyValueText(task.dependencies)}
            definition="Packages this change adds to a manifest or lockfile, and what the project's policy did about them (product/04:58): 'allow' proceeds, 'ask' raises the question below, 'block' sends the task back. Licence and last release come from a package registry an operator has declared; with none declared the platform asks nobody and says so."
          />
          {/*
            Package names, manifest paths and a registry's licence string — third-party text
            (BD-022) — so the sentence goes through `UntrustedText` like every other one here.
          */}
          <p className="-mt-2 text-[11px] text-fg-muted">
            <UntrustedText value={dependencyBasisText(task.dependencies)} />
          </p>
          {/*
            The package's page on the registry, when the platform asked one and it answered.
            Composed by the platform from the encoded name rather than taken from a model or a
            manifest — and still through `safeHref` like every URL this application renders, because
            a DTO field is `z.url()` and `z.url()` accepts `data:` (Q49).
          */}
          {(task.dependencies?.added ?? []).some((entry) => entry.metadata.source_url !== null) ? (
            <ul className="-mt-1 flex flex-wrap gap-2">
              {(task.dependencies?.added ?? []).map((entry) =>
                entry.metadata.source_url === null ? null : (
                  <li key={`${entry.ecosystem}:${entry.name}`}>
                    <ExternalLink
                      url={entry.metadata.source_url}
                      label={`${entry.ecosystem}:${entry.name}`}
                      className="text-[11px] text-accent underline"
                    />
                  </li>
                ),
              )}
            </ul>
          ) : null}
          {/*
            **Required reviewers** (WP-38's record of WP-37's routing). The handles are untrusted:
            `CODEOWNERS` is written by whoever can push to the repository.
          */}
          <Metric
            label="Required reviewers"
            value={reviewersValueText(task.required_reviewers)}
            definition="Who this merge request needs a review from, as the platform routed them (product/19:138): CODEOWNERS on the default branch first, then the project's reviewers setting, then the human who asked — plus anyone a risk class requires. A handle with no account on this provider is named rather than dropped."
          />
          <p className="-mt-2 text-[11px] text-fg-muted">
            <UntrustedText value={reviewersBasisText(task.required_reviewers)} />
          </p>
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
          {/*
            **The census of what this panel does not answer** (WP-38, criterion 5).

            product/10:38 lists eleven merge-readiness checks and this panel renders five of them:
            coverage delta, dependencies, risk classes and required reviewers, budget against the
            estimate, and questions pending. The other six are named here **with what exists for
            each** — rather than drawn as empty ticks that read as passed (standing rule 16) — and
            the list is held to product/10:38 **in a test** rather than in this comment, so it
            cannot go stale the way the sentence it replaces did:
            `apps/web/src/features/checks-panel.test.tsx` › "the Checks panel against product/10:38".

            That sentence said the pipeline producing CI and rebase status "lands with WP-15 and
            WP-38". Both shipped — the CI gate settles from `ci.pipeline.finished` (WP-15) and the
            rebase gate records `task.rebase.checked` (WP-26) — so what is missing is not a pipeline
            but a **projection**: nothing on this screen's DTO carries either, and no work package
            owns adding one (standing rule 83: a fix is what makes the old sentence false).
          */}
          <p className="text-[11px] text-fg-muted">
            Not on this panel: acceptance criteria met, CI green, rebase status, review threads
            open/resolved, business verdict, tamper check. The pipeline produces four of them and
            this screen does not read them — the CI gate settles from the provider's own pipeline
            event (WP-15), the rebase gate records every check (WP-26), the review window counts
            unresolved threads (BD-007), and both verdicts are artifacts in the tab beside this one.
            Acceptance criteria are written into the Refined Spec and judged in a verdict, and the
            tamper check (BD-024) has no producer at all. They are absent rather than shown as
            passing.
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
