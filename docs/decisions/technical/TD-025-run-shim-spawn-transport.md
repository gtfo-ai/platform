# TD-025 — Spawning the CLI inside the run container: an in-container run shim over a Unix socket on a per-run control volume; launcher-relayed exec as fallback

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** TD-021, technical/04, technical/05, research/05, research/10; resolves OPEN-QUESTIONS Q33

## Context (verified)
The Agent SDK option `spawnClaudeCodeProcess(options: SpawnOptions) => SpawnedProcess` is the documented seam "to run Claude Code in VMs, containers, or remote environments". `SpawnOptions` carries `command`, `args`, `cwd`, `env` and a teardown `signal` (fired ~2 s after the SDK closes stdin); `SpawnedProcess` needs only `stdin` (Writable), `stdout` (Readable), `kill(signal)`, `killed`, `exitCode` and `exit`/`error` events (`ChildProcess` satisfies it). The SDK owns the NDJSON protocol; we own the transport. Docker facts: a named volume can be mounted into several containers at once, optionally as a sub-directory via `--mount type=volume,volume-subpath=…`; a running container can be attached to a network with `docker network connect`.

## Decision
1. **Run shim.** The `platform-runtime` image ships a small static shim (`agentic-runlet`, ~300 lines, TypeScript compiled to a single file or Go — implementer's choice, must have no runtime deps) as the container's entrypoint under `tini`. It listens on a Unix socket `/ctl/ctl.sock` and accepts exactly one authenticated control connection. Frames (length-prefixed JSON + raw byte chunks): `hello{token}`, `spawn{command,args,cwd,env}`, `stdin{bytes}`, `stdout{bytes}`, `stderr{bytes}`, `signal{name}`, `exit{code,signal}`, `cred.get{host}` / `cred.reply{token}`, `ping/pong`. On `spawn` it starts `claude` with the given args/env as uid 1000 in `cwd`, pipes stdio into frames, forwards `signal`, reports `exit`. If the control connection drops, the shim sends SIGTERM to the child, waits the grace period, then SIGKILL, and exits — an orphaned agent never keeps running.
2. **Control volume.** The launcher creates one named volume `ctl` (once) and mounts `ctl/<run-id>/` into the workspace container at `/ctl` (`volume-subpath=<run-id>`, rw) — the workspace sees only its own directory. The **runner** process (platform side) has the whole `ctl` volume mounted at `/run/agentic/ctl` from its start (static mount, no dynamic mount needed) and connects to `/run/agentic/ctl/<run-id>/ctl.sock`. The runner's `spawnClaudeCodeProcess` returns a `SpawnedProcess` whose `stdin`/`stdout` are the multiplexed frames; `stderr` frames feed the SDK `stderr` callback and the run log; `kill()` sends `signal`; the SDK's teardown `signal` triggers `signal{SIGTERM}` then container stop.
3. **No network path from workspace to platform.** The run network stays `internal: true` with only the egress sidecar; the git credential helper inside the workspace talks to the shim over the same Unix socket (`cred.get`), the shim forwards it over the control connection, and the runner answers with the run-scoped token from the launcher's broker. The launcher therefore needs no broker endpoint reachable from runs.
4. **Kubernetes later.** The same shim listens on TCP inside the pod; the runner connects over the cluster network with mTLS (or through the exec/attach API). The frame protocol is identical, so the SDK-side `SpawnedProcess` adapter does not change.
5. **Fallbacks, in order:** (a) launcher-relayed `docker exec` attach streamed to the runner over a WebSocket (no shim in the image; couples the stdio path to the launcher process); (b) SDK inside the workspace container with an HTTP MCP endpoint back to the platform and proxy-injected credentials (policy hooks then run next to the untrusted shell). Neither is expected to be needed.

## Rationale
The shim removes every uncertainty that made this a spike: no dependence on Docker attach/hijack semantics or stdout/stderr multiplexing frames, no Docker socket use by the runner, explicit exit codes and stderr, deterministic teardown when the platform restarts, and the same mechanism on Kubernetes. It also collapses the credential broker into the existing channel, so the workspace has zero network reachability to platform services.

## Consequences
- WP-13 becomes "implement `agentic-runlet` + runner adapter + conformance tests" with a one-day verification of `volume-subpath` on the target Docker version (Docker Engine ≥ 26 `[verify exact version]`) instead of an open-ended spike.
- Runner restart: the control connection drops → shim kills the CLI → the run is marked `interrupted`; the pipeline resumes the stage via SDK `resume` on the session store with a "you were interrupted" note (technical/04).
- The `ctl` volume holds only sockets and per-run scratch; it is tmpfs-backed where the driver allows and cleaned per run.
- Security review item: the shim accepts one connection, requires the per-run token in `hello`, runs the child as uid 1000, never exposes a TCP port in Docker mode.

## Amendment (WP-98, 2026-09-30) — two sockets, not one (Q50)

§3's *"the git credential helper … talks to the shim over the same Unix socket (`cred.get`)"* describes one socket where two
ship: the helper talks to the shim over a **second** Unix socket on the same control volume, `/ctl/cred.sock` (`cred.get` and
`ping` only, unauthenticated on purpose — Q50), while `/ctl/ctl.sock` stays §1's one authenticated connection; and the token it
answers with is the one **the runner minted for this run** (TD-028, WP-76), not one from a launcher broker.

## Amendment (backlog 342, 2026-09-30, session 10) — the CLI's environment is composed by the runner from the launcher's answer

§1's `spawn{command,args,cwd,env}` stays the **whole** environment of the child: the shim replaces, never merges, and technical/04's `env` row (*explicit, never inherited*) stands. What §1 did not say is who supplies the variables that describe the **container**: the egress proxy, `HOME`, `CLAUDE_CONFIG_DIR`, the image's `PATH`, and the git credential helper. Before this amendment they were written only on the container. Backlog 342 reads, off the tree, that they therefore stop at the shim.

1. **The launcher answers them** on `ProvisionedRunWorkspace`, beside `claudeCodePath`. The field is a strict, structured object (proxy URL or null, `NO_PROXY`, `HOME`, `CLAUDE_CONFIG_DIR`, `PATH` read from the image's declared `Config.Env`, and git configuration pairs). It is never a free-form record, so a `RUNLET_*` name or a credential cannot travel in it. One launcher function produces both this answer and the container's own environment.
2. **The runner composes the frame's `env`** in one function: the model credential, the launcher's values, then `platformEnvironment`. Git configuration is one list of pairs, numbered once (`GIT_CONFIG_COUNT` = the list's length, contiguous `KEY_n`/`VALUE_n`), and a key supplied twice is refused by name. `RunSpec.env` cannot override an answered name or any `GIT_CONFIG_*`.
3. **No secret is added to the frame.** The answered values are paths, an internal proxy URL and a command string. The model credential the frame already carries is unchanged, and the frame is written to no transcript or log (TD-012).
4. **Rejected**: the shim merging an allow-list of its own environment. That would put the list in the image while its values live in the launcher, renumber git's indices inside the dependency-free shim, and copy from an environment that holds `RUNLET_*`. Also rejected: the runner hard-coding launcher facts it does not know (the sidecar name, the helper command, the image `PATH`).
5. **Measured before it is built** (a daemon, no model credential). The fake CLI reports the names, never the values, of its `/proc/self/environ` through the launcher control-plane check, and the real CLI started with a fake key shows whether its traffic reaches the sidecar. Owner: **WP-118**, which gates WP-33.
