# Open questions

Answered questions move to the **Decision log** at the bottom with the founder's answer and the document that records it. Only genuinely open items stay in the top section.

## Open

**Q37 Two hazards the command block-list of `product/19` §3 states too narrowly.** The list gives `rm -rf /*` and `git branch -D *`, so the same destructive actions spelled differently — `rm -fr /`, `rm -r -f /`, `git branch --delete --force main` — do not match. WP-02 declined to invent the missing patterns (security rules belong in the document, not in code the document does not state) and named the gap in `DECLINED_BLOCK_VARIANTS` instead; all three land on `ask` today, never `allow`. — *Recommendation:* amend product/19 §3 to state the hazards rather than one spelling of each: `rm` with any recursive flag outside the workspace, and branch deletion in either short or long form. Two further items on that list (`any command writing outside the workspace`, `network calls to non-allow-listed hosts`) cannot be a command pattern at all and are enforced by the run container and the egress proxy (TD-021); they are recorded in `UNPATTERNABLE_BLOCK_ITEMS`.

**Q36 The full RBAC capability map.** `technical/08` names seven capabilities by example (`task.answer_question: member`, `task.approve_plan: maintainer`, `run.steer: member`, `kb.proposal.decide: maintainer`, `project.settings.write: admin`, `budget.write: maintainer`, `transcript.read: member`) and `product/11` describes the four roles in one sentence each; WP-02 needed a decision for every action the API of `technical/08` exposes. — *Recommendation (implemented in `packages/domain/permissions.ts`, asserted by an exhaustive role×action test):* keep the seven documented entries verbatim and derive the rest from product/11's sentences — **viewer** reads (org, projects, tasks, artifacts, runs, budgets, knowledge); **member** acts on a task without deciding for the team (create, pause/resume, retry or return a stage, take over and hand back, answer questions, steer, cancel or retry a run, give feedback, ask the task, export, read transcripts); **maintainer** decides (approve plans and budgets, decide knowledge proposals, write the KB, write budgets, pipeline and autonomy settings, cancel a task, `@agentic rework`, run shadow and discovery, read the audit log, read integrations); **admin** administers (users, project membership, project creation and settings, integrations, org settings). The judgement calls worth a veto: **cancelling a task, `rework` and `return_to_stage` are maintainer, not member** — the first two discard work the team paid for, and `return_to_stage` sends the task backwards and burns one of BD-008's bounded iterations exactly as `rework` does, so leaving it at `member` would make the maintainer gate on `rework` bypassable through the cheaper action (retrying the *current* stage costs a run rather than a loop and stays at `member`); and **`integration.read` is maintainer, not viewer** (integration config is close to credentials).

**Q35 `DiscoveryDraft` artifact schema.** `technical/12` lists the structured `data` of nine artifact types but not `DiscoveryDraft`, which `technical/02` and `technical/04` both name. WP-01 needed a schema to publish. — *Recommendation (implemented in `packages/contracts`):* model it on the outputs `product/06` § "Step 2 — Technical discovery" describes — `documents[{path, title, markdown, confidence}]` for the drafted `technical/*.md` pages, `commands[{purpose, command, verified, evidence}]` where `verified` means the agent actually ran it in the workspace, `linked_documents[{path, reason}]` for files that are linked rather than copied, and `questions[]` for what it could not answer. Confirm or amend when the Discovery prompt is written (WP-17/WP-21).

**Q34 Founder veto on operating definitions.** `product/19-operating-definitions.md` contains 21 product-owner decisions made on your behalf (workpad template, command policy defaults, significance scores, Jira mapping, MR conventions, interview bank, statistics formulas, autonomy presets, risk classes, cost model, human-time rules, linter comment, bootstrap spec, take-over protocol, storage gauge, dogfood plan). — *Recommendation:* skim and veto by item number; silence = accepted.


**Q23 Model defaults.** BD-013 (Opus 5 for reasoning-heavy stages, Sonnet 5 for verification/summaries, Haiku for classification) has not been confirmed. — *Recommendation:* accept as defaults and revisit after the first 20 dogfood tasks with per-stage cost and return-rate data.

**Q24 Readiness level thresholds.** product/17 proposes five levels with specific criteria. — *Recommendation:* accept provisionally; tune after dogfooding.

**Q25 Significance thresholds (BD-018).** Concrete defaults for the discard and auto-apply thresholds. — *Recommendation:* discard = typo/formatting-only deltas; auto-apply band = reference items, link fixes, `last_confirmed` bumps; everything else (lessons, rules, decisions, business facts) = proposal.

