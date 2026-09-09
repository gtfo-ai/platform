# BD-006 — Human checkpoints: questions always, plan approval by size policy

- **Status:** accepted (2026-08-28, Q3, Q8, Q10)
- **Date:** 2026-08-28
- **Relates to:** product/04, product/03 UJ-2

## Context
Full autonomy is the goal, but the brief explicitly wants refinement to raise questions and wait. Community experience (research/01) says the most valuable human checkpoint is *before* code is written, and that the cheapest one is answering a precise question.

## Decision
- Any agent stage may raise **questions**; the task pauses until answered via ticket comment, Slack thread or UI. Unanswered questions escalate to `Needs human` after **1 working day** by default (configurable per project), with a reminder before escalation.
- Only **mapped users** (platform account matched by email) can act: role `member` answers questions, role `maintainer` approves plans and knowledge proposals. Comments by unmapped users, bots or contractors are recorded but never trigger transitions (BD-022).
- **Plan approval** is a project policy: `never | above size (default L) | always`. Default: required for L/XL plans.
- **Probation mode:** a new project requires plan approval for its first N tasks (default 5) regardless of size; a maintainer ends probation explicitly. Readiness level 0 keeps probation on (BD-026).
- Human **merge** is always required (BD-007).
- All other stages are autonomous by default. A project can add human stages anywhere.

## Rationale
Balances autonomy with the two places where human judgement has the highest leverage per minute: clarifying intent and blessing a large plan.

## Alternatives considered
- Always approve plans — slows small tasks; humans stop reading.
- Never ask, always assume — the failure mode every autonomous-agent report warns about.

## Consequences
- Questions inbox in UI; question/answer channels must be equivalent and deduplicated.
- Question response time becomes a tracked metric (product/16).
