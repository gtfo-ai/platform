# TD-008 — Search: Postgres full-text (phase 1), pgvector hybrid with RRF (phase 2), BM25 extension only if measured

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/02, research/07, technical/07, BD-012

## Decision
Phase 1: `kb_chunks.search tsvector STORED` (config `simple` for mixed Czech/English), GIN, `websearch_to_tsquery`, kind/confidence boosts and path-glob matching; transcripts index a compact `search_text`. Phase 2: pgvector `halfvec(1024)` HNSW + RRF in SQL, gated by per-project eval sets; evaluate `pg_textsearch` (PostgreSQL licence, needs our own Postgres image) at the same time; ParadeDB rejected (AGPL). No SQLite/LanceDB second engine.

## Consequences
- Search quality is measured, not assumed (eval set per project, product/05).

## Amendment (WP-58 ruling, 2026-09-26) — phase 1 drops a query term only when its document frequency is significantly above one half

**Context.** Q58's recommendation, built at WP-58, drops a query term found in more than half of a
project's documents (the zero of the Robertson–Spärck Jones inverse document frequency). On this
repository's 160 Markdown files it separates function words (`this` 0.63 and up) from subject words
(`knowledge` 0.48 and down). On the 23-page fixture vault it drops the vault's **subject**, `session`
(13 of 23, 0.57), and a wrong page then ranks first on PostgreSQL for a query about that subject
(0.412 against the right page's 0.375; 0.474 right against 0.412 without the floor). A share read off
23 pages cannot be told from one half: its standard error there is about 0.10.

**Decision.** The floor stays a property of the `KnowledgeStore` port, counted at index time and
decided inside `search` by both adapters, and a query whose every term is dropped still returns no
documents. The drop rule becomes: drop a term when its document frequency `df` over `N` documents
satisfies **`df > N/2 + √N`** — one half plus two binomial standard errors (`2 · √N / 2`) — and
`df ≥ 2`. The margin is derived, not tuned: it is the conventional two-standard-error test that the
term's share is above one half. It gives the same split as the bare half on the measured real
corpus (line at 92.6 of 160, 0.58: `with`, `from`, `that`, `this` still dropped, `knowledge` kept),
drops nothing in a vault of four pages or fewer, and on the 23-page fixture only a term in 17 pages
or more (0.74) — so `session` is kept and the project key, which the indexer writes onto every chunk,
is dropped.

**Rejected at the same ruling**, with reasons in `docs/technical/PROGRESS.md` under WP-58 (*Architect
ruling, session 8*): the bare half as built (a measured case made worse, on the small single-subject
vault every new project starts as); "never drop a term present in the best-matching documents"
(circular, and degenerates into never dropping); a minimum surviving-term count (contradicts the
honest empty answer for an all-function-word query); a fixed minimum vault size (a second free number
the margin derives); a per-project setting (asks the operator to calibrate what nobody can yet
measure); reverting the drop and keeping only the statistics (discards the real-corpus gain).

**Consequences.** The floor is close to inert on vaults under a few dozen pages, which is correct: a
corpus that small cannot tell a subject word from a function word. The residual is stated, not
closed: on a large single-subject vault, a subject word significantly above one half is still dropped
(a query of that word alone then finds nothing by text), and the junk-query class is narrowed, not
closed. The next mechanism — inverse-document-frequency **weighting** rather than a hard drop — is
PROGRESS backlog 171 and needs a second real (Czech/English) vault before any line moves.
