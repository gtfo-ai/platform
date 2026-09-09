# 01 — Vision and positioning

## One-liner

**Agentic turns a ticket into a reviewed, mergeable merge request — autonomously, inside the tools your team already uses — and gets better at *your* project with every task it delivers.**

## The problem

Teams that run Claude Code by hand already get value. What they do not get:

1. **Memory.** Every session starts from zero. The developer re-explains the business, the conventions, the gotchas. Lessons from last week's task are lost. `CLAUDE.md` helps but is written by hand, drifts, and nobody owns it.
2. **Process.** A human has to sit in the loop: refine the ticket, decide the approach, prompt, review, re-prompt, open the MR, update Jira, tell the team. The agent is fast; the human around it is the bottleneck.
3. **Governance.** Nobody knows what a task cost, which prompt produced which change, or why the agent did what it did. Budgets are a credit-card surprise.
4. **Throughput.** One developer drives one agent. Ten tickets in the backlog wait for ten sessions.

## The product

A self-hosted, open-source platform where **a pipeline of specialised agents** takes a task through the same stages a good engineering team uses — refinement, architecture, implementation, code review, business acceptance, merge, retrospective — and where **a per-project knowledge base** (business context, architecture, decisions, lessons, rules) is read by every agent and improved by every task.

The platform is not a chat window. Humans interact with it where they already work: Jira tickets, GitLab merge requests, Slack threads, plus a web UI for visibility, configuration, cost and knowledge curation.

## Why it is better than running `claude` locally

| Running `claude` yourself | Agentic |
|---|---|
| Context lives in your head and a hand-written `CLAUDE.md` | Curated, versioned, per-project knowledge base with business + technical layers, fed by onboarding, retrospectives and feedback |
| You are the process | Pipeline with gates, returns, questions to humans, bounded retry loops, escalation |
| One task at a time, while you watch | N tasks in parallel, unattended, 24/7, WIP limits per project |
| Cost visible only on the invoice | Cost per run, stage, task, day; budgets that pause work before they blow up |
| No audit trail | Every prompt, model, setting, tool call and output stored and replayable |
| Integrations are whatever you script | First-class Jira, GitLab, Slack, Sentry, Loki; new ones without architecture drift |
| It forgets what you told it | It learns: lessons and feedback become rules and knowledge |

## What it is not (non-goals for now)

- Not a general chat assistant or IDE plugin.
- Not multi-LLM. Claude only (BD-004). The abstraction to add others exists in the domain model but is not implemented.
- Not a SaaS with tenant sign-up. One deployment = one organisation (BD-009).
- Not a replacement for human merge. A human merges (BD-007) — at least until trust metrics justify auto-merge for low-risk classes of tasks.
- Not a Jira/GitLab replacement. We integrate; we do not re-implement task boards or code hosting.

## Positioning

- **For** small-to-mid engineering teams (2–50 developers) who already use Claude Code and have a real backlog in Jira and code in GitLab.
- **Who** want to offload well-specified tickets, bugs and chores to agents without losing control, visibility or quality.
- **Agentic is** an autonomous software delivery platform
- **That** runs a configurable, real-life engineering pipeline of Claude agents with persistent project knowledge, cost governance and full audit.
- **Unlike** hosted "AI engineer" products (Devin, Copilot coding agent, Jules) it is self-hosted, open source, integration-first (GitLab/Jira), transparent about cost, and owns a learning knowledge base per project.
- **Unlike** DIY orchestration (scripts around `claude -p`, OpenAI's Symphony reference implementation, Ralph loops) it ships the process, the knowledge model, the UI and the governance (budgets, audit, cost) out of the box. Symphony itself has no database, no budgets and is explicitly not maintained as a product (research/01).
- **Unlike** GitLab Duo Agent Platform it is vendor-neutral on the task side (Jira first), runs outside CI with a fast inner loop, and keeps knowledge in the repository rather than in a hosted service.

## Principles (short form; full list in 15)

1. **Knowledge compounds.** Every task must leave the project knowledge base better than it found it.
2. **Humans are a first-class stage participant,** not an exception path. Asking is cheaper than guessing.
3. **Everything is an event; everything is auditable.**
4. **Defaults are opinionated; everything is overridable** at global, project and repository level.
5. **Cost is a feature.** Visible, predictable, capped.
6. **Small, verified steps.** A returned stage is normal, not a failure.
7. **No lock-in.** Knowledge is markdown in the user's git repository. Delete the platform and the knowledge stays.
