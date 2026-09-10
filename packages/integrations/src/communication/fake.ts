/**
 * `FakeCommunication` — the in-memory chat provider behind the Communication contract suite, the
 * question/approval tests and the digest job (technical/06, technical/10).
 *
 * The interesting half is inbound. An answer or an approval that arrives from chat is a *human
 * decision*, and BD-022 (with Q10) allows it to become `task.question.answered` or
 * `task.approval.decided` only when the author maps to a platform user. This fake implements that
 * rule and reports the drop as `ignored: unmapped_identity`, so a suite can assert positively on
 * both branches instead of asserting the absence of an event — which would also pass if the
 * harness never delivered anything.
 *
 * ## Known divergences from a real chat provider
 *
 * The rule: **a fake may be stricter than the real adapter, never kinder.**
 *
 *  1. **Stricter — `postTaskThread` is idempotent per task.** Slack will happily start a second
 *     thread; the port promises one, so the *adapter* has to remember. The fake enforces the
 *     promise, which is what makes it testable at all.
 *  2. **Stricter — posting to an unconfigured channel is `not_found`.** A provider that posted
 *     into the void would make a lost notification look like a delivered one.
 *  3. **Stricter — an unmapped author never produces an answer or an approval.** Slack delivers
 *     the message regardless; dropping it is the normaliser's job (Q10) and this fake does it.
 *     Feedback is deliberately *not* dropped: `feedbackRecordSchema` records an unmapped author's
 *     identity with a null user id, because feedback is data, not a decision.
 *  4. **Kinder, deliberately — `blocks` is never validated.** The port treats it as an opaque
 *     provider payload (CLAUDE.md's exception to the strict-schema rule), so anything passes here
 *     while Slack rejects malformed Block Kit with `invalid_blocks`. WP-10 owns that validation
 *     and its golden fixtures.
 *  5. **Kinder — no quota, no quiet hours, no Socket Mode reconnect.** No 429 unless a test
 *     scripts one, and no connection to lose. `test/contract/integrations/action-executor.
 *     contract.test.ts` ("communication — post_task_thread") is the test that scripts one and
 *     drives it through `IntegrationActionExecutor`. The digest's quiet hours are a platform
 *     policy (WP-32), not a provider behaviour, so their absence here is correct rather than
 *     kind.
 *  6. **Different — message and thread ids are sequential strings**, where Slack's `thread_ts` is
 *     a timestamp that also orders messages. Code that sorts by `message_id` would pass here.
 *  7. **Stricter — an empty webhook secret verifies nothing.** `verifyFakeDelivery` refuses before
 *     it compares, so a fake built with `webhookSecret: ''` rejects both a forgery signed with the
 *     empty key and an authentic delivery (standing rule 18, added at WP-10 with the shared suite
 *     case "refuses every delivery when the binding has no verification credential").
 *  8. **Fail open, like a real one — an event name this fake does not know is `unsupported_event`,
 *     never an exception** (standing rule 20, added at WP-10). A body that is not JSON at all is
 *     `malformed_payload` rather than a `SyntaxError` thrown out of `normalise`, which is what it
 *     used to be.
 */
