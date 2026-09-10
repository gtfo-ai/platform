/**
 * The Slack provider's registration (BD-017: "A new provider is one module plus registration").
 *
 * Nothing in the pipeline, the UI or the knowledge base changes because this file exists; a
 * composition root registers it and the `communication` type has an implementation beside the
 * fake.
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentTooling,
  IntegrationTimer,
  Logger,
  RateLimitPolicy,
} from '@platform/application';
import type { Clock, IdSource } from '@platform/domain';
import type { ProviderCreateInput, ProviderRegistration } from '../../registry.js';
import { slackConfigSchema, slackSecretFields } from './config.js';
import { SLACK_PROVIDER_ID, type SlackFetch } from './http.js';
import { createSlackProvider, type SlackProvider, type SlackProviderOptions } from './provider.js';
import type { SocketConnect } from './socket.js';
import type { SlackThreadDirectory } from './threads.js';

/**
 * Slack exposes **nothing** to an agent, and that is a decision rather than an omission.
 *
 * technical/06: "Mutating ticket/MR actions are exposed to agents only via the platform MCP
 * (`ask_human`, `notify_human`, …) which enforces policy and audit." A `slack` CLI on an agent's
 * PATH would be a way to message humans that bypasses the question record, the deadline, the
 * reminder and the audit row — and it would need a bot token inside a run container, which BD-025
 * and BD-002 both refuse.
 */
export const slackAgentTooling: AgentTooling | null = null;

/**
 * Slack's own budget, passed at registration rather than left on the executor's cautious default.
 *
 * `chat.postMessage` "generally allows posting one message per second per channel, while also
 * maintaining a workspace-wide limit", and the Web API's tiers are per-minute
 * (<https://docs.slack.dev/apis/web-api/rate-limits>, retrieved 2026-09-10). One per second is
 * therefore the *ceiling* for the method this binding uses most, so the sustained rate is set at
 * it and the bucket allows a small burst — a task picked up, its plan posted and its first
 * question asked arrive together.
 */
export const slackRateLimitPolicy: RateLimitPolicy = {
  capacity: 5,
  refillPerSecond: 1,
  maxConcurrent: 2,
};

/**
 * What the composition root supplies once, when it registers the provider.
 *
 * The split follows Loki's and Sentry's registrations (WP-11): `ProviderCreateInput` carries what
 * belongs to a *binding* — its configuration, its secrets and its redactor — while the clock, the
 * transport, the id source, the thread directory, the socket connector, the timer and the
 * observability sink are **platform services** captured here.
 *
 * That split is also what lets the contract suites drive the production path. Slack's registration
 * was a bare object literal until WP-11's merge, so the harness had to call `createSlackProvider`
 * directly — and a required `redactor` on `ProviderCreateInput` is checked where the object is
 * *constructed*, not where it is used, so every Slack test could have kept passing while `create`
 * forwarded nothing at all. Standing rule 31, second half: "the composition root that builds it in
 * production must be the thing the tests drive".
 */
export interface SlackRegistrationDeps {
  /** ISO-8601 now: signature replay detection and feedback timestamps both need it. */
  readonly clock: Clock;
  /** Defaults to `globalThis.fetch`; the contract suites pass a replay transport. */
  readonly fetch?: SlackFetch;
  /** Where a redaction count is reported. The redacted text is never reported (TD-012). */
  readonly onRedaction?: SlackProviderOptions['onRedaction'];
  /**
   * Mints the id of a `feedback` record. Defaults to a v4 uuid: `uuidv7()` lives in Postgres
   * (technical/03) and this ring has no database; `idSchema` is `z.uuid()` and accepts either.
   */
  readonly ids?: IdSource;
  /** Where the thread ↔ task mapping lives. In memory by default (divergence 1); WP-15's seam. */
  readonly threads?: SlackThreadDirectory;
  /** Socket Mode: injected so a test drives envelopes without a network. */
  readonly connect?: SocketConnect;
  /** Socket Mode: reconnect backoff runs on this, never on a wall clock. */
  readonly timer?: IntegrationTimer;
  readonly logger?: Logger;
}

