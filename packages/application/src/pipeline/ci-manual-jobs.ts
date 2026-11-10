/**
 * **A manual job nobody started is not a check, unless it is a test** (BD-024's 2026-11-07
 * amendment, TD-036 decisions 2–4, S-27.2).
 *
 * AUT-6655 on Autix: GitLab held pipeline 3038234623 at `sentry-release-commit`, a release step in
 * stage `release` with `allow_failure: false` (the default for `when: manual` inside `rules`, so
 * GitLab calls the pipeline *blocked* and its API says `manual`). Every job that ran was green, and
 * the CI gate — which passed only `success` — waited out `ci_timeout_minutes` twice.
 *
 * This module is the rule, and the **one** function both readers call (TD-036 decision 4): the CI
 * gate (`gates.ts`, on the poll and on a pipeline's event, `ci-settle.ts`) and the `mr_pipeline`
 * duty (`merge-request-ready.ts`), which asks for a fresh merge-request pipeline only when this rule
 * would keep the gate waiting *because of a manual job*. Pure: no provider, no clock.
 *
 * ## The rule, by default (decision 2)
 *
 * A pipeline whose status is `manual` passes when all four hold:
 *  - (a) no job is `pending` or `running` — GitLab leaves the jobs behind a blocking manual job
 *    `created`, which the port maps to `pending`, so a held **build** step the tests need never
 *    passes;
 *  - (b) no job is `failed` or `canceled` unless it has `allow_failure: true` — otherwise the gate
 *    **fails**;
 *  - (c) at least one job has `success`;
 *  - (d) no unstarted blocking manual job is a **test job** — WP-143's convention (`isTestJob` in
 *    `@platform/domain`): stage `test` when the pipeline has one, otherwise every job, and a job
 *    whose stage is `null` counts. So a provider with no stages waits on every blocking manual job,
 *    which is the gate's behaviour before TD-036.
 *
 * And it waits — fails closed — on a `manual` pipeline in which it can see **no** blocking manual
 * job: the provider says something holds the pipeline and the read does not show what, so it cannot
 * say that what holds it is not a test.
 *
 * ## The project's control (decision 3)
 *
 * `pipeline.ci.required_manual_jobs`: absent is the default above; `[]` drops (d) and keeps (a)–(c);
 * `all` waits on every `manual` pipeline, which is the behaviour before TD-036; a list of exact
 * names replaces (d) with *exactly these must have run* — a named job still `manual` keeps the gate
 * waiting whatever its stage or `allow_failure`, even on a `success` pipeline, a named job that ran
 * and failed (or was canceled) fails it, and a name the pipeline does not contain is not waited for
 * (BACKLOG 1474). A named job the provider `skipped` did not run and will not: it **fails** the
 * gate, saying the pipeline's rules skipped it (BACKLOG 1493). And a job list the provider cut
 * (`jobs_truncated`, BACKLOG 1490) never passes on this rule: the gate waits as before.
 *
 * ## The project's per-job choice (S-28.7, the M28 ruling)
 *
 * `pipeline.ci.manual_jobs` maps an **exact** job name to `run`, `wait` or `ignore`, and a mode
 * wins over everything above for that name:
 *  - `wait` — exactly a name in `required_manual_jobs`: a person must start it, the gate waits, its
 *    failure (or the pipeline's rules skipping it) fails the gate;
 *  - `run` — the same check, **and** the platform starts it: every wait the rule answers lists the
 *    `run` jobs currently `manual` as `toStart` (never a trigger job, which this version does not
 *    start), and the `ci_play_manual` duty plays them (`ci-play.ts`). A played job's failure fails
 *    the gate even with `allow_failure: true`;
 *  - `ignore` — never started and never a check, even when it blocks the provider's pipeline: it is
 *    not waited for by any policy and its failure is not the gate's (the gate judges the jobs that
 *    ran). A pass still lists it in `notRun` when it is blocking, because the provider may still
 *    show the pipeline blocked at it.
 * A name with no mode keeps exactly the behaviour above. `run` and `ignore` come only from the
 * project settings (`repository-grades.ts`).
 *
 * ## What it does not change
 *
 * A `pending` or `running` pipeline waits, and a `failed`, `canceled` or `skipped` one fails, as
 * before; their failing jobs are the gate's own (`failed`, not allowed to fail). A `success`
 * pipeline passes as before (the coordinator's ruling on #114: GitLab lists `created` jobs on a
 * green pipeline whose jobs `needs:` an optional manual one), and is asked only the project's
 * named jobs.
 */
