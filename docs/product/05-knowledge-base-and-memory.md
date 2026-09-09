# 05 — Knowledge base and memory (the killer feature)

Decisions: [BD-012 knowledge in repo](../decisions/business/BD-012-knowledge-in-repo.md), [BD-018 proposals](../decisions/business/BD-018-self-improvement-via-proposals.md). Evidence: [research/02](../research/02-memory-and-knowledge-approaches.md).

## What problem the knowledge base solves

A developer who joins a team is useful after weeks because they accumulate: what the product is for, how the code is organised, which conventions matter, what broke last time, and what the team decided and why. Claude Code starts every session as a brilliant contractor on day one. The knowledge base (KB) is how the platform's agents get to "week six" and stay there.

## Design principles (all backed by research/02)

1. **Markdown in the project's git repository is the only long-term store.** Human-readable, reviewable in MRs, `git blame` is provenance, no lock-in, and every agent reads it natively. Every index is a derived, rebuildable cache keyed by commit.
2. **Curated, not dumped.** Studies show generic repository overviews cost tokens without improving results; *tuned, failure-driven* guidance improves them. The KB holds what code cannot say: business intent, decisions and rationale, pitfalls, conventions that differ from defaults, where to look.
3. **Tiered loading.** A small always-on core; targeted injection by path/trigger; on-demand search and links; never bulk reads.
4. **Write-back only through reviewed deltas with provenance.** Agents propose; policy or humans apply; nothing is silently rewritten; deprecate, don't delete.
5. **Shape it the way Claude Code already loads knowledge** (CLAUDE.md, rules with `paths:`, skills) so humans using Claude Code locally and other agents (via `AGENTS.md`) benefit from the same files.

## Layers of knowledge

