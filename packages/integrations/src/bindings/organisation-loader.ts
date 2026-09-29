/**
 * The organisation's own chat account, built with **no binding** — the path every organisation-
 * scoped outbound call needs, and the one WP-65 is the first to take (PROGRESS backlog 80).
 *
 * `loader.ts` builds adapters from a project's bindings, because a binding is a project's use of an
 * account. An organisation budget has no project, so it has no binding to start from; what it has
 * is the **account** — `integrations` is org-scoped by construction, and a communication account
 * names its own default channel in `integrations.config` (the value a project's binding overrides,
 * `providers/slack/config.ts`). This builds that account the way the project loader builds a
 * binding: the provider's registration, the decrypted credentials, the provider's own strict schema
 * over the **account's** config alone, and a redactor over the account's own credentials composed
 * with the platform's.
 *
 * ## What it answers
 *
 *  - **no communication account** → `communication: null`, absent-not-broken (standing rule 20);
 *  - **an account whose own config names no channel** → `communication: null` as well, and that is
 *    a decision rather than a shortcut: every binding may name its own channel and leave the
 *    account's empty, which is a legitimate project-by-project setup and means *the organisation has
 *    chosen no channel of its own*. Posting to some project's channel instead would be answer (b)
 *    of backlog 80, which was rejected. The duty logs the absence at `warn` by name;
 *  - **an account that cannot be built** — unregistered provider, undecryptable credential, a
 *    config that fails the schema — throws {@link BindingLoadError}, the project loader's rule;
 *  - **the account the organisation flagged** (`notifications.organisation_default` in the
 *    organisation settings document, Q103 (c), WP-93) speaks for the organisation, whatever the
 *    other accounts name. A flag that points at no communication account, or at one whose own
 *    config names no channel, throws — a flag somebody set is never read as "no flag" (standing
 *    rule 20);
 *  - **two or more communication accounts that name a channel, and none flagged** throws too: the
 *    organisation's budget alarm going to whichever sorts first is a coin toss, and it is the same
 *    refusal a project with two chat bindings gets. Q103 records the question; the refusal names
 *    the flag that resolves it.
 *
 * ## Attribution
 *
 * Every call made through the result goes through the one `IntegrationActionExecutor`, whose audit
 * row, idempotency record and rate-limit budget are keyed by `integrations.id` — this account's id,
 * with no project, because this account's credential and no project's configuration was in scope.
 */
import type {
  InjectedSecret,
  IntegrationAccount,
  IntegrationActionExecutor,
  IntegrationCallScope,
  OrganisationIntegrationsPort,
  PipelineIntegrations,
  SecretRedactor,
  SecretStore,
} from '@platform/application';
import {
  bindingSecretRedactor,
  composeSecretRedactors,
  noSecretsRedactor,
} from '@platform/application';
import type { IntegrationPortByType, IntegrationRegistry } from '../registry.js';
import { BindingLoadError } from './loader.js';

export interface OrganisationIntegrationsLoaderOptions {
  /** Every `communication` account of the organisation, oldest first, with no binding overlay. */
  readonly communicationAccounts: () => Promise<readonly IntegrationAccount[]>;
  readonly secrets: SecretStore;
  readonly registry: IntegrationRegistry;
  /** The process's one executor — the same one every project's calls go through. */
  readonly executor: IntegrationActionExecutor;
  /** TD-012 step 2, composed after the account's own credentials — `loader.ts`'s option. */
  readonly platformRedactor?: SecretRedactor;
  /**
   * The integration id the organisation settings document flags as its default chat account
   * (`notifications.organisation_default`, Q103 (c)), or `null` when none is flagged. Omitted is
   * `null` — every composition before WP-93. It throws when the document does not parse, and the
   * throw reaches the caller as it is.
   */
  readonly organisationDefault?: () => Promise<string | null>;
}

