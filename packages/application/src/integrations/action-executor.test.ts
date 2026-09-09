/**
 * `IntegrationActionExecutor` — the five duties of technical/06 § "Outbound: actions".
 *
 * Every assertion here is positive where it can be: "exactly one row with status `would_have` and
 * zero events" rather than "no event was emitted", because the second one also passes when the
 * harness never called the executor at all.
 *
 * No test waits on the wall clock. Backoff and rate limiting run on `createVirtualTimer`, and the
 * assertions are on the *durations asked for* (`timer.sleeps`), which is the behaviour, rather
 * than on how long the process actually slept, which is the hardware.
 */
import { inspect } from 'node:util';
import type { TaskMode } from '@platform/contracts';
import { fixedClock } from '@platform/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  IntegrationError,
  IntegrationRateLimitedError,
  type IntegrationRef,
} from '../ports/integrations/common.js';
import type { LogFields, Logger } from '../ports/logger.js';
import {
  createMemoryAuditLog,
  createMemoryIdempotencyStore,
  createVirtualTimer,
  type MemoryIdempotencyStore,
  type MemoryIntegrationAuditLog,
  type VirtualTimer,
} from '../testing/memory-integrations.js';
import {
  createIntegrationActionExecutor,
  type IntegrationActionExecutor,
  type MutatingActionRequest,
  redactErrorInPlace,
} from './action-executor.js';
import { exactSecretRedactor } from './redaction.js';

interface CapturedLog {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly fields: LogFields;
  readonly message: string;
}

/** A logger that keeps what it was given, so an assertion can read the record pino would emit. */
const capturingLogger = (): { readonly records: CapturedLog[]; readonly logger: Logger } => {
  const records: CapturedLog[] = [];
  const at =
    (level: CapturedLog['level']) =>
    (fields: LogFields, message: string): void => {
      records.push({ level, fields, message });
    };
  return {
    records,
    logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
  };
};

const INTEGRATION: IntegrationRef = {
  integrationId: '00000000-0000-4000-8000-000000000001',
  provider: 'fake-task-management',
  type: 'task_management',
};

const OTHER_INTEGRATION: IntegrationRef = {
  ...INTEGRATION,
  integrationId: '00000000-0000-4000-8000-000000000002',
};

const PROJECT_ID = '00000000-0000-4000-8000-0000000000b0';
const TASK_ID = '00000000-0000-4000-8000-0000000000c0';
const SECRET = 'fake-jira-token-0123456789';

/**
 * Lets every already-scheduled promise chain run.
 *
 * Twenty turns is far more than the executor needs (acquire → perform → release is three), so a
 * missing concurrency cap has every chance to reveal itself instead of hiding behind "the second
 * call had not been scheduled yet".
 */
/**
 * Settles a promise without asserting on it, so the *first* assertion in a test can be the one
 * that names the behaviour. `rejects.toThrow` fails as "promise resolved instead of rejecting",
 * which says nothing about the side effect that happened instead.
 */
const outcomeOf = async (
  promise: Promise<unknown>,
): Promise<{ readonly rejected: boolean; readonly error: unknown }> =>
  promise.then(
    () => ({ rejected: false, error: null }),
    (error: unknown) => ({ rejected: true, error }),
  );

const flushMicrotasks = async (turns = 20): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) {
    await Promise.resolve();
  }
};

