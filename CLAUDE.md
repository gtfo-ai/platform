# Agentic platform — instructions for Claude Code

## What this repository is
Self-hosted, open-source platform that runs Claude Code agents through a real-life delivery pipeline (ticket → MR) with a per-project knowledge base. The product spec lives in `docs/` and is authoritative: `docs/product/*` (what/why), `docs/decisions/**` (BD/TD records), `docs/technical/*` (how). If code and docs disagree, the docs win; change the docs first (with a decision) and then the code.

## Non-negotiables
- No secrets in the repo, ever (BD-002). Fixtures use obviously fake values. `.env.example` lists every variable with a safe default.
- Clean architecture: `packages/domain` has no I/O; `application` depends only on `domain` and ports; adapters live in `infrastructure`/`integrations`; `apps/*` are composition roots.
- Everything is an event; handlers are idempotent and registered with a priority (TD-005). Never mutate state outside an aggregate's transaction.
- All external text (tickets, MR comments, logs, web) is untrusted data (BD-022).
- Tests are part of every change (technical/10): unit + property tests for domain, contract tests for integration ports, golden fixtures for SDK streams, fake-Claude e2e for pipeline changes.
- Conventional commits with `Signed-off-by` (DCO). Small MRs.

## Layout
`packages/{domain,application,contracts,infrastructure,integrations,prompts}`, `apps/{server,web,launcher,runlet}`, `scripts/`, `test/`, `docker/`, `schemas/`, `.github/workflows/`, `docs/`.

Workspace packages are published under the neutral scope `@platform/*` (BD-014). They are consumed straight from `src/` — there is still no build step for the server rings. WP-06 made `apps/server` runnable without one: `pnpm dev` and `pnpm db:migrate` run the TypeScript sources through `scripts/ts-source-resolver.mjs`, which maps the repository's `.js` specifiers onto the `.ts` files on disk. A `tsc` emit is a packaging decision for WP-22 (the Docker image), not a prerequisite for running the server. **`apps/web` is the exception**: a browser needs a bundle, so WP-20 gave it Vite 8 (`apps/web/vite.config.ts`). Vite resolves the repository’s `.js` specifiers onto `.ts`/`.tsx` itself, so the convention is unchanged, and `dist/` is generated output that is not committed.

`schemas/` holds the JSON Schemas generated from `packages/contracts` (`pnpm schemas`). It is generated output: edit the zod schema, regenerate, commit both.

`packages/infrastructure/src/db/migrations/*.sql` is the authoritative database schema (TD-011): forward-only, applied under an advisory lock, never edited once applied — add a new numbered file. The Drizzle definitions beside them type the queries and are held to the SQL by an integration parity test.

