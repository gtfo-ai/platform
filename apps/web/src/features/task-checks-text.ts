/**
 * The Checks rail's words — every value and every basis sentence the merge box prints, as pure
 * functions of the task's own record (product/10:38's eleven items; split out of `task-detail.tsx`
 * at S-23.9b so the rail, the header and their tests read one definition).
 *
 * Nothing here renders: a sentence that carries provider or repository text (a branch, a package
 * name, a CODEOWNERS handle) is still rendered by the caller through `UntrustedText` (BD-022). The
 * status each row draws (`*Status`) is the platform's reading of the same value, and never a tick
 * for a gate that has not decided.
 */
import type {
  AcceptanceVerdictData,
  HumanTimeKind,
  HumanTimeSummary,
  ReviewVerdictData,
  TaskCoverage,
  TaskDependencies,
  TaskDetailResponse,
  TaskRecord,
  TaskReviewers,
  TaskReviewThreads,
  TaskState,
  TaskStop,
} from '@platform/contracts';
import { BUILTIN_STAGE_IDS, isBuiltinGateStageId } from '@platform/contracts';
import { stageLabel } from '../ui/humanize.js';
import { formatDateTime, formatMinutes } from '../ui/kit.js';
import type { Status } from '../ui/status.js';
import { roughEstimateLine } from './approval-text.js';

/**
 * What the task's estimate rests on, as one sentence — the same four states the workpad prints.
 *
 * Platform text only: the numbers are the platform's own and no provider string reaches it, which
 * is why it is a plain string rather than an `UntrustedText`. The point of the line is that "the
 * estimator has not run" and "it ran and found nothing to estimate from" are different facts about
 * a project, and a blank field says neither (Q71 (b)).
 */
export const estimateBasisText = (task: TaskRecord): string => {
  // S-28.16 (M28 ruling B2): an estimate on too few finished tasks asks nobody, and says so.
  const rough = roughEstimateLine(task);
  if (rough !== null) {
    return rough;
  }
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
    return 'No human activity recorded on this task yet — no review comment, question, approval or message to an agent.';
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
  // S-25.5: *points*, spelled out — "pp" is a statistician's abbreviation (research/21 § 4).
  return `${coverage.delta_pct > 0 ? '+' : ''}${coverage.delta_pct.toFixed(1)} points`;
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
    return 'Reviewers are chosen at the up-to-date check, which this merge request has not reached yet.';
  }
  const source =
    reviewers.source === 'codeowners'
      ? 'the code owners file on the default branch'
      : reviewers.source === 'project_config'
        ? 'the project’s reviewers setting'
        : reviewers.source === 'requester'
          ? 'the person who asked for the task'
          : 'nothing';
  if (reviewers.handles.length === 0) {
    return `No code owner matches, the project names no reviewers and the person who asked has no account here, so this merge request was assigned to nobody.`;
  }
  const unresolved =
    reviewers.unresolved.length === 0
      ? ''
      : ` No account on the git host for ${reviewers.unresolved.join(', ')}, so nobody was assigned for them.`;
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
        ? 'sent back: protected files changed'
        : row.outcome === 'escalated'
          ? 'needed you, then sent back by a person'
          : `${words.fail}, sent back`;
    case 'failed':
      return needsYouText(row.outcome);
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
 *  - an escalation the CI gate closed `undecided` — **not checked** (S-25.15): the check is made
 *    when the gate settles, and this gate never settled, so the item is muted and does not count
 *    as a check that needs a person — the CI item beside it does. The row closes `undecided` for
 *    endings that differ: the pipeline never finished (the CI timeout, a Retry on the same held
 *    pipeline), the provider did not answer, the gate's checks ran out — and a pipeline that **did**
 *    finish whose changed files the provider never listed, so the check could not be made. Only the
 *    stop's `ci_ending` on this attempt (`ci_timed_out`, `ci_held_unchanged`) proves the pipeline
 *    was unfinished, so only then is it *not checked: CI didn't finish*; otherwise *not checked
 *    yet*, which is true of every ending (BACKLOG 1362 asks the server which it was);
 *  - any other escalation — the gate could not decide, which is what it says.
 *
 * A rebase row entered **before** the CI row belongs to an earlier round and is not read.
 */
