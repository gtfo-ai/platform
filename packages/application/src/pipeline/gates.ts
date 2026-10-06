/**
 * Gate evaluation — product/04's S4 (CI), S6b (rebase) and S8 (merged).
 *
 * A gate is "a deterministic check". Three of them are the platform's own and are evaluated here;
 * anything else a template declares is resolved by its `on` event, or by a `command`, which needs
 * a workspace and is therefore not evaluated yet — and says so rather than passing.
 *
 * ## The rebase gate does **not** read `mergeable`
 *
 * `mergeable: true` means "the provider would let you press merge", which is not the question. The
 * rebase gate asks "does this branch still apply to the target", and the field that answers it is
 * `has_conflicts`. The two differ in both directions: a provider can report `mergeable: true` for
 * a branch that is behind the target (nothing conflicts, but the project may require a linear
 * history), and it reports `mergeable: false` for an unrelated reason such as a failing pipeline
 * or a missing approval, neither of which a rebase would fix.
 *
 * And `has_conflicts: null` is a **third** answer, not a false one: the provider has not finished
 * computing it. Treating unknown as "no conflicts" merges a conflicted branch; treating it as
 * "conflicted" sends a clean branch to a resolution run with nothing to fix. So it is neither — the
 * gate reports `pending` and the job re-runs it, a bounded number of times.
 *
 * ## What happens after it says `false` — and what this module does *not* do (WP-26)
 *
 * It runs no command and touches no working copy: the gate is a **read**, and product/04 S6b's
 * *"rebase, resolve conflicts, re-run CI"* is the template's answer to a failure rather than this
 * function's. `rebase_gate.fail_to` is `conflict_resolution`, an agent stage declared behind
 * `ci_gate` (`packages/domain/src/pipeline/templates.ts`), so the failure is a **return** that
 * spends a round of the `rebase` loop — product/04 S6b's *"bounded, default 2 attempts"*, with the
 * escalation at the end of it belonging to `returnToStage` like every other loop — and the
 * resolution's own fall-through re-enters the CI gate above.
 *
 * The settlement's *measurement* is not here either: `task.rebase.checked` is appended by the job
 * that settled the gate (`rebase.ts`), because this module returns a value and writes nothing.
 *
 * ## What a failed CI gate says (Q55 closed, WP-81)
 *
 * The failure branch settles `passed: false`, names every failing job, and hands back **every
 * failing job's log** (up to `MAX_CI_LOG_JOBS`, backlog 485; the first one only until then) —
 * product/04 S4's *"failing job's error block"*, BD-024 §5 — each read through `getJobLog`,
 * redacted by the git binding's redactor (TD-012's two steps plus every minted shape, WP-80) on the
 * whole text and only then bounded to its share of one budget, the end first (`ci-log.ts`), and
 * labelled with its job's name. The `detail` is stored on the task as the return reason and handed
 * to the next Implementation run inside its `return_feedback` data block; the cuts travel as
 * `detailOriginalChars` and are announced in that block's marker, never in the body. A log the
 * platform could not read is **said** in the detail by its job's name, and so are the jobs past
 * the cap. Until WP-81 this gate returned the job names only, because a minted run credential had
 * no redactor on the pipeline's path (Q55); WP-76 and WP-80 gave it one, and the pin in
 * `gates.test.ts` is inverted by name rather than deleted.
 *
 * ## The tamper check is part of this gate's read (WP-81, BD-024 §2)
 *
 * When the pipeline is terminal — or the project has none for the head — the gate also compares
 * the merge request's changed paths with the protected paths and the plan's declared, review-
 * confirmed exceptions (`tamper.ts` has the rule and its reasoning). A change that touches a
 * protected path it may not fails the gate whatever the pipeline said: a **return to the
 * Developer**, spending the `ci_fix` loop like a red pipeline (`RETURN_LOOPS.ci_gate`), closed with
 * the outcome word `protected_paths_changed`. One settlement function, {@link judgeCiSettlement},
 * serves both paths that settle this gate — the poll below and the pipeline's event
 * (`ci-settle.ts`) — so neither is a side door past the check.
 *
 * **Its second half is not here** (WP-102, Q109 answered (b)): a path the plan declared and no
 * review has judged yet is passed provisionally with its head and recorded on the task, and the
 * rebase gate's settlement (`jobs.ts`) reads the latest Review Verdict's confirmation of it in its
 * own transaction — which returns the task on `ci_fix`, as this gate would have.
 *
 * That file also executes every branch of this module, including each `unsupported` refusal, and
 * the e2e drives the CI failure end to end (`test/e2e/pipeline`, "when the merge request's
 * pipeline is red"). Both exist because of what the round-1 review measured: settling
 * `CI_TERMINAL_FAIL` as `passed: true` left the whole unit+contract tier green, and a task
 * advanced to code review on red CI. This is a guard, and an untested guard fails open in silence.
 */
