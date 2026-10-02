/**
 * The merge-request poll store's WP-123 statements, over a recording `SqlExecutor` — what the
 * adapter does with the rows PostgreSQL answers: the head read back as text or `null`, the write's
 * parameters, and a waiting task whose `mr_ref` is not a merge-request ref left out rather than
 * thrown on (rule 20). The statements themselves are run against PostgreSQL 18 in
 * `test/integration/pipeline/mr-poll.integration.test.ts` › "a poll-only binding’s rows (WP-123,
 * migration 0074)".
 */
import type { Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../events/sql.js';
import { createPostgresMergeRequestPollStore } from './postgres-ticket-poll.js';

const BINDING = {
  projectId: '00000000-0000-4000-8000-0000000000b1' as Id,
  integrationId: '00000000-0000-4000-8000-0000000000a1' as Id,
};

const recording = (rows: readonly Record<string, unknown>[]) => {
  const calls: { text: string; values: unknown[] }[] = [];
  const sql: SqlExecutor = {
    query: async <R extends Record<string, unknown>>(text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows: rows as R[], rowCount: rows.length };
    },
  };
  return { sql, calls };
};

describe('the poll-only binding’s statements (WP-123)', () => {
  it('reads the last-seen head, or null for a binding that has none or does not exist', async () => {
    const known = recording([{ head: '1'.repeat(40) }]);
    expect(
      await createPostgresMergeRequestPollStore({ sql: known.sql }).defaultHeadOf(BINDING),
    ).toBe('1'.repeat(40));
    expect(known.calls[0]?.values).toEqual([BINDING.projectId, BINDING.integrationId]);
    expect(known.calls[0]?.text).toContain('mr_poll_default_head');

    const none = recording([{ head: null }]);
    expect(
      await createPostgresMergeRequestPollStore({ sql: none.sql }).defaultHeadOf(BINDING),
    ).toBeNull();
    const gone = recording([]);
    expect(
      await createPostgresMergeRequestPollStore({ sql: gone.sql }).defaultHeadOf(BINDING),
    ).toBeNull();
  });

  it('writes the head on the binding’s own row', async () => {
    const { sql, calls } = recording([]);
    await createPostgresMergeRequestPollStore({ sql }).recordDefaultHead(BINDING, '2'.repeat(40));
    expect(calls[0]?.text).toMatch(/update bindings set mr_poll_default_head = \$3/);
    expect(calls[0]?.values).toEqual([BINDING.projectId, BINDING.integrationId, '2'.repeat(40)]);
  });

  it('maps the waiting tasks, and leaves out a row whose mr_ref is not a merge-request ref', async () => {
    const { sql, calls } = recording([
      {
        task_id: '00000000-0000-4000-8000-0000000000c1',
        mr_ref: { iid: 7, url: 'https://git.example.test/acme/api/-/merge_requests/7' },
        entered_at: '2026-06-01T09:00:00.123456Z',
      },
      {
        task_id: '00000000-0000-4000-8000-0000000000c2',
        mr_ref: { iid: 'seven' },
        entered_at: '2026-06-01T09:30:00.000000Z',
      },
    ]);

    const ready = await createPostgresMergeRequestPollStore({ sql }).readyMergeRequests(
      BINDING,
      21,
    );

    expect(ready).toEqual([
      {
        taskId: '00000000-0000-4000-8000-0000000000c1',
        mr: { iid: 7, url: 'https://git.example.test/acme/api/-/merge_requests/7' },
        enteredAt: '2026-06-01T09:00:00.123456Z',
      },
    ]);
    expect(calls[0]?.values).toEqual([BINDING.projectId, 21]);
    expect(calls[0]?.text).toContain("t.state = 'ready_for_merge'");
  });
});
