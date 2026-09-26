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
- **Amendment (WP-34, session 5 — as built, Q86):** a **shadow** task never asks for plan approval, whatever the policy, probation or risk class says. A shadow batch runs unattended by definition — nothing it produces reaches a provider (BD-021), its cost is bounded by the shadow budget and the org, project and task caps, and product/18's Observe level never asks for a plan — so an approval would park every ticket of the batch on a human for a decision that decides nothing. The skip is unconditional and stated at `packages/application/src/pipeline/saga.ts`; the alternative, one approval per batch, is recorded under Q86 if this is ever reversed.
- **Amendment (WP-56, session 8 — Q95 answered per its recommendation, not waited on):** an **approval** (plan or budget) expires on the same working-day calendar as a question and at the same default — **1 working day**, read from the template's limits, never from a new dial cell — and an expired approval escalates the task to `Needs human` exactly as an unanswered question does. The founder may reverse this; if so, the approval-expiry machinery is deleted rather than left unreachable (Q95).
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
