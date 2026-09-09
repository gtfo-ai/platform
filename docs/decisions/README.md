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

## Index — technical

Round 2. See [`technical/README.md`](../technical/README.md).
