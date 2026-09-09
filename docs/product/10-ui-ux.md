# 10 — UI and UX

Goal: someone who has never used the platform understands within a minute what is happening, what it costs, and how to intervene. The UI is a **control tower**, not a chat.

Decision: [BD-015 UI is a first-class product surface](../decisions/business/BD-015-ui-first-class.md). Visual design language is a Round 2 topic; this document fixes the information architecture and key interactions.

## Information architecture

```
Dashboard (org)            – spend today/month vs budget, active agents, tasks by state, alerts, projected spend
Projects
  └ Project overview       – board (stages as columns), health of integrations, KB completeness, budget bar
    ├ Tasks                – list/filter; Task detail
    │   └ Task detail      – header (ticket, MR, cost, cycle time, state), stage timeline, artifacts, questions, runs
    │       └ Run detail   – live transcript, prompt snapshot, settings, cost meter, actions
    ├ Knowledge            – vault browser/editor, pending proposals (approve/reject), rules, search, completeness
    ├ Pipeline             – template editor (enable/disable/reorder/add stage), per-stage model/effort/prompt/limits, status mapping
    ├ Integrations         – per-type cards with health, test connection, project-level settings
    ├ Budgets & costs      – per project, forecast, per-stage breakdown
    ├ Shadow               – shadow-mode runs: comparison with the human MR, predicted cost, similarity
    └ Settings             – autonomy dial, features (mirror of the wizard), WIP limits, policies, risk classes, budgets, Slack channel, quiet hours
Agents (org)               – live view: who is working on what, model, tokens/min, elapsed; idle agents; queue
Questions inbox (org)      – all pending questions/approvals across projects, answer inline
Statistics (org)           – delivered tasks, cost, LOC, cycle time, return rates, intervention rate; per day/week/month; CSV export
Audit log (org)            – filterable event stream (config, human actions, integration actions)
Settings (org)             – auth, Claude provider mode, default models, global budgets, users & roles, feature flags
```

## Key screens

### Board (project)
- Columns = stages (from the project's pipeline template) plus `Queued`, `Needs human`, `Done (7d)`.
- Card: ticket key + title, template icon (feature/bug/chore/spike), running-agent pulse, cost so far, time in stage, iteration counter (e.g. "review 2/3"), question badge.
- Drag is *not* supported (state is owned by the pipeline); actions are on the card menu: pause, cancel, return to stage, open ticket, open MR.

### Task detail
- Left: vertical **stage timeline** with status, duration, cost per stage, returns drawn as loops with reason.
- Centre: **artifacts** tab (Refined Spec, Plan, RCA, Review Verdicts, Retro) rendered markdown with version history; **runs** tab; **questions** tab; **events** tab (raw).
- Right: **Checks** panel — merge-readiness at a glance: acceptance criteria met, CI green, rebase status, review threads open/resolved, business verdict, tamper check, coverage delta, dependency status, risk classes and required reviewers, budget vs estimate, questions pending (research/01: Conductor); cost breakdown donut (per stage), budget bar, links (ticket, MR, Slack thread), actions.

### Run detail (the "click and watch" requirement)
- Header: stage, role, model, effort, permission mode, tokens (in/out/cache), cost (live estimate → final), turns, elapsed.
- **Transcript** (live via stream): assistant text (markdown), tool calls as collapsible cards (name, input, output, duration; diffs rendered as diffs; shell output as terminal), thinking blocks collapsed by default, sub-agent runs nested, compaction boundaries shown. Search within transcript. Follow-tail toggle.
- **Prompt** tab: exact system prompt and user prompt, context pack (list of KB docs included, with token counts), skills/MCP loaded.
- **Settings** tab: effective configuration snapshot with "changed from default" markers.
- Actions: cancel, retry with different model/effort (creates a new run), **steer** (send a message to the running agent; appears in the transcript, audited), **take over** (pause pipeline, get branch + resume command, export workspace), give feedback (👍/👎 + text, scoped to stage or project).

### Agents view
- One row per running run: project, task, stage, role, model, elapsed, tokens/min, last tool call. Idle capacity and queue depth. This is the "who is working on what" requirement.

### Knowledge screen
- Tree of the vault (`business/`, `technical/`, `decisions/`, `lessons/`, `rules/`, `research/`), markdown editor with preview, backlinks, "used by N runs in last 30 days" per document.
- **Proposals** queue: diffs proposed by Retrospective/Feedback with provenance; approve (commits), edit-then-approve, reject with reason (which the Librarian learns from).
- Completeness checklist (from onboarding) and stale-document warnings.

### Ask the task
- A thread on the task page (and mirrored in the ticket thread) where anyone with access can ask "why did you choose X?"; answered from the audit trail and artifacts with links to the exact run and prompt.

### Questions inbox
- Card per pending question: project, task, stage, question text with context, suggested answer if the agent proposed one, answer box, "answer in Jira/Slack" links (all channels are equivalent; first answer wins, others get a note).

## UX rules

- Every number shown has a tooltip with its definition (cost = provider reported; estimated = price table).
- Every agent output is one click away from the prompt that produced it.
- Never block a human on a modal for agent activity; the pipeline is asynchronous and the UI reflects that.
- Empty states teach: an empty board explains how tasks get picked up and links to the rule config.
- Dark/light theme, keyboard navigation, responsive to laptop widths (mobile read-only later).
- Live updates everywhere (no refresh), but with a "paused updates" indicator when scrolling a transcript.
- Language: English UI; user content shown as-is.
