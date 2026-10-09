/**
 * The ticket lifecycle's Jira half (WP-172, research/15 J1, J3, J4, J5, J6): the pure decisions —
 * the union of J1's per-issue-type lists, J3's transitions, J5's window — and the adapter's
 * read-then-write split of the claim, against a transport scripted inline.
 *
 * The fixture-replay runner (`test/contract/integrations/jira-cloud.contract.test.ts`) holds the
 * shared contract; this file holds the cases a replay makes awkward to isolate: a `403`, a page
 * shaped exactly at the window's edge, and a ticket somebody else holds where the only thing that
 * may happen is a read. Every status name here is invented and neutral (BD-031).
 */
import {
  allowAnyIntegrationHost,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  IntegrationError,
  type MemoryIntegrationAuditLog,
  noSecretsRedactor,
  type TaskManagementPort,
} from '@platform/application';
import {
  MAX_LIFECYCLE_STATUS_NAME_CHARS,
  MAX_TICKET_STATUSES,
  type TaskMode,
} from '@platform/contracts';
import { fixedClock } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import {
  assignRefusal,
  commentWindow,
  createJiraCloudTaskManagement,
  MAX_RECORDED_CATEGORY_CONFLICTS,
  toTicketTransitions,
  unionJiraStatuses,
} from './index.js';
import type { JiraComment, JiraStatus } from './mapping.js';

const SITE = 'https://acme-example.atlassian.net';
const KEY = 'ACME-7';
const REF = { provider: 'jira-cloud', key: KEY, url: `${SITE}/browse/${KEY}` } as const;
const NOW = '2026-10-08T10:00:00.000Z';
const SELF = '557058:00000000-0000-4000-8000-0000000b0701';
const SOMEONE = '557058:00000000-0000-4000-8000-00000000d0c1';

const status = (id: string, name: string, key?: string): JiraStatus => ({
  id,
  name,
  ...(key === undefined ? {} : { statusCategory: { key } }),
});

describe('unionJiraStatuses (WP-172 ruling (a), criterion 3)', () => {
  it('answers a status shared by two issue types once, in its first spelling', () => {
    const union = unionJiraStatuses([
      [status('1', 'Doing', 'indeterminate'), status('2', 'Done', 'done')],
      [status('1', 'doing ', 'indeterminate'), status('3', 'Testing', 'indeterminate')],
    ]);
    expect(union.statuses.map((entry) => entry.name)).toEqual(['Doing', 'Done', 'Testing']);
    expect(union.statuses[0]).toEqual({
      id: '1',
      name: 'Doing',
      category: 'in_progress',
      raw_category: 'indeterminate',
    });
    expect(union.conflicts).toEqual([]);
    expect(union.skipped).toBe(0);
  });

  it('keeps the first category of a name seen with two, and reports the second', () => {
    const union = unionJiraStatuses([
      [status('5', 'Waiting for review', 'indeterminate')],
      [status('6', 'Waiting for review', 'new')],
    ]);
    expect(union.statuses).toEqual([
      {
        id: '5',
        name: 'Waiting for review',
        category: 'in_progress',
        raw_category: 'indeterminate',
      },
    ]);
    expect(union.conflicts).toEqual([
      { name: 'Waiting for review', kept: 'indeterminate', ignored: 'new' },
    ]);
  });

  it('normalises an absent or unknown key to unknown and keeps the raw key', () => {
    const union = unionJiraStatuses([[status('7', 'Sent back'), status('8', 'Testing', 'DONE')]]);
    expect(union.statuses.map((entry) => [entry.category, entry.raw_category])).toEqual([
      ['unknown', null],
      ['unknown', 'DONE'],
    ]);
  });

  it('skips and counts a status the port cannot carry, never inventing a name or an id', () => {
    const union = unionJiraStatuses([
      [
        { name: 'No id' },
        { id: '9' },
        status('10', 'x'.repeat(MAX_LIFECYCLE_STATUS_NAME_CHARS + 1)),
        status('11', 'Done', 'done'),
      ],
    ]);
    expect(union.statuses.map((entry) => entry.name)).toEqual(['Done']);
    expect(union.skipped).toBe(3);
  });
});

