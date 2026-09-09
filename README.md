# Agentic

An open-source, self-hosted platform that turns a ticket into a reviewed, mergeable merge request through a pipeline of role-specialised Claude Code agents, with a per-project knowledge base that improves with every task.

**Status:** early implementation. The product and technical definition is complete and lives in [`docs/`](docs/README.md). The database, the event store, the job runtime and the HTTP server are built; there are no integrations, no agent runner and no UI yet, so no ticket has been through the pipeline. Follow [`docs/technical/PROGRESS.md`](docs/technical/PROGRESS.md) for what is built.

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
pnpm dev                              # apps/server on $PORT; apps/web arrives in WP-20
```

Running a whole instance (`docker compose up`) arrives with the images in WP-22.

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

[Apache-2.0](LICENSE). Bundled third-party CLIs keep their own licences and are executed, never linked; the notice file ships with the images.