import type { Id, TaskStageOutcome } from '@platform/contracts';
import {
  DEFAULT_CI_TIMEOUT_MINUTES,
  isBuiltinGateStageId,
  MAX_CI_TIMEOUT_MINUTES,
  MIN_CI_TIMEOUT_MINUTES,
} from '@platform/contracts';
import type { CompiledPipeline, PipelineStage } from '@platform/domain';
import { stageOf } from '@platform/domain';
import {
  isPresencePath,
  isRepositoryFilePath,
  type RepositoryFileSource,
} from '../config/repository-config.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type { CiConfigLocation, PipelineStatus } from '../ports/integrations/git-provider.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import {
  type FailingJobLogs,
  type FailingJobRef,
  failingJobs,
  readFailingJobLogs,
} from './ci-log.js';
import { coalescedMergeRequestDiff, MAX_CONFLICT_FILES } from './diff-coalescer.js';
import { type TransientProviderCode, transientProviderFailure } from './gate-outage.js';
import type { PipelineIntegrations, PipelineIntegrationsPort } from './integrations.js';
import { gitReads, integrationsForProject, noRunScopedSecrets } from './integrations.js';
import type { ProjectSettings, ProjectSettingsPort } from './settings.js';
import { effectiveProtectedPaths, withCiConfigPath } from './settings.js';
import type { PipelineStore, StoredTask } from './store.js';
import { changedExistingPaths, exceptionsOf, judgeTamper, tamperFailureDetail } from './tamper.js';

export type GateResult =
  | {
      readonly kind: 'settled';
      readonly passed: boolean;
      readonly detail: string;
      /**
       * The CI gate's failure, stated so that three identical ones in a row can be recognised
       * (product/04 S4) on **this** path as well as the event path (WP-60 review round 2):
       * `ci:<status>:<failing jobs, sorted>` — stable across attempts, because the head moves every
       * round.
       */
      readonly ciSignature?: string;
      /**
       * The branch head the gate read — the live head the CI gate asked the pipeline status of, or
       * the one the rebase gate's merge-request read carried (WP-79). The settlement records the CI
       * gate's as `tasks.ci_head_sha`, and a rebase head as `tasks.ready_head_sha` when it moves
       * the task into `ready_for_merge` — only if it is the head CI passed (`rebaseAgainstCi`,
       * review round 2), because a rebase read judges mergeability, not the commits. That is what a
       * later resume or hand-back into Ready is compared with. Absent when the gate read no head.
       */
      readonly headSha?: string;
      /**
       * The word the gate's row is closed with instead of `pass`/`fail`/`returned` (WP-81): the
       * tamper check's `protected_paths_changed` on its return, `protected_paths_awaiting_review` on
       * a provisional pass, and since WP-105 `protected_paths_clean` on a clean one — every CI
       * settlement names what the check found, on a red pipeline's return too. Absent for the
       * rebase and merged gates, whose settlements make no tamper check.
       */
      readonly outcome?: TaskStageOutcome;
      /**
       * The protected paths a **provisional** CI pass excused until the Code review confirms them
       * (WP-102, Q109 (b)), redacted — present exactly when `outcome` is
       * `protected_paths_awaiting_review`. The settlement records them as `tasks.ci_excused_paths`
       * beside `ci_head_sha`, and the rebase gate's settlement compares them with the latest Review
       * Verdict before Ready.
       */
      readonly excusedPaths?: readonly string[];
      /**
       * The length `detail` would have had uncut, when the gate cut the failing job's log to its head
       * and tail (WP-81). Stored beside the return reason so the prompt's marker announces the cut.
       */
      readonly detailOriginalChars?: number;
    }
  /**
   * The answer is not available yet; the job asks again. `ciWait` is present exactly when the CI
   * gate is waiting on a **poll-only** git binding (WP-136): the job then bounds the wait by time
   * rather than by {@link MAX_GATE_CHECKS} (`ci-wait.ts`).
   */
  | { readonly kind: 'pending'; readonly detail: string; readonly ciWait?: CiWait }
  /** The platform cannot evaluate this gate at all; the task escalates. */
  | { readonly kind: 'unsupported'; readonly detail: string };

/**
 * One CI failure as the convergence rule records it: `ci:<status>:<failing jobs, sorted>@<sha>`.
 *
 * The part before `@` is the failure's **shape** — stable across attempts, because the head moves
 * every round, and what "three identical failures" compares. The part after it is **which
 * pipeline** failed, so that one pipeline observed twice — by the poll and by its event, or by two
 * polls of a head nobody moved — counts once, whichever path settled it (WP-60 review round 3,
 * `jobs.ts` § `ciConvergence`). One definition for the event path (`ci-settle.ts`) and the poll
 * path (this module).
 */
export const ciFailureSignature = (
  status: string,
  failingJobs: readonly string[],
  headSha: string,
): string => `ci:${status}:${[...failingJobs].sort().join(',')}@${headSha}`;

/** The CI gate's stage id on every shipped ticket template. */
export const CI_GATE_STAGE = 'ci_gate' as const;

/**
 * **Does the rebase gate's head agree with the head CI passed?** (WP-79 review round 2, PROGRESS
 * backlog 275.)
 *
 * The rebase gate is the last thing a task passes before Ready, and the head it read is what Ready
 * records as judged (`tasks.ready_head_sha`). Before this it recorded that head whether or not CI
 * had ever run on it: a push between the CI settlement and the rebase evaluation (the review stages
 * run in between — backlog 275's race), or a human handing a task back at `code_review` or
 * `rebase_gate` after pushing, reached Ready with a head CI never judged — and every later resume
 * trusted it. So the settlement asks this first, and on a template that runs `ci_gate`:
 *
 *  - the rebase head equals `tasks.ci_head_sha` (written by the CI settlement) → agree;
 *  - otherwise — a different head, no CI-passed head, or a rebase read that named no head → CI
 *    must judge again (`reenter_ci`).
 *
 * A template that does not run `ci_gate` has nothing to agree with, and passes as before. Pure, so
 * each branch is unit-tested (`gates.test.ts`); `jobs.ts`'s settlement acts on it.
 */
