/**
 * `judgeTamper` and `exceptionsOf` on their own — every branch of BD-024 §2's comparison (WP-81),
 * plus a property: the check can only get **stricter** as protected paths are added and **looser**
 * as declared-and-confirmed exceptions are, never the other way round. The gate's own use of them is
 * `gates.test.ts`; the loop's is `saga.test.ts`.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { StoredArtifact } from './store.js';
import {
  changedExistingPaths,
  exceptionsOf,
  judgeTamper,
  type TamperInputs,
  tamperFailureDetail,
  unconfirmedExcusedPaths,
} from './tamper.js';

const inputs = (overrides: Partial<TamperInputs> = {}): TamperInputs => ({
  changedPaths: ['src/totals.ts'],
  protectedPaths: ['tests/**', '**/*.test.*', '.github/**'],
  declared: [],
  confirmed: [],
  reviewed: false,
  ...overrides,
});

describe('changedExistingPaths (WP-81 round 1: existing files only)', () => {
  const file = (
    path: string,
    status: Partial<{
      new_file: boolean;
      renamed_file: boolean;
      deleted_file: boolean;
      old_path: string;
    }> = {},
  ) => ({
    new_path: path,
    old_path: status.old_path ?? path,
    new_file: status.new_file ?? false,
    renamed_file: status.renamed_file ?? false,
    deleted_file: status.deleted_file ?? false,
  });

  it('skips an added file, keeps a modified and a deleted one, and a rename’s old name only', () => {
    expect(
      changedExistingPaths([
        file('src/new.test.ts', { new_file: true }),
        file('src/a.test.ts'),
        file('src/gone.test.ts', { deleted_file: true }),
        file('src/moved.test.ts', { renamed_file: true, old_path: 'tests/was.test.ts' }),
      ]),
    ).toEqual(['src/a.test.ts', 'src/gone.test.ts', 'tests/was.test.ts']);
  });

  it('reads a missing or contradictory status as modified (standing rule 20)', () => {
    const missing = { new_path: 'src/a.test.ts', old_path: 'src/a.test.ts' } as never;
    expect(changedExistingPaths([missing])).toEqual(['src/a.test.ts']);
    expect(
      changedExistingPaths([file('src/b.test.ts', { new_file: true, deleted_file: true })]),
    ).toEqual(['src/b.test.ts']);
    // Two names and no rename flag: both are counted.
    expect(changedExistingPaths([file('src/c.ts', { old_path: 'tests/c.test.ts' })])).toEqual([
      'tests/c.test.ts',
      'src/c.ts',
    ]);
  });
});

describe('judgeTamper', () => {
  it('is clean when no changed path is protected', () => {
    expect(judgeTamper(inputs())).toEqual({ kind: 'clean' });
  });

  it('names an undeclared protected path, sorted and once', () => {
    expect(
      judgeTamper(
        inputs({
          changedPaths: ['src/b.test.ts', 'src/totals.ts', 'src/a.test.ts', 'src/b.test.ts'],
        }),
      ),
    ).toEqual({ kind: 'changed', undeclared: ['src/a.test.ts', 'src/b.test.ts'], unconfirmed: [] });
  });

  it('is clean when every protected path was declared and confirmed, by pattern on either side', () => {
    expect(
      judgeTamper(
        inputs({
          changedPaths: ['src/a.test.ts'],
          declared: ['src/*.test.ts'],
          confirmed: ['src/a.test.ts'],
          reviewed: true,
        }),
      ),
    ).toEqual({ kind: 'clean' });
  });

  it('waits for the review on a declared path nobody has judged yet', () => {
    expect(
      judgeTamper(inputs({ changedPaths: ['src/a.test.ts'], declared: ['src/a.test.ts'] })),
    ).toEqual({ kind: 'awaiting_review', paths: ['src/a.test.ts'] });
  });

  it('fails a declared path a review judged and did not confirm', () => {
    expect(
      judgeTamper(
        inputs({ changedPaths: ['src/a.test.ts'], declared: ['src/a.test.ts'], reviewed: true }),
      ),
    ).toEqual({ kind: 'changed', undeclared: [], unconfirmed: ['src/a.test.ts'] });
  });

  it('does not excuse a confirmation the plan never declared', () => {
    // The review cannot widen the plan: "listed … and the Code review must confirm" is both halves.
    expect(
      judgeTamper(
        inputs({ changedPaths: ['src/a.test.ts'], confirmed: ['src/a.test.ts'], reviewed: true }),
      ),
    ).toEqual({ kind: 'changed', undeclared: ['src/a.test.ts'], unconfirmed: [] });
  });

  it('reports an undeclared path and an unconfirmed one together', () => {
    expect(
      judgeTamper(
        inputs({
          changedPaths: ['src/a.test.ts', '.github/workflows/ci.yml'],
          declared: ['src/a.test.ts'],
          reviewed: true,
        }),
      ),
    ).toEqual({
      kind: 'changed',
      undeclared: ['.github/workflows/ci.yml'],
      unconfirmed: ['src/a.test.ts'],
    });
  });

  it('never gets looser as protected paths are added, nor stricter as exceptions are confirmed', () => {
    const path = fc.constantFrom(
      'src/a.test.ts',
      'src/b.ts',
      'tests/unit/x.ts',
      '.github/workflows/ci.yml',
      'docs/readme.md',
    );
    const paths = fc.uniqueArray(path, { maxLength: 5 });
    const rank = (verdict: ReturnType<typeof judgeTamper>): number =>
      verdict.kind === 'clean' ? 0 : verdict.kind === 'awaiting_review' ? 1 : 2;
    fc.assert(
      fc.property(
        paths,
        paths,
        paths,
        fc.boolean(),
        path,
        (changed, declared, confirmed, reviewed, extra) => {
          const base = inputs({ changedPaths: changed, declared, confirmed, reviewed });
          const moreProtected = { ...base, protectedPaths: [...base.protectedPaths, extra] };
          expect(rank(judgeTamper(moreProtected))).toBeGreaterThanOrEqual(rank(judgeTamper(base)));
          const moreConfirmed = { ...base, confirmed: [...confirmed, extra] };
          expect(rank(judgeTamper(moreConfirmed))).toBeLessThanOrEqual(rank(judgeTamper(base)));
        },
      ),
    );
  });
});

let seq = 0;
const stored = (type: StoredArtifact['type'], data: unknown): StoredArtifact => {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}` as Id,
    taskId: '00000000-0000-4000-8000-0000000000c1' as Id,
    type,
    version: 1,
    markdown: null,
    data: data as never,
    schemaVersion: '1',
    producedByRunId: null,
    redactionCount: 0,
    createdAt: '2026-06-01T09:00:00.000Z' as IsoDateTime,
  };
};

const plan = (declared: readonly string[]) =>
  stored('ImplementationPlan', {
    approach: 'a',
    alternatives_considered: [],
    affected_modules: [],
    files_to_change: [],
    data_changes: [],
    api_changes: [],
    validation_contract: [],
    test_plan: [],
    rollout_notes: '',
    risks: [],
    estimated_size: 'S',
    decisions_to_record: [],
    protected_path_changes: declared.map((path) => ({ path, reason: 'because' })),
  });

const notes = () =>
  stored('ImplementationNotes', {
    summary: 's',
    deviations_from_plan: [],
    tests_added: [],
    commands_run: [],
    known_gaps: [],
    followup_tickets: [],
    mr: { url: 'https://git.example.test/acme/api/-/merge_requests/7', iid: 7 },
  });

const review = (confirmed: readonly string[]) =>
  stored('ReviewVerdict', {
    verdict: 'approve',
    findings: [],
    summary: 's',
    protected_path_changes_confirmed: [...confirmed],
  });

describe('exceptionsOf', () => {
  it('reads the latest plan’s declarations and a review newer than the latest notes', () => {
    expect(
      exceptionsOf([plan(['old/**']), plan(['src/a.test.ts']), notes(), review(['src/a.test.ts'])]),
    ).toEqual({
      declared: ['src/a.test.ts'],
      confirmed: ['src/a.test.ts'],
      reviewed: true,
    });
  });

  it('does not count a review of an earlier push: its confirmation is not of this change', () => {
    expect(exceptionsOf([plan(['src/a.test.ts']), review(['src/a.test.ts']), notes()])).toEqual({
      declared: ['src/a.test.ts'],
      confirmed: [],
      reviewed: false,
    });
  });

  it('declares nothing without a plan (a chore) and confirms nothing without a review', () => {
    expect(exceptionsOf([notes()])).toEqual({ declared: [], confirmed: [], reviewed: false });
  });

  it('lets a body that does not parse contribute nothing, which is only ever stricter', () => {
    expect(
      exceptionsOf([
        stored('ImplementationPlan', { approach: 'a' }),
        notes(),
        stored('ReviewVerdict', {}),
      ]),
    ).toEqual({ declared: [], confirmed: [], reviewed: false });
  });
});

describe('unconfirmedExcusedPaths (WP-102: the rebase settlement’s half)', () => {
  const excused = ['src/totals.test.ts', 'tests/legacy.spec.ts'];

  it('confirms every excused path a newer review confirmed and the plan still declares, by pattern', () => {
    expect(
      unconfirmedExcusedPaths(excused, {
        declared: ['src/totals.test.ts', 'tests/**'],
        confirmed: ['src/*.test.ts', 'tests/legacy.spec.ts'],
        reviewed: true,
      }),
    ).toEqual([]);
  });

  it('names each path the review did not confirm, sorted and once', () => {
    expect(
      unconfirmedExcusedPaths([...excused, 'src/totals.test.ts'], {
        declared: excused,
        confirmed: ['src/totals.test.ts'],
        reviewed: true,
      }),
    ).toEqual(['tests/legacy.spec.ts']);
  });

  it('confirms nothing without a review of this change, whatever an older verdict said', () => {
    expect(
      unconfirmedExcusedPaths(excused, {
        declared: excused,
        confirmed: excused,
        reviewed: false,
      }),
    ).toEqual([...excused].sort());
  });

  it('does not count a confirmation of a path the latest plan no longer declares', () => {
    expect(
      unconfirmedExcusedPaths(excused, {
        declared: ['tests/legacy.spec.ts'],
        confirmed: excused,
        reviewed: true,
      }),
    ).toEqual(['src/totals.test.ts']);
  });

  it('has nothing to confirm when nothing was excused', () => {
    expect(unconfirmedExcusedPaths([], { declared: [], confirmed: [], reviewed: false })).toEqual(
      [],
    );
  });
});

describe('tamperFailureDetail', () => {
  it('names each path through the redactor and says which half of BD-024 it failed', () => {
    const detail = tamperFailureDetail(
      { kind: 'changed', undeclared: ['tests/secret-abc.ts'], unconfirmed: ['src/a.test.ts'] },
      (text) => text.replace('secret-abc', '[REDACTED:x]'),
    );
    expect(detail).toContain('does not declare in protected_path_changes: tests/[REDACTED:x].ts');
    expect(detail).toContain(
      'the Code review did not confirm in protected_path_changes_confirmed: src/a.test.ts',
    );
    expect(detail).not.toContain('secret-abc');
  });
});
