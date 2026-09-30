# User guide

> What the product does, screen by screen, and what it does **not** do yet. The companion is the
> [operator guide](operator-guide.md), which is about installing and running the instance.
>
> Every "not yet" below is read off the code rather than remembered: the screens themselves say what
> they cannot show, and the one endpoint the application calls that the server does not serve is
> named in `apps/server/src/routes/client-census.test.ts`, a test that fails if this list goes stale
> in either direction.

## The shape of it

A ticket in your tracker becomes a task. The task walks a pipeline of stages, each run by a
role-specialised Claude Code agent in its own container, and ends at a merge request a human reviews
and merges — the platform never merges ([BD-007](decisions/business/BD-007-human-merges.md)). Along
the way it asks questions, requests approvals, spends a budget you set, and writes what it learned
back to the project's knowledge base as proposals you accept or reject.

You can watch all of that, and intervene at any point, from the browser.

### Signing in, and what your role lets you do

Open the instance's URL. Sign-up is off by default on a self-hosted instance; the first
administrator is created from the environment at boot and everyone else is invited by an
administrator.

Four roles, increasing: **viewer** reads, **member** answers questions and drives a task,
**maintainer** approves, **admin** manages integrations and users. Every action is checked on the
server on every request — the browser only hides what you cannot do.

| You want to | You need |
|---|---|
| read boards, tasks, runs, budgets, the knowledge base | viewer |
| answer a question, pause/resume, retry a stage, cancel a run, leave feedback, ask the task | member |
| approve a plan or a budget, cancel a task, return it to a stage, rework it, decide a knowledge proposal, set budgets, run discovery | maintainer |
| create a project, add an integration, manage users | admin |

### The top navigation

**Dashboard · Agents · Inbox · Integrations · Onboarding · Statistics · Audit log · Settings**, and
from the dashboard, into a project: its **board**, **knowledge**, **pipeline** and **budgets**.

Screens that show live data subscribe to a server-sent event stream, so agent counts, task states
and transcripts move without a refresh.

## 1. Onboarding a project — the wizard

**Onboarding** in the top navigation. Five steps, each of which is also reachable on its own, so
"finish later" leaves a checklist rather than a dead end. The wizard is **resumable because its state
is the server's**: which project exists, which integrations are bound, whether discovery has run.
Close the tab at step 3 and come back to the same place.

### Step 1 — Connect

Give the project a **key**, a name and a repository URL, then attach the integrations it uses.

The key is a lower `snake_case` slug — `^[a-z][a-z0-9_]*$`, so `acme_web` and not `Acme-Web`. It ends
up in URLs and branch names, and it is checked in the browser before anything is sent: a key with a
capital or a hyphen produces an inline error and **no request**, which is easy to mistake for a
button that did nothing.

Then: the integrations the project uses. This step **binds and tests** them; it does not create them.
An integration has to exist first: an admin creates it on the **Integrations** screen (section 9) or
with the request in the operator guide's §4. Once one exists it appears here as a checkbox, "Test connection" makes one real call to the provider and records the
result, and "Bind" attaches it to this project. A wrong token is therefore a red badge here rather
than a failed run tomorrow.

You never paste a credential into the browser, at any point. What is named is the *environment
variable* the server should read, and the server seals the value itself.

### Step 2 — Technical discovery

Starts the **Discovery agent** on the repository. It is a normal agent run in every respect — it has
a budget, a transcript you can watch, a cost entry, and it escalates to a human if it fails — and it
produces two things:

- a **readiness evaluation**: fourteen criteria and a level from 0 to 4
  ([product/17](product/17-repository-readiness.md)), with the three cheapest improvements named;
- **drafted knowledge pages**, which arrive as proposals rather than as commits.

Three of the criteria are the platform's own answer and are never taken from what the model claims,
and the "what this unlocks" text is the platform's, never the agent's. The discovery agent's shell
reads the repository and runs the project's own declared commands — its test, lint and setup
commands (including an executable `.agentic/workspace/setup`, run as `./.agentic/workspace/setup`),
and the lockfile install they need — so R1, R2 and R6 are answered by running them. The install
can fetch only from a package registry your operator declared (`APP_RUN_REGISTRY_HOSTS`, empty by
default). On an instance that declared none, the egress proxy refuses the install's requests, so a
repository whose tests need dependencies cannot run them. It cannot
commit, push or add a dependency, and nothing it writes is kept. It drafts **technical** pages only;
the business pages are step 3's.