## Assumptions to confirm (tagged `(assumption)` in docs)

- A1 Target team size 2–50 developers (product/01).
- A2 Cost targets per merged task in product/16 are placeholders until measured.
- A3 Teams accept a bot posting in Jira/Slack; some organisations require approval for bots — onboarding docs must cover it.
- A4 The founder's projects have CI in GitLab; if not, the CI gate is skipped (product/04).

## Round 2 (technical) — answered

All Round-2 decisions are recorded as TD-001…TD-024 in `decisions/technical/README.md`; remaining technical uncertainties are verification items in `TODO.md`.

## Decision log (answered 2026-08-28)

| Q | Question | Answer | Recorded in |
|---|---|---|---|
| Q1 | License | Apache-2.0 | BD-002 |
| Q2 | Stage additions (Intake, CI gate, Investigation, Merged gate, Librarian, 4 templates) | Accept all | BD-005 |
| Q3 | Plan approval default | By size (L/XL) + probation mode (first 5 tasks) | BD-006, product/04 |
| Q4 | KB apply policy | Proposals by default; `auto_apply` opt-in for a middle significance band; a discard threshold below which nothing is created | BD-018, product/05, product/07 |
| Q5 | Human MR comments | All unresolved threads by mapped users, batched with 2-minute debounce; max 3 rounds | BD-007, product/04 |
| Q6 | KB location | Configurable `knowledge_dir`, default `.agentic/knowledge`; Obsidian hidden-root behaviour still to test | BD-012, product/12, TODO |
| Q7 | Drift without a direction document | Configurable: `disabled` + one-time nudge (default) or `label_unknown` | product/05 |
| Q8 | Question timeout | 1 working day by default, configurable | BD-006, product/04 |
| Q9 | Communication language | `auto` (match ticket/thread) | BD-016 |
| Q10 | Who can answer/approve | Only mapped users with roles; member answers, maintainer approves | BD-006, product/11 |
| Q11 | "Delivered" definition | Merged agent MR | product/16 |
| Q12 | Budget timezone | Org setting, default from `TZ`, fallback UTC | BD-010 |
| Q13 | Retention | Configurable, default keep everything forever | BD-003, product/09 |
| Q14 | `local` provider mode in Docker | First-class (documented compose profile) | BD-004, product/14 |
| Q15 | Repository directory name | `.agentic`, configurable | BD-014 |
| Q16 | Sentry/Loki in MVP | Agent tooling + bug pre-fetch only | product/14 |
| Q17 | Dogfood projects | Two projects, both Jira Cloud; GitLab, one gitlab.com and one self-managed; platform source on GitHub | product/14, product/08 |
| Q18 | Bot identity | Dedicated bot per integration + "Requested by" footer | product/08 |
| Q19 | Workpad comment | Yes | BD-023 |
| Q20 | Rework-as-reset | Yes, explicit trigger (`@agentic rework` or MR closed with reason) | BD-007, product/04 |
| Q21 | Low readiness | Warn + stricter defaults; readiness is report-only, never auto-remediated | BD-026, product/17 |
| Q22 | Clean-first-MR rate per ticket author | Show to everyone in the project | product/16 |
| Q26 | Adoption features in MVP? | All of them, in three internal milestones | product/14, product/18 |
| Q27 | Autonomy dial vs granular policies | Presets over granular; overrides show as Custom | BD-027 |
| Q28 | Ticket readiness linter default | Opt-in per project, off by default | BD-028, product/18 |
| Q29 | Business model | Everything Apache-2.0; hosting, support, registry | BD-029 |
| Q30 | Configuration of adoption features | One wizard step "Operating mode and features", all optional, mirrored in settings | BD-028, product/06 |
| Q13-b | Storage gauge | Yes; warning at 50 GB, purge by month partitions | product/19 §20 |
| Q23 | Model defaults | Accepted provisionally; revisit after 20 dogfood tasks | BD-013 |
| Q24 | Readiness thresholds | Accepted provisionally; detection rules defined | product/19 §5 |
| Q25 | Significance thresholds | Score classes with discard 0.2 / proposal 0.6 | product/19 §4 |
| Q31 | Shadow report | Defined | product/19 §13 |
| Q32 | Risk classes | Defined | product/19 §14 |
| Q33 | Spawn mechanism for the CLI inside run containers | In-container run shim over a Unix socket on a per-run control volume; launcher-relayed exec as fallback (founder: "spawn inside the container or via docker proxy — propose a solid solution") | TD-025 |
