# 21 — UX flow review: every screen with a clear intent

- **Date:** 2026-11-06. **Code:** `main` at `9736997c`. **Round:** M25 (slices S-25.x).
- **Method.** Every route in `apps/web/src/routes/tree.tsx` was opened in Chrome against the web-e2e fixture
  backend (`test/web-e2e/support/serve.ts`, port 4350, fixture login), as a user would, at 1440 × 900. The code
  behind each finding was then read at the cited line. A read-only agent built the jargon census (§ 4) from the
  sources. No test was run (owner rule).
- **The owner's live example** (Autix, AUT-6639, 2026-11-06): the task page's *Waiting for approval* card offered
  *Approve* and *Reject…* with no plan anywhere in it. The owner: *"I'm blind and blind approve is no-go."*
  It is reproduced in the fixtures and is finding **F1**, the round's one blocker.
- **Scope.** This round is about **flow**: who arrives where, what they want, and what the next step is. The
  visual design language (TD-033) and the earlier consistency audit (refusal reasons, one primary per view,
  confirmations, stage names) are done (S-23.22, S-23.23, S-23.26) and are not re-reported. The worker's local
  page (`apps/web/src/worker/*`) belongs to the worker session and is out of scope.
- **Screenshots.** `Sxx` refers to the fixture screen at the URL given in § 2. The owner's live screenshot is `L1`.

## 0. The rule this round adds

> **A screen answers one question, and a decision is made with its evidence on screen.**
> Nobody approves, accepts or rejects what they cannot see from where the button is. A state word says what it
> means for the person reading it, not where it sits on an internal ladder.

## 1. Who and why — the personas' paths today

### P1 — Engineering lead ("the governor")
| Job | Path today | Friction |
|---|---|---|
| Is anything stuck or waiting on me? | Home → *Needs you* | Works. But *Approve* on Home opens the task, where the approval card shows no plan (F1). |
| What did it cost, and against what cap? | Home *Spend* → (no link) → Project → *Budgets* → "Set a cap in the project settings" → Settings → Budgets | The cap is read on one tab and set on another. No per-stage or per-task breakdown, which product/10 promises (F8). |
| How autonomous is each project, and why? | Projects → "L3 Agent-ready" badge | The badge isn't explained. You must know product/17's ladder; L0 is a red ✕ for every new project (F3). |
| Month-end numbers | Statistics | "3 observations", "Returns per delivered task 8.0" with no sense of good or bad (F15). |

### P2 — Developer ("reviewer and merger")
| Job | Path today | Friction |
|---|---|---|
| Approve a plan | Home/Inbox → task → *Approve* | **The plan isn't on the card.** It's under Artifacts → *Implementation plan v2*, which nothing links to, and that tab opens on "Choose a document" (F1). |
| See why a check is red | Task → Checks rail | "Tamper check", "Rebase status", "+2.5 pp", "Risk classes", and "3 checks need you" as a red ✕ (F6). |
| Open the MR or ticket | Task → scroll to the bottom of the right rail | *Ticket* and *Merge request* are the last links on the page (F5). |
| Watch the agent | Task → Runs → run page | The run page leaves the project frame. Its one amber button is *Cancel run*. "Now: Needs you" doesn't say what (F13). |

### P3 — Product manager ("source of truth for *what*")
| Job | Path today | Friction |
|---|---|---|
| Answer a question | Jira/Slack link → task → callout → answer | Works well: the answer chips and the box are on the card. |
| Accept a knowledge change | Project → Knowledge → Proposals → *Approve* | You can approve with the change collapsed. The health warning leads the screen, not the proposals that wait for you (F2). |
| Understand where a ticket is | Board → card | "Review 1", "touches DEMO-98 · 3 files", "Ticket not read yet" (F6). |
| Try the platform on past tickets | Project → *Shadow* | "Shadow" sounds hidden or broken. The tab shows *cannot be started*, an error and an empty state at once (F7). |

### P4 — Operator ("the one who installs it")
| Job | Path today | Friction |
|---|---|---|
| Are my integrations working? | Integrations | "Healthy · checked 57 d ago" comes from the last manual *Test connection*, not from traffic (F4). |
| Which project uses this integration? | Integrations → row → detail → bottom | "Used by 1 project", unnamed in the list (F4). |
| Did anything break in the background? | Settings → Operations → Dead letters / Failed jobs | Nothing on Home or in the frame says one exists (F14). |
| Add a project | New project | It asks for *Key* before the repository (F11). |
| Finish setup | Home → *Finish setting up* | "4 of 5 done" with **step 1** current while steps 2–5 are ticked (F10). |

