/**
 * The Sentry adapter driven **through** `IntegrationActionExecutor` (technical/06 § "Outbound:
 * actions").
 *
 * This file exists because of an obligation the executor's own docblock puts on the provider work
 * packages, verbatim:
 *
 * > a port method that changes provider state must be asserted to reach the executor as a
 * > `MutatingActionRequest`, by running it in shadow mode and asserting the provider was not
 * > entered.
 *
 * `resolve` is the one mutating method this port has — Sentry publishes no comment and no
 * merge-request-link endpoint (Q43) — so it is the whole of the shadow assertion, and "not
 * entered" is the strongest form available for a real adapter: **zero HTTP requests**, observed on
 * the transport the adapter was given.
 *
 * The rate-limit half proves the other direction: Sentry's documented `429` with `Retry-After`
 * arrives as an `IntegrationRateLimitedError` and is waited out on the executor's injected timer,
 * never on a wall clock.
 */
import {
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  type IntegrationActionRequest,
  type MemoryIntegrationAuditLog,
  noSecretsRedactor,
  type VirtualTimer,
} from '@platform/application';
import type { JsonObject, TaskMode } from '@platform/contracts';
import { fixedClock } from '@platform/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadReplayFixture, type ReplayInteraction } from '../support/integrations/http-replay.js';
import {
  SENTRY_CLOCK_AT,
  SENTRY_FIXTURES,
  SENTRY_ISSUE_ID,
  SENTRY_PROJECT,
  type SentryReplayContext,
  sentryReplayContext,
} from '../support/integrations/sentry-harness.js';

const PROJECT_ID = '00000000-0000-4000-8000-0000000000b6';
const TASK_ID = '00000000-0000-4000-8000-0000000000c6';
const PUT_KEY = `PUT /organizations/acme-example/issues/${SENTRY_ISSUE_ID}/`;
const GET_KEY = `GET /organizations/acme-example/issues/${SENTRY_ISSUE_ID}/`;
const SEARCH_KEY =
  'GET /projects/acme-example/api/issues/?limit=25&query=is:unresolved&statsPeriod=';

/** The recorded documents, taken from the corpus rather than restated, so this file cannot drift. */
const recorded = (predicate: (interaction: ReplayInteraction) => boolean): ReplayInteraction => {
  const found = ['issues', 'issue-search'].flatMap((name) =>
    loadReplayFixture(SENTRY_FIXTURES, name).filter(predicate),
  )[0];
  if (found === undefined) {
    throw new Error('the recorded interaction this test needs is missing from the corpus');
  }
  return found;
};

describe('Sentry through IntegrationActionExecutor', () => {
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
      clock: fixedClock(SENTRY_CLOCK_AT),
      rateLimits: { capacity: 100, refillPerSecond: 100, maxConcurrent: 4 },
    });

  const resolveRequest = (
    context: SentryReplayContext,
    mode: TaskMode,
  ): IntegrationActionRequest<JsonObject> => ({
    integration: context.port.ref,
    action: 'resolve_issue',
    mutating: true,
    mode,
    payload: { issue_id: SENTRY_ISSUE_ID, in_release: '2026.06.2' },
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    perform: async () => {
      const issue = await context.port.resolve({ id: SENTRY_ISSUE_ID }, { inRelease: '2026.06.2' });
      return { status: issue.status };
    },
    shadowResult: () => ({ would_have: 'resolve_issue' }),
    describeResult: (result) => result,
  });

  it('performs the mutation in normal mode: one PUT, then the re-read', async () => {
    const context = sentryReplayContext();

    const outcome = await executor().execute(resolveRequest(context, 'normal'));

    expect(outcome.status).toBe('ok');
    expect(
      context.replay.requests.map((request) => request.key),
      'the write, and the read that substantiates it — the PUT body is undocumented',
    ).toEqual([PUT_KEY, GET_KEY]);
    expect(auditLog.entries.map((entry) => entry.status)).toEqual(['ok']);
  });

  it('records would_have in shadow mode and issues no HTTP request at all', async () => {
    const context = sentryReplayContext();

    const outcome = await executor().execute(resolveRequest(context, 'shadow'));

    expect(outcome.status, 'a mutating action in shadow mode is never performed').toBe(
      'would_have',
    );
    expect(
      context.replay.requests,
      'shadow mode reached no Sentry endpoint, not even the re-read',
    ).toEqual([]);
    expect(auditLog.entries.map((entry) => entry.status)).toEqual(['would_have']);
    expect(auditLog.events, 'nothing was performed, so nothing is announced').toEqual([]);
  });

  it("waits Sentry's documented Retry-After on the executor's timer and retries", async () => {
    const context = sentryReplayContext();
    const rateLimited = recorded(
      (interaction) => interaction.status === 429 && interaction.variant === 'rate-limited',
    );
    const success = recorded(
      (interaction) =>
        interaction.method === 'GET' &&
        interaction.status === 200 &&
        interaction.path.startsWith('/projects/'),
    );
    // A sequence for one key: the documented 429, then the documented 200.
    context.replay.script([{ ...rateLimited, variant: undefined }, success]);

    const outcome = await executor().execute({
      integration: context.port.ref,
      action: 'search_issues',
      mutating: false,
      payload: { project: SENTRY_PROJECT, query: 'is:unresolved' },
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      perform: async () => {
        const issues = await context.port.searchIssues({
          project: SENTRY_PROJECT,
          query: 'is:unresolved',
        });
        return { count: issues.length };
      },
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.attempts, 'one refusal plus one success').toBe(2);
    expect(timer.sleeps, 'waited exactly what Sentry asked for, in milliseconds').toEqual([2000]);
    expect(
      context.replay.requests.map((request) => request.key),
      'the adapter itself was entered twice, so the 429 came from a provider and not a lambda',
    ).toEqual([SEARCH_KEY, SEARCH_KEY]);
    expect(auditLog.entries[0]?.attempts).toBe(2);
  });

  it('never puts the binding token in the audit row or in the event (BD-002, TD-012)', async () => {
    const context = sentryReplayContext();

    await executor().execute(resolveRequest(context, 'normal'));

    expect(
      JSON.stringify(auditLog.entries),
      'the audit row must not carry the token',
    ).not.toContain('FAKE-sentry-auth-token');
    expect(JSON.stringify(auditLog.events), 'nor may the event').not.toContain(
      'FAKE-sentry-auth-token',
    );
  });
});