/** `count` distinct invented names, each with the given category key. */
const named = (count: number, key: string, offset = 0): JiraStatus[] =>
  Array.from({ length: count }, (_, index) =>
    status(String(offset + index), `Status ${offset + index}`, key),
  );

describe('unionJiraStatuses is bounded at MAX_TICKET_STATUSES (WP-181 criterion (7))', () => {
  it('answers exactly the bound, and stops with overflow one past it', () => {
    const at = unionJiraStatuses([named(MAX_TICKET_STATUSES, 'new')]);
    expect(at.statuses).toHaveLength(MAX_TICKET_STATUSES);
    expect(at.overflow).toBe(false);
    const past = unionJiraStatuses([named(MAX_TICKET_STATUSES + 1, 'new')]);
    expect(past.overflow).toBe(true);
    expect(past.statuses).toHaveLength(MAX_TICKET_STATUSES);
  });

  it('counts a repeated name once against the bound, whatever the issue type', () => {
    // A thousand issue types sharing one workflow are one status set, not a thousand.
    const groups = Array.from({ length: 3 }, () => named(MAX_TICKET_STATUSES, 'new'));
    const union = unionJiraStatuses(groups);
    expect(union.overflow).toBe(false);
    expect(union.statuses).toHaveLength(MAX_TICKET_STATUSES);
  });

  it('records a conflict once per name, so the conflicts are bounded by the names: at the bound and past it', () => {
    // Every name conflicts in every later issue type: before WP-181 that was one conflict per
    // repetition, so the list grew with the issue types rather than with the names.
    const atBound = unionJiraStatuses([
      named(MAX_TICKET_STATUSES, 'new'),
      named(MAX_TICKET_STATUSES, 'done'),
      named(MAX_TICKET_STATUSES, 'indeterminate'),
    ]);
    expect(atBound.overflow).toBe(false);
    expect(atBound.conflicts).toHaveLength(MAX_TICKET_STATUSES);
    const pastBound = unionJiraStatuses([
      named(MAX_TICKET_STATUSES, 'new'),
      named(MAX_TICKET_STATUSES, 'done'),
      named(1, 'new', MAX_TICKET_STATUSES),
      named(MAX_TICKET_STATUSES, 'indeterminate'),
    ]);
    expect(pastBound.overflow).toBe(true);
    expect(pastBound.conflicts.length).toBeLessThanOrEqual(MAX_TICKET_STATUSES);
  });
});

describe('toTicketTransitions (research/15 J3)', () => {
  it('maps the target status and its category, and drops an unavailable or unnamed move', () => {
    const mapped = toTicketTransitions([
      { id: '51', name: 'Pick it up', to: { name: 'Doing', statusCategory: { key: 'in-flight' } } },
      {
        id: '61',
        name: 'Hand over',
        to: { name: 'Testing', statusCategory: { key: 'completed' } },
      },
      { id: '71', name: 'Send back', to: { name: 'Sent back' }, isAvailable: false },
      { id: '81', name: 'Nowhere', to: null },
    ]);
    expect(mapped.transitions).toEqual([
      { id: '51', name: 'Pick it up', to: { name: 'Doing', category: 'in_progress' } },
      { id: '61', name: 'Hand over', to: { name: 'Testing', category: 'unknown' } },
    ]);
    expect(mapped.skipped).toBe(1);
  });
});

const comment = (id: string, created: string): JiraComment => ({ id, created, body: undefined });

describe('commentWindow (research/15 J5)', () => {
  it('keeps comments created strictly after the horizon, newest first', () => {
    const window = commentWindow(
      [
        comment('3', '2026-10-08T09:03:00.000Z'),
        comment('1', '2026-10-08T09:01:00.000Z'),
        comment('2', '2026-10-08T09:02:00.000Z'),
      ],
      '2026-10-08T09:01:00.000Z',
    );
    expect(window.map((entry) => entry.id)).toEqual(['3', '2']);
  });

  it('keeps everything when there is no horizon', () => {
    expect(commentWindow([comment('1', '2026-10-08T09:01:00.000Z')], null)).toHaveLength(1);
  });
});

