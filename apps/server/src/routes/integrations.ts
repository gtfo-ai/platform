/**
 * The two integration reads of technical/08 § "Integrations" (WP-15h part 2).
 *
 *   GET /api/integrations
 *   GET /api/integrations/:integration_id/setup-guide
 *
 * The other three on that row — `POST /api/integrations`, `PATCH …/:id` and `POST …/:id/test` —
 * write, and a write needs the audit row and the idempotency key a read does not have. They belong
 * to the work package that gives the settings screen a command surface; `routes/client-census.test.ts`
 * carries what the client calls and this server does not serve.
 *
 * ## Organisation-scoped, at `maintainer`
 *
 * `integration.read` is `maintainer` (`packages/domain/src/permissions.ts`, Q36) and an integration
 * belongs to the organisation rather than to a project, so there is no project hook here: a binding
 * is what attaches one to a project, and `GET /api/projects/:id/bindings` is a different endpoint
 * nobody has built. The SPA already tells the reader as much — *"Reading integration configuration
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
  integrationsResponseSchema,
  setupGuideResponseSchema,
} from '@platform/contracts';
import { findShippedProvider, readSetupGuide } from '@platform/integrations';
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
  toIntegrationSummary,
} from '../queries/integration-queries.js';

export interface IntegrationRoutesOptions {
  readonly database: Database;
  /** `APP_BASE_URL`; the origin the webhook URL is built on (technical/08 — one origin). */
  readonly baseUrl: string;
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
          'Non-secret configuration only: the provider’s declared credential fields are removed here, and an integration whose provider this build does not ship publishes an empty `config` because the platform cannot tell its configuration from its credentials. `health.status` is `unknown` for every row until something writes `integrations.health` — nothing does in this build, and `POST /api/integrations/:id/test` is the endpoint that would.',
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
      return {
        items: rows.map((row) => toIntegrationSummary(row, findShippedProvider(row.provider))),
      };
    },
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
};
