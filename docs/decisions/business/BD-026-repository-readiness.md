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

## Amendment (2026-10-06 — from the first local test) — a criterion the workspace could not run is *not checked*, not failed

**Context.** Autix's first discovery recorded **level 0** (chore and spike only). R3, R4, R5, R7 and R9
passed; R1, R2 and R6 failed only because the platform's run image has no PHP or Composer and the
install was refused — the evidence of all three says *"could not run it here"*. The repository's CI runs
its Codeception suite on every merge request. "Failed closed" was meant to cost a suggestion; here it
cost the project every `feature` and `bug` default, for a fact about the platform.

**Decision.**
1. R1, R2 and R6 — the criteria discovery answers by **running** a command (product/17) — may be
   recorded **not checked** when the run could not run the command: its interpreter or build tool is not
   in the run image, or the platform refused it or the install it needs. The evidence states the reason.
   Only those three, and only for a project that verifies locally: under `verification.mode: ci` they are
   read, and a criterion that is read cannot be "not checked" — a report saying so is recorded as a fail.
   A command that ran and failed is a fail. A criterion nobody reported still fails.
2. **The ladder:** a rung is reached when each of its criteria passed or was not checked. "Not checked"
   is not a pass: it is shown as such, is not one of the cheapest improvements, and every rung has a
   criterion that is read rather than run, so no level rests on unchecked criteria alone.
3. When an evaluation has a not-checked criterion and the project has a CI configuration (R3 passed, or
   the platform read the CI file), the evaluation carries the note `verification_mode_ci_suggested`:
   under `verification.mode: ci` discovery reads those criteria from the CI configuration instead.

**Consequences.** A model's "not checked" is a claim like its "passed" (BD-022's residual for the eleven
agent-answered criteria, unchanged): it can lift a level-0 project whose R3 passes to level 1 where it
used to stay at 0. The direction readiness errs in is still the conservative one for every criterion
that is read; for the three that are run, the platform no longer mistakes its own workspace for the
repository. A stored evaluation is not rewritten: Autix's row stays at level 0 until it is re-evaluated,
and the same answers reported under this rule read as **level 2** (R1, R2, R6 not checked; R3, R4, R5, R9
passed; level 3 stops at R8, R10 and R12, which failed), with the `verification.mode: ci` note.
