# BD-028 — Adoption features are opt-in, configured in a wizard step, and always editable later

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** product/18, product/06

## Decision
Shadow mode, review-only mode, ticket readiness linter, history bootstrap, maintenance pipeline, digest/quiet hours, budget-approval thresholds and epic split are **off by default**; steer, take-over, cost estimates, human time accounting, ask-the-task, rebase gate, dependency awareness, reviewer routing and dependency policy (`ask`) are **on by default** because they are low-risk and only add information or safety. All are presented in one onboarding wizard step ("Operating mode and features") with a one-sentence value statement, default and cost implication; every step is skippable and every setting is mirrored in project settings. Toggle changes are audited.

## Rationale
The founder's direction: these features add and *show* value, but must not surprise teams or Jira users; opt-in with a guided setup gets both.

## Consequences
- Wizard and settings share one schema (Round 2).
- Feature usage becomes a metric (which teams turn on what, and when they move the dial).
