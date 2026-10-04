# TD-028 — The launcher's transport is a split one: an authenticated HTTP control plane on an internal network, and the run's stdio unchanged on TD-025's control socket

- **Status:** accepted
- **Date:** 2026-09-15
- **Deciders:** architect (ruling on Q52, session 6, while writing milestone M4)
- **Relates to:** TD-021, TD-025, TD-023, TD-020, BD-020, BD-021, BD-025, technical/01, technical/05, Q52, Q59, WP-14, WP-15g, WP-22, WP-53, WP-72, PROGRESS backlog 0b, 34, 35, 49, 71, 82, 109, 110

## Context

**What forces it.** `apps/launcher` is a complete `WorkspaceProvider` service — mirror, credential, workspace, attachment, export, revocation, teardown and a retention sweep — and **nothing talks to it**. `apps/server/src/agent.ts` takes a `RunWorkspaceProvisioner` it is *given*, the provisioner is absent by default, and `startRuntime` therefore composes `unavailableClaudeRunner`, which throws and names the missing piece. So on every build that exists today **no production agent run has ever executed**, and the service's own docblock says why: *"A network transport. TD-021 deploys this as its own container, which implies an RPC surface between the runner and the launcher, and there is no second process to talk to until WP-22 has a compose file"* (`apps/launcher/src/service.ts:31-37`). WP-22 has since shipped that compose file, so the reason for deferring has expired.

**What that absence costs, measured rather than argued.** Eleven open findings are latent for exactly this reason and go live together on the first deployment that composes a provisioner: a credential stored unredacted in `artifacts` (backlog 35), a run that cannot execute one of its project's commands (49), every run starting from the default branch because `RunSpec.checkoutRef` reaches nothing (71), an exec of a CLI path that is not in the container (34), an ask given a container it holds no tool to open (82), a dead run holding a budget reservation for ever (109), a local-mode run committing nothing to any cap (110), and the two lost-wake-up sites (36, 106). None of them can be *proved* fixed until a run runs.

**Three facts constrain the answer, and each is read off the tree.**

1. **The stdio path is already decided and already built.** TD-025 §2: the launcher mounts `ctl/<run-id>/` into the workspace container, and *"the **runner** process (platform side) has the whole `ctl` volume mounted at `/run/agentic/ctl` from its start (static mount, no dynamic mount needed) and connects to `/run/agentic/ctl/<run-id>/ctl.sock`"*. `packages/infrastructure/src/runlet/` implements both ends of the frame protocol and `scripts/runlet-container-check.mjs` verifies it against the real image. **Nothing about the SDK's `SpawnedProcess` needs a network transport.**
2. **The control volume must not be mounted into the API container, and the compose file already says so.** `compose.yml:43-48`: *"**The control volume is not mounted into `app`.** TD-025 §2 gives the *runner* a static mount of the whole `ctl` volume, and that volume holds every live run's token. … mounting it here would hand the container with the HTTP surface a credential it has no code to use. The service that gains the mount is the one that gains the transport (Q52)."* TD-021's WP-15g amendment ranks the same trade for the Docker socket: a separate **container** with no route to the proxy is the only arrangement that preserves blast radius after an RCE in the API process.
3. **Which process runs an agent cannot be decided by `ROLE`.** `apps/server/src/role.ts:39-43`: *"gating the agent runner on the **role** would be a lottery. pg-boss hands a `stage.execute` job to any subscribed worker, so a deployment with `ROLE=worker` beside `ROLE=runner` would give half its agent stages to the process that composes no runner, and each of those would fail its run and escalate its task."* The same file records that per-queue subscription is *"still missing"* and owned by nobody.

## Decision

1. **The transport splits in two, and only the control plane is new.**
   - **Data plane (unchanged):** the runner process keeps TD-025 §2's static mount of the whole `ctl` volume and opens the per-run Unix socket itself. The SDK's `spawnClaudeCodeProcess` returns the existing frame-backed `SpawnedProcess`. **No stdio, no `stdin`/`stdout` and no credential-helper round trip crosses HTTP.**
   - **Control plane (new):** the launcher exposes a small HTTP API for the operations that are request/response — create a workspace, export, destroy, mint and revoke a run credential, and report health. `WorkspaceProvider`/`RunService` stays the port; the HTTP client is one more adapter behind it, and the in-process composition remains valid for the single-process developer mode.
2. **The control plane is reachable only from the runner.** A compose network `launcher-api` with `internal: true` that only the launcher and the runner container join; **no published port**, no route from the `app` service, and no route from any run's network. This is the same arrangement `docker-proxy` already uses for the Engine API.
3. **It is authenticated anyway.** A shared secret (`APP_LAUNCHER_TOKEN`, with the `_FILE` variant TD-020 requires) compared in constant time, on every request, in addition to the network isolation — because a network boundary is a deployment property and an authentication check is a code property, and this surface creates containers. The token is not a credential the launcher mints; it is instance configuration.
4. **Every control-plane operation is idempotent on the run id.** `create` for a run that already has a handle answers the stored handle rather than starting a second container; `destroy` for a run that is already gone succeeds. At-least-once delivery is the caller's assumption everywhere else in this platform, and an operation that starts a container must not be an exception.
5. **`stage.execute` is subscribed by configuration, never by role.** A worker composition subscribes the agent-run queue **only when it is configured to run agents** — a launcher URL and token, or an in-process provisioner. This closes the per-queue-subscription gap `role.ts` names, and it is what makes the two-container topology safe: the API/worker container never takes an agent job it cannot perform.
6. **The shipped compose topology gains one product service.** `app` (`ROLE=api,worker` behaviour via `ROLE=all` on a single-process instance, or `ROLE=api` beside it) keeps **no** `ctl` mount and **no** launcher token; a second container from the same image (`ROLE=runner`) carries both and joins `launcher-api`. `compose.local.yml` keeps the single-process developer mode, where the provisioner may be composed in process.
7. **Failure is typed and loud.** Control-plane errors map onto the existing `WorkspaceError` codes rather than onto raw HTTP status text, so the stage executor's existing ending applies unchanged (Q59: a start failure is retryable or terminal, never a new task state). A worker configured with a launcher it cannot reach **says so by name at composition**, the way `startRuntime` already names the runner piece it lacks.

## Rationale

