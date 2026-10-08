# 17 — Repository readiness

Decision: [BD-026](../decisions/business/BD-026-repository-readiness.md). Evidence: research/01 (Factory's readiness levels; Symphony "exposes infrastructure gaps rather than overcoming them"; Sweep's post-mortem on missing sandboxes; Ralph: "no way would I use it on an existing codebase without strong tests").

## Why it exists

Autonomy is only as safe as the repository's ability to prove work correct. An agent on a repo without tests or CI produces confident MRs nobody can verify. Readiness makes that limit **explicit, measured and actionable**, so teams know why the platform behaves conservatively and what the cheapest next improvement is. Readiness is a diagnostic: the platform reports it and adjusts its own defaults, but it does not fix the repository itself (founder decision, 2026-08-28).

## What it measures

Binary criteria, detected automatically by the Discovery agent at onboarding and re-checked after every merge onto the default branch without a run (WP-64): R3 from CI events, R8, R10 and R13 from the files (R10 and R13 since WP-94, pass-only), R9, R11 and R12 from the platform's own records; the other seven keep the latest discovery's answer until a maintainer re-evaluates, which runs discovery again as a new budgeted task (WP-94). Each criterion states **what it unlocks** so the score is a value proposition, not a scolding.

| # | Criterion | How detected | Unlocks / protects |
|---|---|---|---|
| R1 | Test suite exists and runs green on default branch | test command found in `how-to-run.md`/CI config and executed in the workspace | Implementation self-check; acceptance evidence; test tamper gate has something to protect |
| R2 | Tests finish in < 15 minutes | measured | Fast inner loop; fewer per-run timeouts |
| R3 | CI runs on merge requests | pipeline events observed for MRs | Deterministic CI gate; flaky detection |
| R4 | CI is reliable (< 5% flaky reruns in last 30 days) | gate statistics | Returns caused by infrastructure are not blamed on the agent |
| R5 | Lint and formatter enforced in CI | config + CI job | Reviewer skips style; fewer nit iterations |
| R6 | One-command dev setup (`make setup`, devcontainer, compose) | executed in the workspace | Reproducible workspaces; app can be booted for business review |
| R7 | Type checking or static analysis in CI (where applicable) | config | Earlier error detection in Implementation |
| R8 | `CLAUDE.md`/`AGENTS.md` present, ≤ 200 lines, links to the KB index | file inspection | Context pack quality; lower token cost |
| R9 | Protected default branch, MR required, bot cannot self-approve | git provider API | Human merge guarantee (BD-007) |
| R10 | MR template and commit convention documented | files/KB | MR hygiene checks are objective |
| R11 | Observability bindings present (Sentry project, Loki labels) | integration bindings | Investigation stage has evidence for bugs |
| R12 | Knowledge completeness ≥ 70% (see 06) | KB score | Refinement drift detection, fewer questions |
| R13 | Secret scanning in CI or pre-commit | config | Lower risk from agent commits |
| R14 | Dependency lockfile present and installable offline from allow-listed registries | workspace build | Deterministic builds inside the network allow-list |

**A project that verifies on CI** (`verification.mode: ci`, BD-025's 2026-10-05 amendment) does not let agents run its suite, its installs or its setup, so R1, R2 and R6 are **read, not run**: R1 from a CI job that runs the test suite, R2 from a job timeout or a documented duration, R6 from the documented setup command. The evidence says so in the platform's words; the criteria and the levels are unchanged.

**"Could not check" is not "failed"** (BD-026's 2026-10-06 amendment). R1, R2 and R6 are the three criteria discovery answers by **running** a command, and in a project that verifies locally the run workspace may be unable to run it at all: the platform's run image has no interpreter for the project's language (a PHP project's `php` and `composer` are absent), or the platform's command policy refused the command or its install. Such a criterion is recorded **not checked**, with the reason as its evidence — never as a fail, because the workspace's limits are a fact about the platform, not about the repository. A criterion that is read rather than run cannot be "not checked": a report saying so is recorded as a fail. A command that **ran and failed** is a fail. What "not checked" does to the level is the ladder rule below, and when the project has a CI configuration the readiness report carries a note suggesting `verification.mode: ci`, under which discovery reads the three from it instead.

## Levels (what the score means)

| Level | Requires | Platform behaviour |
|---|---|---|
| **0 — Unverified** | none of R1, R3 | Only `chore` and `spike` run with defaults; `feature`/`bug` run with plan approval `always`, probation on, Business review requires human confirmation of evidence. Board shows a red badge with the top missing criterion. |
| **1 — Basic** | R1, R3 | `feature`/`bug` allowed with plan approval by size; probation on. |
| **2 — Reliable** | 1 + R2, R4, R5, R9 | Defaults as documented in product/04; probation can be relaxed by a maintainer. |
| **3 — Agent-ready** | 2 + R6, R8, R10, R12 | Suggested: lower plan-approval threshold to XL only; Business review may run the app. |
| **4 — Autonomous-capable** | 3 + R7, R11, R13, R14 | Eligible for future auto-merge policies for `chore` (not in v1). |

A level is reached when every rung below it is (a repository with R1 and R3 but none of level 2's criteria is level 1 whatever else it passes). **A criterion recorded *not checked* does not block its rung**: a rung is reached when each of its criteria passed or was not checked. It does not count as a pass either — it is shown as *not checked* with its reason, it is not among the cheapest improvements (the improvement is the workspace's, not the repository's), and every rung also has criteria that are read rather than run (R3 beside R1, R4, R5 and R9 beside R2, R8, R10 and R12 beside R6), so no level is reached on unchecked criteria alone. The alternative — failing them — put Autix, a PHP project whose CI runs its suite on every merge request, at level 0 (chore and spike only) because the run image has no PHP (first local test, 2026-10-05).

Levels only *suggest* stricter or looser defaults; maintainers can override any default, and the override is shown next to the readiness badge so the trade-off is visible.

## Where it shows up

- **Project page:** level badge, criteria checklist with pass/fail/not checked and "what this unlocks", trend over time.
- **Board:** badge on the project header; tooltip with the top two missing criteria.
- **Retrospectives:** each return or escalation is tagged with the readiness criterion that would have prevented it ("2 of 3 CI returns were flaky reruns → R4"). Aggregated in statistics: *returns attributable to readiness gaps* per month, which turns readiness into a cost argument ("R4 cost $41 last month").
- **Onboarding wizard:** after technical discovery, the wizard shows the initial level and the three cheapest criteria to improve next, with a short how-to for each (no automated fixes).
- **Statistics:** readiness level vs cost per merged task and first-pass acceptance rate across projects — the evidence that readiness pays.

*Amended 2026-10-08 (BD-031).* The readiness output also lists the **unmapped ticket lifecycle slots** (product/04 § "Ticket lifecycle") as a **note**. A note is information: it is never a criterion, never a failure, and it changes no level. For example: *"in review, approved and QA are not mapped: the platform moves the ticket at no point after in progress, and the QA stage is off."* A project whose binding has no lifecycle block gets one note saying that the platform neither claims tickets nor moves them.

## What it is not

- Not a code-quality score and not a judgement of the team.
- Not a gate that blocks work (except level 0 restricting to chore/spike by default, which a maintainer can override).
- Not automated remediation: the platform names the gap and the fix; humans decide when to do it (they may of course file a normal ticket for the agent to implement, like any other task).
