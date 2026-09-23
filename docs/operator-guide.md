# Operator guide

> How to install, run, upgrade and back up a self-hosted instance. Everything here was run against
> this repository; where something has not been measured it says so. The companion is the
> [user guide](user-guide.md), which is about the product rather than the deployment.
>
> Decisions behind it: [BD-020](decisions/business/BD-020-docker-12-factor-deployment.md) (a single
> `docker compose` starts a complete instance), [TD-018](decisions/technical/TD-018-docker-images-and-compose.md)
> (the five images), [TD-021](decisions/technical/TD-021-workspace-isolation.md) (which container
> holds the Docker socket), [TD-023](decisions/technical/TD-023-config-logging-metrics-otel.md)
> (health probes), [TD-020](decisions/technical/TD-020-configuration-and-env-naming.md) (variable
> naming and `_FILE` secrets). The full variable reference is `.env.example`; it is the source, and
> this guide names only the ones an install needs.

## 1. What you are installing

Seven containers, from `compose.yml`:

| Service | What it is | Notes |
|---|---|---|
| `db` | PostgreSQL 18 | the only stateful service; volume `db-data` |
| `migrate` | one-shot schema migration | runs to completion before `app` starts |
| `app` | the API, the SSE stream, the webhook endpoint **and the browser application** | publishes `${APP_PORT:-8080}` |
| `runner` | the worker that **runs agent stages** | same image as `app`; no published port |
| `docker-socket-proxy` | a filtered Docker API | the **only** container with the socket |
| `launcher` | creates a container per agent run | reaches the daemon only through the proxy |
| `db-backup` | scheduled `pg_dump` | profile `backup`, off unless asked for |

Two more images exist that no service starts — `platform-runtime` (the container an agent run
happens in) and `platform-egress` (its outbound proxy). The launcher creates them per run.

### The runner, and why it is a container of its own

`runner` is the same image and the same code as `app`; what makes it the runner is one mount and two
variables. It carries the control volume TD-025 gives the runner a static mount of, and
`APP_LAUNCHER_URL` + `APP_LAUNCHER_TOKEN`, which point it at the launcher's control plane on an
`internal: true` network with no published port. Only `runner` and `launcher` join that network, and
`runner` has **no** route to the Docker proxy.

**A process runs agent stages only when it has both variables**, never because of its `ROLE`
([TD-028](decisions/technical/TD-028-launcher-control-plane.md) decision 5). pg-boss hands a job to
any subscribed worker, so gating on a role name would give half a split deployment's agent stages to
a process that composes no runner and fail each of them. `app` is therefore pinned to *no* launcher
even when `.env` carries the token.

**Set both lines or the instance runs no agent**, in `.env`:

```bash
APP_LAUNCHER_URL=http://launcher:7780          # must match APP_LAUNCHER_PORT
APP_LAUNCHER_TOKEN=$(openssl rand -hex 32)     # at least 32 characters
```

Exactly one of the two is a **startup refusal naming the other**, which is why compose pins neither
on the service: a pinned URL beside an empty token would put a stock instance in the very state the
refusal exists for. The token is instance configuration rather than a credential the platform mints,
both halves refuse anything shorter than 32 characters, and the launcher with no token exposes **no
control plane at all** rather than an unauthenticated one. It is compared in constant time on every
request in addition to the network isolation, because a control plane that is safe only because of a
compose file is safe until somebody writes a different compose file — and this one creates
containers.

**A compose instance without a configured runner runs everything except agent stages *and the
platform gates*.** That is the honest consequence of the rule above
([TD-028](decisions/technical/TD-028-launcher-control-plane.md), amended 2026-09-23) and it is worth
knowing before you meet it. The `stage.execute` jobs are still enqueued and simply **queue** rather
than failing, so nothing is lost and the queue depth is what shows it.

Gate evaluation — `ci_gate`, `rebase_gate`, `merged_gate` — is a *branch of the same handler on the
same queue*, so it stops with them. It is not given a queue of its own because `stage.execute` is
`stately` with one job per task, which is what stops a task running two stages at once; a second
queue would let a gate and a stage for one task run concurrently. Every shipped template puts the
gates *behind* agent stages, so no task reaches one by the pipeline's own motion on such an
instance; the reachable paths are **human** — a hand-back to a gate stage, a `merged_gate` after you
merge by hand, and a gate already waiting when the runner stopped. The jobs are durable and are
taken when a runner starts, bounded by pg-boss's 14-day default retention.

