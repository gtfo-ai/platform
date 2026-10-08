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
