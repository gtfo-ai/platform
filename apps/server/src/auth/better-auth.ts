/**
 * Better Auth, configured for this platform (TD-022).
 *
 * What TD-022 asks for and where it is realised here:
 *
 * | TD-022 | here |
 * |---|---|
 * | email + password with Argon2id at OWASP parameters (`@node-rs/argon2`) | `emailAndPassword.password` |
 * | opaque database sessions, 7-day sliding, revocable | `session` |
 * | `__Host-` cookie, SameSite=Lax | `advanced.cookies.session_token` + `sessionCookieName` |
 * | the `admin` plugin | `plugins` |
 * | our own RBAC with numeric role levels | not here — `packages/domain`'s `can()`, via `rbac.ts` |
 * | OIDC-ready schema | the `accounts` table of migration 0011 |
 *
 * ### Why the field maps exist
 * Better Auth names its fields in camelCase; the platform's wire and column format is snake_case
 * everywhere (CLAUDE.md). Rather than making the auth tables the one snake_case exception, every
 * field is mapped to its column here. `test/integration/auth/better-auth-schema.integration.test.ts`
 * asks Better Auth itself whether migration 0011 satisfies this configuration, so a version bump
 * that adds a column fails a test instead of a login.
 *
 * ### Why `role` stays an enum in the database
 * `users.role` is the `user_role` enum of migration 0002. Better Auth's admin plugin writes it as
 * text and PostgreSQL casts the parameter, so the database keeps enforcing TD-022's four-role
 * vocabulary. Better Auth logs one warning about the type at start-up; that warning is the
 * guarantee working, not a defect. It is why `defaultRole` and `adminRoles` below are enum labels
 * and not the plugin's own `user` / `admin` defaults.
 */

import type { Algorithm } from '@node-rs/argon2';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins/admin';
import type pg from 'pg';
import type { ServerConfig } from '../config.js';

/**
 * `Algorithm.Argon2id`, spelled as its value.
 *
 * `@node-rs/argon2` declares `Algorithm` as an ambient `const enum`, which TypeScript refuses to
 * read under `verbatimModuleSyntax` (there is no runtime object to import). The value is part of
 * the Argon2 specification — 0 = Argon2d, 1 = Argon2i, 2 = Argon2id — so pinning it here is a
 * transcription of the standard, not a magic number.
 */
const ARGON2ID = 2 as Algorithm;

/**
 * The session cookie's name.
 *
 * TD-022 asks for `__Host-session`. The `__Host-` prefix is only *valid* on a cookie that is
 * `Secure`, and a browser will not store a `Secure` cookie received over plain HTTP — so on an
 * `http://` base URL (local development, the test harness, an instance behind a proxy that
 * terminates TLS but is addressed by its internal name) the prefixed name would make login
 * silently impossible. The prefix is therefore applied exactly when it can hold.
 */
export const sessionCookieName = (baseUrl: string): string =>
  new URL(baseUrl).protocol === 'https:' ? '__Host-session' : 'session';

export interface CreateAuthOptions {
  /** The platform's own pool, so Better Auth runs as the least-privilege role like everything else. */
  readonly pool: pg.Pool;
  readonly config: ServerConfig;
}

/**
 * The configuration object, separated from the instance it builds.
 *
 * `getMigrations()` from `better-auth/db/migration` takes exactly these options and reports what it
 * would still have to create in a live database. Exposing them lets
 * `test/integration/auth/better-auth-schema.integration.test.ts` hold migration 0011 to *this*
 * configuration rather than to a second copy of it written in the test — which would only ever
 * prove the copy right.
 */
