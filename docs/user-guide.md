# User guide

> What the product does, screen by screen, and what it does **not** do yet. The companion is the
> [operator guide](operator-guide.md), which is about installing and running the instance.
>
> Every "not yet" below is read off the code rather than remembered: the screens themselves say what
> they cannot show, and the one endpoint the application calls that the server does not serve is
> named in `apps/server/src/routes/client-census.test.ts`, a test that fails if this list goes stale
> in either direction. The run page's tabs (§ 5) and the top navigation are held to the screens the
> same way, by `apps/web/src/features/user-guide-census.test.ts` — their names and counts, not what
> the prose says they do.

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

**After the platform is upgraded, an open tab asks for a reload.** A banner under the navigation
says *The platform was updated — reload this page*, with a **Reload** button, in place of the error
an old page would otherwise show when the new server's answers no longer match what it expects. The
page checks the server's version each time its live connection comes back (a restart drops it) and
whenever an answer does not match. If the server is the **same** version as the page, a mismatch is
a real fault and is shown as the error it is; an instance built from a checkout has no version to
compare and always shows the error.

## 1. Onboarding a project — the wizard

**Onboarding** in the top navigation. Five steps, each of which is also reachable on its own, so
"finish later" leaves a checklist rather than a dead end. The wizard is **resumable because its state
is the server's**: which project exists, which integrations are bound, whether discovery has run.
Close the tab at step 3 and come back to the same place.

### Step 1 — Connect

Give the project a **key**, a name, a repository URL and its **default branch**, then attach the
integrations it uses.

