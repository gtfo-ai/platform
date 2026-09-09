# BD-011 — Cost accounting: provider-reported cost is truth, price table for estimates

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/04

## Context
The SDK result message reports `total_cost_usd`, token counts including cache read/write, and per-model usage (research/04). In `local`/subscription mode there is no invoice cost.

## Decision
Store provider-reported cost and token counts per run as the source of truth. Maintain a versioned price table (model → USD per MTok input/output/cache-write/cache-read, effective date) to compute live estimates during streaming and to compute "API-equivalent" cost in `local` mode, always labelled *estimated*. Budgets use actual cost when available, estimated otherwise.

## Consequences
- Price table must be maintained (TODO: verify cache multipliers per model — research/04 lists differing cache-read multipliers).
- Statistics distinguish actual vs estimated.
