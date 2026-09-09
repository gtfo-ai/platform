# BD-005 — Default pipeline stages, templates and review independence

- **Status:** accepted (founder confirmed all additions 2026-08-28, Q2)
- **Date:** 2026-08-28
- **Relates to:** product/04

## Context
The brief lists: pick-up, business refinement (with return and drift labelling, questions block), architecture, implementation, code review (approve/return), business review (approve/return), waiting for human merge, lessons learned. Research on other systems (research/01) shows the recurring failure modes are vague specs, unbounded loops, no independent verification and missing observability context for bugs.

## Decision
Adopt the brief's stages and add: **Intake** as an explicit stage with WIP checks and template selection; a deterministic **CI gate** after Implementation; an **Investigation** stage in the bug template (Sentry/Loki evidence, root cause with confidence); a **Merged gate** capturing diff stats; and a **Librarian** step after Retrospective. Ship four templates: `feature`, `bug`, `chore`, `spike`. Business drift is a label plus notification, never a blocker. Code review and Business review run in fresh sessions independent of the implementer. Pipelines are data and are customisable per project (enable/disable/reorder/add custom stages bound to events).

## Rationale
- Intake as a stage makes limits and template choice auditable.
- CI as a gate is deterministic and cheap; letting an agent "decide" whether CI passed is wasteful.
- Bugs without evidence-gathering produce guessed fixes.
- Independent review is the single most effective quality lever reported across community projects.
- Templates keep cheap tasks cheap (chores skip Architecture and Business review).

## Alternatives considered
- Single "do everything" agent with a long prompt — cheaper per task but no gates, no artifacts, poor auditability, worse quality (research/01).
- Fully free-form pipeline builder from day one — over-engineering; templates + custom stages cover it.

## Consequences
- Each stage needs a role prompt, artifact schema, tool set and limits (product/13).
- Status mapping per template must be configurable in the Jira binding.
