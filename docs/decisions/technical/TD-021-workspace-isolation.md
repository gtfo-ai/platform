# TD-021 — Workspace isolation: container-per-run created by a socket-proxied launcher; SDK on the platform side spawning the CLI in the container; per-run internal network with egress proxy

- **Status:** accepted (spawn transport decided in TD-025)
- **Date:** 2026-08-28
- **Relates to:** research/10, research/05, technical/05, BD-021, BD-025, BD-020

## Decision
- **Launcher service** (`ROLE=launcher`) is the only component that can reach the Docker socket, via `docker-socket-proxy` (`CONTAINERS`, `NETWORKS`, `VOLUMES`, `IMAGES`, `POST`; `EXEC`, `BUILD`, `SECRETS` off). It implements the `WorkspaceProvider` port: `create(RunSpec) → handle`, `attach(handle) → SpawnedProcess`, `kill`, `export`, `destroy`, `broker`.
- **Per run:** an `internal: true` network `run-<id>`, an egress-proxy sidecar (tinyproxy/squid, allow-list rendered from project config; phase 2 Envoy with credential injection), a workspace container from the `platform-runtime` image (Claude binary + CLIs, no platform code) running as uid 1000 with `cap-drop ALL`, `no-new-privileges`, read-only rootfs, `/tmp` tmpfs, memory/CPU/pids limits (project defaults 2 CPU / 4 GiB / 512 pids), `init: true`, `runtime: runc` (`runsc` opt-in per project on Linux hosts). Volumes: `ws-<id>` rw at `/work`, per-project bare mirror ro at `/cache`.
- **SDK placement (option C):** the Agent SDK runs in the platform `runner` role and spawns `claude` inside the container through `spawnClaudeCodeProcess`, carried by the in-container run shim over a Unix socket on a per-run control volume (TD-025). Hooks, `canUseTool` and the platform MCP tools run on the trusted side; integration tokens never enter the container. Fallbacks are listed in TD-025.
- **Credentials:** the container holds only `HTTPS_PROXY`, `CLAUDE_CONFIG_DIR` and non-secret project vars; git uses `credential.helper=!agentic-cred`, which asks the run shim over the control socket (TD-025) for a run-scoped GitLab project access token minted by the launcher (Developer, `write_repository`, expires next day, revoked at run end); the Anthropic key is masked/injected at the proxy in phase 2 (phase 1: in env, documented). Protected branches enforced server-side; `PreToolUse` denies pushes outside `agentic/*`.
- **Lifecycle:** bare mirror per project updated before each run; `git clone --reference` per run; export on take-over = push `agentic/<task>` + transcript copy + optional tarball; container/network/sidecar removed at run end; volume retained per policy (default 14 days for paused/taken-over tasks, 3 days otherwise).

## Rationale
Container-per-run is the only model that gives per-task filesystem, process and network isolation without KVM; keeping the SDK on the platform side yields BD-025 (no tokens in the agent) for free; the internal network + proxy makes "ignore the proxy env" harmless.

## Alternatives considered
Shared runner + worktrees + bubblewrap (needs weakening seccomp; shared `.git` state); gVisor default (10–200× slower file I/O for installs); Firecracker/Kata/Docker Sandboxes (KVM); Kubernetes first (BD-020 says later).

## Consequences
- WP-13 implements the run shim and runner adapter (TD-025) with conformance tests; remaining checks: embedded DNS on internal networks; token minting on self-managed Free; `volume-subpath` on the target Docker version.
- Kubernetes provider later: Job/`agent-sandbox` per run, NetworkPolicy + Cilium FQDN, exec/attach WebSocket for the spawn hook.

## Amendment (WP-15g, 2026-09-12) — "only component" is a *deployment* boundary, and `ROLE=launcher` does not exist

Recorded from an architect ruling taken before WP-15g composed the agent runner, because the
implementation would otherwise have contradicted this record by implication.

**The correction first.** This decision's own line 8 says the launcher is `ROLE=launcher`. **There is no
such role.** `apps/server/src/role.ts:22` is `all | api | worker | runner | indexer`; the launcher is its
own app, bin and env schema, and `docs/technical/01-architecture-overview.md:21-22` already deploys it as
its own image. `.env.example`'s launcher section repeated the same error. Read every `ROLE=launcher` in
this document as **the `platform-launcher` container**.

