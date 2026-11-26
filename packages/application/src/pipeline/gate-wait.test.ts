/**
 * A gate with no answer yet waits by time, the pure half (BD-034): the decision, the limit and the
 * brief. The saga-level cases — the rebase gate waiting for mergeability past five checks — are in
 * `saga.test.ts` › "waits for another gate by time from its entry, backing off, and parks at its sixty-minute limit (BD-034)".
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  decideGateWait,
  GATE_EVENT_LIMIT_MINUTES,
  GATE_PENDING_LIMIT_MINUTES,
  GATE_WAIT_FIRST_RECHECK_MS,
  GATE_WAIT_MAX_RECHECK_MS,
  gateWaitBackstop,
  gateWaitBrief,
  gateWaitDelayMs,
  gateWaitLimitMinutes,
  gateWaitReason,
} from './gate-wait.js';
import { GATE_RECHECK_MS } from './jobs.js';

const MINUTE = 60_000;
const ENTERED = Date.parse('2026-11-26T08:00:00.000Z');

describe('the gate wait decision (BD-034)', () => {
  it('starts at the gate’s thirty seconds and backs off to five minutes', () => {
    expect(GATE_WAIT_FIRST_RECHECK_MS).toBe(GATE_RECHECK_MS);
    expect([1, 2, 3, 4, 5, 6, 40].map(gateWaitDelayMs)).toEqual([
      30_000,
      60_000,
      120_000,
      240_000,
      300_000,
      300_000,
      GATE_WAIT_MAX_RECHECK_MS,
    ]);
  });

  it('waits an hour for a gate the platform evaluates and a day for a declared event', () => {
    expect(gateWaitLimitMinutes(false)).toBe(GATE_PENDING_LIMIT_MINUTES);
    expect(gateWaitLimitMinutes(true)).toBe(GATE_EVENT_LIMIT_MINUTES);
    expect(GATE_PENDING_LIMIT_MINUTES).toBe(60);
    expect(GATE_EVENT_LIMIT_MINUTES).toBe(24 * 60);
  });

  it('re-checks past five checks, moves the last re-check up to the deadline, and times out at it', () => {
    const at = (elapsedMinutes: number, checks: number) =>
      decideGateWait({
        enteredAtMs: ENTERED,
        nowMs: ENTERED + elapsedMinutes * MINUTE,
        checks,
        limitMinutes: 60,
      });
    expect(at(3, 6)).toEqual({ kind: 'recheck', delayMs: 300_000 });
    expect(at(58, 20)).toEqual({ kind: 'recheck', delayMs: 2 * MINUTE });
    expect(at(60, 21)).toEqual({ kind: 'timed_out' });
  });

  it('parks on an instant that does not parse (standing rule 16) and at its backstop', () => {
    expect(
      decideGateWait({ enteredAtMs: Number.NaN, nowMs: ENTERED, checks: 1, limitMinutes: 60 }),
    ).toEqual({ kind: 'timed_out' });
    expect(gateWaitBackstop(60)).toBe(121);
    expect(
      decideGateWait({ enteredAtMs: ENTERED, nowMs: ENTERED, checks: 121, limitMinutes: 60 }),
    ).toEqual({ kind: 'backstop', limit: 121 });
  });

  it('cannot run past its limit however the clock is driven (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_440 }),
        fc.array(fc.integer({ min: 0, max: 10 * MINUTE }), { maxLength: 400 }),
        (limitMinutes, lateness) => {
          let nowMs = ENTERED;
          for (let checks = 1; ; checks += 1) {
            const decision = decideGateWait({ enteredAtMs: ENTERED, nowMs, checks, limitMinutes });
            if (decision.kind !== 'recheck') {
              expect(checks).toBeLessThanOrEqual(gateWaitBackstop(limitMinutes));
              return;
            }
            expect(decision.delayMs).toBeGreaterThan(0);
            expect(nowMs + decision.delayMs).toBeLessThanOrEqual(ENTERED + limitMinutes * MINUTE);
            nowMs += decision.delayMs + (lateness[checks] ?? 0);
          }
        },
      ),
    );
  });
});

describe('the gate wait brief (BD-034)', () => {
  it('says what the gate waited for, how often it asked and until when', () => {
    const facts = {
      stage: 'rebase_gate',
      detail: 'the provider has not computed mergeability yet',
      checks: 17,
      limitMinutes: 60,
      minutes: 60,
    };
    expect(gateWaitReason(facts, { kind: 'timed_out' })).toBe(
      'the "rebase_gate" gate could not be decided after 60 minutes and 17 checks: the provider has not computed mergeability yet; it stopped at its 60-minute limit',
    );
    expect(gateWaitReason({ ...facts, minutes: null }, { kind: 'backstop', limit: 121 })).toBe(
      'the "rebase_gate" gate could not be decided after an unmeasured time and 17 checks: the provider has not computed mergeability yet; it stopped at its backstop of 121 checks',
    );
    expect(gateWaitBrief(facts)).toBe(
      'The "rebase_gate" gate for this task still has no answer after 60 minutes (the provider has not computed mergeability yet). ' +
        'The platform asked 17 times, waiting 30 seconds and then twice as long each time up to 5 minutes, until its 60-minute limit for this gate. ' +
        'Something that should have answered by itself did not. Look at the merge request (or the event the gate waits for) yourself, then hand the task back.',
    );
  });
});
