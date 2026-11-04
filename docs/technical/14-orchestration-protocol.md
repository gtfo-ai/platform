# 14 — The lean loop: how this repository is built

> Replaces the session-1…21 orchestration protocol (its text is in git history; its ledger,
> `PROGRESS.md`, is **frozen** as history). Decided by the product owner on 2026-11-04: keep the roles
> and the quality gates, drop the weight.

## Roles

| Role | Who | Does | Never |
|---|---|---|---|
| **Orchestrator** | the main session (`/orchestrate`) | picks the next slice, writes its brief, routes findings, merges | writes product code, reads large outputs |
| **Architect** | `.claude/agents/architect.md`, on demand | takes a **decision** when a slice needs one: a short TD/BD or an amendment (≤ 1 page) | specifies code line by line; runs per slice |
| **Implementer** | `.claude/agents/implementer.md` | builds one slice with its tests in a worktree, runs `verify`, pushes a branch, opens a PR | commits to `main`; edits `docs/decisions/**` or `docs/product/**` |
| **Reviewer** | `.claude/agents/reviewer.md` | one pass over the PR diff with fresh eyes | edits files; blocks on nits |

## The loop (one slice)

```
1. Orchestrator: pick the next slice from 13-implementation-plan.md; if it needs a decision the
   docs do not hold, ask the architect first (one short record, then continue).
2. Orchestrator: write the brief (template below) — ≤ 40 lines.
3. Implementer (worktree, branch slice/<id>): build + tests; `pnpm run -s verify` must PASS;
   push the branch; `gh pr create` with the PR template filled in. Report ≤ 200 words.
4. In parallel:  CI runs every tier on the PR (lint … integration, e2e, web-e2e, DCO).
                 Reviewer reviews the PR diff — one pass.
5. Verdict:
   - APPROVE / APPROVE-with-nits → the implementer (same agent, a message) fixes nits on the branch
     without a new review; the orchestrator checks the diff of the fix.
   - REQUEST_CHANGES (blocker/major only) → implementer fixes; the reviewer re-checks only the
     findings (a second pass is the exception, a third means the slice is split or sent to the
     architect).
6. Merge when CI is green and the review approved: `git push origin slice/<id>:main`
   (fast-forward; rebase on origin/main first if it moved — CI must be green on the pushed head).
   GitHub marks the PR merged. One line in LEDGER.md (same commit or the next).
```

**Parallel slices**: two implementers at once in two worktrees when the plan marks the slices
independent (different packages, no shared migration number).

## Slices

A slice is **one coherent capability**, one PR, usually what used to be 2–3 work packages. Its plan
entry is short:

```
| S-nn | Title | Depends | Decision(s) | Acceptance (≤ 6 bullets: observable behaviour + the test that proves it) | Risk: low/high |
```

Design detail lives in the decision records, not in the plan row. **Risk: high** = touches
credentials, the worker protocol, the updater, money (cost ledger), migrations that are not plainly
additive, or authz — those get the reviewer's security checklist and canaries.

## The brief (orchestrator → implementer)

```
Slice S-nn — <title>
Worktree: <path>  Branch: slice/<id>  Base: <sha>
Goal: <2–3 sentences: the capability and why>
Acceptance: <the plan row's bullets>
Read: <the decision sections + the 3–6 files that matter>
Decided, do not reopen: <bullets>
Constraints: CLAUDE.md non-negotiables; docs/technical/16-engineering-checklist.md
Done = verify PASS + PR open + report (files, acceptance → test names, anything found)
```

## Gates (what "quality" means here)

- **Tests in every slice** (technical/10): unit/property for domain, contract tests for ports, an
  integration or fake-Claude e2e for pipeline and protocol behaviour.
- **`pnpm run -s verify` passes locally** before the PR; **CI green on the PR head** before merge —
  CI is the integration/e2e verdict (no local load-gated tiers, no double e2e runs).
- **One review per PR.** Risk-high slices: the reviewer runs 2–4 calibrated canaries on the
  security-relevant lines and checks the 16-checklist's security section.
- **Docs first for decisions only**: a slice that changes a decision gets the architect's record
  merged with (or before) it. Docs a slice makes false are fixed in the same PR.
- `CLAUDE.md`'s non-negotiables, DCO, no secrets — unchanged.

## State, findings, history

- **`docs/technical/LEDGER.md`** — one line per merged slice: id, title, PR, merge sha, date, one
  sentence of note. This is the state: the next slice is the first plan row without a LEDGER line.
- **`docs/technical/BACKLOG.md`** — one line per open finding (grade, owner, item). Implementer and
  reviewer add a line there in their PR when they find something outside the slice; nobody else
  "refines" it. The orchestrator schedules majors into a slice or a decision.
- **`docs/technical/16-engineering-checklist.md`** — the ≤ 15 rules that still catch defects
  (distilled from PROGRESS's 102). A new rule needs a real defect and one line of evidence.
- **PR descriptions** hold the implementer's notes and the review verdict.
- `PROGRESS.md` is read only when an old entry is cited (`PROGRESS #NNN`).

## Machine

The owner's machine also runs other projects (a Docker VM); heavy tiers run on CI for that reason.
Locally: `verify` only, never `pkill`/`killall`, push only from a clean tree (the pre-push hook
tests the working tree), implementers in worktrees with `pnpm install --frozen-lockfile --offline
--ignore-scripts` (so the shared git hooks stay pointed at the main checkout).
