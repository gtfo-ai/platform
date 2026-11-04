# BACKLOG — open findings

The live backlog of the lean loop (technical/14): one line per open finding, nothing else.
`PROGRESS.md` is frozen history, and each entry's full text, evidence and "done" criteria stay there;
the # column is the entry's original number, so cite it as `PROGRESS #NNN`. To add an item, append one
line with the next free number (the highest is 703, so the next is **704**), its grade
(blocker/major/minor/nit) and its owner (a slice or WP, or "—"), in the same PR as the slice that found it.
To close one, move its line to "Closed" below with the merge sha or PR, or delete it and say so in that
slice's LEDGER line.

Sorted by grade (major, minor, nit, then ungraded), then by number. "?" means the entry states no grade.

| # | Grade | Owner | Item |
|---|---|---|---|
| 171 | major | WP-58 (architect ruling pending) | KB query floor drops the subject word on a single-subject vault; a wrong page can outrank the right one on PostgreSQL (small-to-major) |
| 693 | major | WP-283 | Ruled (c): on a remote worker the launcher's mirror and export helpers need the core-held SSH deploy key; worker must sign through the core |
| 232 | minor | — | Storage gauge (org-dashboard panel, 50 GB warning, partition purge) not built; only Prometheus metrics exist |
| 446 | minor | — | WP-144 criterion (3), a real `docker compose stop runner` mid-run, not built; needs fake providers reachable from a compose stack |
| 538 | minor | — | Two installations sharing one tracker service account both see themselves as assignee, so the claim does not stop double work |
| 556 | minor | WP-270 (b) | Flake: runlet conformance case for a close after `result` fails with write EPIPE in CI (two occurrences); measure before fixing |
| 570 | minor | — | Flake: web-e2e xss.spec, integrations page never showed its Setup guide button within 30 s (once in three runs) |
| 587 | minor | — | `git -C <dir>` honours a run-written .git/config (fsmonitor, pager, hooks); tier 3 per TD-030; path-guard measurement in docs/TODO.md |
| 687 | minor | — | docker-socket-proxy pinned at 0.3.0 while 0.5.0 is current; read the diff and bump both instances, or record why not |
| 688 | minor | — | Take-over of a run held by a remote worker exports the branch but no untracked-files tarball; needs an upload verb and retention |
| 694 | minor | WP-285 | Undecided whether a rate_limited run saves its unfinished work; WP-285's criteria must state it |
| 695 | minor | WP-283 | A run package carries the core's workspacePath and claudeCodePath; WP-283 must say the worker answers them from its own provisioning |
| 696 | minor | — | protocol:check reads "one release earlier" as the base's first parent, so a multi-commit push can slip a protocol version bump |
| 697 | minor | WP-276 criterion (9) | Ruled: one lock order run_offers → runs → tasks, so a claim and a cancel/sweep/settle of the same run cannot deadlock |
| 701 | minor | WP-281 | Ruled: a start failure in the claimant settles as not_started; run.started moves to the CLI spawn request; release until then (the first two built by S-22.1; `release` is WP-281's) |
| 702 | minor | WP-276 | `recordCliSpawn` takes `run.started`'s context-pack record from transaction 1b's memory; a claimant outside the job must read it back (`run_context_pack` or the plan) |
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
| 703 | nit | — | WP-275a (3)'s planted pattern value is asserted through the ticket snapshot only; the KB-page and prior-artifact paths into the same prompt have no case of their own |
| 683 | nit | — | bash 5.3 keeps a backtick body's trailing backslash and 3.2 drops it; the policy records no reading for that byte |
| 685 | nit | — | Over-ask: a quoted `[` as a command name reads as an expanded name and blocks, where bash finds nothing and runs nothing |
| 698 | nit | WP-276 criterion (10) | Memory PipelineStore keeps writes made before finish threw LeaseLostError; PostgreSQL rolls them back |
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
