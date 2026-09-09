# 04 — The pipeline

The **pipeline** is the flow a task goes through from "picked up" to "merged and learned from". It is modelled after how a good engineering team works, not after how an LLM loop works. Every stage is an **agent with a role**, a **deterministic gate**, or a **human step**.

Decisions: [BD-005 stage set](../decisions/business/BD-005-pipeline-stages.md), [BD-006 human checkpoints](../decisions/business/BD-006-human-checkpoints.md), [BD-007 human merges](../decisions/business/BD-007-human-merges.md), [BD-008 bounded loops](../decisions/business/BD-008-bounded-loops-and-escalation.md).

## Vocabulary

- **Task** — one unit of work, 1:1 with a ticket in the task-management integration. Has a *pipeline instance*, a state, artifacts, runs, cost.
- **Pipeline template** — an ordered, branching set of stages. Defaults: `feature`, `bug`, `chore`, `spike`. Selected at intake by rule or by the Triager.
- **Stage** — a step. Kinds: `agent` (a Claude run with a role), `gate` (deterministic check, e.g. CI result), `human` (waits for a person), `system` (side effects like transitions).
- **Run** — one execution of an agent stage. A stage can have many runs (retries, returns). Runs are what carry prompts, model, cost, transcript.
- **Artifact** — a structured output of a stage stored on the task (Refined Spec, Plan, Root Cause, Review Verdict, MR reference, Retro report). Artifacts are markdown + structured JSON (schema per artifact type).
- **Return** — a transition backwards with a reason and structured feedback. Returns are normal.
- **Question** — a stage's request for human input. Pauses the task until answered (or timed out → escalation).
- **Escalation** — the task is parked in `Needs human` with a reason; no agent runs until a human acts. Every escalation and question carries a **blocker brief**: what is missing, why it blocks, the exact human action needed (research/01: Symphony, no_human).
- **Workpad** — the single sticky comment on the ticket (and MR) that the platform edits in place with state, checklist, cost and links (BD-023).

## Default stages (feature template)

```
Intake ─► Refinement ─► Architecture ─► Implementation ─► CI gate ─► Code review ─► Business review ─► Ready for merge (human) ─► Merged gate ─► Retrospective ─► Done
              │ ▲            │  ▲             ▲   │              │ ▲               │                          │
              │ └─questions─┘  └── return ────┘   └── fix ───────┘ └──── return ───┘                          │
              └──── reject / needs human ──────────────────────────────────────────────── human MR comments ──┘
```

### S0 — Intake (system + optional cheap agent: *Triager*)
- **Trigger:** task-management event (label added, status changed, epic membership, JQL match on poll) or manual "Start" in UI.
- **Does:** checks project WIP limits (max parallel, max in pipeline — BD-010), creates the Task, classifies it (`feature | bug | chore | spike`) using the ticket type mapping first and, if ambiguous, a Haiku call; selects the pipeline template; posts the "picked up" comment; transitions the ticket status.
- **Outputs:** Task created, `task.intake.completed` event.
- **Never:** reads the codebase deeply or spends more than cents.

### S1 — Refinement (*Product Manager*)
- **Inputs:** ticket (title, description, comments, attachments text, linked issues), business knowledge base (product overview, glossary, business rules, roadmap), recent related tasks.
- **Does:** rewrites the ticket into a **Refined Specification**: goal, user value, in scope, out of scope, acceptance criteria (Given/When/Then), non-functional requirements, dependencies, size (S/M/L/XL), *business drift* assessment against the documented product direction (label only, never blocks — BD-005), and **open questions**.
- **Gate:** *Definition of Ready.* If there are blocking questions → post them, set `Waiting for answers`, wait. Unanswered after 1 working day (configurable) → reminder, then `Needs human`. Non-blocking assumptions are stated explicitly and proceed.
- **Returns:** can *reject* (duplicate, already done, not actionable, out of product scope) → `Needs human` with reason.
- **Validation section:** the spec must contain *runnable* validation (commands, test names, or manual steps) for each acceptance criterion; downstream stages treat it as a contract (research/01: Symphony, Backlog.md). If the ticket author wrote a "Test plan"/"Validation" section, it is copied verbatim and is non-negotiable.
- **Why high demands here:** every downstream stage is cheaper when the spec is precise; underspecified tickets are the #1 upstream cause of failure across every system studied (research/01). This is the stage where a bad ticket costs $0.50 instead of $30.

