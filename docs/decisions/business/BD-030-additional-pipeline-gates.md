# BD-030 — Rebase gate, dependency/epic awareness, reviewer routing with risk classes, dependency policy, coverage delta

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** product/04, product/18, BD-005, BD-024

## Decision
Add to the default pipeline: a **rebase gate** before Ready (and whenever the default branch moves) with bounded conflict resolution and CI re-run, plus conflict warnings between concurrent tasks; **dependency and epic awareness** at Intake and Refinement (skip blocked tickets, epic context); **reviewer routing** from CODEOWNERS/config and **risk classes** from touched paths that can force approval, a named reviewer or a stricter checklist; a **dependency policy** (`ask` by default) when a third-party dependency is added, with license and maintenance status in Checks; **coverage delta** in Checks when CI reports coverage. All defaults on, all configurable per project.

## Rationale
These are the real-life gaps of parallel agent work: main moves, tickets depend on each other, some areas need specific eyes, new dependencies carry risk, and "tests added" should be a number.

## Consequences
- Git provider contract gains: read CODEOWNERS, rebase/push with conflict detection, coverage from CI artifacts (Round 2).
- Task-management contract gains: issue links and epic parent.