import { hasTestStage, isTestJob } from '@platform/domain';
import type { PipelineStatus } from '../ports/integrations/git-provider.js';
import type { ProjectSettings } from './settings.js';

type PipelineJob = PipelineStatus['jobs'][number];
type JudgedPipeline = Pick<PipelineStatus, 'status' | 'jobs' | 'jobs_truncated'>;

/** One job's mode in `pipeline.ci.manual_jobs` (S-28.7, the M28 ruling). */
export type ManualJobMode = 'run' | 'wait' | 'ignore';

/**
 * `pipeline.ci.required_manual_jobs`, read (TD-036 decision 3) — and, beside it, the per-job
 * `modes` of `pipeline.ci.manual_jobs` (S-28.7), absent when the project states none.
 */
export type ManualJobPolicy = (
  | { readonly kind: 'default' }
  | { readonly kind: 'none' }
  | { readonly kind: 'all' }
  | { readonly kind: 'named'; readonly names: ReadonlySet<string> }
) & { readonly modes?: ReadonlyMap<string, ManualJobMode> };

export const DEFAULT_MANUAL_JOB_POLICY: ManualJobPolicy = { kind: 'default' };

/**
 * The project's policy from its settings. The schema bounds the key at the document; a value that
 * is somehow not one of its shapes reads as the **default**, never as `[]` — the default is the
 * reading that keeps a test from being skipped.
 */
export const manualJobPolicyOf = (settings: Pick<ProjectSettings, 'config'>): ManualJobPolicy => {
  const base = requiredPolicyOf(settings.config.pipeline?.ci?.required_manual_jobs);
  const modes = manualJobModesOf(settings.config.pipeline?.ci?.manual_jobs);
  return modes === null ? base : { ...base, modes };
};

const requiredPolicyOf = (stated: unknown): ManualJobPolicy => {
  if (stated === 'all') {
    return { kind: 'all' };
  }
  if (Array.isArray(stated) && stated.every((name) => typeof name === 'string')) {
    return stated.length === 0
      ? { kind: 'none' }
      : { kind: 'named', names: new Set(stated as readonly string[]) };
  }
  return DEFAULT_MANUAL_JOB_POLICY;
};

const MODES: ReadonlySet<string> = new Set(['run', 'wait', 'ignore']);

/**
 * `pipeline.ci.manual_jobs` as a map, or `null` when it states nothing. The schema bounds it at the
 * document; an entry that is somehow not one of the three words is **skipped** — the name then
 * keeps the behaviour it has with no mode, which never starts a job and never drops a check.
 */
const manualJobModesOf = (stated: unknown): ReadonlyMap<string, ManualJobMode> | null => {
  if (typeof stated !== 'object' || stated === null || Array.isArray(stated)) {
    return null;
  }
  const modes = new Map<string, ManualJobMode>();
  for (const [name, mode] of Object.entries(stated)) {
    if (typeof mode === 'string' && MODES.has(mode)) {
      modes.set(name, mode as ManualJobMode);
    }
  }
  return modes.size === 0 ? null : modes;
};

/**
 * A job's mode under the policy: its `manual_jobs` entry, else `wait` for a name in
 * `required_manual_jobs`, else `null` — no choice, TD-036's rule.
 */
