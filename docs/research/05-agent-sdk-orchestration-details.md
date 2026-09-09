# Research: Claude Agent SDK details for the orchestrator (2026-09)

> Verified against https://code.claude.com/docs/en/agent-sdk/typescript.md (fetched raw, 336 KB), session-storage.md, streaming-vs-single-mode.md, and a `claude-code-guide` report covering hooks.md, permissions.md, subagents.md, mcp.md, structured-outputs.md, python.md. One claim from the guide report ("TypeScript has no streaming input for mid-run messages") was **refuted** by the raw TypeScript reference; corrected below.

## 1. Streaming input, steering, interrupt (TypeScript) — VERIFIED
- `query({ prompt: string | AsyncIterable<SDKUserMessage>, options })` — an async iterable prompt puts the session in **streaming input mode**: "a long lived process that takes in user input, handles interruptions, surfaces permission requests"; queued messages "process sequentially, with ability to interrupt".
- The returned `Query` (extends `AsyncGenerator<SDKMessage>`) exposes, in streaming input mode only: `interrupt()` (resolves with an `SDKControlInterruptResponse` receipt listing `still_queued` messages on CLI ≥ 2.1.205), `streamInput(stream)`, `setPermissionMode(mode)`, `setModel(model)`, `applyFlagSettings(settings)` ("tightening `permissions` after the agent reads untrusted input"). Assistant messages truncated by an interrupt carry `aborted: true` (SDK ≥ 0.3.214).
- **Implication:** the *steer* feature (product/18) = push an `SDKUserMessage` into the run's input stream; *pause/cancel* = `interrupt()`; per-stage permission tightening = `applyFlagSettings`/`setPermissionMode` mid-run. Python has the same via `ClaudeSDKClient.query()`/`receive_response()`/`interrupt()`.
- Feature detection: `SDKSystemMessage.capabilities` (e.g. `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`) — "ignore values you don't recognize".

## 2. Session persistence — VERIFIED
- `sessionStore` option: interface with required `append(key, entries)` and `load(key)`; optional `listSessions`, `listSessionSummaries`, `delete` (must cascade to subkeys), `listSubkeys`. `sessionStoreFlush: 'batched' | 'eager'` (alpha), `loadTimeoutMs` (default 60 000). Resume from the store materialises into a temp config dir; the store holds the durable copy. `forkSession(sessionId, { sessionStore })` copies history to a new session.
- `projectKey` encodes the working directory; set `CLAUDE_CODE_PROJECT_DIR_NAME` (SDK ≥ 0.3.234) with `CLAUDE_CONFIG_DIR` in `env` to key sessions by a stable name instead of the workspace path — required for our per-task workspaces.
- Local files: `$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<session-id>.jsonl`; subagent transcripts under `subagents/agent-<id>`.

