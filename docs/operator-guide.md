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
than failing, so nothing is lost. **Two places show it** (WP-86):

- `/readyz` on `app` reports `agent_runs: degraded`, with `"details": {"agent_runs": "unserved"}`,
  once a `stage.execute` job has waited five minutes and no process has claimed one in that time.
  `degraded` still answers **200**, so it never takes the instance out of rotation.
- `/metrics` exports `jobs_queued{queue="stage.execute"}` (jobs ready to run and not yet claimed)
  and `jobs_queued_oldest_age_seconds{queue="stage.execute"}` (how long the oldest has waited), and
  the same pair for every other queue.

```bash
curl -fsS localhost:8080/readyz
curl -fsS localhost:8080/metrics | grep '^jobs_queued'
```

Both are asserted through `app` with the runner absent and then present in
`test/e2e/topology/two-processes.e2e.test.ts`; these two `curl` lines against a compose instance
were not run.

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

### The topology, and splitting it further with `ROLE`

A stock instance is **already two product processes**: `app` (`ROLE` from `.env`, `all` by default —
the API *and* a worker, with no runner) and `runner` (`ROLE=runner` — a worker with the runner, and
no API). They share nothing but the database, and everything that has to cross between them crosses
through it. `ROLE` is also how you scale out further: the same image under a different value runs a
different share of the work. Every role below was started in a test as its own process against a
shared database (`test/e2e/topology/two-processes.e2e.test.ts`, WP-72), each crossing asserted
through the processes rather than reasoned about.

| `ROLE` | Serves the API, SSE and `/webhooks/*` | Runs the dispatcher and the job workers | Smallest `APP_DB_POOL_MAX` (concurrency 1) |
|---|---|---|---|
| `all` | yes | yes | 24 |
| `api` | yes | no — it only **enqueues** | 4 |
| `worker`, `runner`, `indexer` | no | yes | 22 |

Each process refuses to start below its own number and names it, listing what the number is made of. The table is held to the code by a test (`apps/server/src/config.test.ts`), so it moves when a workload is added. `runner` and `indexer` are workers
named for what you deploy them for; whether a worker runs agents is its launcher configuration,
never its role (above).

**What crosses, and how:**

- **A command's effect.** A command answered by a process that runs no worker (`ROLE=api`) is handed
  to a worker through the job queue in the database: that role holds an enqueue-only queue client
  and never takes a job itself (WP-72; before it, such a process held none, so a knowledge approval
  waited for the nightly pass and every command that starts a stage was refused). The processes
  may start in any order: `migrate` declares every job queue, so a `ROLE=api` process accepts a
  command before any worker has started, and the job waits in the queue until one does (WP-86).
- **The live run.** The runner writes the transcript and announces it with PostgreSQL `NOTIFY`; the
  process that serves your browser reads the rows back, so the run screen fills from `app` while the
  run executes in `runner`.
- **Steer, take-over and cancel cross through the database** (WP-85, TD-028 decision 9; cancel
  since WP-101, decision 11). The process that
  serves the API never holds a run, so it does not deliver the command: it records it (a
  `run_commands` row) and wakes the process holding the run's lease with PostgreSQL `NOTIFY`. The
  command is **accepted, then applied or refused** — a steer answers `202`, and the run screen shows,
  per command, whether the runner applied it or refused it (`run_ended` when the run finished first;
  it is never applied late). A take-over pauses the task, records which run it stopped, and the runner
  stops that run and exports its workspace. A run cancel does the same without the export when the
  runner holds the run's lease (`202`; the run ends `cancelled` in the runner with what it cost), and
  ends the run in place when no process holds it (`200`). The runner also polls on its lease heartbeat (every 100
  s), so a command recorded while its `NOTIFY` connection was reconnecting is applied within one beat
  — a steer that sits at *pending* for a couple of minutes means the runner's database connection is
  struggling. Nothing new listens on a port. The steer limit (one message per 5 s per person) is one
  window for the whole installation since WP-101 — it is read off the recorded steers under a
  per-user database lock — so adding API replicas does not multiply it.
