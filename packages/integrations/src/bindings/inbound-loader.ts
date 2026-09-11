/**
 * Turning `integrations.id` into the objects the webhook endpoint needs — the mirror of
 * `loader.ts`, from the account's side (WP-15c).
 *
 * `createPipelineIntegrationsLoader` starts from a **project** and builds the two ports the
 * pipeline calls. An inbound delivery arrives at `/webhooks/:provider/:integrationId` and starts
 * from an **account**: the credential that signs it belongs to the account, `inbox(provider,
 * delivery_id)` has no project column, and which project the delivery is *about* is a question only
 * the normaliser can answer. So this loader answers both halves separately.
 *
 * ## Two constructions, and why they are not one
 *
 * - **The account adapter** is built from `integrations.config` alone. It answers *is this
 *   authentic* and *which delivery is it*, which are properties of the account.
 * - **One adapter per binding** is built from `integrations.config` with that binding's
 *   `bindings.config` merged over it, exactly as the project loader does. It answers *what does
 *   this mean for this project* — and a per-project override of a pick-up rule is the reason
 *   `bindings.config` exists (`ProjectBinding`'s docblock).
 *
 * Merging them would make one document answer both, and then a project narrowing its pick-up label
 * would silently change which deliveries the **account** accepts.
 *
 * ## Absent, unbound and broken are three different facts
 *
 * - No integration with that id → `null`. The endpoint answers 404 and writes nothing: there is no
 *   row an audit could reference.
 * - An integration nobody has bound → an account with **no bindings**. The delivery is verified,
 *   stored and performs nothing, with the reason on the row. Collapsing it into the case above
 *   would make an unused account look like a forged URL.
 * - An integration whose adapter cannot be built — an unregistered provider, a config that fails
 *   its schema, a credential that will not decrypt → {@link BindingLoadError}, thrown. Same rule as
 *   the project loader: a binding that fails to load must not become a binding that quietly is not
 *   there.
 *
 * ## The redactor is the account's, and that is what closes the `X-Gitlab-Token` hole
 *
 * `ResolvedInboundIntegration.redactor` is composed from this account's **own resolved
 * credentials** plus whatever the composition root adds (TD-012 step 2's pattern rules). GitLab's
 * legacy scheme sends the binding's webhook secret as plain text in a header, so the exact-match
 * redactor built from that very secret is the thing that finds it on the way to `inbox.headers`.
 * A run-scoped credential cannot appear in an inbound delivery, so there is no `IntegrationCallScope`
 * here — that is Q55's answer for the outbound direction and it has no inbound twin.
 */
import type {
  BindingRepository,
  InboundBinding,
  InboundIntegrationLoader,
  InboundNormaliser,
  InjectedSecret,
  IntegrationAccount,
  ResolvedInboundIntegration,
  SecretRedactor,
  SecretStore,
} from '@platform/application';
import {
  bindingSecretRedactor,
  composeSecretRedactors,
  noSecretsRedactor,
} from '@platform/application';
import type { Id, IntegrationType, JsonObject } from '@platform/contracts';
import type { IntegrationRegistry } from '../registry.js';
import { BindingLoadError } from './loader.js';

export interface InboundIntegrationLoaderOptions {
  readonly repository: BindingRepository;
  readonly secrets: SecretStore;
  readonly registry: IntegrationRegistry;
  /**
   * The platform's own redactor, composed **after** the account's exact-match one — TD-012 step 2.
   *
   * Optional in the type and *named* rather than defaulted at every call site: the composition root
   * passes `patternRedactor()`, and a caller that really means "nothing but the account's own
   * secrets" passes {@link noSecretsRedactor} in full. Standing rule 31 is why it is not a silent
   * no-op: an optional security dependency is an absent one, and the visible default here is the
   * account's own redactor, which is never absent.
   */
  readonly platformRedactor?: SecretRedactor;
}

/** `<provider>:<integrationId>:<field>` — the same naming the project loader uses. */
const secretName = (account: IntegrationAccount, field: string): string =>
  `${account.provider}:${account.integrationId}:${field}`;

/** Asked of the built object, not of its type: what a new provider gets wrong is the object. */
const inboundOf = (port: object): InboundNormaliser | null =>
  'inbound' in port ? ((port as { inbound: InboundNormaliser }).inbound ?? null) : null;

export const createInboundIntegrationLoader = (
  options: InboundIntegrationLoaderOptions,
): InboundIntegrationLoader => {
  const platformRedactor = options.platformRedactor ?? noSecretsRedactor();

  return {
    forIntegration: async (integrationId: Id): Promise<ResolvedInboundIntegration | null> => {
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

      const build = (config: JsonObject, what: string): object => {
        const parsed = registration.configSchema.safeParse({ ...config, ...secrets });
        if (!parsed.success) {
          // The paths, never the values: the merged document holds the credential.
          const paths = parsed.error.issues
            .map((issue) => (issue.path.length === 0 ? '<root>' : issue.path.join('.')))
            .join(', ');
          throw new BindingLoadError(
            integrationId,
            null,
            `${what} of integration "${account.name}" (${account.provider}) has configuration that fails its schema at: ${paths}`,
          );
        }
        try {
          return registration.create({
            integrationId,
            config: parsed.data,
            secrets,
            redactor,
          }) as object;
        } catch (cause) {
          throw new BindingLoadError(
            integrationId,
            null,
            `${what} of integration "${account.name}" (${account.provider}) could not be instantiated`,
            { cause },
          );
        }
      };

      const inbound = inboundOf(build(account.config, 'the account adapter'));
      const ref = {
        integrationId,
        provider: account.provider,
        type: account.type,
      };
      if (inbound === null) {
        // A provider with no inbound half can have no bindings that normalise anything; building
        // them would be a set the endpoint could never use.
        return { ref, inbound: null, bindings: [], redactor };
      }

      const bindings: InboundBinding[] = [];
      for (const binding of account.bindings) {
        const port = build(binding.config, `the binding of project ${binding.projectId}`);
        const bound = inboundOf(port);
        if (bound === null) {
          // Unreachable while one registration builds both — the account adapter above already
          // proved this provider has an inbound half — and asserted rather than assumed, because a
          // registration whose `create` branched on config would make it reachable (rule 22).
          throw new BindingLoadError(
            integrationId,
            binding.bindingId,
            `the binding of project ${binding.projectId} built a port with no inbound half while the account's has one`,
          );
        }
        bindings.push({
          bindingId: binding.bindingId,
          projectId: binding.projectId,
          inbound: bound,
        });
      }

      return { ref, inbound, bindings, redactor };
    },
  };
};