Everything else — intake, the board, the knowledge index, every outbound provider call, the cost
ledger, the audit — runs in `app`.

### Requirements

- Docker Engine with the `docker compose` plugin. Measured here on Docker **29.7.2**
  (`linux/arm64`, Docker Desktop on macOS) with Compose **v5.5.1**; CI builds the same images on
  `ubuntu-latest` and `ubuntu-24.04-arm`.
- Room in the Docker VM for the images. Measured unpacked at WP-22: base 547 MB, runtime 1.32 GB,
  egress 13.2 MB, product 1.1 GB, launcher 966 MB — about **4 GB** once the shared base layer is
  counted once, plus whatever the database grows to.
- Outbound network access at build time (the images fetch Node, the CLIs and the npm packages).
- Nothing else: no Node, no pnpm, no PostgreSQL on the host.

## 2. Install

```bash
git clone https://github.com/gtfo-ai/platform.git agentic
cd agentic
cp .env.example .env
```

Generate the secret key first — **paste the value, never the command**:

```bash
openssl rand -base64 48
```

A `.env` file is read literally: **nothing in it is a shell**. `APP_SECRET_KEY=$(openssl rand
-base64 48)` written into it is not a generated key — compose passes the *string*
`$(openssl rand -base64 48)`, verbatim, and `docker compose config` shows it. That particular string
is 26 characters, so the app refuses to start with a message that reads oddly given what you typed:

```
invalid server configuration: APP_SECRET_KEY must be at least 32 characters
(generate one with `openssl rand -base64 48`); there is no default
```

The refusal is luck, not a guard: the same mistake with a longer command —
`$(head -c 48 /dev/urandom | base64)`, 35 characters — is **accepted**, and the instance then signs
sessions and encrypts every integration credential with a string anybody can guess. Both measured
against `loadServerConfig`. Paste the value.

Now edit `.env`. **Four values** decide whether the instance starts and whether you can sign in:

```ini
# Session signing and encryption of integration secrets at rest. No default, ever.
# At least 32 characters — the output of the command above:
APP_SECRET_KEY=paste-the-generated-value-here

# The first administrator, created at boot while the instance has no users at all.
APP_BOOTSTRAP_ADMIN_EMAIL=you@example.com
APP_BOOTSTRAP_ADMIN_PASSWORD=       # at least 12 characters; change it after first sign-in

# The origin this instance is reached on. It is what webhook URLs are built from,
# so it has to be the URL a provider can actually POST to.
APP_BASE_URL=http://localhost:8080
```

`APP_SECRET_KEY` has no default and never will: a development default is a real secret in a public
repository the day somebody ships with it ([BD-002](decisions/business/BD-002-open-source-build-in-public.md)).
Keep it — **it encrypts the integration credentials in the database, so losing it means re-entering
every credential.** Every secret also accepts a `<NAME>_FILE` variant holding a path, which is what
to use with Docker secrets; the `_FILE` variant wins.

### `.env` is the app container's environment

`compose.yml` gives the `app` and `migrate` services `env_file: .env`, so **every line of `.env`
reaches the process** — the provider credentials, `APP_INTEGRATION_SECRET_ENV`,
`APP_INTEGRATION_HOSTS`, `APP_TRUST_PROXY`, `APP_METRICS_*`, the `APP_SSE_*` and `APP_DB_*` knobs,
and every `<NAME>_FILE` variant. The two `APP_INTEGRATION_*` lists are **empty in `.env.example` and
empty means closed**: leave them and §4's first integration is refused, by name. §4 says what to put
in each. Five values
stay on the service because compose computes them or the topology depends on them, and
`environment:` wins over `env_file:`, so setting any of these five in `.env` does nothing:

| Pinned | Why |
|---|---|
| `DATABASE_URL` | built from `POSTGRES_USER`/`PASSWORD`/`DB` and the `db` service's name |
| `HOST`, `PORT` | the container always listens on `0.0.0.0:8080`; the host-side knob is `APP_PORT` |
| `APP_KNOWLEDGE_MIRROR_ROOT`, `APP_WORKSPACE_EXPORT_DIR` | paths inside the container, on its volumes |

> **Earlier releases needed a `compose.override.yml`.** Until WP-50 the service carried a
> hand-written list of eighteen variables and everything else in `.env` was simply not there —
> it sat in compose's own environment, where it interpolates `${…}` in the file and stops. If you
> wrote the four-line override this guide used to teach, it is now redundant; it still works
> (`env_file` lists merge), and deleting it changes nothing.

