# BD-006 — Human checkpoints: questions always, plan approval by size policy

- **Status:** accepted (2026-08-28, Q3, Q8, Q10)
- **Date:** 2026-08-28
- **Relates to:** product/04, product/03 UJ-2

## Context
Full autonomy is the goal, but the brief explicitly wants refinement to raise questions and wait. Community experience (research/01) says the most valuable human checkpoint is *before* code is written, and that the cheapest one is answering a precise question.

## Decision
- Any agent stage may raise **questions**; the task pauses until answered via ticket comment, Slack thread or UI. Unanswered questions escalate to `Needs human` after **1 working day** by default (configurable per project), with one reminder before escalation — halfway through the working time to the deadline (WP-84).
- Only **mapped users** (platform account matched by email) can act: role `member` answers questions, role `maintainer` approves plans and knowledge proposals. Comments by unmapped users, bots or contractors are recorded but never trigger transitions (BD-022).
- **Plan approval** is a project policy: `never | above size (default L) | always`. Default: required for L/XL plans.
- **Amendment (WP-34, session 5 — as built, Q86):** a **shadow** task never asks for plan approval, whatever the policy, probation or risk class says. A shadow batch runs unattended by definition — nothing it produces reaches a provider (BD-021), its cost is bounded by the shadow budget and the org, project and task caps, and product/18's Observe level never asks for a plan — so an approval would park every ticket of the batch on a human for a decision that decides nothing. The skip is unconditional and stated at `packages/application/src/pipeline/saga.ts`; the alternative, one approval per batch, is recorded under Q86 if this is ever reversed.
- **Amendment (WP-56, session 8 — Q95 answered per its recommendation, not waited on):** an **approval** (plan or budget) expires on the same working-day calendar as a question and at the same default — **1 working day**, read from the template's limits, never from a new dial cell — and an expired approval escalates the task to `Needs human` exactly as an unanswered question does. The founder may reverse this; if so, the approval-expiry machinery is deleted rather than left unreachable (Q95).
- **Amendment (2026-10-06, PROGRESS backlog 495 — as built; the decision was silent on what a rejection does):** a **rejected plan** sends the task back to Architecture as a **new attempt**, with the maintainer's reason as that attempt's return feedback, and spends one round of the `architecture_revisions` loop (BD-008, default 2); a rejection with the loop spent escalates the task to `Needs human`, the reason kept on the rejected attempt for whoever hands it back. A **rejected budget** is not a rejected plan: the task stops at `Needs human` and does not go round again, because a second plan would carry the same estimate (WP-28).
- **Amendment (2026-11-06, the owner on a live task — *"I'm blind and blind approve is no-go"*; data shape in TD-035):** an approval is a decision **about evidence**, so it carries three things and the screen shows all three beside the buttons:
  1. **Its subject** — the exact thing being approved, fixed when it was asked: for a plan, *the* plan version that was current at the request (not "the latest plan"); for a budget, the estimate and the threshold it crossed. A click can only approve the subject the person was shown; if a newer plan exists, the old approval cannot be approved — the newer plan is asked for on its own.
  2. **Why it was asked** — every reason that required it, not just the first: probation (task *n* of *N*), a risk class the plan touches (named), the plan's size at or above the threshold, a policy of `always`, an estimate above the budget threshold.
  3. **How to stop being asked for this reason** — e.g. probation ends after *N* completed tasks or when a maintainer ends it; a size threshold or the autonomy dial can be raised; a risk class's policy can be changed (product/19 §14 recommends keeping it). The platform states the lever; it never pulls it.

  The intent behind this: plan approval is **not** the goal of the product — refinement and plans should become good enough not to need it. It exists for exactly the cases where trust is not yet earned (a new project, a risky area, a large change), and each ask names which of those it is, so approvals become rarer as trust grows by a maintainer's visible choice rather than silently. An approval asked before this amendment whose subject or reasons were not recorded says **"not recorded"** — it is never back-filled with a guess — and a plan approval with no identifiable plan cannot be approved, only rejected (which asks for a fresh plan). Who may decide is unchanged (maintainer).
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
