/**
 * The GitLab provider's registration (BD-017: "A new provider is one module plus registration").
 *
 * Nothing in the pipeline, the UI or the knowledge base changes because this file exists; a
 * composition root registers it and the `git` type has a second implementation beside the fake.
 */
import type { AgentTooling, RateLimitPolicy } from '@platform/application';
import type { ProviderRegistration } from '../../registry.js';
import { gitlabConfigSchema, gitlabSecretFields } from './config.js';
import { GITLAB_PROVIDER_ID } from './http.js';
import { createGitLabProvider } from './provider.js';

/**
 * What an agent may be handed inside a run (technical/06 § "Agent tooling exposure").
 *
 * Names only — there is no field for a value, and the names are the tool-native ones `glab`
 * itself reads (TD-020). The run-scoped token the runner injects is the *minted* credential, not
 * the operator's binding token.
 */
export const gitlabAgentTooling: AgentTooling = {
  cli: {
    command: 'glab',
    version: null,
    env: {
      variables: [
        {
          name: 'GITLAB_TOKEN',
          secret: true,
          description: 'Run-scoped GitLab token, injected by the runner from the secret store.',
        },
        {
          name: 'GITLAB_HOST',
          secret: false,
          description: 'Instance root, e.g. https://gitlab.com or a self-managed URL.',
        },
      ],
    },
  },
  mcp: null,
  skill: { id: 'gitlab', path: 'packages/prompts/skills/gitlab' },
  env: {
    variables: [
      {
        name: 'GITLAB_TOKEN',
        secret: true,
        description: 'Run-scoped GitLab token, injected by the runner from the secret store.',
      },
      {
        name: 'GITLAB_HOST',
        secret: false,
        description: 'Instance root, e.g. https://gitlab.com or a self-managed URL.',
      },
    ],
  },
};

/**
 * GitLab's own budget, passed at registration rather than left on the executor's cautious default.
 *
 * GitLab.com documents 2,000 authenticated API requests per user per minute
 * (<https://docs.gitlab.com/user/gitlab_com/#rate-limits-on-gitlabcom>, retrieved 2026-09-10),
 * which is ~33/s. This asks for a small fraction of it: a self-managed instance sets its own
 * limits, usually lower, and the cost of being slower than the provider allows is latency where
 * the cost of being faster is a 429 storm shared with every other client of that token.
 */
export const gitlabRateLimitPolicy: RateLimitPolicy = {
  capacity: 20,
  refillPerSecond: 8,
  maxConcurrent: 4,
};

export const gitlabProviderRegistration: ProviderRegistration<'git'> = {
  id: GITLAB_PROVIDER_ID,
  type: 'git',
  displayName: 'GitLab (gitlab.com and self-managed)',
  configSchema: gitlabConfigSchema,
  secretFields: [...gitlabSecretFields],
  setupGuidePath: 'packages/integrations/src/providers/gitlab/setup-guide.md',
  agentTooling: gitlabAgentTooling,
  // TD-026: what the knowledge indexer's mirror fetch authenticates with. `oauth2` is the username
  // `buildCloneUrl` already sends for a minted token, and GitLab accepts any non-blank one beside a
  // project or personal access token (the citation is on `GitStaticCredential.username`).
  gitCredential: { passwordField: 'token', username: 'oauth2' },
  create: (input) =>
    createGitLabProvider({
      integrationId: input.integrationId,
      config: gitlabConfigSchema.parse(input.config),
      secrets: input.secrets,
      // Standing rule 31: required on `ProviderCreateInput`, and passed here rather than left to a
      // default that redacts nothing.
      redactor: input.redactor,
      clock: {
        now: () => new Date().toISOString() as `${string}T${string}`,
      },
    }),
};

export { CODEOWNERS_PATHS, parseCodeowners } from './codeowners.js';
export { type GitLabConfig, gitlabConfigSchema, gitlabSecretFields } from './config.js';
export { buildCloneUrl, expiryForTtl, scopesFor } from './credentials.js';
export { GITLAB_PROVIDER_ID, type GitLabFetch } from './http.js';
export { mapMergeability, mapPipelineStatus, terminalCiStatus } from './mapping.js';
export {
  createGitLabProvider,
  type GitLabProvider,
  type GitLabProviderOptions,
} from './provider.js';
export {
  constantTimeEquals,
  decodeSigningToken,
  GITLAB_TOKEN_HEADER,
  gitLabDeliveryKey,
  standardWebhookSignature,
  verifyGitLabDelivery,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from './webhook-verify.js';
