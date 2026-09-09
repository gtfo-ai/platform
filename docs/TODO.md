# TODO (definition phase and pre-implementation)

## Verification (facts stated in docs that still need a source)

- [ ] Obsidian: can a vault be rooted at a hidden directory (`.agentic/knowledge`)? (Q6) — official help pages fetched 2026-08-28 say nothing either way; needs a manual test.
- [x] Jira Cloud REST v3 transition payload and `/search` deprecation — verified 2026-08-28 from the OpenAPI spec (research/03).
- [ ] `acli` on-disk session location / env-var alternative — not documented (stdin login for CI is documented); plan to re-login at container start.
- [ ] Agent SDK `local` mode inside a container: binary mount + OAuth token; note bare mode does not read the OAuth token (verified) — test refresh at expiry (BD-004, Q14).
- [x] Agent SDK `settingSources` semantics verified 2026-08-28: `["project"]` gives CLAUDE.md, rules, skills, hooks from `<cwd>/.claude` without user-level config; no SDK bare option (research/04).
- [x] Prompt-cache multipliers per model — verified 2026-08-28, table in research/04.
- [x] GitLab: bot (Developer role) can resolve discussions; draft MRs run the same pipelines — verified 2026-08-28 (research/03). Verified 2026-08-28: Note webhooks include `object_attributes.id` and `discussion_id`; MR events include the acting `user` (username, email) — research/03.
- [x] Slack Socket Mode: up to 10 connections per app, not allowed in the Marketplace — verified 2026-08-28. Still open: Block Kit payload size limits for question choices.
- [ ] Sentry hosted MCP: `Authorization: Sentry-Bearer <token>` verified; whether Internal Integration tokens are accepted (README mentions only user tokens) — test.
- [x] AGENTS.md: stewarded by the Agentic AI Foundation (Linux Foundation), "used by over 60k open-source projects" — verified 2026-08-28 at agents.md.
- [x] Competitive claims in product/01 cross-checked against research/01 (2026-08-28).

## Product definition follow-ups

- [ ] Write the "Agentic workpad" comment template (ticket + MR) — BD-023.
- [ ] Define protected paths defaults for the tamper gate (tests, CI config, `.agentic/`, `.claude/`) — BD-024/025.
- [ ] Define the three-list command policy defaults per stage (allow / ask / block) — BD-025.
- [ ] Define significance scoring rules and default thresholds for KB proposals (Q25, BD-018).
- [ ] Define readiness criteria detection details and level thresholds for tuning after dogfooding (Q24, product/17).
- [ ] Third-party license notice file listing bundled CLIs (logcli AGPL-3.0, acli proprietary, sentry-mcp FSL) — BD-002.
- [ ] Storage gauge and purge-window setting for transcripts (Q13-b).

- [ ] Write the default role prompts as files with output JSON schemas and 3 eval examples each (Round 2, from product/13).
- [ ] Define artifact JSON schemas (Refined Spec, Plan, RCA, Review Verdict, Acceptance Verdict, Implementation Notes, Retro Report).
- [ ] Define `.agentic/config.yml` and `pipeline.yml` schemas with examples (Round 2 owns the schema; product owns the fields list in product/12).
- [ ] Jira status mapping defaults per template; decide label prefix (`agentic:*`) vs custom field (product/08).
- [ ] MR description template and commit message convention defaults (product/13 `mr-description` skill).
- [ ] Onboarding interview question bank v1 (product/06) with Czech and English versions.
- [ ] KB templates: `business/overview.md`, `business/direction.md`, `technical/overview.md`, `technical/how-to-run.md`, `technical/conventions.md`, `lessons/_template.md`, `decisions/_template.md`, `index.md`.
- [ ] Statistics definitions sheet (each metric: formula, source events) from product/16.
- [x] Probation mode accepted (Q3) and documented in product/04 / BD-006.
- [ ] Dogfooding plan: success criteria and timeline for the two projects (both Jira Cloud; one gitlab.com, one self-managed GitLab) — Q17 answered, plan pending.
- [ ] Security review of the threat model (prompt injection paths, token scopes, workspace escape) before MVP release.
- [ ] Contributor guide and code of conduct for build-in-public.

- [ ] Autonomy dial preset table with exact policy values per level (BD-027) and the readiness cap mapping.
- [ ] Wizard step 4 content: value statements, defaults and cost implications per feature (BD-028).
- [ ] Shadow mode comparison report specification (Q31).
- [ ] Default risk classes and reviewer routing rules (Q32, BD-030).
- [ ] Cost estimation model v1 (size × trailing history) and accuracy metric.
- [ ] Human time accounting: event-to-minutes derivation rules and privacy note (per-user breakdown off by default).
- [ ] Ticket readiness linter comment template (one comment, ≤ 10 lines, language auto).
- [ ] History bootstrap: what is mined (MR review comments, commit messages, closed tickets), budget cap, proposal format.
- [ ] Take-over protocol: pause semantics, resume command posting, workspace export format, hand-back to a stage.

## Later (parking lot; not for MVP)

- [ ] Auto-merge policy for `chore` once trust metrics exist (BD-007) — fits Autonomous level later.
- [ ] Shadow mode in parallel with live human tickets (v0.2).
- [ ] Organisation-level shared knowledge across projects (product/05).
- [ ] Cross-tenant control plane if hosting is ever offered (BD-009).
- [ ] Managed Agents execution backend (research/04).
- [ ] Non-token cost items (CI minutes) in cost model (product/09).
- [ ] Prompt A/B testing per project (product/13).
- [ ] Platform self-improvement channel: retros that identify a *platform* weakness open an issue in the Agentic repo (product/07).
