# TD-019 — Release: release-please + conventional commits, forward-only migrations via a one-shot service, `.agentic` schema versioning

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/09, technical/11, BD-018

## Decision
release-please v5 maintains a release PR (human merges) and tags `vX.Y.Z`; commitlint enforced; image tags `X.Y.Z`, `X.Y`, `X`, `sha-<7>`, `edge`, never `latest` in docs; migrations forward-only, executed by the `migrate` Compose service under an advisory lock; app refuses to start if the DB schema is newer; `.agentic` files carry `version`, JSON Schemas published and served; N-1 upcast in memory with a migration proposal instead of rewriting the user's repository.