- **The chat connection.** Slack's Socket Mode is held by the process that serves `/webhooks/*`, and
  that process renews a liveness row for it every 20 s (fresh for 60 s). An approval is posted with
  buttons only while the row is fresh; with no such process running — a worker-only deployment, or
  `app` down — it is posted as text naming the task page instead of buttons nobody can press.
- **A run's git credential.** The runner that minted it redacts it by exact value. Every other
  process — `app` above all, which stores and posts what quotes it: a webhook, a CI log, a
  merge-request diff — redacts it by its recorded *shape* (the prefix, GitLab's random part, the
  length), which the runner writes beside the mint's audit row and every process re-reads when that
  row commits, and every five seconds as the fallback (WP-80, WP-107). A process whose re-reads keep
  failing logs it once at `error` after a minute of failures and keeps the rules it last read. **If your GitLab administrator changed the personal-access-token prefix**, set
  the GitLab integration's `token_prefix` to it: a minted token that does not start with
  `token_prefix` is revoked and refused rather than used, because no other process could redact it.
  A credential minted through an integration the project has since been unbound from is still
  revoked through that integration; one whose integration row is gone is reported and lives to its
  expiry.
- **A merge request's diff** is read at most once per revision *per worker process*, so one gate
  entry may read it once in `app` and once in `runner`.

### Requirements

- Docker Engine with the `docker compose` plugin. Measured here on Docker **29.7.2**
  (`linux/arm64`, Docker Desktop on macOS) with Compose **v5.5.1**; CI builds the same images on
  `ubuntu-latest` and `ubuntu-24.04-arm`.
- Room in the Docker VM for the images. Measured unpacked at WP-22, the product and launcher again
  at WP-82: base 547 MB, runtime 1.32 GB, egress 13.2 MB, product 801 MB, launcher 661 MB. Those
  sum to about **3.3 GB**, which counts the base inside each of the three images built on it, so it
  is an upper bound; plus whatever the database grows to.
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

One check is never `down`: **`agent_runs`** is `degraded` (and `/readyz` still answers 200) when
agent stages are not being taken — `details.agent_runs` says `unserved` (a `stage.execute` job has
waited five minutes with nothing claiming it: no runner, or a runner with no launcher URL and token)
or `unknown` (the read failed; the `database` check says why). It is about the instance, not the
process you asked, so `app` reports it too. See *The runner, and why it is a container of its own*, above.