The default branch is required (WP-139): it is the branch every run checks out, every merge request
targets and the knowledge base is read from, and the platform's fallback — `main` — is the wrong one
for a repository whose default is `develop` or `dev`. Once a git integration is bound, the step shows
the default branch the git provider reports and where the provider says the CI configuration lives
(GitLab's *CI/CD configuration file* setting); when the stored branch differs, a notice says so —
*"GitLab's default branch is X; this project uses Y"*, also beside the readiness panel — the field is
prefilled with the provider's and **Save default branch** changes it. The notice refuses nothing:
since WP-142 every check the platform makes (branch protection, readiness R9, the poll, coverage,
`CODEOWNERS`) reads the stored branch. The same control is on the
project's settings page; a maintainer may use it, and it is refused while any of the project's tasks
is unfinished, because a live task's branch and merge request were made against the old one.

The key is a lower `snake_case` slug — `^[a-z][a-z0-9_]*$`, so `acme_web` and not `Acme-Web`. It ends
up in URLs and branch names, and it is checked in the browser before anything is sent: a key with a
capital or a hyphen produces an inline error and **no request**, which is easy to mistake for a
button that did nothing.

Then: the integrations the project uses. This step **binds and tests** them; it does not create them.
An integration has to exist first: an admin creates it on the **Integrations** screen (section 9) or
with the request in the operator guide's §4. Once one exists it appears here as a checkbox, "Test connection" makes one real call to the provider and records the
result, and "Bind" attaches it to this project. The result is shown beside the integration you
tested, as on the Integrations screen: *testing…* while the call runs, then **Last test: passed** or
**Last test: failed** with each check the provider answered, or a notice that the test could not be
run. A wrong token is therefore a failed test here rather than a failed run tomorrow.

You never paste a credential into the browser, at any point. What is named is the *environment
variable* the server should read, and the server seals the value itself.

#### The ticket lifecycle

Once a ticket tracker is bound, step 1 shows **Ticket lifecycle**: the moments at which the platform
moves a ticket, each a pick list of **your tracker's own statuses**, loaded from the tracker with each
status's category beside its name. The platform assumes no status name; it offers only what the
tracker lists. **Every slot may be left empty** (*Not mapped*): an empty slot means the ticket is not
moved at that point, and the stage still runs.

| Slot | What it does |
|---|---|
| **Pick up from** | Only tickets in this status are started (a pick-up label works instead). On cancel or rework the ticket is moved back here. |
| **In progress** | The ticket is moved here when the platform claims it, and again each time a developer stage starts, a return included. |
| **In review** | Moved here when the agent's code review starts. |
| **Approved** | Moved here when the agent's own review has passed and its findings are fixed. |
| **QA** | Mapped, tasks created from then on get a human **QA** stage before Ready for merge, and the ticket is moved here when the task enters it. |
| **Returned** | One or more statuses, never set by the platform: a person moving the ticket into one of them returns the task to the agent. |
| **Done** | Moved here when the merge request is merged. |

Two switches sit under the slots. **Claim the ticket before the first run** (on unless you switch it
off): before a task's first run the platform assigns the ticket to the tracker integration's own
account, moves it to *In progress* if that slot is mapped, and reads the ticket again. If somebody
else holds the ticket, the task stops in **Needs human** with the reason *assigned elsewhere*, no run
starts, and the platform posts one comment on the ticket — *"The agent did not start work on this
ticket: it is assigned to somebody else. A maintainer has been asked who should take it."* While
claiming, a ticket already assigned to a person is not started at all, unless you tick **Also start
tickets already assigned to a person**. On cancel or rework the platform unassigns itself (and moves
the ticket back to *Pick up from*, if mapped).

**Save the ticket lifecycle** checks every name against the tracker's statuses before anything is
written. A name the tracker does not list is refused, the slot that names it is marked, and nothing
is saved; if the tracker cannot be read at that moment, the form says the statuses could not be
loaded and nothing was saved, and keeps your choices so you can save again. A name you saved earlier
that the tracker no longer lists is shown above the slots as *Not listed*, and the slot is empty
until you pick again. **Binding a tracker in this step for the first time also saves its lifecycle**
with every slot empty and the claim on — the step says so under *Bind* before you press it — so a
project set up here claims unless you switch the claim off. A binding that already has a lifecycle
keeps it as it is. A tracker binding with no lifecycle saved (one bound before the lifecycle
existed) neither claims nor moves tickets, and re-saving the bindings does not change that; saving
this form once, even with every slot empty, turns the claim on unless you switch it off. Once
a slot other than *Pick up from* is mapped, the project's older `status_mapping` configuration is not
applied at all, and the form says so. The readiness panel (step 2) lists each empty slot as a
**note** — information, never a failure, and it changes no level.

Reading the tracker's statuses needs a maintainer; saving the bindings needs an administrator.

### Step 2 — Technical discovery

Starts the **Discovery agent** on the repository. It is a normal agent run in every respect — it has
a budget, a transcript you can watch, a cost entry, and it escalates to a human if it fails — and it
produces two things (below). The step shows where the discovery is **now**, read back from its task
whenever the page loads — a refresh included — and followed live while the page is open: *queued*
(its run has not started), *running* with a **Watch its live transcript** link to the run page,
*needs a person* with the escalation's reason and brief, *paused*, or *done* with the project's current readiness level
(which a later re-check or re-evaluation may have moved since the discovery recorded it) — and **Open its task** leads to the task page. The sentence the button answers with
(*"the Discovery agent is queued"*) is only the click's immediate feedback.

What discovery produces:

- a **readiness evaluation**: fourteen criteria and a level from 0 to 4
  ([product/17](product/17-repository-readiness.md)), with the three cheapest improvements named —
  and, since WP-143, a **CI-rules notice** when there is one: a *warning* that the default branch's
  CI rules give an `agentic/` branch no test job in a push or a merge-request pipeline (naming the
  rule and the fix), or a *note* naming what the platform could not read (`include:`, `extends`,
  `!reference`, `changes:`, an external CI configuration). It changes no level and blocks nothing;
  it is evaluated again at every re-check (`docs/first-local-test.md` § 1 has what it checks);
- **drafted knowledge pages**, which arrive as proposals rather than as commits.

Three of the criteria are the platform's own answer and are never taken from what the model claims,
and the "what this unlocks" text is the platform's, never the agent's. The discovery agent's shell
reads the repository and runs the project's own declared commands — its test, lint and setup
commands (including an executable `.agentic/workspace/setup`, run as `./.agentic/workspace/setup`),
and the lockfile install they need — so R1, R2 and R6 are answered by running them. The install
can fetch only from a package registry your operator declared (`APP_RUN_REGISTRY_HOSTS`, empty by
default). On an instance that declared none, the egress proxy refuses the install's requests, so a
repository whose tests need dependencies cannot run them. **A criterion the run could not run is
*not checked*, not failed**: the run image is built for Node.js projects and has no PHP, Composer,
Python or JVM, so on such a project R1, R2 and R6 show *not checked* with the reason. A not-checked
criterion does not hold the level down (each rung is reached when its criteria passed or were not
checked) and is not listed among the improvements; when the project has CI, the panel adds a note
suggesting `verification.mode: ci` (project settings), under which discovery reads the three from the
CI configuration — press *Re-evaluate readiness* afterwards. An evaluation recorded before this rule
keeps its level until it is re-evaluated. It cannot
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
| R13 | passes when `.pre-commit-config.yaml`, `lefthook.yml`, `.husky/pre-commit` or `.gitlab-ci.yml` **runs** a secret scanner (gitleaks, trufflehog, detect-secrets, ggshield, secretlint): a pre-commit hook of that scanner, or a command line that starts with it; or `.gitlab-ci.yml` includes GitLab's secret-detection template without switching it off. Since WP-143 the CI file is the one GitLab names (`ci_config_path`, e.g. `deploy/.gitlab-ci.yml`) in place of the root `.gitlab-ci.yml` when the two differ. Merely mentioning a scanner does not count. Otherwise carried |
| R3 | passes when the platform has stored a pipeline event for a merge request in the last 30 days; otherwise carried |

R10, R13 and R3 are never *failed* by a re-check: a template under another name, a scanner in a
GitHub Actions workflow or a convention written in prose is invisible to the files the platform
reads, so a miss keeps the previous answer. R1, R2, R4, R5, R6, R7 and R14 need a run, so they keep
the latest discovery's answer. **To have them answered again, press *Re-evaluate readiness*** on the
project settings page (maintainers): it runs the Discovery agent again as a new task, with the same
budget cap, cost accounting and transcript as the first run, and records its evaluation as a
*re-evaluation* beside the earlier ones. The pages it drafts again replace the earlier discovery's
drafts of the same pages that are still waiting in the knowledge queue: the older card turns
*discarded*, and its first evidence line names the task whose newer draft replaced it. A draft you
already approved is left alone. The button shows the run's budget cap (a ceiling, not a
prediction) and what the last discovery cost; it is off, with the reason, while a discovery is
running or parked, before the first discovery, and after three re-evaluations in a row recorded
nothing. A project that was never evaluated is not re-checked: the readiness panel keeps saying
there is no evaluation until discovery runs. When a discovery run finished but its findings were
never recorded — the recording failed, was retried once by the platform and failed again — the
button's panel says so with the reason, and the discovery task is escalated (or, already finished,
its people are told in chat): the run was paid for and the project kept its previous evaluation, and
re-evaluating runs it again.

### Step 3 — Business interview

