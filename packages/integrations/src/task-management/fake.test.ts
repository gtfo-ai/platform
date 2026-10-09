/**
 * `FakeTaskManagement` beyond the contract suite.
 *
 * The contract suite asserts what *every* provider must do. This file asserts the claims the
 * fake's own divergence register makes — the strict query grammar, the loud unknown status, the
 * capability gate — because a register entry nothing exercises is a comment, not a guarantee.
 */
import { IntegrationError, IntegrationRateLimitedError } from '@platform/application';
import { MAX_TICKET_STATUSES } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createFakeTaskManagement } from './fake.js';

const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000a1';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000b1';
const REF = {
  provider: 'fake-task-management',
  key: 'FAKE-1',
  url: 'https://tickets.example.test/browse/FAKE-1',
};

type Options = Parameters<typeof createFakeTaskManagement>[0];

const build = (options: Partial<Options> = {}) =>
  createFakeTaskManagement({
    integrationId: INTEGRATION_ID,
    identities: [{ providerUserId: 'user-1', email: 'dev@example.test' }],
    tickets: [
      {
        key: 'FAKE-1',
        title: 'Totals are wrong',
        status: 'Ready for agent',
        labels: ['agentic'],
        epic: { key: 'EPIC-1', title: 'Billing', description: '' },
      },
      { key: 'FAKE-2', title: 'Unrelated', status: 'Backlog', labels: [] },
    ],
    ...options,
  });

