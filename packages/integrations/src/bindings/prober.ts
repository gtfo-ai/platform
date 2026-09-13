/**
 * `POST /api/integrations/:id/test` — the wizard's *"does this credential work?"* (WP-21).
 *
 * The third loader beside `loader.ts` (a project's two ports) and `inbound-loader.ts` (an account's
 * webhook halves), and it exists for the same reason they are two rather than one: this one starts
 * from an **account** and needs the built port *itself*, not its inbound half. Every type port
 * carries `testConnection(): Promise<HealthProbe>` — "a read-only probe for the health panel and
 * the setup wizard" (`ports/integrations/common.ts`) — so the probe is the provider's own, and this
 * module is the lookup that reaches it.
 *
 * ## Three answers, and they are different facts
 *
 * - **No integration with that id** → `null`. The route answers 404 and writes nothing.
 * - **An adapter that cannot be built** — an unregistered provider, a config that fails its schema,
 *   a credential that will not decrypt → {@link BindingLoadError}, thrown. Same rule as both other
 *   loaders: a binding that fails to load must not become a binding that quietly is not there.
 * - **A probe that came back** → the provider's verdict, whatever it is. `ok: false` is a
 *   successful *test* reporting a failed *connection*, and collapsing the two would make a wizard
 *   step that cannot tell "your token is wrong" from "the platform is broken".
 *
 * ## The call goes through `IntegrationActionExecutor`, like every other outbound call
 *
 * CLAUDE.md's rule is *"every outbound provider call goes through `IntegrationActionExecutor` —
 * never directly"*, and `action-executor.ts` names `testConnection` in the docblock of
 * `ReadActionRequest.mode` as one of the two reads that have no task. It is not decoration here: a
 * probe is the product's **only HTTP-triggered outbound call**, so without the executor it would
 * write no `integration_actions` row (BD-003), take no rate limit and be the one call an operator
 * could drive at whatever rate they like against somebody else's API with the organisation's
 * credential. `mutating: false` is correct and is the provider's promise — `testConnection` is
 * documented "never mutates, so it is safe to run from the settings UI on demand" — so the shadow
 * guard does not apply; the audit row and the rate limit do.
 *
 * `projectId` and `taskId` are `null`: an integration belongs to the organisation and a probe
 * belongs to no task, which is exactly the case `ReadActionRequest.mode` is optional for.
 */
import type {
  BindingRepository,
  HealthProbe,
  InjectedSecret,
  IntegrationAccount,
  IntegrationActionExecutor,
  SecretRedactor,
  SecretStore,
} from '@platform/application';
import {
  bindingSecretRedactor,
  composeSecretRedactors,
  noSecretsRedactor,
} from '@platform/application';
import type { Id, IntegrationType } from '@platform/contracts';
import type { IntegrationRegistry } from '../registry.js';
import { BindingLoadError } from './loader.js';

export interface IntegrationProberOptions {
  readonly repository: BindingRepository;
  readonly secrets: SecretStore;
  readonly registry: IntegrationRegistry;
  /**
   * The process's one executor — **required, never defaulted** (standing rule 31).
   *
   * A prober built without it would make an unaudited, unlimited provider call, which is the
   * defect this option exists to make impossible rather than to make configurable.
   */
  readonly executor: IntegrationActionExecutor;
  /**
   * The platform's own redactor, composed after the account's exact-match one — TD-012 step 2.
   *
   * Named rather than defaulted at the call site for the reason `inbound-loader.ts` states: an
   * optional security dependency is an absent one (standing rule 31). What it protects here is the
   * probe's **detail string**, which is provider text on its way to an HTTP response and an audit
   * row — a provider whose error message echoes the token it rejected is the ordinary case.
   */
  readonly platformRedactor?: SecretRedactor;
}

/** `<provider>:<integrationId>:<field>` — the naming both other loaders use. */
const secretName = (account: IntegrationAccount, field: string): string =>
  `${account.provider}:${account.integrationId}:${field}`;

/** Asked of the built object, not of its type: what a new provider gets wrong is the object. */
const probeOf = (port: object): (() => Promise<HealthProbe>) | null =>
  'testConnection' in port &&
  typeof (port as { testConnection: unknown }).testConnection === 'function'
    ? (port as { testConnection: () => Promise<HealthProbe> }).testConnection.bind(port)
    : null;

