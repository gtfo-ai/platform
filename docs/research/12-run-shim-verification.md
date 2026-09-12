# Research: `agentic-runlet` verification — control volume, embedded DNS, hardened container (2026-09-10)

> WP-13's named deliverable (TD-025, technical/05 § "Control channel"). It closes two `TODO.md`
> verification items — `volume-subpath` on the target Docker Engine version, and Docker embedded DNS
> behaviour on `internal: true` networks (`research/10` § "Egress allow-listing" §3 marked the second
> `[unverified — spike]`).
>
> **Measured here, on this machine, on the versions below. Everything else in this document is
> labelled as inference and says what would settle it.** The distinction is the same one the
> provider work packages made about fixtures: a thing you ran and a thing you reasoned about are
> different kinds of evidence, and a report that blurs them is how a design passes its own review
> and fails in production.

## What was run

| | |
|---|---|
| Host | macOS 15 (darwin 25.6.0), arm64 |
| Docker | client **29.7.2** / server **29.7.2**, API **1.55**, Docker Desktop **4.90.0 (238679)**, containerd v2.3.3, runc 1.4.3, `linux/arm64` |
| Images | `node:24-alpine` (Node 24.11.1), `alpine:3.21` |
| Command | `node scripts/runlet-container-check.mjs` — **7/7 checks passed**, 2026-09-10 |
| Suites | `packages/infrastructure/src/runlet/*.test.ts` (unit) and `conformance.contract.test.ts` (contract), in `pnpm run -s verify` |

TD-025 wrote the target as "Docker Engine ≥ 26 `[verify exact version]`". The exact version this was
verified on is **29.7.2 (API 1.55)**. The lower bound is *not* established here: `volume-subpath`
landed in Engine 26 per Docker's own changelog, but this report cannot claim a floor it did not run.
An operator on an older engine should run the same script before believing TD-025's shape.

## Measured

### 1. `volume-subpath` isolates one run's directory — **yes**

```
--mount type=volume,source=<ctl>,target=/ctl,volume-subpath=run-x
```
mounted only `run-x`; the sibling `other-run/secret` was not visible in the container (`ls /ctl` →
`token` only). This is the mechanism TD-025 §2 rests on: one `ctl` volume, one sub-directory per
run, and a workspace that sees only its own.

### 2. A missing sub-path fails the container start — **yes, loudly**

```
docker: Error response from daemon: cannot access path
/var/lib/docker/volumes/<ctl>/_data/does-not-exist: lstat …: no such file or directory
```
The daemon does **not** create the sub-directory. **WP-14 must create `<ctl>/<run-id>/` before
starting the run container, and `chown` it to the container's uid** — a volume's root is
`root:root 0755`, so a container running as uid 1000 cannot create the socket in it. That was found
by hitting it: the first attempt at check 5 failed until the directory was pre-created and chowned.

### 3. Embedded DNS on an `internal: true` network — **container names resolve**

`/etc/resolv.conf` carries `nameserver 127.0.0.11`; `nslookup <peer>` on an `--internal` network
returned the peer's address (`172.27.0.2`). So the workspace can reach its egress sidecar by name
without a published port, which is what technical/05's network policy assumes.

> **Amendment (2026-09-11, ci-fix).** The conclusion above is right and was re-measured on both
> platforms. The **instrument was not**: `nslookup`'s exit status is not a sound answer to "does
> this name resolve?", and the e2e case that inherited it from this report was the last red test on
> `main`. Busybox `nslookup` also queries `<name>.<search-domain>`, which the embedded resolver must
> forward upstream — and an `internal` network has no route upstream, so that query fails and the
> whole invocation exits 1 while the name resolves perfectly well. A developer machine has no
> `search` line and a cloud runner's host does, so the report's daemon could not show it. Measured,
> one internal network and one peer, varying nothing but the search domain:
>
> ```
> (no search domain)                  nslookup rc=0   getent hosts rc=0  172.27.0.2
> --dns-search example.invalid        nslookup rc=1   getent hosts rc=0  172.27.0.2
> ```
>
> The Linux side of this is not a claim you have to take: CI run **`34582432776`** is all-green
> including `e2e-fake-claude`, and it is the one that carries this probe as it now stands. (An
> earlier draft of this paragraph cited `34580312845` and called it "the first all-green run on
> `main`". Both halves were wrong: `gh run view` reports its `headBranch` as
> `ci-fix/e2e-linux-ctl`, so it was the first all-green run **on the fix branch, through the pull
> request** — `main` has had none since WP-14 — and it predates the bounded DNS probe, so it was
> not evidence for the probe it was cited for.)
>
> `getent hosts` is the probe that answers the question asked, and it is what
> `docker-workspace.e2e.test.ts` uses now — with the address asserted, not just the status, so the
> false branch cannot widen again (standing rule 56). Check 4's negative is re-measured there too,
> as `getent hosts example.com`, and still holds.