[product/19](product/19-operating-definitions.md) §8's eight sections — product, users, business
rules, glossary, direction, quality bar, review expectations, communication — as a form. Each is
optional: leave it empty to skip it, or tick **Not applicable** (with an optional reason). The whole
step is optional too: it is headed *(optional)*, and **Skip for now** folds the form away and records
nothing (**Answer it now** brings it back). The same form is on the project settings page under
*Business context*, so a skipped interview can be answered there later.

Submitting writes **proposals, not pages**: each answered or not-applicable section becomes one page
under `business/` in the knowledge proposal queue, where a maintainer edits and approves it, and
approving it opens a merge request like any other proposal. Nothing is committed from the form. The
page is your own words under the platform's headings — no agent rewrites them. Answers are cut at
12 000 characters (a not-applicable reason at 1 000), credential-shaped strings are redacted before
anything is stored, and a cut is announced in the page. Submitting again replaces the earlier
submission's pages for the sections you answered again, as long as nobody has approved them yet:
the earlier card turns *discarded*, and its first evidence line says a newer answer replaced it.

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
(the level in force counts, so an organisation maximum of Observe pauses it too); the project's daily
digest says so once when the pause begins and once when it ends. At **Assist**,
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
- **Settings that no longer parse stop the project's runs too** (since WP-106). This happens when an
  upgrade narrows a key your saved settings use, or when somebody edits them outside the screens. The
  configuration screen answers with the key and the value it cannot accept. Every run of the project
  is refused with the same sentence: the stage is parked for a human as *the project's stored
  settings do not parse*, and an ask is refused. This lasts until a corrected configuration is saved.
  The platform never plans a run on the settings as if they were empty. Tickets keep arriving
  meanwhile: each one becomes a task, the task stops at its first stage with that sentence, and chat
  notifications are still sent. A task already in flight stops with the same sentence at its next
  step (a finished stage, the CI check, the dependency check) rather than going on. Once the settings are fixed, resume the parked tasks from their pages.
  The shadow and history-bootstrap batches answer *the feature is off* meanwhile, whatever their
  switch says: that switch is part of the settings that cannot be read. A task **created** while
  the settings could not be read is told so in its brief. When it is resumed it takes its iteration
  limits, its autonomy dial and its pipeline (a Spike ticket's spike pipeline, an epic's breakdown)
  again from the corrected settings, so it never runs on the platform's defaults.
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

