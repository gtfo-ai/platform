# TD-001 — Backend language and runtime: TypeScript on Node 24 LTS (Bun-clean code, no Bun host runtime yet)

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/05, research/11, BD-004, BD-015

## Context
The founder left the choice to research. The decisive factor is Claude Agent SDK parity: the TypeScript SDK exposes 33 in-process hook events vs 10 in Python (TS-only: `SessionStart/End`, `PostCompact`, `StopFailure`, `PreModelSwitch`, `InstructionsLoaded`, …), `canUseTool` works headlessly with `permissionPrompts: 'none'`, streaming-input errors surface instead of stalling, `startup()` pre-warming exists, and reference session-store adapters ship with it. One language for backend, runner and UI gives one toolchain, one CI matrix and shared contracts (zod → JSON Schema draft-07 for structured outputs). Bun as the long-running host is premature (1.4.x regressions, SDK fast-mode issue open).

## Decision
TypeScript (strict) on **Node 24 LTS** (move to Node 26 LTS after 2026-10-28), pnpm workspaces monorepo, ESM. Code kept Bun-clean (no Node-only native addons except prebuilt napi) so a host-runtime switch is a Dockerfile change. Python is not used in the product.

## Alternatives considered
Python 3.13 + `claude-agent-sdk` (MIT licence, richer Jira/GitLab client ecosystem — moot with thin clients); PHP/Symfony + TS sidecar (two services from day one).

## Consequences
- The TS SDK is under Anthropic's Commercial Terms (consumed, not redistributed) — noted in README/THIRD_PARTY_NOTICES.
- `env` option replaces the subprocess environment: always spread explicitly (technical/04).