### 4. …and nothing else does — **no external resolution, no default route**

`nslookup example.com` on the same network returned **SERVFAIL** (the embedded resolver lists the
host resolver as an external server, but the internal network has no route to it), and
`ip route | grep -c '^default'` returned **0**. The residual DNS channel `research/10` worried about
is therefore *not* open on an internal network on this engine: a container can name its neighbours
and cannot resolve the internet. (Busybox's `ip route show default` ignores its own selector and
prints the link route; the check greps for a `default` line instead. Worth knowing — reading that
output naively says "1 default route" where the answer is none.)

### 5. An SDK `query()` completes through the shim in a hardened container — **yes**

Two containers, TD-025 §2's layout:

* **run container** — `agentic-runlet` as PID 1 under `--init`, with technical/05's hardening flags:
  `--user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true --read-only --tmpfs /tmp
  --pids-limit 256 --memory 512m --network none`; `/ctl` is the run's sub-path of the control volume;
* **runner container** — the whole `ctl` volume at `/run/agentic/ctl`, also `--network none`,
  running a real `query()` from `@anthropic-ai/claude-agent-sdk@0.3.267` whose
  `spawnClaudeCodeProcess` is `createRunletSpawn(...)` pointed at
  `/run/agentic/ctl/<run-id>/ctl.sock`.

Result: `{"ok":true,"types":["system","assistant","result"],"result":"the shim carried this",
"total_cost_usd":0.01}`. The SDK parsed the NDJSON its CLI wrote, which means the stream crossed the
frame protocol, the Unix socket and the volume intact. **Both containers had no network at all**, so
the only channel between them was the socket file — TD-025 §3's "no network path from workspace to
platform", demonstrated rather than asserted.

The run container then **exited 0 by itself** once the CLI finished.

### 6. A runner that disappears leaves no agent behind — **yes**

The peer container authenticated, spawned a CLI that installs a SIGTERM handler and never exits, and
was then `docker kill -s KILL`ed. The shim's own log:

```
{"reason":"control_disconnected","msg":"runlet shutting down"}
{"level":40,"pid":19,"msg":"runlet child ignored SIGTERM; sending SIGKILL"}
{"reason":"control_disconnected","msg":"agentic-runlet exiting"}
```
and the run container reached `exited:0`. What this check does **not** exercise is the runner
disappearing when the child has *already* exited — the shim then had nothing left to wait for and
waited anyway, staying alive with both servers listening. Found while fixing the credential window
in the same guard family and pinned by
`shim.test.ts > finishes shutting down when the runner drops after the child has already exited`,
because a container check with a live child cannot reach it.

The grace period itself is **not** timed here — that is
proved on an injected clock in `shim.test.ts` (`teardownSignals` is `['SIGTERM']` while the grace has
not elapsed and `['SIGTERM','SIGKILL']` after, with the child's disappearance confirmed by asking the
operating system). A wall-clock bound on a 2-core CI runner would be a hardware assertion.

## Inferred, not measured

Each of these is a claim this work package could not run, with what would settle it.

1. **The `platform-runtime` image.** The measurement above ran `node:24-alpine` with the repository
   bind-mounted read-only and the shim executed from TypeScript source through
   `scripts/ts-source-resolver.mjs`. TD-025 asks for "a single file … no runtime deps"; that is
   **WP-22's packaging**, and nothing here proves the bundle behaves like the source. *Settled by*
   WP-22 building the image and running `scripts/runlet-container-check.mjs` with
   `RUNLET_CHECK_IMAGE=<platform-runtime>`, which is why that variable exists.
