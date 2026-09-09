# BD-021 — Each task runs in an isolated, disposable workspace with least-privilege tools

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** product/09 safety rails

## Decision
Every task gets its own checkout/branch in an isolated workspace that is destroyed after completion (retained N days for debugging). Stages receive only the tools they need: read-only stages cannot write files or call mutating integration actions; Implementation can write files, run project commands, commit/push to `agentic/*` branches and update its own MR. Secrets never enter the agent context; tools are pre-authenticated by the platform. Destructive git operations and pushes outside `agentic/*` are blocked. Outbound network from workspaces is allow-listed per project.

## Rationale
Parallel tasks must not interfere; prompt injection and mistakes must have a small blast radius.

## Consequences
- Round 2: container-per-run vs worktrees on a shared runner; network policy mechanism.
