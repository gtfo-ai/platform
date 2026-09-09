# BD-002 — Open source, build in public, zero secrets in the repository

- **Status:** accepted
- **Date:** 2026-08-28
- **Deciders:** founder

## Context
The product will be developed publicly on GitHub. Credentials for Jira, GitLab, Slack, Sentry, Loki and Claude are needed to run it.

## Decision
The repository is public from day one. No secret, token, or customer data ever enters the repository, including in docs, tests, fixtures or CI logs. `.env.example` (and `.env` defaults used only for local development with non-secret values) is the only place environment variables are listed. Secrets are provided at runtime via environment variables or mounted files.

## Rationale
Trust and adoption for a self-hosted tool depend on transparency; a single leaked token destroys it. Preventing leaks by rule is cheaper than by remediation.

## Alternatives considered
- Private until MVP — loses early community feedback; does not remove the need for the rule.

## Consequences
- CI must run secret scanning on every push; commit hooks locally (Round 2: tooling choice).
- Test fixtures use obviously fake values (`xoxb-FAKE-…`).
- The platform itself must redact secret-shaped strings from transcripts and KB commits (product/09).
- License: **Apache-2.0** (founder decision 2026-08-28, Q1). Bundled AGPL binaries (e.g. `logcli`) are executed, never linked; the notice file lists third-party licenses.
