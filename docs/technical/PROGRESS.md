# PROGRESS — implementation ledger

> Maintained by the orchestrator (docs/technical/14-orchestration-protocol.md). Statuses: TODO · IN_PROGRESS · REVIEW · DONE · BLOCKED. Keep entries short; details go in the WP's notes section below.

## Resume note

> **Session 2 started 2026-09-09.** Read this section, then "Standing rules earned by evidence"
> and "WP-06a" below, then continue the loop in `14-orchestration-protocol.md`. Nothing is broken; `main` is
> green and every finished WP is pushed.
>
> **In flight right now:** WP-06a review round 2 (branch `wp/06a` `887e72d`, all five verify targets
> re-confirmed green in the orchestrator's own shell before the review was sent) and WP-07 (implementer in
> an isolated worktree, branch `wp/07`). Environment re-confirmed: gh authenticated as `JanMikes`, Docker
> 29.7.2, pnpm 12.3.4, Node 25.1.0.

**Where things stand**

- **`main` is at `d60d770`, green on all five verify targets, CI green.** Nine work packages are DONE and
  pushed: WP-00 `8852b9e` · WP-01 `dedc4b9` · WP-02 `168d368` · WP-02a `8abf247` · WP-03 `ca1ae06` ·
  WP-05 `3397924` · WP-04 `59817d6` · ci-fix `6481b3d` · WP-04a `d729616` · WP-06 `d60d770`.
- **WP-06a is finished but NOT on `main`.** It lives on branch **`wp/06a`** (commit `887e72d`, pushed).
  It is green on all five targets and its round-1 review findings are fixed, but **its round-2 review was
  still running when the session paused**, so it was deliberately kept off `main`.

**The immediate next step**

1. Re-run the final review of `wp/06a` (this is its review round 2; rounds are bounded at 3). The brief the
   last reviewer was given: verify the fifth-layer fix (`Connection.abandon()` writing `reset` per topic then
   `shutdown` **off-chain**); judge whether the new test "cannot pass for the wrong reason" is elegantly
   branch-independent or blind to which branch ran; check the 500-turn `settle` bound is a proof of
   impossibility rather than a disguised timing assertion; check the corrected memory arithmetic
   (255×64 + 512 = 16,832 frames ≈ 10.59 MiB on one stalled stream, 33× the budget it replaces); and above
   all **review the ten-entry shared-quantity audit in the module docblock as a document — is anything
   missing?** Five layers of this defect were found by four readers, every one of them "replay and live
   share a quantity".
2. On APPROVE: `git merge --squash wp/06a` into `main`, re-run all five targets **on main**, commit, push,
   delete the branch. On REQUEST_CHANGES: one more implementer round, then it is BLOCKED and recorded.
3. **WP-06a must land before WP-12 or WP-15**, because nothing publishes to the SSE hub until then and the
   defect is latent only until they do.

**Then continue the plan**

- **WP-07** (integration ports + fakes + contract suites) is next in plan order and unblocks WP-08…WP-11,
  which are four parallel-safe provider WPs.
- **WP-12** (Claude SDK runner) depends on WP-04 and WP-05, both DONE, so it can run alongside WP-07.
- Cap concurrency at **two or three** agents — see the parallelism note below; three implementers plus
  reviews drove this 14-core host to load average 143 and made timing-sensitive tests lie.

**Merge recipe that works** (used for WP-02, WP-03, WP-04, WP-05): `git merge --squash <branch>` →
`pnpm install` → run all five verify targets → resolve conflicts (expect `pnpm-lock.yaml`, both packages'
`index.ts` and `package.json`, `.env.example`, and `docs/technical/PROGRESS.md`, which is orchestrator-owned
so take your own side) → `git add -A` → commit with the WP message → push. **Green in a worktree is not
green on `main`**: WP-04 added a *required* config field that WP-05's test literal did not have, and both
were green in isolation.

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
9. **When two code paths can both satisfy an obligation, the fact that the obligation was met is itself a
   shared quantity, and it needs an explicit arbiter.** This is the sixth layer of the WP-06a defect and the
   same sentence as the other five. Two paths each correctly discharging "the client has been told" is not
   two correct paths; it is an unsynchronised shared flag with no flag.
10. **A test whose assertion is satisfied by every branch must also assert which branch ran**, or it certifies
   the observable and not the code. `hub.test.ts:817` asserted `shutdown@-` last — true down either route —
   and never asserted the `reset` that only one route writes.

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
| WP-06a | SSE: replay and live frames share the write chain; and the test harness cannot see it | WP-06 | no | REVIEW | branch `wp/06a` `887e72d` | all 5 targets re-verified green by the orchestrator (session 2); review round 2 running; **before WP-12/WP-15** |
| WP-07 | Integration ports + fakes + contract test suites | WP-04 | no | IN_PROGRESS | branch `wp/07` (worktree) | started session 2, alongside the WP-06a review |
| WP-08 | Jira Cloud provider | WP-07 | yes | TODO | — | |
| WP-09 | GitLab provider (gitlab.com + self-managed) | WP-07 | yes | TODO | — | |
| WP-10 | Slack provider | WP-07 | yes | TODO | — | |
| WP-11 | Sentry + Loki providers | WP-07 | yes | TODO | — | |
| WP-12 | Claude SDK runner (technical/04) | WP-04, WP-05 | no | TODO | — | |
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
