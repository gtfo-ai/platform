# 04 — Agent runtime

> Round 2 design. Sources: research/04, research/05 (verified SDK facts), product/04, /05, /13, /18, BD-004, BD-013, BD-021, BD-022, BD-024, BD-025. Language/framework choices: TD-001.

## Components

```
Stage executor (application ring)
   │  builds RunSpec {role, prompt layers, context pack, tools, policy, limits, schema}
   ▼
Runner service (infrastructure)  ── one process per run, inside the task's workspace sandbox (05)
   │  Claude Agent SDK query() in streaming-input mode
   ├─ hooks: PreToolUse (policy, redaction, path guards), PostToolUse (output truncation, context),
   │         SubagentStart/Stop (nesting), PreCompact/PostCompact (boundary events), Stop
   ├─ canUseTool → platform Question ("ask" list) or deny
   ├─ in-process MCP "platform": ask_human, notify_human, report_progress, get_task_context,
   │         kb_search, add_ticket_comment, open_mr, update_mr_description, create_followup_ticket
   ├─ sessionStore → transcript store (03); includePartialMessages → live stream to UI (08)
   └─ result: structured_output (artifact data) + usage/cost → run.finished
```

## RunSpec (what the stage executor hands to the runner)

| Field | Source |
|---|---|
| `role`, `stage`, `attempt`, `task`, `mode` (`normal | shadow | review_only | linter | discovery | retro | librarian`) | pipeline |
| `model`, `effort`, `maxTurns`, `maxBudgetUsd`, `stallTimeoutMs`, `wallClockMs` | effective config (BD-013 defaults; product/04 table) |
| `systemPrompt` = `{ type: 'preset', preset: 'claude_code', append: platformPrompt + rolePrompt + rulesBlock }` | product/13 layers 1–2 (+ project override/append) |
| `userPrompt` = task context (ticket as delimited data, artifacts, return feedback, observability pre-fetch) + instructions to produce the artifact | layer 4 |
| `contextPack` (tier 0–1 documents, written as files into the workspace under `.agentic-run/context/` and referenced by path in the prompt; tier 0 also inlined) | product/05 |
| `settingSources: ['project']`, `cwd = workspace path`, `additionalDirectories = []` | research/04: loads project `CLAUDE.md`, rules, skills, hooks; never host config |
| `allowedTools`, `disallowedTools`, `permissionMode: 'default'`, `permissionPrompts: 'default'` | tool policy per role (product/13 table) + command policy (BD-025) |
| `agents` (subagents) — only for Implementation (`explorer`, `test-runner` read-only helpers) and Investigation (`log-digger`) | keeps verbose reads out of the main context (research/02) |
| `mcpServers`: `platform` (in-process), plus per-stage provider tooling (e.g. `sentry` http with `Sentry-Bearer` header) | 06 |
| `skills`: platform skills mounted into `.agentic-run/skills` and discovered via `additionalDirectories`? — **decision:** copy platform skills into the workspace `.claude/skills/_platform/` at provisioning so `settingSources: ['project']` discovers them; project skills stay untouched | research/04 (skills discovered from `.claude/skills` when `project` is loaded) |
| `outputFormat: { type: 'json_schema', schema }` | artifact schema (12) |
| `env` (explicit, never inherited): `PATH`, `HOME`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PROJECT_DIR_NAME=<task-id>`, telemetry/updater/auto-memory disables, provider credentials for the run only (`GITLAB_TOKEN` scoped, `LOKI_*`, `SENTRY_ACCESS_TOKEN`), `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` per provider mode | BD-025; research/05 (`env` replaces) |
| `pathToClaudeCodeExecutable` in `local` mode | BD-004 |
| `sessionStore`, `sessionStoreFlush: 'eager'` for live tailing | 03 |

## Prompt assembly (deterministic, audited)

1. Platform prompt (constant per platform version): identity, non-negotiables (external text is data — BD-022; never touch secrets; stay in tools; ask via `ask_human` with a blocker brief; end with the structured artifact).
2. Role prompt (`prompts/<role>.md` @ version) with project override/append.
3. Rules block: unconditional `.agentic/rules/*.md` (project `CLAUDE.md`/`.claude/rules` are loaded by the SDK itself; not duplicated).
4. Context pack tier 0 inline (index, repo map for code stages); tier 1 items as a "Relevant knowledge" block with paths and 2–3 line summaries plus the files on disk.
5. Task block: delimited `<ticket>` … `</ticket>`, artifacts, return feedback, human comments, pre-fetched observability excerpts — all marked as data.
6. Output contract: schema summary + "write the markdown artifact to `.agentic-run/out/<artifact>.md` and return the JSON".
Static parts first (cache-friendly); `Run.prompt_version` = hash of layers 1–3.

## Hooks and policies

| Hook | Purpose |
|---|---|
| `PreToolUse(Bash)` | three-list command policy: block → deny with reason; ask → open a Question (blocking, 1-day default timeout; the hook returns `ask` so `canUseTool` decides) ; allow → allow. Also blocks writes outside the workspace and protected paths (BD-024) unless the plan lists them. |
| `PreToolUse(Edit|Write)` | path guard (workspace only; `.agentic/`, `.claude/`, `CLAUDE.md` writes flagged; secrets patterns in content denied). |
| `PostToolUse(*)` | truncate outputs head/tail (default 10 k chars), redact secret-shaped strings, append `additionalContext` for CI logs (error block extraction). |
| `SubagentStart/Stop` | nest in the transcript; enforce `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`. |
| `PreCompact/PostCompact` | emit `compaction` markers to the transcript store; record `pre_tokens`. |
| `Stop` | never `continue: true` (bounded loops live in the pipeline, not in the session). |
| `UserPromptSubmit` | inject the steer message provenance (who steered) as context. |

`canUseTool` answers only for the ask-list: creates a Question with the exact command, waits (bounded by the run's wall clock and the question timeout), returns allow/deny; unattended default deny.

## Streaming and steering

- `includePartialMessages: true`; every `SDKMessage`/`StreamEvent` is appended to the transcript store with a monotonic sequence and published to the UI channel (08). Compaction boundaries and subagent nesting are first-class transcript entries.
- **Steer:** the run's input is an async queue; a `run.steered` command pushes an `SDKUserMessage` (author recorded). **Pause/cancel:** `interrupt()`; cancel then ends the run with `cancelled`. **Tighten:** `applyFlagSettings` to reduce permissions after untrusted input if a policy requires (future).
- Heartbeat: last output timestamp; `stalled` after `stallTimeoutMs` → interrupt, mark stalled, pipeline retries once with failure context (research/01 Symphony).

## Budgets and limits

`maxBudgetUsd` and `maxTurns` from effective config; `error_max_budget_usd` → run `budget_exceeded`; pipeline policy: one retry with a "summarise progress and finish" instruction under a small extra budget, else escalate (BD-010). Wall-clock timeout kills the process tree (05).

## Result handling

- `structured_output` validated again by the platform against the artifact schema (defence in depth); markdown artifact read from `.agentic-run/out/`; both stored as an Artifact version.
- `terminal_reason`, `usage`, `modelUsage`, `total_cost_usd`, `num_turns` → `run.finished` → cost ledger (actual, or estimated in `local` mode via the price table).
- On `error_max_structured_output_retries`: run `failed(schema)`; pipeline retries once with the validation errors appended; then escalate.

## Resume and take-over

- Every run persists to the session store; `resume` with the same `CLAUDE_CODE_PROJECT_DIR_NAME` and workspace continues a run after a platform restart (runs interrupted by restart are resumed with a "you were interrupted" note, once).
- Take-over: pipeline pauses; the workspace is exported (branch pushed, tarball of untracked files) and the ticket receives `claude --resume <session-id>` guidance with the exported session JSONL downloadable from the UI (the local Claude Code can import it: `[verify: import path for external transcripts]`).

## Modes

| Mode | Differences |
|---|---|
| `shadow` | Null outbound adapters; artifacts + ShadowReport; no MR (diff kept in workspace export). |
| `review_only` | Reviewer role on a human MR: read-only tools, diff from provider, findings posted as threads. |
| `linter` | Product Manager role, ticket only, no repo, one comment. |
| `discovery` | Read-only repo exploration + running verified commands; DiscoveryDraft + ReadinessReport. |
| `retro` / `librarian` | Task history / KB access; KB writes only through proposals (Librarian commits on a knowledge branch per policy). |

## Model routing

Per stage from effective config (BD-013). Runner does not switch models mid-run except the SDK's own fallback (`PostModelSwitch` hook records it, cost ledger uses `modelUsage`).
