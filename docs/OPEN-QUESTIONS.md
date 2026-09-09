# Open questions

Answered questions move to the **Decision log** at the bottom with the founder's answer and the document that records it. Only genuinely open items stay in the top section.

## Open

**Q39 How the first account on a fresh instance is created.** `technical/08` lists `POST /api/org/users/invite` and Better Auth's sign-in routes, and `product/06`'s wizard begins with an operator already signed in — but nothing says how that operator's account comes to exist on an instance whose `users` table is empty, nor whether self-registration is open. WP-06 could not defer it: an instance nobody can sign in to has no testable login. — *Recommendation (implemented in `apps/server/src/auth/bootstrap.ts` and `.env.example`):* **open registration is off by default** (`APP_ALLOW_SIGNUP=false`; with it on, a new account gets `member`), and the first administrator comes from the environment — `APP_BOOTSTRAP_ADMIN_EMAIL` plus `APP_BOOTSTRAP_ADMIN_PASSWORD` (or its `_FILE` variant), applied **only** while the instance has no users at all, and created through Better Auth's own sign-up path so the password is hashed by the same code a later login verifies it with. The account is promoted to `admin` in the same boot. The alternative — "the first person to sign up becomes the administrator" — hands the instance to whoever reaches it first in the window between the container starting and the operator opening the browser, which for a self-hosted product on a public address is a real race, not a theoretical one. An instance with no users and no bootstrap credential starts and logs a warning that nobody can sign in, rather than refusing: an operator adding the variable and restarting is a better failure than a container that will not boot. Confirm, and decide whether the onboarding wizard (WP-21) should end by forcing a password change on that account.

**Q38 Working-day calendar.** `technical/12` writes `limits.question_timeout: 1 working day` and `packages/contracts` publishes the grammar (`N [working] minutes|hours|days`), but no document says what a *working* day is: which weekdays count, which hours of them count, where holidays come from, and in whose time zone. WP-05 had to resolve deadlines to an absolute instant, so it could not defer the question. — *Recommendation (implemented in `packages/application/src/scheduling` and `.env.example`):* an **organisation-level** calendar — working days are an organisational fact, not a repository one, so `.agentic/config.yml` may not set it — with four fields: `timezone` (IANA, seeded from `TZ`, default UTC, never the host clock), `working_weekdays` (default Monday–Friday), `working_hours` (default 09:00–17:00 in that zone) and an explicit `holidays` list of dates (default empty; the platform never guesses a country's public holidays, and an operator who wants them pastes them in or the onboarding wizard offers a country list later). "Working time" is then time inside those windows and nothing else, which makes `1 working day` = one full window (Friday 16:00 + 1 working day = Monday 16:00) and `2 working hours` behave consistently. Confirm, and decide whether the wizard should offer a holiday preset per country (product/06 step 5) and whether quiet hours (WP-32) should reuse the same window.

**Q37 Hazards the command block-list of `product/19` §3 states as one spelling each.** The list gives `rm -rf /*`, `git push --force*`, `git push origin :*`, `git branch -D *` and `curl * | sh` / `wget * | sh`. Every one of them is a hazard written as a single spelling, and the other spellings of the same hazard do not match the pattern: `rm -fr /`, `rm -r -f /`; `git branch --delete --force main`; `git push -f`, `git push … --delete` / `-d`, the force refspec `git push origin +agentic/x:main`, and the plain refspec `git push origin agentic/foo:main`, which writes `main` under an allow entry that names only `agentic/*`; and `curl http://x|sh`, `| bash`, `| /bin/sh`, `|&`, `wget -O- http://x|sh`. WP-02 declined to invent the missing patterns (security rules belong in the document, not in code the document does not state), named the gap in `DECLINED_BLOCK_VARIANTS`, and recorded that they all land on `ask`, never `allow`. **WP-02a disproved that last claim:** `git push origin agentic/x -f`, `git push origin agentic/x --delete` and `git push origin agentic/foo:main` all returned **allow**, because the allow entry `git push origin agentic/*` was carrying them, and the `curl|sh` spellings returned `ask` rather than `block`. The line the code now draws: a missing spelling that only decides between `ask` and `block` stays the document's to fix — the command can never reach `allow`, so the code is not what is keeping it out; a missing spelling reachable from the **allow**-list is closed in code, because the allow-list is the one thing the module defends. So `git push -f*`, `git push --delete*`, `git push -d*` and `git push origin +*` joined the block list, the refspec form floors at `ask`, and the `curl|sh` family is caught by normalising a pipeline's spacing and spelling any shell stage `sh`; `rm -fr /` and `git branch --delete --force main` are unchanged and still `ask`. — *Recommendation:* amend product/19 §3 to state the hazards rather than one spelling of each — `rm` with any recursive flag outside the workspace; branch deletion in either form; force-pushing, deleting or retargeting a remote ref in any spelling, refspecs included; piping a download into any shell — so that the document and the code say the same thing. Two further items on that list (`any command writing outside the workspace`, `network calls to non-allow-listed hosts`) cannot be a command pattern at all and are enforced by the run container and the egress proxy (TD-021); they are recorded in `UNPATTERNABLE_BLOCK_ITEMS`. WP-02a also found that this module's approximation of the first of those two — flooring a `> file` redirection at `ask` — is walked around by flags that write a path directly (`git diff --output=`, `git log --output=`, GNU `find -fprintf` / `-fls`, all verified against the real tools); they are now floored by `HAZARDOUS_ARGUMENTS`, along with `pip install --target/--root/--prefix/--log/--report`. A second review round added two more families to the same list: `git difftool --extcmd`, and `git log --ext-diff` / `git show --textconv`, which run whatever the *repository's own* config names and so are untrusted input under BD-022.

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