## 2. Intent cards, screen by screen

Each card answers six things:
- **Who** arrives, from where;
- **Q**, the one question the screen answers;
- **Primary**, the action and what happens next;
- **Secondary**: keep, move or drop;
- **States**: empty, loading, blocked, error;
- **Never**: what the screen must not show.

### S01 Home `/`
- **Who:** everyone, after signing in. **Q:** *Does anything need me, and is the work moving?*
- **Primary:** none of its own. Each *Needs you* row is the action, and its verb must say what it opens: *Review plan*,
  *Answer*, *Open task*. Today a row says "Approve" and opens the task (`features/dashboard.tsx:272`), which promises a
  one-click decision.
- **Secondary:** *Running now* (keep). *Projects* (keep, with each project's needs-you count). *Finish setting up* (keep only
  until the first ticket ran, then hide unless something is actually missing; F10). *Spend* (keep, link it to the
  budgets screen). *Instance* (operator only).
- **States:** an empty *Needs you* says "Nothing waits for you" plus the next likely event. Background failures (dead
  letters, failed jobs) show for operators as a row in *Needs you* (F14).
- **Never:** model ids in the *Running now* rows (`claude-opus-5`) for non-engineers: put the activity there instead.

### S02 Projects `/projects`
- **Who:** P1, P2. **Q:** *Which project needs attention?*
- **Primary:** *New project* (keep).
- **Row:** name · what agents may do here (the readiness meaning, F3) · needs-you count · running count · open tasks ·
  spend 30 d. Today the row is "L3 Agent-ready · 2 open · $12.50 · 30d", with nothing about who is waiting.
- **Never:** "L0", "Unverified" as a red ✕.

### S03 Board `/projects/$key`
- **Who:** P1, P2, P3. **Q:** *Where is each ticket, and which ones wait on a person?*
- **Primary:** *Start a ticket* (keep).
- **Finding:** a task that waits on a person sits in **Active** if its state is still a stage (`board.tsx:59`
  `columnFor(state)`), while its card says "Needs you 2". The *Needs you* column, the card badge and the task header
  pill must read one rule (`ui/task-status.ts` `needsYou`) (F5).
- **Card:** loop badges "Review 1", "Re-checks 2/3" → "Review round 1 of 3" (F6). "touches DEMO-98 · 3 files" →
  "Overlaps DEMO-98 (3 files)".
- **Empty:** product/10 already asks it to explain the pick-up rule (kept).

### S04 Task `/projects/$key/tasks/$id`
- **Who:** P2/P3 from a Jira, Slack or Inbox link. P1 from the board. **Q:** *What is happening to this ticket, and what do I
  do now?*
- **Primary:** whatever the callout asks: answer, or **review the plan** and then approve. When nothing waits, there is no
  amber button.
- **Header:** state pill from `needsYou` (today "Active" beside "An agent is waiting for your answer"). Ticket and MR
  links go **in the header**, next to the key (today they are at the bottom of the right rail).
- **Callout (F1):** each approval shows its **subject**:
  - **plan:** the plan's summary, size, risks and files, a *Read the whole plan* toggle, the version, and "Approve → Implementation
    starts; Reject → back to Architecture with your reason";
  - **budget:** the numbers;
  - **rework:** the reason and what reruns;
  - **knowledge:** the change.
