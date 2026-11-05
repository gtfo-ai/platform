# TD-031 — Agent runs are offers in one pool: the server's runner and remote workers claim them with one SQL claim, one lease and an epoch fence; a remote worker speaks a short-poll HTTPS protocol and receives a run package the core decided

- **Status:** accepted
- **Date:** 2026-11-04
- **Deciders:** architect (session 21), within BD-032 (the product owner's decisions of 2026-11-04)
- **Relates to:** BD-003, BD-004, BD-010, BD-011, BD-021, BD-022, BD-025, BD-032, TD-003, TD-004, TD-005, TD-007, TD-012, TD-021, TD-022, TD-025, TD-028 (amended here), TD-032, technical/01, /02, /04, /05, /08, research/17, Q123, Q124, plan § "Milestone M22"

## Context

Read at `da2e2ed6`; nothing here was run.

- **A run lives inside a job.** `stage.execute` is `stately` with `singletonKey: task:<id>`
  (`packages/application/src/pipeline/jobs.ts:639`) and the executor's shape is *transaction / no
  transaction / transaction* with the run awaited in the middle (`stage-executor.ts:1-20`). The singleton
  is what enforces *a task never runs two stages at once* (TD-028's WP-53 amendment), and it holds only
  while the job is active.
- **Who runs an agent is the process that took the job.** TD-028 decision 5 subscribes `stage.execute`
  only in a process with a launcher, and therefore a runner-less instance also stops evaluating gates
  (TD-028's WP-53 amendment; `apps/server/src/role.ts:39-43`). The owner's first production core
  (BD-032 Context) has no runner at all.
- **The lease exists and is per process.** `runs.lease_owner`/`lease_expires_at`
  (`0004_pipeline.sql:90-91`), TTL 5 min renewed every 100 s (`pipeline/lease.ts:60-63`), and *"a lost lease
  never interrupts the run"* (`lease.ts:50-55`). The sweep ends the row `lease_expired`
  (`recovery/run-lease.ts`) and escalates.
- **A run's inputs are already a schema.** `runSpecSchema` (`ports/runner.ts:190-322`) carries the
  prompt, limits, tools, command policy, protected paths, MCP servers, skills **by name**, environment and
  resume id; the launcher's `createRunRequestSchema` (`launcher/protocol.ts:334-398`) carries the
  workspace spec and the run credential. Skills' **content** is written by the launcher from its own
  `@platform/prompts` copy (`apps/launcher/src/runtime.ts:106-111`).
- **Commands reach a holder through the database** (TD-028 decision 9, `run_commands`, `0060`), with
  `pg_notify` as latency and the heartbeat poll as the guarantee.
- **Facts about the SDK and the deployment** are in research/17: the usage-limit signal is
  `rate_limit_event` with `status: "rejected"` and an optional `resetsAt` of undocumented unit; a
  setup-token cannot ask its remaining usage; a CDN in front of the core cuts a request idle for ~100 s.

## Decision

### 1. The offer

A new table `run_offers` (one row per run, `run_id` unique):

| column | meaning |
|---|---|
| `id`, `run_id`, `task_id`, `project_id`, `stage`, `attempt` | the stage entry the run serves |
| `kind` | `stage` or `ask` (decision 13) |
| `state` | `open` → `claimed` → `settled`; `open` → `withdrawn`; `claimed` → `open` only by an unspent **release** (decision 6) |
| `lease_epoch` | integer, `0` while never claimed, incremented by every claim |
| `claimant_kind`, `worker_id` | `server` (worker_id null) or `worker` |
| `assignee_user_id`, `assignee_until` | decision 8 |
| `server_from`, `workers_from` | earliest instant each side may claim (decision 8); null = never |
| `excluded_worker_ids` | uuid[]; a worker that released for a usage limit or lost the run |
| `image_digests` | the run and egress image digests the package names (decision 4) |
| `run_token_hash`, `run_token_epoch` | SHA-256 of the run token minted at the claim and the epoch it belongs to (decision 7); replaced at the next claim |
| `release_reason`, `released_at` | the last unspent release (decision 6; `credential_unavailable` from decision 2) |
| `offered_at`, `claimed_at`, `settled_at`, `withdrawn_reason`, `expires_at` | |

Partial unique index `run_offers (task_id) where kind = 'stage' and state in ('open','claimed')` — **this replaces the job
singleton for the run's duration** (decision 3). The `runs` row is written **at offer time** in status
`created` (the run state machine of technical/02 is unchanged), and `run.started` is appended at the
claim that starts it. Events: `run.offered`, `run.claimed` (claimant, worker, epoch), `run.offer.released`
(reason), `run.offer.withdrawn` (reason) — appended to technical/02's catalogue by the row that writes
them. An offer that nobody claims by `expires_at` (`offered_at + execution.offer_timeout`, default 24 h,
decision 8) is withdrawn and the task escalates to `needs_human` with the brief *no claimant took this run*.

### 2. The claim and the epoch fence

One SQL claim, used by every claimant (the server's runner in process, a remote worker over HTTP):

```sql
with candidate as (
  select o.id from run_offers o
  where o.state = 'open' and <eligibility for this claimant>       -- decision 8
  order by o.offered_at
  for update skip locked
  limit 1)
update run_offers o set state = 'claimed', lease_epoch = o.lease_epoch + 1, claimant_kind = $kind,
  worker_id = $worker, claimed_at = now()
from candidate where o.id = candidate.id returning o.*;
```

In the same transaction: `runs.lease_owner` (`server:<process>` or `worker:<id>`), `lease_expires_at`,
a new column `runs.lease_epoch` (copied from the offer), `runs.worker_id`, and the admission re-check
(`cost/guard.ts` and the task cap) — an admission refused at the claim withdraws the offer and pauses the
task exactly as today's admission does. **Every write a claimant makes** — heartbeat, transcript batch,
platform tool call, approval request, release, finish, late cost — carries `(run_id, epoch)` and is
conditional on `runs.lease_epoch = $epoch and runs.lease_owner = $owner` and a non-terminal run; a
mismatch is `409 lease_lost` (remote) or `LeaseLostError` (in process). On `lease_lost` the claimant
**stops the session and destroys its workspace**. This amends `lease.ts`'s *"a lost lease never
interrupts the run"* in three ways, for **every** claimant (the server's included):

- an **answered** `lease_lost` (another claim or a terminal row exists) interrupts at once;
- a **`401`** on any run-scoped call (the worker or its user revoked, the run token invalid) is treated
  exactly as `lease_lost`;
- **self-termination**: a claimant that has gone `TTL − ½·renew` without one **successful** renewal —
  measured on its **monotonic** clock from the moment it received the last successful answer — stops the
  session, pushes nothing further, and destroys the workspace. The rule `TTL − ½·renew ≥ 2 × renew` (at
  least two consecutive missed beats tolerated) is a stated invariant, checked by a unit test over the
  constants. **The numbers:** the server's claimant keeps `RUN_LEASE_TTL_MS` 300 s and `RUN_LEASE_RENEW_MS`
  100 s (`lease.ts:60-63`) and self-stops 250 s after its last success (two missed beats tolerated); a
  remote worker's lease is 600 s and its renew interval is 30 s — the heartbeat is held ≤ 20 s and
  re-issued at once, so a renewal lands about every 20 s on a healthy link and 30 s is the declared bound
  — and it self-stops 585 s after its last success (nineteen missed beats tolerated).

**The sweep acts later than any claimant gives up.** `lease_expires_at` is written by the core at the
renewal (`now() + TTL` on the core's clock); the claimant's self-stop is a duration on its own monotonic
clock counted from *after* it saw that renewal, so wall-clock skew between machines does not enter.
`recovery/run-lease.ts` ends a run only when `lease_expires_at + APP_LEASE_SKEW_GRACE` (default 120 s,
covering response latency, clock-rate drift and the sweep's own pass interval) is past, so a claimant that
self-terminates is gone at least `½·renew + grace` (170 s server, 135 s remote) before the core can
re-offer. Before re-offering, the sweep
**revokes the run's minted credential** (TD-028 decision 10's revoke, through the minting integration) and
re-plans only after the revoke is recorded (`revoked` or `unconfirmed`, the latter re-offered anyway with
the residual logged). **Residuals, stated:** a **static** run token (decision 5) cannot be revoked per run,
so a tampered or clock-broken worker that ignores self-termination can keep pushing to the same
`agentic/*` branch until the token expires — which is part of why the static opt-in exists (Q124); a
**deploy key** run is fenced at the signing oracle instead (`ssh-sign` refuses a stale epoch, so no new SSH
session can open; a session already open may finish its push). Pre-M22, the server runner's database loss
past 5 minutes only escalated; it now self-terminates first, which is strictly less concurrent work.

The git credential is **minted after the claim commits** and before the package is returned
(`assertOutsideTransaction`, TD-028's WP-76 amendment unchanged): a mint failure releases the offer
(`release_reason = credential_unavailable`, retryable under Q59a's bound) rather than leaving a claimed
offer with no package.

### 3. The asynchronous hand-off, and what replaces the job singleton

`stage.execute` keeps everything up to the plan: re-validate, ticket claim, owed duties, budget
admission, `createRun` (status `created`), the plan, the stored prompt (`runs.system_prompt`/`user_prompt`)
and the context pack — and then **writes the offer in the run's transaction and ends**. The run no
longer happens inside the job. Three things replace the singleton for the run's duration:

1. the partial unique index of decision 1 (at most one open or claimed offer per task);
2. `revalidate` gains one question: *does this stage entry already have a non-terminal run?* — if yes,
   the job is a duplicate wake-up and succeeds doing nothing;
3. **every task transition that leaves the stage closes the offer in its own transaction**, by **one
   conditional statement**: `update run_offers set state = 'withdrawn' … where id = $offer and state =
   'open'`. One row touched → the offer is withdrawn and the run row ends `cancelled` in the same
   transaction. Zero rows → a claim won the row lock first, so a `cancel` `run_commands` row is recorded
   instead (TD-028 decision 11) and the stage does not move on until the run's own ending — the same rule
   cancel and take-over follow today. No read-then-write; an integration test interleaves the withdrawal
   with a concurrent claim in both orders.

The run **settles through a command on the core**, `settleRun(runId, epoch, outcome)` in
`packages/application/src/pipeline/settle.ts`, which is today's *transaction 2* moved out of the job:
artifact validation and redaction (`artifacts/redaction.ts`), `finishRun`/`failRun`, `completeStage`,
hand-back, escalation, cost. It re-validates on arrival exactly as tx 2 does now (`recordOntoStoppedTask`
for a task that moved), and it is idempotent on `(run_id, epoch)`: a second settle of a settled run
answers the stored result. The server's runner calls it in process; a remote worker calls `POST
/api/worker/v1/runs/:id/finish`. **Gates stay on `stage.execute`** and are evaluated by any worker
process (decision 12).

### 4. The run package — what the core decides and the worker executes

`runPackageSchema` in `packages/contracts` (camelCase, the same stated deviation TD-028's WP-53 note
records for the launcher protocol): the `RunSpec` **minus** every secret value, the launcher's
`WorkspaceSpec`, the run credential (decision 5), the **skills' content** (name → files, with the set's
digest that `prompt_version` already records), the run and egress image **digests**, `(run_id, epoch)`,
the run token (decision 7), and `limits.leaseTtlMs`. Bounded (`WORKER_PACKAGE_MAX_BYTES`, 4 MiB) and
refused, not truncated, past it.

**Skills travel in the create request, for every claimant.** The launcher's own `@platform/prompts` copy
(`apps/launcher/src/runtime.ts:106-111`) is retired: `createRunRequestSchema` gains `skills`, the
launcher writes exactly what it is given under `.agentic-run/plugins/agentic/skills/` and checks the
digest. One mechanism for server and worker, and the core decides the bytes even when the worker's image
is one protocol version behind. The size bound joins `CONTROL_PLANE_MAX_BODY_BYTES` (raised by the row
if the measured skill set needs it).

**Images by digest.** The package names the run image and egress image by digest — the core's own
(TD-032 decision 3). A worker advertises the digests it holds at each claim; the claim's eligibility
admits only offers whose digests it holds. The launcher refuses a digest it does not have locally; it
never pulls at create (the worker's updater pre-pulls, TD-032).

**What the worker adds locally, and nothing else:** `CLAUDE_CODE_OAUTH_TOKEN` from its own environment
into the CLI environment (`cliEnvironment`, WP-118), and `api.anthropic.com` is already in the spec's
egress list. The core never puts a model credential in a package.

### 5. The run credential on a worker

By TD-028's credential source:

- **`minted`** (short-lived, **one project**, revoked at settle and by the sweep, decision 2) — carried in the package. Its reach is the project's host-only credential reach (TD-030; path scoping is PROGRESS backlog 481): `agentic/*` is the in-container git guard's rule, which a tampered worker skips, so on a remote worker the branch limit holds by the provider's **protected branches** (verified by readiness, technical/05) and nothing finer.
- **`deploy_key`** (decision 13b) — **the key never leaves the core.** The worker's runlet `ssh.sign`
  frames are forwarded to `POST runs/:id/ssh-sign`, and the core's existing signing oracle (WP-146's
  narrow RFC 4252 §7 user-authentication check) answers, refusing a stale epoch. The package carries the
  public key and the SSH route only. **But the oracle authenticates an SSH session and never sees the
  refs pushed**: during its run, a tampered worker can open sessions and push to **any** ref the deploy
  key may write (every unprotected branch of every project the key is enabled on), not only `agentic/*`.
  So a deploy-key project is behind the same opt-in as a static token.
- **`static`** (decision 13, a ≤ 90-day project-wide token) — the token's reach is the project and it
  outlives the run on a developer's disk.

  Both are admitted on a remote worker **only when** the git integration sets `remote_run_credential:
  allow` (admin, audited, default `deny`); otherwise the claim's eligibility excludes the project from
  remote workers and the execution setting says why. This is a trust decision for the owner (**Q124**; the
  implementation follows the recommendation: opt-in, default deny), and the residual is stated in BD-032
  and technical/05: with the opt-in, the reach widens from one project for hours to **every project the
  key is enabled on** (deploy key) or one project for up to 90 days (static), and per-run revocation is
  lost. This matters for the first
  deployment: a gitlab.com Free project cannot mint (TD-028's 2026-10-03 amendment), so on a
  `workers_only` core it runs **only** through the deploy key or the opt-in.

A repo-less spec carries none (WP-74).

### 6. Release: an offer handed back unspent

`POST /api/worker/v1/runs/:id/release {epoch, reason}` before `run.started`: reasons `usage_limited`
(with `resets_at`), `image_missing`, `provision_failed`, `shutdown`. The offer returns to `open`, the
worker is added to `excluded_worker_ids` for `usage_limited` and `provision_failed`, the minted
credential is revoked, and nothing is charged. A release after `run.started` is refused (`409
run_started`): a started run ends through `finish`.

### 7. Worker identity and the run token

- **Worker credential**: `wkr_<base32 id>_<43 base64url chars>` (a prefix gitleaks and the pattern
  redactor recognise), stored as SHA-256 (high-entropy; Argon2 buys nothing, TD-022), per machine, tied to
  a user; table `workers (id, user_id, name, credential_hash, created_at, last_seen_at, revoked_at,
  protocol_version, image_digests, state, paused_until, paused_reason, concurrency)`. Revoking a worker, or
  deactivating its user, makes every later call `401`, which the worker treats as `lease_lost` (decision 2:
  it stops at once). In the revoking transaction the worker's live runs get `lease_expires_at = now()` —
  nothing else — so the **ordinary sweep path** ends them after the skew grace, revokes their minted
  credentials, closes their offers and re-plans once (decision 12), exactly as for a lost worker; the
  revoked worker is added to the carried exclusions.
- **Run token**: 32 random bytes minted at the claim, stored hashed on the offer with its epoch, valid
  until the run is terminal plus 15 min (for late cost). It authenticates every run-scoped call; the
  worker credential authenticates the rest. **Neither token ever enters the run container**: the SDK, the
  hooks and the platform-tool MCP server run in the worker process (TD-021's "SDK on the platform side"),
  which is the only holder.

### 8. Routing and eligibility (BD-032 decisions 3 and 5)

`project_execution_settings (project_id, mode, prefer, fallback_after, assignee_window, offer_timeout)` —
**in the database, written through the project settings API by `project.settings.write` (admin), never
in `.agentic/config.yml`**: where code runs and whose subscription pays is an administrator's choice that
a pushed commit must not change (BD-025's config-trust reasoning); `.agentic/config.yml`'s strict schema
refuses an `execution` key. Defaults: `hybrid`, `prefer: server`, `fallback_after: 15s` when the server is
preferred and `5m` when workers are, `assignee_window: 120s`, `offer_timeout: 24h`.

At offer creation the core computes the timestamps: with an **online** assignee worker (heartbeat in the
last 60 s, effective role `member`+, not paused, not excluded) `assignee_until = now + assignee_window`; then the preferred
side's `*_from` = `assignee_until or now`, the other side's = that `+ fallback_after`; `server_only` sets
`workers_from = null`, `workers_only` sets `server_from = null`. **A core with no claimant composed for
the server** treats every project as `workers_only` at offer time and says so on the settings screen.
Eligibility in the claim SQL: the worker's user's effective project role is `member` or above (the 2026-11-05 hotfix amendment), the worker is
not revoked, not paused, not excluded, holds the image digests, the project's credential source is `minted`, or is
`static`/`deploy_key` with `remote_run_credential: allow` (decision 5), and `now() >= workers_from` or (`assignee_user_id = worker.user_id` and `now() <
assignee_until`). The effective role is checked at the claim; losing it later does not stop a run in flight.

The server's runner claims while it has a free slot (`APP_RUNNER_CONCURRENCY`) with `now() >= server_from`.
**Waking**: `pg_notify('run_offers', project_id)` on offer and release; the server's runner `LISTEN`s and
also polls every 5 s; a remote worker's claim long-poll (decision 9) is woken by the same notification
in the API process that holds it.

### 9. The worker protocol

All under `/api/worker/v1/`, JSON, `Cache-Control: no-store`, header `X-Worker-Protocol: <int>` on every
request; `WORKER_PROTOCOL_VERSION` lives in `packages/contracts`. The core accepts `[N-1, N]`; anything
else is `426 upgrade_required` with `{ accepted: [N-1, N], compose_url, digests }`, and the worker stops
claiming (it finishes nothing it has not started; TD-032 decision 5 for a run in flight).

| verb | auth | purpose |
|---|---|---|
| `POST device` / `POST device/token` | none (rate-limited, decision 10c) | decision 10c |
| `POST handshake` | worker | protocol range, core digests, compose bundle digest, worker settings, server time |
| `POST claims` | worker | **held up to 25 s**; body: free slots, image digests held, paused state; answers `200` + package or `204` |
| `POST runs/:id/heartbeat` | run | renews the lease; **held up to 20 s**, answered early with pending `run_commands` (steer, cancel, take-over) and decided approvals; body carries acks of applied/refused commands |
| `POST runs/:id/transcript` | run | batch of `{seq, event}` ≤ 256 KiB; insert `on conflict (run_id, seq) do nothing` |
| `POST runs/:id/tools/:name` | run | a platform tool call (decision 10b) |
| `POST runs/:id/approvals` | run | opens a tool approval; answers its id; the decision arrives on a heartbeat |
| `POST runs/:id/session` | run | the SDK session mirror (TD-007), redacted on ingest |
| `POST runs/:id/ssh-sign` | run | decision 5 (deploy key, opt-in) |
| `POST runs/:id/release` / `finish` / `late-cost` | run | decisions 6, 3 and Q70 (b) |
| `POST pause` | worker | `{until, reason}`; decision 11 |
| `GET release` | worker | digests + protocol range; the updater verifies attestations itself (TD-032 decision 3) |
| `GET compose.yml` | worker | first install only, pinned by digest (TD-032 decision 3) |
| `POST update-report` | worker | TD-032 decision 4 |

**Short-poll HTTPS, not WebSocket.** Every held request ends by 25 s, well under a CDN's ~100 s idle cut
(research/17 § 8) and under any API process's request timeout; a worker re-issues it at once. It needs no
sticky routing (any `ROLE=api` replica answers, woken by `LISTEN`), no held-connection lifecycle (WP-43
showed what one costs) and passes every proxy. The price is one request per 20–25 s per idle worker and
per running run, which is negligible at a team's scale. WebSocket is rejected: it needs a liveness and
reconnect protocol of its own, ties a worker to one API process, and buys latency the 20 s heartbeat
already makes acceptable for steer (an applied steer is answered within one held request).

**Retries.** A worker retries every call with jittered backoff until self-termination (`TTL − ½·renew`); transcript and
tool calls are idempotent by `(run_id, seq)` and `(run_id, tool_use_id)` respectively; `finish` by
`(run_id, epoch)`. A core restart (deploy) is therefore invisible to a run whose lease outlives it.
Remote lease TTL is **10 minutes** (`RUN_LEASE_TTL_MS` stays 5 min for the server's runner) so that a
core deploy plus a CDN hiccup does not end a run (BD-032 decision 6).

### 10. What the protocol carries besides the claim

#### 10a. Transcript ingest and re-redaction

The worker's sink redacts with what it knows — its run credential and its own Claude token (exact value)
plus the shipped pattern rules — before anything leaves the machine; **the Claude token is redacted
only there**, because the core never knows it (the core's pattern rule for the `sk-ant-oat` prefix is the
backstop, `[unverified]` prefix — TODO V-WM4). The core then **re-redacts every entry** with the run's
full TD-012 redactor (every project secret, every injected credential, the minted-credential shapes)
before the row is written; `redaction_count` is the sum. Each entry is validated against
`transcriptEventSchema`; an undecodable entry is stored as a typed `ingest_refused` row naming its seq,
never silently dropped. The run's `run:<id>` SSE position is announced by the core's sink, so the UI
needs no change.

#### 10b. Platform tools through the core

The worker composes an HTTP `PlatformToolPort`; the core rebuilds `PlatformToolContext` from the run row
(project, task, mode, `promptHolds`, the run's redactor) and runs **the production
`apps/server/src/platform-tools.ts`** — mutating tools through `IntegrationActionExecutor` exactly as
today. Inputs are validated by the existing zod schemas at the route; a mutating tool is deduplicated on
`(run_id, tool_use_id)` so a retried `open_mr` opens one merge request.

#### 10c. Device flow (BD-032 decision 8)

RFC 8628's shape (research/17 § 7) on the platform's own auth: `POST device` → `device_code` (32 bytes,
stored hashed), `user_code` (8 characters from a 20-letter alphabet, `XXXX-XXXX`), `verification_uri`
(`/workers/approve`), `interval: 5`, `expires_in: 600`. The developer, signed in (TD-022 session, CSRF
rules), enters the code, names the machine and approves (`human_actions` row). The worker's `device/token`
poll answers `authorization_pending` / `slow_down` / `access_denied` / `expired_token` or, **once**, the
worker credential.

**Against code phishing and abuse:** the approval page shows the requesting IP address, user agent and
the code's age, with the warning *approve only a code your own machine is showing you now*; a code older
than 5 minutes needs a second confirmation. **Rate limits** key on the client address from
`APP_TRUSTED_CLIENT_IP_HEADER` (e.g. `CF-Connecting-IP` behind Cloudflare), honoured **only** when the
request's peer is trusted by the **existing** `APP_TRUST_PROXY` (`apps/server/src/config.ts:58`), which
is widened from a boolean to `false | true | <comma-separated addresses or CIDRs>` (the forms Fastify's
`trustProxy` accepts, research/17 § 9) — one setting, so it wins and no second list exists; otherwise the
socket address is used. `true` trusts every peer and is documented as safe only when the core's port is
unreachable except through the proxy. At most 20 outstanding (unexpired, unapproved) codes per client address
and 200 per instance; past either, `device` answers `429`. The approver must be an active user; the worker is theirs. No claude.ai login is
involved anywhere (BD-004 decision 3 untouched).

### 11. Usage limit (BD-032 decision 7)

- **Detection**, in the worker's runner (and the server's, when it runs `local`): a `rate_limit_event`
  whose `status` is `rejected`, or a result with `api_error_status = 429` / `errorCode:
  "credits_required"`. `resetsAt` is used when present (its unit is pinned by a golden fixture, TODO
  V-WM1); otherwise the pause is `APP_WORKER_USAGE_PAUSE_DEFAULT` (1 h) and the UI says *until about*.
- **Before the start**: a paused worker does not claim (`claims` with `paused` refuses locally and the
  core refuses a claim from a worker whose `paused_until` is future). A rejection between claim and
  `run.started` is a `release` with `usage_limited`.
- **Mid-run**: the run ends `failed` with the new terminal reason **`rate_limited`** (appended to
  `runTerminalReasonSchema` and its enum, last, by migration). `settleRun` treats it as *not the task's
  failure*: if the stage entry has not been re-offered for a usage limit before, a new run of the same
  stage entry is planned (`stage.execute`), with that worker excluded; otherwise the task escalates
  `needs_human` with the brief *usage limits ended this stage twice*. Its measured cost is charged as
  any run's. The worker posts `pause`.
- The server's own runner, when `local`, follows the same rule: it stops claiming until the reset.

### 12. Lost worker (BD-032 decision 6), and what changes in the lease sweep

`recovery/run-lease.ts` keeps ending the row `lease_expired`. What follows changes for **every**
claimant: the first `lease_expired` of a stage entry plans the stage again (a new run, a new offer, the
lost worker excluded); the second escalates. **Every terminal writer closes the run's offer in the run's
terminal transaction** — the sweep (`lease_expired`), `settleRun` (every ending, `rate_limited` included),
a withdrawal and a release-then-withdraw — by setting it `settled` or `withdrawn`, so the per-task
partial unique index (decision 1) admits the re-planned offer; the re-plan is enqueued after that commit,
never inside it. **Exclusions are carried**: the re-planned offer's `excluded_worker_ids` is the old
offer's plus the lost (or limited) worker, copied by `stage.execute` from the stage entry's previous offer. The counters live on the stage entry —
`task_stages.lost_runs` and `task_stages.usage_limited_runs` — one re-offer each. A worker that comes back
after the sweep gets `409 lease_lost` and destroys its container; its measured cost reaches the ledger
through `late-cost` (Q70 (b), `cost/late.ts`), authorised by the run token for 15 min after the end.

### 13. Which process does what (amends TD-028 decision 5)

`stage.execute` is subscribed by **every** process with a worker half: it plans, offers and evaluates
gates, and needs no runner. **The claimant is composed by configuration**: a process with a launcher URL
and token (or the in-process provisioner) runs the server claimant loop; a process without one runs
none and logs that it is not a claimant. **`task.ask` runs become offers too** (`run_offers.kind =
'ask'`): a core with no server runner — the first production deployment — would otherwise never answer
an ask. An ask offer is preferred to the **asking user's** online worker for `assignee_window` (the asker
plays the assignee's part), then follows the project's routing; it is outside the per-task index (an ask
runs beside a stage today) and its settle is the ask's existing ending. `/readyz` replaces
`agent_runs: degraded / unserved` with `claimants`: `server` (composed here), `workers: <n> connected`,
or `none` — `none` is **not** degraded on a core where every project is `workers_only` or no project
has an open offer; it is degraded only when an offer has waited past its `workers_from + 5 min` with no
eligible claimant. Metrics: `run_offers_open{project}`, `run_offer_wait_seconds`, `workers_connected`,
`workers_paused`.

### 14. Steer, cancel and take-over on a remote run

TD-028 decision 9's `run_commands` row is unchanged; for a remote lease holder the **heartbeat response**
is the delivery (no `pg_notify` reaches a worker). The worker applies it to its in-process live-run
register and acks on the next heartbeat; `applied_at`/`refused_reason` are stamped from the ack. The ack
uses the **existing** reasons only (`run_ended`, `register_miss`, `delivery_failed`, `undecodable`,
`0060_run_commands.sql:58-61`; 0064 widened only `kind`) — a worker-side failure maps onto `delivery_failed` — so the
CHECK constraint is untouched in M22. A new reason would need the CHECK dropped and re-added, which is a
`contract` migration (TD-032 §1) shipped expand-first: a release whose code tolerates the value, then the
constraint change. A
take-over of a remote run exports the **branch** (pushed with the run credential) and no tarball in M22;
the tarball upload is backlog (stated residual).

## Rationale

One claim over one table is the only shape in which *hybrid* cannot double-run: the server and the
workers compete for a row lock, and the loser sees nothing. Moving the run out of the job is forced by the
remote case (a job cannot wait on a laptop for an hour) and is cheaper than two code paths: the server's
runner becomes the in-process client of the same claim, lease and settle, so every test of one is a test
of the other. The epoch is what makes the lease safe across machines that cannot see each other: a
worker that was presumed lost and is not cannot write anything after the next claim. Short polls instead
of a socket follow from the owner's deployment (a CDN, no access gateway, any API replica).

## Alternatives considered

- **Keep the run in the job and let a worker take the job** (pg-boss over HTTP) — rejected: at-least-once
  delivery to any subscriber (TD-028's argument against pg-boss as a transport), and the job's expiry
  would bound a run by a queue setting.
- **A second queue for remote runs** — rejected by BD-032 (two schedulers).
- **WebSocket per worker** — rejected above; the long-poll is the boring choice behind a CDN.
- **The worker pulls skills from its own image** — rejected: under protocol N-1 the worker's bytes may
  differ from what `prompt_version` records; the core decides.
- **Keep static- and deploy-key projects off remote workers entirely** — rejected: the first deployment (gitlab.com, `workers_only`) would run nothing; the deploy key is signed on the core and the static token is an audited opt-in (Q124).
- **Keep `lease.ts`'s never-interrupt rule for fenced claimants** — rejected: with two machines, a run
  that continues after another claim is exactly the double work BD-032 forbids.

## Consequences

- Migrations (M22): `run_offers`, `runs.lease_epoch`/`worker_id`, `workers`, `worker_device_codes`,
  `project_execution_settings`, `task_stages.lost_runs`/`usage_limited_runs`, the `rate_limited` enum
  value — every one **additive** (TD-032).
- `stage-executor.ts` splits into plan-and-offer (the job), the claimant loop (`pipeline/claimant.ts`) and
  `settle.ts`; `lease.ts` gains the epoch; `run-lease.ts` gains the re-offer.
- The launcher's create request gains `skills` and image digests; the launcher's skill copy is deleted.
- technical/01, /04, /05, /08 are amended by pointers to this record; technical/02 gains the offer state
  machine and four events from the row that builds them.
- **Residuals, stated:** a tampered worker can return any transcript and any artifact for its own run (the
  core validates shape and redacts; it cannot verify the model said it); it can under-report its usage
  and so evade the estimated budget caps (BD-032 Consequences); its push reach is the run's project, bounded
  by protected branches rather than `agentic/*` (decision 5), and wider under the Q124 opt-in; a worker
  that ignores self-termination with a static token keeps pushing until the token expires (decision 2); the Claude token's redaction
  depends on the worker's own redactor; a take-over of a remote run exports no tarball; an offer on a
  `workers_only` project with no worker waits up to `offer_timeout`.

## Amendment (2026-11-04, architect, session 21) — decision 5: on a worker the launcher's git helpers sign through the core too, and the deploy key still never leaves it (PROGRESS backlog 693)

Read at `369b38f0` with WP-273 uncommitted in the tree; nothing was run.

**The contradiction.** Decision 5 keeps the deploy key on the core and covers the run container's git
(the runlet's `ssh.sign` frames). It never covered the launcher's two git helpers, which TD-028 decision
13b item 5 hands the key itself: `updateMirror` and the export build the helper's environment from
`credential.password` as `GIT_SSH_KEY` (`packages/infrastructure/src/workspace/provider.ts`,
`#gitCredentialEnv` and `SSH_HELPER_SETUP`), and the run's checkout is cloned from that mirror. A
worker's launcher has no key, and `runCredentialIssues(…, 'carried')` refuses an SSH spec without one
(`packages/contracts/src/run-spec.ts`). So as designed no deploy-key run could be created on a worker,
and none could save work or export a take-over.

### Ruling: option (c), with a third carriage

Of backlog 693's options: (a) HTTPS-minted-only is (e) for gitlab.com Free; (b) a core git proxy is a new
transport for one credential variant; (d) contradicts this decision and BD-032's residual; (e) was
rejected by this record's alternatives. **(c) is chosen: on a worker, the helpers sign through the core
exactly as the run container does.** Its reach is the one the Q124 opt-in already states — a signing
oracle for the run's lifetime, never the key — so nothing widens.

1. **`DeployKeyCarriage` gains `relayed`** (`'carried' | 'signed_by_core' | 'relayed'`). `carried` stays
   the server's launcher (key in the create request, helpers as TD-028 13b item 5, unchanged).
   `signed_by_core` stays the **run package** rule (no key, the SSH route and public key only).
   `relayed` is the **worker's launcher** rule: an SSH spec carries **no** private key and **must** carry
   the route plus a `helperAgentSocket` path; a request carrying a deploy key is refused. The worker's
   launcher protocol applies `relayed`, never `carried`.
2. **Who holds the socket.** The `remote-worker` process (the only holder of the run token, decision 7)
   serves, per run with an SSH route, an ssh-agent socket on the worker's `ctl` volume beside the run's
   control directory, speaking the same two requests as `/ctl/ssh-agent.sock` (list identities → the
   public key from the package; sign → `POST runs/:id/ssh-sign` under the run token and epoch). It is the
   runlet's relay code path, not a second agent implementation. The launcher mounts that socket's
   directory into the mirror and export helpers and sets the helper's `GIT_SSH_COMMAND` with
   `IdentityAgent=<socket>` instead of a key file; `SSH_HELPER_SETUP` writes only `known_hosts`. Whether
   a helper container connects to a Unix socket on a mounted named-volume directory through the
   socket-proxied daemon is `[unverified]` (TODO V-WM8); WP-279 measures it in `deploy-key-check.mjs`'s
   new `relayed` phase and WP-284 again on a worker bundle.
3. **The three questions backlog 693 posed, answered.**
   - *Is the run token valid before `run.started`?* Yes: it is minted at the claim (decision 7) and the
     claim appends `run.started` (decision 1), both before the package is returned; the mirror runs
     during `create`, after both. `ssh-sign` admits a run that is non-terminal at the presented epoch.
   - *Does the cap cover the helpers?* Yes, one cap per run: `MAX_DEPLOY_KEY_SIGNATURES` (128) counts
     every signature the core makes for the run — runlet and helpers alike. A mirror fetch is one SSH
     connection, an export push one. On the core the count is **a database counter, `run_offers.ssh_signatures` (created with the
     table by WP-274), incremented in the same statement as the epoch check** (any `ROLE=api` replica may answer, so a per-process counter would
     be a cap per replica).
   - *The helper's direct route?* Accepted. A helper is platform content only (no agent code reaches it,
     WP-75) and connects to `altssh.gitlab.com:443` from the worker's helper network, as on the server; on
     a developer's machine that is the developer's network, which the worker already uses to reach the core
     and `api.anthropic.com`. The run container's own SSH still goes through its egress sidecar.
4. **Ordering at the end of a run.** `ssh-sign` refuses a terminal run, so the worker performs every
   export — saved unfinished work (BD-025), a take-over's branch push (decision 14) — **before** its
   `finish`, and WP-283 asserts that order (a sign after the terminal write is refused, contract-tested in
   WP-282); a `lease_lost` or a self-termination exports nothing
   (decision 2). Backlog 694's "saved" answer, if WP-285 chooses it, needs nothing more for a deploy-key
   project.
5. **TD-028 decision 13b item 5 is amended for the worker case only**: on a worker the helpers hold no
   key and sign through the run's relayed agent socket; on the server item 5 is unchanged. The platform's
   vault mirror (TD-026) is unchanged.

### Q124 and the first deployment, end to end

Both of the first deployment's credential shapes now have a path, and both sit behind the same
`remote_run_credential: allow` (Q124 (a), default `deny`):

- **Static HTTPS token** — the Autix shape: gitlab.com Free, `run_credential: static`, `run_token_owner:
  operator` (TD-028 decision 13a). With the opt-in, the claim's eligibility admits the project (decision
  8), the package carries the static credential (`signed_by_core` admits a non-SSH, non-deploy-key
  credential), the worker's launcher applies `relayed` — which for an HTTPS spec is the `carried` rule —
  so the mirror and export helpers authenticate with `GIT_USER`/`GIT_PASS` as on the server, and the run
  container's git uses `/ctl/cred.sock` (WP-118). No new mechanism; the residual is Q124's (one project,
  up to 90 days, the operator's own token on the developer's machine for the run's life, no per-run
  revocation). With `deny` the project is excluded from every remote claim and, on a `workers_only` core,
  its offers wait and the execution settings screen says why.
- **Deploy key** — the ruling above.

### Consequences

- WP-274's migration creates `run_offers.ssh_signatures`; decision 1's `worker_id` columns (on `run_offers`
  and `runs`) land with WP-280's migration instead of WP-274's (TD-032's 2026-11-04 amendment C), and
  WP-274's claim writes no `worker_id` until WP-281's remote claim does.
- WP-279 builds the `relayed` carriage in the launcher protocol and the helpers' agent-socket
  environment; WP-282's `ssh-sign` gains the database counter, the non-terminal rule and its second
  caller; WP-283 serves the helper socket, exports before `finish` and proves both credential shapes in
  the fake-worker e2e; WP-284's Docker check runs both against a real launcher. Backlog 693 is owned by
  **WP-283** and resolves when its e2e creates a deploy-key run on a worker. No M22 row moves.
- Residual, stated: a tampered worker can call `ssh-sign` for its run up to the cap whether or not a
  helper asked — the same reach the runlet relay already has, now counted in one place.

## Amendment (2026-11-04, architect, session 21) — decisions 1, 2, 3 and 6: what `settleRun` is given and what it reads back, the stored run plan, a start failure as a settle, when `run.started` is appended, and one lock order (PROGRESS backlogs 700, 701, 697)

Read at `769360d0` (WP-275 merged); nothing was run. The code read: `pipeline/settle.ts`
(`SettleRunRequest`, `RecordInput`, `settleRun`), `pipeline/stage-executor.ts` (`startTheRun`,
`runStage`, `recordUnstarted`), `pipeline/offers.ts`, `pipeline/store.ts` (`lockSettlement`, `finish`,
`shutdownEndings`), `pipeline/planner.ts` (`reviewChecklists`), `pipeline/settings-snapshot.ts`,
`pipeline/deadline-rules.ts`, `pipeline/run-redaction.ts`, `apps/server/src/agent.ts`, `jobs.ts`'s
`retry`/hand-back re-enqueue, `domain/aggregates/run.ts`, and migrations 0004 and 0094.

**The finding, confirmed.** Once WP-276 ends the job at the offer, nothing that WP-275's request carries
from the job's memory survives to the claimant except what is stored, and two inputs are stored
nowhere. Read off the tree: (i) the **`RunSpec` is not reconstructible**: `runs` holds the two prompts
**redacted**, the model, effort, mode and prompt version, and `run_context_pack` the pack's rows; the
limits, tools, command policy, protected paths, MCP servers, skill names and environment names are the
planner's output over a point-in-time read, the job's per-attempt `overrides` and the
`mergeRequestPaths`/`observability` read fresh on each fire, and re-planning yields another document —
`startTheRun`'s own rule is *"written here and never re-derived"*. (ii) The **applied review
checklists** are computed by the planner from the prompt it assembled and carried only by the job;
`run_context_pack`'s columns (`0004_pipeline.sql`: tier, source path, reason, score, tokens, validated,
KB commit) carry none, so the read 700 asked for spares no migration. (iii) `runs.settings_snapshot`
cannot stand in for `ProjectSettings`: it is redacted and stored as a marker past 256 KiB. Settle reads
the settings **once**, for `questionTimeoutOf` (`deadline-rules.ts:40-61`); the job used the plan-time
value.

### 1. `settleRun`'s request: TD-031 §3's shape, with the fence and the stop reason spelled out

```ts
interface SettleRunRequest {
  readonly runId: Id;
  readonly fence: RunLeaseFence;        // { epoch, owner } — the claim's; on the worker route the
                                        // owner is derived from the authenticated worker, never the body
  readonly outcome: RunOutcome | NotStartedReport;
  readonly stopReason: RunStopReason | null; // the claimant's own stop register (`ports/runner.ts`,
                                             // closed vocabulary), validated at the worker boundary (WP-281)
}
interface NotStartedReport {
  readonly kind: 'not_started';
  readonly failure: string;          // describeStartFailure's closed vocabulary, unchanged
  readonly detail: string | null;    // the launcher's own words, unredacted, bounded by the claimant
  readonly transient: boolean;       // isRetryableStartFailure(error), the classification only
  readonly spawnRequested: boolean;  // WP-150's marker, as recordUnstarted takes it today
}
```

Nothing else crosses. Everything `RecordInput` held besides those four is read **under the settle's
lock** by **one** function in `settle.ts`, `settlementInputs(tx, runId)`:

| input | source |
|---|---|
| `job` (`taskId`, `projectId`, `stage`, `attempt`) | the run row (`StoredRun`); nothing else of the job is read by settle |
| `run` (the aggregate) | **one** shared `toRunAggregate` over the row and the stream's next sequence, replacing the twins in `commands.ts` and `recovery/run-lease.ts`; it admits a stage-less row (`run-lease.ts`'s reading) and `settleRun` refuses one as `not_a_stage_run`, because an ask's ending is the ask's (decision 13) |
| `stage` (`PipelineStage`) | `stageOf(compilePipeline(…task's frozen columns…), run.stage)`, i.e. `revalidate`'s lookup **without** its *is the task still here* half; a stage the frozen template no longer has settles as `recordOntoStoppedTask` does |
| `settings` | **retired from the request.** Settle reads one value, the question timeout, and it is **frozen at plan time** in the run plan (§2), which is exactly what the job used (`prepared.settings`); a live read, which could be a `configRefusal` and refuse the settle of a run that happened, is rejected |
| `reviewChecklists` | the run plan (§2) |
| `redactor` | **one factory**, `runRedactorFor(secretEnvironment, base)` = `composeSecretRedactors(injectedSecretRedactorForEnvironment(…), base)` — the composition `startTheRun` builds today, named once and used for the prompt columns (transaction 1b), the session (through the spec) and settle. At settle the secret **names** come from `run_plans.secret_env_names` (readable, so a repeated settle after the seal is cleared still builds the same redactor; settle never opens the seal) and the **values** from the settling process's `agentRunEnvironment` — the same function the planner and the claimant use |

**The rotation residual is closed for the server claimant and stated for a worker.** From WP-276 the
claimant re-attaches the secret values at the claim (§2) and settles in the same process, so the values
the session held and the values the settle redacts are one resolution of one process environment; a
credential rotated between plan and claim changes the prompt columns' redactor only, and the old value
is then handed to no session. On a remote worker (WP-281/282) the core's settle redactor has the core's
values and never the worker's Claude token — TD-031's stated residual, unchanged, closed only by the
worker's local exact-value redaction (WP-283 (2)).

**The answer gains a third kind**: `settled | already_settled | task_gone`. `task_gone` is the run whose
task was deleted mid-run (`runs.task_id … on delete cascade`, so the row went with it): nothing is
written, `ending` is `null`, the claimant destroys its workspace. WP-275's `settled` with `ending: null`
for that case is retired. WP-281 maps it to `410 run_gone`, which a worker treats as terminal.

**Follow-on enqueues move into the command.** `jobs.ts` re-enqueues `stage.execute` for a `retry`
(`RUN_START_RETRY_MS`) and a `handed_back` (`SHUTDOWN_HAND_BACK_DELAY_MS`) off the job's outcome. Once
the caller is a claimant or a worker route there is no job handler to do it, so `settleRun` takes the
job client and enqueues both **after its commit** — one path for every caller.

### 2. The run plan is stored: `run_plans`, written in the run's creation transaction, the spec **sealed** (additive)

A claimant needs the whole `RunSpec` to provision and run (`runner.start(spec, hooks)`); §4's package is
the same spec minus secret values. So the plan is persisted **once, in transaction 1b, beside the run
row** — the moment the prompt columns and the pack are written, and for the same reason: written there
and never re-derived.

```sql
-- migration-class: additive
create table run_plans (
  run_id uuid primary key references runs (id) on delete cascade,
  format smallint not null,               -- the sealed spec's shape, bumped when it changes
  sealed_spec bytea,                      -- envelope-sealed storedRunSpecSchema; null once the run is terminal
  key_id text not null,                   -- the APP_SECRET_KEY generation that sealed it (as `secrets.key_id`)
  secret_env_names text[] not null,       -- the spec's secretEnvNames, readable: names, never values
  review_checklists jsonb,                -- AppliedChecklistRecord[]; null = recorded nothing (WP-45)
  question_timeout text not null,         -- questionTimeoutOf(settings) at plan time
  created_at timestamptz not null default now()
);
insert into platform_table_policy (table_name, app_access) values ('run_plans', 'read_write');
```

Additive under TD-032 §1 and its 2026-11-04 amendment: a new table, its only reference to an existing
table states `on delete cascade` (B), the policy row registers a table this file creates (A); no
`not valid` constraint (C). It does **not** raise the rollback floor: an older build never reads the
table and runs no offer it did not claim in its own job. Number: the next free one at implementation
(0095 planned).

**Why a table and not columns on `run_offers`.** The offer is the claim's mutable lifecycle (claimed,
released, withdrawn); the plan is written once and read by the claimant, settle, WP-281's package
builder and WP-282's tool context. A new table also keeps the `not null` columns, which on 0094's
existing table would be refused as additive or need a default nobody means.

**The spec is sealed, not redacted — ruled after weighing both.** The first draft of this amendment
stored the spec and ran the session on the **redacted** prompt columns. The design review (session 21)
showed that understated: the prompt redactor is TD-012 step 1 (the injected model credential) **and
step 2, the gitleaks-derived pattern rules** (`StageExecutorOptions.redactor`, composed in
`startTheRun`), so the session would read `[REDACTED sha256:…]` wherever a pattern matched in a KB
page, a prior artifact or ticket text — false positives included — and the same rules run over the
spec could refuse every run of a project for good. **Chosen instead: `storedRunSpecSchema` —
`runSpecSchema` with every `env` entry named in `secretEnvNames` removed (the names stay), prompts
included and byte-identical — is envelope-sealed under `APP_SECRET_KEY`** with the mechanism `secrets`
uses (`packages/infrastructure/src/secrets/envelope.ts`, `sealSecret`, the run id as the bound
identity), behind an application port (`RunPlanSealer`). Why sealed wins:

- **No behaviour change**: the session is handed exactly the bytes the planner assembled, as today; no
  false-positive damage to a prompt and no permanent refusal of a project by a pattern.
- **TD-012 holds**: TD-012 governs what is stored *readable*; the sealed column is the `secrets` table's
  shape (technical/03: never joined into an API response), it is served by no route and no export, and
  the readable record of the prompt stays `runs.system_prompt`/`user_prompt`, redacted, unchanged.
- **Its exposure is bounded in time**: `RunRepository.finish` — every terminal writer's one statement —
  sets `run_plans.sealed_spec = null` in the run's terminal transaction (a leaf row reached only under
  the run's lock, so §5's order is unchanged). A sealed spec exists only while its run is live; a
  backup taken mid-run holds it encrypted, as it holds every `secrets` row.
- The **rejected alternatives**, named: the unredacted spec in plaintext (TD-012 forbids it); the
  redacted prompt columns as the prompt run (this amendment's first draft: a silent behaviour change and
  false-positive damage); re-planning at the claim (another document, refused by `startTheRun`'s rule).

Bounded at `RUN_PLAN_MAX_BYTES` (1 MiB of canonical JSON before sealing), refused past it, never cut.
`secret_env_names`, `review_checklists` and `question_timeout` are platform text and stay readable (settle needs them after
the seal is cleared; the artifact write redacts the checklist record as today).

**What a claimant runs: `loadRunPackage(tx, runId, environment)`** (`pipeline/run-package.ts`) — the
spec opened, and the secret values re-attached from the claimant's own `agentRunEnvironment` (a name it
cannot resolve is a non-transient `not_started`, `credential_unavailable`; a seal it cannot open — an
`APP_SECRET_KEY` rotated without its previous generation — is `run_plan_unreadable`, likewise). The
process that claims needs `APP_SECRET_KEY`, which every process with a worker half already has; a remote
worker never does — the core opens the seal and the package carries the spec (decision 4).

A run with **no** plan row (planned before the row that writes it; reachable only through a settle of a
run in flight across that upgrade) settles with `review_checklists` null and the live question
timeout — the platform default on a `configRefusal` — and a `warn` naming `run_plan_missing`; a
claimant that finds such an offer withdraws it and escalates with that name. Neither is reachable
after one release.

### 3. A start failure settles through `settleRun` as `not_started` (backlog 701 (a)–(b))

`recordUnstarted` moves into `settle.ts` as the `not_started` branch, writing exactly what it writes
today (failed run, `start_failure`, the escalation or the untouched task, the measured zero or the
unmeasured hold by `spawnRequested`). The fence pre-check, the lock, `(run_id, epoch)` idempotency and
the offer's close are then one path, and a worker reports the same thing through `finish`. A
`NotStartedReport` is a distinct type and never a fabricated `RunOutcome`; `record` still never sees
one. The redacted `RunStartFailure` (backlog 453's words) is built **in settle** with the settle's
redactor, not by the claimant.

**The retry counter is counted from stored rows**, as `MAX_SHUTDOWN_HAND_BACKS` is:
`RunRepository.startFailures(tx, entry)` answers how many of the stage entry's `(task, stage, attempt)`
runs **immediately preceding** this one (ordered by `created_at`, since `started_at` is null for an unstarted run) ended with a recorded start failure — a run that started, or a
shutdown hand-back, ends the streak, which is what today's payload counter does (a hand-back re-enqueues
with no `startAttempts`). Read under the settle's lock, the current run is still live and so not
counted: `attempt = startFailures + 1`, `retryable = transient && attempt < MAX_RUN_START_ATTEMPTS`.
`StageExecutionJob.startAttempts` is read by nothing; it stays an accepted, ignored payload field for one
release (a job queued by the previous build) and is then removed.

### 4. When `run.started` is appended, and what `release` may undo (backlog 701 (c))

Decision 1 appends `run.started` "at the claim", decision 6 admits `release` only "before
`run.started`" — so as written no unspent offer could ever be released. **Ruled: `run.started` is
appended when the claimant asks for its CLI**, in the transaction that writes
`runs.cli_spawn_requested_at` (WP-150's marker, committed before the shim's `spawn` frame). The marker is
already the platform's one boundary between a run that may have spent and one that cannot; `run.started`
now states the same fact instead of a weaker one. The run's lifecycle is re-cut onto the offer:

| moment | status | events |
|---|---|---|
| offer written (transaction 1b) | `created` (persisted; the run enters the log here) | `run.created`, `run.offered` |
| claim | `created → starting` | `run.claimed` |
| CLI spawn marker (fenced on `(epoch, owner)`; a stale fence withholds the `spawn` frame) | `starting → running`, `runs.started_at` written | `run.started` |
| release (decision 6) | `starting → created` | `run.offer.released` |
| withdrawal (decision 3) | `created → cancelled` | `run.finished` (`cancelled`), `run.offer.withdrawn` |

`RUN_TRANSITIONS` gains `created → cancelled` and `starting → created`, and its docblock's *"`created` is
in memory only"* — false since WP-274 — is corrected; technical/02's run state machine is amended by the
row that changes the table. A run that ends before the marker has **no** `run.started`, and every
consumer of that event (the cost ledger and pricing, `run-lease.ts`, `events/consumption.ts`, the runs
route, the context-pack readers, the ask executor) must read such a run correctly; the lease sweep's
wall-clock backstop reads `coalesce(started_at, created_at)`.

**Decision 6 is amended:** `release` is admissible while the run is `starting` with
`cli_spawn_requested_at` null, and refused `409 run_started` once the marker is written. It undoes the
**claim only**: the offer `claimed → open` (its `lease_epoch` kept, so the next claim increments it and
the releasing claimant's fence is stale), `runs.lease_owner`/`lease_expires_at` cleared, the run
`starting → created`, the minted credential revoked, `excluded_worker_ids` per reason; nothing is
charged and no run is ended. Events stay appended (`run.claimed` and `run.offer.released` both stand).
A remote worker therefore needs a fenced, idempotent **`POST /api/worker/v1/runs/:id/spawn`** answered
before it sends the `spawn` frame (decision 9's table gains it; WP-281). **The server claimant does not
release in WP-276**: its provision failures settle as `not_started` and re-plan as today, one failed
row per flap (Q59(a)'s visibility).

### 5. One lock order (backlog 697)

**`run_offers`, then `runs`, then `tasks`**, for every transaction that locks more than one of them:
the claim (its CTE already takes the offer first and the outer `update runs` second; it additionally
takes `for update of o, r skip locked`, so a claim never waits on a run a terminal writer holds),
`settleRun` (`lockSettlement` **will** lock the run's offer row, then the run, before anything else — today it locks `runs` only), every
other `finish` caller (a person's cancel, whose documented `runs` then `tasks` becomes `run_offers`,
`runs`, `tasks`; the lease sweep; the holder's applied cancel; the take-over's stop; the shutdown
hand-back; the ask's ending), and WP-276's withdrawal (its conditional offer update, then the run, then
the task's save). `tasks.save` is an optimistic write at the end of each, so it is last everywhere.
Shape (b) alone was not chosen because the withdrawal and the task row make a second cycle a claim is
not part of.

### Consequences

- **A row before WP-276 carries the migration**: WP-275a (the run plan, the four-field request, the
  `not_started` settle, the counter from rows) and WP-275b (the lifecycle re-cut of §4, **no migration
  and no rollback-floor raise**: `starting` is in the run-status enum since 0002, the sweep works off the
  lease, and the web already renders `starting` and a null `started_at`), each shippable with the job
  still running the session; WP-276 keeps "Migration: no". The job in WP-275a already runs
  its session from `loadRunPackage`, so WP-276 moves a call rather than inventing a read.
- technical/02 (run state machine), technical/03 (`run_plans`, its seal and its clearing at the
  terminal write), technical/04 (the claimant's spec is the sealed plan) are amended by WP-275a/275b.
- **TD-031 decision 11 is amended** (the review's finding on this amendment): a usage-limit rejection
  is observable only after the CLI spawned — after `run.started` under §4 — so *"a rejection between
  claim and `run.started` is a `release` with `usage_limited`"* cannot happen and would be `409
  run_started`. **A rejection is always the mid-run branch** (`rate_limited`, one re-offer). `release
  usage_limited` remains only for a worker that learns of its pause (a sibling run's rejection, a
  `resetsAt` still in the future) after claiming and before its spawn call. WP-285 (2) is amended.
- Backlogs 700 and 701 are ruled here; 697's order is ruled here and built in WP-276; 698 is folded into
  WP-276's tests.
- **Residuals, stated:** a live run's whole spec — prompts unredacted, secret env values excluded —
  is stored sealed under `APP_SECRET_KEY` until its terminal write, so a holder of the database **and**
  the key reads it, the reach `secrets` already has; a worker's Claude token is redacted only by the
  worker; a settle of a run planned before WP-275a reads the live question timeout.

## Amendment (2026-11-04, architect, session 22) — the worker's local UI: what a developer sees and controls on their own machine, and where each control is decided (owner request 2026-11-04; slice S-22.13, WP-292)

**Context.** The owner asked for a page, served by the worker on a local port, showing what the worker is
doing (state, the task, the stage, logs) and letting the developer pause, stop and cancel. Read at
`75d132d2`. What exists: `POST pause {until, reason}` with `reason ∈ {usage_limited}` only
(`packages/contracts/src/worker.ts:512-513, 547-550`), backed by `workers.paused_reason` under a CHECK of
that one value (`0096_workers.sql:58`); WP-283 (3) gives the worker `POST /internal/drain` and `GET
/internal/state` on its compose network only; a run cancel is a core command on the `Run` aggregate,
`run.cancel` at `member` (`packages/domain/src/permissions.ts:181`, route `apps/server/src/routes/commands.ts:1051-1057`),
whose lease-held branch records a `run_commands` row the heartbeat delivers (§14); `release` is refused
after `run.started` (§6); the package names `taskId`/`projectId`/`stage` but no key or title
(`run-spec.ts:469-476`); the protocol is `1`, accepted `[1]` (`worker.ts:70, 76`).

**Decision.**

1. **Serving.** The `remote-worker` process opens a **second listener**, separate from `/internal/*`, on
   container port 7357; `compose.worker.yml` publishes it as `127.0.0.1:${APP_WORKER_UI_PORT:-7357}:7357`
   — never a bare port, which Docker publishes on every host address (research/17 § 10). The listener
   binds the container's interface, because a container-loopback listener is unreachable through a
   publish. `APP_WORKER_UI=enabled|disabled` (default `enabled`); `disabled` opens nothing. No run
   container can reach it: run containers join only their per-run networks (TD-025), asserted by the
   Docker check.
2. **Auth.** A 32-byte token, generated on first start, kept in `worker-state` (`ui-token`, mode 0600),
   rotated by deleting the file. Each start logs once `http://127.0.0.1:<port>/#token=…` — in the
   **fragment**, so it reaches no request line; the page moves it to `sessionStorage` and strips it. Every
   `/api/local/*` call carries `Authorization: Bearer` (compared in constant time): **no cookie**, so a
   cross-site request carries no credential and CSRF has nothing to ride; no CORS header is ever sent.
   The `Host` header must be exactly `localhost`, `127.0.0.1` or `[::1]` with the published port
   (DNS rebinding, `[unverified]` V-WM9), and a mutating call must also carry a matching `Origin`.
   Responses: `Cache-Control: no-store`, a `default-src 'self'; frame-ancestors 'none'` CSP, `nosniff`.
   The token is added to the worker's local redactor and never enters a request to the core.
3. **What it shows**, read from the worker's own memory (no new core read): connection (handshake time,
   protocol, core range, `426`/revoked/`lease_lost`), pause state and reason, update pending, slots; per
   run: project and ticket key, task title, stage, role, attempt, run state, elapsed, tokens so far and
   the cost **only when reported** (BD-011: the worker has no price list, so no estimate is invented); a
   transcript tail and the worker's log tail (bounded ring buffers). **What it displays is exactly what
   the worker uploads**: the transcript entries after the local sink's redaction (§10a — the run
   credential, the Claude token, the shipped patterns) and log lines after pino's redaction plus the same
   exact-value redactor; never the raw SDK stream. **The page is a second Vite entry of `apps/web`**
   (`worker.html`), served by the worker from the bundle the platform image already carries
   (`docker/app.Dockerfile:22-26`), reusing `ui/untrusted.tsx` and the transcript renderers, so BD-022's
   text-node rule and `no-html.test.ts` cover it unchanged; its own initial-graph budget (≤ 120 kB gz) is
   a `bundle:check` entry beside TD-013's 300 kB. The display fields (project key, ticket key, title)
   come in a new package block built from the core's redacted ticket snapshot.
4. **Controls — the core decides each one that changes shared state.**
   - **Pause / resume claiming**: a new protocol verb `POST manual-pause {paused: boolean}` (a state
     assertion, idempotent), stored in a **new nullable column `workers.manually_paused_at`** (additive)
     — not a new `paused_reason`, which would need the CHECK dropped (a `contract` migration, TD-032 §1)
     and would conflate a person's hold with a limit's timer. The claim's eligibility and the *online
     assignee* rule (§8) exclude it; the Workers screen shows *paused by its owner*. One `human_actions`
     row (`worker.pause` / `worker.resume`, `params: {worker_id, via: 'worker_ui'}`, the worker's user).
     Runs in flight continue.
   - **Drain and stop**: manual-pause, finish what is running, exit; the worker remembers in
     `worker-state` that the pause was a drain's and clears it at its next start. WP-283's
     `/internal/drain` is the same function.
   - **Cancel a run**: a new run-token verb `POST runs/:id/cancel {reason?}` with an `Idempotency-Key`.
     The core performs **the same application command** as `POST /api/runs/:run_id/cancel`, as the
     worker's user, under the same `run.cancel` permission (a `403` is shown, not worked around), with the
     same `human_actions` row plus `via: 'worker_ui'`. The worker holds the lease, so it is the `202`
     branch: a `run_commands` row the worker's own heartbeat delivers and acks (§14). As from the task
     page, the **task is paused**; the page says so. The UI never stops a container: a killed worker is a
     lost lease (§12), not a cancel.
   - **Not offered:** releasing a run (the claim-to-spawn window is seconds, and §6 refuses it after);
     handing a *started* run back to the pool (no such semantics exist — Q126); steer and take-over
     (the core's run page, linked).
5. **Protocol.** `WORKER_PROTOCOL_VERSION` → **2**, accepted `[1, 2]` (`protocol:check`: `N = B+1`, `B`
   kept, no bump in the push before). A version-1 worker never calls the two verbs, and the core answers
   it the version-1 shapes: the handshake's `worker.manually_paused_at` and the package's display block
   are sent **only** when `X-Worker-Protocol ≥ 2`, because every schema is strict and a v1 worker would
   refuse an unknown key. A v2 worker against a core accepting only `[1]` gets `426` (§9) and the page
   says the core must update first.

**Alternatives rejected.** A self-contained page outside `apps/web` (a second set of untrusted-text rules
outside the census); a cookie session (CSRF to defend); controls acting locally only (no audit, the core
would offer work to a worker that will not take it, and a local kill reads as a lost worker); reading the
core's re-redacted transcript back (a new read verb and bandwidth for a view of the same machine).

**Residuals.** The local view may show a value the core's re-redaction would mask if it reached the run
from outside the package (the repository, the web) — it is on the developer's machine already. The UI is
not a confidentiality boundary against the machine's owner, who controls the Docker daemon and can read
the run credential from the container (§5's tampered-worker residual). Before Docker Engine 28.0.0 a
host on the same L2 segment can reach a loopback publish; the token holds there.

**Amendment (2026-11-05, orchestrator-authorised, S-22.19) — one claim-blocker vocabulary, both sides.** *Why a
connected worker takes nothing* has one answer list, `WORKER_CLAIM_BLOCKERS` / `workerClaimBlockerSchema` in
`packages/contracts/src/workers.ts`, ordered most fundamental first (the first is the sentence a screen shows):
`not_set_up`, `revoked`, `offline`, `protocol_outdated`, `claude_rejected`, `paused`, `draining`, `usage_limited`,
`launcher_unreachable`, `images_missing`, `images_outdated`, `no_eligible_project`; the words are one exhaustive
table, `WORKER_CLAIM_BLOCKER_WORDS` in `apps/web/src/ui/humanize.ts`, read by the SPA and the local page. The core
answers its half on `GET /api/workers` (`claim_blockers`, `can_claim`, `last_claimed_at`) from the claim's own
predicates minus the per-offer ones — *draining* is a hold whose newest `worker.pause` row says `via: *_drain*`, and
*pick only* is no blocker — and the worker answers its half on `GET /api/local/state` from what it holds (its
launcher, its images, its connection); neither side bumps the protocol.

## Amendment (2026-11-04, orchestrator-authorised, WP-278) — decision 8: what "no server claimant" does to each mode

§8's *"a core with no claimant composed for the server treats every project as `workers_only`"* is read
per mode, and "no claimant" is an instance fact (`server_claimants` liveness rows, migration 0097), not
the offering process's configuration. **`server_only` stays closed to workers**: an administrator may
have chosen it so the project's credential never reaches a developer's machine (Q124's reason), so its
offers wait — bounded by `offer_timeout` — and the settings screen says so. **`hybrid` opens to workers
at once but keeps its `server_from`** (never null), so a server runner that was down when the offer was
written still takes it when it returns; a stale liveness read can only let workers claim as early as
the server, never keep the server from a run. `server_only` never sets `workers_from`, unconditionally.

## Amendment (2026-11-05, architect, session 22) — decision 2: a remote mint failure is a start failure, not a release (backlog 740)

**Context.** §2 (line 120-123) says a mint failure after the claim commits *"releases the offer
(`release_reason = credential_unavailable`, retryable under Q59a's bound)"*. The two halves contradict
each other: Q59(a)'s bound is the stage entry's **failed runs** (`settle.ts:157`, `MAX_RUN_START_ATTEMPTS =
3`; `settle.ts:1365-1396`, `startFailures` + 1) and a release **keeps** the run and fails nothing
(amendment §4: `starting → created`). As built in S-22.6 (`remote-runs.ts:497-509` calls `release` with
`credential_unavailable`; `remote-package.ts:22`, `:102-110`), the offer is open again at once, with no
delay and no counter: every eligible worker's claim long-poll re-claims it and re-calls the provider's
token API at request rate, and the task never escalates. The server claimant meets the same error
differently: `workspaces.ts:203-213` re-throws it and `classifyProvisionFailure`
(`workspace-runner.ts:224-237`) calls anything not a `WorkspaceError` terminal, so a provider `503` there
escalates on the first try. Mint errors are `IntegrationError`s, which already say whether a retry could
help (`ports/integrations/common.ts:93-114`: `retryable` for `rate_limited` and `unavailable`).

**Decision.**

1. **A mint failure after a remote claim settles the run `not_started` through `settleRun`**, exactly as
   `settleUnpackaged` (`remote-runs.ts:354-375`) settles every other packaging failure — never a release.
   The packager's `credential_unavailable` answer becomes a `RunStartError` (diagnosis reason
   `run_credential_unavailable`, `ports/workspace.ts`), `retryable` = the mint error's
   `IntegrationError.retryable`; any other error is terminal. The run fails, the offer is `settled`, and
   Q59(a) does the rest unchanged: re-planned after `RUN_START_RETRY_MS` (30 s, `stage-enqueue.ts:21`) as a
   new run and a new offer, at most `MAX_RUN_START_ATTEMPTS` (3) per stage entry, then `needs_human` with
   the existing start-failure brief (*"the run could not be started (…)"*). Each attempt is one visible
   failed `runs` row — Q59(a)'s stated reason for counting rows.
2. **The binding-changed race** (`remote-package.ts:126-131`: the mint returned a static or deploy-key
   credential after a claim that admitted only `minted`) is **retryable** under the same bound: the
   re-planned offer's eligibility (§8) then answers who may claim it.
3. **The server claimant classifies the same way**: `classifyProvisionFailure` returns
   `IntegrationError.retryable` for an `IntegrationError`, so a provider `503` on either claimant is three
   spaced attempts and an escalation, and a `403` on either is one attempt and an escalation.
4. **No worker is excluded.** The fault is the provider's or the binding's, not the worker's; excluding it
   would only move the next mint to the next worker and could leave a `workers_only` offer with no
   eligible claimant until `offer_timeout`. **No migration**: no column on `run_offers`, no backoff field.
5. **`credential_unavailable` leaves `runReleaseReasonSchema`** (`contracts/src/events.ts:872-878`) and §1's
   `release_reason` note; a release is the claimant's own act (§6's four reasons, which
   `workerReleaseReasonSchema` already is). S-22.6 is unmerged, so no stored event carries it.

**Rejected.** *A release counter on the offer* (`release_count`, escalate at N): a migration and a second
bound beside Q59(a)'s for the same fact — a run that could not start. *A `claimable_from` backoff on the
offer*: spaces the calls but never ends them, and needs the claim SQL, the server's poll and the
long-poll wake-up to learn a fourth timestamp. *Excluding the failing worker*: see 4.

**Residuals.** A provider outage escalates every task whose stage entry spent its three attempts inside
it — bounded, visible, and the same trade Q59(a) made for a launcher that is down. The worst case per
stage entry is three mint calls over ≥ 60 s (plus whatever retry the call itself makes), not unbounded.

**Built by S-22.6** (WP-281 item 2), before merge.

## Amendment (2026-11-05, architect, session 22) — decision 9: `GET compose.yml` is public, and outside the protocol check (backlog 760)

**Context.** §9's table authenticates `GET compose.yml` with the worker credential. That credential
comes from the device flow, which the worker runs **at its first start**, and it can only start from the
compose file. So a first install cannot fetch the pinned file from its core
(`apps/server/src/routes/worker/protocol.ts:778-810`, `preValidation: authenticateWorker`), and the operator
guide sends a person to the image's or the repository's unpinned copy instead. There is a second problem:
the `onRequest` hook (`protocol.ts:140-151`) answers `426` to any `/api/worker/v1/` request without
`X-Worker-Protocol`. That covers the `426`'s own `compose_url` (`protocol.ts:123`) when a person opens it
in a browser, and it covers a documented `curl` that hard-codes a version, which stops working once the
range moves past it (WP-292 bumps it). **No worker calls this route**: TD-032 §3 has the updater read the
template from the verified image. The route exists only for a person.

**What the file holds** (verified, `apps/server/src/workers/compose.ts:69-109`). The renderer substitutes
three inputs and nothing else: the four core digests, `APP_IMAGE_REPOSITORY` and `APP_BASE_URL`. The
template (`compose.worker.yml`) names `CLAUDE_CODE_OAUTH_TOKEN` only as `${…:?…}`, the launcher token is
generated on the worker, and the socket proxy's digest is the template's own. **No secret.**

**What it discloses to an anonymous caller, at the margin.** Any anonymous request under
`/api/worker/v1/` already gets the `426` body: the protocol range, `compose_url` (which shows that worker
mode exists) and the four digests (`protocol.ts:111-128`). The device flow is unauthenticated by §9.
Making the file public adds only two things: `APP_IMAGE_REPOSITORY`, a registry namespace (for a
private registry its name, never a pull credential), and `APP_BASE_URL`, the core's canonical URL. The
template text is in the public repository and the image.

**Decision.**

1. **`GET /api/worker/v1/compose.yml` takes no authentication** (option (c)). A credential, if
   presented, is ignored, and no worker contact is recorded. The answers are unchanged: `200
   application/yaml` with the attachment disposition, or `503 digests_unresolved` /
   `503 compose_template_unavailable`. The bytes come from the memoised release (`release.ts:94`), so an
   anonymous request causes no rendering. It gets no rate limiter of its own, as with `GET /api/setup-state`.
2. **It is the one path the `X-Worker-Protocol` check skips**: `GET` (and HEAD, which Fastify answers for a GET route) of exactly
   `/api/worker/v1/compose.yml`, query ignored. It is a human download, not a protocol message, and its
   content depends on the core alone. `Cache-Control: no-store` still applies. Every other verb, the device
   flow included, keeps backlog 712's rule.
3. **The renderer stays limited to those three inputs**. A test enforces it: the rendered file differs
   from the template only on the `${PLATFORM_*_IMAGE:-…}` defaults and the `APP_CORE_URL` line. A later
   substitution therefore becomes a decision, not an accidental leak.
4. **Install is two copy-paste steps**, and `APP_CORE_URL` is already defaulted in the file:
   `curl -fsSo compose.worker.yml https://<core>/api/worker/v1/compose.yml`, then
   `CLAUDE_CODE_OAUTH_TOKEN=… docker compose -f compose.worker.yml up -d`. The person then approves the
   logged code at `/workers/approve`. The Workers screen shows both lines, built from the page's own
   origin, for copying. That needs no new endpoint.

**Rejected.** *(a) A signed-in person's download*: a second route serving the same bytes behind a
session. From a terminal it needs an API key or a browser download that is then moved to the machine,
which adds steps. It also protects nothing, because the content is not secret and the digests already
reach anonymous callers through the `426`. *(b) The device flow first* (`docker run … login`): the
one-shot needs an image reference before any pinned reference exists, so the person types a tag, which
is exactly what pinning avoids. Its credential would also have to land in a volume of a compose project
that does not exist yet. And the worker already logs in at first start. *Keeping the worker
credential*: it guards a route its holder never calls.

**Residuals, stated.** An anonymous caller learns the registry namespace and the canonical base URL. An
operator who considers worker mode's existence sensitive has no switch, which was already true through
the `426` and the device flow. The file can be trusted only as far as the TLS connection to the core,
the same as before. TD-032 §3 still holds: a person reads it, and no updater applies it.

**Built by S-22.8** (WP-284 item 6), before merge.

## Amendment (2026-11-05, architect, session 22) — the worker-UI amendment §3 and §4: a drain stays up, and the page checks answers without zod (backlogs 771, 770)

**Context.** §4 says a drain finishes the run and *exits*. But `compose.worker.yml:124` restarts the
worker `unless-stopped`, so an exit is an immediate restart, the restart clears the drain's pause, and
the worker claims again. The same restart would also break TD-032 §6, which drains, waits for **idle**,
and only then recreates the container. Separately, with zod the `worker.html` entry measured 127 kB gz
against §3's 120 kB. As built, the page checks answers with a strict guard
(`apps/web/src/worker/read-state.ts`), and the worker parses every answer with
`workerLocalStateSchema` before sending it (`apps/server/src/remote-worker/runtime.ts:619`).

**Decision.**

1. **A drain stops claiming, finishes what runs, and stays up idle. It never exits.** Stopping is the
   person's `docker compose stop` (Docker does not restart a container stopped by hand under
   `unless-stopped`) or the updater's recreate. The restart policy is unchanged.
2. **A drain's pause lasts one process lifetime. A Pause lasts until Resume.** At start, the worker
   clears the core's pause only if the `drain-pause` marker is present. A drain writes the marker
   **only if the worker was not already manually paused**, so Pause → Drain → restart stays paused.
   A later Pause takes the hold over (the marker is removed), and Resume clears both. Any start clears
   a drain's pause: a crash, a reboot, or the updater's recreate. A person who wants the hold to
   survive a restart uses Pause.
3. **The audit can tell the source apart.** `POST manual-pause` becomes `{paused, via}` (strict and
   required; the verb exists only from protocol 2, which ships unreleased in this slice) with
   `via ∈ {worker_ui, worker_ui_drain, worker_internal_drain, worker_start}`. That is: the page's
   Pause/Resume, the page's Drain, `POST /internal/drain` (the updater's or an operator's curl), and
   the start-time clear. The value is copied into the `human_actions` row's `params.via`. A repeat of
   the stored state still writes no row.
4. **The page keeps its guard. The budget stays 120 kB.** The rule from CLAUDE.md ("zod for all
   boundaries") is met by the side that owns the schema: the worker validates with zod. A separate
   browser entry with its own budget may check a same-origin answer with a hand-written strict guard
   on three conditions. (a) The server parses that answer through the zod schema before sending it.
   (b) A test compares the guard with the schema in both directions, covering keys at every depth,
   enum members, and nullability. (c) The test runs the same accept and refuse fixtures through both.
   Only `worker.html` uses this exception. The main SPA keeps zod.

**Rejected.** *Exit with `restart: on-failure`*: a reboot would then leave the worker down until
someone notices, and the updater's idle wait would race the exit. *Raise the budget to ~130 kB*: it
would pay 24.5 kB for a second validation of an answer the server already parsed. *`zod/mini`*: it
measured only 2 kB smaller.

**Residual.** A crash during a drain restarts the worker and it claims again. That is acceptable: a
drain is a wind-down, not a hold.

**Built by S-22.13** (WP-292 items 2 and 4), before merge.

## Amendment (2026-11-05, architect, session 22) — decision 8: what a developer's worker picks up — a claim scope per worker and an explicit *take this one* (owner request; slice S-22.15, WP-293)

**Context.** The owner: *"eventually possibility to choose what the worker should pick"*. Read at `640ca6ac`;
nothing was run. Today `POST claims` takes the oldest offer its eligibility admits (`postgres-run-offers.ts`,
`WORKER_ELIGIBLE`: not excluded, images held, not revoked, the user may act and is `member`+, not paused or
manually paused, `workers_from` reached or the user's head start, the credential rule), and the body names
nothing else (`contracts/src/worker.ts:597-601`). `CLAIM_SQL` can already narrow to one run (`$1`). A stage
offer names no assignee yet (BACKLOG 730).

**Decision.**

1. **Two selectors first, the rest deferred.** **Projects** — a worker's *claim scope*: its automatic
   claims take every project its eligibility admits (the default, today's behaviour), **named projects
   only**, or **none** (*pick only*). A developer in several projects needs this first: the repositories
   they know, and their subscription spent on their own team's work. **Take this one** — an explicit claim
   of one listed offer from the local page. **Deferred:** stage/role (*only reviews*; a later column beside
   this one), *assignee = me* (blocked by BACKLOG 730; once fixed, §8's head start already gives the
   assignee's worker first refusal), a blocklist (the allow-list expresses it; a deny list is a second rule
   to reconcile).
2. **Stored on the core, per worker, set by its owner; a preference enforced in the claim, never a
   boundary.** A new nullable column `workers.claim_project_ids uuid[]` (additive): `null` = every project;
   `'{}'` = pick only; otherwise those projects. Per **worker**, not per user: a developer's desktop may take
   everything while their laptop takes only what is picked. Not worker-local configuration: the core needs
   it at offer time (5) and the Workers screen shows it. It is a conjunct of `WORKER_ELIGIBLE` for an
   **automatic** claim, because the claim is the one race-free place to filter; a worker filtering what it
   was given would have to release, spending an epoch and a credential mint per refusal. **It can only
   narrow**: no value admits an offer the eligibility refuses (integration test: a scope naming a project the
   user is not a member of, or a `server_only` project, claims nothing). `PUT claim-scope` (worker credential)
   refuses with `422` an id that is not a project where the user is `member`+ at the write. This keeps the value meaningful
   and is not a security check; a membership lost later is harmless. Only the worker's owner sets it, from the local
   page; an administrator sees it and keeps their own levers (the project's mode, revoke). One
   `human_actions` row `worker.claim_scope` `{worker_id, project_ids, via: 'worker_ui'}`; a repeat of the
   stored value writes none.
3. **Take this one is an ordering choice inside the same eligibility, not a priority and not a
   reservation.** It is **the one claim** with `$1` set, through `POST offers/:run_id/claim` (worker
   credential, not held): `200` with the package exactly as `claims`, or `409 offer_not_claimable` when the
   statement claimed nothing. That one answer covers taken, withdrawn, not yet the worker's, and ineligible, so it reveals no reason.
   It **ignores the claim scope**, which is what *pick only* is for, and nothing else. It does not ignore
   `workers_from`, because hybrid's `server_from` preference and `offer_timeout` are the administrator's
   routing (BD-032 decision 3; Q127). It does not ignore another user's head start (BD-032 decision 5), the
   exclusions, or either pause. **No hold**: a pick competes at the row lock like any claim, and the server's
   claimant or another worker that commits first wins. The server claimant is unchanged. One `human_actions`
   row `worker.take_offer` `{worker_id, run_id, via: 'worker_ui'}` in the claim's transaction; `run.claimed`
   is unchanged.
4. **Visibility: `GET offers`** (worker credential) lists at most 50 open offers, oldest first, that this
   worker could claim **now**. It uses the same `WORKER_ELIGIBLE` text with the scope ignored, so the list
   and the claim cannot disagree. Each entry has the run id, kind, project key, ticket key, task title,
   stage, role, `offered_at`, and whether the scope takes it automatically. **It discloses nothing new**:
   every listed task is in a project where the user is `member`+ and may act, and that user already reads
   its title and ticket on the board (`task.read` is `viewer`). The same credential already obtains a whole
   run package through `claims`. A revoked worker or a user who may not act gets `401`, as on every verb.
   **BD-022:** the title and ticket key are untrusted. They come from the **redacted** ticket snapshot
   through WP-292's display-block builder and are bounded as there. `worker.html` renders them as text
   nodes (`no-html.test.ts` unchanged). An ask is listed with its task and stage *question*, **never the
   question's text**. The local page proxies the list as `GET /api/local/offers` and a pick as `POST
   /api/local/offers/:run_id/take` under WP-292's bearer, `Host` and `Origin` rules. It polls only while
   visible, every 10 s.
5. **Routing.** Offer time is unchanged but for one rule: the **online assignee** (§8) also requires that the
   assignee's worker's scope takes the project automatically (`null` or containing it). Otherwise a
   pick-only worker would hold every offer for `assignee_window` for nothing. Offers no worker's scope takes
   are left as today. The server takes them from `server_from`, any worker whose scope admits them takes
   them, a person picks them, or `offer_timeout` withdraws them and escalates the task. `/readyz` is unchanged.
6. **Protocol 3**, accepted `[2, 3]`. The handshake's `worker.claim_project_ids` is sent only at `≥ 3`.
   A v2 worker calls none of the four new verbs (`GET`/`PUT claim-scope`, `GET offers`,
   `POST offers/:run_id/claim`).

**Rejected.** *Filtering on the worker*: the worker would claim and then release, and the core could not
route the head start. *Per user*: one setting for machines that want different ones. *A pick that jumps
`server_from`*: Q127. *A reservation* (a pick holds the offer for N seconds): a fourth timestamp in the
claim for a click that takes milliseconds. *A join table* `worker_claim_projects`: two writes per change,
and *pick only* would still need a flag. A stale id in the array never matches anything.

**Residuals.** If every worker on a `workers_only` core is *pick only*, the pool is a manual queue, and
`offer_timeout` (24 h) is its backstop. The Execution screen does not yet say *no connected worker takes
this project automatically* (deferred). On a `hybrid`, server-preferred project the list is nearly always
empty, because the server claims within `fallback_after`. A tampered worker can list and pick exactly what
`claims` already admits for it.

**Built by S-22.15** (WP-293).

## Amendment (2026-11-05, architect, session 22) — the worker-UI amendment: the first run is a wizard on the local page — platform, Claude sign-in, approval (owner request; slice S-22.17, WP-294)

**Context.** The owner's first real run (2026-11-05) failed before the page existed. The reasons:
- `compose.worker.yml:96` has `${CLAUDE_CODE_OAUTH_TOKEN:?…}`, so `up` fails at parse.
- `config.ts:119, 136` refuses to start without `APP_CORE_URL` and without the token.
- The device code reaches only a log line (`credential.ts:91-98`); `onCode` is not wired (`runtime.ts:627-633`).
- While the worker waits, the page draws the room, and its mode defaults to *Taking work* (`model.ts:42-46`).
- `claude` exists only in `platform-runtime` (`runtime.Dockerfile:165`). The `platform` image deletes the SDK's binary (`app.Dockerfile:108`).
- `GET release` needs the worker credential (`protocol.ts:11, 434`).
- `claude setup-token` *"opens the same browser authorization flow as `/login`"*. If the browser shows a code instead of redirecting, it is pasted at *"Paste code here if prompted"*. The token is printed and saved nowhere ([code.claude.com/docs/en/authentication](https://code.claude.com/docs/en/authentication), read 2026-11-05).

**Decision.**

1. **The worker starts with nothing.**
   - Without a core URL, Claude token or credential, it serves the page, claims nothing and calls no core until step (c).
   - Compose changes: `APP_CORE_URL: ${APP_CORE_URL:-}` in the template (the core's render still fills the default) and `${CLAUDE_CODE_OAUTH_TOKEN:-}`. An empty value counts as absent.
   - Each value is taken from the **environment** (`_FILE` included) first, then the `worker-state` file, then the wizard. A value from the environment is shown as such and is changed there, not on the page.
2. **A three-step wizard:** (a) platform, (b) Claude, (c) approval.
   - Each step is skipped when already satisfied. Each advances by itself on the existing 2 s state poll.
   - While a step is open, the page shows a **Stepper** (TD-033 §9: done once) *instead of* the room. No mode chip, no Pause, Drain or Cancel.
   - `WorkerLocalState` (local only, not the protocol) gains a `setup` block. `connection` gains `needs_platform`, `needs_claude` and `core_unreachable`.
   - Every word is an exhaustive `Record` in `worker/model.ts`, the `humanize.ts` mechanism, in sentence case.
3. **(a) Connect to a platform.** This step runs only when the environment has no URL. A core-served file always carries one, so prod skips it. In dev mode (S-22.16) it is the main path.
   - **Detect.** The **worker** probes a fixed list: `http://host.docker.internal:{8080,5173}`, plus `APP_WORKER_CORE_CANDIDATES` (environment only). The browser does not probe, because its CSP allows `connect-src 'self'` and its loopback is not the core's. The page offers each candidate that answers as *Use the platform running on this machine*. Compose adds `extra_hosts: host.docker.internal:host-gateway` (Linux).
   - **Type.** A field, checked live by the worker:
     - The URL is `https:`, or `http:` only for `host.docker.internal`, `localhost`, `127.0.0.1` or `[::1]`, and has no userinfo.
     - The worker sends `GET /api/version` and `GET /api/worker/v1/release` with `X-Worker-Protocol`, `redirect: 'error'`, a 5 s timeout, a 64 KiB cap and **no credential**.
     - Answers are parsed by the strict schemas. Only parsed fields (host, version, protocol fit) are shown, as text (BD-022).
     - A failure is a class (*no answer*, *not a platform*, *certificate*, *needs another worker version* from the `426`). The body is never echoed.
     - SSRF: the person holds the bearer and owns the machine, so the fetch reaches nothing they could not `curl`. The bounds keep the worker from becoming a reader of arbitrary bodies.
   - **Stored** as `core-url`.
   - **Change platform** (menu, idle only, *Drain* offered first) deletes `credential`, which belongs to one core. The file now records its core's origin and is ignored for another. The Claude token is kept.
   - The image pins belong to the core the file came from. If the new core's digests differ, claims are refused (images held, §8), and the page shows that core's `curl … compose.yml` + `up -d`. S-22.10's updater re-pins from the **effective** URL.
4. **(b) Sign in to Claude: the official CLI, never a re-implementation** of Anthropic's OAuth client. Their client changes, and Q123 is open.
   - **Binary.** The existing `pull-runtime-image` one-shot copies `/usr/local/bin/claude` into a `claude-cli` volume, mounted read-only in `remote-worker`. That is the exact CLI runs execute. The core image does not grow and the worker gets no Docker client (TD-021).
   - **Process.** The worker runs `claude setup-token` under a pty (`script(1)`, not a native `node-pty`) with:
     - an environment scrubbed of every token variable;
     - a fresh temporary `HOME`/`CLAUDE_CONFIG_DIR`, deleted afterwards;
     - a wide terminal;
     - one session at a time, a 10 min cap, and *Cancel*.
   - **What it reads**, and nothing else:
     - the sign-in URL: a primary *Open Claude sign-in* through `safeHref`, only if it is `https:` on the Anthropic host list the slice measures;
     - the paste prompt: a field, *Paste the code Claude shows you*;
     - the token, by shape (V-WM4).
   - **The localhost callback cannot complete**, because the CLI listens inside the container on an unpublished port. Pasting the code is the route (V-WM10).
   - **Never logged.** CLI output enters no log line or tail. The code and the token join the exact redactor at once.
   - **Fallback, always visible:** *Paste a token instead*, with `claude setup-token` in a `CopyField`.
   - **Check and store.** The token is checked once with the cheapest call the pinned CLI offers (V-WM10; at most one no-tool, one-turn `claude -p`). It is stored as `claude-token`: 0600, atomic, read at each run start, and in no request to any core (WP-283 (2)'s capture test extended).
   - **Sign out / change Claude account** (idle only, *Drain* first) deletes the file. It does not revoke the token at Anthropic, and the page says so.
5. **(c) Approve this machine.**
   - The code is the page's **dominant element**: large monospace letters, with *Copy*.
   - The primary button is *Open the approval page*, linking `<verification_uri>?code=<user_code>`, rendered only if its origin is the core's.
     - The core's `/workers/approve` prefills from `?code=` and strips it from the address.
     - It keeps every warning and the explicit *Approve*, and never approves by itself. This is RFC 8628 §3.3.1's `verification_uri_complete`. The §5.4 residual, a phisher's link that prefills, equals a phisher's typed code.
   - A countdown runs from `expires_at` against `server_time`. A new code appears without a reload: `ensureCredential` already loops on expiry and denial.
   - Approval advances to the room.
6. **`GET /api/worker/v1/release` becomes public**, as `compose.yml` did. Its range and digests already reach anonymous callers through the `426`, and the compose bundle digest is a hash of a public file. The protocol header check stays. **No protocol bump**: no shape changes. An older core's `401` reads *checked partly* and the wizard continues on `/api/version`.
7. **Failures, each with one next action:**
   - **Claude rejected.** An authentication failure, from the check or from a run's stream (golden fixture `documented-adapted`), stops claiming locally and returns to (b): *Claude no longer accepts this sign-in*, then *Sign in again*. The run in flight ends as any CLI failure. A usage limit stays WP-285's pause.
   - **Core unreachable.** `core_unreachable` shows the class and the address, *Retrying in N s* and *Try now*.
   - **Revoked.** *This machine was removed from `<host>`*, then *Connect again*, which deletes the credential and starts a new device flow without a restart.
   - `upgrade_required` is unchanged.
8. **New `POST /api/local/*` verbs:** `core/check`, `core`, `claude/sign-in`, `claude/code`, `claude/token`, `claude/sign-out`, `connect-again`, `retry`.
   - **WP-292's bearer, `Host` and `Origin` checks are enough to write a secret.** Whoever can read the bearer (the logs or the volume) controls Docker and can already read a run's token. No cookie means nothing for CSRF to ride. `Host` stops rebinding.
   - They come with these guards:
     - **write-only**: no answer carries the token, the code or the credential (planted-value test);
     - bounded bodies;
     - a malformed token is refused without echo;
     - a value that comes from the environment answers `409`.
9. **The address.** `up -d` prints no container output, so a profiled one-shot, `address`, prints the page's URL (`ensureUiToken`, exclusive create). Compose starts a profiled service that is targeted explicitly ([docs.docker.com/compose/how-tos/profiles](https://docs.docker.com/compose/how-tos/profiles/)). The file is saved as `compose.yaml` in its own directory, so no `-f` is needed.

**Rejected.**
- *An own OAuth client*: see 4.
- *`claude` in the `platform` image*: every core would carry it, and WP-82 removed it.
- *A sign-in container from the launcher*: a TTY attach through the socket proxy, plus an egress list.
- *Paste-only*: the owner asked for the easiest path; it is kept as the fallback.
- *Detection in the browser*: the CSP and CORS block it.
- *`http:` to any host*.
- *A dimmed room*: it still reads as working.

**Residuals.**
- The CLI's screen text is not a contract. A process test replays V-WM10's measured transcript through a fake `claude`, and it is re-measured at every CLI pin bump. The paste fallback always works.
- A worker whose token was rejected stays *online* to routing until its contact ages out (backlog 884).
- Q123 is unchanged.

**Built by S-22.17** (WP-294).

## Amendment (2026-11-05, architect, session 22) — the worker-UI amendment §2 and the first-run amendment §8–9: no bearer by default; `http://127.0.0.1:7357` opens the page (owner; S-22.17, WP-294)

**Context.** The owner rejected the extra command (*"why do we need this as extra step"*). The
first-run amendment §9 needed `docker compose run --rm address` because the page's bearer lives only
in a log line, and `up -d` prints none. The token also leaves a reusable address in the browser's
history (backlog 775).

**Decision.**
1. **`APP_WORKER_UI_AUTH=none|token`, default `none`.** Under `none` the worker:
   - creates no `ui-token`;
   - reads no `Authorization` header;
   - logs `this worker's page: http://127.0.0.1:<port>` at each start.

   `token` keeps WP-292's behaviour exactly: the 0600 `ui-token`, the fragment address and the
   constant-time bearer `401`. It is the setting for a machine with more than one OS account.
2. **The boundary that stays in both modes:**
   - a `127.0.0.1`-only publish;
   - the `Host` allow-list (`421`, DNS rebinding);
   - on every `POST` (the wizard's token, code, URL and DSN writes included): an exact `Origin`
     (`403`, absent included), `Content-Type: application/json` (so a cross-site `fetch` needs a
     preflight, which is never answered), and `Sec-Fetch-Site: same-origin` when the header is
     present;
   - no CORS header and no cookie.

   A browser page on another origin can therefore neither read an answer nor have a write accepted.
   No answer ever carries a secret (first-run §8, unchanged).
3. **Repointing never carries the developer's Claude sign-in.** Under `none`, *Change platform* also
   deletes the stored `claude-token`, so the new core never runs with the old account. It is refused
   (`409`) while the token comes from the environment. The stepper always names the platform's host
   before the Claude step.
4. **The address step is removed.** The quickstart is: download the file, `docker compose up -d`,
   open `http://127.0.0.1:7357`. The profiled `address` one-shot of first-run §9 is not built.

**Residuals, stated.**
- **Another OS account on the same machine** can reach the loopback port and send any `Host` and
  `Origin` it likes. It can do what the page does: read the redacted view, pause, drain, cancel a
  run (the core records it as the worker's user), sign Claude out, set a DSN, or repoint an idle
  worker. Through 3, the repoint drops the developer's Claude sign-in, so it costs the developer
  their session, not their account. `token` mode is the answer for shared machines.
- **A process running as the developer** gained nothing from the token. Any process that can reach
  Docker could already read `worker-state` and `.env`. A process without Docker access was
  previously stopped by the token and now reaches the page as any other local account does.
- V-WM9 (DNS rebinding and Private Network Access) still holds for the `Host` check.

**Rejected.**
- *A one-shot bootstrap exchange* (the fragment traded for a session token): it still needs the
  logged address.
- *Opening the browser from the container*: it is impossible from inside a container.

## Amendment (2026-11-05, orchestrator-authorised hotfix) — decision 8: "a project member at `member` or above" is the effective role (backlog 886)

§8's eligibility, *"the worker's user is a project member at `member` or above"*, and the online
assignee's *"member"* are read as the **effective project role** that every project-scoped request is
already authorised by (`apps/server/src/auth/rbac.ts`'s `effectiveRole`): the higher of the
organisation role (`users.role`) and a `project_members` row for that project — a membership promotes,
it never demotes. Read literally as a membership row, the claim admitted nobody on a real installation,
because nothing outside the tests writes `project_members`: an organisation admin's connected worker,
holding the right images, claimed nothing (Autix). Both statements now ask one predicate,
`userMayRunInProjectSql` (`packages/infrastructure/src/pipeline/running-role.ts`), whose role list is
derived from the domain's `ROLE_LEVELS`. An organisation `viewer` still runs nothing without a
membership at `member` or above, so `worker.register: viewer` still grants nothing by itself.

## Amendment (2026-11-05, orchestrator-authorised, WP-285) — decision 11: a usage limit excludes no worker, and a limited run's work is saved

1. **No exclusion for a usage limit.** A `rate_limited` ending re-plans the stage entry once with **no**
   worker added to `excluded_worker_ids`; `lease_expired` (a lost worker) keeps the exclusion of §12.
   Why: on a `workers_only` core with one worker (Autix), the exclusion left nobody to claim — a 24 h
   `offer_timeout`, then *Needs human*. The limited worker's own pause (`paused_until`, refused at the
   claim) keeps it off until the reset, so another worker takes the re-offer at once, or the same one
   after the reset. A second limit still escalates (*usage limits ended this stage twice*).
2. **The work is saved** (BACKLOG 694, adopted): `rate_limited` joins `SAVED_UNFINISHED_WORK_REASONS`.
   The export is git only and spends no Claude quota, and the re-plan — the same attempt of the same
   stage entry — checks out that branch and is told the previous attempt's work is there. BD-025's
   2026-10-05 amendment, item 2, is amended to match.