| Layer | Content | Owner | Where |
|---|---|---|---|
| **Business context** | Product overview, users/personas, domain glossary, business rules and invariants, product direction/roadmap, non-goals, quality bar | PM (from onboarding), refined by retrospectives | `.agentic/knowledge/business/` |
| **Technical context** | Architecture overview (boundaries, invariants, ownership — not a file listing), module map with "where to look for X", conventions that differ from defaults, how to run/test/lint, environments, external services, known pitfalls | Discovery agent (onboarding) + engineers + retrospectives | `.agentic/knowledge/technical/` |
| **Decisions** | ADRs for the *project* (business and technical), one per file, with status and supersession | Humans and Architecture stage (proposals) | `.agentic/knowledge/decisions/` |
| **Lessons** | Dated, sourced items distilled from retrospectives and feedback: what to do, why, what failed before; typed `lesson | pitfall | reference`; with `trigger`, `paths`, `confidence`, `evidence`, `last_confirmed`, `expires` | Retrospective + Feedback → Librarian → humans | `.agentic/knowledge/lessons/` |
| **Rules** | Short, imperative, always-on instructions for agents in a scope (project/stage/path). Promoted from lessons when confirmed twice or written by humans | Humans; Librarian proposes promotion | `.agentic/rules/` |
| **Procedures** | How-tos as skills (progressive disclosure): run integration tests, database migration protocol, release checklist | Humans + Librarian (skill drafts from repeated successful workflows) | `.agentic/skills/` (and the project's `.claude/skills/`) |
| **Episodic history** | Per-task summaries: spec, plan, outcome, iterations, cost, what was learned | Platform (automatic) | Platform database; optional export to `.agentic/knowledge/tasks/` |
| **Index** | `index.md`: one line per document, the map of the vault (≤ 200 lines) | Librarian (regenerated), humans may edit | `.agentic/knowledge/index.md` |

## Lesson item schema

```yaml
---
id: L-2026-08-28-api-tests-need-redis
title: API tests need a local Redis; run `make test-deps` first
type: lesson            # lesson | pitfall | reference | decision-pointer
kind: technical         # technical | business
trigger: "running or writing tests in packages/api"   # description used for matching
paths: ["packages/api/**"]                             # glob used for precise injection
scope: project          # project | stage:<name>
status: active          # active | deprecated
confidence: confirmed   # proposed | confirmed | contested
evidence: [task:PROJ-123, run:8f3c1, mr:!412]
added: 2026-08-28
last_confirmed: 2026-08-28
expires: 2026-12-09     # soft expiry -> re-verification
---
One paragraph: what to do, why, what failed before. Links: [[decisions/TD-007-redis-for-sessions]].
```

This mirrors what Devin (trigger descriptions), GitHub Copilot (`fact + citations + reason`, expiry, validate-on-read) and ReasoningBank (`title/description/content`) do, on plain files.

## How agents consume the KB: the context pack

For every run the platform assembles a **context pack** and records it in the audit (which documents, why, token count):

| Tier | What | Mechanism |
|---|---|---|
| 0 Always | Project `CLAUDE.md` (+ `AGENTS.md` if present), unconditional `.agentic/rules`, stage role prompt, `knowledge/index.md`, a repo map (symbol outline, 1–4k tokens) for code stages | Static, first in the prompt → prompt-cache friendly |
| 1 Triggered | Lessons/pitfalls whose `paths` match files the task touches (from the plan / diff) or whose `trigger` matches the task description; relevant decisions; the task's own artifacts (spec, plan, verdicts) | Pre-run selection by the platform: glob match + full-text (phase 1) / hybrid search (phase 2); top 5–10 items; **validated on read**: items citing paths/symbols that no longer exist are dropped and flagged |
| 2 On demand | Any KB page via wiki links from the index; `kb_search` tool (returns `path#heading` + 2–3 lines); code intelligence; ticket/MR/observability tools | Just-in-time; agents are instructed to follow links, not bulk-read |
| 3 Never bulk | Raw transcripts, old logs, full task history | Only through summaries or search |

Stage-specific emphasis: Refinement loads business context first; Architecture and Code review load technical context and decisions; Implementation loads conventions, path-scoped rules and pitfalls; Retrospective loads the task history.

Token budget per context pack is a project setting (default 12k tokens for tiers 0–1); the platform reports the actual size per run so teams see the trade-off.

## Derived indexes (rebuildable; details in Round 2)

- **Full-text search** over the vault (phase 1).
- **Hybrid search** (BM25 + embeddings, reciprocal rank fusion) over the vault (phase 2) — research shows this is the point where retrieval failures drop by half. Embedding provider is configurable; default a permissively licensed local model, switchable to a hosted one. `[Round 2: TD]`
- **Link graph** from wikilinks and frontmatter: used for lint (orphans, dangling links, contradictions) and 1-hop expansion in search. No graph database.
- **Code map** (deterministic symbol/import graph, repo map) per commit for code stages (phase 1 basic, phase 3 LSP-backed).

## Curation: the Librarian

An agent that runs after retrospectives and feedback, and nightly:

- Merges proposals into the right files; deduplicates against existing items (add / update / deprecate / no-op reconciliation).
- Enforces budgets: index ≤ 200 lines; each rule file one topic; `CLAUDE.md` pointer stays short.
- Validates: frontmatter schema, dangling links, expired items (re-verify cited paths against HEAD), contradictions (lexical overlap + LLM check → flagged for humans, never auto-resolved).
- Promotes lessons to rules when `confirmed` and cited by ≥ 2 tasks; drafts a skill when the same successful procedure appears in ≥ 3 tasks.
- Produces a "KB health" report: size, stale items, orphans, unused documents (not included in any context pack for 90 days), proposals waiting.
- Never invents facts; every change carries provenance.

Apply policy per project (BD-018): every proposal gets a significance score; below the discard threshold nothing is created; in the middle band it is a proposal unless the project opted into `auto_apply` (then committed directly with an audit line); above the auto-apply threshold it is always a proposal for a maintainer. Default `auto_apply: off`.

## Business knowledge and drift

The Refinement stage compares each ticket with `business/direction.md` (goals, non-goals, principles) and labels **drift** with a short justification when a ticket contradicts or wanders from it. Drift never blocks (founder decision), but it is visible on the ticket, in Slack and in statistics ("drift-labelled tasks per month"), and the retrospective checks whether the direction document itself is stale. When no direction document exists, behaviour is a project setting `drift_without_direction: disabled (default, one-time nudge on the project page) | label_unknown` (Q7).

## Cross-project knowledge

Not shared by default (project isolation). Later: an organisation-level `shared` vault (rules, skills, lessons with `scope: global`) consumed by projects through explicit opt-in. Listed in TODO.

## What we deliberately do not do

- No graph database, no vector store as source of truth, no LLM-extracted "facts" replacing human-readable notes (research/02: weak evidence, high ops cost, non-rebuildable).
- No per-user memory in v1 (agents act for the project, not for a person).
- No automatic bulk documentation generation of what the code already says.

## Measuring that the KB works

- Context pack size and hit rate (was a tier-1 item cited or used by the agent?).
- Returns avoided: retrospective tags each return with "would a KB item have prevented it?" and whether one now exists.
- Proposal acceptance rate; stale/deprecated counts; per-project eval set of 5–10 representative tasks re-run when the KB changes materially (phase 2).
