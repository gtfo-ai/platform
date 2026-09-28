/**
 * Migration 0059's upgrade half (WP-84 review round 1): an undelivered `immediate` notification
 * recorded **before** the re-post sweep existed is never re-posted by it.
 *
 * Without the backfill the first recovery pass after an upgrade would re-post every undelivered
 * row since WP-32 — a `task_started` for a task finished months ago among them. Migrates to 0058,
 * plants such a row (as old as a real one would be), applies 0059, and asserts the sweep's own read
 * does not find it — while a row recorded after the upgrade, equally old by then, is found.
 */
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Transaction } from '@platform/application';
import type { IsoDateTime } from '@platform/contracts';
import { db, recovery as recoveryAdapters } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestClient,
  createTestDatabase,
  type TestDatabase,
  withClient,
} from '../support/postgres.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../../packages/infrastructure/src/db/migrations/', import.meta.url),
);
const REPOST_MIGRATION = '0059_wake_ups_and_reminders.sql';
const repostStore = recoveryAdapters.createPostgresNotificationRepostStore();

let database: TestDatabase;
let before: string;
let projectId: string;
let oldRow: string;
let deliveredRow: string;

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

describe('migration 0059: an undelivered row recorded before it is never re-posted', () => {
  beforeAll(async () => {
    database = await createTestDatabase('repost_upgrade');
    before = mkdtempSync(join(tmpdir(), 'wp84-migrations-'));
    for (const file of readdirSync(MIGRATIONS)) {
      if (file.endsWith('.sql') && file < REPOST_MIGRATION) {
        cpSync(join(MIGRATIONS, file), join(before, file));
      }
    }
    await db.runMigrations({
      connectionString: database.connectionString,
      migrationsDirectory: before,
    });
    await withClient(database.connectionString, async (client) => {
      const org = await client.query<{ id: string }>(
        "insert into organizations (name) values ('upgrade') returning id",
      );
      const project = await client.query<{ id: string }>(
        `insert into projects (org_id, key, name, repo_url)
         values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
        [org.rows[0]?.id],
      );
      projectId = project.rows[0]?.id as string;
      const insert = async (cause: string, deliveredAt: string | null) =>
        (
          await client.query<{ id: string }>(
            `insert into notifications (project_id, class, cause_event_id, title, planned_delivery,
                                        created_at, delivered_at, delivered_as)
             values ($1, 'task_started', $2, 'ACME-1 picked up', 'immediate', $3, $4, $5)
             returning id`,
            [projectId, cause, ago(90), deliveredAt, deliveredAt === null ? null : 'immediate'],
          )
        ).rows[0]?.id as string;
      // A `task_started` from three months ago that nothing ever delivered.
      oldRow = await insert('00000000-0000-4000-9000-000000005901', null);
      deliveredRow = await insert('00000000-0000-4000-9000-000000005902', ago(89));
    });
    await db.runMigrations({ connectionString: database.connectionString });
  }, 180_000);

  afterAll(async () => {
    rmSync(before, { recursive: true, force: true });
    await database?.drop();
  });

  it('marks the old undelivered row attempted, so the sweep does not find it, and leaves a delivered one alone', async () => {
    const client = createTestClient(database.connectionString);
    await client.connect();
    try {
      const tx = { adapter: 'postgres', client } as unknown as Transaction;
      const found = await repostStore.undeliveredImmediate(tx, {
        before: new Date(Date.now() - 48 * 60_000).toISOString() as IsoDateTime,
        limit: 50,
      });
      expect(found.map((row) => row.id)).not.toContain(oldRow);
      const marks = await client.query<{ id: string; marked: boolean }>(
        'select id, repost_attempted_at is not null as marked from notifications order by created_at, id',
      );
      expect(Object.fromEntries(marks.rows.map((row) => [row.id, row.marked]))).toEqual({
        [oldRow]: true,
        [deliveredRow]: false,
      });

      // A row recorded after the upgrade — as old by the time a pass reads it — is the sweep's.
      const fresh = await client.query<{ id: string }>(
        `insert into notifications (project_id, class, cause_event_id, title, planned_delivery,
                                    created_at)
         values ($1, 'escalation', '00000000-0000-4000-9000-000000005903', 'ACME-2 needs a human',
                 'immediate', $2)
         returning id`,
        [projectId, ago(1)],
      );
      const after = await repostStore.undeliveredImmediate(tx, {
        before: new Date(Date.now() - 48 * 60_000).toISOString() as IsoDateTime,
        limit: 50,
      });
      expect(after.map((row) => row.id)).toEqual([fresh.rows[0]?.id]);
    } finally {
      await client.end();
    }
  });
});