**Project prompt files.** A stage can be given your own standing instructions, beside its role
prompt and never instead of it. They live in the repository under `.agentic/prompts/` on the default
branch: `<stage>.md` and `<stage>.append.md` (for example `implementation.md` and
`implementation.append.md`) are read by name, or a stage's `prompt` / `prompt_append` key names
another file in that directory (`prompts/review.md`). Each file may be at most 16 KiB, and a stage
gets at most its first **8 000 characters**. **An edit applies at the next reading, not at the
merge**: the platform reads the files with `.agentic/config.yml`, after the next knowledge index run
or when you press **Re-read now**, so a stage that starts between your merge and that reading still
gets the previous text. The project's **Settings** page has a *Project prompt files* card that shows
the commit the last reading was taken at, every file it holds with its length and whether the cut
applies (never its text — a run's **Prompt** tab shows what that run was given), and which file each
stage would be given now.

## 2. Dashboard

Spend, active agents and open work at a glance, and a way into each project. The agent count moves
live. A maintainer or admin also sees **one banner** when an organisation chat account's credentials
cannot be decrypted: every project's prompt files are withheld until the account is re-sealed or
retired under **Integrations**, whose card for that account says the same (WP-157).

## 3. The board

**A project → board.** One column per task state. Each card carries the ticket key and the ticket's
**title** — its own words as the platform read them, or *Ticket not read yet* before it has — with
the state and the pipeline stage beneath, and the task's measured cost so far: reported by the
provider, or priced from the price list in `local` provider mode. A run that ended with nobody
measuring it is left out of that figure, and the card then says so beside it — *excl. 2 unmeasured*.

The columns are task **states**, not pipeline stages, and that is deliberate for now: the column list
in the product spec is "the stages of the project's pipeline template, plus Queued / Needs human /
Done", and the template is not published to the client yet — a board built on it today would have one
column called "unknown".

**There is no drag-and-drop, by design.** The pipeline owns task state; you move a task with a
command that the domain can refuse, not by dropping a card.

### Starting a ticket by hand

A ticket reaches the board when it matches the project's **intake rule** — the label, status, epic or
query its task-management integration picks up. For a ticket no rule matches, a **member** (or above)
types its key into **Start a ticket** above the columns and presses **Start**; the form is not shown
to a viewer. The key is letters, digits, `.`, `_` and `-` (for example `ACME-123`).

The start reads the ticket from the tracker and records it as matched **by hand** — and that is the
only thing it skips. The task is then created exactly as for a rule match: it gets the template its
issue type maps to, it is **queued** if the project is at its WIP limit, it waits for a human if
the default branch is unprotected, and a ticket that already has a task is not started twice — even
under a new key: a Jira issue moved to another project is the same ticket, because the platform
records Jira's own issue id beside the key (for tasks created before this release, the key alone).
Edits made to the ticket after such a move still reach its task, which then shows the new key, and
so does an `@agentic ask` comment on it (WP-148); its
branch and merge request keep the old one. So the
answer is *Started ACME-123 — its task appears on the board once intake has created it*, not a task.
The start is refused, by name and with nothing recorded, when the project binds no task-management
integration, when its autonomy dial is **Observe** (which picks up no new tickets), when the ticket
already has a task, when the ticket is in a tracker project the integration is not set to read
(a Jira integration's `project_keys`, the same filter a webhook delivery honours), when the tracker
does not know the key, and when the tracker cannot be read at that moment (try again). Each start
leaves one row in the audit log, and once intake has created the task, the task's own *Who did
what* lists it: the start, with the person who pressed it. Pressing **Start** twice sends one start.

## 4. Task detail

Left: the stage timeline. Centre: artifacts, runs, questions and approvals. Right: checks, cost and
links. Live on that task's topic.

**The stage timeline lists the newest stage first**, and each entry opens the run of that stage
attempt: *Open the run* (*Open the run (live)* while it is running) goes to its transcript, and when
the attempt ran more than once — a retry of the same attempt, say — to the latest run. *Why the run
did not start* goes to the run page of a run that never reached its agent, which says why instead of
showing an empty transcript. A stage that runs no agent — a gate such as the CI or rebase gate, or a
plan approval — or one whose agent has not started yet says *No run for this stage* and links
nothing.

**While an agent is working on a stage**, a panel at the top of the centre column says so: a pulsing
dot, the stage and the role, how long the run has been going, and the **latest progress line** the
agent reported — *"slice 2 of 4 pushed; next the endpoint"* — with its percentage when it gave one
and how long ago it said it. The line updates live as the agent reports, and *Watch the run* opens
the run's transcript. The agent writes the line, so it is shown as text, never as markup; an agent
reports at most one line every 30 seconds. *No progress reported yet* means the agent has not called
the tool, not that it is idle — the run page's transcript is the full record.

Below that line, the panel shows **the run's transcript as it happens** — the same entries as the
run page, arriving live — bounded to the newest 30 blocks, with *Open the full run* for the whole session, its search and the
steer box.

Every artifact in the centre column **opens**: *Open* shows the document the stage produced, on this
page, as text. It is model output, so it is rendered the way everything else untrusted is — as
characters, never as markup and never as a link. The line above it says how many credentials the
platform replaced in it before storing it. An artifact produced **before** the upgrade that
introduced that redaction is not shown at all: nothing redacted it, artifacts are never rewritten,
and the platform will not publish a document it cannot vouch for — it says so by name instead.

**Download JSON**, beside the task's key, is the task's whole record as one document — everything
this page shows, each run's record, the task's events and, for a maintainer, who did what — offered to
a member or above. A viewer is not offered it; the export would refuse them.

**The claim and the QA stage** show under the task's key when there is something to show (the
project's ticket lifecycle, step 1). *ticket claimed* means the platform assigned the ticket to its
own account and the tracker confirmed it; *claim (shadow)* means a shadow task recorded what it would
have assigned and assigned nothing; *claim released* means the claim was given back — on a cancel, a
rework, or a task that stopped between the assignment and its record — and the ticket is no longer
the platform's. Each says when. A task that never claimed (no lifecycle saved, or a task older than
the claim) shows nothing. **QA stage** means this task was created while the project mapped a *QA*
status, so a person tests it before Ready for merge (below).

### What you can do from here

The commands in the table below, plus **take over**, **hand back** and **ask the task** (after the
checks panel); a run's own commands — retry, cancel and steer — are on the run screen (section 5).
Each is an operation the task aggregate either performs or **refuses by name** — a refusal comes back as an
error naming the transition, not as a silent no-op — and each accepted one leaves a row in the audit.

| Command | Who | What it does |
|---|---|---|
| **Pause** | member | stops the task from entering another stage |
| **Resume** | member | lets it continue. A task paused while it waited for its merge goes back to waiting for it — if its branch still has the commit the platform's gates judged, through the rebase gate, which checks it against the target branch as it is now (a default branch that moved during the pause is not re-checked while the task is paused) and warns about another task touching the same files, spending no iteration limit (WP-105); if somebody pushed while it was paused, it goes back through the CI gate first (WP-79). It reads *paused* for the moment the platform takes to check; merging the merge request on the git provider while it is paused ends the pause, and the retrospective runs as for any merge |
| **Cancel** | maintainer | ends the task; it enters no further stage |
| **Retry stage** | member | runs the current stage again, optionally with a reason. Costs a run. If the stage's run is still going, it is stopped first and the new attempt starts once it has ended; the screen says which attempt was queued and whether a run was stopped |
| **Return to stage** | maintainer | sends the task back to an earlier stage it has already run; a reason is required, and that stage is given it. Costs an iteration of the loop. Works on a task in **Needs human** too — the way to send an escalated task to the stage that should run again. When the task stopped at a **gate** that recorded a failure — the CI gate after its fix loop ran out — the form shows a box, ticked, *Attach the gate's last failure* with its length in characters: the stage is then given the failing jobs' log excerpts as well as your reason, as two separate blocks, so you need not paste the logs. Untick it to send your reason alone. A task that was **merged** cannot be sent back to a stage before the merge |
| **Rework** | maintainer | restarts the work with new instructions, which are required. The task moves to a **new branch** (`agentic/<ticket>-r2`, then a higher number on each later rework — the numbers can skip, because a plain return counts too) and the merge request you rejected is **closed** on the git provider with a comment naming the new branch; a new merge request is opened from the new branch when the work gets there again. Like **Return to stage**, it works on a task in **Needs human**, offers the same *Attach the gate's last failure* box, and refuses a merged task |
| **Answer a question** | member | answers a question the agent asked; the task continues |
| **Decide an approval** | maintainer | approves or rejects a plan (and, where configured, a budget) |
| **Feedback** | member | 👍/👎 plus text, on the task |

A task that escalates **after its merge** — its retrospective failed, say — finishes rather than
going back to work: **Resume** runs the retrospective (a task stopped at the merge gate itself
resumes into the retrospective, the move the gate would have made) and the task reaches done;
**Retry stage** does the same when it stopped at the retrospective or the librarian, and is refused
at the merge gate, because retrying that gate would record the merge again. Returning, reworking or handing it back to any stage before the merge is refused by name
(*task_merged*), because its branch is already in the default branch. Pausing it first, or taking it
over, leaves only **Cancel** (WP-152).

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

### The merge request stays a draft until Ready

The Developer opens its merge request as a **draft**, and it stays one while the CI gate, the code
review, the business review and the rebase gate run: the platform marks it ready only when the task
reaches **Ready for merge** (the product owner's decision of 2026-10-06). When the task leaves Ready
for an agent stage again — your review comments sent it back, a conflict is being resolved, you
returned it — the merge request goes back to draft until the task is Ready again; a gate re-check
(the default branch moved) leaves it ready. So your project's CI has to run its tests on a **draft**
merge request from an `agentic/` branch. If its rules skip or hold jobs for a `Draft:` title, the CI
gate waits and says so — *"the merge request is a draft and pipeline … is held at manual job …"* —
and the readiness panel's CI-rules warning names the rule it understood.

### QA, and sending a task back from QA or Ready

When the project maps a *QA* status, a task created afterwards gets a human **QA** stage after the
rebase gate and before Ready for merge: the ticket moves to the QA status and the merge request
stays open, and still a draft, while a person tests the branch. QA ends when the ticket leaves the
QA status for a status that is not a return; the task then goes on to Ready for merge. Merging the
merge request during QA ends it too, and a move of the default branch sends the task back through the
rebase gate. With no *QA* status mapped, the task goes from the rebase gate straight to Ready.

At **QA** and at **Ready for merge**, any of three things a person does returns the task to the
Developer:

- **a status** — moving the ticket to one of the *Returned* statuses, or back to *In progress* or
  *Pick up from*;
- **a ticket comment**;
- **a merge-request note** — a comment on a diff line or a general note, including one GitLab does
  not let you resolve.

They are collected for two minutes from the first one and sent back as one return, carrying every
person's word since the last implementation run; the Developer is told to read the conversation, and
asks a question if a status change alone leaves it nothing to fix. A pure acknowledgement — *thanks*,
*LGTM* and the like — does **not** return the task (the project's configuration can add words in its
own language, `human_returns.acknowledgements`), and nothing the platform itself wrote ever does. Each
return spends one of the human rounds, as review comments at Ready always have.

### The conversation on the merge request

The review is held **on the merge request**, where you read it:

- **The Reviewer's findings.** Every code review of a task that has a merge request posts each finding
  as its own thread, anchored to the file and line where the diff allows it (otherwise as a note that
  names the location), and then **one summary note** stating the verdict — posted even when there
  are no findings.
- **The Developer's replies.** The fix run that follows replies on each thread it addressed, and
  answers a ticket comment on the ticket. Where a note asks for something only a person can do, the
  reply names who must act and says it is not done.
- **Resolution.** The Reviewer resolves a thread only after a re-review confirms the fix, and only
  **its own** finding threads: never a person's thread, and never another task's.

Every agent stage also reads the merge request's notes and the ticket's comments, as data it is told
not to obey. A shadow task posts none of this: each write is recorded as what it would have done.

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
  counted them. It counts when somebody comments while the task waits at QA or Ready for merge, and again when the
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
  the review has not judged the change yet — the rebase gate, just before Ready, reads the code
  review's confirmation, so neither review runs twice; then *declared changes confirmed by the code
  review*, or *declared changes not confirmed, sent back* (the developer is told which paths, as
  for an undeclared change); *clean* when the check ran and found nothing; *checking*; or *not
  reached*. A CI gate whose row carries no record of the check reads *not recorded*: one that
  settled before WP-105 recorded what its check found (before WP-81 no check was made at all, and
  from WP-81 on a clean check closed its row with the same word), or one a person returned from
  while the task was stopped there, which no check settled — the platform cannot tell these apart
  and does not claim *clean* for any of them. It is never drawn as an empty tick for a gate that has not decided.
  A merge request that changes **100 files or more** is more than the check reads, so the CI gate
  cannot tell whether a protected path changed and hands the task to a human (`needs_human`) even
  on green CI — split a large refactor, or take the merge from there yourself.

When CI fails, the developer's next run is also handed the log of every failing job — up to five,
each labelled with the job's name and cut to its share of one budget, the end of the log first,
with credentials redacted — beside the job names. A job whose log could not be read is named as
such, and so are the failing jobs past the fifth.

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
  would refuse — except on a task that was **merged**, which is handed back only into the
  retrospective or the librarian, and only out of *Needs human*; a merged task you took over is paused,
  and from that pause it can only be cancelled (WP-152). Handing back to **Ready for merge** does not skip the checks: when the branch is not
  the commit the platform's gates judged — you pushed, or the platform cannot read it — the task
  re-enters the CI gate and walks through review and the rebase gate to Ready again, spending none of
  its iteration limits; an unchanged branch goes back through the rebase gate alone — one
  mergeability read, no iteration limit spent — which checks it against the target branch as it is
  now and re-reads the code review's confirmation of any protected path CI excused, so a round that
  changed the plan without pushing cannot wait at Ready on the old confirmation (WP-105). Handing back
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

Click a run. Header metrics, then four tabs:

- **Transcript** — the live stream of the agent's turn: messages, tool calls and their results, as
  they happen. This is the "click and watch" part of the product. Everything in it is rendered as
  **text**; the application has no markdown-to-HTML step anywhere, on purpose, because all of it —
  model output, tool results, file contents — is untrusted
  ([BD-022](decisions/business/BD-022-external-text-is-untrusted.md)). The first row, **system ·
  init**, is the Claude Code CLI's own start-up message, shown as the CLI sent it. Its `skills` list
  is everything the CLI found, including its own bundled skills (`deep-research`, `update-config`
  and others), and it is **not** what this run could use: the run was handed only its role's
  platform skills (`agentic:kb` and the like) — the only skills written into its workspace — and the
CLI refuses any other.
- **Prompt** — the exact system and user prompt that produced this run.
- **Context pack** — what was retrieved and put in front of the model.
- **Settings** — the project settings this run was planned with, frozen when the run was created
  and redacted then. The line under the header says whether they were the same as the task's
  previous run's.

You can **cancel** the run (member), **retry** it with a different model or effort (member — this
creates a *new* run rather than changing this one), and leave **feedback** scoped to the stage. The
model is a list, not a box to type into: it offers the models the platform has a price for (the
operator's `price_list`) with this run's own model selected, and leaving it unchanged re-plans the
new run from the project's configuration. A model the list does not carry — say one your project
pins — is shown as its own entry marked *not priced* and stays selected. *Other…* lets you type any
id, and the platform runs it because you chose it there; an unlisted id sent without that choice is
refused (`model_not_listed`), so a typo never reaches a run.

**A Developer run that stops without finishing keeps its work.** When it runs out of turns, out of
budget, out of time, stalls or crashes, the platform commits what it had changed as one
`wip: unfinished attempt <n> of implementation (<reason>)` commit and pushes it to the task's
`agentic/<ticket>` branch, with the run's own credential — the same export a take-over makes. The run
page says so under the header (*Unfinished work saved: pushed to … at …*), the task's run list marks
the run *work saved to branch*, and the escalation's brief tells you a retry continues from that
branch. **Retry the stage** and the new run starts on that branch and is told to read the previous
attempt's work and carry on rather than start over; the `wip:` commit stays in the branch's history.
A run that changed nothing pushes nothing. If the push fails the run page says so, and the work is
only in the run's workspace volume, which is kept for three days. A run you **cancel** is not saved —
take the task over instead if you want its work.

**Steering a live run is accepted, then applied or refused** (WP-85). It pushes a turn into a
session that is already running, which only the process running that session can do — on a stock
instance the `runner` container, never the process serving this application. So the message is
recorded and handed to the runner through the database: the screen says *Accepted* at once, and
**Commands sent to this run**, under the transcript, then shows whether it was *applied* (it appears
in the transcript as a turn attributed to you) or *refused* — *the run ended before it could be
applied* (it is never applied late), *the live session did not take it* (it was closing; not
retried) or *no live session was found*. A message usually applies within
a second; one that stays *pending* for a couple of minutes means the runner's database connection is
struggling. You can send one message every five seconds; the limit is yours across the whole
installation, however many processes serve this application (WP-101).

**Cancel stops the session** (WP-101). When the runner is holding the run — the usual case — the
task is paused at once, the cancel is handed to the runner the same way a steer is, and **Commands
sent to this run** shows it as *Cancel*: *pending* until the runner interrupts the session, then
*applied*. The run then ends *cancelled* with what the session had cost up to that moment, charged
once like any other run. A message you steered that was still waiting is not delivered — the run
ends before it, and it reads *the run ended before it could be applied*. If no process is holding the
run (the runner is down, or its lease lapsed), there is nothing to interrupt: the run is ended here
and reads *cancelled* straight away. If the runner dies after you cancel and before it stops the
session, the platform ends the run itself a few minutes later and it reads *lease expired* rather
than *cancelled*, because nothing confirmed the stop.

Three tabs can refuse to show you a document, and that is deliberate: each is the record of what
this run was given, and none is re-derived after the fact. A run started by this build shows all
three. A run started before the platform recorded one does not, and never will — **Prompt** and
**Context pack** say the document *could not be loaded* and give the server's reason, **Settings**
says the run predates the record:

- **Prompt** — recorded since migration 0038, redacted at the write, because a prompt carries the
  credentials the run was handed. An older prompt is not re-derivable: its delimiter is a fresh
  random value per prompt and its knowledge excerpts are a point-in-time read, so re-assembling one
  would show you a document that run never saw.
- **Context pack** — recorded with the run since migration 0041, budget included. For an older run
  only the retrieved rows exist, and summing them would publish "budget equals total" as a fact. A
  pack with nothing in it is shown as an empty pack, not refused.
- **Settings** — recorded since WP-91. Today's project settings are not shown in an older run's
  place, because they are not the ones it was planned with.

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
inbox links to the task rather than pretending to be the only way in.

**Quiet hours are the exception.** When a project has its daily digest on and quiet hours set, a
question raised inside the window is not posted to the task's Slack thread at all: it waits as a
line in the next digest, without buttons. A reply typed in the task's thread (one an earlier
message opened) then does not answer it — unless another question posted in that thread is still
open, in which case the reply answers **that** one (and with two or more open it is ignored) — and
otherwise it is recorded as feedback on the task, while a blocking question keeps the task waiting.
The half-time reminder does not change this: it is stored as a reminder, not a question. So answer
it here or on the task page. An approval raised in
quiet hours is the same: a digest line without buttons. A project that wants questions to interrupt
at night lists `question` among the digest's urgent classes (`features.digest.urgent`, beside the
default `escalation` and `budget_exhausted`, which the list replaces rather than extends).

A question is due after the project's question timeout — **1 working day** by default, counted on the
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
  chat binding gets no report line; the server log says it instead. **A pause at Observe** is said
  twice: one line on the night the pause begins (the project's dial, or the organisation's maximum,
  is at Observe) and one on the night it ends, and nothing on the nights between.

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
  default branch, and never without a maintainer's decision;
- **apply failed**: an approved proposal the platform could not commit — its apply failed or never
  ran, the recovery pass asked for one more apply, and an hour later it was still not committed (the
  project may have no git binding, or the provider refused the commit). The card says so, with the
  reason, and offers **Approve again**, which asks for another apply; **Reject** ends it. Until then
  nothing retries it on its own;
- **waits for a merge**: an approved proposal for a page that an earlier knowledge merge request
  already creates and nobody has merged yet. It is not stacked onto that merge request's branch (you
  may be reviewing it) and does not open a second one that would conflict with it: it stays
  approved, the card names the merge request it waits for, and once that one merges the change is
  committed as an update on a branch of its own. If that merge request is closed instead, the page
  is created. Only a page an earlier approval would *create* waits this way: two approved changes to
  a page that already exists still open two merge requests.

