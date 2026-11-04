/**
 * `GET /api/setup-state` — the sign-in page's one read before anybody has a session (WP-291).
 *
 * The page names `APP_BOOTSTRAP_ADMIN_EMAIL` while nobody has signed in yet and stops once
 * somebody has; this answers which of the two it is (`auth/setup-state.ts` for the cache,
 * `queries/setup-state-queries.ts` for where the fact is stored).
 *
 * ## Public, and the one bit it discloses
 *
 * The route has **no guard**, because the page that reads it is the one page with no session. What
 * it tells an anonymous caller is exactly one bit: *whether this instance has ever been signed in
 * to*. That is an accepted disclosure (technical/08 § "Auth and RBAC"): it names no account, no
 * count and no time, and an instance nobody has used yet is already distinguishable by the fact
 * that its bootstrap address answers no traffic. The response schema is strict so the read cannot
 * grow a second fact by accident.
 *
 * **No rate limit of its own**, because the server has no limiter for public reads (the webhook
 * door's bucket is per integration; Better Auth limits its own routes). It needs none: once an
 * instance has been used the answer is cached in-process and the read touches no database, so the
 * only instance where it queries per request is one with an empty audit table.
 */
import { setupStateResponseSchema } from '@platform/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

export interface SetupStateReader {
  readonly firstSignInPending: () => Promise<boolean>;
}

export const registerSetupStateRoutes = async (
  app: FastifyInstance,
  options: { readonly setupState: SetupStateReader },
): Promise<void> => {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/api/setup-state',
    {
      schema: {
        summary: 'Whether anybody has signed in to this instance yet',
        description:
          'Public, read before a session exists: the sign-in page names `APP_BOOTSTRAP_ADMIN_EMAIL` only while `first_sign_in_pending` is true. It discloses one bit — whether the instance has ever been signed in to — and nothing else (technical/08 § "Auth and RBAC"). The fact is durable: it is `users.first_signed_in_at`, set at an account’s first sign-in (or, on an instance that predates the column, any `human_actions` row), so session expiry and sign-out do not bring the hint back.',
        tags: ['auth'],
        response: { 200: setupStateResponseSchema },
      },
    },
    async () => ({ first_sign_in_pending: await options.setupState.firstSignInPending() }),
  );
};
