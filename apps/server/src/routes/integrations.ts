/**
 * The integration reads of technical/08 § "Integrations" (WP-15h part 2).
 *
 *   GET /api/integrations
 *   GET /api/integrations/:integration_id/setup-guide
 *   GET /api/integrations/:integration_id/refused-deliveries
 *
 *   GET /api/integrations/providers           the shipped providers and their fields (WP-100)
 *
 * The commands on that row — `POST /api/integrations`, `POST …/:id/test`, since WP-100
 * `PATCH …/:id`, and since WP-114 `POST …/:id/secrets` (re-seal) and `DELETE …/:id` (retire) — are
 * served by `routes/onboarding.ts`, with the audit row a read does not have.
 * `routes/client-census.test.ts` carries what the client calls and this server does not serve.
 *
 * ## `…/providers` is the catalogue, never a constructed provider
 *
 * The create form renders each provider's required non-credential fields from it (WP-100, PROGRESS
 * backlog 328), so the field list is read off the provider's own schema by
 * `packages/integrations/src/catalogue.ts` rather than copied into the SPA — a copy is a second list
 * to keep true, and importing the catalogue into the browser bundle would pull every adapter past
 * TD-013's budget.
 *
 * ## Organisation-scoped, at `maintainer`
 *
 * `integration.read` is `maintainer` (`packages/domain/src/permissions.ts`, Q36) and an integration
 * belongs to the organisation rather than to a project, so there is no project hook here: a binding
 * is what attaches one to a project, and `GET /api/projects/:id/bindings` is a different endpoint
 * (`routes/onboarding.ts` from WP-21, `routes/project-bindings.ts` since WP-181) scoped by the project rather than by the organisation. The SPA already tells the reader as much — *"Reading integration configuration
 * needs the maintainer role (Q36)"* — so the level was fixed before the route existed.
 *
 * ## Nothing on either response is a credential, and that is enforced rather than promised
 *
 * `queries/integration-queries.ts` removes the provider's declared secret fields from
 * `integrations.config` before it is published, and publishes nothing at all for a provider this
 * build does not ship. `secrets` is never joined. The setup guide is a file in this repository, not
 * a stored value.
 *
 * ## `webhook_url`, and the one thing it does not promise
 *
 * It is non-null exactly when the provider has an **inbound half** in this build
 * (`ProviderCatalogueEntry.inboundWebhook`, checked against the built adapter in
 * `packages/integrations/src/catalogue.test.ts`). Publishing it for a provider without one would put
 * a URL beside a guide that contradicts it — Sentry's own says *"Do not point a Sentry webhook at
 * the platform; nothing would consume it"* — and `IntegrationIngress` refuses such a delivery with
 * `unsupported_provider` anyway. It is the URL a delivery is posted to; it is not a claim that this
 * instance is reachable from the internet, which is `APP_BASE_URL`'s business and the guide's.
 */
import {
  apiErrorSchema,
  integrationProvidersResponseSchema,
  integrationsResponseSchema,
  refusedDeliveriesResponseSchema,
  setupGuideResponseSchema,
} from '@platform/contracts';
import {
  findShippedProvider,
  readSetupGuide,
  SHIPPED_PROVIDERS,
  toIntegrationProvider,
} from '@platform/integrations';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import type { Database } from '../queries/identity-queries.js';
import { findProjectRole } from '../queries/identity-queries.js';
import {
  findIntegrationRow,
  listIntegrationRows,
  listRefusedDeliveries,
  type OrganisationCredentialStates,
  toIntegrationSummary,
} from '../queries/integration-queries.js';

export interface IntegrationRoutesOptions {
  readonly database: Database;
  /** `APP_BASE_URL`; the origin the webhook URL is built on (technical/08 — one origin). */
  readonly baseUrl: string;
  /**
   * Whether each live organisation communication account decrypts (WP-157 (a), PROGRESS backlog
   * 413) — `createOrganisationAccountCredentials` in `knowledge.ts`, the loader that withholds the
   * prompt files. `null` publishes `credentials_readable: null` (*not checked*) on every row.
   */
  readonly organisationCredentials:
    | (() => Promise<readonly { readonly integrationId: string; readonly readable: boolean }[]>)
    | null;
}

const integrationParamsSchema = z.strictObject({ integration_id: z.uuid() });

