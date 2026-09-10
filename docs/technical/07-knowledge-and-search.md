# 07 — Knowledge base indexing, search, code map, Librarian pipeline

> Round 2 design. Decisions: TD-008 (search), TD-009 (embeddings), TD-010 (code map). Sources: product/05, /07, research/02, research/07.

## Source of truth and sync
- The vault lives in the project repository at `knowledge_dir` (default `.agentic/knowledge`). The platform reads it from the **default branch** (BD-025) at task start and after every merge (`mr.merged` / `default_branch.moved`).
- `KnowledgeIndexer` job (pg-boss, singleton per project): `git diff --name-only <last_indexed>..<head>` restricted to `knowledge_dir`, `.agentic/rules`, `CLAUDE.md`, `AGENTS.md` → parse frontmatter (schema in product/05) → split into chunks by heading (each chunk prefixed with `project / path / H1 > H2`) → upsert `kb_documents`, `kb_chunks`, `kb_links` → update `kb_index_state`. Full rebuild on demand or when the parser version changes.
- Validation on index: frontmatter schema, dangling wikilinks, expired items, duplicated ids; results feed the KB health report.

## Retrieval for context packs (phase 1)
Inputs: task text (ticket + spec), touched paths (from plan/diff when available), stage.
1. **Path match:** documents whose `paths` globs match any touched path → score 1.0.
2. **Trigger/full-text match:** `websearch_to_tsquery('simple', <task keywords>)` over `kb_chunks.search`, boosted by document `kind` (stage-specific weights: business pages for Refinement, technical/decisions for Architecture and Review, lessons/pitfalls for Implementation) and by `confidence`/`status`.
3. **Validate on read:** drop items whose cited paths/symbols no longer exist at HEAD; record `validated=false` in `run_context_pack` and flag the document.
4. Fill the token budget (default 12 k for tiers 0–1): tier 0 always (index, rules, repo map for code stages), then tier 1 by score until the budget is reached; write files into the workspace `.agentic-run/context/` and list them in the prompt with 2–3-line summaries.
5. `kb_search` MCP tool exposes the same query for tier 2 (returns `path#heading` + snippet + score; never whole documents unless asked by path).

> **A pack must render provider text as provider text — including the platform's own truncation
> marker, which a provider can forge** (WP-11a review round 1, judged non-blocking; the item is in
> `docs/TODO.md` and the mechanics are in `technical/06` § ObservabilityLogs). `agentic.truncation`
> is a Sentry tag, a Loki stream label and a breadcrumb category — namespaces the *provider* writes
> — so an application that tags its own events with it produces an answer claiming a cap fired when
> none did. Every cap still holds (a real truncation overwrites the forged value), so what a forger
> buys is a false "truncated" claim plus platform-looking text inside a prompt. **This is where it
> closes**: whatever assembles a pack must not read a marker key as the platform's own voice, and
> must not let integration text — a label, a tag, a log line, a ticket — occupy the pack's own
> voice (BD-022). Closing it in the adapters instead would mean a second rule about provider-chosen
> keys in the adapter ring, which already has one.

## Phase 2: hybrid search
- Enable pgvector (`halfvec(1024)`, HNSW, cosine) on `kb_chunks`; embeddings by the `EmbeddingProvider` port (default local `Qwen3-Embedding-0.6B` int8 via transformers.js in the app process or a dedicated `indexer` role; alternatives Ollama, Voyage). Model id and dims stored on the index; changing the provider triggers a rebuild.
- Hybrid = RRF over the tsvector rank and the vector rank in one SQL statement; optional reranker later. Adoption is gated by the per-project eval set (research/02: hybrid halves retrieval failures; measure first).
- Evaluate `pg_textsearch` (BM25) at the same time; adopt only if measurably better (requires our own Postgres image with the extension).

## Code map (phase 1)
- `CodeMapper` job per commit: `ctags --output-format=json -R` (definitions), a cheap reference pass (identifier grep / ast-grep rules for the top languages), symbol graph → personalised PageRank biased toward the task's files → render a 1–4 k token map (files and their key symbols). Cache tags per blob SHA (`code_files`) and rendered maps per `(commit, focus_hash, token_budget)` (`code_maps`).
- Phase 3: tree-sitter/LSP for precise references on typed languages; opt-in per project.

## Transcript search
`run_messages.search_text` holds assistant text, tool names, file paths and user prompts (not raw tool results); GIN per partition; run-detail search uses it; cross-run search on the task page is scoped by `task_id`.

## Librarian pipeline (product/07 loop, mechanised)
1. Retrospective (agent) → `RetroReport.proposals[]` with `significance` scores (rules in the prompt; recorded per proposal).
2. `ProposalCurator` (deterministic + Librarian agent): dedupe against `kb_documents` (same `id`/path or high lexical overlap → update instead of add), schema validation, secret scan, size budgets (index ≤ 200 lines), contradiction candidates (lexical overlap + a Haiku check) flagged, provenance attached.
3. Policy (BD-018): below `discard_below` → dropped (audit only); between thresholds → proposal, or direct commit when `auto_apply` is on; above `proposal_above` → proposal. Proposals appear in the UI queue and, when the project prefers, as a knowledge MR (`agentic/knowledge/<date>` branch).
4. Apply: Librarian run in a knowledge workspace (default branch checkout): edit files, regenerate `index.md`, commit with provenance trailer (`Agentic-Source: task PROJ-123 run <id>`), push to the knowledge branch → MR (or direct push to default branch when the project allows and the branch is not protected).
5. `knowledge.proposal.applied` → indexer job.
6. Nightly hygiene job: expiring items re-verified against HEAD; deprecate candidates (included N times, never cited — citation detected by matching KB paths in assistant text); consolidation suggestions; health report stored in `readiness_evaluations`-like table `kb_health_reports` and shown in the UI.

## History bootstrap (product/18)
Job: list merged MRs (`listMergedMergeRequests`, N default 200) → fetch discussions → a Sonnet 5 run per batch of ~20 MRs extracting recurring reviewer requests, conventions and pitfalls into proposals with MR links as evidence → curator → proposal queue. Budget-capped; progress in the UI.
