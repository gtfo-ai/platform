/**
 * The pure half of PROGRESS backlog 490: which failures are a provider that did not answer, the
 * delay, the bound and the words. `stage.execute` drives them in
 * `saga.test.ts` › "a gate whose provider does not answer (backlog 490)";
 * `gates.test.ts` holds the evaluator's half.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  IntegrationError,
  IntegrationRateLimitedError,
  IntegrationResponseError,
} from '../ports/integrations/common.js';
import {
  decideGateOutage,
  GATE_OUTAGE_FIRST_RECHECK_MS,
  GATE_OUTAGE_LIMIT_MINUTES,
  GATE_OUTAGE_MAX_RECHECK_MS,
  type GateOutageFacts,
  gateOutageBackstop,
  gateOutageBrief,
  gateOutageDelayMs,
  gateOutageReason,
  transientProviderFailure,
} from './gate-outage.js';
import { GATE_RECHECK_MS } from './jobs.js';

const MINUTE = 60_000;
const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

describe('transientProviderFailure', () => {
  it('answers the executor’s two retryable codes, whatever the cause', () => {
    expect(
      transientProviderFailure(
        new IntegrationError('unavailable', 'gitlab', 'GET … could not be reached', {
          cause: timeout(),
        }),
      ),
    ).toBe('unavailable');
    expect(
      transientProviderFailure(new IntegrationRateLimitedError('gitlab', 'slow down', {})),
    ).toBe('rate_limited');
  });

  it('answers null for every code a later attempt does not fix, even over a transport cause', () => {
    for (const code of [
      'unauthorised',
      'forbidden',
      'not_found',
      'conflict',
      'invalid_request',
      'unsupported_capability',
    ] as const) {
      expect(
        transientProviderFailure(new IntegrationError(code, 'gitlab', 'no', { cause: timeout() })),
        code,
      ).toBeNull();
    }
    expect(
      transientProviderFailure(new IntegrationResponseError('gitlab', 'get_merge_request', ['x'])),
    ).toBeNull();
  });

  it('recognises a bare transport error by its class or code, never its message', () => {
    expect(transientProviderFailure(timeout())).toBe('timeout');
    expect(transientProviderFailure(new TypeError('fetch failed'))).toBe('network');
    expect(
      transientProviderFailure(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
        }),
      ),
    ).toBe('network');
    expect(
      transientProviderFailure(Object.assign(new Error('x'), { code: 'UND_ERR_SOCKET' })),
    ).toBe('network');
    // A message that merely says "timeout" is not a timeout.
    expect(transientProviderFailure(new Error('TimeoutError: fetch failed ECONNRESET'))).toBeNull();
    expect(
      transientProviderFailure(new TypeError('Cannot read properties of undefined')),
    ).toBeNull();
    expect(
      transientProviderFailure(Object.assign(new Error('x'), { code: 'ERR_INVALID_ARG_TYPE' })),
    ).toBeNull();
  });

  it('follows a cause chain a bounded number of links, and survives odd throwables', () => {
    const wrapped = (depth: number): unknown =>
      depth === 0 ? timeout() : new Error(`layer ${String(depth)}`, { cause: wrapped(depth - 1) });
    expect(transientProviderFailure(wrapped(5))).toBe('timeout');
    expect(transientProviderFailure(wrapped(6))).toBeNull();
    // An IntegrationError found down the chain decides by its own code.
    expect(
      transientProviderFailure(
        new Error('outer', {
          cause: new IntegrationError('forbidden', 'gitlab', 'no', { cause: timeout() }),
        }),
      ),
    ).toBeNull();
    for (const odd of [null, undefined, 'TimeoutError', 42, { name: 'TimeoutError' }]) {
      const expected = typeof odd === 'object' && odd !== null ? 'timeout' : null;
      expect(transientProviderFailure(odd), String(odd)).toBe(expected);
    }
    const cyclic: { name: string; cause?: unknown } = { name: 'Error' };
    cyclic.cause = cyclic;
    expect(transientProviderFailure(cyclic)).toBeNull();
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('no');
        },
      },
    );
    expect(transientProviderFailure(hostile)).toBeNull();
  });
});

describe('the outage delay and bound', () => {
  it('starts at the gate’s own thirty seconds and doubles to five minutes', () => {
    expect(GATE_OUTAGE_FIRST_RECHECK_MS).toBe(GATE_RECHECK_MS);
    expect([1, 2, 3, 4, 5, 6, 50].map(gateOutageDelayMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000,
    ]);
  });

  it('never waits less than thirty seconds or more than five minutes, and never shrinks', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (failures) => {
        const delay = gateOutageDelayMs(failures);
        expect(delay).toBeGreaterThanOrEqual(GATE_OUTAGE_FIRST_RECHECK_MS);
        expect(delay).toBeLessThanOrEqual(GATE_OUTAGE_MAX_RECHECK_MS);
        expect(gateOutageDelayMs(failures + 1)).toBeGreaterThanOrEqual(delay);
      }),
    );
  });

  it('re-asks within the deadline, clamped to it, and parks at or past it', () => {
    const at = (nowMs: number, failures = 1) =>
      decideGateOutage({ nowMs, deadlineMs: 60 * MINUTE, failures, limitMinutes: 60 });
    expect(at(0)).toEqual({ kind: 'recheck', delayMs: 30_000 });
    expect(at(0, 9)).toEqual({ kind: 'recheck', delayMs: 300_000 });
    expect(at(59 * MINUTE, 9)).toEqual({ kind: 'recheck', delayMs: MINUTE });
    expect(at(60 * MINUTE)).toEqual({ kind: 'timed_out' });
    expect(at(61 * MINUTE)).toEqual({ kind: 'timed_out' });
  });

  it('parks on an instant that does not parse (standing rule 16) and at its backstop', () => {
    expect(
      decideGateOutage({ nowMs: 0, deadlineMs: Number.NaN, failures: 1, limitMinutes: 60 }),
    ).toEqual({ kind: 'timed_out' });
    const limit = gateOutageBackstop(GATE_OUTAGE_LIMIT_MINUTES);
    expect(limit).toBe(121);
    expect(
      decideGateOutage({ nowMs: 0, deadlineMs: 60 * MINUTE, failures: limit, limitMinutes: 60 }),
    ).toEqual({ kind: 'backstop', limit });
  });

  it('cannot run past its bound however the clock is driven', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 1_440 }),
        fc.array(fc.integer({ min: 0, max: 10 * MINUTE }), { maxLength: 400 }),
        (limitMinutes, lateness) => {
          const deadlineMs = limitMinutes * MINUTE;
          let nowMs = 0;
          for (let failures = 1; ; failures += 1) {
            const decision = decideGateOutage({ nowMs, deadlineMs, failures, limitMinutes });
            if (decision.kind !== 'recheck') {
              expect(failures).toBeLessThanOrEqual(gateOutageBackstop(limitMinutes));
              return;
            }
            expect(nowMs + decision.delayMs).toBeLessThanOrEqual(deadlineMs);
            nowMs += decision.delayMs + (lateness[failures] ?? 0);
          }
        },
      ),
    );
  });
});

describe('the outage brief', () => {
  const facts = (overrides: Partial<GateOutageFacts> = {}): GateOutageFacts => ({
    stage: 'ci_gate',
    where: 'gitlab.com',
    code: 'unavailable',
    failures: 14,
    minutes: 60,
    bound: { kind: 'ci_timeout', minutes: 60 },
    ...overrides,
  });

  it('names the host, the time, the code and the bound a person can raise', () => {
    expect(gateOutageBrief(facts())).toBe(
      'gitlab.com did not answer for 60 minutes: unavailable. ' +
        'The "ci_gate" gate asked 14 times without an answer, waiting 30 seconds and then twice as long each time up to 5 minutes, until the CI timeout of 60 minutes from the gate\'s entry (`pipeline.limits.ci_timeout_minutes = 60`). ' +
        'Nothing about the merge request was decided: this is the provider being unreachable, not a result. ' +
        "Check that gitlab.com is reachable from the platform's host (and its status page), then hand the task back at ci_gate.",
    );
    expect(gateOutageReason(facts(), { kind: 'timed_out' })).toBe(
      'the "ci_gate" gate could not be decided: gitlab.com did not answer for 60 minutes: unavailable (14 failed reads); it stopped at the CI timeout of 60 minutes from the gate\'s entry (`pipeline.limits.ci_timeout_minutes = 60`) (PROGRESS backlog 490)',
    );
  });

  it('explains each code, counts in the singular, and says so when the time was not measured', () => {
    const one = facts({
      code: 'timeout',
      failures: 1,
      minutes: null,
      bound: { kind: 'ceiling', minutes: 60 },
    });
    expect(gateOutageBrief(one)).toContain(
      'gitlab.com did not answer for an unmeasured time: timeout (no answer within the request’s time limit).',
    );
    expect(gateOutageBrief(one)).toContain('asked 1 time without an answer,');
    expect(gateOutageReason(one, { kind: 'backstop', limit: 121 })).toContain(
      '(1 failed read); it stopped at its backstop of 121 failed reads',
    );
    expect(gateOutageBrief(facts({ code: 'rate_limited', minutes: 1 }))).toContain(
      'did not answer for 1 minute: rate_limited (the provider asked the platform to slow down).',
    );
    expect(gateOutageBrief(facts({ code: 'network' }))).toContain(
      'network (the connection could not be made or was dropped)',
    );
  });
});