export const rebaseAgainstCi = (
  pipeline: CompiledPipeline,
  ciHeadSha: string | null,
  rebaseHead: string | undefined,
): { readonly kind: 'agree' } | { readonly kind: 'reenter_ci'; readonly reason: string } => {
  const ci = stageOf(pipeline, CI_GATE_STAGE);
  if (ci === null || !ci.enabled || ci.kind !== 'gate') {
    return { kind: 'agree' };
  }
  if (rebaseHead === undefined) {
    return {
      kind: 'reenter_ci',
      reason: 'the rebase gate read no head commit, so CI judges the branch again',
    };
  }
  if (ciHeadSha === null) {
    return {
      kind: 'reenter_ci',
      reason: 'CI has not passed a head of this branch, so it judges the branch before Ready',
    };
  }
  if (ciHeadSha !== rebaseHead) {
    return {
      kind: 'reenter_ci',
      reason: 'the branch head moved since CI passed it, so CI judges the new commits before Ready',
    };
  }
  return { kind: 'agree' };
};

/**
 * How many times a gate may answer `pending` before the task is parked for a human — every gate,
 * except the CI gate on a poll-only git binding, whose bound is a time (WP-136, {@link CiWait}).
 */
export const MAX_GATE_CHECKS = 5;

/**
 * **The CI gate is waiting on a binding no webhook reaches** (WP-136, the product owner's decision
 * of 2026-10-03).
 *
 * A binding a webhook reaches is normally settled by the pipeline's own `ci.pipeline.finished`
 * long before {@link MAX_GATE_CHECKS} run out; a poll-only binding (`MergeRequestPollPlan
 * .receives_webhooks: false`, WP-123) is told nothing, so five checks thirty seconds apart parked
 * every task whose pipeline took longer than about two and a half minutes. For that binding — and
 * only at `ci_gate` — the evaluator answers `pending` with this, and the job bounds the wait by
 * `pipeline.limits.ci_timeout_minutes` from the gate's current entry instead (`ci-wait.ts`).
 *
 * A binding with **no** poll plan (polling off) keeps the five checks: the ruling's condition is the
 * plan's own `receives_webhooks`, and a binding that neither polls nor receives is a configuration
 * the five-check park already names.
 */
export interface CiWait {
  /** The configured timeout, read at this evaluation (`pipeline.limits.ci_timeout_minutes`). */
  readonly timeoutMinutes: number;
  /** The provider id of the git binding, named in the brief (`gitlab`). */
  readonly provider: string;
  /** The head pipeline the gate read, or `null` when none has started for the head commit. */
  readonly pipeline: { readonly id: string; readonly status: string } | null;
}

/**
 * The CI timeout a project's settings state, or the default (WP-136). The schema bounds the key at
 * the document; this re-checks the number it is handed rather than trusting a layer it cannot see
 * (standing rule 16: a missing or malformed number is not a bound).
 */
export const ciTimeoutMinutesOf = (settings: ProjectSettings): number => {
  const stated = settings.config.pipeline?.limits?.ci_timeout_minutes;
  return typeof stated === 'number' &&
    Number.isInteger(stated) &&
    stated >= MIN_CI_TIMEOUT_MINUTES &&
    stated <= MAX_CI_TIMEOUT_MINUTES
    ? stated
    : DEFAULT_CI_TIMEOUT_MINUTES;
};

/**
 * **The provider did not answer** (PROGRESS backlog 490, `gate-outage.ts`): a transient failure of
 * a provider read during the evaluation — never a verdict, and not a `pending` either, because it
 * is bounded by a time and must not spend `MAX_GATE_CHECKS`. Only {@link GateEvaluator.evaluate}
 * answers it; `judgeCiSettlement`, which `ci-settle.ts` also calls, keeps {@link GateResult}.
 */
export interface GateProviderOutage {
  readonly kind: 'unreachable';
  readonly code: TransientProviderCode;
  /** The git binding's provider id (`gitlab`). */
  readonly provider: string;
  /** The binding's host (`gitlab.com`), named in the brief; `null` for an adapter that dials none. */
  readonly host: string | null;
  /**
   * `pipeline.limits.ci_timeout_minutes` when this is the CI gate on a **poll-only** binding — the
   * wait WP-136 bounds by time from the gate's entry, which an outage does not extend — else `null`.
   */
  readonly ciTimeoutMinutes: number | null;
  /** The failure itself, for the job's log line (the executor has already redacted it in place). */
  readonly error: unknown;
}

export type GateEvaluation = GateResult | GateProviderOutage;

export interface GateEvaluator {
  evaluate(stage: PipelineStage, stored: StoredTask): Promise<GateEvaluation>;
}

