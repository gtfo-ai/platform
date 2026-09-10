/**
 * The Slack adapter — `CommunicationPort` in Socket Mode (WP-10).
 *
 * ## What it is not
 *
 * It is **not** where retries, backoff or shadow mode live. `IntegrationActionExecutor` owns
 * those, and every outbound call in the product path goes through it: a handler in the
 * notification band builds an `IntegrationActionRequest` whose `perform` calls one of these
 * methods (technical/06 § "Outbound: actions").
 * `test/contract/integrations/slack-executor.contract.test.ts` proves the composition — a
 * mutating port call in shadow mode issues zero HTTP requests, and a recorded 429 is waited out on
 * the executor's injected timer.
 *
 * It is also **not** where a question is decided to be asked, and not where the digest's contents
 * or its quiet hours are decided. WP-15 owns the first, WP-32 the second; this module owns the
 * capability, the Block Kit and the answer capture.
 *
 * ## Divergences from real Slack, stated rather than implied
 *
 * The fake's register has a dual for a real adapter: *the adapter must not be kinder than the
 * provider*. Where replay cannot reproduce a behaviour, or where the port promises something Slack
 * does not enforce, it is written down here.
 *
 *  1. **`postTaskThread`'s idempotency is per adapter instance.** The port promises one thread per
 *     task; Slack will happily start a second. The adapter remembers in a `SlackThreadDirectory`,
 *     which is in memory by default, so a restarted process would open a second thread. The
 *     **durable** half is the executor's idempotency store: `post_task_thread` carries an
 *     `IdempotencyPlan` keyed by task and a `ThreadRef` is JSON, so a second call replays the
 *     stored ref and issues zero HTTP requests — asserted against a *fresh* adapter, which is the
 *     only version of that assertion an in-memory map cannot fake. `SlackThreadDirectory` is
 *     exported so WP-15 can supply a database-backed one.
 *  2. **A `ThreadRef`/`MessageRef` carries no permalink.** `chat.postMessage` returns `channel` and
 *     `ts` and no URL; a permalink is a second call (`chat.getPermalink`) per message. The port
 *     allows `null` and `null` is what "unknown" means, so the adapter does not assemble a URL
 *     from a pattern the documentation does not publish.
 *  3. **Rate limiting cannot be reproduced in replay.** Slack allows "one message per second per
 *     channel, while also maintaining a workspace-wide limit" and answers `429` with `Retry-After`
 *     in seconds; the *mapping* of that response is exercised by a recorded 429 driven through the
 *     executor, but no test here reaches a real quota.
 *  4. **`not_in_channel` is reported as `forbidden`, where the port's docblock names only
 *     `channel_not_found` → `not_found`.** The channel exists; the operator's fix is
 *     `/invite @agentic`, which is a different action from "fix the channel id". Reporting both as
 *     `not_found` would send an operator to look for a channel that is right there.
 *  5. **Socket Mode deliveries are signed locally.** A Socket Mode payload arrives with no Slack
 *     signature, and the adapter mints one with the binding's own signing secret so that
 *     `inbound.verify` is the single door (see `socket.ts`). The signature attests the transport,
 *     not Slack's key.
 *  6. **A markdown → `mrkdwn` conversion is partial by design.** Tables, images, block quotes and
 *     nested lists pass through as their markdown source (`mrkdwn.ts`).
 *  7. **`resolveIdentity` needs `users:read.email`.** Without that scope Slack answers
 *     `missing_scope`, which surfaces as `forbidden` rather than as "no such user": a binding that
 *     cannot look up an email cannot map identities, and pretending the user does not exist would
 *     make an unmapped answer look like a stranger's.
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
  IntegrationError,
  type IntegrationRef,
  type IntegrationTimer,
  type Logger,
  type MessageBody,
  type MessageRef,
  type NormalisedDelivery,
  type QuestionPost,
  type SecretRedactor,
  type ThreadRef,
  type WebhookDelivery,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import type { Clock, IdSource } from '@platform/domain';
import {
  approvalBlocks,
  assertBlockKit,
  BLOCK_LIMITS,
  digestBlocks,
  questionBlocks,
  taskThreadBlocks,
} from './blocks.js';
import { createSlackClient, type SlackClient } from './client.js';
import type { SlackConfig } from './config.js';
import { createSlackHttp, SLACK_PROVIDER_ID, type SlackFetch } from './http.js';
import { normaliseSlackDelivery } from './inbound.js';
import { toMrkdwn, truncate } from './mrkdwn.js';
import type { SlackUser } from './schemas.js';
import { slackDeliveryKey, usableSigningSecret, verifySlackDelivery } from './signature.js';
import {
  createSlackSocket,
  type SlackSocket,
  type SocketConnect,
  webSocketConnect,
} from './socket.js';
import {
  createMemoryThreadDirectory,
  type SlackThreadDirectory,
  type SlackThreadHandle,
} from './threads.js';

export interface SlackProviderOptions {
  readonly integrationId: Id;
  readonly config: SlackConfig;
  /** `{bot_token, app_token, signing_secret}` from the secret store. */
  readonly secrets: Readonly<Record<string, string>>;
  /** Injected so replay needs no HTTP interception; production passes `globalThis.fetch`. */
  readonly fetchImpl?: SlackFetch;
  /** Injected: signature replay detection and feedback timestamps both need "now". */
  readonly clock: Clock;
  /** Mints the id of a `feedback` record. Production passes a uuid source. */
  readonly ids: IdSource;
  /** Where the thread ↔ task mapping lives. In memory by default (divergence 1). */
  readonly threads?: SlackThreadDirectory;
  /** TD-012. Applied to the one provider string that leaves this ring: the probe's `detail`. */
  readonly redactor?: SecretRedactor;
  readonly onRedaction?: (event: { readonly action: string; readonly count: number }) => void;
  /** Socket Mode: injected so a test drives envelopes without a network. */
  readonly connect?: SocketConnect;
  /** Socket Mode: reconnect backoff runs on this, never on a wall clock. */
  readonly timer?: IntegrationTimer;
  readonly logger?: Logger;
}

