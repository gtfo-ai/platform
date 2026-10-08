# Decisions

Architecture-Decision-Record style. One decision per file. Never edit an accepted decision's substance; write a new one that supersedes it and link both ways.

- `business/BD-nnn-<slug>.md` — product/business decisions (what, why, for whom, policy).
- `technical/TD-nnn-<slug>.md` — technical decisions (how). Round 2.

## Template

```markdown
# BD-nnn — Title

- **Status:** proposed | accepted | superseded by BD-mmm
- **Date:** YYYY-MM-DD
- **Deciders:** who
- **Relates to:** docs, other decisions

## Context
What situation or requirement forces a decision. Facts with sources; assumptions marked.

## Decision
The decision, in one or two sentences, in the imperative.

## Rationale
Why this over the alternatives.

## Alternatives considered
- Alternative — why not.

## Consequences
Positive, negative, follow-ups (TODO links), what must be verified.
```

## Index — business

| ID | Title | Status |
|---|---|---|
| [BD-001](business/BD-001-product-scope.md) | Product scope: autonomous ticket-to-merge-request pipeline for Claude Code teams | accepted |
| [BD-002](business/BD-002-open-source-build-in-public.md) | Open source, build in public, zero secrets in the repository | accepted |
| [BD-003](business/BD-003-auditability.md) | Everything is auditable and replayable | accepted |
| [BD-004](business/BD-004-claude-only-provider-modes.md) | Claude only; provider modes `api` and `local`; no claude.ai login in the product | accepted |
| [BD-005](business/BD-005-pipeline-stages.md) | Default pipeline stages, templates and review independence | accepted |
| [BD-006](business/BD-006-human-checkpoints.md) | Human checkpoints: questions always, plan approval by size + probation | accepted |
| [BD-007](business/BD-007-human-merges.md) | A human merges; human MR comments re-enter the pipeline | accepted |
| [BD-008](business/BD-008-bounded-loops-and-escalation.md) | Every loop is bounded; escalation to `Needs human` | accepted |
| [BD-009](business/BD-009-single-tenant-instances.md) | One instance per organisation (tenant); many projects per instance | accepted |
| [BD-010](business/BD-010-wip-limits-and-budgets.md) | WIP limits per project; budgets at org/project/task/run with pause-not-kill | accepted |
| [BD-011](business/BD-011-cost-accounting.md) | Cost accounting: provider-reported cost is truth, price table for estimates | accepted |
| [BD-012](business/BD-012-knowledge-in-repo.md) | Knowledge base lives in the project repository as markdown; indexes are derived | accepted |
| [BD-013](business/BD-013-default-models-and-effort.md) | Default model and effort per stage | proposed |
| [BD-014](business/BD-014-rename-friendly-naming.md) | The product name is a display string; identifiers are name-neutral | accepted |
| [BD-015](business/BD-015-ui-first-class.md) | The web UI is a first-class control tower, humans still work in their tools | accepted |
| [BD-016](business/BD-016-language-policy.md) | English in repo/prompts/UI; agents reply to humans in the human's language | accepted |
| [BD-017](business/BD-017-pluggable-integrations-by-type.md) | Integrations are pluggable by type with a contract; adding one never changes the core | accepted |
| [BD-018](business/BD-018-self-improvement-via-proposals.md) | Self-improvement through provenance-carrying proposals; two significance thresholds | accepted |
| [BD-019](business/BD-019-onboarding-optional-but-nudged.md) | Project onboarding is optional but strongly nudged and scored | accepted |
| [BD-020](business/BD-020-docker-12-factor-deployment.md) | Docker is the only supported deployment; 12-factor | accepted |
| [BD-021](business/BD-021-agent-workspace-isolation.md) | Each task runs in an isolated, disposable workspace with least-privilege tools | accepted |
| [BD-022](business/BD-022-external-text-is-untrusted.md) | All text from tickets, MRs, logs and web is untrusted data, never instructions | accepted |
| [BD-023](business/BD-023-workpad-comment.md) | One sticky "workpad" comment per ticket and per MR, edited in place | accepted |
| [BD-024](business/BD-024-verification-integrity.md) | Verification integrity: protected tests, reproduction gate, CI is the only green | accepted |
| [BD-025](business/BD-025-config-trust-and-command-policy.md) | Agent configuration is trusted only from the default branch; three-list command policy; no tokens in agent context | accepted |
| [BD-026](business/BD-026-repository-readiness.md) | Repository readiness is measured, shown and drives conservative defaults; it is not auto-remediated | accepted |
| [BD-027](business/BD-027-autonomy-dial.md) | One autonomy dial with presets over granular policies | accepted |
| [BD-028](business/BD-028-opt-in-features-and-wizard.md) | Adoption features are opt-in, configured in a wizard step, and always editable later | accepted |
| [BD-029](business/BD-029-business-model.md) | Everything is Apache-2.0; revenue from hosting, support and a registry service | accepted |
| [BD-030](business/BD-030-additional-pipeline-gates.md) | Rebase gate, dependency/epic awareness, reviewer routing with risk classes, dependency policy, coverage delta | accepted |
| [BD-031](business/BD-031-ticket-lifecycle-claim-qa-and-mr-conversation.md) | The tracker lifecycle is the project's mapping: optional status slots, a claimed ticket, a human QA stage, every form of a human return, the review conversation on the MR | accepted |

## Index — technical

Round 2. See [`technical/README.md`](../technical/README.md).
