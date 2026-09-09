# TD-020 — Configuration: env vars with `APP_` prefix for platform settings, tool-native names for integration credentials, `<NAME>_FILE` variants, zod-validated at boot

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** technical/12, BD-014, BD-020

## Decision
Platform settings use the neutral prefix `APP_` (rename-friendly, BD-014); standard 12-factor names stay unprefixed (`PORT`, `DATABASE_URL`, `LOG_LEVEL`, `TZ`); integration credentials keep the names the bundled CLIs read (`GITLAB_TOKEN`, `GITLAB_HOST`, `JIRA_API_TOKEN`, `LOKI_ADDR`, `SENTRY_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) so run environments need no re-mapping; every secret accepts a `_FILE` variant. All configuration is parsed and validated with zod at boot (fail fast, print the offending key, never the value). `.agentic/config.yml` and `pipeline.yml` are validated against published JSON Schemas; unknown keys are errors.
