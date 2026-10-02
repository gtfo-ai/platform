/**
 * `pendingSpend`'s **scope mapping**, against a scripted executor.
 *
 * The rest of `PostgresCostStore` is asserted where its assertions belong — the contract suite in
 * `test/contract/cost-store.contract.test.ts` and the real database in
 * `test/integration/cost/postgres-cost-store.integration.test.ts`, which is also where the
 * *derivation* this method performs is measured. What is here is the half a database cannot show
 * cheaply: **which** `where` fragment and **which** parameters a budget's scope produces, including
 * the two scopes that must produce no query at all.
 *
 * It matters because the fragments differ in a way a passing integration case would not reveal: the
 * organisation scope's `scope_id` is **null** by migration 0007's design (*"exactly one subject"*),
 * so its fragment is `true` and its parameter list is one shorter — and a `$4` left in the SQL with
 * no fourth value is a *"bind message supplies 3 parameters, but prepared statement requires 4"* at
 * runtime, on the admission path of every run in a deployment that has an org budget.
 */
import type { Transaction } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../events/sql.js';
import { createPostgresCostStore } from './postgres-cost-store.js';

const SCOPE = '00000000-0000-4000-8000-0000000000a1' as Id;
const SINCE = '2026-09-01T00:00:00.000Z' as IsoDateTime;

interface Call {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** A transaction whose client records every query and answers one scripted row. */
const recording = (calls: Call[], rows: readonly Record<string, unknown>[] = []): Transaction =>
  ({
    adapter: 'postgres',
    client: {
      query: async (text: string, values: readonly unknown[] = []) => {
        calls.push({ text, values });
        return { rows, rowCount: rows.length };
      },
    } as unknown as SqlExecutor,
  }) as unknown as Transaction;

describe('PostgresCostStore.pendingSpend', () => {
  const store = createPostgresCostStore();

  it('scopes a project budget to the project, and carries the reservation and the live statuses', async () => {
    const calls: Call[] = [];
    const committed = await store.pendingSpend(
      recording(calls, [{ pending_usd: '4.500000', held_usd: '15.000000', held_runs: 1 }]),
      { scope: 'project', scopeId: SCOPE },
      SINCE,
      2,
    );
    expect(committed).toEqual({ pendingUsd: 4.5, heldUsd: 15, heldRuns: 1 });
    expect(calls[0]?.text).toContain('r.project_id = $4');
    // WP-131: the hold is asked in the same read, at the run's own reservation and — for a row that
    // recorded none — at the reservation this caller passed as `$3`. The semantic half (which runs,
    // which window) is `test/integration/cost/postgres-cost-store.integration.test.ts`'s.
    expect(calls[0]?.text).toContain('coalesce(r.reserve_usd, $3::numeric)');
    expect(calls[0]?.text).toContain('r.usd_reported is null and r.usd_estimated is null');
    expect(calls[0]?.values).toEqual([SINCE, ['created', 'starting', 'running'], 2, SCOPE]);
  });

  it('scopes an organisation budget to every run, because its scope_id is null', async () => {
    const calls: Call[] = [];
    await store.pendingSpend(recording(calls), { scope: 'org', scopeId: null }, SINCE, 2);
    // Three values, not four: the fragment names no column, so a `$4` would be a bind error on
    // every admission in a deployment with an organisation budget.
    expect(calls[0]?.values).toHaveLength(3);
    expect(calls[0]?.text).not.toContain('$4');
  });

  it('scopes a task budget to the task', async () => {
    const calls: Call[] = [];
    await store.pendingSpend(recording(calls), { scope: 'task', scopeId: SCOPE }, SINCE, 2);
    expect(calls[0]?.text).toContain('r.task_id = $4');
  });

  /**
   * The two shapes that are **not** a set of runs in a window, and the empty answer.
   *
   * A `run` budget is one run rather than a scope over them, and a `project`/`task` row with no
   * `scope_id` is malformed. Both answer zero *without querying*, which is asserted by counting the
   * calls: a version that fell through to `where undefined` would still return a number.
   */
  it('asks nothing for a run-scoped budget or a scope row with no id', async () => {
    const calls: Call[] = [];
    const nothing = { pendingUsd: 0, heldUsd: 0, heldRuns: 0 };
    expect(
      await store.pendingSpend(recording(calls), { scope: 'run', scopeId: SCOPE }, SINCE, 2),
    ).toEqual(nothing);
    expect(
      await store.pendingSpend(recording(calls), { scope: 'project', scopeId: null }, SINCE, 2),
    ).toEqual(nothing);
    expect(calls).toEqual([]);
  });

  it('answers zero when the sum comes back empty, rather than NaN', async () => {
    // `NaN` compares false against every cap, so a cap fed one silently stops stopping anything
    // (standing rule 16).
    const calls: Call[] = [];
    expect(
      await store.pendingSpend(recording(calls), { scope: 'project', scopeId: SCOPE }, SINCE, 2),
    ).toEqual({ pendingUsd: 0, heldUsd: 0, heldRuns: 0 });
  });
});
