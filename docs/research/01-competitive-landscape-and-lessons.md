# Research: ticket-to-MR agent orchestrators — landscape and lessons

> Researched 2026-08-28 from primary sources (repo READMEs/specs, official docs, vendor engineering posts, papers). Everything was fetched directly unless marked. Informs BD-005…BD-008, BD-021…BD-024 and product/04, /15, /16.

## Landscape (what exists, what to borrow, what to avoid)

### OpenAI Symphony — closest analogue (Apache-2.0, 27k★, "engineering preview", spec-first)
Polling daemon turning Linear into the control plane: claims eligible issues, per-issue workspace, `codex app-server` subprocess, human merges. No database (Linear is truth); orchestration states `Unclaimed → Claimed → Running → RetryQueued → Released` separate from tracker states; dispatch = labels ∧ active state ∧ per-state + global concurrency ∧ priority/age; stall timeout 5 min, turn timeout 1 h, `max_turns` 20; exponential backoff with previous-failure context injected on retry; **the Linear API key never reaches the agent** (host-side `linear_graphql` tool); strict Liquid templates; hot-reload of `WORKFLOW.md` with last-known-good. The 329-line `WORKFLOW.md` is the best published "ticket workflow for an agent": status map as state machine; **one persistent "workpad" comment** on the issue (env stamp, plan checklist, acceptance criteria, validation commands, notes, confusions) instead of many comments; reproduce first; ticket `Validation`/`Test Plan` sections are non-negotiable; **scope-creep valve** = file a separate Backlog issue; PR feedback sweep (every reviewer comment blocking until fixed or justified pushback); completion bar before Human Review; **rework after human rejection = full reset** (close PR, new branch, state what will be done differently); blocked-access **blocker brief** (what is missing / why it blocks / exact human action). OpenAI-internal: "some teams saw 500% more landed PRs in three weeks", conditional on harness engineering; companion post: `AGENTS.md` ~100 lines as a map, everything else in `docs/`, linters whose error messages are remediation instructions.
Avoid: no persistent state, no budget primitive, unsandboxed hooks, single-prompt monolith for all stages.
https://github.com/openai/symphony , https://github.com/openai/symphony/blob/main/SPEC.md , https://github.com/openai/symphony/blob/main/elixir/WORKFLOW.md , https://openai.com/index/open-source-codex-orchestration-symphony/ , https://openai.com/index/harness-engineering/

### Paperclip (MIT, 80k★) — "AI company" control plane
Node/Postgres; adapters (Claude Code, Codex, …) with `invoke/status/cancel`, CLI session id persisted for resume; **heartbeat table as queue with coalesced wakeups**; **atomic checkout** `UPDATE issues SET … WHERE status = ANY(:expected)`; execution policy per issue with review/approval stages, `maxReviewRounds` (default 3) then escalation to a responsible human, human decisions reset the counter; append-only **cost ledger in cents, cache-adjusted**, attributed to company/agent/project/goal/issue/model; budget = window + amount + warn 80% + hard stop ("It stops"); agent-proposed spend approvals; config revisions with rollback. Avoid: company metaphor overhead, unsandboxed adapters, telemetry on by default.
https://github.com/paperclipai/paperclip , https://docs.paperclip.ing/guides/power/execution-policy/ , https://docs.paperclip.ing/guides/day-to-day/costs/

### Vibe Kanban (Apache-2.0, 28k★; company shut down 2026-04-10)
Worktree per task, executor profiles, **inline diff comments batched into one follow-up prompt**, "needs attention" state. No cost tracking. https://github.com/BloopAI/vibe-kanban , https://www.vibekanban.com/blog/shutdown

### Claude Squad (AGPL-3.0), Conductor (closed, Mac)
Squad: pause = commit + delete worktree, keep branch. Conductor: `conductor.json` setup/run/archive scripts with per-workspace port; **Checks tab** aggregating git status, CI, review threads, todos as merge-readiness. https://github.com/smtg-ai/claude-squad , https://www.conductor.build/docs/reference/checks

### Ralph loop (Huntley; Anthropic `ralph-wiggum` plugin; snarktank/ralph MIT 21.7k★)
Fresh process per iteration with file-based state (`prd.json` stories with `passes`, `progress.txt`), iteration caps, tests must pass before commit. Lessons: quality drops past ~100–150k tokens, one story must fit one context window, agents write false completion claims to escape loops, plan files rot, users burned two Max subscriptions in days; Huntley would not use it on an existing codebase without strong tests. https://ghuntley.com/ralph/ , https://github.com/snarktank/ralph , https://www.geocod.io/code-and-coordinates/2026-01-27-ralph-loops , https://www.theregister.com/2026/01/27/ralph_wiggum_claude_loops/

