/**
 * The repository-configuration table's adapter (WP-63). The SQL itself runs against PostgreSQL in
 * the integration tier (`test/integration/config/repository-config-store.integration.test.ts`);
 * here: what a stored row *means*, including a row this release did not write.
 */

import { MAX_PROJECT_PROMPT_FILES } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../events/sql.js';
import {
  createPostgresRepositoryConfigStore,
  promptReadingOfColumn,
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

describe('the prompt directory a row carries (WP-92)', () => {
  const row = (prompts: unknown) => ({
    status: 'absent',
    commit_sha: SHA,
    config: null,
    not_applied: [],
    detail: null,
    read_at: AT,
    prompts,
  });
  const stored = {
    files: {
      '.agentic/prompts/implementation.md': { kind: 'file', text: 'Use pnpm.', blobSha: 'a1' },
      '.agentic/prompts/huge.md': { kind: 'oversized', bytes: 20_000 },
      '.agentic/prompts/link.md': { kind: 'not_a_file', mode: '120000' },
    },
    truncated: false,
  };

  it('reads the shape the reader writes', () => {
    expect(snapshotOfRow(row(stored)).prompts).toEqual(stored);
  });

  it('reads null, and a row with no column, as "not read"', () => {
    expect(snapshotOfRow(row(null)).prompts).toBeUndefined();
    const { prompts: _none, ...older } = row(null);
    expect(snapshotOfRow(older).prompts).toBeUndefined();
  });

  it.each([
    ['not an object', 'x'],
    ['files not an object', { files: [], truncated: false }],
    ['no truncated flag', { files: {} }],
    [
      'an unknown entry kind',
      { files: { '.agentic/prompts/a.md': { kind: 'glob' } }, truncated: false },
    ],
    [
      'a file entry with no text',
      { files: { '.agentic/prompts/a.md': { kind: 'file', blobSha: 'x' } }, truncated: false },
    ],
    [
      'a path the reader would not list',
      { files: { 'src/secrets.md': { kind: 'file', text: 't', blobSha: 'x' } }, truncated: false },
    ],
    [
      'more entries than the reader lists',
      {
        files: Object.fromEntries(
          Array.from({ length: MAX_PROJECT_PROMPT_FILES + 1 }, (_, index) => [
            `.agentic/prompts/p${index}.md`,
            { kind: 'oversized', bytes: 1 },
          ]),
        ),
        truncated: true,
      },
    ],
  ])('reads a column with %s as "not read", never as a prompt', (_name, prompts) => {
    expect(promptReadingOfColumn(prompts)).toBeUndefined();
    expect(snapshotOfRow(row(prompts)).prompts).toBeUndefined();
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
    // WP-92: a reading that did not read the prompt directory stores `null`, never `{}`.
    expect(calls[0]?.values[7]).toBeNull();
    expect(await store.read('00000000-0000-4000-8000-0000000000aa' as Id)).toBeNull();
  });
});