/**
 * What the CI gate needs besides the provider (WP-81): the project's settings for its protected
 * paths, and the task's artifacts for the declared and confirmed exceptions — read in a transaction
 * of its own, after every provider call, never around one.
 */
export interface CiGateOptions {
  readonly integrations: PipelineIntegrationsPort;
  readonly settings: ProjectSettingsPort;
  readonly unitOfWork: UnitOfWork;
  readonly store: Pick<PipelineStore, 'artifacts'>;
  readonly clock: { now(): string };
  /** WP-138 ruling (f): see `PipelineSagaOptions.repositoryFiles`. Absent: a head with no pipeline waits. */
  readonly repositoryFiles?: RepositoryFileSource;
}

/**
 * Where a repository's CI configuration lives when the provider has not said otherwise — GitLab's
 * default (WP-138). Since WP-139 the gate and `mr_ready` ask the provider for the project's own
 * path (`GitProviderPort.repositorySettings`), so this is only what an empty GitLab
 * `ci_config_path` means, kept for the sentences that name it.
 */
export const CI_CONFIG_PATH = '.gitlab-ci.yml';

/** {@link ciConfigOnDefaultBranch}'s answer: only `absent` reads as *"the project has no CI"*. */
export type CiConfigPresence =
  | { readonly kind: 'absent'; readonly path: string }
  | { readonly kind: 'present'; readonly where: string }
  | { readonly kind: 'unknown'; readonly reason: string };

/**
 * Does the default branch carry the project's CI configuration? (WP-138, WP-139.)
 *
 * Two reads, and only `absent` lets the gate read a head with no pipeline as *"the project has no
 * CI"* (product/04 S4):
 *  1. **where** the configuration lives, from the provider through the executor
 *     (`gitReads.repositorySettings`, GitLab's `ci_config_path`) — an `external` location (another
 *     project's file, a URL) is **present** without a second read (the row's ruling (b)), and an
 *     `unknown` one or a failed read is `unknown`;
 *  2. whether that path exists on the default branch, from the platform's mirror (TD-026), the
 *     reader the configuration and the readiness re-check use.
 *
 * A failed provider read is **not** an absent file: it answers `unknown` with the provider's error
 * named, and the gate waits (fail closed), bounded by its own wait (WP-136).
 */
export const ciConfigOnDefaultBranch = async (
  files: RepositoryFileSource | undefined,
  integrations: PipelineIntegrations,
  context: { readonly projectId: Id; readonly taskId: Id },
): Promise<CiConfigPresence> => {
  let location: CiConfigLocation;
  try {
    // WP-142: the location only — the provider's default branch is not the pipeline's to follow.
    const answered = await gitReads(integrations).ciConfigLocation(context);
    if (answered === null) {
      return {
        kind: 'unknown',
        reason: 'the project has no git binding to ask where its CI lives',
      };
    }
    location = answered;
  } catch (error) {
    if (!(error instanceof IntegrationError)) {
      throw error;
    }
    return {
      kind: 'unknown',
      reason: `the provider could not say where this project's CI configuration lives (${error.message})`,
    };
  }
  if (location.kind === 'unknown') {
    return { kind: 'unknown', reason: location.reason };
  }
  if (location.kind === 'external') {
    return { kind: 'present', where: `outside the repository, at ${location.location}` };
  }
  if (files === undefined) {
    return { kind: 'unknown', reason: 'this process composed no reader of the repository' };
  }
  const path = location.path;
  if (isRepositoryFilePath(path)) {
    const read = await files.read({ projectId: context.projectId, paths: [path] });
    if (read.status !== 'ok') {
      return { kind: 'unknown', reason: read.reason };
    }
    const entry = read.files[path];
    if (entry === undefined) {
      return { kind: 'unknown', reason: `the reading did not answer ${path}` };
    }
    // A symlink, a gitlink or an oversized file is still a CI file somebody committed.
    return entry.kind === 'absent' ? { kind: 'absent', path } : { kind: 'present', where: path };
  }
  // A path outside the reader's exact list (GoParking's `deploy/.gitlab-ci.yml`): its presence
  // alone is asked, and no byte of it is read (`RepositoryFileRequest.presence`).
  if (!isPresencePath(path)) {
    return {
      kind: 'unknown',
      reason: `the CI configuration path ${JSON.stringify(path.slice(0, 80))} is not one the platform will look up`,
    };
  }
  const read = await files.read({ projectId: context.projectId, paths: [], presence: [path] });
  if (read.status !== 'ok') {
    return { kind: 'unknown', reason: read.reason };
  }
  const found = read.presence?.[path];
  if (found === undefined) {
    return { kind: 'unknown', reason: `the reading did not answer ${path}` };
  }
  return found === 'absent' ? { kind: 'absent', path } : { kind: 'present', where: path };
};

/** The pipeline's own answer for the live head, before the tamper check is made. */
export type CiReading =
  /** product/04 S4: *"If the project has no CI, the gate is skipped"* — the tamper check is not. */
  | { readonly kind: 'no_pipeline' }
  | { readonly kind: 'passed'; readonly detail: string }
  | {
      readonly kind: 'failed';
      readonly status: string;
      /** Every failing job that is not allowed to fail, by name. */
      readonly failingJobs: readonly string[];
      /**
       * Every failing job whose log the settlement reads (`failingJobs`, backlog 485), in the
       * pipeline's order; empty when none was named.
       */
      readonly logJobs: readonly FailingJobRef[];
      readonly detail: string;
    };

