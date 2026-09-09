# Open questions

Answered questions move to the **Decision log** at the bottom with the founder's answer and the document that records it. Only genuinely open items stay in the top section.

## Open

**Q13-b Purge window.** Default retention is "keep everything forever" (Q13). Should the UI warn when transcript storage exceeds a size (e.g. 50 GB)? — *Recommendation:* yes, a storage gauge on the org dashboard with a one-click purge-window setting.

**Q23 Model defaults.** BD-013 (Opus 5 for reasoning-heavy stages, Sonnet 5 for verification/summaries, Haiku for classification) has not been confirmed. — *Recommendation:* accept as defaults and revisit after the first 20 dogfood tasks with per-stage cost and return-rate data.

**Q24 Readiness level thresholds.** product/17 proposes five levels with specific criteria. — *Recommendation:* accept provisionally; tune after dogfooding.

**Q31 Shadow mode comparison.** What should the shadow report compare besides files touched, size, tests and review findings? — *Recommendation:* also a Reviewer pass over the *human* MR to show findings it would have raised, and an estimate of reviewer minutes saved; nothing is posted to GitLab.

**Q32 Risk class defaults.** Which path patterns should ship as default risk classes? — *Recommendation:* `auth|login|session|token`, `payment|billing|invoice`, `migration|schema`, `infra|deploy|docker|helm|terraform`, `.agentic|.claude|CLAUDE.md|.github|.gitlab-ci`; the wizard proposes matches from the repository and the maintainer edits.

**Q25 Significance thresholds (BD-018).** Concrete defaults for the discard and auto-apply thresholds. — *Recommendation:* discard = typo/formatting-only deltas; auto-apply band = reference items, link fixes, `last_confirmed` bumps; everything else (lessons, rules, decisions, business facts) = proposal.

## Assumptions to confirm (tagged `(assumption)` in docs)

- A1 Target team size 2–50 developers (product/01).
- A2 Cost targets per merged task in product/16 are placeholders until measured.
- A3 Teams accept a bot posting in Jira/Slack; some organisations require approval for bots — onboarding docs must cover it.
- A4 The founder's projects have CI in GitLab; if not, the CI gate is skipped (product/04).

## To be answered in Round 2 (technical)

- Language/runtime and SDK flavour (TypeScript vs Python), event bus, database, UI stack, workspace isolation model, search index engine, embedding provider default, secrets handling, auth/SSO library, Slack/GitLab/Jira client libraries, testing strategy, Docker image layering, GitHub Actions workflows, versioning/release process. See `technical/README.md`.

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
