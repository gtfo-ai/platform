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
 * ## Where redaction happens, and why it is not a list of call sites
 *
 * TD-012 step 1, and standing rule 31 for why `redactor` is **required** rather than optional: a
 * `create()` that forwards nothing type-checks, so the guarantee has to be asserted on strings the
 * adapter emitted rather than on the shape of its options.
 *
 * There are three places, and each covers a direction rather than a field:
 *
 *  1. **Before rendering** (`redactInput`), for every document a port method is handed — a message
 *     body, a question's options, a digest's lines. It is first because the rendering *caps* text
 *     (3,000 characters a section, 75 a button label) and a redactor that ran after a cap leaves
 *     the leading bytes of a token in the channel.
 *  2. **At the transport** (`http.ts`), over the finished request document and over every response
 *     document before any branch reads it — the success branch and the failure branch that quotes
 *     Slack's own error slug.
 *  3. **On an inbound delivery** (`inbound.ts`), before it is normalised, because a thread reply
 *     becomes `feedback.received` and is written to `events.payload`, which is append-only.
 *
 * The redactor itself is the caller's composed with one over this binding's own three credentials,
 * so a composition root that passes `noSecretsRedactor()` cannot disarm it.
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
  bindingSecretRedactor,
  type CommunicationCapabilities,
  type CommunicationInboundEvent,
  type CommunicationPort,
  composeSecretRedactors,
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
import type { Id, JsonObject } from '@platform/contracts';
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
  /**
   * TD-012, applied to everything this adapter emits in either direction.
   *
   * **Required, never defaulted** (standing rule 31, earned at WP-11). While it was optional the
   * registration did not pass one and `redact` was the identity function along the only production
   * path, so every branch below it was decoration. What the adapter does with it is
   * `composeSecretRedactors(input.redactor, bindingSecretRedactor([…this binding's own
   * credentials…]))`, so a caller that passes `noSecretsRedactor()` still cannot disarm it.
   */
  readonly redactor: SecretRedactor;
  /** Where a redaction count is reported. The redacted text is never reported (TD-012). */
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

  /**
   * What the caller injected, plus **all three** of this binding's own credentials (standing rule
   * 31, and the reason `composeSecretRedactors` exists: the caller can only tell the adapter about
   * a run-scoped or a neighbouring binding's secret, and the adapter is the only thing that knows
   * its own).
   *
   * All three, and each for a path that exists:
   *
   *  - **`bot_token`** authenticates every Web API call, so it is the value a Slack error body —
   *    which "echoes the request" (`http.ts`) — can hand back, and the one an operator pastes into
   *    the channel this binding reads when they are debugging a scope. Both routes end in a string
   *    this ring emits.
   *  - **`app_token`** authenticates `apps.connections.open`; the same echo argument applies, and a
   *    Socket Mode failure is reported through the same error path as any other call.
   *  - **`signing_secret`** never leaves the process, and it is included anyway: it is the
   *    credential most likely to arrive back *inbound* (an operator pasting it into a thread while
   *    setting the app up), and `feedback.received` writes a thread reply into `events.payload`,
   *    which is append-only (BD-003) and cannot be fixed afterwards. Redacting a value the platform
   *    holds is never wrong; deciding it "cannot reach a string we emit" is exactly the reasoning
   *    rule 31 was written against.
   *
   * The values are the **effective** ones — what `create` actually sends and signs with — because a
   * redactor that does not know the credential in flight has a hole where the audit log looks.
   * `bindingSecretRedactor` skips anything under `MIN_SECRET_LENGTH`, so a blank or a stub cannot
   * turn ordinary text into placeholders.
   */
  const redactor = composeSecretRedactors(
    options.redactor,
    bindingSecretRedactor([
      { name: 'slack_bot_token', value: botToken },
      appToken === null ? null : { name: 'slack_app_token', value: appToken },
      signingSecret === null ? null : { name: 'slack_signing_secret', value: signingSecret },
    ]),
  );

  const http = createSlackHttp({
    baseUrl: config.base_url,
    token: botToken,
    fetchImpl: options.fetchImpl ?? ((url, init) => fetch(url, init as RequestInit)),
    timeoutMs: config.request_timeout_ms,
    // The choke point: every document crossing the transport, in both directions, is redacted
    // once before anything reads it.
    redactor,
    ...(options.onRedaction === undefined ? {} : { onRedaction: options.onRedaction }),
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
    const outcome = redactor.redactText(text);
    if (outcome.count > 0) {
      options.onRedaction?.({ action, count: outcome.count });
    }
    return outcome.value;
  };

  /**
   * Everything a port method was handed, redacted in one pass **before** any of it is rendered.
   *
   * Two things make it this shape rather than a `redact.apply` per field. First, *order*: the
   * rendering caps a section at 3,000 characters and a button label at 75, and redaction that ran
   * after a cap would leave the leading bytes of a token in the channel — Sentry's rule at WP-11,
   * "redaction strictly precedes every byte cap", pointed at an outbound path instead of an
   * inbound one. Second, *coverage*: a message body, a question's options and a digest's lines are
   * all documents with string leaves at arbitrary depth, and enumerating the leaves is how
   * `environment` came to read an unredacted `tags` one work package ago.
   *
   * The transport redacts the finished request document as well; that pass is the net for anything
   * added later, and it finds nothing to do when this one has run (a replaced value is a
   * placeholder, so the count is 0 and no event is reported).
   */
  const redactInput = <TInput>(action: string, input: TInput): TInput => {
    const outcome = redactor.redactJson({ input } as unknown as JsonObject);
    if (outcome.count > 0) {
      options.onRedaction?.({ action, count: outcome.count });
    }
    return (outcome.value as { input: TInput }).input;
  };

  /** The notification fallback: what a phone shows, and what a screen reader reads. */
  const fallback = (markdown: string): string =>
    truncate(toMrkdwn(markdown), BLOCK_LIMITS.messageText);

  const send = async (input: {
    channel: string;
    threadTs: string | null;
    body: MessageBody;
    /** Built from the **redacted** body, which is why it is a function and not a value. */
    blocks(body: MessageBody): unknown;
    action: string;
  }): Promise<MessageRef> => {
    const body = redactInput(input.action, input.body);
    // Caller-supplied `body.blocks` reach Slack unmodified apart from redaction: `assertBlockKit`
    // checks shape and the vendor's limits, never content, so nothing here escapes text a caller
    // put in a block. That is the deal the port states (`MessageBody`) — blocks are structure, and
    // their text must already be escaped by whoever built them. `body.markdown`, the other route,
    // is escaped by `toMrkdwn` in the block builders and by `fallback` in the notification text.
    const blocks = body.blocks ?? input.blocks(body);
    assertBlockKit(blocks, input.action);
    const posted = await client.postMessage({
      channel: input.channel,
      text: fallback(body.markdown),
      blocks,
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
        // The same composed redactor: an answer and a feedback body are written to `events.payload`.
        redactor,
        ...(options.onRedaction === undefined ? {} : { onRedaction: options.onRedaction }),
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
        // A string this adapter renders itself. Its parts came through the transport, which has
        // already redacted them, so this pass is defence in depth and normally counts 0 — kept and
        // labelled rather than left to look like the guard that is doing the work (rule 22).
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
        blocks: (body) => taskThreadBlocks(body.markdown),
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
      // The options are a second document the port method was handed, and they are rendered into
      // button labels (capped at 75 characters) and button values: redacted with the body, in one
      // pass, before any of that happens. `send`'s own pass then finds nothing.
      const asked = redactInput('post_question', {
        body,
        options: question.options ?? [],
      });
      const posted = await send({
        channel: thread.channel,
        threadTs: thread.thread_id,
        body: asked.body,
        blocks: (redacted) =>
          questionBlocks({
            questionId: question.id,
            markdown: redacted.markdown,
            options: asked.options,
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
        blocks: (redacted) =>
          approvalBlocks({ approvalId: approval.id, markdown: redacted.markdown }),
        action: 'post_approval',
      }),

    postMessage: async (thread, body) =>
      send({
        channel: thread.channel,
        threadTs: thread.thread_id,
        body,
        blocks: (redacted) => taskThreadBlocks(redacted.markdown),
        action: 'post_message',
      }),

    updateMessage: async (messageRef, rawBody) => {
      const body = redactInput('update_message', rawBody);
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

    postDigest: async (channel, rawItems: readonly DigestItem[]) => {
      // A digest line's title, detail and URL come from tickets and merge requests, and its
      // rendering caps each section: redacted first, like every other document this adapter sends.
      const items = redactInput('post_digest', rawItems);
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
