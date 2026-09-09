# BD-023 — One sticky "workpad" comment per ticket and per MR, edited in place

- **Status:** accepted (2026-08-28, Q19)
- **Date:** 2026-08-28
- **Relates to:** product/04, product/08, research/01 (Symphony workpad, Sweep progress comment, claude-code-action sticky comment)

## Context
Agents that post a new comment per event flood tickets and MRs; humans stop reading. Symphony, Sweep and Anthropic's claude-code-action all converged on a single comment updated in place.

## Decision
For every task the platform maintains **one ticket comment** ("Agentic workpad") containing: current stage and state, plan checklist, acceptance criteria with status, validation commands and results, cost so far, iteration counters, open questions, links (task page, MR, Slack thread), and a short timestamped notes log. Questions that need a human answer are additionally posted as **separate comments** (so they notify), and answered by reply. The MR has an equivalent sticky description/comment. Stage artifacts (spec, plan, verdicts) are linked from the workpad, and the full versions live on the task page.

## Rationale
One place to look; low noise; the ticket stays useful for humans who never open the platform UI.

## Consequences
- Task-management integration needs "update comment by marker" as a required action.
- Ticket description is never edited by agents.
