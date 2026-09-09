/**
 * `FakeTaskManagement` beyond the contract suite.
 *
 * The contract suite asserts what *every* provider must do. This file asserts the claims the
 * fake's own divergence register makes — the strict query grammar, the loud unknown status, the
 * capability gate — because a register entry nothing exercises is a comment, not a guarantee.
 */
import { IntegrationError, IntegrationRateLimitedError } from '@platform/application';
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
      resolveUser: () => null,
    });
    expect(result.events).toEqual([]);
    expect(result.ignored[0]?.reason).toBe('not_for_this_project');
  });

  it('normalises a status change and a pick-up match', async () => {
    const port = build();
    const context = {
      projectId: PROJECT_ID,
      integrationId: INTEGRATION_ID,
      resolveUser: () => null,
    };

    const status = await port.inbound.normalise(
      port.emitStatusChanged({ ticketKey: 'FAKE-1', from: 'Ready for agent', to: 'In Progress' }),
      context,
    );
    expect(status.events[0]?.type).toBe('ticket.status.changed');

    const matched = await port.inbound.normalise(
      port.emitTicketMatched({ ticketKey: 'FAKE-1', rule: 'label:agentic' }),
      context,
    );
    expect(matched.events[0]?.type).toBe('ticket.matched');
  });

  it('fails a read of a ticket that never existed', async () => {
    const port = build();
    await expect(port.readTicket({ ...REF, key: 'FAKE-404' })).rejects.toBeInstanceOf(
      IntegrationError,
    );
  });
});
