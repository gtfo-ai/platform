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
 * What an agent may be handed inside a run: **the `jira-ticket` recipes, and no CLI, server or
 * credential** (WP-54).
 *
 * technical/06 is explicit that "mutating ticket/MR actions are exposed to agents only via the
 * platform MCP", and a read-only Jira CLI spec would have to state the environment variable names
 * a real CLI reads. Nobody here has run one, and a tooling spec is a promise the runner keeps
 * (it mounts what the spec names), so `cli`, `mcp` and `env` stay empty — the shape
 * `SENTRY_AGENT_TOOLING` already has.
 *
 * The **skill** is named because since WP-54 a skill is provisioned by *binding* as well as by
 * role (PROGRESS backlog 40): the stage planner hands a run a provider skill only when one of the
 * project's bindings names it here. Leaving this `null` would have withheld `jira-ticket` from
 * every project, Jira-bound or not; the skill itself says the two CLIs are unauthenticated.
 */
export const JIRA_CLOUD_AGENT_TOOLING: AgentTooling | null = {
  cli: null,
  mcp: null,
  skill: { id: 'jira-ticket', path: 'packages/prompts/skills/jira-ticket' },
  env: { variables: [] },
};

/**
 * Everything about this provider that is true before an executor exists.
 *
 * Split out because Jira is the one shipped provider whose registration is a **factory** — it
 * captures an executor, a clock and an action context — while the read surface of technical/08
 * (`GET /api/integrations`, `GET /api/integrations/:id/setup-guide`) needs the metadata and never
 * calls `create`. The factory spreads this object, so the display name, the secret field list and
 * the guide path have exactly one definition rather than one per consumer (standing rule 7).
 */
export const JIRA_CLOUD_PROVIDER_METADATA = {
  id: PROVIDER_ID,
  type: 'task_management',
  displayName: 'Jira Cloud',
  configSchema: jiraCloudConfigSchema,
  secretFields: [...JIRA_CLOUD_SECRET_FIELDS],
  setupGuidePath: 'packages/integrations/src/providers/jira-cloud/setup-guide.md',
} as const satisfies Pick<
  ProviderRegistration<'task_management'>,
  'id' | 'type' | 'displayName' | 'configSchema' | 'secretFields' | 'setupGuidePath'
>;

export const createJiraCloudRegistration = (
  deps: JiraCloudRegistrationDeps,
): ProviderRegistration<'task_management'> => ({
  ...JIRA_CLOUD_PROVIDER_METADATA,
  secretFields: [...JIRA_CLOUD_PROVIDER_METADATA.secretFields],
  agentTooling: JIRA_CLOUD_AGENT_TOOLING,
  create: ({ integrationId, config, secrets, redactor }) =>
    createJiraCloudTaskManagement({
      integrationId,
      config: jiraCloudConfigSchema.parse({
        ...(config as Record<string, unknown>),
        ...secrets,
      }),
      // Standing rule 31: the field is required on `ProviderCreateInput`, and this is the
      // registration honouring it rather than dropping it on the floor.
      redactor,
      executor: deps.executor,
      clock: deps.clock,
      actionContext: deps.actionContext,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    }),
});
