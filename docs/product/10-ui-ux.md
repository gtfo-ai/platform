# 10 — UI and UX

Goal: someone who has never used the platform understands within a minute what is happening, what it costs, and how to intervene. The UI is a **control tower**, not a chat.

> **Amendment 2026-11-06 (product owner, research/21, M25).** *Every screen answers one question, and a decision is
> made with its evidence on screen.* Each screen states who it is for, the one question it answers, its primary action
> and what happens after it. research/21 § 2 is the intent card per screen, and it is authoritative for M25. Nobody
> approves, accepts or rejects anything they cannot see from where the button is. A state word says what it means for
> the reader, not where the state sits on an internal ladder.

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

> **Amendment 2026-11-06 (Q-UX-1, Q-UX-3, M25).**
> - **Top row.** The top row holds the five daily screens: Home, Projects, Inbox, Agents and Statistics. Integrations,
>   Workers and the Audit log are an *Admin* section of org Settings, and their URLs keep resolving.
> - **Run pages** sit inside their project's frame.
> - **Shadow** is shown as **Trial** ("a trial run on tickets you already shipped"). Its tab appears only before the
>   project's first live task or while a trial exists; otherwise it lives under project Settings.
> - **Budgets** is where a project's cap is both read and set, with the per-stage breakdown and the top tasks.
> - **Home** leads with *Needs you* for everyone. Background failures (stuck events, failed jobs) appear there as rows
>   that only an administrator sees. The setup list hides once a ticket has run, unless something is missing; then it
>   says what is missing and what that costs.

## Key screens