export const manualJobModeOf = (policy: ManualJobPolicy, name: string): ManualJobMode | null =>
  policy.modes?.get(name) ?? (policy.kind === 'named' && policy.names.has(name) ? 'wait' : null);

/** A job the project requires by name — `run` or `wait`, from either key. */
const isRequiredJob = (policy: ManualJobPolicy, job: Pick<PipelineJob, 'name'>): boolean => {
  const mode = manualJobModeOf(policy, job.name);
  return mode === 'run' || mode === 'wait';
};

const isIgnoredJob = (policy: ManualJobPolicy, job: Pick<PipelineJob, 'name'>): boolean =>
  manualJobModeOf(policy, job.name) === 'ignore';

/**
 * Whether the policy names any job it requires — the question that decides whether a `success`
 * pipeline is asked about jobs at all (TD-036's ruling on #114), and whether the pipeline event's
 * duty re-reads a green pipeline (`ci-settle.ts`).
 */
export const asksForNamedJobs = (policy: ManualJobPolicy): boolean =>
  policy.kind === 'named' ||
  [...(policy.modes?.values() ?? [])].some((mode) => mode === 'run' || mode === 'wait');

/**
 * The `run` jobs the platform may start now: `manual`, named `run`, and not a trigger job (a
 * downstream pipeline's bridge — `run` is refused for those in this version, the M28 ruling).
 */
export const manualJobsToStart = (
  pipeline: Pick<PipelineStatus, 'jobs'>,
  policy: ManualJobPolicy,
): readonly PipelineJob[] =>
  pipeline.jobs.filter(
    (job) =>
      job.status === 'manual' &&
      job.trigger !== true &&
      manualJobModeOf(policy, job.name) === 'run',
  );

/** A job a person has to start, which the provider counts toward the pipeline (decision 1). */
export const isBlockingManualJob = (job: Pick<PipelineJob, 'status' | 'allow_failure'>): boolean =>
  job.status === 'manual' && !job.allow_failure;

/**
 * **Does the rule wait on a manual job here?** (decision 2 (d), decision 3) — the half both readers
 * share. `jobs` are the unstarted manual jobs the policy waits for, in the pipeline's order; `holds`
 * is whether it waits on a manual job at all — also true of a `manual` pipeline in which the read
 * shows **no** blocking manual job (`unseen`), under every policy but `[]`: something holds it, and
 * the read cannot say it is not a job the policy requires. Independent of the pipeline's other
 * jobs, so `mr_pipeline` asks it of a pipeline still running.
 */
export const manualJobsHolding = (
  pipeline: JudgedPipeline,
  policy: ManualJobPolicy,
): {
  readonly holds: boolean;
  readonly jobs: readonly PipelineJob[];
  readonly unseen: boolean;
  /**
   * S-28.7: whether it holds for a reason **a person** must answer — a held job that is not one the
   * platform starts itself ({@link manualJobsToStart}), or an unseen hold. What `mr_pipeline` asks:
   * a fresh pipeline is never requested because of a `run` job. Equal to `holds` for a policy with
   * no `run` mode.
   */
  readonly heldForPerson: boolean;
} => {
  // BACKLOG 1490: a job list the provider cut is a list that may hide what holds the pipeline.
  const unseen =
    pipeline.status === 'manual' &&
    (pipeline.jobs_truncated === true || !pipeline.jobs.some((job) => isBlockingManualJob(job)));
  const counted = (job: PipelineJob): boolean => !isIgnoredJob(policy, job);
  // S-28.7: a job the project requires by mode (`run`/`wait`) holds under every policy.
  const required = pipeline.jobs.filter(
    (job) => job.status === 'manual' && isRequiredJob(policy, job),
  );
  const base = ((): readonly PipelineJob[] => {
    switch (policy.kind) {
      case 'none':
        return [];
      case 'all':
        return pipeline.jobs.filter((job) => isBlockingManualJob(job) && counted(job));
      case 'named':
        return pipeline.jobs.filter(
          (job) => job.status === 'manual' && policy.names.has(job.name) && counted(job),
        );
      case 'default': {
        const test = isTestJob(hasTestStage(pipeline.jobs));
        return pipeline.jobs.filter((job) => isBlockingManualJob(job) && test(job) && counted(job));
      }
    }
  })();
  const jobs = pipeline.jobs.filter((job) => base.includes(job) || required.includes(job));
  const unseenHolds = unseen && policy.kind !== 'none';
  const toStart = manualJobsToStart(pipeline, policy);
  return {
    holds: jobs.length > 0 || unseenHolds,
    jobs,
    unseen,
    heldForPerson: jobs.some((job) => !toStart.includes(job)) || unseenHolds,
  };
};

