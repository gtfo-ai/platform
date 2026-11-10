# TD-038 — The platform may merge: `policies.merge.by`, a fresh all-true check with the reviewed head pinned, one call per head, and the existing `mr.merged` path

- **Status:** accepted
- **Date:** 2026-11-10
- **Deciders:** the product owner (the ruling, BD-007's 2026-11-10 amendment); the orchestrator (rulings 1–6); the architect (this record)
- **Relates to:** BD-007, BD-006, BD-022, BD-025, BD-027, BD-030, TD-029 amendments D–E, TD-036, TD-037, product/04 S7, product/18, slice S-28.15

## Context
AUT-6655 sat at `ready_for_merge` waiting for a person. The platform has no merge capability: `ready_for_merge` is a
`human` stage that only `mr.merged` leaves (`packages/domain/src/pipeline/templates.ts:238-246`), and
`GitProviderPort` has no merge method (`packages/application/src/ports/integrations/git-provider.ts:675-1100`). The owner:
*"ready to merge even agentic can merge, not only person — in the agentic workflow we want as least human steps as
possible."* S-28.13 (PR #155) already reads the provider's verdict at Ready (`ready_merge_check`, `task_merge_checks`,
migration 0118) and resolves the platform's own threads. `tasks.ready_head_sha` is the head CI passed and Ready judged
(`packages/application/src/pipeline/gates.ts:200-240`).

## Decision
1. **The setting** `policies.merge: { by: person | platform }`, **default `person`**. A `policies` key because it is a
   human checkpoint like `plan_approval_risk`: set on the project settings page; the repository file is graded
   `tighten_only` (it may say `person`, never `platform`; BD-025). Not a dial preset field, so no project starts merging on
   deploy; the wizard preselects `platform` when Autonomous is picked. **Why `person` by default:** a merge into a team's
   default branch is the most outward act the platform has, and product/18 makes every adoption feature opt-in and
   conservative; the owner turns it on in one save.
2. **Who merges, per task** — `mergeByPersonReasons(input)` in `packages/domain`, pure, every reason in a fixed order (the
   shape of `planApprovalReasons`): `setting_person`; `probation {completed, of}` (the dial's probation, as for plans);
   `risk_class {classes}` (any class matched by the merge request's changed paths, `riskClassesForPaths`);
   `provider_cannot_merge` (capability `merge: false`); `shadow_mode`. Empty → the platform merges. **Probation and risk
   classes always hold**, whatever the setting (TD-037: the low-risk rule never overrides probation). A person-approved
   plan does **not** hold the merge: the plan gate decides direction before spend, and a person having looked is more
   oversight, not less.
3. **The fresh check** — the `platform_merge` duty (`pipeline.outbound`, executor, idempotency key
   `platform_merge:<task>:<ready_head_sha>`) re-reads, outside any transaction, and merges only when every item holds:
   the task is at `ready_for_merge` and not paused; no human-return window is open and no person's item is younger than
   the window (TD-029 A); the latest verdict of every review stage the frozen pipeline ran is `approve`; the ticket's
   fresh status is neither `closed` nor hands-off (TD-029 B/E); the MR is `opened`, not draft, `merge_blocker` null and
   `mergeable` true (S-28.13's read: pipeline, conflicts, threads, the provider's own approval rules); and **MR head ==
   `tasks.ready_head_sha` == `tasks.ci_head_sha`** where the pipeline has `ci_gate`. A failing item is a reason on the
   page, never an attempt. The platform **never** approves a merge request, changes a branch or project setting, uses
   auto-merge, or retries past a provider refusal.
4. **The call** — new port method `mergeMergeRequest(ref, { expected_head_sha, squash, remove_source_branch })` and
   capability `merge`. GitLab: `PUT …/merge_requests/:iid/merge` with `sha` (*"must match the HEAD of the source branch"*;
   409 otherwise), `squash` = the same read's `squash_on_merge`, `should_remove_source_branch` = its
   `should_remove_source_branch || force_remove_source_branch`; the merge method is the project's and has no parameter
   (<https://docs.gitlab.com/api/merge_requests/#merge-a-merge-request>, read 2026-11-10). 401/405/409/422 → **refused**
   (port error carrying the status word), anything else → transport failure.
5. **Bounds** — **one decisive call per (task, head)**: a refusal is final for that head and leaves the merge to a person;
   a transport failure is retried by the job **3 tries** total, each try first re-reading the MR (already `merged` →
   done). The last try records `failed` and tells the people; the task stays at Ready (a person's stage), it is not
   escalated. Declared in `JOB_EXHAUSTION` as bound-and-tell. A new head (after a return and re-review) is a new key.
6. **One path to `merged_gate`.** The duty never advances the task. It records `task_merges` (migration 0119,
   additive: task, head, outcome `merged | refused | failed`, provider status word, merge commit, attempted_at) and
   `task.merge.attempted` with the system actor; the executor's `integration_actions` row is the call's audit.
   `mr.merged` (webhook or poll) moves the task. **Lost signal:** the recovery pass's `ready_merge_check` row re-reads a
   task still at Ready with a `merged` row older than 10 min and records `mr.merged` through `recordNormalisedDelivery`
   (a duplicate is dropped there); after 3 such passes it escalates with a brief.
7. **Nothing silent.** The task DTO's `merge` block: `by`, the reasons, the provider blocker, the last attempt. The page
   says *Merging automatically when GitLab reports it mergeable — now: 2 unresolved threads*, *Waiting for a person to
   merge: probation task 3 of 5*, *The platform's merge was refused: GitLab said the branch moved (409) — merge it
   yourself or Send back*, and *Merged by the platform at 14:02, commit abc1234*. A merge is announced once to the task's
   people (the notify duty's idempotency).

## Rejected
- Default `platform` — an outward write switched on by an upgrade. Coupling the merge to the plan-risk rule — see 2.
- Auto-merge (`auto_merge`) — the provider merges later, past the platform's head pin and fresh read.
- The duty advancing the task — two paths into `merged_gate`, one for platform merges only.

## Consequences and residuals
- Only GitLab ships a git adapter; the fake implements `merge` with the head check. A provider without it answers
  `merge: false` and a person merges, said as `provider_cannot_merge`.
- The binding's account needs *Allowed to merge* on the target branch; a 401 says so and the setup guide documents it.
- An organisation's autonomy maximum does not bound `policies.merge` (same shape as BACKLOG 1557); filed as BACKLOG 1589.
