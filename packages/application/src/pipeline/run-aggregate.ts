/**
 * **One `StoredRun` → `Run`** (WP-275a, TD-031's 2026-11-04 amendment §1) — the row as the Run
 * aggregate, at the sequence the log says its stream is at. It replaces the twins `commands.ts` and
 * `recovery/run-lease.ts` each kept, and is what `settleRun` rebuilds its aggregate with, so a run
 * settled in another process than the one that created it is the same aggregate.
 *
 * Every field the aggregate types more narrowly than the row does is **parsed**, not cast: `role`,
 * `mode` and `effort` are text columns, and a value the enum does not have would otherwise reach an
 * event payload and be rejected by the catalogue's schema at append time, which is a 500 for a
 * caller who did nothing wrong.
 *
 * It **admits a stage-less row** (an ask's, `run-lease.ts`'s reading): whether a stage-less run may
 * take a given ending is the caller's question — `settleRun` refuses one as `not_a_stage_run` and a
 * person's cancel refuses it by name, because an ask's ending is the ask's (TD-031 decision 13).
 */
import { agentRoleSchema, effortSchema, runModeSchema } from '@platform/contracts';
import type { Run } from '@platform/domain';
import type { StoredRun } from './store.js';

export const toRunAggregate = (stored: StoredRun, sequence: number): Run => ({
  id: stored.id,
  taskId: stored.taskId,
  projectId: stored.projectId,
  stage: stored.stage,
  role: agentRoleSchema.parse(stored.role),
  mode: runModeSchema.parse(stored.mode),
  attempt: stored.attempt,
  model: stored.model,
  effort: effortSchema.parse(stored.effort),
  promptVersion: stored.promptVersion,
  status: stored.status,
  startedAt: stored.startedAt,
  lastOutputAt: null,
  endedAt: null,
  terminalReason: stored.terminalReason,
  sequence,
});