**Readiness is re-checked after every merge onto the default branch** — a merged task, a merged
knowledge proposal — without running an agent. The re-check re-answers seven criteria and carries the
other seven from the previous evaluation, saying so in each one's evidence (*"carried from the
discovery evaluation of …"*):

| Re-answered after a merge | How |
|---|---|
| R9, R11, R12 | the platform's own answers, as at discovery (git provider, bindings, the index) |
| R8 | `CLAUDE.md` and `AGENTS.md` read at the merged commit: present, at most 200 lines, naming `<knowledge dir>/index.md` |
| R10 | passes when a merge request template (`.gitlab/merge_request_templates/Default.md`, or `pull_request_template.md` at the root, in `docs/` or in `.github/`) **and** a commitlint configuration file are both present at the merged commit; otherwise carried |
| R13 | passes when `.pre-commit-config.yaml`, `lefthook.yml`, `.husky/pre-commit` or `.gitlab-ci.yml` **runs** a secret scanner (gitleaks, trufflehog, detect-secrets, ggshield, secretlint): a pre-commit hook of that scanner, or a command line that starts with it; or `.gitlab-ci.yml` includes GitLab's secret-detection template without switching it off. Merely mentioning a scanner does not count. Otherwise carried |
| R3 | passes when the platform has stored a pipeline event for a merge request in the last 30 days; otherwise carried |

R10, R13 and R3 are never *failed* by a re-check: a template under another name, a scanner in a
GitHub Actions workflow or a convention written in prose is invisible to the files the platform
reads, so a miss keeps the previous answer. R1, R2, R4, R5, R6, R7 and R14 need a run, so they keep
the latest discovery's answer. **To have them answered again, press *Re-evaluate readiness*** on the
project settings page (maintainers): it runs the Discovery agent again as a new task, with the same
budget cap, cost accounting and transcript as the first run, and records its evaluation as a
*re-evaluation* beside the earlier ones. The button shows the run's budget cap (a ceiling, not a
prediction) and what the last discovery cost; it is off, with the reason, while a discovery is
running or parked, before the first discovery, and after three re-evaluations in a row recorded
nothing. A project that was never evaluated is not re-checked: the readiness panel keeps saying
there is no evaluation until discovery runs.

### Step 3 — Business interview

[product/19](product/19-operating-definitions.md) §8's eight sections — product, users, business
rules, glossary, direction, quality bar, review expectations, communication — as a form. Each is
optional: leave it empty to skip it, or tick **Not applicable** (with an optional reason). The same
form is on the project settings page under *Business context*.

Submitting writes **proposals, not pages**: each answered or not-applicable section becomes one page
under `business/` in the knowledge proposal queue, where a maintainer edits and approves it, and
approving it opens a merge request like any other proposal. Nothing is committed from the form. The
page is your own words under the platform's headings — no agent rewrites them. Answers are cut at
12 000 characters (a not-applicable reason at 1 000), credential-shaped strings are redacted before
anything is stored, and a cut is announced in the page.

Seven of the eight pages are knowledge-completeness sections, so once they are merged the score
moves by 7/10 (communication is not scored); with at least one technical page — which discovery
drafts — that is above R12's 70 %, and the re-check after the merge records it. product/06 describes
the step as a *conversation* with the Product Manager role in your language; this build ships the
question bank as a form instead (Q102 in the open questions).

### Step 3b — History bootstrap (optional)

Mines the project's merged history into knowledge proposals ([product/19](product/19-operating-definitions.md)
§18): the last N merged merge requests (default 200, at most 1 000) of the last six months, with
their review threads, plus closed tickets and commit messages. It shows the estimated cost and the
cap before you start, runs one agent per twenty merge requests, and everything it finds lands in the
knowledge proposal queue with the merge requests it cites — nothing is applied without a
maintainer. The same panel is on the project settings page.

Each batch shows how many of its runs have reported, what they proposed and refused, what it
spent — and **how much the runs say they read**: *"the runs that reported a count read 37 of the 200
merge requests they were shown"* — the 200 is what those runs were shown, not the whole batch. That count is the agents' own claim, not something the platform checked, and it is shown
as the two numbers rather than a percentage; a batch whose runs read only part of what they were
given has mined only part of the history, and a re-run reads everything again at full cost. *"No
mining run has reported how many merge requests it read yet"* means exactly that, not zero. The
ticket half is small by design: a batch reads five closed tickets per twenty merge requests — 50 at
the default N — and which ones is the ticket tracker's order, not the platform's.

### Step 4 — Operating mode

