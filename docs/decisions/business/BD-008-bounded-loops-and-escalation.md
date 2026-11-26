# BD-008 — Every loop is bounded; escalation to `Needs human`

- **Status:** accepted (amended by [BD-034](BD-034-recover-before-escalating.md), 2026-11-26)
- **Date:** 2026-08-28

## Context
Review ↔ implementation, CI ↔ implementation, question rounds and plan revisions can loop forever, burning money.

## Decision
Every return cycle has a maximum iteration count (defaults: code review 3, business review 2, CI fixes 3, refinement question rounds 2, architecture revisions 2, human MR rounds 3). Every run has `maxTurns` and a USD cap. Exceeding any limit moves the task to `Needs human` with a summary of what was tried, and notifies. Nothing retries silently.

## Rationale
Predictable worst-case cost per task; makes systemic problems (bad prompt, missing knowledge) visible instead of hidden inside retries.

## Consequences
- Iteration counters visible in UI and ticket comments.
- Retrospective analyses escalations as first-class input.

## Amendment 2026-11-26 — recover before escalating ([BD-034](BD-034-recover-before-escalating.md))
A limit that is spent still moves the task to `Needs human`. But a condition the platform can recover from by itself is not a reason to call a person: a pipeline that is still running, a provider that has not answered yet, a run that never reached the model, a worker that was lost or stopped. Those wait or retry with backoff under a long time bound. "Nothing retries silently" now means nothing retries without a bound and every retry is visible. The iteration limits above are unchanged.
