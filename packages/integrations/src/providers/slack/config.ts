/**
 * The Slack binding's configuration (technical/06 § "Provider module layout", TD-020).
 *
 * Three credentials, three different jobs, and the setup guide keeps them apart because mixing
 * them up is the most common Slack setup failure:
 *
 *  - `bot_token` (`xoxb-…`) authorises the Web API calls this adapter makes;
 *  - `app_token` (`xapp-…`) opens the Socket Mode connection and **only** that;
 *  - `signing_secret` verifies that an inbound HTTP delivery came from Slack.
 *
 * Secret fields carry no value here. The registry resolves them from the secret store and hands
 * them to `create` in `ProviderCreateInput.secrets`, keyed by these field names (BD-002).
 *
 * Sources, retrieved 2026-09-10:
 * <https://docs.slack.dev/authentication/verifying-requests-from-slack> (the five-minute replay
 * window), <https://docs.slack.dev/apis/events-api/using-socket-mode> (the app-level token).
 */
import { httpUrlSchema } from '@platform/contracts';
import * as z from 'zod';

/**
 * A Slack conversation handle.
 *
 * Slack's own `channel` argument takes "Channel ID, name, or user ID"
 * (<https://docs.slack.dev/reference/methods/chat.postMessage>), and the platform stores whatever
 * the operator wrote. Only the shape is checked here: a value with a space in it is a mistake
 * that would otherwise surface as `channel_not_found` an hour later.
 */
const channelSchema = z
  .string()
  .min(1)
  .regex(/^[^\s]+$/, 'expected a channel id (C0123456789) or a name (#agentic), with no spaces');

export const slackConfigSchema = z.strictObject({
  /**
   * The Web API root. Overridden only by the replay transport and by a proxy; a base URL that
   * already ends in a slash is rejected so `…/api//chat.postMessage` cannot happen.
   *
   * `httpUrlSchema` rather than `z.url()` since WP-51: a bare `z.url()` accepted
   * `javascript:`, `data:`, `vbscript:` and `file:` (Q49), and this value is handed to the
   * client this binding's credential is built into. The **host** is the other half and is not a
   * schema's to know: it is checked against `APP_INTEGRATION_HOSTS` when the row is written and
   * again when the call is made (`createIntegrationEgressPolicy`).
   */
  base_url: httpUrlSchema
    .refine((value) => !value.endsWith('/'), { message: 'must not end with a slash' })
    .default('https://slack.com/api'),
  /**
   * The workspace this binding serves (`T…`), or `null` for "any".
   *
   * When it is set, a delivery whose `team_id` names another workspace is `not_for_this_project`
   * rather than normalised: one Slack app can be installed in several workspaces, and an answer
   * from the wrong one is an answer from a stranger.
   */
  team_id: z
    .string()
    .regex(/^[A-Z0-9]{2,}$/, 'expected a Slack team id such as T0FAKETEAM')
    .nullish(),
  /**
   * Where task threads are opened (product/08: one channel per project).
   *
   * Read by the **binding loader** since WP-32 — `communicationChannels` on the registration says
   * that this is the key — so a project overrides it in `bindings.config` while the account's value
   * is the default. It is the one channel setting a human edits, and the settings screen writes it.
   */
  channel: channelSchema,
  /** Where the digest is posted; the loader falls back to `channel` when it is absent. */
  digest_channel: channelSchema.nullish(),
  /**
   * **`digest_cron` and `digest_timezone` were here and are gone** (WP-32, standing rule 83).
   *
   * They configured `providers/slack/digest.ts`, the per-binding digest job WP-10 left behind and
   * nothing ever scheduled. WP-32 moved the digest into the application ring — one instance-wide
   * tick in the **organisation's** zone (Q38), with *when* it is posted read from the project's own
   * `features.digest.at` — so both keys lost their reader, and a stored key nothing reads is the
   * defect PROGRESS backlog 58 and 60 are instances of. They are removed rather than kept: this
   * schema is strict, so a binding that still carries one is refused by name at load with the path,
   * which is the loud direction.
   */
  /** Secret. `xoxb-…`, the bot token every Web API call authenticates with. */
  bot_token: z.string().nullish(),
  /** Secret. `xapp-…`, the app-level token `apps.connections.open` needs. Socket Mode only. */
  app_token: z.string().nullish(),
  /**
   * Secret. The signing secret every inbound delivery is verified against.
   *
   * Required even in Socket Mode: the interactivity and events HTTP paths exist whether or not an
   * operator uses them, and a binding that cannot verify a delivery must reject every one rather
   * than accept it unverified (standing rule 18).
   */
  signing_secret: z.string().nullish(),
  /** Whether this binding opens a Socket Mode connection. Off = webhooks over HTTP. */
  socket_mode: z.boolean().default(true),
  /**
   * How far `X-Slack-Request-Timestamp` may be from now before the delivery is a replay.
   *
   * Slack's own sample code uses five minutes: "if absolute_value(time.time() - timestamp) > 60 *
   * 5: # The request timestamp is more than five minutes from local time. # It could be a replay
   * attack, so let's ignore it."
   */
  signature_tolerance_seconds: z.int().positive().max(3600).default(300),
  /** Per-request timeout in milliseconds; 0 disables it (the replay harness has no network). */
  request_timeout_ms: z.int().nonnegative().max(600_000).default(30_000),
  /**
   * Largest inbound delivery body the normaliser will parse, in bytes.
   *
   * A message's text is attacker-controlled in a public channel (BD-022), and `JSON.parse` of an
   * unbounded string is the cheapest denial of service there is.
   */
  max_delivery_bytes: z.int().positive().max(4_194_304).default(262_144),
  /** Reconnect backoff for Socket Mode, on the executor's injected timer — never a wall clock. */
  socket_reconnect_base_ms: z.int().positive().max(60_000).default(1_000),
  socket_reconnect_max_ms: z.int().positive().max(600_000).default(30_000),
});

export type SlackConfig = z.output<typeof slackConfigSchema>;
export type SlackConfigInput = z.input<typeof slackConfigSchema>;

/** Config fields whose values live in the secret store, never in `integrations.config`. */
export const slackSecretFields = ['bot_token', 'app_token', 'signing_secret'] as const;