### S2 — Architecture (*Architect*)
- **Inputs:** Refined Spec, technical knowledge base (architecture overview, module map, conventions, ADRs, lessons), the codebase (read-only exploration), CI configuration.
- **Does:** produces an **Implementation Plan**: approach and alternatives considered, affected modules/files, data model and migration changes, API/contract changes, test plan, rollout/feature-flag notes, risks, estimated effort, *split proposal* if the task is too large for one MR.
- **Gate (policy per project):** auto-continue, or require human plan approval above a size threshold (default: require for L/XL — BD-006). **Probation mode** (default on for new projects): approval required for the first 5 tasks regardless of size until a maintainer ends probation. Approval via UI, Jira comment `approve plan`, or Slack button, by a mapped maintainer.
- **Validation contract first:** the plan names, before any code exists, the checks that will prove each acceptance criterion (test files, commands, expected observations) — Factory's validator-wall result (36% → 90% parity) and Anthropic's harness guidance (research/01).
- **Optional planning critic:** a project policy can run a cheap, read-only critic pass on auto-approved plans (Jules reports −9.5% task failures). Off by default; on for probation mode.
- **Returns:** to Refinement when the spec is contradictory or infeasible; to `Needs human` for split decisions.
- **Never:** writes code.

### S3 — Implementation (*Developer*)
- **Inputs:** Refined Spec, Plan, technical KB, rules, review findings (on return), human MR comments (on return).
- **Does:** in an isolated workspace (branch `agentic/<KEY>-<slug>`, own checkout — technical detail in Round 2): implements the plan, writes/updates tests, runs the project's test/lint commands (from KB *how to run*), commits in logical steps with conventional messages, pushes, **opens a Draft MR early** and keeps its description updated (summary, plan link, checklist, deviations from plan, test evidence).
- **Outputs:** MR reference, *Implementation Notes* artifact (what was done, deviations, known gaps).
- **Self-check before handoff:** a short built-in checklist (tests pass locally, no debug leftovers, no secrets, description complete).
- **Scope-creep valve:** improvements discovered outside the scope are never implemented; the agent files a *separate* ticket (title, description, acceptance criteria, `related` link) via the platform tool and notes it in the workpad (research/01: Symphony).
- **Test integrity (BD-024):** existing tests and CI/lint config are modified only when the plan says so and why; otherwise the CI gate/reviewer blocks.
- **Returns:** to Architecture when the plan proves wrong (with evidence) — max once per task by default.

### S4 — CI gate (gate)
- **Trigger:** git-provider event `pipeline finished` for the MR's head commit.
- **Pass:** continue. **Fail:** return to Implementation with the failing job's **error block only** (timestamps and progress noise stripped, head/tail truncated — research/01: Sweep, SWE-agent), counted as an iteration. Three identical failures in a row stop the loop early (convergence detection). The gate also runs the **tamper check** (diff touches protected tests/CI config without a plan entry → blocker) and, for bugs, the **reproduction gate** (regression test fails on base, passes on head) — BD-024. Flaky detection: if the same job passes on plain retry, mark `flaky` in the retro input.
- If the project has no CI, the gate is skipped and the local test run is the evidence (recorded in the Implementation Notes).

### S5 — Code review (*Reviewer*)
- **Inputs:** diff, Plan, Refined Spec, technical KB, conventions/rules, security checklist. **Fresh context, different session, ideally different model family or at least different run** than the implementer (BD-005: independence of review).
- **Focus (default checklist):** correctness vs plan; security (input validation, authz, secrets, injection, unsafe deserialisation, dependency changes); clean architecture (layering, boundaries, coupling, naming); tests (coverage of acceptance criteria, meaningful assertions); error handling and logging; performance smells; migrations safety; conventions from KB; MR hygiene (size, description, commits).
- **Outputs:** **Review Verdict** artifact: `approve | request_changes` with findings (severity, file:line, explanation, suggested fix). Findings are posted as MR discussion threads (so a human can see and resolve them too).
- **Returns:** `request_changes` → Implementation (fast path: only address findings). Bounded: default 3 iterations, then escalate to `Needs human` (BD-008). **Convergence detection:** if a re-review reports the same findings as the previous round, stop immediately and escalate instead of burning the remaining iterations (research/01: pi-review-loop).

