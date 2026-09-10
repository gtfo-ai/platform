/**
 * The registry entry for Jira Cloud (technical/06 § "Provider module layout", BD-017).
 *
 * `ProviderRegistration.create` is handed `{integrationId, config, secrets}` and nothing else —
 * no executor, no clock, no task. Those are platform services, not binding configuration, so they
 * are captured **here**, when the provider is registered by the composition root, rather than
 * added to `ProviderCreateInput` (which every other provider shares, and which WP-09…WP-11 are
 * writing against right now).
 *
 * `secrets` is merged over `config` before validation, which is how a binding whose token lives in
 * the secret store reaches the adapter: the settings row stores `api_token` as a reference, the
 * caller resolves it, and the adapter is built from the resolved value it will also redact with
 * (`docs/TODO.md`: the redactor must be built *from* `ProviderCreateInput.secrets`, not beside it).
 */
import type { AgentTooling } from '@platform/application';
import type { ProviderRegistration } from '../../registry.js';
import { JIRA_CLOUD_SECRET_FIELDS, jiraCloudConfigSchema } from './config.js';
import {
  createJiraCloudTaskManagement,
  type JiraActionContext,
  type JiraCloudOptions,
} from './index.js';
import { PROVIDER_ID } from './mapping.js';

export interface JiraCloudRegistrationDeps {
  readonly executor: JiraCloudOptions['executor'];
  readonly clock: JiraCloudOptions['clock'];
  /** See `index.ts`: which task, and in which mode, a call is being made for. */
  readonly actionContext: () => JiraActionContext;
  readonly fetch?: JiraCloudOptions['fetch'];
}

/**
 * What an agent may be handed inside a run: **nothing**, for now.
 *
 * technical/06 is explicit that "mutating ticket/MR actions are exposed to agents only via the
 * platform MCP", and a read-only Jira CLI spec would have to state the environment variable names
 * a real CLI reads. Nobody here has run one, and a tooling spec is a promise the runner keeps
 * (it mounts what the spec names), so `null` is the honest answer until someone verifies it.
 */
export const JIRA_CLOUD_AGENT_TOOLING: AgentTooling | null = null;

export const createJiraCloudRegistration = (
  deps: JiraCloudRegistrationDeps,
): ProviderRegistration<'task_management'> => ({
  id: PROVIDER_ID,
  type: 'task_management',
  displayName: 'Jira Cloud',
  configSchema: jiraCloudConfigSchema,
  secretFields: [...JIRA_CLOUD_SECRET_FIELDS],
  setupGuidePath: 'packages/integrations/src/providers/jira-cloud/setup-guide.md',
  agentTooling: JIRA_CLOUD_AGENT_TOOLING,
  create: ({ integrationId, config, secrets }) =>
    createJiraCloudTaskManagement({
      integrationId,
      config: jiraCloudConfigSchema.parse({
        ...(config as Record<string, unknown>),
        ...secrets,
      }),
      executor: deps.executor,
      clock: deps.clock,
      actionContext: deps.actionContext,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    }),
});
