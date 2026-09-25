# 05 — Workspaces and security

> Round 2 design. Decision: TD-021, TD-012, TD-022. Sources: research/10, research/05, BD-021, BD-022, BD-024, BD-025.

## Workspace lifecycle
1. **Mirror:** per project, a bare mirror on the `repo-cache` volume; `git remote update --prune` before each run; gc disabled while workspaces reference it. **This is the launcher's mirror and serves run workspaces only.** It is written by a helper container (the volume is never mounted into the launcher's own filesystem) and can therefore be advanced only by the component TD-021 allows near the Docker socket. The knowledge indexer reads a **second**, platform-side bare mirror that the platform process clones and fetches itself — TD-026 — with gc left **on**, because nothing alternates to it. Two mirrors per project is the decided state, not an oversight.
   **WP-74 (a run with no checkout):** a run whose tool list holds no file tool and no shell — on this build the ask and the history miner — is given `WorkspaceSpec.repo: null` (`runNeedsCheckout`, `packages/infrastructure/src/workspace/spec.ts`). Its create skips this step and the clone below, runs no `mirror-` and no `clone-` helper, mounts no `repo-cache`, puts no git host on its egress list, and the runner sends the launcher no credential request. It **keeps** everything else in step 2 — volume, network, sidecar, control socket and the platform skills, under an empty `/work/repo` the prepare helper creates — because the CLI runs inside the container and a run has no other transport; running it in the platform process is ruled out by TD-021's decision body (*"spawns `claude` inside the container"*), not merely by its WP-15g amendment. `export` refuses such a workspace by name.
