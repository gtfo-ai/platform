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
| answer a question, pause/resume, retry a stage, cancel a run, leave feedback | member |
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
An integration has to exist first, and creating one is the operator's job — the API serves it and no
screen renders a form yet, so the operator guide's §4 does it with a request. Once one exists it
appears here as a checkbox, "Test connection" makes one real call to the provider and records the
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
commands, and the lockfile install they need — so R1, R2 and R6 are answered by running them. It
cannot commit, push or add a dependency, and nothing it writes is kept.

Readiness is evaluated **once, here**. Nothing re-checks it after a task merges yet.

### Step 3 — Business interview — **not built**

[product/06](product/06-project-onboarding.md) describes a conversational form driven by the Product
Manager role, which writes the product-context pages. Nothing in this build runs that interview. The
step says so and links to the knowledge browser, where the same pages can be written by hand. It is
the reason repository readiness cannot reach level 3 from the wizard alone.

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
configuration file wins wherever it sets one of `pipeline.limits.human_rounds`,
`pipeline.limits.question_timeout`, `policies.knowledge_apply.auto_apply` or
`policies.probation_tasks`; nothing else in it overrides the dial. The policy list under the dial
marks the two that set nothing by themselves: `review_only` (the Review-only card is the switch) and
`suggested_readiness_min`.

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

What step 5 does **not** do is commit the *configuration* (`.agentic/`); that is drafted nowhere yet.

## 2. Dashboard

Spend, active agents and open work at a glance, and a way into each project. The agent count moves
live.

## 3. The board

**A project → board.** One column per task state, with the pipeline stage shown on the card.

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

Nine of the eleven commands the product serves (the other two are on the run screen). Each is an
operation the task aggregate either performs or **refuses by name** — a refusal comes back as an
error naming the transition, not as a silent no-op — and each accepted one leaves a row in the audit.

| Command | Who | What it does |
|---|---|---|
| **Pause** | member | stops the task from entering another stage |
| **Resume** | member | lets it continue |
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
nothing twice.

### The checks panel, and what it cannot show

The product defines eleven merge-readiness checks, and the panel shows **ten** of them:

