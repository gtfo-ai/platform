/**
 * Task detail (product/10 § "Task detail").
 *
 * Left: the stage timeline. Centre: artifacts, runs, questions and approvals. Right: the checks
 * panel, cost and links. Live on the `task:<id>` topic.
 *
 * **What the Checks panel shows, and what it cannot.** product/10:38 lists **eleven**
 * merge-readiness checks — acceptance criteria met, CI green, rebase status, review threads
 * open/resolved, business verdict, tamper check, coverage delta, dependency status, risk classes and
 * required reviewers, budget vs estimate, questions pending. This panel renders **all eleven**: the
 * coverage delta (WP-39), the dependency status (WP-38), risk classes **and required reviewers**
 * (WP-37's routing, WP-38's record of it), cost against the estimate — product/10's *"budget vs
 * estimate"* (WP-28) — questions pending with approvals beside it, since WP-46 the five that were
 * named absent before it: CI and rebase status off the gates' own `task_stages` rows (WP-55 closes
 * them with the verdict), review threads off the review window's `tasks.review_threads`, and the
 * business verdict and acceptance criteria off the latest Acceptance Verdict's body (WP-52's route)
 * — and since WP-81 the **tamper check**, BD-024's gate, off the CI gate's row too, because the
 * check is part of that gate's read and its verdict is the word the row is closed with — and, for a
 * change the plan declared, off the rebase gate's row after it, because since WP-102 (Q109 (b)) the
 * Code review's confirmation is read in the rebase gate's settlement. The whole
 * list is held to product/10:38 by `apps/web/src/features/checks-panel.test.tsx` › "the Checks
 * panel against product/10:38" **in both directions**, so neither this paragraph nor the panel can
 * go stale on its own (WP-38, criterion 5; WP-46; WP-81).
 *
 * **Which commands are here.** technical/09's screens table gives this screen `answer, approve,
 * retry, take over, feedback`; product/10 adds return-to-stage and rework. All of them are present:
 * pause, resume, cancel, answer, decide, **retry-stage**, **return-to-stage**, **rework**,
 * **feedback** and — since WP-44 — **take over** and **hand back** (`features/take-over.tsx`), which
 * this note used to list as absences because nothing rendered the branch, the resume lines and the
 * workspace's fate that `takeOverResponseSchema` carries (standing rule 83: the sentence that
 * described the gap is false the moment the gap closes). An epic-split task also carries the
 * breakdown panel (`features/breakdown-panel.tsx`), the acceptance surface WP-40 built no screen for.
 *
 * **Ask the task is here since WP-31** — `features/ask-thread.tsx`, between the approvals and the
 * artifacts. This note used to say that `taskDetailResponseSchema` had nowhere to carry a thread so
 * a question would post into a void; both halves are false now, and the sentence nearest the fix is
 * the one nobody re-reads (standing rule 83). The thread is a query of its own
 * (`GET /api/tasks/:id/asks`) rather than a field of the task DTO, for the reason that note
 * implied: an ask is answered by a run that takes a minute, on its own schedule.
 */
import type {
  AcceptanceVerdictData,
  ApprovalRecord,
  HumanTimeKind,
  HumanTimeSummary,
  QuestionRecord,
  ReviewVerdictData,
  TaskCoverage,
  TaskDependencies,
  TaskDetailResponse,
  TaskRecord,
  TaskReviewers,
  TaskReviewThreads,
  TaskStageOutcome,
  TaskStageOutcomeWord,
  TaskState,
} from '@platform/contracts';
import {
  acceptanceVerdictDataSchema,
  reviewVerdictDataSchema,
  stageVerdictSchema,
  taskStageOutcomeWordSchema,
} from '@platform/contracts';
import { Link, useSearch } from '@tanstack/react-router';
import { type ReactElement, useState } from 'react';
import { taskExportPath } from '../api/endpoints.js';
import { isForbiddenError, readErrorDetail } from '../api/read-error.js';
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
  Field,
  formatDateTime,
  formatElapsed,
  formatMinutes,
  formatRunCost,
  formatUsd,
  Loading,
  Metric,
  SectionHeading,
} from '../ui/kit.js';
import { DownloadLink, ExternalLink, UntrustedProse, UntrustedText } from '../ui/untrusted.js';
import { AskThread } from './ask-thread.js';
import { BreakdownPanel } from './breakdown-panel.js';
import { unmeasuredRunsText } from './cost-text.js';
import { FeedbackForm } from './feedback.js';
import { TakeOverPanel } from './take-over.js';

/**
 * **Raise this task's cap** (WP-131 review round 1) — shown on a task its budget paused, the one way
 * out of that pause: the cap is raised through `POST /api/tasks/:id/budget`, then the task is
 * resumed through the existing resume command. Only a figure above the cap in force is offered; the
 * server refuses the rest (409 `budget_not_raised`) and nothing here lowers a cap.
 */
