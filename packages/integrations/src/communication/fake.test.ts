/**
 * `FakeCommunication` beyond the contract suite: the capability gate, the thread guard and the
 * shape of what a digest actually posts.
 */
import { IntegrationUnsupportedError } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { createFakeCommunication } from './fake.js';

const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000a3';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000b3';
const TASK_ID = '00000000-0000-4000-8000-0000000000c3';
const QUESTION_ID = '00000000-0000-4000-8000-0000000000d3';

type Options = Parameters<typeof createFakeCommunication>[0];

const build = (options: Partial<Options> = {}) =>
  createFakeCommunication({
    integrationId: INTEGRATION_ID,
    channels: ['#agentic'],
    identities: [{ providerUserId: 'U-MAPPED', email: 'dev@example.test' }],
    ...options,
  });

const context = (userId: string | null) => ({
  projectId: PROJECT_ID,
  integrationId: INTEGRATION_ID,
  resolveUser: () => userId,
});

describe('FakeCommunication', () => {
  it('reports editing as unsupported when the capability is off', async () => {
    const port = build({ capabilities: { messageUpdate: false } });
    const thread = await port.postTaskThread({
      channel: '#agentic',
      taskId: TASK_ID,
      body: { markdown: 'picked up' },
    });
    const posted = await port.postMessage(thread, { markdown: 'ready' });
    await expect(port.updateMessage(posted, { markdown: 'merged' })).rejects.toBeInstanceOf(
      IntegrationUnsupportedError,
    );
  });

  it('refuses to post into a thread it never opened', async () => {
    const port = build();
    await expect(
      port.postMessage(
        { provider: 'fake-communication', channel: '#agentic', thread_id: 't-999', url: null },
        { markdown: 'hello?' },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses to edit a message it never posted', async () => {
    const port = build();
    await expect(
      port.updateMessage(
        {
          provider: 'fake-communication',
          channel: '#agentic',
          message_id: 'm-999',
          thread_id: null,
          url: null,
        },
        { markdown: 'x' },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('renders a digest of every item', async () => {
    const port = build();
    await port.postDigest('#agentic', [
      { task_id: TASK_ID, title: 'TASK-1', url: null, state: 'ready_for_merge', detail: '3 runs' },
      { task_id: null, title: 'TASK-2', url: null, state: 'blocked', detail: null },
    ]);
    const digest = port.messagesIn('#agentic').at(-1);
    expect(digest?.kind).toBe('digest');
    expect(digest?.markdown).toContain('TASK-1 (ready_for_merge): 3 runs');
    expect(digest?.markdown).toContain('TASK-2 (blocked)');
  });

  it('keeps the blocks it was given and counts edits', async () => {
    const port = build();
    const thread = await port.postTaskThread({
      channel: '#agentic',
      taskId: TASK_ID,
      body: { markdown: 'picked up' },
    });
    const posted = await port.postMessage(thread, {
      markdown: 'question',
      blocks: [{ type: 'actions' }],
    });
    await port.updateMessage(posted, { markdown: 'answered' });
    const message = port.messages.find((candidate) => candidate.id === posted.message_id);
    expect(message?.markdown).toBe('answered');
    expect(message?.updated).toBe(1);
  });

  it('reports a malformed delivery instead of throwing', async () => {
    const port = build();
    const result = await port.inbound.normalise(
      { headers: {}, body: '{"event":"answer"}' },
      context(null),
    );
    expect(result.ignored[0]?.reason).toBe('malformed_payload');
  });

  it('attributes feedback to a mapped user when there is one', async () => {
    const port = build();
    const userId = '00000000-0000-4000-8000-00000000f00a';
    const result = await port.inbound.normalise(
      port.emitFeedback({ taskId: TASK_ID, authorId: 'U-MAPPED', text: 'good MR', rating: 5 }),
      context(userId),
    );
    expect(result.events.length).toBe(1);
    const event = result.events[0] as NonNullable<(typeof result.events)[number]>;
    const feedback = (event.payload as { feedback: Record<string, unknown> }).feedback;
    expect(feedback.author_user_id).toBe(userId);
    expect(feedback.rating).toBe(5);
    expect(feedback.scope).toBe('task');
    expect(result.events[0]?.actor).toMatchObject({ kind: 'user', user_id: userId });
  });

  it('scopes project-wide feedback to the project', async () => {
    const port = build();
    const result = await port.inbound.normalise(
      port.emitFeedback({ authorId: 'U-MAPPED', text: 'the digest is noisy' }),
      context('00000000-0000-4000-8000-00000000f00b'),
    );
    expect(result.events.length).toBe(1);
    const event = result.events[0] as NonNullable<(typeof result.events)[number]>;
    const feedback = (event.payload as { feedback: Record<string, unknown> }).feedback;
    expect(feedback.scope).toBe('project');
    expect(feedback.task_id).toBeNull();
  });

  it('gives every question its own message id', async () => {
    const port = build();
    const thread = await port.postTaskThread({
      channel: '#agentic',
      taskId: TASK_ID,
      body: { markdown: 'picked up' },
    });
    const question = {
      id: QUESTION_ID,
      task_id: TASK_ID,
      stage: 'refinement',
      run_id: null,
      text: 'Which currency?',
      options: null,
      blocking: true,
      status: 'open',
      asked_at: '2026-06-01T09:00:00.000Z',
      deadline_at: null,
      reminders_sent: 0,
      answer: null,
      answered_by_user_id: null,
      answered_via: null,
      answered_at: null,
    } as const;
    const first = await port.postQuestion(thread, question, { markdown: 'Which currency?' });
    const second = await port.postQuestion(thread, question, { markdown: 'Which currency?' });
    expect(first.message_id).not.toBe(second.message_id);
  });
});