describe('FakeTaskManagement', () => {
  it('matches by status, epic and the three supported query forms', async () => {
    const port = build();

    expect(
      (await port.matchTickets({ kind: 'status', status: 'Ready for agent' })).map(
        (m) => m.ref.key,
      ),
    ).toEqual(['FAKE-1']);
    expect(
      (await port.matchTickets({ kind: 'epic', epic_key: 'EPIC-1' })).map((m) => m.ref.key),
    ).toEqual(['FAKE-1']);
    expect(
      (await port.matchTickets({ kind: 'query', query: 'label = "agentic"' })).map(
        (m) => m.ref.key,
      ),
    ).toEqual(['FAKE-1']);
    expect(
      (await port.matchTickets({ kind: 'query', query: 'status = "Backlog"' })).map(
        (m) => m.ref.key,
      ),
    ).toEqual(['FAKE-2']);
  });

  it('refuses a query it cannot mean, instead of returning everything (divergence 3)', async () => {
    const port = build();
    await expect(
      port.matchTickets({ kind: 'query', query: 'project = FAKE AND status != Done' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('honours `since` and `limit`', async () => {
    const port = build();
    const all = await port.matchTickets({ kind: 'label', label: 'agentic' }, { limit: 0 });
    expect(all).toEqual([]);

    const future = await port.matchTickets(
      { kind: 'label', label: 'agentic' },
      { since: '2030-01-01T00:00:00.000Z' },
    );
    expect(future).toEqual([]);
  });

  it('refuses to seed a ticket into a status the workflow does not have', () => {
    expect(() =>
      createFakeTaskManagement({
        integrationId: INTEGRATION_ID,
        tickets: [{ key: 'FAKE-9', title: 'x', status: 'Nowhere' }],
      }),
    ).toThrow(/workflow/);
  });

  it('reports creating a ticket as unsupported when the capability is off', async () => {
    const port = build({ capabilities: { createTicket: false } });
    await expect(
      port.createTicket({
        project_key: 'FAKE',
        issue_type: 'Task',
        title: 'nope',
        description: '',
        labels: [],
        parent_key: null,
        priority: null,
      }),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });
  });

  it('surfaces a scripted rate limit, which is how the executor reaches its 429 branch', async () => {
    const port = build();
    port.core.script.failNext(
      'add_comment',
      new IntegrationRateLimitedError('fake-task-management', 'slow down', {
        retryAfterMs: 1000,
      }),
    );

    await expect(port.addComment(REF, 'hello')).rejects.toBeInstanceOf(IntegrationRateLimitedError);
    // Only the armed call fails; the next one goes through.
    const comment = await port.addComment(REF, 'hello');
    expect(comment.comment_id.length).toBeGreaterThan(0);
  });

  it('keeps the workpad separate from ordinary comments', async () => {
    const port = build();
    await port.addComment(REF, 'a question');
    await port.upsertWorkpad(REF, 'agentic:workpad', 'v1');
    await port.upsertWorkpad(REF, 'agentic:workpad', 'v2');

    const ticket = await port.readTicket(REF);
    expect(ticket.comments.length).toBe(2);
    expect(
      ticket.comments.filter((comment) => comment.marker_id === 'agentic:workpad').length,
    ).toBe(1);
  });

  it('resolves an identity by provider user id and reports an unknown one as null', async () => {
    const port = build();
    expect((await port.resolveIdentity({ providerUserId: 'user-1' }))?.verified).toBe(true);
    expect(await port.resolveIdentity({ providerUserId: 'ghost' })).toBeNull();
    expect(await port.resolveIdentity({})).toBeNull();
  });

  it('ignores a delivery about a ticket it does not have', async () => {
    const port = build();
    const delivery = port.emitCommentAdded({
      ticketKey: 'FAKE-1',
      authorId: 'user-1',
      text: 'hi',
    });
    const other = createFakeTaskManagement({ integrationId: INTEGRATION_ID });
    const result = await other.inbound.normalise(delivery, {
      projectId: PROJECT_ID,
      integrationId: INTEGRATION_ID,
      defaultBranch: 'main',
      resolveUser: () => null,
      resolveThread: async () => null,
    });
    expect(result.events).toEqual([]);
    expect(result.ignored[0]?.reason).toBe('not_for_this_project');
  });

  it('normalises a status change and a pick-up match', async () => {
    const port = build();
    const context = {
      projectId: PROJECT_ID,
      integrationId: INTEGRATION_ID,
      defaultBranch: 'main',
      resolveUser: () => null,
      resolveThread: async () => null,
    };

    const status = await port.inbound.normalise(
      port.emitStatusChanged({ ticketKey: 'FAKE-1', from: 'Ready for agent', to: 'In Progress' }),
      context,
    );
    // The status event first and the edit beside it (WP-60), the way Jira's delivery reads.
    expect(status.events.map((event) => event.type)).toEqual([
      'ticket.status.changed',
      'ticket.updated',
    ]);

    const matched = await port.inbound.normalise(
      port.emitTicketMatched({ ticketKey: 'FAKE-1', rule: 'label:agentic' }),
      context,
    );
    expect(matched.events[0]?.type).toBe('ticket.matched');
  });

  /**
   * WP-60: the edit is applied **before** the delivery is built, so the stage that re-reads the
   * ticket because of it reads the new words — the fake's half of Q61 (b).
   */
  it('applies an edit to the stored ticket and announces the fields that moved', async () => {
    const port = build();
    const context = {
      projectId: PROJECT_ID,
      integrationId: INTEGRATION_ID,
      defaultBranch: 'main',
      resolveUser: () => null,
      resolveThread: async () => null,
    };
    const result = await port.inbound.normalise(
      port.emitTicketUpdated({ ticketKey: 'FAKE-1', description: 'Now with criteria.' }),
      context,
    );
    expect(result.events.map((event) => event.type)).toEqual(['ticket.updated']);
    expect(
      (result.events[0]?.payload as { changed_fields: string[] } | undefined)?.changed_fields,
    ).toEqual(['description']);
    const after = await port.readTicket(REF);
    expect(after.description).toBe('Now with criteria.');
    expect((result.events[0]?.payload as { updated_at: string } | undefined)?.updated_at).toBe(
      after.updated_at,
    );
  });

  it('fails a read of a ticket that never existed', async () => {
    const port = build();
    await expect(port.readTicket({ ...REF, key: 'FAKE-404' })).rejects.toBeInstanceOf(
      IntegrationError,
    );
  });
});

describe('the search index lag, on request (WP-87 review round 1)', () => {
  it('leaves a freshly updated ticket out of matchTickets until the lag has passed', async () => {
    const port = createFakeTaskManagement({
      integrationId: INTEGRATION_ID,
      searchLagMs: 5_000,
      tickets: [{ key: 'FAKE-1', title: 'Seeded long ago', labels: ['agentic'] }],
    });
    // The seed is stamped at the clock's first instant, and the clock steps a second per read.
    const rule = { kind: 'label', label: 'agentic' } as const;
    expect(await port.matchTickets(rule)).toEqual([]);
    for (let read = 0; read < 5; read += 1) {
      await port.readTicket({ provider: port.ref.provider, key: 'FAKE-1', url: 'https://x.test' });
    }
    expect((await port.matchTickets(rule)).map((match) => match.ref.key)).toEqual(['FAKE-1']);
  });
});

describe('the minute-grained window (divergence 11, WP-87 review round 2)', () => {
  it('answers a ticket updated earlier in the same minute as `since`, as Jira’s rounded window does', async () => {
    const port = createFakeTaskManagement({
      integrationId: INTEGRATION_ID,
      clockStart: '2026-06-01T10:00:10.000Z',
      tickets: [{ key: 'FAKE-1', title: 'Updated at 10:00:10', labels: ['agentic'] }],
    });
    const rule = { kind: 'label', label: 'agentic' } as const;
    // 40 seconds after the ticket's update, but inside the same minute.
    expect(
      (await port.matchTickets(rule, { since: '2026-06-01T10:00:50.000Z' })).map((m) => m.ref.key),
    ).toEqual(['FAKE-1']);
    expect(await port.matchTickets(rule, { since: '2026-06-01T10:01:00.000Z' })).toEqual([]);
  });
});

describe('the ticket lifecycle (WP-171, divergences 12–16)', () => {
  const WORKFLOW = [
    { name: 'To pick up', rawCategory: 'new' },
    { name: 'Doing', rawCategory: 'indeterminate' },
    { name: 'Sent back', rawCategory: 'a-key-nobody-documented' },
    { name: 'Finished', rawCategory: 'done' },
    'Parked',
  ] as const;
  const lifecycle = (options: Partial<Options> = {}) =>
    build({
      statuses: WORKFLOW,
      tickets: [{ key: 'FAKE-1', title: 'Totals are wrong', status: 'To pick up' }],
      ...options,
    });

  it('lists its workflow with normalised categories, keeping an unknown key and a missing one', async () => {
    expect(await lifecycle().listStatuses()).toEqual([
      { id: 's-1', name: 'To pick up', category: 'todo', raw_category: 'new' },
      { id: 's-2', name: 'Doing', category: 'in_progress', raw_category: 'indeterminate' },
      {
        id: 's-3',
        name: 'Sent back',
        category: 'unknown',
        raw_category: 'a-key-nobody-documented',
      },
      { id: 's-4', name: 'Finished', category: 'done', raw_category: 'done' },
      { id: 's-5', name: 'Parked', category: 'unknown', raw_category: null },
    ]);
  });

  it('answers MAX_TICKET_STATUSES statuses and refuses one more, as the Jira adapter does (WP-181 (7))', async () => {
    const workflow = (count: number) => Array.from({ length: count }, (_, index) => `S${index}`);
    expect(
      await build({ statuses: workflow(MAX_TICKET_STATUSES), tickets: [] }).listStatuses(),
    ).toHaveLength(MAX_TICKET_STATUSES);
    await expect(
      build({ statuses: workflow(MAX_TICKET_STATUSES + 1), tickets: [] }).listStatuses(),
    ).rejects.toMatchObject({ code: 'invalid_response', action: 'list_statuses' });
  });

  it('refuses a workflow that names a status twice, case-insensitively (divergence 14)', () => {
    expect(() => build({ statuses: ['Doing', 'doing'], tickets: [] })).toThrow(/once/);
  });

  it('lists every other status as a transition named unlike its target (divergence 12)', async () => {
    const transitions = await lifecycle().listTransitions(REF);
    expect(transitions.map((transition) => transition.to.name)).toEqual([
      'Doing',
      'Sent back',
      'Finished',
      'Parked',
    ]);
    for (const transition of transitions) {
      expect(transition.name).not.toBe(transition.to.name);
    }
    expect(transitions[0]?.to.category).toBe('in_progress');
  });

  it('acts as agentic-bot unless `self` names another account (divergence 16)', async () => {
    expect(await lifecycle().selfIdentity()).toMatchObject({
      external_id: 'agentic-bot',
      verified: false,
    });
    const other = lifecycle({ self: { providerUserId: 'svc-9', displayName: 'Service' } });
    expect(await other.selfIdentity()).toMatchObject({
      external_id: 'svc-9',
      display_name: 'Service',
    });
    const comment = await other.addComment(REF, 'hello');
    const read = await other.readTicket(REF);
    expect(read.comments.find((c) => c.id === comment.comment_id)?.author.external_id).toBe(
      'svc-9',
    );
  });

  it('answers a seeded assignee, leaves it on unassign, and assigning over it takes the ticket', async () => {
    const port = lifecycle({
      tickets: [{ key: 'FAKE-1', title: 'Taken', status: 'Doing', assignee: 'user-1' }],
    });
    expect((await port.readTicket(REF)).assignee).toMatchObject({
      external_id: 'user-1',
      verified: false,
    });
    expect(await port.unassign(REF)).toEqual({ changed: false });
    expect((await port.readTicket(REF)).assignee?.external_id).toBe('user-1');
    expect((await port.assignToSelf(REF)).changed).toBe(true);
    expect((await port.readTicket(REF)).assignee?.external_id).toBe('agentic-bot');
  });

  it('dates seeded comments, keeps only those strictly after `since`, newest first (divergence 15)', async () => {
    const port = lifecycle({
      tickets: [
        {
          key: 'FAKE-1',
          title: 'Talked about',
          status: 'Doing',
          comments: [
            { authorId: 'user-1', body: 'first', createdAt: '2026-06-01T09:00:00.000Z' },
            { authorId: 'user-1', body: 'at the horizon', createdAt: '2026-06-01T10:00:00.000Z' },
            { authorId: 'user-1', body: 'tie, earlier', createdAt: '2026-06-01T11:00:00.000Z' },
            { authorId: 'user-1', body: 'tie, later', createdAt: '2026-06-01T11:00:00.000Z' },
          ],
        },
      ],
    });
    const page = await port.listComments(REF, { since: '2026-06-01T10:00:00.000Z', limit: 10 });
    expect(page.comments.map((comment) => comment.body)).toEqual(['tie, later', 'tie, earlier']);
    expect(page.total).toBe(2);
    expect(page.comments[0]?.author.verified).toBe(true);
    const cut = await port.listComments(REF, { limit: 1 });
    expect(cut.comments.map((comment) => comment.body)).toEqual(['tie, later']);
    expect(cut.total).toBe(4);
  });

  it('refuses a page size outside 1–100 as invalid_request', async () => {
    await expect(lifecycle().listComments(REF, { limit: 101 })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it.each([
    ['lifecycleStatuses', 'listStatuses'],
    ['transitionsRead', 'listTransitions'],
    ['assign', 'assignToSelf'],
    ['assign', 'unassign'],
    ['assign', 'selfIdentity'],
    ['commentsRead', 'listComments'],
  ] as const)('refuses by name with %s off: %s', async (flag, member) => {
    const port = lifecycle({ capabilities: { [flag]: false } });
    const call = {
      listStatuses: () => port.listStatuses(),
      listTransitions: () => port.listTransitions(REF),
      assignToSelf: () => port.assignToSelf(REF),
      unassign: () => port.unassign(REF),
      selfIdentity: () => port.selfIdentity(),
      listComments: () => port.listComments(REF, { limit: 1 }),
    }[member];
    const error = await call().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(IntegrationError);
    expect(error).toMatchObject({ code: 'unsupported_capability', action: member });
  });
});