**So "only component" cannot be satisfied by a `ROLE`,** and it must not be read as a package boundary
either. Ranked by what survives an RCE in the API process: a **separate container** with no socket bind and
no route to `docker-socket-proxy` is the only arrangement that preserves blast radius; a separate process
helps only if the OS denies the socket to that uid, which nothing does today; a separate `ROLE` gives
nothing, because `ROLE=all` is the shipped default and would put the socket beside the platform's only
unauthenticated endpoint (`/webhooks/*`); and a separate **package** gives nothing at runtime, since
`DockerEngine` is already reachable through `@platform/infrastructure`, which `apps/server/package.json:25`
depends on. **This decision requires the container.**

**No process that composes the pipeline or serves `/webhooks/*` may construct a Docker client.**

**The port splits where TD-025 §2 split the channel.** `updateMirror`, `create`, `kill`, `export`,
`destroy`, `purgeExpired` and `broker` stay launcher-side. **`attach` is obtained locally by the runner**
from the control volume it already mounts — `packages/application/src/ports/workspace.ts:182-188` documents
`WorkspaceAttachment` as *"the control channel, from the runner's side of the volume (TD-025 §2)… a path in
the runner process' own filesystem"*, and its three fields derive from `controlRoot` + `runId` + a token
file. The only part of `DockerWorkspaceProvider.attach` that touches the daemon is an `inspectContainer`
liveness probe (`packages/infrastructure/src/workspace/provider.ts:721-722`), and **the connect is a better
liveness check than an inspect that races it**. This settles the second half of Q52 — `WorkspaceProvider` is
not one interface with a remote implementation — and leaves the transport for the launcher-side calls open.

**`DOCKER_HOST` absent must be a startup error, never the host socket.** Today
`parseDockerHost(undefined)` returns `/var/run/docker.sock` (`apps/launcher/src/config.ts:79`, reproduced
from `readLauncherConfig({})` with nothing set), so *absence of configuration grants the unfiltered daemon
that this decision deploys a proxy to remove*. That is standing rule 55's shape — a guard whose default is
the thing it exists to prevent — and rule 18's: an unset value must not produce the permissive result.

**What positively enforces this, rather than what is forbidden** (rule 55: a deny-list is a claim about the
platform's layout, not about intent). A test read **off disk** — the shape of
`packages/integrations/src/providers/delivery-key-redaction.test.ts` — asserting that
`workspace.DockerEngine` is constructed in **exactly one** file and `DOCKER_HOST` is read in **exactly
one**, both under `apps/launcher/src/`. That is a checkable claim about this repository's own sources rather
than a hope about a deployment. WP-22 asserts the container half over the compose file.

### Amendment note (WP-15g, as built)

The amendment above says *"`attach` is obtained **locally** by the runner from the control volume it already
mounts"*. **As built, `attach` stays on `DockerWorkspaceProvider`**, and the reason is recorded here rather
than left as a contradiction, because docs win over code and this record is the thing a future session will
trust.

**The rule is unchanged and is what matters**: no process that composes the pipeline or serves `/webhooks/*`
constructs a Docker client. WP-15g's reviewer verified that it holds **structurally at the repository level**
rather than by configuration — `apps/server` takes a `RunWorkspaceProvisioner` (`spawn` + `workdir` +
`release`) and never a `WorkspaceProvider`, and `apps/launcher/src/docker-access.test.ts` is a **positive
census** over `git ls-files`: one `workspace.DockerEngine` constructor file and one shipped `DOCKER_HOST`
reader, both under `apps/launcher/src/`. An intent-to-added `apps/server/src/zz-mutant-engine.ts` kills both
claims by name. The census's own docblock admits what it cannot see — the aliased form
`const E = workspace.DockerEngine; new E({…})` passes — which is a named gap rather than a hidden one
(rules 44, 48).

**Why the mechanism moved.** A runner-side `readLocalAttachment` would have had **no caller** until Q52's
transport exists, and *"built, composed by nothing"* is the defect this project spent WP-15a, WP-15c, WP-17
and WP-15f unwinding — `createPipelineRuntime` was composed only by a test harness through twenty-three work
packages (PROGRESS backlog 11 is the general shape). The function is about fifteen lines of filesystem work
and gets written the day the transport needs it, which is the same day it acquires a caller.

**What this leaves open, stated so nobody reads silence as completeness.** The **deployment** half —
a compose file that binds the socket into the launcher container only — is **WP-22**'s, and the amendment
above assigns it there. And **no test tier exercises the real `DockerWorkspaceProvider.attach`**: the
contract suite runs the real provider only behind a daemon and an absent `platform-runtime` image, so the
control-socket readiness handshake stays mutation-blind until WP-22 (PROGRESS, WP-15g's refiner note).