### S6 — Business review (*Acceptance Tester*)
- **Inputs:** Refined Spec acceptance criteria, diff, MR description, test results; where feasible runs the tests or the app (project-provided commands).
- **Does:** verifies each acceptance criterion with evidence (test name, screenshot/log, or reasoning), checks scope creep and missing pieces, checks user-facing texts and edge cases from the business rules.
- **Outputs:** **Acceptance Verdict** artifact per criterion; approve or return with concrete gaps.
- **Returns:** Implementation (bounded, default 2).

### S7 — Ready for merge (human)
- MR is marked ready, reviewers assigned per project config, ticket status → `In review`, Slack notification with summary and cost.
- **Human MR comments** by mapped users create `mr.review.comment` events; unresolved threads are batched (2-minute debounce) into one return to Implementation, then a fast Code review, then back to Ready (BD-007). `@agentic hold` pauses; `@agentic rework` restarts from Architecture.
- **While waiting, nothing runs.** The task sleeps and is woken only by events (comment, approval, CI result, merge) — never by a polling agent (research/01: Cursor subscriptions, Devin sleeping sessions).
- **Human rejection = reset, not patching.** If a human requests a fundamentally different approach (explicit `@agentic rework` or MR closed with a reason), the task returns to Architecture with the human's reasoning; the old MR is closed, a fresh branch is created and the new plan must state what will be done differently (research/01: Symphony). Ordinary review comments follow the fast path above. A human decision resets the agent-to-agent iteration counter (Paperclip).
- **Human merge** (or MR close/decline → `Needs human` with reason; a closed MR after human comment "won't do" → task `Cancelled`).

### S8 — Merged gate (gate)
- Trigger: `mr.merged`. Records merge time, final diff stats (LOC added/removed/changed), cycle time. Optional post-merge hook: transition ticket to a "deployed" status when a later CI event says so (future).

### S9 — Retrospective (*Retrospective Facilitator*)
- **Inputs:** everything on the task: spec, plan, all runs' summaries, returns and their reasons, review findings, human comments, cost, time, flaky notes.
- **Does:** writes a **Retro Report**: what went well, what caused returns/iterations, human corrections and why, and — the important part — **proposed knowledge updates**, split into *business* (domain facts, rules, glossary terms learned) and *technical* (architecture facts, conventions, gotchas, how-to). Each proposal is a small, deduplicated diff to the knowledge base with provenance (task key, run id).
- **Outputs:** knowledge update proposal (MR or direct commit per project policy — BD-012), ticket → `Done`, Slack summary.
- Followed by the **Librarian** (see [05](05-knowledge-base-and-memory.md)) which merges proposals into the KB structure and keeps it tidy.

## Bug template (differences)

`Intake → Refinement (bug-flavoured: expected vs actual, impact, repro steps) → Investigation → Architecture (fix plan, regression test) → Implementation → CI → Code review → Business review → Ready → Merged → Retro`.

