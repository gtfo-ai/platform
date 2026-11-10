/**
 * The CI gate's `task_stages` columns — `ci_pending_read`, `ci_ending` (backlog 1078) and
 * `ci_manual_not_run` (S-27.2, migration 0109) — over a recording `SqlExecutor`: what the adapter
 * sends and what it does with the rows PostgreSQL answers. Each write parses its value with the
 * writer's strict schema before it is sent, and each read refuses a stored value that does not
 * parse. The statements themselves run against PostgreSQL 18 in the pipeline-store contract suite
 * (`test/contract/support/pipeline-store-suite.ts`, through the integration tier).
 */
import type { Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { POSTGRES_ADAPTER, type PostgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';
import { createPostgresPipelineStore } from './postgres-pipeline-store.js';

const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;

const recording = (rows: readonly Record<string, unknown>[], rowCount = rows.length) => {
  const calls: { text: string; values: unknown[] }[] = [];
  const client: SqlExecutor = {
    query: async <R extends Record<string, unknown>>(text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows: rows as R[], rowCount };
    },
  };
  const tx: PostgresTransaction = { adapter: POSTGRES_ADAPTER, client };
  return { tx, calls };
};

// No task row is loaded here, so no template is needed to read one.
const store = () => createPostgresPipelineStore({ templates: {} });

const NOT_RUN = {
  pipeline_id: '3038234623',
  pipeline_url: 'https://gitlab.example.test/acme/api/-/pipelines/3038234623',
  pipeline_status: 'manual' as const,
  jobs: [{ name: 'sentry-release-commit', stage: 'release', url: null }],
  checked_at: '2026-11-07T09:00:00.000Z',
};

const READ = {
  pipeline_id: '3038234623',
  pipeline_url: null,
  head_sha: '1'.repeat(40),
  status: 'manual' as const,
  held_job: 'sentry-release-commit',
  held_job_url: null,
  draft: true,
  checked_at: '2026-11-07T09:00:00.000Z',
  timeout_minutes: 60,
};

describe('ci_manual_not_run (S-27.2, migration 0109)', () => {
  it('writes the parsed value on the open row, of the named attempt or of whichever is open', async () => {
    const named = recording([], 1);
    expect(
      await store().tasks.recordCiManualNotRun(
        named.tx,
        { taskId: TASK, stage: 'ci_gate', attempt: 2 },
        NOT_RUN,
      ),
    ).toBe(true);
    expect(named.calls[0]?.text).toContain("state = 'running' and exited_at is null");
    expect(named.calls[0]?.values).toEqual([TASK, 'ci_gate', 2, JSON.stringify(NOT_RUN)]);

    const open = recording([], 0);
    expect(
      await store().tasks.recordCiManualNotRun(
        open.tx,
        { taskId: TASK, stage: 'ci_gate' },
        NOT_RUN,
      ),
    ).toBe(false);
    expect(open.calls[0]?.values[2], 'no attempt: whichever is open').toBeNull();
  });

  it('refuses a value outside its schema before sending anything', async () => {
    const { tx, calls } = recording([], 1);
    await expect(
      store().tasks.recordCiManualNotRun(
        tx,
        { taskId: TASK, stage: 'ci_gate' },
        { ...NOT_RUN, pipeline_url: 'javascript:alert(1)' },
      ),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('reads the current pass’s value, null for none, and refuses one that does not parse', async () => {
    const found = recording([{ ci_manual_not_run: NOT_RUN }]);
    expect(await store().tasks.latestCiManualNotRun(found.tx, TASK, 'ci_gate')).toEqual(NOT_RUN);
    expect(found.calls[0]?.text).toContain('select max(attempt)');
    expect(found.calls[0]?.text).toContain("r.state = 'returned'");
    expect(await store().tasks.latestCiManualNotRun(recording([]).tx, TASK, 'ci_gate')).toBeNull();
    expect(
      await store().tasks.latestCiManualNotRun(
        recording([{ ci_manual_not_run: null }]).tx,
        TASK,
        'ci_gate',
      ),
    ).toBeNull();
    await expect(
      store().tasks.latestCiManualNotRun(
        recording([{ ci_manual_not_run: { ...NOT_RUN, jobs: [] } }]).tx,
        TASK,
        'ci_gate',
      ),
    ).rejects.toThrow();
  });
});

describe('ci_pending_read and ci_ending (backlog 1078)', () => {
  it('writes a pending read and an ending on the open row only, parsed', async () => {
    const read = recording([], 1);
    const entry = { taskId: TASK, stage: 'ci_gate', attempt: 1 };
    expect(await store().tasks.recordCiPendingRead(read.tx, entry, READ)).toBe(true);
    expect(read.calls[0]?.values).toEqual([TASK, 'ci_gate', 1, JSON.stringify(READ)]);
    const cleared = recording([], 1);
    expect(await store().tasks.recordCiPendingRead(cleared.tx, entry, null)).toBe(true);
    expect(cleared.calls[0]?.values[3]).toBeNull();
    const ending = recording([], 0);
    expect(await store().tasks.recordCiEnding(ending.tx, entry, 'ci_timed_out')).toBe(false);
    expect(ending.calls[0]?.text).toContain("state = 'running' and exited_at is null");
  });

  it('reads an attempt’s own read and the previous attempt’s, null for none', async () => {
    expect(
      await store().tasks.ciPendingReadOf(
        recording([{ ci_pending_read: READ }]).tx,
        TASK,
        'ci_gate',
        1,
      ),
    ).toEqual(READ);
    expect(await store().tasks.ciPendingReadOf(recording([]).tx, TASK, 'ci_gate', 1)).toBeNull();
    const previous = recording([{ ci_pending_read: READ }]);
    expect(await store().tasks.previousCiPendingRead(previous.tx, TASK, 'ci_gate', 2)).toEqual(
      READ,
    );
    expect(previous.calls[0]?.values).toEqual([TASK, 'ci_gate', 2]);
    await expect(
      store().tasks.previousCiPendingRead(
        recording([{ ci_pending_read: { ...READ, status: 'held' } }]).tx,
        TASK,
        'ci_gate',
        2,
      ),
    ).rejects.toThrow();
  });
});

describe('ci_manual_started (S-28.7, migration 0112)', () => {
  const STARTED = {
    job_id: '9071',
    pipeline_id: '907',
    name: 'build_composer',
    url: null,
    at: '2026-11-10T09:00:00.000Z',
    outcome: 'started' as const,
  };

  it('locks the open row, replaces the job’s entry, and writes the parsed array', async () => {
    const earlier = { ...STARTED, at: '2026-11-10T08:59:00.000Z' };
    const other = { ...STARTED, job_id: '9074', name: 'codeception', outcome: 'refused' as const };
    const { tx, calls } = recording([{ ci_manual_started: [earlier, other] }], 1);
    expect(
      await store().tasks.recordCiManualStarted(
        tx,
        { taskId: TASK, stage: 'ci_gate', attempt: 2 },
        STARTED,
      ),
    ).toBe(true);
    expect(calls[0]?.text).toContain('for update');
    expect(calls[0]?.text).toContain("state = 'running' and exited_at is null");
    expect(calls[1]?.text).toContain("state = 'running' and exited_at is null");
    expect(calls[1]?.values).toEqual([TASK, 'ci_gate', 2, JSON.stringify([other, STARTED])]);
  });

  it('writes nothing when the attempt has no open row', async () => {
    const { tx, calls } = recording([], 0);
    expect(
      await store().tasks.recordCiManualStarted(
        tx,
        { taskId: TASK, stage: 'ci_gate', attempt: 2 },
        STARTED,
      ),
    ).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('refuses an entry outside its schema before it writes, and a stored value that does not parse', async () => {
    const { tx, calls } = recording([{ ci_manual_started: null }], 1);
    await expect(
      store().tasks.recordCiManualStarted(
        tx,
        { taskId: TASK, stage: 'ci_gate', attempt: 2 },
        { ...STARTED, job_id: 'build_composer' },
      ),
    ).rejects.toThrow();
    // Only the locking read was sent (`… for update`); no `update` statement.
    expect(calls.filter((call) => call.text.trimStart().startsWith('update'))).toEqual([]);
    expect(calls).toHaveLength(1);
    const corrupt = recording([{ ci_manual_started: [{ ...STARTED, extra: true }] }]);
    await expect(store().tasks.ciManualStartedOf(corrupt.tx, TASK, 'ci_gate', 2)).rejects.toThrow();
    const none = recording([{ ci_manual_started: null }]);
    expect(await store().tasks.ciManualStartedOf(none.tx, TASK, 'ci_gate', 2)).toBeNull();
  });
});
