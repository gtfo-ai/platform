# TD-036 — The CI gate and manual jobs: a job nobody started is not a check, unless it is a test

- **Status:** accepted
- **Date:** 2026-11-07
- **Deciders:** the product owner (the rule, BD-024's 2026-11-07 amendment); the orchestrator (Q134, from the owner's
  stated intent); the architect (the design)
- **Relates to:** BD-024, BD-017, BD-025, BD-007, TD-032, WP-143, product/04 S4 and S7, BACKLOG 459, 1078, 1471, Q134

## Context
AUT-6655 (BACKLOG 1078): pipeline 3038234623 is `manual` in GitLab's API. GitLab's UI calls that **blocked**, and it
means a manual job with `allow_failure: false`, which is the default for `when: manual` inside `rules`. Optional
manual jobs (`allow_failure: true`) do not affect the pipeline's status, and *"merge requests in projects with
Pipelines must succeed enabled can't be merged with a blocked pipeline"* (https://docs.gitlab.com/ci/jobs/job_control/,
read 2026-11-07).

The gate passes only `success` (`packages/application/src/pipeline/gates.ts:676`) and waits on everything else
(`pendingPipelineDetail`, `:696`):
- on a poll-only binding, until `ci_timeout_minutes` (`ci-wait.ts`);
- on a webhook binding, GitLab's normaliser ignores a hook that is not terminal (`gitlab/inbound.ts:401`), so the
  gate's five checks run out.

`mr_pipeline` (`merge-request-ready.ts:296`) asks for a fresh merge-request pipeline whenever the head's pipeline
holds a blocking manual job. On Autix every head is held at `sentry-release-commit`, so every head gets two
pipelines and the gate then waits on the second. The port carries each job's `status` and `allow_failure`
(`ports/integrations/git-provider.ts:157`; GitLab maps a missing `allow_failure` to `false`, `gitlab/provider.ts:1395`).
GitLab's jobs API also returns `stage`, which the adapter already parses (`gitlab/schemas.ts:264`) and drops.

**Why not pass every manual job.** The platform keeps every merge request a draft until Ready, so a project whose
draft rule makes its tests manual would reach Ready on **every** task with no test run. The readiness warning
(`packages/domain/src/readiness/ci-rules.ts`) would not catch it: it fires only when neither the push nor the
draft-merge-request context runs a test job, and never for a file with `include:`.

## Decision
1. **The port's meaning** (BD-017), stated on `pipelineJobSchema`:
   - a job's `status: 'manual'` means the job does not run until a person starts it;
   - `allow_failure: true` means the provider does not count the job's result toward the pipeline's, and `false`
     means it does, so a manual job with `false` is *blocking*;
   - the job gains **`stage: string | null`**, the provider's stage name, or `null` from a provider that has none;
   - a pipeline's `status: 'manual'` means the provider holds the pipeline at a blocking manual job.

   Any other git adapter maps to these meanings. GitHub has no adapter yet. The candidate mapping, an Actions job
   that waits on an environment's required reviewers, is `[unverified]` (`docs/TODO.md`).
2. **The rule, by default.** The gate reads the **latest** pipeline of the live head, as it does today. A pipeline
   whose status is `manual` passes when all four hold:
   - (a) no job is `pending` or `running`;
   - (b) no job is `failed` or `canceled` unless it has `allow_failure: true`;
   - (c) at least one job has `success`;
   - (d) no unstarted blocking manual job is a **test job**. A test job is one WP-143 counts: a job in stage `test`
     when any job of the pipeline is in stage `test`, otherwise every job (`ci-rules.ts:871`, `counted`). The
     predicate moves to one exported domain function that both readers use, so the convention is never written
     twice. A job whose `stage` is `null` counts. So a provider with no stages waits on every blocking manual job,
     which is today's behaviour.

   Condition (a) keeps a held build step from passing: GitLab leaves the jobs behind a blocking manual job `created`,
   which maps to `pending`. When the rule does not pass, the gate waits exactly as today: the held detail, *Needs
   you*, the CI timeout, and `isUnchangedHeldRetry`. The pass is judged **before** the held-retry comparison, and it
   settles through `judgeCiSettlement` like a `success`, so the tamper check still runs. `sentry-release-commit` sits
   in a release stage, so it passes.