Splitting the planes is the only shape that keeps three properties at once that a single shape loses. Putting the *whole* provider behind HTTP would mean relaying the agent's stdio through the launcher — TD-025 §5's fallback (a), which that record already ranks below the shim because it couples the stdio path to the launcher process and re-introduces the attach semantics the shim was built to avoid. Putting the *whole* thing in process would mean a Docker client in the process that serves `/webhooks/*`, which TD-021's amendment forbids and `apps/launcher/src/docker-access.test.ts` refuses mechanically. The split keeps the Docker socket in one container, keeps the run's bytes on a Unix socket that never leaves the host, and adds an HTTP surface whose whole vocabulary is five verbs on a run id (seven since WP-103: decision 12's read verb, `GET /v1/runs`, and `destroy` by run id, which is a route of its own, `POST /v1/runs/<id>/destroy`).

Authentication beside network isolation is the same reasoning BD-002 and rule 18 apply elsewhere: a control plane that is safe *only* because of a compose file is safe until somebody writes a different compose file, and this one creates containers.

Per-queue subscription by configuration is not a new idea here; it is the rule `role.ts` already states (*"What decides whether a process can run an agent is its configuration"*) finally enforced at the queue rather than at the run. The alternative — every worker subscribing and half of them failing runs — is measured in that file as a lottery that escalates tasks.

## Alternatives considered

- **pg-boss as the transport** (the launcher subscribes to a queue the platform enqueues to) — rejected: `create` must answer with a handle and a live socket path, jobs are at-least-once, and two deliveries of one create start two containers. It also gives the launcher a database connection it deliberately does not have today (`compose.yml`'s launcher service joins neither the default network nor `db`).
- **Relayed `docker exec` over a WebSocket** (TD-025 §5 fallback (a)) — rejected for the reason TD-025 already gives, and it would put the run's stdio through a second process's event loop for the life of every run.
- **The whole provider in the API process** — rejected by TD-021's WP-15g amendment and by the existing census.
- **A Unix socket for the control plane too**, shared through a volume — attractive (no network at all), rejected because it makes the launcher and the runner co-tenant on one host by construction, which forecloses the Kubernetes path TD-021 and TD-025 both keep open, and because a control plane that cannot be pointed at another host is a control plane that has to be rewritten to scale.
- **Publishing the launcher's port with authentication only** — rejected: no operator benefit, and it puts a container-creating API on the host's network.

## Consequences

- **WP-53 implements this** and is the row that makes eleven latent findings testable; it is verified against the real images with the scripted CLI and **needs no model credential**, so it does not wait on WP-33.
- **WP-72 becomes an assertion of the shipped topology** rather than an exercise of an untested option: two processes, one database, one assertion per crossing (PROGRESS backlog 38).
- **A deployment with no runner container leaves `stage.execute` jobs queued.** That is the honest consequence of decision 5 and it must be visible rather than silent: the queue depth is a metric, `/readyz` reports the runner as absent, and the operator guide states that a compose instance without the runner service runs everything except agent stages. Recorded here so the next reader meets the trade rather than the symptom.
- `.env.example`, `compose.yml` and `docs/operator-guide.md` gain the second service, its token and its network; `technical/01` § Containers and `technical/05` § 2 gain the control plane beside the data plane.
- **To verify** (none of it run here): the launcher's HTTP surface against the real images on both architectures; that the runner container's `ctl` mount sees a socket created by the launcher's `volume-subpath` mount (WP-13 measured `volume-subpath` on Docker Engine 29.7.2 and this is the same mechanism from the other side); and the start-up refusal when the token is absent.

## Amendment (WP-53, 2026-09-23) — decision 5's queue carries the platform gates too

Recorded by the orchestrator from an architect's ruling taken during WP-53, because the
implementation measured a consequence this record did not state. **Decision 5 stands**; what follows
is the trade it makes, written down rather than discovered by the next operator.

**The queue is not agent-runs-only.** Gate evaluation — `ci_gate`, `rebase_gate` and `merged_gate`
(`packages/application/src/pipeline/gates.ts`) — is a *branch of the same `stage.execute` handler*,
on the same queue, registered at the same place. So a process that does not subscribe the queue,
which is exactly what decision 5 makes configurable, also stops evaluating the platform gates, which
are not agent runs and need no runner.

**Why it is not given a queue of its own.** `stage.execute` is `stately` with
`singletonKey: task:<id>`, which is what enforces *a task never runs two stages at once*. A second
queue forfeits that: a gate and a stage for the same task would run concurrently and both write the
task through `settle`. That is a correctness regression bought for the convenience of a degraded
deployment, and the trade is refused in that direction.

**What an operator actually loses, stated narrowly.** Every shipped template puts the gates *behind*
agent stages, so on a runner-less instance no task reaches a gate by the pipeline's own motion. The
reachable paths are **human**: a hand-back to an enabled gate stage, and a `merged_gate` after a human
merge — plus a gate already `pending` when the runner stopped, whose recheck never fires, so
`MAX_GATE_CHECKS` never escalates it.

**Nothing is lost, only delayed.** The jobs are durable and are taken when a runner starts. The bound
is pg-boss's default retention — 14 days, since no `retentionSeconds` is set — and **beyond it the
job is dropped and the task is stranded with no escalation.** No row owns a sweep for that; it is
filed in the backlog rather than implied here.

**So the sentence WP-53's criterion (8) puts in the operator guide reads "everything except agent
stages *and the platform gates*"**, and the bullet above about queued `stage.execute` jobs is to be
read as covering both.

**And the visibility this consequence leans on does not exist, in either half.** The Consequences
bullet above says *"the queue depth is a metric, `/readyz` reports the runner as absent"*. Both
clauses were false when they were written and are still false: `apps/server/src/metrics.ts` registers
five metrics and every one of them is HTTP, SSE or event-dispatch — there is **no** job-queue metric
at all — and `/readyz` does not report the runner. So this decision's stated mitigation for its own
stated consequence is unbuilt, which is worse than an unmitigated consequence because it reads as
handled.

*Closed at WP-86:* `jobs_queued{queue}` and `jobs_queued_oldest_age_seconds{queue}` are the metric, and
`/readyz` reports `agent_runs: degraded` (`details.agent_runs: unserved`, still 200) on every role holding a
job client — an instance-level reading of pg-boss's tables, because the process an operator reads runs no
agent by design. The launcher itself is still not reported.

This correction is recorded here rather than by rewriting that bullet, because a decision record is
amended and not edited. It is **standing rule 78** — *a residual's named mitigation is a claim about
code that exists; grep for it before you write the sentence* — and the amendment above repeated the
same error one paragraph after inheriting it, which is why the rule is cited rather than merely
obeyed. The gap is filed as PROGRESS backlog **135** and owned by WP-72; until it is built, the
honest statement of decision 5's consequence is that a runner-less deployment stalls agent stages and
the platform gates **silently**.

## Amendment (WP-53, 2026-09-23, second) — decision 4's idempotency is scoped to a launcher's lifetime

Recorded by the orchestrator from WP-53's review, because decision 4 reads as unqualified and the
implementation cannot meet it as written.

**Decision 4 says "every control-plane operation is idempotent on the run id".** The shipped
idempotency is **in-process memory**, which is the right choice and not a shortcut: a durable store
needs a database connection this decision's own topology denies the launcher container
(`compose.yml`'s launcher service joins neither the default network nor `db`, which is the same
argument that rejected pg-boss as the transport). So the guarantee is real **within one launcher
process** and is **not preserved across a launcher restart**.

**What that costs was not settled here until WP-82, and an earlier draft of this amendment wrongly settled it.**
A `create` replayed after a restart does not find the stored handle. What happened next was **PROGRESS
backlog 136's open question** — the three candidates were a name collision that leaves the first run's
container orphaned, a rollback, or a second container — and it is now **measured**: the first (the
paragraph *Measured at WP-82* below).

The draft this replaces asserted that no second container starts *"because the container name is
derived from the run id, so the daemon refuses the duplicate"*. That mechanism is **wrong on this
tree** and the correction matters more than the claim did: the first name-derived object `create`
makes is the **network** (`packages/infrastructure/src/workspace/provider.ts:630`), `createVolume` is
idempotent, and `#prepare` — which **rewrites `/ctl/<runId>/token`** — runs *before* any container
name is used. `DockerEngine.createNetwork` sends no `CheckDuplicate`, so whether the daemon refuses
at all is version-dependent and unmeasured. So the collision, if it happens, reads as the **network
or the sidecar**, and the realistic bad case is **not** fail-closed: a replayed create can overwrite
the live run's shim token and *then* fail, orphaning the container it did not know about.

The residual therefore stayed **`needs measurement`**, owned by backlog **136**, until WP-82 measured it.

**Measured at WP-82** (PROGRESS backlog 136, `scripts/launcher-control-plane-check.mjs`, Docker Engine
29.7.2 / API 1.55): a create replayed after a restart, the first create having completed, is refused at
the run's network (`409 … already exists`, `workspace_failed` to the runner) before `#prepare`. The live
run's shim token is untouched, nothing is rolled back, and no second container starts. The first run's
container keeps running with no launcher holding a handle for it. The check asserts the refusal, so a
daemon that stops refusing duplicate network names fails it. Until WP-103 nothing bounded that container;
since WP-103 (decision 12) the runner's orphan pass lists it through `GET /v1/runs` — read off the daemon,
filtered by the instance label — and destroys it once its run is terminal. A restart *during* a create was
measured at WP-103 (backlog 286, Docker Engine 29.8.1): the runner is told `engine_unavailable`, and the
helper the create was running, the network and the volume are left with no run container; the same pass
removes the helper and the network, and the workspace volume is reclaimed by retention once no container
holds it. The bound of decision 4 is still one launcher process; what bounds the orphans a restart
leaves is the reaper — one recovery interval after the run's row is terminal, or an hour after the
container was created for a run id with no row.

The scope is written here because this is the document a reader goes to first. It was already stated
at `apps/launcher/src/control-plane.ts`, in `PROGRESS.md` and in `CLAUDE.md` — three places that are
all downstream of the decision that makes the promise.

## Amendment (WP-76 ruling, 2026-09-25) — the runner mints the run's git credential and the create request carries it

Recorded by the architect before WP-76 starts, because PROGRESS backlog **133** is a transport
decision this record did not take: decision 1 lists *"mint and revoke a run credential"* among the
launcher's verbs, and the launcher cannot mint — it has no binding, no `APP_SECRET_KEY` and no
database (`apps/launcher/src/index.ts:15-20`), so its source is `unwiredCredentials`, which throws
`invalid_spec` (terminal). Read at `6972cbc`; nothing here was run.

**A third consequence 133 does not name.** The agent's own push — `git push origin agentic/*`,
allowed by `DEFAULT_IMPLEMENTATION_ALLOW` (`packages/domain/src/policies/command-policy.ts:277`) —
asks through the credential helper, `cred.get` reaches the **runner**, and the runner answers only
through `RunletSpawnOptions.credentials`, which `createLauncherRunWorkspaceProvisioner` does not
pass (`packages/infrastructure/src/launcher/provisioner.ts`, the `createRunletSpawn` call), so every
answer is *"runlet has no credential responder; refusing"* (`runlet/spawn-adapter.ts`,
`answerCredential`). Fixing the launcher alone would move the failure from `startRun` to the push.

**Decision.**

1. **The runner mints** — the process that composes the provisioner (`apps/server/src/workspaces.ts`),
   which is the `app` image with the database and the secret key (`compose.yml`'s `runner` service).
   It builds the project's git binding through `packages/integrations/src/bindings/loader.ts` and calls
   `GitProviderPort.mintCredential` / `revokeCredential` as `MutatingActionRequest`s through
   `IntegrationActionExecutor`: actions `mint_credential` / `revoke_credential`, keyed by the git
   binding's `integrations.id`, `mode` the task's own. **No idempotency key** — the executor's
   docblock already says a minted credential must not carry one, because the stored result is
   redacted and a replay would answer with `[REDACTED:…]`. `describeResult` records `scope`,
   `expires_at` and `revoke_id` (`<project>#<token_id>`, `gitlab/credentials.ts`, not secret) and
   never the value. The mint happens inside `provision`, i.e. in `stage.execute`'s no-transaction
   phase, and it calls `assertOutsideTransaction` as the pipeline's own provider mutations do
   (`packages/application/src/pipeline/integrations.ts:279` — the guard is there, not inside the
   executor), so a mint from inside a transaction is refused rather than reviewed for. No call leaves through
   CLAUDE.md's binding-less exception: a run credential always has a binding.
2. **One credential per repo-ful run, its scope fixed by the spec**: `push` when `spec.readOnly` is
   false, `read` when it is true — so `RunCredentialSource.mint`'s `'read'` gets its producer and
   backlog 133 (2) closes. Not two tokens for a writing run: `write_repository` is *"pull and push"*
   (research/10, addendum 2026-09-25), and a second token is a second bot user and a second
   revocation to lose. A repo-less spec gets none (WP-74's pairing, unchanged).
3. **The create request carries the material, not a request to mint.** `createRunRequestSchema`'s
   `credential` becomes `{ host, username, password, scope, expiresAt }`: `null` when `spec.repo` is
   null; **required** when the spec writes; `null` allowed for a repo-ful read-only spec only under
   decision 6; and a `push` scope on a read-only spec is **refused** at the schema, on both ends. No
   `revokeId` crosses — the launcher cannot use one. The launcher's `RunCredentialSource` becomes a
   pass-through (`mint` returns what the request carried; `revoke` forgets, calling nobody); the
   broker's three states and `credentialFor` still gate the mirror fetch and the take-over export
   push. The launcher stores the credential **only** in the broker's map — the idempotent-create map
   holds the response, never the request — logs no body, and persists nothing.
4. **The runner answers `cred.get`** from its own copy, with the broker's exact-host comparison
   (not `endsWith`, not a case fold — `broker.ts`'s four negatives), and answers `null` from the
   moment `release` begins. A read-only run's helper therefore hands out a `read` token, which GitLab
   refuses for a push by scope.
5. **Revocation is the runner's, through the executor, exactly once per credential**: after
   `endRun` returns on every ending of `release` (so the take-over export pushes first); on a
   `createRun` that fails for any reason; and the mint is made **once per `provision` call** so a
   client retry re-sends the same credential. Standing rule 19 is met by `revoke_id` carrying the
   project it was minted on. A per-call adapter has no memory of an earlier revoke, so a second
   revoke answers `not_found` (GitLab divergence 6) — hence *once*. **The crash path** (runner dies
   between mint and revoke) is revocable from the audit row's `revoke_id`; WP-47's lease sweep
   (`packages/application/src/recovery/run-lease.ts`) is where it belongs — WP-76 builds it or files
   it by number, and until then the token lives to its expiry.
   **Built at WP-77** (PROGRESS backlog 155): a recovery row of `recovery/stranded.ts` finds every
   terminal run with a `mint_credential` audit row and no successful `revoke_credential` row for the same
   `revoke_id`, and revokes it **by address** from a `pipeline.outbound` job, outside any transaction and
   through the executor — the crash path *and* a teardown revoke that failed. One attempt per
   `revoke_id`; a `not_found` answer is recorded **unconfirmed**, never as revoked. A credential whose
   minting binding has since been unbound was not recoverable this way (PROGRESS backlog 156);
   since WP-80 it is revoked through the minting integration (decision 10).
6. **A binding that cannot mint is a refusal for a writing run, never a fallback.** No git binding,
   or `capabilities().credentialMinting` false (GitLab's `mint_credentials` defaults to **false**,
   `gitlab/config.ts`), fails a writing run **in the runner, before the create**, terminally, naming
   the binding and the setting. The binding's static credential is never sent instead: it is the
   personal access token that *mints* (GitLab: *"You must use a personal access token with this
   endpoint"*), the most powerful secret an instance holds, and sending it to the container with the
   Docker-socket path is the trade TD-021 refuses; BD-025 §3 admits only *narrowly scoped,
   run-lifetime* tokens. A **read-only** run proceeds with `credential: null` (anonymous fetch) —
   today's behaviour, right for a public repository; a private one still fails at the mirror, and the
   operator guide must say a private repository needs `mint_credentials: true`.
   **Amended by the founder's answer to Q98 (b), 2026-10-03 (decision 13 below):** the refusal stands
   for the binding's **own** credential, which is still never sent; a binding whose integration declares
   `run_credential: static` gives the run a dedicated `run_token` instead, and the refusal names both
   settings when neither is configured.
7. **Shadow mode is unchanged**: the executor answers `would_have` and the shadow result is **no
   credential** (never a fake value — rule 18), so a shadow run fetches anonymously. Whether a shadow
   task may mint a read token is **Q98**.
   **Superseded by the orchestrator's ruling on Q98 (a), 2026-09-26, at WP-76's review round 1:** a
   shadow task **may** mint a **`read`**-scoped credential, and nothing else. It is the one declared
   carve-out in the executor's shadow guard (`SHADOW_RUN_CREDENTIAL_CARVE_OUT`,
   `packages/application/src/integrations/action-executor.ts`), and it admits exactly two requests: a
   `mint_credential` whose scope is `read`, and a `revoke_credential` of **any** scope — revoking only
   removes access, so it is the one mutation shadow mode must never suppress (WP-76 review round 2
   measured a shadow revoke of a provider-widened `push` token answered `would_have` and the token left
   live). Neither may carry an idempotency key. The declaration is checked **before** the task's mode is
   read, so a malformed one is refused (`invalid_request`, nothing sent or recorded) in a normal task as
   well; an admitted request is performed and its row's status is `ok` (the event is
   `integration.action.performed`) with the task's `shadow` mode in the row; every other mutating action
   of a shadow task, a `push` mint included, stays `would_have`. A revoke counts as done only on an `ok`
   outcome with a `true` result — anything else is a failure naming the token's expiry. The reasoning is Q98's: without it shadow mode — a quiet trial on a
   real project — cannot fetch a private repository at all. **What it costs, stated**: on GitLab the mint
   creates a project access token **and a bot user visible in the project's settings** for the run's
   lifetime (up to 48 h — the expiry is a date), so a shadow trial is not invisible to a project
   maintainer who looks there; nothing is pushed, commented or transitioned. Q98 (b) — no minting on
   GitLab.com Free — is unchanged: a writing run there is refused.
8. **The value joins the run's redactors**: the run's injected-secret redactor (TD-012 step 1,
   `apps/server/src/agent.ts`) and `IntegrationCallScope.runScopedSecrets` (Q55) for that run's
   provider calls, so a transcript row, an artifact or a CI log that echoes it is redacted. The
   redactor must be able to learn a value minted after it was built; the implementer makes that
   order hold.

**Alternatives rejected.** A launcher `RunCredentialSource` calling back to the platform, and a
launcher with its own binding and secret key — both widen the one container with a Docker-socket
path (133's reasoning, adopted). The static binding credential for the fetch — decision 6. Minting in
the `app` process — it does not run `stage.execute` (decision 5), so the token would need a second
crossing. Two tokens per writing run — decision 2. Deploy tokens for `read` (every GitLab tier,
including GitLab.com Free, but no repository write and no port member today) — noted in Q98.

**Sentences this overturns, to be rewritten by WP-76 in the same change (rule 83).**
`protocol.ts:130-137` (*"The launcher **mints** through its own `RunCredentialSource`"*) — the
second clause survives: the scope is still decided platform-side. `broker.ts:5` (*"The launcher
mints"*) and its `RunCredentialSource` docblock. `apps/launcher/src/index.ts:15-27` and `:45` (which
cites the answered Q52). TD-021's credentials bullet — amended there by cross-reference.

**Residuals, stated.**
- **The runner holds a push token for the life of the run**, not one request, because it answers
  `cred.get`. It adds nothing an attacker with code execution in the runner lacks: that process can
  decrypt the minting token already.
- **The launcher holds it from create to end**, which is TD-021's original design; a launcher
  compromise is already ≈ host root (research/10, threat model).
- **Lifetime is up to two days, not 24 hours**: `RUN_CREDENTIAL_TTL_SECONDS` is 24 h and GitLab
  grants to midnight UTC on or after it (`expiryForTtl`). A retried mint whose first response was
  lost leaves a token with no known `revoke_id`, visible as `agentic-<scope>-<date>` and dying at
  expiry.
- **`agentic/*` is not enforced by GitLab** (Q40): the protected default branch is the control.
- **Code in the container can read the token through the helper** — BD-025 §3 permits it for the
  run's lifetime; decision 8 keeps it out of what the platform stores, not out of the container.
- **GitLab.com Free cannot run a writing stage at all** (project access tokens need Premium there).
- **A launcher restart between create and a take-over export** loses the credential: the export
  answers `pushed: false` and the tarball is the only copy.

## Amendment (WP-43, 2026-09-26) — held inbound connections

A provider transport the platform holds open (Slack Socket Mode) is composed by the process that serves
`/webhooks/*` (`ROLE=api`/`all`), decided by construction: the connection supervisor
(`packages/application/src/integrations/inbound-connections.ts`) is handed that process's webhook ingress,
and a worker-capable process without one holds nothing and names each account it is not holding (a role
with neither capability composes no integration stack and names nothing; none exists in this build). N
`api` replicas hold N connections (Slack: at most ten per app, each payload to one of them, a redelivery
possibly to another); `inbox (provider, delivery_id)`, keyed by payload, is the backstop. There is no
dedicated `slack` role. The socket signs each envelope with the binding's own signing secret so that
`inbound.verify` stays the single authority — which makes the **WebSocket host the real trust boundary**:
a host that is not the binding's allow-listed `base_url` host or a subdomain of it is refused, by name,
before any connect (`assertSocketHost`, the folded half of PROGRESS backlog 196). Shutdown closes every
held socket, including one whose open was still in flight when the stop began.

**Amendment (WP-72, 2026-09-27) — the crossings of the shipped topology, and the API role's queue client.** The two product processes share nothing but the database, and each crossing is asserted through two processes in `test/e2e/topology/two-processes.e2e.test.ts`: (1) a command's effect — answered by a process that runs no worker, performed by a worker through the job queue; since WP-72 `ROLE=api` holds an **enqueue-only** pg-boss client (supervision and cron off, every worker operation refused by name, `apps/server/src/enqueue-only-jobs.ts`), which it did not before, so on `ROLE=api` a knowledge approval waited for the nightly pass and every command that starts a stage was refused; (2) a run's transcript — written by the runner, streamed by the process that serves the API over `NOTIFY` and a read-back; (3) readiness — per process, `dispatch` only on worker roles, plus the instance-level `agent_runs` line since WP-86; (4) the chat socket — held by the process that serves `/webhooks/*`, which renews `held_connection_liveness` (migration 0054) so an approval is posted with buttons only while some process holds it; (5) steer and take-over did **not** cross: on this topology the process that serves the API never holds a run, so every steer was refused `run_not_reachable` (PROGRESS backlog 134) — **superseded at WP-85**: they cross through a `run_commands` row and `pg_notify` to the lease holder (decision 9), asserted through both processes; (6) a run credential is redacted by exact value only in the runner, and elsewhere by the pattern rules alone, which cover GitLab's default `glpat-` prefix and not an administrator-chosen one (PROGRESS backlog 154, decision (a); (b) filed as 259) — **superseded at WP-80**: every process now redacts it by the shape recorded beside the mint's audit row (TD-012's M5 amendment). For this crossing the tier proves the **composition**, not the per-process behaviour: both `apps/server` instances run in one Node process and the installed shape rules are module state (`packages/infrastructure/src/redaction/pattern-redaction.ts`), so it cannot tell which instance's refresher installed a rule; that each `ROLE` subscribes and reads is asserted per role by `test/integration/redaction/shape-refresh-roles.integration.test.ts` (WP-107; PROGRESS backlog 360). The Consequences bullet's *'the queue depth is a metric, `/readyz` reports the runner as absent'* remained unbuilt and unowned (PROGRESS backlog 135, declined by WP-72) — closed at WP-86.

## Amendment (M5 architect pass, session 8, 2026-09-27) — a command reaches a run through the database, and an unbound credential is revoked through the integration that minted it

Two decisions M5's rows need before code, both on this record because both are consequences of
decision 6's two-process topology. Neither changes decisions 1–8.

**9. A human command for a live run (steer, take-over's stop) reaches the process holding it through
the database, never through a new network route.** PROGRESS backlog **134** measured the cost of
decision 6: the process serving the API is pinned never to hold a run (`apps/server/src/role.ts:106`,
`runner: { api: false, … }`), the live-run register is per process, so `steerRunCommand` refuses every
steer on the shipped topology (`packages/application/src/pipeline/commands.ts:1295-1297`) and a
take-over records `runId: null` (`:1409`). The shape:
- the API process **records** the command — a `run_commands` row (run id, kind, redacted payload,
  actor, `Idempotency-Key`-derived id) in the same transaction as the aggregate operation and the
  `human_actions` row the route already writes — and answers `202 accepted`, never a claim that the
  model heard it;
- it wakes the holder with `pg_notify` on a channel keyed by `runs.lease_owner` (the column WP-47 gave a
  writer, `0004_pipeline.sql:90`); the process that holds the lease `LISTEN`s through the existing
  broadcast adapter (`packages/infrastructure/src/broadcast/postgres-broadcast.ts`) and **also polls its
  own leased runs' pending rows on the heartbeat**, because a notification is not delivered to a process
  that was reconnecting — the notify is latency, the poll is the guarantee;

  *Amended at WP-85 (orchestrator, session 9):* the `human_actions` row is **not** in the command's
  transaction. Every command writes it after `perform`, under the WP-67 idempotency claim
  (`apps/server/src/routes/commands.ts`), and the run command follows that one rule rather than a second.
  A crash between the two writes leaves the committed `run_commands` row and its event (which carry the
  author), no audit row, and the key held, so a replay answers `idempotency_attempt_unknown` rather
  than performing again. The `run_commands` row itself is written in the aggregate operation's
  transaction, as above.

- the holder applies the command to its in-process register, stamps `applied_at` or a typed
  `refused_reason` (run no longer live, register miss), and the task screen reads that stamp; a row
  still pending when the run ends is closed `run_ended` by the run's own ending, in its transaction;
  *(WP-85: the stamp is taken before delivery as the exactly-once arbiter; a steer whose delivery then
  throws is re-stamped `delivery_failed` — never back to pending — and a row the holder cannot decode is
  refused `undecodable` on its own. A take-over's stop is not awaited, so a stop that fails after the
  stamp leaves the row `applied` with the error logged — the stated residual.)*
- the single-process mode (`ROLE=all`) takes the same path, so there is one mechanism to test.

*Alternatives rejected:* HTTP from the API process to the runner (gives the runner an inbound
listener and an address, which decision 2 exists to avoid, and a second authenticated surface); a
pg-boss job per command (at-least-once to *any* subscribed worker, while the command must reach the one
process holding the run); routing the API role's steer to "whichever process" by retry (the lottery
`role.ts` already refuses).

**10. A minted run credential whose project is no longer bound to the minting integration is revoked
through the minting integration.** PROGRESS backlog **156** half 3. Since WP-73b the recovery pass
*reports* such a credential and leaves it live to its expiry
(`packages/application/src/recovery/run-credential.ts:64-69`), because the query requires the mint's
`integration_id` to be the project's git binding still. The join exists to stop an address reaching a
host that did not issue it; the minting integration is **by construction** that host, and the audit,
idempotency and rate-limit records are already keyed by `integrations.id` (technical/06, WP-51), so a
revoke through it is truthful in every record it writes. So:
- the revoke (teardown and recovery alike) builds its adapter from the **minting `integrations.id`**,
  bound or not; the binding join is dropped from the recovery predicate and kept as the *refusal* in the
  one case it was right about — a revoke must never go through an integration **other** than the one
  that minted (WP-73b's teardown refusal stands);
- when the minting `integrations` row itself is gone (deleted), the credential is reported exactly as
  today and lives to its expiry — there is no host left the platform may call;
- WP-73b's report line becomes a revoke attempt, one per `revoke_id`, and a `not_found` answer stays
  *unconfirmed*, never *revoked*.

*Alternatives rejected:* refusing a binding change while an unexpired, unconfirmed credential exists
(makes an operator's provider swap hostage to a crashed run for up to 48 hours); keeping *report and
expire* (a known live push credential the platform could revoke and chooses not to).

*Consequences.* A migration for `run_commands`; the steer route's answer changes from a synchronous
delivery to *accepted, then applied or refused* on the run screen; `docs/technical/05` § 2 and
`docs/technical/08`'s steer and take-over rows are amended by the row that builds decision 9 (M5
**WP-85**), and decision 10 by **WP-80**.

## Amendment (M6 architect pass, session 9, 2026-09-30) — a cancel reaches the session, and an orphaned run container has a reaper

Two decisions M6's rows need before code. Both extend decision 9's channel or decision 1's
control-plane surface; neither changes decisions 1–10.

**11. A cancel of a run whose lease is live is a run command, and a run with no live lease is ended in
place.** PROGRESS backlog **294**: since WP-85 the channel that stops a live session exists and the
take-over uses it, while `cancelRunCommand` still only wins the `runs` row, so the session spends to its
own end and its cost arrives late through `runs.recordCost`. So:
- `run_commands.kind` admits `cancel` (a new forward-only migration; 0060 is not edited);
- when `runs.lease_expires_at` is in the future, the cancel records a `cancel` row in the aggregate
  operation's transaction, pauses the task there as today, notifies the lease holder and answers `202`.
  The holder applies it as the take-over does, through `handle.stop`, and the run ends `cancelled` in
  its own process with its measured cost. There is **one terminal writer**, the holder, and the
  heartbeat poll is the guarantee, exactly as decision 9 says;
- when the lease is absent or expired, no process holds the session, and the cancel ends the record in
  place as it does today (the synchronous answer is kept for this branch only);
- a holder that dies before applying leaves the row to the lease sweep (WP-47), whose `run.failed` with
  `lease_expired` closes it `run_ended`. The run then reads `lease_expired` rather than `cancelled`, which
  is the truth: no process confirmed the stop.

*Alternative rejected:* recording the row **and** ending the record synchronously (backlog 294's option
(ii)). The heartbeat stops with the terminal row, so the stop would rest on the notification alone —
at-most-once — and `finish`'s `run_ended` closing would need an exemption for `cancel` rows.

**12. The launcher lists the run containers it labelled, and a runner-side recovery row reaps the ones
no run owns.** PROGRESS backlog **286**: the launcher's only record of a run it created is its memory
and the handle it returns, so a container whose handle never reaches the runner (a lost create answer,
a restart during a create, a replay) keeps running, and nothing reconciles the daemon with `runs`.
Decision 4's idempotency is scoped to a launcher's lifetime (the second WP-53 amendment), so it cannot
be the bound. So:
- the control plane gains **one read verb** answering the run ids of the containers and networks carrying the run
  label (networks since WP-118's pre-review round: a create killed before its first container leaves one), read from the daemon rather than from the launcher's memory, authenticated like every other
  operation (decision 3);
- `destroy` by run id removes a run's objects whether or not the launcher holds a handle, by label, and
  stays idempotent (decision 4);
- the reaper is a **recovery row in the runner**, which reads `runs`: a listed run id whose run is
  terminal, or is unknown and older than a stated grace, is destroyed, one attempt per id per pass, and
  counted. The launcher still reads no database (TD-021's amendment), and the decision about *which*
  container is an orphan stays with the process that can see the runs;
- the launcher abandons a create whose request closed before the response and removes what it made, or
  its docblock states why it cannot.

*Alternatives rejected:* a launcher-side reaper that reads `runs` (gives the one process with the Docker
socket a database role, which TD-021 forbids); a TTL label the launcher enforces on its own (reaps a
long, live run by the clock, or leaves an orphan for as long as the TTL).

*Consequences.* A migration for decision 11; decision 12 adds a verb to decision 1's list and a row to
the recovery table. `docs/technical/05` § 2 (the WP-53 amendment), `docs/technical/08`'s cancel row,
`docs/user-guide.md`'s cancel paragraph and `CLAUDE.md`'s WP-53 paragraph are amended by the rows that
build them: decision 11 by M6 **WP-101**, decision 12 by M6 **WP-103**, whose first criterion is the
daemon measurement 286 asks for.

## Amendment (2026-10-03 — the founder's answer to Q98 (b)) — a static run credential, opt-in, where the provider cannot mint

Recorded by the architect at the product owner's first local test (plan § "Milestone M8", row
**WP-137**): the test runs on **gitlab.com Free**, which cannot create project access tokens
(research/10, 2026-09-25 addendum), so under decision 6 no stage can fetch the private repository and no
writing stage runs. The founder chose an explicit, opt-in fallback (BD-025's amendment of this date).
Nothing here was run; it is read off `packages/application/src/pipeline/integrations.ts`
(`runCredentialWrites`) and `packages/integrations/src/providers/gitlab/{config,index}.ts` at `d07ae04`.

**13. A static run credential.**

1. **Where it is declared.** On the git **integration** (the account, where `mint_credentials` lives),
   never on the binding's API token: a config key `run_credential: minted | static` (default `minted`)
   and a **separate secret field** `run_token`, listed in the provider's `secretFields` so the loader
   decrypts it, `GET /api/integrations` strips it and it is sealed only through `secret_refs` (TD-020). A
   write is refused, by name, when `static` has no `run_token`, when `run_token` equals the API token
   (exact comparison of the two decrypted values, at the write and again at use), and when
   `mint_credentials: true` and `static` are both set (one source per integration, so the audit says
   which). A static integration may carry **one** project binding: a second is refused (`409`), because
   the token's reach is a membership the platform cannot see and a second project would share it. GitLab
   also takes `run_token_username` (non-secret; the helper's username) and `run_token_expires_at` (an ISO
   date, required, at most **90 days** ahead at the write), because the platform does not use the token to
   ask GitLab its own expiry (item 3).
2. **How it reaches a run.** `runCredentialWrites.mint` returns a third kind, `static`, when minting is
   off and the integration is static: the **same** `RunCredential` material (`host`, `username`,
   `password`, `scope: 'push'`, `expiresAt` = the declared date) on the **same** control-plane create
   request (decision 3), the broker map in the launcher, the runner's `cred.get` answer with the
   exact-host comparison (decision 4) — never in an environment variable, a file in the image, the
   prompt or a log. A read-only spec gets the same token: it cannot be narrowed (the loss is item 5). It
   joins the run's injected-secret redactor and `runScopedSecrets` exactly as decision 8 says for a
   minted value; and because it is a declared secret field, every process that loads the binding already
   redacts it by exact value. The GitLab `glpat-` pattern rule is the backstop elsewhere. A use past
   `run_token_expires_at` is refused before the create, naming the date. No `mint_credential` /
   `revoke_credential` audit row is written (no call is made); the run records `credential_source`
   (`minted` | `static` | `none`) and the integration it came from, so *which credential a run had* is
   answerable from the audit.
3. **What it may not do.** The platform never uses `run_token` for its own provider calls — the adapter's
   API client is built from the API token alone, and a test holds that `run_token` is read only by the
   run-credential path. The platform does not probe it either; the probe (`POST /api/integrations/:id/test`)
   reads, **with the API token**, the declared user's membership of the bound project and **refuses an
   access level above Developer** (a Maintainer can unprotect the default branch, which is the push
   control, Q40), and reports that it cannot confirm the token belongs to that user.
4. **Shadow mode.** A shadow task is **not** given a static credential: it is push-capable and cannot be
   narrowed to the `read` decision 7 admits. The executor-equivalent answer is *no credential* (rule 18),
   so a shadow run on a private repository on gitlab.com Free still fails at the fetch, by name.
5. **What is lost, stated.** No per-run revocation and no run-lifetime bound: the token lives to its
   declared expiry. Code in the container can read it through the helper (as with a minted one), and the
   run's egress admits the git host, so it can be pushed **into the repository itself** — where, unlike a
   revoked minted token, it still works. Its reach is bounded by the dedicated user's memberships (one
   project) and its scopes (`read_repository`/`write_repository` grant no REST API), not by the
   platform. A read-only stage holds a push-capable token. The control the platform adds: the gates that
   already read the merge request's added lines (`dependency-gate.ts`'s reader) search them for the exact
   value, and a hit parks the task *Needs human* with a brief that says **rotate the run token** and never
   prints it.
6. **The refusal when neither is configured**, terminal, before the create, naming the binding and both
   settings: *"the git binding <id> (gitlab) cannot give run <id> a credential: minting is off (GitLab:
   `mint_credentials: true`, which needs Premium on GitLab.com) and no static run credential is configured
   (GitLab: `run_credential: static` with a dedicated `run_token`; weaker isolation, operator guide §
   Integrations). The binding's own token is never sent instead (TD-028 decisions 6 and 13)."* The
   provider's words come from `CredentialMintingHints` (WP-107), which gains a `static` hint.

*Alternatives rejected.* Sending the binding's API token (decision 6's reasoning, unchanged). A deploy
token (every tier, `read_repository` only — no push, so no writing stage). A deploy **key** (SSH, push
possible, but the run's git path is HTTPS through the credential helper and the egress proxy). A group
access token (Premium on GitLab.com too).

*Consequences.* A migration (`runs.credential_source`); the GitLab config schema, catalogue and setup
guide; `docs/operator-guide.md`'s integrations section and `docs/first-local-test.md`'s GitLab step and
failure table (rule 83); technical/05's credentials paragraph and technical/06's GitLab section.

## Amendment (2026-10-04 — the founder's follow-up to Q98 (b)) — decision 13 gains two operator-chosen variants: the operator's own repository-only token, and a project SSH deploy key

Recorded by the architect (M8 round 3, PROGRESS § "Architect ruling (M8 round 3, session 11)"; plan rows
**WP-141** and **WP-146**). The founder: *support either option and let the admin decide*, alongside
decision 13's dedicated-user token. A dedicated user costs a seat on gitlab.com; the two variants do not.
Nothing here was run. Sources: research/10's 2026-10-04 addendum.

**13a. The operator's own token, repository-only** (`run_credential: static`, `run_token_owner:
operator`; the default `run_token_owner: dedicated_user` is decision 13 unchanged). Everything in
decision 13 items 1, 2, 4 and 6 holds (separate secret field, refusals at write and use, one binding per
static integration, the same create-request → broker map → `cred.get` path, redaction, no shadow
credential, `credential_source = static`). Item 3 changes for this owner only:
1. **The role check is replaced by a scope proof.** The probe does **not** refuse a Maintainer or Owner;
   instead it makes exactly **one** call with `run_token` — `GET /api/v4/user` — through
   `IntegrationActionExecutor` as a read (audited, rate-limited; the value redacted from the row) and
   **refuses unless the answer is `403`** (the body's `insufficient_scope` recorded when present; the
   exact shape is measured first, docs/TODO.md). A `2xx` is refused by name: *"this token can call the
   GitLab API; create one with only `read_repository` and `write_repository`"*. This is the platform's
   only use of `run_token` against the API, and the census decision 13 item 3 asks for admits that one
   probe call and nothing else. Why the role may be high: a token with no API scope cannot change
   protection, membership or settings — those are API operations — so what a Maintainer could do through
   the API is out of the token's reach; what it can still do is git, and git is bounded by item 2.
2. **The default branch's protection is the push control, and the probe checks it.** With the
   **API** token, the probe reads the bound project's protected branches and **refuses** unless
   `projects.default_branch` is protected with push access **No one** (`push_access_levels` holding only
   access level 0) and force-push off. A Maintainer's git push to an unprotected or Maintainer-push
   default branch would otherwise succeed. The check is repeated before each create of a run that
   receives this credential (one read, cached for the run's lifetime), so an operator who loosens
   protection after the probe is refused at the next run, by name.
3. **Lost, stated** (in addition to decision 13 item 5): the token reaches **every repository the user
   can access**, not one project — a read-only stage holds read access to all of them and a writing stage
   push access to every unprotected branch of all of them. A second binding is still refused on the
   integration (the audit stays one-integration-one-project), but nothing stops the operator binding
   another integration with the same value; the platform does not detect it. `read_repository` also
   grants the repository files API (research/10), which is a read the platform does not use.

**13b. A project SSH deploy key with write access** (`run_credential: deploy_key`). Free on every tier,
scoped by GitLab to the projects it is enabled on, no user and no seat (the seat half is `[unverified]`).
1. **Declared** on the git integration: a secret field `run_ssh_private_key` (an **unencrypted OpenSSH
   Ed25519** private key; any other type or a passphrase is refused at the write, because the signer
   below implements Ed25519 only) and a non-secret `run_ssh_public_key`. Refused like decision 13:
   `deploy_key` with `mint_credentials: true`, a second binding, a public key that is not the private
   key's (checked at the write by deriving it). `run_token` and the key are mutually exclusive.
2. **The key never enters a run container.** The run's `/ctl` volume carries a second socket,
   `/ctl/ssh-agent.sock`, served by the run shim, which speaks the **ssh-agent protocol's two requests a
   git client needs** (list identities, sign) and relays each sign request over the existing frame
   channel to the **runner**, which holds the key (from the create path, as decision 13 item 2) and signs
   with Ed25519. Every other agent request is refused. The container therefore holds a *signing oracle
   for the run's lifetime* — the same reach as a credential helper — and never the key: when the run ends
   there is nothing to exfiltrate, which is strictly better than decision 13's token. Each sign is
   counted on the run (not logged with content).
3. **Git uses it through configuration, not files the agent writes.** The launcher's
   `cliEnvironment` (WP-118's one function) adds `GIT_SSH_COMMAND` = `ssh -F /dev/null -o
   IdentityAgent=/ctl/ssh-agent.sock -o IdentitiesOnly=no -o StrictHostKeyChecking=yes -o
   UserKnownHostsFile=<platform-written file> -o HostKeyAlias=gitlab.com -o ProxyCommand=<the shim's
   CONNECT helper> -p 443` and one `GIT_CONFIG_*` pair `url.ssh://git@altssh.gitlab.com:443/.insteadOf =
   https://gitlab.com/`, so fetch and push of the repository's ordinary URL go over SSH; the HTTPS
   credential helper is not configured for such a run. `known_hosts` is written by the platform from the
   **documented** gitlab.com host keys (a constant with its source, research/10), never from a first
   connection. The run image gains `openssh-client` (pinned, the size measured).
4. **Egress stays HTTP `CONNECT` on port 443.** The sidecar is tinyproxy; SSH reaches gitlab.com through
   it as a `CONNECT altssh.gitlab.com:443` from the shim's helper (the shim already holds the proxy
   address; no `nc`/`socat` is added), and `altssh.gitlab.com` joins the run's egress list for such a
   run only. **No `ConnectPort 22`** is opened: tinyproxy's `ConnectPort` is global, so admitting 22 would
   admit it for every allowed host. Therefore a **self-managed** GitLab (no `altssh` endpoint) is
   **refused by name** for `deploy_key` on this build — *"SSH deploy-key runs reach gitlab.com through
   altssh.gitlab.com:443 only; a self-managed host needs its SSH port admitted by the egress sidecar,
   which this build does not do"* — and filed, not built.
5. **The launcher's mirror** (`updateMirror`'s helper container, TD-021) fetches over the same SSH
   route with the key written to a `0600` file on the helper's tmpfs for the helper's lifetime — the same
   exposure class as today's `GIT_PASS` in that helper's environment, stated rather than improved. **The
   platform's own vault mirror (TD-026) is unchanged: HTTPS with the binding's API token**, because it is
   the platform's read path and the binding token is the platform's credential.
6. **The probe**, with the API token: `GET /projects/:id/deploy_keys` must list the declared public key
   with `can_push: true`; the default branch must be protected with push **No one** and the key must not
   be in its push access levels (a deploy key can be admitted to a protected branch); the probe states
   it cannot see whether the key is also enabled on other projects.
7. **Shadow**: no key (it cannot be narrowed to `read`), as decision 13 item 4. `credential_source`
   gains `deploy_key`. The added-lines exact-value search covers the private key's base64 body.
8. **Lost, stated**: no per-run revocation (removing the key from the project is the revocation); a
   read-only stage can sign pushes; the oracle can be asked to authenticate to any SSH server the
   egress admits (only `altssh.gitlab.com`), so its reach is every project the key is enabled on.

*Alternatives rejected.* A key file in the run container (exfiltrable, outlives the run).
`ConnectPort 22` (global in tinyproxy). An SSH-capable second sidecar (a new service for one provider
variant; revisit if self-managed SSH is asked for). Using the deploy key for the platform's own vault
mirror (it is a run credential; the vault mirror needs no write).

*Consequences.* A migration (`runs.credential_source` gains `deploy_key`; no column for 13a); the GitLab
config schema, catalogue, setup guide and `CredentialMintingHints`; the run shim's frame protocol (a
`ssh.sign` request/answer pair, `@platform/contracts`); the run image; the egress renderer's per-run
host; operator guide, `docs/first-local-test.md`, technical/05 and /06 (rule 83).
