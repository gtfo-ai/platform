# BD-018 — Self-improvement through provenance-carrying proposals; approval policy per project

- **Status:** accepted (2026-08-28, Q4)
- **Date:** 2026-08-28
- **Relates to:** product/07

## Decision
Retrospectives and feedback never edit knowledge silently. They create **proposals** (diffs to KB files, rule candidates) with provenance (task, run, human author when applicable, evidence). Every proposal carries a **significance score** (new rule > new lesson > update to existing item > reference/link/typo). Two configurable thresholds govern handling: below the **discard threshold** nothing is created at all (noise); between the thresholds the change is a proposal by default, or — only if the project opts into `auto_apply` — is committed directly with an audit line and no queue entry; above the **auto-apply threshold** the change is always a proposal that a maintainer approves (UI queue or knowledge MR). Defaults: `auto_apply: off`, so every non-trivial change is a proposal. Rules carry `scope`, `confidence`, `source` and `last_validated`; unused or contradicted rules are surfaced for pruning.

## Rationale
Self-learning without governance produces rule bloat and contradictory instructions; provenance lets humans trust and prune.

## Consequences
- Proposal queue in UI; acceptance rate is a product metric.
- Significance scoring rules are part of the Librarian prompt and are auditable per proposal.