### Board (project)
- Columns = stages (from the project's pipeline template) plus `Queued`, `Needs human`, `Done (7d)`.
- Card: ticket key + title, template icon (feature/bug/chore/spike), running-agent pulse, cost so far, time in stage, iteration counter (e.g. "review 2/3"), question badge.
- Drag is *not* supported (state is owned by the pipeline); actions are on the card menu: pause, cancel, return to stage, open ticket, open MR.
- *Amended 2026-11-06 (M25).* The *Needs you* column, the card's badge and the task header's state read **one** rule: a
  task with an open question, a pending approval, or the `needs_human` state needs you, whatever its stage. Loop
  counters read as rounds ("Review round 2 of 3").

### Task detail
- Left: vertical **stage timeline** with status, duration, cost per stage, returns drawn as loops with reason.
- Centre: **artifacts** tab (Refined Spec, Plan, RCA, Review Verdicts, Retro) rendered markdown with version history; **runs** tab; **questions** tab; **events** tab (raw).
- Right: **Checks** panel — merge-readiness at a glance: acceptance criteria met, CI green, rebase status, review threads open/resolved, business verdict, tamper check, coverage delta, dependency status, risk classes and required reviewers, budget vs estimate, questions pending (research/01: Conductor); cost breakdown donut (per stage), budget bar, links (ticket, MR, Slack thread), actions.

*Amended 2026-11-06 (BD-006 amendment, M25).*
- **Approvals.** A pending approval is shown **with its subject**: the plan itself, open (summary, size, files, risks),
  or the budget figures, the rework's reason or the knowledge change. It also says:
  - **why it was asked**, as the reasons the platform recorded (probation task *n* of *N*, the size threshold, a risk
    class, a project that always asks);
  - **what each answer does next** (*Approve*: Implementation starts; *Reject*: back to Architecture with your
    reason);
  - **how to stop being asked** for that reason, linked to the setting that retires it.

  Approvals are meant to become rarer as trust grows: the card is where that trade-off is visible. Home and the Inbox
  never approve in one click. Their verb is *Review plan*, and it opens the card.
- **Header.** The ticket and merge request links sit next to the ticket key.
- **Stages.** The stage timeline is the list mode of the Flow canvas, not a second section.
- **Checks.** The panel counts checks; questions and approvals are the callout's.

*Amended 2026-11-07 (product owner, after a CI failure on an agent's merge request, M25 S-25.11).* **A task that went
back says why it went back, and what happens next.** A gate's failure (CI, the rebase, the dependency policy) or a
reviewer's return sends the task to an earlier stage. Until that stage ends, the task header's *Now* line and the
callout's slot carry one sentence. It names the cause, who acts, and how many tries are left:
- **The agent is on it:** "CI failed on the merge request (job *unit*): the Developer is fixing it (round 2 of 3)." The failing job
  is linked by name (through `safeHref`). There is no action, because nothing is asked of the reader.
- **It stopped:** when the rounds are used up, or the same failure came back (three times in a row for CI, product/04
  S4), the escalation says which one. "CI failed the same way three times in a row (job *unit*), so the agent stopped." The one next step follows it: look at the job,
  then *Retry* or *Take over*.
- **The board card** shows the same fact in short form ("CI failed · fixing, round 2/3"). The stage timeline draws the
  return as a loop with its reason, as above.
- A return whose reason was not recorded says so ("went back from CI; the reason was not recorded"). It never
  guesses.
- **While a gate waits, it says what it is waiting for, from the first read.** The case that prompted this is
  AUT-6655. GitLab held its pipeline at a manual job, the platform waited 60 minutes twice, and the page showed only
  "CI" and *Needs you*. The waiting gate's last read is shown on the task header, the callout and the board card while
  it waits, not only after the timeout:
  - a pipeline held at a manual job: "CI is waiting for someone to start the manual job *sentry-release-commit* in
    GitLab. Start it there and the task continues." The job and pipeline are linked through `safeHref`. When the
    platform keeps the merge request a draft and the project's CI rules hold jobs for drafts, it adds a link to the
    readiness panel's CI-rules warning;
  - a pipeline still running: "CI is running (pipeline *n*, 12 min so far; the task gives up after 60)".
  This is *Needs you* the moment a person's action is the only way forward (a held manual job is that), with the one
  next step. It is not *Needs you* after the timeout.
- **A timed-out wait says it timed out**, with the last read: "CI did not finish within 60 minutes: pipeline *n* was
  still held at the manual job *sentry-release-commit*." The next step is *Start the job in GitLab, then Retry*. The
  task page never reads as a failed check when nothing failed.
- **A Retry on a pipeline that is still held does not wait again.** It stops at once and says why: "The pipeline is
  still held at the manual job *sentry-release-commit*, so Retry did not wait again. Start the job in GitLab, or change
  its rule, then Retry." This is the worker session's #89, `ci_held_unchanged`.
- *Amended 2026-11-07 (S-25.12).* All of the above is built from the gate's **structured read**, never from its
  recorded sentence: the pipeline and its link, the held job and its link, the draft flag, minutes waited, the
  timeout. That means `gate_wait` while the wait is open, and `last_gate_wait` on the attempt an escalation came from.
  A task whose read was never recorded (any attempt before #89) falls back to the recorded sentence, introduced as
  "What the platform saw last:".

*S-25.11's wording (2026-11-07).* The examples above say **round**, not *try*: the vocabulary census retires "try N" for
*Attempt N* (S-23.23), and the board's loop badge already calls this counter a round ("CI fix round 2 of 3"). The
repeated failure is **three** identical CI failures in a row, which is what the pipeline counts (product/04 S4,
`ciConvergence`), not two. A CI failure's return still links the merge request rather than the failing job, whose URL
the return's row does not record. A timed-out check whose attempt recorded no read (before #89) still says it "did not
finish in the time the platform waits for it", followed by the sentence the platform recorded; since S-25.12 every
other waiting or timed-out check is worded from its read, as above.

### Run detail (the "click and watch" requirement)
- Header: stage, role, model, effort, permission mode, tokens (in/out/cache), cost (live estimate → final), turns, elapsed.
- *Amended 2026-11-06 (M25).* While a run is live, watching is the job: *Cancel run* is a danger secondary, never the
  page's amber primary. When the run waits on a person, the page links to what it waits for.
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
- *Amended 2026-11-06 (M25).* The proposals waiting for the reader come first. A proposal is approved with its change
  open on screen, never collapsed under the button.

### Ask the task
- A thread on the task page (and mirrored in the ticket thread) where anyone with access can ask "why did you choose X?"; answered from the audit trail and artifacts with links to the exact run and prompt.

### Questions inbox
- Card per pending question: project, task, stage, question text with context, suggested answer if the agent proposed one, answer box, "answer in Jira/Slack" links (all channels are equivalent; first answer wins, others get a note).

## UX rules

- Every number shown has a tooltip with its definition (cost = provider reported; estimated = price table).
- Every agent output is one click away from the prompt that produced it.
- Never block a human on a modal for agent activity; the pipeline is asynchronous and the UI reflects that.
- Empty states teach: an empty board explains how tasks get picked up and links to the rule config.
- Dark theme (one theme; see the amendment below), keyboard navigation, responsive to laptop widths (mobile read-only later).
  > **Amended 2026-11-05 by the product owner (TD-033 amendment):** one theme only: the brand's dark theme. There is no light
  > theme and no theme switch.
- Live updates everywhere (no refresh), but with a "paused updates" indicator when scrolling a transcript.
- Language: English UI; user content shown as-is.
- *Amended 2026-11-06 (M25).* **Plain words.** An internal term (gate, loop, tamper check, binding, slot, context pack,
  dead letter, readiness level numbers) either has a plain-words replacement on screen, or carries its definition one
  hover or one keypress away. research/21 § 4 is the census.