describe('IntegrationActionExecutor', () => {
  let auditLog: MemoryIntegrationAuditLog;
  let store: MemoryIdempotencyStore;
  let timer: VirtualTimer;
  let executor: IntegrationActionExecutor;
  let performed: number;

  const build = (overrides: Partial<Parameters<typeof createIntegrationActionExecutor>[0]> = {}) =>
    createIntegrationActionExecutor({
      auditLog,
      redactor: exactSecretRedactor([{ name: 'jira', value: SECRET }]),
      timer,
      clock: fixedClock('2026-06-01T09:00:00.000Z', 1000),
      idempotencyStore: store,
      // A budget wide enough that only the tests that mean to hit it do.
      rateLimits: { capacity: 100, refillPerSecond: 100, maxConcurrent: 4 },
      ...overrides,
    });

  beforeEach(() => {
    auditLog = createMemoryAuditLog();
    store = createMemoryIdempotencyStore();
    timer = createVirtualTimer({ autoAdvance: true });
    executor = build();
    performed = 0;
  });

  /** A mutating action that returns a comment id, as `addComment` would. */
  const addComment = (overrides: Record<string, unknown> = {}) => ({
    integration: INTEGRATION,
    action: 'add_comment',
    mutating: true as const,
    // Required on a mutating request, and stated here for the same reason a call site must state
    // it: the shadow guard is only as good as the value it reads.
    mode: 'normal' as TaskMode,
    payload: { ticket_key: 'FAKE-1', body: 'hello' },
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    perform: async () => {
      performed += 1;
      return { comment_id: `c-${performed}` };
    },
    shadowResult: () => ({ comment_id: 'shadow' }),
    describeResult: (result: { comment_id: string }) => ({ comment_id: result.comment_id }),
    ...overrides,
  });

  const readTicket = (overrides: Record<string, unknown> = {}) => ({
    integration: INTEGRATION,
    action: 'read_ticket',
    mutating: false as const,
    payload: { ticket_key: 'FAKE-1' },
    projectId: PROJECT_ID,
    perform: async () => {
      performed += 1;
      return { status: 'In Progress' };
    },
    ...overrides,
  });

  describe('shadow mode (technical/02 invariant)', () => {
    it('performs no mutating call, records would_have and emits no event', async () => {
      const outcome = await executor.execute(addComment({ mode: 'shadow' }));

      expect(performed).toBe(0);
      expect(outcome.status).toBe('would_have');
      expect(outcome.result).toEqual({ comment_id: 'shadow' });
      expect(auditLog.entries.length).toBe(1);
      expect(auditLog.entries[0]?.status).toBe('would_have');
      expect(auditLog.entries[0]?.result).toEqual({ comment_id: 'shadow' });
      expect(auditLog.events).toEqual([]);
    });

    it('still performs reads, because a shadow task needs its context', async () => {
      const outcome = await executor.execute(readTicket({ mode: 'shadow' }));

      expect(performed).toBe(1);
      expect(outcome.status).toBe('ok');
      expect(auditLog.events.map((event) => event.type)).toEqual(['integration.action.performed']);
    });

    /**
     * The compile-time half of the guard.
     *
     * A default of `normal` would make a forgotten `mode` a *silent real side effect*, so `mode`
     * is required on a mutating request. Reverting it to optional does not fail any runtime test —
     * it makes `tsc` report `TS2578: Unused '@ts-expect-error' directive` on the line below, which
     * is `pnpm typecheck` failing by name.
     *
     * It is only half. `tsc` is not present at run time, which is what the two tests below are
     * about.
     */
    it('does not compile a mutating request that omits the mode', () => {
      const withoutMode = {
        integration: INTEGRATION,
        action: 'add_comment',
        mutating: true as const,
        payload: { ticket_key: 'FAKE-1' },
        perform: async () => ({ comment_id: 'c-1' }),
        shadowResult: () => ({ comment_id: 'shadow' }),
        describeResult: (result: { comment_id: string }) => ({ comment_id: result.comment_id }),
      };

      // @ts-expect-error `mode` is required on MutatingActionRequest — see the docblock.
      const request: MutatingActionRequest<{ comment_id: string }> = withoutMode;

      expect(request.action).toBe('add_comment');
    });

    /**
     * The runtime half, exercised the only way it can be: from a call site with no types.
     *
     * `untyped()` erases the signature, so what runs below is exactly what Node runs when a
     * JavaScript caller — a plugin, a REPL, a `JSON.parse`d request, a mis-typed `as` — calls
     * `execute`. Review round 1 asserted this obligation with `@ts-expect-error`, and its mutation
     * died as `TS2578` — a compile-time death, while the process went on performing the action.
     * Reverting the runtime guard fails these two on `performed`, which is the side effect itself.
     */
    const untyped = (target: IntegrationActionExecutor): ((request: unknown) => Promise<unknown>) =>
      target.execute as unknown as (request: unknown) => Promise<unknown>;

    it('refuses a mutating request that reaches it without a mode, from JavaScript', async () => {
      const request = {
        integration: INTEGRATION,
        action: 'add_comment',
        mutating: true,
        payload: { ticket_key: 'FAKE-1' },
        perform: async () => {
          performed += 1;
          return { comment_id: 'c-1' };
        },
        shadowResult: () => ({ comment_id: 'shadow' }),
        describeResult: (result: { comment_id: string }) => result,
      };

      const settled = await outcomeOf(untyped(executor)(request));

      expect(performed, 'a mutating request with no mode must not reach the provider').toBe(0);
      expect(settled.rejected, 'and it must be refused rather than performed').toBe(true);
      expect(String(settled.error), 'and refused for the stated reason').toMatch(
        /must state the task's mode/,
      );
      expect(auditLog.entries, 'a request this malformed never reached a provider').toEqual([]);
    });

    it('refuses "SHADOW", which no === comparison would have caught, from JavaScript', async () => {
      const request = {
        integration: INTEGRATION,
        action: 'add_comment',
        mutating: true,
        // Upper case: unequal to 'shadow', so the guard's comparison would fall through to a real
        // provider call. This is the mislabelled-mode leak the reviewer built by hand.
        mode: 'SHADOW',
        payload: { ticket_key: 'FAKE-1' },
        perform: async () => {
          performed += 1;
          return { comment_id: 'c-1' };
        },
        shadowResult: () => ({ comment_id: 'shadow' }),
        describeResult: (result: { comment_id: string }) => result,
      };

      const settled = await outcomeOf(untyped(executor)(request));

      expect(performed, 'a shadow task must not reach the provider through a mis-spelling').toBe(0);
      expect(settled.rejected, 'a mode that is not exactly "normal" or "shadow" is refused').toBe(
        true,
      );
      expect(String(settled.error), 'and refused for the stated reason').toMatch(
        /must state the task's mode/,
      );
      expect(auditLog.entries, 'nothing performed, nothing recorded').toEqual([]);
    });

    it('still accepts a well-formed mode from JavaScript, so the guard is not a wall', async () => {
      const outcome = (await untyped(executor)({
        ...addComment(),
        mode: 'shadow',
      })) as { status: string };

      expect(outcome.status, 'a correct mode still takes the shadow branch').toBe('would_have');
      expect(performed).toBe(0);
    });
  });

  describe('audit (BD-003)', () => {
    it('emits performed with the redacted payload, the result and the duration', async () => {
      const outcome = await executor.execute(addComment());

      expect(outcome.status).toBe('ok');
      expect(auditLog.entries.length).toBe(1);
      const entry = auditLog.entries[0];
      expect(entry?.status).toBe('ok');
      expect(entry?.attempts).toBe(1);
      expect(entry?.direction).toBe('out');
      expect(entry?.taskId).toBe(TASK_ID);
      expect(auditLog.events.length).toBe(1);
      const event = auditLog.events[0];
      expect(event?.type).toBe('integration.action.performed');
      expect(event?.actor).toEqual({
        kind: 'integration',
        integration_id: INTEGRATION.integrationId,
        provider: INTEGRATION.provider,
      });
    });

    it('records the failure before rethrowing it', async () => {
      const failure = new IntegrationError('not_found', INTEGRATION.provider, 'ticket is gone');
      await expect(
        executor.execute(
          addComment({
            perform: async () => {
              performed += 1;
              throw failure;
            },
          }),
        ),
      ).rejects.toBe(failure);

      expect(auditLog.entries.length).toBe(1);
      expect(auditLog.entries[0]?.status).toBe('failed');
      expect(auditLog.entries[0]?.error).toContain('ticket is gone');
      expect(auditLog.events.map((event) => event.type)).toEqual(['integration.action.failed']);
    });

    it('redacts an injected secret in the payload and in the error message (TD-012)', async () => {
      const failure = new IntegrationError(
        'unauthorised',
        INTEGRATION.provider,
        `token ${SECRET} was rejected`,
      );
      await expect(
        executor.execute(
          addComment({
            payload: { ticket_key: 'FAKE-1', authorization: `Bearer ${SECRET}` },
            perform: async () => {
              throw failure;
            },
          }),
        ),
      ).rejects.toBe(failure);

      const entry = auditLog.entries[0];
      expect(JSON.stringify(entry?.payload)).not.toContain(SECRET);
      expect(entry?.payload.authorization).toBe('Bearer [REDACTED:integration:jira]');
      expect(entry?.error).not.toContain(SECRET);
      expect(entry?.redactionCount).toBe(2);
    });

    it('logs the row’s redacted error when the audit row cannot be written (TD-012)', async () => {
      const captured = capturingLogger();
      executor = build({ logger: captured.logger });
      auditLog.failNext(new Error('database is down'));

      await expect(
        executor.execute(
          addComment({
            perform: async () => {
              throw new IntegrationError(
                'unauthorised',
                INTEGRATION.provider,
                `token ${SECRET} was rejected`,
              );
            },
          }),
        ),
      ).rejects.toThrow('database is down');

      const record = captured.records.find(
        (entry) =>
          entry.message === 'integration action failed and its audit row could not be written',
      );
      expect(record, 'the audit failure must be logged').toBeDefined();
      const err = String(record?.fields.err);
      expect(err, 'the log line must not carry the injected secret').not.toContain(SECRET);
      expect(err, 'it carries the placeholder the audit row would have carried').toContain(
        '[REDACTED:integration:jira]',
      );
    });

    it('scrubs the secret out of the error it rethrows, message and stack', async () => {
      const failure = new IntegrationError(
        'unauthorised',
        INTEGRATION.provider,
        `token ${SECRET} was rejected`,
        { cause: new Error(`upstream said ${SECRET}`) },
      );

      const caught = await executor
        .execute(addComment({ perform: async () => Promise.reject(failure) }))
        .then(
          () => null,
          (error: unknown) => error,
        );

      // Identity survives: a handler still matches on the class and the code.
      expect(caught).toBe(failure);
      expect((caught as IntegrationError).code).toBe('unauthorised');
      expect((caught as Error).message, 'the rethrown message').not.toContain(SECRET);
      expect((caught as Error).message).toContain('[REDACTED:integration:jira]');
      expect(String((caught as Error).stack), 'the rethrown stack').not.toContain(SECRET);
      expect(String(((caught as Error).cause as Error).message), 'the cause chain').not.toContain(
        SECRET,
      );
    });

    /**
     * The provider error carries the shape WP-08…WP-11 will actually throw.
     *
     * An axios or undici failure is not a bare `Error`: the request config and the response body
     * hang off it as **own enumerable properties**, which is where the injected credential sits
     * (`config.headers.Authorization`) and exactly what `pino-std-serializers` copies key by key
     * (`lib/err.js`). Scrubbing only `message` and `stack` would leave every one of them.
     */
    it('scrubs an own enumerable property of the rethrown error, however deep', async () => {
      const failure = Object.assign(
        new IntegrationError('unauthorised', INTEGRATION.provider, 'request failed'),
        {
          config: { headers: { Authorization: `Bearer ${SECRET}` } },
          response: { status: 401, body: { detail: [`token ${SECRET} was rejected`] } },
        },
      );

      const caught = await executor
        .execute(addComment({ perform: async () => Promise.reject(failure) }))
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(caught).toBe(failure);
      expect(
        JSON.stringify(caught),
        'JSON.stringify walks own enumerable properties, and so must the scrub',
      ).not.toContain(SECRET);
      expect(failure.config.headers.Authorization, 'the header the platform injected').toBe(
        'Bearer [REDACTED:integration:jira]',
      );
      expect(failure.response.body.detail[0], 'a string nested in an array in an object').toContain(
        '[REDACTED:integration:jira]',
      );
    });

    it('scrubs the audit-store failure it rethrows, not only the provider error', async () => {
      // The audit adapter's own error: a driver that quotes the statement it could not run is how
      // an injected credential ends up in a database error. `throw auditError` used to leave
      // unscrubbed one line from a scrubbed sibling.
      auditLog.failNext(new Error(`insert failed while writing token ${SECRET}`));

      const caught = await executor
        .execute(
          addComment({
            perform: async () => {
              throw new IntegrationError('not_found', INTEGRATION.provider, 'ticket is gone');
            },
          }),
        )
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect((caught as Error).message, 'the audit failure is what reaches the caller').toContain(
        'insert failed',
      );
      expect(
        (caught as Error).message,
        'the audit-store error must not carry the injected secret',
      ).not.toContain(SECRET);
      expect((caught as Error).message).toContain('[REDACTED:integration:jira]');
    });

    it('scrubs an audit failure on the success path too, where nothing threw before', async () => {
      // Not one of the two `throw` statements: `record` on the success path simply propagates.
      // A choke point covers it; a per-branch scrub never did.
      auditLog.failNext(new Error(`insert failed while writing token ${SECRET}`));

      const caught = await executor.execute(addComment()).then(
        () => null,
        (error: unknown) => error,
      );

      expect(performed, 'the provider call succeeded; only the audit write failed').toBe(1);
      expect(
        (caught as Error).message,
        'an error leaving the success path is scrubbed like every other',
      ).not.toContain(SECRET);
    });

    it('logs a count when an error refuses the scrub instead of leaking silently', async () => {
      const captured = capturingLogger();
      executor = build({ logger: captured.logger });
      const frozen = Object.freeze(
        new IntegrationError('forbidden', INTEGRATION.provider, `token ${SECRET} was rejected`),
      );

      await expect(
        executor.execute(addComment({ perform: async () => Promise.reject(frozen) })),
      ).rejects.toBe(frozen);

      const record = captured.records.find(
        (entry) =>
          entry.message ===
          'an error left the integration executor still carrying an injected secret',
      );
      expect(record, 'a refused scrub must be reported, not silent').toBeDefined();
      expect(record?.fields.redaction_blocked, 'the message could not be written').toBe(1);
      expect(
        JSON.stringify(record?.fields),
        'the warning reports a count and never the text',
      ).not.toContain(SECRET);
    });

    it('refuses an action name that is not snake_case, and records nothing', async () => {
      await expect(executor.execute(addComment({ action: 'Add Comment' }))).rejects.toThrow(
        /not a snake_case action name/,
      );
      expect(auditLog.entries).toEqual([]);
      expect(performed).toBe(0);
    });
  });

  describe('idempotency (product/08)', () => {
    const plan = {
      key: 'marker:agentic:workpad',
      encode: (result: { comment_id: string }) => result.comment_id,
      decode: (stored: unknown) => ({ comment_id: stored as string }),
    };

    it('performs once and replays the stored result afterwards', async () => {
      const first = await executor.execute(addComment({ idempotency: plan }));
      const second = await executor.execute(addComment({ idempotency: plan }));

      expect(performed).toBe(1);
      expect(first.status).toBe('ok');
      expect(second.status).toBe('replayed');
      expect(second.result).toEqual(first.result);
      expect(auditLog.entries.map((entry) => entry.status)).toEqual(['ok', 'replayed']);
      // A replay performed nothing, so it emits nothing.
      expect(auditLog.events.map((event) => event.type)).toEqual(['integration.action.performed']);
    });

    it('does not share a key between two integrations', async () => {
      await executor.execute(addComment({ idempotency: plan }));
      await executor.execute(addComment({ integration: OTHER_INTEGRATION, idempotency: plan }));

      expect(performed).toBe(2);
      expect(store.keys().length).toBe(2);
    });

    it('does not share a key between two actions of one integration', async () => {
      await executor.execute(addComment({ idempotency: plan }));
      await executor.execute(addComment({ action: 'upsert_workpad', idempotency: plan }));

      expect(performed).toBe(2);
      expect(store.keys().length).toBe(2);
    });

    it('stores the key before the audit row, so a failed write cannot duplicate the call', async () => {
      auditLog.failNext(new Error('database is down'));
      await expect(executor.execute(addComment({ idempotency: plan }))).rejects.toThrow(
        'database is down',
      );

      expect(performed).toBe(1);
      expect(store.size).toBe(1);

      const retry = await executor.execute(addComment({ idempotency: plan }));
      expect(retry.status).toBe('replayed');
      expect(performed).toBe(1);
      expect(auditLog.entries.map((entry) => entry.status)).toEqual(['replayed']);
    });
  });

  describe('rate limits and backoff (429 + Retry-After)', () => {
    it('waits exactly as long as Retry-After says, then succeeds', async () => {
      let attempts = 0;
      const outcome = await executor.execute(
        addComment({
          perform: async () => {
            attempts += 1;
            if (attempts === 1) {
              throw new IntegrationRateLimitedError(INTEGRATION.provider, 'slow down', {
                retryAfterMs: 2500,
              });
            }
            return { comment_id: 'c-1' };
          },
        }),
      );

      expect(outcome.status).toBe('ok');
      expect(outcome.attempts).toBe(2);
      expect(timer.sleeps).toEqual([2500]);
      expect(auditLog.entries[0]?.attempts).toBe(2);
    });

    it('falls back to exponential backoff when the provider sends no Retry-After', async () => {
      let attempts = 0;
      await expect(
        executor.execute(
          addComment({
            perform: async () => {
              attempts += 1;
              throw new IntegrationError('unavailable', INTEGRATION.provider, 'gateway timeout');
            },
          }),
        ),
      ).rejects.toThrow('gateway timeout');

      expect(attempts).toBe(3);
      expect(timer.sleeps).toEqual([500, 1000]);
      expect(auditLog.entries[0]?.status).toBe('failed');
      expect(auditLog.entries[0]?.attempts).toBe(3);
    });

    it('never retries an error the provider will answer the same way', async () => {
      await expect(
        executor.execute(
          addComment({
            perform: async () => {
              performed += 1;
              throw new IntegrationError('forbidden', INTEGRATION.provider, 'no permission');
            },
          }),
        ),
      ).rejects.toThrow('no permission');

      expect(performed).toBe(1);
      expect(timer.sleeps).toEqual([]);
    });

    it('spends a token per call and waits for the bucket to refill', async () => {
      executor = build({ rateLimits: { capacity: 1, refillPerSecond: 1, maxConcurrent: 4 } });

      await executor.execute(addComment());
      await executor.execute(addComment());

      expect(performed).toBe(2);
      expect(timer.sleeps).toEqual([1000]);
    });

    it('gives each integration its own budget', async () => {
      executor = build({ rateLimits: { capacity: 1, refillPerSecond: 1, maxConcurrent: 4 } });

      await executor.execute(addComment());
      await executor.execute(addComment({ integration: OTHER_INTEGRATION }));

      expect(performed).toBe(2);
      expect(timer.sleeps).toEqual([]);
    });

    it('caps concurrency per integration', async () => {
      executor = build({ rateLimits: { capacity: 10, refillPerSecond: 10, maxConcurrent: 1 } });
      const order: string[] = [];
      const gate = Promise.withResolvers<void>();
      const firstStarted = Promise.withResolvers<void>();

      const first = executor.execute(
        addComment({
          perform: async () => {
            order.push('first:start');
            firstStarted.resolve();
            await gate.promise;
            order.push('first:end');
            return { comment_id: 'c-1' };
          },
        }),
      );
      const second = executor.execute(
        addComment({
          perform: async () => {
            order.push('second:start');
            return { comment_id: 'c-2' };
          },
        }),
      );

      // Deterministic, not timing: wait for the first call to be *in* the provider, then let the
      // scheduler run far enough that a missing cap would show up as `second:start`.
      await firstStarted.promise;
      await flushMicrotasks();
      expect(order).toEqual(['first:start']);

      gate.resolve();
      await Promise.all([first, second]);
      expect(order).toEqual(['first:start', 'first:end', 'second:start']);
    });
  });
});

