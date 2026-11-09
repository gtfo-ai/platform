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
administrator. Until somebody has signed in, the sign-in page says to use the administrator email
set at install; the exact setting it comes from is under **For administrators**.

**When something is refused, the screen says why in plain words** — *Your role does not allow
this.*, *That stage is not the one the task is at now.*, *Some settings are invalid: Base URL.* —
built from what the server answered, not copied from it. The server's own message, which names ids
and internal paths, is folded under **Technical details** beneath it, for whoever has to look
further. In the same way, a screen that mentions a server setting, a configuration key or the
repository's settings file says so in words, and the exact name is under **For administrators**.
An address that does not exist shows *This page does not exist* inside the usual frame, with the
address you asked for and **Go to Home**.

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

**Home · Projects · Inbox · Agents · Statistics** — the row under the top bar, the five screens of
every day, its current entry underlined in amber. **Projects** carries the number of projects,
**Inbox** what waits for you (open questions, pending approvals, held CI jobs and stopped tasks) and **Agents** the runs in
flight; a count that is zero, or not loaded yet, is not drawn. On a narrow screen the last entries
move into a **More navigation** (`···`) menu at the end of the row, and the running pill shows only
its number. There is no *Onboarding* entry: a project is set up once, so the wizard is **New
project** — in the top bar's **+** menu and on the **Projects** page.

