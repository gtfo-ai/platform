# BD-001 — Product scope: autonomous ticket-to-merge-request pipeline for Claude Code teams

- **Status:** accepted
- **Date:** 2026-08-28
- **Deciders:** founder
- **Relates to:** product/01, product/02, product/14

## Context
The founder brief asks for a fully autonomous platform where AI agents orchestrate themselves through a real-life delivery workflow, with a per-project knowledge base, integrations (Jira, GitLab, Slack, Loki, Sentry), cost governance and audit. Many adjacent products exist (see research/01) but none combine self-hosting, GitLab/Jira-first integration, transparent cost and a learning knowledge base.

## Decision
Build a self-hosted, open-source platform that takes a ticket from a task-management system through a configurable pipeline of role-specialised Claude Code agents to a human-mergeable merge request, and that maintains a per-project knowledge base improved by every task. Target users: small-to-mid engineering teams already using Claude Code.

## Rationale
- Clear, measurable job: ticket in, reviewed MR out, cost and audit attached.
- Differentiation is in the process + knowledge + governance, not in the model.
- Narrow enough for one team to ship an end-to-end MVP.

## Alternatives considered
- General agent orchestration framework (any domain) — no focused value, crowded.
- IDE/chat assistant — Claude Code already is one.
- Hosted SaaS first — conflicts with open-source/self-host positioning and adds tenancy work up front.

## Consequences
- Everything not on the ticket→MR path is secondary (see product/15 non-goals).
- The knowledge base is a must-have, not a nice-to-have (BD-012).