describe('assignRefusal (WP-172 ruling (d))', () => {
  it('names the Assign Issues permission on a 403, keeping Jira’s detail', () => {
    const refused = assignRefusal(
      new IntegrationError('forbidden', 'jira-cloud', 'HTTP 403: no', { action: 'x' }),
      KEY,
      'assign_to_self',
    ) as IntegrationError;
    expect(refused.code).toBe('forbidden');
    expect(refused.action).toBe('assign_to_self');
    expect(refused.message).toContain('Assign Issues');
    expect(refused.message).toContain('HTTP 403: no');
  });

  it('passes any other failure through untouched', () => {
    const other = new IntegrationError('not_found', 'jira-cloud', 'HTTP 404', {});
    expect(assignRefusal(other, KEY, 'unassign')).toBe(other);
  });
});

// ── The adapter, against a transport scripted inline ─────────────────────────────

interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

type Answer = (call: Call) => Response;

const json = (body: unknown, status = 200): Response =>
  new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const MYSELF = { accountId: SELF, displayName: 'Agentic Platform' };

const adapter = (
  answers: Record<string, Answer>,
  options: { readonly mode?: TaskMode; readonly projectKeys?: readonly string[] } = {},
): { port: TaskManagementPort; calls: Call[]; audit: MemoryIntegrationAuditLog } => {
  const calls: Call[] = [];
  const audit = createMemoryAuditLog();
  const clock = fixedClock(NOW, 0);
  const port = createJiraCloudTaskManagement({
    integrationId: '00000000-0000-4000-8000-0000000001c2',
    config: {
      site_url: SITE,
      user_email: 'agentic-bot@example.test',
      api_token: 'FAKE-jira-api-token-0123456789',
      project_keys: [...(options.projectKeys ?? ['ACME'])],
    } as never,
    executor: createIntegrationActionExecutor({
      egress: allowAnyIntegrationHost(),
      auditLog: audit,
      redactor: noSecretsRedactor(),
      timer: createVirtualTimer({ autoAdvance: true }),
      clock,
      rateLimits: () => ({ capacity: 100, refillPerSecond: 100, maxConcurrent: 8 }),
    }),
    clock,
    actionContext: () => ({ mode: options.mode ?? 'normal', projectId: null, taskId: null }),
    redactor: noSecretsRedactor(),
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      const text = request.method === 'GET' ? '' : await request.text();
      const call: Call = {
        method: request.method,
        path: url.pathname.replace('/rest/api/3/', ''),
        query: url.searchParams,
        body: text.length === 0 ? undefined : JSON.parse(text),
      };
      calls.push(call);
      const answer = answers[`${call.method} ${call.path}`];
      return answer === undefined ? json({ errorMessages: ['unscripted'] }, 501) : answer(call);
    },
  });
  return { port, calls, audit };
};

const assignedTo = (accountId: string | null): Record<string, Answer> => ({
  'GET myself': () => json(MYSELF),
  [`GET issue/${KEY}`]: () =>
    json({
      id: '10007',
      key: KEY,
      // `fields=assignee` only: Jira returns the fields asked for, so no `updated` here.
      fields: { assignee: accountId === null ? null : { accountId } },
    }),
  [`PUT issue/${KEY}/assignee`]: () => new Response(null, { status: 204 }),
});

const puts = (calls: readonly Call[]): Call[] => calls.filter((call) => call.method === 'PUT');

