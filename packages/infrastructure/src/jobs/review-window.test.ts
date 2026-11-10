/**
 * S-28.15 (TD-038 decision 3): "a human-return window is open" is an `mr.comment.debounce` job with
 * the singleton key `mr:<iid>` created, retrying or active — read from pg-boss's own table, with the
 * schema name held to a bare identifier before it is interpolated.
 */
import { JOB_QUEUES } from '@platform/application';
import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../events/sql.js';
import { createPostgresReviewWindowProbe } from './review-window.js';

const recording = (rows: readonly unknown[]) => {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const sql = {
    query: async (text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values });
      return { rows, rowCount: rows.length };
    },
  } as unknown as SqlExecutor;
  return { sql, calls };
};

describe('the review-window probe (S-28.15)', () => {
  it('asks pg-boss for a live window job of this merge request, and answers open when one is', async () => {
    const { sql, calls } = recording([{ '?column?': 1 }]);
    const probe = createPostgresReviewWindowProbe({ sql, jobsSchema: 'pgboss' });
    expect(await probe.reviewWindowOpen(7)).toBe(true);
    expect(calls[0]?.text).toContain('from pgboss.job');
    expect(calls[0]?.text).toContain("state in ('created', 'retry', 'active')");
    expect(calls[0]?.values).toEqual([JOB_QUEUES.mrCommentDebounce, 'mr:7']);
  });

  it('answers closed when no such job is queued or running', async () => {
    const { sql } = recording([]);
    const probe = createPostgresReviewWindowProbe({ sql, jobsSchema: 'pgboss' });
    expect(await probe.reviewWindowOpen(7)).toBe(false);
  });

  it('refuses a schema name that is not a bare identifier', () => {
    const { sql } = recording([]);
    expect(() =>
      createPostgresReviewWindowProbe({ sql, jobsSchema: 'pgboss; drop table job' }),
    ).toThrow(/invalid pg-boss schema/);
  });
});
