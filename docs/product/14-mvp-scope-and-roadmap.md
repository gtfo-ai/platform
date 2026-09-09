# 14 — MVP scope and roadmap

Startup rule applied: the MVP must deliver the **whole loop** (ticket → merged MR → learned) for one real project, not half of every feature. Breadth (providers, templates, UI polish) comes after the loop works on the founder's own projects (dogfooding).

## MVP (v0.1) — "one project, the whole loop"

**In**
- Single organisation, local auth (admin + members), Docker Compose deployment, 12-factor.
- Provider mode `api` and `local`, both first-class in Docker Compose (BD-004, Q14).
- Integrations: Jira Cloud (label pick-up + status mapping + workpad comment + questions + poll fallback + webhook), GitLab on **gitlab.com and self-managed** (bot MR, draft→ready, discussions, pipeline events, merge event), Slack (Socket Mode notifications + question buttons + thread answers). Sentry and Loki as **agent tooling + bug pre-fetch** only (no webhooks, no task creation).
- Pipeline templates `feature` and `bug` and `chore` with all stages in product/04; plan approval policy; bounded loops; human MR comment loop; Retrospective + Librarian with `proposal` policy (KB MR).
- Repository readiness levels with attribution in retrospectives (product/17).
- Knowledge base phase 1: `.agentic/` layout, index, rules, lessons schema, full-text search, context packs with audit, onboarding wizard steps 1–5 with Discovery agent and business interview.
- Cost: per run/stage/task/project/day; budgets org/project/task/run with pause-not-kill; price table.
- Audit: full run records with transcripts; task timeline; config audit.
- UI: dashboard, board, task detail, run detail with live transcript, agents view, questions inbox, knowledge browser + proposals queue, pipeline settings (enable/disable, model/effort/prompt override, limits), integrations setup with test connection, budgets, statistics (tasks delivered, cost, LOC per day), audit log.
- Skills mounted into runs (product/13) and project skill reuse.
- GitHub Actions CI for the platform: unit + contract tests, secret scanning, image build.

**Out (explicitly)**
- `spike` template, custom stages editor UI (custom stages via `.agentic/pipeline.yml` only), GitHub provider, Jira Data Center, Sentry/Loki webhooks, hybrid vector search, LSP code intelligence, cross-project knowledge, SSO, auto-merge, mobile, prompt A/B, eval harness UI.

**MVP exit criteria**
- 20 real tickets across the 2 founder projects (both Jira Cloud; one gitlab.com, one self-managed GitLab) delivered end-to-end; ≥ 60% merged; cost per merged feature measured; ≥ 10 accepted KB proposals; zero secrets incidents; a stranger can install from the README in < 1 hour.

## v0.2 — "trust and knowledge"
Hybrid search + triggered lesson injection with validate-on-read; eval sets per project; KB health report and nightly hygiene; `spike` template; custom stage editor in UI; statistics deep-dive (return rates, intervention rate, question response time); Jira Data Center; prompt versions diff UI.

## v0.3 — "breadth"
GitHub provider; Sentry webhooks → tasks; Loki/Sentry-driven "Investigation only" pipeline (RCA without fix, for on-call); Confluence import; organisation shared knowledge; SSO (OIDC); per-project LSP code intelligence opt-in; auto-merge policy for `chore` when trust metrics allow.

## Later / ideas parking lot
- Managed Agents as an optional execution backend (research/04).
- Other LLM providers behind the provider abstraction.
- Multi-repo tasks (one ticket → MRs in several repos).
- Cost optimisation advisor (suggest model/effort per stage from history).
- Marketplace of pipeline templates and role prompts.
- Hosted offering (one instance per customer).