import {
  type ApprovalPost,
  type CommunicationCapabilities,
  type CommunicationInboundEvent,
  type CommunicationPort,
  type DigestItem,
  type ExternalIdentity,
  type HealthProbe,
  type InboundContext,
  type InboundNormaliser,
  type IntegrationRef,
  IntegrationUnsupportedError,
  type MessageBody,
  type MessageRef,
  type NormalisedDelivery,
  type NormalisedEvent,
  type QuestionPost,
  type ThreadRef,
  type WebhookDelivery,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import * as z from 'zod';
import {
  buildFakeDelivery,
  createFakeCore,
  type FakeCore,
  fakeDeliveryKey,
  notFound,
  snapshot,
  verifyFakeDelivery,
} from '../support/fake-support.js';

const PROVIDER = 'fake-communication';

/**
 * The channel every normalised answer is attributed to.
 *
 * `answerChannelSchema` in `@platform/contracts` enumerates `ui | ticket | slack | api`, so a
 * communication provider that is not Slack has no value of its own — recorded as discovered work
 * rather than papered over here.
 */
const ANSWER_CHANNEL = 'slack' as const;

export interface FakeCommunicationOptions {
  readonly integrationId: Id;
  readonly baseUrl?: string;
  readonly channels?: readonly string[];
  readonly identities?: readonly {
    providerUserId: string;
    email?: string;
    displayName?: string;
  }[];
  readonly capabilities?: Partial<CommunicationCapabilities>;
  readonly webhookSecret?: string;
}

interface StoredMessage {
  id: string;
  channel: string;
  thread_id: string | null;
  markdown: string;
  blocks: unknown;
  kind: 'thread' | 'question' | 'approval' | 'message' | 'digest';
  updated: number;
}

const answerBody = z.strictObject({
  event: z.literal('answer'),
  task_id: z.uuid(),
  question_id: z.uuid(),
  author_id: z.string().min(1),
  text: z.string().min(1),
});

const approvalBody = z.strictObject({
  event: z.literal('approval'),
  task_id: z.uuid(),
  approval_id: z.uuid(),
  author_id: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().nullish(),
});

const feedbackBody = z.strictObject({
  event: z.literal('feedback'),
  task_id: z.uuid().nullish(),
  author_id: z.string().min(1),
  text: z.string().min(1),
  rating: z.int().min(1).max(5).nullish(),
});

const deliveryBody = z.discriminatedUnion('event', [answerBody, approvalBody, feedbackBody]);

/** The event names this fake acts on. Anything else is `unsupported_event`, never an exception. */
const KNOWN_EVENTS: ReadonlySet<string> = new Set(['answer', 'approval', 'feedback']);

export interface FakeCommunication extends CommunicationPort {
  readonly core: FakeCore;
  /** Every message posted, in order. */
  readonly messages: readonly StoredMessage[];
  messagesIn(channel: string): readonly StoredMessage[];
  emitAnswer(input: {
    readonly taskId: Id;
    readonly questionId: Id;
    readonly authorId: string;
    readonly text: string;
    readonly deliveryId?: string;
  }): WebhookDelivery;
  emitApproval(input: {
    readonly taskId: Id;
    readonly approvalId: Id;
    readonly authorId: string;
    readonly decision: 'approved' | 'rejected';
    readonly reason?: string;
    readonly deliveryId?: string;
  }): WebhookDelivery;
  emitFeedback(input: {
    readonly taskId?: Id | null;
    readonly authorId: string;
    readonly text: string;
    readonly rating?: number;
    readonly deliveryId?: string;
  }): WebhookDelivery;
  /**
   * An authentic delivery this fake does not act on — the shape a provider ships next.
   *
   * It is *signed*, so a suite asserting "ignored, not thrown" is asserting about the normaliser
   * rather than about the signature check.
   */
  emitUnknownEvent(input?: {
    readonly event?: string;
    readonly deliveryId?: string;
  }): WebhookDelivery;
}

export const createFakeCommunication = (options: FakeCommunicationOptions): FakeCommunication => {
  const ref: IntegrationRef = {
    integrationId: options.integrationId,
    provider: PROVIDER,
    type: 'communication',
  };
  const core = createFakeCore({ ref, webhookSecret: options.webhookSecret });
  const baseUrl = options.baseUrl ?? 'https://chat.example.test';
  const channels = new Set(options.channels ?? ['#agentic']);
  const capabilities: CommunicationCapabilities = {
    threads: true,
    buttons: true,
    messageUpdate: true,
    socketMode: true,
    digest: true,
    ...options.capabilities,
  };

  const identities = new Map<string, ExternalIdentity>();
  for (const identity of options.identities ?? []) {
    identities.set(identity.providerUserId, {
      provider: PROVIDER,
      external_id: identity.providerUserId,
      email: identity.email ?? null,
      display_name: identity.displayName ?? null,
      verified: true,
    });
  }
  const identityOf = (providerUserId: string): ExternalIdentity =>
    identities.get(providerUserId) ?? {
      provider: PROVIDER,
      external_id: providerUserId,
      email: null,
      display_name: null,
      verified: false,
    };

  const threadsByTask = new Map<Id, ThreadRef>();
  const messages: StoredMessage[] = [];
  let messageCounter = 0;
  let threadCounter = 0;
  let deliveryCounter = 0;

  const nextDeliveryId = (): string => {
    deliveryCounter += 1;
    return `d-${deliveryCounter}`;
  };

  const requireChannel = (action: string, channel: string): string => {
    if (!channels.has(channel)) {
      throw notFound(PROVIDER, action, `channel ${channel}`);
    }
    return channel;
  };

  const post = (
    channel: string,
    threadId: string | null,
    body: MessageBody,
    kind: StoredMessage['kind'],
  ): MessageRef => {
    messageCounter += 1;
    const message: StoredMessage = {
      id: `m-${messageCounter}`,
      channel,
      thread_id: threadId,
      markdown: body.markdown,
      blocks: body.blocks ?? null,
      kind,
      updated: 0,
    };
    messages.push(message);
    return {
      provider: PROVIDER,
      channel,
      message_id: message.id,
      thread_id: threadId,
      url: `${baseUrl}/${channel.replace('#', '')}/${message.id}`,
    };
  };

  const requireThread = (action: string, thread: ThreadRef): ThreadRef => {
    requireChannel(action, thread.channel);
    const known = [...threadsByTask.values()].some(
      (candidate) => candidate.thread_id === thread.thread_id,
    );
    if (!known) {
      throw notFound(PROVIDER, action, `thread ${thread.thread_id}`);
    }
    return thread;
  };

  const inbound: InboundNormaliser<CommunicationInboundEvent> = {
    verify: (delivery) => verifyFakeDelivery(core.webhookSecret, delivery),
    deliveryKey: (delivery) => fakeDeliveryKey(PROVIDER, delivery),
    normalise: async (
      delivery: WebhookDelivery,
      context: InboundContext,
    ): Promise<NormalisedDelivery<CommunicationInboundEvent>> => {
      let raw: unknown;
      try {
        raw = JSON.parse(delivery.body) as unknown;
      } catch {
        // Divergence 8: a body that is not JSON is a drop with a reason, not a thrown SyntaxError.
        return {
          events: [],
          ignored: [{ reason: 'malformed_payload', detail: 'body is not JSON' }],
        };
      }
      const named = (raw as { event?: unknown } | null)?.event;
      if (typeof named === 'string' && !KNOWN_EVENTS.has(named)) {
        // Divergence 8: fail open on an inbound notification (standing rule 20).
        return {
          events: [],
          ignored: [
            { reason: 'unsupported_event', detail: `event ${JSON.stringify(named.slice(0, 32))}` },
          ],
        };
      }
      const parsed = deliveryBody.safeParse(raw);
      if (!parsed.success) {
        return {
          events: [],
          ignored: [{ reason: 'malformed_payload', detail: parsed.error.issues[0]?.message ?? '' }],
        };
      }
      const body = parsed.data;
      const identity = identityOf(body.author_id);
      const userId = context.resolveUser(identity);
      const author: ExternalIdentity = { ...identity, verified: userId !== null };

      if (body.event === 'feedback') {
        // Divergence 3: feedback is data, so an unmapped author is recorded, not dropped.
        const event: NormalisedEvent<'feedback.received'> = {
          type: 'feedback.received',
          payload: {
            project_id: context.projectId,
            task_id: body.task_id ?? null,
            feedback: {
              id: core.ids.next(),
              project_id: context.projectId,
              task_id: body.task_id ?? null,
              author_user_id: userId,
              author_identity: author,
              scope: body.task_id == null ? 'project' : 'task',
              text: body.text,
              rating: body.rating ?? null,
              source_channel: ANSWER_CHANNEL,
              created_at: core.clock.now(),
            },
          },
          actor:
            userId === null
              ? { kind: 'integration', integration_id: context.integrationId, provider: PROVIDER }
              : { kind: 'user', user_id: userId, identity: author },
        };
        return { events: [event], ignored: [] };
      }

      if (userId === null) {
        // Q10: unmapped users cannot answer or approve.
        return {
          events: [],
          ignored: [
            {
              reason: 'unmapped_identity',
              detail: `${body.author_id} is not mapped to a platform user`,
            },
          ],
        };
      }

      if (body.event === 'answer') {
        const event: NormalisedEvent<'task.question.answered'> = {
          type: 'task.question.answered',
          payload: {
            project_id: context.projectId,
            task_id: body.task_id,
            question_id: body.question_id,
            answer: body.text,
            answered_by_user_id: userId,
            channel: ANSWER_CHANNEL,
          },
          actor: { kind: 'user', user_id: userId, identity: author },
        };
        return { events: [event], ignored: [] };
      }

      const event: NormalisedEvent<'task.approval.decided'> = {
        type: 'task.approval.decided',
        payload: {
          project_id: context.projectId,
          task_id: body.task_id,
          approval_id: body.approval_id,
          decision: body.decision,
          decided_by_user_id: userId,
          reason: body.reason ?? null,
        },
        actor: { kind: 'user', user_id: userId, identity: author },
      };
      return { events: [event], ignored: [] };
    },
  };

  return {
    core,
    ref,
    get messages() {
      return messages;
    },
    messagesIn: (channel) => messages.filter((message) => message.channel === channel),
    capabilities: () => ({ ...capabilities }),
    testConnection: async (): Promise<HealthProbe> => {
      core.enter('test_connection');
      return {
        ok: true,
        checked_at: core.clock.now(),
        detail: `${channels.size} channels configured`,
        token_expires_at: null,
      };
    },

    postTaskThread: async (request) => {
      core.enter('post_task_thread');
      requireChannel('post_task_thread', request.channel);
      // Divergence 1: one thread per task, whatever the caller does.
      const existing = threadsByTask.get(request.taskId);
      if (existing !== undefined) {
        return snapshot(existing);
      }
      threadCounter += 1;
      const threadId = `t-${threadCounter}`;
      post(request.channel, threadId, request.body, 'thread');
      const thread: ThreadRef = {
        provider: PROVIDER,
        channel: request.channel,
        thread_id: threadId,
        url: `${baseUrl}/${request.channel.replace('#', '')}/${threadId}`,
      };
      threadsByTask.set(request.taskId, thread);
      return snapshot(thread);
    },

    postQuestion: async (thread, _question: QuestionPost, body) => {
      core.enter('post_question');
      requireThread('post_question', thread);
      return post(thread.channel, thread.thread_id, body, 'question');
    },

    postApproval: async (thread, _approval: ApprovalPost, body) => {
      core.enter('post_approval');
      requireThread('post_approval', thread);
      return post(thread.channel, thread.thread_id, body, 'approval');
    },

    postMessage: async (thread, body) => {
      core.enter('post_message');
      requireThread('post_message', thread);
      return post(thread.channel, thread.thread_id, body, 'message');
    },

    updateMessage: async (messageRef, body) => {
      core.enter('update_message');
      if (!capabilities.messageUpdate) {
        throw new IntegrationUnsupportedError(PROVIDER, 'message editing');
      }
      const message = messages.find((candidate) => candidate.id === messageRef.message_id);
      if (message === undefined) {
        throw notFound(PROVIDER, 'update_message', `message ${messageRef.message_id}`);
      }
      message.markdown = body.markdown;
      message.blocks = body.blocks ?? null;
      message.updated += 1;
      return { ...messageRef };
    },

    postDigest: async (channel, items: readonly DigestItem[]) => {
      core.enter('post_digest');
      requireChannel('post_digest', channel);
      const markdown = items
        .map((item) => `- ${item.title} (${item.state})${item.detail ? `: ${item.detail}` : ''}`)
        .join('\n');
      return post(channel, null, { markdown }, 'digest');
    },

    resolveIdentity: async (query) => {
      core.enter('resolve_identity');
      if (query.providerUserId !== undefined) {
        return identities.get(query.providerUserId) ?? null;
      }
      if (query.email !== undefined) {
        return [...identities.values()].find((identity) => identity.email === query.email) ?? null;
      }
      return null;
    },

    inbound,

    emitAnswer: (input) =>
      buildFakeDelivery({
        secret: core.webhookSecret,
        event: 'answer',
        deliveryId: input.deliveryId ?? nextDeliveryId(),
        payload: {
          event: 'answer',
          task_id: input.taskId,
          question_id: input.questionId,
          author_id: input.authorId,
          text: input.text,
        },
      }),

    emitApproval: (input) =>
      buildFakeDelivery({
        secret: core.webhookSecret,
        event: 'approval',
        deliveryId: input.deliveryId ?? nextDeliveryId(),
        payload: {
          event: 'approval',
          task_id: input.taskId,
          approval_id: input.approvalId,
          author_id: input.authorId,
          decision: input.decision,
          reason: input.reason ?? null,
        },
      }),

    emitFeedback: (input) =>
      buildFakeDelivery({
        secret: core.webhookSecret,
        event: 'feedback',
        deliveryId: input.deliveryId ?? nextDeliveryId(),
        payload: {
          event: 'feedback',
          task_id: input.taskId ?? null,
          author_id: input.authorId,
          text: input.text,
          rating: input.rating ?? null,
        },
      }),

    emitUnknownEvent: (input = {}) => {
      const event = input.event ?? 'reaction_added';
      return buildFakeDelivery({
        secret: core.webhookSecret,
        event,
        deliveryId: input.deliveryId ?? nextDeliveryId(),
        payload: { event, author_id: 'U-SOMEBODY', emoji: 'thumbsup' },
      });
    },
  };
};