The autonomy dial ([product/19](product/19-operating-definitions.md) §11), four positions:

| Position | What it means |
|---|---|
| **Observe** | nothing is picked up; shadow runs only |
| **Assist** | scoping only — the agent stops after architecture |
| **Supervised** *(default)* | plan approval above size L, probation on |
| **Autonomous** | no plan approval except for risk classes; still never merges |

Choosing one writes the project's configuration.

**What a position does to a task.** Moving the dial affects a running task only in part. Three
policies are **fixed when a task starts** and do not move with the dial afterwards: whether business
review runs, Assist's stop after architecture, and the number of human review rounds. The rest are
**read when they are used**, so a move reaches running tasks too: plan approval and probation (at
the moment a plan is ready), the budget-approval threshold (when refinement finishes), the question
timeout (when a question is asked) and knowledge auto-apply (when a proposal is curated). **Assist**
parks a task in *Needs human* after architecture, with a brief that names the dial; hand it back at
*Implementation* to continue, or cancel it — after a maintainer has approved its plan, because
Assist asks for plan approval on every task. A ticket whose pipeline has no architecture stage (a
chore) parks before anything runs, since there is no point at which it could stop before code is
written. Assist also turns the business-review stage off, so a task handed back past the park skips
it. **Autonomous** allows five human review rounds on a merge request where the other positions
allow three, and auto-applies knowledge proposals in the middle significance band. The project's
**settings** override the dial wherever they set one of `pipeline.limits.human_rounds`,
`pipeline.limits.question_timeout`, `policies.knowledge_apply.auto_apply` or
`policies.probation_tasks`; nothing else overrides it. The repository's own `.agentic/config.yml`
overrides **none** of the four: from the file they are *not applied* (step 5 below says why). The policy list under the dial
marks the two that set nothing by themselves: `review_only` (the Review-only card is the switch) and
`suggested_readiness_min`.

**The dial and the maintenance pipeline.** The dial's *level* applies to scheduled maintenance chores
and its per-stage policies do not. At **Observe** the nightly pass creates no chore — Observe means no
agent merge requests — and the Maintenance card says *Paused at Observe* while the feature is on
(the level in force counts, so an organisation maximum of Observe pauses it too). At **Assist**,
**Supervised** and **Autonomous** each chore runs to a merge request a human reviews, with no dial of
its own: Assist's stop after architecture would otherwise park every chore before it ran.

The same step offers **risk classes** — product/19 §14's six (auth, payments, data, infra,
agent-config, public-api) or what the discovery agent proposed — and applies none until you accept.
Two of them, payments and public-api, require a **review checklist**: a list of review items *you*
write (the platform ships none), given to the reviewer beside its own checks whenever a change
touches that class's paths. The screen asks for each list's items before *Accept* is enabled, because
a class naming a checklist the configuration does not define is refused; the review then records
which lists it was given (`checklists_applied` on the Review Verdict).

**Shadow mode** (the Observe position) runs the pipeline on closed tickets you pick and posts
nothing. For each ticket that has a human merge request it also runs **one reviewer over that human
merge request**, and that review is a task of its own: a card on the board keyed
`mr!<iid>/shadow/<task id>`, in shadow mode, with its own spend counted against the shadow budget. It
posts nothing on the merge request — every comment it would have written is recorded in the audit
log as *would have* — and its findings, with a comparison of which of the agent's own acceptance
criteria each side met, appear on the ticket's shadow report once it ends.

### Step 5 — Commit the knowledge

The proposal queue. The discovery agent's drafts are proposals with source `bootstrap`; approving one
commits it on an `agentic/knowledge/*` branch and opens a merge request — **never onto the default
branch**. Nothing the agent drafted is in your repository until you accept it and merge it.

The *configuration* reaches the repository the same way, from the project's **Settings** page
rather than from the wizard: **Propose these settings to the repository** writes them as
`.agentic/config.yml`, adds a one-line pointer to the knowledge index in `CLAUDE.md`, and opens a
merge request on an `agentic/config/*` branch — never a direct commit onto the default branch. The
button stays on the page, so a settings change made months later is reviewable the same way. The
card shows the last export and its merge request after a reload (as recorded when it was made), and
pressing the button again while that merge request is still open answers it — *no second one was
opened* — instead of opening another; merge or close it first to propose a newer configuration.

**Once that file is on the default branch, it wins — within limits.** The platform reads the
repository's own `.agentic/config.yml` from the default branch (after every knowledge index run,
and when you press **Re-read the repository**). Wherever the file sets an operational key, the
file's value is the one runs use, and the settings answer for keys the file leaves out; the pipeline
screen shows which layer every key came from. Two things to know:

