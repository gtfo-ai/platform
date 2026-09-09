# BD-013 — Default model and effort per stage

- **Status:** proposed
- **Date:** 2026-08-28
- **Relates to:** product/04 (table), research/04 (pricing)

## Decision
Defaults: Haiku 4.5/low for intake classification; Opus 5/medium for Refinement; Opus 5/high for Investigation, Architecture, Implementation and Code review; Sonnet 5/medium for Business review, Retrospective and Librarian; Sonnet 5/low for feedback intake. Fable 5.1 is an opt-in upgrade for Architecture and Code review. Every value overridable at organisation, project and repository level; every run stores what it used.

## Rationale
Verified pricing (research/04): Opus 5 at $5/$25 is 5× cheaper than Fable 5.1 while being the recommended model for complex agentic coding; Sonnet 5 at $2/$10 suits structured verification; Haiku for classification. Effort `high` where errors are expensive to undo.

## Consequences
- Re-evaluate quarterly against pricing and model releases; the price table is versioned (BD-011).
- Metrics per model/stage (return rate, cost) inform changes — product/16.
