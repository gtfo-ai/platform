/**
 * `user_invites` (migration 0122, TD-022's 2026-11-26 amendment): the one-time invite links' SQL.
 *
 * Every read goes through Drizzle's **builder**, never a raw `execute`: a raw `timestamptz` comes
 * back as an unparsed string, which is how the identity pair once answered 500 on every request
 * (`routes/org.ts`, `toWireIdentityMapping`). Every row is read **with the database's `now()`**
 * beside it, so the state a list, an inspect or a refusal computes (`inviteStateAt`) is the one the
 * claim's own `expires_at > now()` decides.
 *
 * Nothing here ever holds or returns a token — only its SHA-256, and only as a lookup key.
 */
import type { JsonObject, UserRole } from '@platform/contracts';
import { db as dbAdapters } from '@platform/infrastructure';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Database } from './identity-queries.js';

const { humanActions, userInvites } = dbAdapters.schema;

/** One link, with the database's `now()` read in the same statement. */
export interface InviteRecord {
  readonly id: string;
  readonly role: UserRole;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly acceptedUserId: string | null;
  readonly revokedAt: Date | null;
  /** The database's `now()` when the row was read. */
  readonly now: Date;
}

/** `now()`, decoded by a `timestamptz` column's own mapper — a `Date`, never a string. */
const dbNow = () => sql`now()`.mapWith(userInvites.createdAt);

const RECORD = {
  id: userInvites.id,
  role: userInvites.role,
  createdBy: userInvites.createdBy,
  createdAt: userInvites.createdAt,
  expiresAt: userInvites.expiresAt,
  acceptedAt: userInvites.acceptedAt,
  acceptedUserId: userInvites.acceptedUserId,
  revokedAt: userInvites.revokedAt,
} as const;

const RECORD_WITH_NOW = { ...RECORD, now: dbNow() } as const;

/** The administrator's list holds at most this many links, newest first. */
export const MAX_LISTED_INVITES = 200;

/**
 * Makes a link and records `org.user.invite` (role, hours) as its maker — **one transaction**, so a
 * link never exists without its audit row, nor the row without its link.
 */
export const insertInvite = async (
  database: Database,
  input: {
    readonly id: string;
    readonly tokenSha256: string;
    readonly role: UserRole;
    readonly createdBy: string;
    readonly validForHours: number;
  },
): Promise<InviteRecord> =>
  database.transaction(async (tx) => {
    const rows = await tx
      .insert(userInvites)
      .values({
        id: input.id,
        tokenSha256: input.tokenSha256,
        role: input.role,
        createdBy: input.createdBy,
        createdAt: sql`now()`,
        expiresAt: sql`now() + make_interval(hours => ${input.validForHours}::int)`,
      })
      .returning(RECORD_WITH_NOW);
    const row = rows[0];
    if (row === undefined) {
      throw new Error('the invite insert returned no row');
    }
    await tx.insert(humanActions).values({
      taskId: null,
      userId: input.createdBy,
      action: 'org.user.invite',
      params: { invite_id: row.id, role: row.role, valid_for_hours: input.validForHours },
    });
    return row;
  });

export const listInvites = async (database: Database): Promise<readonly InviteRecord[]> =>
  database
    .select(RECORD_WITH_NOW)
    .from(userInvites)
    .orderBy(desc(userInvites.createdAt), desc(userInvites.id))
    .limit(MAX_LISTED_INVITES);

export const findInviteById = async (
  database: Database,
  id: string,
): Promise<InviteRecord | null> => {
  const rows = await database
    .select(RECORD_WITH_NOW)
    .from(userInvites)
    .where(eq(userInvites.id, id))
    .limit(1);
  return rows[0] ?? null;
};

export const findInviteByTokenHash = async (
  database: Database,
  tokenSha256: string,
): Promise<InviteRecord | null> => {
  const rows = await database
    .select(RECORD_WITH_NOW)
    .from(userInvites)
    .where(eq(userInvites.tokenSha256, tokenSha256))
    .limit(1);
  return rows[0] ?? null;
};

/**
 * Revokes a link that has made no account and is not revoked yet — **including one an accept holds
 * the claim of** (`accepted_at` set, `accepted_user_id` null): the revoke stands, and the release
 * that follows a refused email clears only the claim, so the link stays revoked. Records
 * `org.user.invite_revoke` in the same transaction. `null` when there was nothing to revoke.
 */
export const revokeInvite = async (
  database: Database,
  input: { readonly id: string; readonly revokedBy: string },
): Promise<InviteRecord | null> =>
  database.transaction(async (tx) => {
    const rows = await tx
      .update(userInvites)
      .set({ revokedAt: sql`now()`, revokedBy: input.revokedBy })
      .where(
        and(
          eq(userInvites.id, input.id),
          isNull(userInvites.acceptedUserId),
          isNull(userInvites.revokedAt),
        ),
      )
      .returning(RECORD_WITH_NOW);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    await tx.insert(humanActions).values({
      taskId: null,
      userId: input.revokedBy,
      action: 'org.user.invite_revoke',
      params: { invite_id: row.id, role: row.role },
    });
    return row;
  });

/**
 * **The claim** (the amendment's item 4): one conditional update, so of two concurrent accepts of
 * one link exactly one gets a row back — the second waits on the first's row lock, re-reads
 * `accepted_at` once it commits, and matches nothing.
 */
export const claimInvite = async (
  database: Database,
  tokenSha256: string,
): Promise<{ readonly id: string; readonly role: UserRole } | null> => {
  const rows = await database
    .update(userInvites)
    .set({ acceptedAt: sql`now()` })
    .where(
      and(
        eq(userInvites.tokenSha256, tokenSha256),
        isNull(userInvites.acceptedAt),
        isNull(userInvites.revokedAt),
        gt(userInvites.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: userInvites.id, role: userInvites.role });
  return rows[0] ?? null;
};

/**
 * Gives a claim back (an email Better Auth refused), so the link stays usable — clearing **only**
 * the claim: a revoke that landed meanwhile is left standing, and the link then reads revoked.
 */
export const releaseInviteClaim = async (database: Database, id: string): Promise<void> => {
  await database
    .update(userInvites)
    .set({ acceptedAt: null })
    .where(and(eq(userInvites.id, id), isNull(userInvites.acceptedUserId)));
};

/**
 * Names the account a claimed link made, and records `org.user.invite_accept` as that account —
 * one transaction, so the link and its audit row never disagree.
 */
export const completeInviteAccept = async (
  database: Database,
  input: { readonly id: string; readonly userId: string; readonly params: JsonObject },
): Promise<void> => {
  await database.transaction(async (tx) => {
    await tx
      .update(userInvites)
      .set({ acceptedUserId: input.userId })
      .where(eq(userInvites.id, input.id));
    await tx.insert(humanActions).values({
      taskId: null,
      userId: input.userId,
      action: 'org.user.invite_accept',
      params: input.params,
    });
  });
};
