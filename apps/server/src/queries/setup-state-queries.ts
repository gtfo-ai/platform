/**
 * The two statements behind `GET /api/setup-state` (WP-291).
 *
 * "Has anybody ever signed in here?" is `users.first_signed_in_at` (migration 0093), set once per
 * account by the served Better Auth instance's `session.create.after` hook. A session row cannot
 * answer it — Better Auth deletes one at sign-out and when it finds one expired — and nothing else
 * is written into the audit for it: `human_actions` is what people *did*, and a synthetic sign-in
 * row there leaked into every task's audit list, the export and the statistics (WP-291's first
 * version did exactly that, and seven e2e tests said so).
 *
 * ## Instances that predate the column
 *
 * 0093 has no backfill (an `update` is not an additive statement, TD-032 §1). So the read also
 * answers "not pending" when any `human_actions` row exists, as durable evidence the instance is in
 * use on one upgraded with its column still null. Not proof of a sign-in: `user_id` may be null, and
 * since WP-88 a chat-button decision records a mapped person who may never have signed in — so the
 * hint can only hide early on an instance already in use, never reappear. The residual, stated: an upgraded instance whose people signed in but
 * never performed a command shows the hint until its next sign-in sets the column.
 */
import { sql } from 'drizzle-orm';
import type { Database } from './identity-queries.js';

/** Whether anybody has ever signed in to this instance. */
export const anySignInRecorded = async (database: Database): Promise<boolean> => {
  const { rows } = await database.execute<{ recorded: boolean }>(sql`
    select exists (select 1 from users where first_signed_in_at is not null)
        or exists (select 1 from human_actions) as recorded
  `);
  return rows[0]?.recorded === true;
};

/** Stamps the account's first sign-in; a later sign-in leaves the first instant alone. */
export const recordFirstSignIn = async (database: Database, userId: string): Promise<void> => {
  await database.execute(sql`
    update users set first_signed_in_at = now()
     where id = ${userId}::uuid and first_signed_in_at is null
  `);
};
