# TD-015 — Test strategy tooling: Vitest 5 projects, PGlite + Testcontainers, nock replay, fast-check, fake Claude runner, weekly Stryker

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/09, technical/10, BD-017

## Decision
As specified in technical/10: Vitest 5 with projects; PGlite for repository tests and Testcontainers Postgres 18 for migrations/extensions/locking; contract suites per integration type against fakes and recorded (nock 14, native fetch) provider fixtures; fast-check model-based tests for state machines/budgets/redaction; a `ClaudeRunner` port with `FakeClaudeRunner` fixtures for all business logic and a fake `spawnClaudeCodeProcess` for the SDK adapter; nightly real-LLM smoke under a dedicated Console workspace spend limit and a GitHub `llm-ci` environment; Stryker weekly on the domain; coverage thresholds domain 90/85, overall 80.
