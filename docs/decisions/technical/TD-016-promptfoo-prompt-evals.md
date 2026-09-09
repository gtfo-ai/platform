# TD-016 — Prompt evals with promptfoo (Claude Agent SDK provider) and in-repo eval cases with schema and field assertions

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/09, product/13, BD-013

## Decision
`prompts/<role>/{prompt.md, schema.json, evals/cases.yaml, evals/baseline.json}`; promptfoo (MIT) with the `anthropic:claude-agent-sdk` provider (`working_dir` = fixture repo, `setting_sources: ['project']`, `max_budget_usd`, `output_format` = schema); hard assertions `is-json` (schema) and `javascript` field checks, `llm-rubric` (Haiku) only for prose quality at low weight; PR job on `prompts/**` changes (same-repo PRs, `llm-ci` environment, `EVAL_MAX_USD`), nightly baseline; fail on any previously passing hard case failing or pass rate dropping > 5 pp. Local-session mode of the provider is never used in CI (BD-004). Prompt version = hash(prompt + schema) recorded per run.
