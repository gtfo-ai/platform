/**
 * The two reads over refused inbound deliveries, against PostgreSQL 18 (WP-44, PROGRESS backlog 198;
 * migration 0047).
 *
 * The unit tier asserts the routes against plain functions (`routes/org.test.ts`) and the ingress's
 * list of refused accounts as a pure fold (`inbound.test.ts`); this is the half only a database can
 * state: that `createPostgresInboxStore` writes `inbox.unmapped_identities` and reads it back, that
 * `jsonb_to_recordset` unpacks it into candidates, that a mapped or machine account is excluded, and
 * that a row written before 0047 (`null`) contributes no candidate and says so on the refused list.
 */
import type { Transaction } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { db, integrations as integrationAdapters } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listIdentityCandidates } from '../../../apps/server/src/queries/identity-queries.js';
import { listRefusedDeliveries } from '../../../apps/server/src/queries/integration-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let drizzled: ReturnType<typeof drizzle<typeof db.schema>>;
let integrationId: string;

beforeAll(async () => {
  database = await createMigratedDatabase('refused-deliveries');
  pool = createTestPool(database.connectionString, { options: '-c role=platform_app', max: 4 });
  drizzled = drizzle(pool, { schema: db.schema });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('refused') returning id",
  );
  const integration = await pool.query<{ id: string }>(
    `insert into integrations (org_id, type, provider, name)
     values ($1, 'communication', 'slack', 'Slack') returning id`,
    [org.rows[0]?.id],
  );
  integrationId = integration.rows[0]?.id as string;

  const store = integrationAdapters.createPostgresInboxStore({ sql: pool });
  const client = await pool.connect();
  try {
    await client.query('begin');
    const tx = { adapter: 'postgres', client } as unknown as Transaction;
    const delivery = (
      deliveryId: string,
      at: string,
      error: string | null,
      unmapped: { provider: string; external_id: string }[],
    ) => ({
      provider: 'slack',
      deliveryId,
      integrationId: integrationId as Id,
      headers: {},
      payload: {},
      verified: true,
      redactionCount: 0,
      error,
      unmappedIdentities: unmapped,
      errorReasons: error === null ? [] : (['unmapped_identity'] as const),
      receivedAt: at as IsoDateTime,
      processedAt: at as IsoDateTime,
    });
    await store.record(
      tx,
      delivery('d1', '2026-09-26T09:00:00.000Z', 'unmapped_identity: "U1" is not mapped', [
        { provider: 'slack', external_id: 'U1' },
      ]),
    );
    await store.record(
      tx,
      delivery('d2', '2026-09-26T10:00:00.000Z', 'unmapped_identity: "U1" is not mapped', [
        { provider: 'slack', external_id: 'U1' },
      ]),
    );
    await store.record(
      tx,
      delivery('d3', '2026-09-26T11:00:00.000Z', 'unmapped_identity: "UMAPPED"', [
        { provider: 'slack', external_id: 'UMAPPED' },
      ]),
    );
    // Produced its events: no error, so it is on neither list.
    await store.record(tx, delivery('d4', '2026-09-26T12:00:00.000Z', null, []));
    await client.query('commit');
  } finally {
    client.release();
  }
  // A row written before migration 0047: the column is null, which is "not recorded".
  await pool.query(
    `insert into inbox (provider, delivery_id, integration_id, received_at, payload, error,
                        redaction_count, verified)
     values ('slack', 'd0', $1, '2026-09-26T08:00:00Z', '{}'::jsonb,
             'unmapped_identity: "UOLD"', 0, true)`,
    [integrationId],
  );
  const user = await pool.query<{ id: string }>(
    "insert into users (email, name) values ('mapped@example.test', 'Mapped') returning id",
  );
  await pool.query(
    `insert into user_identities (provider, external_id, user_id, kind)
     values ('slack', 'UMAPPED', $1, 'person')`,
    [user.rows[0]?.id],
  );
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('refused inbound deliveries (WP-44, backlog 198)', () => {
  it('round-trips the refused accounts through the inbox store', async () => {
    const store = integrationAdapters.createPostgresInboxStore({ sql: pool });
    expect((await store.find('slack', 'd1'))?.unmappedIdentities).toEqual([
      { provider: 'slack', external_id: 'U1' },
    ]);
    // A pre-0047 row reads back as none recorded, not as a malformed value.
    expect((await store.find('slack', 'd0'))?.unmappedIdentities).toEqual([]);
  });

  it('lists the newest refused deliveries of the integration, and says which predate the list', async () => {
    const items = await listRefusedDeliveries(drizzled, integrationId);
    expect(items.map((item) => item.delivery_id)).toEqual(['d3', 'd2', 'd1', 'd0']);
    expect(items.find((item) => item.delivery_id === 'd0')?.unmapped).toBeNull();
    // d0 predates migration 0055 too: no codes, served because it cannot be told apart.
    expect(items.find((item) => item.delivery_id === 'd0')?.reasons).toBeNull();
    expect(items.find((item) => item.delivery_id === 'd1')?.reasons).toEqual(['unmapped_identity']);
    expect(items.find((item) => item.delivery_id === 'd1')?.unmapped).toEqual([
      { provider: 'slack', external_id: 'U1' },
    ]);
  });

  it('offers each unmapped account once, newest first, and never one somebody has mapped', async () => {
    expect(await listIdentityCandidates(drizzled)).toEqual([
      {
        provider: 'slack',
        external_id: 'U1',
        deliveries: 2,
        last_seen_at: '2026-09-26T10:00:00.000Z',
      },
    ]);
  });
});

/**
 * WP-73b, PROGRESS backlog 206: the read served every row with an `inbox.error`, newest fifty, so a
 * busy channel's ordinary ignores pushed the refusal an operator opened it for out of the list.
 * Sixty ignores newer than one refusal: the refusal is what the read answers.
 */
describe('refused deliveries on a busy binding (backlog 206)', () => {
  it('answers the one refusal behind sixty newer ignores, and none of the ignores', async () => {
    const org = await pool.query<{ id: string }>(
      "insert into organizations (name) values ('busy') returning id",
    );
    const busy = (
      await pool.query<{ id: string }>(
        `insert into integrations (org_id, type, provider, name)
         values ($1, 'communication', 'slack', 'Busy Slack') returning id`,
        [org.rows[0]?.id],
      )
    ).rows[0]?.id as string;
    const store = integrationAdapters.createPostgresInboxStore({ sql: pool });
    const client = await pool.connect();
    try {
      await client.query('begin');
      const tx = { adapter: 'postgres', client } as unknown as Transaction;
      const row = (
        deliveryId: string,
        at: string,
        error: string,
        reasons: readonly ('unsupported_event' | 'decision_refused')[],
      ) => ({
        provider: 'slack',
        deliveryId,
        integrationId: busy as Id,
        headers: {},
        payload: {},
        verified: true,
        redactionCount: 0,
        error,
        unmappedIdentities: [],
        errorReasons: reasons,
        receivedAt: at as IsoDateTime,
        processedAt: at as IsoDateTime,
      });
      await store.record(
        tx,
        row('refused', '2026-09-27T08:00:00.000Z', 'decision_refused: not_permitted: a viewer', [
          'decision_refused',
        ]),
      );
      for (let index = 0; index < 60; index += 1) {
        const at = new Date(Date.parse('2026-09-27T09:00:00.000Z') + index * 1000).toISOString();
        await store.record(
          tx,
          row(
            `ignored-${index}`,
            at,
            'unsupported_event: message is not a reply in a task thread',
            ['unsupported_event'],
          ),
        );
      }
      await client.query('commit');
    } finally {
      client.release();
    }

    const items = await listRefusedDeliveries(drizzled, busy);
    expect(items.map((item) => [item.delivery_id, item.reasons])).toEqual([
      ['refused', ['decision_refused']],
    ]);
    expect((await store.find('slack', 'ignored-0'))?.errorReasons).toEqual(['unsupported_event']);
  });
});
