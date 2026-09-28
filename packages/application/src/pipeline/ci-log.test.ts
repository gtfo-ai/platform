/**
 * The failing job's log, read → redacted → bounded (WP-81, BD-024 §5). The gate-level assertions —
 * the token straddling the bound, the marker's length — are `gates.test.ts`; these are the pieces.
 */
import { MAX_FEEDBACK_CHARS } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { boundLog, CI_LOG_HEAD_CHARS, CI_LOG_TAIL_CHARS, failingJobWithLog } from './ci-log.js';

describe('boundLog', () => {
  it('keeps a log that fits whole and reports no cut', () => {
    const log = 'a'.repeat(CI_LOG_HEAD_CHARS + CI_LOG_TAIL_CHARS);
    expect(boundLog(log)).toEqual({ text: log, originalChars: null });
  });

  it('keeps the head and the tail of a longer one and reports the length it had', () => {
    const log = `${'h'.repeat(CI_LOG_HEAD_CHARS)}${'m'.repeat(10)}${'t'.repeat(CI_LOG_TAIL_CHARS)}`;
    const bounded = boundLog(log);
    expect(bounded.originalChars).toBe(log.length);
    expect(bounded.text).toBe(`${'h'.repeat(CI_LOG_HEAD_CHARS)}\n${'t'.repeat(CI_LOG_TAIL_CHARS)}`);
    expect(bounded.text).not.toContain('m');
  });

  it('fits inside the prompt’s feedback cap with room for the platform’s own sentences', () => {
    // The assembler must not have to cut a CI reason a second time (ci-log.ts, the bound's docblock).
    expect(CI_LOG_HEAD_CHARS + CI_LOG_TAIL_CHARS + 1).toBeLessThanOrEqual(
      MAX_FEEDBACK_CHARS - 1_500,
    );
  });
});

describe('failingJobWithLog', () => {
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

  it('picks the first failing, not-allowed-to-fail job that names a log', () => {
    expect(
      failingJobWithLog([
        job('flaky', 'failed', 'l1', true),
        job('lint', 'success', 'l2'),
        job('unit', 'failed', null),
        job('e2e', 'failed', 'l4'),
      ]),
    ).toEqual({ name: 'e2e', logRef: 'l4' });
  });

  it('names a failing job with no log rather than none, so the reason can say so', () => {
    expect(failingJobWithLog([job('unit', 'failed', null)])).toEqual({
      name: 'unit',
      logRef: null,
    });
  });

  it('answers null when nothing failed that may not', () => {
    expect(failingJobWithLog([job('flaky', 'failed', 'l1', true)])).toBeNull();
  });
});
