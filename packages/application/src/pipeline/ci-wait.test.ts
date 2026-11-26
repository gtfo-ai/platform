/**
 * The CI gate's wait for a pipeline, the pure half (WP-136; every git binding since 2026-11-26): the
 * decision and the brief. The saga-level cases — the clock, the hand-back, the recovered job, the
 * webhook binding — are in `saga.test.ts` › "the CI gate waits for a pipeline up to its CI timeout
 * (WP-136)".
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CI_WAIT_CEILING_MINUTES,
  CI_WAIT_EARLY_RECHECK_MS,
  CI_WAIT_LATE_RECHECK_MS,
  CI_WAIT_OVERTIME_RECHECK_MS,
  ciWaitBackstopChecks,
  ciWaitBrief,
  ciWaitCeilingMinutes,
  ciWaitReason,
  decideCiWait,
  isProgressingPipeline,
} from './ci-wait.js';
import { MAX_GATE_CHECKS } from './gates.js';
import { GATE_RECHECK_MS } from './jobs.js';

const MINUTE = 60_000;
const ENTERED = Date.parse('2026-10-04T08:00:00.000Z');

describe('the CI wait decision (WP-136)', () => {
  it('keeps the gate’s thirty seconds for the first checks, and states the backstop the ruling gives', () => {
    expect(CI_WAIT_EARLY_RECHECK_MS).toBe(GATE_RECHECK_MS);
    expect(CI_WAIT_LATE_RECHECK_MS).toBe(MINUTE);
    // The ruling's `ceil(timeout / 60 s) + 5`, plus the overtime's reads five minutes apart up to
    // the day's ceiling (BD-034).
    expect(CI_WAIT_CEILING_MINUTES).toBe(1440);
    expect(CI_WAIT_OVERTIME_RECHECK_MS).toBe(5 * MINUTE);
    expect(ciWaitBackstopChecks(60)).toBe(65 + 276);
    expect(ciWaitBackstopChecks(10)).toBe(15 + 286);
    expect(ciWaitBackstopChecks(1440)).toBe(1445);
    expect(ciWaitCeilingMinutes(60)).toBe(1440);
    expect(ciWaitCeilingMinutes(1440)).toBe(1440);
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
      decideCiWait({ enteredAtMs: ENTERED, nowMs: ENTERED, checks: 341, timeoutMinutes: 60 }),
    ).toEqual({ kind: 'backstop', limit: 341 });
    expect(
      decideCiWait({
        enteredAtMs: ENTERED,
        nowMs: ENTERED + 90 * MINUTE,
        checks: 341,
        timeoutMinutes: 60,
        progressing: true,
      }),
    ).toEqual({ kind: 'backstop', limit: 341 });
  });

  /**
   * BD-034 (2026-11-26, GO-705): a pipeline still `pending` or `running` at the timeout is waited
   * for overtime, one read every five minutes, up to the day's ceiling; `manual` and no pipeline
   * time out as before.
   */
  it('waits overtime for a progressing pipeline up to the ceiling, and times out anything else', () => {
    expect(isProgressingPipeline({ id: '1', status: 'running' })).toBe(true);
    expect(isProgressingPipeline({ id: '1', status: 'pending' })).toBe(true);
    expect(isProgressingPipeline({ id: '1', status: 'manual' })).toBe(false);
    expect(isProgressingPipeline(null)).toBe(false);
    const at = (elapsedMinutes: number, progressing: boolean) =>
      decideCiWait({
        enteredAtMs: ENTERED,
        nowMs: ENTERED + elapsedMinutes * MINUTE,
        checks: 70,
        timeoutMinutes: 60,
        progressing,
      });
    expect(at(60, false)).toEqual({ kind: 'timed_out' });
    expect(at(60, true)).toEqual({
      kind: 'recheck',
      delayMs: CI_WAIT_OVERTIME_RECHECK_MS,
      overtime: true,
    });
    expect(at(1438, true)).toEqual({ kind: 'recheck', delayMs: 2 * MINUTE, overtime: true });
    expect(at(1440, true)).toEqual({ kind: 'ceiling', minutes: 1440 });
    expect(
      decideCiWait({
        enteredAtMs: Number.NaN,
        nowMs: ENTERED,
        checks: 2,
        timeoutMinutes: 60,
        progressing: true,
      }),
    ).toEqual({ kind: 'timed_out' });
  });

  it('parks rather than waits on an instant that does not parse (standing rule 16)', () => {
    expect(
      decideCiWait({ enteredAtMs: Number.NaN, nowMs: ENTERED, checks: 2, timeoutMinutes: 60 }),
    ).toEqual({ kind: 'timed_out' });
  });

  it('never re-checks past the timeout when the pipeline is not progressing, and never sooner than thirty seconds (property)', () => {
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
  it('says how long it waited overtime and how often it asked when it stops at the ceiling (BD-034)', () => {
    const wait = {
      timeoutMinutes: 60,
      provider: 'gitlab',
      pollOnly: false,
      pipeline: { id: '19204', status: 'running' },
    } as const;
    const brief = ciWaitBrief(wait, { kind: 'ceiling', minutes: 1440 }, 341);
    expect(brief).toBe(
      'The CI pipeline 19204 for this merge request was still running after 1440 minutes. ' +
        'The platform waited past the CI timeout (`pipeline.limits.ci_timeout_minutes = 60`) because the pipeline was still progressing, ' +
        'reading it every minute up to the timeout and every 5 minutes after, 341 reads in all, and no pipeline event settled it. ' +
        'A pipeline that has not finished in this long is stuck — usually no runner picks up its jobs. ' +
        'Look at the pipeline; when it has finished, hand the task back at ci_gate.',
    );
    expect(ciWaitReason(wait, { kind: 'ceiling', minutes: 1440 }, 341)).toBe(
      'the CI gate on a gitlab binding waited 1440 minutes, past its CI timeout of 60 because the pipeline was still progressing, and stopped at its ceiling: the merge request was still running (pipeline 19204) at check 341',
    );
  });

  it('names the backstop when the count, not the clock, stopped the wait', () => {
    const brief = ciWaitBrief(
      {
        timeoutMinutes: 60,
        provider: 'gitlab',
        pollOnly: true,
        pipeline: { id: '42', status: 'running' },
      },
      { kind: 'backstop', limit: 65 },
      65,
    );
    expect(brief).toContain('The CI gate stopped after 65 checks, its backstop');
    expect(brief).toContain('`pipeline.limits.ci_timeout_minutes = 60`');
    expect(brief).toContain('pipeline 42 was still running');
    expect(brief).toContain('hand the task back at ci_gate');
  });

  /**
   * 2026-11-26 (fontai, GO-705): the time bound reaches a binding a webhook reaches too, and its
   * brief must not claim the binding is poll-only.
   */
  it('words a binding a webhook reaches without calling it poll-only', () => {
    const wait = {
      timeoutMinutes: 60,
      provider: 'gitlab',
      pollOnly: false,
      pipeline: { id: '19204', status: 'running' },
    } as const;
    const brief = ciWaitBrief(wait, { kind: 'timed_out' }, 63);
    expect(brief).toContain(
      'The CI pipeline 19204 for this merge request was still running after 60 minutes',
    );
    expect(brief).toContain('No pipeline event from gitlab settled it');
    expect(brief).not.toContain('poll-only');
    const reason = ciWaitReason(wait, { kind: 'timed_out' }, 63);
    expect(reason).toBe(
      'the CI gate on a gitlab binding timed out: the merge request was still running (pipeline 19204) after 60 minutes (pipeline.limits.ci_timeout_minutes = 60)',
    );
    expect(ciWaitReason({ ...wait, pollOnly: true }, { kind: 'timed_out' }, 63)).toContain(
      'the CI gate on a poll-only gitlab binding timed out',
    );
  });
});