const NO_PIPELINE_DETAIL =
  'the project has no pipeline for this commit; the local test run is the evidence';

/**
 * **The CI gate's settlement, for both paths that settle it** (WP-81): the poll below and the
 * pipeline's event (`ci-settle.ts`). The pipeline's verdict comes in as `reading`; this makes the
 * tamper check (`tamper.ts`), reads the failing jobs' logs when there is a failure to explain
 * (`ci-log.ts`), and answers the one {@link GateResult}.
 *
 * Every provider call here is a read through the executor, outside every transaction; the
 * artifacts are read in a transaction of their own, closed before the logs are read. The endings,
 * in order:
 *
 *  - the diff lists **no** file → `pending` (not yet computed, never *nothing changed*); a list at
 *    the read's bound → `unsupported` (the rest is unseen) — neither is read as *no tamper*;
 *  - a protected path changed that may not → `settled`, **failed**, `protected_paths_changed`, the
 *    reason naming the paths (and the pipeline's own failure and log, when it failed too) — no
 *    `ciSignature`, because it is not a CI failure the convergence rule should count;
 *  - the pipeline failed → `settled`, failed, the job names and the log excerpt, `ciSignature`,
 *    and the tamper check's own word — `protected_paths_clean`, or
 *    `protected_paths_awaiting_review` when a declared path is still unjudged (WP-105);
 *  - a declared protected path the review has not judged yet → `settled`, **passed**,
 *    `protected_paths_awaiting_review`, with the head like any pass **and** the excused paths
 *    (`excusedPaths`), which the settlement records on the task; the rebase gate's settlement
 *    compares them with the latest Review Verdict before Ready (WP-102, Q109 (b));
 *  - otherwise → `settled`, passed, with the head CI judged and `protected_paths_clean` — the
 *    word that tells the Checks panel the check ran (WP-105, PROGRESS backlog 280: until then this
 *    pass closed its row `pass`, which a settlement before WP-81, with no check at all, wrote too).
 */
export const judgeCiSettlement = async (
  options: CiGateOptions,
  bindings: PipelineIntegrations,
  stored: StoredTask,
  headSha: string,
  reading: CiReading,
): Promise<GateResult> => {
  const git = bindings.git;
  if (git === null || stored.mr === null) {
    return {
      kind: 'unsupported',
      detail:
        'the CI gate needs a git provider and a merge request, and the task has one without the other',
    };
  }
  const context: { readonly projectId: Id; readonly taskId: Id } = {
    projectId: stored.task.projectId,
    taskId: stored.task.id,
  };
  const files = await coalescedMergeRequestDiff(
    { port: options.integrations, integrations: bindings, now: options.clock.now() },
    { ...stored.mr, head_sha: headSha },
    MAX_CONFLICT_FILES,
    context,
  );
  if (files === null) {
    // Unreachable: the binding was checked above, and the read answers `null` only without one.
    return {
      kind: 'unsupported',
      detail: 'the CI gate needs a git provider and the project has no git binding',
    };
  }
  if (files.length === 0) {
    return {
      kind: 'pending',
      detail:
        'the provider lists no changed file for the merge request yet, so the tamper check (BD-024) cannot be made',
    };
  }
  if (files.length >= MAX_CONFLICT_FILES) {
    return {
      kind: 'unsupported',
      detail: `the merge request changes at least ${MAX_CONFLICT_FILES} files, more than the tamper check (BD-024) reads, so the platform cannot tell whether a protected path changed`,
    };
  }
  const settings = await options.settings.forProject(stored.task.projectId);
  if (settings.configRefusal !== undefined) {
    /**
     * **Closed, by name** (WP-106, PROGRESS backlog 354). The tamper check compares the change
     * with the project's protected paths, and a configuration that cannot be read has stood in the
     * platform's defaults for them — so a pass here could carry a change that touches a path the
     * project protects towards Ready with no agent run left to refuse it. The gate cannot be
     * evaluated, and says why: the task is escalated with the refusal's own sentence.
     */
    return { kind: 'unsupported', detail: settings.configRefusal };
  }
  /**
   * **The CI file the project runs is protected wherever it lives** (WP-143, backlog 442): the
   * default list names `.gitlab-ci.yml`, and a project whose provider names another path (GoParking's
   * `deploy/.gitlab-ci.yml`) would otherwise leave its real CI file editable. One provider read; a
   * refusal waits rather than judging the change without it (fail closed, bounded by the gate's wait).
   */
  let ciLocation: CiConfigLocation | null;
  try {
    ciLocation = await gitReads(bindings).ciConfigLocation(context);
  } catch (error) {
    if (!(error instanceof IntegrationError)) throw error;
    return {
      kind: 'pending',
      detail: `the provider could not say where the CI configuration lives (${error.message}), so the tamper check (BD-024) cannot tell whether the change touches it`,
    };
  }
  const artifacts = await options.unitOfWork.transaction(async (scope) =>
    options.store.artifacts.listFor(scope.tx, stored.task.id),
  );
  const verdict = judgeTamper({
    changedPaths: changedExistingPaths(files),
    protectedPaths: withCiConfigPath(effectiveProtectedPaths(settings), ciLocation),
    ...exceptionsOf(artifacts),
  });
  const redact = (text: string): string => git.redactor.redactText(text).value;
  const ciDetail = reading.kind === 'no_pipeline' ? NO_PIPELINE_DETAIL : reading.detail;

  if (verdict.kind === 'changed' || reading.kind === 'failed') {
    const head = [
      ...(verdict.kind === 'changed' ? [tamperFailureDetail(verdict, redact)] : []),
      ciDetail,
    ].join('\n');
    const logs =
      reading.kind === 'failed'
        ? await readFailingJobLogs(bindings, reading.logJobs, context)
        : null;
    const composed = composeFailureDetail(head, logs);
    return {
      kind: 'settled',
      passed: false,
      headSha,
      detail: composed.detail,
      ...(composed.originalChars === null ? {} : { detailOriginalChars: composed.originalChars }),
      // WP-105 (backlog 280): every settlement names what the tamper check found — the paths it
      // returns the task for, or, on a red pipeline's return, that it found nothing or only
      // declared paths awaiting the review — so a row never reads like one no check was made for.
      outcome:
        verdict.kind === 'changed'
          ? ('protected_paths_changed' as const)
          : verdict.kind === 'clean'
            ? ('protected_paths_clean' as const)
            : ('protected_paths_awaiting_review' as const),
      ...(verdict.kind !== 'changed' && reading.kind === 'failed'
        ? { ciSignature: ciFailureSignature(reading.status, reading.failingJobs, headSha) }
        : {}),
    };
  }
  if (verdict.kind === 'awaiting_review') {
    const excused = verdict.paths.map(redact);
    return {
      kind: 'settled',
      passed: true,
      headSha,
      outcome: 'protected_paths_awaiting_review',
      excusedPaths: excused,
      detail: `${ciDetail}; the tamper check (BD-024) excused declared protected paths until the Code review confirms them, and the rebase gate checks the confirmation before Ready: ${excused.join(', ')}`,
    };
  }
  return {
    kind: 'settled',
    passed: true,
    headSha,
    outcome: 'protected_paths_clean',
    detail: ciDetail,
  };
};