- **Acceptance criteria** and **Business verdict** — read from the latest Acceptance Verdict the
  business review wrote: how many criteria were met, not met or untestable (each with the
  reviewer's evidence), and whether it approved or asked for changes. No verdict yet says
  *no verdict*; a verdict the server refuses to serve says *unavailable* and why.
- **CI status** and **Rebase status** — the latest attempt of each gate: green or red, up to date
  or conflicts, *checking* while it decides, *not reached* before the task gets there, and
  *escalated (…)* with the reason when the gate stopped for a person.
- **Review threads** — open and resolved human threads on the merge request, as the review window
  last counted them. It counts when somebody comments while the task waits for merge; until then
  it says *not read*, never zero.
- **Coverage delta**, **Dependencies**, **Risk classes**, **Required reviewers**, the **Estimate**
  against what the task has spent, and **Questions pending**.

The eleventh, the **tamper check**, is named as absent with its reason: it needs the platform to
compare the paths a change touches with the exceptions its plan declared and to store the result,
and this build does not do that yet. It is never drawn as an empty tick that reads as "passed".

### What is not on this screen

- ~~**Take over** and **hand back**~~ **are on this screen since WP-44** (and on the run screen,
  for the run's task). **Take over** pauses the pipeline, interrupts the running agent, commits and
  pushes its work in progress on `agentic/<ticket>` and answers with the branch, the
  `claude --resume` command and whether the workspace was exported — the panel shows exactly those,
  in the tense the platform means them (*requested* is "being pushed as the run winds down", not
  "done"). Tick **Also archive the workspace** to get a tarball too. While you hold the task the
  panel shows your branch and the resume lines, two downloads — **the transcript** of the run you
  interrupted (`GET /api/runs/<run>/transcript.jsonl`, rendered from the stored transcript each time,
  so it lasts as long as the transcript does) and **the workspace tarball** when you asked for one
  (`GET /api/runs/<run>/export.tar`, kept for **14 days from the take-over, whether or not you have
  handed back** — the taken-over workspace's own retention)
  — and **Hand back**, whose stage list is the task's own pipeline, so it offers nothing the platform
  would refuse. A task you took over and have not handed back moves to needing a human after
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
- **Ask the task a question.** The answers are a thread, and the task response has nowhere to carry
  one, so a question would post into a void.

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

**Steering a live run is the one thing the application asks for and the server does not serve.** It
pushes a turn into a session that is already running, which needs a transport to the running
container that this build does not have. Cancelling has the same limit from the other side: it ends
the run as a *record*, and does not interrupt what is executing.

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
reply *typed* in a Slack thread is not yet matched to its task on this build, so answer a question
here or on the task page. So the inbox links to the task rather than pretending to be the only way in. A
question is due after the project's question timeout — **1 working day** by default, counted on the
organisation's working calendar, so one asked late on a Friday is due on Monday — and an expired
question is not silently dropped; it moves the task to needing a human.

Approvals work the same way: the plan-approval gate is what the **Supervised** autonomy level turns
on above a certain task size, and any maintainer can decide it. An approval nobody decides expires on
the same calendar and at the same timeout as a question, and moves the task to needing a human too.

## 7. Knowledge

**A project → knowledge.** Three things:

- the **browser**: the knowledge base as it exists in the project's repository, as a tree and a
  document view;
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
the organisation, the project, or the repository's `.agentic/`). Read-only: editing validates and
exports to the repository, which needs the same missing editor.

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
screens, and the same text the operator reads. For a provider with an inbound webhook, the card shows
the URL to paste in.

Nothing on this screen is a credential: the server strips every field a provider declares to be a
secret before publishing an integration's configuration, and publishes nothing at all for a provider
this build does not ship — because it then cannot tell configuration from credential.

"Test connection" lives in the **wizard**, beside the binding it is about. **"Add an integration"
lives nowhere**: `POST /api/integrations` is served, the browser application even carries the client
call for it, and no screen renders the form — so this screen's cards are the ones an operator created
with a request (operator guide, §4). It is the one place in the product where the API can do
something the browser cannot.

## 10. Audit log

A filterable stream of configuration changes, oldest cursor forward. A secret in a diff appears as
the literal string `"changed"` — that is the server's doing, not the screen's.

Every human action taken through the product is recorded with the acting user, the command and its
parameters. A *refused* command records nothing.

## 11. Settings

The signed-in session, the theme, the instance version, and the user list with roles.

Autonomy defaults, provider mode, global budgets and feature flags are **named as absent** rather
than drawn as controls that would silently do nothing: the endpoints that would write them are not
built.

## 12. Statistics — **a stub, and it says so**

Delivered tasks, cost, lines changed, cycle time, return rates and intervention rate, with a CSV
export, are what this screen is for. None of it is published yet. The screen names the numbers that
are coming rather than drawing a chart on a response shape invented in the browser, or a page of
zeroes that would read as "we delivered nothing" instead of "nothing is measured yet".

## 13. The whole list of what is not there yet

In one place, so it is not spread across thirteen sections:

| Not built | Where you meet it |
|---|---|
| Steering a live run | run detail — the only endpoint the application calls that the server does not serve |
| Ask the task a question | task detail |
| The business interview | onboarding step 3 |
| Committing `.agentic/` configuration from the wizard | onboarding step 5 |
| Re-evaluating readiness after a task merges | onboarding step 2 |
| Editing a knowledge document or the pipeline in the browser | knowledge, pipeline |
| Organisation settings (autonomy defaults, provider mode, global budgets, flags) | settings |
| Statistics | statistics |
| Nine of the thirteen merge-readiness checks | task detail |
| Creating an integration from the browser — any screen at all | integrations, onboarding step 1 |

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
