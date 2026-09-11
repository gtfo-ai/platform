/**
 * `@platform/domain` — aggregates, value objects, domain events, state machines and policies.
 *
 * The innermost ring of technical/01: **no I/O**, and the only workspace package it may import is
 * `@platform/contracts` (enforced by `lint/style/noRestrictedImports` in `biome.json`).
 *
 * Determinism is a design constraint, not an accident. Nothing here reads a clock, generates a
 * random id or touches a file: time arrives as a `Clock` and ids as an `IdSource`, both on the
 * `CommandContext`. That is what lets the state machines be checked with model-based property
 * tests rather than examples.
 *
 * Every aggregate is an immutable record; every command is a pure function
 * `(aggregate, input, context) → { aggregate, events }`. Events are built from the catalogue
 * schemas in `@platform/contracts` and parsed on the way out, so a payload that drifts from
 * technical/02 fails here rather than at the database.
 */

// Aggregates
export * from './aggregates/approval.js';
export * from './aggregates/budget.js';
export * from './aggregates/question.js';
export * from './aggregates/run.js';
export * from './aggregates/task.js';
export * from './aggregates/task-state-machine.js';
// Foundations
export * from './clock.js';
// Configuration
export * from './config/effective-config.js';
export * from './errors.js';
export * from './events.js';
export * from './ids.js';
export * from './permissions.js';
// The pipeline interpreter (WP-15)
export * from './pipeline/interpreter.js';
export * from './pipeline/templates.js';
// Policies
export * from './policies/autonomy.js';
export * from './policies/budgets.js';
export * from './policies/command-policy.js';
export * from './policies/iteration-limits.js';
export * from './policies/wip.js';

export const packageId = '@platform/domain' as const;
