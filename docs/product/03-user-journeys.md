# 03 — User journeys

Each journey is written from the human's point of view. Agent-side behaviour is in [04-pipeline.md](04-pipeline.md).

## UJ-1 Install and connect (P4, ~30 minutes)

1. Operator runs the platform with a single `docker compose up` from the published images. Only env vars with defaults are needed to boot; secrets are provided via env or a mounted file.
2. Opens the UI, creates the first admin user (local auth; SSO later).
3. Global settings: Claude provider mode (API key vs local binary / operator credentials — BD-004), default models per stage, global budgets.
4. Adds integrations under *Integrations*: each is a form generated from the integration's config schema (Jira base URL + token; GitLab URL + token; Slack app credentials; Sentry; Loki). Each integration has a **Test connection** button and a health indicator.
5. Creates a project: pick a GitLab repository, a Jira project + selection rule (label / epic / JQL), Slack channel, Sentry project, Loki labels. The platform clones the repo into its workspace.
6. Optional but nudged: **Onboarding** ([06](06-project-onboarding.md)). The UI shows a knowledge-completeness score until it is done.

## UJ-2 Deliver a feature ticket (P3 → agents → P2)

1. PM writes `PROJ-123 "Allow users to export invoices as CSV"` and adds the label `agentic` (or moves it to a mapped status).
2. Within a minute the ticket shows the platform's **workpad** comment: "Picked up. Pipeline: *feature*. Requested by: <label author>. Tracking: <link to task page>" — this one comment is edited in place for the rest of the task (BD-023). Jira status → `Refinement` (mapped).
3. **Refinement** posts a *Refined specification* comment: goal, scope, out of scope, acceptance criteria, affected areas, size estimate, business-drift flag if any. If it has questions, it posts them as a numbered list and sets status `Waiting for answers`; the same questions appear in the Slack channel thread and in the UI *Questions inbox*.
4. PM answers in Jira (reply comment) or Slack thread or UI. The pipeline resumes automatically.
5. **Architecture** posts an *Implementation plan* comment (approach, files/modules, data changes, test plan, risks). Per project policy the plan either auto-continues or waits for a human 👍 (default: auto-continue for S/M tasks, require approval for L/XL — BD-006).
6. **Implementation** creates branch `agentic/PROJ-123-export-invoices-csv`, opens a **Draft MR** immediately (so humans can watch), implements, runs tests, pushes. CI runs. On red CI the agent gets the logs and fixes (bounded).
7. **Code review** (a separate agent with fresh context) reviews the diff against the plan, conventions and security checklist; either approves or returns findings to implementation (bounded loop, default max 3). Findings are posted as MR discussion threads, so humans see the same thing.
8. **Business review** checks acceptance criteria against the diff and the running tests; approves or returns.
9. MR is marked *Ready*, Jira → `In review`, Slack: "PROJ-123 ready for review: <MR link>, cost so far $3.42, 2 review iterations".
10. Developer reviews. Comments on the MR are picked up: the task goes back to Implementation with the human comments as input ("address review feedback"), then again through code review (fast path). Developer merges.
11. **Retrospective** runs after merge: summarises what happened, proposes knowledge updates (lessons, decisions, rule candidates) as a small MR to `.agentic/knowledge` (or commits directly if the project allows), transitions Jira → `Done`, posts a short summary to Slack.

## UJ-3 Fix a bug with observability context (P2)

Same as UJ-2 with the *bug* pipeline: after Refinement an **Investigation** stage reproduces or evidences the bug using Sentry issue details, stack traces, Loki logs around the timestamps, and the codebase; it posts a *Root-cause analysis* comment with confidence. Architecture is lightweight (fix plan + regression test). If root cause cannot be established with confidence, the stage asks the human for more evidence instead of guessing.

## UJ-4 Give feedback that sticks (P2)

- On any MR discussion, the human writes a comment prefixed with the configurable trigger (default `@agentic remember:`), e.g. "…never call the payment API from controllers, go through `PaymentService`".
- Or in the UI on a run/stage output: thumbs down + text.
- The **Feedback** flow turns it into a rule candidate (scoped project/stage) in the knowledge base. Depending on project settings it is applied immediately or waits for approval in the *Knowledge* screen. The next task shows the rule in its context pack and the human can see it was used.

## UJ-5 Watch and control (P1, P2)

- Dashboard board: columns = pipeline stages, cards = tasks, with live badge of the running agent, cost so far and time in stage.
- Click a task → timeline of stages and runs, artifacts (spec, plan, MR link, review verdicts), questions, cost breakdown.
- Click a run → live formatted transcript (assistant text, tool calls with collapsible inputs/outputs, diffs, thinking summaries), model/effort/prompt snapshot, tokens and cost ticking.
- Controls: pause task, cancel run, retry stage, force return to a stage with a note, raise per-task budget, answer questions.

## UJ-6 Budget hits (P1)

- Project daily budget reaches 100%: no new runs start; running runs finish (they have their own per-run cap); tasks show `Paused: budget`; Slack/UI notification. At 80% a warning is sent. Resets on the window boundary or when the lead raises the budget.

## UJ-7 Month-end review (P1)

- Statistics: tasks delivered, cycle time, cost per task and stage, return rate per stage, human intervention rate, LOC added/removed, per day/week/month, filter by project. Export CSV.

## UJ-8 Add a new integration (P4, contributor)

- Implement one module of the *Git provider* type (e.g. GitHub) that fulfils the type's capability interface, emits the type's events, and registers its config schema and agent tooling. No changes to the pipeline or UI needed beyond what the type already renders.