/** Why a pipeline the rule does not pass is still waited on — the gate's words pick from it. */
export type CiWaitCause =
  /** A job is still queued or running — on a held pipeline, one queued behind the manual job. */
  | 'in_flight'
  /** No job ran yet. */
  | 'nothing_ran'
  /** An unstarted manual job the policy requires (a test job, by default). */
  | 'manual_required'
  /** The provider holds the pipeline at a manual job the read cannot see. */
  | 'manual_unseen'
  /**
   * The provider's job list was cut (`jobs_truncated`, BACKLOG 1490), so the rule cannot say that no
   * unlisted job is one it requires: it never passes on a cut list and waits as before.
   */
  | 'jobs_unseen';

export type CiPipelineJudgement =
  | {
      readonly kind: 'passed';
      /**
       * The **blocking** manual jobs nobody started that the pass leaves behind — what the gate
       * records as `ci_manual_not_run` (decision 5). Optional ones held nothing and are not listed.
       */
      readonly notRun: readonly PipelineJob[];
    }
  | {
      readonly kind: 'failed';
      /** The jobs the failure names, in the pipeline's order. */
      readonly failing: readonly PipelineJob[];
      /** A failure of a job the project named in `required_manual_jobs`, not the pipeline's own. */
      readonly required: boolean;
      /**
       * The named required jobs the provider reports `skipped` (BACKLOG 1493): the pipeline's
       * rules mean they never run, so *exactly these must have run* cannot be met. Also in
       * `failing`; listed apart so the reason can say they were skipped rather than failed.
       */
      readonly skipped: readonly PipelineJob[];
    }
  | {
      readonly kind: 'waiting';
      readonly cause: CiWaitCause;
      /**
       * The manual jobs this wait is for, first the ones the policy requires, then any other
       * blocking manual job (the one a held pipeline is held at) — what the gate's sentence names.
       */
      readonly heldAt: readonly PipelineJob[];
      /**
       * S-28.7: the `run` jobs currently `manual` that the platform may start
       * ({@link manualJobsToStart}) — on every wait, a running pipeline's included, so the second
       * wave (a test job that `needs:` a started build job) is started when it appears. Empty for a
       * policy with no `run` mode.
       */
      readonly toStart: readonly PipelineJob[];
    };

const TERMINAL_FAIL = new Set(['failed', 'canceled', 'skipped']);

const ranAndFailed = (job: PipelineJob): boolean =>
  job.status === 'failed' || job.status === 'canceled';

/**
 * **The CI gate's verdict on a pipeline's jobs** (TD-036 decisions 2–3). `pending` and `running`
 * pipelines wait and `failed`/`canceled`/`skipped` ones fail exactly as before; `success` passes
 * as before unless a job the project named is unstarted, failed or skipped (or the list is cut);
 * `manual` is judged by (a)–(d), the cut list and the unseen hold.
 */
