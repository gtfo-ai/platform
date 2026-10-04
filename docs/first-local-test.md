# The first local test — GitLab, Jira Cloud and a Claude subscription on a Mac

> A runbook for one setup: Docker Desktop on a Mac, a project on **GitLab** (gitlab.com or a
> self-managed instance), tickets in **Jira Cloud**, and agents paid for by your own **Claude
> subscription** ([BD-004](decisions/business/BD-004-claude-only-provider-modes.md)'s `local`
> mode). It goes from an empty clone to a first ticket worked by an agent, and then says where to
> look when something fails. The [operator guide](operator-guide.md) and the
> [user guide](user-guide.md) are the full references; this page links into them rather than
> repeating them.
>
> **How to read the commands.** Every command block says, on each line, whether it was **run**
> (on a disposable instance from this repository at `1c8b6b1c`, Docker Desktop 29.8.1, Compose
> 5.5.1, `linux/arm64`, 2026-10-03, during WP-135) or **not run** and why. Nothing here was run with a
> real credential: no model token, no GitLab token and no Jira token was used, so the first real
> agent run, the first real provider call and the first real ticket are yours. The WP-135 notes in
> [`technical/PROGRESS.md`](technical/PROGRESS.md) have each command's outcome.

## 0. What you need before you start

- **Docker Desktop** with the `docker compose` plugin. Give its VM room: an agent run is a container
  limited to **2 CPUs and 4 GiB** of memory (`PLATFORM_WORKSPACE_LIMITS`), beside PostgreSQL, the
  `app`, the `runner` and the `launcher`. 8 GB of memory for the VM is a sensible floor; what the
  stack itself uses was **not measured**. Disk: the images are about **3.3 GB** unpacked (operator
  guide § 1), plus the build cache.
- **Port 8080** free on the Mac. Nothing else is published: the database and the launcher are on
  internal networks. If 8080 is taken, set `APP_PORT` and `APP_BASE_URL` (§ 3) to another port.
- **A build at or after commit `11a17ae`.** Before it, an instance in `local` mode composed **no
  agent runner** at all — the `runner` logged your token as missing while its environment carried it,
  and every agent stage queued forever (WP-133). This page's commands build from your checkout, so
  `git pull` is enough; `git merge-base --is-ancestor 11a17ae HEAD && echo ok` prints `ok` on a good
  checkout (run). Ticket identity by Jira **issue id** (below) needs `1c8b6b1c` or later.
- **A Claude Pro, Max, Team or Enterprise plan**, and the `claude` CLI on your Mac **once**, to mint a
  token (§ 3). Anthropic documents `claude setup-token` as *"This token authenticates with your
  Claude subscription and requires a Pro, Max, Team, or Enterprise plan. It can only make model
  requests"*, valid for one year
  ([Claude Code authentication](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)).
- **Node is optional.** With Node 24 or newer on the Mac, `node scripts/build-images.mjs` builds every
  image in one command; § 4 also gives the plain `docker build` lines, which need nothing but Docker.

**Your Claude Code login on the Mac is not what runs the agents.** The platform runs its own pinned
`claude` (2.1.267) inside a fresh, network-restricted container per run (`platform-runtime`), and
that container is given **no host mount** — not your binary, not `~/.claude`, not your keychain.
The only thing that crosses from you is the token you put in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`; it
reaches a run's environment **by name** and was found in no log line and no database row of a test
instance (WP-133, with a fake token). Runs spend your plan's usage limits, the same ones your own
Claude Code sessions spend (operator guide § 8).

## 1. The GitLab side

Read the GitLab setup guide once — [`setup-guide.md`](../packages/integrations/src/providers/gitlab/setup-guide.md),
also served in the product at **Integrations → GitLab → Setup guide**. What matters for this test:

**The token.** A **personal access token** with scope **`api`**, from a user with the
**Maintainer** (or Owner) role on the Autix project — a bot user if you have one, your own account
if you do not (its name then appears on every comment the platform writes). A project or group
access token works for reads but **cannot mint** — and every stage that writes needs a minted token
or, on gitlab.com Free where nothing can mint, the static run credential below.

**A private repository needs a run credential, minted or static.** Each agent run with a checkout
gets a git credential the platform hands it on the create request: either its own short-lived
project access token, minted through the binding's token and revoked when the run ends
(`mint_credentials: true`), or — where GitLab cannot mint — the integration's **static run
credential** (`run_credential: static`). With neither, every stage on a private repository is
refused at start naming the binding and **both** settings; a read-only stage can only fetch a
repository GitLab serves without authentication.

**On gitlab.com Free — Autix's case — use a static run credential** (the setup guide's step 5a;
TD-028 decisions 13 and 13a). **You choose which of three forms**, each with its own loss:

| | A. A dedicated user's token | B. Your own repository-only token | C. A project SSH deploy key |
|---|---|---|---|
| Set | `run_credential: static` | `run_credential: static`, `run_token_owner: operator` | **not in this build** (WP-146) |
| You create | a **dedicated** GitLab user on the Autix project **only**, role **Developer**, and its token | a token of **your own** account | — |
| Token scopes | `read_repository` + `write_repository`, expiry ≤ 90 days | `read_repository` + `write_repository` **only** (no `api`, `read_api`, `read_user`), expiry ≤ 90 days | — |
| Costs | a seat | nothing | nothing |
| **Test connection** checks | the user's role: Developer passes, Maintainer/Owner refused | the token **cannot call the API** (`GET /user` with it must answer `403 insufficient_scope`) **and** every rule matching `develop`, wildcards included, leaves push **No one**, force push off — the latter **re-checked before every run**; the scope is not, so test again after every re-seal | — |
| **Lost** | the token lives to its expiry, is not revoked per run, a read-only stage holds it with its push scope, and a run could push it into the repository where it still works | all of A's, and **reach**: it reads **every repository you can access** and pushes to every unprotected branch of them; pipelines on the branches and tags a run pushes run **as you**, and a tag matching a protected-tag rule open to Maintainers gets protected CI variables — protect release tags with *No one* too | — |

**Which today:** A if a seat is free, B otherwise — B needs no new user, and the checks are what stand
in for the role limit, so protect the default branch (*Protect the default branch*, below — and leave **Allowed to force push** off) before testing. C is
stronger than both (the key never enters the run's container) and lands later. Either way, put the
token in `.env` as `GITLAB_RUN_TOKEN` and add the name to `APP_INTEGRATION_SECRET_ENV` (§3). The
platform's one added control is a search of every merge request's added lines for the exact token —
a hit parks the task with *"rotate the run token"*. The protected default branch stays the push
control.

| | gitlab.com | self-managed |
|---|---|---|
| Project access tokens (so `mint_credentials`) | **Premium or Ultimate only** — on Free use `run_credential: static` instead (above) | every tier |
| `APP_INTEGRATION_HOSTS` entry | `gitlab.com` | your host exactly as in `base_url`, no scheme, no port |
| `base_url` | `https://gitlab.com` | `https://<your host>[/<path>]`, no `/api/v4`, no trailing slash, and not a URL that redirects |
| Token prefix | `glpat-` (default) | set `token_prefix` if an administrator changed it (Admin → Settings → General → Account and limit) |
| Reaching it from the containers | public internet | the launcher's helper containers clone it and the run's egress sidecar connects to it **from inside Docker Desktop's VM** — a host reachable only over a VPN, or with a certificate from a private CA, was **not tested** |
| A webhook into your Mac | cannot reach `localhost` | would need your Mac reachable from the GitLab server — **not tested**; use polling |

