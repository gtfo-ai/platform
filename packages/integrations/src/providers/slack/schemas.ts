/**
 * Slack Web API responses and inbound payloads, validated at the ring edge (BD-022).
 *
 * Every schema here describes something Slack sent, so it is deliberately **non-strict**:
 * `z.object` strips unknown keys, which is CLAUDE.md's documented exception for opaque provider
 * payloads and the right direction for a vendor that adds fields continuously. What is *named* is
 * checked, and a named field of the wrong type is an `invalid_response` at `parseProviderData`
 * rather than an `undefined` three layers up.
 *
 * Field lists transcribed from the published documentation, retrieved 2026-09-10:
 *  - `chat.postMessage`: <https://docs.slack.dev/reference/methods/chat.postMessage>
 *  - `chat.update`:      <https://docs.slack.dev/reference/methods/chat.update>
 *  - `auth.test`:        <https://docs.slack.dev/reference/methods/auth.test>
 *  - `users.info`:       <https://docs.slack.dev/reference/methods/users.info>
 *  - `users.lookupByEmail`: <https://docs.slack.dev/reference/methods/users.lookupByEmail>
 *  - `apps.connections.open`: <https://docs.slack.dev/reference/methods/apps.connections.open>
 *  - Socket Mode envelopes: <https://docs.slack.dev/apis/events-api/using-socket-mode>
 *  - `block_actions`: <https://docs.slack.dev/reference/interaction-payloads/block_actions-payload>
 *  - the `message` event: <https://docs.slack.dev/reference/events/message>
 */
import * as z from 'zod';

/** A Slack message timestamp — `"1503435956.000247"` — which is also a message's identity. */
export const slackTsSchema = z.string().regex(/^\d{10}\.\d{6}$/, 'expected a Slack ts');

export const chatPostMessageResponseSchema = z.object({
  ok: z.literal(true),
  channel: z.string().min(1),
  ts: slackTsSchema,
  message: z
    .object({
      text: z.string().nullish(),
      ts: slackTsSchema.nullish(),
      thread_ts: slackTsSchema.nullish(),
      bot_id: z.string().nullish(),
      user: z.string().nullish(),
    })
    .nullish(),
});

export const chatUpdateResponseSchema = z.object({
  ok: z.literal(true),
  channel: z.string().min(1),
  ts: slackTsSchema,
  text: z.string().nullish(),
});

export const authTestResponseSchema = z.object({
  ok: z.literal(true),
  url: z.string().min(1),
  team: z.string().nullish(),
  user: z.string().nullish(),
  team_id: z.string().min(1),
  user_id: z.string().min(1),
  /** Present for a bot token, absent for a user token — which is how the probe tells them apart. */
  bot_id: z.string().nullish(),
  enterprise_id: z.string().nullish(),
  is_enterprise_install: z.boolean().nullish(),
});

export const slackUserSchema = z.object({
  id: z.string().min(1),
  team_id: z.string().nullish(),
  name: z.string().nullish(),
  real_name: z.string().nullish(),
  deleted: z.boolean().nullish(),
  is_bot: z.boolean().nullish(),
  is_app_user: z.boolean().nullish(),
  profile: z
    .object({
      email: z.string().nullish(),
      display_name: z.string().nullish(),
      real_name: z.string().nullish(),
    })
    .nullish(),
});

export const userResponseSchema = z.object({ ok: z.literal(true), user: slackUserSchema });