**Settings** is the **gear** in the top bar, between the inbox and your avatar (on a phone, the
account menu's *Settings*; `g` `s` from the keyboard). The screens you open weekly rather than
daily — **Integrations**, **Workers** and the **Audit log** — are its **Admin** section (section 11).
Their addresses are the ones they always had (`/integrations`, `/workers`, `/workers/approve`,
`/audit`, and so on), so a bookmark or the link a worker shows you still opens them; they now open
beside the Settings list, with their entry marked — except the two wizards, *New integration* and
*Add a worker*, which keep the page to themselves — and the search finds them by name.

**Inside a project the row becomes the project's own tabs** — **Board**, **Knowledge**,
**Pipeline**, **Budgets**, **Trial** (only before the project's first live task or while it has a
trial — section 8, *Trial*) and **Settings** — under a header with the project's name, its
key, its readiness (what agents may do there, below under *Projects*) and — on the board, if you may
start a ticket in it — a **Start a ticket** button. A task's page sits under its project's header
too, on the Board tab, when opened from its board; from the inbox or Agents it does not yet. Every
address is the one it always was: `/projects/ACME` is the board, `/projects/ACME/knowledge` its
knowledge, and so on.

**The top bar and the row under it stay at the top while you scroll** — inside a project only the tabs
do, and the project's name scrolls away; on a phone only the top bar stays, so the page keeps the screen.

**The top bar**, left to right:

- the **agentic.** wordmark, which goes Home;
- inside a project, **/ *project name* ▾** — the project switcher: every project by key and name,
  the current one checked, then **All projects** and **New project**;
- **Search or jump to…** — the command palette (below); on a narrow screen just its magnifier;
- **● *N* running** — the runs in flight, pulsing amber while any is (still, if your system asks for
  reduced motion), and a link to **Agents**. The small dot beside it is the live connection: green
  while the page is receiving updates, with its word — *Connecting*, *Reconnecting*, *Server
  restarting*, *Disconnected* — shown beside it whenever it is not live, because a page that has
  stopped receiving updates has also stopped changing;
- **+** — **New project** (for an admin: creating a project is an admin's), and inside a project you
  may start tickets in, **Start a ticket…**, which opens the board's *Start a ticket* dialog (below); with
  neither, there is no **+**;
- the **inbox** button, with the number of questions, approvals and held CI jobs waiting for you
  (Home's *Needs you* also counts tasks that stopped for a person, so the two numbers can differ);
- your avatar (below).

Screens that show live data subscribe to a server-sent event stream, so agent counts, task states
and transcripts move without a refresh.

**Your avatar, at the right of the top bar, opens the account menu**: who you are signed in as and
with which role, and **Sign out**. There is one theme, dark, so there is nothing to choose.

**After the platform is upgraded, an open tab asks for a reload.** A banner under the navigation
says *The platform was updated — reload this page*, with a **Reload** button, in place of the error
an old page would otherwise show when the new server's answers no longer match what it expects. The
page checks the server's version each time its live connection comes back (a restart drops it) and
whenever an answer does not match. If the server is the **same** version as the page, a mismatch is
a real fault and is shown as the error it is; an instance built from a checkout has no version to
compare and always shows the error.

### Search and keyboard shortcuts

**Search or jump to…** in the top bar — or ⌘ K (Ctrl K on Windows and Linux), or `/` — opens the
command palette: type part of a screen's name, a project's name or key, or a ticket key, move with
↑ and ↓, and press Enter to go there; Esc closes it. Besides the places it offers a few actions:
**New project** (for an admin), **Start a ticket in this project** (inside a project you may start
tickets in), **Open inbox** and **Keyboard shortcuts**. Its screens are the top row's, **Settings**,
and Settings' **Integrations**, **Workers** and **Audit log**. It searches what the page has already read,
so a task is found by its ticket key once its project's board (or Home) has been opened in this
tab; it asks the server for nothing new.

The shortcuts — `?` lists them all:

| Keys | Does |
|---|---|
| `⌘ K` | Search or jump to (Ctrl K on Windows and Linux) |
| `/` | Search or jump to |
| `?` | Show these shortcuts |
| `g` `h` | Home |
| `g` `p` | Projects |
| `g` `i` | Inbox |
| `g` `a` | Agents |
| `g` `s` | Settings |
| `g` `b` | The board, inside a project |
| `j` | Next row |
| `k` | Previous row |

`g` then a letter means the two keys one after the other, within about a second and a half. `j` and
`k` move between the rows of the list that has the focus — the project list, the inbox, the
integrations, the board's list view, the Agents list and the other lists drawn as a bordered box. None of them does anything while you type in a field, and **Settings → Keyboard
shortcuts** turns them all off for this browser — ⌘ K and Ctrl K still open the search, because a
key chord with ⌘ or Ctrl cannot be typed by accident.

**A row that opens something opens from anywhere on it**, not only from its title: a project, a
run, an integration, a task on the board (its card too), a *Needs you* item — which opens its task,
so an approval (**Review plan**) and a question (**Answer**) are always decided on the task page, never by a click on the row. A
row's own buttons and menus (`···`, *Open task*, a problem's repair) keep their own click. The row
is still an ordinary link, so ⌘-click or a middle click opens it in a new tab and right-click copies
it. A row with nowhere to go — a worker, an audit entry, a knowledge proposal — does not light up
under the pointer.

## 1. Setting up a project — New project

**New project** — in the top bar's **+** menu, the button on **Projects**, or Home when there is no
project yet — opens the setup wizard at its first step. The page is headed *New project*; on the
left is the list of six steps, on the right the step you are on, with its title, one sentence saying
what it does (and, where it is known, how long it takes and what it costs) and, at the bottom,
**← Back to …** and **Continue to …** — the button names the step it goes to.

| Step | Done when |
|---|---|
| 1 **Connect** | the project exists and has a ticket tracker **and** a git integration bound |
| 2 **Technical discovery** | discovery has recorded a readiness evaluation |
| 3 **Business context** *(optional)* | a business page has been proposed |
| 4 **History** *(optional)* | a history bootstrap has been started |
| 5 **How autonomous** | the operating mode has been saved |
| 6 **Review and finish** | nothing drafted waits for your review |

A done step shows a check (✓), the step you are on a filled dot, the others an empty one; the two
optional steps are tagged *Optional*. **You cannot jump past a required step that is not done**:
*Continue* is off, with the reason beside it (*"Bind a git integration to continue."*), and the
later steps in the list are plain text rather than links — an address that names a later step says
*… is not open yet* and links the step that comes first. Done steps are links, so you can go back to
any of them. The optional steps have **Skip for now** beside *Continue*: it moves on and records
nothing. **One button is the coloured one**: while a step is not done, its own action is
(*Run discovery*, *Save operating mode*, *Propose the pages*…); once it is done, *Continue* is.

**Everything is saved as you go, because every step's state is the server's** — which project
exists, what is bound, whether discovery has run, what is in the knowledge queue. **Save and exit**
(top right) goes Home. The address is `/onboarding?project=<key>&step=<step>`; open
`/onboarding?project=<key>` and the wizard continues at the first step that is not done (an optional
step you passed over counts as passed once a later step is done). `/onboarding` alone is always a
**new** project; *Continue an existing project*, under the step list, lists the ones that exist.
Every step is also on the project's **Settings** page, so nothing is reachable only here.

### Step 1 — Connect

Three sections on one page. **Project details** starts from the **repository URL**: paste it, and
the **name** and the **key** are proposed from it — `https://gitlab.com/autix/autix-core.git` (or
`git@gitlab.com:autix/autix-core.git`) proposes the name *autix-core* and the key `autix_core`. Both
stay editable: a field you typed into is yours, and changing the URL afterwards leaves it alone;
while you have not touched the key, it follows the name you type. Then the **default branch**, which
is **not** proposed — a URL does not say which branch is the default, and nothing has asked the git
provider yet. *Create project* creates the project and keeps you on this step. Then
**Integrations**: the ones it uses. Then **Ticket lifecycle** (below).

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
with the request in the operator guide's §4 — **Add an integration** in this section opens that
screen. *Continue* opens once a ticket tracker and a git integration are bound. Once one exists it appears here as a checkbox, "Test connection" makes one real call to the provider and records the
result. The result is shown beside the integration you
tested, as on the Integrations screen: *testing…* while the call runs, then **Last test: passed** or
**Last test: failed** with each check the provider answered, or a notice that the test could not be
run. A wrong token is therefore a failed test here rather than a failed run tomorrow.

The checkboxes start at what the project already binds, and the save button **replaces the
project's set with the ticked ones**, so it is labelled with what it will change: *Save 2
connections* when you tick one more, *Remove the git host connection* when you untick one, and *No
changes to save* (switched off) while the ticks equal what is bound. Binding the tracker
and then the git host in a second press keeps both. Unticking a bound integration asks first, naming
what stops working (the tracker stops feeding tickets, the git host stops merge requests, chat stops
receiving questions); only *Remove connection* in that dialog sends the change. The integration
itself is never deleted here. The project settings' *Connections* section is the same selection
and the same button.

You never paste a credential into the browser, at any point. What is named is the *environment
variable* the server should read, and the server seals the value itself.

#### The ticket lifecycle

Once a ticket tracker is bound, step 1's **Ticket lifecycle** section shows the moments at which the platform
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
| **Returned** | One or more statuses, never set by the platform: a person moving the ticket into one of them returns the task to the agent. A checkbox per status, with a count of how many are ticked; at most ten. |
| **Done** | Moved here when the merge request is merged. |

Two switches sit under the slots. **Claim the ticket before the first run** (on unless you switch it
off): before a task's first run the platform assigns the ticket to the tracker integration's own
account, moves it to *In progress* if that slot is mapped, and reads the ticket again. If somebody
else holds the ticket, the task stops in **Needs you** with the reason *assigned elsewhere* — its callout
says whose ticket it is (*"AUT-6676 is assigned in Jira to Vojtěch Kaizr, so no agent started on it."*, and
that they aren't a linked member of this project when the platform cannot hand them the task) and offers the ways out in the box:
**Take it** or **Assign…** (the same confirmation as the header's, which says when Jira is assigned too),
**Link account…** for an administrator, **Open in Jira** and **Cancel task…** — and the header's owner line then
reads *Unassigned* with no buttons of its own, so there is one **Take it** on the page. Once the task has an owner,
**Give it back to the agent** (then the page's amber button) runs the stage again: the claim keeps the ticket for that owner even while Jira still
shows the other person, and the callout says so (*"Jira still shows Vojtěch Kaizr, which doesn't stop the agent."*,
or that the owner is being assigned in Jira when the project writes owners back). The platform's own account of the
stop is under *Details* (since S-25.14). On the board card, Home's *Needs you* and the Inbox the stop reads
*"Waiting for: Vojtěch Kaizr's Jira ticket"*. No run
starts, and the platform posts one comment on the ticket — *"The agent did not start work on this
ticket: it is assigned to somebody else. A maintainer has been asked who should take it."* While
claiming, a ticket already assigned to a person is not started at all, unless you tick **Also start
tickets already assigned to a person**. On cancel or rework the platform unassigns itself (and moves
the ticket back to *Pick up from*, if mapped).

A third switch, **Assign the owner in the tracker** (off unless you tick it; since S-26.8a), writes a
task's owner back to the ticket: *"When someone takes or is assigned a task here, also assign the
ticket to them in Jira. Only people who linked their Jira account are assigned there."* It is saved
with the rest of the lifecycle, and like the slots it is a maintainer's (section 4, *Task
detail*, says what it writes and what it never does).

**A ticket assigned to a member of the project stays theirs** (since S-26.2). When the assignee is a
tracker account linked to a member (or above) of the project (*Settings → Linked accounts*), the
ticket is started even with **Also start tickets already assigned to a person** unticked, the task's
owner is that member, and no claim — the first, or the one after a return — reassigns it: the
platform writes no assignment, still moves the ticket to *In progress*, and runs. A cancel or a
rework never unassigns that person. *Assigned to a person* in the rules above therefore means a
person the platform cannot link to a member — an unlinked account, or a linked person below
member — and the switch **Also start tickets already assigned to a person** now takes only those.
Because a broad pick-up rule (*every To Do ticket*) now starts members' assigned tickets too, a team
whose tracker assigns everything narrows intake with a pick-up label.

**Taking the task unblocks the claim.** When a task stopped because its ticket is *assigned
elsewhere* — to somebody the platform cannot link — a maintainer can **Take it** or **Assign…** it
on the platform and then **Hand back**: the claim then leaves the ticket with the person who holds it
in the tracker, writes no assignment, still moves the ticket to *In progress*, and the run starts. No
later claim (after a return either) writes the integration's own account over that person. The
tracker keeps showing them until the project writes owners back (*Assign the owner in the tracker*,
which then assigns the ticket to the new owner when you take it) or somebody changes it there. A
change in the tracker after your take wins as usual: it replaces the owner, and the next claim
follows the rules above again. A cancel or a rework of such a task unassigns nobody.

**Save the ticket lifecycle** checks every name against the tracker's statuses before anything is
written. A name the tracker does not list is refused, the slot that names it is marked, and nothing
is saved; if the tracker cannot be read at that moment, the form says the statuses could not be
loaded and nothing was saved, and keeps your choices so you can save again. A name you saved earlier
that the tracker no longer lists is shown above the slots as *Not listed*, and the slot is empty
until you pick again. **Binding a tracker in this step for the first time also saves its lifecycle**
with every slot empty and the claim on — the step says so under the save button before you press it — so a
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
produces two things (below). **Run discovery** carries its budget cap on the button (*up to $2.00*,
a ceiling, not a prediction). The step shows where the discovery is **now**, read back from its task
whenever the page loads — a refresh included — and followed live while the page is open: *queued*
(its run has not started), *running* with the agent's latest progress line and **Watch live**, a
link to the run page (the step list says *Running now* too),
*needs a person* with the escalation's reason and brief, *paused*, or *done* with the project's current readiness level
(which a later re-check or re-evaluation may have moved since the discovery recorded it) — and **Open its task** leads to the task page. The sentence the button answers with
(*"the Discovery agent is queued"*) is only the click's immediate feedback.

What discovery produces:

- a **readiness evaluation**: fourteen criteria and a level from 0 to 4
  ([product/17](product/17-repository-readiness.md)), shown as a meter, each criterion by a short
  name (*Tests run green*, *Protected default branch*…) with what it unlocks, its id (R1…R14) and
  the agent's evidence under **Details**, and the three cheapest improvements named —
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

*Continue* opens once a readiness evaluation exists; until then **Save and exit** and come back —
the step list shows the discovery as running.

### Step 3 — Business context (optional)

[product/19](product/19-operating-definitions.md) §8's eight sections — product, users, business
rules, glossary, direction, quality bar, review expectations, communication — as a form. Each is
optional: leave it empty to skip it, or tick **Not applicable** (with an optional reason). The whole
step is optional too: it is tagged *Optional*, and **Skip for now** moves on to the next step and
records nothing — the step stays in the list to come back to. The same form is on the project
settings page under *Business context*, so a skipped interview can be answered there later.

Submitting writes **proposals, not pages**: each answered or not-applicable section becomes one page
under `business/` in the knowledge proposals, where a maintainer approves or rejects it (the
Knowledge screen has no editor: to change a page, reject it with a reason and answer the section
again), and approving it opens a merge request like any other proposal. Nothing is committed from the form. The
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

### Step 4 — History (optional)

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

### Step 5 — How autonomous

**How much agents do alone** — the autonomy dial ([product/19](product/19-operating-definitions.md) §11) — has four
positions, each said as what happens to a ticket:

| Position | What it means |
|---|---|
| **Observe** | Agents start no ticket. You can try them on past tickets; nothing reaches your repository. |
| **Assist** | Agents write the spec and the plan for a ticket, then stop; a person writes the code. |
| **Supervised** *(default)* | Agents deliver; you approve the plan of a large ticket, and the first 5 tasks get extra checks (the platform's *probation*). |
| **Autonomous** | Agents deliver without asking, unless a change touches a sensitive area (a *risk class*). A person still merges. |

Choosing one and pressing **Save operating mode** writes the project's configuration; *Continue*
opens once it has been saved once. Which commands the agents may run is not edited here — *Learn
more* under the panels says why.

**What a position does to a task.** Moving the dial affects a running task only in part. Three
policies are **fixed when a task starts** and do not move with the dial afterwards: whether business
review runs, Assist's stop after architecture, and the number of human review rounds. The rest are
**read when they are used**, so a move reaches running tasks too: plan approval and probation (at
the moment a plan is ready), the budget-approval threshold (when refinement finishes), the question
timeout (when a question is asked) and knowledge auto-apply (when a proposal is curated). **Assist**
parks a task in *Needs you* after architecture, with a brief that names the dial; hand it back at
*Implementation* to continue, or cancel it — after a maintainer has approved its plan, because
Assist asks for plan approval on every task. A ticket whose pipeline has no architecture stage (a
chore) parks before anything runs, since there is no point at which it could stop before code is
written. Assist also turns the business-review stage off, so a task handed back past the park skips
it. **Autonomous** allows five human review rounds on a merge request where the other positions
allow three, and auto-applies knowledge proposals in the middle significance band. The project's
**settings** override the dial wherever they set one of `pipeline.limits.human_rounds`,
`pipeline.limits.question_timeout`, `policies.knowledge_apply.auto_apply` or
`policies.probation_tasks`; nothing else overrides it. The repository's own `.agentic/config.yml`
overrides **none** of the four: from the file they are *not applied* (step 6 below says why). The policy list under the dial
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

**Trial runs** (the Observe position; *Shadow mode* before S-25.7) runs the pipeline on closed
tickets you pick and posts nothing — a trial run on tickets you already shipped (section 8,
*Trial*). For each ticket that has a human merge request it also runs **one reviewer over that human
merge request**, and that review is a task of its own: a card on the board keyed
`mr!<iid>/shadow/<task id>`, part of the trial, with its own spend counted against the trial's
budget. It posts nothing on the merge request — every comment it would have written is recorded in
the audit log as *would have* — and its findings, with a comparison of which of the agent's own
acceptance criteria each side met, appear on the ticket's trial report once it ends.

### Step 6 — Review and finish

A summary of what was set — the project, the integrations bound, the readiness level, the business
pages and the history (or that they were skipped), the operating mode and how many drafted pages
wait for your review — then **Review the drafted pages** (the knowledge queue), **Propose the
settings to the repository** (the project's settings page, below) and **Open the board**, which is
where the wizard ends.

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

## 2. Home

**Home** in the top navigation (it was called *Dashboard*), and the wordmark at the top left. It
answers three questions in this order: what needs you, what is moving, and where to go.

- **Needs you (N)** comes first: every open question and pending approval in the organisation, and
  every task that was escalated to a person (*Needs you* on its board) and has no question or
  approval of its own. Each row names the project, the ticket and the stage, the question's first
  line (an agent's words, shown as plain text) or **what the approval is about** (*Plan v2 · size L ·
  6 files*, a budget's estimate and threshold, or *the plan it is about was not recorded* for one
  asked before approvals recorded their plan), how long it has waited, and the action — **Answer**,
  **Review plan** or **Open** — which opens the task. No row approves in one click: the plan is read
  on the task page, beside its buttons. The oldest waits at the top; the box shows five
  and **View inbox →** has the rest. When nothing waits it says *Nothing needs you right now.*
  **An administrator also sees what broke in the background** here, after those rows and never
  pushed out by them: *3 events are stuck* (events whose handler failed every retry) and *1
  background job failed*, each only while its count is above zero, and each **Review** opens its
  section of Settings (*Stuck events*, *Failed background jobs*). Nobody else is shown them, or asked
  for them. **When tasks stopped for a person hold a project's queue** — its tickets cannot start
  because those tasks fill the places the project allows — one more line says so: *5 tickets can’t
  start until these are decided or cancelled*, linked to the board's **Queued** column.
- **Running now (N)**: every run that is running — its stage and role (the link to the run), the
  project, the ticket, what it is doing in the words the Agents page uses (*Working: Reading files*,
  *Thinking*, *Stuck: No activity for 12 min*), how long it has run, what it has cost so far and the
  latest progress line the agent reported. **Agents →** has the whole list; a run's model is on its
  own page.
- **Projects**: one row per project — its name (the way into its board), its key, a word for its
  status when it is not active (*Paused*, *Archived*), its readiness
  (what agents may do there, as on the Projects page), its open tasks and its spend over the last 30 days — and, for an admin, **New project**,
  which opens the wizard.
- On the right, **Spend** — *Against the monthly cap*, the organisation's monthly cap as
  *$412 of $1,000* with a meter, when one is set (the month so far), and *Spend, last 30 days*
  across all projects either way: two windows, each named on its own line, then **Organisation
  budgets** (where those caps are set) and **Statistics** (what the spend bought) — and **Instance**:
  whether the live connection is up, and the version.

Every box refreshes on its own when something happens — a question asked, a run started or
finished — without reloading the page.

**A new instance is set up from here.** For an admin, while there is no project — or no
integration — Home is a **setup checklist** instead of the boxes: *Connect your tracker and git
host*, *Create a project*, *Run technical discovery*, *Choose how autonomous agents are*, *Start
your first ticket* — and, on a platform whose server runs no agent work (the project's *Execution*
settings say so), **Connect a worker** before the ticket, because nothing runs until a developer's
computer does. That step is ticked once a worker takes work — by itself, or only the runs its owner
picks; a worker that exists but cannot is named with the platform's reason and what to do (*jan-mbp
can't take work yet: not connected to the platform. Start the worker on that computer…*) — or, while
it updates itself, *jan-mbp is updating now*, which needs nobody — and *Continue setup* opens the
**Add a worker** wizard at *Ready to work* for it. On a platform whose server runs agent work the
step is not there at all. Each step is ticked from what the platform already knows (an integration of
each kind exists, a project exists, its readiness was evaluated, its operating mode was applied, it
has a ticket's task), never from what this browser remembers, so a step done in another tab or
through the API is ticked too. **Continue setup** opens the first step that is not done — the
Integrations screen, the wizard (on the project, when it exists) or the board's *Start a ticket*
dialog — and every step's name is a link to its own screen. Once a project exists, the checklist moves
to the right-hand column as *Finish setting up*. **Once that project has run a ticket the checklist
is gone**, whether or not discovery and the autonomy dial were ever ticked — those have working
defaults, and the project's settings hold them. From then on the right-hand column names only a
piece that is still **missing**, under *Missing from setup*, with what its absence costs and a link to
fix it: *Merge requests can't be opened until a git host is connected* (**Connect a git host →**),
*New tickets can't reach the agents until a tracker is connected*, or — where nothing on the server
runs the project — that no agent can run its tickets until a worker is connected (or why the one you
have can't take work yet; with several, how many can't and why, such as *3 can't take work (2 not
connected, 1 needs an update)*, with **Open Workers →**). With nothing missing, there is no box at all. The checklist follows the
oldest project; a later project's steps are the wizard's to show. Every other role, on an instance
with no project, is told that an admin sets it up.

A maintainer or admin also sees **one banner** when an organisation chat account's credentials can
no longer be read: no project's runs are given the project's prompt files until the credentials are
replaced or the integration is retired. **Fix it** opens that integration, whose card says the same
(WP-157).

### Projects

**Projects** in the top navigation: every project you can read, one row each — its name (the way
into its board), its key, its **readiness**, its open tasks and its spend over the last 30 days. **New project** at the top right opens the wizard; with no project yet, the page
says what a project is and offers the same. How many things wait for you is not shown per project
yet — the inbox's count in the top bar is the total.

**Readiness says what agents may do in the project**, not the ladder's number
([product/17](product/17-repository-readiness.md)): *Plans need your OK* at level 0 — the normal
start, drawn in a neutral grey, never red — *Big plans need your OK* at levels 1 and 2, *Agents plan
on their own* at level 3 and *Ready for more autonomy* at level 4, the last two in green. The same
badge is on the project's header and on Home. **Press it** (or focus it and press Enter) for its
definition: the level's name and number (*Level 0 · Unverified*), what the level means now, the next
level and what it needs, the first criterion it is missing with how to fix it, and a link to the
project's *Discovery & readiness* settings. The missing criterion is read from the project's latest
readiness evaluation when you open it; a project discovery has not evaluated yet says nothing is
known to be missing.

### Agents

**Agents** in the top navigation answers *what are my agents and workers doing right now, and what
needs me*. Under the title one line says it in words — *2 working · 1 needs you · 1 waiting · 3 free
seats*, and *· 1 stuck* when an agent has been silent too long. The page has no button of its own:
what needs you is the map's **Needs you** box, whose title opens the inbox, and the list's own
section. Below it, three views of the same live data; the one you pick is
remembered in this browser and is part of the address (`/agents?view=office`), so it can be sent to
somebody:

- **Map** (the default): your organisation on the left, then one card per **seat** — the platform
  server, and each worker machine with its owner, *2 of 3 slots busy* and a *Paused* badge when it is
  paused — and to the right of each seat the runs it holds, then its free slots. Under the seats the
  **Queue** holds the runs no seat has picked up yet, and under the organisation **Needs you** lists
  what waits for a person, each a link to its task. A run's card shows its ticket key and title, the
  project, its status (*● Working*, *Thinking*, *Needs you*, *Stuck*, *Waiting*), the *Now: Reading
  files* line, the task's whole pipeline as a strip of stages with the current one named, the model,
  how long it has run and what it has cost so far. A connector is dashed and moving while the agent
  works and solid amber while it waits for you. Drag to pan; the buttons in the corner zoom and fit.
  On a narrow screen the list is shown instead.
- **Office**: the same seats as a pixel office, always in the dark brand colours. Each worker is a
  room with its name on the door plate, and the server is the *Platform room*. Each run sits at a desk
  as the platform's robot, posed by what the agent is doing — typing, thinking (a growing thought
  bubble), a raised hand with a *!* when it needs you, scratching its head with a *?* when it is stuck,
  a coffee while it starts up — with a speech bubble saying *Now: …* and a nameplate with the ticket
  and the stage. A free desk has a sleeping robot (a coffee on a paused worker); a run that has just
  finished cheers for a moment, one that failed slumps. Runs waiting for a seat sit on the bench in the
  **Lobby**, and what needs you stands at the beacon-lit **help desk**, each a link to its task. If
  your system asks for reduced motion, every robot holds still. Each desk is a button whose name says
  everything the drawing does, in words — *DEMO-1 · Checkout flow · Code review · working: Reading
  files · worker jan-mbp* — so a screen reader hears what a glance sees.
- **List**: every live run as a row, what needs you first, then what is stuck, then the rest oldest
  first — project, ticket and title, the stage, what the agent is doing, where it runs, the
  stage strip, how long and how much (the model is in the run's dialog) — with a `···` menu: **Open run**, **Open task** and **Cancel
  run…**, which asks before it stops the agent. A run that has just ended stays at the end of the
  list as *just finished* or *just ended* for as long as the map and the office keep it at its desk;
  one that failed says why beside *Failed* — *Failed: Lost its worker*, *Failed: Did not start*,
  and *Failed: Did not report its cost* for a run the platform stopped because it
  could not measure its cost, which is a fault and never *Hit its budget* —
  the same words the board card and the task's run list use.
  Below it, what needs you and every seat with its slots.
  This is the view that always tells the whole story; the other two never say anything it does not.

A card, a desk or a row opens the same dialog: the run's **Live activity** beside its **log**, where it
runs, and **Open task** / **Open run** — messaging the agent and stopping it stay on the run page. The page updates
on its own: an event from the platform refreshes the lists, the clock moves *elapsed* and *stuck*
every 15 seconds, and the *Now: …* of up to twelve runs on screen follows their transcripts live
(at most one refresh a second).
With nothing running, the map and the list say *No agent is working* with a way to a board, and the
office shows everyone asleep under the same words. On a platform whose server runs no agent work and
with no worker registered, they say **Waiting for a worker** instead, with **Add a worker**, and the
queue and the office's bench say their runs wait *for a worker* rather than *for a seat*. With workers
that can't take work, they say **No worker can take work** and why — the first worker and its first
reason, *jan-mbp: not connected to the platform* — with **See why** to the Workers page; while runs
wait, a line above the views says *1 run is waiting and no worker can take them: …*, and the queue
and the bench say *waiting, and no worker can take them*.

What it cannot show yet: how many runs the platform server takes at once (no reading reports it, so
its seat says *2 running* rather than a slot count, and the free-seat count is the workers' alone);
whether a worker is draining; a worker that is not yours unless you are an administrator (its runs
are still shown, on a seat named from the run); and an escalated task with no question or approval
(Home's *Needs you* lists those).

## 3. The board

**A project → Board**, the project's first tab. Five columns — **Queued**, **Active**, **Needs you**,
**Ready to merge** and **Done** — each headed by its name and how many tasks it holds; *Needs you*
is lit amber, because that is where your work is. **A task sits in Needs you whenever something
waits on a person** — an open question, a pending approval, a task that needs a human, one its
budget paused or one somebody took over — whatever stage it is in (a done or cancelled task never
does, whatever it left open), so the column, the card's ◆ and the task page's state always say the
same thing. Two placements to know: **a task paused by hand
sits in Active** (a pause a person made waits on nobody; its card says *Paused*), and **a merged
task, and one in its retrospective, stays under Ready to merge** until it is done. On a
narrow screen the columns scroll sideways, one column at a time, rather than wrapping, so the
pipeline still reads left to right.

**Each card says which phase the ticket is in and whether it needs you:**

- the ticket's **title** first — its own words as the platform read them — which opens the task;
  beside it, muted, the ticket key and the template's icon (feature, bug, chore, spike). Before the
  platform has read the ticket, the card names it by its key and says *Ticket not read yet*;
- a strip of the stages the task has **entered**, one mark each — done ✓, the current one ●, sent
  back ↺, failed, skipped — with the current stage's name under it. While an agent is working on the
  task, the card pulses amber and says what it is doing: *Code review · Now: Reading files*.
  Otherwise it says the task's state in words (*Waiting for answers*, *Paused*, …). Stages the task
  has not reached yet are not drawn;
- how long it has been in its current stage, and the measured cost so far: reported by the
  provider, or priced from the price list in `local` provider mode. A run that ended with nobody
  measuring it is left out of that figure, and the card then says so beside it — *excl. 2
  unmeasured*;
- a **◆** when the task waits on a person — a question, an approval, a task that needs a human, a
  task its budget paused or one somebody took over — with the number of open questions and pending
  approvals beside it (a task paused by hand is somebody's choice, and has none);
- a badge per loop the task has gone round, in rounds against its limit: *Review round 2 of 3*
  (*Review round 2* when the limit is not known);
- *touches ACME-12 · 3 files* when the rebase gate found that another active task changes the same
  files (the comparison runs at the rebase gate, so no badge means *not compared yet*).

**Why a queued ticket has not started.** A project runs at most so many tasks at once and holds at
most so many in its pipeline (*Parallel tasks* in *Settings → Rules & limits*: 2 and 5 unless a
setting says otherwise, and never above the organisation's maximum), and a task stopped for a person
still holds its pipeline place until it finishes or is cancelled. The platform checks both limits
whenever a task finishes, stops for a person, is paused or is cancelled, and starts the first queued
ticket when both have room. When they are full, the **Queued** column says so once, at its top —
*Waiting for a place: this project holds at most 5 tasks in its pipeline, and 5 are in it — 5 of
them wait for you. A place frees when one of them finishes or is cancelled, so decide them or cancel
one.* (*… wait for a person.* when you may not decide them; when the running tasks are at their limit
too, only a running task finishing or being cancelled frees a place) — and each queued card says its
own place instead of *Queued*: *2nd in queue · 5 of 5 places taken* (*2 of 2 running* when only the
running tasks are full). The queue is ordered by the ticket's priority, then by age. *1st in queue ·
a place is free* means the limits have room and the queue moves on at the next such change.

**The `···` menu on a card** offers **Pause…** or **Resume**, **Return to stage…**, **Cancel…**,
**Open ticket** and **Open merge request** — the task page's own commands. *Pause…* asks *Why are you
pausing it? — optional*, and what you write is shown on the task while it is paused. *Cancel…* asks first and says what
cancelling does (it ends the task for good); *Return to stage…* asks which stage the task has
entered to send it back to, and why — the stage is given your reason; a task that stopped at a gate
which recorded a failure carries it too, as the task page's ticked *Attach the check's last failure*
box does (open the task to send your reason alone). Who may do what is the table in section 4 —
cancelling and returning are a maintainer's, so a member's menu does not offer them. A merged task
can still be cancelled but not paused or sent back; a done or cancelled task offers only the links. A link the provider sent that is not a web address is shown struck through rather than
followed.

**List** (the toggle above the columns, or `?view=list`) shows the same tasks as a list, newest
first, with filters for the **state**, the **template** and **Needs you**.

**An empty board** says why it is empty. A project with **no tracker connected** says so — *No
tracker is connected* — with **Connect a tracker**, which opens the project's *Connections*; otherwise
it says how tickets arrive — a ticket that matches the project's **start rule** (a label, a status, an
epic or a query) — with **Open start rules**. Either way, if you may start one, **Start a ticket by
hand** is beside it.

The columns are task **states**, not pipeline stages, and that is deliberate for now: the column list
in the product spec is "the stages of the project's pipeline template, plus Queued / Needs human /
Done"; each card's strip carries its stage instead.

**There is no drag-and-drop, by design.** The pipeline owns task state; you move a task with a
command that the domain can refuse, not by dropping a card.

### Starting a ticket by hand

A ticket reaches the board when it matches the project's **start rule** (the pickup rule) — the label, status, epic or
query its task-management integration picks up. For a ticket no rule matches, a **member** (or above)
presses the project header's **Start a ticket** (or the top bar's **+ → Start a ticket…**, or an
empty board's **Start a ticket by hand**): a small dialog opens with the cursor in its **Ticket key**
field; type the key and press **Start**. None of these is shown to a viewer. The key is letters,
digits, `.`, `_` and `-` (for example `ACME-123`).

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

The task page reads like a pull request: what the task is, where it is, and what you do now. It is
live on that task's topic.

**A task has an owner** (since S-26.1): one person of the project, a member or above. The owner
follows the ticket's assignee when that assignee is a tracker account linked to a member of the
project (*Settings → Linked accounts*, an administrator's mapping, or the person's own *Settings → Your accounts*); an assignee the platform cannot link —
an unlinked account, or a linked person below member — is kept as *assigned elsewhere* and the task
has no owner, and the platform's own account or a machine account is nobody — it never takes a
task from the person who owns it, so the platform claiming the ticket keeps its owner. A ticket a
linked member holds is never claimed from them at all (step 1, *The ticket lifecycle*). A disabled
account owns nothing. **The latest change wins**: a change of assignee in the tracker replaces an owner set on the platform, and an owner set
on the platform stays until somebody changes the tracker. A member may take a task nobody owns (and
nobody holds elsewhere) or give back their own; a maintainer may give any task to any member, or to
nobody. By default nothing is written to the tracker. **A project can opt in to writing the owner
back** (since S-26.3; the ticket lifecycle's switch **Assign the owner in the tracker**, Jira only): then an owner set on
the platform — by a maintainer, or by a person picking the task on their own machine — is also
assigned the ticket in Jira, through their linked Jira account. Giving a task back writes nothing (the
platform never unassigns a person), an owner with no linked Jira account gets no write, a change made
in Jira before the write wins over it once the platform has seen it, and a shadow task's write is only
recorded. The task's `owner_writes_back` says whether its current owner is written back, and the task
read's `take_writes_back` whether *your* Take would be. The owner's computer gets the head start on
the task's runs (*Settings → Execution*, below). **A task that existed before owners did** — or any
live task whose ticket assignee the platform has never stored — has its ticket read **once** by the
recovery pass, about a minute after the upgrade, up to twenty tasks a pass, the most recently
touched first; so a task stopped because its ticket is assigned to someone else names that person
without anybody touching the ticket. An unassigned ticket is read that once and not again, and so is
a ticket Jira says is gone or that the platform's account may not see. A read that fails because
Jira is down, slow or refusing the credential is tried again 15 minutes later and then two hours
after that; after the third failure the platform stops, logs it, and the task waits for its ticket
to change or for its next stage to read it.

**The owner on the page** (since S-26.8b): beside the ticket's links, the owner's initials and
*Owner: Vojtěch* (*(you)* when it is you), *Unassigned* in grey, or — for a tracker assignee the
platform cannot link — *Assigned in Jira to Jan Novák (not linked to a platform account)*, with
*Link account…* (Settings → Linked accounts) for an administrator. Buttons by that line, and the
`···` menu, show **Take it**, **Assign…** and **Unassign** — only what your role may do: a member
takes a task nobody owns or gives back their own, a maintainer any of the three on anybody's task.
Taking a task somebody else owns asks first — *Take DEMO-1 from Vojtěch? Their machine stops
getting it.* — and, when your taking it writes the assignment back to the tracker (the project
writes owners back and your account is linked there), says that it also assigns the ticket there
(and whom it replaces there — whoever the tracker shows, the owner included). Taking a task nobody
owns that the tracker still assigns to somebody else — a person the platform cannot link, or a
colleague who gave the task back — asks only when your taking it is written back: *Take DEMO-2?
This also assigns DEMO-2 in Jira to you, replacing Jan Novák.* **Assign…**
opens a list of exactly the people the platform accepts as the owner (a member or above in the
project, with an active account); choosing one says what follows before you press *Assign* —
*Assign DEMO-1 to Petra? Vojtěch’s machine stops getting it.*, then *This also assigns DEMO-1 in
Jira to Petra, replacing Jan Novák.* when that person's assignment is written back, or *Jira still
shows Jan Novák.* when it is not. **Unassign** never changes the tracker: where assignments are
written back, the ticket stays assigned there. A line then says what follows: *Assigned to you.
Your machine picks it up at the next stage.* or *Assigned to Petra. Their machine picks it up at the
next stage.* On the **board**, a card shows its owner's initials at its top right
(the name in its tooltip), and *Everyone* · *Mine* · *Unassigned* filters the board and the list
(`?owner=me` or `?owner=none` in the URL); the board remembers your choice in this browser. The API
has the same: `owner` on every task, `POST /api/tasks/:id/owner`, `GET
/api/projects/:id/owner-candidates?task_id=` for the people a maintainer may assign, and `?owner=` on
a project's task list.

**Why a run waits** (S-26.5; in words since S-26.8b part 2): while a task's run waits for a machine
or the server to start it, the page says why nobody takes it now. The task page's *Now* line and a
note above the tabs say it in full — *Waiting for Vojtěch’s machine. It’s offline (last seen 2 h
ago).* — and a board card, its row on *Agents* and on Home's *Running now* in short — *Waiting ·
Vojtěch’s machine is offline*. The reasons: the owner's machine is offline (with when it was last
seen) or paused; it is online and still cannot take it — it *needs an update*, it is *still setting
up* (getting its run images), it is *finishing a run* and taking nothing new (an update or its
owner's own *Drain*), it is *at its usage limit* and resumes when the limit resets, it *waits on the
platform* (the platform's run images need fixing), or another reason in the Workers screen's words;
the owner has no machine that takes this project, or only picks runs by hand; no machine takes
unassigned tasks in this project; or the tracker assigns it to somebody who is not linked to a
platform account (*Waiting · assigned to Jan Novák (not linked)*), so only a machine that takes
everyone's tasks can run it. When the machine is yours, the words say *your machine*. The note offers
the next step you may take, never as the page's main button: *Take it* and *Assign…* when your role
allows them, *Open Workers* to the machine's owner (with *Update it from its page* when it needs an
update), *Open Instance* to an administrator when the platform's images are the reason, and *Link
account…* to an administrator for an unlinked assignee; everyone else sees the sentence alone. A task
somebody gave back is unassigned, whatever the tracker still shows. Nothing is said when a machine or
the server can take the run now. *Settings → Execution* also says, without naming anybody's machine,
whether the server or another person's machine takes this project's unassigned tasks by itself
(`others_take_unassigned`) — so a machine set to *Only my tasks* can tell whether unassigned tasks
would have nowhere to run.

- **The header** is the ticket's title with its key after it in grey (the key alone when the
  platform never read the title), the task's state as a label with its icon — *Needs you* whenever
  something waits on a person, by the same rule as the board's column — and one line: links to the
  **Ticket** and the **Merge request** (once there is one), the template, the stage it is in, what it
  has cost so far and how long ago it was opened. Under it,
  the phase strip — one glyph per stage, the current one pulsing — names the stage and what the agent
  is doing now. On the right is **one button, chosen by what the task is waiting for**: *Give it back to the agent…*
  while you hold it (below), *Answer* when an agent asked a question (it takes you to the answer
  box), *Review plan* when a plan or a budget waits for a maintainer (it takes you to the approval in
  the needs-you box, where the plan is shown), *Raise this task's cap…* when the
  task's own cap paused it and you may raise budgets, *Resume* when the task is paused or waiting
  for a person — and none when nothing waits on you. When the needs-you box below says how the task
  stopped and that the next step is to retry the stage (the rounds used up, the same failure again,
  CI that never finished) and no approval is waiting, the box's own **Retry stage…** is the page's
  one amber button and Resume moves to the `···` menu; from a stop both re-run the stage as a new attempt, and Retry stage also
  stops a run of it still going. Resume is never offered past an open question
  or a pending approval: answer or decide it instead. Everything else is in the **`···`**
  menu beside it: *Pause…*, *Resume*, *Work on it yourself…*, *Retry stage…*, *Return to stage…*, *Rework…*,
  *Raise this task's cap…*, *Download JSON* and *Cancel task…*. A command with fields, or one you
  cannot undo, opens a dialog with those fields. The menu leaves out what the platform would refuse
  for anybody — Pause, Work on it yourself, Return and Rework on a merged task, any stage command on a task
  that has entered no stage, a take-over of a finished task — and what would do nothing useful:
  Pause and Work on it yourself on a queued task, Work on it yourself on a task somebody paused, Cancel once the task
  is merged or in its retrospective.
- **A queued task** has no phase strip yet, so its *Now* line says what it waits for — *Queued ·
  Now: Waiting for a place · 2nd in queue · 5 of 5 places taken* — and a neutral note under the
  header says it in full: which limits are full, how many of the tasks holding them wait for a
  person, what frees a place, and where this ticket stands — *AUT-6861 is next in the queue and
  starts then.* only when the next such change starts it, *AUT-6862 is 2nd in the queue: 1 ticket is
  ahead of it.* further back. The tasks holding the places are listed as links, those waiting for a
  person first (ten, then *and N more*). **Change the limit** opens *Settings → Rules & limits*, and is
  shown only to whoever may change the project's settings (an administrator). When the limit in force
  is the **organisation's** maximum, raising the project's would change nothing, so the note says
  *Your organisation allows at most N …* instead and offers an organisation administrator **Change
  the organisation's limit** (the organisation's *Policies*); anyone else reads that an organisation
  administrator can raise it. Deciding a stopped task moves it on; its place frees when it finishes
  or is cancelled. A place that frees — a task finishing, stopping for a person, being paused, or a
  limit raised on either settings screen — starts the next queued task at once.
- **The needs-you box**, under the header, appears only when something waits on a person: each open
  question with its answer box, each pending approval with *Approve* and *Reject…* (see *Deciding an
  approval* below), an escalation
  with the word its stage was closed with (*"Needs you: the gate could not decide in its allotted
  checks."*) and *Return to stage…*, *Rework…* and *Retry stage…*, a budget pause with whose cap is
  spent and where it is raised, and an epic's proposed breakdown
  while a maintainer has something left to decide on it. An escalation leads with **why it
  stopped** and the next step; the sentence listing every way out comes last, beside its buttons.
- **A task a person paused** says so in the same place, as information: who paused it and when —
  or that their *Cancel run* did — the reason they gave, if any, and **Resume** for whoever may.
- **A command the task's state refuses names the ticket**: *AUT-6639 is paused, so it cannot be
  retried — resume it first.*
- **Four tabs**: *Overview* (the flow — the graph, or its list: the stage timeline — the running
  stage, Ask the task and feedback), *Artifacts* (the documents, by type and version), *Runs* (every run, with its status —
  and why one ended, *Failed · Lost its worker*, *Failed · Did not start*, *Stopped: the run did not report its cost* — model, cost and duration) and *Activity* (who did what, in words — *Paused the task by Pat* — with the person's name, and the recorded parameters behind *Details*). The tab is in the address (`?tab=runs`),
  so a link opens the same tab; a link to an artifact opens the Artifacts tab on it.
- **On the right, Checks** — the merge box (below) — then the cost against the task's cap.

**The Flow, at the top of the Overview**, is the task's own pipeline as a graph, the way it was frozen
when the task started. Each card says where the task is: *Done* with how long the stage took and what
its run cost, *Sent back*, *Failed*, *Skipped*, *Upcoming*, *Disabled* — and on the current stage
what the agent is doing, *Working* with *Now: Reading files*, *Needs you* when a question or approval
is waiting, *Stuck* when it has been silent too long — with the model, and *2nd attempt* when the
stage is running again. The connector into the stage that is running moves; a curve below the row
counts how often a loop has been spent (*Review rounds: 1 of 3 used*) — shown once the loop has been used,
or while you point at the curve or focus a card it touches. The graph opens on the current stage
and its neighbours; **Fit all** shows the whole pipeline. Click a card to watch that stage's
run: a **Live activity** list (the time, a dot, what the agent did — one row per tool call or burst
of thinking or writing) beside a **Log** that follows the end of the run until you scroll up (*Follow
the end* resumes), both updating as the agent works. It is watch-only and says where the agent runs
(the platform's server or a named worker); *Open run* goes to the run page, where you can message or
stop it, and *Open artifact* opens what the stage wrote on this page. A stage no agent runs (a gate,
Ready to merge) shows its configuration instead. **Full screen** works as on the Pipeline tab
(section 8). **List** — and a screen too narrow for the graph — shows the **stage timeline** in the
graph's place, so the pipeline is drawn once, never as a graph with a second drawing under it.

**The stage timeline lists the newest stage first**; a stage's name opens the same panel a card of
the graph does, and each entry opens the run of that stage
attempt: *Open the run* (*Open the run (live)* while it is running) goes to its transcript, and when
the attempt ran more than once — a retry of the same attempt, say — to the latest run. *Why the run
did not start* goes to the run page of a run that never reached its agent, which says why instead of
showing an empty transcript. A stage that runs no agent — a gate such as the CI or rebase gate, or a
plan approval — or one whose agent has not started yet says *No run for this stage* and links
nothing.

**While an agent is working on a stage**, a panel on the Overview says so: a pulsing
dot, the stage and the role, how long the run has been going, and the **latest progress line** the
agent reported — *"slice 2 of 4 pushed; next the endpoint"* — with its percentage when it gave one
and how long ago it said it. The line updates live as the agent reports, and *Watch the run* opens
the run's transcript. The agent writes the line, so it is shown as text, never as markup; an agent
reports at most one line every 30 seconds. *No progress reported yet* means the agent has not called
the tool, not that it is idle — the run page's transcript is the full record.

Below that line, the panel shows **the run's transcript as it happens** — the same entries as the
run page, arriving live — bounded to the newest 30 blocks, with *Open the full run* for the whole session, its search and the
**Message the agent** box.

Every artifact on the **Artifacts** tab **opens**: choosing one on the left shows the document the
stage produced, on this page, as text — its prose, with the raw JSON behind *Raw JSON* (open when the
document has no prose of its own). It is model output, so it is rendered the way everything else untrusted is — as
characters, never as markup and never as a link. The line above it says how many credentials the
platform replaced in it before storing it (*2 secrets hidden*). An artifact produced **before** the upgrade that
introduced that redaction is not shown at all: nothing redacted it, artifacts are never rewritten,
and the platform will not publish a document it cannot vouch for — it says so by name instead.

**Download JSON**, in the `···` menu, is the task's whole record as one document — everything
this page shows, each run's record, the task's events and, for a maintainer, who did what — offered to
a member or above. A viewer is not offered it; the export would refuse them.

**The claim and the QA stage** show under the header's meta line when there is something to show (the
project's ticket lifecycle, step 1). *ticket claimed* means the platform assigned the ticket to its
own account and the tracker confirmed it — or, for a ticket a linked member of the project holds,
that the platform took the task and left the ticket assigned to that member, or to whoever holds it
on a task somebody on the platform took (the page does not yet tell these apart); *Trial run* means a trial's task (section 8, *Trial*)
recorded what it would have assigned and assigned nothing; *claim released* means the claim was given back — on a cancel, a
rework, or a task that stopped between the assignment and its record — and the ticket is no longer
the platform's. Each says when. A task that never claimed (no lifecycle saved, or a task older than
the claim) shows nothing. **QA stage** means this task was created while the project mapped a *QA*
status, so a person tests it before Ready for merge (below).

### What you can do from here

The commands in the table below — the header's one button and the `···` menu — plus **Work on it yourself**,
**Give it back to the agent** and **ask the task** (below); a run's own commands — re-run, cancel and message — are on the run screen (section 5).
**The page offers only what your role may do**: the *Who* column is checked by the server for each
of you, so a member sees no *Cancel task…*, *Return to stage…* or *Rework…*, and where an approval
waits the needs-you box says *A maintainer decides this* instead of offering Approve and Reject; a
viewer is offered no *Pause* or *Resume* either. **Reject** asks first, saying what rejecting does,
with an optional reason recorded with the decision.

**Deciding an approval.** An approval shows what it approves, why it was asked, and how to stop being
asked — so you never approve blind:

- **The plan itself, open**: its approach, its size, the files it changes and its risks, then **Read
  the whole plan** (open as well) with the alternatives, data and API changes, the test plan and the
  rest. It is *the* plan the approval was asked about — its version and stage attempt are named — not
  whatever plan is newest. A budget approval shows the estimate and the threshold it crossed.
- **Why you are asked**: every reason the platform recorded — the project's first tasks get extra
  checks (*This project's first 5 tasks get extra checks, and 2 of them are done*), the plan touches a
  sensitive area (named), its size reached the threshold, **How much agents do alone** or a stage
  override asks for every plan, or the estimate is above the budget threshold.
- **How to stop being asked**, under each reason, with a link to the setting that retires it: **How
  much agents do alone** or the size threshold (*Settings → Rules & limits*), a stage override
  (*Repository configuration*), the sensitive-area rule (keeping it is recommended), or the extra
  checks, which end by themselves after their tasks are done or when a maintainer ends them. The platform names the lever;
  it never pulls it. Approvals are meant to become rarer as trust grows.
- **What happens next**: *Approve* — Implementation starts on this plan; *Reject* — the plan goes back
  to Architecture with your reason (a budget's reject stops the task for a person).

*Approve* approves exactly the plan on screen. An approval asked before approvals recorded their plan
says *not recorded*, and — like one whose plan has since been replaced by a newer one — it can only
be rejected, which asks for a fresh plan. Slack follows the same rule: its approval message shows the
plan and the reasons, and its *Approve* approves only the plan that message showed (below).
Each is an operation the task aggregate either performs or **refuses by name** — a refusal comes back as an
error naming the transition, not as a silent no-op — and each accepted one leaves a row in the audit.

| Command | Who | What it does |
|---|---|---|
| **Pause** | member | stops the task from entering another stage. It asks for an optional reason, which the task page shows while it is paused. Not offered on a task that was **merged**, and refused for one (*task_merged*): there is nothing left to stop, and from a pause it could not reach its retrospective |
| **Resume** | member | lets it continue. A task paused while it waited for its merge goes back to waiting for it — if its branch still has the commit the platform's gates judged, through the rebase gate, which checks it against the target branch as it is now (a default branch that moved during the pause is not re-checked while the task is paused) and warns about another task touching the same files, spending no iteration limit (WP-105); if somebody pushed while it was paused, it goes back through the CI gate first (WP-79). It reads *paused* for the moment the platform takes to check; merging the merge request on the git provider while it is paused ends the pause, and the retrospective runs as for any merge — and so does merging it while the task is paused at **QA**, on a project that has that stage (a pause at an earlier stage is escalated to a human instead). Resuming a task paused at QA takes it back to QA, not to Ready |
| **Cancel** | maintainer | ends the task; it enters no further stage |
| **Retry stage** | member | runs the current stage again, optionally with a reason — its stage list starts on the current stage. Costs a run. If the stage's run is still going, it is stopped first and the new attempt starts once it has ended; the screen says which attempt was queued and whether a run was stopped |
| **Return to stage** | maintainer | sends the task back to an earlier stage it has already run; a reason is required, and that stage is given it. Uses one of the rounds that stage may send the task back for. Works on a task in **Needs you** too — the way to send an escalated task to the stage that should run again. When the task stopped at a **gate** that recorded a failure — the CI gate after its fix loop ran out — the form shows a box, ticked, *Attach the check's last failure* with its length in characters: the stage is then given the failing jobs' log excerpts as well as your reason, as two separate blocks, so you need not paste the logs. Untick it to send your reason alone. A task that was **merged** cannot be sent back to a stage before the merge |
| **Rework** | maintainer | restarts the work with new instructions, which are required. The task moves to a **new branch** (`agentic/<ticket>-r2`, then a higher number on each later rework — the numbers can skip, because a plain return counts too) and the merge request you rejected is **closed** on the git provider with a comment naming the new branch; a new merge request is opened from the new branch when the work gets there again. Like **Return to stage**, it works on a task in **Needs you**, offers the same *Attach the check's last failure* box, and refuses a merged task |
| **Answer a question** | member | answers a question the agent asked; the task continues |
| **Decide an approval** | maintainer | approves or rejects a plan (and, where configured, a budget) |
| **Feedback** | member | **Good** / **Bad** (a toggle: press it again to clear it) plus text, on the task |

A task that escalates **after its merge** — its retrospective failed, say — finishes rather than
going back to work: **Resume** runs the retrospective (a task stopped at the merge gate itself
resumes into the retrospective, the move the gate would have made) and the task reaches done;
**Retry stage** does the same when it stopped at the retrospective or the librarian, and is refused
at the merge gate, because retrying that gate would record the merge again. Returning, reworking or handing it back to any stage before the merge is refused by name
(*task_merged*), because its branch is already in the default branch. **Pause** and **Work on it yourself** are
refused the same way (WP-165), and the task page offers neither (WP-194): there is nothing to stop
or hand over, and from a pause the task could not reach its retrospective. Cancelling a run on such a task — a question you asked it, say —
stops the run and leaves the task waiting for a person, where **Resume** still finishes it.

The stage list offered by *retry*, *return to stage* and *rework* comes from the task's **own**
history rather than from the pipeline template, for the same reason as the board's columns; a task
that has entered no stage yet is offered none of the three rather than a control that can only fail.
The three dialogs share the stage you picked, and an untick of *Attach the check's last failure*
holds for that escalation until the gate escalates again. Each dialog's submit button stays disabled
until the command's own required fields are filled, so you do not send a request the server will
reject; it closes when the command was accepted, and a refusal is shown inside it.

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
check waits and the task page says what it waits for, from the first check: *"CI is waiting for
someone to start the manual job codeception in GitLab. Start it there and the task
continues."*, with the job linked, a note that links the readiness panel's CI-rules warning (which
names the rule it understood), and *Start the job in GitLab* as the page's one button.
**A manual job nobody started is not a check** (BD-024's 2026-11-07 amendment). When every job
that ran is green and only manual jobs are left, CI passes and the task's CI check says *CI passed —
the manual job sentry-release-commit was not run*, with the job linked. That holds unless one of the
manual jobs — a manual trigger for another pipeline included — is a **test job** — one in stage `test`, or any job when the pipeline has no `test`
stage, or a job with no stage at all: a test is never skipped. The check also waits when a job is
queued behind the held one (a build step your tests need, say), when no job has run yet, and when a
job that is not allowed to fail failed — which fails the check, as a red pipeline does. To set your
own rule, use `pipeline.ci.required_manual_jobs`: `[]` requires no manual job (a held test job then
passes too), `all` waits for every one, as before this rule, and a list of job names waits for
exactly those — a named job that ran and failed fails the check, so does one the pipeline's rules
skipped, and a name the pipeline does not contain is not waited for. The project's settings may say
any of these. `.agentic/config.yml` may only require more: its `all` applies, its list is added to
the settings' list, and its `[]` never applies (the agent whose change the check judges can edit
that file); the effective configuration lists what it did not apply, with the reason. A merge request's head held only at a job the rule
does not wait for keeps one pipeline: the platform asks GitLab for a fresh merge-request pipeline
only when the rule would wait on a manual job. At **Ready for merge**, a task whose pipeline GitLab
still shows as blocked says so — on the task page and in the ticket's workpad: *"GitLab shows
pipeline n, the latest for this commit, as blocked at the manual job sentry-release-commit. If this
project requires pipelines to succeed, GitLab won't merge it until sentry-release-commit has run:
start it on GitLab."* The platform never says the merge request can be merged. The waiting
described next applies to a required job. A held job is
*Needs you* at once: on the task page, on the board — its card says *CI held · start the job* and
sits under *Needs you* — and as a row of the Inbox and of Home's *Needs you* (*CI waits for someone
to start the manual job …*), which opens the task. A paused task shows no CI wait: the check stops while it is paused. While the pipeline is simply running, the page
says *"CI is running (pipeline n, 12 min so far; the task gives up after 60)"* and asks nothing. If
the wait runs out, the page says *"CI did not finish within 60 minutes: pipeline n was still held at
the manual job …"* — never that CI failed — and the next step, *Start the job in GitLab, then
Retry*; a Retry on a pipeline that is still held stops at once and says so rather than waiting the
hour again. A task that stopped before the platform recorded these reads shows the sentence it did
record, after *What the platform saw last:*.

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

The checks are a **merge box**, as on a pull request: one line on top — *All required checks pass*,
*2 checks need you* (a check failed, or a gate stopped for a person), or *3 required checks are not
decided yet* — or, while the task is at a stage before any check can run (Refinement,
Architecture…), *Checks start at Implementation.*, with no clock and no count — and one row per check with a status icon, its name and its value. **The line counts
checks only**: an open question or a pending approval is the needs-you box's, above, so it is not
counted as a check; while one waits, a second line says so (*Questions and approvals waiting for a
person are in the box above*), and their rows read *1 · see above*. Point at (or tab to)
a name for its definition; open a row for the sentence its value rests on — which attempt of a gate,
what the estimate was computed from, which base the coverage was measured against, which packages and
licences, which reviewers and why. A check that has not been made, or whose record cannot say what it
found (*not reached*, *not recorded*, *unavailable*), is never counted as a pass. Under the box,
**Cost so far** is drawn against the task's cap, beside the estimate's accuracy and **People's
time** (*$1.20 · 2 h of people's time* — the agents' cost and the minutes people spent, side by side
and never added).

The product defines eleven merge-readiness checks, and the box shows **all eleven**:

- **Acceptance criteria** and **Business verdict** — read from the latest Acceptance Verdict the
  business review wrote: how many criteria were met, not met or untestable (each with the
  reviewer's evidence), and whether it approved or asked for changes. No verdict yet says
  *no verdict*; a verdict the server refuses to serve says *unavailable* and why.
- **CI status** and **Up to date** (with the default branch) — the latest attempt of each automatic
  check: green or red, yes or conflicts, *checking* while it decides, *not reached* before the task gets there, and
  and why the gate stopped for a person when it did.
- **Review threads** — open and resolved human threads on the merge request, as the platform last
  counted them. It counts when somebody comments while the task waits at QA or Ready for merge, and again when the
  merge request reports every thread resolved — which GitLab sends only for a project that requires
  resolved threads before merging. A thread resolved without a comment while others stay open is
  not counted until one of those happens; until the first count it says *not read*, never zero.
- **Test coverage** (the change against the default branch, in points), **Dependencies**,
  **Sensitive areas** (the project's risk classes the change touches), **Required reviewers**, the **Estimate**
  against what the task has spent, and **Questions pending** — and beside it, a twelfth row the
  product's list does not have, **Approvals pending**.

- **Protected files** — BD-024's check (the platform calls it the *tamper check*), made with the CI
  check: the existing files the change modifies,
  deletes or renames away, against the project's protected paths (tests and CI/lint configuration
  by default), minus the changes the plan declared and the code review confirmed. Adding a new test
  is never flagged. *changed, sent back* when anything
  is left (the developer is told which paths, and CI status then says *sent back: protected files
  changed* rather than red); *declared changes await the code review* when the plan declared them and
  the review has not judged the change yet — the up-to-date check, just before Ready, reads the code
  review's confirmation, so neither review runs twice; then *declared changes confirmed by the code
  review*, or *declared changes not confirmed, sent back* (the developer is told which paths, as
  for an undeclared change); *no unapproved changes* when the check ran and found no protected file changed, or found only changes the plan declared and the code review confirmed; *checking*; or *not
  reached*. When the CI check stopped without a verdict the protected-files check was not made: it
  reads *not checked: CI didn't finish* when the pipeline is known to be unfinished (CI timed out, or
  a Retry found the same held pipeline) and *not checked yet* otherwise, muted either way and not
  counted among the checks that need you — the CI status beside it is the one that does.
  A CI gate whose row carries no record of the check reads *not recorded*: one that
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

- **Work on it yourself…** (the `···` menu; the platform calls this a *take-over*) and **Give it
  back to the agent…** (the header's button while you hold the task, a *hand-back*) are on this
  screen, each in a dialog (and on the run screen, for the run's task). The task page then reads *A
  person is working on it*. **Work on it yourself** pauses the pipeline, interrupts the running agent, commits and
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
  — and **Give it back to the agent**, whose stage list is the stages of the task's own pipeline that a hand-back
  would accept, so it offers nothing the platform would refuse: never the merge gate, the
  retrospective, the librarian or done, and **Ready for merge** only when you took the task over at
  Ready (WP-165). A task that was **merged** cannot be taken over at all, and the panel says so instead of offering it; one taken over before that
  rule existed is offered no stage, and the panel says it was merged — cancel it, or resume it into
  its retrospective once it is waiting for a person. Handing back to **Ready for merge** does not skip the checks: when the branch is not
  the commit the platform's gates judged — you pushed, or the platform cannot read it — the task
  re-enters the CI check and walks through review and the up-to-date check to Ready again, spending none of
  its iteration limits; an unchanged branch goes back through the up-to-date check alone — one
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
- An **epic split** task carries a **Proposed breakdown** panel — in the needs-you box while a
  maintainer has children left to decide, on the Overview otherwise: one row per child ticket the agent
  proposed, with its acceptance criteria, a checkbox per child and two buttons, **Accept N** and
  **Reject N…**. Accepting **creates those tickets in your tracker** — one per accepted child, never
  twice — and rejecting asks first (no ticket is filed for a rejected child, and it cannot be
  accepted later), then keeps the row with your reason. Only a maintainer sees the checkboxes; everybody who can read the task can read
  the queue. The feature is off until a project turns on **Epic split** in its operating-mode
  features.
- **Ask the task** (member) is a thread on the Overview, under the Flow: ask *"why did you choose X?"* and
  the answer is written from the task's audit trail and artifacts, citing the exact run, artifact or
  action it rests on — each citation is a link into this application, never a link the model wrote.
  An ask starts a run and spends the project's money, which is why it needs a member rather than a
  viewer; reading the thread needs only a viewer. It is a project feature (**Ask the task** among the operating-mode features), on by default.
  Like any run it needs an instance whose runner is configured (section 13).
  Ask *why did it stop?* or *what am I supposed to decide?* and the answer starts from where the task
  is now — its stop, the escalation's reason and brief, the CI wait it is on or that ran out — in
  plain sentences that name a run by its stage and attempt. The page shows the answer exactly as
  written, so it never renders Markdown. A question that got no answer says why in words (*The
  answer didn't come back in the expected shape*, *The run was cancelled before it answered*, …),
  links the run that tried, and offers **Ask again** with your question filled in; the platform
  never shows a half-shaped answer it could not check.

## 5. Run detail and the transcript

Click a run — in the task's run list, under *Running now* on Home, or on the Agents screen. The page
sits inside its project, under the project's header and tab row (its address stays `/runs/<id>`), and is
laid out like a GitHub Actions job:

- **The header** leads back to the task in its project, by its ticket key and title, and names the
  run: its status icon, the stage, the role and the attempt (*Implementation · Developer · attempt
  3*). The actions are on the right. **Cancel run** is there while the run is live — a red-outlined
  button, never the amber one: while a run is live, watching is the job, so the page has no primary
  button at all (the message box's *Send* and the transcript's *Following* toggle are plain), and it
  asks before it cancels. **Re-run ▾** is offered once the run has ended — the server refuses a re-run of a live
  one — and becomes the primary button once a run has failed. The
  **···** menu holds **Work on it yourself…** (**A person is working on it: resume / give back…** while the task is taken over), which opens the
  same take-over form and hand-back the task page has, and **Download transcript**, the run's
  transcript as a JSONL file. *Re-run ▾* and *Work on it yourself…* are shown only to a reader whose
  role may use them (a member or above); a viewer sees neither, and still the download.
- **The left column** is the task's runs in stage order, each with its status icon, the one you
  are reading marked — click another to read it. Under it, **Details** opens the settings line
  (described under *Settings* below), where an unsuccessful run's unfinished work was saved, and the
  version of the role prompt the run was given.
- **The summary strip** gives the status, where it runs (*Runs on* the platform server,
  or a developer's remote worker by the name its owner gave it; *waiting to be picked up* while
  nobody has taken the run yet, and *not recorded* when the platform no longer holds who ran it),
  once the run has ended **Ended
  because** (*Succeeded*, *Ran out of turns*, *Hit its budget*, *Lost its worker*, …), the model, the
  effort, the cost (marked *est.* when the
  platform estimated it), the elapsed time, the turns and the tokens (in, out, and read from the prompt cache). Hover or focus a label for
  what its number means. The transcript's last row, *The run ended*, gives the same reason in the
  same words.
- **Once a run that started has ended without succeeding**, a box under the summary strip, *This run
  ended: …*, says what that ending means in one sentence (*Lost its worker*: the machine running it
  stopped checking in, so the platform ended the run — which says nothing about whether the agent
  itself failed), what the platform did next — *The stage was run again: attempt 2* with a link to
  that run, *The task stopped for a person*, or *Nothing else has happened since* — and what you can
  do: **Re-run as configured** and **Work on it yourself…** (a member; neither is offered to a
  viewer, and *Work on it yourself…* not on a finished task), **Open the task**, and **Jump to the
  last lines**, which opens the transcript at its end with the search cleared. A run ended by a
  refused permission names the tool it was refused when the transcript recorded it, and **See the
  run’s settings** opens the Settings tab. A run you cancelled, one handed back at a shutdown and one
  that hit a usage limit get a plain box rather than a red one: nothing went wrong in them. A run
  whose workspace never started keeps its own box, *This run did not start*, in the transcript's
  place.
- **While the run is live**, a *Now:* line says what the agent is doing, in the words the board and
  the Agents screen use (*Reading files*, *Running a command*, *No activity for 6 min*), with its
  last few steps listed under it (a list a screen reader names *Live activity*). When it says *Now:
  Needs you*, it links to what the task waits for — *Answer the question →* onto the answer box,
  *Review plan →* onto the approval, or *See what it needs →* — on the task's page.

Then four tabs:

- **Transcript** — the agent's session as a log, live. Each tool call is one **step**: a status
  icon, the tool, what it was called with and how long it took, collapsed until you open it.
  Opening it shows the call itself — the change as removed and added text, the command and its
  output, the file it read, or a sub-agent's own transcript nested inside. The step the agent is on
  and any step that failed are open already. A call the run never answered — its last, when it crashed or lost its
  worker — reads **no result** once the run has ended, never *running*. The model's words are prose between the steps, and its
  thinking stays folded under *Thinking*. The log scrolls in a pane of its own, sized to the window:
  at the bottom it follows the end; scroll up and it stays where you are, with **Paused updates, N
  behind**, until you press **Follow tail**. Everything in it is rendered as **text**; the
  application has no markdown-to-HTML step anywhere, on purpose, because all of it — model output,
  tool results, file contents — is untrusted
  ([BD-022](decisions/business/BD-022-external-text-is-untrusted.md)). The platform's and the CLI's
  own rows say what happened on the row — *The platform stopped the run · it stopped producing
  anything for too long*, *The model API failed; retrying · attempt 2 of 10 · rate limited*, *The CLI
  wrote to its error output · …* — and fold open onto the record as it was written. The first row, **The
  session started**, folded like a step, is the Claude Code CLI's own start-up message, shown as the
  CLI sent it. Its `skills` list is everything the CLI found, including its own bundled skills
  (`deep-research`, `update-config` and others), and it is **not** what this run could use: the run
  was handed only its role's platform skills (`agentic:kb` and the like) — the only skills written
  into its workspace — and the CLI refuses any other.
- **Prompt** — the exact system and user prompt that produced this run, each under its own heading
  (*System prompt*, *User prompt*).
- **Knowledge given** — what the agent was given: the knowledge pages retrieved and put in front of the model.
- **Settings** — the project settings this run was planned with, frozen when the run was created
  and redacted then. The settings line under **Details** says whether they were the same as the
  task's previous run's.

A run reads **starting** from the moment the platform's runner takes it until it asks for the
agent's CLI — while its workspace is prepared — and **running** from then on; a starting run shows
no elapsed time yet and can be cancelled, and a message sent to it is recorded and reaches the agent
as soon as it starts. A run that ends while still starting never ran an agent and cost nothing.

You can **cancel** the run (member), **re-run** it (member — this creates a *new* run rather than
changing this one), and leave **feedback** scoped to the stage at the foot of the page. **Re-run ▾**
offers *Re-run as configured*, a new run on the stage's configured model and effort, and *Re-run
with another model or effort…*, a dialog with two lists and **Re-run**. The model is a list, not
a box to type into: it offers the models the platform has a price for (the
operator's `price_list`), and it starts on **Configured (…)**, which names the model the project's
configuration gives this stage. Leaving it there re-plans the new run from the configuration, so
that is the model it runs (if somebody changes the configuration before you press the button, the
new value wins). This run's own model is an ordinary entry: choose it to run the same model again —
which matters when this run was itself a retry on another model. A model the list does not carry —
say one your project pins — is shown as its own entry marked *not priced*. The effort list works the
same way: **Configured (…)** names the stage's configured effort, and this run's effort is one of
the choices. *Other…* lets you type any
id, and the platform runs it because you chose it there; an unlisted id sent without that choice is
refused (`model_not_listed`), so a typo never reaches a run.

**A Developer run that stops without finishing keeps its work.** When it runs out of turns, out of
budget, out of time, stalls or crashes, the platform commits what it had changed as one
`wip: unfinished attempt <n> of implementation (<reason>)` commit and pushes it to the task's
`agentic/<ticket>` branch, with the run's own credential — the same export a take-over makes. The run
page says so under **Details** (*Unfinished work saved: pushed to … at …*), the task's run list marks
the run *work saved to branch*, and the escalation's brief tells you a retry continues from that
branch. **Retry the stage** and the new run starts on that branch and is told to read the previous
attempt's work and carry on rather than start over; the `wip:` commit stays in the branch's history.
A run that changed nothing pushes nothing. If the push fails the run page says so, and the work is
only in the run's workspace volume, which is kept for three days. A run you **cancel** is not saved —
choose **Work on it yourself** instead if you want its work.

**A message to a live run is accepted, then applied or refused** (WP-85). The **Message the agent**
box (its button is **Send**) sits under the log and stays at the bottom of the window while the run
is live — from the moment it is claimed (*starting*); a run still waiting for a seat, or one that has
ended, has none. A message pushes a turn into a
session that is already running, which only the process running that session can do — on a stock
instance the `runner` container, never the process serving this application. So the message is
recorded and handed to the runner through the database: the screen says *Accepted* at once, and
**Commands sent to this run**, under the message box, then shows whether it was *applied* (it appears
in the transcript as a turn attributed to you) or *refused* — *the run ended before it could be
applied* (it is never applied late), *the live session did not take it* (it was closing; not
retried) or *no live session was found*. A message usually applies within
a second; one that stays *pending* for a couple of minutes means the runner's database connection is
struggling. You can send one message every five seconds; the limit is yours across the whole
installation, however many processes serve this application (WP-101).

**Cancel stops the session** (WP-101). **Cancel run** first asks you to confirm, saying what it
does; **Keep it running** sends nothing. When the runner is holding the run — the usual case — the
task is paused at once, the cancel is handed to the runner the same way a message is, and **Commands
sent to this run** shows it as *Cancel*: *pending* until the runner interrupts the session, then
*applied*. The run then ends *cancelled* with what the session had cost up to that moment, charged
once like any other run. A message you sent that was still waiting is not delivered — the run
ends before it, and it reads *the run ended before it could be applied*. If no process is holding the
run (the runner is down, or its lease lapsed), there is nothing to interrupt: the run is ended here
and reads *cancelled* straight away. If the runner dies after you cancel and before it stops the
session, the platform ends the run itself a few minutes later and it reads *Ended because: Lost its
worker* rather than *Cancelled*, because nothing confirmed the stop.

Three tabs can refuse to show you a document, and that is deliberate: each is the record of what
this run was given, and none is re-derived after the fact. A run started by this build shows all
three. A run started before the platform recorded one does not, and never will — **Prompt** and
**Knowledge given** say the document *could not be loaded* and why, with the server's own message under
*Technical details*, **Settings**
says the run predates the record:

- **Prompt** — recorded since migration 0038, redacted at the write, because a prompt carries the
  credentials the run was handed. An older prompt is not re-derivable: its delimiter is a fresh
  random value per prompt and its knowledge excerpts are a point-in-time read, so re-assembling one
  would show you a document that run never saw.
- **Knowledge given** — recorded with the run since migration 0041, budget included. For an older run
  only the retrieved rows exist, and summing them would publish "budget equals total" as a fact. A
  pack with nothing in it is not refused: it says *No knowledge pages were put in front of the
  model*, beside its token budget.
- **Settings** — recorded since WP-91. Today's project settings are not shown in an older run's
  place, because they are not the ones it was planned with.

This is the product's rule about numbers: every one shown has a definition, and one that has none is
absent rather than invented. It is why the **Agents** screen shows no "tokens per minute" — a rate
computed from whatever two samples the browser happened to see is a number with no definition.

## 6. Inbox — questions and approvals

**Inbox** in the top navigation: everything pending for you, across every project, answerable in
place — laid out like GitHub's notifications. The left column filters the list: **All**,
**Questions**, **Approvals**, **Stopped**, or one project, each with its count. Each row starts with the
*needs you* bell, then the question's first line (or what the approval is about — *Plan v2 · size L ·
6 files*), and under it
where it is — project · ticket · stage — how long ago it was asked and, for a question, when it is due. Click a
question's line and the row opens in place: the whole question, a **Your answer** box and **Answer**.
An approval's row links to the task, where it is decided with the plan on screen (**Review plan**);
no row approves in one click. A task whose CI check waits on a manual job somebody must start is a
row too (*CI waits for someone to start the manual job deploy*), under **All** and its project, and
**Open** takes you to the task, where *Start the job in GitLab* is the button. With nothing
pending the page says *Nothing needs you*.

**A task stopped for a person** is a row of its own section, **Stopped, waiting for a person**, below
the rest: why it waits — *Waiting for: Vojtěch Kaizr's Jira ticket* for a ticket someone else holds,
*The same failure repeated* and the like for the other stops the platform words, or *Needs a person*
— where it is and when it stopped. The whole row opens the task, where it is decided; nothing is done
from the list. A stopped task that also has a question or an approval is listed once, as that row,
and the Inbox count in the top navigation counts it once. The board card and Home's *Needs you* say
the same short form (S-25.15).

A question the agent asks may also arrive in Slack, and all channels are equivalent — **the first
answer wins**. An approval arrives in Slack with what it is about: for a plan, its version, size,
the files it changes (the first few), its risks and a line of its approach; every reason it was asked,
in words; and a **Review plan** link to the task page. It has **Approve / Request changes** buttons,
and *Approve* approves exactly the plan in that message — pressed after the plan was replaced, or on
a message older than the plan, it approves nothing and the bot answers in the thread with the reason
and the task page link. A plan approval whose plan was not recorded (or has been replaced) is posted
with **Review plan** and **Request changes** only, never *Approve*. A click
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
inbox**, because it can no longer be answered — the line under the inbox's title says what the list is
(*Questions and approvals waiting for a person, across all projects.*), and **Learn more** beside it says
what an expired item does — and the task page
is where it is retried or cancelled. **Before that, one
reminder**: halfway through the working time to the deadline, the project's chat channel gets a
message saying the question is still unanswered, which names the task page (it has no buttons). A
question answered before then is not reminded about.

Approvals are different: **an approval never expires** (BD-006's 2026-11-07 amendment). The plan-approval gate is what
the **Supervised** autonomy level turns on above a certain task size, and any maintainer can decide
it. A plan or budget approval waits until somebody approves or rejects it. Meanwhile the task reads
*Waiting for approval*, is in *Needs you* and the inbox (*requested 3 h ago · waits for a
maintainer*, with no due time), and the project's chat channel gets at most **five reminders**: the
first halfway through the question timeout, then one per question timeout (half a working day after
the request, then once a working day, by default). After that the chat goes quiet, but the item stays
in *Needs you*. Resuming or retrying the task does not get round a pending approval — whoever asks,
the platform refuses it and names the approval, because only its decision moves the task. Pausing does
not either: a paused task gets no reminders, and resuming it puts it back to *Waiting for approval*
(or, if the approval was decided while it was paused, carries on from that decision), with the
reminders picking up where they left off. Taking the task over and handing it back, or sending it back to an
earlier stage, is refused the same way while the approval is pending — a maintainer decides the
approval instead, and rejecting it sends the task back — and cancelling the task withdraws the approval, so it leaves the
inbox. An approval
that expired before the change stays expired, and its task is retried or handed back from the task page
as before.

Once an approval is decided — here, on the task page, or with a button — its Slack
message is **edited**: the buttons are removed and the message says how it was settled (approved,
changes requested, or, for one that expired before approvals stopped expiring, expired), naming the decider by role; the task page names the person. A chat
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

**A project → Knowledge.** On the left, the knowledge base's **files** as they exist in the project's
repository, grouped by folder. The page reads in the order you need it:

- first the **Suggested edits** (the platform's knowledge *proposals*) — the ones waiting for your
  decision at the top, the decided ones below them — one row each: the page it would change, its
  type and kind, and where it came from (*mined from merged history*, *drafted at project setup*,
  *from a task* …); **The change and its evidence** under a row holds the change itself and what it
  cites, and it is **open** on every row still waiting for a decision, so *Approve* is never pressed
  with the change collapsed;
- then the file you clicked on the left, if any;
- then the **Health** report, as a notice: what the nightly hygiene pass last found — a page the
  parser refused (and which is therefore in no agent's context), links that point nowhere, expired
  pages, duplicates — or that it found nothing wrong, or *No health report yet* before the first pass
  has run. A finding is an observation; nothing rewrites a page because one names it.
**Approve** is on the row and **Reject** is in its `···` menu; a decision the server refuses says so
under the list.

- What an approval does: a commit on an `agentic/knowledge/*` branch and a merge request. Never the
  default branch, and never without a maintainer's decision;
- **apply failed**: an approved proposal the platform could not commit — its apply failed or never
  ran, the recovery pass asked for one more apply, and an hour later it was still not committed (the
  project may have no git binding, or the provider refused the commit). The row says so, with the
  reason, and offers **Approve again**, which asks for another apply; **Reject** ends it. Until then
  nothing retries it on its own;
- **waits for a merge**: an approved proposal for a page that an earlier knowledge merge request
  already creates and nobody has merged yet. It is not stacked onto that merge request's branch (you
  may be reviewing it) and does not open a second one that would conflict with it: it stays
  approved, the row names the merge request it waits for, and once that one merges the change is
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
needs an editor the application does not yet include, so the panel is read-only: a proposal is
approved or rejected — a reject asks first, and its reason is what the Librarian learns from — never
edited here.

## 8. Pipeline and budgets

**A project → Pipeline** draws each template the project has enabled as a graph: pick one under
**Template**. Each stage is a card — its name, the agent's role, the model and effort it runs with —
connected in the order a task goes when everything passes; a stage that only a failure enters (the
conflict resolution behind the rebase check) or that the pipeline skips (marked *Disabled*) sits above
the row, and every way a stage can send the task back is a dashed curve below it with its limit
(*Review rounds: up to 3*: the review may send the work back at most three times; the stage's dialog says what a round is).
A gate's card reads *Automatic check* and a stage the platform completes itself *Automatic step*; an advisory stage says
*for information only: it never sends the task back*. Click a card for the stage's
configuration: its role, model, what it writes, its loops and where each of its outcomes goes. A gate's card says what it waits for (*Waits for the CI pipeline*). Drag
to pan; it opens on the first stages at a size you can read, the **+**, **−** and **Fit all** buttons zoom (Fit all shows the whole pipeline); **Full
screen** gives the graph the window, Escape gives it back. On a narrow screen, or with **List**, the
same stages are an ordered list.

**Effective configuration**, folded below the graph, shows the configuration with the source of every
key (a default, the organisation, the project, or the repository's `.agentic/config.yml`) and when the
repository's file was last read. Read-only here: the settings are edited on the project's settings
page, which also proposes them to the repository (section 1, step 6); a YAML editor in the browser is
not built.

**A project → Budgets** is where a project's cap is both read and set. It shows each budget as a
meter: its window (*Per month*), what has been spent of its limit (*$3.25 of $40.00*), and the share
at which you are notified. Below that, **where the money went**: pick a window (*Per day*, *Per
week*, *Per month* — the default — or *In total*) and the page lists what the cost ledger booked in
it **by stage**, most first (a question asked of a task, which runs outside the pipeline, is the line *Questions to an agent*), and the **top tasks**, each linking to its task (a trial's task says
*Trial run*). Where part of a figure is the platform's own price for a run whose provider reported
no cost, it says so (*$2.50 ($0.25 estimated)*); a run nothing could price is in no figure. Last on
the page is the editor, **Project budgets**: a field per window, an empty field is no cap, and
**Save budgets** writes the windows you changed. *Rules & limits* in the project's settings points
here rather than carrying a second editor; the setup wizard keeps its own, because a project being
created has no Budgets tab yet. A budget stops a *new* run from starting: the check
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
still being prepared or in the instant before the request went out — cannot have spent anything, is shown with a cost of **0**, and is never held.
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

### Trial

**A project → Trial** is a trial run on tickets you already shipped: it runs the pipeline on closed
tickets you pick and compares what it would have built with what a person merged; nothing is written
outside the platform. (It was called *Shadow*; its address is still `/projects/<key>/shadow`.) The
tab is there **before the project's first live task, and while it has a trial**; otherwise the page
is under the project's **Settings → Trial run**, which links to it. The page shows one thing at a
time: while it loads, a line saying so; if it could not be read, that error alone; if a trial may not
start, why, in a sentence (*Trial runs are off for this project …* — switch on **Trial runs** under
*Rules & limits*, with How much agents do alone at Observe); otherwise the form: enter up to 25 ticket
keys and **Start a trial run**. Each trial is a row — when it started, how many tickets, whether it
is still running, what it spent — and its name opens the trial's own page: its figures in one strip
(*Tickets*, *Refused*, *Reported*, *Compared*, *Spent*, *Budget*), the cost per ticket by size, the
similarity distribution, the launch candidates and every ticket with its similarity — or the reason
it has none. A trial's task says *Trial run* beside its ticket claim, because it assigned nothing.

## 9. Integrations

**Integrations** lists the organisation's connected systems, grouped by what each does for a project
— **Tickets**, **Code & merge requests**, **Chat**, **Errors**, **Logs** — one row each: its health
**now** as an icon and a word, its name, its provider (a small glyph for its role — a merge for a git
host, an open issue for a ticket tracker — and the provider's name; never the provider's logo),
what the health was read from and how long ago (*last call 5 m ago*, *last delivery 1 h ago*, *tested
3 h ago*), and the projects that use it, linked (*Used by Autix*; past two, *Used by Autix, Demo +2*,
the rest named when you hover the count).

The health is read from the integration's **traffic**, not only from the last test: the last call the
platform made to the provider, and the last webhook (or poll) delivery it received and verified, with
the last **Test connection** as one more fact. *Working* means something succeeded in the last
24 hours; *Some calls failing* means the newest call failed after one that worked; *Failing* means
calls failed and none worked; *Not checked recently* means nothing happened in the last 24 hours — a
test that passed a month ago does not make an integration *Working* — and an administrator gets a
**Test again** button on that row; *Never checked* means nothing has happened at all; and *Retired*.
A failed call can be one request's fault (a ticket that no longer exists), which is why one failure
after a success reads *Some calls failing* and the next successful call clears it.

Each row's **`···`** menu has **Test connection** (the answer appears under the row), **Setup guide**,
**Edit configuration**, **Replace credentials** and **Retire**. Click anywhere on a row to open the
integration's own page, with three tabs:

- **Overview** — anything wrong with it; its **health** with the facts it was read from (the last call
  and whether it succeeded, the last delivery, the last connection test), each with its age; the
  **projects** that use it, each with what for (*Autix · Tickets from AUT · Picked up with label
  agentic*); and its configuration, each setting under its name in words. **Test connection** is the
  page's button, and the `···` beside it holds the rest. Secrets are stored encrypted and never shown.
- **Setup guide** — the provider's own guide, written for the provider's screens and the same text
  the operator reads. For a provider with an inbound webhook it shows the webhook URL to paste into
  the provider, with a **Copy** button; a provider with no inbound half says it has none.
- **Rejected webhooks** — what the provider sent that the platform refused, and why (an unmapped
  chat account, a decision the clicker may not make).

GitLab, Jira, Slack, Sentry and Loki are trademarks of their respective owners; this project is not
affiliated with or endorsed by them. The screens carry the same line.

Nothing on these screens is a credential: the server strips every field a provider declares to be a
secret before publishing an integration's configuration, and publishes nothing at all for a provider
this build does not ship — because it then cannot tell configuration from credential.

**New integration** (admin) is a four-step wizard. A maintainer, who may read integrations but not
change them, is offered none of *New integration*, *Test connection*, *Edit configuration*,
*Replace credentials* or *Retire*, and the screen says administrators add and change them. **1. Choose a provider** — one card per provider,
each saying what connecting it does. **2. Configure it** — a name of your choosing and the fields that
provider requires (its URL, its organisation or channel), each labelled in words with its key in the
hint; the provider's optional settings are under **Optional settings**, each a control of its type (a
yes/no choice, a number, a comma-separated list) — leave one empty and the provider's default
applies. **3. Say where its credentials are** — for each credential, the *environment variable* the server
reads it from, which must be on the operator's allow-list (operator guide, §4); the value itself
never crosses the browser. **Create integration** sends it; the server checks the configuration
against the provider's own schema before it stores anything, so a create can be refused for a reason
outside the form, and the screen names the settings it refused (*Some settings are invalid: Base
URL.*), with the server's own message under *Technical details* (go back a step with the step list to
correct it). **4. Test the connection** — or skip it — and the wizard ends with
**Use in a new project** (the New project wizard) or **Add to an existing project…** (pick the
project, and you land on its settings' *Connections*, where you tick the integration). **A reload
does not lose your place**: before the create, what you typed is kept for this browser tab (never
the credentials' variable names, which it asks for again); after it, the address names the new
integration, so a reload lands on its test or the ending — never on a form that would create a
second one. **Test connection** shows the same answer here, on the integration's page,
on its row and in the project wizard beside the binding it is about.

An integration whose stored configuration would not load (one created before the form asked for
these fields) says so on its row, naming the settings, with an **Edit configuration** link beside it
(the same as the `···` menu's). **Edit configuration** fixes it: a dialog asks
for the required fields again, lets you change the optional ones, and removes the keys the provider
does not declare.

**Replace credentials** (admin) rotates a token: in its dialog, name the new environment variable for
each credential you are replacing, and the server seals the new value and deletes the old one.
**Retire** (admin) removes an integration you no longer use: a dialog says what it does first — its
credentials are deleted and its row stays, marked *Retired*, with no menu, because the audit still
names it. A project that binds it, or a run credential it minted that is still live, refuses the
retire, and the dialog says why.

## 10. Audit log

One row per configuration change, newest first: who made it — their initials and name, or *A removed
account* when that person's account has gone — what they changed, in words, naming the project when
it is a project's settings (*changed the settings of Payments: Autonomy level*), and when.
**Details** under a row holds the raw change and the id of what was changed; a secret in it appears
as the literal string `"changed"` — that is the server's doing, not the screen's. Two filter menus
sit in the list's header. **Project** keeps one project's settings changes: the server filters by
kind only, so it asks for project changes and keeps that project's among those **on this page** (the
page says so; **Load older entries** shows the page before it), and a change to a project's
connections or a budget, which does not name its project, is not among them. The other shows the
changes to one kind of thing (*Organisation*, *Project*, *Integration*, *Connections*, *Budget* or
*Person*) or to all of them, and **Load older entries** pages back.

Every action a person takes through the product is recorded with the acting user, the command and
its parameters — but **this screen lists only the configuration changes**; a task's own commands are
on that task's *Activity* tab, and a project's settings changes on its settings page's *Who changed
what*, both in words (*Changed how much agents do alone*) with the person's name. A *refused*
command records nothing.

## 11. Settings

**Settings** — the gear in the top bar, also in the account menu — is one page per section, picked from the list on the
left (on a phone, a one-line menu above the section that names the one you are on) — **Policies ·
Notifications · Budgets · Users · Linked accounts · Integrations · Workers · Audit log · Stuck
events · Failed background jobs · Instance · Session · Keyboard shortcuts · Your accounts** — grouped as
*Organisation*, *People*, *Admin*, *Operations* and *Personal*. **Opening Settings opens the first
section your role may change**: *Policies* for an administrator, *Budgets* for a maintainer,
*Keyboard shortcuts* for everybody else. An address that is no section (a mistyped
`/settings/your-accounts`, say) says *There's no settings page at this address.* with **Open
Settings**, rather than showing another section in its place. A section that changes something has **one Save** at its
foot: it stays disabled (*Nothing has changed.*) until you change something, and it saves only what
you changed. *Keyboard shortcuts* is the exception — it applies as you pick it, and is kept in this
browser only. *Linked accounts*, *Stuck events* and *Failed background jobs* are an administrator's
and are shown to an administrator only, *Integrations* and the *Audit log* to a maintainer or an
administrator; anybody else who opens one of their addresses lands where *Settings* does.
*Workers*, *Instance* and the *Personal* sections are everybody's.

**The Admin section is three screens with addresses of their own** — **Integrations** (section 9),
**Workers** (section 12, *Workers*) and the **Audit log** (section 10). They open at `/integrations`,
`/workers` and `/audit` as they always did, beside this list with their entry marked (the
*New integration* and *Add a worker* wizards take the whole page for their own steps);
`/settings/integrations` and the like take you there too.

- **Session** — who is signed in, and with which role.
- **Keyboard shortcuts** — **Use single-key shortcuts**, on until you turn it off: whether `g h`,
  `j`, `k`, `/`, `?` and the rest do anything (see *Search and keyboard shortcuts*,
  near the top of this guide). ⌘ K or Ctrl K opens the search either way.
- **Budgets** — the **organisation budgets**, the caps that stop a new run anywhere in the
  organisation: one field per window (*Per day*, *Per week*, *Per month*, *In total*), each with what
  has been spent of it; empty is no cap. **Save budgets** writes each changed window in turn, and a
  window the server refuses says so under its own field.
- **Users** — everybody with an account, with their role and whether they are active.
- **Linked accounts** (*Provider identities* before) — which Slack, Jira or GitLab account is which
  person, without which a decision made in those tools is refused as unmapped. Each account has
  **Unlink**, which asks first and names the account and the person (or says it is a machine) — it
  unlinks the account whoever linked it, this form or the person's own code. Below the list,
  *Accounts nobody has linked* shows the accounts the platform refused a decision from and the
  tracker assignees of tasks in progress that no person here holds (*assigned to 3 tasks*); *Use
  this account* fills the form and links nothing until you say who it is.
- **Your accounts** — your own Jira and GitLab accounts: the ones linked to you, each with
  **Unlink** (it asks first; answers and approvals from that account stop counting as yours, and a
  task you already own stays yours until the ticket's assignee changes), and **Link an account**,
  below.

**Linking your own Jira or GitLab account** (*Settings → Your accounts*, every signed-in person). A
linked account can answer questions and approve plans from Jira or GitLab, so the platform never
takes your word for which account is yours and never matches by email: it **proves** it. There is no
field to type an account id into.

1. **Link an account** shows a code. It looks like `agentic-link-7K3Q9VDM2X`, is valid for 30
   minutes and is shown **once** — after a reload the page says a code is live but cannot show it
   again, and offers **Get a new code**; asking voids the old one. At most five an hour: a sixth
   says so in words.
2. Write it as a comment **from your own account**: on a ticket of a project you are in (Jira), or on
   a merge request (GitLab — merge requests only, not issues). Do not edit the comment afterwards:
   an edited comment, or one somebody else edited, links nobody.
3. The platform reads the comment's author from the provider — from the webhook, or, on a project
   with no webhook, when you name the ticket or merge request under **I wrote it on …** (a project,
   *A ticket* or *A merge request*, and its key or number; only for a task of a project where you
   are a member or above). The page asks again every few seconds while the code is live, so the
   match appears by itself.
4. It then **asks you**: *Link Jira account Dev One?*, with the account id and the connection that
   read it beside the name. Only **Link this account** links it; **Not mine — get a new code** starts
   again. The name is the provider's text: check the account id. Once linked, the page says what
   follows — *You now own 2 tasks assigned to you in Jira* when the link made tasks yours — and that
   you can delete the comment now.

A code that stopped says why — it expired, someone else wrote it too, or the account that wrote it
is linked to another person — and offers a new one.

If somebody else writes your code too — anyone who can read the ticket can copy it — the code links
nobody, and you are told someone else used it: ask for a new one and post it where fewer people can
see it. A comment written by the integration's own account, by an account an administrator declared
a machine, or carrying the platform's own marker never links anybody, and an account already linked
to another person is refused. Once linked, every task in progress that the tracker assigns to that
account and that nobody owns becomes yours. You can unlink your own account at any time (tasks you
own through it keep you as owner until the ticket's assignee changes); you can delete the comment
once you are linked.
- **Stuck events** (*Dead letters* before) — events the platform stopped retrying after their handler
  failed every attempt, each with a **Try again** button for once the fault is fixed (the operator
  guide's §9 says what a re-queue does and does not do). The newest come first, and **Show older**
  reaches the rest; **Failed background jobs** (*Failed jobs* before) pages the same way. Home's
  *Needs you* tells an administrator when either has something in it.
- **Instance** — the version and build the server is running.

**Policies** and **Notifications** are the organisation settings (since WP-93), which only an
administrator may save. *Policies* holds the maximums every project is held to:

- the **command maximum** — every agent run's commands are its role's list intersected with this one,
  so a command left out of *Allowed* is removed from every run of every project;
- the **autonomy maximum** — the highest dial position a project may choose. A project above it runs
  at the maximum from its next task (the project's own setting is kept, so raising the maximum
  restores it), and a task that is already running keeps the dial it started with;
- the **parallel tasks maximum** — a project may allow fewer tasks at once, never more.

*Notifications* holds the organisation's **quiet hours** and **digest time** — an organisation budget
crossing its threshold at night waits for the morning digest, and a spent budget is still posted at
once — and, with two chat accounts, the **default chat account** that speaks for the organisation.

A lowered maximum applies from the next run or task; nothing already running is moved. When you
save one, the page lists every project the change caps — whose autonomy level or WIP limit in force
fell — with the value before and after. Each project's own choice is kept, so raising the maximum
again restores it. The provider
mode (an environment setting) and feature flags (a project's own) are not organisation settings. A
project's features are switched on its own settings page.

**A project's Settings tab** has the same shape, one page per section — **Connections · Execution ·
Default branch · Discovery & readiness · Business context · History · Trial run · Rules & limits ·
Repository configuration · Prompt files · Knowledge** — and mirrors every step of the setup wizard,
so nothing is only reachable while a project is being set up; opening the tab opens *Connections*.
The wizard's own controls keep their own buttons there (How much agents do alone, the ticket
lifecycle), because each is one decision with its own save; the project budgets are set on the
project's **Budgets** tab (section 8), where the money they cap is shown. *Trial run* links to the
project's Trial page, which is reached from here once its tab is gone. *Rules & limits* (*Policies &
WIP* before) holds the operating mode —
**How much agents do alone**, the features, the **Sensitive areas**, a pointer to *Budgets*, the
notifications and who changed what — with the verification mode (*Checks run by: agents* or *CI*)
and **Parallel tasks**, the limits in force. Unlike an organisation
section it has **no one Save at its foot**: each card saves on its own, some as you change them and
the rest with their own button. **Replace with these classes…** asks first when risk classes are
already in force, saying that a class not among the proposed ones stops applying.

**The ticket lifecycle** is a project's own setting too: the project settings' *Connections* section
carries the same form as the wizard's step 1 (§ 1, *The ticket lifecycle*) — every slot a pick
list of the tracker's own statuses, every slot allowed to stay empty, the two claim switches, and the
same check against the tracker when you save. Change it there at any time; a new *QA* mapping
applies to tasks created afterwards.

**Verification** is a project's own setting, under *Rules & limits*: *Agents run the checks* (the
default) or *CI runs the checks*. Choose CI when the project's pipeline already runs the tests and
static analysis on every merge request and the agents' workspace (2 CPUs, 4 GiB) is too small for
them — no agent then runs the test suite, a linter, a build or a dependency install (they are
refused as `command policy: block`), every agent with a shell is told the CI gate runs them, a red
pipeline comes back to the Developer with the failing job's log, and Discovery answers R1, R2 and R6
by reading the CI configuration rather than running anything (the evidence says so). The same key is
`verification.mode: ci` in `.agentic/config.yml`, which may switch a project to CI but never back.

**Execution** (since WP-278) is who runs a project's agents, the *Execution* section of its
settings, and only an administrator may change it. Every agent run is first *offered*, and whoever may take it
does:

- **Who runs this project's agents** — *Workers only* (developers' own computers, the **Workers**
  page), *Prefer workers*, *Prefer the platform server* (the default) or *Platform server only*.
  The line under the choice says what it means.
- **If no worker takes it within …** / **If the platform server hasn't taken it within …** — with
  a preference, how long the first side has before the other may take the run too (the fallback):
  15 s when the server is preferred, 5 min when workers are, unless you choose another duration.
- **Head start for the assignee's worker** — a worker of the task's **owner** (for a question, of
  the person who asked it) gets this long (2 min by default) to take the run before anybody else,
  while that worker is online and takes the project by itself (not *only what I pick*). The head
  start is fixed when the run is offered: an owner changed later gets it from the next stage.
- **Give up and ask a person after** — a run nobody takes within this long (a day by default) is
  withdrawn and its task goes to **Needs you** with the brief *no claimant took this run*; a
  question is answered as failed. Check the choice, and whether a worker or the platform server is
  actually running.

Each duration is a list of presets; **Custom…** takes a number of seconds. The section says in a
sentence whether the platform server runs agent work on this platform right now. With none, a
project that prefers the server has its runs offered to workers at once rather than after the
fallback, and a *platform server only* project's runs wait — the card says which. When the project's
git connection gives runs a long-lived token or a deploy key, the card says that workers can't take
its runs (sending that credential to a developer's computer is off) and links **Open the git
connection**, where an administrator can allow it. **Would take this project's work** lists each
worker you can see — every one for an administrator — with ✓ *Takes its runs by itself*, *Only runs
its owner picks*, or ✗ and the first reason in the same words as the Workers page (the worker's own,
such as *It has an older build than this platform*, before the project's, such as *The project runs on
the platform server only*), and under it what waits: *3 runs are waiting for a worker*, and for each
reason some can't go to one, *2 waiting runs can't go to workers: they were offered to the platform
server only* (pausing and resuming a task offers its run again). A change applies to runs offered
after you save it. This is never a key of `.agentic/config.yml` (*Why isn't this in the repository's
configuration?* says so): where code runs and whose subscription pays is not something a pushed
commit may change.

## 12. Statistics

The organisation's delivery numbers over a range you choose — the last 7, 30, 90 or 365 days — and
a granularity (by day, week or month), both at the top of the page beside **Download CSV**, which
downloads the same figures with one row per metric and period. Each row names its unit: `count`, `usd`, `minutes`, `hours`, `ratio` (a fraction between 0 and 1)
or `decimal` (an average such as returns per delivered task).

The figures are grouped into sections: **Throughput** (tasks started, tasks delivered, merge rate,
cycle time), **Quality** (first-pass acceptance, clean first-MR rate, human intervention rate,
returns per delivered task), **Cost** (spend in this range, lifetime cost per delivered task,
estimated share of spend, estimate error, cache hit ratio), **Time** (agent time, question response
time, reviewer minutes per delivered task, human minutes), then **Knowledge** and **Merge requests
and tickets** for the rest. Each figure is a card: the value, its name, which way is good (*Higher
is better*, *Lower is better*, or *A volume, not a score* for a count of how much happened — this
build shows no previous period to compare with), and what the figure is from (*From 12 delivered
tasks*, *From 3 answered questions*, *From 5 data points* where the count is not of one thing).
The range above the cards is written like every other date (*Sep 10, 2026 to Oct 9, 2026*), with
the timezone the days were cut in. Hover or focus the name to read its definition. Where the period holds at least two days (or weeks, or months) with a value, a small line
under the figure shows its trend.

How to read a few of them:

- **Returns per delivered task** is an average count — *8.0* means the delivered tasks were sent back
  eight times each on average — not a percentage.
- **Cache hit ratio** is the share of all input tokens that were read from the prompt cache, so it is
  always between 0 % and 100 %.
- **Lifetime cost per delivered task** counts the *whole* spend of each task delivered in the range,
  including runs from before the range began. **Spend in this range** counts only money spent inside
  the range, on every task. With few deliveries the first can be much larger than the second; both
  are correct.

A card with nothing to measure in the range shows a dash and *No data in this range* — which is not
the same as `0`: a zero is a measurement, the dash means there was nothing to divide. What is known
to be imprecise about a figure — reviewer minutes, for example, over-count on bots and under-count on
approvals — is listed under **How these are measured** at the foot of the page, folded. A number this
build cannot compute is never drawn as a zero either: it is listed under **Not measured, and why**,
also folded, with its reason and what would give it a value.

### Workers

**Workers** lists the machines registered to run agent stages for this platform — yours, or every
one if you are an administrator. **Add a worker** at the top opens the wizard below, and **Approve a
machine** the approval page. Each row says first **whether the machine can take work**, as the
platform itself decides it: **Ready**, or **Can't take work** with the first reason — *Not connected
to the platform — last seen 3 h ago*, *Paused by its owner*, *Paused — usage limit until 14:00*, *It
has an older build than this platform*, *It has no run images*, *Needs an update*, *No project gives it
work* — and **Why?** lists every reason with what to do about it, the most fundamental first. A machine
whose owner chose *only the runs I pick* says *Takes only runs its owner picks*: it claims nothing by
itself, and a run picked on its page still starts. A machine that is **updating itself** — draining
because it has an older build or speaks an older version — says *Updating now…* as work in progress,
not as a fault: its updater brings it up to date by itself, usually within a minute or two, and there
is nothing to do (re-running the installer is a repair and changes no images). The header counts it
as *updating*, and Home, the wizard's *Ready to work* and a project's execution settings say the same. Then its owner, *Last took work 5 m ago* (or *Has
not taken work yet*), and how many of its run slots are busy (*1 of 2 busy*). Under that, **What this
machine takes** says the machine's setting in the same sentence as its own page (*What a machine
takes*, below): on your own machine with **Change**, the same two choices and **Save**; on somebody
else's — an administrator sees every machine — with their name (*This machine takes **only Vojtěch's
tasks**, in **all their projects**.*) and nothing to press, because only a machine's owner changes it.
On your own machine, under *Only my tasks*, the card warns *Unassigned tasks in Autix have nowhere to
run.* for each project where neither the platform server nor any other machine — your others included —
takes unassigned tasks by itself, as the machine's own page does; the screen asks once you press
**Change**, so before that, when the platform did not answer, and on somebody else's machine it says
nothing. A muted *Skipped 3 runs this machine doesn't take* counts the waiting runs its choice leaves
for others. **Details**
holds when it was registered and last seen, its worker version and the image digests it
reported. The header counts *2 ready · 1 can't take work · 1 revoked*. The page refreshes by itself
every 15 seconds while it is open. **Revoke** opens a dialog that says what it does before anything
happens: the machine's credential stops at its next call, any run it holds is ended by the lease
sweep and planned again, and to use the machine again you approve it again from the machine. With
no worker yet, the page says what a worker is, with **Add a worker**.

#### Add a worker

**Add a worker** — in the top bar's **+** menu, for everybody signed in — is a five-step wizard at
`/workers/new`, with the steps on the left, one primary button per step and **Save and exit** at
the top right. The step is in the address, so a link (or Home's checklist) opens it where you left
off.

1. **Install.** What a worker is, what you need (Docker on that computer and a Claude
   subscription), and one line to copy per system, built from this platform's own address — the
   one for the system your browser runs on first:
   - **macOS or Linux (Terminal):** `curl -fsSL '<platform>/api/worker/v1/install.sh' | sh`;
   - **Windows (PowerShell):**
     `powershell -ExecutionPolicy ByPass -c "irm '<platform>/api/worker/v1/install.ps1' | iex"`, in
     Windows PowerShell 5.1 or PowerShell 7 — the line the installer's own header documents. It
     needs Docker Desktop for Windows installed and running in Linux containers mode (Windows
     containers are refused) and the Docker Compose v2 that ships with it;
     it needs no administrator rights, installs into `$HOME\agentic-worker`, and adds no service and
     no PATH change. **Or download it, read it, then run it** gives
     `irm '<platform>/api/worker/v1/install.ps1' -OutFile install.ps1; notepad install.ps1` and then
     `powershell -ExecutionPolicy ByPass -File install.ps1`.

   Each has **Read the script first**. The script checks Docker, puts the worker in
   `~/agentic-worker`, starts it for this platform and opens http://127.0.0.1:7357, the worker's own
   page. **Set it up by hand** holds the three lines instead: the `curl` that downloads `compose.worker.yml`, the
   `APP_CORE_URL=…` line for a `.env.worker` file beside it, and
   `docker compose --env-file .env.worker -f compose.worker.yml up -d`; then open
   http://127.0.0.1:7357 on that computer.
   The platform cannot see an install, so this step is done when you tick **I've done this**.
2. **Start it and sign in.** The worker's page opens at http://127.0.0.1:7357 and walks you through
   signing in to Claude, then shows the code to approve. **If you set it up by hand** holds the
   terminal way: `claude setup-token` signs in to your Claude subscription. The browser then says
   *Build something great — you can close this window*: the token is printed in the **terminal**
   where you ran the command, not in the browser, and may wrap over two lines — join them — and goes
   into `.env.worker` as `CLAUDE_CODE_OAUTH_TOKEN` (the step also gives a command that writes it
   without printing it), then start the worker again. Don't authorize again: every run creates a new
   token. Three troubleshooting items: *Safari can't connect to localhost:…/callback* (the command
   was stopped before you authorized: run it again in a terminal that stays open), *downloading the
   script or compose.yml answers 503 or 426* (the platform needs an update: ask an administrator),
   and *the page at 127.0.0.1:7357 doesn't open* (`docker compose ps` in the worker's folder, and
   read what starting it prints). *Continue* is never held here: you may already have the code.
3. **Approve.** **Approve the code** opens the approval page (below) in a new tab. The step is done
   once a new worker of yours appears — this page asks every 5 seconds while you wait.
4. **Ready to work.** Whether that worker can take work now, line by line, as the platform decides
   it: connected, speaks this platform's version, not paused, not draining, not held by a Claude
   usage limit, has its run images, has this platform's current images, a project gives it work —
   each one it fails says what to do (a worker draining for an update says *Updating now…*, in
   progress, with nothing to do), and any other reason the platform names (its owner's account
   disabled, the platform unable to name its own images) is listed too. A last line says whether it
   has taken its first run; that is not needed to continue. A worker that takes only the runs its
   owner picks may continue.
5. **Choose projects** (optional). Each of your projects, and whether workers run its stages; for
   one that does not, an administrator gets **Use workers for …** (its *Execution* settings) and
   anyone else is told to ask one. The wizard ends on **Open the board** of the first project
   workers run, or **Go to Workers** when there is none.

**The approval page**, `/workers/approve`: the worker's page shows a code like `BCDF-GHJK`, and you
type it here while signed in, in the large code field (a link from the worker's page fills it in).
Before you decide, the page shows where the request came from, which client sent it and how old the
code is. **Approve only a code your own machine is showing you now** — somebody who sends you a code
is asking you to give their machine your access — and a code older than five minutes asks you to
confirm that a second time. Name the machine and approve, or deny. After **Approve** the page waits
for the machine, asking every 5 seconds: once it connects it says *jan-mbp is connected*, with
**Continue: check it's ready** (the wizard's *Ready to work*). If it has not connected within two
minutes, it says what to check — is the worker still running on that computer, and was it set up with
this platform's address — with **Keep waiting**.

A machine its owner paused from the worker's own page reads **Paused by its owner**: it takes no new
work until it is resumed there. That page — on the developer's machine only, at
`http://127.0.0.1:7357` — shows what the worker is doing and has **Cancel run**, which does exactly
what the task page's *Cancel* does: the run stops and **its task is paused** until somebody resumes it.
A line under its header says what the worker is doing in one sentence: **Taking work** only when
nothing keeps it from work, otherwise **Connected, but not taking work** and why — its launcher is
not answering (with **Try now**, which asks it again), it has no run images or an older build than the
platform, Claude refused its sign-in — or the hold: *Paused by you*, *Draining: finishing 1 run…*, a
usage limit. While it is held, **Resume** is the one button; otherwise **Pause** is beside the header
and **Drain** is under **More**, with what each does written under it. The list of runs waiting for a
worker says why it is empty, and an update is said to come by itself (the worker updates after its
current run). The platform's Workers page says the same reasons for each worker, in the same words,
and a project's execution settings say which workers would take its runs and how many waiting runs no
worker may take now.
Stopping the worker's container is not a cancel; the platform gives the stage to another computer
— once: a second lost run of the same stage goes to *Needs you*, naming both runs
and the machines that held them.

When a worker reaches its Claude **usage limit** the run it was doing ends — not as the task's failure
— its unfinished work is pushed to the task's branch, and the stage is offered once more, continuing
from that work: another worker takes it at once, or the same one once its limit resets. The limited
worker takes no work until then, and carries on by itself. Its own page and the Workers screen both say **Paused — usage limit
until 14:00** (in the organisation's timezone on the platform's screens; *until about* when the limit
did not say when it resets, and the worker waits an hour), and the run's page says the same beside
*Runs on*. A second usage limit on the same stage goes to *Needs you*. A person's *Pause* is a
different hold: the end of a usage limit never lifts it.

**What a machine takes.** The worker's own page has a card, **What this machine takes**, with one
sentence that says the setting as it is stored — *This machine takes **your tasks and unassigned
ones**, in **Autix and Fontai**.* (up to three project names, then *Autix, Fontai +2*) — and the same
sentence under the machine's name at the top of the page. **Change** opens two choices:

- **Which tasks**: *My tasks and unassigned ones* (what a newly approved machine starts with), *Only my
  tasks*, *Everything* (any task in its projects, including a colleague's — what a machine approved
  before this choice existed keeps, unless it was set to pick only), or *Only what I pick* (it takes
  nothing by itself; you choose each run on this page, and choosing one assigns the task to you). Each
  says in one line what follows.
- **In which projects**: *All projects you can see* (the default) or *Only these:* and the projects you
  tick. It applies to every choice above; under *Only what I pick* it narrows the list of runs.

**Save** stores it and the card says *Saved · applies to the next run*: a run in flight is never moved.
It is set per machine — your desktop may take everything while your laptop takes only what you pick —
and it only narrows what the platform already lets that machine take; it never adds a project you do
not work on. "Your task" is a task you own; a question you asked on a task is yours whoever owns the
task. "Unassigned" means nobody owns the task and its ticket is not held by someone the platform cannot
match to a member — a ticket a member gave back is unassigned. A machine that takes only your tasks and
finds none waits by choice, and is not shown as blocked; the Workers screen counts the runs it left for
others. The machine's owner changes the choice; an administrator sees it on the Workers screen and
cannot change it. Under *Only my tasks* the card warns, for each selected project where neither the
server nor any other machine — yours included — takes unassigned tasks by itself, *Unassigned tasks in
Autix have nowhere to run.* It is a warning: the choice still saves. It says nothing when the platform
did not answer (an older platform version), and it reflects the other machines' settings when the page
last read them, so reload the page after changing another machine.

**Picking a run.** Below the card, **Runs waiting for a machine** lists what the machine could take
right now, refreshed every 10 seconds while the page is open. A run of a task nobody owns reads **Take
this one** with *Assigns DEMO-1 to you.* under it; pressing it says *Assigned to you · starting on this
machine…* and the task becomes yours. A run of your own task reads **Run it here**. A run of a task
someone else owns reads *Vojtěch's task* and has nothing to press — a pick never takes a task from its
owner; if they took it while the list was open, the press says *Vojtěch took DEMO-1 a moment ago. Pick
another.*, and if it was already theirs, *DEMO-1 is Vojtěch's. A maintainer can reassign it on the task
page.* A question asked on a task is listed as a question, never with its text, and picking it makes
nobody its owner; one you asked reads *Your question*. A run whose ticket is held by somebody the
platform cannot match reads **Take this one** with no *Assigns* line: it is taken without making it
yours. A pick is a choice of order inside what the machine may already take, not a priority: it never jumps the platform's own turn on a project whose
administrator prefers the server, nor another person's head start on their own run — so on such a
project the list is usually empty, and a run that is not listed is not yours to take yet. If another
machine or the platform takes a run first, the press says so and the list refreshes. A machine set to
*only what I pick* takes nothing by itself, and is not given a head start on runs it would not take.

## 13. The whole list of what is not there yet

In one place, so it is not spread across thirteen sections:

| Not built | Where you meet it |
|---|---|
| The business interview as a *conversation* with the Product Manager role (the form is built; Q102) | New project step 3 |
| Committing `.agentic/` configuration from the wizard itself (the project settings page does it) | New project step 6 |
| Re-answering the nine run-dependent readiness criteria after a merge (five are re-checked) | New project step 2 |
| Editing a knowledge document or the pipeline in the browser | knowledge, pipeline |
| Instance-wide feature flags and the provider mode as organisation settings (the provider mode is an environment setting; a project's features are its own) | settings |
| The statistics the screen lists under *Not measured, and why* | statistics |
| Moving a ticket to a *deployed* status once a deploy is seen (the *Done* slot moves it at the merge) | ticket lifecycle, New project step 1 |
| A ticket lifecycle for a project with two ticket trackers bound (the form says the pipeline applies one only with exactly one) | ticket lifecycle, project settings |
| Showing and changing a task's owner on the task page and the board (the platform records it and the API serves it) | task detail, board |

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
