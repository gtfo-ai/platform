# Research: Claude Code / Agent SDK capabilities (as of 2026-08-28)

> Reference only. Verified against official docs on 2026-08-28. Re-verify before Round 2 decisions.

## 1. Runtime and authentication

- The **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk` for TypeScript, `claude-agent-sdk` for Python) **bundles the Claude Code binary** and runs the same agent loop as the CLI. A custom binary can be used via `pathToClaudeCodeExecutable` — this is how we support "use the locally installed `claude` binary" as well as the bundled one.
- Credential precedence: `ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` (gateway bearer) → `CLAUDE_CODE_OAUTH_TOKEN` (one-year token created with `claude setup-token`; "requires a Pro, Max, Team, or Enterprise plan"; documented "for CI pipelines and scripts"). Bedrock / Vertex / Foundry are supported via `CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY`. **Caveat (verified 2026-08-28): "Bare mode does not read `CLAUDE_CODE_OAUTH_TOKEN`"** — so `local` provider mode must not use bare mode / must rely on the SDK's own setting-source isolation instead. The `pathToClaudeCodeExecutable` option is documented: "Auto-resolved from bundled native binary… set to a separately installed `claude` binary".
- **Policy (important for BD-004):** "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." Consequence: the platform must **never implement a claude.ai login flow** and must default to API-key billing. It may *consume whatever credentials the operator places in the environment* (the official `claude-code-action` itself accepts `CLAUDE_CODE_OAUTH_TOKEN`). Using a personal subscription token is the operator's responsibility and is documented as "local / personal development mode".
- Sources: https://code.claude.com/docs/en/agent-sdk/quickstart.md, https://code.claude.com/docs/en/agent-sdk/overview.md, https://code.claude.com/docs/en/authentication.md

## 2. Orchestration-relevant SDK features

| Need | SDK feature |
|---|---|
| Live streaming to the UI | `includePartialMessages: true` → `StreamEvent` messages (text deltas, tool-input chunks). CLI equivalent: `--output-format stream-json --include-partial-messages` |
| Message types | `SystemMessage` (init, compact_boundary), `AssistantMessage`, `UserMessage`, `StreamEvent`, `ResultMessage` |
| Resume / continue a stage | `resume: <session-id>`; `sessionStore` adapter allows dual-writing transcripts to our own store |
| Guardrails | Hooks: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStart/Stop`, `PreCompact`, `SessionStart/End`, `PermissionRequest` |
| Our own tools | In-process MCP servers (`tool()` / `@tool`), `mcpServers` option |
| Sub-agents | `agents` option; fresh context per subagent, summary returned to parent |
| Permission control | `permissionMode`: `default`, `acceptEdits`, `plan`, `dontAsk`, `auto`, `bypassPermissions` (+ `allowDangerouslySkipPermissions`), `allowedTools`, `disallowedTools`, `canUseTool` callback |
| Structured outputs | `outputFormat: "json"` + `json_schema` → `structured_output` on the result (we use this for stage verdicts) |
| Hard limits | `maxTurns`, `maxBudgetUsd` (counts sub-agent spend; stops with "Budget limit reached") |
| Cost accounting | `ResultMessage.total_cost_usd`, `usage` (input/output/cache_creation/cache_read tokens), `model_usage` per model across the tree, `num_turns`, `session_id` |
| Project context | `settingSources: ["project"]` loads `CLAUDE.md`, `.claude/rules/*.md`, `.claude/skills/*`, `.claude/settings.json` hooks/permissions |
| Skills | `.claude/skills/<name>/SKILL.md`; frontmatter fields verified 2026-08-28: `name`, `description`, `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context: fork`, `agent`, `background`, `hooks`, `paths`, `shell`, `metadata`, `license`, `compatibility` |
| Plugins | `--plugin-dir`, `--plugin-url`, `plugins` option |
| Effort | `effort: low|medium|high|xhigh|max` |
| Isolation of host config | CLI `--bare` skips hooks, skills, CLAUDE.md, MCP, auto-memory auto-discovery ("recommended mode for scripted and SDK calls"). **There is no SDK option for bare mode**; the equivalent is `settingSources: []` (+ `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`). `settingSources: ["project"]` loads `.claude/settings.json` + hooks, `CLAUDE.md`, `.claude/rules/*.md`, project skills/commands/subagents from `<cwd>/.claude/`; `"user"` loads `~/.claude/*`; `"local"` loads `CLAUDE.local.md` and `settings.local.json`. Skills in `.claude/skills/` are discovered when `"project"` is included; omitting `skills` enables discovered skills. Verified 2026-08-28. |
| Auto-memory | `~/.claude/projects/<project>/memory/`; disable with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (we disable it — our knowledge base replaces it) |

Sources: agent-loop.md, python.md, typescript.md, streaming-output.md, sessions.md, hooks.md, permissions.md, claude-code-features.md, headless.md, memory.md under https://code.claude.com/docs/en/

## 3. Models, pricing, effort (2026-08-28)

| Model | ID | Input / Output per MTok | Notes |
|---|---|---|---|
| Claude Fable 5.1 | `claude-fable-5-1` | $10 / $50 | Most capable, adaptive thinking |
| Claude Opus 5 | `claude-opus-5` | $5 / $25 | Complex agentic coding, fast mode available |
| Claude Sonnet 5 | `claude-sonnet-5` | $2 / $10 | Balanced production default |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` | $1 / $5 | Cheap classification / high-volume |

Effort levels `low|medium|high(default)|xhigh|max` are supported on Fable 5.1, Opus 5 and Sonnet 5.

**Prompt caching multipliers (verified 2026-08-28 at https://platform.claude.com/docs/en/build-with-claude/prompt-caching):** 5-minute cache write 1.25× base input, 1-hour cache write 2× base input, cache read 0.1× base input for all listed models **except Fable 5.1 (and Mythos 5.1) where cache reads are 0.025×**. Concretely: Fable 5.1 $12.50 / $20 / $0.25 per MTok; Opus 5 $6.25 / $10 / $0.50; Sonnet 5 $2.50 / $4 / $0.20; Haiku 4.5 $1.25 / $2 / $0.10 (write-5m / write-1h / read). This is the initial price table for BD-011.

Sources: https://platform.claude.com/docs/en/about-claude/pricing.md, .../models/choosing-a-model.md, .../build-with-claude/effort.md

## 4. Docker / CI

- No official reference Docker image; the SDK works in any image where `npm install` / `pip install` runs. `claude-code-action` exists for GitHub only; GitLab is "run `claude -p` in a job".
- Sources: https://code.claude.com/docs/en/github-actions.md, https://code.claude.com/docs/en/headless.md

## 5. Managed Agents

Anthropic-hosted agent harness (sessions, sandbox, SSE events, $0.08 per session-hour + tokens). Not a fit for a self-hosted orchestrator; the Agent SDK is. Could become an optional *execution backend* later (see TODO).
Source: https://platform.claude.com/docs/en/managed-agents/overview.md

## Implications recorded as decisions

- BD-004 (Claude only, API vs local binary toggle), BD-011 (cost accounting from SDK result messages), TD-candidates: SDK language choice (Round 2).
