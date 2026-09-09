# 18 — Adoption features and operating modes

Decisions: [BD-027 autonomy dial](../decisions/business/BD-027-autonomy-dial.md), [BD-028 opt-in features and the setup wizard](../decisions/business/BD-028-opt-in-features-and-wizard.md), [BD-029 business model](../decisions/business/BD-029-business-model.md), [BD-030 additional pipeline gates](../decisions/business/BD-030-additional-pipeline-gates.md). Evidence: research/01.

Purpose: features whose job is to **show value early and let a team turn autonomy up at its own pace**. Everything here is optional, off or conservative by default unless stated, configured in the onboarding wizard (product/06, step 4) and changeable at any time in project settings. Every toggle records who changed it (audit).

## The autonomy dial

One per-project setting with four presets. A preset sets the granular policies; any policy can still be overridden, and the UI then shows the dial as *Custom* with the differences listed.

| Level | Name | What runs | Granular policies set by the preset |
|---|---|---|---|
| 0 | **Observe** | Shadow mode, ticket linter (if enabled), review-only on human MRs. No agent MRs. | pipeline disabled for new tickets; review-only on; shadow allowed |
| 1 | **Assist** | Refinement and Architecture produce artifacts; a human decides whether to launch Implementation ("scoping-only"). | plan approval `always`; probation on; auto-apply off |
| 2 | **Supervised** (default after onboarding) | Full pipeline; approvals by size; probation for the first 5 tasks. | plan approval `above L`; probation on; question timeout 1 working day; auto-apply off |
| 3 | **Autonomous** | Full pipeline, approvals only for risk-classed MRs; probation off. | plan approval `never` except risk classes; probation off; auto-apply on for the middle significance band |

Readiness (product/17) caps the *suggested* level: level 0 readiness suggests at most Assist; the maintainer can override, visibly.

## Opt-in features

| Feature | What it does | Value it shows | Default | Configuration |
|---|---|---|---|---|
| **Shadow mode** | Runs the pipeline on selected closed tickets (or on new tickets in parallel with humans) without opening MRs or commenting on tickets; produces spec, plan, diff and a comparison with the human MR (files touched, size, tests, review findings the human MR would have received); shows cost per ticket | The demo and the calibration tool: "what it would have built, at what cost, how close" | off | Wizard: pick N recent closed tickets (default 10) and a budget cap; settings: shadow budget per month; results only in the UI |
| **Review-only mode** | The Reviewer stage on human-authored MRs (label, path or all MRs), posting findings as discussion threads and a neutral summary that never blocks merge | Value from day one; teaches the KB through feedback before the agent writes code | off | Wizard: trigger (label / all MRs / paths), severity floor for posting (default `major`), max findings per MR (default 10) |
| **Ticket readiness linter** | A light Refinement pass on new tickets of configured issue types that are *not* labelled for the agent; posts one short comment: the questions a developer would ask, missing acceptance criteria, an agent-readiness score | Fixes the number one failure cause upstream, for human-implemented tickets too | off | Wizard: issue types, projects, comment language; settings: max one comment per ticket, re-lint on edit off/on |
| **History bootstrap** | During onboarding, mines the last N merged MRs and their review comments plus closed tickets for conventions, pitfalls and recurring reviewer requests; proposes KB items with provenance (MR links) | KB starts at "week six", not empty | off (offered in wizard) | Wizard: N (default 200), date range, budget cap; results land in the proposal queue |
| **Steer** | Send a message to a running agent from the run page (appears as a user turn in the transcript; audited) | Control while watching; corrects a run before it wastes budget | on for maintainers and members | Settings: roles allowed to steer |
| **Take over / hand back** | A human takes a task over: the platform pauses the pipeline, posts the branch and a `claude --resume <session>` command to the ticket and UI, exports the workspace; the human can hand it back to any stage | Never stuck; humans and agents share the same branch and history | on | Settings: retention of paused workspaces (default 14 days) |
| **Maintenance pipeline** | Scheduled chores within a dedicated budget: dependency bumps, flaky-test hunting, docs drift, lint debt, KB hygiene; each produces a normal `chore` task | Keeps the repository agent-ready; visible in readiness trend | off | Wizard: schedule (default weekly), budget, allowed chore types |
| **Cost estimate before spend** | At refinement, predicts task cost from size and project history; shown in the workpad; above a threshold the task waits for budget approval by a maintainer | Budgets become planning, not a brake | estimate on; approval threshold off | Settings: approval threshold in USD; estimation window (last 30 tasks) |
| **Human time accounting** | Records human minutes per task from events (review start → merge, question asked → answered, approvals) and shows total cost of delivery = tokens + people | Honest ROI | on (derived from events; no tracking of individuals beyond what tools already record) | Settings: show per-user breakdown off/on (default off) |
| **Digest and quiet hours** | Slack notifications batched into a daily digest outside configured hours; urgent classes (escalation, budget 100%) still immediate | The bot stays welcome | quiet hours off; digest on at 09:00 org time | Wizard: channel, quiet hours, urgent classes |
| **Ask the task** | A Q&A thread on a task ("why did you choose X?") answered from the task's audit trail and artifacts, in the UI and in the ticket thread | Trust through explanation; cheaper than reading transcripts | on | Settings: model (default Sonnet 5), per-question budget |

