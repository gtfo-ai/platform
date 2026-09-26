/**
 * The repository-configuration table's adapter (WP-63). The SQL itself runs against PostgreSQL in
 * the integration tier (`test/integration/config/repository-config-store.integration.test.ts`);
 * here: what a stored row *means*, including a row this release did not write.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../events/sql.js';
import {
  createPostgresRepositoryConfigStore,
  snapshotOfRow,
} from './postgres-repository-config-store.js';

const SHA = 'f'.repeat(40);
const AT = new Date('2026-09-26T10:00:00.000Z');

describe('snapshotOfRow', () => {
  it('reads the three statuses a writer produces', () => {
    expect(
      snapshotOfRow({
        status: 'absent',
        commit_sha: SHA,
        config: null,
        not_applied: [],
        detail: null,
        read_at: AT,
      }),
    ).toEqual({ status: 'absent', commitSha: SHA, readAt: AT.toISOString() });
    expect(
      snapshotOfRow({
        status: 'valid',
        commit_sha: SHA,
        config: { stages: {} },
        not_applied: [{ key: 'policies.autonomy', reason: 'r' }],
        detail: null,
        read_at: AT,
      }),
    ).toMatchObject({
      status: 'valid',
      values: { stages: {} },
      notApplied: [{ key: 'policies.autonomy' }],
    });
    expect(
      snapshotOfRow({
        status: 'invalid',
        commit_sha: SHA,
        config: null,
        not_applied: [],
        detail: 'version (expected 1)',
        read_at: AT,
      }),
    ).toMatchObject({ status: 'invalid', detail: 'version (expected 1)' });
  });

  it('reads a valid row whose values are not an object as a refusal, never as an empty layer', () => {
    for (const config of [null, [1], 'x']) {
      const snapshot = snapshotOfRow({
        status: 'valid',
        commit_sha: SHA,
        config,
        not_applied: [],
        detail: null,
        read_at: AT,
      });
      expect(snapshot.status, JSON.stringify(config)).toBe('invalid');
    }
  });
});

describe('createPostgresRepositoryConfigStore', () => {
  it('replaces the project’s row, writing values only for a valid reading', async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const sql: SqlExecutor = {
      query: async (text, values = []) => {
        calls.push({ text, values });
        return { rows: [], rowCount: 1 };
      },
    };
    const store = createPostgresRepositoryConfigStore(sql);
    await store.record('00000000-0000-4000-8000-0000000000aa' as Id, {
      status: 'invalid',
      commitSha: SHA,
      readAt: AT.toISOString() as IsoDateTime,
      detail: 'version (expected 1)',
    });
    expect(calls[0]?.text).toMatch(/on conflict \(project_id\) do update/);
    expect(calls[0]?.values.slice(1, 6)).toEqual([
      'invalid',
      SHA,
      null,
      '[]',
      'version (expected 1)',
    ]);
    expect(await store.read('00000000-0000-4000-8000-0000000000aa' as Id)).toBeNull();
  });
});
