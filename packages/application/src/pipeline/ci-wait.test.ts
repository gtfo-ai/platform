/**
 * The CI gate's wait on a poll-only binding, the pure half (WP-136): the decision and the brief.
 * The saga-level cases — the clock, the hand-back, the recovered job, the unchanged bindings — are
 * in `saga.test.ts` › "the CI gate on a poll-only binding (WP-136)".
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CI_WAIT_EARLY_RECHECK_MS,
  CI_WAIT_LATE_RECHECK_MS,
  ciWaitBackstopChecks,
  ciWaitBrief,
  decideCiWait,
} from './ci-wait.js';
import { MAX_GATE_CHECKS } from './gates.js';
import { GATE_RECHECK_MS } from './jobs.js';

const MINUTE = 60_000;
const ENTERED = Date.parse('2026-10-04T08:00:00.000Z');

describe('the CI wait decision (WP-136)', () => {
  it('keeps the gate’s thirty seconds for the first checks, and states the backstop the ruling gives', () => {
    expect(CI_WAIT_EARLY_RECHECK_MS).toBe(GATE_RECHECK_MS);
    expect(CI_WAIT_LATE_RECHECK_MS).toBe(MINUTE);
    expect(ciWaitBackstopChecks(60)).toBe(65);
    expect(ciWaitBackstopChecks(10)).toBe(15);
    expect(ciWaitBackstopChecks(1440)).toBe(1445);
  });

  it('re-checks 60 seconds later at 59 minutes and times out at 60', () => {
    expect(
      decideCiWait({
        enteredAtMs: ENTERED,
        nowMs: ENTERED + 59 * MINUTE,
        checks: 58,
        timeoutMinutes: 60,
      }),
    ).toEqual({ kind: 'recheck', delayMs: CI_WAIT_LATE_RECHECK_MS });
    expect(
      decideCiWait({
        enteredAtMs: ENTERED,
        nowMs: ENTERED + 60 * MINUTE,
        checks: 59,
        timeoutMinutes: 60,
      }),
    ).toEqual({ kind: 'timed_out' });
  });

  it('stops at the backstop count even when the clock says there is time left', () => {
    expect(
      decideCiWait({ enteredAtMs: ENTERED, nowMs: ENTERED, checks: 65, timeoutMinutes: 60 }),
    ).toEqual({ kind: 'backstop', limit: 65 });
  });

  it('parks rather than waits on an instant that does not parse (standing rule 16)', () => {
    expect(
      decideCiWait({ enteredAtMs: Number.NaN, nowMs: ENTERED, checks: 2, timeoutMinutes: 60 }),
    ).toEqual({ kind: 'timed_out' });
  });

  it('never re-checks past the timeout, and never sooner than thirty seconds (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 1440 }),
        fc.integer({ min: 0, max: 2 * 1440 * MINUTE }),
        fc.integer({ min: 1, max: 2000 }),
        (timeoutMinutes, elapsed, checks) => {
          const decision = decideCiWait({
            enteredAtMs: ENTERED,
            nowMs: ENTERED + elapsed,
            checks,
            timeoutMinutes,
          });
          if (elapsed >= timeoutMinutes * MINUTE) {
            return decision.kind === 'timed_out';
          }
          if (checks >= ciWaitBackstopChecks(timeoutMinutes)) {
            return decision.kind === 'backstop';
          }
          return (
            decision.kind === 'recheck' &&
            decision.delayMs ===
              (checks < MAX_GATE_CHECKS ? CI_WAIT_EARLY_RECHECK_MS : CI_WAIT_LATE_RECHECK_MS)
          );
        },
      ),
    );
  });
});

describe('the CI wait brief (WP-136)', () => {
  it('names the backstop when the count, not the clock, stopped the wait', () => {
    const brief = ciWaitBrief(
      { timeoutMinutes: 60, provider: 'gitlab', pipeline: { id: '42', status: 'running' } },
      { kind: 'backstop', limit: 65 },
      65,
    );
    expect(brief).toContain('The CI gate stopped after 65 checks, its backstop');
    expect(brief).toContain('`pipeline.limits.ci_timeout_minutes = 60`');
    expect(brief).toContain('pipeline 42 was still running');
    expect(brief).toContain('hand the task back at ci_gate');
  });
});