2. **`tini` as PID 1.** `--init` was used, and the shim was the container's main process; the image's
   real entrypoint chain (`tini` → `agentic-runlet` → `claude`) is WP-22's. What *is* measured is
   that the shim exits by itself, so whatever supervises it will see a clean exit.
3. **Socket ownership across the two containers.** Both containers ran as uid 1000, and the socket is
   created `0600`. If WP-14 runs the platform's runner container as a different uid, it will get
   `EACCES` on connect. Two ways out — same uid, or a shared gid with `0660` — and the shim would
   need a mode option for the second. **Called out for WP-14 because it is a one-line failure that
   looks like a protocol bug.**
4. **The egress sidecar.** Check 3 shows the workspace can resolve a neighbour on an internal
   network; it does not show a proxy allow-list working, which is WP-14's.
5. **Kubernetes (TD-025 §4).** Not touched. The frame protocol is transport-agnostic by
   construction — nothing in `framing.ts` or `shim.ts` knows it is on a Unix socket except the two
   `listen`/`connect` calls — but "same frames over TCP with mTLS" is untested.
6. **tmpfs backing for the `ctl` volume** (TD-025 § Consequences: "tmpfs-backed where the driver
   allows"). Not attempted; the local driver's `tmpfs` option was not exercised.

## What the shim does that the decision did not spell out

Recorded here because a reviewer of TD-025 will want to know where the code went beyond the record.

* **A second socket.** TD-025 §3 says the credential helper "talks to the shim over the same Unix
  socket", which cannot be the *same socket file* as the one that "accepts exactly one authenticated
  control connection". It is implemented as a second socket on the same per-run directory
  (`cred.sock`), with its own accept-list of two frame types. Filed as **Q50** in
  `docs/OPEN-QUESTIONS.md` with the reasoning.
* **The token authenticates the runner, not the shim's own child.** Inside one container the CLI runs
  as the same uid as the shim and can read `/proc/<shim>/environ` and the token file on `/ctl`. What
  keeps a compromised child off the control channel is that the *slot is already taken* before the
  child exists, and that a dropped connection kills the run rather than freeing the slot. Stated at
  the top of `shim.ts` so nobody later mistakes the token for a secret from the agent.
* **`exit.signal` is wider than the signals the runner may send.** A child can die of `SIGSEGV`;
  reporting that as `null` would turn a crash into an ordinary exit.
* **The window between the child's `exit` and its stdio's `close` bounds *silence*, not the drain.**
  `close` is the honest end of a run — every byte read and framed — and a detached grandchild
  holding the pipe can withhold it for ever, so there is a backstop (`stdioFlushMs`, 2 s). Armed
  once at `exit`, that backstop also cut off a stream that was still delivering: the 16 MiB
  conformance case lost its last **65,536 bytes** — one pipe buffer, taking the `result` line with
  it — in two of ten full-suite runs on a loaded machine, and reported the run as ended. Every frame
  forwarded after the child is gone now re-arms the window. The trade is stated at `armStdioFlush`:
  a grandchild that keeps writing keeps the shim alive, and the run's own deadline is the
  platform's.
* **The entrypoint does not `process.exit` when the shim shuts down; it lets the loop drain.**
  `process.exit` discards what Node holds in a socket's **userland** write queue. The first figure
  recorded here — 16 MiB written to a raw Unix socket, then `end()`, `destroySoon()`,
  `process.exit(0)`, delivering **8,192** bytes five runs out of five — was a measurement of a *raw
  socket*, and a review rightly could not reproduce it against the shim: restoring `process.exit(0)`
  left the suite green and a slow runner (5 ms per chunk, and a 3 s stall) lost nothing either way.
  It does not, because backpressure keeps the queue empty at shutdown — when the socket fills the
  shim pauses the child's stdout, so the child cannot finish and the run cannot end while the queue
  is full.
  **The defect is real all the same, and the condition it needs is that the child ends while the
  socket is backed up** — which `exit` permits, because it does not wait for a pipe. Measured
  against `apps/runlet/src/index.ts` with a runner that stops reading and a child that exits 7 after
  writing a 64-byte tail: shipped delivers **64 of 64** tail bytes and the `exit` frame, three runs
  out of three; `process.exit(0)` delivers **0 of 64** and **no `exit` frame at all**, three out of
  three — a runner that is never told the run ended. The figure is now produced by a test rather
  than quoted (standing rule 39): `conformance.contract.test.ts`'s *"delivers the tail and the exit
  frame to a runner that stopped reading before the run ended"*, which fails with *"the socket closed
  before a exit frame arrived"* when `process.exit(0)` is restored. An `unref`ed 10 s timer remains
  as the backstop for a handle that never closes; check 5 above (`exited 0 by itself`) is the
  assertion that the drain still ends.
* **Teardown covers the child, not its descendants — and the difference is WP-14's to close.**
  `killChild` signals one pid. A review measured the gap with `process.kill(pid, 0)`: a child that
  forks a **detached** grandchild leaves that grandchild running after the shim has shut down, and
  no signal from the shim can reach it (`detached: true` asks for a new process group, so signalling
  the group would miss exactly the process that escaped). What closes it is the container: stopping
  the run container kills its whole pid namespace, which is what check 6 above observes when the run
  container reaches `exited:0` on its own. **WP-14 therefore owes the run a `docker stop`/`rm` on
  every path that ends it** — including the paths where the shim has already exited and the launcher
  is only tidying up — because "the shim exited" is *not* "the workspace's processes are gone". The
  shim's own docblock at `killChild` states the guarantee at this width so no later reader takes the
  broader one.

## Re-run against the real image (WP-22, 2026-09-12)

Everything above was measured with the shim started from **TypeScript source** in `node:24-alpine`
with this repository bind-mounted read-only at `/repo` — the arrangement technical/05 forbids a run
container, and the only one available before `platform-runtime` existed. That image exists now
(`docker/runtime.Dockerfile`), and the same seven checks were re-run against it:

| | |
|---|---|
| Host | macOS 15 (darwin 25.6.0), arm64 |
| Docker | client/server **29.7.2**, API **1.55**, `linux/arm64` |
| Shim image | **`platform-runtime:dev`** — `claude` 2.1.267, `agentic-runlet` as the entrypoint, **no `/repo` mount** |
| Driver image | `node:24-alpine` with `/repo` (the *runner's* side, which is the platform and may have it) |
| Command | `RUNLET_CHECK_RUNTIME_IMAGE=platform-runtime:dev node scripts/runlet-container-check.mjs` — **7/7 passed**, 7.8 s |

What the re-run changes about the evidence, and what it does not:

- **check 5 is now the real packaging.** `an SDK query() completes through the shim in a hardened
  container` ran with the shim being the image's bundled `/usr/local/bin/agentic-runlet` (349 kB, no
  `node_modules`) rather than a TypeScript entry loading the whole `@platform/infrastructure` barrel
  — which, before the bundle, pulled `pg`, `pg-boss`, the Agent SDK and `vitest` into a run
  container. The shim logged `{"command":"/ctl/fake-claude-cli","cwd":"/tmp","pid":18,…}` and the
  run completed `{"ok":true,"result":"the shim carried this"}`;
- **the fake CLI moved onto the control volume.** With no `/repo` in the run container there is
  nowhere else to put an executable both sides can name, and both sides must name it identically
  because the SDK checks `existsSync` on the executable **on the runner's side** before handing the
  command to `spawnClaudeCodeProcess`. The driver therefore mounts the run's sub-directory at `/ctl`
  as well as the whole volume at `/run/agentic/ctl`;
- **it still does not run the real `claude`.** The binary is in the image and answers `--version`
  (2.1.267, matching the SDK the platform runs), but check 5 spawns the fake CLI, because a real one
  needs a model credential this repository does not have. That is the same boundary WP-13 drew.

The check keeps both arrangements: with `RUNLET_CHECK_RUNTIME_IMAGE` unset it behaves exactly as it
did at WP-13, which is what a developer changing the shim wants.

## Reproducing

```
node scripts/runlet-container-check.mjs          # 7 checks, ~40 s, needs a Docker daemon
node scripts/runlet-container-check.mjs --keep   # leaves the volume and containers for inspection
RUNLET_CHECK_RUNTIME_IMAGE=platform-runtime:dev node scripts/runlet-container-check.mjs
```
It is deliberately not a `verify` target: `verify`'s steps are CI's steps
(`scripts/verify-targets.ts`), and CI's lint and unit jobs have no daemon.
