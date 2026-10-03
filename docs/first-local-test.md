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
access token works for reads but **cannot mint**, and minting is what every stage that writes needs.

**Minting is not optional for a private repository.** Each agent run with a checkout gets its own
short-lived project access token, minted through the binding's token, revoked when the run ends.
Without `mint_credentials: true` on the integration, a stage that writes (implementation, conflict
resolution, the librarian) is refused at start naming the setting, and a read-only stage can only
fetch a repository GitLab serves without authentication.

| | gitlab.com | self-managed |
|---|---|---|
| Project access tokens (so `mint_credentials`) | **Premium or Ultimate only** — on Free, no stage can check out a private repository | every tier |
| `APP_INTEGRATION_HOSTS` entry | `gitlab.com` | your host exactly as in `base_url`, no scheme, no port |
| `base_url` | `https://gitlab.com` | `https://<your host>[/<path>]`, no `/api/v4`, no trailing slash, and not a URL that redirects |
| Token prefix | `glpat-` (default) | set `token_prefix` if an administrator changed it (Admin → Settings → General → Account and limit) |
| Reaching it from the containers | public internet | the launcher's helper containers clone it and the run's egress sidecar connects to it **from inside Docker Desktop's VM** — a host reachable only over a VPN, or with a certificate from a private CA, was **not tested** |
| A webhook into your Mac | cannot reach `localhost` | would need your Mac reachable from the GitLab server — **not tested**; use polling |

**Protect the default branch** — **Settings → Repository → Protected branches**, `main` (or your
default) with **Allowed to push and merge: No one**. The platform checks it before it starts a task:
a ticket on a project whose default branch is unprotected becomes a task that is immediately parked
*Needs human* with the brief *"the default branch … is not protected"*.

**Webhook or polling.** On a Mac, GitLab cannot reach `http://localhost:8080`, so use a
**poll-only** binding: set `poll_enabled: true` and `project`, and leave **both**
`webhook_secret_token` and `webhook_signing_token` empty. A GitLab binding with no webhook secret is
poll-only, and since WP-123 its polls read, besides the merge requests themselves (opened, updated,
merged, closed), the **default branch's head** (so a task at Ready is re-checked for conflicts when
`main` moves) and the **comments on merge requests waiting at Ready** (so a reviewer's comment
returns the task to Implementation). Setting a webhook secret for a webhook GitLab cannot reach turns
both reads off. What polling never sees: approvals and **finished pipelines** — which matters at the
CI gate (§ 8, *the CI gate on a poll-only binding*).

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
JIRA_API_TOKEN=<the Atlassian API token>
APP_INTEGRATION_SECRET_ENV=GITLAB_TOKEN,JIRA_API_TOKEN
APP_INTEGRATION_HOSTS=gitlab.com,<your-site>.atlassian.net
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
- **`GITLAB_TOKEN`, `JIRA_API_TOKEN`** are the provider credentials, and **`APP_INTEGRATION_SECRET_ENV`**
  is the allow-list of variable *names* the integration form may name. You never paste a token into
  the browser: the form names the variable and the server seals its value.
- **`APP_INTEGRATION_HOSTS`** is the allow-list of hosts an integration may call, empty and therefore
  closed by default. For a self-managed GitLab write its host instead of `gitlab.com`.

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

## 5. Sign in, connect, onboard

1. Open <http://localhost:8080/> and sign in with `APP_BOOTSTRAP_ADMIN_EMAIL` and its password
   (the stock check signed in as its bootstrap administrator: 200, run). You are an **admin**.
2. **Integrations → Add integration → GitLab** (not run: needs your token). Name it; `base_url`
   `https://gitlab.com` (or yours); `token` → the variable name **`GITLAB_TOKEN`**; and among the
   optional fields: `project` = `<group>/<autix-project>` (GitLab's path with namespace),
   `mint_credentials` = true, `poll_enabled` = true. Leave both webhook fields empty. Press **Test
   connection**: it calls `GET /version` and shows the version and edition.
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
     refused), then tick both integrations, **Test connection**, **Bind**.
   - **Step 2 — Technical discovery** is the **first real model run**: a Discovery agent reads the
     repository and runs its declared commands, and you get a readiness level and drafted knowledge
     pages as proposals. It spends your plan's usage. A ticket does not wait for it — nothing in
     intake reads readiness (read off the code) — so you may skip it for the first ticket and run it
     later from the project's settings page.
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
  the workpad comment and the status moves.
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
| a stage that writes fails at start naming `mint_credentials` | the task page's brief and the run's error | turn `mint_credentials` on (gitlab.com: Premium or Ultimate) |
| a run fails with *"…the model API answered HTTP 401…"* | the run page's error (measured with a fake token, WP-133) | a wrong or expired token: replace it in `.env`, `docker compose up -d` |
| an agent cannot install a package or reach a host | the run's egress sidecar: `docker ps --filter label=com.agentic.run` lists `egress-<run id>` while the run lives, and `docker logs egress-<run id>` has *"Proxying refused on filtered domain …"* (not run here) | add a registry to `APP_RUN_REGISTRY_HOSTS`, or a model-side host to `APP_MODEL_EGRESS_HOSTS` |
| **the CI gate on a poll-only binding**: the task parks with *"the "ci_gate" gate could not be decided after 5 attempts …"* | the task page's brief | see below |
| something failed with no task to show it | **Settings → Dead letters** and **Settings → Failed jobs** (admin) | operator guide § 9 |

**The CI gate on a poll-only binding** (read off the code, not measured — WP-135's discovered work).
The gate asks GitLab for the merge request's head pipeline when it is entered and then every
**30 seconds, five times in all**; a webhook's *pipeline finished* event normally settles it, and a
poll-only binding receives none. So a CI pipeline that takes longer than **about two minutes** parks
the task *Needs human* at the CI gate even when it later goes green. When the pipeline has finished,
**Hand back** at `ci_gate` from the task page: the gate is read again (with five fresh checks). A
project with no CI at all passes the gate's pipeline half.

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
