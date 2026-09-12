/**
 * The provider registry — technical/06 § "Provider module layout", BD-017.
 *
 * > `registry.ts` — providers register `{type, id, configSchema, secretFields, capabilities,
 * > agentTooling}`.
 *
 * It is the one place that knows a provider exists. The pipeline, the UI and the knowledge base
 * ask it for a *type*; adding GitHub is a registration and a module, and nothing else changes.
 *
 * Two of its checks are guards rather than bookkeeping, and both fail loudly at registration —
 * which is boot time — rather than at the first use:
 *
 *  - **every name in `secretFields` must exist in `configSchema`.** A typo there means the field
 *     is never treated as a secret: it is rendered in the settings form as plain text, stored
 *     unencrypted and printed in a config diff (`config.changed`, technical/02). The typo is
 *     invisible in review; the check is not.
 *  - **`type` must match what the registry is asked for**, so a `git` provider cannot be handed
 *    to a caller that wants a task manager and fail three layers later on a missing method.
 */
import type {
  AgentTooling,
  CommunicationPort,
  GitProviderPort,
  ObservabilityErrorsPort,
  ObservabilityLogsPort,
  SecretRedactor,
  TaskManagementPort,
} from '@platform/application';
import type { Id, IntegrationType } from '@platform/contracts';
import type * as z from 'zod';

/** Which port a type resolves to. The mapping the whole registry is generic over. */
export interface IntegrationPortByType {
  readonly task_management: TaskManagementPort;
  readonly git: GitProviderPort;
  readonly communication: CommunicationPort;
  readonly logs: ObservabilityLogsPort;
  readonly errors: ObservabilityErrorsPort;
}

/** What a provider is handed when a binding is instantiated. */
export interface ProviderCreateInput {
  readonly integrationId: Id;
  /** Validated against the registration's `configSchema` before this is called. */
  readonly config: unknown;
  /**
   * Resolved secret values, by config field name. The registry never stores them; the caller
   * fetches them from the secret store for the lifetime of the adapter (BD-002).
   */
  readonly secrets: Readonly<Record<string, string>>;
  /**
   * TD-012's redactor for every provider string this binding will emit — **required**, and the
   * reason it is required is standing rule 31.
   *
   * WP-11 shipped both observability adapters with an *optional* `redactor` and no field here, so
   * along the only production path `redact.apply` was the identity function and a scripted Loki
   * response returned `Authorization: Bearer <token>` verbatim. `SecretRedactor`'s own docblock had
   * already written the rule down for the executor — "deliberately required, with no default
   * implementation … a redactor that defaults to *do nothing* is indistinguishable, at the call
   * site, from one that works" — and the adapter ring reintroduced the defect one layer out.
   *
   * **What a caller must pass**, and what a fourth provider must accept: a `SecretRedactor` built
   * from the secrets the platform injected into *this* binding (`exactSecretRedactor` over the
   * resolved values, which is what `bindingSecretRedactor` does for the adapter's own credentials),
   * or `noSecretsRedactor()` written out in full when the composition root really means "this
   * binding injected nothing". Every adapter composes this with a redactor over its own resolved
   * credentials (`composeSecretRedactors`), so a caller cannot disarm it by passing the no-op — but
   * a caller that knows about a *run-scoped* or a neighbouring binding's secret can only tell the
   * adapter about it through this field.
   */
  readonly redactor: SecretRedactor;
}

/**
 * How a provider's **static** binding credential is presented to `git` over HTTPS (WP-18a, TD-026).
 *
 * The knowledge indexer fetches the project's repository into a platform-side bare mirror with the
 * `git` binary, using the credential the operator configured on the binding — not a minted one:
 * GitLab's `mint_credentials` is off by default, so a mint-only path would leave the default
 * deployment with no credential at all. Which of a provider's secret fields is the git password is
 * provider knowledge, so the provider declares it here rather than the indexer carrying a table of
 * provider names (standing rule 7, BD-017: adding a provider touches no consumer).
 *
 * Absent means *this provider has no static git credential*, which is a refusal at the fetch, never
 * an anonymous one (standing rules 16 and 18).
 */
export interface GitStaticCredential {
  /**
   * The `secretFields` entry holding the password. Checked against `secretFields` at registration:
   * a field that is not declared secret would be stored unencrypted, and a field that does not
   * exist would make the refusal look like an unconfigured binding.
   */
  readonly passwordField: string;
  /**
   * The username git sends beside it. A constant rather than a field, because providers that take
   * a token as the password ignore it — GitLab: *"Use: Any non-blank value as a username. The
   * project access token as the password"*
   * (<https://docs.gitlab.com/user/project/settings/project_access_tokens/>, retrieved 2026-09-10,
   * already cited in `providers/gitlab/credentials.ts`).
   */
  readonly username: string;
}