A Librarian curation that a project's **stored settings** refused (they do not parse under this
release) is not lost: it is offered again at every recovery interval until the settings parse, and
the settings screen's refusal says how many curations are waiting on the fix.

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
as a free run. **In `local` provider mode** (a Claude subscription) every run is that second case:
the platform labels each run's cost an estimate and prices its token usage from the price list,
keeping the figure the CLI reported beside it — so budgets count list-price dollars for tokens a
subscription does not bill per token (operator guide § 8).

**A run that hands over its result in the turn that crosses its per-run cap keeps that result.** It
is shown as **completed** with a **budget cap crossed** badge on its page, and the stage moves on
instead of pausing the task. Its whole cost is still counted: the run's figure, the ledger, the
task's spend and every budget window include the overrun. The task's own cap is still checked before
its next run starts. The result is kept only if the Claude Code CLI accepted it and the platform's
own validation agrees. A run that stopped at its cap with nothing handed over still pauses the task,
as before.

A run that ended with **nobody measuring it** — the platform stopped it, or it crashed, or a cancel
or a lost process ended it before it reported — has no cost at all, and is shown as *not measured*.
This is only a run that got as far as asking for the Claude Code CLI: a run that never did — its
workspace refused the handshake, or a cancel or a lost process ended it while its workspace was
still being prepared — cannot have spent anything, is shown with a cost of **0**, and is never held.
Its run page says *This run did not start* in place of an empty transcript: for a run refused at the
handshake, the reason; for a run a person cancelled (or the platform's restart handed back) before its
CLI was asked to start, that it was stopped first and how far it had got — the run is still shown as
**cancelled**, because the status says who ended it.
Its spend is unknown, so every budget **holds** it at the per-run cap it was started under: a held
run is never counted as spent and writes no cost entry, but it counts toward the budget exactly as
spend does when the next run is admitted, and the pause says how much is held apart from what was
spent.
The hold ends when the process that ran it reports its cost, or when the budget's window rolls
over; the per-task cap never rolls over, so a task paused on a hold waits for a maintainer to raise
the cap. A task paused by **its own** cap shows **Raise this task's cap** on its page, to someone who
may set budgets in its project: enter a figure above the cap shown, and the task's own cap is raised and the task resumes at the stage it
stopped at. A cap is only ever raised, and raising it releases no hold — the held runs still count
against the new cap. A task an organisation, project or feature budget paused is not offered it: that
cap is raised where it is set. A task's **Cost so far** adds only the measured runs, and says *Excludes N runs nobody
measured* beneath it when there are any — as do the board card and the chat message when a task completes.

**The per-run caps are sized for a small or medium repository, and a raised stage cap needs a raised
task cap.** The shipped caps are refinement 2, architecture 5, implementation 15, code review 5 and
business review 3 USD, with a task cap of 50 USD, the same in both provider modes. A large repository
can need more: on the first local test (Autix, a large PHP application read by Opus 5 in `local`
mode) the architect spent its 5 USD reading the code, and its project raised its own caps in
`.agentic/config.yml` to refinement 5, architecture 15, implementation 40, code review 15 and
business review 10 (`stages.<stage>.budget_usd`). A run is admitted only if what the task has spent
and holds, plus that run's own cap, fits the task cap — so at those figures a task that spent 15 USD
on architecture cannot start a 40 USD implementation run under the default 50 USD task cap, and
pauses before it. The task cap has no configuration key in this build: raise it on the task, with
**Raise this task's cap**, to at least what its remaining stages may spend. In `local` mode the
dollars are list-price estimates (above), but they are what admission compares.

## 9. Integrations

Per-provider cards with health, and each provider's **setup guide** — written for the provider's own
screens, and the same text the operator reads. For a provider with an inbound webhook, the **Setup
guide** card shows the webhook URL to paste into the provider, with a **Copy** button; a provider
with no inbound half says it has none.

Nothing on this screen is a credential: the server strips every field a provider declares to be a
secret before publishing an integration's configuration, and publishes nothing at all for a provider
this build does not ship — because it then cannot tell configuration from credential.

**Add an integration** (admin) is a form on this screen, and **Test connection** is on each card as
well as in the wizard beside the binding it is about; both show the same answer (since WP-155 — the
wizard's button used to show nothing). Choose a provider and the form asks for the
fields that provider requires — its URL, its organisation or channel — and, for each credential, the
*environment variable* the server reads it from, which must be on the operator's allow-list (operator
guide, §4). The form never takes a credential. The server checks the configuration against the
provider's own schema before it stores anything, so a create can be refused for a reason outside the
form, and the server's own message — naming the field — is shown.

The form also offers the provider's optional settings, each as a control of its type (a yes/no
choice, a number, a comma-separated list); leave one empty and the provider's default applies.