### S1b — Investigation (*Investigator*)
- **Inputs:** ticket, linked Sentry issue(s) (events, stack traces, breadcrumbs, release, frequency), Loki logs around the incident window (queries derived from the project's observability config: labels, service names), the codebase, recent merged tasks touching the same modules.
- **Outputs:** **Root Cause Analysis** artifact: reproduction (or evidence), root cause with confidence (`high | medium | low`), affected scope, proposed fix direction, regression test idea. `low` confidence → asks for more evidence (question) instead of proceeding, unless the project policy says "attempt anyway".

## Chore template
Small, mechanical tasks (dependency bump, config change, rename): `Intake → Refinement (light) → Implementation → CI → Code review → Ready → Merged → Retro (light)`. No Architecture, no Business review.

## Spike template
Research/analysis tickets: `Intake → Refinement → Architecture (produces a document instead of a plan) → Human`. Output is a markdown report attached to the ticket and stored in the KB under `research/`. No MR.

## Customisation model

A pipeline is data, not code. The platform ships the four templates above; a project can:

- **Enable/disable** stages (e.g. disable Business review, disable plan approval).
- **Reorder** within constraints (a stage declares which artifacts it requires; the platform validates the template).
- **Change** model, effort, prompt (override or append), tools allowed, max iterations, timeouts, budget per stage.
- **Add custom stages** declared as: trigger event, kind (`agent|gate|human|system`), prompt, required artifacts, produced artifact, success/return transitions. Example: a `Security scan` gate after CI, a `Docs update` agent before Ready, a `Translate strings` agent for i18n projects.
- **Map** stage states to ticket statuses per project.

Where: global defaults in platform settings → project settings in the UI → `.agentic/pipeline.yml` in the repository (highest precedence for non-secret settings; see [12](12-agentic-directory.md)). Every change is audited and every run stores the effective config it ran with.

### Events (business-level names; technical shape in Round 2)

`task.created`, `task.stage.entered`, `task.stage.completed`, `task.stage.returned`, `task.question.asked`, `task.question.answered`, `task.escalated`, `task.paused`, `task.resumed`, `task.cancelled`, `task.completed`, `run.started`, `run.output` (stream), `run.finished`, `run.failed`, `artifact.created`, `mr.opened`, `mr.updated`, `mr.review.comment`, `mr.merged`, `mr.closed`, `ci.pipeline.finished`, `ticket.comment.added`, `ticket.status.changed`, `budget.threshold.reached`, `budget.exhausted`, `feedback.received`, `knowledge.update.proposed`, `knowledge.update.applied`.

Handlers subscribe to events with a **priority**; multiple handlers for one event run in priority order; a handler may emit further events (chaining). Custom stages are handlers on `task.stage.completed` for a given predecessor.

## Stage defaults: model, effort, limits (proposed — BD-013)

| Stage | Agent role | Default model | Effort | Max turns | Per-run budget | Max iterations | Tools |
|---|---|---|---|---|---|---|---|
| Intake classification | Triager | Haiku 4.5 | low | 3 | $0.10 | 1 | none (ticket text only) |
| Refinement | Product Manager | Opus 5 | medium | 30 | $2 | 2 (question rounds) | KB read, ticket read, repo read (light) |
| Investigation (bug) | Investigator | Opus 5 | high | 60 | $5 | 1 | KB, repo read, Sentry, Loki, ticket |
| Architecture | Architect | Opus 5 | high | 60 | $5 | 2 | KB, repo read, ticket |
| Implementation | Developer | Opus 5 | high | 200 | $15 | 3 (review returns) | KB, repo write, shell (tests/lint), git, MR, ticket |
| Code review | Reviewer | Opus 5 | high | 60 | $5 | — | KB, repo read, diff, MR comments |
| Business review | Acceptance Tester | Sonnet 5 | medium | 40 | $3 | — | KB, repo read, shell (tests) |
| Retrospective | Facilitator | Sonnet 5 | medium | 30 | $2 | 1 | task history, KB write (proposal) |
| Librarian | Librarian | Sonnet 5 | medium | 30 | $2 | 1 | KB read/write |
| Feedback intake | Librarian | Sonnet 5 | low | 10 | $0.50 | 1 | KB write (proposal) |

Rationale: Opus 5 is the price/quality sweet spot for reasoning-heavy stages; Fable 5.1 is offered as an opt-in upgrade for Architecture and Code review on hard projects; Sonnet 5 where the task is structured verification or summarisation; Haiku for classification. Effort `high` where mistakes are expensive to undo (plan, code, review). Every value is overridable at global, project and repository level. Prompts and role descriptions: [13](13-agents-prompts-skills.md).

## Task states (human-visible)

`Queued` (WIP limit) → `In pipeline: <stage>` → `Waiting for answers` → `Waiting for approval` → `Ready for merge` → `Paused (budget | manual)` → `Needs human` → `Done` | `Cancelled`.

## What makes the pipeline "real life" and not a loop

- Separation of *what* (Refinement), *how* (Architecture), *doing* (Implementation), *checking* (CI, Code review, Business review), *learning* (Retro).
- Independent reviewers with fresh context.
- Questions are a normal outcome, not a failure.
- Human review comments re-enter the pipeline instead of dying in the MR.
- Bounded loops with explicit escalation. Nothing spins forever, nothing silently gives up.
- Every stage leaves an artifact a human can read in 2 minutes.