**Know the default branch.** Autix's is **`develop`**, not `main` — and the platform uses the
branch you give it in the wizard (§ 5): every run checks it out, every merge request targets it and
the knowledge base is read from it. Before WP-139 the wizard sent none, so every project was `main`
and a repository without a `main` failed at the first checkout. Since WP-142 the stored branch is the
**only** answer: the protection check at intake, readiness R9, the poll's `default_branch.moved` (and so
the rebase gate's re-check), coverage's baseline and the `CODEOWNERS` read all take it too. GitLab's own
default (Settings → Repository → Branch defaults) is read only to prefill the wizard's field and for a
**notice** on the project's settings page and beside the readiness panel — *"GitLab's default branch is
X; this project uses Y"* — which refuses nothing. Keep the two the same anyway: GitLab's default is what
people open merge requests against.

**Moving the default branch** (Autix `develop` → `main`). In this order:

1. **Finish or cancel every task of the project** — the board shows none outside *Done*/*Cancelled*. The
   change is refused (`409 project_has_live_tasks`) while one is unfinished, because its branch, merge
   request and gates were made against the old branch. A ticket the poll matches in the meantime starts a
   new task and blocks the change again, so do steps 2 and 3 together (or set the project's autonomy dial
   to *Observe* for the minutes it takes: Observe picks up no ticket).
2. **On GitLab**: create `main` if it does not exist, **protect it** (Allowed to merge: Maintainers,
   Allowed to push and merge: **No one**, force push off — the same rule as below), make sure its
   `.gitlab-ci.yml` carries the CI rules below, and set it as the **default branch** (Settings →
   Repository → Branch defaults). From here until step 3 the settings page shows the notice; nothing is
   refused and nothing runs differently.
3. **On the platform**: the project's settings page → **Default branch** → `main` → **Save default
   branch**. In the same transaction the platform forgets the head its poll last saw, so the next poll
   reads `main`'s head as a first reading and records **no** move (no rebase re-check, no index run from
   it); after the change it asks for a knowledge index of `main`, which also re-reads `.agentic/config.yml`
   there. With **your own** run token (§ 1's form B), press **Test connection** again: its protection
   check reads the stored branch, now `main`. The notice disappears.

Nothing of this was run against GitLab: the order is the code's, read off `writeProjectDefaultBranch`
(`apps/server/src/queries/onboarding-queries.ts`) and the poll (`pipeline/mr-poll.ts`).

**Protect the default branch** — **Settings → Repository → Protected branches**, `develop` (your
default branch) with **Allowed to merge: Maintainers** and **Allowed to push and merge: No one**.
Merging stays a person's act on GitLab; nobody, the platform's tokens included, pushes to it
directly. The platform checks that the branch is protected before it starts a task: a ticket on a
project whose default branch is unprotected becomes a task that is immediately parked *Needs human*
with the brief *"the default branch … is not protected"*. With **your own** run token (§ 1's form B)
also leave **Allowed to force push** off: that rule is checked at **Test connection** and before every
run, and a run is refused while it does not hold.

**Autix's CI rules — required before the first feature ticket.** The platform's branches are
`agentic/<ticket>` (fixed, Q114), and its merge requests are opened as drafts and **marked ready
before CI is asked for** (§ 7). Autix runs its Composer jobs only for source branches matching
`^(feature|bugfix)/`, so, in `.gitlab-ci.yml` on `develop`:

- **admit `agentic/`** wherever `feature|bugfix` is matched — `^(feature|bugfix|agentic)/`;
- **make the test jobs run on merge-request pipelines** (`$CI_PIPELINE_SOURCE == "merge_request_event"`
  in their `rules:`): when the head of a ready merge request has no pipeline, the platform asks GitLab
  for a **merge-request pipeline**, and a job whose rules do not admit one is not in it — GitLab may
  then refuse the pipeline as having no jobs, and the CI gate waits until its timeout (§ 8);
- the rule that **skips a `Draft:` title** needs no change: the platform removes `Draft:` when
  Implementation completes, before the gate reads CI.

Without the first two the merge request gets no pipeline and every task parks at the CI gate.
Whether GitLab starts a pipeline on its own when a draft is marked ready was read off its
documentation, not measured on gitlab.com (`docs/TODO.md`).

**The readiness panel checks this for you, as far as it can (WP-143).** Discovery and every
re-check after a merge evaluate the default branch's CI file — at the path GitLab names, read from
the platform's mirror — for a **push** pipeline of `agentic/X-1` and a **merge-request** pipeline
from it into the stored default branch (title not `Draft:`, commit message not `WIP`). It reads
`workflow:rules`, each job's `rules:` (`if:` with `==`, `!=`, `=~`, `!~`, `&&`, `||`, parentheses,
`null`) and `only`/`except`. When **no** job in stage `test` (or no job at all, for a file with no
`test` stage) runs in **either** pipeline and it understood every rule that decided, the panel shows
a **warning** — *CI rules skip agentic/ branches* — naming the first rule that kept the branch out
and the fix (admit `agentic/`). It **cannot see** `include:` (any kind — the file is then not
evaluated), `extends`, `!reference`, `changes:`, `exists:`, `trigger:`, project CI/CD variables or
any variable it does not set, and a CI configuration outside the repository (`@` or a URL); for
those it shows a quieter **note** listing what it did not see, never a warning. Autix's file today
gets the note: its test jobs share `.default_rules` through `!reference`, filter merge requests by
`changes:`, and the e2e jobs use `extends` — only `lint-documan` is decided (it runs in a
merge-request pipeline). So the note is not a pass: check the two bullets above by hand. The notice
never blocks anything and changes no readiness level.

**Webhook or polling.** On a Mac, GitLab cannot reach `http://localhost:8080`, so use a
**poll-only** binding: set `poll_enabled: true` and `project`, and leave **both**
`webhook_secret_token` and `webhook_signing_token` empty. A GitLab binding with no webhook secret is
poll-only, and since WP-123 its polls read, besides the merge requests themselves (opened, updated,
merged, closed), the **default branch's head** — the stored branch's (so a task at Ready is
re-checked for conflicts when it moves) and the **comments on merge requests waiting at Ready** (so a reviewer's comment
returns the task to Implementation). Setting a webhook secret for a webhook GitLab cannot reach turns
both reads off. What polling never sees: approvals and **finished pipelines** — which matters at the
CI gate (§ 8, *the CI gate on a poll-only binding*).

### GoParking — a self-managed GitLab

GoParking is on **`https://gitlab.fontai.org`**, a self-managed instance, so it gets an integration
of its own (a GitLab integration has one `base_url` and one polled `project`). What differs from
Autix:

- **`APP_INTEGRATION_HOSTS`** must name **`gitlab.fontai.org`** — exactly that host, no scheme, no
  port — beside `gitlab.com` (§ 3). `base_url` is `https://gitlab.fontai.org`.
- **Minting, not a static credential.** A self-managed instance has project access tokens on every
  tier, so set **`mint_credentials: true`** and leave `run_credential` at `minted` with **no**
  `run_token`: each run gets its own short-lived project access token, revoked when the run ends.
  The integration's `token` must belong to a user with the **Maintainer** role (or above) on
  GoParking — minting a project access token needs it. Put it in `.env` under a name of its own,
  for example `GITLAB_FONTAI_TOKEN`, and add that name to `APP_INTEGRATION_SECRET_ENV`.
- **Default branch `dev`.** Type `dev` in the wizard (§ 5); once the integration is bound the
  wizard shows what GitLab says and offers it. Protect `dev` as above (merge: Maintainers, push and
  merge: No one).
- **CI configuration at `deploy/.gitlab-ci.yml`.** Nothing to configure: since WP-139 the platform
  reads the project's **CI/CD configuration file** setting (GitLab's `ci_config_path`) from GitLab
  and looks for that file on `dev` — before, it looked for `.gitlab-ci.yml` at the root, found none
  and read GoParking as a project with no CI, so a merge request with no pipeline passed the CI gate
  on no evidence. A configuration GitLab takes from another project (`…@group/project`) or a URL
  counts as CI that is present. The project's settings page (**Default branch**) shows what GitLab
  answered. The same CI rules as Autix's apply: `agentic/` admitted, test jobs on merge-request
  pipelines.
- **Reaching it from the containers** is the self-managed column of the table above: a host
  reachable only over a VPN, or with a certificate from a private CA, was not tested.

## 2. The Jira side

Read the Jira Cloud setup guide once — [`setup-guide.md`](../packages/integrations/src/providers/jira-cloud/setup-guide.md),
also at **Integrations → Jira Cloud → Setup guide**.

- **An API token**: *Atlassian account → Security → API tokens → Create API token*, as the account
  the platform should act as. The platform signs in with that account's e-mail and the token.
- **Permissions** on the Autix Jira project for that account: Browse projects, Add comments, Edit
  issues, Transition issues, Link issues (and Create issues only if you enable epic splitting).
- **How a ticket is picked up**: the label **`agentic`** by default (`pickup_label`). A webhook needs
  a public URL, so on a Mac set **`poll_enabled: true`**: every 60 seconds the platform asks Jira for
  `labels = "agentic" AND updated >= "-<n>m"`. The first poll reads only the last interval, so **add
  the label after polling is on**, or edit an already-labelled ticket so the next poll sees it.
- **`project_keys`**: set it to Autix's Jira project key (the form takes a comma-separated list, for
  example `AUTIX`). Empty means every project the account can see.
- **What the platform writes to the ticket**: one *Agentic workpad* comment it keeps up to date,
  questions as comments, and status moves by name — *In Refinement* (else *In Progress*), *In
  Progress*, *In Review*, *Done* — only where your workflow has that status (product/19 § 6). Use a
  ticket you do not mind being commented on and moved.
- **A ticket's identity is its Jira issue id** (WP-134, `1c8b6b1c`): a ticket moved to another Jira
  project keeps its id, so it meets the task it already has rather than starting a second one. Put
  both projects in `project_keys` if tickets move between them.

## 3. `.env`

```bash
git clone https://github.com/gtfo-ai/platform.git agentic   # not run (this page was run from an existing checkout)
cd agentic
git merge-base --is-ancestor 11a17ae HEAD && echo ok        # run: ok
cp .env.example .env                                        # run (in a scratch directory)
openssl rand -base64 48                                     # run: 64 characters
openssl rand -hex 32                                        # run: 64 characters
claude setup-token                                          # not run: it needs your Claude account (`--help` was run)
```

`.env` is read literally — **paste values, never `$(…)` commands** (operator guide § 2). Edit the
lines below in place (each already exists in `.env.example`, except the first, which you add at the
end) and leave every other line as it is:

```ini
COMPOSE_FILE=compose.yml:compose.local.yml

APP_SECRET_KEY=<the output of: openssl rand -base64 48>
APP_BOOTSTRAP_ADMIN_EMAIL=<you@your-domain>
APP_BOOTSTRAP_ADMIN_PASSWORD=<at least 12 characters>
APP_BASE_URL=http://localhost:8080

APP_LAUNCHER_URL=http://launcher:7780
APP_LAUNCHER_TOKEN=<the output of: openssl rand -hex 32>
CLAUDE_CODE_OAUTH_TOKEN=<the output of: claude setup-token>

GITLAB_TOKEN=<the GitLab personal access token, scope api>
GITLAB_RUN_TOKEN=<the dedicated Developer user's token, read_repository + write_repository (gitlab.com Free only)>
GITLAB_FONTAI_TOKEN=<GoParking: a Maintainer's personal access token on gitlab.fontai.org, scope api>
JIRA_API_TOKEN=<the Atlassian API token>
APP_INTEGRATION_SECRET_ENV=GITLAB_TOKEN,GITLAB_RUN_TOKEN,GITLAB_FONTAI_TOKEN,JIRA_API_TOKEN
APP_INTEGRATION_HOSTS=gitlab.com,gitlab.fontai.org,<your-site>.atlassian.net
```

What each one is for:

- **`COMPOSE_FILE`** makes every plain `docker compose …` command in this page use
  `compose.local.yml` too, so a later `up -d`, `stop` or `logs` cannot silently bring the instance
  back in `api` mode. Run with this `.env`, `docker compose config` resolved `APP_PROVIDER_MODE=local`
  on `app` and `runner` with no `-f` flag (run). Without it, add `-f compose.yml -f compose.local.yml`
  to every command.
- **`APP_SECRET_KEY`** signs sessions and encrypts the integration credentials in the database.
  Keep it: losing it means entering every credential again.
- **`APP_BOOTSTRAP_ADMIN_*`** is how the first account exists (OPEN-QUESTIONS Q39): while the instance
  has **no users at all**, it creates this administrator at boot. Open registration is off. Choose
  the password well — this build has **no screen to change it**.
- **`APP_LAUNCHER_URL` and `APP_LAUNCHER_TOKEN`** switch on the `runner`. Without both, every agent
  stage queues and nothing runs (operator guide § 1).
- **`CLAUDE_CODE_OAUTH_TOKEN`** is the subscription token. Leave `ANTHROPIC_API_KEY` empty:
  `compose.local.yml` blanks it, because the CLI prefers an API key when both are present.
- **`GITLAB_TOKEN`, `JIRA_API_TOKEN`** are the provider credentials (and **`GITLAB_RUN_TOKEN`** the
  static run credential of §1, on gitlab.com Free only), and **`APP_INTEGRATION_SECRET_ENV`**
  is the allow-list of variable *names* the integration form may name. You never paste a token into
  the browser: the form names the variable and the server seals its value.
- **`APP_INTEGRATION_HOSTS`** is the allow-list of hosts an integration may call, empty and therefore
  closed by default. A self-managed GitLab's host goes here exactly as in its `base_url` —
  `gitlab.fontai.org` for GoParking (§ 1). Leave out the GoParking lines if you test Autix only.

Two optional lines, only if you need them:

- **`APP_RUN_REGISTRY_HOSTS`** — package registries an agent run may install from (`npm ci`,
  `pnpm install --frozen-lockfile`, `pip install -r`), for example `registry.npmjs.org`. Empty means
  a run installs nothing. The run image carries **Node 24 and npm, and no PHP, Composer, Python or
  pnpm** (run: `command -v` in `platform-runtime:dev`), so a project in another language cannot run
  its own test suite inside a run: the agent edits and reads, and your **CI** is the evidence.
- **`APP_PORT`** (and `APP_BASE_URL` with it) if 8080 is taken.

## 4. Build, start, check

```bash
docker build -f docker/base.Dockerfile -t platform-base:dev .                                          # run
docker build -f docker/runtime.Dockerfile --build-arg BASE_IMAGE=platform-base:dev -t platform-runtime:dev .  # run
docker build -f docker/egress.Dockerfile -t platform-egress:dev .                                      # run
APP_COMMIT=$(git rev-parse HEAD) docker compose build                                                  # run
docker compose up -d                                                                                   # run (as the stock check's `local` leg)
docker compose ps                                                                                      # run (by the check)
curl -fsS localhost:8080/healthz                                                                       # run (on the check's published port): 200
curl -fsS localhost:8080/readyz                                                                        # run (on the check's published port)
curl -fsS localhost:8080/api/version                                                                   # run (on the check's published port, before APP_COMMIT was set)
```

**Why the three `docker build` lines come first.** `docker compose build` alone **fails on a machine
that has never built the images**: the `app` and `launcher` images are built `FROM
platform-base:dev`, which no registry has, and compose does not build it — run with a tag nothing had
built: *"failed to solve: pull access denied, repository does not exist"* for
`docker.io/library/platform-base` (run). The run image and its egress proxy are also not compose
services — the launcher creates them per run — so compose never builds them; without them the first
agent run fails. With Node 24, `node scripts/build-images.mjs` does all four builds in one command
(not run for this page; it is what CI and the checks use). Cached rebuilds took 1–13 s each here;
**a first build downloads a Node image, six CLIs and the npm dependencies, and its duration on an
empty machine was not measured**. `APP_COMMIT=…` bakes the commit into the image, so
`/api/version` can tell you which build you are running (the image's environment carried it, run;
the endpoint reads it in `apps/server/src/runtime.ts`).

The published images on GHCR are an alternative to building (operator guide § 2), but on
2026-10-03 the packages were **not anonymously pullable** (the registry's token endpoint answered
401 without credentials), so that route needs `docker login ghcr.io` with access to them.

**What a healthy start looks like** (the `local` leg of `node scripts/compose-stock-check.mjs`, which
starts exactly this arrangement — `compose.yml` + `compose.local.yml`, the launcher pair and a fake
token in `.env` — **PASS**, run):

- `docker compose ps`: `db` and `app` *healthy*, `runner` *healthy*, `launcher` and
  `docker-socket-proxy` running, `migrate` *exited (0)* — `up -d` runs the migrations first.
- `/healthz` 200; `/readyz` 200 with `{"status":"ok","checks":{"database":"ok","migrations":"ok","queue":"ok","dispatch":"ok","agent_runs":"ok"}}`
  (read on the stock leg's instance; the `local` leg's was read before it was serving).
- `docker compose logs runner` has a line *"this process runs agent stages"* and **never**
  *"composed without an agent runner"*; `docker compose logs app` says the `app` composes none — that
  is by design, the `runner` runs agents.
- `docker compose logs launcher` says *"the launcher control plane is listening"*.

### The pre-flight: one turn with your token (optional, before § 5)

Before you connect anything, you can ask whether your token authenticates **from a run container**
and which hosts the logged-in CLI contacts (WP-140). It runs the pinned `claude` for **one** turn —
the prompt *"Reply with the single word OK."*, no tools, at most two minutes — on the check's own
throwaway containers: no database, no GitLab, no Jira, nothing of the stack above. It needs Node 24,
`pnpm install` once in the checkout, and the `platform-runtime:dev` and `platform-egress:dev` images
from the first three lines of § 4. With `CLAUDE_CODE_OAUTH_TOKEN` exported in your shell (the same
value as in `.env`; **never** put it on the command line):

```bash
DOCKER_HOST=unix:///var/run/docker.sock node scripts/launcher-control-plane-check.mjs --real-model   # run with a fake token: FAIL on authentication only, as expected
```

It ends with one line, `PASS: launcher-control-plane-check --real-model (11/11 checks)` when the turn
succeeded. Above it: the run's result (`success`, turns, token usage, and the cost the CLI
*reports* — your plan is not billed per token, but the turn counts toward its usage limits), and the
hosts the run's egress proxy **saw**, allowed and refused. A refused host is one the shipped list
lacks; add it to `APP_MODEL_EGRESS_HOSTS` only if the run failed for it. A wrong or expired token
fails the record *"authentication succeeded"* with `api_retry_statuses: [401, …]`. The flag without
the variable, or the variable without the flag, is refused before anything starts, and the check
asserts your token's value appears in nothing it printed, nor in the runner's record, the launcher's log or the proxy's log. Run it **once**: there is
no retry, and a second run is a second turn.

## 5. Sign in, connect, onboard

1. Open <http://localhost:8080/> and sign in with `APP_BOOTSTRAP_ADMIN_EMAIL` and its password
   (the stock check signed in as its bootstrap administrator: 200, run). You are an **admin**.
2. **Integrations → Add integration → GitLab** (not run: needs your token). Name it; `base_url`
   `https://gitlab.com` (or yours); `token` → the variable name **`GITLAB_TOKEN`**; and among the
   optional fields: `project` = `<group>/<autix-project>` (GitLab's path with namespace),
   `poll_enabled` = true, and the run credential — on **gitlab.com Free**: `run_credential` =
   `static`, `run_token` → the variable name **`GITLAB_RUN_TOKEN`**, `run_token_username` = the
   token owner's username, `run_token_expires_at` = its token's expiry date, `mint_credentials`
   **off**, and — for your own token (§1's form B) — `run_token_owner` = `operator`; on Premium or a
   self-managed instance: `mint_credentials` = true instead. Leave both webhook fields empty. Press
   **Test connection**: it calls `GET /version` and shows the version and edition — and for a static
   run credential the checks of §1, which fail until the integration is bound to the project (step
   4). Form A: `run_credential` reads the dedicated user's role — Developer passes, Maintainer or
   Owner (or a role that cannot push) is refused, and it says it cannot confirm the token is that
   user's. Form B: `run_credential` is the scope proof (`403` passes, `200` is refused naming the two
   scopes) and `default_branch_protection` reads `develop`'s rule. Test again after step 4. Not run:
   needs your tokens.
3. **Add integration → Jira Cloud** (not run): `site_url` `https://<your-site>.atlassian.net`,
   `user_email` the token's account, `api_token` → **`JIRA_API_TOKEN`**, optional `project_keys` =
   Autix's key, `poll_enabled` = true, `pickup_label` left at `agentic`. Leave `webhook_secret` empty.
   **Test connection** calls `GET /rest/api/3/myself` and names the account.
   The create refuses a host or a variable name you did not declare (both refusals run on the stock
   check: `403 integration_host_not_permitted`, `403 secret_name_not_permitted`, each naming the
   setting); fix `.env` and **`docker compose up -d`** — never `restart`, which keeps the old
   environment.
4. **Onboarding** (the user guide § 1 walks it):
   - **Step 1 — Connect**: a project key in lower `snake_case` (`autix`; a capital or a hyphen is an
     inline error and sends no request), a name, the repository's **HTTPS** clone URL
     (`https://gitlab.com/<group>/<project>.git` — an SSH `git@…` address is not a URL and is
     refused), and the **Default branch** — **`develop`** for Autix, `dev` for GoParking; the field
     is required, because the platform's fallback `main` is the wrong branch for both. Then tick
     both integrations, **Test connection**, **Bind**. Once the GitLab integration is bound, the step
     shows the default branch **GitLab** reports and where it says the CI configuration lives; if
     the stored branch differs, a notice says so (*"GitLab's default branch is X; this project uses
     Y"*), the field is prefilled with GitLab's and **Save default branch** changes it. The same control is on the project's settings page. A maintainer can change it
     later, but **not while any of the project's tasks is unfinished** (`409
     project_has_live_tasks`): a live task's branch and merge request were made against the old one.
   - **Step 2 — Technical discovery** is the **first real model run**: a Discovery agent reads the
     repository and runs its declared commands, and you get a readiness level and drafted knowledge
     pages as proposals. It spends your plan's usage. A ticket does not wait for it — nothing in
     intake reads readiness (read off the code) — so you may skip it for the first ticket and run it
     later from the project's settings page. **For a large repository, run it first** (below).

**A large repository: the first clone.** The first run of a project — whichever stage it is —
makes the launcher clone the whole repository into its cache volume (`agentic-repo-cache`) before
the run starts, and the knowledge index clones it a second time into the `knowledge` volume. A
repository of the size reported for this setup (about **633 MB**; not measured here) therefore needs
**at least twice that** on Docker Desktop's disk, plus a working tree per live run (runs clone from
the cache with shared objects, so a run adds its checkout, not another history). The launcher's
create is bounded at **10 minutes** (`packages/infrastructure/src/launcher/client.ts`, the control
client's default timeout), and a first clone over a slow link can approach it; what happens to a
create that exceeds it was **not measured**. Warm the cache with **Step 2 — Technical discovery**
before the first ticket: it is one run, it pays the clone while you are watching, and every later
run fetches only what changed. Watch `docker compose logs -f launcher` while it runs.
   - **Step 3** (the business interview, a form) and **3b** (history mining, which reads up to 200
     merge requests and costs several runs) are optional; skip them for now.
   - **Step 4 — Operating mode**: leave **Supervised** (the default). It asks for **plan approval on
     the first five tasks** (probation) and above size L, so your first ticket will stop once for you
     in the **Inbox** after Architecture. **Observe** picks up no tickets at all.
   - **Step 5** is the knowledge proposal queue.

## 6. The first ticket

Either:

- **Label a Jira ticket `agentic`** (after `poll_enabled` is on). Within one poll interval (60 s) it
  becomes a task on **Dashboard → Autix → board**. Or
- **Start it by hand**: on the board, **Start a ticket**, type the key (`AUTIX-123`), **Start**. The
  answer is *"Started AUTIX-123 — its task appears on the board once intake has created it"*; the
  task's *Who did what* names you as the person who started it (WP-134).

Neither was run (both need a Jira site).

## 7. What a healthy first run looks like

The feature template runs **Refinement → Architecture → Implementation → CI gate → Code review →
Business review → Rebase gate → Ready for merge**, and then waits for **you** to merge on GitLab —
the platform never merges. After the merge it runs a retrospective and the librarian, and the task
is *Done*.

- **The board** shows the task under its state, with the stage beneath it and the measured cost so
  far.
- **The task page** (click the card) has the stage timeline, each stage's artifact (*Open* shows it),
  the runs, and the Checks panel.
- **A run page** (click a run) streams the transcript live: the first row is **system · init**, the
  CLI's own start-up message, then the agent's messages and tool calls. **Agents** in the top
  navigation shows it as active.
- **The Inbox** gets the plan approval after Architecture (Supervised, probation). Approve it as the
  admin; the task continues into Implementation.
- **GitLab** gets an `agentic/<ticket>` branch and a merge request from Implementation; **Jira** gets
  the workpad comment and the status moves. The merge request is opened by the Developer through the
  platform's `open_mr` tool (WP-138): from `agentic/<ticket>` into the project's **default branch**
  (Autix: `develop` — the project's `default_branch`, never a branch the agent names), as a
  **draft**, with *"Opened by the agentic platform for <ticket>."* at the end of its description
  (and *"Requested by <name>"* when the ticket's reporter maps to a platform user). When Implementation completes, the platform **marks it ready** (removes
  `Draft:`), and — when its head has no pipeline and the default branch has the project's CI file
  (GitLab's *CI/CD configuration file* setting, `.gitlab-ci.yml` unless the project set another, or
  a configuration in another project), or the platform cannot read whether it has one — asks
  GitLab for a merge-request pipeline (the API behind the merge request's *Run pipeline* button),
  because GitLab does not start one when a draft is marked ready. Read off GitLab's documentation,
  not measured on gitlab.com (docs/TODO.md).
- **Autix's CI rules are required** (§ 1): `agentic/` admitted where `feature|bugfix` is matched,
  and the test jobs run on merge-request pipelines — otherwise the merge request gets no pipeline
  and the CI gate waits for one until its timeout (the platform's branch namespace is fixed, Q114).
- **The runner's log** has a *"stage executed"* line per stage.

## 8. When something fails — where it is named

| What you see | Where it is named | What to do |
|---|---|---|
| `docker compose` stops with *"required variable CLAUDE_CODE_OAUTH_TOKEN is missing a value: set CLAUDE_CODE_OAUTH_TOKEN for local mode"* | the terminal (run, with the variable unset) | put the token in `.env` |
| `app` exits at start | `docker compose logs app` — *"invalid server configuration: …"* names the variable | fix it in `.env`, `docker compose up -d` |
| tasks stay at their first stage; nothing runs | `docker compose logs runner`: *"composed without an agent runner"* with the `missing` list; after five minutes `/readyz` says `agent_runs: degraded`, `details.agent_runs: unserved` | set the launcher pair and the token; `docker compose up -d` |
| an integration cannot be created | the form shows the server's refusal: `integration_host_not_permitted` or `secret_name_not_permitted` naming the setting, or `400 missing_secret` (the variable is not in the container) | add it to `.env`, **`docker compose up -d`** (not `restart`) |
| **Test connection** is red | the integration's card, with the provider's error (already redacted) | check the token, its scopes, `base_url` / `site_url` |
| a labelled ticket never appears | `docker compose logs app runner` (the poll runs as a job, in either worker); the Jira integration's card | is `poll_enabled` on; was the label added after it; is the key in `project_keys`; is the dial at Observe |
| a task goes straight to *Needs human* | the task page's **brief** — e.g. *"the default branch … is not protected"* | fix the cause, then **Hand back** at the stage the brief names |
| a run fails at its start because the clone could not check out the default branch, or a merge request targets the wrong branch | the run's error; the project's settings page, **Default branch**, which shows the stored branch beside GitLab's (not run: needs your repository) | change the default branch there — refused while a task is unfinished, so cancel or finish it first |
| a stage fails at start: *"cannot give run … a credential: minting is off … and no static run credential is configured"* | the task page's brief and the run's error | gitlab.com Free: `run_credential: static` with a `run_token` (§1, the setup guide's step 5a); Premium or self-managed: `mint_credentials` on. Then **Hand back** |
| a stage fails at start: *"… declares a static run credential this platform will not give run …"* | the task page's brief and the run's error — the reason is named: no run token, the API token in its place, `mint_credentials` also on, or *"expired on <date>"* | fix the named setting; for an expired one create a new token, re-seal `run_token`, set `run_token_expires_at`; then **Hand back** |
| **Test connection**'s `run_credential` check is red | the integration's card | *not a member* or *no project is bound*: add the dedicated user to the project, bind the integration, test again; *Maintainer*/*Owner*: lower the user to Developer |
| *(your own token, form B)* `run_credential` is red: *"this token can call the GitLab API …"* or *"did not accept the run token at all (401)"* | the integration's card | create a new token with **only** `read_repository` + `write_repository`, put it in `.env`, re-seal `run_token`; a 401 is a wrong, expired or revoked token |
| *(form B)* `default_branch_protection` is red, or a stage fails at start: *"… the default branch develop of … is not protected / lets Maintainers push / allows force push …"* | the integration's card; the task page's brief | **Settings → Repository → Protected branches**: `develop` with push **No one** and force push off; test again, then **Hand back** |
| saving the integration or binding it is refused: `run_credential_refused`, `static_run_credential_shared` | the form shows the server's refusal, naming the field | the field it names; a static integration may be bound by **one** project |
| a task parks with *"the merge request adds the static run token to the repository"* | the task page's brief | **rotate the run token**: revoke it in GitLab, create a new one, re-seal it, declare its expiry; remove it from the branch before anything else |
| a run fails with *"…the model API answered HTTP 401…"* | the run page's error (measured with a fake token, WP-133) | a wrong or expired token: replace it in `.env`, `docker compose up -d` |
| an agent cannot install a package or reach a host | the run's egress sidecar: `docker ps --filter label=com.agentic.run` lists `egress-<run id>` while the run lives, and `docker logs egress-<run id>` has *"Proxying refused on filtered domain …"* (not run here) | add a registry to `APP_RUN_REGISTRY_HOSTS`, or a model-side host to `APP_MODEL_EGRESS_HOSTS` |
| **the CI gate on a poll-only binding**: the task parks with *"The CI pipeline … was still running after 60 minutes — the CI timeout (`pipeline.limits.ci_timeout_minutes = 60`) …"* | the task page's brief | see below |
| something failed with no task to show it | **Settings → Dead letters** and **Settings → Failed jobs** (admin) | operator guide § 9 |

