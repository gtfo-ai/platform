# Research: per-project knowledge base and memory for coding agents

> Verified 2026-08-28. Sources linked inline. This report informed BD-012 and product/05, /07.

## Executive summary

1. **Industry convergence:** every serious coding-agent vendor uses two layers: a human-authored, git-tracked markdown layer (CLAUDE.md / AGENTS.md / rules / SKILL.md, scoped by path or description) plus a machine-written "memories" layer that is second-class and gated by validation or human approval (Copilot, Devin, Cursor, Augment, Codex, Claude Code auto-memory). Letta (MemGPT's company) abandoned server-side memory in March 2026 for a git-repo-backed "MemFS" edited with shell tools. https://www.letta.com/blog/context-repositories/ , https://www.letta.com/blog/our-next-phase/
2. **Graph memory (Graphiti/Zep, Cognee cognify, GraphRAG) is the wrong tool for lessons-learned notes:** 4–6+ LLM calls per ingested note, a graph server, non-deterministic (not rebuildable) indexes; controlled evidence shows gains only on multi-hop/temporal questions (Mem0-graph lost to plain Mem0 on single-hop 65.7 vs 67.1 and multi-hop 47.2 vs 51.2 at ~3× latency, https://arxiv.org/html/2504.19413v1 ; GraphRAG-Bench "frequently underperforms vanilla RAG", https://arxiv.org/pdf/2506.05690). Kùzu was archived 2025-10-10 (fork: LadybugDB). Where a graph pays: deterministic **code-structure graphs** (tree-sitter/LSP) with SWE-bench evidence (RepoGraph +32.8% relative, https://arxiv.org/html/2410.14684v1 ; LocAgent Acc@10 77.4% vs 58.8% embeddings, https://arxiv.org/html/2503.09089).
3. **Vector search is a stage-2 add-on.** Anthropic: start with agentic search (glob/grep), add semantic search only if speed or fuzzy queries demand it. https://claude.com/blog/building-agents-with-the-claude-agent-sdk . When added: hybrid BM25 + dense with RRF (Anthropic Contextual Retrieval: −49% retrieval failures, −67% with reranking; if the KB is under ~200k tokens "just put it in the prompt with caching"). https://www.anthropic.com/engineering/contextual-retrieval . Anthropic offers no embedding model; Voyage is the documented example. https://platform.claude.com/docs/en/build-with-claude/embeddings
4. **Context files measurably help efficiency and adherence, not correctness by default.** AGENTS.md present → −28.6% runtime, −16.6% tokens at equal completion (https://arxiv.org/abs/2601.20404); generic repo overviews did not raise success and cost +20% (https://arxiv.org/abs/2602.11988); *tuned* guidance raised SWE-bench Verified 25.5% → 33.0% (https://arxiv.org/abs/2606.20512). Implication: the KB must hold **non-derivable** knowledge (pitfalls, rationale, decisions, where-to-look) and must be curated — exactly what Claude Code's `/doctor` trims.
5. **A runtime-practical self-improvement loop exists:** Reflector → Curator → delta edits to a playbook (ACE, ICLR 2026, https://arxiv.org/abs/2510.04618), lesson items `{title, description, content, evidence}` from successes and failures (ReasoningBank, +4.6% SWE-bench Verified, https://arxiv.org/abs/2509.25140), with CI pass/fail and reviewer corrections as sufficient signals (https://arxiv.org/abs/2607.22157). Without curation and deprecation, accumulated experience *degraded* performance below baseline (https://arxiv.org/abs/2606.17591).

## Markdown-based memory: mechanisms (Claude Code, verified)

| Mechanism | Loading behaviour | Facts |
|---|---|---|
| `CLAUDE.md` hierarchy | managed → `~/.claude/CLAUDE.md` → project `CLAUDE.md`/`.claude/CLAUDE.md` → `CLAUDE.local.md`; ancestors at launch, subdirectory files on demand; additive | Target < 200 lines per file; `@path` imports (4 hops); delivered as a user message after the system prompt, "context, not enforced configuration"; project CLAUDE.md re-injected after compaction. https://code.claude.com/docs/en/memory |
| `.claude/rules/*.md` | unconditional rules every session; rules with `paths:` glob frontmatter only when a matching file is read; symlinks allowed | CLAUDE.md = facts always needed; rules = path-scoped conventions; skills = procedures |
| Skills `SKILL.md` | only `name` + `description` preloaded (~1% of context); body on invocation; bundled files free until opened | frontmatter `paths`, `context: fork`, `agent`, `disable-model-invocation`; open standard used by ~40 clients. https://code.claude.com/docs/en/skills , https://agentskills.io/home |
| Auto-memory | `~/.claude/projects/<project>/memory/MEMORY.md` index (first 200 lines / 25 KB) + topic files; `type: user|feedback|project|reference` | machine-local, not git-tracked by default; relocatable via `autoMemoryDirectory`; subagents can have `memory: project` → `.claude/agent-memory/<name>/` (git-shareable). https://code.claude.com/docs/en/sub-agents |
| `AGENTS.md` | nearest file wins; plain markdown | Linux Foundation (Agentic AI Foundation) stewarded; > 60k OSS projects; read by Codex, Jules, Gemini CLI, Copilot agent, Cursor, Aider, Zed; Claude Code reads it via `@AGENTS.md` import or symlink. https://agents.md/ |
| Karpathy "LLM wiki" (2026-04) | `raw/` → `wiki/` (`index.md`, `log.md`, entities, concepts, sources) with operations ingest / query / lint | "compilation over retrieval"; hallucinations become embedded facts without provenance; works to ~100 sources before needing search. https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f |
| Obsidian-vault-as-memory | `Home.md`, `projects/`, `domains/`, `patterns/`, `sessions/`; session start reads ~2 files (~100 lines); follow wikilinks, never bulk-read | https://github.com/adamtylerlynch/obsidian-agent-memory-skills |

Pros: reviewable, provenance = git blame, zero infra, native to every agent, prompt-cache friendly, no lock-in. Cons: always-on files cost tokens every turn; adherence drops with length; no ranking beyond a few hundred pages; ungated write-back compounds hallucinations; contradictions across files are resolved arbitrarily.

## Graph memory (summary)

| System | Verdict |
|---|---|
| Graphiti / Zep | Needs Neo4j/FalkorDB (Kùzu backend deprecated); multiple LLM + embedding calls per episode; optimised for conversational user facts. Weak fit. https://github.com/getzep/graphiti |
| Cognee | Three storage subsystems; document "cognify" LLM-heavy; its deterministic code-graph pipeline lives in community repo. Document path poor; code-graph viable. https://github.com/topoteretes/cognee |
| GraphRAG / LazyGraphRAG / LightRAG | Heavy; plain RAG wins single-hop, graph wins multi-hop. Not justified for hundreds–thousands of short notes. https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/ |
| Code-structure graphs (RepoGraph, LocAgent, Codebase-Memory, Graphify) | Deterministic, rebuildable per commit, no LLM; SWE-bench gains; Codebase-Memory: one SQLite file, 10× lower token cost. **The one graph worth building.** https://arxiv.org/html/2603.27277v1 , https://github.com/safishamsi/graphify |

Wikilinks + frontmatter already form a graph; a `links` table regenerated from the vault gives traversal and lint without a graph engine.

## Vector memory and embeddings

- Mem0: extraction + update LLM calls per write; Qdrant/Postgres/Neo4j stack; its own guidance says use a proper RAG pipeline for engineering knowledge. Avoid; reuse its ADD/UPDATE/DELETE/NOOP reconciliation idea for consolidation. https://mem0.ai/blog/multi-agent-memory-systems
- Letta: copy the design (bounded labelled core blocks, background "sleep-time" consolidation landing as commits), not the server. https://docs.letta.com/guides/agents/memory
- Stores: **LanceDB** (embedded, native FTS + vector, RRF reranker, table versioning) best single choice; **sqlite-vec + FTS5** minimal alternative that can also hold links/frontmatter tables; Chroma has no local hybrid; Qdrant/pgvector only if a server already exists. https://docs.lancedb.com/search/hybrid-search , https://github.com/asg017/sqlite-vec
- Embeddings: Voyage 4 series (voyage-4-lite $0.02/M, voyage-4 $0.06/M, voyage-code-4 $0.12/M; **voyage-4-nano is Apache-2.0 open weights in the same space** → local-to-cloud path); OpenAI text-embedding-3-small $0.02/M; local Apache-2.0: Qwen3-Embedding-0.6B/4B/8B, EmbeddingGemma-300m, bge-m3, nomic-embed-text-v1.5. Jina open weights are non-commercial licensed — avoid. Re-embedding a 5M-token KB costs cents; licensing/offline/ops decide. https://docs.voyageai.com/docs/pricing , https://huggingface.co/Qwen/Qwen3-Embedding-0.6B
- Chunk on heading hierarchy; prefix chunks with `project / path / H1 > H2` (deterministic "contextual" prefix); Cursor measured +12.5% answer accuracy adding semantic search to grep on ≥1k-file repos — "the combination leads to the best outcomes". https://cursor.com/blog/semsearch

## Code-aware retrieval

- Boris Cherny: early Claude Code used RAG + local vector DB; agentic search (glob/grep) worked better, simpler, no staleness/privacy issues. https://newsletter.pragmaticengineer.com/p/building-claude-code-with-boris-cherny
- Consensus: agentic search default up to low-thousands of files; an index pays at ≥ ~1k files/monorepos or conceptual queries; every vendor with data exposes grep *and* a structured/semantic tool. Cheapest structure layer = symbol graph (tree-sitter/LSP), e.g. Aider RepoMap (PageRank over tags, 1–4k tokens, https://aider.chat/docs/repomap.html), Serena (LSP over MCP, https://github.com/oraios/serena), Claude Code code-intelligence plugins (https://code.claude.com/docs/en/large-codebases).

## Anthropic guidance to design around

- Context engineering: smallest set of high-signal tokens; just-in-time retrieval via identifiers; progressive disclosure; structured note-taking; subagents return 1–2k-token summaries. https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Long-running harnesses: initializer vs incremental agents, progress file, feature list, git commits as memory, session-start ritual, clean state. https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Memory tool `memory_20250818` (file ops under `/memories`), context editing `clear_tool_uses_20250919`, server-side compaction `compact_20260112` (default trigger 150k). https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool , https://platform.claude.com/docs/en/build-with-claude/compaction
- Prompt caching: writes 1.25×/2×, reads 0.1× (0.025× on Fable 5.1); static content first; breakpoint after system prompt survives compaction. https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Steering: "Procedures belong in skills. CLAUDE.md is for facts Claude should hold all the time"; `/doctor` trims derivable content; a `Stop` hook can propose CLAUDE.md updates. https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more

## How products close the loop

| Product | Pattern |
|---|---|
| Devin Knowledge | item = content + trigger description + pinned repos; auto-suggested, user approves. https://docs.devin.ai/product-guides/knowledge |
| GitHub Copilot memory (GA 2026-03) | `{subject, fact, citations, reason}`, validated just-in-time against current code, 28-day expiry, writes only by write-access contributors; A/B +7% PR merge rate. https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/ |
| Cursor | rules in git; memories need approval; promoted manually to rules. https://cursor.com/docs/rules |
| Augment | "Memory Review": pending memories approved/edited/discarded inline. https://www.augmentcode.com/blog/how-we-built-memory-review |
| Windsurf | memories "legacy — migrate to skills". |
| OpenHands | `.agents/skills/<name>/SKILL.md` with `triggers:` keywords and `paths:`. https://docs.openhands.dev/openhands/usage/microagents/microagents-overview |

Quality-control patterns to copy: human approval of proposals, PR-based changes, provenance + validate-on-read, expiry/`last_confirmed`, deprecate-don't-delete, promotion gates (verified by a passing check, names the failure it solves), delta edits + size budgets, trigger scoping (description for recall, globs for precision).

## Token-spend patterns

Progressive disclosure; index-first loading (≤ 200 lines); path/glob scoping; just-in-time retrieval; prompt caching with static prefix first; subagent isolation for verbose reads; deny-list reads of generated/vendored code; compaction with instructions; procedures out of CLAUDE.md into skills; compressed retrieval results (`file:line` + ≤ 2 lines); whole-KB-in-prompt when < ~200k tokens. Illustrative Claude Code startup: system prompt ≈ 4.2k, auto-memory index ≈ 0.7k, project CLAUDE.md ≈ 1.8k tokens. https://code.claude.com/docs/en/context-window

## Recommended design (adopted in product/05 with adjustments)

Git-tracked markdown is the only long-term store; every index (FTS/vector, symbol graph, repo map) is a commit-keyed rebuildable cache. Shape the KB the way Claude Code loads it (CLAUDE.md/AGENTS.md bridge, rules with `paths:`, skills). Tiered loading: always-on (≤ 200 lines) → triggered (paths/description-matched lessons, validated on read) → on demand (`kb_search`, wiki links, LSP) → never bulk. Lesson schema with `trigger`, `paths`, `scope`, `status`, `confidence`, `evidence`, `last_confirmed`, `expires`. Write-back: Reflector emits delta proposals → Curator dedups/validates/lints → PR to the KB → humans merge (low-risk classes auto-merge by policy) → nightly hygiene (re-verify expiring items, deprecate on repeated misses, consolidate, regenerate index, rebuild search). Keep 5–10 representative tasks per project as an eval set. Phase 1 needs no index; phase 2 adds hybrid search (LanceDB or sqlite-vec + FTS5, local Apache-2.0 embedder with a Voyage switch); phase 3 adds LSP/code embeddings per project when measured.

## Caveats
- Vendor benchmarks (Mem0, Zep, Milvus, Augment) are self-reported and contested; independent evidence for lessons-learned memory in coding agents is thin → keep per-project eval sets.
- Memory write-back is a prompt-injection surface (https://arxiv.org/html/2604.16548v1); the PR gate + write-access restriction is the mitigation (BD-018, BD-022).
- Obsidian's official help (fetched 2026-08-28) only says the config folder is dot-prefixed (`.obsidian`) and can be renamed to another dot-prefixed name; it makes no statement about dot-folders as vault roots or about ignoring other dot-folders. Both remain `[unverified]` and need a manual test → OPEN-QUESTIONS Q6.
