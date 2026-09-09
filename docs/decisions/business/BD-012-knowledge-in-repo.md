# BD-012 — Knowledge base lives in the project repository as markdown; indexes are derived

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** product/05, product/12, research/02

## Context
The knowledge base is the differentiator. Options: markdown files in git, a graph database, a vector database, or a platform-side document store. Users fear lock-in; engineers trust git review; agents read markdown natively; Claude Code's own memory model is markdown files.

## Decision
The source of truth for project knowledge is a directory of markdown files in the project repository (default `.agentic/knowledge`, configurable per project via `knowledge_dir` — Q6), versioned and reviewable like code. The platform builds and maintains **derived, rebuildable indexes** (full-text search and, when justified, embeddings and a link graph) for retrieval; losing the index loses nothing. Task episode history (per-task summaries, run metadata) is stored platform-side with optional export to the repo.

## Rationale
- No lock-in, human-editable, diffable, reviewable, portable; survives the platform.
- Agents consume markdown with zero translation; matches Claude Code conventions (CLAUDE.md, skills).
- Any graph/vector benefit can be layered on as an index without changing the source of truth.

## Alternatives considered
- Graph DB as source of truth — opaque to humans, operational burden, weak fit for prose knowledge (research/02).
- Vector DB as source of truth — not human-curatable, embeddings drift with model changes.
- Platform DB only — lock-in, invisible to developers, not reviewed.

## Consequences
- Knowledge changes by agents are commits (via MR or direct, per project policy `knowledge_apply: proposal | auto`).
- Need a Librarian to keep the vault coherent; need size budgets to keep context packs small.
- Concurrency: knowledge commits are serialised per repository.