export const judgeCiPipeline = (
  pipeline: JudgedPipeline,
  policy: ManualJobPolicy,
): CiPipelineJudgement => {
  const { jobs } = pipeline;
  const hold = manualJobsHolding(pipeline, policy);
  const blocking = jobs.filter(isBlockingManualJob);
  const heldAt = [...hold.jobs, ...blocking.filter((job) => !hold.jobs.includes(job))];
  const toStart = manualJobsToStart(pipeline, policy);
  const waiting = (cause: CiWaitCause): CiPipelineJudgement => ({
    kind: 'waiting',
    cause,
    heldAt,
    toStart,
  });
  if (TERMINAL_FAIL.has(pipeline.status)) {
    return {
      kind: 'failed',
      failing: jobs.filter((job) => job.status === 'failed' && !job.allow_failure),
      required: false,
      skipped: [],
    };
  }
  if (pipeline.status === 'pending' || pipeline.status === 'running') {
    return waiting('in_flight');
  }
  // TD-036 decision 3, and S-28.7's `run`/`wait`: a required job that ran and failed fails the
  // gate whatever its `allow_failure` — a played job's result is a required check.
  const requiredFailed = jobs.filter((job) => ranAndFailed(job) && isRequiredJob(policy, job));
  // BACKLOG 1493: a required job the pipeline's rules skipped never runs, so it is never satisfied.
  const requiredSkipped = jobs.filter(
    (job) => job.status === 'skipped' && isRequiredJob(policy, job),
  );
  /**
   * **A `success` pipeline keeps the behaviour before TD-036** (the coordinator's ruling on #114):
   * the provider's green is believed, and only the project's **named** jobs are asked of it — a
   * named job that failed or was skipped fails the gate, one still manual keeps it waiting, and a
   * cut list keeps it waiting. Conditions (a) and (b) are not applied here: GitLab lists `created`
   * jobs on a green pipeline (a job that `needs:` an optional manual job), and waiting on them
   * would hold every such task until its CI timeout.
   */
  if (pipeline.status === 'success') {
    if (!asksForNamedJobs(policy)) {
      return { kind: 'passed', notRun: blocking };
    }
    if (requiredFailed.length > 0 || requiredSkipped.length > 0) {
      return {
        kind: 'failed',
        failing: [...requiredFailed, ...requiredSkipped],
        required: true,
        skipped: requiredSkipped,
      };
    }
    if (pipeline.jobs_truncated === true) {
      return waiting('jobs_unseen');
    }
    return hold.holds ? waiting('manual_required') : { kind: 'passed', notRun: blocking };
  }
  // `manual`: held at a blocking manual job. (b) — and a required job that ran and failed, or was
  // skipped, fails the gate (decision 3, BACKLOG 1493).
  // S-28.7: an `ignore` job is not a check — its failure is not the gate's.
  const disallowed = jobs.filter(
    (job) => ranAndFailed(job) && !job.allow_failure && !isIgnoredJob(policy, job),
  );
  if (disallowed.length > 0 || requiredFailed.length > 0 || requiredSkipped.length > 0) {
    const failing = [
      ...disallowed,
      ...[...requiredFailed, ...requiredSkipped].filter((job) => !disallowed.includes(job)),
    ];
    return {
      kind: 'failed',
      failing,
      required: disallowed.length === 0,
      skipped: requiredSkipped,
    };
  }
  // (a): nothing passes while a job is still queued (behind the held one) or running.
  if (jobs.some((job) => job.status === 'pending' || job.status === 'running')) {
    return waiting('in_flight');
  }
  // BACKLOG 1490: on a cut job list the rule never passes.
  if (pipeline.jobs_truncated === true) {
    return waiting('jobs_unseen');
  }
  // (c)
  if (!jobs.some((job) => job.status === 'success')) {
    return waiting('nothing_ran');
  }
  if (hold.unseen) {
    return waiting('manual_unseen');
  }
  // (d), or the project's list.
  if (hold.holds) {
    return waiting('manual_required');
  }
  return { kind: 'passed', notRun: blocking };
};