- **Overview:** three drawings of one pipeline (PhaseTrack in the header, the Flow canvas, the Stage timeline). Keep the
  PhaseTrack and **one** of the other two (the timeline as the canvas's list mode, which already exists), not both stacked.
- **Checks rail:** the header reads "3 checks need you" with a red ✕ when the reason is *Questions pending* and
  *Approvals pending*, which duplicates the callout. The rail should count gates that failed, and list the callout items as
  "see above".
- **Ask the task:** a task with no thread shows "The thread could not be loaded — it was not found". An absent thread
  should be the empty state, not an error (S04, bottom).
- **Never:** "Plan approval · requested …" with nothing to approve.

### S05 Run `/runs/$id`
- **Who:** P2 debugging, P1 auditing. **Q:** *What did the agent do and why?*
- **Primary:** while live, **none**: watching is the job. *Cancel run* is a destructive secondary, not the amber beacon
  (TD-033: amber = the thing to do). When finished, *Retry with…*.
- **Findings:** the page drops the project frame (the breadcrumb shows only "DEMO-1 Checkout…"). "Run on: not claimed
  yet" beside "Status: Running". "Now: Needs you" with no link to what it needs. The *Context pack* tab name →
  "What the agent was given".

### S06 Inbox `/inbox`
- **Who:** anyone with something waiting. **Q:** *What waits for me, oldest first?*
- **Primary:** per row. A question can be answered in place (keep). An approval row says what it approves ("Plan for
  DEMO-1 · size M · 6 files") and its verb is *Review plan*.
- **Intro:** "An item that expires leaves this list." → lead with what the list is: "Questions and approvals waiting for a
  person, across all projects."

### S07 Agents `/agents`
- **Who:** P1, P2 watching. **Q:** *Who is working on what right now?*
- **Primary:** today *Open inbox*, which is another screen's job and duplicates *Needs you*. Drop the primary (the map is
  the content). Keep the *Needs you* node, linking to the Inbox.

### S08 Workers `/workers` (owned by the worker round; checked, nothing new)

### S09 Integrations `/integrations`
- **Who:** P4, and P2 when something fails. **Q:** *Are the systems we depend on working, and what is each one for?*
- **Primary:** *New integration* (keep).
- **Rows (F4):**
  - a provider icon;
  - grouped by what it does for a project: *Tickets* (Jira), *Code & merge requests* (GitLab), *Chat* (Slack),
    *Errors* (Sentry), *Logs* (Loki);
  - "Used by **Autix**", linking to the project (more than two projects: "Autix, Demo +2");
  - health that is true **now**.
- **Health:** today `integrations.health` is written only by *Test connection* (`apps/server/src/queries/integration-queries.ts:43`),
  so "Healthy · checked 57 d ago" is a 57-day-old opinion. Health should come from traffic: the last successful
  outbound call or inbound delivery in `integration_actions`/`inbox`. When nothing has happened recently, the row says
  "Not checked recently" and offers *Test again* in the row.

### S10 Integration detail `/integrations/$id`
- **Q:** *Is this one working, and what would I change?*
- **Findings:**
  - Raw config keys show as chips beside their labels (`site_url`, `user_email`); drop them.
  - "Credentials are not shown: the server keeps them sealed and publishes only the rest" → "Secrets are stored
    encrypted and never shown."
  - "Refused deliveries" → "Rejected webhooks".
  - The projects list sits at the bottom and needs each project's role ("Autix — tickets from project AUT, label
    `agentic`").

### S11 Statistics `/stats`
- **Q:** *Is the platform worth what it costs?*
- **Findings:** "3 observations" → "from 3 tasks". Each metric needs a one-line reading ("lower is better", or the
  previous period). The date range uses ISO dates while every other screen uses "Sep 10, 2026".

### S12 Audit log `/audit`
- **Q:** *Who changed what?*
- **Finding:** "changed a project's settings: Autonomy level" doesn't name the project, and there is no project filter.

### S13 Org settings `/settings/*`
- **Lands on** *Session* (who you are), the least useful page. It should land on *Policies*, or on the first section the
  role may change.
- **Names:** "Dead letters" → "Stuck events", "Failed jobs" → "Failed background jobs", "Provider identities" →
  "Linked accounts" (the census, § 4).
- **Policies:** the copy says "baseline intersected with this list" and "dial position". Rewrite it in outcomes.

### S14 Project Knowledge `/projects/$key/knowledge`
- **Who:** P3, P2. **Q:** *What do agents know about this project, and what changes wait for my OK?*
- **Order:** proposals waiting for you first. The health pass ("dangling link", "nightly hygiene pass") comes second.
- **F2:** *Approve* sits on the row with the change collapsed ("The change and its evidence"). Show the diff open, or
  make the row verb *Review*.
- "significance 0.72" → drop it, or say "high/medium/low".

### S15 Project Pipeline `/projects/$key/pipeline`
- Keep it. "Gate", "System step" and the return-loop labels are the census's (F6).

### S16 Project Budgets `/projects/$key/budgets`
- **Q:** *How much has this project spent against its cap, and on what?*
- **F8:** it reads the cap but sends you to Settings to set it, and has no breakdown by stage or task. Move the cap editor
  here and add the per-stage and top-tasks breakdown (product/10 § IA).

### S17 Project Shadow `/projects/$key/shadow`
- **Q:** *How would agents have done on tickets we already shipped?*
- **F7:**
  - Three states stack: the "A batch cannot be started for this project" notice, a red "could not be loaded / not found"
    and the empty state. It should be one.
  - Rename it *Trial run* (tab: *Trial*).
  - Show it as a tab only while the project has no live tasks or has a trial; otherwise reach it from Settings.

### S18 Project Settings `/projects/$key/settings/*`
- Already a NavList (S-23). Census items: "bindings", "slot", "Policies & WIP", "probation", "Verification: In force:
  local".

### S19 New project `/onboarding`
- **F11:** step 1 asks for *Key*, *Name*, *Repository URL* and *Default branch*, in that order.
  - Ask for the repository first, then propose the name, the key and the default branch from it.
  - The key's hint ("it ends up in addresses and branch names") then explains a default instead of a riddle.

### S20 Sign-in, not found, palette: no new findings.

## 3. Information architecture

**Top navigation today:** nine items in one row — Home, Projects, Inbox, Agents, Workers, Integrations, Statistics,
Audit log, Settings. Three of them (Workers, Integrations, Audit log) are **setup and oversight**, visited weekly by one
persona. The other six are daily.

**Proposal (S-25.6):** keep Home, Projects, Inbox, Agents, Statistics. Move Integrations, Workers and Audit log into
one *Admin* group: a NavList section of Settings, or a trailing "Admin ▾" menu. The decision is the owner's (Q-UX-1).

**Duplicated paths** (each answers *what waits for me*):
- Home *Needs you*;
- Inbox;
- the Agents page's *Needs you* node and its *Open inbox* primary;
- the board's *Needs you* column;
- the task's Checks header.

Keep them, but make all five read the same rule and use the same verbs.

**Missing paths:**
- Home *Spend* → the budgets screen;
- a project row → its waiting items;
- an integration row → its projects;
- a run page → its project frame;
- an approval → its plan.

**What Home leads with, per persona:** *Needs you* first, for everyone. Then P1 sees spend against cap, P2/P3 see their
running tasks, and P4 sees integration and background health. Home is not personalised by role today. With F14, the
operator rows come from the same *Needs you* box, shown only to admins.

## 4. Jargon census

The table lists the terms a person sees, with a plain-words replacement and where each is defined. Sources are
`apps/web/src/…`; the full table with file:line is in the S-25 PR description.

| Term on screen | Where | Plain words | Defined? |
|---|---|---|---|
| L0–L4 · Unverified/Basic/Reliable/Agent-ready/Autonomous-capable | `features/readiness-label.tsx:14-28` → header, Projects, Home | what it means now: *Plans need your OK* (L0), *Plans need your OK for big tickets* (L1–2), *Agents plan on their own* (L3+); the level name in a popover | no |
| ✕ red for L0 | `readiness-label.tsx:27` (`failure`) | neutral tone; L0 is the normal start | — |
| Autonomy dial, Observe/Assist/Supervised/Autonomous, probation | `features/operating-mode.tsx:100-111,379` | *How much agents do alone*; probation → *extra checks on the first N tasks* | partly |
| Shadow, shadow batch, claim (shadow) | `app/project-frame.tsx:76`, `features/shadow.tsx:494-544`, `ticket-claim.tsx:28-41` | *Trial run on past tickets* | intro only |
| Gate, System step, advisory | `viz/flow/stage-card.tsx:58-61` | *Automatic check* | partly |
| Loop badges: Review 2/3, Re-checks, Conflict fixes, Review rounds | `ui/humanize.ts:282-292`, `board-card.tsx:119-128` | *Review round 2 of 3* | no |
| "costs an iteration of the loop" | `task-dialogs.tsx:396` | *uses one of the 3 review rounds* | no |
| Tamper check, protected paths | `task-checks.tsx:308`, `task-checks-text.ts:370` | *Protected files untouched* | yes, but long |
| Rebase status, rebase gate, CI gate | `task-checks.tsx:317-321`, `board-card.tsx:284` | *Up to date with main*, *CI* | partly |
| Coverage delta +2.5 pp | `task-checks-text.ts:123` | *Test coverage +2.5 points* | yes |
| Risk classes (raw slugs) | `task-checks.tsx:403-411` | *Sensitive areas touched* | no |
| converged, escalated (undecided), dead_lettered | `stage-outcome.ts:32-50` | *Needs you: checks ran out* … | no |
| Context pack | `run-detail.tsx:164,874` | *What the agent was given* | no |
| Steer / steers | `transcript/view.tsx:256`, `task-checks-text.ts:63` | *Message the agent* | no |
| local provider mode | `run-detail.tsx:286`, `cost-text.ts:29` | *on a Claude subscription, cost is estimated* | uses itself |
| redacted / N redactions | `task-artifacts.tsx:58` | *N secrets hidden* | no |
| workpad | `take-over.tsx:377` | *the ticket's progress comment* | no |
| Take over / Hand back | `take-over.tsx:262,271` | *Work on it yourself* / *Give it back to the agent* | no |
| bindings, slot, pick-up rule, WIP | `onboarding-connect.tsx:207-225`, `ticket-lifecycle.tsx:70`, `board.tsx:162` | *connections*, *status*, *start rule*, *parallel tasks* | slots yes |
| vault, proposals, in no context pack, significance 0.72 | `project-panels.tsx:78,308,348` | *knowledge base*, *suggested edits*, *never given to agents*, drop the number | no |
| Policies & WIP, Verification: In force: **local** | `settings-sections.ts:91`, `verification-mode.tsx:63,75` | *Rules & limits*, *Checks run by: agents* | partly |
| Dead letters, Failed jobs, Provider identities, re-queue | `settings-sections.ts:56,62`, `dead-letters.tsx:121` | *Stuck events*, *Failed background jobs*, *Linked accounts*, *Try again* | intro |
| Raw config keys `site_url` | `integration-detail.tsx` | drop | — |
| Raw `Role: admin`, `project.status`, `integration.type` | `app/shell.tsx:156`, `project-frame.tsx:191`, `onboarding-connect.tsx:145` | the existing label maps | no |
| Model ids `claude-opus-5` on Home and Agents rows | `dashboard.tsx`, `viz/flow/stage-card.tsx:105` | keep them on run and pipeline pages; on Home show the activity | no |

**Server-written text is not covered by any spec-reference census.** It reaches the screen verbatim and could still
carry `WP-`/`TD-` references:
- readiness `notice.message`;
- `escalation.reason` and `brief`;
- shadow `blocked`;
- `findings_unrecorded.reason`;
- worker `state.reason`;
- `withheld.reason`.

`apps/server/src/queries/user-facing-copy.test.ts` lists one string. → BACKLOG.

## 5. Findings, ranked

| # | Grade | Screen | Finding | Fix | Doc amendment |
|---|---|---|---|---|---|
| **F1** | **blocker** | Task (L1, S04), Home (S01), Inbox (S06) | An approval offers *Approve* without its subject. The plan is an artifact nobody links to. The Home verb "Approve" opens a page. `features/task-callout.tsx:130-190`; `ApprovalRecord` has no subject (`packages/contracts/src/records.ts:109`). | The approval names its subject (artifact + version, the budget numbers, the proposal). The card renders it inline, with *Read the whole plan* expanded by default for a plan. *Approve* says what happens next. The header's duplicate *Approve…* opens the same card. Home and Inbox say *Review plan*. | product/10 Task detail + Questions inbox; technical/02 approval record; a short TD (architect) for `subject` |
| F2 | major | Knowledge (S14) | A proposal can be approved with its change collapsed. The health notice outranks the waiting proposals. | The change is open on the card, the verb is *Review*, and proposals come first. | product/10 Knowledge |
| F3 | major | Projects, header, Home (S02) | "✕ L0 Unverified": an internal ladder, red for the normal starting state. | The badge says what agents may do; neutral for L0. A popover gives the meaning, the next level, what unlocks it (the top missing criterion with its how-to), and a link to *Discovery & readiness*. | product/17 § "Where it shows up" (red badge → neutral) |
| F4 | major | Integrations (S09, S10) | Health is the last manual probe ("Healthy · checked 57 d ago"). "Used by 1 project" is unnamed. No identity per provider. | Health from traffic, with a stale-probe rule and *Test again*. Provider icons (inline SVG). Grouped by role. Project names linked. Raw keys dropped. | product/08 § Health + integration identity |
| F5 | major | Task, Board (S03, S04) | Three different "needs you" rules (column, pill, card). Ticket/MR links at the bottom. Three pipeline drawings. *Ask the task* errors on an absent thread. The Checks header duplicates the callout. | One `needsYou` rule; links in the header; timeline = the canvas's list mode; an absent thread = the empty state; Checks counts gates. | product/10 Board + Task detail |
| F6 | major | Board, Checks, Pipeline | Loop, gate, tamper, rebase and risk-class jargon (§ 4). | One humanize pass + `title`/popover definitions. | product/10 UX rules (a glossary line) |
| F7 | major | Shadow (S17) | Three contradictory states; the name. | One state; rename *Trial*; tab only when relevant. | product/10 IA (Shadow → Trial) |
| F8 | major | Budgets (S16) | The cap is read here and set elsewhere; no breakdown. | Cap editor here; per-stage and top-task breakdown; link from Home *Spend*. | product/10 IA |
| F9 | major | Frame | Nine top items; the run page drops the project frame; Agents' primary is another screen's. | An Admin group (Q-UX-1); the run inside the project frame; drop Agents' primary. | product/10 IA |
| F10 | minor | Home | Setup checklist: step 1 current while 2–5 are done; it stays on a working install. | Hide once a ticket has run unless something is missing, and say what the missing piece costs ("no git host: merge requests can't be opened"). | — |
| F11 | minor | New project | Key before repository. | Repository first, then derive name, key and branch. | product/06 Step 1 |
| F12 | minor | Integration detail | Raw keys, "sealed", "Refused deliveries". | Words (§ 2 S10). | — |
| F13 | major | Run (S05) | The amber primary is *Cancel run*. "not claimed yet" beside *Running*. "Needs you" without a link. | Cancel → secondary (danger); seat word fixed; link to the waiting item. | product/10 Run detail |
| F14 | minor | Settings, Home | Background failures are invisible outside Settings. Settings lands on *Session*. | Operator rows in *Needs you*; land on the first changeable section; rename. | — |
| F15 | minor | Statistics, Audit | "observations"; no reading direction; ISO dates; the audit doesn't name the project. | Words, "lower is better", project names + a filter. | — |
| F16 | minor | Inbox | The intro leads with expiry. | Lead with what the list is. | — |
| F17 | minor | Project settings | Dial/probation copy explains jargon with jargon. | Rewrite in outcomes. | product/19 § 11 (preset wording) |
| F18 | minor | server copy | Server-written strings outside every spec-reference census. | Extend `user-facing-copy.test.ts` to each field listed in § 4. | — |

## 6. Proposed slices (M25)

Order: F1 first, alone. Then slices that touch different files run two at a time.

| Slice | Covers | Touches | Risk |
|---|---|---|---|
| **S-25.1** Approvals show what they approve | F1 (+ the Home/Inbox verbs) | contracts (approval `subject`), server projection + the place approvals are requested, `task-callout.tsx`, `task-header.tsx`, `dashboard.tsx`, `inbox.tsx`; architect: a ≤ 1-page TD amendment | high (authz-adjacent: who decides what) |
| **S-25.2** Readiness says what it means | F3 | `readiness-label.tsx`, project header, Projects, Home, a popover; product/17 | low |
| **S-25.3** Integrations: identity, true health, who uses it | F4, F12 | `integrations.tsx`, `integration-detail.tsx`, a new `ui/provider-icon.tsx` (licences checked), the server's integration summary (health from `integration_actions`/`inbox`) | medium |
| **S-25.4** One "needs you", and the task page's order | F5, F13 | `ui/task-status.ts`, `board.tsx`, `task-header.tsx`, `task-overview.tsx`, `task-checks.tsx`, `ask-thread.tsx`, `run-detail.tsx` | low |
| **S-25.5** Plain words | F6, F17, the § 4 table, F16 | `ui/humanize.ts`, `task-checks*.ts`, `stage-outcome.ts`, `operating-mode.tsx`, `project-panels.tsx`, `settings-sections.ts` + a census extension (F18) | low |
| **S-25.6** Navigation and homes | F9, F10, F14, Home per persona | `app/shell.tsx`, `routes/tree.tsx`, `dashboard.tsx`, `home-setup.ts`, `agents.tsx` | medium (the nav census changes) |
| **S-25.7** Budgets, Trial, Knowledge, Stats | F2, F7, F8, F15 | `project-panels.tsx`, `shadow.tsx`, the budgets panel, `statistics.tsx`, `audit.tsx` | low |
| **S-25.8** New project starts from the repository | F11 | `onboarding.tsx`, `onboarding-connect.tsx` | low |

## 7. Questions for the owner — answered 2026-11-06

The owner accepted all four recommendations (*"accept your recommendations based on reasoning"*). On F1 they added:
*"the goal of the whole platform is to avoid plan approval because the refinement and proposals should be that good — but
maybe that is exactly what the plan approval is for."*

Both readings hold. BD-006 already rejected "always approve plans" because *humans stop reading*: an approval is
meant to be the exception, and it should retire itself as trust grows (probation ends, readiness rises, the size
threshold moves). The platform decides it in `requiresPlanApproval` (`packages/domain/src/policies/autonomy.ts:241`),
which returns only a yes or a no, so nobody can see why they are asked or how to stop being asked. S-25.1 therefore
shows three things on the card: the **subject**, the **reasons**, and **how to retire each reason** (BD-006's
2026-11-06 amendment). A blind approval is a defect. An unexplained approval is the reason approvals never go away.

- **Q-UX-1** (IA): move Integrations, Workers and Audit log out of the top row into an *Admin* group? Recommended: yes, as
  a NavList section of Settings, so the top row is the five daily screens.
- **Q-UX-2** (readiness words): name a level by **what agents may do** ("Plans need your OK"), keeping the ladder's name
  in the popover? Recommended: yes.
- **Q-UX-3** (Shadow): rename it to *Trial* and show the tab only before the first live task or while a trial exists?
  Recommended: yes.
- **Q-UX-4** (approvals): should *Approve* stay disabled until the plan was opened, or is showing the plan inline (open by
  default) enough? Recommended: inline and open is enough; a disabled button reads as broken.

## 8. Provider icons — sources and brand terms (retrieved 2026-11-06)

The owner asked for an icon per provider. Each brand's own terms were read before choosing a source.

| Provider | Simple Icons 16.36.0 (CC0 paths) | The brand's terms for a logo inside a third-party UI |
|---|---|---|
| GitLab | present (`gitlab`) | "Use of the Logos is not permitted under these Guidelines". UI and integration requests are "generally refused". The name may be used with the trademark statement (handbook.gitlab.com … /trademark-guidelines/, revised 2026-10-28). |
| Jira | present (`jira`) | Allowed only unmodified, from Atlassian's own files, resized at most. A re-drawn or recoloured path does not qualify (atlassian.design/foundations/logos). |
| Slack | **removed** (Salesforce brands, PR #13503, 2025-11-29) | "Most uses require a specific written license"; "don't use different colors" (slack.com/media-kit). |
| Sentry | present (`sentry`) | No published third-party rules were found (sentry.io/branding). Unverified. |
| Loki | **absent** (request #12138 open) | Grafana Labs: no colour changes; covers its own projects only; a non-affiliation statement is required (grafana.com/trademark-policy). |

**Decision (S-25.3).** Every provider gets an **Octicons glyph for its role**, with the provider's **name as text** beside
it:
- GitLab: `GitMergeIcon`;
- Jira: `IssueOpenedIcon`;
- Slack: `CommentDiscussionIcon`;
- Sentry: `BugIcon`;
- Loki: `LogIcon`.

These glyphs are `@primer/octicons-react` (MIT), already a dependency and already in `THIRD_PARTY_NOTICES.md`, so the
notices are unchanged and nothing is vendored. The integrations screen and the user guide carry one line: *"GitLab,
Jira, Slack, Sentry and Loki are trademarks of their respective owners; this project is not affiliated with or endorsed
by them."*

Two alternatives were rejected:
- **Brand logos.** They are refused by GitLab and Slack and constrained by Grafana and Atlassian, and a monochrome
  re-colour is exactly the "colour change" three of them forbid.
- **Jira's real logo alone.** One brand mark among four glyphs reads as inconsistent.
