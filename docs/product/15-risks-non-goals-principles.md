# 15 — Risks, non-goals and principles

## Product risks and mitigations

| Risk | Impact | Mitigation (product level) |
|---|---|---|
| Agents produce plausible but wrong MRs; reviewers lose trust | Adoption dies | Independent Code review + Business review stages; acceptance evidence per criterion; small tasks; human merge; trust metrics visible (review pass rate) |
| Cost blow-ups | Buyer churn | Per-run caps, per-task caps, project/org budgets, forecasts, cheap models for cheap stages, context packs instead of dumping the KB |
| Vague tickets → wasted spend | Cost + trust | Refinement stage with Definition of Ready; questions before code; drift labelling |
| Knowledge base rots (stale, contradictory, bloated) | Killer feature becomes noise | Librarian consolidation, provenance, "last validated" dates, usage counters, human proposal queue, size budgets per KB section |
| Prompt/rule injection through tickets, MR comments or logs | Security | Treat all external text as data; tools least-privilege; no secrets in agent context; policy blocks on destructive ops; review stage explicitly checks for suspicious instructions in inputs |
| Anthropic policy on subscription use | Legal/ToS | Default API key; no claude.ai login flow in product; subscription mode documented as operator's own credentials for personal/local use (research/04) |
| Rate limits with parallel agents | Throughput | Org-level `max_parallel_runs`, backoff, queue |
| Integration API drift | Breakage | Integration type contracts + contract tests in CI; version pins for CLIs in the image |
| Lock-in fear from users | Adoption | Knowledge in the user's repo as markdown; export everything; open source |
| Review fatigue from too many MRs | Team pushback | WIP limits per project, batching notifications, MR quality checklist, size limits with split proposals |
| Agent loops (review ↔ implementation) | Cost + time | Bounded iterations, convergence detection, escalation, iteration counter in UI |
| Agents misreport completion / game tests (research/01: 75.8% of self-assessed failures were false successes; pass rates collapse when test edits are excluded) | Bad MRs look done | BD-024: deterministic checks decide "done", tamper gate on tests/CI config, reproduction gate for bugs, reviewers with fresh context and read-only tools |
| Slow outer loop frustrates humans (Sweep post-mortem) | Adoption | Fast inner loop inside the workspace (tests, lint, app boot); tracker/MR only as outer loop; live transcript in UI |
| Config-from-MR attack (an MR edits the rules that govern its own review) | Security | BD-025: agent config read from default branch only |
| Flaky CI misattributed to the agent | Wasted iterations | Flaky detection (retry once), recorded in retro |
| Secrets leaking into transcripts/KB | Security | Redaction of known secret patterns in transcripts and artifacts; agents never receive secrets; KB commits scanned |

## Non-goals (v1)

- Multi-provider LLM support (abstraction only).
- SaaS multi-tenancy.
- Auto-merge.
- Replacing the ticket board or code host UI.
- Mobile app.
- Agents deploying to production.
- Fine-tuning models.

## Principles (full)

1. **Knowledge compounds** — every task must improve the project knowledge or explicitly state why it did not.
2. **Ask, don't guess** — a question costs a human two minutes; a wrong assumption costs a review cycle.
3. **Small steps, hard gates** — S/M tasks by default; split L/XL; gates are deterministic where they can be.
4. **Independent verification** — the agent that wrote the code never reviews it.
5. **Everything is an event; everything is auditable; everything is replayable.**
6. **Opinionated defaults, total overridability** — global → project → repository.
7. **Cost is a feature** — visible live, capped, forecast.
8. **Least privilege** — per stage, per tool, per integration action.
9. **No lock-in** — markdown in git, exports, open source.
10. **Humans work where they already are** — Jira, GitLab, Slack first; the UI is the control tower.
11. **Boring technology, cloud-native shape** — 12-factor, containers, stdout logs, env config (Round 2 chooses the stack).
12. **Build in public** — no secrets in the repo, ever; docs are the product spec.
