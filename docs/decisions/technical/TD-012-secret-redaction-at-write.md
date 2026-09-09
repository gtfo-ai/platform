# TD-012 — Secret redaction as a pure function in the single persistence path; gitleaks-derived rules plus exact-match of injected secrets

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/07, technical/03, BD-002, BD-003

## Decision
Before any write to `run_messages`, `integration_actions`, `events.payload`, `config_audit`, artifacts and KB commits: (1) replace every secret value the platform injected into the run/environment (`[REDACTED:integration:<name>]`), (2) apply a curated subset of gitleaks' rule set compiled for JS (generic API keys, private keys, cloud/provider tokens incl. Anthropic/OpenAI, JWTs, connection strings) with `[REDACTED sha256:<6>]` placeholders, (3) optional entropy heuristic in key-like contexts. Record `redaction_count` and `redaction_log`. Originals are never stored (append-only rows cannot be fixed later). The rule set has unit tests with fake secrets and a CI check that fixtures contain none.