Three consequences worth knowing:

- **`APP_VERSION`, `APP_COMMIT` and `APP_BUILT_AT` are commented out in `.env.example` on purpose.**
  The image bakes them, and an empty value in `.env` would override the image's — making a released
  build report `0.0.0-dev` at `GET /api/version`.
- **A missing `APP_SECRET_KEY` is now refused by the app, not by compose.** `docker compose up`
  starts, the container exits, and `docker compose logs app` says
  `invalid server configuration: APP_SECRET_KEY must be at least 32 characters …`. That is the
  trade for making `APP_SECRET_KEY_FILE` usable at all: compose's old `${APP_SECRET_KEY:?…}` failed
  on unset *or empty*, so an instance that kept its key in a file — which is what Docker secrets
  means — could not start.
- **The `launcher` container does not get `.env`**, and that is deliberate: it is the only container
  with a route to the Docker daemon, and it reads a short, fixed list (`DOCKER_HOST`, `LOG_LEVEL`,
  `APP_WORKSPACE_*`). Everything it needs is written on the service.

Then:

```bash
docker compose up -d --build
```

The first build takes a while (it compiles nothing, but it downloads a Node image, six CLIs and the
npm dependencies). Subsequent starts are seconds.

> **Why `--build`.** `compose.yml` names the images as `platform:${PLATFORM_TAG:-dev}` — with no
> registry — so `docker compose up` without `--build` looks for `platform` on Docker Hub and fails.
> To run the images published by CI instead, pull and retag them first:
>
> ```bash
> export PLATFORM_TAG=edge   # or a release: 1.2.3
> for image in platform platform-launcher platform-runtime platform-egress; do
>   docker pull "ghcr.io/gtfo-ai/${image}:${PLATFORM_TAG}"
>   docker tag "ghcr.io/gtfo-ai/${image}:${PLATFORM_TAG}" "${image}:${PLATFORM_TAG}"
> done
> docker compose up -d --no-build
> ```
>
> The published manifests carry a provenance attestation, and it needs no account to check:
> `gh attestation verify oci://ghcr.io/gtfo-ai/platform:edge --repo gtfo-ai/platform`. There is **no SBOM
> attestation** — BuildKit can only produce one for an image it pushes itself, and these are pushed
> by `docker push` after a plain build.

### Check that it came up

```bash
docker compose ps                       # db healthy, migrate exited 0, app/launcher running
curl -fsS localhost:8080/healthz        # {"status":"ok",...}
curl -fsS localhost:8080/readyz         # {"status":"ok","checks":{...}}
```

Then open <http://localhost:8080/> and sign in with the bootstrap administrator. The
[user guide](user-guide.md) starts there.

### If `/readyz` is 503

That is a real answer, not a glitch, and the body says which check failed:

```json
{"status":"down","checks":{"database":"ok","migrations":"down","queue":"ok","dispatch":"ok"}}
```

| Check | `down` means | What to do |
|---|---|---|
| `database` | the connection or the `platform_migrations` query failed | look at `docker compose logs db` |
| `migrations` | the schema is **behind** this build (migrate has not run) **or ahead of it** (you rolled the image back) | run `docker compose run --rm migrate`; for "ahead", roll the image forward again — migrations are forward-only and an older build must not serve a newer schema |
| `queue` | pg-boss did not start | the logs name the failure |
| `dispatch` | this process cannot handle every event the build declares consumed, so it refuses to sweep the outbox | see below |

