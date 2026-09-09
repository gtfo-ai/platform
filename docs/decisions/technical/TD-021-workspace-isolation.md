# TD-021 — Workspace isolation: container-per-run created by a socket-proxied launcher; SDK on the platform side spawning the CLI in the container; per-run internal network with egress proxy

- **Status:** accepted (spike required for the spawn mechanism)
- **Date:** 2026-08-28
- **Relates to:** research/10, research/05, technical/05, BD-021, BD-025, BD-020

## Decision
- **Launcher service** (`ROLE=launcher`) is the only component that can reach the Docker socket, via `docker-socket-proxy` (`CONTAINERS`, `NETWORKS`, `VOLUMES`, `IMAGES`, `POST`; `EXEC`, `BUILD`, `SECRETS` off). It implements the `WorkspaceProvider` port: `create(RunSpec) → handle`, `attach(handle) → SpawnedProcess`, `kill`, `export`, `destroy`, `broker`.
- **Per run:** an `internal: true` network `run-<id>`, an egress-proxy sidecar (tinyproxy/squid, allow-list rendered from project config; phase 2 Envoy with credential injection), a workspace container from the `platform-runtime` image (Claude binary + CLIs, no platform code) running as uid 1000 with `cap-drop ALL`, `no-new-privileges`, read-only rootfs, `/tmp` tmpfs, memory/CPU/pids limits (project defaults 2 CPU / 4 GiB / 512 pids), `init: true`, `runtime: runc` (`runsc` opt-in per project on Linux hosts). Volumes: `ws-<id>` rw at `/work`, per-project bare mirror ro at `/cache`.
- **SDK placement (option C):** the Agent SDK runs in the platform `runner` role and spawns `claude` inside the container through `spawnClaudeCodeProcess` (dockerode attach with hijacked stdio). Hooks, `canUseTool` and the platform MCP tools run on the trusted side; integration tokens never enter the container. Fallback if the spike fails: option B (runner process inside the container with an HTTP MCP endpoint back to the platform).
- **Credentials:** the container holds only `HTTPS_PROXY`, `CLAUDE_CONFIG_DIR`, non-secret project vars and a per-run bootstrap token; git uses `credential.helper=!agentic-cred` that exchanges the bootstrap token at the launcher broker for a run-scoped GitLab project access token (Developer, `write_repository`, expires next day, revoked at run end); the Anthropic key is masked/injected at the proxy in phase 2 (phase 1: in env, documented). Protected branches enforced server-side; `PreToolUse` denies pushes outside `agentic/*`.
- **Lifecycle:** bare mirror per project updated before each run; `git clone --reference` per run; export on take-over = push `agentic/<task>` + transcript copy + optional tarball; container/network/sidecar removed at run end; volume retained per policy (default 14 days for paused/taken-over tasks, 3 days otherwise).

## Rationale
Container-per-run is the only model that gives per-task filesystem, process and network isolation without KVM; keeping the SDK on the platform side yields BD-025 (no tokens in the agent) for free; the internal network + proxy makes "ignore the proxy env" harmless.

## Alternatives considered
Shared runner + worktrees + bubblewrap (needs weakening seccomp; shared `.git` state); gVisor default (10–200× slower file I/O for installs); Firecracker/Kata/Docker Sandboxes (KVM); Kubernetes first (BD-020 says later).

## Consequences
- Spike (first implementation task): `spawnClaudeCodeProcess` over attach — resume, stderr, exit codes, session store; embedded DNS on internal networks; token minting on self-managed Free.
- Kubernetes provider later: Job/`agent-sandbox` per run, NetworkPolicy + Cilium FQDN, exec/attach WebSocket for the spawn hook.
