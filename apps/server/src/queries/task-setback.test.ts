/**
 * The task read's `returns` and `stop` (S-25.11), projected off `task_stages` rows of the shapes the
 * pipeline writes — `transitions.ts`' return (`returned`, `returned_to`, `return_reason`),
 * `jobs.ts`' `ciConvergence` (the CI `signature` on the attempt it settles), and the escalations
 * that close the parked row (`converged`, `undecided`, with the escalation's reason). Every fact is
 * asserted from both sides: it is published when the row holds it, and `null` (or absent) when not.
 */
import { MAX_TASK_STOP_RECORDED_CHARS } from '@platform/contracts';
import { compilePipeline, SHIPPED_TEMPLATES } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { ciFailureOf, returnsOf, type SetbackStageRow, stopOf } from './task-setback.js';

const FEATURE = SHIPPED_TEMPLATES.feature;
if (FEATURE === undefined) {
  throw new Error('the feature template is shipped');
}
const PIPELINE = compilePipeline('feature', FEATURE, null, false);

const row = (over: Partial<SetbackStageRow> & Pick<SetbackStageRow, 'stage'>): SetbackStageRow => ({
  attempt: 1,
  state: 'completed',
  outcome: null,
  exitedAt: '2026-11-07T10:00:00.000Z',
  returnedTo: null,
  returnReason: null,
  signature: null,
  ...over,
});

/** The CI gate's failed settlement, as `applyDecision`'s return case leaves its row. */
const ciReturned = (attempt: number, at: string, signature: string | null): SetbackStageRow =>
  row({
    stage: 'ci_gate',
    attempt,
    state: 'returned',
    outcome: 'returned',
    exitedAt: at,
    returnedTo: 'implementation',
    returnReason: 'pipeline 41 failed: unit\nLog of the failing job unit, redacted:\n…',
    signature,
  });

describe('ciFailureOf', () => {
  it('reads the status and the jobs as the signature joined them', () => {
    expect(ciFailureOf('ci:failed:lint,unit@0123abcd')).toEqual({
      status: 'failed',
      jobs: 'lint,unit',
    });
    expect(ciFailureOf('ci:canceled:@0123abcd')).toEqual({ status: 'canceled', jobs: '' });
    // A signature written before WP-60's round 3 has no head.
    expect(ciFailureOf('ci:skipped:unit')).toEqual({ status: 'skipped', jobs: 'unit' });
    // A job name holding `@` keeps everything before the last one.
    expect(ciFailureOf('ci:failed:deploy@eu@0123abcd')).toEqual({
      status: 'failed',
      jobs: 'deploy@eu',
    });
  });

  it('is not a CI failure for anything else the column carries', () => {
    expect(ciFailureOf(null)).toBeNull();
    // The review's convergence signature (`saga.ts`) shares the column.
    expect(ciFailureOf('review:3f2a')).toBeNull();
    expect(ciFailureOf('ci:success:@0123abcd')).toBeNull();
    expect(ciFailureOf('ci:failed')).toBeNull();
  });
});

describe('returnsOf', () => {
  it('publishes each return oldest first, with its target, who acts and the CI failure', () => {
    const rows = [
      row({ stage: 'implementation', attempt: 1, exitedAt: '2026-11-07T09:00:00.000Z' }),
      ciReturned(2, '2026-11-07T10:00:00.000Z', 'ci:failed:unit@bbbb'),
      ciReturned(1, '2026-11-07T09:30:00.000Z', 'ci:failed:lint@aaaa'),
      row({ stage: 'implementation', attempt: 2, state: 'running', exitedAt: null }),
    ];
    const returns = returnsOf(rows, PIPELINE);
    expect(returns.map((entry) => entry.attempt)).toEqual([1, 2]);
    expect(returns[1]).toEqual({
      from_stage: 'ci_gate',
      attempt: 2,
      to_stage: 'implementation',
      to_role: 'developer',
      at: '2026-11-07T10:00:00.000Z',
      outcome: 'returned',
      reason_recorded: true,
      ci_failure: { status: 'failed', jobs: 'unit' },
      loop: 'ci_fix',
    });
  });

  it('reads a CI-red return by its signature, whichever word its tamper check closed the row with', () => {
    // What production writes on a red pipeline's return (gates.ts' settlement, WP-105): the tamper
    // check's word, `protected_paths_clean` — not `returned`. The CI failure rests on the signature.
    const clean = {
      ...ciReturned(3, '2026-11-07T11:00:00.000Z', 'ci:failed:unit@cccc'),
      outcome: 'protected_paths_clean' as const,
    };
    const [entry] = returnsOf([clean], PIPELINE);
    expect(entry?.outcome).toBe('protected_paths_clean');
    expect(entry?.ci_failure).toEqual({ status: 'failed', jobs: 'unit' });
    expect(entry?.loop).toBe('ci_fix');
    expect(stopOf({ state: 'needs_human', currentStage: 'ci_gate' }, [clean])?.cause).toBe(
      'tries_spent',
    );
  });

  it('claims no loop, and no CI failure, where the row does not prove them', () => {
    // A code review's return: the loop is not on the row (a person's return spends another).
    const review = row({
      stage: 'code_review',
      state: 'returned',
      outcome: 'returned',
      returnedTo: 'implementation',
      returnReason: 'findings',
    });
    // The dependency gate returns from wherever the task is, with no CI signature on the row.
    const dependency = ciReturned(3, '2026-11-07T11:00:00.000Z', null);
    const [first, second] = returnsOf([review, dependency], PIPELINE);
    expect(first?.loop).toBeNull();
    expect(first?.ci_failure).toBeNull();
    expect(second?.loop).toBeNull();
    expect(second?.ci_failure).toBeNull();
    // The review signature never reads as a CI failure, even on a CI row.
    const odd = returnsOf([ciReturned(4, '2026-11-07T12:00:00.000Z', 'review:3f2a')], PIPELINE);
    expect(odd[0]?.ci_failure).toBeNull();
  });

  it('says not recorded for a missing reason, target or role', () => {
    const bare = row({
      stage: 'ci_gate',
      state: 'returned',
      outcome: 'returned',
      returnedTo: null,
      returnReason: '',
      signature: 'ci:failed:unit@aaaa',
    });
    const [entry] = returnsOf([bare], null);
    expect(entry?.to_stage).toBeNull();
    expect(entry?.reason_recorded).toBe(false);
    expect(entry?.to_role).toBeNull();
    expect(entry?.loop).toBeNull();
    // A target that is not an agent stage has no role.
    const toGate = returnsOf([{ ...bare, returnedTo: 'rebase_gate' }], PIPELINE);
    expect(toGate[0]?.to_role).toBeNull();
  });

  it('publishes no return for a row that did not go back', () => {
    expect(
      returnsOf([row({ stage: 'ci_gate', state: 'failed', outcome: 'converged' })], PIPELINE),
    ).toEqual([]);
  });
});