**`dispatch` is the one to know about.** `/readyz` is 503 on `ROLE=all` and `ROLE=worker` for as
long as the process cannot compose a pipeline — it is honest rather than broken, and it is the same
condition under which the outbox sweep deliberately does not start
([TD-023](decisions/technical/TD-023-config-logging-metrics-otel.md)'s amendment). A stock instance
today **does** compose one, so the check passes; if you set `ROLE` to something else, `api`, `runner`
and `indexer` omit the check entirely rather than report it `ok`.

Two consequences for whatever sits in front of the instance:

- **`/healthz` is the liveness probe.** It never touches the database, so a database blip cannot turn
  into a restart loop. Use it for `restart` policies and for an orchestrator's liveness check.
- **Do not point a reverse proxy's or a load balancer's upstream health check at `/readyz`**, and do
  not give a compose service a `depends_on: service_healthy` condition against it. `ROLE=all` is the
  single-process default and serves the browser application as well as the workers, so a 503 there
  pulls the whole instance out of rotation. `compose.yml` deliberately gates nothing on it.

## 3. What the `app` container serves

One origin, which is the point — the API client and the SSE client both assume it:

| Path | What |
|---|---|
| `/` and every client route (`/projects/…`, `/runs/…`, `/inbox`, …) | the browser application's shell |
| `/assets/*` | its hashed, immutable assets |
| `/api/*` | the authenticated API |
| `/events` | the SSE stream |
| `/webhooks/:provider/:integration_id` | the **only unauthenticated** endpoint; the credential is the signature over the body |
| `/healthz`, `/readyz`, `/metrics`, `/api/version` | the operational surface, served by every `ROLE` |

Every response that carries part of the browser application also carries, and **a reverse proxy in
front must not strip, rewrite or duplicate them**:

```
content-security-policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self';
                         font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self';
                         form-action 'self'; frame-ancestors 'none'
x-frame-options: DENY
x-content-type-options: nosniff
vary: accept-encoding
```

The policy is a measurement of this exact bundle, not a template: it allows no inline script and no
inline style because the bundle has neither. A proxy that injects its own analytics snippet, or a
second CSP header, will break the application in the browser rather than degrade quietly — that is
the intended direction. `frame-ancestors 'none'` and `x-frame-options: DENY` say the same thing to
two generations of browser; keep both.

The app compresses the bundle itself (gzip, and Brotli when the client asks) and sends
`vary: accept-encoding`. If your proxy also compresses, turn one of them off; a doubly-encoded body
is the failure you get for leaving both on.

`APP_METRICS_USERNAME` / `APP_METRICS_PASSWORD` put HTTP basic auth on `/metrics`. They are empty in
`.env.example`, which means **`/metrics` is open** — set them, or keep the port off the public
network.

`APP_TRUST_PROXY=true` is what makes the app believe `X-Forwarded-For` and `X-Forwarded-Proto`. Set
it **only** when a proxy you control terminates TLS in front; with it on and the app reachable
directly, a client can forge its own address.

Both of those are among the variables `compose.yml` does not pass through, so they need the override
from §2 to have any effect at all.

## 4. Integrations

An integration is created once for the organisation (a credential and a host), and then **bound** to
each project that uses it. Nothing here is edited on disk: the wizard in the browser does it, and
the [user guide](user-guide.md) walks through it. What the operator owns is the credential.

**A credential never crosses the API.** `POST /api/integrations` takes, for each secret field, the
*name of an environment variable* that the server reads and seals itself
([TD-020](decisions/technical/TD-020-configuration-and-env-naming.md),
[BD-002](decisions/business/BD-002-open-source-build-in-public.md)). So the flow is:

1. put the credential in the `app` container's environment — a line in `.env`, or a `_FILE` secret
   (`.env` **is** that environment, §2);
2. add that variable's **name** to `APP_INTEGRATION_SECRET_ENV`, a comma-separated allow-list that is
   **empty by default**;
3. create the integration, naming the variable;
4. restart `app` whenever you add a credential or change the allow-list — both are read at start-up.

The allow-list is not ceremony: without it a caller could name `APP_SECRET_KEY` and have the server
seal and store its own master key. A name that is not on the list is refused by name:
`secret_name_not_permitted … Add it to APP_INTEGRATION_SECRET_ENV (declared: none) and restart the
process`.

**And declare the hosts, or nothing will work.** `APP_INTEGRATION_HOSTS` is the second half of the
same idea and is **also empty by default**: the admin who names a credential *field* never sees the
credential's *value*, so without this list they can point a provider at a host they control and have
the platform deliver the token there — and the audit records that as a successful provider call.
With the list empty, `POST /api/integrations` refuses every host and **no provider call leaves the
process**:

```
integration_host_not_permitted: this deployment does not permit calling "gitlab.example.com".
Add it to APP_INTEGRATION_HOSTS (declared: none) and restart the process
```

**What to put in it: the host of every integration you create, exactly as it appears in that
integration's `base_url` (or Jira's `site_url`), with no scheme, no port and no path.** Hosted
Sentry is `sentry.io`, GitLab.com is `gitlab.com`, a Jira site is `<your-site>.atlassian.net`, and a
self-managed instance is whatever host you type into the form. Matching is exact and
case-insensitive, on the **host** only: no wildcard below a name — `gitlab.example.com` does not
admit `api.gitlab.example.com`, and a Loki on `https://loki.example.test:3100` is declared as
`loki.example.test`. Write an internationalised host
in punycode. A single `*` declares the list open, which is a thing to type on purpose. What the list
does *not* check is where a declared host resolves: it is an allow-list of names, not of addresses.

