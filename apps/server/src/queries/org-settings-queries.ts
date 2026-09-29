/**
 * `organizations.settings` — the organisation settings document's reads and its one write (WP-93).
 *
 * The document is **stored as written and parsed at every read** (`organisationSettingsFrom` in
 * `config-layers.ts`): these functions hand the route the raw column, and the route — never this
 * module — decides what a document that does not parse answers. That keeps one parse for every
 * reader (the settings port, `GET …/config`, the dial, the notification duty and these routes).
 *
 * The write is a **read-modify-write under a row lock** (`select … for update`): `PATCH /api/org`
 * replaces sections of one JSON document, and two administrators replacing *different* sections at
 * once must both land. Without the lock the second write would put back the first one's section as
 * it was before — the lost update `tasks.version` exists to refuse elsewhere.
 */
import type { JsonObject, OrganisationSettings } from '@platform/contracts';
import { db as dbAdapters } from '@platform/infrastructure';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from './identity-queries.js';
import { ensureOrganisation } from './onboarding-queries.js';

const { integrations, organizations } = dbAdapters.schema;

/** The column as stored, **unparsed**, and when it last changed — or `null` with no organisation. */
export interface StoredOrganisationSettings {
  readonly settings: unknown;
  readonly updatedAt: Date;
}

/** The deployment's one organisation row (product/01), or `null` before the first project. */
export const findOrganisationSettings = async (
  database: Database,
): Promise<StoredOrganisationSettings | null> => {
  const rows = await database
    .select({ settings: organizations.settings, updatedAt: organizations.updatedAt })
    .from(organizations)
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : { settings: row.settings, updatedAt: row.updatedAt };
};

/**
 * Replace the document, computed from the stored one by `next` **under the row's lock**.
 *
 * `next` receives the stored column and returns the document to write, or throws — a refusal
 * rolls the transaction back and writes nothing. The organisation is created if the instance has
 * none yet (`ensureOrganisation`, the wizard's own bootstrap), so an administrator can set the
 * maximums before the first project exists.
 */
export const replaceOrganisationSettings = async (
  database: Database,
  next: (stored: unknown) => Promise<OrganisationSettings> | OrganisationSettings,
): Promise<{ readonly before: unknown; readonly after: OrganisationSettings }> => {
  const orgId = await ensureOrganisation(database);
  return database.transaction(async (tx) => {
    const locked = await tx
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for('update');
    const before: unknown = locked[0]?.settings ?? {};
    const after = await next(before);
    await tx
      .update(organizations)
      .set({ settings: after as JsonObject, updatedAt: sql`now()` })
      .where(eq(organizations.id, orgId));
    return { before, after };
  });
};

/** Whether `id` is a **communication** account — what `notifications.organisation_default` names. */
export const isCommunicationAccount = async (database: Database, id: string): Promise<boolean> => {
  const rows = await database
    .select({ id: integrations.id })
    .from(integrations)
    .where(and(eq(integrations.id, id), eq(integrations.type, 'communication')))
    .limit(1);
  return rows.length > 0;
};
