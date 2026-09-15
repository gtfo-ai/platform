# Agentic

An open-source, self-hosted platform that turns a ticket into a reviewed, mergeable merge request through a pipeline of role-specialised Claude Code agents, with a per-project knowledge base that improves with every task.

**Status:** early implementation, and it runs. The product and technical definition is complete and lives in [`docs/`](docs/README.md). A ticket reaches the platform through a provider webhook, walks the pipeline, and is watched and driven from a browser application the server itself serves; five integration providers, the knowledge base, the cost ledger and the task and run commands are built. **One thing is deliberately missing from a stock instance: there is no transport between the API process and the launcher container, so no agent stage runs** — see the [operator guide](docs/operator-guide.md) §10 and the [user guide](docs/user-guide.md). Follow [`docs/technical/PROGRESS.md`](docs/technical/PROGRESS.md) for what is built.

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

To run a **whole instance** instead — five containers, the browser application included — read the
[operator guide](docs/operator-guide.md). The short version is `cp .env.example .env`, set
`APP_SECRET_KEY` and the bootstrap administrator, and `docker compose up -d --build`: `.env` is the
app container's environment, so there is no override file to write.

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