export const tamperValueText = (
  ci: StageRow | null,
  rebase: StageRow | null = null,
  /** The task read's `stop`: its `ci_ending` says whether the pipeline was unfinished. */
  stop: TaskStop | null = null,
): string => {
  if (ci === null) {
    return 'not reached';
  }
  if (ci.state === 'running') {
    return 'checking';
  }
  switch (ci.outcome) {
    case 'protected_paths_changed':
      return 'changed, sent back';
    case 'protected_paths_awaiting_review':
      return settledConfirmationText(ci, rebase);
    case 'protected_paths_clean':
      // Not *untouched*: `judgeTamper` is also clean when protected files did change and every
      // change was declared and confirmed by the review (review of PR #84).
      return 'no unapproved changes';
    case 'pass':
      return TAMPER_NOT_RECORDED;
    default:
      return ci.state === 'returned'
        ? TAMPER_NOT_RECORDED
        : tamperNotChecked(ci)
          ? ciUnfinished(ci, stop)
            ? TAMPER_NOT_CHECKED
            : TAMPER_NOT_CHECKED_YET
          : needsYouText(ci.outcome);
  }
};

/** The words for a tamper check its CI gate never got to make, the pipeline unfinished (S-25.15). */
export const TAMPER_NOT_CHECKED = 'not checked: CI didn’t finish';

/** The same, when the row cannot say why the check was not made (BACKLOG 1362). */
export const TAMPER_NOT_CHECKED_YET = 'not checked yet';

/**
 * The stop proves this CI attempt's pipeline never finished: it timed out waiting, or a Retry found
 * the same held pipeline (`ci_ending`, recorded only for those two endings).
 */
const ciUnfinished = (ci: StageRow, stop: TaskStop | null): boolean =>
  stop !== null &&
  stop.stage === 'ci_gate' &&
  stop.attempt === ci.attempt &&
  (stop.ci_ending === 'ci_timed_out' || stop.ci_ending === 'ci_held_unchanged');

/**
 * The CI gate escalated without settling (`failed`, closed `undecided`): the tamper check is made in
 * the settlement, so it was not made at all — the item is *not checked*, never *needs you*.
 */
const tamperNotChecked = (ci: StageRow): boolean =>
  ci.state === 'failed' && ci.outcome === 'undecided';

/**
 * Why a check stopped and waits for a person, in words (S-25.5, research/21 § 4): the outcome its
 * row was closed with — `undecided`, `unsupported`, `converged` — is the platform's word, never
 * printed raw; any other is the bare *needs you*, and the timeline's line says the rest.
 */
const NEEDS_YOU_WORDS: Readonly<Record<string, string>> = {
  undecided: 'needs you: it could not decide',
  unsupported: 'needs you: it cannot be checked here',
  converged: 'needs you: the same failure repeated',
};

const needsYouText = (outcome: StageRow['outcome']): string =>
  outcome !== null && Object.hasOwn(NEEDS_YOU_WORDS, outcome)
    ? (NEEDS_YOU_WORDS[outcome] as string)
    : 'needs you';

/**
 * A CI row closed `pass` or `returned` with no tamper word. Two writers leave one: a gate that
 * settled before WP-105 recorded the check's outcome on the row (before WP-81 no check ran; from
 * WP-81 on a clean one wrote the same word), and — still, after WP-105 — a person's return or
 * rework out of a task stopped at `ci_gate`, which `applyDecision` closes `returned` with no gate
 * settling it (WP-105 review round 1). Neither is *clean*, and the row cannot say which it was, so
 * the label claims no date.
 */
export const TAMPER_NOT_RECORDED = 'not recorded';

