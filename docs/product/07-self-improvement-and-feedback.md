# 07 — Self-improvement and feedback

Decisions: [BD-018](../decisions/business/BD-018-self-improvement-via-proposals.md), [BD-022](../decisions/business/BD-022-external-text-is-untrusted.md). Evidence: research/02 (ACE, ReasoningBank, Copilot memory, Augment memory review, "Learning on the Job").

## The idea

Treat the platform like a developer who keeps a notebook. After every task and every correction, the notebook gets a little better, and the next task starts from it. The difference from a naïve "append to CLAUDE.md" approach is **governance**: proposals, provenance, validation, expiry, consolidation.

## Signals

| Signal | Source | Strength |
|---|---|---|
| CI pass/fail, test results | CI gate | strong, objective |
| Review findings (agent) and whether they recurred | Code review / Business review verdicts | medium |
| Human MR comments and requested changes | Git provider events | strong (a human corrected the agent) |
| Explicit feedback: `@agentic remember: …` in MR/ticket/Slack; 👍/👎 + text in UI on a run or artifact | Humans | strongest, explicit intent |
| Questions the agent had to ask | Refinement/Architecture | medium (missing knowledge indicator) |
| Returns and escalations with reasons | Pipeline | strong |
| Proposal acceptance/rejection with reason | Knowledge screen | strong (teaches the Librarian) |

## Loop

1. **Reflect** (Retrospective stage, per task; and Feedback intake, per feedback event): reads the task history and the signals; emits **delta proposals** only — add/update/deprecate a lesson, promote a lesson to a rule, draft a skill from a repeated successful procedure, propose a one-line `CLAUDE.md`/rule addition when the same correction occurred twice. Splits proposals into *business* and *technical*. Never rewrites whole files.
2. **Curate** (Librarian): dedupe against existing items (add / update / deprecate / no-op), validate schema and links, secret scan, size budgets, gates for promotion (`confirmed` requires a passing check or a human confirmation and must name the failure it prevents).
3. **Apply** by significance (BD-018): the Curator scores each delta; below the *discard threshold* it is dropped; between the thresholds it becomes a proposal, or is committed directly with an audit line if the project opted into `auto_apply`; above the *auto-apply threshold* it is always a proposal for a maintainer (UI queue or knowledge MR). Thresholds and `auto_apply` (default off) are project settings.
4. **Use**: the next run's context pack includes matching items; the run records which items were included and whether the agent cited them.
5. **Hygiene** (nightly): re-verify expiring items against HEAD, deprecate items that were included N times and never useful (heuristic + human confirmation), consolidate overlapping items, regenerate the index and search index, produce the KB health report.

## Scopes of what can be learned

| Scope | Example | Stored as |
|---|---|---|
| Project, technical | "Migrations must be reversible; CI runs `migrate:down`" | lesson → rule |
| Project, business | "Invoices for EU customers always include VAT id; see glossary 'reverse charge'" | business page / glossary / lesson |
| Stage-specific | "Code review: flag any direct SQL in controllers" | rule with `scope: stage:code-review` |
| Path-specific | "`packages/payments/**`: never log card data" | rule with `paths:` |
| Pipeline/process | "Plan approval keeps being requested for small refactors → lower threshold" | suggestion to the project maintainer (not auto-applied) |
| Platform (global) | "Refinement asks the same question about acceptance criteria formatting" | improvement issue for the Agentic product itself (we dogfood; see TODO) |

## Feedback UX

- MR/ticket/Slack: `@agentic remember: <text>` (configurable trigger) → acknowledged with a reply and a link to the proposal.
- UI: 👍/👎 on a run, stage output or artifact, with optional text and a scope picker (this task / this stage / this project / paths).
- The person giving feedback sees, within a minute, what the platform understood (the proposal diff) and can edit it.
- Feedback authors are verified identities (BD-022); anonymous or unverified text never becomes a rule.

## Guardrails against "learning" the wrong thing

- Provenance on every item; no provenance → no item.
- Contradiction detection flags, never auto-resolves.
- Rule count and index size budgets; bloated KBs measurably hurt (research/02).
- Per-project eval set (5–10 tasks) re-run when the KB changes materially (phase 2) to catch regressions.
- Deprecate, don't delete; git history keeps everything.