/**
 * Slack's registration, narrowed to the adapter's own port.
 *
 * `ProviderRegistration<'communication'>` promises a `CommunicationPort`, which is what the
 * registry and the pipeline see (BD-017). A caller that registered this module by name knows it
 * gets the two extras Slack adds — the thread directory and the Socket Mode connection — and
 * narrowing the return type here is what lets it have them without a cast.
 */
export interface SlackProviderRegistration extends ProviderRegistration<'communication'> {
  create(input: ProviderCreateInput): SlackProvider;
}

export const createSlackRegistration = (
  deps: SlackRegistrationDeps,
): SlackProviderRegistration => ({
  id: SLACK_PROVIDER_ID,
  type: 'communication',
  displayName: 'Slack (Socket Mode)',
  configSchema: slackConfigSchema,
  secretFields: [...slackSecretFields],
  setupGuidePath: 'packages/integrations/src/providers/slack/setup-guide.md',
  agentTooling: slackAgentTooling,
  create: (input) =>
    createSlackProvider({
      integrationId: input.integrationId,
      config: slackConfigSchema.parse(input.config),
      secrets: input.secrets,
      // Standing rule 31: required on `ProviderCreateInput`, and forwarded here rather than left to
      // a default that redacts nothing. The adapter composes it with its own three credentials.
      redactor: input.redactor,
      clock: deps.clock,
      ids: deps.ids ?? { next: () => randomUUID() },
      ...(deps.fetch === undefined ? {} : { fetchImpl: deps.fetch }),
      ...(deps.onRedaction === undefined ? {} : { onRedaction: deps.onRedaction }),
      ...(deps.threads === undefined ? {} : { threads: deps.threads }),
      ...(deps.connect === undefined ? {} : { connect: deps.connect }),
      ...(deps.timer === undefined ? {} : { timer: deps.timer }),
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    }),
});

/** The system-clock registration a composition root uses when it has nothing to inject. */
export const slackProviderRegistration: SlackProviderRegistration = createSlackRegistration({
  clock: { now: () => new Date().toISOString() as `${string}T${string}` },
});

export {
  ANSWER_ACTION_ID,
  APPROVE_ACTION_ID,
  approvalBlockId,
  assertBlockKit,
  BLOCK_LIMITS,
  digestBlocks,
  parseApprovalBlockId,
  parseQuestionBlockId,
  questionBlockId,
  questionBlocks,
  REJECT_ACTION_ID,
} from './blocks.js';
export { createSlackClient, type SlackClient } from './client.js';
export { type SlackConfig, slackConfigSchema, slackSecretFields } from './config.js';
export {
  createSlackDigestJob,
  type DigestOutcome,
  SLACK_DIGEST_QUEUE,
  type SlackDigestJob,
  type SlackDigestOptions,
} from './digest.js';
export { codeForSlackError, SLACK_PROVIDER_ID, type SlackFetch } from './http.js';
export type { SlackInboundDeps } from './inbound.js';
export { normaliseSlackDelivery } from './inbound.js';
export {
  readSlackManifest,
  SLACK_APP_TOKEN_SCOPE,
  SLACK_BOT_EVENTS,
  SLACK_BOT_SCOPES,
  SLACK_MANIFEST_PATH,
} from './manifest.js';
export { escapeSlackText, toMrkdwn } from './mrkdwn.js';
export {
  createSlackProvider,
  type SlackProvider,
  type SlackProviderOptions,
} from './provider.js';
export {
  SLACK_SIGNATURE_HEADER,
  SLACK_SIGNATURE_VERSION,
  SLACK_TIMESTAMP_HEADER,
  signSlackRequest,
  slackDeliveryKey,
  slackSignatureHeaders,
  usableSigningSecret,
  verifySlackDelivery,
} from './signature.js';
export {
  createSlackSocket,
  type SlackSocket,
  SlackSocketError,
  type SocketConnect,
  type SocketConnection,
  type SocketHandlers,
  webSocketConnect,
} from './socket.js';
export {
  createMemoryThreadDirectory,
  type SlackThreadDirectory,
  type SlackThreadHandle,
} from './threads.js';