/** Slack's own extras, beyond the type port's. */
export interface SlackProvider extends CommunicationPort {
  /**
   * The Socket Mode connection for this binding.
   *
   * @throws {IntegrationError} `unsupported_capability` when the binding is configured for
   * webhooks, and `invalid_request` when it has no app-level token — a socket that cannot open is
   * a binding that silently receives nothing.
   */
  socket(options: {
    onDelivery(delivery: WebhookDelivery): Promise<void>;
    readonly maxReconnects?: number | null;
  }): SlackSocket;
  /** The thread ↔ task directory, so a composition root can share or inspect it. */
  readonly threads: SlackThreadDirectory;
}

const invalidRequest = (action: string, detail: string): IntegrationError =>
  new IntegrationError('invalid_request', SLACK_PROVIDER_ID, detail, { action });

/**
 * A Slack account that may stand for a platform user.
 *
 * A bot, an app user and a deactivated account are refused rather than returned: identity mapping
 * is a security boundary (BD-006, Q10), and mapping a platform user onto a bot account would let
 * anything that can post as that bot answer a question.
 */
const isMappable = (user: SlackUser): boolean =>
  user.deleted !== true && user.is_bot !== true && user.is_app_user !== true;

const identityOf = (user: SlackUser): ExternalIdentity => ({
  provider: SLACK_PROVIDER_ID,
  external_id: user.id,
  email: user.profile?.email?.includes('@') === true ? user.profile.email : null,
  display_name: user.profile?.display_name ?? user.real_name ?? user.name ?? null,
  // Slack answered the lookup, so this identity came from the provider rather than from a payload.
  verified: true,
});

