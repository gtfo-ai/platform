/**
 * The bug pre-fetch (WP-89) against hand-written port doubles — this ring may not import the
 * fakes in `@platform/integrations`, and the fakes' own behaviour is held by the shared contract
 * suites. What is held here is the pre-fetch's own logic: which stage, which binding, which issue,
 * what the prompt is told when something is missing, the redaction, the audit rows, and the one
 * error it must never absorb.
 */
import type { Id, IsoDateTime, TicketSnapshot } from '@platform/contracts';
import type { PipelineStage } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { TransactionOpenError, withOpenTransaction } from '../events/open-transaction.js';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { allowAnyIntegrationHost } from '../integrations/egress.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { IntegrationRef } from '../ports/integrations/common.js';
import type {
  ErrorEvent,
  Issue,
  ObservabilityErrorsPort,
} from '../ports/integrations/observability-errors.js';
import type {
  LogQueryResult,
  LogRangeQuery,
  ObservabilityLogsPort,
} from '../ports/integrations/observability-logs.js';
import { createMemoryAuditLog, createVirtualTimer } from '../testing/memory-integrations.js';
import type { ObservabilityPortByType, PipelineIntegrationsPort } from './integrations.js';
import {
  LOG_EXCERPT_LINES,
  LOG_EXCERPT_WINDOW_MS,
  prefetchObservability,
} from './observability-prefetch.js';
import type { StoredTask } from './store.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const ERRORS_ID = '00000000-0000-4000-8000-0000000000e1' as Id;
const LOGS_ID = '00000000-0000-4000-8000-0000000000f1' as Id;
/** Obviously fake, planted in the stack trace; the binding's redactor knows it. */
const PLANTED = 'FAKE-planted-sentry-token-0123456789';
const LINK = 'https://errors.example.test/issues/42';
const EVENT_AT = '2026-06-01T09:11:00.000Z';

const stored = { task: { id: TASK, projectId: PROJECT } } as unknown as StoredTask;
const investigation = { id: 'investigation', kind: 'agent', role: 'investigator' } as PipelineStage;
const architecture = { id: 'architecture', kind: 'agent', role: 'architect' } as PipelineStage;

const snapshotWith = (description: string): TicketSnapshot => ({
  title: 'The footer sums the wrong rows',
  description,
  comments: [],
  truncated: false,
  comment_count: 0,
  redaction_count: 0,
  ticket_updated_at: null,
});

const ISSUE: Issue = {
  ref: { provider: 'double', id: '42', short_id: 'ACME-1AB', url: LINK },
  project: 'api',
  title: 'TypeError: cannot read totals of undefined',
  culprit: 'src/billing/totals.ts',
  level: 'error',
  status: 'unresolved',
  first_seen: '2026-05-30T08:00:00.000Z',
  last_seen: EVENT_AT,
  count: 137,
  user_count: 12,
  assigned_to: null,
};

const eventWith = (correlation: Record<string, string>): ErrorEvent => ({
  event_id: 'ev-1',
  issue_id: '42',
  timestamp: EVENT_AT,
  stack_trace: `TypeError: cannot read totals of undefined\n    at total (src/billing/totals.ts:42:11) ${PLANTED}`,
  message: 'cannot read totals of undefined',
  breadcrumbs: [
    { timestamp: EVENT_AT, category: 'http', level: 'info', message: 'GET /invoices/42' },
  ],
  tags: { release: '2026.06.1' },
  release: '2026.06.1',
  environment: 'production',
  correlation_ids: correlation,
});

const ref = (integrationId: Id, type: 'errors' | 'logs'): IntegrationRef => ({
  integrationId,
  provider: `double-${type}`,
  type,
  host: null,
});

interface Doubles {
  readonly event?: ErrorEvent | null;
  readonly issueError?: Error;
  readonly selector?: string | null;
  readonly logs?: LogQueryResult;
  readonly maxRangeMs?: number;
  readonly maxLines?: number;
}

const errorsPort = (doubles: Doubles, calls: string[]): ObservabilityErrorsPort =>
  ({
    ref: ref(ERRORS_ID, 'errors'),
    // The double's own link rule: exactly LINK. The shared suite holds the real ones.
    linkedIssues: (text: string) => (text.includes(LINK) ? [{ id: '42' }] : []),
    getIssue: async () => {
      calls.push('get_issue');
      if (doubles.issueError !== undefined) throw doubles.issueError;
      return ISSUE;
    },
    getLatestEvent: async () => {
      calls.push('get_latest_event');
      return doubles.event === undefined ? eventWith({ trace_id: 'trace-abc' }) : doubles.event;
    },
  }) as unknown as ObservabilityErrorsPort;

