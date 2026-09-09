# BD-017 — Integrations are pluggable by type with a contract; adding one never changes the core

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** product/08, research/03

## Decision
Integrations are grouped in **types** (Task management, Git provider, Communication, Observability–logs, Observability–errors). Each type defines a contract: configuration schema, capabilities, events it must emit, actions it must implement, and the agent tooling it exposes. A provider (Jira, GitLab, Slack, Loki, Sentry) implements a type. The pipeline, UI and knowledge base depend only on types. A new provider is one module plus registration.

## Rationale
The brief demands new integrations without architecture drift; event-driven handlers per type are the mechanism.

## Consequences
- Contract tests per type run in CI against fakes; provider tests run against recorded fixtures.
- Type contracts must be designed for the second provider (GitHub, Linear) from the start, even if unimplemented.
