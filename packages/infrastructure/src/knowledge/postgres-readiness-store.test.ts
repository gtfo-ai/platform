/**
 * The readiness store's **read**, against a scripted executor (WP-21).
 *
 * The write is asserted where a write can be: the shared contract suite, run against the in-memory
 * double in the contract tier and against a real PostgreSQL 18 in the integration tier. What is
 * here is the half a database cannot usefully exercise — `toCriteria`, the defensive parse of a
 * `jsonb` column.
 *
 * It matters because the column is **not** the port's shape: it is snake_case JSON written by this
 * adapter, and a row may have been written by an older build or (in a self-hosted deployment) by an
 * operator with `psql`. A read that trusted it would hand `readinessResponseSchema.parse` a
 * criterion with a missing field and answer 500 for a project whose evaluation is otherwise fine;
 * one that coerced it would publish an invented `passed`. It drops what it cannot read and keeps
 * the rest, and every one of those shapes is a case below.
 */
import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../events/sql.js';
import { PostgresReadinessStore } from './postgres-readiness-store.js';

const PROJECT = '00000000-0000-4000-8000-0000000000c1';

const scripted = (rows: readonly Record<string, unknown>[]): SqlExecutor =>
  ({ query: async () => ({ rows, rowCount: rows.length }) }) as unknown as SqlExecutor;

const row = (criteria: unknown) => ({
  id: '00000000-0000-4000-8000-0000000000c2',
  project_id: PROJECT,
  level: 2,
  criteria,
  evaluated_at: new Date('2026-09-13T04:00:00.000Z'),
  source: 'discovery',
});

const criterion = (overrides: Record<string, unknown> = {}) => ({
  id: 'R1',
  passed: true,
  evidence: 'ran the suite',
  unlocks: 'Implementation self-check',
  detected_by: 'agent',
  ...overrides,
});

describe('PostgresReadinessStore.latest', () => {
  it('answers null when the project has no evaluation', async () => {
    expect(await new PostgresReadinessStore(scripted([])).latest(PROJECT as never)).toBeNull();
  });

  it('maps a stored row onto the port’s camelCase shape', async () => {
    const store = new PostgresReadinessStore(scripted([row([criterion()])]));
    const evaluation = await store.latest(PROJECT as never);
    expect(evaluation?.level).toBe(2);
    expect(evaluation?.source).toBe('discovery');
    expect(evaluation?.evaluatedAt).toBe('2026-09-13T04:00:00.000Z');
    expect(evaluation?.criteria).toEqual([
      {
        id: 'R1',
        passed: true,
        evidence: 'ran the suite',
        unlocks: 'Implementation self-check',
        detectedBy: 'agent',
      },
    ]);
  });

  it('reads a platform-detected criterion as such', async () => {
    // Both values of the enum (rule 68: the field is what says whether a model's word was taken).
    const store = new PostgresReadinessStore(
      scripted([row([criterion({ id: 'R9', detected_by: 'platform' })])]),
    );
    expect((await store.latest(PROJECT as never))?.criteria[0]?.detectedBy).toBe('platform');
  });

  it('drops a criterion it cannot read rather than coercing or crashing', async () => {
    // Each entry is one way a row can be wrong; the good one at the end is what proves the parse
    // kept going rather than giving up on the first bad entry (standing rule 10).
    const store = new PostgresReadinessStore(
      scripted([
        row([
          null,
          'a string',
          42,
          criterion({ id: 7 }),
          criterion({ passed: 'yes' }),
          criterion({ evidence: 12 }),
          criterion({ unlocks: null }),
          criterion({ detected_by: 'guessed' }),
          criterion({ detected_by: undefined }),
          criterion({ id: 'R3' }),
        ]),
      ]),
    );
    expect((await store.latest(PROJECT as never))?.criteria.map((entry) => entry.id)).toEqual([
      'R3',
    ]);
  });

  it('reads a criteria column that is not an array as no criteria at all', async () => {
    for (const value of [null, {}, 'nonsense', 3]) {
      const store = new PostgresReadinessStore(scripted([row(value)]));
      expect((await store.latest(PROJECT as never))?.criteria, JSON.stringify(value)).toEqual([]);
    }
  });
});
