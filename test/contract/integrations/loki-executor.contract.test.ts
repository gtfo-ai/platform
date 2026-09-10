/**
 * The Loki adapter driven **through** `IntegrationActionExecutor` (technical/06 § "Outbound:
 * actions").
 *
 * The `ObservabilityLogs` port has **no mutating method** — every call is a read — so the shadow
 * assertion this file can make is the mirror image of the Sentry one, and it is worth making
 * rather than skipping: a read is performed **in every mode**, including `shadow`, because shadow
 * mode suppresses side effects and reading a log changes nothing. A provider or a call site that
 * marked a read as `mutating` would silently stop feeding a shadow task's Investigation context,
 * which is the failure product/12's ShadowReport exists to avoid.
 *
 * The rate-limit half is the other direction: a `429` arrives as `IntegrationRateLimitedError` and
 * is waited out on the executor's injected timer, never on a wall clock.
 */
import {
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  type MemoryIntegrationAuditLog,
  noSecretsRedactor,
  type VirtualTimer,
} from '@platform/application';
import { fixedClock } from '@platform/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadReplayFixture, type ReplayInteraction } from '../support/integrations/http-replay.js';
import {
  LOKI_CLOCK_AT,
  LOKI_FIXTURES,
  LOKI_SELECTOR,
  LOKI_WINDOW,
  type LokiReplayContext,
  lokiReplayContext,
} from '../support/integrations/loki-harness.js';

const PROJECT_ID = '00000000-0000-4000-8000-0000000000b7';
const TASK_ID = '00000000-0000-4000-8000-0000000000c7';
const QUERY_KEY =
  'GET /query_range?direction=backward&end=1780308000000000000&limit=100&query={app="api", env="production"}&start=1780304400000000000';

const recorded = (predicate: (interaction: ReplayInteraction) => boolean): ReplayInteraction => {
  const found = loadReplayFixture(LOKI_FIXTURES, 'query-range').filter(predicate)[0];
  if (found === undefined) {
    throw new Error('the recorded interaction this test needs is missing from the corpus');
  }
  return found;
};

describe('Loki through IntegrationActionExecutor', () => {
  let auditLog: MemoryIntegrationAuditLog;
  let timer: VirtualTimer;

  beforeEach(() => {
    auditLog = createMemoryAuditLog();
    timer = createVirtualTimer({ autoAdvance: true });
  });

  const executor = () =>
    createIntegrationActionExecutor({
      auditLog,
      redactor: noSecretsRedactor(),
      timer,
      clock: fixedClock(LOKI_CLOCK_AT),
      rateLimits: { capacity: 100, refillPerSecond: 100, maxConcurrent: 4 },
    });

  const queryRequest = (context: LokiReplayContext) => ({
    integration: context.port.ref,
    action: 'query_range',
    mutating: false as const,
    payload: { selector: LOKI_SELECTOR, from: LOKI_WINDOW.from, to: LOKI_WINDOW.to },
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    perform: async () => {
      const result = await context.port.queryRange({
        selector: LOKI_SELECTOR,
        from: LOKI_WINDOW.from,
        to: LOKI_WINDOW.to,
        limit: 100,
      });
      return { line_count: result.line_count, truncated: result.truncated };
    },
  });

  it('performs the read and records it', async () => {
    const context = lokiReplayContext();

    const outcome = await executor().execute(queryRequest(context));

    expect(outcome.status).toBe('ok');
    expect(outcome.result.line_count).toBe(3);
    expect(context.replay.requests.map((request) => request.key)).toEqual([QUERY_KEY]);
    expect(auditLog.entries.map((entry) => entry.status)).toEqual(['ok']);
  });

  it('performs the read in shadow mode too, because a read has no side effect', async () => {
    const context = lokiReplayContext();

    const outcome = await executor().execute({ ...queryRequest(context), mode: 'shadow' });

    expect(
      outcome.status,
      'a shadow task still gets its log excerpt; shadow mode suppresses writes, not reads',
    ).toBe('ok');
    expect(context.replay.requests.map((request) => request.key)).toEqual([QUERY_KEY]);
  });

  it('waits the Retry-After on the executor timer and retries', async () => {
    const context = lokiReplayContext();
    const rateLimited = recorded(
      (interaction) => interaction.status === 429 && interaction.variant === 'rate-limited',
    );
    const success = recorded(
      (interaction) =>
        interaction.status === 200 && interaction.path.includes('limit=100&direction'),
    );
    context.replay.script([{ ...rateLimited, variant: undefined }, success]);

    const outcome = await executor().execute(queryRequest(context));

    expect(outcome.status).toBe('ok');
    expect(outcome.attempts, 'one refusal plus one success').toBe(2);
    expect(timer.sleeps, 'waited exactly what the 429 asked for, in milliseconds').toEqual([2000]);
    expect(
      context.replay.requests.map((request) => request.key),
      'the adapter itself was entered twice, so the 429 came from a provider and not a lambda',
    ).toEqual([QUERY_KEY, QUERY_KEY]);
    expect(auditLog.entries[0]?.attempts).toBe(2);
  });

  it('never puts the bearer token in the audit row or in the event (BD-002, TD-012)', async () => {
    const context = lokiReplayContext();

    await executor().execute(queryRequest(context));

    expect(
      JSON.stringify(auditLog.entries),
      'the audit row must not carry the token',
    ).not.toContain('FAKE-loki-bearer-token');
    expect(JSON.stringify(auditLog.events), 'nor may the event').not.toContain(
      'FAKE-loki-bearer-token',
    );
  });
});