const logsPort = (doubles: Doubles, queries: LogRangeQuery[]): ObservabilityLogsPort =>
  ({
    ref: ref(LOGS_ID, 'logs'),
    capabilities: () => ({
      labels: true,
      series: true,
      maxRangeMs: doubles.maxRangeMs ?? 24 * 60 * 60 * 1000,
      maxLines: doubles.maxLines ?? 1000,
    }),
    excerptSelector: () => (doubles.selector === undefined ? '{app="api"}' : doubles.selector),
    queryRange: async (query: LogRangeQuery) => {
      queries.push(query);
      return (
        doubles.logs ?? {
          streams: [
            {
              labels: { app: 'api' },
              lines: [
                { timestamp: '2026-06-01T09:12:00.000Z', line: 'later line trace-abc', labels: {} },
                {
                  timestamp: '2026-06-01T09:10:00.000Z',
                  line: 'earlier line trace-abc',
                  labels: {},
                },
              ],
            },
          ],
          line_count: 2,
          truncated: false,
        }
      );
    },
  }) as unknown as ObservabilityLogsPort;

type Binding = 'present' | 'absent' | Error;

const harness = (bindings: { errors?: Binding; logs?: Binding }, doubles: Doubles = {}) => {
  const audit = createMemoryAuditLog();
  const executor = createIntegrationActionExecutor({
    egress: allowAnyIntegrationHost(),
    auditLog: audit,
    redactor: exactSecretRedactor([]),
    timer: createVirtualTimer({ autoAdvance: true }),
    clock: { now: () => '2026-06-01T10:00:00.000Z' as IsoDateTime },
  });
  const calls: string[] = [];
  const queries: LogRangeQuery[] = [];
  const resolutions: string[] = [];
  const redactor = exactSecretRedactor([{ name: 'errors:binding:auth_token', value: PLANTED }]);
  const ports: ObservabilityPortByType = {
    errors: errorsPort(doubles, calls),
    logs: logsPort(doubles, queries),
  };
  const integrations = {
    forProject: async () => {
      throw new Error('the pre-fetch must not resolve the pipeline’s bindings');
    },
    forMintingIntegration: async () => null,
    forProposedTaskManagement: async () => {
      throw new Error('the pre-fetch must not build a proposed binding');
    },
    forObservability: async (_projectId: Id, type: 'errors' | 'logs') => {
      resolutions.push(type);
      const binding = bindings[type] ?? 'absent';
      if (binding instanceof Error) throw binding;
      if (binding === 'absent') return null;
      return { executor, port: ports[type], ref: ports[type].ref, redactor };
    },
  } as unknown as PipelineIntegrationsPort;
  const warnings: string[] = [];
  const logger = {
    warn: (_fields: unknown, message: string) => warnings.push(message),
    info: () => {},
    debug: () => {},
    error: () => {},
    child: () => logger,
  };
  return {
    audit,
    calls,
    queries,
    resolutions,
    warnings,
    run: (stage = investigation, snapshot: TicketSnapshot | null = snapshotWith(`See ${LINK}`)) =>
      prefetchObservability({ integrations, logger: logger as never }, stored, stage, snapshot),
  };
};

describe('which runs get the pre-fetch', () => {
  it('is only the Investigator’s — another stage resolves nothing', async () => {
    const world = harness({ errors: 'present', logs: 'present' });
    expect(await world.run(architecture)).toBeUndefined();
    expect(world.resolutions).toEqual([]);
  });

  it('adds nothing for a project with neither binding, so its prompt is unchanged', async () => {
    const world = harness({});
    expect(await world.run()).toBeUndefined();
    expect(world.resolutions).toEqual(['errors', 'logs']);
    expect(world.calls).toEqual([]);
  });
});

describe('the linked issue', () => {
  it('reads the issue and its latest event through the executor, redacted, with the link count', async () => {
    const world = harness({ errors: 'present' });
    const [event, ...rest] = (await world.run()) ?? [];
    expect(rest).toEqual([]);
    expect(event).toMatchObject({ kind: 'error_event', status: 'read', issueLinks: 1 });
    expect(event?.body).toContain('at total (src/billing/totals.ts:42:11)');
    expect(event?.body).toContain('users: 12');
    expect(event?.body).toContain('GET /invoices/42');
    // The binding's redactor ran over what the executor handed back unredacted (standing rule 13).
    expect(event?.body).not.toContain(PLANTED);
    expect(event?.body).toContain('[REDACTED');
    // Two audited reads, attributed to the binding, the project and the task.
    expect(world.audit.entries.map((entry) => entry.action)).toEqual([
      'get_issue',
      'get_latest_event',
    ]);
    for (const entry of world.audit.entries) {
      expect(entry).toMatchObject({
        integrationId: ERRORS_ID,
        projectId: PROJECT,
        taskId: TASK,
        mutating: false,
        status: 'ok',
      });
    }
  });

  it('says the issue has no event rather than inventing one', async () => {
    const world = harness({ errors: 'present' }, { event: null });
    const [event] = (await world.run()) ?? [];
    expect(event?.status).toBe('read');
    expect(event?.body).toContain('latest event: none');
  });

  it.each([
    ['a ticket with no link', snapshotWith('no link here'), 'no_issue_link', 0],
    ['a ticket the platform has not read', null, 'no_ticket_text', undefined],
  ])('makes no provider call for %s, and says why', async (_name, snapshot, status, links) => {
    const world = harness({ errors: 'present' });
    const [event] = (await world.run(investigation, snapshot)) ?? [];
    expect(event).toEqual({
      kind: 'error_event',
      status,
      body: '',
      ...(links === undefined ? {} : { issueLinks: links }),
    });
    expect(world.calls).toEqual([]);
  });
});