- **A file that does not parse stops the project's runs.** The reading names the key paths it failed
  on, the configuration screen refuses to show a configuration it cannot compute, and a stage that
  would start is parked for a human with the same sentence — until a corrected file is merged and
  re-read. The platform does not quietly run on the settings alone.
- **The file can tighten, never loosen, what agents and reviewers are held to.** It can add
  protected paths, reviewers, risk classes and requirements, checklist items and blocked commands;
  it cannot remove any of those, re-allow a command the settings took away, move the autonomy dial
  or any of its policies (probation, knowledge auto-apply, human rounds, question timeout), relax
  the dependency or coverage policy, override a template's stages, or switch a feature on or off —
  those stay on the settings page, and the file's attempt is listed as *not applied* on the
  pipeline screen. What it may set freely is operational: stage models, effort, turns and budgets
  (every run is still held to the task cap and the organisation and project budgets), the
  iteration limits, the knowledge directory, the context budget, the language, the commit
  convention and the ticket status names.
- **The file is plain YAML.** An explicit tag — `!custom`, `!!js/function`, even `!!str` — a
  duplicated key or a `__proto__` key makes the file invalid, with its position or
  key path named.

## 2. Dashboard

Spend, active agents and open work at a glance, and a way into each project. The agent count moves
live.

## 3. The board

**A project → board.** One column per task state. Each card carries the ticket key and the ticket's
**title** — its own words as the platform read them, or *Ticket not read yet* before it has — with
the state and the pipeline stage beneath.

The columns are task **states**, not pipeline stages, and that is deliberate for now: the column list
in the product spec is "the stages of the project's pipeline template, plus Queued / Needs human /
Done", and the template is not published to the client yet — a board built on it today would have one
column called "unknown".

**There is no drag-and-drop, by design.** The pipeline owns task state; you move a task with a
command that the domain can refuse, not by dropping a card.

## 4. Task detail

Left: the stage timeline. Centre: artifacts, runs, questions and approvals. Right: checks, cost and
links. Live on that task's topic.

Every artifact in the centre column **opens**: *Open* shows the document the stage produced, on this
page, as text. It is model output, so it is rendered the way everything else untrusted is — as
characters, never as markup and never as a link. The line above it says how many credentials the
platform replaced in it before storing it. An artifact produced **before** the upgrade that
introduced that redaction is not shown at all: nothing redacted it, artifacts are never rewritten,
and the platform will not publish a document it cannot vouch for — it says so by name instead.

### What you can do from here

The commands in the table below, plus **take over**, **hand back** and **ask the task** (after the
checks panel); a run's own commands — retry, cancel and steer — are on the run screen (section 5).
Each is an operation the task aggregate either performs or **refuses by name** — a refusal comes back as an
error naming the transition, not as a silent no-op — and each accepted one leaves a row in the audit.

| Command | Who | What it does |
|---|---|---|
| **Pause** | member | stops the task from entering another stage |
| **Resume** | member | lets it continue. A task paused while it waited for its merge goes back to waiting for it — if its branch still has the commit the platform's gates judged; if somebody pushed while it was paused, it goes back through the CI gate first, and it reads *paused* for the moment the platform takes to check (WP-79); merging the merge request on the git provider while it is paused ends the pause, and the retrospective runs as for any merge |
| **Cancel** | maintainer | ends the task; it enters no further stage |
| **Retry stage** | member | runs the current stage again, optionally with a reason. Costs a run |
| **Return to stage** | maintainer | sends the task back to an earlier stage; a reason is required. Costs an iteration of the loop |
| **Rework** | maintainer | restarts the work with new instructions, which are required. The task moves to a **new branch** (`agentic/<ticket>-r2`, then a higher number on each later rework — the numbers can skip, because a plain return counts too) and the merge request you rejected is **closed** on the git provider with a comment naming the new branch; a new merge request is opened from the new branch when the work gets there again |
| **Answer a question** | member | answers a question the agent asked; the task continues |
| **Decide an approval** | maintainer | approves or rejects a plan (and, where configured, a budget) |
| **Feedback** | member | 👍/👎 plus text, on the task |

The stage list offered by *retry*, *return to stage* and *rework* comes from the task's **own**
history rather than from the pipeline template, for the same reason as the board's columns; a task
that has entered no stage yet gets an empty state rather than a control that can only fail. Each
form's submit button stays disabled until the command's own required fields are filled, so you do not
send a request the server will reject.

