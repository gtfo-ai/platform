/**
 * The rebase settlement's half of the tamper check on its own (WP-102, Q109 (b)): which paths it
 * reads, through which transaction, and the return it makes. The settlement's use of it — the
 * whole walk into Ready or back to implementation — is `saga.test.ts` › "the tamper check in the CI
 * gate (WP-81)"; the fake-Claude walk is `test/e2e/pipeline/tamper-settlement.e2e.test.ts`.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { compilePipeline, SHIPPED_TEMPLATES } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { Transaction } from '../ports/transaction.js';
import type { StoredArtifact, StoredTask } from './store.js';
import { confirmExcusedPaths, unconfirmedTamperReturn } from './tamper-confirmation.js';

const TX = { marker: 'the settlement’s transaction' } as unknown as Transaction;
const TASK_ID = '00000000-0000-4000-8000-000000000102' as Id;

const stored = (ciExcusedPaths: readonly string[]): StoredTask =>
  ({
    task: { id: TASK_ID, ticket: { key: 'ACME-1' } },
    ciExcusedPaths,
  }) as unknown as StoredTask;

let artifactSeq = 0;
const artifact = (type: StoredArtifact['type'], data: unknown): StoredArtifact => {
  artifactSeq += 1;
  return {
    id: `00000000-0000-4000-8000-${artifactSeq.toString(16).padStart(12, '0')}` as Id,
    taskId: TASK_ID,
    type,
    version: 1,
    markdown: null,
    data: data as never,
    schemaVersion: '1',
    producedByRunId: null,
    redactionCount: 0,
    createdAt: '2026-09-30T10:00:00.000Z' as IsoDateTime,
  };
};

/** Whole bodies, so the contracts' parsers read them (a body that does not parse confirms nothing). */
const PLAN = artifact('ImplementationPlan', {
  approach: 'Sum the lines.',
  alternatives_considered: [],
  affected_modules: ['invoices'],
  files_to_change: [{ path: 'src/totals.ts', change: 'sum' }],
  data_changes: [],
  api_changes: [],
  validation_contract: [],
  test_plan: [],
  rollout_notes: '',
  risks: [],
  estimated_size: 'S',
  decisions_to_record: [],
  protected_path_changes: [{ path: 'src/legacy.test.ts', reason: 'the rounding it pins' }],
});
const NOTES = artifact('ImplementationNotes', {
  summary: 'Done.',
  deviations_from_plan: [],
  tests_added: [],
  commands_run: [],
  known_gaps: [],
  followup_tickets: [],
  mr: { url: 'https://git.example.test/acme/api/-/merge_requests/7', iid: 7 },
});
const REVIEW = (confirmed: readonly string[]) =>
  artifact('ReviewVerdict', {
    verdict: 'approve',
    findings: [],
    summary: 'Reviewed.',
    protected_path_changes_confirmed: [...confirmed],
  });

const storeOf = (artifacts: readonly StoredArtifact[], reads: unknown[]) =>
  ({
    artifacts: {
      listFor: async (tx: Transaction, taskId: Id) => {
        reads.push([tx, taskId]);
        return artifacts;
      },
    },
  }) as never;

describe('confirmExcusedPaths', () => {
  it('reads nothing when the CI gate excused nothing, so the settlement is unchanged', async () => {
    const reads: unknown[] = [];
    expect(await confirmExcusedPaths(storeOf([], reads), TX, stored([]))).toBeNull();
    expect(reads).toEqual([]);
  });

  it('reads the artifacts through the settlement’s own transaction, and confirms a confirmed path', async () => {
    const reads: unknown[] = [];
    const answer = await confirmExcusedPaths(
      storeOf([PLAN, NOTES, REVIEW(['src/legacy.test.ts'])], reads),
      TX,
      stored(['src/legacy.test.ts']),
    );
    expect(answer).toEqual({ kind: 'confirmed' });
    expect(reads).toEqual([[TX, TASK_ID]]);
  });

  it('names a path the latest review did not confirm', async () => {
    const answer = await confirmExcusedPaths(
      storeOf([PLAN, NOTES, REVIEW([])], []),
      TX,
      stored(['src/legacy.test.ts']),
    );
    expect(answer).toEqual({ kind: 'unconfirmed', paths: ['src/legacy.test.ts'] });
  });

  it('does not count a review of an earlier push', async () => {
    const answer = await confirmExcusedPaths(
      storeOf([PLAN, REVIEW(['src/legacy.test.ts']), NOTES], []),
      TX,
      stored(['src/legacy.test.ts']),
    );
    expect(answer).toEqual({ kind: 'unconfirmed', paths: ['src/legacy.test.ts'] });
  });
});

const FEATURE = SHIPPED_TEMPLATES.feature;
if (FEATURE === undefined) {
  throw new Error('the feature template is shipped');
}

describe('unconfirmedTamperReturn', () => {
  const feature = compilePipeline('feature', FEATURE, null, false);

  it('makes the return ci_gate would have made, from the rebase gate, on ci_fix', () => {
    const decision = unconfirmedTamperReturn(feature, stored(['src/legacy.test.ts']), [
      'src/legacy.test.ts',
    ]);
    expect(decision).toMatchObject({
      kind: 'return',
      from: 'rebase_gate',
      to: 'implementation',
      loop: 'ci_fix',
    });
    expect(decision.kind === 'return' ? decision.reason : '').toContain(
      'the Code review did not confirm in protected_path_changes_confirmed: src/legacy.test.ts',
    );
    expect(decision.kind === 'return' ? decision.escalationBrief : '').toContain('ACME-1');
  });

  it('keeps the interpreter’s escalation when ci_gate has nowhere to return to', () => {
    const noFailTo = compilePipeline(
      'feature',
      {
        ...FEATURE,
        stages: FEATURE.stages.map((stage) => {
          if (stage.id !== 'ci_gate' || stage.kind !== 'gate') {
            return stage;
          }
          const { fail_to: _dropped, ...rest } = stage;
          return rest;
        }),
      },
      null,
      false,
    );
    const decision = unconfirmedTamperReturn(noFailTo, stored(['src/legacy.test.ts']), [
      'src/legacy.test.ts',
    ]);
    expect(decision.kind).toBe('escalate');
  });
});