### Backlog.md (MIT, 6.7k★)
Task document schema: frontmatter + Description / Acceptance Criteria (checkboxes) / Implementation Plan / Implementation Notes / Definition of Done; one task = one context window = one PR; **three human checkpoints: spec, plan, code**. https://github.com/MrLesk/Backlog.md

### Kilo Code cloud agents (Apache-2.0)
Trigger (webhook/cron) → prompt template → container session → auto-commit after every message → PR; YOLO only; compute billed per second, no per-task cap. https://kilo.ai/docs/code-with-ai/platforms/cloud-agent

### OpenHands (MIT, ~87k★, SWE-bench Verified 72.8%)
**Event-sourced state** (`Event(id, ts, source, cause)`, typed action/observation; condensation is itself an event, history never deleted; cost went from quadratic to linear with no accuracy loss); persistence as `base_state.json` + per-event files; workspace abstraction Local/Docker/Remote behind one agent-server; **memory tiers**: always-on `AGENTS.md`, keyword-triggered skills, path-triggered rules injected into tool results; cost per `usage_id`, `max_budget_per_task`, org caps with 80/90/100 alerts; `ConfirmRisky(threshold)` policy on model-declared `security_risk`; stuck detector (repeat ×4, error ×3); critic on finish with bounded refinement (3). Jira Cloud webhook intake with a service account; git ops under the triggering user's credentials; resolver gated on `author_association`. Lessons: thread pub/sub caused ordering bugs → rewrite; 10 GB image; 140+ config fields; daily real-LLM integration tests; "a fork falls ~2,600 PRs behind per year — never fork". https://github.com/All-Hands-AI/OpenHands , https://docs.openhands.dev/sdk/arch/events.md , https://www.openhands.dev/blog/the-path-to-openhands-v1 , https://docs.openhands.dev/openhands/usage/cloud/project-management/jira-integration

### SWE-agent / mini-SWE-agent (Princeton, MIT)
Measured: lint-on-edit 18.0% vs 15.0%; capped search results; 100-line file windows; last-5 observations beat full history; "93% of resolved runs submit before exhausting budget → more budget won't help"; stateless `subprocess.run` per action for stability; non-interactive env (`PAGER=cat`), REPL blocklist, two-step submit with checklist, `cost_limit`. https://arxiv.org/html/2405.15793 , https://github.com/SWE-agent/mini-swe-agent

