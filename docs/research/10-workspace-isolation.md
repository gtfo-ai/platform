# Research: workspace isolation, egress control, per-run credentials, lifecycle (2026-09-09)

> Verified against Docker, gVisor, Kubernetes, GitLab, git and Anthropic docs and `@anthropic-ai/claude-agent-sdk@0.3.266` type definitions. Informs TD-021 and technical/05.

## Recommendation in one paragraph
Compose MVP: **container-per-run**, created by a dedicated `launcher` service that is the only service reaching the Docker socket (through `docker-socket-proxy`), with the Agent SDK running in the platform process and the `claude` CLI spawned **inside** the run container via the SDK's `spawnClaudeCodeProcess` hook. Each run gets its own `internal: true` network and an egress-proxy sidecar with the project's domain allow-list; the run container has no default route, runs as uid 1000 with `cap-drop ALL`, `no-new-privileges`, read-only rootfs, memory/CPU/pids limits and `--init`. Hooks, `canUseTool` and in-process SDK MCP tools therefore execute on the trusted side and integration tokens never enter the container; the only in-container credential is a run-scoped git token delivered by a credential helper. Workspaces are `git clone --reference` from a per-project bare mirror, retained N days, exported by pushing `agentic/<task>` plus a transcript copy. gVisor is an opt-in runtime; microVMs are out of scope for MVP. The same `WorkspaceProvider` interface maps onto Kubernetes Jobs / `kubernetes-sigs/agent-sandbox` later.