Double-clicking a command is safe: every write carries an idempotency key, and a replay performs
nothing twice. Two requests under one key that arrive **at the same moment** are safe too since WP-67:
the second is refused `409 idempotency_key_in_flight` instead of being performed, and sending it again
once the first has answered returns the first answer. The application does that sending for you: the
second click stays pending for a moment and then shows the first one's result, not an error. If a
server stopped while performing a command, nobody can say whether it was done; the screen says so and
asks you to check the task first, and pressing the button again is then a new request.

### The checks panel

The product defines eleven merge-readiness checks, and the panel shows **all eleven**:

- **Acceptance criteria** and **Business verdict** — read from the latest Acceptance Verdict the
  business review wrote: how many criteria were met, not met or untestable (each with the
  reviewer's evidence), and whether it approved or asked for changes. No verdict yet says
  *no verdict*; a verdict the server refuses to serve says *unavailable* and why.
- **CI status** and **Rebase status** — the latest attempt of each gate: green or red, up to date
  or conflicts, *checking* while it decides, *not reached* before the task gets there, and
  *escalated (…)* with the reason when the gate stopped for a person.
- **Review threads** — open and resolved human threads on the merge request, as the platform last
  counted them. It counts when somebody comments while the task waits for merge, and again when the
  merge request reports every thread resolved — which GitLab sends only for a project that requires
  resolved threads before merging. A thread resolved without a comment while others stay open is
  not counted until one of those happens; until the first count it says *not read*, never zero.
- **Coverage delta**, **Dependencies**, **Risk classes**, **Required reviewers**, the **Estimate**
  against what the task has spent, and **Questions pending**.

- **Tamper check** — BD-024's check, made by the CI gate: the existing files the change modifies,
  deletes or renames away, against the project's protected paths (tests and CI/lint configuration
  by default), minus the changes the plan declared and the code review confirmed. Adding a new test
  is never flagged. *protected paths changed, sent back* when anything
  is left (the developer is told which paths, and CI status then says *sent back by the tamper
  check* rather than red); *declared changes await the code review* when the plan declared them and
  the review has not judged the change yet — CI checks again before Ready; *clean*; *checking*; or
  *not reached*. It is never drawn as an empty tick for a gate that has not decided.
  A merge request that changes **100 files or more** is more than the check reads, so the CI gate
  cannot tell whether a protected path changed and hands the task to a human (`needs_human`) even
  on green CI — split a large refactor, or take the merge from there yourself.

When CI fails, the developer's next run is also handed the failing job's log — its beginning and
its end, with credentials redacted — beside the job names.

### Taking over, the epic breakdown, and asking the task

