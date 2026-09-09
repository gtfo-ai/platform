# BD-026 — Repository readiness is measured, shown and drives conservative defaults; it is not auto-remediated

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** product/17, product/06, BD-006, BD-024, research/01

## Context
Every system studied fails on repositories without tests and CI; some (Factory) formalised a readiness score to gate autonomy. The founder wants the idea refined for added value but wants the platform to report, not fix.

## Decision
The platform computes a per-project readiness level (0–4) from binary, automatically detected criteria, each documented with what it unlocks. The level sets conservative defaults (level 0 restricts feature/bug tasks to plan approval `always` and probation; higher levels relax) that maintainers can override visibly. Retrospectives attribute returns and escalations to missing criteria so readiness gaps get a cost. The platform never modifies the repository to improve readiness; it names the gap and the fix.

## Rationale
Makes the platform's conservative behaviour explainable, turns infrastructure gaps into a measured cost, and keeps humans in charge of repository changes that are not tickets.

## Consequences
- Discovery agent and CI gate must emit readiness signals; statistics need the attribution join.
- Level thresholds may be tuned after dogfooding.
