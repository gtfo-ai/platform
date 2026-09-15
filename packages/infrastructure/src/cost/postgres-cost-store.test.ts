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
    const usd = await store.pendingSpend(
      recording(calls, [{ usd: '4.500000' }]),
      { scope: 'project', scopeId: SCOPE },
      SINCE,
      2,
    );
    expect(usd).toBe(4.5);
    expect(calls[0]?.text).toContain('r.project_id = $4');
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
    expect(
      await store.pendingSpend(recording(calls), { scope: 'run', scopeId: SCOPE }, SINCE, 2),
    ).toBe(0);
    expect(
      await store.pendingSpend(recording(calls), { scope: 'project', scopeId: null }, SINCE, 2),
    ).toBe(0);
    expect(calls).toEqual([]);
  });

  it('answers zero when the sum comes back empty, rather than NaN', async () => {
    // `NaN` compares false against every cap, so a cap fed one silently stops stopping anything
    // (standing rule 16).
    const calls: Call[] = [];
    expect(
      await store.pendingSpend(recording(calls), { scope: 'project', scopeId: SCOPE }, SINCE, 2),
    ).toBe(0);
  });
});
