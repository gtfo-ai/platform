/**
 * The **Communication** contract suite (technical/10 contract tier).
 *
 * WP-07 runs it against `FakeCommunication`; WP-10 runs the same assertions against Slack in
 * Socket Mode with recorded payloads.
 *
 * The centre of this suite is the identity rule. Q10 and BD-022 say an unmapped chat user cannot
 * answer a question or decide an approval, and the assertion for that is deliberately *positive*
 * on both sides: the mapped case asserts exactly one catalogue event, the unmapped case asserts
 * exactly one `ignored` entry with reason `unmapped_identity`. "No event was produced" alone would
 * also pass against a harness that delivered nothing at all.
 */
import type {
  CommunicationPort,
  ExternalIdentity,
  InboundContext,
  WebhookDelivery,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { expectCatalogueEvent, expectIntegrationError } from './shared.js';

export interface CommunicationContractContext {
  readonly port: CommunicationPort;
  readonly channel: string;
  readonly missingChannel: string;
  readonly taskId: Id;
  readonly questionId: Id;
  readonly approvalId: Id;
  /** A chat user the harness maps to a platform user, and one it does not. */
  readonly mappedAuthor: { readonly providerUserId: string; readonly email: string };
  readonly unmappedAuthorId: string;
  emitAnswer(authorId: string, text: string): WebhookDelivery;
  emitApproval(authorId: string, decision: 'approved' | 'rejected'): WebhookDelivery;
  emitFeedback(authorId: string, text: string): WebhookDelivery;
  readonly projectId: Id;
  readonly integrationId: Id;
  cleanup(): Promise<void>;
}

export interface CommunicationContractHarness {
  readonly name: string;
  create(): Promise<CommunicationContractContext>;
}

export const runCommunicationContract = (harness: CommunicationContractHarness): void => {
  describe(`Communication contract — ${harness.name}`, () => {
    let context: CommunicationContractContext;
    let port: CommunicationPort;

    beforeEach(async () => {
      context = await harness.create();
      port = context.port;
      return async () => {
        await context.cleanup();
      };
    });

    const inboundContext = (userId: Id | null): InboundContext => ({
      projectId: context.projectId,
      integrationId: context.integrationId,
      resolveUser: (identity: ExternalIdentity) =>
        identity.external_id === context.mappedAuthor.providerUserId ? userId : null,
    });

    const openThread = () =>
      port.postTaskThread({
        channel: context.channel,
        taskId: context.taskId,
        body: { markdown: 'Picked up **TASK-1**' },
      });

    describe('capabilities and health', () => {
      it('declares every capability flag as a boolean', () => {
        const capabilities = port.capabilities();
        for (const [name, value] of Object.entries(capabilities)) {
          expect(typeof value, `capability ${name}`).toBe('boolean');
        }
      });

      it('answers a read-only probe', async () => {
        expect((await port.testConnection()).ok).toBe(true);
      });
    });

    describe('threads and messages', () => {
      it('opens one thread per task, however often it is asked', async () => {
        const first = await openThread();
        const second = await openThread();
        expect(second.thread_id).toBe(first.thread_id);
        expect(second.channel).toBe(context.channel);
      });

      it('fails with not_found for a channel it does not have', async () => {
        await expectIntegrationError(
          () =>
            port.postTaskThread({
              channel: context.missingChannel,
              taskId: context.taskId,
              body: { markdown: 'nobody will read this' },
            }),
          'not_found',
        );
      });

      it('posts a question and an approval into the task thread', async () => {
        const thread = await openThread();
        const question = await port.postQuestion(
          thread,
          {
            id: context.questionId,
            task_id: context.taskId,
            stage: 'refinement',
            run_id: null,
            text: 'Which currency should totals use?',
            options: ['EUR', 'CZK'],
            blocking: true,
            status: 'open',
            asked_at: '2026-06-01T09:00:00.000Z',
            deadline_at: null,
            reminders_sent: 0,
            answer: null,
            answered_by_user_id: null,
            answered_via: null,
            answered_at: null,
          },
          { markdown: 'Which currency should totals use?', blocks: [{ type: 'actions' }] },
        );
        expect(question.thread_id).toBe(thread.thread_id);

        const approval = await port.postApproval(
          thread,
          {
            id: context.approvalId,
            task_id: context.taskId,
            kind: 'plan',
            status: 'pending',
            requested_at: '2026-06-01T09:05:00.000Z',
            deadline_at: null,
            decided_by_user_id: null,
            decided_at: null,
            reason: null,
          },
          { markdown: 'Approve the plan?' },
        );
        expect(approval.message_id).not.toBe(question.message_id);
      });

      it('edits a message in place, or refuses when it cannot', async () => {
        const thread = await openThread();
        const posted = await port.postMessage(thread, { markdown: 'Ready for merge' });
        if (!port.capabilities().messageUpdate) {
          await expectIntegrationError(
            () => port.updateMessage(posted, { markdown: 'Merged' }),
            'unsupported_capability',
          );
          return;
        }
        const updated = await port.updateMessage(posted, { markdown: 'Merged' });
        expect(updated.message_id).toBe(posted.message_id);
      });

      it('posts a digest to a channel', async () => {
        const digest = await port.postDigest(context.channel, [
          {
            task_id: context.taskId,
            title: 'TASK-1',
            url: null,
            state: 'ready_for_merge',
            detail: null,
          },
        ]);
        expect(digest.channel).toBe(context.channel);
      });
    });

    describe('identity', () => {
      it('resolves a mapped user by email and returns null for a stranger', async () => {
        const identity = await port.resolveIdentity({ email: context.mappedAuthor.email });
        expect(identity?.external_id).toBe(context.mappedAuthor.providerUserId);
        expect(await port.resolveIdentity({ email: 'stranger@example.test' })).toBeNull();
      });
    });

    describe('inbound (BD-022, Q10)', () => {
      const userId = '00000000-0000-4000-8000-00000000f003';

      it('verifies a delivery and rejects a tampered one', () => {
        const delivery = context.emitAnswer(context.mappedAuthor.providerUserId, 'EUR');
        expect(port.inbound.verify(delivery)).toBe(true);
        expect(port.inbound.verify({ headers: delivery.headers, body: '{}' })).toBe(false);
      });

      it('turns a mapped user answer into task.question.answered', async () => {
        const result = await port.inbound.normalise(
          context.emitAnswer(context.mappedAuthor.providerUserId, 'EUR'),
          inboundContext(userId),
        );
        expect(result.ignored).toEqual([]);
        expect(result.events.length).toBe(1);
        const [event] = result.events;
        const { payload } = expectCatalogueEvent(
          event as NonNullable<typeof event>,
          'task.question.answered',
        );
        expect(payload.answer).toBe('EUR');
        expect(payload.answered_by_user_id).toBe(userId);
        expect(payload.question_id).toBe(context.questionId);
      });

      it('refuses an answer from an unmapped user, and says so', async () => {
        const result = await port.inbound.normalise(
          context.emitAnswer(context.unmappedAuthorId, 'CZK'),
          inboundContext(userId),
        );
        expect(result.events).toEqual([]);
        expect(result.ignored.length).toBe(1);
        expect(result.ignored[0]?.reason).toBe('unmapped_identity');
      });

      it('turns a mapped user decision into task.approval.decided', async () => {
        const result = await port.inbound.normalise(
          context.emitApproval(context.mappedAuthor.providerUserId, 'approved'),
          inboundContext(userId),
        );
        const [event] = result.events;
        const { payload } = expectCatalogueEvent(
          event as NonNullable<typeof event>,
          'task.approval.decided',
        );
        expect(payload.decision).toBe('approved');
        expect(payload.decided_by_user_id).toBe(userId);
      });

      it('refuses an approval from an unmapped user', async () => {
        const result = await port.inbound.normalise(
          context.emitApproval(context.unmappedAuthorId, 'approved'),
          inboundContext(userId),
        );
        expect(result.events).toEqual([]);
        expect(result.ignored[0]?.reason).toBe('unmapped_identity');
      });

      it('records feedback from an unmapped user with a null user id', async () => {
        const result = await port.inbound.normalise(
          context.emitFeedback(context.unmappedAuthorId, 'the MR description was unclear'),
          inboundContext(userId),
        );
        expect(result.ignored).toEqual([]);
        const [event] = result.events;
        const { payload } = expectCatalogueEvent(
          event as NonNullable<typeof event>,
          'feedback.received',
        );
        const feedback = payload.feedback as {
          author_user_id: string | null;
          author_identity: ExternalIdentity | null;
          text: string;
        };
        expect(feedback.author_user_id).toBeNull();
        expect(feedback.author_identity?.verified).toBe(false);
        expect(feedback.text).toBe('the MR description was unclear');
      });
    });
  });
};
