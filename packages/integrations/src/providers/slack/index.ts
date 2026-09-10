/**
 * The Slack provider's registration (BD-017: "A new provider is one module plus registration").
 *
 * Nothing in the pipeline, the UI or the knowledge base changes because this file exists; a
 * composition root registers it and the `communication` type has an implementation beside the
 * fake.
 */

import { randomUUID } from 'node:crypto';
import type { AgentTooling, RateLimitPolicy } from '@platform/application';
import type { ProviderRegistration } from '../../registry.js';
import { slackConfigSchema, slackSecretFields } from './config.js';
import { SLACK_PROVIDER_ID } from './http.js';
import { createSlackProvider } from './provider.js';

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

export const slackProviderRegistration: ProviderRegistration<'communication'> = {
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
      clock: { now: () => new Date().toISOString() as `${string}T${string}` },
      // The id of a `feedback` record. `uuidv7()` lives in Postgres (technical/03) and this ring
      // has no database, so a v4 is minted here; `idSchema` is `z.uuid()` and accepts it.
      ids: { next: () => randomUUID() },
    }),
};

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
