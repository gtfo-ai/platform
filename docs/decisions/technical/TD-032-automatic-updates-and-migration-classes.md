# TD-032 — Automatic updates: every migration is `additive` or `contract`, an older build accepts an all-additive schema, a mandatory pre-update backup, and one updater with three modes (self-managed core, externally managed core, worker)

- **Status:** accepted
- **Date:** 2026-11-04
- **Deciders:** architect (session 21), within BD-032 decisions 9–11 (the product owner's, 2026-11-04, including the Autix deployment input)
- **Relates to:** BD-002, BD-003, BD-020, BD-032, TD-006, TD-011 (amended), TD-017, TD-018, TD-019 (amended), TD-021, TD-028, TD-031, technical/11, research/17, Q125, plan § "Milestone M22"

## Context

Read at `da2e2ed6`; nothing here was run.

- Migrations are forward-only SQL files applied by the `migrate` one-shot under an advisory lock
  (TD-011, TD-019); `assertSchemaIsKnown` (`packages/infrastructure/src/db/migrator.ts:329-338`) refuses
  to start a build on a database carrying any migration it does not know. So today **no** automatic
  update can be rolled back by code: the previous build refuses the new schema by construction.
- Every push to `main` is a release and `latest` is the newest push (TD-019's 2026-09-16 amendment); the
  registry's `latest` can therefore be ahead of a given core.
- `db-backup` exists under the `backup` profile (`compose.yml:482-508`); the operator guide's upgrade
  section already asks for a pre-upgrade `pg_dump` by hand (`docs/operator-guide.md:759-765`).
- The first production core is a Docker Swarm stack deployed by an infra repository's CI with the tag
  pinned there, and no Docker socket on the server (BD-032 Context, decision 10).
- research/17 §§ 4–6: the socket proxy filters by API path only (no label or project scoping); Compose
  recreates a container as *create temp → stop old → remove → rename*, so a container cannot recreate
  itself; a tag resolves to a digest by an anonymous `HEAD` on GHCR.

## Decision

### 1. Two migration classes, declared in the file

Every new file under `packages/infrastructure/src/db/migrations/` opens with one header line:
`-- migration-class: additive` or `-- migration-class: contract; expands: <NNNN_name>`.

- **`additive`** — *the previous release's code works on the schema after it and on every row the new
  release writes.* Admitted statements (checked mechanically): `create table`, `create index` (never
  `concurrently`: the migrator applies each file inside one transaction, `migrator.ts:247-257`, where
  `create index concurrently` cannot run — a non-transactional migration mechanism is not built in M22),
  `alter table … add column` that is nullable or has a default, `add constraint … not valid` and the
  `validate constraint` that completes it (old code writes no row the constraint refuses, or the
  validation fails the migration and the running build carries on — step 4 below), `create or replace function`/`view` that keeps the old signature, `grant`, `comment`, and
  `alter type … add value` **only when** the value already exists in `packages/contracts` at the
  migration's base commit (an enum value the previous build cannot parse is a contract change — e.g.
  TD-031's `rate_limited` lands in contracts one release before the migration that adds it).
- **`contract`** — anything else (drop, rename, type change, `not null` on an existing column, data
  rewrite). It names the `additive` migration it completes (`expands:`).
- The migrator records the class in a new `platform_migrations.class` column at apply time (the column is
  added by migration **0092**, itself additive). Rows applied before it carry `null`, read as `contract`.
- **CI check** `pnpm migrations:check` (a step of `verify:static`): every new file has a valid header;
  an `additive` file contains only admitted statements (a conservative statement scanner; anything it
  cannot classify fails, with the escape being `contract`); a `contract` file's `expands:` migration
  **exists at the push's base commit on `main`** — so the expand was released by an earlier push (every
  push is a release, TD-019) and the contract can never land in the same release as its expand; applied
  files are never edited (already TD-011's rule, now checked by digest against the base).

### 2. The schema guard accepts an all-additive future

`assertSchemaIsKnown` becomes: unknown migrations **all** with class `additive` → start, log
`schema_ahead_additive` naming them, and `/readyz` reports `schema: ahead_additive` (200); any unknown
migration with class `contract` or `null` → `DatabaseSchemaAheadError` as today. This is what makes a
code-only rollback possible. **It protects only builds that contain it**: the first build with the
amended guard is the oldest build an automatic rollback may target; the updater refuses to roll back
past it (it reads the target's guard version from the image label `org.platform.schema-guard=2`).

**Additive is a statement-level property; a rollback also needs a behavioural one.** A schema can be
additive while the *rows* the newer build wrote mean nothing to the older one (after TD-031's WP-276,
`created` runs carry offers that a WP-272–275 build never claims), and `runMigrations` also upgrades the
pg-boss schema, which no migration class sees. So every image carries two more labels, and the updater
**refuses a code rollback past either**:

- `org.platform.rollback-floor=<n>` — an integer **raised by every row that changes what existing rows
  mean to the runtime** (M22: WP-274, WP-276, WP-285, WP-286; a later row raises it when its review says
  so, and `migrations:check` fails a migration whose header says `raises-rollback-floor` without the
  label moving). A rollback from build B to build A is admitted only when `A.floor = B.floor`.
- `org.platform.pgboss-schema=<version>` — the pg-boss schema version the build's `runMigrations`
  installs; a rollback is admitted only when it is equal.

A refused code rollback is `failed_needs_operator` with the backup (decision 5 step 7), exactly as for a
contract migration. In `external` mode the same three labels are printed by `migrate --plan` so an
operator re-pinning a tag can read whether the guard and the floor admit it.

### 3. The core's own digests, and what it serves to workers

The core learns its own image digests by resolving `sha-<own 7-char commit>` for `platform`,
`platform-launcher`, `platform-runtime` and `platform-egress` in `APP_IMAGE_REPOSITORY` (default
`ghcr.io/<owner>`) with the anonymous OCI `HEAD` (research/17 § 6), cached for the process' life;
`APP_WORKER_IMAGE_DIGESTS` overrides it for a mirror or an air-gapped registry. `GET
/api/worker/v1/release` answers **digests and the protocol range only** (no compose file); it answers a
typed `503 digests_unresolved` naming the image when resolution fails. **Workers follow the core, never
`latest`.** This works identically in every core mode, including externally managed.

**The core chooses which build; it cannot choose what a build is.** A worker's updater is root-equivalent
on the developer's machine (decision 4), so whatever it applies must not be the core's choice of bytes:

- the worker verifies every advertised digest's **build attestation** (image.yml attests each build,
  TD-017) against an identity configured **on the worker**, not served by the core:
  `APP_TRUSTED_IMAGE_REPOSITORY` (e.g. `ghcr.io/<owner>/platform`) and `APP_TRUSTED_BUILDER` (the
  repository and workflow, `<owner>/<repo>/.github/workflows/image.yml`, ref `refs/heads/main`); a digest
  whose attestation does not verify is refused and reported, and nothing is pulled into service;
- the worker applies **digests only**; the compose template is read **from the verified new `platform`
  image** (`/opt/platform/compose.worker.yml`), never from the core. `GET /api/worker/v1/compose.yml`
  still renders that template pinned by digest **for the first install** (BD-032 decision 9: a person
  downloads it, reads it and runs it), but no updater ever applies a file the core served;
- the verification tool and its offline trust root are the row's to measure (`[unverified]`, TODO V-WM6);
  a worker without a verifier refuses to self-update and says so.

**Residual, stated:** a compromised core can steer workers to **any** attested build of the trusted
workflow — including an older one with a known defect (a downgrade) — but not to an arbitrary image. The
worker refuses a downgrade below the build it runs unless the core's protocol range excludes it, and logs
every change. The core in `self` mode verifies its own pulls the same way.

### 4. One updater component, three modes

`ROLE=updater` in the `platform` image; the Docker CLI and the Compose plugin are added to that image,
pinned by checksum and declared in `THIRD_PARTY_NOTICES.md`'s table (≈ 78 MB, research/17 § 5 — the
row measures the image-size delta against TD-018's budget and states it). `APP_UPDATE_MODE`:

- **`external`** — the core is deployed by something else (Swarm, Kubernetes, an infra repository
  pinning tags). **No updater runs and nothing touches Docker.** The core only advertises its digests
  and protocol range (decision 3). The migration classes and the guard still hold: the deployment runs
  the `migrate` one-shot before the app (the Swarm reference does it as a `replicated-job` or a CI step,
  M22 WP-289), and a rollback is the operator re-pinning the previous tag, which the guard admits when
  everything since is additive. This is the Autix deployment.
- **`self`** — the shipped `compose.yml`'s default (BD-032 decision 10: always automatic). Decision 5.
- **`off`** — development and CI (`pnpm dev`, the test tiers); nothing polls.
- **`worker`** — set by `compose.worker.yml`. Decision 6.

**Docker access.** The updater talks to Docker only through its **own** socket-proxy instance on an
`internal: true` network only it and the apply container join, with `CONTAINERS NETWORKS VOLUMES IMAGES
INFO POST` (research/17 § 5; whether Compose works through the proxy is measured by the row's Docker
check, TODO V-WM2). **Scoping to its compose project is a code property, not a proxy property** — the
proxy cannot filter by label (research/17 § 4) — so the updater is root-equivalent on its host exactly as
the launcher already is (TD-021's residual), and the record says so. Every Compose call passes
`--project-name` explicitly.

**The apply container.** Because Compose cannot recreate the container that runs it (research/17 § 5),
the long-running updater never applies anything itself: it starts a labelled one-shot container from the
**new** `platform` image (`ROLE=update-apply`, `--rm`, outside the compose project) that performs the
sequence below, recreates the updater last, and exits. A crashed apply leaves `updates/state.json`
naming its step; the next updater start resumes or rolls back from it.

**Where digests are pinned.** The shipped `compose.yml` and `compose.worker.yml` name the four product
images as `${PLATFORM_IMAGE}`, `${PLATFORM_LAUNCHER_IMAGE}`, … The updater owns a marked block of those
lines in `.env` (atomic write; the previous block kept as `.env.previous`), so an operator's own `docker
compose up` keeps working and keeps the pinned digests.

### 5. Core mode `self`: the sequence

Polls the registry for `APP_UPDATE_CHANNEL` (default `latest`; `X` once TD-019's versioning switch is on)
every 15 minutes; a new digest starts an apply (one at a time, never while a previous one is unresolved):

1. **Pull** the four new digests and verify their attestations (decision 3). Failure → abort, nothing changed.
2. **Plan**: run the new image's `migrate --plan` (read-only) → pending migrations with classes. A pending
   `contract` migration whose `expands:` the **running** build does not contain (an instance that skipped
   releases) means the running build may use what it drops: the platform services are **stopped before
   migrate** (downtime, stated in the update record) instead of serving through it.
3. **Mandatory backup**: `pg_dump -Z1` from a one-shot `postgres:18@<db's digest>` container on the db
   network (the operator guide's own command, as a container) into the `backups` volume as
   `pre-update-<from7>-<to7>-<ts>.sql.gz`; it must exit 0 and be non-empty. Failure → abort. Kept for the
   last 5 updates.
4. **Migrate** with the new image's `migrate`. Failure → the transaction of the failing file rolled back;
   if everything applied before it is additive the running build carries on (it was never stopped unless
   step 2 said so) → `failed_migration` recorded, the instance stays on the old digests.
5. **Recreate** `app`, `runner`, `launcher` with the new digests (`docker compose up -d --wait
   --wait-timeout 120`). The server runner's in-flight runs are handed back (WP-144); remote runs survive
   on their 10-minute lease (TD-031 decision 9).
6. **Check** within 120 s: `/readyz` 200 on `app` (and `runner` when composed) and `/api/version` reports
   the new commit.
7. **Unhealthy** → if every migration applied in step 4 is `additive`, the old build carries the
   amended guard, and its `rollback-floor` and `pgboss-schema` labels equal the new build's (decision 2): recreate with the previous digests (`.env.previous`), check again, record
   `rolled_back`. Otherwise record `failed_needs_operator` with the backup's file name and § 6's restore
   block, and **do not restore automatically** (**Q125**; the residual below).

The apply writes each step to `updates/history.jsonl`; the core, on start, ingests unrecorded lines into
`instance_updates` and appends `instance.update.started/succeeded/rolled_back/failed` events (BD-003) and, for `failed_needs_operator`,
posts to the organisation's communication account through `IntegrationActionExecutor` (the WP-65 shape) —
so the updater needs no database credential. Settings → *Updates* (admin) renders them; metric
`instance_update_last_result`.

### 6. Worker mode: the sequence

The worker's updater polls the core's `release` every 5 minutes *(amended 2026-11-06: at start, then every
minute, backing off on failure — see the amendment at the end; and, amended the same day, with no
credential while the worker holds none, its reports deferred until it does)* and on every `426` the worker
reports. A different set of digests, each verified (decision 3) → it asks the worker process (local `POST /internal/drain` on the
worker's own compose network, never published) to stop claiming, waits until it reports **idle** (no run
held), then the apply container (from the verified new image, carrying its own template): pull the verified images (including the run and egress images, so the
launcher never pulls at create), rewrite the managed `.env` block, `up -d --wait --wait-timeout 120`,
and check: the worker's `/readyz` reports `core_handshake: ok` within ~120 s. Failure → previous block,
`up -d`, report `rolled_back` via `POST update-report`. A worker holds no durable state (BD-032 decision
9); its mirror cache and workspace volumes are disposable, so a worker never migrates anything.

### 7. Protocol N-1

`WORKER_PROTOCOL_VERSION` (integer, `packages/contracts`) is independent of the build. The core accepts
`[N-1, N]`; a change ships *expand → contract*: the release that adds a field or verb accepts both
shapes, and the release that removes the old one bumps `N`. **CI check** (`pnpm protocol:check`, part of
`verify:static`): a bump of `WORKER_PROTOCOL_VERSION` is refused when the base commit's value differs from
the value one release earlier — no two bumps in consecutive pushes. A run claimed under `N-1` keeps being
served under `N-1` until it ends; a worker at `N-2` gets `426` on everything, including a run in flight,
which therefore ends `lease_expired` and is re-offered once (TD-031 decision 12) — the stated cost of two
bumps inside one run's life.

## Rationale

The classes turn the owner's "always automatic" into something with a bounded failure: most releases add
tables and columns, and for those an unhealthy update is undone by the previous image alone. A contract
release is still applied automatically, which the owner chose knowingly; its residual is written down
rather than designed around. One updater with modes keeps one mechanism to test; the external mode exists
because an orchestrator that owns the deployment must not be fought by the thing it deploys. The apply
container sidesteps the one Compose behaviour (self-recreation) that makes every in-container updater
unreliable, and no maintained compose-aware updater with rollback exists to adopt (research/17 § 5).

## Alternatives considered

- **Approval before a contract migration** — the owner rejected it (BD-032 decision 10).
- **Watchtower or a fork** — archived upstream; no rollback, no migration step (research/17 § 5).
- **Edit the operator's `compose.yml` in place** — rejected: the operator's own file; the `.env` block is
  smaller and reversible.
- **Down-migrations** — rejected: TD-011 is forward-only for a reason (data loss in a reversal is silent);
  the additive class gives the same rollback for the common case without writing reversals.
- **The updater with a database credential** — rejected: the history file plus ingest-on-start keeps the
  Docker-holding container away from the data.

## Consequences

- **The residual of BD-032 decision 10, stated:** a `contract` release applies automatically; if it is
  unhealthy, the only rollback is restoring the pre-update backup, which loses every write since the
  backup (normally the minutes of the failed update, but an operator who finds it hours later loses
  hours). Forward-only migrations and the guard mean no code-only path exists. The updater does not
  restore by itself (Q125).
- Two CI checks (`migrations:check`, `protocol:check`) join `verify:static`; `docs/technical/14`'s target
  list and `scripts/verify-targets.ts` gain them.
- `compose.yml` gains `updater` and `updater-docker-proxy`; image references become variables; the
  operator guide's § 5 *Upgrade* is rewritten for `self` and `external`.
- The docker-socket-proxy pin (0.3.0, 2024-09-09) is two minor releases behind v0.5.0 (research/17 § 4);
  the updater row pins the same version as the launcher's proxy and files the bump as backlog.
- To verify (TODO V-WM2, V-WM5): Compose through the proxy with the six flags; Swarm `replicated-job` for
  the reference stack's `migrate`.

## Amendment (2026-11-04, architect, session 21) — decision 1's list ruled: what "a table this file creates" admits, a `not valid` constraint narrowed, triggers on a new table (PROGRESS backlog 690, 691)

Read at `369b38f0` with WP-273 uncommitted in the tree; nothing was run. The scanner read is
`packages/infrastructure/src/db/migration-scanner.ts` as WP-271 landed it after three review rounds.

### A. The same-file rule is decision 1's, and its precondition is the scanner's forgery refusals (691)

WP-271's scanner admits three things decision 1 did not list, each only on a table the **same file**
creates: `create unique index`, a validated `add constraint` (check, `primary key`, `unique`,
`exclude`, foreign key), and `insert into platform_table_policy` registering that table. **All three
are admitted, and are now part of decision 1**, because their reach is the new table's own rows and the
previous build writes none (it was compiled without the table) — with one exception, ruled in B.

**The precondition is that "this file creates it" cannot be forged.** The rule holds only together with
the refusals WP-271's review rounds added, which are hereby part of the decision rather than of a
docblock: a table counts as this file's only from a plain `create [unlogged] table <name>` — never
`if not exists` (it may create nothing), never `temp`/`temporary` (it shadows a permanent table for the
session), never a `partition of` or `inherits` child (the previous build's inserts into the parent route
into it), never `create table … as` (it runs a query); a call to any routine this file or an earlier
migration declares is refused wherever a call is evaluated at migration time, and a routine named like a
member of `PURE_CALLS` is refused (overload resolution is PostgreSQL's). Weakening any of these
re-opens decision 1 and needs an amendment here.

**The registry insert, measured off the tree** (backlog 691 asked what an older build does with a
`platform_table_policy` row naming a table it was not compiled with). The rows are read by **three SQL
functions of migration 0001**, whose bodies are the database's, not the image's, so the older and the
newer build run the *same* code over the row:

| reader | what it does with a row for a table the running build does not know |
|---|---|
| `platform_ensure_partitions` (0001; called by `partitions.ts` from the daily `db.partitions.maintain` job and by `migrator.ts` after migrating) | creates that table's monthly partitions when `partition_column` is set — the table exists because the same file created it, so the older build's cron keeps the newer table insertable, exactly as the newer build would |
| `platform_drop_expired_partitions` (0001; `partitions.ts`) | drops expired partitions of rows whose `retention_scope` equals the one scope the code passes (`transcripts`); a new table registered under it is purged by either build alike; a **new** scope is read by no older code, so its retention is not applied (data kept — the fail-safe direction) |
| `platform_apply_grants` (0001; `migrator.ts`, at migrate only) | applies the row's `app_access`; an older build's `migrate` (an `external` re-pin) re-applies the same grants. **Without** the row the table reads as `read_write`, so the registry row is what keeps a new `append_only` table append-only under any build — a reason to admit the insert, not to refuse it |

The TypeScript side: `migrator.ts` also runs `update platform_table_policy set retention_days … where
retention_scope = 'transcripts'` (applies to a new row of that scope as the newer build would);
`maintenance.ts` only schedules `partitions.ts`; `task-audit.ts` and `onboarding-queries.ts` **name the
table in docblocks and query nothing** (grep, no query site); the Drizzle `platformTablePolicy` has no
query site outside its schema file. **No reader enumerates registry rows against a compiled table
list**, so an unknown row is tolerated by every reader. The insert stays admitted only as WP-271 built
it: an explicit column list including `table_name`, `values` rows of literals only (no `on conflict`, no
`select`, no expression), every `table_name` a table this file creates.

### B. A foreign key's reach is the parent too: a reference to an existing table names its `on delete`

A foreign key on a new table constrains the **referenced** table: with the default `no action` (or
`restrict`), a row the newer build wrote in the new table makes the previous build's `delete` of the
parent row fail — after a code rollback, indefinitely. Production code deletes from `bindings`,
`budgets`, `command_idempotency`, `secrets`, the `kb_*` index tables, `event_dispatch`,
`task_duty_leases` and `held_connection_liveness` (grep of `apps/` and `packages/`, test files excluded),
and that set grows without anyone re-reading old migrations. So, in an `additive` file, **every reference
to a table the file did not create** — inline in `create table`, inline in `add column`, or an `add
constraint … foreign key` — must state `on delete cascade` or `on delete set null` (or `set default`);
`no action`/`restrict`/absent is refused with the reason, and `match full` is refused. A reference to a
table the same file creates needs nothing (the previous build never deletes from it). `on update` is not
checked: no platform code updates a primary key (stated, not enforced). This amends decision 1's
"`create table` always": it is now *always, subject to B*.

### C. `add constraint … not valid` on an existing table is additive only over columns the same file adds (the reviewer's minor)

Decision 1's parenthetical — *"old code writes no row the constraint refuses, or the validation fails
the migration"* — is wrong in its first half: PostgreSQL exempts only the **existing** rows from a `not
valid` constraint and enforces it on every later insert and update. Migration 0038 is the house's own
proof: its `not valid` check exists precisely so that *"a writer that omits the column from here is
refused by the database"* (`0038_artifact_redaction.sql:32-34`) — under decision 1 as written it would
have read `additive`, and the previous build's artifact inserts would have failed from the migration
until the recreate and, after a rollback, for good. Ruling:

- **Admitted** (`additive`): `add constraint … check|foreign key … not valid` on an existing table **only
  when every column it names was added earlier in the same file** as nullable with **no default** — so
  every row the previous build writes carries null there — and, for a check, when its expression is
  **null-propagating by construction**: each atom compares exactly one such column with literals (`=`,
  `<>`, `<`, `<=`, `>`, `>=`, `in`, `not in`, `between`, `like`), atoms joined by `and`, `or` and
  parentheses; `is`, a prefix `not`, `coalesce`, `nullif`, `case`, `distinct`, `any`/`all`, a literal on
  both sides of an atom, and every call are refused. Then a null column makes every atom null and the
  check passes, whatever the newer build writes. This is 0092's own shape (`check (class in
  ('additive', 'contract')) not valid` over the column it adds), which stays admitted. Its
  `validate constraint` stays admitted.
- **Refused** (`contract`): any other `not valid` constraint on an existing table — one naming a column
  that existed before the file, or a check the reader cannot show to be null-propagating. Shipped as
  expand → contract with **check-migrations rule 4 unchanged**: the push whose code stops writing the rows
  the constraint will refuse carries a one-statement `additive` marker migration (`comment on column … is
  '<the rule the code now holds>'`), and the later `contract` file adding the constraint names it in
  `expands:`. The marker costs one file and gives the rule a release to name.

**Consequence for M22's plan.** WP-280's planned `runs.worker_id` foreign key `not valid` + `validate`
is over a column WP-274's 0094 would have added — refused under C. So `runs.worker_id` and
`run_offers.worker_id` move from WP-274's migration to WP-280's, added there as nullable columns with an
inline `references workers` (a table that file creates, so B asks nothing): admitted, and every row a
WP-274–WP-279 build writes is null there, which it is anyway (only a remote claim sets it, WP-281).

### D. `create type`, `create sequence`, `create trigger` (690)

- **`create trigger` (and `create constraint trigger`, `create or replace trigger`) — admitted on a table
  the same file creates**, under A's precondition. A trigger fires only on writes to its table; the
  previous build never writes the new table, and the only insert an `additive` file may make is A's
  registry row, which is never into the new table. The trigger's function may be new or earlier; its
  `execute function f()` is not a migration-time evaluation, so the call refusal does not apply to it.
  This admits the useful cases (an append-only guard, a `pg_notify` such as TD-031 §8's `run_offers`
  wake-up) without a `contract`. A trigger on an **existing** table is refused (it changes what the
  previous build's own writes do), and `create event trigger` is refused (it fires on DDL anywhere).
- **`create type` (enum, composite, range) and `create domain` — stay refused.** The house style since
  0002 is a `text` column with a `check` inside `create table` (0081:13, 0092:23), which A admits and
  which is as strong at the write. A new enum *type* would make every later value an `alter type … add
  value` with its contracts-one-release-earlier dance, and a removed value a `contract` that recreates the
  type; text + check evolves by `add constraint … not valid` (C) instead. The trade, stated: a migration
  that genuinely needs a type pays `contract` once; no planned M22 migration does (backlog 690's census).
- **`create sequence` — stays refused.** A sequence's only use is `nextval()` in a default; on an
  existing table that is a non-pure call the scanner already refuses, and on a new table `generated …
  as identity` (or `serial`) inside `create table` is the idiom and is admitted. No migration in the
  history creates one. Admitting it would add a scanner row with no caller.

### E. Who builds it, and how it is checked

The scanner is matched to A–D by **WP-274's criterion (0)**, before its own migration (the first
table-creating migration of M22, and the first with references to existing tables): one test row per
ruling — admitted and refused — each with a canary that is killed (B's `no action` reference admitted;
C's existing-column `not valid` admitted; C's `is not null` check admitted; D's trigger on an existing
table admitted). The scanner's docblock table is replaced by a pointer to this amendment plus the table
as amended. Applied files are not re-scanned (they are never edited, TD-011).

## As built (2026-11-05, WP-287, S-22.10) — V-WM6 measured, and what decision 6 left to the row

Recorded by the implementer; nothing here changes a decision above. Each point is the shape the code
took where decisions 3, 4 and 6 left a choice, so a reviewer can refuse it by name.

1. **V-WM6, measured** against `ghcr.io/gtfo-ai/platform:sha-640ca6a` (anonymous):
   `attest-build-provenance` stores a Sigstore bundle v0.3 (DSSE, SLSA provenance v1) as an OCI
   referrer of the manifest-list digest; GHCR answers the referrers API `404` and serves the OCI 1.1 tag
   fallback `sha256-<hex>`. `gh attestation verify` refuses to run without a GitHub token; `cosign`
   3.1.4 is 136–146 MB per architecture. **The verifier is sigstore-js** (`@sigstore/verify`,
   `@sigstore/bundle`, `@sigstore/tuf`: 2.2 MB of `node_modules` added to the image, measured by `du`),
   in-process; it verified the real bundle and refused it with a wrong workflow in the identity. **The
   offline trust root** is the Sigstore public-good TUF root `@sigstore/tuf` embeds; the verifier
   refreshes `trusted_root.json` through TUF at `tuf-repo-cdn.sigstore.dev` (BACKLOG 899), and
   `attestation.test.ts` verifies the recorded bundle offline against the seed. Checked for each digest,
   as `gh attestation verify --repo --signer-workflow --source-ref` does: the certificate chain to
   Fulcio, an SCT, Rekor inclusion; the certificate identity equal to `https://github.com/<APP_TRUSTED_BUILDER>`
   with GitHub's OIDC issuer; its **source repository** and **source repository ref** extensions; the
   statement's subject (repository **and** digest); the provenance's workflow (repository, path, ref);
   and the provenance's commit equal to the certificate's source repository digest.
   **Keyless only.** The first version also had a keyed path (`APP_TRUSTED_ATTESTATION_KEY`); the
   orchestrator's ruling on PR #38 removed it — a second trust root decision 3 never decided. A fork
   or an offline worker that needs one goes to the architect (BACKLOG 951). The Docker check, which
   cannot mint a Fulcio certificate, replaces the signature module in **its own** images only.
2. **The four repositories** are `APP_TRUSTED_IMAGE_REPOSITORY` and its `-launcher`, `-runtime`,
   `-egress` siblings; the core still names digests only.
3. **A build is its commit, and the downgrade bound reads the log.** The four advertised images must
   name **one** non-null commit, or the set is refused (a core cannot pair the running `platform` with
   an older attested launcher). The running set is verified the same way. The same commit is never a
   downgrade; two commits are ordered by the earliest Rekor `integratedTime` of each set's four
   attestations. A set that cannot be ordered (an unattested running build) is refused the same way
   (BACKLOG 898 for the re-run residual).
4. **A refusal is reported** as `update-report` `failed` with the reason in `detail` — a signature,
   certificate, bundle or statement that does not verify, a mixed set, a downgrade, no verifier — once
   per advertised set; the contract's three results are kept. **A failure that is not a refusal** — a
   registry that does not answer or answers `5xx`, bytes that do not hash to the digest asked, a trust
   root that cannot be fetched — is reported nowhere and asked again at the next poll; a refusal
   re-reads the trust root next time (a key rotation the cached root predates). The core records each
   report as a `human_actions` row `worker.update` under the worker's user (the shape `worker.pause`
   with `via: worker_internal_drain` already has), so WP-287 needs no migration; `GET /api/workers`
   answers the newest as `last_update` (BACKLOG 895, 954).
5. *(Superseded by the 2026-11-05 decision-4 amendment below: the folder is mounted at a fixed path.)* **The env file** is the one compose recorded on the project's containers
   (`com.docker.compose.project.environment_file`), else `<project dir>/.env`, and must be inside the
   project directory, which the apply container mounts **at its host path**. Values the first `up` took
   from the shell (the Claude token) are carried from the running containers' environment into
   `docker compose`'s process environment — never a file or an argument. `.env.previous` is `0600`.
   *(Amended 2026-11-06: only a variable the template declares with no non-empty default is carried —
   see the carried-values amendment at the end.)*
6. **Order**: verify all four → one commit → downgrade bound → pull the four (a failure drains nothing)
   → drain → wait for idle with no deadline → the apply. The updater writes its own template to the
   `updates` volume as the rollback's. The apply brings up every long-running service except `updater`
   and `updater-docker-proxy` (it talks through the latter; BACKLOG 897), checks `core_handshake`
   **and** that `remote-worker` runs the new reference, reports, then recreates the updater. A
   rollback (and the rollback of a crashed apply) **restarts `remote-worker`** after its `up`, so a
   worker the failed `up` never recreated does not stay drained; an owner's *Pause* survives it.
7. **Decision 2's labels do not apply in worker mode.** `schema-guard`, `rollback-floor` and
   `pgboss-schema` bound a **core's** code rollback over its database; a worker has no database and
   migrates nothing (decision 6), so its rollback reads none of them. WP-288 reads them.
8. **No core URL yet, no updater work.** The updater's `APP_CORE_URL` is optional (the core's rendered
   file defaults it to the core, as the worker's): unset, it idles and says so, for S-22.17's first-run
   page, which may start a worker before a core is known (BACKLOG 955).

## Amendment (2026-11-05, orchestrator-authorised, S-22.21) — decision 4: the updater keeps the install folder current, through a mount at a fixed path

**Decision 4 holds on every OS**: the install folder always holds what runs. The owner's rule is
"auto-update always", and a person's own `docker compose up` in that folder must never bring back an
older build.

1. **The folder is mounted, never parsed.** `compose.worker.yml` mounts the install folder into the
   updater at a fixed container path: `${APP_WORKER_BUNDLE_DIR:-.}:/var/lib/platform/host-bundle`.
   Docker resolves the source, including a `C:\…` folder on Docker Desktop for Windows. The updater
   hands the source Docker reports for that mount back to Docker for the apply container's own mount.
   No apply reads a host path off a label (`com.docker.compose.project.working_dir`), so *As built* §5's
   same-path mount and its `/`-only rule are gone (BACKLOG 990).
2. **Applying writes the folder back.** The apply renders the new build's compose file from the
   template the verified new image carries, for the new digests and the core's URL. It writes that
   file atomically over the folder's own compose file (`compose.yaml`, or the name already there) and
   pins the managed block of the folder's `.env`, keeping the person's own lines. It then runs Compose
   with `--project-directory /var/lib/platform/host-bundle` and the fixed `--project-name`, and hands
   the mount's source back as `APP_WORKER_BUNDLE_DIR`. So the folder on disk is always what runs, and
   a setting a newer template reads for the first time is read from the folder's `.env`. The file
   rewritten is the one Compose recorded it ran (only its name is read off the label), else the
   first of Compose's default names that **is a worker bundle**; another project's `compose.yml` in
   the folder is never touched. A git checkout (a folder holding `.git`) is never rewritten, because
   its files are tracked: only its `.env` is pinned and the image's template runs.
3. **Rollback source.** Before writing, the previous compose file is kept in the `updates` volume
   (`previous-bundle/<update id>/`) and the previous `.env` beside it in the folder (`.env.previous`).
   A rollback puts both back byte for byte and brings the project up from them. The image template the
   old updater writes to the volume stays only as the last resort, for an apply that crashed before it
   kept anything.
4. **Ownership is the installer's marker.** An installer recognises its own install by the file it
   writes into the folder (`.agentic-worker-install`, holding the core's URL), never by the
   `working_dir` label, which names `/var/lib/platform/host-bundle` after the first update. A folder
   without the mark is a new install, so any project of the name already on the machine is someone
   else's and refused. The label is read for one thing only: a marked folder still refuses a project
   whose label names a different host folder outright (another install of the same name).
5. Verification, the downgrade bound, drain-then-idle and the report are unchanged. A plan from an
   older updater (the folder mounted at its host path) applies as before. The only refusal added is
   for an updater with no `host-bundle` mount, a compose file that predates this, and it names the
   fix: download the compose file again.

## Amendment (2026-11-06, owner) — decision 6: the worker's updater asks at start and every minute, and backs off on failure

**Why.** A worker installed during a deploy started one build behind its core, and the Add-a-worker
wizard said "It has an older build than this platform" for about 7 minutes (installed 08:47 UTC, the
update finished 08:54) before its updater applied the update. The owner: updates should land faster.

1. **At start, then every minute.** The updater asks the core's `release` at once when it starts (after
   the start-up recovery), as before (the loop already polled before its first wait; a test now holds
   it), and then every `APP_UPDATE_POLL_SECONDS`, whose default is now **60** (was 300). The variable and its bounds (1 to 86400 s) are unchanged; a `426` still wakes
   a poll at once. The request is one small `GET`, and verification is not repeated by it: the
   attestations are read only when the advertised digests differ from the running ones, and a set
   that verified is **remembered by its digests**, so a poll that answers the same set again (after a
   pull that failed, say) does not verify it again. The running set's build is read once, as before.
2. **A failed poll backs off.** A poll the updater will ask again later — the core did not answer or
   answered something other than its release, refused the worker's credential, a registry or Sigstore's
   trust root did not answer, or the verified images could not be pulled — doubles the wait before the
   next (60 → 120 → 240 → 300 s), capped at **5 minutes** (or at the configured interval, when an
   operator set a longer one), so a broken core is not asked every minute. The first poll that works
   resets the wait to the interval. A refusal (an attestation that does not verify, a downgrade) is not
   a failed poll: it is settled for that set, as before.
3. **What did not change.** Drain-then-idle, the apply and its rollback, the report and the downgrade
   bound are as decision 6 and the amendments above state. The time a worker takes to update is still
   bounded below by its run in flight, which it finishes first.
4. **An apply that did not end `succeeded` is a failed poll.** When the apply container ends and
   `updates/state.json` does not read `succeeded` for that update — rolled back, failed, or unreadable —
   the poll backs off, so a state the updater cannot read never drains and applies again every minute.

As built: `apps/server/src/updater/updater.ts` (`nextPollDelayMs`, `MAX_POLL_BACKOFF_MS`, the loop in
`run`), `config.ts` (`DEFAULT_UPDATE_POLL_SECONDS = 60`), `compose.worker.yml`'s default, and the tests in
`apps/server/src/updater/updater.test.ts`.

## Amendment (2026-11-06, orchestrator-authorised) — As built §5: carry only the values the template has no default for

**Why.** After `compose.worker.yml`'s default became `APP_UPDATE_POLL_SECONDS: ${APP_UPDATE_POLL_SECONDS:-60}`
(was `:-300`), an updated worker's updater still ran with `300`, though its `.env` did not set it: the
apply carried every `${VAR…}` a service's environment interpolates from the running container, so an
older template's **default** was carried as if a person had chosen it, and a template's new default
never reached an existing install.

1. **Carried:** a variable the template declares with **no non-empty default** — `${VAR}`,
   `${VAR:?…}`, `${VAR?…}`, `${VAR:-}`, `${VAR-}` — that neither the env file nor the managed block
   sets. These are the values a first install passes on the shell (`CLAUDE_CODE_OAUTH_TOKEN`).
2. **Never carried:** a variable with a non-empty default (`${VAR:-x}`, `${VAR-x}`). It follows the
   template being rendered; a person who wants their own value sets it in the folder's `.env`, which
   Compose reads as before.
3. The defaults are read off the model of the template being brought up. A variable used more than
   once is carried when **any** of its uses has no non-empty default (the conservative reading), and
   its value is read from such a use first.
4. **When it lands.** The forward apply runs from the new, verified image (`launchApply(plan,
   to.platform)` in `updater.ts`), so the update that deploys this rule already applies it, and a worker
   holding an old default (the carried `300`) drops it on that same update. Only a `mode: 'rollback'`
   apply runs from the updater's own — the old — image, and with it the old rule.
5. **`APP_CORE_URL` follows the core.** The file the folder runs is rendered with
   `${APP_CORE_URL:-<core>}` (`plan.core_url`), a non-empty default, so it is not carried; only the
   image's own template (`${APP_CORE_URL:-}`: a git checkout, a rollback's last resort) carries it.

As built: `carriedEnvironment` and `variablesWithoutDefault` in `apps/server/src/updater/apply.ts`, the
tests in `apps/server/src/updater/update-apply.test.ts`.

## Amendment (2026-11-06, orchestrator-authorised, production incident) — decision 6: a worker with no credential follows its core too

**Why.** Workers installed on 2026-11-06 got stuck at the local page's Claude sign-in ("Checking with
Claude…"). The fix shipped (#65), but those workers never received it: the updater asked `release` only
with the worker credential, and a worker gets its credential only at the device approval, which comes
*after* the Claude step. A re-run of the installer only started the worker again, so the only way out
was `--uninstall --purge` and a new install.

1. **`release` without a credential.** `GET /api/worker/v1/release` is public since WP-294. With no
   credential stored for the core's origin, the updater asks it with no `Authorization` header (the
   protocol header stays) and updates exactly as with one: the attestations, the downgrade bound, the
   pull, the drain (which already waits while a Claude sign-in runs) and the apply. **This reaches
   only workers that already run this build.** A worker stuck before this fix runs the old updater,
   which needs a credential and so never asks: only a re-run of the installer (4) reaches it, and from
   then on its own updater follows the core.
2. **Only reporting waits for the credential.** `update-report` — a refusal or an apply's result — is
   skipped by name while there is none. The apply leaves `reported: false` in `updates/state.json`, and
   the updater reports it at the first poll that holds a credential, once per update per process (as
   well as at start-up, as before); the last refusal made without a credential is kept in memory and
   reported the same way. The updater's liveness is a local file and needs none.
3. **The apply's check for a worker not approved yet.** Such a worker cannot hand-shake until a person
   acts, so `/readyz` answers `503`. When the apply finds no credential for the plan's core, a
   `core_handshake` of `needs_claude` or `logging_in` — waiting for the sign-in or the approval, as
   before the update — is good once every read has said so for 5 s (`NOT_APPROVED_STEADY_MS`: a build
   that starts and then crash-loops answers once, then nothing), `launcher: ok` still required; `needs_platform`, `core_unreachable` and
   anything else roll back as before. A worker that holds a credential must read `core_handshake: ok`,
   unchanged.
4. **The installer moves a worker that is not set up yet.** When the containers exist and run another
   build than the core serves, the folder's `.env` has no managed block (the updater never applied an
   update to it), and the worker's page (`http://127.0.0.1:<APP_WORKER_UI_PORT>/api/local/state`) reads
   `connection` `needs_platform`, `needs_claude` or `logging_in`, `install.sh`/`install.ps1` install the
   served bundle (`compose up -d`) and say why in one line. Only that one field is read and nothing of
   the answer is printed. A page that does not answer, one that asks for a token
   (`APP_WORKER_UI_AUTH=token`), or any other connection keeps the previous behaviour (`compose start`).
   A page that does not answer at all is a **stopped** worker: the installer starts it, reads the page
   again once it answers (bounded by `AGENTIC_INSTALL_WAIT_SECONDS`), and installs the served build in
   the same run when it is not set up yet.
   **Residual, stated:** an approved worker whose Claude sign-in was removed also reads `needs_claude`;
   the installer then installs the served build over it without the updater's attestation check — the
   trust a first install takes — and loses nothing (its approval and sign-in are in its volumes).

As built: `tick`, `refuse`, `reportTerminal` and `reportPending` in `apps/server/src/updater/updater.ts`,
`storedCredentialFor`, `NOT_APPROVED_CONNECTIONS`, `NOT_APPROVED_STEADY_MS` and `waitForHandshake` in
`apply.ts`, `release(null)` in `apps/server/src/remote-worker/core-client.ts`, `setup_state` in
`install.sh` and `Get-SetUpState` in `install.ps1`; the tests in `updater.test.ts`, `update-apply.test.ts`, `install-script.test.ts` and
`scripts/worker-install-ps1-check.ps1`.