**The CI gate on a poll-only binding** (WP-136; the unit tier drives it on a test clock, not
measured on gitlab.com). A poll-only binding is told nothing when a pipeline finishes, so the gate
asks GitLab for the merge request's head pipeline itself: when it is entered, then every **30
seconds** for its first five checks, then **every minute**, until the **CI timeout** has passed since
the task entered the gate — `pipeline.limits.ci_timeout_minutes`, **60 minutes** by default (10–1440;
set it in `.agentic/config.yml` if Autix's pipelines routinely take longer). A pipeline that finishes
green inside the timeout passes the gate within a minute of finishing; one still running at the
timeout parks the task *Needs human* with a brief naming the pipeline, its status and the key — or
saying *no pipeline has started for the head commit*, and for a `manual` pipeline that it waits for
someone to start its manual job. When the pipeline has finished, **Hand back** at `ci_gate` from the
task page: that is a new entry with a fresh timeout. A **pause and resume** keeps the clock: a task resumed after its timeout is read once more and then parks; only a hand-back restarts it. (A binding with a webhook secret keeps the old
five checks 30 seconds apart, because the pipeline's own event settles it.) A
project with no CI at all passes the gate's pipeline half — but **only when the default branch has
no CI file** (WP-138): a head with no pipeline on a project that has one is a pipeline that has not
started, and the gate waits for it rather than passing. Which file is GitLab's answer (WP-139): the
project's *CI/CD configuration file* setting (`ci_config_path`) — `.gitlab-ci.yml` when it is empty,
`deploy/.gitlab-ci.yml` for GoParking — and a configuration in another project or at a URL counts as
present without being read. GitLab omits the setting for a token that may not read the code; the
gate then cannot tell and waits. The file's presence is read from the platform's own mirror
(`APP_KNOWLEDGE_MIRROR_ROOT`); a process that has none cannot tell, and waits too — on a poll-only
binding up to the same CI timeout.

The logs are JSON, one line per entry, with `task_id` and `run_id` where they apply:
`docker compose logs -f app runner launcher`.

## 9. Stopping, restarting and upgrading

```bash
docker compose stop      # not run as one command; each service's stop was run (runner, app, db: 0.2 s each, exit 0)
docker compose up -d     # run (as above); also how you apply an edited .env
docker compose down      # not run: removes the containers and keeps every volume
```

- **Stop with no agent run in progress** (Agents shows none). A `runner` stopped mid-run waits its
  own 30 s deadline and exits; the run is then ended `lease_expired` by the lease sweep after its
  lease lapses (five minutes) and the task waits for you *Needs human* (WP-133; nothing interrupts a
  run on shutdown in this build). The graces in `compose.yml` — 45 s for `app` and `runner`, 60 s
  for the `launcher`, 30 s for `db` — cost nothing when nothing is in flight; do not shorten them or
  stop a container with `docker kill` (WP-132, WP-133).
- **`.env` changes need `docker compose up -d`**, which recreates `app` and `runner`;
  `docker compose restart` keeps the old environment (measured, WP-132).
- **`docker compose down -v` deletes the database and every credential in it.** Use it only to
  start over, and then also `docker volume rm agentic-repo-cache` (the launcher creates that volume
  itself, so compose does not remove it).
- **Upgrading** is the operator guide's § 5, with the image builds from § 4 above in place of
  `docker compose build`:

```bash
git pull                                          # not run
docker compose exec -T db pg_dump -U app -Fc app > pre-upgrade-$(date +%F).dump   # not run
# the four build lines of § 4                     # run (cached), as above
docker compose stop app runner                    # run per service (by the check)
docker compose run --rm migrate                   # not run on this page; `up -d` ran the same migrate service
docker compose up -d                              # run
```

## 10. What is not built that you might expect

- **The platform never merges** ([BD-007](decisions/business/BD-007-human-merges.md)). A task ends
  at *Ready for merge* until you merge it on GitLab.
- **No TLS and no public URL** on a laptop: the instance is plain HTTP on `localhost`, which is why
  both integrations poll. Webhooks need a reachable `APP_BASE_URL` (operator guide § 4).
- **Polling does not carry everything**: Jira comments and the ticket linter's *created* event are
  webhook-only; GitLab approvals and finished pipelines are webhook-only (the CI gate above).
- **Chat**: without a Slack integration nothing is posted to chat; questions and approvals wait in
  the **Inbox** and on the task page.
- **Cost in `local` mode is an estimate at list price.** Every run's cost is labelled an estimate
  and priced from the platform's price table by its token usage (read off the code; operator guide
  § 8), so the board, the budgets and the caps count dollars your subscription does not bill per
  token. That is still a fair way to compare tasks and to stop a runaway one. No subscription run has
  been made from this build, so whether the CLI's model ids match the price table is not measured; a
  run whose model has no price row shows no cost.
- **No password change screen**, and no account management beyond the user list in **Settings**.
- **The business interview is a form**, not a conversation (Q102); **editing a knowledge page or the
  pipeline in the browser** is not built (user guide § 13).
- **Edits to a Jira ticket moved to another project** do not reach its task: they arrive under the
  new key, and the edit path still looks the task up by key (WP-134's discovered work).
- **Jira Data Center** is not supported; this is Jira Cloud only.
