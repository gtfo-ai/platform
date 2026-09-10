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
 *
 * ## Two obligations WP-10 added here rather than in its own file (standing rule 23)
 *
 * A new port obligation that lives only in a provider's own contract file is a promise one
 * provider made to itself: BD-017's claim is that a *new* provider is trustworthy without touching
 * the pipeline, and only the shared suite can make that true. Both of these were found while
 * writing the Slack adapter and both are properties of the **port**, so both are asserted for
 * every communication provider:
 *
 *  1. **An unknown inbound event is ignored with a reason, never thrown** (standing rule 20). A
 *     chat provider ships new event types continuously; a normaliser that throws turns the next
 *     one into a permanently failing job. The harness supplies the delivery, because only it knows
 *     what "authentic but unrecognised" looks like for its provider.
 *  2. **A binding with no verification credential refuses every delivery** (standing rule 18). The
 *     defect this is named for accepted `HMAC-SHA256('', body)` because an unset secret became an
 *     empty string, so the case is asserted from both ends: a delivery signed *with* the empty
 *     credential is refused, and so is a genuinely authentic one — with the configured port's
 *     acceptance of that same delivery as the control, so a green refusal cannot come from a
 *     harness that built a broken delivery.
 *
 * Both take provider-shaped inputs from the harness rather than writing a literal, for the reason
 * technical/06 gives about `foreignRevokeId`: an assertion that hard-codes one provider's dialect
 * is that provider's test wearing the suite's name.
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
  /**
   * An authentic delivery of something this provider does not act on — a reaction, a presence
   * change, whatever the provider ships next. It must be *verifiable*, or the case would prove the
   * signature check rather than the normaliser.
   */
  emitUnknownEvent(): WebhookDelivery;
  /**
   * The same port, built with **no** verification credential at all.
   *
   * Not a second provider and not a mock: the same adapter, configured the way an operator
   * configures it when they forget the secret.
   */
  readonly unverifiablePort: CommunicationPort;
  /** A delivery signed with the empty credential — the signature an attacker can compute. */
  signedWithNoCredential(): WebhookDelivery;
  /**
   * A `blocks` payload this provider accepts, for the message body the suite sends. The fake
   * validates nothing and Slack validates everything, so the literal belongs to the harness.
   */
  readonly providerBlocks: unknown;
  /**
   * How many *provider-visible effects* this port has produced so far — messages the fake
   * actually stored, requests the real adapter actually sent. Not the number of port methods
   * entered: both of them enter `postTaskThread`, and only one of them may reach the provider.
   *
   * It exists for one assertion, and standing rule 10 is why: "opens one thread per task" compares
   * two `thread_id`s, and that comparison is satisfied *by both branches* — a double that repeats
   * its last recorded answer returns the same id for a second, real POST. Counting the calls is
   * what says which branch ran. Found by mutation at WP-10: disabling the adapter's idempotency
   * left the whole suite green.
   *
   * **It must move.** A counter only ever asserted not to have changed is satisfied by one that is
   * frozen, and `providerCalls: () => 0` passed 2335 of 2335 tests in review round 1. The suite
   * therefore takes a baseline, requires a rise across the first `postTaskThread`, and only then
   * requires no rise across the second — so a frozen implementation of this method fails here
   * rather than silently excusing the adapter it was added to police.
   */
  providerCalls(): number;
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
        const before = context.providerCalls();
        const first = await openThread();
        const after = context.providerCalls();
        // The counter has to prove itself before it is allowed to decide anything. Asserting only
        // that it *did not move* is standing rule 10 one level up: a counter that never moves at
        // all — `providerCalls: () => 0` — satisfies it, and that mutation left 2335 of 2335 tests
        // green when this case first shipped. A baseline and a rise are what make the second
        // assertion below a measurement instead of a tautology.
        expect(
          after,
          'the harness counter must move for a call that did reach the provider, or it cannot testify about one that did not',
        ).toBeGreaterThan(before);

        const second = await openThread();

        expect(second.thread_id).toBe(first.thread_id);
        expect(second.channel).toBe(context.channel);
        // Rule 10: the two ids above are equal whether the adapter remembered or asked again, so
        // the assertion that decides it is the one counting what the second call sent.
        expect(
          context.providerCalls(),
          'the second call must be answered from memory, not by opening a second thread',
        ).toBe(after);
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
          { markdown: 'Which currency should totals use?', blocks: context.providerBlocks },
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

      it('ignores an event it does not understand instead of throwing (rule 20)', async () => {
        const delivery = context.emitUnknownEvent();
        expect(
          port.inbound.verify(delivery),
          'control: the unknown delivery is authentic, so this is about the normaliser',
        ).toBe(true);

        const result = await port.inbound.normalise(delivery, inboundContext(userId));
        expect(result.events, 'an unrecognised notification produces no event').toEqual([]);
        expect(result.ignored.length, 'and says why, once').toBe(1);
        expect(['unsupported_event', 'malformed_payload']).toContain(result.ignored[0]?.reason);
      });

      it('refuses every delivery when the binding has no verification credential (rule 18)', () => {
        const authentic = context.emitAnswer(context.mappedAuthor.providerUserId, 'EUR');
        const forged = context.signedWithNoCredential();

        expect(
          port.inbound.verify(authentic),
          'control: a configured binding accepts an authentic delivery',
        ).toBe(true);
        expect(
          context.unverifiablePort.inbound.verify(forged),
          'a signature computed with the unset credential must not verify',
        ).toBe(false);
        expect(
          context.unverifiablePort.inbound.verify(authentic),
          'and neither must a genuinely authentic one: an unconfigured binding verifies nothing',
        ).toBe(false);
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
