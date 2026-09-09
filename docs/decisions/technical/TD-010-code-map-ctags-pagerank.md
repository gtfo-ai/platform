# TD-010 — Code map: universal-ctags + reference pass + personalised PageRank, cached per blob and per commit; tree-sitter/LSP later

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/02, research/07, technical/07

## Decision
Phase 1 repo map generated from `ctags --output-format=json` definitions plus a cheap reference pass (ast-grep rules or identifier grep for the top languages), symbol graph, personalised PageRank biased to the task's files, rendered within a token budget (1–4 k). Cache tags per blob SHA and maps per `(commit, focus_hash, budget)`. Phase 3: tree-sitter/LSP for precise references (per-project opt-in). No maintained JS port of aider's RepoMap exists; we write ~300 lines.