**Upgrading an instance that already has integrations**: add this variable before you restart, or
every provider call — including the pipeline's — is refused until you do. The refusal names the host,
so the log line tells you what to declare.

```ini
# .env
GITLAB_TOKEN=glpat-…                      # the tool-native name the CLI would use
APP_INTEGRATION_SECRET_ENV=GITLAB_TOKEN,JIRA_API_TOKEN,JIRA_WEBHOOK_SECRET
APP_INTEGRATION_HOSTS=gitlab.com,acme-example.atlassian.net
```

```bash
docker compose up -d app                  # picks up both
```

### Creating one: the Integrations screen, or the API

**Since WP-30 the browser can do this.** The Integrations screen has an "Add integration" form and a
"Test connection" button on every card; the form asks for the provider, a name, the credential
*field* and the **name of the environment variable** the server should read it from — never the
value. A provider this build does not ship is refused by name, and the refusal lists the ones that
do. (Until that release, no screen called `POST /api/integrations` at all, which is the defect
PROGRESS backlog 55 records.)

The API is still there, and it is what a script uses:

```bash
BASE=http://localhost:8080

# 1. sign in, keeping the session cookie
curl -sS -c cookies.txt -X POST "$BASE/api/auth/sign-in/email" \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"…"}'

# 2. create it. `secret_refs` maps a provider's credential *field* to the **name** of the
#    environment variable the server should read — never to a value.
curl -sS -b cookies.txt -X POST "$BASE/api/integrations" \
  -H 'content-type: application/json' \
  -H "Origin: $BASE" \
  -H 'x-requested-with: XMLHttpRequest' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"type":"git","provider":"gitlab","name":"GitLab",
       "config":{"host":"https://gitlab.example.com"},
       "secret_refs":{"token":"GITLAB_TOKEN"}}'
# → 201 {"id":"…","provider":"gitlab","name":"GitLab"}
```

The two extra headers are not optional and the API says so if you omit them: every mutating request
needs a trusted `Origin` **and** `x-requested-with`, which is the cross-site guard. `Idempotency-Key`
is required on the three commands that *create* something, so a retry is not a second integration.

Then bind it to a project — in the wizard's step 1, or on the project's own settings page
(`/projects/<key>/settings`), which mirrors every wizard step (product/18).

### The five providers that ship

Each has its own setup guide, written for the provider's own screens — scopes, tokens, webhook
configuration, and what the platform does and does not do with each. They are served in the product
at **Integrations → the provider → Setup guide**, and they are the same files here:

| Provider | Type | Inbound webhook | Guide |
|---|---|---|---|
| GitLab | git hosting | yes | [`packages/integrations/src/providers/gitlab/setup-guide.md`](../packages/integrations/src/providers/gitlab/setup-guide.md) |
| Jira Cloud | task management | yes | [`packages/integrations/src/providers/jira-cloud/setup-guide.md`](../packages/integrations/src/providers/jira-cloud/setup-guide.md) |
| Slack | chat | yes | [`packages/integrations/src/providers/slack/setup-guide.md`](../packages/integrations/src/providers/slack/setup-guide.md) |
| Sentry | error tracking | no | [`packages/integrations/src/providers/sentry/setup-guide.md`](../packages/integrations/src/providers/sentry/setup-guide.md) |
| Loki | logs | no | [`packages/integrations/src/providers/loki/setup-guide.md`](../packages/integrations/src/providers/loki/setup-guide.md) |

This guide does not repeat them.

### The webhook URL

For a provider with an inbound half, the integrations screen publishes the URL to paste into the
provider. It is built from `APP_BASE_URL`:

```
<APP_BASE_URL>/webhooks/<provider>/<integration_id>
# e.g. https://agentic.example.com/webhooks/gitlab/0193c0de-...-...
```

Two things it does **not** claim. It is not a promise that this instance is reachable from the
provider — that is `APP_BASE_URL`'s business and yours. And it is published only for a provider that
has an inbound half in this build: Sentry and Loki get none, because pointing a Sentry webhook here
would deliver to something that consumes nothing.

