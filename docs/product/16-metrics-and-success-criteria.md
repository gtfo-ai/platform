# 16 — Metrics and success criteria

## Product success (what we optimise for)

| Metric | Definition | Target after 3 months on a real project (assumption) |
|---|---|---|
| **Merge rate** | merged agent MRs / tasks started | ≥ 70% |
| **First-pass acceptance** | tasks reaching *Ready for merge* with zero human MR comments / tasks merged | ≥ 40% |
| **Human intervention rate** | tasks with any `Needs human`, answered question or human return / tasks started | ≤ 50% initially, trending down as KB grows |
| **Cost per merged task** | total task cost / merged tasks, by template | feature ≤ $25, bug ≤ $15, chore ≤ $5 (assumption; measure first) |
| **Cycle time** | intake → merged (wall clock), and *agent time* (sum of run time) | median feature < 24h wall, < 2h agent |
| **Return rate per stage** | returns into stage / stage entries | code review returns 0.5–1.5 per task is healthy; > 3 signals prompt/KB problems |
| **Knowledge growth quality** | proposals accepted / proposals made | ≥ 60% |
| **Knowledge usage** | % runs whose context pack included a KB document that the agent cited | ≥ 80% |
| **Clean-first-MR rate per ticket author** | tasks reaching Ready with zero returns and zero human comments, grouped by ticket author | visible to everyone in the project (Q22), framed as "tickets that needed no questions"; no target |
| **Reviewer minutes per merged MR** | time from human review start to merge (approximation from MR events); accounts an operator declared machines are excluded; every review window during which that account approved a merge request in the project is withheld from the published figure — a deliberately wide rule, erring toward withholding — until the approval delivery is verified on a real GitLab (`docs/TODO.md`), and counted in the metric's caveat (WP-61) | trending down |
| **Defect escape** | bugs filed against agent-merged MRs within 30 days / merged MRs — a bug counts only when its ticket **links** the merge request (no inference from adjacency), and the rate is published only when at least half of the period's bugs are traceable that way — a **chosen** floor, the product's rule rather than a derived one; below it the rate is absent, with the coverage as the reason (WP-61, Q87) | tracked, no target yet |

## Operational metrics (dashboard)

- Tasks delivered per day/week/month; by project, template, size.
- LOC added/removed/changed per merged MR and aggregated per day (from MR diff stats, read once per merged MR; the platform's own merge requests only — WP-61).
- Cost: per run, stage, task, project, org; per model; cache hit ratio (cache-read tokens / input tokens).
- Why not LOC as a success metric: METR's RCT found experienced developers 19% slower while believing they were faster (research/01); LOC is shown for information, delivered-and-merged work is the target.
- Budget utilisation and forecast.
- Agent utilisation: parallel runs vs limit; queue wait time.
- Integration health: event lag (webhook received → processed), failed outbound actions.
- Question response time (asked → answered) — this is usually the real bottleneck; show it to the team.
- Human minutes per merged MR and total cost of delivery (tokens + people).
- Cost estimate accuracy by size; budget approvals requested/granted.
- Shadow mode: similarity to the human MR, predicted cost per ticket. Review-only: findings accepted vs dismissed. Ticket linter: tickets edited within 48 h of the lint comment.
- Rebase gate: conflicts auto-resolved vs escalated; concurrent-task overlaps (distinct pairs of tasks at a pair of revisions; a push to either side is a new overlap — WP-61).

## Success criteria for the definition phase (this round)

- Every requirement from the founder brief maps to a section and a decision.
- Every external claim is sourced or tagged `[unverified]`.
- An implementer can build the MVP end-to-end from `docs/` + Round 2 technical docs without asking product questions that are not already in `OPEN-QUESTIONS.md`.