export const createSlackProvider = (options: SlackProviderOptions): SlackProvider => {
  const { config, clock } = options;
  const botToken = options.secrets.bot_token ?? '';
  if (botToken.trim() === '') {
    throw invalidRequest('create', 'the binding has no bot token; set SLACK_BOT_TOKEN (TD-020)');
  }
  const signingSecret = usableSigningSecret(options.secrets.signing_secret ?? null);
  const appToken = usableSigningSecret(options.secrets.app_token ?? null);

  const http = createSlackHttp({
    baseUrl: config.base_url,
    token: botToken,
    fetchImpl: options.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit)),
    timeoutMs: config.request_timeout_ms,
  });
  const client: SlackClient = createSlackClient(http);
  const threads = options.threads ?? createMemoryThreadDirectory();

  const ref: IntegrationRef = {
    integrationId: options.integrationId,
    provider: SLACK_PROVIDER_ID,
    type: 'communication',
  };

  const capabilities: CommunicationCapabilities = {
    threads: true,
    buttons: true,
    messageUpdate: true,
    socketMode: config.socket_mode,
    digest: true,
  };

  /** Learned from `auth.test`, so the normaliser never reads a message this bot posted. */
  let botUserId: string | null = null;

  const redact = (action: string, text: string): string => {
    if (options.redactor === undefined) {
      return text;
    }
    const outcome = options.redactor.redactText(text);
    options.onRedaction?.({ action, count: outcome.count });
    return outcome.value;
  };

  /** The notification fallback: what a phone shows, and what a screen reader reads. */
  const fallback = (markdown: string): string =>
    truncate(toMrkdwn(markdown), BLOCK_LIMITS.messageText);

  const send = async (input: {
    channel: string;
    threadTs: string | null;
    body: MessageBody;
    blocks: unknown;
    action: string;
  }): Promise<MessageRef> => {
    // Caller-supplied `body.blocks` reach Slack unmodified: `assertBlockKit` checks shape and the
    // vendor's limits, never content, so nothing here escapes text a caller put in a block. That is
    // the deal the port states (`MessageBody`) — blocks are structure, and their text must already
    // be escaped by whoever built them. `body.markdown`, the other route, is escaped by
    // `toMrkdwn` in the block builders and by `fallback` in the notification text.
    assertBlockKit(input.blocks, input.action);
    const posted = await client.postMessage({
      channel: input.channel,
      text: fallback(input.body.markdown),
      blocks: input.blocks,
      threadTs: input.threadTs,
      action: input.action,
    });
    return {
      provider: SLACK_PROVIDER_ID,
      channel: posted.channel,
      message_id: posted.ts,
      thread_id: input.threadTs,
      // Divergence 2: no permalink without a second call, and `null` means "unknown".
      url: null,
    };
  };

  const handleOf = (thread: ThreadRef): SlackThreadHandle => ({
    channel: thread.channel,
    threadTs: thread.thread_id,
  });

  const inbound: InboundNormaliser<CommunicationInboundEvent> = {
    verify: (delivery) =>
      verifySlackDelivery(
        delivery,
        { signingSecret, toleranceSeconds: config.signature_tolerance_seconds },
        clock,
      ),
    deliveryKey: (delivery) => slackDeliveryKey(delivery),
    normalise: async (
      delivery: WebhookDelivery,
      context: InboundContext,
    ): Promise<NormalisedDelivery<CommunicationInboundEvent>> =>
      normaliseSlackDelivery(delivery, context, {
        threads,
        teamId: config.team_id ?? null,
        botUserId,
        ids: options.ids,
        clock,
        maxBodyBytes: config.max_delivery_bytes,
      }),
  };

  return {
    ref,
    threads,
    capabilities: () => ({ ...capabilities }),

    testConnection: async (): Promise<HealthProbe> => {
      const identity = await client.authTest();
      botUserId = identity.user_id;
      const workspace = identity.team ?? identity.team_id;
      const as = identity.bot_id == null ? 'a user token' : `bot ${identity.bot_id}`;
      return {
        ok: true,
        checked_at: clock.now(),
        detail: redact('test_connection', `Slack workspace ${workspace} as ${as}`),
        // A Slack bot token does not expire unless the app enables token rotation, and no endpoint
        // this adapter calls publishes the expiry; `null` is "unknown", not "never".
        token_expires_at: null,
      };
    },

    postTaskThread: async (request) => {
      // Divergence 1: the port promises one thread per task, so the adapter remembers.
      const existing = threads.threadForTask(request.taskId);
      if (existing !== null) {
        return {
          provider: SLACK_PROVIDER_ID,
          channel: existing.channel,
          thread_id: existing.threadTs,
          url: null,
        };
      }
      const posted = await send({
        channel: request.channel,
        threadTs: null,
        body: request.body,
        blocks: request.body.blocks ?? taskThreadBlocks(request.body.markdown),
        action: 'post_task_thread',
      });
      threads.rememberThread(request.taskId, {
        channel: posted.channel,
        threadTs: posted.message_id,
      });
      return {
        provider: SLACK_PROVIDER_ID,
        channel: posted.channel,
        thread_id: posted.message_id,
        url: null,
      };
    },

    postQuestion: async (thread, question: QuestionPost, body) => {
      const posted = await send({
        channel: thread.channel,
        threadTs: thread.thread_id,
        body,
        blocks:
          body.blocks ??
          questionBlocks({
            questionId: question.id,
            markdown: body.markdown,
            options: question.options ?? [],
          }),
        action: 'post_question',
      });
      // A reply in this thread now answers *this* question (`inbound.ts`).
      threads.rememberQuestion(handleOf(thread), question.id);
      return posted;
    },

    postApproval: async (thread, approval: ApprovalPost, body) =>
      send({
        channel: thread.channel,
        threadTs: thread.thread_id,
        body,
        blocks: body.blocks ?? approvalBlocks({ approvalId: approval.id, markdown: body.markdown }),
        action: 'post_approval',
      }),

    postMessage: async (thread, body) =>
      send({
        channel: thread.channel,
        threadTs: thread.thread_id,
        body,
        blocks: body.blocks ?? taskThreadBlocks(body.markdown),
        action: 'post_message',
      }),

    updateMessage: async (messageRef, body) => {
      const blocks = body.blocks ?? taskThreadBlocks(body.markdown);
      assertBlockKit(blocks, 'update_message');
      const updated = await client.updateMessage({
        channel: messageRef.channel,
        ts: messageRef.message_id,
        text: fallback(body.markdown),
        blocks,
        action: 'update_message',
      });
      return { ...messageRef, channel: updated.channel, message_id: updated.ts };
    },

    postDigest: async (channel, items: readonly DigestItem[]) => {
      const lines = items.map((item) => ({
        title: item.title,
        state: item.state,
        url: item.url ?? null,
        detail: item.detail ?? null,
      }));
      const blocks = digestBlocks('Agentic digest', lines);
      assertBlockKit(blocks, 'post_digest');
      const posted = await client.postMessage({
        channel,
        text: truncate(
          `Agentic digest: ${items.length} item${items.length === 1 ? '' : 's'}`,
          BLOCK_LIMITS.messageText,
        ),
        blocks,
        threadTs: null,
        action: 'post_digest',
      });
      return {
        provider: SLACK_PROVIDER_ID,
        channel: posted.channel,
        message_id: posted.ts,
        thread_id: null,
        url: null,
      };
    },

    resolveIdentity: async (query) => {
      const user =
        query.providerUserId !== undefined && query.providerUserId !== ''
          ? await client.userInfo(query.providerUserId)
          : query.email !== undefined && query.email !== ''
            ? await client.lookupByEmail(query.email)
            : null;
      if (user === null || !isMappable(user)) {
        // A bot, an app user or a deactivated account is not a platform user. Refusing here is why
        // `resolveUser` can treat an `external_id` as an authorisation subject at all.
        return null;
      }
      return identityOf(user);
    },

    inbound,

    socket: (socketOptions) => {
      if (!config.socket_mode) {
        throw invalidRequest(
          'open_socket',
          'this binding is configured for webhooks; set socket_mode to open a connection',
        );
      }
      if (appToken === null) {
        throw invalidRequest(
          'open_socket',
          'socket mode needs the app-level token; set SLACK_APP_TOKEN (TD-020)',
        );
      }
      if (options.timer === undefined) {
        throw invalidRequest('open_socket', 'socket mode needs an injected timer for its backoff');
      }
      return createSlackSocket({
        openConnection: () => client.openConnection(appToken),
        connect: options.connect ?? webSocketConnect,
        timer: options.timer,
        clock,
        signingSecret,
        onDelivery: async (delivery) => socketOptions.onDelivery(delivery),
        logger: options.logger,
        reconnectBaseMs: config.socket_reconnect_base_ms,
        reconnectMaxMs: config.socket_reconnect_max_ms,
        maxReconnects: socketOptions.maxReconnects ?? null,
      });
    },
  };
};
