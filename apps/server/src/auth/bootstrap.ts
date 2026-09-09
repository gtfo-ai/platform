/**
 * Creating the first administrator.
 *
 * A fresh instance has no users, and open registration is off by default (`APP_ALLOW_SIGNUP`) —
 * a self-hosted instance reachable from the internet is not a sign-up page. Something therefore
 * has to create the first account, and the two candidate designs are:
 *
 * - **"the first person to sign up becomes admin"** — one unauthenticated request between the
 *   container starting and the operator reaching it and the instance belongs to somebody else;
 * - **an explicit operator credential in the environment**, which is where every other credential
 *   in this platform already lives (TD-020), is auditable in the compose file, and cannot be won
 *   by whoever gets there first.
 *
 * The second is what this does; `docs/OPEN-QUESTIONS.md` Q39 records it and asks for a founder
 * confirmation. Afterwards, administrators invite users (`POST /api/org/users/invite`,
 * technical/08), which is WP-20's screen and a later work package's endpoint.
 *
 * The account is created through Better Auth's own sign-up API rather than by writing rows, so the
 * password is hashed by exactly the code path a later login verifies it with. Sign-up is disabled
 * on the *served* instance, so a second, unexposed Better Auth instance with sign-up enabled is
 * built for this one call — a server-side function call, never a route.
 */
import type { Logger } from '@platform/application';
import { db as dbAdapters } from '@platform/infrastructure';
import { eq, sql } from 'drizzle-orm';
import type pg from 'pg';
import type { ServerConfig } from '../config.js';
import type { Database } from '../queries/identity-queries.js';
import { createAuth } from './better-auth.js';

const { users } = dbAdapters.schema;

export type BootstrapOutcome =
  | { readonly kind: 'created'; readonly email: string }
  | { readonly kind: 'users_exist' }
  | { readonly kind: 'not_configured' }
  | { readonly kind: 'raced' };

export interface BootstrapAdminOptions {
  readonly pool: pg.Pool;
  readonly database: Database;
  readonly config: ServerConfig;
  readonly logger: Logger;
}

export const countUsers = async (database: Database): Promise<number> => {
  const result = await database.select({ total: sql<string>`count(*)` }).from(users);
  return Number.parseInt(result[0]?.total ?? '0', 10);
};

export const bootstrapAdministrator = async (
  options: BootstrapAdminOptions,
): Promise<BootstrapOutcome> => {
  const { config, database, logger } = options;

  if ((await countUsers(database)) > 0) {
    return { kind: 'users_exist' };
  }

  if (config.bootstrapAdminEmail === null || config.bootstrapAdminPassword === null) {
    logger.warn(
      { allow_signup: config.allowSignUp },
      'no users exist and APP_BOOTSTRAP_ADMIN_EMAIL is not set: nobody can sign in to this instance yet',
    );
    return { kind: 'not_configured' };
  }

  // Sign-up is disabled on the served instance; this one is never mounted on a route.
  const bootstrapAuth = createAuth({
    pool: options.pool,
    config: { ...config, allowSignUp: true },
  });

  try {
    const result = await bootstrapAuth.api.signUpEmail({
      body: {
        email: config.bootstrapAdminEmail,
        password: config.bootstrapAdminPassword,
        name: config.bootstrapAdminName,
      },
    });

    // Sign-up applies the admin plugin's `defaultRole` (member). The bootstrap account is the
    // administrator by definition, so it is promoted in the same boot — and `email_verified` is
    // set because an operator who typed the address into the deployment is the verification.
    await database
      .update(users)
      .set({ role: 'admin', emailVerified: true, updatedAt: new Date() })
      .where(eq(users.id, result.user.id));

    logger.info(
      { email: config.bootstrapAdminEmail, user_id: result.user.id },
      'created the bootstrap administrator',
    );
    return { kind: 'created', email: config.bootstrapAdminEmail };
  } catch (error) {
    // Two replicas booting together both see an empty table; `users.email` is unique, so exactly
    // one wins and the other lands here. That is the intended outcome, not a failure.
    if ((await countUsers(database)) > 0) {
      logger.info({ error: String(error) }, 'another instance created the bootstrap administrator');
      return { kind: 'raced' };
    }
    throw error;
  }
};