export const connectionsOpenResponseSchema = z.object({
  ok: z.literal(true),
  url: z.string().regex(/^wss:\/\//, 'expected a wss:// URL'),
});

export type SlackUser = z.infer<typeof slackUserSchema>;
export type ChatPostMessageResponse = z.infer<typeof chatPostMessageResponseSchema>;
export type AuthTestResponse = z.infer<typeof authTestResponseSchema>;

// ── Inbound ──────────────────────────────────────────────────────────────────

/**
 * The Events API envelope: `{token, team_id, api_app_id, event, type: "event_callback", …}`.
 *
 * `token` — the deprecated verification token — is deliberately **not** in this schema. Reading it
 * would invite somebody to compare it, and a shared secret echoed in the body it is meant to
 * authenticate is not a signature; `signature.ts` is the only thing that decides authenticity.
 */
export const eventCallbackSchema = z.object({
  type: z.literal('event_callback'),
  team_id: z.string().nullish(),
  api_app_id: z.string().nullish(),
  event_id: z.string().nullish(),
  event_time: z.number().nullish(),
  event: z.object({
    type: z.string().min(1),
    subtype: z.string().nullish(),
    channel: z.string().nullish(),
    channel_type: z.string().nullish(),
    user: z.string().nullish(),
    bot_id: z.string().nullish(),
    app_id: z.string().nullish(),
    text: z.string().nullish(),
    ts: z.string().nullish(),
    thread_ts: z.string().nullish(),
    event_ts: z.string().nullish(),
  }),
});

/** One clicked element of a `block_actions` payload. */
export const blockActionSchema = z.object({
  action_id: z.string().nullish(),
  block_id: z.string().nullish(),
  value: z.string().nullish(),
  type: z.string().nullish(),
  action_ts: z.string().nullish(),
  text: z.object({ text: z.string().nullish() }).nullish(),
});

export const blockActionsSchema = z.object({
  type: z.literal('block_actions'),
  user: z.object({
    id: z.string().min(1),
    username: z.string().nullish(),
    name: z.string().nullish(),
    team_id: z.string().nullish(),
  }),
  api_app_id: z.string().nullish(),
  team: z.object({ id: z.string().nullish(), domain: z.string().nullish() }).nullish(),
  container: z
    .object({
      type: z.string().nullish(),
      message_ts: z.string().nullish(),
      thread_ts: z.string().nullish(),
      channel_id: z.string().nullish(),
      is_ephemeral: z.boolean().nullish(),
    })
    .nullish(),
  channel: z.object({ id: z.string().nullish(), name: z.string().nullish() }).nullish(),
  message: z
    .object({
      ts: z.string().nullish(),
      thread_ts: z.string().nullish(),
      text: z.string().nullish(),
    })
    .nullish(),
  /**
   * Present on every interactivity payload and deliberately unused.
   *
   * `response_url` is a *capability*: anything holding it can post into the conversation for 30
   * minutes. Parsing it into the ring would put it in an event payload and then in the database.
   * Replies go through `chat.postMessage` with the bot token, which is audited.
   */
  actions: z.array(blockActionSchema).min(1),
});

export type EventCallback = z.infer<typeof eventCallbackSchema>;
export type BlockActions = z.infer<typeof blockActionsSchema>;

/** Either shape a verified Slack delivery can carry, plus the handshake Slack sends once. */
export const slackDeliverySchema = z.union([
  eventCallbackSchema,
  blockActionsSchema,
  z.object({ type: z.string().min(1) }),
]);

/**
 * A Socket Mode envelope.
 *
 * > `{"envelope_id": "<unique_identifier_string>", "type": "<event_type_enum>", "payload":
 * > "<message_data>", "accepts_response_payload": "<boolean>", "retry_attempt": "<optional>",
 * > "retry_reason": "<optional>"}`
 *
 * `hello` and `disconnect` carry no `envelope_id`, which is why it is optional here and required
 * by the code that acks.
 */
export const socketEnvelopeSchema = z.object({
  type: z.string().min(1),
  envelope_id: z.string().nullish(),
  payload: z.unknown().nullish(),
  accepts_response_payload: z.boolean().nullish(),
  retry_attempt: z.number().nullish(),
  retry_reason: z.string().nullish(),
  reason: z.string().nullish(),
});

export type SocketEnvelope = z.infer<typeof socketEnvelopeSchema>;