## 3. Hooks — VERIFIED (guide report + reference)
- TypeScript hook events (superset): `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `UserPromptSubmit`, `UserPromptExpansion`, `MessageDisplay`, `Stop`, `StopFailure`, `SubagentStart/Stop`, `PreCompact`, `PostCompact`, `PermissionRequest`, `PreModelSwitch/PostModelSwitch`, `SessionStart/End`, `Notification`, `Setup`, `TaskCreated/Completed`, `Elicitation/ElicitationResult`, `ConfigChange`, `InstructionsLoaded`, `WorktreeCreate/Remove`, `CwdChanged`, `FileChanged`, `DirectoryAdded`. Python covers the essentials (Pre/PostToolUse, UserPromptSubmit, Stop, Subagent*, PreCompact, PermissionRequest, Notification) without the TS-only ones.
- `PreToolUse` output: `permissionDecision: allow|deny|ask|defer`, `permissionDecisionReason`, `updatedInput` (rewrite tool input). `PostToolUse`: `additionalContext`, `updatedToolOutput`. `Stop` can return `continue: true`.

## 4. Permissions — VERIFIED
Evaluation order: hooks → deny rules (`disallowedTools`, settings) → ask rules → permission mode → allow rules (`allowedTools`) → `canUseTool(tool, input, context)`. Pattern syntax: `Bash(glab *)`, `Edit(/secrets/**)`, `mcp__server__*`; bare-name deny removes the tool from context. `permissionPrompts: 'none'` (≥ 2.1.259) skips `canUseTool`. Three-list command policy (BD-025) maps to: block → `disallowedTools` patterns; allow → `allowedTools`; ask → everything else lands in `canUseTool`, which we answer by raising a platform Question and returning deny/allow when answered (or deny with reason if unattended).

## 5. Subagents — VERIFIED
`agents: { name: { description, prompt, tools?, disallowedTools?, model?, skills?, memory?, mcpServers?, maxTurns?, background?, effort?, permissionMode? } }`. Subagent messages carry `parent_tool_use_id`; only the final result returns to the parent context. Env knobs: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default 3), `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20), `CLAUDE_CODE_DISABLE_BUILTIN_AGENTS`.

## 6. Structured outputs — VERIFIED
`outputFormat: { type: 'json_schema', schema }` → `structured_output` on the result; on repeated validation failure the result subtype is `error_max_structured_output_retries` and `terminal_reason: "structured_output_retry_exhausted"`. Zod → JSON Schema via `z.toJSONSchema(schema, { target: 'draft-7' })`.

## 7. Cost and usage — VERIFIED
Result message: `total_cost_usd`, `usage { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }` (main loop), `modelUsage` (per model, whole tree incl. subagents, compaction; **cumulative across turns in streaming-input sessions** — read the latest result), `num_turns`, `terminal_reason` (`completed | max_turns | budget_exhausted | structured_output_retry_exhausted | api_error | …`). No per-message usage during streaming → live cost in the UI is *estimated* from streamed text length until the result arrives (BD-011 already labels estimates).

## 8. Budget — VERIFIED
`maxBudgetUsd` counts subagents; exceeded → result subtype `error_max_budget_usd`, partial work stays on disk and in the session store; can resume with a higher budget.

## 9. Runtime options (TS) — VERIFIED
`cwd`, `settingSources`, `additionalDirectories`, `env` (**replaces** the subprocess environment — spread `process.env` to keep `PATH`; Python merges), `executable: 'bun'|'deno'|'node'`, `executableArgs`, `extraArgs: Record<string, string|null>`, `pathToClaudeCodeExecutable`, `stderr` callback, `persistSession`, `resume`, `continue`, `forkSession`, `includePartialMessages`, `maxTurns`, `maxBudgetUsd`, `model`, `effort`, `thinking`, `systemPrompt` (string or `{ type: 'preset', preset: 'claude_code', append }`), `skills`, `mcpServers` (in-process via `createSdkMcpServer` + `tool()`, or stdio/http), `hooks`, `canUseTool`, `permissionMode`, `permissionPrompts`. Stall handling: API timeout/stall env vars documented under "Handle slow or stalled API responses" (pass via `env`).

## 10. Docker / packaging — VERIFIED
- The SDK bundles a platform binary as an optional dependency (`@anthropic-ai/claude-agent-sdk-linux-x64`, `-linux-x64-musl`, …); SDK version tracks the bundled Claude Code version (e.g. SDK 0.3.191 ↔ CLI 2.1.191). Package managers that ignore npm's `libc` field install both glibc and musl variants — delete the unused one in the image. Cross-compile by force-installing the target platform package.
- Env vars for headless runners: `DISABLE_TELEMETRY=1`, `DISABLE_AUTOUPDATER=1`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `DO_NOT_TRACK=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PROJECT_DIR_NAME`.
- Node version requirement not stated in the reference `[unverified]`; assume current LTS.

## 11. Worktrees and compaction — VERIFIED
- No SDK `worktree` option; only `WorktreeCreate/Remove` hook events and `includeWorktrees` in session listing. Our workspace manager creates the checkout itself and passes `cwd`.
- Compaction: no SDK switch; `PreCompact`/`PostCompact` hooks; boundary message `{ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual'|'auto', pre_tokens } }`; guidance via CLAUDE.md; manual `/compact` as a prompt.

## Decision-relevant summary
TypeScript SDK ≥ Python SDK in orchestration surface (hooks, runtime setters, capability detection, `env` control). Steering, interrupt, permission tightening, session store, structured verdicts, budgets and cost fields are all available and documented. This removes the last SDK-side reason to prefer Python; see TD-001.