3. **The project's control** is `pipeline.ci.required_manual_jobs` in `.agentic/config.yml`. It is a strict
   sub-object, trusted only from the default branch (BD-025), and it appears in the effective-config DTO and in
   `schemas/`. It has **three states**:
   - **absent**: decision 2's default;
   - **`[]`**: no manual job is required, so (d) is dropped while (a) to (c) stay;
   - **`all`**: every blocking manual job must have run, which is the behaviour before this decision.

   A **list of exact names** (at most 50, each ≤ 255 characters, no globs) replaces (d) with *exactly these must
   have run*. A named job:
   - that is `manual` keeps the gate waiting, whatever its stage or `allow_failure`, even on a `success` pipeline;
   - that ran and failed fails the gate;
   - that the pipeline does not contain is not waited for.

   `pipeline.ci` sits **beside** `pipeline.limits`, which holds `ci_timeout_minutes`, because `limits` holds bounds
   (how long and how often, BD-008), while this key is a policy about what counts as evidence. Moving the timeout
   into it would break every document that states it.
4. **`mr_pipeline` asks the same question.** A fresh merge-request pipeline is requested only when the head has no
   pipeline, or when decision 2, with the project's `required_manual_jobs`, would keep the gate waiting *because of a
   manual job*. A head held only at a job the rule does not wait for gets none, so it keeps one pipeline per head and
   the gate reads that one. Both call one pure function over `(PipelineStatus, policy)`.
5. **What is recorded.** A pass that leaves blocking manual jobs unstarted writes **`task_stages.ci_manual_not_run`**
   (jsonb, **migration 0109, additive**) in the settling transaction while the attempt is open. The value is
   `{pipeline_id, pipeline_url, pipeline_status, jobs: [{name, stage, url}] (≤ 20), checked_at}`, with names and
   stages redacted then bounded, URLs and identities treated as `ci-pending-read.ts` treats them, and one writer.
   - It is a **new column**, not a third `ci_ending` word or a new key in `ci_pending_read`, because an older build
     parses those two strictly and would refuse the task's read after a rollback (TD-032 decision 2).
   - The task-detail DTO serves the latest passed `ci_gate` attempt's value as `ci_manual_not_run` (or `null`).
   - Optional manual jobs are not listed, because they held nothing.
   - The page's Checks item and the workpad's CI line read *CI passed — the manual job sentry-release-commit was not
     run*. The job's name is shown as untrusted text, and the job is linked through `safeHref`.
6. **Webhook bindings hear a held pipeline.** GitLab's normaliser maps a pipeline hook whose status is `manual` to a
   new event, **`ci.pipeline.held`**. The event has its **own payload schema**: project, merge request, head sha and
   pipeline id, with no status and no failed jobs. `terminalCiStatus` keeps excluding `manual`, so `.finished` is
   unchanged. The CI-settle duty handles the new event as it handles `.finished`: it re-reads the live head's latest
   pipeline and judges by decision 2.
7. **Ready and merge.** The platform never says a merge request *can be merged*. Ready means the platform's checks
   are done, and a person merges (BD-007).
   - When the gate passed the head's **latest** pipeline with blocking manual jobs unstarted (`pipeline_status`
     `manual`), the Ready callout, the Ready chat notification and the workpad add one sentence: *"GitLab shows
     pipeline n, the latest for this commit, as blocked at the manual job X. If this project requires pipelines to
     succeed, GitLab won't merge it until X has run: start it on GitLab."* The provider's name comes from the
     binding, and *n* is the pipeline recorded in `ci_manual_not_run`.
   - This decision does not read the provider's merge-check setting.

## Rejected
- **Opt-in, keeping the wait as the default.** The owner wants an optional release job not to block by default.
- **Pass every manual job** (the first version of this record). It skips tests on every task of a project with a draft
  rule, and nothing warns about it (Context; Q134).
- **Treating only `allow_failure: true` manual jobs as optional.** Those already pass. AUT-6655's job is blocking by
  GitLab's own default.
- **Globs in `required_manual_jobs`.** A job name is an identity.
- **Reading `detailed_merge_status: ci_must_pass` at Ready** (https://docs.gitlab.com/api/merge_requests/). It needs a
  port field and a recorded read on a later stage, so it is filed as BACKLOG 1472.

## Consequences and residuals
- **A test job in a stage not named `test`**, in a pipeline that also has a `test` stage, passes unstarted when it is
  manual. `ci_manual_not_run` names it, and naming it in `required_manual_jobs` closes the gap for that project.
  Waiting also on a job that `ci-rules.ts` reads as manual only under the `Draft:` title is filed as BACKLOG 1475,
  because the gate does not read the CI file today.
- **A required job run at Ready that fails does not return the task** (BACKLOG 1473).
- **A required name that the pipeline never contains is silent** (BACKLOG 1474).
- **An older build refuses a configuration that sets `pipeline.ci`**, which is the strict schema's general rollback
  cost.
- Slice S-27.2.
