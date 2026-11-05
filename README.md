# Agentic

An open-source, self-hosted platform that turns a ticket into a reviewed, mergeable merge request through a pipeline of role-specialised Claude Code agents, with a per-project knowledge base that improves with every task.

**Status:** early implementation, and it runs. The product and technical definition is complete and lives in [`docs/`](docs/README.md). A ticket reaches the platform through a provider webhook, walks the pipeline, and is watched and driven from a browser application the server itself serves; five integration providers, the knowledge base, the cost ledger and the task and run commands are built. Agent stages run in the `runner` container once `.env` carries the launcher pair (`APP_LAUNCHER_URL`, `APP_LAUNCHER_TOKEN`) and a model credential — see the [operator guide](docs/operator-guide.md) §1 and §10 and the [user guide](docs/user-guide.md). *(Until WP-135 this sentence said no agent stage runs on a stock instance; that has been false since WP-53.)* Follow [`docs/technical/PROGRESS.md`](docs/technical/PROGRESS.md) for what is built.

## Quick start (contributors)

```bash
corepack enable && corepack install   # pnpm 12.3.4, per packageManager
pnpm install                          # also installs the git hooks
pnpm run -s verify                    # lint + typecheck + unit + contract
```

Node 24 or newer is required (`.nvmrc`). Other targets: `pnpm run -s verify:integration`, `pnpm run -s verify:e2e`, `pnpm run -s verify:ui`. Each prints one final `PASS:`/`FAIL:` line. The integration and e2e targets start a PostgreSQL 18 container, so they need a running Docker daemon (or `TEST_DATABASE_URL` pointing at a PostgreSQL 18 server).

To run the server itself against a local database, copy `.env.example` to `.env`, set `DATABASE_URL`, `APP_SECRET_KEY` and the `APP_BOOTSTRAP_ADMIN_*` pair, then:

```bash
pnpm db:migrate                       # forward-only SQL migrations, advisory-locked
pnpm dev                              # apps/server on $PORT, and the Vite dev server for apps/web
```

To run a **whole instance** instead — seven containers, the browser application included — read the
[operator guide](docs/operator-guide.md). The short version is `cp .env.example .env`, set
`APP_SECRET_KEY` and the bootstrap administrator, build the images with `node scripts/build-images.mjs`
(a bare `docker compose up --build` on a machine that never built them fails: the `app` and
`launcher` images are built on `platform-base`, which compose does not build), and
`docker compose up -d`: `.env` is the app container's environment, so there is no override file to
write. **Trying it on a Mac with GitLab, Jira Cloud and your own Claude subscription?**
[The first local test](docs/first-local-test.md) is a runbook for exactly that, from an empty clone
to a first ticket.

## Run a worker on your machine (worker mode)

