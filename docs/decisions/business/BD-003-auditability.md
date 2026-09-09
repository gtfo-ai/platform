# BD-003 — Everything is auditable and replayable

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** product/09

## Context
Autonomous agents change code, comment on tickets, message people and spend money. Teams must be able to answer "which prompt, model and settings produced this, and who approved what" after the fact.

## Decision
Every run stores its exact prompts, model, effort, settings snapshot, context pack, full transcript, tool calls, tokens and cost. Every task stores every transition, artifact version, question/answer and human action. Every configuration change stores who/when/diff. Every outbound integration action stores payload and result. Records are append-only.

## Rationale
Debuggability, trust, compliance, and the retrospective stage all depend on it. Storing is cheap compared to the tokens spent producing it.

## Alternatives considered
- Summaries only — insufficient to debug a bad MR or a prompt regression.

## Consequences
- Storage grows; retention is configurable per organisation and **defaults to keeping everything forever** (founder decision 2026-08-28, Q13); operators may set a purge window for raw transcripts, metadata is always kept.
- Transcripts may contain sensitive content → project-level access control.
- Redaction of secret patterns before storage.
