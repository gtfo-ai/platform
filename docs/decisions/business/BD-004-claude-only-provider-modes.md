# BD-004 — Claude only; provider modes `api` and `local`; no claude.ai login in the product

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/04, product/09

## Context
The brief: focus on Claude Code (Anthropic) only; always use the Claude Agent SDK; support both API billing and, for local use, the locally available Claude Code binary with the operator's subscription. Verified facts (research/04): the Agent SDK bundles the Claude Code binary and accepts a custom binary path; credentials are read from the environment (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, Bedrock/Vertex/Foundry flags); Anthropic's policy states third-party developers may not *offer claude.ai login or rate limits* in their products, including Agent SDK based agents, without approval.

## Decision
1. The platform integrates with Claude exclusively through the Claude Agent SDK. The domain model has a `provider` concept so another model provider could be added later, but only Claude is implemented.
2. A global setting `provider mode` selects `api` (default; bundled binary, API key or cloud-provider credentials, provider-reported cost) or `local` (path to a Claude Code binary supplied by the operator; credentials are whatever the operator's environment provides; cost is estimated from the price table and labelled as such).
3. The platform never implements or embeds a claude.ai login/OAuth flow and never ships or stores subscription tokens on the user's behalf. `local` mode is a **first-class deployment option in Docker** (founder decision 2026-08-28, Q14): a documented compose profile mounts the operator's Claude Code binary and credentials into the runner. Documentation states that using subscription credentials in automation is the operator's responsibility under Anthropic's terms.

## Rationale
Meets the brief while staying inside published policy. Keeping the SDK as the single integration point gives streaming, hooks, budgets, structured output and cost reporting for free.

## Alternatives considered
- Direct Messages API with our own agent loop — more control, far more work, loses Claude Code features (skills, CLAUDE.md, MCP, compaction).
- Shelling out to `claude -p` without the SDK — loses typed events and hooks; the SDK already wraps the same binary.

## Consequences
- Docker image contains the SDK's bundled binary; a `local` compose profile mounts binary + credentials and must be tested for token expiry (Round 2).
- Budget enforcement in `local` mode relies on estimated cost.
- Verified 2026-08-28: `pathToClaudeCodeExecutable` is documented for a separately installed binary; `CLAUDE_CODE_OAUTH_TOKEN` is a one-year token documented for CI/scripts; **bare mode does not read the OAuth token**, so `local` mode must isolate host config via `settingSources` rather than `--bare` (research/04). Still to verify in Round 2: behaviour inside containers and refresh at expiry.