export const authOptions = (options: CreateAuthOptions): BetterAuthOptions => {
  const { config } = options;
  // Normalised for the same reason `auth/plugin.ts` normalises its trusted-origin list, and to the
  // same value: a trailing slash or a default port in `APP_BASE_URL` must not be able to make the
  // two disagree about what this instance's origin is. Better Auth happens to normalise internally
  // today, which means passing the raw string is harmless *and* invisible — so the symmetry is
  // made explicit here rather than depending on a library's internals staying that way.
  const origin = new URL(config.baseUrl).origin;
  const secure = new URL(config.baseUrl).protocol === 'https:';
  const argon2Options = {
    algorithm: ARGON2ID,
    memoryCost: config.argon2.memoryCostKib,
    timeCost: config.argon2.timeCost,
    parallelism: config.argon2.parallelism,
  } as const;

  return {
    appName: 'agentic',
    secret: config.secretKey,
    baseURL: origin,
    basePath: '/api/auth',
    database: options.pool,
    // One instance, one organisation (BD-009), so the only origin that may drive the API is the
    // instance's own. A deployment that serves the SPA from somewhere else adds it here.
    trustedOrigins: [origin],
    telemetry: { enabled: false },

    emailAndPassword: {
      enabled: true,
      disableSignUp: !config.allowSignUp,
      // Better Auth's default is scrypt; TD-022 says Argon2id at OWASP parameters.
      password: {
        hash: async (password) => argon2Hash(password, argon2Options),
        verify: async ({ hash, password }) => {
          try {
            return await argon2Verify(hash, password, argon2Options);
          } catch {
            // A malformed or foreign hash is a failed verification, not a 500: it is exactly what
            // an attacker would provoke by pointing the instance at a half-migrated table.
            return false;
          }
        },
      },
    },

    advanced: {
      database: { generateId: 'uuid' },
      // The `__Secure-` prefix Better Auth adds on its own would produce `__Secure-__Host-session`;
      // `secure` is set explicitly below instead, which is the attribute that actually matters.
      useSecureCookies: false,
      defaultCookieAttributes: { secure, httpOnly: true, sameSite: 'lax', path: '/' },
      cookies: { session_token: { name: sessionCookieName(origin) } },
    },

    user: {
      modelName: 'users',
      fields: {
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
      additionalFields: {
        // Already a column (technical/03); declared so Better Auth does not try to add it and so
        // `status` survives a round trip through the adapter.
        status: { type: 'string', required: false, input: false, defaultValue: 'active' },
      },
    },
    session: {
      expiresIn: config.sessionTtlDays * 24 * 60 * 60,
      // Sliding: a session in daily use is extended, an abandoned one expires (TD-022).
      updateAge: 24 * 60 * 60,
      // The cookie cache would let a revoked session keep working until the cache expired.
      // Revocability is the property TD-022 chose database sessions for, so it stays off.
      cookieCache: { enabled: false },
      modelName: 'sessions',
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        userId: 'user_id',
      },
    },
    account: {
      modelName: 'accounts',
      fields: {
        accountId: 'account_id',
        providerId: 'provider_id',
        userId: 'user_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    verification: {
      modelName: 'verifications',
      fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' },
    },

    plugins: [
      admin({
        // Enum labels, not the plugin's `user` / `admin` defaults — see the module note.
        defaultRole: 'member',
        adminRoles: ['admin'],
        schema: {
          user: { fields: { banReason: 'ban_reason', banExpires: 'ban_expires' } },
          session: { fields: { impersonatedBy: 'impersonated_by' } },
        },
      }),
    ],
  };
};

export const createAuth = (options: CreateAuthOptions) => betterAuth(authOptions(options));

/** The configured Better Auth instance, with this platform's plugins and field maps. */
export type Auth = ReturnType<typeof createAuth>;

export interface PendingAuthSchema {
  /** Tables Better Auth would still have to create; empty when the migrations satisfy it. */
  readonly tablesToCreate: string[];
  /** Columns it would still have to add, per table. */
  readonly columnsToAdd: { readonly table: string; readonly fields: string[] }[];
}

/**
 * What Better Auth would still have to change about a live database to satisfy this configuration.
 *
 * The auth tables are hand-written SQL (TD-011/TD-019) whose shape is dictated by a library and two
 * plugins, so "these are the columns Better Auth wants" is a claim that has to be *asked*, not
 * asserted in a comment: the day an upgrade adds a column, a comment stays true-looking and the
 * login breaks. `test/integration/auth/better-auth-schema.integration.test.ts` calls this against a
 * freshly migrated database and requires both lists to be empty.
 *
 * It lives here rather than in the test so the check runs against the **real** options object
 * above; a copy of the configuration written in a test would only ever prove the copy right.
 */
export const pendingAuthSchema = async (options: CreateAuthOptions): Promise<PendingAuthSchema> => {
  const { getMigrations } = await import('better-auth/db/migration');
  const { toBeCreated, toBeAdded } = await getMigrations(authOptions(options));
  return {
    tablesToCreate: toBeCreated.map((table) => table.table),
    columnsToAdd: toBeAdded.map((table) => ({
      table: table.table,
      fields: Object.keys(table.fields),
    })),
  };
};
