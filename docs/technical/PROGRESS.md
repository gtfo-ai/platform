# PROGRESS — implementation ledger

> Maintained by the orchestrator (docs/technical/14-orchestration-protocol.md). Statuses: TODO · IN_PROGRESS · REVIEW · DONE · BLOCKED. Keep entries short; details go in the WP's notes section below.

## Resume note

- **Current WP:** WP-01 (`packages/contracts`) — not yet started.
- **Last done:** WP-00 committed and pushed to `origin/main` after 3 review rounds (APPROVE).
- **Next step:** delegate WP-01 to an implementer; deps (WP-00) are DONE. WP-03 depends only on WP-00 and is therefore runnable in parallel with WP-01 in a worktree.
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
| WP-01 | `packages/contracts` | WP-00 | no | DONE | next commit | APPROVE round 1; 5 hardening fixes folded in |
| WP-02 | `packages/domain` | WP-01 | no | TODO | — | |
| WP-03 | Postgres schema + Drizzle + migrations (technical/03) | WP-00 | no | TODO | — | |
| WP-04 | Event store + priority dispatcher + outbox job (TD-005) | WP-02, WP-03 | no | TODO | — | |
| WP-05 | Jobs port on pg-boss | WP-03 | no | TODO | — | |
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

## Discovered work (not in plan)

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