## Pipeline additions (details in product/04; BD-030)

| Addition | Behaviour | Default | Configuration |
|---|---|---|---|
| **Rebase gate** | Before Ready and whenever the default branch moved: rebase, resolve conflicts (bounded, default 2 attempts), re-run CI. Conflicting concurrent tasks are surfaced on the board ("touches the same files as PROJ-98") | on | attempts; strategy `rebase | merge` |
| **Dependency and epic awareness** | Intake skips tickets blocked by open tickets (Jira links); the epic description and sibling ticket summaries enter the Refinement context pack | on | link types considered; max sibling summaries (default 5) |
| **Reviewer routing and risk classes** | Reviewers assigned from CODEOWNERS/project config; MRs labelled with risk classes from touched paths (auth, payments, migrations, infra) that can force plan approval, a named reviewer or a stricter review checklist | on (classes empty until configured; wizard proposes from repo structure) | risk classes: paths → policy |
| **Dependency policy** | Adding a third-party dependency raises a question by default; the Checks panel shows license and maintenance status | ask | `allow | ask | block` per ecosystem; allow-listed packages |
| **Coverage delta** | Test coverage change of the MR shown in Checks when the project's CI reports coverage | on when available | coverage source |
| **Epic split (spike variant)** | PM writes an epic; the agent proposes a ticket breakdown with acceptance criteria as a draft for the PM to accept | off (spike template option) | — |

## The setup wizard (product/06, step 4 revised)

All of the above is presented in one wizard step, **"Operating mode and features"**, after technical discovery and the business interview:
1. Pick the autonomy dial level (default Supervised; the wizard suggests a cap from readiness).
2. Toggle features, each with a one-sentence value statement, its default and its cost implication; recommended set is preselected per dial level (Observe preselects shadow mode, review-only, linter).
3. Risk classes proposed from the repository structure; reviewer routing from CODEOWNERS if present.
4. Budgets, including a separate shadow/maintenance budget.
5. Notifications: channel, quiet hours, digest.
Every step is skippable; a "Finish later" leaves a checklist on the project page. Settings pages mirror the wizard one-to-one, so nothing is only reachable during onboarding.

## Metrics these features add (product/16)
- Shadow mode: similarity to human MR (files overlap, size ratio), predicted cost per ticket.
- Review-only: findings accepted (thread resolved with change) vs dismissed.
- Ticket linter: tickets improved after lint (edited within 48 h), questions avoided downstream.
- Cost estimate accuracy (estimate vs actual, by size).
- Human minutes per merged MR; total cost of delivery.
- Rebase gate: conflicts resolved automatically vs escalated.