/**
 * The failure's detail: the platform's sentences, then — per failing job, in the pipeline's order —
 * its labelled log excerpt or the reason there is none, then the jobs past the cap by name
 * (backlog 485). `originalChars` is the length the detail would have had with every included log
 * whole, when `ci-log.ts` cut any of them — what the prompt's marker announces (technical/04); the
 * jobs past the cap are not a cut, because the body says in words that their logs were not read.
 */
const composeFailureDetail = (
  head: string,
  logs: FailingJobLogs | null,
): { readonly detail: string; readonly originalChars: number | null } => {
  if (logs === null) {
    return { detail: head, originalChars: null };
  }
  if (logs.logs.length === 0) {
    return {
      detail: `${head}\nNo job log is included: no failing job was named, so no log was read.`,
      originalChars: null,
    };
  }
  let cutChars = 0;
  const parts = logs.logs.map((log) => {
    if (log.kind === 'unreadable') {
      return `No log of the failing job ${log.job} is included: ${log.why}.`;
    }
    if (log.originalChars !== null) {
      cutChars += log.originalChars - log.text.length;
    }
    return `Log of the failing job ${log.job}, redacted:\n${log.text}`;
  });
  if (logs.omitted.length > 0) {
    parts.push(
      `${logs.omitted.length} more failing ${logs.omitted.length === 1 ? 'job' : 'jobs'} past the first ${logs.logs.length}, whose logs were not read: ${logs.omitted.join(', ')}.`,
    );
  }
  const detail = [head, ...parts].join('\n');
  return { detail, originalChars: cutChars === 0 ? null : detail.length + cutChars };
};

/**
 * A pending CI read, with the wait a **poll-only** binding gets (WP-136, {@link CiWait}) — or as it
 * was, for a binding a webhook reaches or one with no poll plan. The settings are read only here,
 * on a pending answer, so a settled gate costs nothing more than before.
 */
const withCiWait = async (
  options: CiGateOptions,
  bindings: PipelineIntegrations,
  stored: StoredTask,
  result: Extract<GateResult, { kind: 'pending' }>,
  pipeline: CiWait['pipeline'],
): Promise<GateResult> => {
  const git = bindings.git;
  if (git === null || git.port.pollPlan()?.receives_webhooks !== false) {
    return result;
  }
  const settings = await options.settings.forProject(stored.task.projectId);
  return {
    ...result,
    ciWait: {
      timeoutMinutes: ciTimeoutMinutesOf(settings),
      provider: git.ref.provider,
      pipeline,
    },
  };
};

const CI_TERMINAL_PASS = new Set(['success']);
const CI_TERMINAL_FAIL = new Set(['failed', 'canceled', 'skipped']);

/** How much of a held job's name (provider text) the pending detail quotes. */
const MAX_HELD_JOB_NAME_CHARS = 100;