**`dispatch` is the one to know about.** `/readyz` is 503 on every worker role — `all`, `worker`,
`runner` and `indexer` — for as long as the process cannot compose a pipeline — it is honest rather
than broken, and it is the same condition under which the outbox sweep deliberately does not start
([TD-023](decisions/technical/TD-023-config-logging-metrics-otel.md)'s amendment). A stock instance
today **does** compose one, so the check passes. `ROLE=api` runs no dispatcher and omits the check
entirely rather than report it `ok`; since WP-72 it does report `queue`, for the enqueue-only client
it hands commands to the workers through. The API ready beside a worker that is 503 for this reason
is asserted with two processes in `test/e2e/topology/two-processes.e2e.test.ts`.

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

### Metrics worth an alert

`/metrics` is Prometheus text. Besides the Node process and HTTP metrics, these are the platform's
own, and each is exported **only** by a process that can measure it — a missing series means *this
process cannot answer*, never zero:

| Metric | What it says | Alert on |
|---|---|---|
| `event_dispatch_pending` | events committed and not yet dispatched (worker roles) | a value that keeps growing |
| `event_dispatch_dead_lettered` | events that spent `APP_DISPATCH_MAX_ATTEMPTS` and left the queue — **Settings → Dead letters** names each one (§9) | anything above 0 |
| `notifications_undelivered{planned="immediate"}` | chat notifications nobody received, past `pipeline.outbound`'s whole retry window (about 48 minutes), after every one of the job's three attempts tried to deliver and failed — on a project with the digest off, and for every organisation budget alarm, the recovery pass re-posts each one **once** more under the same idempotency key (WP-84) and nothing retries it after that; an organisation budget alarm whose chat configuration the platform refused (two accounts each naming a channel, Q103) is counted here too; a question or approval notification the platform **withheld** because the question was answered or the approval decided first is not (it was correctly not sent) | anything above 0: a revoked chat token or a refused organisation configuration shows up here, not as an absence of messages |
| `notifications_undelivered{planned="digest"}` | lines held for a digest that has not carried them a day later | anything above 0 |
| `platform_storage_bytes{component="database"}` | `pg_database_size` of the platform's database | growth; see §6 |
| `platform_storage_bytes{component="knowledge_mirrors"}` | the bare git mirrors under `APP_KNOWLEDGE_MIRROR_ROOT` (processes that have it) | the 50 GB mark, as for the database |
| `platform_storage_total_bytes{components="database+knowledge_mirrors"}` | the two lines above summed — exported only when both were measured | the disk you gave the instance |
| `knowledge_mirror_bytes{project_id="…"}` | one project's mirror — the axis you can act on | a project that outweighs the rest |
| `jobs_queued{queue="…"}` | pg-boss jobs ready to run and not yet claimed, per declared queue, `0` included; a timer not yet due is not counted (every role that holds a job client, WP-86) | `queue="stage.execute"` above 0 for longer than a stage takes: no runner is taking agent stages |
| `jobs_queued_oldest_age_seconds{queue="…"}` | how long the oldest of those has waited; no series for a queue with nothing waiting | `queue="stage.execute"` above 300 — the same condition `/readyz` reports as `agent_runs: degraded` |
| `webhook_deliveries_rate_limited_total{provider="…"}` | webhook deliveries answered `429` by their integration's rate limit, before any signature check (API roles, WP-87) | a rate that does not stop: somebody is flooding the endpoint, or a vendor's burst is larger than the bucket — its deliveries are being retried, not lost, until the vendor gives up |
| `command_idempotency_claims_unknown{action="…"}` | commands whose process died between claiming their `Idempotency-Key` and recording the outcome, past the in-flight window (`CLAIM_IN_FLIGHT_MS`, `apps/server/src/routes/idempotency.ts`); the key answers `409 idempotency_attempt_unknown` for good (API roles, WP-73) | anything above 0 asks a **human check** of the resource the action names — never a delete of the row, which would let a retry perform the command a second time |

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
"Test connection" button on every card. Since WP-100 the form offers the providers this build ships
and, for the one you choose, asks for a name, each field that provider **requires** (GitLab's and
Loki's `base_url`, Jira Cloud's `site_url` and `user_email`, Sentry's `organization`, Slack's
`channel`) and, for each credential field, the **name of the environment variable** the server
should read it from — never the value. The field list comes from the server
(`GET /api/integrations/providers`), read off each provider's own schema. (Until WP-30 no screen
called `POST /api/integrations` at all — PROGRESS backlog 55 — and until WP-100 the form sent an
empty configuration that every provider refused at the first test — backlog 328.)

**The create checks the configuration before it stores anything.** A document the provider's schema
refuses — a required field missing, a key the provider does not declare, a value of the wrong shape —
answers `400` with the code `invalid_integration_config` and names each key path; no row is written.
An integration created before WP-100 whose configuration would not load shows the refusal on its card
(and `/test` answers `409 invalid_integration_config`); **Edit configuration** repairs it, which is
`PATCH /api/integrations/<id>` with `config` (keys to set) and `remove` (keys to delete), checked the
same way as the create. Both forms offer the provider's **optional** fields too, each with a control
of its type — a true/false choice, a number, a comma-separated list, a list of values — and an
optional field left empty is not sent, so the provider's default applies (WP-114).

**Rotating a credential.** Put the new value in a **new** environment variable on
`APP_INTEGRATION_SECRET_ENV`, restart the process so it reads it, and press **Replace credentials** on
the integration's card — `POST /api/integrations/<id>/secrets` with `{"secret_refs": {"<field>":
"<VARIABLE>"}}` and an `Idempotency-Key`. The server reads and seals the value exactly as the create
does, **deletes** the old sealed row, keeps the fields you did not name, and resets the health to
*unknown*; press **Test connection** afterwards. A retry under the same key re-seals nothing.

**Retiring an integration.** **Retire** on the card — `DELETE /api/integrations/<id>` — deletes the
integration's sealed credentials and keeps the row, marked retired, because the audit names it for
every call it made. It is refused while a project binds it (`409 integration_bound`, naming the
projects — unbind it first) and while a run credential it minted has not expired and was not
confirmed revoked (`409 integration_has_live_credential`; wait for the revoke or the expiry), and
while it is the organisation's chat account (`409 integration_is_organisation_default`; change
*Organisation settings* first). A
retired integration is never loaded and refuses every change; its name stays taken.

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
       "config":{"base_url":"https://gitlab.example.com"},
       "secret_refs":{"token":"GITLAB_TOKEN"}}'
# → 201 {"id":"…","provider":"gitlab","name":"GitLab"}
```

