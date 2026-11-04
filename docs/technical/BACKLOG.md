# BACKLOG — open findings

The live backlog of the lean loop (technical/14): one line per open finding, nothing else.
`PROGRESS.md` is frozen history, and each entry's full text, evidence and "done" criteria stay there;
the # column is the entry's original number, so cite it as `PROGRESS #NNN`. To add an item, append one
line with the next free number (the highest is 733, so the next is **734**), its grade
(blocker/major/minor/nit) and its owner (a slice or WP, or "—"), in the same PR as the slice that found it.
To close one, move its line to "Closed" below with the merge sha or PR, or delete it and say so in that
slice's LEDGER line.

Sorted by grade (major, minor, nit, then ungraded), then by number. "?" means the entry states no grade.

| # | Grade | Owner | Item |
|---|---|---|---|
| 171 | major | WP-58 (architect ruling pending) | KB query floor drops the subject word on a single-subject vault; a wrong page can outrank the right one on PostgreSQL (small-to-major) |
| 693 | major | WP-283 | Ruled (c): on a remote worker the launcher's mirror and export helpers need the core-held SSH deploy key; worker must sign through the core |
| 714 | major | WP-281 | Claim, heartbeat and finish SQL must re-check `workers.revoked_at` and the user-may-act rule (`USER_MAY_ACT`) in their own statement, so a request authenticated just before a revoke or ban cannot commit after it |
| 232 | minor | — | Storage gauge (org-dashboard panel, 50 GB warning, partition purge) not built; only Prometheus metrics exist |
| 446 | minor | — | WP-144 criterion (3), a real `docker compose stop runner` mid-run, not built; needs fake providers reachable from a compose stack |
| 538 | minor | — | Two installations sharing one tracker service account both see themselves as assignee, so the claim does not stop double work |
| 730 | minor | — | A stage offer names no assignee (WP-278): the ticket's assignee is read at intake (`TicketRead.assignee`) and dropped, so BD-032 decision 5's head start reaches only an ask's asker until a mapped assignee user is stored on the task |
| 733 | minor | — | Offer timestamps (`server_from`, `workers_from`, `expires_at`) are written from the offering process's clock and compared with the claimant's, while claimant liveness uses the database's clock; a process clock ahead of the claimant's delays a server claim by the skew (WP-278) |
| 556 | minor | WP-270 (b) | Flake: runlet conformance case for a close after `result` fails with write EPIPE in CI (two occurrences); measure before fixing |
| 570 | minor | — | Flake: web-e2e xss.spec, integrations page never showed its Setup guide button within 30 s (once in three runs) |
| 587 | minor | — | `git -C <dir>` honours a run-written .git/config (fsmonitor, pager, hooks); tier 3 per TD-030; path-guard measurement in docs/TODO.md |
| 687 | minor | — | docker-socket-proxy pinned at 0.3.0 while 0.5.0 is current; read the diff and bump both instances, or record why not |
| 688 | minor | — | Take-over of a run held by a remote worker exports the branch but no untracked-files tarball; needs an upload verb and retention |
| 694 | minor | WP-285 | Undecided whether a rate_limited run saves its unfinished work; WP-285's criteria must state it |
| 695 | minor | WP-283 | A run package carries the core's workspacePath and claudeCodePath; WP-283 must say the worker answers them from its own provisioning |
| 696 | minor | — | protocol:check reads "one release earlier" as the base's first parent, so a multi-commit push can slip a protocol version bump |
| 701 | minor | WP-281 | Ruled: a start failure in the claimant settles as not_started; run.started moves to the CLI spawn request; release until then (the first two built by S-22.1; `release` is WP-281's) |
| 704 | minor | WP-284 | WP-279's launcher resolves a create's image digest with a bare `sha256:` inspect, which finds an image id (what `/v1/health` answers) but a registry manifest digest only under the containerd store; TD-032's `sha-<7>` digests need `repo@digest` or an id map — measure on a worker bundle |
| 705 | minor | WP-283 | The relayed helper agent socket's ownership: WP-279's Docker phase measured `1000:0`/`0660` in a `1000:0`/`0750` directory (export helper uid 1000, mirror helper root with no capabilities); the `remote-worker` must create it so |
| 708 | minor | WP-283 | The worker must serve each run's relayed helper agent socket from a directory of its own: the mirror/export helpers mount the socket's whole directory, so a shared one would let one run's helper reach another run's socket (PR #2 review) |
| 711 | minor | — | A user's deactivation (Better Auth ban/disable) expires their workers' run leases from the update's after-hook, after its commit, not in its transaction as TD-031 §7 says; a trigger on users is not additive (TD-032 D) |
| 712 | minor | WP-281 | WP-280 serves no X-Worker-Protocol check on device/device-token (a credential-less machine asks before it speaks the protocol); WP-281 should state whether the 426 applies there |
| 715 | minor | — | Device-flow limit keys an exact IPv6 address (rotate within a /64 to dodge the 20 per address), and ~10 addresses fill the 200 instance slots for 10 min; key IPv6 on its /64 and alert on the instance limit |
| 722 | minor | WP-281 | `/readyz` on a process that is not a claimant (`app` beside a busy `runner`) reads `claimants: none` and degrades after an offer waits 5 min, though another process's server claimant is alive and only busy. The liveness row exists since WP-278 (`server_claimants`, migration 0097, renewed by every running server claimant); `/readyz` only needs to read it beside WP-281's connected-worker count |
| 713 | nit | — | worker_device_codes rows are never deleted; bounded by the 200-pending limit per ten minutes, but grow with use; add a sweep of consumed/expired rows |
| 367 | nit | — | Lost-reminder recovery reads at most 50 never-reminded rows per kind, so not-yet-due rows can hold a due reminder back |
| 422 | nit | — | pipeline.outbound polls at 0.5 s in every process; idle cost on a large job table and drain above N = 50 never measured |
| 439 | nit | — | WP-136 put the pipeline harness's `now` on the test clock, which also moves run_commands.created_at and the steer window |
| 440 | nit | — | Flake: two-processes e2e read one gate entry's MR diff twice in `app` under load (coalescer race suspected, not measured) |
| 505 | nit | — | Unmeasured whether a production run's control connection closes on the CLI's exit or the launcher's stop; needs a model credential |
| 555 | nit | — | Fake Claude runner cannot withhold a spawn frame, so the withheld-spawn ending has no fake-Claude e2e |
| 658 | nit | — | Over-ask: a command substitution in a git remote or branch position is split at spaces and refused at the boundary |
| 672 | nit | — | Over-ask: a newline inside a backtick in a substitution body is over-read; blocked on 681 |
| 681 | nit | — | Over-ask: `$` after an escaped backslash in a command name is read as an expansion where bash runs a literal name |
| 682 | nit | — | Over-ask: a single-quoted backtick in a `$(…)` body reads uncertain where bash runs a literal name |
| 710 | nit | — | WP-275a (3)'s planted pattern value is asserted through the ticket snapshot only; the KB-page and prior-artifact paths into the same prompt have no case of their own |
| 683 | nit | — | bash 5.3 keeps a backtick body's trailing backslash and 3.2 drops it; the policy records no reading for that byte |
| 685 | nit | — | Over-ask: a quoted `[` as a command name reads as an expanded name and blocks, where bash finds nothing and runs nothing |
| 702 | nit | — | `apps/launcher` still declares `@platform/prompts` as a runtime dependency (and the launcher image copies it) though nothing at runtime reads it since WP-279; tests only — move to devDependencies |
| 706 | nit | — | `DockerWorkspaceProvider.cliEnvironment` after a launcher restart answers the configured tag's `PATH`, not the digest the run was created from (the run→image map is memory); harmless while one tag serves every run |
| 732 | nit | — | An offer withdrawn before any claim (`run_plan_missing`, WP-278's `offer_timeout`) escalates with `escalate`'s wording — *stopped without a result … open the run's transcript* — for a run that never started and has no transcript |
| 721 | nit | — | An ask's settle (WP-276) re-reads the task's run and audit lines a citation may name at settle time, not at plan time, so a citation of a line written after the plan is kept; storing the plan's lines would need a column |
| 132 | ? | — | Unexplained once: authenticated GET /api/artifacts/:id answered 200 with an empty body in verify:e2e; instrumented, not seen since |
| 7 | ? | — | "Carried, not yet scheduled": a bullet list of carried nits (route-sealed credential never opened by the loader, volume retention, …) |

## Closed

| # | Grade | Closed by | Item |
|---|---|---|---|

| # | Closed by | Item |
|---|---|---|
| 690 | WP-274 `4760587c` (scanner matched to TD-032's 2026-11-04 amendment) | Ruled (TD-032 amendment D): create trigger/type/sequence in additive migrations; scanner to match the amendment |
| 691 | WP-274 `4760587c` (scanner matched to TD-032's 2026-11-04 amendment) | Ruled (TD-032 amendments A–C): scanner admits same-file unique index, validated constraint, platform_table_policy insert |
| 700 | S-22.1 (WP-275a) | Ruled: settleRun in the claimant lacks the job's memory (redactor, review checklists); the planned spec is sealed in a new run_plans table |
| 697 | S-22.2 (WP-276 criterion 9) | One lock order run_offers → runs → tasks: `lockSettlement`, `finish`, a cancel's `lockRun`/`lockLiveRunOf` and the sweep's claim lock the offer first; the claim takes `for update of o, r skip locked`; `offer-lock-order.integration.test.ts` holds it with a 40P01 canary |
| 698 | S-22.2 (WP-276 criterion 10) | Memory store keeps writes made before a fenced write threw LeaseLostError; divergence 4 now names it, and every `lease_lost` test asserts through PostgreSQL or on the fenced call's own answer |
| 709 | S-22.2 (WP-276) | The claimant reads `run.started`'s context-pack record back (`RunRepository.contextPack`, `run_context_pack` and the header columns), never from transaction 1b's memory |
| 707 | S-22.4 (WP-279), found and fixed in the slice | An export over SSH never pushed: the export helper runs as uid 1000, the git image has no such user, and OpenSSH exits 255 (*No user exists for uid 1000*) — `pushed: false`, nothing in `failures`, carried (WP-146) or relayed alike; the helper now gets a read-only `/etc/passwd` from `<ctl>/helper-etc/` (measured by `deploy-key-check.mjs`) |