/**
 * The CI gate's pending detail for a pipeline that is neither green nor red — and, for one **held
 * at a manual job**, a plain sentence about why (backlog 486). The merge request stays a draft
 * until Ready since the product owner's 2026-10-06 decision, so a project whose CI rules hold or
 * skip jobs for a `Draft:` title (Autix's, before its rule admitted `agentic/*` drafts) leaves the
 * gate waiting on a pipeline whose status is `manual`; *"pipeline 12 is manual"* told an operator
 * nothing about that. Only a pipeline whose own status is `manual` is called held: a `running`
 * pipeline with a manual deploy job in a later stage is still running.
 */
export const pendingPipelineDetail = (
  status: Pick<PipelineStatus, 'id' | 'status' | 'jobs'>,
  draft: boolean,
): string => {
  if (status.status !== 'manual') {
    return `pipeline ${status.id} is ${status.status}`;
  }
  const job = status.jobs.find((entry) => entry.status === 'manual');
  const held =
    job === undefined
      ? 'a manual job'
      : `manual job ${JSON.stringify(job.name.slice(0, MAX_HELD_JOB_NAME_CHARS))}`;
  return draft
    ? `the merge request is a draft and pipeline ${status.id} is held at ${held} — the project's CI rules may skip or hold jobs for drafts, and the platform keeps its merge request a draft until Ready; see the readiness panel's CI-rules warning`
    : `pipeline ${status.id} is held at ${held}: nothing runs until somebody starts it on the provider`;
};