The two extra headers are not optional and the API says so if you omit them: every mutating request
needs a trusted `Origin` **and** `x-requested-with`, which is the cross-site guard; omitting one
answers `403` with the code `cross_site_request` and a sentence naming the missing piece — for
example *"cross-site request refused for POST /api/integrations: Origin (absent) is not a trusted
origin"*. `Idempotency-Key`
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

For a provider with an inbound half, the integrations screen's **Setup guide** card shows the URL to
paste into the provider, with a **Copy** button — the same value the API publishes as the
`webhook_url` field of `GET /api/integrations/:id/setup-guide`. It is built from `APP_BASE_URL`:

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
scheme sends the binding's own webhook secret in `X-Gitlab-Token`). Each integration has its own rate
limit on this endpoint (WP-87): past it a delivery is answered `429` with `Retry-After` **before**
its signature is checked, stored nowhere, and counted on `webhook_deliveries_rate_limited_total`. The
bucket is generous (a burst of 120, then 10 a second) and per `app` process.

**No public URL?** A task-management binding can **poll** instead (WP-87): set `poll_enabled: true`
(and, if 60 seconds is not right, `poll_interval_seconds`) in the binding's configuration — or, for
every project the account serves, on the integration itself, where **Edit configuration** offers both
as typed controls (WP-114). The
platform then asks the provider for the binding's pick-up rule on that interval, and each ticket it
finds is treated exactly as a webhook's match; each poll also re-reads the tickets of the binding's
running tasks, so an edit to a ticket the status mapping has moved off a **status** pick-up rule
still reaches its task (WP-110). A binding can have both — a ticket seen by the webhook and by a
poll is started once. What a poll does not carry (comments, the ticket linter's *created* event) is
listed in the Jira setup guide's step 5.

A **GitLab** binding can poll its merge requests the same way (WP-110): the same two keys in its
configuration, and a `project` to list. A poll turns each merge request into the events a webhook
would have sent — a new or reopened one, an update, a merge, a close — so review-only mode starts
and a task learns that its merge request merged. A merge seen by the webhook and by a poll is one
merge. Approvals, review comments, finished pipelines and default-branch moves are **not** in a
merge-request listing. A GitLab binding with **no webhook secret at all** — neither
`webhook_secret_token` nor `webhook_signing_token`, so no delivery can reach it — is **poll-only**, and
its polls make two more reads (WP-123): the default branch's head, so a task waiting at Ready is
re-checked for conflicts when `main` moves, and the comments on each merge request waiting at Ready
(at most twenty per poll), so a reviewer's comment returns the task to Implementation. A binding
with a webhook secret makes neither read: its webhook carries both. Approvals stay webhook-only
(they count toward review time and change nothing else); the GitLab setup guide's step 3a lists the
rest. One setting, `APP_POLL_SWEEP_INTERVAL_MS`, bounds how long a lost poll of either kind waits.

## 5. Upgrade

Migrations are **forward-only** and applied under a PostgreSQL advisory lock, so the order is always
the same: stop serving on the old code, migrate, start the new code.

**Which image to upgrade to.** This project ships continuously
([TD-019](decisions/technical/TD-019-release-engineering.md)'s amendment of 2026-09-16): every push
to `main` is reviewed, verified and published to GHCR on `amd64` and `arm64` as `sha-<7>`, `edge`
and `latest`. So **pull `latest`, or pin a `sha-<7>` tag** — `latest` is the newest push to `main`
and `sha-<7>` is one exact commit, which is what to pin when you want the upgrade to be a decision
rather than a schedule. **Version tags** (`X.Y.Z`, and the moving `X.Y` and `X`) are cut by the same
workflow once the maintainers switch versioning on: each is a copy of one push's `sha-<7>` image at
the same digest, never a separate build, and its GitHub Release says whether the upgrade needs a
migration. Until the first `vX.Y.Z` release exists nothing published carries one — pin a `sha-<7>`.

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

**Upgrading past the build that introduced deadlines (WP-56).** Questions and plan or budget
approvals that were open before it have no deadline. The recovery pass (the
`APP_INTAKE_RECONCILE_INTERVAL_MS` timer) gives each its first one **counted from the pass, not from
when it was asked** — the project's `question_timeout`, `1 working day` by default, on the working
calendar — so nothing that was waiting on the day of the upgrade expires at once. A **take-over**
has nowhere to store such a deadline, so one held for more than five working days on the day of the
upgrade moves to needing a human on the first pass; the workpad keeps its branch and resume command.

**Upgrading past the build that recovers lost reminders (WP-108).** A question or approval open on
the day of the upgrade that was never reminded about — open before reminders existed, given its
first deadline by the pass above, or whose reminder timer was lost — is reminded **once** on the
first pass after its halfway point, as long as its deadline has not passed; one already past its
deadline is not reminded, it is escalated as before. So a project with old open questions may post
a burst of *"still unanswered"* reminders shortly after the upgrade.

**Upgrading past the build that polls merge requests (WP-110).** The smallest `APP_DB_POOL_MAX` rose
by one — **24** for `ROLE=all` (from 23) and **22** for `worker`, `runner` and `indexer` (from 21) —
because the merge-request poller is one more job worker. A process below its number refuses to start
and names it (the `ROLE` table in §1), and once `migrate` has applied 0068 the old image is no help, so check
the value **before** you upgrade: a stock `.env` (`25` since this build, `24` before) already meets it;
an installation that set `APP_DB_POOL_MAX` to exactly the old minimum must raise it by one. The same
holds for every later build that adds a job worker: the floor table above moves with the code, so read
it against your `.env` on each upgrade (PROGRESS backlog 371).

**Upgrading past the build that re-reads stored repository readings (WP-121).** Before it, the copy of
a project's `.agentic/prompts/` files the platform stores was redacted by the pattern rules only, so a
credential the platform holds — committed to a prompt file in a shape no rule knows — could still be in
it and reach every run of that project. Migration 0073 marks every such stored reading, and from then
on **no prompt text of a marked reading is given to any run or shown anywhere**. The process that runs
the knowledge index (`ROLE=all`, `worker` or `indexer`) re-reads every marked project **once, at
start**, eight at a time in the background — the same read an index run makes, through the knowledge
mirror — and replaces the reading with one redacted by every credential the platform holds. Expect
one `pattern-redacted repository readings read again` line per batch. A project whose repository
cannot be read then (no `APP_KNOWLEDGE_MIRROR_ROOT`, an unreachable remote) keeps **no** prompt text
until it can: a `warn` line names it, the project's settings page says why under *Project prompt
files*, and its stages run without their prompt files. Fix the cause and press **Re-read now** (or
`POST /api/projects/:project_id/config/refresh`); the next index run of the project does the same.
The platform cannot un-leak a credential already committed to a project's history — rotate it.

**Upgrading past the build that renamed the poll sweep variable (WP-123).** `APP_TICKET_POLL_SWEEP_INTERVAL_MS`
is now **`APP_POLL_SWEEP_INTERVAL_MS`** — it has governed the merge-request poller's sweep as well as
the ticket poller's since WP-110, and the old name said tickets. The old name is **still read for one
release**: set alone it applies, and every start logs a `warn` naming the new one; set beside the new
name it is ignored (the new one wins) and the `warn` says so. Rename the line in your `.env` now — the
release after this one stops reading the old name, and a value under it then silently falls back to the
default of a minute. The same build adds migration 0074 (`bindings.mr_poll_default_head`, the
last-seen default-branch head of a poll-only GitLab binding); its first poll after the upgrade reads
the head and records no move.

**Upgrading past the build that gave each instance its own network (WP-126).** `compose.yml` used to
name its default network `agentic` outright, so every compose project started from the file on one
Docker host joined that one network, and the `db` name on it could answer with **another project's
database**. The network is now the project's own: **`agentic_default`** on a stock install (compose's
`<project>_default`; with `docker compose -p <name>` it is `<name>_default`). Make this one upgrade
with the **old** `compose.yml` still in place, and with no agent run in progress:

```bash
cd agentic
docker compose down                       # no -v: removes the containers and the `agentic` network, keeps every volume
git pull                                  # then the steps at the top of this section
docker compose run --rm migrate
docker compose up -d
```

**If you already pulled the new `compose.yml`**, the same order still works with one more line —
`docker compose down` with the new file removes the containers but no longer knows the old network:

```bash
docker compose down                       # the containers; `agentic` stays
docker network rm agentic
docker compose run --rm migrate
docker compose up -d
```

Do **not** run `run --rm migrate` (or `up -d`) first on Compose v5.5.1: it stops `db`, removes
`agentic` and then fails to start `db` with *"could not find a network matching network mode
agentic"*, so the migration never runs; `docker compose up -d --force-recreate` recovers that state,
after which `run --rm migrate` succeeds. Compose 2.38.2 instead recreates the containers on the new
network and leaves `agentic` behind for you to remove. Both measured on a minimal two-service project
making exactly this change, and the sequence above was clean on both versions. **Anything you attached to
`agentic` by name** — a reverse-proxy container, a `docker network connect agentic …`, another compose
file declaring `agentic` as an `external` network — must name `agentic_default` instead.
`agentic-run-egress` keeps its global name on purpose (the launcher is handed it by name), so two
instances on one host still share that one network; only their launchers and the run objects they
create join it.

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
| `exports` | take-over export tarballs | the **user's** artefacts, served to them at `GET /api/runs/<run>/export.tar` (the `app` container reads the volume through `APP_WORKSPACE_EXPORT_DIR`) and **removed after 14 days** by the launcher's retention sweep — the taken-over workspace's own window (WP-44, Q93). The branch is on the git host either way |
| `agentic-repo-cache` | the launcher's per-project bare mirrors | a cache, re-created on the next run |

### Disk: the database and the mirrors

Two things grow on the instance's disk and they grow for different reasons, so the storage gauge
reports them as **two lines under one total** (§3): the **database** grows with the platform's own
activity (transcripts, events), and the **knowledge mirrors** grow with the size of your projects'
repositories — one bare clone per project, appearing on that project's first index run (TD-026). A
single monorepo can outweigh a year of transcripts.

A mirror is a cache ([BD-012](decisions/business/BD-012-knowledge-in-repo.md)): deleting one costs
its project a full re-clone on its next index run and nothing else. `APP_KNOWLEDGE_MIRROR_MAX_BYTES`
puts a ceiling on their total; **unset, the default, there is none**. When set, after each index run
the mirror **used least recently** is removed until the total is under it — by last use, never by
age, because the oldest mirror is often the most active project's, and never one used within the
last hour. The run that crosses it logs `knowledge mirror evicted` per mirror, and
`knowledge mirrors are over APP_KNOWLEDGE_MIRROR_MAX_BYTES` when every remaining one is in use.
Choose the ceiling from `knowledge_mirror_bytes`, not from a guess.

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
and it allows only the model host (`APP_MODEL_EGRESS_HOSTS`), the project's git host and — for a run
that may install from a lockfile (developer, reviewer, acceptance tester, discovery) — the package
registries you declare in `APP_RUN_REGISTRY_HOSTS`, which is empty and therefore closed by default.
A project's own configuration cannot add a host. *(Until WP-82 this said "the hosts the project's
configuration lists"; `.agentic/config.yml` has never had a key for one.)*

**No integration credential is inside a run container.** The SDK runs on the platform side and spawns
the CLI in the container over a per-run control socket; git gets a run-scoped token from a credential
helper that asks back across that socket — the `runner` answers it, for the run's own git host and
only while the run is live — and the token is never in the container's environment. The token is
readable by code in the run for the run's lifetime (BD-025 §3 permits it), is `read`-only for a
read-only stage, and is revoked when the run ends. Integration secrets are encrypted at rest with AES-256-GCM
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

`APP_WORKING_DAYS`, `APP_WORKING_HOURS` and `APP_HOLIDAYS`, read in `TZ`, are the **working calendar**
every deadline the platform holds a person to is counted on (WP-56): a blocking question and a plan
or budget approval expire after the project's `pipeline.limits.question_timeout` (default
`1 working day`, BD-006) and move the task to needing a human, and a taken-over task escalates after
**5 working days with no command from the person holding it** (product/19 §19; since WP-44 a command
they issue on the task restarts the count, while another user's command and a push to the branch do
not — the normaliser does not yet carry who pushed, though GitLab's hook names them). So a question asked at 16:00 on a
Friday with the defaults (Monday–Friday, 09:00–17:00) expires at 16:00 on Monday, not on Saturday.
They are read at start-up: an empty value is the default in `.env.example`, and a malformed one
refuses to start with the variable's name in the message. The platform never guesses public holidays
— list yours in `APP_HOLIDAYS`.

### Dead letters: an event the platform stopped retrying

An event whose handler fails `APP_DISPATCH_MAX_ATTEMPTS` times (10 by default, about twenty minutes
of retrying) is **dead-lettered**: it leaves the dispatch queue, the events behind it in its stream
move on, and — when it belongs to a task — that task is parked in *Needs human* with a brief naming
the event and the handler. `event_dispatch_dead_lettered` (§3) counts them. **Settings → Dead
letters** (admin only; `GET /api/org/dead-letters`) lists each one: its position, event type, stream,
the handler that failed, how many times, the last error (redacted by the platform's patterns and cut
at 2 000 characters — the full text is in the log), and the task it escalated, if any. An event that
names no task has no brief anywhere else, so this list is where it shows up. The newest fifty come
first and **Show older** pages back to the oldest (WP-114).

Once the handler is fixed — usually a new build, sometimes a provider permission — press
**Re-queue** (`POST /api/org/dead-letters/:position/requeue`). It puts the **same** event back in the
queue: nothing is copied into the log, and every handler that already succeeded for it is skipped,
so what those did is not done twice. The press is recorded in the audit (`human_actions`, action
`org.dead_letter.requeue`, with the event's task when it has one). The task the dead letter escalated
stays in *Needs human*; look at it afterwards and hand it back or retry the stage as its brief says.
If the handler still fails, the event is dead-lettered again after the same number of attempts.

This replaces the hand-typed `update event_dispatch …` statement earlier builds documented, which
left no audit row.

### Failed jobs: a job the job queue stopped retrying

The job queue (pg-boss) retries a job whose handler throws up to its queue's retry limit and then
marks it **failed**. **Settings → Failed jobs** (admin only; `GET /api/org/failed-jobs`, WP-108)
lists them, newest first (**Show older** pages back to the oldest, WP-114): the queue, how many times it was tried, the retry limit, when it failed and
the failure's message (redacted by the platform's patterns and cut at 2 000 characters; the job's
payload is never shown). Beside each one is the platform's own census of that queue — whether it
ends its own failures or relies on the retries, what a failed job of it drops, and, since WP-124,
its **shape** (TD-004's M7 amendment), which is what the card's last sentence reads:

- **a recovery row** finds what the job left and tries once more, then makes it visible — a lost
  stage is re-enqueued once and then escalated, a lost reminder is sent, an approved knowledge change
  whose apply failed is re-applied once and then reads **apply failed** on the project's proposal
  queue (a maintainer approves it again to retry), and a discovery run whose findings were never
  recorded is recorded once more and then its task is escalated;
- **bound and escalate**: the job's last try escalated the task it carried, with a brief on the task
  page — a review-comment window, a review or lint post, a spike report, a breakdown's child tickets,
  the dependency check, a resume's head check. A task that had already finished (a review-only or
  lint task is `done` by the time its post runs) cannot escalate, so its people get an escalation
  message instead — on a project with a chat binding (OPEN-QUESTIONS Q113);
- **listed only**: the next transition re-derives what the job was for (a ticket status, a workpad,
  a conflict warning), the queue's next scheduled run redoes it, or what it dropped was a
  notification or a metric (a day's digest, a chat edit). Nothing re-runs it.

`pipeline.outbound` carries all three, one per duty, and the card names them, because this list
never reads a job's payload. There is **no re-queue**: not every queue's handler is shown to re-check
its state when it fires again. pg-boss keeps a failed job for its retention window, days rather than
for ever, so the list is not an archive; the log has every failure.

## 10. Known limits of this build

Stated here so an operator meets them in a document rather than in production:

- **An agent run needs `APP_LAUNCHER_TOKEN`, and without it nothing runs one.** WP-53 built the
  transport (§1, "the runner"), so a stock instance *with* a token in `.env` runs agent stages in the
  `runner` container; one without a token queues them. Everything else — intake, the board, the
  knowledge base, the commands, the cost ledger, the audit — runs either way.
- **A stage that writes needs a git binding that can mint** (WP-76). The `runner` mints one
  short-lived GitLab project access token per run with a checkout, through the integration executor —
  `read` for a read-only stage, `read` + `write` for one that writes, revoked when the run ends, one
  audit row each — and hands it to the launcher on the create request. A run whose runner died, or
  whose revoke failed, has its token revoked by the recovery pass a few minutes later (one pass
  interval after the run ends — for a dead runner, after the lease sweep has ended it), **once**; if
  that attempt fails too, or GitLab answers that it has no such token, the error log says so and the
  token must be checked by hand in the project's access tokens (WP-77). So the GitLab integration
  needs **`mint_credentials: true`**, which needs a personal access token that may create project
  access tokens (GitLab Premium or Ultimate on GitLab.com; any self-managed tier) — the GitLab setup
  guide's step 5. Without it, a stage that writes (implementation, conflict resolution, the
  librarian) fails at start **naming the binding and the setting**, and a read-only stage fetches
  anonymously, which works only for a repository GitLab serves without authentication: **a private
  repository needs `mint_credentials: true` for every stage.** The binding's own token is never
  handed to a run instead. A token whose revocation fails (the `runner` logs it by name) or whose
  `runner` died mid-run lives until GitLab expires it — up to two days, because GitLab grants whole
  days. A **shadow** task's runs get a `read` token, never a push one.
- **`docker compose up` cannot pull the published images** without the retagging step in §2, because
  `compose.yml` names them without a registry.
- **`compose.yml` passes the `app` service a fixed list of variables**, so `.env` is not the app's
  environment until you add the override in §2. Every credential and every optional feature switch is
  behind that.
- **Creating an integration from a screen landed with WP-30** (§4): the wizard's integrations step and
  the project settings page both carry the create and test buttons over the endpoints §4 documents.
- **No SBOM attestation** is published (§2).
- **The business-interview step of onboarding is a form, not the Product Manager's conversation**
  (WP-64, Q102; see the user guide). Its answers become knowledge proposals, never commits.
- Every endpoint the browser application calls is served (the census in
  `apps/server/src/routes/client-census.test.ts` holds it, admitted gaps empty since WP-27, which added
  steer, take-over and hand-back). Since WP-85 a steer and a take-over's stop reach the run in the
  `runner` container through the database — accepted by `app`, then applied or refused by the runner
  (§1, *The topology*; TD-028 decision 9) — and since WP-101 so does a run cancel (decision 11).
- **Chat notifications ship since WP-32**: a project bound to a Slack integration with a channel gets a
  thread per task and the project's quiet hours and daily digest apply; an organisation-level budget
  posts to the organisation's own chat account's channel (WP-65), and since WP-93 the organisation's
  quiet hours, digest time and — with two chat accounts — the account that speaks for it are set on
  **Settings → Organisation settings** (`PATCH /api/org`, admin), beside the organisation's command,
  autonomy and WIP maximums. **Since WP-43 the process that serves the API (`ROLE=all` or `ROLE=api`) holds the
  Slack Socket Mode connection** — a `ROLE=worker` process holds none and names the integration in
  its log — so an approval is posted with Approve / Request changes **while that process holds the
  connection** (since WP-72 it renews a liveness row the notification band reads; with no such
  process the approval arrives as text naming the task page), and a click from an account an
  admin has mapped on **Settings → Provider identities** is decided like one on the task page (a
  plan needs a maintainer). `APP_INTEGRATION_HOSTS` must name `slack.com` for the connection to
  open. Since WP-88 a question is posted the same way, with a button per option, and a *reply* in
  its Slack thread answers it from a mapped account: the platform records which thread belongs to
  which task in its own database (`chat_threads`), so the reply reaches the task whichever process
  receives it.