describe('stopOf', () => {
  const parked = { state: 'needs_human', currentStage: 'ci_gate' } as const;

  it('reads the rounds used up off a returned row the task did not leave', () => {
    const rows = [
      ciReturned(1, '2026-11-07T09:00:00.000Z', 'ci:failed:unit@aaaa'),
      ciReturned(4, '2026-11-07T12:00:00.000Z', 'ci:failed:unit@dddd'),
    ];
    expect(stopOf(parked, rows)).toEqual({
      stage: 'ci_gate',
      attempt: 4,
      cause: 'tries_spent',
      loop: 'ci_fix',
      ci_failure: { status: 'failed', jobs: 'unit' },
      recorded: null,
      recorded_cut: false,
    });
  });

  it('reads the same failure again off a converged row', () => {
    const rows = [
      row({
        stage: 'ci_gate',
        attempt: 3,
        state: 'failed',
        outcome: 'converged',
        returnReason: 'the same CI failure three times in a row',
        signature: 'ci:failed:unit@cccc',
      }),
    ];
    expect(stopOf(parked, rows)?.cause).toBe('same_failure');
    expect(stopOf(parked, rows)?.ci_failure).toEqual({ status: 'failed', jobs: 'unit' });
  });

  it('reads a check with no answer off an undecided row, with the sentence it recorded', () => {
    const recorded =
      'the CI gate on a poll-only gitlab binding timed out: the merge request was still manual (pipeline 41) after 60 minutes';
    const rows = [
      row({ stage: 'ci_gate', state: 'failed', outcome: 'undecided', returnReason: recorded }),
    ];
    expect(stopOf(parked, rows)).toEqual({
      stage: 'ci_gate',
      attempt: 1,
      cause: 'no_answer',
      loop: null,
      ci_failure: null,
      recorded,
      recorded_cut: false,
    });
  });

  it('cuts a long recorded sentence at the cap, and says so', () => {
    const long = 'x'.repeat(MAX_TASK_STOP_RECORDED_CHARS + 1);
    const at = stopOf(parked, [
      row({ stage: 'ci_gate', state: 'failed', outcome: 'undecided', returnReason: long }),
    ]);
    expect(at?.recorded?.length).toBe(MAX_TASK_STOP_RECORDED_CHARS);
    expect(at?.recorded_cut).toBe(true);
    const exact = stopOf(parked, [
      row({
        stage: 'ci_gate',
        state: 'failed',
        outcome: 'undecided',
        returnReason: long.slice(1),
      }),
    ]);
    expect(exact?.recorded_cut).toBe(false);
    const none = stopOf(parked, [
      row({ stage: 'ci_gate', state: 'failed', outcome: 'undecided', returnReason: null }),
    ]);
    expect(none?.recorded).toBeNull();
  });

  it('is null for a task not waiting for a person, and for an ending it cannot word', () => {
    const rows = [ciReturned(4, '2026-11-07T12:00:00.000Z', 'ci:failed:unit@dddd')];
    expect(stopOf({ state: 'active', currentStage: 'ci_gate' }, rows)).toBeNull();
    expect(stopOf({ state: 'needs_human', currentStage: null }, rows)).toBeNull();
    expect(
      stopOf(parked, [row({ stage: 'ci_gate', state: 'failed', outcome: 'unsupported' })]),
    ).toBeNull();
    // Only the latest attempt counts: an older returned row under a newer escalated one.
    expect(
      stopOf(parked, [
        ...rows,
        row({ stage: 'ci_gate', attempt: 5, state: 'failed', outcome: 'escalated' }),
      ]),
    ).toBeNull();
  });
});
