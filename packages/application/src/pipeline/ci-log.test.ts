/**
 * The failing jobs' logs, read → redacted → bounded (WP-81, BD-024 §5; every failing job since
 * PROGRESS backlog 485). The gate-level assertions — the token straddling the bound, the labels,
 * the marker's length — are `gates.test.ts`; these are the pieces.
 */
import { MAX_FEEDBACK_CHARS } from '@platform/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  boundLog,
  CI_LOG_BUDGET_CHARS,
  CI_LOG_HEAD_CHARS,
  CI_LOG_MIN_SHARE_CHARS,
  CI_LOG_TAIL_CHARS,
  type FailingJobRef,
  failingJobs,
  MAX_CI_LOG_JOBS,
  selectLogJobs,
  splitLogBudget,
} from './ci-log.js';

describe('boundLog', () => {
  it('keeps a log that fits whole and reports no cut', () => {
    const log = 'a'.repeat(CI_LOG_BUDGET_CHARS);
    expect(boundLog(log)).toEqual({ text: log, originalChars: null });
  });

  it('keeps the head and the tail of a longer one at the whole budget, as WP-81 did', () => {
    const log = `${'h'.repeat(CI_LOG_HEAD_CHARS)}${'m'.repeat(10)}${'t'.repeat(CI_LOG_TAIL_CHARS)}`;
    const bounded = boundLog(log);
    expect(bounded.originalChars).toBe(log.length);
    expect(bounded.text).toBe(`${'h'.repeat(CI_LOG_HEAD_CHARS)}\n${'t'.repeat(CI_LOG_TAIL_CHARS)}`);
    expect(bounded.text).not.toContain('m');
  });

  it('keeps only the end of a log whose share is no larger than the tail (backlog 485)', () => {
    const log = `${'h'.repeat(5_000)}${'t'.repeat(1_200)}`;
    expect(boundLog(log, 1_200)).toEqual({ text: 't'.repeat(1_200), originalChars: log.length });
    expect(boundLog(log, CI_LOG_TAIL_CHARS).text).toHaveLength(CI_LOG_TAIL_CHARS);
    expect(boundLog(log, CI_LOG_TAIL_CHARS).text.startsWith('h')).toBe(true);
    expect(boundLog(log, CI_LOG_TAIL_CHARS).text).not.toContain('\n');
  });

  it('gives a share past the tail a head, up to the head bound, and the tail the rest', () => {
    const log = `${'h'.repeat(3_000)}${'m'.repeat(5_000)}${'t'.repeat(5_000)}`;
    const five = boundLog(log, 5_000).text;
    expect(five).toBe(`${'h'.repeat(500)}\n${'t'.repeat(4_500)}`);
    // The head stops at its bound; the tail takes the remainder, reaching back into the middle.
    expect(boundLog(log, 9_000).text).toBe(
      `${'h'.repeat(CI_LOG_HEAD_CHARS)}\n${'m'.repeat(2_500)}${'t'.repeat(5_000)}`,
    );
  });

  it('fits inside the prompt’s feedback cap with room for the platform’s own sentences', () => {
    // The assembler must not have to cut a CI reason a second time (ci-log.ts, the budget's docblock).
    expect(CI_LOG_BUDGET_CHARS + MAX_CI_LOG_JOBS).toBeLessThanOrEqual(MAX_FEEDBACK_CHARS - 1_500);
  });
});

describe('splitLogBudget (backlog 485)', () => {
  it('splits evenly between logs longer than their share', () => {
    expect(splitLogBudget([20_000, 9_000, 7_000], 6_000)).toEqual([2_000, 2_000, 2_000]);
  });

  it('gives a short log’s unused share to the others, in the input’s order', () => {
    expect(splitLogBudget([20_000, 300, 9_000], 6_000)).toEqual([2_850, 300, 2_850]);
    expect(splitLogBudget([0, 20_000], 6_000)).toEqual([0, 6_000]);
  });

  it('guarantees every log at least the minimum share at the cap', () => {
    expect(CI_LOG_MIN_SHARE_CHARS).toBe(1_200);
    expect(splitLogBudget(new Array(MAX_CI_LOG_JOBS).fill(50_000), CI_LOG_BUDGET_CHARS)).toEqual(
      new Array(MAX_CI_LOG_JOBS).fill(CI_LOG_MIN_SHARE_CHARS),
    );
  });

  it('never spends past the budget, never gives a log more than it has, and starves none', () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: 100_000 }), { minLength: 1, maxLength: MAX_CI_LOG_JOBS }),
        fc.nat({ max: 20_000 }),
        (lengths, budget) => {
          const shares = splitLogBudget(lengths, budget);
          expect(shares).toHaveLength(lengths.length);
          expect(shares.reduce((sum, share) => sum + share, 0)).toBeLessThanOrEqual(budget);
          const floor = Math.floor(budget / lengths.length);
          shares.forEach((share, index) => {
            const length = lengths[index] ?? 0;
            expect(share).toBeLessThanOrEqual(length);
            expect(share).toBeGreaterThanOrEqual(Math.min(length, floor));
          });
          // Nothing is left on the table while a log was cut (up to the floor's rounding).
          const spent = shares.reduce((sum, share) => sum + share, 0);
          if (shares.some((share, index) => share < (lengths[index] ?? 0))) {
            expect(budget - spent).toBeLessThan(lengths.length);
          }
        },
      ),
    );
  });
});

describe('failingJobs and selectLogJobs', () => {
  const job = (
    name: string,
    status: 'failed' | 'success',
    logRef: string | null,
    allow = false,
  ) => ({
    name,
    status,
    log_ref: logRef,
    allow_failure: allow,
  });

  it('names every failing, not-allowed-to-fail job in the pipeline’s order', () => {
    expect(
      failingJobs([
        job('flaky', 'failed', 'l1', true),
        job('lint', 'success', 'l2'),
        job('unit', 'failed', null),
        job('e2e', 'failed', 'l4'),
      ]),
    ).toEqual([
      { name: 'unit', logRef: null },
      { name: 'e2e', logRef: 'l4' },
    ]);
  });

  it('answers no job when nothing failed that may not', () => {
    expect(failingJobs([job('flaky', 'failed', 'l1', true)])).toEqual([]);
  });

  it('reads at most the cap, the jobs naming a log first, and names the rest in order', () => {
    const jobs: FailingJobRef[] = [
      { name: 'a', logRef: null },
      { name: 'b', logRef: 'lb' },
      { name: 'c', logRef: 'lc' },
      { name: 'd', logRef: 'ld' },
      { name: 'e', logRef: null },
      { name: 'f', logRef: 'lf' },
      { name: 'g', logRef: 'lg' },
    ];
    const selected = selectLogJobs(jobs);
    expect(selected.read.map((entry) => entry.name)).toEqual(['b', 'c', 'd', 'f', 'g']);
    expect(selected.omitted).toEqual(['a', 'e']);
    expect(selectLogJobs(jobs.slice(0, 3))).toEqual({ read: jobs.slice(0, 3), omitted: [] });
  });
});