const RaiseTaskCap = ({
  capUsd,
  commands,
}: {
  readonly capUsd: number;
  readonly commands: ReturnType<typeof useTaskCommands>;
}): ReactElement => {
  const [value, setValue] = useState<number | null>(null);
  const valid = value !== null && Number.isFinite(value) && value > capUsd;
  return (
    <Card className="flex flex-col gap-2">
      <SectionHeading>Paused for its budget</SectionHeading>
      <p className="text-xs text-fg-muted">
        {`This task's cap is ${formatUsd(capUsd)}. Raise it and the task resumes at the stage it stopped at; a run nobody measured stays held at its cap and is never counted as spent.`}
      </p>
      <Field
        label="New cap (USD)"
        hint={`Above ${formatUsd(capUsd)}.`}
        type="number"
        min={capUsd}
        step="any"
        value={value ?? ''}
        onChange={(event) => {
          const parsed = Number.parseFloat(event.target.value);
          setValue(Number.isFinite(parsed) ? parsed : null);
        }}
      />
      <div>
        <Button
          disabled={!valid || commands.raiseBudget.isPending}
          onClick={() => {
            if (valid) {
              commands.raiseBudget.mutate(value);
            }
          }}
        >
          Raise this task's cap
        </Button>
      </div>
      {commands.raiseBudget.isError ? <ErrorNotice title="The cap was not raised." /> : null}
    </Card>
  );
};

/**
 * *"Excludes 1 run nobody measured."* — now in `./cost-text.ts`, which the board card reads too
 * (WP-134, backlog 408); re-exported here for the task page's own test.
 */
export { unmeasuredRunsText };

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
 * What the human-time figure leaves out on purpose, or `null` when it leaves nothing out (WP-44,
 * PROGRESS backlog 190).
 *
 * The page applies the statistics' two exclusions: a machine's rows are not human time and are not
 * mentioned, and a review window an approval touched is **withheld** — kept out of the total and
 * said here, so the number is never silently lower than what was recorded (standing rule 16).
 */
export const humanTimeWithheldText = (humanTime: HumanTimeSummary): string | null => {
  const { entries, minutes } = humanTime.withheld;
  if (entries === 0) {
    return null;
  }
  const windows = entries === 1 ? '1 review window' : `${entries} review windows`;
  return `Not counted: ${windows} (${formatMinutes(minutes)}) an approval landed inside, withheld until the approval's author is confirmed — the statistics withhold the same.`;
};

/** The epic split's template id (`EPIC_SPLIT_TEMPLATE_ID` in the domain), the only task with a queue. */
export const EPIC_SPLIT_TEMPLATE = 'epic_split';

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

/** The gate's acting ending is waiting for the task to resume (WP-67, `deferred_stage`). */
const isDeferred = (dependencies: TaskDependencies): boolean =>
  (dependencies.deferred_stage ?? null) !== null;

/**
 * A deferred ending on a task that was **cancelled** while it waited, which will never resume
 * (PROGRESS backlog 265). The record keeps `deferred_stage` — nothing wakes the resume job for a
 * cancel, and clearing it would be a second writer of `tasks.dependencies` for the sake of a label
 * — so the panel is what reads the state and stops promising a resume that cannot happen.
 */