An integration whose stored configuration would not load (one created before the form asked for
these fields) says so on its card, naming the fields. **Edit configuration** fixes it: it asks for
the required fields again, lets you change the optional ones, and removes the keys the provider does
not declare.

**Replace credentials** (admin) rotates a token: name the new environment variable for each
credential you are replacing, and the server seals the new value and deletes the old one. **Retire**
(admin) removes an integration you no longer use: its credentials are deleted and its card stays,
marked *retired*, with no controls, because the audit still names it. A project that binds it, or a
run credential it minted that is still live, refuses the retire, and the card says which.

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
for once the fault is fixed (the operator guide's §9 says what a re-queue does and does not do). The
newest come first, and **Show older** reaches the rest; the failed-jobs list beside it pages the
same way.

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

A lowered maximum applies from the next run or task; nothing already running is moved. When you
save one, the page lists every project the change caps — whose autonomy level or WIP limit in force
fell — with the value before and after. Each project's own choice is kept, so raising the maximum
again restores it. The provider
mode (an environment setting) and feature flags (a project's own) are not organisation settings. A
project's features are switched on its own settings page.

**The ticket lifecycle** is a project's own setting too: the project settings page's *Connections*
card carries the same form as the wizard's step 1 (§ 1, *The ticket lifecycle*) — every slot a pick
list of the tracker's own statuses, every slot allowed to stay empty, the two claim switches, and the
same check against the tracker when you save. Change it there at any time; a new *QA* mapping
applies to tasks created afterwards.

**Verification** is a project's own setting, on its settings page: *Agents run the checks* (the
default) or *CI runs the checks*. Choose CI when the project's pipeline already runs the tests and
static analysis on every merge request and the agents' workspace (2 CPUs, 4 GiB) is too small for
them — no agent then runs the test suite, a linter, a build or a dependency install (they are
refused as `command policy: block`), every agent with a shell is told the CI gate runs them, a red
pipeline comes back to the Developer with the failing job's log, and Discovery answers R1, R2 and R6
by reading the CI configuration rather than running anything (the evidence says so). The same key is
`verification.mode: ci` in `.agentic/config.yml`, which may switch a project to CI but never back.

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
| The business interview as a *conversation* with the Product Manager role (the form is built; Q102) | onboarding step 3 |
| Committing `.agentic/` configuration from the wizard itself (the project settings page does it) | onboarding step 5 |
| Re-answering the nine run-dependent readiness criteria after a merge (five are re-checked) | onboarding step 2 |
| Editing a knowledge document or the pipeline in the browser | knowledge, pipeline |
| Instance-wide feature flags and the provider mode as organisation settings (the provider mode is an environment setting; a project's features are its own) | settings |
| The statistics the screen lists under *Not measured, and why* | statistics |
| Moving a ticket to a *deployed* status once a deploy is seen (the *Done* slot moves it at the merge) | ticket lifecycle, onboarding step 1 |
| A ticket lifecycle for a project with two ticket trackers bound (the form says the pipeline applies one only with exactly one) | ticket lifecycle, project settings |

And one that is about the deployment rather than a screen: an agent stage runs only on an instance
whose operator set `APP_LAUNCHER_URL` and `APP_LAUNCHER_TOKEN`, because those switch on the `runner`
container WP-53 added — and a model credential: `ANTHROPIC_API_KEY`, or in `local` mode
`CLAUDE_CODE_OAUTH_TOKEN`, which a `local`-mode instance has used since WP-133 (before it, such an
instance ran no agent at all). [The first local test](first-local-test.md) sets all of it up. Without them a stage that needs an agent **queues** rather than failing —
nothing is lost and nothing is escalated, but nothing moves either. The platform gates are on the
same queue and stop with it, which on such an instance you only meet through a human path: a
hand-back to a gate stage, or a merge you make by hand.
Everything around it — intake from a webhook, the board, the commands, the knowledge base, the audit
and the cost ledger — works either way. A stage that **writes** (implementation, conflict
resolution, the librarian) also needs the GitLab integration to be allowed to mint short-lived
tokens (`mint_credentials: true`): the platform gives each run its own token — read-only for a
read-only stage, never one that pushes for a shadow task — and revokes it when the run ends. Where
GitLab cannot mint (GitLab.com Free), an administrator may declare a **static run credential**
instead (`run_credential: static`): one token every run of that project is given — a dedicated
user's, or the administrator's own repository-only one (`run_token_owner: operator`, handed to a run
only while the default branch is protected with push "No one") — which is not revoked when a run ends
and is never given to a shadow task — weaker isolation, which the operator guide states. On GitLab.com
the administrator may instead give the project an **SSH deploy key** (`run_credential: deploy_key`):
the platform keeps the key and a run only asks it to sign, so the key never enters the run's
workspace. With neither, such a stage fails at start naming the binding and both
settings, and a read-only stage can check out only a repository GitLab serves without
authentication. The [operator guide](operator-guide.md) §1 and §10
say the same thing from the other side.
