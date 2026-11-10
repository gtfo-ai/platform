# BD-007 — A human merges; human MR comments re-enter the pipeline

- **Status:** accepted
- **Date:** 2026-08-28

## Context
The brief: "Merge Request is waiting to merge by developer." Developers will leave comments on MRs as they do for colleagues.

## Decision
The platform never merges. When the MR is ready, a human reviews and merges. Every unresolved MR discussion thread opened by a mapped user generates an event; threads are **batched in a 2-minute window** into one return to Implementation with all comments as input (the window opens on the first unresolved comment and the handler re-reads every unresolved thread when it fires, so later comments are included; it does not extend with each new comment — clarified at WP-05), followed by a fast-path Code review, then back to Ready (Q5). An explicit `@agentic rework` (or closing the MR with a reason) restarts from Architecture on a fresh branch instead of patching (Q20). Trigger words (`@agentic hold`, `@agentic remember:`) are configurable.

## Rationale
Keeps accountability with the team; turns the MR into the natural feedback channel instead of forcing humans into the platform UI.

## Alternatives considered
- Auto-merge on green + approvals — maybe later for `chore` template once trust metrics exist (TODO).

> **Amended by BD-031 (2026-10-08), as built at WP-178.** The return is no longer "every unresolved MR
> discussion thread": every human word since the last run — MR diff threads, MR general notes whatever
> `resolvable` says, ticket comments, and a person's status change — returns the task from any human
> stage (`qa` or Ready), batched in the same window; an acknowledgement alone and the platform's own
> notes do not (TD-029 decisions 6–8).

## Consequences
- Git provider integration must deliver MR comment and merge events (webhooks) — research/03 verifies GitLab supports this.
- A human comment loop counts toward iteration limits separately (default 3 human rounds before `Needs human`, to avoid an endless polite ping-pong).

## Amendment (2026-11-10, the product owner's ruling; design in TD-038; slice S-28.15) — the platform may merge

The owner: *"ready to merge even agentic can merge, not only person — in the agentic workflow we want as least human
steps as possible."* This supersedes *"The platform never merges"* and the parking-lot *"auto-merge … maybe later"*.

- **A per-project setting decides who merges**: a person (the default, today's behaviour) or the platform. It is set in
  the project settings by a maintainer; a repository file may only choose *person*.
- **The platform merges only when everything is true, read at the moment of merging**: the task is at Ready (QA passed
  where the project has QA), every review stage approved, CI passed on the very commit that was reviewed, the git
  provider says the merge request can be merged under its own rules (pipeline, conflicts, draft, threads, approvals),
  the ticket is not closed or taken by a person, and the project is not in shadow mode. It pins the reviewed commit, so
  a push in between refuses the merge. It never bypasses or changes a provider rule and never approves its own merge
  request.
- **The plan decision is the human checkpoint** (the owner: *"the merge decision once approved or does not need the
  approval because platform decided it is safe then platform merge"*). A task whose plan a person approved, or whose
  plan needed no approval (approved by the platform as low-risk, or the project's policy continues without one), is
  merged by the platform when the conditions above hold. Probation and risk classes do not hold the merge: they already
  force a person's plan approval. The record of the merge names the plan decision it rests on.
- **Nothing silent**: the task page says beforehand that the platform will merge and what it waits for; a refused or
  failed merge says what, why and what to do, and is left to a person (no retry loop); a merge by the platform is
  recorded as the platform's action and announced once.
- Unchanged: human merge-request comments re-enter the pipeline as amended by BD-031; a merge (by anyone) moves the task
  to the merged gate the same way.