## Isolation models
| Model | Facts | Verdict |
|---|---|---|
| Container-per-run via Docker socket | socket access is root-equivalent (https://docs.docker.com/engine/security/); OpenHands mounts it in the controller and closed "run without socket" as not planned; **docker-socket-proxy** filters by API section (`CONTAINERS`, `NETWORKS`, `VOLUMES`, `POST`; `EXEC`/`BUILD`/`SECRETS` off) but not request bodies (https://github.com/Tecnativa/docker-socket-proxy); rootless Docker / userns-remap as hardening | **MVP**, socket only in a tiny launcher |
| Long-lived runner + worktrees + bubblewrap/nsjail | Docker's default seccomp denies `clone`/`unshare` of new namespaces; Claude Code needs `enableWeakerNestedSandbox` ("considerably weakens security") inside containers; worktrees share `.git` state across runs | not the primary boundary |
| gVisor `runsc` | Compose `runtime: runsc`; Anthropic rates it "Excellent", overhead medium/high, file-I/O heavy patterns (npm install) up to 10–200× slower (https://code.claude.com/docs/en/agent-sdk/secure-deployment); Linux only | opt-in flag |
| Firecracker / Kata / Docker Sandboxes | need KVM (most cloud VMs lack nested virt); Docker Sandboxes Linux = Arm bare metal only | later (Kubernetes RuntimeClass) |
| Kubernetes Jobs / agent-sandbox | `activeDeadlineSeconds`, `ttlSecondsAfterFinished`; Anthropic cookbook: pod per session, NetworkPolicy egress only to proxy + DNS, 10–30 s pod start → warm pool; `kubernetes-sigs/agent-sandbox` CRDs with warm pools and gVisor/Kata (https://agent-sandbox.sigs.k8s.io/docs/); FQDN allow-lists need Cilium `toFQDNs` | migration target |
| Anthropic sandboxing | Claude Code Bash sandbox (bubblewrap/Seatbelt + proxy allow-list) restricts **only Bash**; `Options.sandbox` exists in SDK 0.3.266 (`network.allowedDomains`, `filesystem`, `credentials` masking with `injectHosts`/`tlsTerminate`, `enableWeakerNestedSandbox`); `@anthropic-ai/sandbox-runtime` (beta) wraps a whole process but needs unprivileged user namespaces | defence in depth later; not the MVP boundary. Claude Code refuses bypass-permissions as root → run as uid 1000 |

## Egress allow-listing
1. **`internal: true` network + egress proxy sidecar (recommended):** workspace attached only to `run-<id>`; sidecar (tinyproxy `FilterDefaultDeny Yes` or squid `dstdomain` ACLs) dual-homed; `HTTP(S)_PROXY` env; a tool ignoring the env simply has no route. Node 24+ needs `NODE_USE_ENV_PROXY=1`. Phase 2: Envoy `credential_injector` to inject the Anthropic key and git token at the proxy so they never enter the container. https://docs.docker.com/reference/compose-file/networks/ , https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/credential_injector_filter
2. iptables inside the container (Anthropic devcontainer `init-firewall.sh`) needs `NET_ADMIN` — prefer 1.
3. DNS: with a CONNECT proxy the workspace needs no resolver; Docker embedded DNS behaviour on internal networks `[unverified — spike]`.
Allow per project: Anthropic API host, git host, ecosystem registries, read-only observability hosts; later a registry cache (Verdaccio/devpi). Block telemetry hosts; `strictMcpConfig`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`.

## SDK placement
| Option | Where tools run | Hooks/canUseTool/SDK-MCP | Verdict |
|---|---|---|---|
| A. SDK on platform, `cwd` = bind-mounted workspace | platform container | platform | reject (agent shell sees platform env/DB/socket) |
| B. SDK inside the workspace container (OpenHands agent-server) | container | container (policy next to untrusted shell; tokens in-container) | fallback |
| **C. SDK on platform, CLI spawned in container via `spawnClaudeCodeProcess`** (dockerode attach with hijacked stdio) | container | **platform** (trusted; integration tokens never in container — BD-025 for free) | **recommended; spike first** |
`spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess` is typed ("run Claude Code in VMs, containers, or remote environments") but has no dedicated docs page `[unverified maturity]`. Multi-tenant guidance: `settingSources: []` for host config, per-run `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PROJECT_DIR_NAME`. `local` mode: the workspace image needs a Linux `claude` binary (a macOS host binary is Mach-O); Linux hosts store OAuth creds in `~/.claude/.credentials.json`, macOS in the Keychain → on macOS only `CLAUDE_CODE_OAUTH_TOKEN` is mountable; refresh races with parallel runs `[unverified]`.

## Per-run credentials
- GitLab: project access tokens (`POST /projects/:id/access_tokens`, `write_repository`, Developer, `expires_at` date-granular → ≥ 1 day; revoke at run end; gitlab.com needs Premium; self-managed all tiers `[unverified]`); deploy tokens read-only; OAuth tokens 2 h but attributed to a human. https://docs.gitlab.com/api/project_access_tokens/
- Delivery: in-container `credential.helper = "!agentic-cred"` calling the launcher's broker with a per-run bootstrap token (Paperclip #248 idea); config via `GIT_CONFIG_COUNT/KEY_n/VALUE_n`; phase 2: proxy-side injection.
- Server-side enforcement: protected branches (`push_access_level 40`, `allow_force_push: false`), bot is Developer; client-side `PreToolUse` denies pushes outside `agentic/*`, force, deletion. https://docs.gitlab.com/api/protected_branches/
- Env hygiene: anything in the CLI env is readable by Bash → keep only proxy vars, `CLAUDE_CONFIG_DIR`, non-secret project vars; API key via proxy injection (phase 2) or masked; codex-action's "drop-sudo, no socket, no_new_privs, empty caps" posture. https://github.com/openai/codex-action

## Lifecycle
Per-project bare mirror volume (`git clone --mirror`, `remote update --prune`, no gc while workspaces exist); per run `git clone --reference /cache/<project>.git` (optionally `--dissociate`; `--filter=blob:none` for monorepos; no `--depth` for Implementation); layout `/work/repo` (rw volume), `/cache` (ro), `/tmp` tmpfs, `CLAUDE_CONFIG_DIR=/work/.claude`; `.agentic/workspace` `setup/test/archive` scripts + per-run `APP_PORT` (Conductor pattern); disk quotas only with XFS `pquota` → MVP uses tmpfs sizes + a `du` watchdog; cleanup: remove container + network + sidecar immediately, keep the volume N days (14 for paused/taken-over); export = push `agentic/<task>` with a `wip:` commit + transcript copy + optional tarball. https://git-scm.com/docs/git-clone

## Limits and killing
Anthropic hardened `docker run` reference: `--cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp --memory 2g --cpus 2 --pids-limit 100 --user 1000:1000` (+ userns-remap, `ipc private`); floor 1 GiB/1 CPU per agent, real builds need more → per-project default 2 CPU / 4 GiB / 512 pids. Timeouts layered: `maxTurns`, `maxBudgetUsd`, stall watchdog, stage wall clock → `abort()` (~2 s graceful) → `container.stop` (SIGTERM via `--init`) → SIGKILL after `stop_grace_period` ~20 s. A container is a cgroup, so `docker kill` reliably kills daemons the agent forked. https://code.claude.com/docs/en/agent-sdk/secure-deployment

## Peers
OpenHands (agent-server in container, `forward_env` allow-list, 10 GB image), Paperclip (#248 SandboxProvider + bootstrap token; untrusted-PR compose mounts nothing from host), Vibe Kanban (worktrees, diff streaming), Conductor (setup/run/archive scripts, port per workspace), cwc-long-running-agents (kill-switch and steer hooks, commit-on-stop), Symphony (workspace key + hooks), codex-action (drop-sudo posture).

## Threat model summary
Secrets → none in container, SDK-MCP on platform, proxy-injected key (phase 2). Exfiltration → internal net + allow-list, no DNS (residual: domain fronting on allowed CDNs). Protected branches → server-side rules + hooks (residual: operator misconfiguration → readiness check). Escape → non-root, caps dropped, seccomp, read-only rootfs, optional gVisor (residual: shared kernel). Policy tamper → policy on platform; config snapshot from default branch. Exhaustion → limits, watchdog. Launcher compromise ≈ host root → keep it tiny and reviewed; rootless Docker optional.

## Spike list
`spawnClaudeCodeProcess` over a hijacked attach (resume, stderr, exit codes, session store); embedded DNS on internal networks; `sandbox.credentials` via SDK; project access tokens on self-managed Free; `.credentials.json` refresh with parallel runs; runc `cgroup.kill` version; gVisor host cgroup enforcement.
