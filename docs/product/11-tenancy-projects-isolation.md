# 11 — Tenancy, projects and isolation

Decision: [BD-009 one instance per tenant](../decisions/business/BD-009-single-tenant-instances.md).

## Model

```
Instance (deployment) = Organisation (exactly one)
  ├ Users & roles (admin, maintainer, member, viewer)
  ├ Global settings, budgets, integrations (credentials live here)
  └ Projects (many)
      ├ Repository (one git repo; monorepo sub-paths later)
      ├ Integration bindings (which Jira project/rule, which Slack channel, Sentry project, Loki labels)
      ├ Pipeline configuration, models, prompts, limits, budgets
      ├ Knowledge base (in the repo under .agentic/knowledge, plus platform-side index and task history)
      └ Tasks, runs, artifacts, costs
```

## Why single-tenant instances

- **Isolation by construction.** Two organisations never share a database, a workspace filesystem, a queue, or a Claude credential. No `tenant_id` bug can leak data. Simplest possible security story for an open-source, self-hosted product.
- **Operational simplicity for self-hosters** (the primary audience): one compose file, one database.
- **Scaling path exists:** if we ever offer hosting, we deploy one instance per customer (Helm/operator), which is how many self-hosted products (GitLab, Sentry self-hosted, Metabase) started.
- **Cost:** a small instance is a few containers; per-tenant overhead is acceptable for our customer size.

What we give up: cross-tenant analytics and a shared control plane. Acceptable now; note it in TODO for later.

## Project isolation (within an organisation)

- Knowledge base, memory index, task history, budgets and pipeline config are **per project**. Nothing from project A is put into project B's context. Cross-project knowledge sharing is an explicit future feature ("organisation knowledge"), not a default.
- Agent workspaces are per task (own checkout), destroyed after the task completes (retained for N days for debugging, configurable).
- Integration credentials are org-level (one Jira token) but **bindings** are project-level; a project can override with its own credentials.
- Roles: `viewer` sees boards and artifacts; `member` sees transcripts and answers questions; `maintainer` approves plans, knowledge proposals, budgets and pipeline settings; `admin` manages integrations and users. External identities (Jira, GitLab, Slack) are mapped to platform users by email; unmapped identities cannot trigger actions (Q10).

## Multi-project on one repository

Supported: two projects can point at the same repository with different Jira rules (e.g. `frontend` and `backend` labels) — they share the `.agentic/` directory; the platform warns about concurrent KB edits and serialises knowledge commits.
