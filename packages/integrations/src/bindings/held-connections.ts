/**
 * Which accounts select a **held** inbound connection, and how to open one — the integrations
 * ring's half of WP-43. `@platform/application`'s `inbound-connections.ts` decides *when* and *in
 * which process*; this decides *what*.
 *
 * It mirrors the account half of `inbound-loader.ts` on purpose: the connection belongs to the
 * **account** (`integrations`), because Slack's app-level token and the connection it opens are the
 * app's, not a project's, and every delivery it produces is addressed to
 * `/webhooks/<provider>/<integrationId>` exactly as an HTTP one is. So the selection is read off
 * `integrations.config` alone and a binding's overlay is not consulted — a project cannot switch its
 * account's transport, and since WP-73b (backlog 201) a binding write refuses `socket_mode` — and
 * since WP-79 (backlog 268) a binding stored before that refusal has its copy dropped on read, so
 * the project's own merged config (its buttons) agrees with the transport this module holds.
 *
 * ## Every outbound call goes through the executor
 *
 * The one call a connection makes on the binding's behalf — Slack's `apps.connections.open`, at
 * start and at every reconnect — is wrapped as a **read** of `IntegrationActionExecutor`: the
 * egress allow-list (`APP_INTEGRATION_HOSTS`) is asked before it leaves, the provider's rate limit
 * is spent, and each open leaves one `integration_actions` row. `describeResult` is omitted on
 * purpose: the result is a `wss://` URL whose ticket is a short-lived credential, and an audit row
 * is not where it belongs. The **WebSocket** that URL opens is not an HTTP call and does not pass
 * through the executor: its host is whatever Slack answered, over a call to a host the operator
 * declared — stated rather than implied, and filed in PROGRESS under WP-43.
 */
import { createHash } from 'node:crypto';
import type {
  BindingRepository,
  BrokenHeldConnectionAccount,
  HeldConnectionAccount,
  HeldConnectionDirectory,
  HeldConnectionFingerprint,
  IntegrationActionExecutor,
  SecretRedactor,
  SecretStore,
} from '@platform/application';
import { bindingSecretRedactor, composeSecretRedactors } from '@platform/application';
import type { Id, IntegrationType } from '@platform/contracts';
import type { IntegrationRegistry } from '../registry.js';

export interface HeldConnectionDirectoryOptions {
  readonly repository: BindingRepository;
  readonly secrets: SecretStore;
  readonly registry: IntegrationRegistry;
  /** TD-012 step 2, composed after the account's own exact-match redactor — `inbound-loader.ts`. */
  readonly platformRedactor: SecretRedactor;
  /** The process's one executor, so the open is audited, rate-limited and egress-checked. */
  readonly executor: IntegrationActionExecutor;
  /** Every `integrations.id`, in a stable order. */
  integrationIds(): Promise<readonly Id[]>;
}

const secretName = (provider: string, integrationId: Id, field: string): string =>
  `${provider}:${integrationId}:${field}`;

/** JSON with every object's keys sorted, so a reordered column is not a changed one. */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/**
 * WP-73b, PROGRESS backlog 197: the account's `config` and the **ids** of its sealed credentials —
 * never a value — digested, so the supervisor can tell a changed account from an unchanged one.
 * `integrations.config` holds no credential (the credential fields are sealed into `secrets`, and
 * `GET /api/integrations` strips them if one is pasted there anyway); the digest is one-way either
 * way, and it is compared in memory, never logged.
 */
const fingerprintOf = (account: {
  readonly config: unknown;
  readonly secretIds: readonly string[];
}): HeldConnectionFingerprint =>
  createHash('sha256')
    .update(canonicalJson({ config: account.config, secret_ids: [...account.secretIds] }))
    .digest('hex');

export const createHeldConnectionDirectory = (
  options: HeldConnectionDirectoryOptions,
): HeldConnectionDirectory => {
  const entryFor = async (
    integrationId: Id,
  ): Promise<HeldConnectionAccount | BrokenHeldConnectionAccount | null> => {
    const account = await options.repository.forIntegration(integrationId);
    if (account === null || !options.registry.has(account.provider)) {
      // Nothing this build registers can hold a connection for it; `inbound-loader.ts` names an
      // unregistered provider when a delivery arrives, which is where it is a fault.
      return null;
    }
    let registration: ReturnType<IntegrationRegistry['get']>;
    try {
      registration = options.registry.get(account.type as IntegrationType, account.provider);
    } catch {
      // Registered under another type than the row says: the same fault, named at delivery.
      return null;
    }
    const support = registration.inboundConnection;
    if (support === undefined || !support.selected(account.config)) {
      return null;
    }
    const named = {
      integrationId,
      provider: account.provider,
      name: account.name,
      fingerprint: fingerprintOf(account),
    };
    let secrets: Readonly<Record<string, string>>;
    try {
      secrets = await options.secrets.resolve(account.secretIds);
    } catch (cause) {
      return {
        kind: 'broken',
        ...named,
        detail: `its credentials cannot be read: ${(cause as Error).message}`,
      };
    }
    const parsed = registration.configSchema.safeParse({ ...account.config, ...secrets });
    if (!parsed.success) {
      // The paths, never the values: the merged document holds the credential.
      const paths = parsed.error.issues
        .map((issue) => (issue.path.length === 0 ? '<root>' : issue.path.join('.')))
        .join(', ');
      return {
        kind: 'broken',
        ...named,
        detail: `its configuration fails its schema at: ${paths}`,
      };
    }
    const redactor = composeSecretRedactors(
      bindingSecretRedactor(
        Object.entries(secrets).map(([field, value]) => ({
          name: secretName(account.provider, integrationId, field),
          value,
        })),
      ),
      options.platformRedactor,
    );
    return {
      kind: 'selected',
      ...named,
      open: (onDelivery) =>
        support.open(
          { integrationId, config: parsed.data, secrets, redactor },
          {
            onDelivery,
            execute: async (ref, action, perform) =>
              (
                await options.executor.execute({
                  integration: ref,
                  action,
                  mutating: false,
                  payload: {},
                  perform: async () => perform(),
                })
              ).result,
          },
        ),
    };
  };

  return {
    list: async () => {
      const entries: (HeldConnectionAccount | BrokenHeldConnectionAccount)[] = [];
      for (const integrationId of await options.integrationIds()) {
        const entry = await entryFor(integrationId);
        if (entry !== null) {
          entries.push(entry);
        }
      }
      return entries;
    },
  };
};
