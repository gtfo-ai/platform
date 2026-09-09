# BD-025 — Agent configuration is trusted only from the default branch; three-list command policy; no tokens in agent context

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** BD-021, BD-022, research/01 (claude-code-action security, Factory command lists, Symphony credential isolation, GitLab Duo composite identity)

## Decision
1. `.agentic/`, `CLAUDE.md`, `.claude/` and `.mcp.json` used by a run are read from the project's **default branch**, never from the task branch or an MR branch (an MR could otherwise change the rules that govern its own review). Changes to these files by a task are flagged in Code review.
2. Shell commands available to agents follow a **three-list policy**: allow-list (runs), ask-list (requires a human approval via question), block-list (never; resolved against the real binary, not the name). Defaults ship per stage; the organisation sets the maximum autonomy; projects can only narrow it.
3. Integration credentials never enter the agent's environment except narrowly scoped, run-lifetime tokens for git push to `agentic/*` and read-mostly CLI access; all mutating integration actions go through platform tools.
4. Actions in external systems are attributed to the bot identity **and** record the triggering human (composite identity) in the audit and in MR/ticket text ("Requested by").

## Consequences
- Round 2: implementation of the command policy (hooks/permission callbacks), token minting, config snapshotting from the default branch.