describe('the claim’s read and write (WP-172 ruling (b))', () => {
  /**
   * Criterion 4. **Canary:** drop the assignee read from `unassign` (send the `PUT` whoever holds
   * the ticket) and this case fails on the `PUT` count.
   */
  it('unassign on a ticket somebody else holds sends no PUT', async () => {
    const { port, calls } = adapter(assignedTo(SOMEONE));
    await expect(port.unassign(REF)).resolves.toEqual({ changed: false });
    expect(puts(calls)).toEqual([]);
    expect(
      calls.some((call) => call.path === `issue/${KEY}` && call.query.get('fields') === 'assignee'),
      'the assignee was read',
    ).toBe(true);
  });

  it('unassign on an unassigned ticket sends no PUT either', async () => {
    const { port, calls } = adapter(assignedTo(null));
    await expect(port.unassign(REF)).resolves.toEqual({ changed: false });
    expect(puts(calls)).toEqual([]);
  });

  it('unassign on the binding’s own ticket sends accountId null', async () => {
    const { port, calls } = adapter(assignedTo(SELF));
    await expect(port.unassign(REF)).resolves.toEqual({ changed: true });
    expect(puts(calls).map((call) => [call.path, call.body])).toEqual([
      [`issue/${KEY}/assignee`, { accountId: null }],
    ]);
  });

  it('assignToSelf takes a ticket somebody else holds, and sends the binding’s own account', async () => {
    const { port, calls } = adapter(assignedTo(SOMEONE));
    const result = await port.assignToSelf(REF);
    expect(result.changed).toBe(true);
    expect(result.assignee.external_id).toBe(SELF);
    expect(puts(calls).map((call) => call.body)).toEqual([{ accountId: SELF }]);
  });

  it('assignToSelf on a ticket it already holds writes nothing', async () => {
    const { port, calls } = adapter(assignedTo(SELF));
    expect((await port.assignToSelf(REF)).changed).toBe(false);
    expect(puts(calls)).toEqual([]);
  });

  it('a shadow claim reads, records would_have, and sends no PUT (criterion 5)', async () => {
    const { port, calls, audit } = adapter(assignedTo(SOMEONE), { mode: 'shadow' });
    expect((await port.assignToSelf(REF)).changed).toBe(false);
    expect(puts(calls)).toEqual([]);
    expect(audit.entriesFor('assign_to_self').map((entry) => entry.status)).toEqual(['would_have']);
  });

  it('a 403 on the write is forbidden, naming the Assign Issues permission', async () => {
    const { port } = adapter({
      ...assignedTo(SOMEONE),
      [`PUT issue/${KEY}/assignee`]: () =>
        json({ errorMessages: ['You do not have permission to assign issues.'], errors: {} }, 403),
    });
    const error = await port.assignToSelf(REF).then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(IntegrationError);
    expect((error as IntegrationError).code).toBe('forbidden');
    expect((error as IntegrationError).message).toContain('Assign Issues');
  });

  it('refuses to claim when Jira will not say who the binding is', async () => {
    const { port, calls } = adapter({
      ...assignedTo(SOMEONE),
      'GET myself': () => json({ displayName: 'nameless' }),
    });
    await expect(port.assignToSelf(REF)).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(port.selfIdentity()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(puts(calls)).toEqual([]);
  });
});

const page = (count: number, newestAt: number): Record<string, unknown> => ({
  startAt: 0,
  maxResults: count,
  // Deliberately the page's own length (J5's "the number of items returned"): never read.
  total: count,
  comments: Array.from({ length: count }, (_, index) => ({
    id: String(100 + index),
    author: { accountId: SOMEONE },
    created: new Date(newestAt - index * 60_000).toISOString(),
  })),
});

describe('listComments’ total (WP-172 ruling (c))', () => {
  const at = Date.parse('2026-10-08T09:00:00.000Z');

  it('asks for the newest page of the limit, and a short page is the whole thread', async () => {
    const { port, calls } = adapter({ [`GET issue/${KEY}/comment`]: () => json(page(3, at)) });
    const answer = await port.listComments(REF, { limit: 5 });
    expect(answer.total).toBe(3);
    expect(calls[0]?.query.get('orderBy')).toBe('-created');
    expect(calls[0]?.query.get('maxResults')).toBe('5');
  });

  it('answers null for a full page of comments all inside the window', async () => {
    const { port } = adapter({ [`GET issue/${KEY}/comment`]: () => json(page(5, at)) });
    const answer = await port.listComments(REF, { limit: 5 });
    expect(answer.comments).toHaveLength(5);
    expect(answer.total).toBeNull();
  });

  it('answers the window’s length when the horizon falls inside a full page', async () => {
    const { port } = adapter({ [`GET issue/${KEY}/comment`]: () => json(page(5, at)) });
    const since = new Date(at - 2 * 60_000).toISOString();
    const answer = await port.listComments(REF, { since, limit: 5 });
    expect(answer.comments.map((entry) => entry.id)).toEqual(['100', '101']);
    expect(answer.total).toBe(2);
  });

  it('cuts a page longer than asked to the limit', async () => {
    const { port } = adapter({ [`GET issue/${KEY}/comment`]: () => json(page(8, at)) });
    const answer = await port.listComments(REF, { limit: 5 });
    expect(answer.comments).toHaveLength(5);
    expect(answer.total).toBeNull();
  });

  it('refuses a limit outside 1–100 before asking Jira', async () => {
    const { port, calls } = adapter({});
    await expect(port.listComments(REF, { limit: 0 })).rejects.toMatchObject({
      code: 'invalid_request',
      action: 'list_comments',
    });
    expect(calls).toEqual([]);
  });
});

describe('listStatuses (research/15 J1, never J2)', () => {
  const statuses = (names: readonly [string, string][]) => () =>
    json([
      {
        id: '10004',
        name: 'Task',
        statuses: names.map(([name, key], index) => ({
          id: String(20 + index),
          name,
          statusCategory: { key },
        })),
      },
    ]);

  it('unions the binding’s projects by name and asks J1 for each', async () => {
    const { port, calls, audit } = adapter(
      {
        'GET project/ACME/statuses': statuses([
          ['Doing', 'indeterminate'],
          ['Done', 'done'],
        ]),
        'GET project/BETA/statuses': statuses([
          ['Doing', 'new'],
          ['Testing', 'indeterminate'],
        ]),
      },
      { projectKeys: ['ACME', 'BETA'] },
    );
    const answer = await port.listStatuses();
    expect(answer.map((entry) => [entry.name, entry.category])).toEqual([
      ['Doing', 'in_progress'],
      ['Done', 'done'],
      ['Testing', 'in_progress'],
    ]);
    expect(calls.map((call) => call.path)).toEqual([
      'project/ACME/statuses',
      'project/BETA/statuses',
    ]);
    expect(audit.entriesFor('list_statuses')[0]?.result).toMatchObject({
      status_count: 3,
      category_conflicts: [{ name: 'Doing', kept: 'indeterminate', ignored: 'new' }],
    });
  });

  it('refuses a binding with no project to ask, rather than answering nothing', async () => {
    const { port, calls } = adapter({}, { projectKeys: [] });
    await expect(port.listStatuses()).rejects.toMatchObject({
      code: 'invalid_request',
      action: 'list_statuses',
    });
    expect(calls).toEqual([]);
  });

  it('names at most MAX_RECORDED_CATEGORY_CONFLICTS conflicts on the audit row', async () => {
    const many = MAX_RECORDED_CATEGORY_CONFLICTS + 5;
    const names = Array.from({ length: many }, (_, index) => `Status ${index}`);
    const { port, audit } = adapter(
      {
        'GET project/ACME/statuses': statuses(names.map((name) => [name, 'new'])),
        'GET project/BETA/statuses': statuses(names.map((name) => [name, 'done'])),
      },
      { projectKeys: ['ACME', 'BETA'] },
    );
    expect(await port.listStatuses()).toHaveLength(many);
    const row = audit.entriesFor('list_statuses')[0]?.result as {
      readonly category_conflicts: readonly unknown[];
    };
    expect(row.category_conflicts).toHaveLength(MAX_RECORDED_CATEGORY_CONFLICTS);
  });

  it('answers MAX_TICKET_STATUSES statuses, and refuses one more rather than cutting the list (WP-181 (7))', async () => {
    const names = (count: number) =>
      Array.from({ length: count }, (_, index): [string, string] => [`Status ${index}`, 'new']);
    const atBound = adapter({ 'GET project/ACME/statuses': statuses(names(MAX_TICKET_STATUSES)) });
    expect(await atBound.port.listStatuses()).toHaveLength(MAX_TICKET_STATUSES);
    const past = adapter({
      'GET project/ACME/statuses': statuses(names(MAX_TICKET_STATUSES + 1)),
    });
    await expect(past.port.listStatuses()).rejects.toMatchObject({
      code: 'invalid_response',
      action: 'list_statuses',
      message: expect.stringContaining(`more than ${MAX_TICKET_STATUSES} distinct statuses`),
    });
  });

  it('refuses a project that answers no status it can name', async () => {
    const { port } = adapter({ 'GET project/ACME/statuses': () => json([]) });
    await expect(port.listStatuses()).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
