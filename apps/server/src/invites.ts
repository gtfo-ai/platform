/**
 * The composition of the invite links (TD-022's 2026-11-26 amendment): the `user_invites` SQL and
 * Better Auth's `createUser`, bound for `routes/invites.ts`.
 *
 * ## `createUser`, called server-side with no headers
 *
 * Better Auth 1.7.3's admin `create-user` checks a session only when the call carries a request or
 * headers (`if (!session && (ctx.request || ctx.headers)) throw UNAUTHORIZED`), so the platform's
 * own server may create an account once **it** has decided to — here, after the claim. The role is
 * the link's, one of `user_role`'s four labels; the admin plugin is configured with no `roles`
 * table, so it sets any role, and `users.role` is the database enum that refuses anything else.
 *
 * `Auth`'s type is built from `BetterAuthOptions` (`auth/better-auth.ts`), which erases the
 * plugins' endpoints, so the admin plugin's `createUser` is read through {@link AdminCreateUserApi}
 * — the one shape this module needs — and checked to be a function when it is first called.
 *
 * ## Which refusals release the claim
 *
 * Only those raised **before the user row is written**: Better Auth checks the email's shape and
 * whether a user has it, then inserts the user, then hashes the password and links it. So
 * `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL` (and `USER_ALREADY_EXISTS`) and `INVALID_EMAIL` are
 * refusals, and so is PostgreSQL's unique violation on the user's **email** — two different links
 * accepted with one email at once, where the second insert loses after both passed the lookup —
 * because that insert is the first write. Everything else is thrown, and the claim stays: the link
 * is burned rather than risk a second account (the route's module note, step 5).
 */
import type { JsonObject, UserRole } from '@platform/contracts';
import type { Auth } from './auth/better-auth.js';
import type { Database } from './queries/identity-queries.js';
import {
  claimInvite,
  completeInviteAccept,
  findInviteById,
  findInviteByTokenHash,
  insertInvite,
  listInvites,
  releaseInviteClaim,
  revokeInvite,
} from './queries/invite-queries.js';
import type { CreateInvitedUserOutcome, InviteCommands } from './routes/invites.js';

/** The admin plugin's server-side `createUser`, as far as this module calls it. */
export interface AdminCreateUserApi {
  readonly createUser: (input: {
    readonly body: {
      readonly email: string;
      readonly password: string;
      readonly name: string;
      readonly role: string;
    };
  }) => Promise<{ readonly user: { readonly id: string; readonly email: string } }>;
}

/** Better Auth's refusal codes that are raised before the user row is written. */
const EMAIL_TAKEN_CODES = new Set(['USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL', 'USER_ALREADY_EXISTS']);
const INVALID_EMAIL_CODES = new Set(['INVALID_EMAIL']);

const codeOf = (error: unknown): string | null => {
  const body = (error as { body?: { code?: unknown } } | null)?.body;
  return typeof body?.code === 'string' ? body.code : null;
};

/** PostgreSQL's unique violation on an email constraint, on the error or its `cause`. */
const isEmailUniqueViolation = (error: unknown): boolean => {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const pg = candidate as { code?: unknown; constraint?: unknown; detail?: unknown } | null;
    if (pg?.code !== '23505') continue;
    const where = `${String(pg.constraint ?? '')} ${String(pg.detail ?? '')}`;
    if (where.includes('email')) return true;
  }
  return false;
};

/** What a `createUser` failure means: a refusal before any write, or `null` to rethrow it. */
export const classifyCreateUserFailure = (
  error: unknown,
): Exclude<CreateInvitedUserOutcome, { kind: 'created' }> | null => {
  const code = codeOf(error);
  if (code !== null && EMAIL_TAKEN_CODES.has(code)) return { kind: 'email_taken' };
  if (code !== null && INVALID_EMAIL_CODES.has(code)) return { kind: 'invalid_email' };
  if (isEmailUniqueViolation(error)) return { kind: 'email_taken' };
  return null;
};

const adminApiOf = (auth: Auth): AdminCreateUserApi => {
  const api = auth.api as unknown as Partial<AdminCreateUserApi>;
  if (typeof api.createUser !== 'function') {
    throw new TypeError('Better Auth was composed without the admin plugin: no createUser');
  }
  return api as AdminCreateUserApi;
};

export const createInviteCommands = (options: {
  readonly database: Database;
  readonly auth: Auth;
  readonly recordAction: (input: {
    readonly userId: string;
    readonly action: string;
    readonly params: JsonObject;
    readonly taskId?: string | null;
  }) => Promise<void>;
}): InviteCommands => {
  const { database } = options;
  return {
    create: async (input) => insertInvite(database, input),
    list: async () => listInvites(database),
    findById: async (id) => findInviteById(database, id),
    findByTokenHash: async (hash) => findInviteByTokenHash(database, hash),
    revoke: async (input) => revokeInvite(database, input),
    claim: async (hash) => claimInvite(database, hash),
    release: async (id) => releaseInviteClaim(database, id),
    createUser: async (input: {
      readonly email: string;
      readonly name: string;
      readonly password: string;
      readonly role: UserRole;
    }) => {
      try {
        // No headers, on purpose: see the module note.
        const created = await adminApiOf(options.auth).createUser({
          body: {
            email: input.email,
            password: input.password,
            name: input.name,
            role: input.role,
          },
        });
        return { kind: 'created', userId: created.user.id, email: created.user.email };
      } catch (error) {
        const refusal = classifyCreateUserFailure(error);
        if (refusal === null) {
          throw error;
        }
        return refusal;
      }
    },
    completeAccept: async (input) => completeInviteAccept(database, input),
    recordAction: options.recordAction,
  };
};