const isAbandonedDeferral = (dependencies: TaskDependencies, state: TaskState | null): boolean =>
  isDeferred(dependencies) && state === 'cancelled';

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
export const dependencyValueText = (
  dependencies: TaskDependencies | null,
  state: TaskState | null = null,
): string => {
  if (dependencies === null) {
    return 'not checked';
  }
  if (dependencies.added.length === 0) {
    return dependencies.unread.length === 0 ? 'none added' : 'none read';
  }
  const added = `${dependencies.added.length} added`;
  if (isAbandonedDeferral(dependencies, state)) {
    return `${added} · not applied — the task was cancelled`;
  }
  switch (dependencies.decision) {
    case 'block':
      // A deferred block (WP-67): the task was at a human-owned stop when the gate ran, and the
      // return is applied when it resumes — so it is not yet "blocked" in the sense of sent back.
      return isDeferred(dependencies) ? `${added} · blocked on resume` : `${added} · blocked`;
    case 'ask':
      // **`ask` with no question is not `waiting`.** The gate decides in a job, and a task that
      // stopped being active before that job fired gets the packages on this panel and nobody
      // asked — rare in production, where a stage takes minutes, and measured in the e2e tier where
      // a whole template walks in a second. Printing "waiting" for it would name a human who is not
      // coming (standing rule 18).
      if (dependencies.question_id !== null) {
        return `${added} · waiting`;
      }
      // Deferred (WP-67): a person had stopped the task, and the question is asked when it resumes.
      return isDeferred(dependencies) ? `${added} · asks on resume` : `${added} · not asked`;
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
export const dependencyBasisText = (
  dependencies: TaskDependencies | null,
  state: TaskState | null = null,
): string => {
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
  const unasked = isAbandonedDeferral(dependencies, state)
    ? ' A person had stopped the task when the gate ran, and it was cancelled before it resumed, so the policy was never applied.'
    : isDeferred(dependencies)
      ? dependencies.decision === 'ask'
        ? ' A person had stopped the task when the gate ran, so the question is asked when the task resumes.'
        : ' A person had stopped the task when the gate ran, so it goes back to the stage that added the package when it resumes.'
      : dependencies.decision === 'ask' && dependencies.question_id === null
        ? ' The task had already moved past the point where the platform parks it, and a task that has passed review is not interrupted with a question, so nobody was asked — decide here before you merge.'
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

type StageRow = TaskDetailResponse['stages'][number];

/**
 * The row of a stage's **latest** attempt, or `null` when the task never entered it (WP-46).
 *
 * The Checks panel's *CI green* and *rebase status* are the two gates' own rows: WP-55 closes a
 * gate's row with its verdict when it settles, and WP-46 closes it `failed` when it escalates, so
 * the row is the verdict and nothing here re-derives one from events. The latest attempt, because a
 * gate is re-entered after every implementation loop and after every move of the default branch —
 * an earlier attempt's `pass` says nothing about the head the merge request has now.
 */
export const latestStageRow = (stages: readonly StageRow[], stage: string): StageRow | null =>
  stages
    .filter((row) => row.stage === stage)
    .reduce<StageRow | null>(
      (latest, row) => (latest === null || row.attempt >= latest.attempt ? row : latest),
      null,
    );

/**
 * One gate's row as a value (WP-46). Five answers and none of them a tick drawn for a gate that
 * never ran: `not reached` is no row at all, `checking` a row still open, and an escalation names
 * the word its row was closed with (`undecided`, `unsupported`, `converged`) rather than reading
 * as a failure of the change.
 */
export const gateValueText = (
  row: StageRow | null,
  words: { readonly pass: string; readonly fail: string },
): string => {
  if (row === null) {
    return 'not reached';
  }
  switch (row.state) {
    case 'running':
      return 'checking';
    case 'completed':
      // A provisional pass of the CI gate (WP-81) is still the pipeline's pass, as is a pass whose
      // tamper check was recorded clean (WP-105), and a rebase gate that confirmed the declared
      // protected paths (WP-102) still found no conflict.
      return row.outcome === 'pass' ||
        row.outcome === 'protected_paths_awaiting_review' ||
        row.outcome === 'protected_paths_clean' ||
        row.outcome === 'protected_paths_confirmed'
        ? words.pass
        : row.outcome === 'fail'
          ? words.fail
          : 'passed';
    case 'returned':
      // WP-81: the CI gate's tamper check sent the task back, whatever the pipeline said — so the
      // CI item does not call it red; since WP-102 the rebase gate's settlement can too, and the
      // rebase item does not call that a conflict. PROGRESS backlog 483: a person who sends a task
      // back out of an escalation closes the parked attempt `escalated` — the gate did not fail.
      return row.outcome === 'protected_paths_changed'
        ? 'sent back by the tamper check'
        : row.outcome === 'escalated'
          ? 'escalated, then sent back by a person'
          : `${words.fail}, sent back`;
    case 'failed':
      return `escalated${row.outcome === null ? '' : ` (${row.outcome})`}`;
    default:
      return row.state;
  }
};

/**
 * **The tamper check** (WP-81, BD-024 §2) — the Checks panel's eleventh item, read off the CI gate's
 * latest row, because the check is part of that gate's read and its verdict is the word the row is
 * closed with — and, when that word is the provisional pass, off the **rebase gate's** row entered
 * after it, because since WP-102 (Q109 answered (b)) the Code review's confirmation of a declared
 * change is read in the rebase gate's settlement. Every answer is one a row supports, and none is a
 * tick for a gate that never decided:
 *
 *  - `protected_paths_changed` on the CI row — the gate sent the task back naming the paths;
 *  - `protected_paths_awaiting_review` on the CI row, then the rebase row after it:
 *     - `protected_paths_confirmed` — the settlement found every declared path confirmed;
 *     - `protected_paths_changed` — the settlement found one unconfirmed and sent the task back;
 *     - anything else, or no rebase row yet — the confirmation has not been read;
 *  - `protected_paths_clean` — the check was made and found nothing the change may not touch, on a
 *    pass or on a return for the pipeline's own failure (WP-105, PROGRESS backlog 280);
 *  - `pass`, or a return with no tamper word — **not recorded**: every settlement since WP-81 made
 *    the check, but until WP-105 a clean one closed its row with the same `pass`/`returned` a
 *    settlement before WP-81 wrote, and the row cannot tell the two apart. The item says so rather
 *    than drawing *clean* for a gate that may never have looked (standing rule 16);
 *  - an escalation — the gate could not decide, which is what it says.
 *
 * A rebase row entered **before** the CI row belongs to an earlier round and is not read.
 */
export const tamperValueText = (ci: StageRow | null, rebase: StageRow | null = null): string => {
  if (ci === null) {
    return 'not reached';
  }
  if (ci.state === 'running') {
    return 'checking';
  }
  switch (ci.outcome) {
    case 'protected_paths_changed':
      return 'protected paths changed, sent back';
    case 'protected_paths_awaiting_review':
      return settledConfirmationText(ci, rebase);
    case 'protected_paths_clean':
      return 'clean';
    case 'pass':
      return TAMPER_NOT_RECORDED;
    default:
      return ci.state === 'returned'
        ? TAMPER_NOT_RECORDED
        : `not decided${ci.outcome === null ? '' : ` (${ci.outcome})`}`;
  }
};

/**
 * A CI row closed `pass` or `returned` with no tamper word. Two writers leave one: a gate that
 * settled before WP-105 recorded the check's outcome on the row (before WP-81 no check ran; from
 * WP-81 on a clean one wrote the same word), and — still, after WP-105 — a person's return or
 * rework out of a task stopped at `ci_gate`, which `applyDecision` closes `returned` with no gate
 * settling it (WP-105 review round 1). Neither is *clean*, and the row cannot say which it was, so
 * the label claims no date.
 */
export const TAMPER_NOT_RECORDED = 'not recorded';

/** The rebase settlement's answer to a provisional CI pass (WP-102), or that none was read yet. */
const settledConfirmationText = (ci: StageRow, rebase: StageRow | null): string => {
  const after = rebase !== null && Date.parse(rebase.entered_at) >= Date.parse(ci.entered_at);
  switch (after ? rebase.outcome : null) {
    case 'protected_paths_confirmed':
      return 'declared changes confirmed by the code review';
    case 'protected_paths_changed':
      return 'declared changes not confirmed, sent back';
    default:
      return 'declared changes await the code review';
  }
};

/** Which attempt the value is about, and when it was decided — platform facts only. */
export const gateBasisText = (row: StageRow | null, gate: string): string => {
  if (row === null) {
    return `This task has not entered ${gate}.`;
  }
  const attempt = row.attempt > 1 ? `attempt ${row.attempt}` : 'first attempt';
  return row.exited_at === null
    ? `${gate}, ${attempt}, still deciding.`
    : `${gate}, ${attempt}, decided ${formatDateTime(row.exited_at)}.`;
};

/**
 * The review window's reading of the merge request's human threads (WP-46, backlog 95 item 3), or —
 * for a review-only task — the platform's own findings, labelled as such (WP-73, backlog 209).
 * `null` is *nobody has read them*, which is never drawn as `0 open`.
 */
export const reviewThreadsValueText = (threads: TaskReviewThreads | null): string =>
  threads === null
    ? 'not read'
    : threads.counts === 'platform_findings'
      ? `${threads.open} findings open · ${threads.resolved} resolved`
      : `${threads.open} open · ${threads.resolved} resolved`;

/**
 * The sentence under the count. It says **when** the number was read and which resolutions re-read
 * it (WP-73, revised at WP-90 — PROGRESS backlog 210). A comment opens BD-007's window, and since
 * WP-90 two resolution signals re-count without it: GitLab's merge-request event when *all* threads
 * are resolved (sent only by a project that requires resolved threads before merging), and a note
 * written into a resolved thread. One thread of several resolved without a note sends nothing, so
 * the number can still be older than the merge request.
 */
export const reviewThreadsBasisText = (threads: TaskReviewThreads | null): string =>
  threads === null
    ? 'The review window reads the merge request’s threads when a human comments on it while the task waits for merge; nobody has yet.'
    : threads.counts === 'platform_findings'
      ? `The platform’s own review findings on this merge request, as it read them back at ${formatDateTime(threads.checked_at)}; a human’s own threads are not counted here, and a finding resolved since then is not reflected.`
      : `Read at ${formatDateTime(threads.checked_at)}; a thread is open while it is resolvable, unresolved and has a human note. It is read again when a human comments, and when the merge request reports every thread resolved — which GitLab sends only for a project that requires resolved threads before merging. A thread resolved without a comment while others stay open is not counted until one of those happens — the number is as of that time.`;

/** The latest `AcceptanceVerdict` among the task's artifacts — the newest version wins. */
export const latestAcceptanceVerdict = (
  artifacts: TaskDetailResponse['artifacts'],
): TaskDetailResponse['artifacts'][number] | null =>
  artifacts
    .filter((artifact) => artifact.artifact_type === 'AcceptanceVerdict')
    .reduce<TaskDetailResponse['artifacts'][number] | null>(
      (latest, artifact) =>
        latest === null || artifact.version > latest.version ? artifact : latest,
      null,
    );

/** `k of n met`, with the other two statuses named when there are any. */
export const criteriaValueText = (verdict: AcceptanceVerdictData): string => {
  const count = (status: string) =>
    verdict.criteria.filter((criterion) => criterion.status === status).length;
  if (verdict.criteria.length === 0) {
    return 'none judged';
  }
  const others = [
    count('not_met') === 0 ? null : `${count('not_met')} not met`,
    count('untestable') === 0 ? null : `${count('untestable')} untestable`,
  ].filter((part) => part !== null);
  return `${count('met')} of ${verdict.criteria.length} met${others.length === 0 ? '' : `, ${others.join(', ')}`}`;
};

/**
 * Each criterion with a key for the list. A criterion id is model output and may repeat, so the key
 * is its position in the verdict — stable, because an artifact version is immutable (technical/02).
 */
const keyedCriteria = (verdict: AcceptanceVerdictData) =>
  verdict.criteria.map((criterion, position) => ({ key: `criterion-${position}`, criterion }));

const CRITERION_STATUS: Readonly<Record<string, string>> = {
  met: 'met',
  not_met: 'not met',
  untestable: 'untestable',
};

/**
 * **Business verdict** and **acceptance criteria met** (WP-46, backlog 95 items 4 and 5): the
 * latest `AcceptanceVerdict`'s own `verdict` and `criteria[]`, read through the artifact route
 * WP-52 built (`GET /api/artifacts/:id`) — a field that already exists, not a derivation.
 *
 * The body is model output (BD-022): each criterion's id and evidence is rendered through
 * `UntrustedText`. A body the route refuses — an artifact stored before redaction existed, answered
 * `409 artifact_not_redacted` — is named as such rather than drawn as "no verdict", and a body that
 * does not parse as an `AcceptanceVerdict` says so rather than guessing at its fields.
 */
const AcceptanceChecks = ({
  taskId,
  artifacts,
}: {
  readonly taskId: string;
  readonly artifacts: TaskDetailResponse['artifacts'];
}): ReactElement => {
  const latest = latestAcceptanceVerdict(artifacts);
  const body = useArtifactBody(taskId, latest?.id ?? null);
  const verdictDefinition =
    'The business review’s verdict on this change, from its latest Acceptance Verdict (product/04).';
  const criteriaDefinition =
    'The acceptance criteria the business review judged, from the same verdict, each with the reviewer’s evidence.';
  if (latest === null) {
    return (
      <>
        <Metric label="Business verdict" value="no verdict" definition={verdictDefinition} />
        <Metric label="Acceptance criteria" value="not judged" definition={criteriaDefinition} />
        <p className="-mt-2 text-[11px] text-fg-muted">
          No business review has produced an Acceptance Verdict on this task.
        </p>
      </>
    );
  }
  if (body.isPending) {
    return (
      <>
        <Metric label="Business verdict" value="reading…" definition={verdictDefinition} />
        <Metric label="Acceptance criteria" value="reading…" definition={criteriaDefinition} />
      </>
    );
  }
  const parsed = body.isError ? null : acceptanceVerdictDataSchema.safeParse(body.data.data);
  if (parsed === null || !parsed.success) {
    const why = body.isError
      ? `The Acceptance Verdict v${latest.version} was not served: ${String(body.error)}`
      : `The Acceptance Verdict v${latest.version} does not read as one, so nothing is shown from it.`;
    return (
      <>
        <Metric label="Business verdict" value="unavailable" definition={verdictDefinition} />
        <Metric label="Acceptance criteria" value="unavailable" definition={criteriaDefinition} />
        <p className="-mt-2 text-[11px] text-fg-muted">
          <UntrustedText value={why} />
        </p>
      </>
    );
  }
  const verdict = parsed.data;
  return (
    <>
      <Metric
        label="Business verdict"
        value={verdict.verdict === 'approve' ? 'approved' : 'changes requested'}
        definition={verdictDefinition}
      />
      <p className="-mt-2 text-[11px] text-fg-muted">{`Acceptance Verdict v${latest.version}.`}</p>
      <Metric
        label="Acceptance criteria"
        value={criteriaValueText(verdict)}
        definition={criteriaDefinition}
      />
      {verdict.criteria.length === 0 ? null : (
        <ul className="-mt-1 flex flex-col gap-0.5">
          {keyedCriteria(verdict).map(({ key, criterion }) => (
            <li key={key} className="text-[11px] text-fg-muted">
              {`${CRITERION_STATUS[criterion.status] ?? criterion.status} · `}
              <UntrustedText value={`${criterion.id} — ${criterion.evidence}`} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
};

/**
 * **The word→sentence table of `task_stages.outcome`** (WP-73, PROGRESS backlog 213). The platform's
 * own words are an exhaustive `switch` — a word added to `taskStageOutcomeWordSchema` without a
 * sentence here fails `tsc` — and the two families the vocabulary includes by reference are said
 * generically: a stage verdict, and the event that moved a human stage.
 */
export const stageOutcomeWordSentence = (word: TaskStageOutcomeWord): string => {
  switch (word) {
    case 'returned':
      return 'Sent the task back to an earlier stage.';
    case 'superseded':
      return 'Ended when the stage was entered again as a new attempt.';
    case 'left':
      return 'Ended when the task entered another stage.';
    case 'cancelled':
      return 'Ended because the task was cancelled.';
    case 'system':
      return 'Completed by the platform on entry.';
    case 'failed':
      return 'The run failed, could not start, or its process stopped renewing it.';
    case 'escalated':
      return 'Escalated to a human.';
    case 'undecided':
      return 'Escalated: the gate could not decide in its allotted checks.';
    case 'unsupported':
      return 'Escalated: the project’s integrations cannot answer this gate.';
    case 'converged':
      return 'Escalated: the same failure repeated, so another round would not help.';
    case 'question.expired':
      return 'Escalated: a question expired unanswered.';
    case 'approval.expired':
      return 'Escalated: an approval expired undecided.';
    case 'budget.rejected':
      return 'Escalated: the budget approval was rejected.';
    case 'plan.rejected':
      return 'Sent back: a maintainer rejected the plan, and the next attempt is given the reason.';
    case 'take_over.expired':
      return 'Escalated: the take-over saw no activity for five working days.';
    case 'write_conflict':
      return 'Escalated: the platform’s write lost every retry against another writer.';
    case 'dead_lettered':
      return 'Escalated: an event about this task could not be processed.';
    case 'repository_config_invalid':
      return 'Escalated: the repository’s .agentic/config.yml does not parse.';
    case 'settings_config_invalid':
      return 'Escalated: the project’s stored settings do not parse under this release.';
    case 'context_budget_above_ceiling':
      return 'Escalated: the project’s context budget is above this release’s ceiling.';
    case 'protected_paths_changed':
      return 'Sent the task back: the change touches protected paths the plan did not declare or the code review did not confirm (BD-024).';
    case 'protected_paths_awaiting_review':
      return 'Passed; the protected paths the plan declared await the code review, whose confirmation the rebase gate checks before Ready.';
    case 'protected_paths_clean':
      return 'The tamper check found no protected path the change may not touch; the pipeline decided the gate (BD-024).';
    case 'protected_paths_confirmed':
      return 'Passed; the code review confirmed every protected path the plan declared (BD-024).';
    case 'unknown':
      return 'Finished without a verdict.';
    case 'unrecognised':
      return 'Finished with a verdict the platform does not recognise.';
  }
};

/** Any `task_stages.outcome` as a sentence: the table above, a verdict, or an event's name. */
export const stageOutcomeSentence = (outcome: TaskStageOutcome): string => {
  const word = taskStageOutcomeWordSchema.safeParse(outcome);
  if (word.success) {
    return stageOutcomeWordSentence(word.data);
  }
  if (stageVerdictSchema.safeParse(outcome).success) {
    return `Verdict: ${outcome.replace('_', ' ')}.`;
  }
  // The one event name the platform writes as an ending rather than as a move (`closeCurrentStageRow`).
  if (outcome === 'task.completed') {
    return 'Ended because the task completed.';
  }
  return `Moved on by ${outcome}.`;
};

/** The latest `ReviewVerdict` among the task's artifacts — the newest version wins. */
export const latestReviewVerdict = (
  artifacts: TaskDetailResponse['artifacts'],
): TaskDetailResponse['artifacts'][number] | null =>
  artifacts
    .filter((artifact) => artifact.artifact_type === 'ReviewVerdict')
    .reduce<TaskDetailResponse['artifacts'][number] | null>(
      (latest, artifact) =>
        latest === null || artifact.version > latest.version ? artifact : latest,
      null,
    );

/**
 * What a Review Verdict's `checklists_applied` says, one line per list (WP-73, PROGRESS backlog
 * 217). The three values are three different statements and none stands in for another: `[]` is
 * *"given none"*, a list is what the prompt carried, and `null`/absent is *"not recorded"* — never
 * rendered as *none* (standing rule 16).
 */
export const checklistsAppliedLines = (
  applied: ReviewVerdictData['checklists_applied'],
): readonly string[] => {
  if (applied === null || applied === undefined) {
    return ['Review checklists: not recorded on this verdict.'];
  }
  if (applied.length === 0) {
    return ['Review checklists: the reviewer was given none.'];
  }
  return applied.map(
    (entry) =>
      `Reviewer given ${entry.item_count} item${entry.item_count === 1 ? '' : 's'} from checklist ${entry.name}${entry.truncated ? ' (cut by the prompt’s bound)' : ''} (required by: ${entry.required_by.length === 0 ? 'no class' : entry.required_by.join(', ')}).`,
  );
};

/**
 * **Which review checklists the Reviewer was given** (WP-73, PROGRESS backlog 217): the platform's
 * own record on the latest Review Verdict (WP-45), read through the artifact route as the
 * Acceptance Verdict is. A line beside the risk classes rather than a twelfth Checks item —
 * product/10:38's eleven are held both ways by `checks-panel.test.tsx`. The list names are project
 * configuration and go through `UntrustedText` like every other string on this panel.
 */
const ReviewChecklists = ({
  taskId,
  artifacts,
}: {
  readonly taskId: string;
  readonly artifacts: TaskDetailResponse['artifacts'];
}): ReactElement | null => {
  const latest = latestReviewVerdict(artifacts);
  const body = useArtifactBody(taskId, latest?.id ?? null);
  if (latest === null || body.isPending) {
    return null;
  }
  const parsed = body.isError ? null : reviewVerdictDataSchema.safeParse(body.data.data);
  const lines =
    parsed === null || !parsed.success
      ? [`Review checklists: unavailable — the Review Verdict v${latest.version} was not read.`]
      : checklistsAppliedLines(parsed.data.checklists_applied);
  return (
    <ul className="-mt-1 flex flex-col gap-0.5">
      {lines.map((line) => (
        <li key={line} className="text-[11px] text-fg-muted">
          <UntrustedText value={line} />
        </li>
      ))}
    </ul>
  );
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
 * 18) and is the one thing an `ErrorNotice` would state wrongly. **Only** a 403 (WP-122, backlog
 * 385): a 503 or a 500 was rendered as the same role sentence, so an outage read as a missing role.
 */
const TaskActivity = ({ taskId }: { readonly taskId: string }): ReactElement => {
  const audit = useTaskAudit(taskId);
  return (
    <div>
      <SectionHeading>Who did what</SectionHeading>
      {audit.isPending ? <Loading label="Loading this task's activity…" /> : null}
      {audit.error === null || audit.error === undefined ? null : isForbiddenError(audit.error) ? (
        <EmptyState
          title="Not shown"
          hint={readErrorDetail(
            audit.error,
            'Every human action on this task is recorded; reading the record needs the maintainer role.',
          )}
        />
      ) : (
        // WP-122 (backlog 385): an outage is not a role. Only a 403 is "not shown"; anything else is
        // a failure, stated as the server stated it.
        <ErrorNotice
          title="This task's activity could not be loaded."
          detail={readErrorDetail(audit.error, 'Reading the record needs the maintainer role.')}
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
  state,
  stages,
  commands,
}: {
  readonly state: string;
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
      {/*
        PROGRESS backlog 483: the person handling an escalation is the one who knows which stage
        should run again, and since then the server accepts a return and a rework out of
        `needs_human`. The controls were never hidden for it; this says they are the way out.
      */}
      {state === 'needs_human' ? (
        <p className="text-sm text-fg-muted">
          This task is waiting for a person. Send it back to a stage it has run, with a note the
          stage is given, rework it from there, or retry the stage it stopped at.
        </p>
      ) : null}
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
    taken_over: takenOver,
    can_raise_budget: canRaiseBudget,
    can_export: canExport,
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
  const ciGate = latestStageRow(stages, 'ci_gate');
  const rebaseGate = latestStageRow(stages, 'rebase_gate');
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
                      <UntrustedText value={stageOutcomeSentence(stage.outcome)} />
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
          {/*
            product/09's *"Export as JSON per task"* (WP-112's route, WP-122's link, backlog 381):
            offered only to a caller the route would admit (`can_export`, `task.export`), through
            `DownloadLink` — the one renderer that may write a URL attribute.
          */}
          {canExport ? (
            <DownloadLink
              path={taskExportPath(task.id)}
              label="Download JSON"
              className="text-xs text-accent underline"
            />
          ) : null}
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

        {/*
          WP-131 review round 2: only a task **its own cap** paused (`paused_budget_scope: 'task'`),
          and only for a caller the route would admit (`can_raise_budget`, `budget.write`). A
          project's or an organisation's pause is raised where that cap is set — raising this one
          for it would loosen it for good and resume into the same pause — and the route refuses it
          too (409 `not_paused_by_task_cap`), so this is not the only guard.
        */}
        {canRaiseBudget &&
        task.state === 'paused' &&
        task.paused_reason === 'budget' &&
        task.paused_budget_scope === 'task' ? (
          <RaiseTaskCap capUsd={task.budget_cap_usd} commands={commands} />
        ) : null}

        <div>
          <SectionHeading>Stage commands</SectionHeading>
          <StageCommands state={task.state} stages={stages} commands={commands} />
        </div>

        <TakeOverPanel taskId={task.id} state={task.state} takenOver={takenOver} runs={runs} />

        <BreakdownPanel taskId={task.id} enabled={task.template === EPIC_SPLIT_TEMPLATE} />

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
                      {run.stage === null ? run.role : `${run.stage} · ${run.role}`}
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
                    {/* Backlog 467: the run's unfinished work is on the task's branch. */}
                    {run.saved_work?.pushed === true ? (
                      <Badge tone="warning">work saved to branch</Badge>
                    ) : null}
                    <span className="text-xs text-fg-muted">
                      <UntrustedText value={run.model} />
                    </span>
                    <span className="ml-auto text-xs text-fg-muted">
                      {formatRunCost(run.cost)} · {formatElapsed(run.started_at, nowMs)}
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
            definition="Provider-reported cost of every measured run on this task; estimated in local provider mode (BD-011). A run that ended without a figure is left out of the sum, and counted beneath it when there is one."
          />
          {/*
            **What the total leaves out** (WP-131, PROGRESS backlog 403). `cost_actual_usd` adds only
            the runs that have a figure; a run that ended with nobody measuring it adds nothing, and
            the total alone would read as the whole. The count is the projection's, over the same
            runs every cap holds at their reservations.
          */}
          {task.unmeasured_runs > 0 ? (
            <p className="-mt-2 text-[11px] text-fg-muted">
              {unmeasuredRunsText(task.unmeasured_runs)}
            </p>
          ) : null}
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
          {humanTimeWithheldText(humanTime) === null ? null : (
            <p className="-mt-2 text-[11px] text-fg-muted">{humanTimeWithheldText(humanTime)}</p>
          )}
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
            **The two gates' own verdicts** (WP-46, backlog 95 items 1 and 2, on WP-55's rows). The
            value is the latest attempt's row — `completed` with the gate's word, `returned` when it
            sent the task back, `failed` with the word an escalation closed it with — and never a
            tick for a gate the task has not reached.
          */}
          <Metric
            label="CI status"
            value={gateValueText(ciGate, { pass: 'green', fail: 'red' })}
            definition="The CI gate's verdict on the merge request's head, from the provider's own pipeline (product/04 S4); an escalation names the reason the gate could not decide."
          />
          <p className="-mt-2 text-[11px] text-fg-muted">{gateBasisText(ciGate, 'ci_gate')}</p>
          {/*
            **The tamper check** (WP-81, BD-024 §2): part of the CI gate's read, so its verdict is
            the word the same row is closed with — and for a declared change the rebase gate's
            settlement after it (WP-102) — never a tick for a gate that has not decided, and never
            *clean* for a row that does not say the check ran (WP-105).
          */}
          <Metric
            label="Tamper check"
            value={tamperValueText(ciGate, rebaseGate)}
            definition="BD-024's check: the existing files this change modifies, deletes or renames away, against the project's protected paths (tests and CI/lint configuration by default), minus the changes the plan declared and the code review confirmed. The CI gate makes it; a change the plan declared passes there until the rebase gate, just before Ready, reads the code review's confirmation. Anything left sends the task back to the developer, naming the paths; adding a new file is never flagged. A CI gate that settled before WP-105 kept no word for what its check found, and is never shown as clean."
          />
          <Metric
            label="Rebase status"
            value={gateValueText(rebaseGate, { pass: 'up to date', fail: 'conflicts' })}
            definition="The rebase gate's verdict: whether the merge request merges cleanly onto the default branch as it is now (BD-030). It is checked again every time the default branch moves while the task waits for its merge, and whenever a person brings the task back to Ready (WP-105)."
          />
          <p className="-mt-2 text-[11px] text-fg-muted">
            {gateBasisText(rebaseGate, 'rebase_gate')}
          </p>
          <Metric
            label="Review threads"
            value={reviewThreadsValueText(task.review_threads)}
            definition="Human review threads on the merge request, as BD-007's review window last read them: open threads send the task back to Implementation with the reviewers' comments."
          />
          <p className="-mt-2 text-[11px] text-fg-muted">
            {reviewThreadsBasisText(task.review_threads)}
          </p>
          <AcceptanceChecks taskId={taskId} artifacts={artifacts} />
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
            value={dependencyValueText(task.dependencies, task.state)}
            definition="Packages this change adds to a manifest or lockfile, and what the project's policy did about them (product/04:58): 'allow' proceeds, 'ask' raises the question below, 'block' sends the task back. Licence and last release come from a package registry an operator has declared; with none declared the platform asks nobody and says so."
          />
          {/*
            Package names, manifest paths and a registry's licence string — third-party text
            (BD-022) — so the sentence goes through `UntrustedText` like every other one here.
          */}
          <p className="-mt-2 text-[11px] text-fg-muted">
            <UntrustedText value={dependencyBasisText(task.dependencies, task.state)} />
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
          <ReviewChecklists taskId={taskId} artifacts={artifacts} />
          {/*
            **Every item of product/10:38 is on this panel** (WP-81). The census that named what it
            did not answer — the tamper check, until BD-024's gate had a producer — is held in a
            test in both directions, so an item that stops rendering fails it:
            `apps/web/src/features/checks-panel.test.tsx`.
          */}
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
