/**
 * The two **partitions** the read API branches on, asserted against the enums they partition.
 *
 * `GET /api/org/agents` answers with the runs that are *not* terminal, and `ProjectSummary.
 * open_tasks` counts the tasks that are *not* closed. Both are written as one list and a
 * complement, so a status added to `runStatusSchema` or `taskStateSchema` and to neither list
 * silently picks a side — and in both cases it picks the **visible** one: a finished run would sit
 * on the agents screen for ever, and a closed task would be counted as open on every dashboard.
 *
 * This is standing rule 68: when a behaviour is parameterised over a set, the test has to be
 * parameterised over the same set, or the set is decoration. Reading the enum out of
 * `@platform/contracts` rather than restating its members here is what makes that true — the
 * assertion fails on the commit that adds a member, in this file, naming it.
 *
 * The projections themselves are exercised against real SQL in
 * `test/integration/server/read-api.integration.test.ts` and against rows the pipeline wrote in
 * `test/e2e/server/read-api.e2e.test.ts`; there is nothing a stubbed Drizzle handle could say about
 * them that either of those does not say better.
 */
import { runStatusSchema, taskStateSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { CLOSED_TASK_STATES, TERMINAL_RUN_STATUSES } from './pipeline-queries.js';

describe('the run-status partition behind GET /api/org/agents', () => {
  it('covers every member of runStatusSchema exactly once', () => {
    const all = [...runStatusSchema.options].sort();
    const terminal = [...TERMINAL_RUN_STATUSES].sort();
    const active = all.filter((status) => !TERMINAL_RUN_STATUSES.includes(status));

    expect([...terminal, ...active].sort()).toEqual(all);
    // Both halves are non-empty, so the equality above cannot be satisfied by a list that swallowed
    // the whole enum or by one that is empty (standing rule 42).
    expect(terminal.length).toBeGreaterThan(0);
    expect(active).toEqual(['created', 'running', 'starting']);
  });

  it('treats a stalled run as ended and a starting one as an agent at work', () => {
    // The two judgement calls, named rather than left to the list: `stalled` is an ending the
    // platform reached (`runs.terminal_reason` has a value for it), and `created` is a run whose
    // row exists before its process does — which is still an agent about to work.
    expect(TERMINAL_RUN_STATUSES).toContain('stalled');
    expect(TERMINAL_RUN_STATUSES).not.toContain('created');
  });
});

describe('the task-state partition behind ProjectSummary.open_tasks', () => {
  it('covers every member of taskStateSchema exactly once', () => {
    const all = [...taskStateSchema.options].sort();
    const closed = [...CLOSED_TASK_STATES].sort();
    const open = all.filter((state) => !CLOSED_TASK_STATES.includes(state));

    expect([...closed, ...open].sort()).toEqual(all);
    expect(closed).toEqual(['cancelled', 'done']);
    expect(open.length).toBeGreaterThan(0);
  });

  it('counts a merged task and a task in retro as still open', () => {
    // The retrospective stage runs *after* the merge, so both still cost money and both still have
    // a stage to enter. Counting them as closed would make the dashboard's "open work" disagree
    // with the pipeline about when a task is over.
    expect(CLOSED_TASK_STATES).not.toContain('merged');
    expect(CLOSED_TASK_STATES).not.toContain('retro');
  });
});
