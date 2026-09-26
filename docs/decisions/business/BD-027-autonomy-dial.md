# BD-027 — One autonomy dial with presets over granular policies

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** product/18, BD-006, BD-018, BD-026

## Decision
Each project has an autonomy level — Observe, Assist, Supervised (default), Autonomous — that sets the granular policies (plan approval, probation, auto-apply, question timeout, review-only, shadow). Granular policies remain overridable; an override shows the dial as *Custom* with the differences. Readiness suggests a maximum level; maintainers may override visibly.

## Rationale
Eight independent policies are precise but hard to reason about; a dial gives teams a single, explainable step-up path while keeping precision available.

## Consequences
- Preset tables are versioned; changing a preset definition in a release never silently changes a project's effective policies (they are materialised at selection time and the UI offers "re-apply preset").

## Amendment (WP-62, 2026-09-26 — Q78, and the precedence as built)

**"Overridable" means overridable where something reads the override.** A project overrides a preset
field only through a configuration key that already spells the same setting — `policies.probation_tasks`,
`pipeline.limits.human_rounds`, `pipeline.limits.question_timeout`, `policies.knowledge_apply.auto_apply`
(`AUTONOMY_POLICY_OVERRIDE_KEYS`) — and **the key wins over the materialised preset**; the preset applies
where the document is silent, and the platform default where both are. A preset field with no such key is
not a configuration surface. A project whose document overrides a preset field is shown as **Custom**
(`autonomyResponseFrom`), which is this decision's "overridable → Custom".

**The organisation's autonomy cap applies to the level, not to the document keys.** technical/12's
*"org maximum for autonomy caps what project/repo may set"* caps the **dial**; a document key may still
go past the capped level's preset (for example `auto_apply: true` at Supervised). This is a clarification
of the decision as written — BD-027 never stated a ceiling on overrides and product/19 §11 allows
overrides for any cell — and it is recorded because it is the reading most likely to be assumed the other
way. BD-025 §2's narrow-only rule is about the command policy and does not govern the dial.

**Assist keeps its plan approval.** Assist's scope halt (`stop_after_stage`, a park in `needs_human` after
architecture, continued by the existing hand-back — Q79) does **not** replace the plan-approval gate: Assist's
preset cell is *always*, so a maintainer approves the plan before the task parks, and a member's hand-back
cannot take an unapproved plan into implementation. **What is frozen and what is live**: a task keeps the
`business_review` and `stop_after_stage` policies and the human-round limit it started under; plan approval,
the budget threshold, the question timeout and knowledge auto-apply are read when they apply, so moving the
dial changes them for running tasks too.

