# Agentic — Product Knowledge Base

> **Status:** Round 1 (product) and Round 2 (technical design) complete as of 2026-08-28. Next: implementation by the orchestrator following `technical/13-implementation-plan.md`.
> The platform name **"Agentic"** is a working title. Every document refers to it as *the platform* or `Agentic`; renaming is a search-and-replace of one word. Never hard-code the name into identifiers (package names, DB names, env prefixes) — see [BD-014](decisions/business/BD-014-rename-friendly-naming.md).

This directory is the single source of truth for **what** we are building and **why**. It is written to be read by humans and by the Claude Code agents that will implement the platform. Everything here is a decision or a candidate decision; nothing is "just notes".

## How to read this

| Folder | What lives here | Who writes it |
|---|---|---|
| `product/` | Product definition: vision, users, pipeline, knowledge base, integrations, governance, UI, roadmap | Product owner + brainstorming sessions |
| `decisions/business/` | Business decisions (`BD-nnn`), one per file, ADR style — immutable once accepted, superseded by a new one | Anyone; accepted by product owner |
| `decisions/technical/` | Technical decisions (`TD-nnn`) — filled in Round 2 | Tech lead |
| `research/` | Research reports that informed decisions: 01 competitors & lessons, 02 memory & knowledge, 03 integration tooling, 04 Claude capabilities, 05 SDK orchestration details, 06 workflow engines & queues, 07 data & search, 08 UI stack, 09 testing/CI/Docker/release, 10 workspace isolation, 11 runtime/framework/auth/clients. Reference only; may go stale | Research sessions |
| `technical/` | Round 2 working area: constraints, candidates, architecture | Tech lead |
| `OPEN-QUESTIONS.md` | Questions that block or shape decisions, each with a recommended answer | Anyone |
| `TODO.md` | Product-level backlog for the definition phase and pre-implementation | Anyone |
| `GLOSSARY.md` | Ubiquitous language. If a word is not here, do not use it in code | Anyone |

## Reading order (first time)

1. [Vision and positioning](product/01-vision-and-positioning.md)
2. [Personas and jobs to be done](product/02-personas-and-jobs-to-be-done.md)
3. [User journeys](product/03-user-journeys.md)
4. [The pipeline](product/04-pipeline.md) — the heart of the product
5. [Knowledge base and memory](product/05-knowledge-base-and-memory.md) — the differentiator
6. [Project onboarding](product/06-project-onboarding.md)
7. [Self-improvement and feedback](product/07-self-improvement-and-feedback.md)
8. [Integrations](product/08-integrations.md)
9. [Governance: cost, budgets, audit](product/09-governance-cost-audit.md)
10. [UI and UX](product/10-ui-ux.md)
11. [Tenancy, projects and isolation](product/11-tenancy-projects-isolation.md)
12. [The `.agentic` directory](product/12-agentic-directory.md)
13. [Agents, prompts and skills](product/13-agents-prompts-skills.md)
14. [MVP scope and roadmap](product/14-mvp-scope-and-roadmap.md)
15. [Risks, non-goals and principles](product/15-risks-non-goals-principles.md)
16. [Metrics and success criteria](product/16-metrics-and-success-criteria.md)
17. [Repository readiness](product/17-repository-readiness.md)
18. [Adoption features and operating modes](product/18-adoption-and-operating-modes.md)
19. [Operating definitions](product/19-operating-definitions.md) — templates, defaults and formulas decided by the product owner

Then the technical design: [`technical/README.md`](technical/README.md) → `technical/01`…`13`, decisions `TD-001`…`TD-024`.

## Conventions

- **Decisions are explicit.** When a document says "we do X", there is a `BD-nnn`/`TD-nnn` behind it or the sentence is marked `(proposed)`.
- **Business vs technical.** Product docs say what the user sees and why. Technical docs say how. If a product doc starts naming libraries, move that sentence to `technical/`.
- **Defaults are overridable.** Every default (prompt, model, effort, stage, limit) is documented with *where* a user can override it (global settings, project settings, `.agentic/` in the repo).
- **No secrets, ever.** Docs may show config *shapes* with placeholder values only. See [BD-002](decisions/business/BD-002-open-source-build-in-public.md).
- **Verify over assume.** Any statement about an external system (Claude, Jira, GitLab, Slack, Sentry, Loki, competitors, prices) must trace to a file in `research/` that cites a source URL. Anything not yet verified is tagged `[unverified]` inline and listed under *Verification* in `TODO.md`. Assumptions about *our users* are tagged `(assumption)` and listed in `OPEN-QUESTIONS.md`.
- **Dates are absolute** (`2026-08-28`), never "next week".
- **Language:** English for everything in the repo. Agent prompts default to English; the agents answer humans in the language the human used (see [BD-016](decisions/business/BD-016-language-policy.md)).