export interface IntegrationProbeOutcome {
  readonly ok: boolean;
  readonly checkedAt: string;
  /** One line, already through the account's redactor. Never null — an empty string says so. */
  readonly detail: string;
}

export interface IntegrationProber {
  test(integrationId: Id): Promise<IntegrationProbeOutcome | null>;
}

export const createIntegrationProber = (options: IntegrationProberOptions): IntegrationProber => {
  const platformRedactor = options.platformRedactor ?? noSecretsRedactor();
  return {
    test: async (integrationId: Id): Promise<IntegrationProbeOutcome | null> => {
      const account = await options.repository.forIntegration(integrationId);
      if (account === null) {
        return null;
      }

      let registration: ReturnType<IntegrationRegistry['get']>;
      try {
        registration = options.registry.get(account.type as IntegrationType, account.provider);
      } catch (cause) {
        throw new BindingLoadError(
          integrationId,
          null,
          `integration "${account.name}" names provider "${account.provider}", which this build does not register`,
          { cause },
        );
      }

      let secrets: Readonly<Record<string, string>>;
      try {
        secrets = await options.secrets.resolve(account.secretIds);
      } catch (cause) {
        throw new BindingLoadError(
          integrationId,
          null,
          `integration "${account.name}" (${account.provider}) has credentials that cannot be read: ${
            (cause as Error).message
          }`,
          { cause },
        );
      }

      const injected: InjectedSecret[] = Object.entries(secrets).map(([field, value]) => ({
        name: secretName(account, field),
        value,
      }));
      const redactor = composeSecretRedactors(bindingSecretRedactor(injected), platformRedactor);

      const parsed = registration.configSchema.safeParse({ ...account.config, ...secrets });
      if (!parsed.success) {
        // The paths, never the values: the merged document holds the credential.
        const paths = parsed.error.issues
          .map((issue) => (issue.path.length === 0 ? '<root>' : issue.path.join('.')))
          .join(', ');
        throw new BindingLoadError(
          integrationId,
          null,
          `integration "${account.name}" (${account.provider}) has configuration that fails its schema at: ${paths}`,
        );
      }

      let port: object;
      try {
        port = registration.create({
          integrationId,
          config: parsed.data,
          secrets,
          redactor,
        }) as object;
      } catch (cause) {
        throw new BindingLoadError(
          integrationId,
          null,
          `integration "${account.name}" (${account.provider}) could not be instantiated`,
          { cause },
        );
      }

      const probe = probeOf(port);
      if (probe === null) {
        // Unreachable while every registration builds an `IntegrationPort`, and asserted rather
        // than assumed because what a new provider gets wrong is the object (standing rule 22).
        throw new BindingLoadError(
          integrationId,
          null,
          `integration "${account.name}" (${account.provider}) built a port with no testConnection`,
        );
      }
      const outcome = await options.executor.execute<HealthProbe>({
        integration: {
          integrationId,
          provider: account.provider,
          type: account.type as IntegrationType,
        },
        action: 'test_connection',
        // The account's own configuration, never its credentials: `secrets` is merged into the
        // adapter's config above and is deliberately not in what the audit row records.
        payload: { name: account.name },
        projectId: null,
        taskId: null,
        mutating: false,
        perform: async () => probe(),
        // The verdict, not the provider's prose: `detail` is provider text and the executor
        // redacts what it stores, but a boolean is the evidence an operator reads in the audit.
        describeResult: (result) => ({ ok: result.ok }),
      });
      const result = outcome.result;
      return {
        ok: result.ok,
        checkedAt: result.checked_at,
        // The provider's own words, through the account's redactor. Every `testConnection` already
        // owes this (`healthProbeSchema.detail` says so) and it is applied **again** here rather
        // than trusted: the obligation is on every provider, and this is the one place that can
        // hold a provider that forgot to a promise the platform makes to the operator. Redaction is
        // idempotent over an already-redacted string, so the cost is one pass.
        detail: redactor.redactText(result.detail ?? '').value,
      };
    },
  };
};
