# LEDGER — what is merged

One line per merged slice (technical/14): the state of the build. The next slice is the first plan
slice of the current milestone without a line here. History before 2026-11-04 — milestones M1–M21 and
the first rows of M22 — is in the frozen `PROGRESS.md` (its tables and notes stay readable there).

| Slice | Title | PR | Merge | Date | Note |
|---|---|---|---|---|---|
| WP-271 | Migrations declare a class; `migrations:check` | — | `fd0e6a22` | 2026-11-04 | pre-lean; 3 review rounds |
| WP-272 | The schema guard admits an all-additive future | — | `a487521c` | 2026-11-04 | pre-lean; folded backlog 689, 692 |
| WP-273 | Worker-mode contracts and `protocol:check` | — | `c8d97738` | 2026-11-04 | pre-lean; a run package carries no secret |
| WP-291 | Sign-in redesign and the first-sign-in hint | — | `d32166fc` | 2026-11-04 | owner request; migration 0093; live on Autix |
| WP-274 | Run offers, the claim and the lease epoch | — | `4760587c` | 2026-11-04 | pre-lean; migration 0094 |
| WP-275 | `settleRun` | — | `bfa86711` | 2026-11-04 | pre-lean; money path traced |
| process | The lean loop: technical/14, 15, 16, LEDGER, BACKLOG; M22 re-cut into slices S-22.1…12 | — | — | 2026-11-04 | owner decision; PROGRESS.md frozen |
| S-22.1 | The run plan is stored and the run's lifecycle follows the offer (WP-275a, WP-275b) | #3 | `22515c2e` | 2026-11-04 | migration 0095 `run_plans` (sealed); review: docs only; backlog 700 closed, 709–710 |
| S-22.4 | The launcher writes the skills it is given and runs only the digests it is told (WP-279) | #2 | `02889b87` | 2026-11-04 | relayed deploy-key carriage; fixed: no SSH export had ever pushed (707); backlog 702–708; V-WM8 half measured (socket proxy → WP-284) |
| S-22.5 | Workers and the device flow (WP-280) | #4 | `d58c8960` | 2026-11-04 | migration 0096 `workers`, `worker_device_codes`; `wkr_` credential hashed; backlog 711 (deactivation after commit, minor), 714 (major, WP-281: re-check revoke/ban at write) |
| decision | The worker's local UI: TD-031 amendment, S-22.13 / WP-292 added; Q126 answered (no hand-back; a local cancel pauses the task) | #6 | `65c8db6e` | 2026-11-04 | owner request |
| S-22.2 | The job ends at the offer: server claimant, gates on every worker, `workers_only` readiness (WP-276, WP-277) | #7 | `9d2e16f1` | 2026-11-04 | review: every escalation site closes its offer (was 720); one lock order over 8 writers; backlog 697/698/709 closed, 721–722; rollback floor 3 |
| S-22.3 | Execution settings: mode, preference, fallback, assignee window, offer timeout (WP-278) | #8 | `2e125594` | 2026-11-05 | migration 0097 (+ `server_claimants` liveness); review: withdrawal reasons as short codes (731, escalations no longer roll back); TD-031 §8 reading amended; backlog 730, 732, 733 |
| decision | The redesign: TD-033 visual design language, M23 slices S-23.1–S-23.15 (WP-300–329 reserved), Q46 answered, research/19 | — | — | 2026-11-05 | owner request; D1–D4 per recommendation |
| S-22.6 | Worker protocol I: handshake, claim, heartbeat with commands, release, spawn, finish, late cost (WP-281) | #9 | `da2641cc` | 2026-11-05 | review: settle trusts the core's spawn marker over a worker's report; TD-031 2026-11-05: a mint failure is a start failure (740); backlog 701, 712, 714, 722, 746 closed; 741–745 |
| S-23.1 | Design foundations: brand tokens (dark default), Inter, Octicons, Base UI, the primitive kit | #10 | `20186e37` | 2026-11-05 | review approve-with-nits (counter label, nav toggle, menu trigger); bundle 293 kB of 300 (backlog 802); backlog 800–803 |
| S-23.14 | Live domain events on the org, project and task SSE topics | #11 | `08c39f64` | 2026-11-05 | high risk; review approve-with-nits (task-topic canary, bridge start order, payload ids test); backlog 804; server statements floor 66 |
| S-23.4 | The frame: top bar, org nav, /projects, the project layout route; screens lazy-loaded | #14 | `543c5634` | 2026-11-05 | review approve-with-nits (one primary per view, focus per press, More marks current); initial 260.6 kB (backlog 802 closed, 812 open); backlog 810–813 |
| S-23.3 | The mascot's office poses and props as sprite grids; Bot and Seat components | #12 | `702bedc8` | 2026-11-05 | ComfyUI poses (research/18 office-poses.md); review approve-with-nits; backlog 806–807 |
