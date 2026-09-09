# 06 — Project onboarding

Decision: [BD-019 optional but nudged](../decisions/business/BD-019-onboarding-optional-but-nudged.md).

## Goal

Populate the project's knowledge base with the context a senior colleague would have on week six: what the product is and why, how the code is organised, how work is done here. Done once, refined forever by retrospectives.

## Flow (UI wizard, resumable, each step skippable)

### Step 1 — Connect (required)
Repository, task-management binding (Jira project + pick-up rule), Slack channel, observability bindings. The platform clones the repository and validates access.

### Step 2 — Technical discovery (automatic, ~minutes, cheap)
A **Discovery agent** (Sonnet 5, read-only, bounded budget) inspects the repository and drafts:
- `technical/overview.md`: stack, top-level layout, boundaries it can *infer* with confidence markers; explicitly *not* a file listing.
- `technical/how-to-run.md`: build/test/lint commands found in CI config, `Makefile`, `package.json`, `pyproject`, etc., each marked *verified* only if the agent actually ran it successfully in the workspace.
- `technical/conventions.md`: conventions detected (formatter, lint rules, commit style, branch naming, test layout) — and, importantly, existing `CLAUDE.md`, `.claude/rules`, `AGENTS.md`, `CONTRIBUTING.md`, ADR folders are **linked, not copied**.
- A list of **questions for engineers** it could not answer (e.g. "which module owns billing?", "is the `legacy/` folder still maintained?").
The draft is shown as a diff for the engineer to edit and accept. Nothing is committed without acceptance.

### Step 3 — Business interview (human, 15–30 minutes, optional but nudged)
A conversational form driven by the **Product Manager** role, asking in the interviewee's language:
1. What is the product and for whom? What is it *not*?
2. Who are the users/personas and what do they care about?
3. Key business rules and invariants (things that must never happen).
4. Domain glossary: words that have a specific meaning here.
5. Current direction: goals for the next months, what is out of scope, known technical debt you accept.
6. Quality bar and definition of done (tests, docs, accessibility, performance, security expectations).
7. Review expectations: who reviews, what they care about, MR size preference.
8. Communication: language for tickets/MRs, tone, what should be posted to Slack and when.
Answers become `business/*.md` pages plus glossary entries; the agent shows the generated pages for edit and acceptance. Existing documents (README, docs folder, Confluence export, PDFs pasted as text) can be imported; the agent summarises them into the KB structure and links to the originals rather than duplicating.

### Step 4 — Rules and policies
Pre-filled from steps 2–3: initial `.agentic/rules/*.md` (e.g. "run `make test` before pushing"), pipeline policies (plan approval threshold, knowledge apply policy, WIP limits, budgets, status mapping), models per stage. Sensible defaults; all editable later.

### Step 5 — Commit
One MR to the repository adding `.agentic/` with the accepted content (or a direct commit if the project allows), plus a one-line pointer in `CLAUDE.md` to the KB index (proposed). The platform builds the index.

## Completeness score

Shown on the project page until every section is either filled or explicitly marked "not applicable":
business overview, personas, business rules, glossary, direction, quality bar, technical overview, how-to-run (verified), conventions, review expectations. Each missing section explains what it unlocks (e.g. "Direction: enables drift detection in Refinement").

## Readiness

Separate from knowledge completeness, the **repository readiness level** tells the team how much autonomy the repository can support and what each missing criterion unlocks. It is computed at the end of technical discovery and shown in the wizard with the three cheapest improvements. Full definition: [17 — Repository readiness](17-repository-readiness.md).

## Ongoing onboarding

- Retrospectives propose KB updates; the Librarian keeps the structure.
- Quarterly "KB review" reminder to the project maintainer with the health report.
- When a task returns because of missing context, the retro names the missing section.

## Why not mandatory

Time-to-first-value matters for adoption; a chore ticket can be delivered on a bare repository. But the difference in quality with and without business context is exactly the story we want the statistics page to tell.
