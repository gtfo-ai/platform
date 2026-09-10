# 05 — Workspaces and security

> Round 2 design. Decision: TD-021, TD-012, TD-022. Sources: research/10, research/05, BD-021, BD-022, BD-024, BD-025.

## Workspace lifecycle
1. **Mirror:** per project, a bare mirror on the `repo-cache` volume; `git remote update --prune` before each run; gc disabled while workspaces reference it.
2. **Create (launcher):** volume `ws-<run>`, network `run-<run>` (`internal: true`), egress sidecar with the rendered allow-list, workspace container (`platform-runtime` image: Claude binary pinned to the SDK version, git, CLIs; no platform code) with hardening flags; `git clone --shared --branch <default> /cache/<project>.git` (**amended at WP-14**: cloning *from* the mirror sets the same `objects/info/alternates` entry `--reference` would and needs **no network at all**, so the one step that handles repository content at create time runs with `NetworkMode: none`; the origin URL is set afterwards. The consequence is unchanged and is the reason gc stays disabled: every object older than the run lives in the mirror, so anything that reads the workspace later — the export included — must mount `/cache` read-only too); checkout of the task branch for re-entries; `.agentic/workspace/setup` script executed if present (from the default branch); readiness commands verified during discovery reused here.
3. **Attach (TD-025):** the container's entrypoint is the run shim listening on `/ctl/ctl.sock` (per-run sub-directory of the shared `ctl` volume). The runner connects, authenticates with the run token, and its `spawnClaudeCodeProcess` sends `spawn{command,args,cwd:/work/repo,env}`; stdio, stderr, signals and the exit code travel as frames. If the connection drops, the shim terminates the CLI. The workspace has no network path to the platform; the git credential helper uses the same socket to obtain its run-scoped token.
4. **Run:** hooks and policy on the platform; git pushes only to `agentic/*` with the run-scoped token from the broker; per-run port `APP_PORT` for dev servers.
5. **Finish:** commit/push WIP on interruption (`wip:` commit); remove container, sidecar and network; keep the volume per retention (3 days default, 14 days for paused/taken-over); `workspace.destroyed` on purge.
6. **Export:** branch pushed + transcript JSONL copied to `blobs` + optional tarball (excluding `.git`, `node_modules`) downloadable from the UI; resume instructions posted to the ticket. **WP-14:** the tarball also drops any symlink whose target escapes the workspace — an archive is unpacked somewhere else, and a link out of it is a write outside the workspace on whatever machine unpacks it — and the count is reported. The *transcript* half is the platform's, not the launcher's: the transcript lives in `run_messages`, and `WorkspaceProvider.export` returns the branch, the commit and the tarball.

## Hardening flags (per run container)
`user: 1000:1000`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `read_only: true`, `tmpfs: /tmp (size from config)`, `mem_limit`, `cpus`, `pids_limit`, `init: true`, `stop_grace_period: 20s`, `runtime: runc|runsc`, no port publishing, no host mounts, no Docker socket. Timeouts: stage wall clock → SDK `interrupt()`/abort → `stop` (SIGTERM) → SIGKILL.

## Network policy
Workspace has no default route; the sidecar allows: Anthropic API host (or the configured Bedrock/Vertex/proxy host), the git host, package registries for the project's ecosystems (from discovery), read-only observability hosts when the stage may use them; everything else denied and logged (denied hosts shown in the run detail as a hint). Telemetry hosts blocked; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Phase 2: Envoy sidecar injecting the Anthropic key and git token so neither is present in the container.

## Credentials and identity
- Platform: long-lived group/project access token or service account per GitLab, Jira API token, Slack tokens, Sentry Internal Integration token, Loki credentials — encrypted at rest, decrypted only in the process that uses them, never logged.
- Per run: the launcher mints a GitLab project access token (Developer, `write_repository`, `expires_at` tomorrow, revoked at run end) and hands it to the runner; the workspace's credential helper requests it through the run shim (`cred.get`) over the control socket only while the run is active; read-only stages get no git write token at all. Loki/Sentry read credentials injected as env only for stages whose tool policy includes them.
- Composite identity: every outbound action records the bot identity and the requesting human (BD-025).

## Command and tool policy
- Three lists per stage merged from platform defaults (org maximum) and project config; `PreToolUse(Bash)` evaluates: block → deny; allow → allow; else `ask` → Question to a mapped member/maintainer (timeout = question timeout; unattended default deny).
- File guards: writes limited to the workspace; `.agentic/`, `.claude/`, `CLAUDE.md`, `.gitlab-ci.yml`, tests (protected paths) → allowed only when the plan lists them, and flagged for Code review (BD-024).
- Git guards: no push outside `agentic/*`, no force, no branch deletion, no history rewrite; server-side protected branches verified by the readiness check (R9).
- Network/tools: MCP servers limited to the stage's list; `strictMcpConfig`.

## Untrusted input handling (BD-022)
All external text is delimited as data in prompts; the Reviewer checklist includes "instruction-like content in inputs"; agent configuration (`.agentic`, `.claude`, `CLAUDE.md`, `.mcp.json`) is read from the default branch snapshot, never from the task branch; feedback/answers/approvals require mapped identities verified from webhook payloads.

## Redaction (TD-012)
Exact-match of injected secrets → gitleaks-derived regexes → optional entropy; applied before every persistence and before broadcasting to SSE; counts recorded.

## Threat model (summary; full table in research/10)
Secrets exfiltration, data exfiltration, protected-branch tampering, container escape, policy tampering via repo config, resource exhaustion, lateral movement to platform services, launcher compromise, secrets in transcripts, `local`-mode token misuse — each with its MVP control and residual risk. Residuals to document for operators: shared kernel (use gVisor for untrusted repos), domain fronting via allowed CDNs, launcher ≈ host root (keep tiny; rootless Docker option).

## Control channel (TD-025)
One Unix socket per run on the `ctl` volume: runner ↔ shim frames for spawn/stdio/signals/exit and `cred.get`; single authenticated connection; shim kills the child on disconnect; nothing listens on TCP in Docker mode. Kubernetes: same frames over TCP with mTLS.

## Kubernetes later
`WorkspaceProvider` implemented with Jobs or `agent-sandbox` claims, NetworkPolicy + Cilium FQDN policies, exec/attach WebSocket for the spawn hook, session store adapter for cross-node resume.
