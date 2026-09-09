# TD-024 — Integration clients: handwritten thin clients on native fetch + ky; official Slack Bolt; handwritten webhook verification

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/11, research/03, technical/06, BD-017

## Decision
GitLab, Jira (Cloud now, Data Center later), Sentry and Loki get small typed clients written in-repo on `fetch` + `ky` (retries on 408/413/429/5xx honouring `Retry-After`, per-attempt and total timeouts), covering only the endpoints the type contracts need (~20 per provider); Jira types generated with `openapi-typescript` from Atlassian's Swagger; markdown→ADF via `marklassian`. Slack uses the official `@slack/bolt` (Socket Mode) with `@slack/web-api`. GitHub later via `octokit`. Webhook signatures verified in-house with `timingSafeEqual` (GitLab legacy token and Standard Webhooks, Jira `X-Hub-Signature`, Sentry `Sentry-Hook-Signature`, GitHub `X-Hub-Signature-256`).

## Rationale
No official JS clients for GitLab/Sentry/Loki; gitbeaker is stale and lacks thread resolution; jira.js is Cloud-only and heavy; thin clients keep the image small, support self-managed/DC, and are fully covered by contract tests with recorded fixtures.
