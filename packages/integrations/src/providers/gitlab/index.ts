/**
 * The GitLab provider's registration (BD-017: "A new provider is one module plus registration").
 *
 * Nothing in the pipeline, the UI or the knowledge base changes because this file exists; a
 * composition root registers it and the `git` type has a second implementation beside the fake.
 */
import type { AgentTooling, RateLimitPolicy } from '@platform/application';
import type { ProviderCreateInput, ProviderRegistration } from '../../registry.js';
import {
  type StaticRunCredentialSupport,
  withoutRunOnlyFields,
} from '../../static-run-credential.js';
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
  // WP-14a: the directory exists now, and `test/contract/prompts/platform-skills.contract.test.ts`
  // resolves this path against disk for every registration. The id is the skill's **directory**
  // name, which is what the CLI matches on.
  skill: { id: 'gitlab-mr', path: 'packages/prompts/skills/gitlab-mr' },
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

/**
 * How an operator fixes the two mint refusals on GitLab (WP-107, PROGRESS backlog 278) — the
 * sentences the application ring carried, naming GitLab, until they moved to the registration.
 */
export const GITLAB_CREDENTIAL_MINTING_HINTS = {
  enable:
    'GitLab: `mint_credentials: true` on the integration, which needs project access tokens: ' +
    'GitLab Premium on GitLab.com, any self-managed tier',
  shape:
    'GitLab: an instance whose administrator changed the personal-access-token prefix declares it ' +
    'as `token_prefix` on the integration',
  static:
    'GitLab: `run_credential: static` with a dedicated `run_token`; weaker isolation, operator guide § Integrations',
} as const;

/**
 * GitLab's static run credential (TD-028 decision 13, WP-137): the keys of {@link gitlabConfigSchema}
 * that declare it. `run_token` is read by the run-credential path only — {@link gitlabAdapterInput}
 * removes it before the adapter is built.
 */
export const GITLAB_STATIC_RUN_CREDENTIAL: StaticRunCredentialSupport = {
  modeField: 'run_credential',
  tokenField: 'run_token',
  apiTokenField: 'token',
  usernameField: 'run_token_username',
  expiresAtField: 'run_token_expires_at',
  mintingField: 'mint_credentials',
  maxLifetimeDays: 90,
};

/**
 * What the adapter is built from: the create input **without `run_token`**, in the config and in
 * the secrets. Every construction site (the binding loader, the prober, the inbound and organisation
 * loaders) goes through the registration's `create`, so this is the one place that keeps the run
 * token out of every platform API call (decision 13 item 3). `run_token` stays in the redactor the
 * caller built, which is where it belongs.
 */
export const gitlabAdapterInput = (
  input: ProviderCreateInput,
): Pick<ProviderCreateInput, 'config' | 'secrets'> => ({
  config: withoutRunOnlyFields(
    GITLAB_STATIC_RUN_CREDENTIAL,
    input.config as Readonly<Record<string, unknown>>,
  ),
  secrets: withoutRunOnlyFields(GITLAB_STATIC_RUN_CREDENTIAL, input.secrets),
});

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
  // WP-80 (TD-012's M5 amendment): a minted token is `token_prefix` followed by GitLab's random
  // part, so its shape is stable and declared — the registry refuses minting without this.
  credentialMinting: {
    shape: 'stable',
    // WP-107 (PROGRESS backlog 278): GitLab's words for the two mint refusals, which the application
    // ring renders without naming a provider. Pinned in `provider.test.ts`.
    hints: GITLAB_CREDENTIAL_MINTING_HINTS,
  },
  // WP-137: TD-028 decision 13 — a static run credential where GitLab cannot mint.
  staticRunCredential: GITLAB_STATIC_RUN_CREDENTIAL,
  // WP-137: declared on the **integration** (decision 13 item 1), never by a project's binding — a
  // binding overlay could otherwise switch one project of a minted account to `static`, past the
  // one-binding rule, which reads the account's document.
  accountOnlyFields: ['run_credential', 'run_token_username', 'run_token_expires_at'],
  create: (input) => {
    const adapter = gitlabAdapterInput(input);
    return createGitLabProvider({
      integrationId: input.integrationId,
      config: gitlabConfigSchema.parse(adapter.config),
      secrets: adapter.secrets,
      // Standing rule 31: required on `ProviderCreateInput`, and passed here rather than left to a
      // default that redacts nothing.
      redactor: input.redactor,
      clock: {
        now: () => new Date().toISOString() as `${string}T${string}`,
      },
    });
  },
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
