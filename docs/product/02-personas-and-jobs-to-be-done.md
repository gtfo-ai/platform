# 02 — Personas and jobs to be done

## Personas

### P1 — Engineering lead / CTO ("the buyer and the governor")
- Owns budgets, quality bar, and the decision to adopt.
- Wants: throughput without surprises; cost per delivered task; proof of quality (review pass rate, defect rate); an audit trail for compliance questions.
- Fears: runaway spend, low-quality MRs that waste senior reviewer time, secrets leaking, the agent "doing something weird" to production systems.
- Touchpoints: dashboard, statistics, budgets, audit log, project settings, model/effort defaults.

### P2 — Developer ("the reviewer and merger")
- Reviews and merges agent MRs, answers technical questions, occasionally gives feedback ("never use X here").
- Wants: MRs that look like a good colleague wrote them (small, tested, described, following conventions); to be able to see *why* the agent did something; fast turnaround on review comments.
- Fears: review fatigue; the agent ignoring conventions; having to babysit.
- Touchpoints: GitLab MR, Jira comments, Slack thread, run detail page (to see what happened), feedback button.

### P3 — Product manager / business owner ("the source of truth for *what*")
- Writes tickets, answers refinement questions, owns the business documentation, checks business acceptance.
- Wants: tickets that get built as intended; to be asked when something is unclear instead of guessed; a drift warning when a ticket contradicts the product direction.
- Fears: the agent building the wrong thing well.
- Touchpoints: Jira comments/questions, onboarding interview, business knowledge base pages, business review verdicts.

### P4 — Platform operator ("the one who installs it")
- Deploys the platform in Docker, connects integrations, rotates tokens, upgrades.
- Wants: 12-factor container, one compose file to start, clear env vars, health checks, logs to stdout, no secrets in repo.
- Touchpoints: deployment docs, integration setup screens, health page.

### P5 — The agents themselves (design persona)
- Each stage agent is a "colleague with a role". Designing prompts as job descriptions (responsibilities, inputs, outputs, when to ask, when to stop) makes the pipeline legible to humans. We treat them as personas in the docs: *Triager, Product Manager, Architect, Developer, Reviewer, Acceptance Tester, Retrospective Facilitator, Librarian*.

## Jobs to be done

| # | When… | I want to… | So that… | Persona |
|---|---|---|---|---|
| J1 | a well-described ticket lands in the backlog | label it and have it delivered as an MR without me driving a session | my team's time goes to novel problems | P1, P2 |
| J2 | a ticket is vague | be asked precise questions before any code is written | we don't build the wrong thing | P3 |
| J3 | a bug report references Sentry/Loki | the agent pulls the evidence itself and proposes a root cause | I don't spend an hour collecting logs | P2 |
| J4 | I review an agent MR and leave comments | the agent addresses them like a colleague would, in the same MR | review is one round-trip, not a re-prompt | P2 |
| J5 | the agent made a bad call | tell it once and have it remembered for every future task in this project | I never repeat myself | P2, P3 |
| J6 | I onboard a new project | give the platform our business context and conventions once | every agent works with a senior's understanding | P1, P3 |
| J7 | the month ends | see cost per task/stage/project and what was delivered | I can justify the spend and tune models | P1 |
| J8 | something goes wrong | see exactly what prompt, model, settings and tool calls led to it | I can trust and debug the system | P1, P2 |
| J9 | we hit budget | work pauses gracefully and I get notified, nothing is half-done or lost | no surprise invoice | P1 |
| J10 | I add a new tool (e.g. GitHub) | implement one integration module and register events, nothing else changes | the architecture doesn't rot | P4 |
| J11 | many tickets are ready | run several in parallel with a WIP limit per project | throughput scales with budget, not headcount | P1 |
| J12 | I watch an agent work | see live formatted output and who is doing what right now | I stay in control | P1, P2 |

## Anti-personas (who we are not building for now)

- Solo hobbyist who wants a free chat coding assistant (use Claude Code directly).
- Enterprises requiring on-prem models or non-Claude providers (later, via the provider abstraction).
- Teams without a ticketing system or git hosting (our value is the integration).