`/webhooks/*` is the one unauthenticated endpoint in the product. The credential is the signature
over the request body, so the body reaches the handler unparsed, and an unverified delivery is
refused and **stored nowhere** — a dedup key an unauthenticated caller can choose is a key it can
poison. A verified delivery is stored with its headers and payload **redacted** (GitLab's legacy
scheme sends the binding's own webhook secret in `X-Gitlab-Token`).

## 5. Upgrade

Migrations are **forward-only** and applied under a PostgreSQL advisory lock, so the order is always
the same: stop serving on the old code, migrate, start the new code.

**Which image to upgrade to.** This project ships continuously
([TD-019](decisions/technical/TD-019-release-engineering.md)'s amendment of 2026-09-16): every push
to `main` is reviewed, verified and published to GHCR on `amd64` and `arm64` as `sha-<7>`, `edge`
and `latest`. So **pull `latest`, or pin a `sha-<7>` tag** — `latest` is the newest push to `main`
and `sha-<7>` is one exact commit, which is what to pin when you want the upgrade to be a decision
rather than a schedule. There are no version tags yet: semantic versions are deferred to a later
piece of work, and nothing published today carries one.

```bash
cd agentic
git pull                                  # or: export PLATFORM_TAG=latest (or sha-<7>) and pull the images
docker compose build                      # skip when you pulled published images
docker compose run --rm migrate           # forward-only, advisory-locked, idempotent
docker compose up -d                      # recreates app and launcher on the new image
curl -fsS localhost:8080/readyz
```

`docker compose up -d --build` does the same thing in one step: `app` waits for the `migrate`
service to exit 0 (`condition: service_completed_successfully`).

**Take a dump first.** A migration is forward-only, so there is no down-step to run if one goes
wrong:

```bash
docker compose exec -T db pg_dump -U app -Fc app > pre-upgrade-$(date +%F).dump
```

### What a failed migration looks like

The `migrate` service writes one JSON object per line and exits non-zero:

```json
{"level":"error","msg":"invalid database configuration","error":"Error: invalid database configuration: DATABASE_URL is required (or set DATABASE_URL_FILE to a file holding it)"}
{"level":"error","msg":"migration failed","error":"getaddrinfo ENOTFOUND nosuchhost"}
```

The two lines are the two exit statuses, and they need different actions. Exit **2** —
`invalid database configuration` — means the configuration did not parse and **nothing was
attempted**. Exit **1** — `migration failed` — means it got as far as the database; the message is the
driver's or PostgreSQL's own. Each migration is applied in its own transaction, so the failed one left
nothing behind and everything before it is applied and recorded.

`app` will not start either way (compose holds it on `service_completed_successfully`), and if you
start it anyway `/readyz` reports `migrations: down`. Fix the cause and re-run
`docker compose run --rm migrate`. Re-running is safe — an applied migration is recorded and skipped,
which a healthy re-run says out loud:

```json
{"level":"info","msg":"migrations complete","applied":[],"already_applied":19,"pgboss_schema_version":40,"duration_ms":60}
```

**Rolling back the image without rolling back the database is the one thing that is not supported.**
The older build **refuses to start**: it sees migrations it does not know, writes one line to stderr
naming them, and exits — so there is no `/readyz` to read here, because the container is not up.
`docker compose ps` shows `app` as `Exited (1)` and `docker compose logs app` ends with the line
below — one line, wrapped here, naming whichever migrations the newer build had added:

```
this build does not know 1 migration(s) the database has applied: 0035_the_newer_build_added_this.
The database is newer than the code (TD-019): roll forward to the build that applied them, or
restore the pre-upgrade dump — migrations are forward-only and serving traffic against a schema this
build has never seen is how a rollback corrupts data (docs/operator-guide.md § 5).
```

That refusal is deliberate, and it is the whole recovery procedure. Two ways out, and only two:

- **Roll the image forward** to the build that applied the migrations it names — set `PLATFORM_TAG`
  back to that version and `docker compose up -d`. Nothing is lost; the rollback simply did not
  happen.
- **Restore the dump you took before the upgrade** (§ 6 has the `pg_restore` line), which takes the
  database back to a schema the older image knows. Everything written since that dump is gone, which
  is why the dump is taken *before* the upgrade and not after the trouble starts.

## 6. Backup

The database is the only thing that must be backed up. Everything else in the instance is either a
cache, a live credential, or already somewhere else.

### Scheduled dumps

`db-backup` is behind a compose **profile**, so it does not run unless you ask for it:

```bash
docker compose --profile backup up -d db-backup
```

It writes a compressed dump to the `backups` volume on `BACKUP_SCHEDULE` (`@daily` by default) and
keeps `BACKUP_KEEP_DAYS` / `_WEEKS` / `_MONTHS` generations. **Its PostgreSQL major must equal
`db`'s** — `pg_dump` refuses a server newer than itself, and a backup service that cannot back up
fails the same way every night into a log nobody reads. Both pins are in `compose.yml` and a test
refuses a bump that moves one without the other.

Copy the dumps off the host; a volume on the same machine is not a backup:

```bash
docker compose cp db-backup:/backups ./backups
```

### Restore

```bash
docker compose stop app launcher
docker compose exec -T db pg_restore -U app -d app --clean --if-exists < backup.dump
docker compose start app launcher
```

### What is deliberately **not** backed up

| Volume | What is in it | Why not |
|---|---|---|
| `knowledge` | one bare git mirror per project (`APP_KNOWLEDGE_MIRROR_ROOT`, TD-026) | a **cache** of the project's git repository; the platform re-clones it. The knowledge base itself lives in the project's repository — that is the whole of [BD-012](decisions/business/BD-012-knowledge-in-repo.md) |
| `agentic-ctl` | one directory per live run, holding that run's control socket and token | **live credentials** with the lifetime of a run. Backing them up copies secrets out of their scope, and restoring them restores nothing: the runs are gone |
| `exports` | take-over export tarballs | the **user's** artefacts, downloaded when they are made. The branch is on the git host either way |
| `agentic-repo-cache` | the launcher's per-project bare mirrors | a cache, re-created on the next run |

And one thing to know at teardown time: `docker compose down -v` removes every volume compose
declares, `agentic-ctl` included (measured on a full instance: containers, volumes and networks all
gone). It does **not** remove `agentic-repo-cache`, because compose never declares it — the launcher
creates it itself (`#ensureVolume`), since it only ever mounts it into helper containers. That volume
appears the first time a run happens, so finish a teardown with
`docker volume rm agentic-repo-cache` and ignore a "no such volume" on an instance that never ran
one.

## 7. Security posture

The honest version, in one place.

**The Docker socket is in exactly one container, and it is not the platform's.**
`docker-socket-proxy` is the only service with `/var/run/docker.sock` bound, read-only. It exposes a
filtered Engine API (`CONTAINERS`, `NETWORKS`, `VOLUMES`, `IMAGES`, `INFO`, `POST` on; `EXEC`,
`BUILD`, `SECRETS`, `SWARM` and the rest off) on an `internal: true` network that **only** `launcher`
joins. The `app` container — which serves the API, the SSE stream and the unauthenticated webhook
endpoint — has no socket, no `DOCKER_HOST` and no route to the proxy. That arrangement is what bounds
the blast radius of a remote code execution in the API process, and it is enforced in the code too: a
test refuses any Docker client constructed outside `apps/launcher`
([TD-021](decisions/technical/TD-021-workspace-isolation.md)'s amendment).

What `EXEC: 0` does and does not buy, measured: with `CONTAINERS` and `POST` on, the proxy still
admits `POST /containers/<id>/exec` (201 — an exec instance is *created*) while
`POST /exec/<id>/start` and `GET /exec/<id>/json` are 403. A compromised launcher can create an exec
it can never run or read.

**Everything runs as uid 1000.** `platform-base` and the three images built on it (`platform`,
`platform-launcher`, `platform-runtime`) declare `USER agentic`, uid **1000** — the upstream Node
image's own uid, renamed rather than replaced so the *number* stays single-valued.
`platform-egress` deliberately declares **no** `USER`: it has an `agentic` account at uid 1000 and
the uid is stated where the container is created, so an image that would otherwise start as
nobody-in-particular cannot look configured. A run container gets uid 1000, `cap-drop ALL`,
`no-new-privileges`, a read-only root filesystem, a `/tmp` tmpfs and memory/CPU/pid limits; the
egress sidecar gets uid 1000 and `cap_drop: ALL`.

**A run has no route to the network except through its own proxy.** The run container sits on a
per-run `internal: true` network; the egress sidecar is the only container bridging that to anything,
and it allows only the hosts the project's configuration lists.

**No integration credential is inside a run container.** The SDK runs on the platform side and spawns
the CLI in the container over a per-run control socket; git gets a run-scoped token from a credential
helper that asks back across that socket. Integration secrets are encrypted at rest with AES-256-GCM
under `APP_SECRET_KEY`, and the read API strips every provider-declared credential field from what it
publishes.

**All external text is untrusted.** Ticket bodies, merge-request comments, model output, log lines
and knowledge documents are rendered as text — the browser application has no
markdown-to-HTML step at all — and are put into a prompt only inside a delimited data block with a
per-prompt random nonce ([BD-022](decisions/business/BD-022-external-text-is-untrusted.md)).

**What is not done**, so you can decide whether it matters to you:

- The platform terminates plain HTTP. **TLS is yours** — put a reverse proxy in front, and read §3
  before you configure it.
- `/metrics` is unauthenticated unless you set the two variables in §3.
- Open registration is off (`APP_ALLOW_SIGNUP=false`) and should stay off on anything reachable from
  the internet; administrators make accounts.
- The redistribution terms of two bundled binaries — the `claude` executable and Atlassian's `acli` —
  are **unverified**. See [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md), which states it
  rather than assuming it, and gives the build argument that replaces `acli` with your own copy.

## 8. Provider mode: `api` or `local`

[BD-004](decisions/business/BD-004-claude-only-provider-modes.md) gives two ways to pay for the
model. The default is `api`: set `ANTHROPIC_API_KEY` in `.env`. The alternative is a Claude Code
subscription, and it is an **override file, not a profile**:

```bash
docker compose -f compose.yml -f compose.local.yml up -d
```

with `CLAUDE_CODE_OAUTH_TOKEN` set. The override changes the `app` **and `runner`** services that
already exist; `COMPOSE_PROFILES=local` would start a *second* app on the same port, because a
compose service without `profiles` always runs. Local mode changes only which credential the platform
authenticates with — it does **not** mount your Claude binary or config into a run, because a run
container is given no host mount at all.

Both modes run the **same** pinned `claude` binary, inside the per-run `platform-runtime` container;
what differs is the credential the run's environment carries. Measured against that image at WP-53:
with no credential the CLI answers *"Not logged in · Please run /login"*, and with
`CLAUDE_CODE_OAUTH_TOKEN` set it authenticates with it (a bogus one answers *"401 OAuth access token
is invalid"*, which is a different message from a bogus `ANTHROPIC_API_KEY`). A process in `local`
mode without the token composes no agent runner and names the missing credential in its start-up log
— which is the same shape every other absent collaborator gets, rather than a start-up failure that
would also stop the API.

## 9. Day-to-day

```bash
docker compose logs -f app                 # structured JSON; LOG_FORMAT=pretty for a terminal
docker compose ps
docker compose restart app
docker compose down                        # stop, keep the data
docker compose down -v                     # …and delete it; then: docker volume rm agentic-repo-cache
```

`LOG_LEVEL` (`trace`…`silent`) and `LOG_FORMAT` (`json`, `pretty`) are read at start-up. Logs carry
`request_id`, `task_id`, `run_id` and `trace_id` where they apply. Set
`OTEL_EXPORTER_OTLP_ENDPOINT` to export traces and metrics, and `SENTRY_DSN` to report errors; both
are off when unset.

## 10. Known limits of this build

Stated here so an operator meets them in a document rather than in production:

- **An agent run needs `APP_LAUNCHER_TOKEN`, and without it nothing runs one.** WP-53 built the
  transport (§1, "the runner"), so a stock instance *with* a token in `.env` runs agent stages in the
  `runner` container; one without a token queues them. What is still missing is the **git write
  credential**: the launcher has no git provider wired to it, so a read-only stage runs end to end
  and a stage that needs to push fails at start with that refusal by name. Everything else — intake,
  the board, the knowledge base, the commands, the cost ledger, the audit — runs either way.
- **`docker compose up` cannot pull the published images** without the retagging step in §2, because
  `compose.yml` names them without a registry.
- **`compose.yml` passes the `app` service a fixed list of variables**, so `.env` is not the app's
  environment until you add the override in §2. Every credential and every optional feature switch is
  behind that.
- **Creating an integration from a screen landed with WP-30** (§4): the wizard's integrations step and
  the project settings page both carry the create and test buttons over the endpoints §4 documents.
- **No SBOM attestation** is published (§2).
- **The business-interview step of onboarding is not built** (see the user guide).
- Every endpoint the browser application calls is served (the census in
  `apps/server/src/routes/client-census.test.ts` holds it, admitted gaps empty since WP-27, which added
  steer, take-over and hand-back). A steer reaches only a run held by the process that serves the API;
  in a split deployment it answers `409 run_not_reachable` and take-over exports nothing.
- **Chat notifications ship since WP-32**: a project bound to a Slack integration with a channel gets a
  thread per task and the org's quiet hours and daily digest apply; an organisation-level budget has
  no channel yet, and Slack's buttons do nothing until the Socket Mode connection exists.