### Devin (Cognition, proprietary)
microVM snapshots; session states incl. `blocked`, sleeping costs nothing; Blueprints with `knowledge` = named lint/test/run commands; Jira intake by assignment/labels/`@Devin`, **scoping-only mode** (plan + confidence, human launches; 🟢 doubles merge likelihood vs 🔴); PR body template with testing checklist + session link + "Requested by"; **lint/CI failure comments always processed**; Knowledge items with trigger descriptions; Playbooks; ACU caps; **Devin Fusion** model routing at compaction boundaries ($1.35 vs $10.53 per task, same score); separate Review agent + Autofix; FrontierCode **reverse-classical tests** (agent's tests must fail on original code). Lessons: "Don't build multi-agents" (share full traces, single writer); "context anxiety"; model-written summaries not comprehensive; self-verification produces creative workarounds; shared-kernel containers → microVMs. https://docs.devin.ai , https://cognition.com/blog/dont-build-multi-agents , https://cognition.com/blog/devin-sonnet-4-5-lessons-and-challenges , https://cognition.com/blog/what-we-learned-building-cloud-agents

### Factory.ai Droids (closed CLI)
Risk-tiered autonomy with **three command lists** (allow / ask / hard-block resolving the real binary) and org-set maximum; kernel sandbox + egress allow-list; Spec Mode plan saved to `.factory/docs/YYYY-MM-DD-slug.md`; `droid exec` headless with JSON/stream output and exit codes; Missions: **validators with an information wall and validation contracts written before implementation** (GDAL parity 36% → 90%); Agent Readiness score (5 levels, 60+ criteria) gates autonomy; Signals: daily friction clustering → auto-filed tickets. Lessons: 97% of Legacy-Bench failures are silent; model routing belongs in the harness (−58% cost); linters to direct agents; multiple cheap review passes ≈ one expensive pass. https://docs.factory.ai , https://factory.ai/news/what-it-takes-for-coding-agents-to-complete-large-software-tasks , https://factory.ai/news/model-routing-belongs-in-the-harness

### Sweep (cautionary tale)
Issue→PR bot 2023–24, pivoted to an IDE plugin. Post-mortem: "needed a well defined spec to have >90% success… developers don't want to write a spec"; CI too slow as inner loop; "agents still need supervision in 5 to 10 minute intervals"; users left for Cursor. Borrow: single progress comment edited in place; CI-log hygiene (strip timestamps, extract error block, stop on 3× same error). https://news.ycombinator.com/item?id=43490121 , https://github.com/sweepai/sweep/blob/main/docs/pages/blogs/sweeps-core-algo.mdx

### GitHub Copilot cloud agent, Google Jules, Cursor Cloud Agents
Copilot: runs in Actions (59-min cap), draft PR on `copilot/*`, cannot push to default branch, **initiator's approval doesn't count**, commits link to session log, `gh-aw` safe-outputs (agent is read-only; writes applied by a scoped job). Jules: **plan approval with timer auto-approve**, **critic agent** and planning critic (−9.5% failures), per-repo correction memory, task-count quotas. Cursor: environment snapshot builds with fallback, **wake-on-event subscriptions** (agent sleeps until PR activity/CI/Slack), autofix CI with guard rules (skip if a human pushed or base is red), Slack thread as context. https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent , https://github.com/github/gh-aw , https://developers.googleblog.com/en/meet-jules-sharpest-critic-and-most-valuable-ally/ , https://cursor.com/docs/cloud-agent

### Anthropic: claude-code-action, GitLab CI, harness guidance
claude-code-action: label/assignee/mention triggers, bots blocked unless allow-listed, Bash off by default, creates branches and links to a prefilled PR page (respects branch protection), single sticky progress comment, inline comments buffered and classified by Haiku, **restores `.claude/`, `.mcp.json`, `CLAUDE.md` from the base branch** (prompt-injection mitigation), `--max-turns` + timeouts + concurrency. GitLab CI (beta): one job running `claude -p` with `--allowedTools` and a GitLab MCP binary, note-webhook → pipeline trigger. Guidance: "the agent doing the work isn't the one grading it"; "It is unacceptable to remove or edit tests"; feature list as JSON with `passes` flags ("less prone to agent corruption than Markdown"); evaluators "talk themselves into approving"; secure SDLC: "draw the boundary around access and actions, not around a model's instructions". https://github.com/anthropics/claude-code-action , https://github.com/anthropics/claude-code-action/blob/main/docs/security.md , https://code.claude.com/docs/en/gitlab-ci-cd , https://code.claude.com/docs/en/best-practices , https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents , https://anthropic.com/engineering/harness-design-long-running-apps , https://claude.com/blog/how-anthropic-secures-its-ai-native-software-development-lifecycle

### GitLab Duo Agent Platform
LangGraph service, stateless workers with Postgres checkpoints + code as hidden git refs; executor runs in CI; `.gitlab/duo/agent-config.yml` read from the **default branch only**; **composite identity** = service account ∩ triggering human's permissions; flows declare privileges, anything else → `INPUT_REQUIRED`; Developer Flow: assign/mention → draft MR, iterates on MR feedback, "large open-ended tasks hit iteration limits". https://docs.gitlab.com/user/duo_agent_platform/ , https://docs.gitlab.com/user/duo_agent_platform/security/

### Smaller Jira/Linear → agent → GitLab MR projects
| Project | Idea worth noting |
|---|---|
| no-human-ai/no_human (MIT) | independent review model with no access to the coder session; **tamper detection** for deleted tests/suspicious assertions; **reproduction gate** (bug test fails on old code, passes on new); blocked ⇒ parks with one specific question |
| cyrusagents/cyrus (Apache-2.0) | streams activity to the tracker with dropdown selects and approval widgets |
| langchain-ai/open-swe (MIT, 10.7k★) | read-only Reviewer, Analyzer learning review preferences, `/baby-sit` watches CI |
| sortie-ai/sortie (Apache-2.0) | single binary, `WORKFLOW.md`, Jira + GitLab, CI feedback fed back, run history + cost |
| ColeMurray/background-agents (MIT) | PR attributed to the requesting user |
| jedarden/NEEDLE | outcome-class routing: success→close, failure→retry++, timeout→defer, crash→alert |
| nicobailon/pi-review-loop | review→fix→re-review max 7; fresh-context reviewer; "Fixed N issues" loops, "no issues" exits; convergence detection |
| tembo/agent-studio (MIT) | control plane with Sentry trigger and a "Tasks Inbox" for human review before external actions |
| Atlassian Rovo Dev | reviewer bot checks PR against ticket AC; self-review before requesting human review |
| Codegen | "PRs that come back clean indicate a well-specified task" → clean-first-MR rate per ticket author |
| claude-flow | community verdict "massive overkill", rigid phases — avoid as a base |

## Failure modes (evidence)
1. **Context rot, not limit** — quality erodes past ~100–150k tokens; models wrap up early near the limit ("context anxiety"). Fresh context per stage with distilled handoffs is the cure. https://towardsdatascience.com/governed-context-managing-context-rot-in-claude-code/
2. **Agents misreport completion** — 22.6% of misalignment episodes are inaccurate self-reporting; 75.8% of self-assessed failures were false successes; independent *state* verification cuts false success ~10×. https://arxiv.org/html/2605.29442v1 , https://arxiv.org/html/2606.09863
3. **Test gaming** — Claude Code pass rates fell from 37–52% to 20–24% when test edits were excluded. https://www.devassure.io/blog/ai-coding-agents-gaming-their-own-tests/
4. **Self-grading bias** — evaluators talk themselves into approving; every maker moved to a separate reviewer with fresh context and no write access.
5. **Scope creep** — 10.2% of episodes are self-initiated overreach.
6. **Cost blowups** — $500 session from compaction retries; 1,384 calls in 60 s from an idle-timeout bug; multi-agent ≈ 15× tokens; more budget does not rescue failing runs. https://larridin.com/blog/ai-agent-retry-cost-control , https://www.anthropic.com/engineering/multi-agent-research-system
7. **Slow async loop kills adoption** — Sweep; the fix is a fast inner loop inside the workspace (tests, lint, app boot), tracker only as outer loop.
8. **Review fatigue / slop** — curl bug bounty (<5% valid), Ghostty AI policy, CodeRabbit AI PRs 1.7× more issues. https://redmonk.com/kholterhoff/2026/02/03/ai-slopageddon-and-the-oss-maintainers/
9. **Underspecified tickets are the #1 upstream cause** (Sweep, Codegen, Symphony) → refinement is the highest-leverage stage.
10. **Perceived vs real productivity** — METR RCT: experienced devs 19% slower while believing +20%; measure landed MRs, review rounds, reviewer time, not LOC. https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/
11. **Wrong event model → rewrite** (OpenHands V0, Sweep) — both landed on linear append-only event logs.
12. **Over-abstracted swarms fail** (claude-flow, Cognition, Anthropic agent teams) — single writer, parallel readers, fan-out via git branches.

## Patterns adopted into Agentic (mapping)
| Pattern | Source | Where in our docs |
|---|---|---|
| Two state machines: tracker status vs orchestration state; outcome-class routing | Symphony, NEEDLE | product/04 (Round 2: TD) |
| Append-only event log, condensation as event | OpenHands | BD-003, BD-017 |
| Atomic claim, coalesced wakeups | Paperclip | Round 2 |
| Stall/turn/wall-clock/turn caps, backoff with failure context | Symphony, SWE-agent | BD-008, product/04 |
| Wake-on-event while waiting on humans/CI (no polling agent) | Cursor, Devin | product/04 S7 |
| Fresh process per stage; artifacts not transcripts | Ralph, Anthropic, Backlog.md | BD-005, product/13 |
| Sticky **workpad** comment on the ticket | Symphony, Sweep, claude-code-action | BD-023 |
| Runnable acceptance criteria + validation commands as contract | Symphony, Backlog.md | product/04 S1 |
| Scoping-only mode / probation; confidence gating | Devin | OPEN-QUESTIONS Q3 |
| Validation contract before code; planning critic | Factory, Jules | product/04 S2 |
| Scope-creep valve: file a separate ticket | Symphony | product/04 S3 |
| Reviewer: separate agent, fresh context, read-only; **tamper detection** on tests; **reproduction gate** for bugs; CI is the only green | no_human, Anthropic, Devin | BD-024, product/04 S4–S5 |
| Bounded loops with convergence detection; human decision resets counter; rework-as-reset after human rejection | pi-review-loop, Paperclip, Symphony | BD-008, product/04 S7 |
| Blocker brief format for questions/escalations | Symphony, no_human | product/13 `ask-human` skill |
| Agent never holds integration tokens; config from default branch; three-list command policy; composite identity | Symphony, claude-code-action, Factory, GitLab Duo | BD-021, BD-022, BD-025 |
| Cost ledger attributed to issue ancestry, cache-adjusted; hard pause + warnings; model routing per stage | Paperclip, OpenHands, Devin, Factory | BD-010, BD-011, BD-013 |
| Bounded observations (head/tail truncation, CI log error extraction) | SWE-agent, Sweep | product/04 S4, Round 2 |
| Readiness score gating autonomy | Factory, Symphony | product/06 |
| Metrics: landed MRs, review rounds, reviewer minutes, clean-first-MR rate per ticket author | Codegen, METR | product/16 |
| Merge-readiness "Checks" aggregate | Conductor | product/10 |
| Do not fork OpenHands/Symphony; thin orchestrator over the Claude Agent SDK | OpenHands | BD-004 |

## Things to explicitly not build
Multi-agent swarm with shared mutable state; single long session across stages; polling agents waiting on humans; LLM-only success judgement; CI as the inner loop; unlimited iterations or dollar-less budgets; tokens inside the sandbox; agent-editable tests without a tamper gate; a fork of an existing harness.
