/**
 * `POST /webhooks/:provider/:integrationId` — technical/08's endpoint table, technical/06 §
 * "Inbound: webhooks and polling" (WP-15c).
 *
 * **This is the endpoint that makes production start a ticket.** Before it, nothing outside a test
 * emitted `ticket.matched`, so the pipeline twenty-eight work packages built had no first event.
 *
 * ## Three things about this route that are not like the others
 *
 * 1. **It is unauthenticated, and that is the design.** A provider has no platform session; the
 *    credential it presents is a signature over the body, checked against the binding's own secret
 *    by the provider adapter (TD-024). Which means the *only* thing standing between the internet
 *    and this handler is `inbound.verify`, so its refusal is the branch that matters:
 *    `WebhookIngress` refuses before it stores anything, and standing rule 18's shape — an unset
 *    secret producing a permissive result — is what each adapter's `verify` is written against.
 *    TD-022's CSRF rule does not apply and does not fire: `csrfViolation` only refuses a *mutating
 *    request that carries a session cookie*, which a provider's `POST` never does.
 * 2. **The body reaches the handler unparsed.** Every signature scheme in TD-024 is computed over
 *    the **bytes**, so a parsed-and-re-serialised object verifies a different document than the one
 *    that was signed. A raw-string content-type parser is registered inside an encapsulated plugin,
 *    exactly as `auth/plugin.ts` does for Better Auth, so it applies here and to nothing else.
 * 3. **A refusal is not always a 4xx.** Rule 20: a delivery whose kind the provider cannot key — a
 *    GitLab wiki or release hook — is answered `202 {accepted: false}`, because a vendor that keeps
 *    receiving errors eventually **disables the webhook**, which would take the deliveries that do
 *    matter with it. What does answer 4xx is a delivery that failed its signature (401) and one
 *    whose body is not JSON (400): the first is an attacker or a misconfiguration an operator must
 *    see, the second cannot be stored in a `jsonb` column or read by any normaliser.
 *
 * ## What is deliberately not here
 *
 * technical/08 says "webhook endpoints limited per integration". There is no rate limit on this
 * route yet, and the bound that exists instead is stated rather than implied: a refused delivery
 * writes **one** `integration_actions` row and **no** event and **no** inbox row, so the cost an
 * unauthenticated caller who knows an integration's uuid can impose is one insert per request
 * against a partitioned append-only table. Filed as **Q60** with a recommendation rather than
 * half-built.
 */

import type { InboundDeliveryOutcome, WebhookIngress } from '@platform/application';
import type { Id, WebhookAcceptedResponse } from '@platform/contracts';
import { webhookAcceptedResponseSchema, webhookParamsSchema } from '@platform/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { routeLabel } from '../metrics.js';

export interface WebhookRoutesOptions {
  readonly ingress: WebhookIngress;
}

/**
 * Node lower-cases header names; a header sent twice arrives as an array.
 *
 * Joining with `, ` is what RFC 9110 says a repeated field means, and it is what every signature
 * scheme here would have hashed anyway — but none of the headers TD-024 reads is ever repeated, so
 * the branch exists to avoid `[object Object]` reaching a verifier rather than to be correct about
 * a case that happens.
 */
export const flattenHeaders = (
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> => {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    flat[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return flat;
};

/** Every status this route can answer, so `reply.status()` stays typed against its own schema. */
export type WebhookStatus = 202 | 400 | 401 | 404;

/** The HTTP answer for each outcome. See note 3 in the module docblock for the 202s. */
export const statusFor = (outcome: InboundDeliveryOutcome): WebhookStatus => {
  switch (outcome.kind) {
    case 'accepted':
    case 'duplicate':
      return 202;
    case 'unknown_integration':
      return 404;
    default:
      break;
  }
  switch (outcome.reason) {
    case 'unverified':
      return 401;
    case 'provider_mismatch':
    case 'unsupported_provider':
      return 404;
    case 'malformed_body':
      return 400;
    // Rule 20: an authentic delivery of a kind nobody can key is received and performs nothing.
    case 'unkeyable':
      return 202;
  }
};

const bodyFor = (outcome: InboundDeliveryOutcome): WebhookAcceptedResponse => ({
  accepted: outcome.kind === 'accepted' || outcome.kind === 'duplicate',
  delivery_id:
    outcome.kind === 'accepted' || outcome.kind === 'duplicate' ? outcome.deliveryId : null,
});

export const registerWebhookRoutes = async (
  app: FastifyInstance,
  options: WebhookRoutesOptions,
): Promise<void> => {
  await app.register(async (scope) => {
    // Scoped to this child instance only — see note 2 in the module docblock. Fastify scopes a
    // content-type parser to the plugin that registers it, which is why this does not turn every
    // JSON route in the application into a string handler.
    scope.addContentTypeParser(
      ['application/json', 'application/x-www-form-urlencoded', 'text/plain'],
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, body);
      },
    );

    const typed = scope.withTypeProvider<ZodTypeProvider>();
    typed.post(
      '/webhooks/:provider/:integrationId',
      {
        schema: {
          summary: 'Receive a provider webhook delivery',
          description:
            'Unauthenticated by design: the credential is the signature over the body, checked against the binding’s own secret (TD-024). The response is 2xx as soon as the delivery has been recorded and normalised; an unverifiable signature is 401 and is audited.',
          tags: ['webhooks'],
          params: webhookParamsSchema,
          // Every status this route answers, because `reply.status()` is typed from this map and a
          // route that declared only 200 could not send the 202 it actually answers with.
          response: {
            202: webhookAcceptedResponseSchema,
            400: webhookAcceptedResponseSchema,
            401: webhookAcceptedResponseSchema,
            404: webhookAcceptedResponseSchema,
          },
        },
      },
      async (request, reply) => {
        const { provider, integrationId } = request.params;
        const outcome = await options.ingress.deliver({
          provider,
          integrationId: integrationId as Id,
          delivery: {
            headers: flattenHeaders(request.headers),
            // An empty body is a string too; anything the parser could not produce is not a
            // delivery, and every adapter's `verify` refuses `''`.
            body: typeof request.body === 'string' ? request.body : '',
          },
        });
        request.log.info(
          {
            route: routeLabel(request.routeOptions.url),
            provider,
            integration_id: integrationId,
            outcome: outcome.kind,
            ...(outcome.kind === 'refused' ? { reason: outcome.reason } : {}),
            ...(outcome.kind === 'accepted' ? { events: outcome.events } : {}),
          },
          'webhook delivery handled',
        );
        return reply.status(statusFor(outcome)).send(bodyFor(outcome));
      },
    );
  });
};