/** `<base>/webhooks/<provider>/<integrationId>` — `routes/webhooks.ts`'s own path, built once. */
export const webhookUrlFor = (baseUrl: string, provider: string, integrationId: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/webhooks/${encodeURIComponent(provider)}/${encodeURIComponent(integrationId)}`;

export const registerIntegrationRoutes = async (
  app: FastifyInstance,
  options: IntegrationRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = {
    projectRole: async (projectId: string, userId: string) =>
      findProjectRole(options.database, projectId, userId),
  };

  typed.get(
    '/api/integrations',
    {
      preHandler: requirePermission(guard, 'integration.read'),
      schema: {
        summary: 'The organisation’s integrations',
        description:
          'Non-secret configuration only: the provider’s declared credential fields are removed here, and an integration whose provider this build does not ship publishes an empty `config` because the platform cannot tell its configuration from its credentials. `health.status` is `unknown` for a row nothing has probed; `POST /api/integrations/:id/test` (WP-21) is what writes `integrations.health`, so a tested integration publishes `ok` or `down` with the instant it was checked. `config_refusal` names the key paths of a stored configuration the provider’s schema refuses (a row written before WP-100 made the create parse it), with the `PATCH /api/integrations/:id` that repairs it; `null` when it parses. `retired_at` is when `DELETE /api/integrations/:id` retired it (its credentials destroyed, kept for the audit), `null` while live (WP-114). `credentials_readable` is whether a live organisation communication account’s sealed credentials decrypt — `false` withholds the prompt files of every project, which `credentials_consequence` says — and `null` for every other row, which this read does not check; it never carries a value (WP-157).',
        tags: ['org'],
        response: { 200: integrationsResponseSchema },
      },
    },
    async (request) => {
      const rows = await listIntegrationRows(options.database);
      const unknown = rows
        .filter((row) => findShippedProvider(row.provider) === undefined)
        .map((row) => row.id);
      if (unknown.length > 0) {
        // Named in the log rather than in the response: an operator needs to know *which* row lost
        // its configuration, and the response has no field that could say so.
        request.log.warn(
          { integration_ids: unknown },
          'integration rows name a provider this build does not ship; their configuration is withheld because its credential fields are unknown',
        );
      }
      const credentials: OrganisationCredentialStates =
        options.organisationCredentials === null
          ? null
          : new Map(
              (await options.organisationCredentials()).map((state) => [
                state.integrationId,
                state.readable,
              ]),
            );
      return {
        items: rows.map((row) =>
          toIntegrationSummary(row, findShippedProvider(row.provider), credentials),
        ),
      };
    },
  );

  typed.get(
    '/api/integrations/providers',
    {
      preHandler: requirePermission(guard, 'integration.read'),
      schema: {
        summary: 'The providers this build ships, and the configuration each one asks for',
        description:
          'Read off each provider’s own schema (WP-100): `config_fields` are the non-credential fields, `required` when the schema supplies no default, with the `kind` of value each takes (`string`, `integer`, `number`, `boolean`, `string_list`, `choice` with its `choices`, or `other`) so a form renders a typed control (WP-114), and `secret_fields` are the credentials — configured by naming an environment variable in `secret_refs`, never by value (TD-020). The create parses `config` with the same schema, so a form that sends every `required` field sends a document the provider accepts.',
        tags: ['org'],
        response: { 200: integrationProvidersResponseSchema },
      },
    },
    async () => ({ items: SHIPPED_PROVIDERS.map(toIntegrationProvider) }),
  );

  typed.get(
    '/api/integrations/:integration_id/setup-guide',
    {
      preHandler: requirePermission(guard, 'integration.read'),
      schema: {
        summary: 'The provider’s setup guide, for this integration',
        description:
          'The Markdown this repository ships for the provider (technical/06), with the webhook URL for *this* integration when the provider has an inbound half. Rendered as text, never as HTML — the SPA has no markdown-to-HTML step for anything (BD-022).',
        tags: ['org'],
        params: integrationParamsSchema,
        response: { 200: setupGuideResponseSchema, 409: apiErrorSchema },
      },
    },
    async (request) => {
      const integrationId = request.params.integration_id;
      const row = await findIntegrationRow(options.database, integrationId);
      if (row === undefined) {
        throw new NotFoundError(`integration ${integrationId}`);
      }
      const provider = findShippedProvider(row.provider);
      if (provider === undefined) {
        /**
         * **A provider this build does not ship has no guide, and inventing one is worse than
         * saying so.**
         *
         * 409 rather than 404: the integration exists and the *guide* does not, which is a
         * different fact from a wrong id, and it is the fact an operator has to act on. The
         * provider id is the operator's own configuration — no ticket text, no model output, no
         * credential — so naming it costs nothing a 5xx would protect (`UnprojectableRowError`
         * makes the same argument).
         */
        throw new HttpError(
          409,
          'provider_not_shipped',
          `integration ${integrationId} names provider "${row.provider}", which this build does not ship, so there is no setup guide for it. The shipped providers are the directories under packages/integrations/src/providers`,
        );
      }
      const guide = await readSetupGuide(provider);
      return {
        provider: provider.id,
        title: guide.title,
        markdown: guide.markdown,
        webhook_url: provider.inboundWebhook
          ? webhookUrlFor(options.baseUrl, provider.id, integrationId)
          : null,
      };
    },
  );

  typed.get(
    '/api/integrations/:integration_id/refused-deliveries',
    {
      // `integration.read` (maintainer), the gate of the list and the guide beside it: this is the
      // inbound half of the same integration, and the audience that debugs a dead button.
      preHandler: requirePermission(guard, 'integration.read'),
      schema: {
        summary: 'The newest inbound deliveries of this integration that were refused or ignored',
        description:
          'Each carries `inbox.error` — the adapter’s and the aggregate’s reasons, one per line, redacted at the write — and, since migration 0047, the provider accounts it was refused for as `unmapped_identity` (`null` on an older row, which recorded none). Newest first, at most 50. Everything here is provider-derived text (BD-022): render it, never parse it (WP-44, PROGRESS backlog 198).',
        tags: ['org'],
        params: integrationParamsSchema,
        response: { 200: refusedDeliveriesResponseSchema },
      },
    },
    async (request) => {
      const integrationId = request.params.integration_id;
      if ((await findIntegrationRow(options.database, integrationId)) === undefined) {
        throw new NotFoundError(`integration ${integrationId}`);
      }
      return { items: await listRefusedDeliveries(options.database, integrationId) };
    },
  );
};
