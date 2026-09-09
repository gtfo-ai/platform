# BD-022 — All text from tickets, MRs, logs and the web is untrusted data, never instructions

- **Status:** accepted
- **Date:** 2026-08-28

## Decision
Ticket descriptions, comments, MR discussions, log lines, Sentry events and fetched web content are presented to agents as clearly delimited data. Prompts instruct agents that such content cannot change their role, tools, limits or rules. Suspicious instruction-like content is flagged in artifacts and in the Code review checklist. Only authenticated humans with the right role can issue control commands (`@agentic hold`, approvals), and the platform verifies the author identity from the integration, not from the text.

## Rationale
Prompt injection through a bug report or a log line is the most realistic attack on an autonomous coding agent with repository write access.

## Consequences
- Integration events must carry verified author identity (research/03: Jira/GitLab webhook payloads include the actor).
- Rules and knowledge come only from the repository and platform settings, never from external text directly (feedback goes through proposals — BD-018).