2. **Create (launcher):** volume `ws-<run>`, network `run-<run>` (`internal: true`), egress sidecar with the rendered allow-list, workspace container (`platform-runtime` image: Claude binary pinned to the SDK version, git, CLIs; no platform code) with hardening flags; `git clone --shared --branch <default> /cache/<project>.git` (**amended at WP-14**: cloning *from* the mirror sets the same `objects/info/alternates` entry `--reference` would and needs **no network at all**, so the one step that handles repository content at create time runs with `NetworkMode: none`; the origin URL is set afterwards. The consequence is unchanged and is the reason gc stays disabled: every object older than the run lives in the mirror, so anything that reads the workspace later — the export included — must mount the mirror read-only too. **WP-75:** "the mirror" is the project's **own**, never the volume: the run container and the export helper mount `repo-cache` with `VolumeOptions.Subpath: <key>.git` at `/cache/<key>.git` — the path the alternates name — so a run sees no other project's mirror, which is TD-021's *"per-project bare mirror ro at `/cache`"* as written. The sub-path exists because `updateMirror` runs before `create` and the clone helper, which keeps the whole volume read-only for that reason, refuses a missing mirror by name before any container that mounts one is created; the mirror helper keeps the whole volume read-write because it creates `<key>.git`. **The export helper's git reads no configuration the run wrote** (WP-75, folding backlog 152): the tree, its `.git/config`, its hooks and its `.gitattributes` are the agent's, and before WP-75 run-planted hooks, a `core.fsmonitor`, a clean filter, `commit.gpgSign` + `gpg.program`, a `pushurl`/`insteadOf` redirect and a repository `credential.helper` all ran there (measured), in a container holding the push credential with a route to the git host. So the helper refuses a `.git` that is a symlink, a gitfile or a linked worktree by name; reads only the platform's configuration (`GIT_CONFIG_NOSYSTEM=1`, a `GIT_CONFIG_GLOBAL` it writes, and a `.git/config` it **replaces** with the repository format and origin URL read off the platform-written mirror); removes `.git/hooks` and runs every git command with `-c core.hooksPath=/dev/null`; pushes to the mirror's URL by name rather than through a remote; and refuses by name a checkout holding a **nested repository** — a `.git` directory or gitfile below the top level, found before the first git command that reads the work tree — because that repository's own config is one the helper does not replace, and `git add -A` was measured running its `core.fsmonitor`. The helper runs as the run's own uid, so a directory the run left unlistable once hid a nested repository from that walk while git reached it through the index: the tree is normalised to the owner's `u+rwX` first, and a walk that still fails or prints an error is itself a refusal. The export also stops the run container before its helper exists, so nothing the run left running can change the tree between the checks and the push. A gitlink with no `.git` behind it has no configuration and is not refused, so a project with submodules exports (orchestrator's ruling; both directions in the e2e). An attribute naming a filter no configuration defines runs nothing — measured by the same e2e. What this does **not** claim: the helper's git still reads the run's index, objects and attributes); checkout of the task branch for re-entries; `.agentic/workspace/setup` script executed if present (from the default branch); readiness commands verified during discovery reused here.
3. **Attach (TD-025):** the container's entrypoint is the run shim listening on `/ctl/ctl.sock` (per-run sub-directory of the shared `ctl` volume). The runner connects, authenticates with the run token, and its `spawnClaudeCodeProcess` sends `spawn{command,args,cwd:/work/repo,env}`; stdio, stderr, signals and the exit code travel as frames. If the connection drops, the shim terminates the CLI. The workspace has no network path to the platform; the git credential helper uses the same socket to obtain its run-scoped token.
4. **Run:** hooks and policy on the platform; git pushes only to `agentic/*` with the run-scoped token from the broker; per-run port `APP_PORT` for dev servers.
5. **Finish:** commit/push WIP on interruption (`wip:` commit); remove container, sidecar and network; keep the volume per retention (3 days default, 14 days for paused/taken-over); `workspace.destroyed` on purge. **WP-27 (as measured):** the 14-day window is not a relabel — on Engine 29.7.2 / API 1.55 a volume label cannot be updated (a re-`create` silently keeps the old label and `volume update` refuses anything but cluster volumes), so the launcher writes a `hold-<run-id>` marker volume carrying the later `keep_until` and the sweep takes the later of the two instants.
6. **Export:** branch pushed + the redacted transcript (served from `run_messages`; nothing writes `blobs` — the WP-14 sentence below and PROGRESS backlog 68) + optional tarball (excluding `.git`, `node_modules`) downloadable from the UI; resume instructions posted to the ticket. **WP-14:** the tarball also drops any symlink whose target escapes the workspace — an archive is unpacked somewhere else, and a link out of it is a write outside the workspace on whatever machine unpacks it — and the count is reported. The *transcript* half is the platform's, not the launcher's: the transcript lives in `run_messages`, and `WorkspaceProvider.export` returns the branch, the commit and the tarball.

## Hardening flags (per run container)
`user: 1000:1000`, `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `read_only: true`, `tmpfs: /tmp (size from config)`, `mem_limit`, `cpus`, `pids_limit`, `init: true`, `stop_grace_period: 20s`, `runtime: runc|runsc`, no port publishing, no host mounts, no Docker socket. Timeouts: stage wall clock → SDK `interrupt()`/abort → `stop` (SIGTERM) → SIGKILL.

## Network policy

> **The *platform process* has an egress allow-list too, since WP-51** (PROGRESS backlog 48). This section is about the run container and was, until then, the only egress control in the product: the server process that holds every decrypted credential would call whichever host an `integration.write` caller had typed into a binding's `base_url`. `APP_INTEGRATION_HOSTS` (technical/06 § "Outbound: actions", technical/12) is the other half — operator-declared, exact, empty and therefore closed by default, refused at `POST /api/integrations` and again inside `IntegrationActionExecutor`. The two lists are separate on purpose: this one is rendered per run from what the *stage* needs, that one is instance configuration about what the *platform* may dial.

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

### Amendment (WP-53, 2026-09-23) — the control plane beside the data plane

*"Nothing listens on TCP in Docker mode"* is no longer true of the **launcher**, and the sentence stands for the run: TD-028 splits the transport in two, and only the control half is new.

- **Data plane, unchanged.** The runner keeps the static mount of the whole `ctl` volume and opens `<ctl>/<run-id>/ctl.sock` itself. No stdio, no `stdin`/`stdout`, and no `cred.get` round trip crosses HTTP.
- **Control plane, new.** The launcher exposes an HTTP surface for the operations that are request/response — create a workspace, end a run, report health — on a compose network with `internal: true` and no published port that **only** the launcher and the runner container join. It is authenticated on every request with a constant-time comparison of `APP_LAUNCHER_TOKEN`, *in addition to* the network isolation, because a compose file is a deployment property and an authentication check is a code property — and this surface creates containers.
- Every operation is **idempotent on the run id**: a create for a run that already has a handle answers the stored handle rather than starting a second container. The record is this process' memory, so a launcher that restarted has forgotten and a create replayed across a restart would start a second container; what bounds that is one level up (`stage.execute` is `stately` per task, and the run lease ends a row whose process is gone).
- The run container still reaches **nothing but its egress sidecar**: it is on a per-run `internal: true` network and joins neither the control-plane network nor the daemon's.
- **Which process may run an agent is configuration, never `ROLE`** (TD-028 decision 5): a worker subscribes `stage.execute` and `task.ask` only when it has a launcher URL and token. The consequence the decision's WP-53 amendment writes down is that gate evaluation is a branch of the same handler on the same queue, so a deployment with no configured runner also stops evaluating `ci_gate`, `rebase_gate` and `merged_gate`. Nothing is lost — the jobs are durable and are taken when a runner starts — and the queue depth is the visibility that trade rests on.

## Kubernetes later
`WorkspaceProvider` implemented with Jobs or `agent-sandbox` claims, NetworkPolicy + Cilium FQDN policies, exec/attach WebSocket for the spawn hook, session store adapter for cross-node resume.

## Amendment (WP-22, 2026-09-12) — the images exist, and two residuals they exposed

**The run container has no host mount.** §2's `platform-runtime` image is
`docker/runtime.Dockerfile`: the `claude` CLI pinned to the SDK version the platform runs (both come
out of one `pnpm install --frozen-lockfile`, so they cannot drift), the six agent CLIs, and the
bundled `agentic-runlet` as the entrypoint — one file with no runtime dependencies, held to that by
`scripts/assert-runlet-bundle.mjs` during the image build. With it, `WorkspaceImages.runtimeSourceDir`
is `null` and the create body carries **no binds at all**, which
`test/e2e/workspace/docker-workspace.e2e.test.ts` now asserts against the daemon's own record rather
than against the argument vector. Until WP-22 that same case asserted the opposite — one bind, the
repository at `/repo` — which is what "the one hole" in `hardening.ts` meant.

**The egress sidecar is tinyproxy, and the allow-list is now demonstrated rather than modelled.**
`platform-egress` (`docker/egress.Dockerfile`, tinyproxy 1.11.2 pinned) runs as uid 1000 with
`cap_drop ALL` and a read-only rootfs, and the e2e drives a request through it from inside the run
container: the allowed host answers 200 and a host that is not on the list is refused 403, where
both names are the **same container on the same address**. The rendered configuration lost its
`User nobody`/`Group nobody` lines — not because they broke it (measured: with them present the real
image starts and serves), but because the process does not honour them, which makes them a claim
nothing enforces.

**Residual 1: a filesystem that will not set a socket's mode.** The shim `chmod 0600`s its control
socket after `listen`. On Docker Desktop for macOS with the control volume bind-backed onto a host
directory (virtiofs), `chmod` answers `EINVAL` and the mode cannot be set at creation either — with
`umask(0o177)` the guest still reports `0666` while the host reports `0755`. A fatal refusal there
means the shim cannot start in the one arrangement a developer runs the real images in. It now
checks the **property** instead of the call: `<ctl>/<run-id>` is `0700` owned by the shim's uid (the
launcher creates it that way), and a Unix socket cannot be connected to without search permission on
every directory in its path, so the directory denies exactly the set the `0600` would. When the
directory does **not** carry that property the shim still refuses, naming both facts. Linux is
unaffected — `chmod` succeeds and the branch is never taken.

**Residual 2: the SDK computes the executable's path on the platform side.** `Options.pathToClaudeCodeExecutable`
is `null` outside `local` mode, so the SDK resolves its own bundled binary, checks it exists **in the
platform process' filesystem**, and hands that path to `spawnClaudeCodeProcess` — which the shim then
executes *inside* the run container, where the path is the image's `/usr/local/bin/claude` and not
the platform's `node_modules` path. No tier has run a real agent through the real image (WP-15g
scoped that out and no criterion here needs it), so this is recorded rather than fixed: the fix is a
`RunSpec.claudeCodePath` the workspace spec sets to the run image's path. PROGRESS carries it as
discovered work.