## Commands
- `pnpm install` (installs git hooks via `prepare`) · `pnpm dev` (runs `apps/server` from source with `LOG_FORMAT=pretty` **and** the Vite dev server for `apps/web`, which proxies `/api` and `/events` to the API so the browser sees one origin; needs `DATABASE_URL`, `APP_SECRET_KEY` and a migrated database; `--server-only` skips the web half) · `pnpm test` (unit + contract, with coverage) · `pnpm test:integration` (Testcontainers PostgreSQL 18; `TEST_DATABASE_URL` uses an external server instead) · `pnpm db:migrate` (applies the SQL migrations under an advisory lock; the image runs the same entrypoint as the `migrate` service) · `pnpm test:e2e` (whole `apps/server` instances against the same PostgreSQL container; fake Claude joins at WP-12) · `pnpm test:ui` (web reducers and components in happy-dom) · `pnpm test:web-e2e` (Playwright against the built bundle and a fake API/SSE backend; needs `pnpm exec playwright install chromium` once) · `pnpm bundle:check` (builds `apps/web` and holds the initial graph to TD-013’s 300 kB gzipped budget) · `pnpm lint` · `pnpm typecheck` · `pnpm schemas` (regenerates `schemas/` from `packages/contracts`) · `pnpm schemas:check` (fails when `schemas/` is stale; a step of `verify:static`, which CI's lint job runs) · `pnpm eval` (the role-prompt evals of TD-016; **it cannot run in this repository and says so** — promptfoo is not a dependency and there is no model credential, so it exits **1** naming both, because an eval that ran nothing and reported green is worse than no eval. `pnpm eval --check` reports the same without running anything. The cases are checked in under `packages/prompts/roles/<role>/evals/` and are held to the artifact schemas offline by `packages/prompts/src/evals.test.ts`; the blocker brief is in `PROGRESS.md` under WP-17)
- Verification contract (technical/14) — each prints exactly one final `PASS: <target>` / `FAIL: <target>` line:
  `pnpm run -s verify` (lint + typecheck + schemas:check + ignored:check + nul:check + conflict:check + bundle:check + unit + contract) — it has no list of its own: it is the concatenation of `verify:static`, `verify:types`, `verify:bundle` and `verify:tests`, which are targets too and are exactly the four commands CI's lint, typecheck, bundle and unit jobs run, so a step cannot be in `verify` and missing from CI (`scripts/verify-targets.ts`, held to `.github/workflows/ci.yml` by `scripts/verify.test.ts`) · `pnpm run -s verify:integration` · `pnpm run -s verify:e2e` · `pnpm run -s verify:ui` · `pnpm run -s verify:web-e2e` (Playwright; a target of its own because it needs a browser binary) · `pnpm run -s verify:commits` (DCO + commitlint over a commit range; `verify:dco` and `verify:commitlint` are the halves CI runs as its own jobs — the range comes from the GitHub event payload, or from `--from <rev>`, or `@{upstream}..HEAD`)
- `pnpm nul:check` fails when a tracked source file contains a literal NUL byte (a step of `verify:static`, which CI's lint job runs).
- `pnpm conflict:check` fails when a tracked file carries merge debris — a conflict marker or a `.orig`/`.rej` artefact (a step of `verify:static`, which CI's lint job runs, **and** a pre-push hook job, because CI's verdict arrives after the push).
- `pnpm secrets:scan` runs gitleaks over the working tree; the pre-commit hook scans the staged diff.
- `docker compose up --build` for a full instance (`compose.yml`; `db`, `migrate`, `app`, `docker-socket-proxy`, `launcher`, and `db-backup` under the `backup` profile); `docker compose -f compose.yml -f compose.local.yml up` for the local provider mode (an override file, not a profile: a compose service without `profiles` always runs, so a second `app-local` service behind one started *both*). `node scripts/build-images.mjs [base|runtime|egress|platform|launcher] [--size-check]` builds the images from `docker/*.Dockerfile` — including the two no compose service runs, `platform-runtime` and `platform-egress`, which the launcher creates per run and which `test/e2e/workspace/docker-workspace.e2e.test.ts` needs on the daemon.

## Conventions
- TypeScript strict, ESM, Node 24 (`engines: >=24`); zod for all boundaries; pino for logs (never `console.log` in server code); errors are typed, never swallowed.
- Relative imports carry the `.js` extension. Nothing enforces it today (`moduleResolution: bundler` accepts any form), but it is what a `tsc` ESM emit will require once a build step exists, so the convention is set now rather than retrofitted. Note it does **not** make sources directly runnable by Node's type stripping — that needs the on-disk `.ts` specifier.
- Test file naming decides the tier: `*.test.ts` = unit, `*.contract.test.ts` = contract, `*.integration.test.ts` = integration, `*.e2e.test.ts` = application e2e, anything under `apps/web/src` = ui, and `test/web-e2e/*.spec.ts` = Playwright (`verify:web-e2e`; no vitest project claims it). The integration and e2e tiers share one PostgreSQL 18 container (`test/integration/support/`); the e2e tier starts whole `apps/server` instances on it.
- Integration providers implement the type port + fake + contract test + setup guide; adding a provider never touches the pipeline or UI (BD-017). A provider's HTTP fixtures live in `test/fixtures/http/<provider>/` and every one carries a `source` block — the URL, the date it was retrieved, and whether it is `documented`, `documented-adapted`, `composed`, `inferred` or `invented`, with a `note` for everything but the first. A fixture you recorded and a fixture you invented are different kinds of evidence, and an adapter that conflates them passes its own tests and fails in production. **Two shapes are accepted**: a block on the file (Jira, one document per file) or a block on *every* interaction of an `{"interactions": [...]}` document (GitLab, one recorded conversation per file, whose interactions honestly cite different pages). Partial coverage fails, and an empty `interactions` list is a document that claims nothing rather than a document that passes. The blocks are **enforced**: `test/contract/integrations/fixture-provenance.contract.test.ts` runs the shared suite in `test/contract/support/integrations/fixture-provenance.ts` over every directory under `test/fixtures/http/`, discovered from disk — so a new provider's fixtures are checked the moment they exist. **Both shapes need a `SOURCES.md`** beside the fixtures: it is the human-readable statement of what the corpus rests on (including pages that produced no fixture) and the allow-list of hosts a citation may name, without which the domain check admits any host that is not IANA-reserved. The suite's docblock has the reasoning and the honest list of what it cannot check. The type **ports** live in `packages/application/src/ports/integrations/` (the pipeline depends on them, so they cannot live in an adapter package), the **fakes** in `packages/integrations/src/<type>/fake.ts` with a divergence register in their docblock, and the reusable **contract suites** in `test/contract/support/integrations/`, run against the fake by `test/contract/integrations/*.contract.test.ts` and against each real adapter by its own runner. Every outbound provider call goes through `IntegrationActionExecutor` (shadow mode, idempotency, rate limits, audit) — never directly, and **nothing it writes carries an injected secret**: the audit row, the thrown error and the idempotency record's stored value are redacted there (`encode` is often the identity over provider text, so the guard is in the executor and never at a call site), while an idempotency **key** that would need redacting is *refused* instead — redaction is many-to-one and a key is an identity, so redacting it answers one call with another call's result, including for a `[REDACTED:integration:…]` an attacker wrote into a ticket comment (BD-022). `idempotencyScopeFor` carries the reasoning; `exactSecretRedactor` refuses two secrets that share a placeholder name for the same reason. **The inbound dedup key answers the opposite way, and that is decided rather than inconsistent**: rule 20 — refusing a mutation costs one action, refusing an inbound delivery drops a notification the platform was already told about. So a provider's **dedup key is stored state built out of untrusted delivery text** and goes through the binding's redactor like everything else, keeping a residual that is stated rather than implied on `InboundNormaliser.deliveryKey` (two deliveries differing *only* inside the same injected secret collapse onto one `delivery_id`, and the **first** survives) together with the third option — a one-way digest, distinct *and* secret-free — which is measured there and filed rather than done. The check: `packages/integrations/src/providers/delivery-key-redaction.test.ts` builds every provider through its real registration with the caller's redactor disarmed and fails on a planted credential surviving into the key — and its scope is **every directory under `providers/`**, read off disk, so a new provider is covered the moment it exists. Three adapters shipped this defect before the check existed.
- **The web app never turns a string into markup.** Everything it renders — ticket text, MR comments, model output, tool results, log lines, KB documents — is untrusted (BD-022) and is rendered as React text nodes through `apps/web/src/ui/untrusted.tsx`: no markdown-to-HTML step, no sanitiser, and therefore nothing for a later transform to undo. `apps/web/src/no-html.test.ts` fails the build if a markup sink appears anywhere in the application’s sources, **or if a URL attribute is written outside `apps/web/src/ui/untrusted.tsx`** — the attribute (`href={u}`), the property (`el.href = u`, `el['href'] = u`), `setAttribute`, or a key inside a spread, `createElement`, `cloneElement` or `Object.assign` — so every URL the app renders goes through `safeHref`, which a DTO field does not: `urlSchema` is `z.url()` and accepts `javascript:`, `data:`, `vbscript:` and `file:` (Q49). The guard’s own docblock lists the spellings it catches **and the ones it cannot** (indirection through a variable, a computed attribute name, `action`/`data`/`background`); read it before assuming an attribute is covered. Dropping markdown-to-HTML is a deviation from TD-013 and is recorded as an amendment on that decision.
- **A component that throws does not blank the SPA.** Two boundaries, and they catch different things: `defaultErrorComponent` on the router (`apps/web/src/routes/tree.tsx`) contains a screen that throws inside `<main>` so the navigation stays usable, and `ErrorBoundary` in `apps/web/src/app/app.tsx` sits outside every provider as the backstop for what the router cannot see. `apps/web/src/ui/error-boundary.tsx` has the measurement that made both necessary, and `apps/web/src/app/error-boundary.test.tsx` drives the whole application with a collaborator that throws.
- **A prompt never contains untrusted text outside a data block.** `assemblePrompt`
  (`packages/domain/src/prompt/`) is the only thing that builds one, and the rule it is written to is
  one sentence: *every byte of the assembled prompt is either text the platform wrote or is inside a
  data block* — the pack, but also the ticket key, the ticket URL, a vault path, a prior artifact's
  JSON and a return-feedback string. A block is `<untrusted-data-<nonce> …>` … `</untrusted-data-<nonce>>`
  with **32 random hex characters drawn per prompt**, which replaces technical/04's older fixed
  `<ticket>` tag: a fixed tag is closed by any body that contains it. The body is **byte-identical**
  (nothing is stripped or escaped, so there is nothing for a later transform to undo — the same
  answer `apps/web/src/ui/untrusted.tsx` gives), and **nothing untrusted reaches a marker**: an
  attribute value outside `A–Z a–z 0–9 . _ - /` is refused rather than escaped, and a truncation the
  platform applies is announced as `truncated="true"` in the marker rather than as a line in the
  body (technical/07's forgeable-marker requirement). `readDataBlocks` is the reader, written
  separately and deliberately sloppier (rule 65), and it is what the tests parse an assembled prompt
  with. The residual is stated at the line: this is a guarantee about the *structural* parse, and a
  model that ignores the stated rule is not protected by any delimiter scheme.
- Prompts live in `packages/prompts/roles/<role>/` as `prompt.md` plus `evals/cases.json`; changing a
  prompt requires eval cases and bumps `ROLE_PROMPT_VERSIONS`. There is **no per-role `schema.json`**:
  `schemas/artifacts/*.schema.json` is already generated from the one zod definition, and a second
  copy is a second thing to drift. `promptVersion` carries a digest of the assembled system prompt
  beside the declared version, so an edit that forgot to bump is visible in the audit.
- Env naming: `APP_*` for platform settings, tool-native names for integration credentials, `_FILE` variants for secrets (TD-020).
- The wire format is snake_case everywhere (config YAML, event payloads, artifact data, API DTOs, transcript rows), matching technical/02, /03, /08 and /12; exported identifiers stay camelCase.
- Boundary schemas are **strict**: an unknown key is an error, never dropped. The exceptions are records with user-chosen keys (stage ids, template names, risk classes, status mapping) and opaque provider payloads.
- The dependency rule is enforced by `lint/style/noRestrictedImports` in `biome.json`: the base rule denies every `@platform/*` import and every relative path that escapes a package, and each ring's override re-allows what it may use — `contracts` nothing; `domain`/`prompts` contracts; `application` adds `domain`; `infrastructure`/`integrations` add `application` and `prompts`; `apps/*` may import any `@platform/*`. A new package is denied until it gets its own override.
- A plain Node script that needs to import TypeScript sources imports `scripts/ts-source-resolver.mjs` first (it maps the repo's `.js` specifiers to the `.ts` files on disk).
- **No literal NUL byte in a source file.** Write the separator as the escape `\0`. A NUL makes git classify the blob
  as binary: `git diff` and `git log -p` print `Bin 0 -> 3808 bytes` instead of the change, the file cannot be
  three-way merged, and `grep -rn` skips it — so the core of a fix becomes invisible to its reviewer. It happened at
  WP-05 and again at WP-10, which is why `pnpm run -s nul:check` (part of `verify`) now fails the build on one. Its
  scope is `git ls-files`; the only exemption is a path declared `binary` (or `-text`) in `.gitattributes`.
- **No merge-conflict marker in a tracked file, and no `.orig`/`.rej` left behind.** A squash merge put a whole
  conflict into *this file* at `d1e7b69` and it sat on `main` for an hour: `verify` reads no Markdown, biome and
  `tsc` never see `.md`, gitleaks has no rule for it, and the merge commit was made with `--no-verify`. It was
  found by a subagent happening to read the file. `pnpm run -s conflict:check` (part of `verify`, and a pre-push
  job) now fails on one. It always reports a line opening with seven or more `<` or `>`; it reports the `=` and
  `|` separators only *between* an opening marker and its close, because seven `=` is also a Markdown setext
  heading and seven `|` an empty table row — a guard that fires on legitimate content gets switched off. A path
  that genuinely shows a worked conflict declares `conflict-markers` in `.gitattributes` (the bare attribute);
  the script's docblock states what that trades and what it cannot see.
- Every `.gitignore` pattern is anchored to the repository root (a leading `/`) unless it is genuinely meant to match at any depth. Git matches an unanchored pattern anywhere, so `data/` once hid `apps/server/src/data/` from `git status` while every local check stayed green. `pnpm run -s ignored:check` (part of `verify`) fails the build if a source path is ignored.
- **A `pg.Pool` is built by one of exactly two factories**: `createDatabasePool` (`packages/infrastructure/src/db/client.ts`) for anything that runs, and `createTestPool` (`test/integration/support/postgres.ts`) for the test harness. Both attach the `'error'` listener a pool must have — pg-pool emits that event for a dead *idle* client, `Pool.end()` resolves **before** the removed clients' sockets are closed (`_remove` calls `client.end()` without awaiting it), and an `EventEmitter` throws an `'error'` nobody listens for — which is how CI's `e2e-fake-claude` job died on `57P01` with every test passing (PROGRESS backlog 28). The production listener reports and keeps serving; the harness one absorbs exactly `57P01` and re-throws everything else. A third construction site is refused by the census in `packages/infrastructure/src/db/pool-errors.test.ts`, whose docblock lists the spellings it cannot see.

## Where to look
- HTTP, auth and the SSE stream: `docs/technical/08-api-and-realtime.md`; the composition root is `apps/server/src/runtime.ts` and the wire contract of the stream is `apps/server/src/sse/hub.ts`.
- **The read API and the census that keeps it honest** (WP-15h): the SPA called twenty `/api/*` paths and the server registered **four**, and every tier was green because the only tier that exercises the client's list answers it with a fake backend. `apps/server/src/routes/client-census.test.ts` is the comparison — the client's half read off **every** file git knows about under `apps/web/src` (tracked *and* untracked, rule 85), the server's half a real unauthenticated request through the real router, with the endpoints that are still missing listed **in the test** with the row that owns each, an equality in **both** directions so the list cannot go stale, and the same probe doubling as the per-route auth assertion. The projections are `apps/server/src/queries/pipeline-queries.ts` and they **refuse rather than default, and never invent a field**: `runs.system_prompt`/`user_prompt` have no writer, so `/prompt` answers a typed 409 naming why instead of an empty document; `/context-pack` has **no success branch at all**, because `run_context_pack` has no column for `ContextPackRecord.budget_tokens` and stores `reason`/`score` as nullable where the record requires them — summing the rows into the budget would publish "budget equals total" as a fact the run-detail screen renders, which is what the first version did with its own test pinning it; and a `run_messages` row with a `blob_id` is refused rather than served from a `payload` that would be a stub. `run:<id>` finally has a publisher: the transcript sink announces the stored entry's **position** on the broadcast and `apps/server/src/sse/transcript-bridge.ts` reads the rows back into *its own* hub, so the process serving the stream need not be the one that ran the agent — and it reads back only for a run somebody is watching (TD-014). **Part 2 closed the seven reads the census attributed to a later iteration** — `org/agents`, `org/inbox`, `integrations`, `integrations/:id/setup-guide`, `projects`, `projects/:id/readiness` and `projects/:id/tasks` — so the admitted-gap list is now **commands only**, plus one endpoint the census is blind to by construction: `GET /api/projects/:id/kb/health` reads rows the nightly hygiene pass writes and **no screen calls it**, so a client-driven comparison cannot see it and `routes/kb.ts` asserts it by hand. The projections are four modules beside each other — `queries/{pipeline,project,integration,knowledge}-queries.ts` — and the refusal rule holds across all of them: `readiness_evaluations` has no writer, so `/readiness` answers **409 `readiness_not_evaluated`** with the row count rather than `{level: 0, criteria: []}`, which would publish "nothing passed" as a fact about the project. Two things are enforced rather than promised: `GET /api/integrations` **strips the provider's declared credential fields** from `integrations.config` before publishing it (the loader merges `{...config, ...secrets}`, so a token pasted into the column would otherwise be served) and publishes **nothing** for a provider this build does not ship, because it cannot then tell configuration from credential; and the task page's cursor carries the database's own microsecond rendering rather than a parsed `Date`, because `timestamptz` is microseconds and `Date` is milliseconds — the truncated keyset **skipped the row it came from**, measured at three tasks in, two out. `packages/integrations/src/catalogue.ts` is where a provider's read-only metadata lives (display name, secret fields, setup guide, whether it has an inbound half), separate from the registry because a read surface must name every provider an operator can configure and must never construct one.
- Pipeline behaviour: `docs/product/04-pipeline.md`, `docs/technical/02-domain-model-and-events.md`. The
  interpreter is `packages/domain/src/pipeline/` — the shipped templates as data, and a pure
  `interpret(pipeline, signal) → decision` that reads them; the sagas, the stage executor and the
  `PipelineStore` port are `packages/application/src/pipeline/`, and `createPipelineRuntime` is what a
  composition root registers. A stage runs in a `stage.execute` job, never in an event handler: the shape is
  transaction / no transaction / transaction, so no database connection is held while a run is, and the job
  worker's concurrency is **additive** to the dispatcher's `2 × concurrency + 1` pool floor. Everything a
  handler enqueues goes through `HandlerContext.afterCommit`, because `Jobs.enqueue` does not join the
  handler's transaction — and every job re-validates on fire, since a timer cannot be cancelled (TD-004).
  **The same shape covers every provider call the pipeline makes** (WP-15d): a handler *decides* and the
  `pipeline.outbound` job (`packages/application/src/pipeline/outbound.ts`) *calls*, so nothing reaches a
  provider while a transaction is open. It is refused mechanically rather than reviewed for —
  `events/open-transaction.ts` marks the handler path (in `EventBus`) and the job path (in
  `createPipelineRuntime`), and `integrations.ts` refuses both to resolve a project's bindings and to make
  the call. Two consequences to know before touching it: **ordering between the status mapping (110) and
  the workpad (120) is now the queue's, not TD-005's**, so a test that asserts both waits for both; and a
  write made from that job uses a **narrow** repository method (`tasks.saveWorkpad`,
  `tasks.saveTicketSnapshot`), because a whole-row
  `save` from a job that runs beside the stage executor is a lost update — measured, at 0.40 USD of a
  task's recorded spend.
  **The prompt gets the ticket's own words** (WP-15f): `packages/application/src/pipeline/ticket-snapshot.ts`
  reads the ticket once through `readTicket`, bounds and redacts it and stores it as `tasks.ticket_snapshot`
  (migration 0015) — at **intake**, inside the `intake_check` duty's call phase, and again from the
  `stage.execute` job when a task has none. It is deliberately **not** a fourth `pipeline.outbound` duty,
  and the module's docblock carries the ordering argument that decided it: intake enqueues the first stage
  on the line after its commit, so a duty woken by `task.created` would race the prompt it exists to fill.
  `ticket_snapshot` is the third place the platform stores untrusted external text, after `inbox` and
  `kb_chunks`; the byte budget and its derivation are stated at the caps.
  **`apps/server/src/pipeline.ts` is the production composition** (WP-15a): a project's bindings are read
  from `bindings`/`integrations` and their credentials decrypted from `secrets` by
  `packages/integrations/src/bindings/loader.ts`, which builds the adapters **per call** so the redactor can
  carry the call's run-scoped credentials (Q55). A binding that is *absent* gives `git: null`; a binding that
  *fails to load* throws (rule 20). **Since WP-15g a production `ClaudeRunner` exists**: `apps/server/src/agent.ts`
  composes `createWorkspaceClaudeRunner` over `createClaudeRunner`, with the production `run_messages`
  transcript sink and a per-run TD-012 redactor, and it takes a `RunWorkspaceProvisioner` — **never a Docker
  client**, because TD-021's amendment forbids one in any process that composes the pipeline or serves
  `/webhooks/*`, and `apps/launcher/src/docker-access.test.ts` holds that as a census over `git ls-files`.
  The provisioner is **absent by default**, and when it is absent `startRuntime` composes
  `unavailableClaudeRunner`, which **throws** and names the missing piece; that throw has an ending
  (`stage-executor.ts` fails the run it created and escalates to `needs_human` — **no new task state**, Q59),
  and a start failure is **retryable or terminal** rather than a state of its own (Q59a). Q52's remaining half
  is the out-of-process **transport**, deliberately unbuilt.
- **Production starts a ticket** (WP-15c): `POST /webhooks/:provider/:integrationId`
  (`apps/server/src/routes/webhooks.ts`) is the door, and it is the platform's only **unauthenticated**
  endpoint — the credential is the signature over the body, so the body reaches the handler *unparsed*
  through a content-type parser scoped to that route. `packages/application/src/integrations/inbound.ts`
  asks the four questions in order (which binding, is it authentic, which delivery, what does it mean) and
  writes the `inbox` row **in the same transaction as the events it produced**, which is a deliberate
  deviation from technical/06's "enqueue normalisation as a job" — amended there, because the job shape
  loses a delivery it has already recorded as performed. Three things are decided rather than incidental:
  `inbox.headers`/`payload` are stored **redacted** (GitLab's legacy scheme sends the binding's webhook
  secret as plain text in `X-Gitlab-Token`) with `redaction_count` summing the row's redactions and
  `verified` persisting the verdict a redacted payload can no longer reproduce (migration **0014**); an
  **unverified** delivery writes **no** inbox row, because a dedup key an unauthenticated caller can choose
  is a key it can poison; and authenticity is the **account's** question while meaning is the **project's**,
  so `verify` uses `integrations.config` and `normalise` runs once per binding.
  The matched ticket whose intake wake-up was lost is recovered by `pipeline.intake.reconcile`
  (`packages/application/src/pipeline/intake-reconcile.ts`), which appends a **new** `ticket.matched` —
  re-dispatching the old one is skipped by its `handler_executions` record and a redelivery is deduplicated
  by the very `inbox` row, so the recovery is **task**-shaped — bounded to one attempt per ticket by the
  system actor it stamps.
- **A run's prompt and its tools** (WP-17): `packages/domain/src/prompt/` is the assembler and the
  data-block contract, `packages/prompts/roles/<role>/prompt.md` are the shipped role prompts, and
  `createStageRunPlanner` (`packages/application/src/pipeline/planner.ts`) is what puts a **real**
  context pack into one. The stage executor's shape is now **transaction / plan / transaction**: the
  pack's four-to-six queries happen between the two, so the connection they borrow replaces the
  worker's rather than nesting inside it, and the four re-validation questions are asked twice
  (`revalidate`). `apps/server/src/platform-tools.ts` is the production `PlatformToolPort` —
  `kb_search` is real and the other eight **refuse by name**, which is why
  `PipelineComposition.runner` is a factory over the tools rather than a runner.
- **What a run costs, and what a budget stops** (WP-19): the ledger is
  `packages/application/src/cost/` — one handler on `run.finished`/`run.failed` at TD-005 priority 10
  writing `cost_entries`, `run_model_usage`, `cost_rollup_daily` and `budget_windows` in the handler's
  own transaction, so a redelivery cannot double-charge. Three rules decide what a row says. The
  entries **sum to the provider's run total** (BD-011: reported cost is truth), with the per-model
  rounding residual attributed to the run's own model rather than dropped. A cost the producer did not
  report is **priced from `price_list` and labelled an estimate**, and a model with no price row gets
  *no* ledger row and a named log line — never a zero, which would read as a free run (rule 16); the
  same applies to WP-12's `cost_unreported`, which is a fault and not an overspend. The **model id is
  the only producer string the ledger stores**, bounded at 128 characters and refused past it, because
  truncating it would merge two models onto one key. Org and project budgets stop a *new* run through a
  **read at admission** (`cost/guard.ts`, asked by the stage executor), not through a handler on
  `budget.exhausted` — those events are notifications and stay declared unconsumed; the **task** cap
  stays the executor's own check against project configuration. A window is identified by its start
  instant in the organisation's timezone, so a rollover needs no job. `events/replay.ts` is the
  **backfill**: it reads a range of the append-only `events` table (never `event_dispatch`, whose row a
  completed dispatch deleted) and claims `(position, handler)` in `handler_executions` exactly as the
  dispatcher does, which is what lets a handler registered today be served events swept last month, and
  makes a second pass a no-op.
- Runner and hooks: `docs/technical/04-agent-runtime.md`; isolation: `docs/technical/05-workspaces-and-security.md`. The run shim `agentic-runlet` (TD-025) is `packages/infrastructure/src/runlet/` — frame protocol in `@platform/contracts`, shim, runner-side `SpawnedProcess`, credential helper — with `apps/runlet` as its entrypoint and nothing else; `node scripts/runlet-container-check.mjs` is its Docker verification (not a `verify` target: it needs a daemon), written up in `docs/research/12-run-shim-verification.md`.
- Data: `docs/technical/03-data-model.md`. UI: `docs/technical/09-ui-architecture.md`; the SPA's composition root is `apps/web/src/app/app.tsx`, the client half of the SSE contract is `apps/web/src/realtime/client.ts`, and the untrusted-text rules are `apps/web/src/ui/untrusted-text.ts`. Work plan: `docs/technical/13-implementation-plan.md`.
- Open questions: `docs/OPEN-QUESTIONS.md`; verification backlog: `docs/TODO.md`.
- Autonomous implementation: protocol `docs/technical/14-orchestration-protocol.md`, ledger `docs/technical/PROGRESS.md`, roles `.claude/agents/{implementer,reviewer,architect}.md`.