A **worker** runs a core's agent runs on your own machine, with your own Claude subscription (BD-032).
It holds no database and no platform secret; your Claude token reaches each run's CLI and nothing else.
The full description is the operator guide's
[remote worker section](docs/operator-guide.md#a-remote-worker-on-a-developers-machine-wp-283-wp-284).

**Before you start**

- Docker with Compose v2, running (`docker info` answers).
- The core's URL (the address you open the platform at), and an account on it that is a `member` or
  above of the project.
- A Claude subscription token: run `claude setup-token` yourself and keep its output private.
- On the core, the project's execution setting must send runs to workers — `workers_only`, or `hybrid`
  (the default) — and a git integration whose runs use a static token or a deploy key needs
  `remote_run_credential: allow` set on it by an administrator; the project's execution setting says
  so when it does not.

**Steps** (in an empty directory that is **not** inside a git repository, so the token can never be
committed)

```bash
# 1. The compose file, pinned to the core's own images, with APP_CORE_URL already set to the core.
curl -fsSo compose.worker.yml https://<core>/api/worker/v1/compose.yml

# 2. Your Claude token, into a .env beside it: typed at a silent prompt, never printed.
read -rs CLAUDE_TOKEN && printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$CLAUDE_TOKEN" > .env && unset CLAUDE_TOKEN && chmod 600 .env

# 3. Start the bundle (it pulls the run, egress and git-helper images first).
docker compose -f compose.worker.yml up -d

# 4. The code to approve, and where.
docker compose -f compose.worker.yml logs remote-worker | grep user_code
```

Open the `verification_uri` the log line names (`https://<core>/workers/approve`) while signed in to
the platform, enter the `user_code`, name the machine and approve. The core's **Workers** screen shows
steps 1 and 3 for your instance, ready to copy.

**Check that it works**

```bash
docker compose -f compose.worker.yml exec remote-worker curl -fsS localhost:8080/readyz
# {"status":"ok","checks":{"core_handshake":"ok"}}
```

The machine is then listed on the core's **Workers** screen with its last-seen time.

**Open the local page**

The worker serves a page on this machine only — what it is doing (its state and slots, each run's
project, ticket, stage, the agent's latest steps and the worker's log) with **Pause/Resume**,
**Drain** and **Cancel run**. Its address carries a token and is printed at every start:

```bash
docker compose -f compose.worker.yml logs remote-worker | grep token=
# … "this worker's page: http://127.0.0.1:7357/#token=… (open it on this machine; …)"
```

Open that address in a browser on this machine (it answers on `127.0.0.1` only). Run the same
command to find it again. To change the token, delete `ui-token` in the `worker-state` volume and
restart the worker; `APP_WORKER_UI_PORT` in `.env` picks another port, and `APP_WORKER_UI=disabled`
turns the page off. **Cancel run** pauses the run's task, exactly as the task page's cancel does;
stopping the container is not a cancel (the core treats it as a lost worker and plans the stage
again).

**Stop it**

```bash
# Drain: claim nothing more, finish what is running (the local page's Drain does the same).
docker compose -f compose.worker.yml exec remote-worker curl -fsS -X POST localhost:8080/internal/drain
# Stop: any run in flight is handed back to the core; the credential stays in the worker-state volume.
docker compose -f compose.worker.yml down
```

To log the machine out, revoke it on the Workers screen. Removing the bundle's volumes as well
(`--volumes` on the `down`) also deletes its stored credential.

**Let Claude Code do it for you.** In an empty directory, paste this into Claude Code with your
core's URL in place of `<URL>`:

```text
Set up an Agentic platform worker on this machine. The core is at <URL>.
1. Check that Docker is running (`docker info`); if it is not, stop and tell me.
2. Make sure this directory is empty and not inside a git repository, then run:
   curl -fsSo compose.worker.yml <URL>/api/worker/v1/compose.yml
3. Do NOT run `claude setup-token` yourself, and never read, print, log or commit the token. Ask me to
   run `claude setup-token` in my own terminal, then to run this command myself in this directory and
   paste the token at its silent prompt:
   read -rs CLAUDE_TOKEN && printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$CLAUDE_TOKEN" > .env && unset CLAUDE_TOKEN && chmod 600 .env
   Wait until I say it is done. Check only that .env exists and is not empty (`test -s .env`); never open it.
4. Start the bundle: docker compose -f compose.worker.yml up -d
5. Show me the device code and the approval URL from:
   docker compose -f compose.worker.yml logs remote-worker | grep user_code
   and wait until I say I approved it in the browser.
6. Verify with:
   docker compose -f compose.worker.yml exec remote-worker curl -fsS localhost:8080/readyz
   and tell me whether core_handshake is ok. If it is not, show me the last 50 lines of
   `docker compose -f compose.worker.yml logs remote-worker`.
7. Tell me the address of the worker's local page — the line from
   docker compose -f compose.worker.yml logs remote-worker | grep token=
   — and that I open it in my own browser. Do not open it, and do not print the token anywhere else.
```

## Develop the worker (dev mode)

The steps above are **prod mode**: no clone, the core's own images. To change the worker itself, run
it from this checkout instead — images built from your working tree, the local page hot-reloading,
no self-update. It is a compose project of its own (`agentic-worker-dev`, page on port 7358, its own
volumes and run network), so it runs beside a prod worker on the same machine.

```bash
# 1. Settings: the core defaults to your local `pnpm dev` server (give it a test project of its own —
#    two installations polling one binding duplicate every action); Autix works too.
cp .env.worker.example .env.worker && chmod 600 .env.worker
read -rs T && printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$T" >> .env.worker && unset T

# 2. Build the images from the working tree (`:dev`; Docker's cache skips what did not change) and
#    start the worker. Run it again after a change; `--no-build` only (re)starts.
pnpm worker:dev
pnpm worker:dev logs remote-worker | grep user_code    # approve it on the core, as above

# 3. The local page from Vite with hot reload (Ctrl-C stops it); it prints the address to open.
pnpm worker:dev ui

pnpm worker:dev ps                 # or: logs -f remote-worker, down
```

`compose.worker.dev.yml` is the override (`:dev` images, the updater off, the dev names);
`.env.worker.example` lists every setting.

## Layout

```
packages/domain          aggregates, state machines, policies — no I/O
packages/application     use cases, event handlers, sagas, ports
packages/contracts       zod schemas shared by server and UI
packages/infrastructure  Postgres, jobs, broadcast, Claude SDK runner, workspaces
packages/integrations    integration ports, fakes, contract suites, providers
packages/prompts         role prompts, artifact schemas, eval sets
apps/server              Fastify composition root
apps/web                 React SPA
apps/launcher            workspace provider service
```

## Documentation

- **Running an instance:** [operator guide](docs/operator-guide.md) — install, integrations, upgrade, backup, security posture
- **A first local test** (GitLab + Jira Cloud + a Claude subscription, on a Mac): [runbook](docs/first-local-test.md)
- **Using the product:** [user guide](docs/user-guide.md) — the wizard, the board, a task, a run, the inbox, the knowledge base, budgets
- Start here: [`docs/README.md`](docs/README.md)
- Product definition: [`docs/product/`](docs/product/)
- Technical design: [`docs/technical/`](docs/technical/)
- Decisions (BD/TD records): [`docs/decisions/`](docs/decisions/)
- Research: [`docs/research/`](docs/research/)
- Open questions: [`docs/OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md) · Backlog: [`docs/TODO.md`](docs/TODO.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) — conventional commits, DCO sign-off (`git commit -s`), tests with every change. Security issues go through [SECURITY.md](SECURITY.md), never a public issue.

This project is built in public. No secrets are ever committed; see [BD-002](docs/decisions/business/BD-002-open-source-build-in-public.md).

## Licence

[Apache-2.0](LICENSE). Everything else the images and the browser bundle ship is accounted for in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), which is generated from the lockfile and the build files (`pnpm notices`) and ships inside every image; bundled CLIs keep their own licences and are executed, never linked.
