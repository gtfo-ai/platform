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
 *  - **a `communication` provider must declare where its channel lives** (WP-32). Without it the
 *    binding loader resolves a chat binding with no channel and the symptom is a notification that
 *    was never posted — a failure with no error, which is the kind this file exists to convert
 *    into a boot-time refusal.
 *  - **a provider that mints run credentials must declare a stable credential shape** (WP-80,
 *    TD-012's M5 amendment). Without one its minted values would be redacted only in the process
 *    that minted them, so the registration is refused by name.
 */
import type {
  AgentTooling,
  CommunicationPort,
  CredentialMintingHints,
  GitProviderPort,
  InboundConnection,
  IntegrationRef,
  ObservabilityErrorsPort,
  ObservabilityLogsPort,
  SecretRedactor,
  TaskManagementPort,
  WebhookDelivery,
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

/**
 * Which config keys hold the channels a `communication` binding posts into (WP-32).
 *
 * A channel is **binding** configuration — `bindings.config.channel` merged over the account's —
 * and *which key holds it* is the provider's knowledge, so the provider declares it here rather
 * than the loader carrying a table of provider names (standing rule 7; BD-017: adding a provider
 * touches no consumer). It is the shape {@link GitStaticCredential} already has one type over.
 *
 * Reading a conventional key called `channel` was the alternative and it is the quiet kind of
 * wrong: a provider whose key is `conversation` would get `undefined`, and the first thing anybody
 * would see is a notification that never arrived.
 */
export interface CommunicationChannelFields {
  /** The key holding the channel task threads are opened in. Checked against `configSchema`. */
  readonly channel: string;
  /** The key holding the digest's channel, when the provider has one. Falls back to `channel`. */
  readonly digestChannel?: string;
}

/**
 * A git provider's declaration that it mints run credentials — WP-80, TD-012's M5 amendment.
 *
 * A minted value is redacted by exact value only in the process that minted it; every other process
 * redacts it by the **shape** the minting process recorded (`MintedCredential.shape`). A provider
 * whose values have no stable shape — no declared prefix, no closed class — would be redacted
 * nowhere but in its minter, so such a provider is refused minting **at registration**:
 * `shape: 'stable'` is the only accepted value, and a registration that declares minting with
 * anything else is refused by name. A port that reports `credentialMinting: true` from a
 * registration that declares nothing has the capability **declined** by the binding loader, so the
 * declaration, not the adapter's flag, is what admits minting. `'unstable'` exists so a provider can
 * say so honestly and be refused, rather than omit the key and be declined silently.
 */
export interface CredentialMintingDeclaration {
  readonly shape: 'stable' | 'unstable';
  /**
   * The provider's own words for the two refusals a mint can meet (WP-107, PROGRESS backlog 278),
   * so the application ring, which renders them, names no provider and no provider's setting:
   * `enable` says how an operator turns minting on for a binding whose port reports it off, and
   * `shape` how one fixes a minted value that does not have the shape the provider declared.
   * Carried to `GitBinding.mintingHints` by the binding loader. Refused at registration when blank.
   */
  readonly hints: CredentialMintingHints;
}

/**
 * What the composition gives a held connection (WP-43): where its deliveries go, and the executor
 * every outbound call it makes on the binding's behalf passes through.
 */
export interface InboundConnectionHooks {
  onDelivery(delivery: WebhookDelivery): Promise<void>;
  /**
   * `IntegrationActionExecutor`, as a read — the egress allow-list, the rate limit and an audit
   * row for each call the connection makes to be opened (Slack's `apps.connections.open`).
   */
  execute<T>(ref: IntegrationRef, action: string, perform: () => Promise<T>): Promise<T>;
}

/**
 * A provider whose inbound half can arrive over a connection the platform **holds** rather than a
 * URL the provider calls — Slack's Socket Mode (WP-43).
 *
 * On the registration rather than on the port, because it is about composition — which process
 * opens it and when — and the port is what the pipeline sees (BD-017).
 */
export interface InboundConnectionSupport {
  /**
   * Whether this account's configuration selects the held connection, read off the **raw**
   * account configuration: an account that selects it and then fails its schema must still be
   * named as one that cannot be held, not skipped as one that did not ask.
   */
  selected(rawConfig: unknown): boolean;
  /**
   * Builds the connection over an adapter created exactly as `create` builds one. Opens nothing.
   *
   * @throws {IntegrationError} when this binding cannot hold one as configured.
   */
  open(input: ProviderCreateInput, hooks: InboundConnectionHooks): InboundConnection;
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
  /**
   * For a `communication` provider: which config keys name the channels (WP-32).
   *
   * **Required for that type** and refused for every other one, checked at registration like
   * `secretFields` and for the same reason: a provider registered without it would resolve to a
   * binding with no channel, and the failure would surface as a notification nobody received
   * rather than as a boot error an operator can read.
   */
  readonly communicationChannels?: CommunicationChannelFields;
  /** Present for a provider that can deliver over a held connection (WP-43). */
  readonly inboundConnection?: InboundConnectionSupport;
  /**
   * Config keys only the **account** (`integrations.config`) may set — a binding write that names
   * one is refused (WP-73b, PROGRESS backlog 201). Slack's `socket_mode` is the one: the held
   * connection reads the account's value, so a binding's copy could only disagree with it. A row
   * stored before that refusal keeps its key, so since WP-79 (backlog 268) the binding repository
   * also **drops** a stored binding's copy on read (`accountOnlyFieldsOf`, `overlayBindingConfig`).
   * Must exist in `configSchema`, checked at registration like `secretFields`. Absent is none.
   */
  readonly accountOnlyFields?: readonly string[];
  /**
   * For a `git` provider that can mint run credentials: its declaration that minted values have a
   * stable shape (WP-80, {@link CredentialMintingDeclaration}). Absent means this provider does not
   * mint, whatever its port says. Refused for any other type, and refused unless `shape: 'stable'`.
   */
  readonly credentialMinting?: CredentialMintingDeclaration;
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
    for (const field of registration.accountOnlyFields ?? []) {
      if (!(field in shape)) {
        throw new ProviderRegistrationError(
          registration.id,
          `account-only field "${field}" does not exist in the config schema; a binding write could not name it anyway`,
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
    const minting = registration.credentialMinting;
    if (minting !== undefined) {
      if (registration.type !== 'git') {
        throw new ProviderRegistrationError(
          registration.id,
          `declares credential minting but is a "${registration.type}" provider; only a git binding mints run credentials`,
        );
      }
      if (minting.shape !== 'stable') {
        throw new ProviderRegistrationError(
          registration.id,
          'declares credential minting without a stable credential shape; a minted value would be ' +
            'redacted by exact value only in the process that minted it and verbatim everywhere else, ' +
            'so minting is refused until the provider declares a stable shape (TD-012, WP-80)',
        );
      }
      // Read as `unknown`: a registration is a JavaScript object a provider author wrote, and a
      // missing `hints` must be refused by name rather than crash on `.trim` (standing rule 14).
      const hints = (minting as { hints?: { enable?: unknown; shape?: unknown } }).hints;
      const blank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';
      if (hints === undefined || blank(hints.enable) || blank(hints.shape)) {
        throw new ProviderRegistrationError(
          registration.id,
          'declares credential minting without both hints (`enable` and `shape`); the mint ' +
            'refusals would tell an operator nothing about how to fix them (WP-107)',
        );
      }
    }
    const channels = registration.communicationChannels;
    if (registration.type === 'communication' && channels === undefined) {
      throw new ProviderRegistrationError(
        registration.id,
        'is a "communication" provider and declares no communicationChannels; the binding loader ' +
          'would resolve it with no channel and every notification would be posted nowhere (WP-32)',
      );
    }
    if (channels !== undefined) {
      if (registration.type !== 'communication') {
        throw new ProviderRegistrationError(
          registration.id,
          `declares communicationChannels but is a "${registration.type}" provider`,
        );
      }
      for (const field of [channels.channel, channels.digestChannel]) {
        if (field !== undefined && !(field in shape)) {
          throw new ProviderRegistrationError(
            registration.id,
            `channel field "${field}" does not exist in the config schema; the loader reads the ` +
              'declared key and would find nothing there',
          );
        }
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
