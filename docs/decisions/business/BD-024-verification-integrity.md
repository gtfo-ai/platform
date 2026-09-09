# BD-024 — Verification integrity: protected tests, reproduction gate, CI is the only green

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** product/04 (S4, S5), research/01 (test gaming, false completion, self-grading)

## Context
Evidence: agents misreport completion (22.6% of misalignment episodes; 75.8% of self-assessed failures were false successes), pass rates collapse when test edits are excluded (37–52% → 20–24%), and evaluators talk themselves into approving. Every mature system separates the grader from the worker and verifies *state*, not claims.

## Decision
1. "Done" is decided by **deterministic checks**, never by the implementing agent's claim: CI pipeline result, test results, and stage artifacts with evidence.
2. **Test tamper gate:** modifications or deletions of existing tests and of CI/lint configuration are flagged by the CI gate/reviewer as blockers unless the plan explicitly listed them with a reason, and the Code review must confirm the reason. Projects can declare protected paths.
3. **Reproduction gate for bugs:** the fix must include a test that fails on the base commit and passes on the head commit (reverse-classical test); the CI gate runs it against both when feasible; otherwise the Investigation artifact must contain reproduction evidence.
4. Review agents run in fresh contexts with read-only tools and have no access to the implementer's session.
5. Bounded observations: tool output is truncated head/tail; CI logs are reduced to the failing job's error block before being fed back.

## Consequences
- The CI gate needs job-log extraction and diff classification (Round 2).
- Projects without CI get weaker guarantees; the readiness score (product/06) makes that visible.