export interface ProviderRegistration<TType extends IntegrationType> {
  /** Stable slug: `jira-cloud`, `gitlab`, `slack`, `sentry`, `loki`. */
  readonly id: string;
  readonly type: TType;
  readonly displayName: string;
  /** Strict object schema; unknown keys in a binding's config are errors (TD-020). */
  readonly configSchema: z.ZodObject;
  /** Config field names whose values are secrets. Must all exist in `configSchema`. */
  readonly secretFields: readonly string[];
  /** Path of the setup guide rendered in the UI (product/08 § "Setup UX"). */
  readonly setupGuidePath: string;
  /** What an agent may be given inside a run, or `null` when the provider exposes nothing. */
  readonly agentTooling: AgentTooling | null;
  /**
   * For a `git` provider: which resolved secret `git` authenticates the mirror fetch with (TD-026).
   * Absent — and always absent for a provider of another type — means the indexer has no credential
   * for this binding and refuses rather than fetching anonymously.
   */
  readonly gitCredential?: GitStaticCredential;
  create(input: ProviderCreateInput): IntegrationPortByType[TType];
}

export type AnyProviderRegistration = {
  [TType in IntegrationType]: ProviderRegistration<TType>;
}[IntegrationType];

export class ProviderRegistrationError extends Error {
  readonly providerId: string;

  constructor(providerId: string, detail: string) {
    super(`provider "${providerId}": ${detail}`);
    this.providerId = providerId;
    this.name = 'ProviderRegistrationError';
  }
}

const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;

export interface IntegrationRegistry {
  register(registration: AnyProviderRegistration): void;
  /** @throws {ProviderRegistrationError} when the id is unknown or is of another type. */
  get<TType extends IntegrationType>(type: TType, id: string): ProviderRegistration<TType>;
  list(type?: IntegrationType): readonly AnyProviderRegistration[];
  has(id: string): boolean;
}

export const createIntegrationRegistry = (
  registrations: readonly AnyProviderRegistration[] = [],
): IntegrationRegistry => {
  const byId = new Map<string, AnyProviderRegistration>();

  const register = (registration: AnyProviderRegistration): void => {
    if (!PROVIDER_ID.test(registration.id)) {
      throw new ProviderRegistrationError(
        registration.id,
        'id must be a lower-case slug such as "jira-cloud"',
      );
    }
    if (byId.has(registration.id)) {
      throw new ProviderRegistrationError(registration.id, 'is already registered');
    }
    const shape = registration.configSchema.shape as Record<string, unknown>;
    for (const field of registration.secretFields) {
      if (!(field in shape)) {
        throw new ProviderRegistrationError(
          registration.id,
          `secret field "${field}" does not exist in the config schema; it would be stored and ` +
            'rendered as plain configuration (BD-002)',
        );
      }
    }
    const gitCredential = registration.gitCredential;
    if (gitCredential !== undefined) {
      if (registration.type !== 'git') {
        throw new ProviderRegistrationError(
          registration.id,
          `declares a git credential but is a "${registration.type}" provider; only a git binding is fetched with one (TD-026)`,
        );
      }
      if (!registration.secretFields.includes(gitCredential.passwordField)) {
        throw new ProviderRegistrationError(
          registration.id,
          `git credential field "${gitCredential.passwordField}" is not in secretFields; the ` +
            'knowledge indexer would fetch with a value stored as plain configuration (BD-002)',
        );
      }
      if (gitCredential.username.trim() === '') {
        throw new ProviderRegistrationError(
          registration.id,
          'git credential username is blank; git sends it verbatim and a blank one fails the fetch',
        );
      }
    }
    byId.set(registration.id, registration);
  };

  for (const registration of registrations) {
    register(registration);
  }

  return {
    register,
    has: (id) => byId.has(id),
    get: <TType extends IntegrationType>(type: TType, id: string): ProviderRegistration<TType> => {
      const registration = byId.get(id);
      if (registration === undefined) {
        throw new ProviderRegistrationError(id, 'is not registered');
      }
      if (registration.type !== type) {
        throw new ProviderRegistrationError(
          id,
          `is a "${registration.type}" provider, not "${type}"`,
        );
      }
      return registration as ProviderRegistration<TType>;
    },
    list: (type) =>
      [...byId.values()]
        .filter((registration) => type === undefined || registration.type === type)
        .sort((left, right) => left.id.localeCompare(right.id)),
  };
};