describe('failure is advisory (standing rule 20)', () => {
  it('runs on without the event when the provider refuses, and logs it', async () => {
    const world = harness(
      { errors: 'present' },
      { issueError: new Error('503 from the provider') },
    );
    const [event] = (await world.run()) ?? [];
    expect(event).toEqual({ kind: 'error_event', status: 'unavailable', body: '', issueLinks: 1 });
    expect(world.warnings).toHaveLength(1);
  });

  it('marks a binding that will not load unavailable, and still reads the other one', async () => {
    const world = harness({
      errors: new Error('the credential will not decrypt'),
      logs: 'present',
    });
    const excerpts = (await world.run()) ?? [];
    expect(excerpts.map((excerpt) => [excerpt.kind, excerpt.status])).toEqual([
      ['error_event', 'unavailable'],
      // No event was read, so there is no instant to read the logs around.
      ['log_excerpt', 'no_event'],
    ]);
    expect(world.warnings).toHaveLength(1);
  });

  it('rethrows TransactionOpenError — a moved call, never a provider being down', async () => {
    const world = harness({ errors: 'present' });
    await expect(withOpenTransaction(() => world.run())).rejects.toBeInstanceOf(
      TransactionOpenError,
    );
  });
});

describe('the log excerpt', () => {
  it('reads the window around the event, filtered by the trace id, oldest line first', async () => {
    const world = harness({ errors: 'present', logs: 'present' });
    const [, logs] = (await world.run()) ?? [];
    expect(world.queries).toEqual([
      {
        selector: '{app="api"}',
        filter: 'trace-abc',
        from: new Date(Date.parse(EVENT_AT) - LOG_EXCERPT_WINDOW_MS).toISOString(),
        to: new Date(Date.parse(EVENT_AT) + LOG_EXCERPT_WINDOW_MS).toISOString(),
        limit: LOG_EXCERPT_LINES,
      },
    ]);
    expect(logs).toMatchObject({
      kind: 'log_excerpt',
      status: 'read',
      lines: 2,
      limitReached: false,
    });
    const body = logs?.body ?? '';
    expect(body.indexOf('earlier line')).toBeLessThan(body.indexOf('later line'));
    expect(world.audit.entriesFor('query_range')[0]).toMatchObject({ integrationId: LOGS_ID });
  });

  it('stays inside the binding’s caps on both axes', async () => {
    const world = harness(
      { errors: 'present', logs: 'present' },
      { maxRangeMs: 60_000, maxLines: 10 },
    );
    await world.run();
    const [query] = world.queries;
    expect(Date.parse(query?.to ?? '') - Date.parse(query?.from ?? '')).toBe(60_000);
    expect(query?.limit).toBe(10);
  });

  it.each([
    ['a binding that names no selector', { selector: null }, 'not_configured'],
    ['an event with no trace or request id', { event: eventWith({}) }, 'no_correlation_id'],
  ] as const)('queries nothing for %s, and says why', async (_name, doubles, status) => {
    const world = harness({ errors: 'present', logs: 'present' }, doubles);
    const [, logs] = (await world.run()) ?? [];
    expect(logs).toEqual({ kind: 'log_excerpt', status, body: '' });
    expect(world.queries).toEqual([]);
  });

  it('falls back to the request id, and reports a provider that hit the limit', async () => {
    const world = harness(
      { errors: 'present', logs: 'present' },
      {
        event: eventWith({ request_id: 'req-42' }),
        logs: { streams: [], line_count: 0, truncated: true },
      },
    );
    const [, logs] = (await world.run()) ?? [];
    expect(world.queries[0]?.filter).toBe('req-42');
    expect(logs).toMatchObject({ status: 'read', lines: 0, limitReached: true });
  });
});
