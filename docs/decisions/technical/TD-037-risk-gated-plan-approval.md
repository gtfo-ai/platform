# TD-037 — Risk-gated plan approval: an opt-in policy over the Architect's self-assessment and the platform's own facts; either can only add an ask; an auto-approval is still an approval row

- **Status:** accepted
- **Date:** 2026-11-10
- **Deciders:** the product owner (the ruling, BD-006's 2026-11-10 amendment); the orchestrator (authorised the shape);
  the architect (this record)
- **Relates to:** BD-006, BD-003, BD-022, BD-027, BD-030, TD-035, product/04 S2, technical/12, slice S-28.8

## Context
The plan gate asks a maintainer whenever `planApprovalReasons` (`packages/domain/src/policies/autonomy.ts:268`) is
non-empty: a risk class, probation, or the dial's policy (`always`, or `above_size` with the plan's `size` at or over the
threshold). On a project past probation most asks are the size policy alone, and the owner wants those to stop for a plan
that is plainly low-risk — without letting the model talk its way past a check, and without an invisible decision.

## Decision
1. **Opt-in policy** `policies.plan_approval_risk` (strict; trusted as every `policies` key, BD-025): `{ enabled: false, max_risk: low | medium, min_confidence: 0..1, max_size: XS..XL, always_ask: risk_factor[] }`.
   Off by default; nothing changes for a project that does not set it.
2. **The self-assessment** — the plan artifact gains optional `self_assessment: { confidence: number 0..1, risk_level:
   low | medium | high, risk_factors: closed enum[], reasons: string[], open_questions: string[] }` (bounded strings;
   the role prompt and its evals change, `ROLE_PROMPT_VERSIONS` bumps). **Absent → the gate waits.**
3. **The platform's facts** — `planRiskFacts(plan, project)` in `packages/domain`, computed from data the model does not
   author for this purpose: the declared size, the count and paths of `files_to_change`, the risk classes those paths
   hit (BD-030), whether a path is a migration, CI or protected-test file, and the project's readiness level.
4. **Each side can only add asks.** The plan is auto-approved only when: the policy is enabled; every reason
   `planApprovalReasons` gave is a **policy** reason (`size_at_or_above`, `policy_always`) — a `risk_class` or `probation`
   reason always waits; the assessment is present with `risk_level ≤ max_risk`, `confidence ≥ min_confidence`, no open
   question and no factor in `always_ask`; and no fact exceeds a limit (`size ≤ max_size`, no risk class, no protected
   path). Any failing condition is added to the approval's reasons as new codes of TD-035's closed vocabulary (S-28.8
   names them), so a wait says exactly which condition held it.
5. **An auto-approval is an approval.** It writes the `approvals` row with its subject (TD-035), status `approved`,
   **`approvals.auto_decided = true`** (migration **0114**, additive) and the reasons it was waivable (the facts and the
   assessment's figures), plus `task.approval.decided` with the system actor. The task page shows *Approved by the
   platform: low risk (0.9), 3 files, size S* and links the policy.
6. **Untouched:** probation, risk classes and their `require: [plan_approval]`, shadow mode's skip (BD-006 WP-34), the
   budget gate, and a rejected plan's path.

## Rejected
- **Trusting the assessment alone** — the model grades its own work; the facts exist so it cannot.
- **A model judge of the plan's risk** — a second paid run per plan, and as untestable as decision 8 of TD-029 found.
- **No approval row for an auto-approval** — the audit would hold a plan nobody approved (BD-003).

## Consequences and residuals
- **`files_to_change` is model-declared.** The facts bound what the plan *says*; the code review and the tamper check
  (BD-024) catch a change outside it afterwards, not before. Filed as BACKLOG 1562.
- `self_assessment` text is untrusted (BD-022): rendered as text, never in a prompt outside a data block.
- An older build reading a plan with `self_assessment` must accept it: the artifact field is optional and the schema change
  ships before any prompt asks for it.
