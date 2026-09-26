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

Splitting the planes is the only shape that keeps three properties at once that a single shape loses. Putting the *whole* provider behind HTTP would mean relaying the agent's stdio through the launcher — TD-025 §5's fallback (a), which that record already ranks below the shim because it couples the stdio path to the launcher process and re-introduces the attach semantics the shim was built to avoid. Putting the *whole* thing in process would mean a Docker client in the process that serves `/webhooks/*`, which TD-021's amendment forbids and `apps/launcher/src/docker-access.test.ts` refuses mechanically. The split keeps the Docker socket in one container, keeps the run's bytes on a Unix socket that never leaves the host, and adds an HTTP surface whose whole vocabulary is five verbs on a run id.

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

**What that costs is not settled here, and an earlier draft of this amendment wrongly settled it.**
A `create` replayed after a restart does not find the stored handle. What happens next is **PROGRESS
backlog 136's open question**, and this record must not close it — the three candidates are a name
collision that leaves the first run's container orphaned, a rollback, or a second container, and
which one occurs is **unmeasured**.

The draft this replaces asserted that no second container starts *"because the container name is
derived from the run id, so the daemon refuses the duplicate"*. That mechanism is **wrong on this
tree** and the correction matters more than the claim did: the first name-derived object `create`
makes is the **network** (`packages/infrastructure/src/workspace/provider.ts:630`), `createVolume` is
idempotent, and `#prepare` — which **rewrites `/ctl/<runId>/token`** — runs *before* any container
name is used. `DockerEngine.createNetwork` sends no `CheckDuplicate`, so whether the daemon refuses
at all is version-dependent and unmeasured. So the collision, if it happens, reads as the **network
or the sidecar**, and the realistic bad case is **not** fail-closed: a replayed create can overwrite
the live run's shim token and *then* fail, orphaning the container it did not know about.

The residual therefore stays **`needs measurement`**, owned by backlog **136**, which is cited two
lines below and which exists precisely to leave this open.

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
   minting binding has since been unbound is not recoverable this way (PROGRESS backlog 156).
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