export const createGateEvaluator = (options: CiGateOptions): GateEvaluator => {
  const { integrations } = options;
  return {
    evaluate: async (stage, stored) => {
      if (stage.command !== null) {
        return {
          kind: 'unsupported',
          detail: `gate "${stage.id}" runs the command ${JSON.stringify(stage.command)}, which needs a workspace the platform does not provision for gates yet`,
        };
      }
      if (!isBuiltinGateStageId(stage.id)) {
        // A gate with an `on` event is settled by that event's handler, not here.
        return stage.on.length > 0
          ? { kind: 'pending', detail: `waiting for ${stage.on[0]?.on ?? 'an event'}` }
          : {
              kind: 'unsupported',
              detail: `gate "${stage.id}" is not one the platform evaluates and declares no event`,
            };
      }

      const context = { projectId: stored.task.projectId, taskId: stored.task.id };

      if (stage.id === 'merged_gate') {
        // S8's trigger *is* the evidence: the task only reaches this gate through `mr.merged`.
        return { kind: 'settled', passed: true, detail: 'the merge request was merged' };
      }

      if (stored.mr === null) {
        return {
          kind: 'unsupported',
          detail: `gate "${stage.id}" needs a merge request and the task has none`,
        };
      }

      // The project's bindings, resolved per call (WP-15a) and only for the two gates that ask a
      // provider anything: `merged_gate` is settled by the event that got the task here, so loading
      // a binding for it would make an unrelated misconfiguration fail a gate that needs no
      // provider. A gate runs outside a run — no workspace, so no minted credential — which is why
      // the call's scope holds nothing (Q55).
      const bindings = await integrationsForProject(
        integrations,
        stored.task.projectId,
        noRunScopedSecrets(),
      );

      /**
       * **"The platform cannot tell" is not "the answer is yes"** — and asking the binding first is
       * what keeps the two apart.
       *
       * `gitReads` answers `null` for an unbound project *and* `getPipelineStatus` answers `null`
       * for a commit the provider has no pipeline for. Those are different facts and the CI gate's
       * response to them is opposite: product/04 S4 says a project with **no CI** passes ("the
       * local test run is the evidence"), while a project with **no git binding** has told the
       * platform nothing at all. Collapsing them let a task with no bindings walk through `ci_gate`
       * on `passed: true` — the fifth fail-open guard this project has found (standing rules 18,
       * 56 and 67), and the one this file's own `rebase_gate` branch already got right, which is
       * the asymmetry that gave it away.
       *
       * So the binding is checked **before** either gate reads anything, by identity rather than by
       * a `null` two producers can both return. `gates.test.ts` › "refuses the CI gate when the
       * project has no git binding, instead of passing it".
       */
      if (bindings.git === null) {
        return {
          kind: 'unsupported',
          detail: `gate "${stage.id}" needs a git provider and the project has no git binding`,
        };
      }
      const git = gitReads(bindings);
      const binding = bindings.git;
      // Held as a local: the closure below does not keep the `stored.mr !== null` narrowing.
      const mrRef = stored.mr;

      /**
       * **A provider that does not answer is an outage, not a thrown job** (backlog 490). Every
       * provider read of the two gates is inside this one closure, and the `catch` below it sorts
       * what it throws: a transient failure answers {@link GateProviderOutage} and the job re-asks
       * on its own bound; any other failure — an auth refusal, a `not_found`, a response that
       * failed its schema, or anything that is not a provider's — is rethrown unchanged, which is
       * today's ending.
       */
      const readProvider = async (): Promise<GateResult> => {
        if (stage.id === 'ci_gate') {
          // WP-136: the head pipeline the read saw, for a poll-only binding's brief.
          let seenPipeline: CiWait['pipeline'] = null;
          const read = async (): Promise<GateResult> => {
            /**
             * **The live head, not the recorded one** (WP-60 review round 2). `tasks.mr_ref.head_sha`
             * lags the branch — it moves when a pushing stage reports or when a push's `mr.updated` is
             * dispatched, and a late delivery can briefly hold an older revision — so a gate that asked
             * the pipeline status of the recorded sha could pass on a green pipeline for a commit that
             * is no longer the head. One `get_merge_request` read per evaluation (the rebase gate's
             * read, now made here too); the diff coalescer is not involved.
             */
            const live = await git.mergeRequest(mrRef, context);
            const headSha = live?.ref.head_sha ?? null;
            if (headSha === null || headSha === undefined) {
              return { kind: 'pending', detail: 'the merge request has no head commit yet' };
            }
            const status = await git.pipelineStatus(headSha, context);
            if (status === null) {
              /**
               * **No pipeline is not no CI** (WP-138 ruling (f)). "If the project has no CI, the gate
               * is skipped and the local test run is the evidence" (product/04 S4) — but a head with
               * no pipeline on a project whose default branch carries a CI file is a pipeline that has
               * not started (a draft merge request whose pipelines the project skips, a runner queue,
               * a rule that does not match the branch), and passing it would be a pass with no
               * evidence. Only a default branch with no CI file reads as no CI; the pipeline's half is
               * then skipped, the tamper check is not.
               */
              const ci = await ciConfigOnDefaultBranch(options.repositoryFiles, bindings, context);
              if (ci.kind === 'absent') {
                return judgeCiSettlement(options, bindings, stored, headSha, {
                  kind: 'no_pipeline',
                });
              }
              return {
                kind: 'pending',
                detail:
                  ci.kind === 'present'
                    ? `no pipeline has run for the head ${headSha.slice(0, 12)} yet, and the project has CI configuration (${ci.where}), so this is not a project without CI`
                    : `no pipeline has run for the head ${headSha.slice(0, 12)}, and whether the project has CI configuration on its default branch cannot be read (${ci.reason}), so the gate waits rather than passing`,
              };
            }
            seenPipeline = { id: status.id, status: status.status };
            if (CI_TERMINAL_PASS.has(status.status)) {
              return judgeCiSettlement(options, bindings, stored, headSha, {
                kind: 'passed',
                detail: `pipeline ${status.id} succeeded`,
              });
            }
            if (CI_TERMINAL_FAIL.has(status.status)) {
              const failed = status.jobs
                .filter((job) => job.status === 'failed' && !job.allow_failure)
                .map((job) => job.name);
              return judgeCiSettlement(options, bindings, stored, headSha, {
                kind: 'failed',
                status: status.status,
                failingJobs: failed,
                logJobs: failingJobs(status.jobs),
                detail:
                  failed.length === 0
                    ? `pipeline ${status.id} ${status.status}`
                    : `pipeline ${status.id} ${status.status}: ${failed.join(', ')}`,
              });
            }
            return { kind: 'pending', detail: pendingPipelineDetail(status, live?.draft === true) };
          };
          const result = await read();
          return result.kind === 'pending'
            ? withCiWait(options, bindings, stored, result, seenPipeline)
            : result;
        }

        // rebase_gate
        const mr = await git.mergeRequest(mrRef, context);
        if (mr === null) {
          /**
           * **Deliberately unreachable, and said so rather than left looking tested** (standing
           * rule 22). `gitReads.mergeRequest` returns `null` for exactly one reason — the project has
           * no git binding — and `GitProviderPort.getMergeRequest` is `Promise<MergeRequest>`, never
           * nullable: a provider that cannot find the merge request throws `not_found`. The outer
           * guard that makes this unreachable is the `bindings.git === null` refusal above, which has
           * its own named test for both gates. Kept because the type still admits `null`, and a
           * `??`-shaped shortcut here would be the same fail-open the guard above was written to fix.
           */
          return {
            kind: 'unsupported',
            detail: `gate "${stage.id}" needs a git provider and the project has no git binding`,
          };
        }
        if (mr.has_conflicts === null || mr.has_conflicts === undefined) {
          return { kind: 'pending', detail: 'the provider has not computed mergeability yet' };
        }
        // The head this read carried, when the provider named one (WP-79): what Ready is entered with.
        const rebaseHead = mr.ref.head_sha ?? null;
        const judged = rebaseHead === null ? {} : { headSha: rebaseHead };
        return mr.has_conflicts
          ? {
              kind: 'settled',
              passed: false,
              ...judged,
              detail: `merge request !${mr.ref.iid} conflicts with ${mr.target_branch}`,
            }
          : {
              kind: 'settled',
              passed: true,
              ...judged,
              detail: `merge request !${mr.ref.iid} applies cleanly to ${mr.target_branch}`,
            };
      };

      try {
        return await readProvider();
      } catch (error) {
        const code = transientProviderFailure(error);
        if (code === null) {
          throw error;
        }
        // The settings are read only for the one gate whose bound they state, after the failure.
        const pollOnlyCi =
          stage.id === CI_GATE_STAGE && binding.port.pollPlan()?.receives_webhooks === false;
        return {
          kind: 'unreachable',
          code,
          provider: binding.ref.provider,
          host: binding.ref.host,
          ciTimeoutMinutes: pollOnlyCi
            ? ciTimeoutMinutesOf(await options.settings.forProject(stored.task.projectId))
            : null,
          error,
        };
      }
    },
  };
};
