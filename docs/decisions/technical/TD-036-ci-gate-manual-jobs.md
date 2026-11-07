# TD-036 — The CI gate and manual jobs: a job nobody started is not a check

- **Status:** accepted
- **Date:** 2026-11-07
- **Deciders:** the product owner (the rule, BD-024's 2026-11-07 amendment), architect (the design)
- **Relates to:** BD-024, BD-017, BD-025, BD-007, TD-032, product/04 S4 and S7, product/10, BACKLOG 1078, 1471

## Context
AUT-6655 (BACKLOG 1078): pipeline 3038234623 is `manual` in GitLab's API. GitLab's UI calls that **blocked**, and it
means a manual job with `allow_failure: false`, which is the default for `when: manual` inside `rules`. Optional
manual jobs (`allow_failure: true`) do not affect the pipeline's status, and *"merge requests in projects with
Pipelines must succeed enabled can't be merged with a blocked pipeline"* (https://docs.gitlab.com/ci/jobs/job_control/,
read 2026-11-07). The gate passes only `success` (`packages/application/src/pipeline/gates.ts:687`). It waits on
everything else (`pendingPipelineDetail`, `:701`):
- on a poll-only binding, until `ci_timeout_minutes` (`ci-wait.ts`);
- on a webhook binding, GitLab's normaliser ignores a hook that is not terminal (`gitlab/inbound.ts:401`), so the
  gate's five checks run out.

The port already carries each job's `status` (with `manual`) and `allow_failure`
(`ports/integrations/git-provider.ts:157`; GitLab maps a missing value to `false`, `gitlab/provider.ts:1395`), and
`merge-request-ready.ts:290` already tells a blocking manual job from an optional one.

## Decision
1. **The port's meaning** (BD-017), stated on `pipelineJobSchema`:
   - a job's `status: 'manual'` means the job does not run until a person starts it;
   - `allow_failure: true` means the provider does not count the job's result toward the pipeline's, and `false`
     means it does, so a manual job with `false` is *blocking*;
   - a pipeline's `status: 'manual'` means the provider holds the pipeline at a blocking manual job.

   Any other git adapter maps to these meanings or reports no manual jobs. GitHub has no adapter yet. The candidate
   mapping, an Actions job that waits on an environment's required reviewers, is `[unverified]` (`docs/TODO.md`).
2. **The rule, by default.** The gate reads the live head's pipeline as it does today. A pipeline whose status is
   `manual` **passes** when all four hold:
   - (a) no job is `pending` or `running`;
   - (b) no job has `failed` unless it has `allow_failure: true`;
   - (c) at least one job has `success`;
   - (d) no unstarted manual job is required (decision 3).

   Condition (a) is what keeps a held build step from passing: GitLab leaves the jobs behind a blocking manual job
   `created`, which maps to `pending`. When the rule does not pass, the gate waits exactly as today: the held
   detail, *Needs you*, the CI timeout, and `isUnchangedHeldRetry`. The pass is judged **before** the held-retry
   comparison, and it settles through `judgeCiSettlement` like a `success`, so the tamper check still runs.
3. **The project's control** is `.agentic/config.yml` → `pipeline.ci.required_manual_jobs`. It is a strict
   sub-object of `pipelineConfigSchema`, trusted only from the default branch (BD-025), and it appears in the
   effective-config DTO and in `schemas/`. Its value is either `all` or a list of exact job names (at most 50, each
   ≤ 255 characters, no globs); the default is `[]`.
   - `all` means every blocking manual job must have run, which is today's behaviour.
   - A **named** job:
     - that is still `manual` keeps the gate waiting, whatever its `allow_failure`, even on a `success` pipeline;
     - that ran and failed fails the gate;
     - that the pipeline does not contain is not waited for, because the project's rules did not create it.
4. **What is recorded.** A pass that leaves blocking manual jobs unstarted writes **`task_stages.ci_manual_not_run`**
   (jsonb, **migration 0109, additive**) in the settling transaction while the attempt is open. The value is
   `{pipeline_id, pipeline_url, pipeline_status, jobs: [{name, url}] (≤ 20), checked_at}`, with names redacted then
   bounded, URLs and identities treated as `ci-pending-read.ts` treats them, and one writer.
   - It is a **new column** rather than a third `ci_ending` word or a new key in `ci_pending_read`, because an older
     build parses those two strictly and would refuse the task's read after a rollback (TD-032 decision 2).
   - The task-detail DTO serves the latest passed `ci_gate` attempt's value as `ci_manual_not_run` (or `null`).
     `taskStop.ci_ending` keeps its two no-answer words.
   - Optional manual jobs are **not** listed: they held nothing, and Autix's optional image builds would make the
     list noise.
   - The page's Checks item and the workpad's CI line read *CI passed — the manual job sentry-release-commit was not
     run*. The job's name is shown as untrusted text, and the job is linked through `safeHref`.
5. **Webhook bindings hear a held pipeline.** GitLab's normaliser maps a pipeline hook whose status is `manual` to
   a new event, **`ci.pipeline.held`** (the `.finished` payload with no failed jobs). The CI-settle duty handles it
   like `.finished`: it re-reads the live head and judges by decision 2.
6. **Ready and merge.** The platform never says a merge request *can be merged*. Ready means the platform's checks
   are done, and a person merges (BD-007).
   - When the pass's `ci_manual_not_run.pipeline_status` is `manual` (blocked), the Ready callout, the Ready chat
     notification and the workpad add: *"GitLab shows pipeline n as blocked at the manual job X. If this project
     requires pipelines to succeed, GitLab won't merge it until X has run: start it on GitLab."* The provider's name
     comes from the binding.
   - This decision does not read the provider's merge-check setting.

## Rejected
- **Opt-in, keeping the wait as the default.** The owner's intent is the default, and every project with a release
  job would stop.
- **Treating only `allow_failure: true` manual jobs as optional.** Those already pass, because the pipeline reads
  `success`. AUT-6655's job is blocking by GitLab's own default, so this fixes nothing.
- **Globs in `required_manual_jobs`.** A job name is an identity, and a pattern that silently matches nothing is
  worse than a name.
- **Reading `detailed_merge_status: ci_must_pass` at Ready** (documented at https://docs.gitlab.com/api/merge_requests/)
  to state the blocker for certain. It needs a port field and a recorded read on a later stage. It is filed as
  BACKLOG 1472.

## Consequences and residuals
- **A project whose draft rule makes its tests independent manual jobs, while a lint job runs, passes CI with the
  tests unstarted.** This is visible in `ci_manual_not_run` and in the readiness panel's CI-rules warning, and
  `required_manual_jobs: all` restores the wait (Q134).
- **A required job run at Ready that fails does not return the task**, because no gate is open then. GitLab shows
  the failure and the person returns the task (BACKLOG 1473).
- **A required name that the pipeline never contains is silent** (BACKLOG 1474).
- **An older build refuses a configuration that sets `pipeline.ci`**, which is the strict schema's general rollback
  cost.
- Slice S-27.2.
