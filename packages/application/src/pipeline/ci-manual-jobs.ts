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
 * (BACKLOG 1474). A named job the provider `skipped` did not run and will not: it is not waited for
 * either, for the same reason.
 *
 * ## What it does not change
 *
 * A `pending` or `running` pipeline waits, and a `failed`, `canceled` or `skipped` one fails, as
 * before; their failing jobs are the gate's own (`failed`, not allowed to fail). A `success`
 * pipeline is held to (a), (b) and the project's list as well — a provider that calls a pipeline
 * green while it lists a job queued, running or failing without permission is not believed, which
 * no GitLab pipeline reaches and which makes the property `ci-manual-jobs.test.ts` holds a statement
 * about every pass rather than about held pipelines only.
 */
import { hasTestStage, isTestJob } from '@platform/domain';
import type { PipelineStatus } from '../ports/integrations/git-provider.js';
import type { ProjectSettings } from './settings.js';

type PipelineJob = PipelineStatus['jobs'][number];
type JudgedPipeline = Pick<PipelineStatus, 'status' | 'jobs'>;

/** `pipeline.ci.required_manual_jobs`, read (TD-036 decision 3). */
export type ManualJobPolicy =
  | { readonly kind: 'default' }
  | { readonly kind: 'none' }
  | { readonly kind: 'all' }
  | { readonly kind: 'named'; readonly names: ReadonlySet<string> };

export const DEFAULT_MANUAL_JOB_POLICY: ManualJobPolicy = { kind: 'default' };

/**
 * The project's policy from its settings. The schema bounds the key at the document; a value that
 * is somehow not one of its shapes reads as the **default**, never as `[]` — the default is the
 * reading that keeps a test from being skipped.
 */
export const manualJobPolicyOf = (settings: Pick<ProjectSettings, 'config'>): ManualJobPolicy => {
  const stated: unknown = settings.config.pipeline?.ci?.required_manual_jobs;
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
} => {
  const unseen =
    pipeline.status === 'manual' && !pipeline.jobs.some((job) => isBlockingManualJob(job));
  switch (policy.kind) {
    case 'none':
      return { holds: false, jobs: [], unseen };
    case 'all': {
      const jobs = pipeline.jobs.filter(isBlockingManualJob);
      return { holds: jobs.length > 0 || unseen, jobs, unseen };
    }
    case 'named': {
      const jobs = pipeline.jobs.filter(
        (job) => job.status === 'manual' && policy.names.has(job.name),
      );
      return { holds: jobs.length > 0 || unseen, jobs, unseen };
    }
    case 'default': {
      const counted = isTestJob(hasTestStage(pipeline.jobs));
      const jobs = pipeline.jobs.filter((job) => isBlockingManualJob(job) && counted(job));
      return { holds: jobs.length > 0 || unseen, jobs, unseen };
    }
  }
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
  | 'manual_unseen';

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
    }
  | {
      readonly kind: 'waiting';
      readonly cause: CiWaitCause;
      /**
       * The manual jobs this wait is for, first the ones the policy requires, then any other
       * blocking manual job (the one a held pipeline is held at) — what the gate's sentence names.
       */
      readonly heldAt: readonly PipelineJob[];
    };

const TERMINAL_FAIL = new Set(['failed', 'canceled', 'skipped']);

const ranAndFailed = (job: PipelineJob): boolean =>
  job.status === 'failed' || job.status === 'canceled';

/**
 * **The CI gate's verdict on a pipeline's jobs** (TD-036 decisions 2–3). `pending` and `running`
 * pipelines wait and `failed`/`canceled`/`skipped` ones fail exactly as before; `success` and
 * `manual` are judged by (a), (b) and the project's list, and `manual` by (c), (d) and the unseen
 * hold as well — so a `success` passes unless a named job is unstarted or failed (or the provider
 * lists a job it cannot have finished).
 */
export const judgeCiPipeline = (
  pipeline: JudgedPipeline,
  policy: ManualJobPolicy,
): CiPipelineJudgement => {
  const { jobs } = pipeline;
  const hold = manualJobsHolding(pipeline, policy);
  const blocking = jobs.filter(isBlockingManualJob);
  const heldAt = [...hold.jobs, ...blocking.filter((job) => !hold.jobs.includes(job))];
  if (TERMINAL_FAIL.has(pipeline.status)) {
    return {
      kind: 'failed',
      failing: jobs.filter((job) => job.status === 'failed' && !job.allow_failure),
      required: false,
    };
  }
  if (pipeline.status === 'pending' || pipeline.status === 'running') {
    return { kind: 'waiting', cause: 'in_flight', heldAt };
  }
  const requiredFailed =
    policy.kind === 'named'
      ? jobs.filter((job) => ranAndFailed(job) && policy.names.has(job.name))
      : [];
  // (b), on a `success` pipeline too: a provider that calls a pipeline green while a job it counts
  // failed is not believed. And a required job that ran and failed fails the gate (decision 3).
  const disallowed = jobs.filter((job) => ranAndFailed(job) && !job.allow_failure);
  if (disallowed.length > 0 || requiredFailed.length > 0) {
    const failing = [...disallowed, ...requiredFailed.filter((job) => !disallowed.includes(job))];
    return { kind: 'failed', failing, required: disallowed.length === 0 };
  }
  // (a), on a `success` pipeline too: nothing passes while a job is still queued or running.
  if (jobs.some((job) => job.status === 'pending' || job.status === 'running')) {
    return { kind: 'waiting', cause: 'in_flight', heldAt };
  }
  if (pipeline.status === 'manual') {
    // (c) — a `success` pipeline with no job listed passes as it always did.
    if (!jobs.some((job) => job.status === 'success')) {
      return { kind: 'waiting', cause: 'nothing_ran', heldAt };
    }
    if (hold.unseen) {
      return { kind: 'waiting', cause: 'manual_unseen', heldAt };
    }
  }
  // (d), or the project's list; on a `success` pipeline only a named job can still be manual.
  if (hold.holds) {
    return { kind: 'waiting', cause: 'manual_required', heldAt };
  }
  return { kind: 'passed', notRun: blocking };
};
