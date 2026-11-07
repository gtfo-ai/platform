/**
 * The reads and the two deletes behind a person's own linked accounts (S-26.6): what
 * `GET /api/me/identities` lists, the person's unlink and the admin's, and the thread *I wrote it
 * on …* may read — a task's ticket or merge request in the named project, never a key the platform
 * has not met there.
 *
 * The link itself is written in the application ring (`identity/identity-links.ts`, through
 * `IdentityLinkStore`), because it is decided in a transaction beside the match it confirms. These
 * are here for the reason `identity-queries.ts` gives for its own: one caller, no second
 * implementation.
 */
import type { LinkThreadTarget } from '@platform/application';
import type { MergeRequestRef } from '@platform/contracts';
import { db as dbAdapters } from '@platform/infrastructure';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from './identity-queries.js';

const { tasks, userIdentities } = dbAdapters.schema;

export interface MyIdentityRow {
  readonly provider: string;
  readonly external_id: string;
  readonly display_name: string | null;
  readonly created_at: Date;
}

/** The caller's own `person` rows — never a machine (a machine names nobody). */
export const listMyIdentities = async (
  database: Database,
  userId: string,
): Promise<readonly MyIdentityRow[]> =>
  database
    .select({
      provider: userIdentities.provider,
      external_id: userIdentities.externalId,
      display_name: userIdentities.displayName,
      created_at: userIdentities.createdAt,
    })
    .from(userIdentities)
    .where(and(eq(userIdentities.userId, userId), eq(userIdentities.kind, 'person')))
    .orderBy(asc(userIdentities.provider), asc(userIdentities.externalId));

/**
 * Deletes the row when it is **the caller's own** `person` row; `false` otherwise — another
 * person's account, a machine or no row are one answer, so the endpoint says nothing about whose
 * an account is.
 */
export const unlinkMyIdentity = async (
  database: Database,
  input: { readonly userId: string; readonly provider: string; readonly externalId: string },
): Promise<boolean> => {
  const deleted = await database
    .delete(userIdentities)
    .where(
      and(
        eq(userIdentities.provider, input.provider),
        eq(userIdentities.externalId, input.externalId),
        eq(userIdentities.userId, input.userId),
        eq(userIdentities.kind, 'person'),
      ),
    )
    .returning({ provider: userIdentities.provider });
  return deleted.length > 0;
};

/** An admin's unlink: any row, a person's or a machine's. The row it removed, or `null`. */
export const unlinkIdentity = async (
  database: Database,
  input: { readonly provider: string; readonly externalId: string },
): Promise<{ readonly kind: 'person' | 'machine'; readonly user_id: string | null } | null> => {
  const deleted = await database
    .delete(userIdentities)
    .where(
      and(
        eq(userIdentities.provider, input.provider),
        eq(userIdentities.externalId, input.externalId),
      ),
    )
    .returning({ kind: userIdentities.kind, user_id: userIdentities.userId });
  return deleted[0] ?? null;
};

/**
 * The thread a person may name for *I wrote it on …*: the ref a task of **this** project stored —
 * its ticket by key, or its merge request by iid — or `null`. Read off the platform's own rows, so
 * the read that follows goes to a thread a binding of the project already led the platform to.
 */
export const findLinkThread = async (
  database: Database,
  projectId: string,
  target: { readonly ticketKey: string } | { readonly mergeRequestIid: number },
): Promise<LinkThreadTarget | null> => {
  if ('ticketKey' in target) {
    const rows = await database
      .select({
        provider: tasks.ticketProvider,
        key: tasks.ticketKey,
        url: tasks.ticketUrl,
        id: tasks.ticketId,
      })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), eq(tasks.ticketKey, target.ticketKey)))
      .limit(1);
    const row = rows[0];
    return row === undefined
      ? null
      : {
          kind: 'ticket',
          ticket: {
            provider: row.provider,
            key: row.key,
            url: row.url,
            ...(row.id === null ? {} : { id: row.id }),
          },
        };
  }
  const rows = await database
    .select({ mrRef: tasks.mrRef })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        sql`${tasks.mrRef} is not null`,
        sql`(${tasks.mrRef} ->> 'iid') = ${String(target.mergeRequestIid)}`,
      ),
    )
    .limit(1);
  const ref = rows[0]?.mrRef as MergeRequestRef | null | undefined;
  return ref === null || ref === undefined ? null : { kind: 'merge_request', mergeRequest: ref };
};