/** The outcome of the rebase row entered after this CI row, or `null` when there is none yet. */
const settledConfirmation = (ci: StageRow, rebase: StageRow | null): StageRow['outcome'] =>
  rebase !== null && Date.parse(rebase.entered_at) >= Date.parse(ci.entered_at)
    ? rebase.outcome
    : null;

/** The rebase settlement's answer to a provisional CI pass (WP-102), or that none was read yet. */
const settledConfirmationText = (ci: StageRow, rebase: StageRow | null): string => {
  switch (settledConfirmation(ci, rebase)) {
    case 'protected_paths_confirmed':
      return 'declared changes confirmed by the code review';
    case 'protected_paths_changed':
      return 'declared changes not confirmed, sent back';
    default:
      return 'declared changes await the code review';
  }
};

/** Which attempt the value is about, and when it was decided — platform facts only. */
export const gateBasisText = (row: StageRow | null, gateId: string): string => {
  const gate = stageLabel(gateId);
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
export const keyedCriteria = (verdict: AcceptanceVerdictData) =>
  verdict.criteria.map((criterion, position) => ({ key: `criterion-${position}`, criterion }));

export const CRITERION_STATUS: Readonly<Record<string, string>> = {
  met: 'met',
  not_met: 'not met',
  untestable: 'untestable',
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

/** Seven characters, the way git prints one; the full sha is on the merge request. */
const shortSha = (sha: string): string => (sha.length > 7 ? sha.slice(0, 7) : sha);

/** product/19 §16's order, and the labels a person reads rather than the enum's own spelling. */
const HUMAN_TIME_KIND_LABELS: readonly (readonly [HumanTimeKind, string])[] = [
  ['review', 'review'],
  ['question', 'questions'],
  ['approval', 'approvals'],
  ['steer', 'messages to agents'],
];

// ── The merge box's statuses (S-23.9b) ───────────────────────────────────────
//
// Each row of the rail draws a `StatusIcon` beside its value, and the icon is the platform's reading
// of **the same record the value is read from** — never a second source. The rules are the values'
// own: a gate that has not decided is `queued` or `running`, never `success`; a record that cannot
// say what it found (*not recorded*, *unavailable*, *none read*) is `skipped`, which the summary
// counts as not passed; and what waits on a person is `needs_you`.

/** A gate's latest row (`gateValueText`'s five answers) as a status. */
export const gateStatus = (row: StageRow | null): Status => {
  if (row === null) {
    return 'queued';
  }
  switch (row.state) {
    case 'pending':
    case 'running':
      return 'running';
    case 'completed':
      return row.outcome === 'fail' ? 'failure' : 'success';
    case 'returned':
      // A person's return out of an escalation did not fail the gate (backlog 483).
      return row.outcome === 'escalated' ? 'waiting' : 'failure';
    case 'failed':
      return 'needs_you';
    case 'skipped':
      return 'skipped';
  }
};

/** `tamperValueText`'s answers as a status: *not recorded* is never drawn as a pass. */
export const tamperStatus = (ci: StageRow | null, rebase: StageRow | null = null): Status => {
  if (ci === null) {
    return 'queued';
  }
  if (ci.state === 'running') {
    return 'running';
  }
  switch (ci.outcome) {
    case 'protected_paths_changed':
      return 'failure';
    case 'protected_paths_awaiting_review':
      switch (settledConfirmation(ci, rebase)) {
        case 'protected_paths_confirmed':
          return 'success';
        case 'protected_paths_changed':
          return 'failure';
        default:
          return 'waiting';
      }
    case 'protected_paths_clean':
      return 'success';
    case 'pass':
      return 'skipped';
    default:
      // Not checked (S-25.15) is muted like *not recorded*: the CI item is the one that needs you.
      return ci.state === 'returned' || tamperNotChecked(ci) ? 'skipped' : 'needs_you';
  }
};

/** Unread is `queued`; open threads wait on their reviewers. */
export const reviewThreadsStatus = (threads: TaskReviewThreads | null): Status =>
  threads === null ? 'queued' : threads.open > 0 ? 'waiting' : 'success';

/** `dependencyValueText`'s answers as a status; a question nobody was asked needs you. */
export const dependencyStatus = (
  dependencies: TaskDependencies | null,
  state: TaskState | null = null,
): Status => {
  if (dependencies === null) {
    return 'queued';
  }
  if (dependencies.added.length === 0) {
    return dependencies.unread.length === 0 ? 'success' : 'skipped';
  }
  if (isAbandonedDeferral(dependencies, state)) {
    return 'skipped';
  }
  switch (dependencies.decision) {
    case 'block':
      return isDeferred(dependencies) ? 'waiting' : 'failure';
    case 'ask':
      return dependencies.question_id === null && isDeferred(dependencies)
        ? 'waiting'
        : 'needs_you';
    default:
      return 'success';
  }
};

/** Not routed is `queued`; a handle nobody could be assigned for waits. */
export const reviewersStatus = (reviewers: TaskReviewers | null): Status => {
  if (reviewers === null) {
    return 'queued';
  }
  if (reviewers.handles.length === 0) {
    return 'skipped';
  }
  return reviewers.unresolved.length > 0 ? 'waiting' : 'success';
};

/** Not measured and not reported are not a number; a fall in coverage waits on a reader. */
export const coverageStatus = (coverage: TaskCoverage | null): Status => {
  if (coverage === null) {
    return 'queued';
  }
  if (coverage.head_pct === null) {
    return 'skipped';
  }
  return coverage.delta_pct !== null && coverage.delta_pct < 0 ? 'waiting' : 'success';
};

/** Budget against the estimate: no estimate is `queued`, a spend past it waits on a reader. */
export const estimateStatus = (
  task: Pick<TaskRecord, 'estimate_usd' | 'cost_actual_usd'>,
): Status =>
  task.estimate_usd === null
    ? 'queued'
    : task.cost_actual_usd > task.estimate_usd
      ? 'waiting'
      : 'success';

/** The Acceptance Verdict's criteria as a status: one not met fails, one untestable waits. */
export const criteriaStatus = (verdict: AcceptanceVerdictData): Status => {
  if (verdict.criteria.length === 0) {
    return 'skipped';
  }
  if (verdict.criteria.some((criterion) => criterion.status === 'not_met')) {
    return 'failure';
  }
  return verdict.criteria.some((criterion) => criterion.status === 'untestable')
    ? 'waiting'
    : 'success';
};

/** What the merge box's summary line counts: a row's status and whether it gates the merge. */
export interface CheckOutcome {
  readonly status: Status;
  readonly required: boolean;
  /** A question or an approval — the needs-you callout's item, not a check (S-25.4). */
  readonly callout?: boolean;
}

const NEEDS_ATTENTION: ReadonlySet<Status> = new Set<Status>(['failure', 'needs_you']);

/** The line under the summary while a callout item waits: where it is, never a count of checks. */
export const CHECKS_CALLOUT_POINTER =
  'Questions and approvals waiting for a person are in the box above, not counted here.';

/**
 * Stages of the shipped flow that sit before the first gate in its order but are entered only from
 * a gate's failure (`conflict_resolution`, from the up-to-date check): never where checks start.
 */
const REACHED_FROM_A_GATE: ReadonlySet<string> = new Set(['conflict_resolution']);

/**
 * The stage the checks start at, derived from the shipped flow's order (`BUILTIN_STAGE_IDS`): the
 * stage before the first gate (`isBuiltinGateStageId`) that a task reaches in order — the one whose
 * merge request the first gate checks. *Implementation* on the shipped flow.
 */
export const CHECKS_START_STAGE: string = (() => {
  const firstGate = BUILTIN_STAGE_IDS.findIndex((id) => isBuiltinGateStageId(id));
  const before = BUILTIN_STAGE_IDS.slice(0, Math.max(firstGate, 0)).filter(
    (id) => !REACHED_FROM_A_GATE.has(id),
  );
  return before.at(-1) ?? 'implementation';
})();

/**
 * The templates whose pipeline reaches Implementation and the checks after it — the domain's
 * `TICKET_TEMPLATES` (feature, bug, chore), named here so the bundle carries no domain ring and held
 * to it by `task-page.test.tsx`. A spike or an epic split never reaches a check (review of #126).
 */
export const CHECKED_TEMPLATES: ReadonlySet<string> = new Set(['feature', 'bug', 'chore']);

/**
 * **Checks before any can run** (S-25.20): the sentence the merge box says in place of its count
 * while the task is at a stage of the shipped flow **before** the checks start, and no gate has a
 * row — *"Checks start at Implementation."*; at that stage itself, *"…when Implementation is
 * done."*. `null` otherwise: a template other than {@link CHECKED_TEMPLATES}, a project's own
 * stage, a finished task, or a task any gate has seen,
 * whose rows say what they say. Neutral, never a warning: nothing is late.
 */
export const checksNotStartedText = (
  task: Pick<TaskRecord, 'state' | 'current_stage' | 'template'>,
  stages: readonly StageRow[],
): string | null => {
  const current = task.current_stage ?? null;
  if (
    current === null ||
    task.state === 'done' ||
    task.state === 'cancelled' ||
    !CHECKED_TEMPLATES.has(task.template)
  ) {
    return null;
  }
  const order: readonly string[] = BUILTIN_STAGE_IDS;
  const at = order.indexOf(current);
  const start = order.indexOf(CHECKS_START_STAGE);
  if (at === -1 || start === -1 || at > start || REACHED_FROM_A_GATE.has(current)) {
    return null;
  }
  if (stages.some((row) => isBuiltinGateStageId(row.stage))) {
    return null;
  }
  const name = stageLabel(CHECKS_START_STAGE);
  return at === start ? `Checks start when ${name} is done.` : `Checks start at ${name}.`;
};

/**
 * The merge box's one line (GitHub's *"All checks have passed"*): how many **checks** need a
 * person, or — when none does — whether every **required** check passed. A required check that is
 * pending, not reached or not recorded is not a pass, so the line never says *pass* for a check
 * nobody made.
 *
 * A row marked `callout` (questions and approvals pending) is the needs-you callout's item and is
 * **not** counted (S-25.4, product/10's Checks amendment): before, one open question read "1 check
 * needs you" with a red ✕ beside the callout that already asked for the answer. While one waits,
 * `callout` is {@link CHECKS_CALLOUT_POINTER}; otherwise `null`. So *"All required checks pass"*
 * can stand beside a pending approval — the checks pass, and the approval is above.
 */
export const checksSummary = (
  rows: readonly CheckOutcome[],
  /** {@link checksNotStartedText}: said in place of the count, neutral, while no check can run. */
  notStarted: string | null = null,
): { readonly status: Status; readonly text: string; readonly callout: string | null } => {
  const checks = rows.filter((row) => row.callout !== true);
  const callout = rows.some((row) => row.callout === true && row.status !== 'success')
    ? CHECKS_CALLOUT_POINTER
    : null;
  const attention = checks.filter((row) => NEEDS_ATTENTION.has(row.status)).length;
  if (attention > 0) {
    return {
      status: 'failure',
      text: attention === 1 ? '1 check needs you' : `${attention} checks need you`,
      callout,
    };
  }
  // S-25.20: before any check can run, nothing is undecided yet — the line says when they start.
  if (notStarted !== null) {
    return { status: 'queued', text: notStarted, callout };
  }
  const open = checks.filter((row) => row.required && row.status !== 'success').length;
  if (open === 0) {
    return { status: 'success', text: 'All required checks pass', callout };
  }
  return {
    status: 'waiting',
    text:
      open === 1
        ? '1 required check is not decided yet'
        : `${open} required checks are not decided yet`,
    callout,
  };
};