/** The value of the provider's declared channel key in the account's own config, if it names one. */
const accountChannel = (account: IntegrationAccount, key: string | undefined): string | null => {
  if (key === undefined) {
    return null;
  }
  const value = account.config[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
};

export const createOrganisationIntegrationsLoader = (
  options: OrganisationIntegrationsLoaderOptions,
): OrganisationIntegrationsPort => {
  const platformRedactor = options.platformRedactor ?? noSecretsRedactor();
  return {
    forOrganisation: async (scope: IntegrationCallScope): Promise<PipelineIntegrations> => {
      const none: PipelineIntegrations = {
        executor: options.executor,
        git: null,
        taskManagement: null,
        communication: null,
      };
      const candidates: { account: IntegrationAccount; channel: string; digest: string }[] = [];
      const flagged = (await options.organisationDefault?.()) ?? null;
      const accounts = await options.communicationAccounts();
      if (flagged !== null && !accounts.some((account) => account.integrationId === flagged)) {
        throw new BindingLoadError(
          null,
          null,
          `the organisation settings flag ${flagged} as the organisation's chat account (notifications.organisation_default), and no communication account has that id; set it to an existing account or remove it (PATCH /api/org)`,
        );
      }
      for (const account of accounts) {
        if (flagged !== null && account.integrationId !== flagged) {
          // Q103 (c): with an account flagged, the others are not candidates at all.
          continue;
        }
        let registration: ReturnType<IntegrationRegistry['get']>;
        try {
          registration = options.registry.get('communication', account.provider);
        } catch (cause) {
          throw new BindingLoadError(
            null,
            null,
            `the organisation's communication account "${account.name}" names provider "${account.provider}", which this build does not register`,
            { cause },
          );
        }
        const fields = registration.communicationChannels;
        const channel = accountChannel(account, fields?.channel);
        if (channel === null) {
          if (flagged !== null) {
            throw new BindingLoadError(
              null,
              null,
              `the organisation's flagged chat account "${account.name}" (${account.provider}) names no channel of its own; an organisation-scoped notification has nowhere to go until it does, or until another account is flagged (PATCH /api/org)`,
            );
          }
          continue;
        }
        candidates.push({
          account,
          channel,
          digest: accountChannel(account, fields?.digestChannel) ?? channel,
        });
      }
      if (candidates.length === 0) {
        return none;
      }
      const chosen = candidates[0];
      if (candidates.length > 1 || chosen === undefined) {
        throw new BindingLoadError(
          null,
          null,
          `the organisation has ${candidates.length} communication accounts that name a channel of their own (${candidates
            .map((candidate) => `${candidate.account.provider}/${candidate.account.name}`)
            .join(
              ', ',
            )}); an organisation-scoped notification goes to exactly one, so flag the one that speaks for the organisation (notifications.organisation_default, PATCH /api/org) or leave the account-level channel empty on all but one`,
        );
      }

      const { account } = chosen;
      const registration = options.registry.get('communication', account.provider);
      let secrets: Readonly<Record<string, string>>;
      try {
        secrets = await options.secrets.resolve(account.secretIds);
      } catch (cause) {
        throw new BindingLoadError(
          null,
          null,
          `the organisation's communication account "${account.name}" (${account.provider}) has credentials that cannot be read: ${
            (cause as Error).message
          }`,
          { cause },
        );
      }
      const injected: InjectedSecret[] = Object.entries(secrets).map(([field, value]) => ({
        name: `${account.provider}:${account.integrationId}:${field}`,
        value,
      }));
      const redactor = composeSecretRedactors(
        bindingSecretRedactor(injected),
        bindingSecretRedactor(scope.runScopedSecrets),
        platformRedactor,
      );
      const parsed = registration.configSchema.safeParse({ ...account.config, ...secrets });
      if (!parsed.success) {
        // The paths, never the values: the document holds the credential this just merged in.
        const paths = parsed.error.issues
          .map((issue) => (issue.path.length === 0 ? '<root>' : issue.path.join('.')))
          .join(', ');
        throw new BindingLoadError(
          null,
          null,
          `the organisation's communication account "${account.name}" (${account.provider}) has configuration that fails its schema at: ${paths}`,
        );
      }
      let port: ReturnType<typeof registration.create>;
      try {
        port = registration.create({
          integrationId: account.integrationId,
          config: parsed.data,
          secrets,
          redactor,
        });
      } catch (cause) {
        throw new BindingLoadError(
          null,
          null,
          `the organisation's communication account "${account.name}" (${account.provider}) could not be instantiated`,
          { cause },
        );
      }
      const communication = port as IntegrationPortByType['communication'];
      // The channel is read back out of the **validated** config, as the project loader does, so a
      // value the provider's own schema refused never reaches a call.
      const validated = parsed.data as Record<string, unknown>;
      const fields = registration.communicationChannels;
      const channel = fields === undefined ? undefined : validated[fields.channel];
      const digest =
        fields?.digestChannel === undefined ? undefined : validated[fields.digestChannel];
      return {
        ...none,
        communication: {
          port: communication,
          ref: communication.ref,
          channel: typeof channel === 'string' ? channel : chosen.channel,
          digestChannel:
            typeof digest === 'string' && digest.trim() !== '' ? digest : chosen.digest,
          redactor,
        },
      };
    },
  };
};