- **Take over** and **hand back** are on this screen (and on the run screen, for the run's task).
  **Take over** pauses the pipeline, interrupts the running agent, commits and
  pushes its work in progress on `agentic/<ticket>` and answers with the branch, the
  `claude --resume` command and whether the workspace was exported — the panel shows exactly those,
  in the tense the platform means them (*requested* is "being pushed as the run winds down", not
  "done"). Tick **Also archive the workspace** to get a tarball too. While you hold the task the
  panel shows your branch and the resume lines, two downloads — **the transcript** of the run you
  interrupted (`GET /api/runs/<run>/transcript.jsonl`, rendered from the stored transcript each time,
  so it lasts as long as the transcript does) and **the workspace tarball** when you asked for one
  (`GET /api/runs/<run>/export.tar`, kept for **14 days from the take-over, whether or not you have
  handed back** — the taken-over workspace's own retention). The run it stops is found wherever it
  runs — on a stock instance in the `runner` container — and the stop is *accepted, then applied*
  by that container (WP-85); the session line reads *not known yet* until the run has reported one,
  and the run screen shows whether the stop was applied. When no run was in flight, nothing was
  exported and the panel offers neither download; a take-over recorded before WP-73 names the run it
  *infers* and says so
  — and **Hand back**, whose stage list is the task's own pipeline, so it offers nothing the platform
  would refuse. Handing back to **Ready for merge** does not skip the checks: when the branch is not
  the commit the platform's gates judged — you pushed, or the platform cannot read it — the task
  re-enters the CI gate and walks through review and the rebase gate to Ready again, spending none of
  its iteration limits; only an unchanged branch goes straight back to waiting (WP-79). Handing back
  at a review stage or the rebase gate after a push does not skip CI either: the rebase gate lets a
  task into Ready only for the commit CI passed, and otherwise sends it back through the CI gate — a
  re-check that counts against the task's `rebase_rechecks` limit, so a branch that keeps moving
  after CI ends up with a human rather than looping. A task you took over and have not handed back moves to needing a human after
  **5 working days without a command from you** — any command you issue on the task (a pause, an
  answer, feedback, a question) restarts the count; somebody else's does not, and neither does a push
  to the branch, because this build does not yet record who pushed. It stays yours when it escalates: the
  panel and the workpad keep showing the branch and the resume command. What you push to the
  branch while you hold it is followed: on a GitLab binding the merge request's update moves the
  revision the platform records for the task, so the next conflict check between tasks reads your
  commit rather than the agent's last one; an update GitLab stamps earlier than the one already
  recorded never moves it back. The CI gate does not rely on that record at all: it asks GitLab for
  the merge request's current head each time and judges **that** commit's pipeline, so a green
  pipeline for an older commit never passes it.
- An **epic split** task carries a **Proposed breakdown** panel: one row per child ticket the agent
  proposed, with its acceptance criteria, a checkbox per child and one button. Accepting **creates
  those tickets in your tracker** — one per accepted child, never twice — and rejecting keeps the row
  with your reason. Only a maintainer sees the checkboxes; everybody who can read the task can read
  the queue. The feature is off until a project turns on **Epic split** in its operating-mode
  features.
- **Ask the task** (member) is a thread at the bottom of the page: ask *"why did you choose X?"* and
  the answer is written from the task's audit trail and artifacts, citing the exact run, artifact or
  action it rests on — each citation is a link into this application, never a link the model wrote.
  An ask starts a run and spends the project's money, which is why it needs a member rather than a
  viewer; reading the thread needs only a viewer. It is a project feature (**Ask the task** among the operating-mode features), on by default.
  Like any run it needs an instance whose runner is configured (section 13).

## 5. Run detail and the transcript

Click a run. Header metrics, then three tabs:

- **Transcript** — the live stream of the agent's turn: messages, tool calls and their results, as
  they happen. This is the "click and watch" part of the product. Everything in it is rendered as
  **text**; the application has no markdown-to-HTML step anywhere, on purpose, because all of it —
  model output, tool results, file contents — is untrusted
  ([BD-022](decisions/business/BD-022-external-text-is-untrusted.md)).
- **Prompt** — the exact system and user prompt that produced this run.
- **Context pack** — what was retrieved and put in front of the model.

You can **cancel** the run (member), **retry** it with a different model or effort (member — this
creates a *new* run rather than changing this one), and leave **feedback** scoped to the stage.

**Steering a live run is accepted, then applied or refused** (WP-85). It pushes a turn into a
session that is already running, which only the process running that session can do — on a stock
instance the `runner` container, never the process serving this application. So the message is
recorded and handed to the runner through the database: the screen says *Accepted* at once, and
**Commands sent to this run**, under the transcript, then shows whether it was *applied* (it appears
in the transcript as a turn attributed to you) or *refused* — *the run ended before it could be
applied* (it is never applied late), *the live session did not take it* (it was closing; not
retried) or *no live session was found*. A message usually applies within
a second; one that stays *pending* for a couple of minutes means the runner's database connection is
struggling. Cancelling still has the old limit: it ends the run as a *record*, and does not
interrupt what is executing.

One tab can answer "not available" rather than showing you a document, and that too is deliberate:

- **Context pack** — the stored row cannot hold two of the fields the pack requires, and summing what
  is there would publish "budget equals total" as a fact the screen would then render as true.

**Prompt** used to be the second, and is not any more: the two columns have had a writer since
migration 0038, so a run started by this build shows the exact prompt it was given — redacted at the
write, because a prompt carries the credentials the run was handed. A run started *before* that
migration still answers "not available", and always will: the prompt is not re-derivable, because
its delimiter is a fresh random value per prompt and its knowledge excerpts are a point-in-time
read, so re-assembling one would show you a document that run never saw.

This is the product's rule about numbers: every one shown has a definition, and one that has none is
absent rather than invented. It is why the **Agents** screen shows no "tokens per minute" — a rate
computed from whatever two samples the browser happened to see is a number with no definition.

## 6. Inbox — questions and approvals

**Inbox** in the top navigation: everything pending for you, across every project, answerable in
place.

A question the agent asks may also arrive in Slack, and all channels are equivalent — **the first
answer wins**. An approval arrives in Slack with **Approve / Request changes** buttons; a click
counts only when an admin has mapped your Slack account to you on **Settings → Provider
identities**, and only if your role may decide it — the same rule as the button on the task page. A
question arrives with a button per option, and a reply *typed* in its Slack thread answers it too,
under the same mapping rule; once it is answered anywhere, or expires, the Slack message says so and
its buttons go. A decision taken in Slack appears in the task's audit like one taken here. So the
inbox links to the task rather than pretending to be the only way in. A
question is due after the project's question timeout — **1 working day** by default, counted on the
organisation's working calendar, so one asked late on a Friday is due on Monday — and an expired
question is not silently dropped; it moves the task to needing a human. It also **leaves the
inbox**, because it can no longer be answered — the inbox says so above the list — and the task page
is where it is retried or cancelled. **Before that, one
reminder**: halfway through the working time to the deadline, the project's chat channel gets a
message saying the question is still unanswered, which names the task page (it has no buttons). A
question answered before then is not reminded about.

Approvals work the same way: the plan-approval gate is what the **Supervised** autonomy level turns
on above a certain task size, and any maintainer can decide it. An approval nobody decides expires on
the same calendar and at the same timeout as a question, and moves the task to needing a human too
— with the same one reminder halfway there.

Once an approval is decided — here, on the task page, or with a button — or expires, its Slack
message is **edited**: the buttons are removed and the message says how it was settled (approved,
changes requested, or expired), naming the decider by role; the task page names the person. A chat
provider that cannot edit a message keeps the buttons, and a late press is refused by the approval
rather than recorded.

### What reaches the chat channel

Links a model wrote — in a review's summary, a blocker brief, a question — are posted **as their bare
address**, never under the label the model gave them, so the bot never shows a link whose text says
one thing and whose target is another. The ticket's own link is the platform's and stays a link.

Two messages come from the platform rather than from a task:

- **An organisation budget that is spent** is posted **once**, to the channel your organisation's
  chat integration names in its own settings (not a project's channel). If that integration names no
  channel, nobody is told in chat — the operator sees it in the server log — and if two chat
  integrations each name one, the platform refuses to pick and says so in the log.
- **The nightly maintenance pass's report** — which chores it created, which it could not perform and
  why, whether the maintenance budget stopped it — is a line in the project's **daily digest**, once
  per chore period, and again only when something new happened. A project with the digest off or no
  chat binding gets no report line; the server log says it instead.

## 7. Knowledge

**A project → knowledge.** Four things:

- the **browser**: the knowledge base as it exists in the project's repository, as a tree and a
  document view;
- the **health report**: what the nightly hygiene pass last found — a page the parser refused (and
  which is therefore in no agent's context), links that point nowhere, expired pages, duplicates —
  or *No health report yet* before the first pass has run. A finding is an observation; nothing
  rewrites a page because one names it;
- the **proposal queue**: what agents have suggested, each approvable or rejectable;
- what an approval does: a commit on an `agentic/knowledge/*` branch and a merge request. Never the
  default branch, and never without a maintainer's decision.

The knowledge base lives **in your repository**
([BD-012](decisions/business/BD-012-knowledge-in-repo.md)), which is why there is no "export": it is
already there, reviewable in the same merge requests as the code.

Editing a document in the browser is **not** built. It would open a commit or a merge request and it
needs an editor the application does not yet include, so the panel is read-only and says so.

## 8. Pipeline and budgets

**A project → pipeline** shows the effective configuration with the source of every key (a default,
the organisation, the project, or the repository's `.agentic/config.yml`) and when the repository's
file was last read. Read-only here: the settings are edited on the project's settings page, which
also proposes them to the repository (section 1, step 5); a YAML editor in the browser is not built.

**A project → budgets** shows the budget bars. A budget stops a *new* run from starting: the check
happens when a run is admitted, so a run already under way finishes and is accounted for. There are
three levels — organisation, project and per-task — and the window rolls over on the organisation's
own timezone without anything scheduled.

What a run costs is taken from what the provider reports, and the per-model entries sum to that
total. A cost the provider did not report is priced from a price list and **labelled an estimate**; a
model with no price row gets no ledger row at all and a log line, never a zero, because a zero reads
as a free run.

## 9. Integrations

Per-provider cards with health, and each provider's **setup guide** — written for the provider's own
screens, and the same text the operator reads. For a provider with an inbound webhook, the **Setup
guide** card shows the webhook URL to paste into the provider, with a **Copy** button; a provider
with no inbound half says it has none.

Nothing on this screen is a credential: the server strips every field a provider declares to be a
secret before publishing an integration's configuration, and publishes nothing at all for a provider
this build does not ship — because it then cannot tell configuration from credential.

**Add an integration** (admin) is a form on this screen, and **Test connection** is on each card as
well as in the wizard beside the binding it is about. The form never takes a credential: it names the
*environment variable* the server reads, which must be on the operator's allow-list (operator guide,
§4) — so a create can be refused for a reason outside the form, and the server's own message is
shown.

## 10. Audit log

A filterable stream of configuration changes, oldest cursor forward. A secret in a diff appears as
the literal string `"changed"` — that is the server's doing, not the screen's.

Every human action taken through the product is recorded with the acting user, the command and its
parameters. A *refused* command records nothing.

## 11. Settings

The signed-in session, the theme, the instance version, the user list with roles, the
**organisation budgets** (the caps that stop a new run anywhere in the organisation), **provider
identities** — which Slack, Jira or GitLab account is which person, without which a decision made in
those tools is refused as unmapped — and, for an administrator, the **dead letters**: events the
platform stopped retrying after their handler failed every attempt, each with a **Re-queue** button
for once the fault is fixed (the operator guide's §9 says what a re-queue does and does not do).

**Organisation settings** (since WP-93) are the maximums every project is held to, and an
administrator saves each section on its own:

- the **command maximum** — every agent run's commands are its role's list intersected with this one,
  so a verb left out of *allow* is removed from every run of every project;
- the **autonomy maximum** — the highest dial position a project may choose. A project above it runs
  at the maximum from its next task (the project's own setting is kept, so raising the maximum
  restores it), and a task that is already running keeps the dial it started with;
- the **WIP maximum** — a project may allow fewer tasks at once, never more;
- the organisation's **quiet hours** and **digest time** — an organisation budget crossing its
  threshold at night waits for the morning digest, and a spent budget is still posted at once — and,
  with two chat accounts, the **default chat account** that speaks for the organisation.

A lowered maximum applies from the next run or task; nothing already running is moved. The provider
mode (an environment setting) and feature flags (a project's own) are not organisation settings. A
project's features are switched on its own settings page.

## 12. Statistics

The organisation's delivery numbers over a range you choose (7, 30, 90 or 365 days) and a bucket
(day, week, month), with a **CSV download** of the same figures and a table of returns by stage.
Every number carries its definition, and its caveats are on the screen. A number this build cannot
compute is listed under **Not measured, and why** with its reason, never drawn as a zero — a zero
would read as "we delivered nothing" instead of "nothing is measured"; and a range with nothing in
it says *no data in this range*, which is a different sentence from `0`.

## 13. The whole list of what is not there yet

In one place, so it is not spread across thirteen sections:

| Not built | Where you meet it |
|---|---|
| Interrupting a live run from **Cancel** (it ends the record; steer and take-over do reach the run, since WP-85) | run detail |
| The business interview as a *conversation* with the Product Manager role (the form is built; Q102) | onboarding step 3 |
| Committing `.agentic/` configuration from the wizard itself (the project settings page does it) | onboarding step 5 |
| Re-answering the nine run-dependent readiness criteria after a merge (five are re-checked) | onboarding step 2 |
| Editing a knowledge document or the pipeline in the browser | knowledge, pipeline |
| Instance-wide feature flags and the provider mode as organisation settings (the provider mode is an environment setting; a project's features are its own) | settings |
| The statistics the screen lists under *Not measured, and why* | statistics |

And one that is about the deployment rather than a screen: an agent stage runs only on an instance
whose operator set `APP_LAUNCHER_URL` and `APP_LAUNCHER_TOKEN`, because those switch on the `runner`
container WP-53 added. Without them a stage that needs an agent **queues** rather than failing —
nothing is lost and nothing is escalated, but nothing moves either. The platform gates are on the
same queue and stop with it, which on such an instance you only meet through a human path: a
hand-back to a gate stage, or a merge you make by hand.
Everything around it — intake from a webhook, the board, the commands, the knowledge base, the audit
and the cost ledger — works either way. A stage that **writes** (implementation, conflict
resolution, the librarian) also needs the GitLab integration to be allowed to mint short-lived
tokens (`mint_credentials: true`): the platform gives each run its own token — read-only for a
read-only stage, never one that pushes for a shadow task — and revokes it when the run ends. Without
it such a stage fails at start naming the setting, and a read-only stage can check out only a
repository GitLab serves without authentication. The [operator guide](operator-guide.md) §1 and §10
say the same thing from the other side.