/**
 * The scrub's coverage, stated against the walk the consumer performs.
 *
 * `apps/server` logs an unexpected error as `{ err }`; `pino-std-serializers` then emits the
 * message and stack **with the whole cause chain appended**, an `AggregateError`'s `errors[]`, and
 * a copy of every key `for…in` reaches (`lib/err.js:24-38`). Each test below is one of those four
 * routes, and the last two are the documented *limitations* — asserted, so that a change which
 * makes one coverable fails here instead of passing quietly.
 */
describe('redactErrorInPlace', () => {
  const redactor = exactSecretRedactor([{ name: 'jira', value: SECRET }]);
  const PLACEHOLDER = '[REDACTED:integration:jira]';

  it('scrubs a cause chain, and a cycle in it terminates', () => {
    const inner = new Error(`inner ${SECRET}`);
    const outer = new Error(`outer ${SECRET}`, { cause: inner });
    // A wrapper that pointed `cause` back at its wrapper. Terminated by the `seen` set, which is
    // the same device pino's own chain walk uses — not by a depth bound pino does not share.
    (inner as { cause?: unknown }).cause = outer;

    const redaction = redactErrorInPlace(redactor, outer);

    expect(
      redaction.count,
      'both messages and both stacks carried the secret',
    ).toBeGreaterThanOrEqual(2);
    expect(redaction.blocked, 'nothing refused the write').toBe(0);
    expect(outer.message).toBe(`outer ${PLACEHOLDER}`);
    expect(inner.message).toBe(`inner ${PLACEHOLDER}`);
  });

  /**
   * A bound on our walk is only a safety property if the consumer has one too, and pino's
   * `messageWithCauses` is unbounded. Twenty is comfortably past the old `MAX_CAUSE_DEPTH = 8`,
   * which returned `count: 0` here while pino printed every one of these messages.
   */
  it('scrubs a cause chain deeper than any fixed bound, because pino has none', () => {
    const CHAIN = 20;
    let error = new Error(`depth 0 ${SECRET}`);
    for (let depth = 1; depth <= CHAIN; depth += 1) {
      error = new Error(`depth ${depth} ${SECRET}`, { cause: error });
    }

    redactErrorInPlace(redactor, error);

    let current: unknown = error;
    for (let depth = 0; depth <= CHAIN; depth += 1) {
      expect((current as Error).message, `the message at cause depth ${CHAIN - depth}`).toContain(
        PLACEHOLDER,
      );
      current = (current as Error).cause;
    }
  });

  /**
   * The axios/undici shape the provider work packages will throw. `for…in` is what pino copies,
   * what `JSON.stringify` serialises and what `util.inspect` prints, so it is what the scrub walks.
   */
  it('walks own enumerable properties, recursively, and survives a cycle among them', () => {
    class HttpError extends Error {
      readonly config = { headers: { Authorization: `Bearer ${SECRET}` } };
      readonly response: { body: { messages: string[] }; self?: unknown } = {
        body: { messages: [`token ${SECRET} was rejected`] },
      };
    }
    const error = new HttpError('request failed');
    error.response.self = error.response;

    const redaction = redactErrorInPlace(redactor, error);

    expect(redaction.count, 'the header and the body line were both replaced').toBe(2);
    expect(error.config.headers.Authorization).toBe(`Bearer ${PLACEHOLDER}`);
    expect(error.response.body.messages[0]).toBe(`token ${PLACEHOLDER} was rejected`);
    // `JSON.stringify` would throw on the cycle; `util.inspect` prints it as `[Circular]`, and it
    // is the render a developer reads in a terminal.
    expect(inspect(error), 'nothing util.inspect prints still carries it').not.toContain(SECRET);
  });

  /** `AggregateError.errors` is non-enumerable, so only a walk that asks for it by name finds it. */
  it('walks the errors of an AggregateError, as pino’s aggregateErrors does', () => {
    const error = new AggregateError(
      [new Error(`first ${SECRET}`), new Error(`second ${SECRET}`)],
      'batch failed',
    );

    const redaction = redactErrorInPlace(redactor, error);

    expect(redaction.count, 'two messages and two stacks').toBeGreaterThanOrEqual(2);
    expect(error.errors[0]?.message).toBe(`first ${PLACEHOLDER}`);
    expect(error.errors[1]?.message).toBe(`second ${PLACEHOLDER}`);
  });

  it('reports a refusal rather than counting a write that did not happen', () => {
    const error = new Error('opaque');
    Object.defineProperty(error, 'detail', {
      enumerable: true,
      configurable: true,
      get: () => `token ${SECRET}`,
    });

    const redaction = redactErrorInPlace(redactor, error);

    expect(redaction.count, 'a getter with no setter accepts nothing').toBe(0);
    expect(redaction.blocked, 'and the refusal is counted, not swallowed').toBe(1);
  });

  it('scrubs what a frozen error still allows, and reports what it refused', () => {
    const frozen = Object.freeze(new Error(`frozen ${SECRET}`));

    // `message` is an own data property and freezing seals it; `stack` is an accessor in V8, so
    // `Object.freeze` does not seal it and the write goes through. Both are asserted because the
    // count must report what was written, not what was attempted.
    expect(redactErrorInPlace(redactor, frozen), 'only the stack could be written').toEqual({
      count: 1,
      blocked: 1,
    });
    expect(frozen.message, 'a sealed message is left as it was').toContain(SECRET);
    expect(String(frozen.stack), 'the stack is not sealed by freeze in V8').not.toContain(SECRET);
    // The documented limitation, asserted so it cannot be quietly fixed or quietly widened:
    // `String(err)` reads `name` and `message`, and the message is the one that was refused.
    expect(String(frozen), 'String(frozenError) is the one route the scrub cannot close').toContain(
      SECRET,
    );
  });

  /**
   * The second documented limitation. A `Map` value is not walked, because there is no in-place
   * write that preserves iteration order for every exotic collection; the reason it is tolerable
   * is that pino serialises a `Map` as `{}` — asserted against the real serialiser in
   * `apps/server/src/logging.test.ts`, not assumed here.
   */
  it('does not walk into a Map, and says so', () => {
    const error = Object.assign(new Error('opaque'), {
      cache: new Map([['authorization', `Bearer ${SECRET}`]]),
    });

    expect(redactErrorInPlace(redactor, error)).toEqual({ count: 0, blocked: 0 });
    expect(error.cache.get('authorization'), 'a Map value is left as it was').toContain(SECRET);
  });

  it('does nothing for a value that is not an error', () => {
    expect(redactErrorInPlace(redactor, `plain ${SECRET}`)).toEqual({ count: 0, blocked: 0 });
  });
});
