# 14 — Orchestration protocol for the autonomous implementation session

> How a single long-running Claude Code session delivers `13-implementation-plan.md` without losing context. The session's main agent is the **Orchestrator**; it delegates every work package to a fresh-context **implementer** subagent and every result to a fresh-context **reviewer** subagent (`.claude/agents/`). The **architect** agent is available read-only for design questions, and the **refiner** agent turns a finding that is bigger than the work package that found it into a scheduled piece of work.

## Principles
1. **State lives in files, not in the conversation.** `docs/technical/PROGRESS.md` is the ledger (status per WP, decisions, discovered work, blockers). The orchestrator re-reads it at every iteration; after any compaction or restart it can continue from the ledger alone.
2. **Fresh context per unit of work.** The orchestrator never reads source files or large outputs itself; it reads subagent reports (≤ 300–400 words) and the ledger. Implementers and reviewers start clean every time.
3. **Independent verification.** A WP is done only when: the implementer reports DONE, `pnpm run -s verify` passes in the orchestrator's own shell, the WP's test target passes, and the reviewer returns APPROVE. Loops are bounded: max 3 review rounds, then the WP is marked BLOCKED with the findings in the ledger and the orchestrator moves on.
4. **Small, green commits, pushed.** One commit per accepted WP (or per accepted review round if large), conventional message `feat(scope): WP-nn <title>` with `Signed-off-by`, pushed to `origin/main` immediately. Build in public: never commit secrets; the pre-commit hook (gitleaks) must be installed in WP-00.
5. **Dogfood the product's rules.** Refine before building (read the WP and its docs), plan briefly, implement, verify with deterministic checks, review with fresh eyes, retro into the ledger.

## The loop
```
repeat:
  1. Read PROGRESS.md. Pick the next WP whose dependencies are DONE, in plan order; prefer WPs marked parallel-safe when two implementers can run at once (different packages, no shared files).
  2. Ensure clean tree and green verify on main (git status; pnpm run -s verify). If red: spawn implementer "fix main" before anything else.
  3. Spawn implementer(s) with: WP id, the exact rows/docs to read, notes from the ledger, and the report format. Parallel implementers run in isolated worktrees (Agent tool isolation: worktree); sequential ones work on main.
  4. On report: run pnpm run -s verify and the WP's test target yourself. FAIL → send the failure to the same implementer (SendMessage) with "fix, then re-report" (max 2 times), then treat as review round.
  4b. Route the findings that are not this WP's. A report or a review that surfaces a defect **bigger than the work package it was found in**, or a product improvement, goes to a fresh-context **refiner** agent (`.claude/agents/refiner.md`), which turns it into a backlog entry, a plan row with an acceptance criterion, an OPEN-QUESTIONS entry with a recommendation, or a decision-record amendment — carrying the measurement that earned it. It is **not** fixed in the current WP and **not** left in the report. The refiner writes only `PROGRESS.md`, `13-implementation-plan.md`, `OPEN-QUESTIONS.md` and `TODO.md`; the orchestrator still owns the ledger's own sections.
  5. Spawn reviewer with the WP id and diff range. REQUEST_CHANGES → send findings to the implementer (new invocation with the findings from the ledger), max 3 rounds. APPROVE → commit, push, update PROGRESS.md (status DONE, commit sha, decisions, discovered work).
  6. For worktree WPs: merge the worktree branch into main (fast-forward or merge), run verify on main, push.
  7. Every 5 WPs or at milestone boundaries: run the full test suite incl. integration/e2e targets, check `gh run list --limit 5` for CI status on GitHub and fix-forward failures as a WP "ci-fix"; write a short milestone note in PROGRESS.md (what works end-to-end, what is missing).
until all WPs are DONE or BLOCKED.
```

## Context hygiene for the orchestrator
- Keep every tool output short — but **never `| tail` a run you may need to diagnose**: a pipeline exits with `tail`'s status (so a `FAIL` inside an `&&` chain scrolls past and the chain continues), and the failing test's name is destroyed with the rest of the output. Redirect to a file and filter the file: `pnpm run -s verify > /tmp/v.log 2>&1; echo $?; grep -E '^(PASS|FAIL):' /tmp/v.log`. Both halves of that cost this project a standing rule (61, 75). `git log --oneline -5` is fine; never `cat` sources.
- Ask subagents for the report format only; if a report exceeds the limit, ask for the summary again.
- Do not keep an in-conversation task list; PROGRESS.md is the list. Update it with small Edit calls.
- When the conversation gets long, write a "resume note" section at the top of PROGRESS.md (current WP, current round, next step) before continuing; after compaction, read it first.

## Blockers and questions
- Product ambiguity → `docs/OPEN-QUESTIONS.md` entry with a recommendation; implement the recommendation; continue.
- **A finding too big for the WP that found it** → refiner agent, then continue the WP. Absorbing it makes the WP unreviewable; dropping it loses the measurement someone paid a review round for. The largest gap in this project's history — `createPipelineRuntime` composed only by a test harness, through twenty-three work packages — was a finding **no work package owned**, which is exactly the shape this step exists to catch.
- External blocker (missing credential, unavailable service) → mark WP BLOCKED with the exact human action needed (blocker brief: what is missing, why it blocks, what to do), continue with other WPs. Never wait idle if any WP can proceed.
- Only when no WP can proceed: write the blocker briefs at the top of PROGRESS.md and stop with a summary.

## Commit and push policy
- Commit only accepted WPs; push after every commit. Work directly on `main` (single-team phase); worktree branches `wp/nn` are merged and deleted.
- Never rewrite history, never force-push, never amend pushed commits.
- If GitHub CI fails on a pushed commit, the next iteration starts with a `ci-fix` WP.

## Verification script contract (created in WP-00)

> **Invocation form (WP-00, verified):** pnpm 12 rejects a global flag before an implicit script name — `pnpm -s verify` errors with `unexpected argument '-s' found`. Always use `pnpm run -s <target>`.

`pnpm run -s verify` = lint + typecheck + unit + contract tests; `pnpm run -s verify:integration` = Testcontainers suites; `pnpm run -s verify:e2e` = fake-Claude compose e2e; `pnpm run -s verify:ui` = web tests. Each target prints a one-line PASS/FAIL summary at the end.

`verify` is itself the concatenation of three sub-targets — `verify:static`, `verify:types`, `verify:tests` — which exist so that CI does not carry a second copy of the list: each is one workflow job's one command, so a step added to `verify` is a step CI runs. This was earned: `ignored:check` sat in `verify` and in **no** CI job from WP-06 until WP-10, because the two lists were maintained by hand. The table is `scripts/verify-targets.ts` and `scripts/verify.test.ts` fails when a target or group of it is not invoked by `.github/workflows/ci.yml`.

## Definition of done per WP
Acceptance criteria from the plan met; tests per `10-testing-strategy.md`; `pnpm run -s verify` green; reviewer APPROVE; ledger updated; commit pushed; no new `[unverified]` claims in docs without a TODO entry; `.env.example` and `CLAUDE.md` updated when relevant.
