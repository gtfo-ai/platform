/**
 * Every process's minted-credential shape rules, read from the database — WP-80, TD-012's M5
 * amendment, PROGRESS backlog 259.
 *
 * The minting process writes a shape beside the mint's audit row (asserted in
 * `test/integration/integrations/audit-log.integration.test.ts`); this is the other half: a process
 * that **never minted** — its own pool, its own refresher — reads the unexpired shapes at start and
 * on refresh, and its `patternRedactor()` then replaces a value of that shape which no gitleaks rule
 * knows. The values are obviously fake.
 *
 * Since WP-107 (TD-012's M6 amendment (1), backlog 276) the last case drives the announcement: the
 * minting pool's audit adapter commits the shape and its hint together, and the other pool's
 * refresher — subscribed on its own `LISTEN` connection, its timer ten minutes away — holds the rule
 * within the wait.
 */
import { randomUUID } from 'node:crypto';
import type { Broadcast, IntegrationActionEntry } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import {
  eventing as eventingAdapters,
  integrations as integrationAdapters,
  redaction as redactionAdapters,
} from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let minter: pg.Pool;
let reader: pg.Pool;
let integrationId: string;

/** A subscription that never fires: the cases below that are about the timer or the start. */
const silentBroadcast: Pick<Broadcast, 'subscribe'> = {
  subscribe: async () => ({ close: async () => {} }),
};

const MINTED = 'acmepat-FAKE0minted0elsewhere00';
const LATER = 'corppat_FAKE0minted0later0000000';

const insertShape = async (prefix: string, length: number, expiresIn: string): Promise<void> => {
  await minter.query(
    `insert into minted_credential_shapes (integration_id, prefix, charset, length, expires_at)
     values ($1, $2, 'token', $3, now() + $4::interval)`,
    [integrationId, prefix, length, expiresIn],
  );
};

beforeAll(async () => {
  database = await createMigratedDatabase('minted-shapes');
  // Four: WP-107's case composes eventing on each pool, whose floor at concurrency 1 is three.
  minter = createTestPool(database.connectionString, { max: 4 });
  reader = createTestPool(database.connectionString, { max: 4 });
  const org = await minter.query<{ id: string }>(
    "insert into organizations (name) values ('shapes') returning id",
  );
  const integration = await minter.query<{ id: string }>(
    `insert into integrations (org_id, type, provider, name)
     values ($1, 'git', 'gitlab', $2) returning id`,
    [org.rows[0]?.id, `git-${randomUUID().slice(0, 8)}`],
  );
  integrationId = integration.rows[0]?.id as string;
}, 180_000);

afterAll(async () => {
  redactionAdapters.installMintedCredentialShapes([]);
  await minter?.end();
  await reader?.end();
  await database?.drop();
});

describe('a process that never minted redacts a minted credential by its shape', () => {
  it('loads the unexpired shapes at start and a new one on refresh, and ignores an expired one', async () => {
    await insertShape('acmepat-', MINTED.length, '1 day');
    // Expired: a credential of this shape is dead, so nothing is compiled for it.
    await insertShape('oldpat-', 30, '-1 minute');
    const redactor = redactionAdapters.patternRedactor();
    expect(redactor.redactText(MINTED).value).toBe(MINTED);

    const refresh = await redactionAdapters.startMintedCredentialShapeRefresh({
      sql: reader,
      broadcast: silentBroadcast,
      intervalMs: 60_000,
    });
    try {
      expect(redactionAdapters.installedMintedCredentialShapeRules()).toHaveLength(1);
      const outcome = redactor.redactText(`the run pushed with https://agentic:${MINTED}@git`);
      expect(outcome.value).not.toContain(MINTED);
      expect(outcome.value).toContain(redactionAdapters.redactionPlaceholder(MINTED));
      expect(redactor.redactText('oldpat-FAKE0000000000000000000').count).toBe(0);

      // Minted after this process started, and announced to nobody (the silent broadcast): reached
      // at the next timer read, not before. The announced path is the WP-107 case below.
      await insertShape('corppat_', LATER.length, '1 day');
      expect(redactor.redactText(LATER).value).toBe(LATER);
      expect(await refresh.refresh()).toBe(2);
      expect(redactor.redactText(LATER).value).toBe(redactionAdapters.redactionPlaceholder(LATER));
    } finally {
      await refresh.stop();
    }
  });

  it('refuses to start when the shapes cannot be read, and keeps its rules when a refresh fails', async () => {
    await expect(
      redactionAdapters.startMintedCredentialShapeRefresh({
        sql: { query: async () => Promise.reject(new Error('the database went away')) },
        broadcast: silentBroadcast,
      }),
    ).rejects.toThrow(/went away/);

    let fail = false;
    const flaky = {
      query: async <R extends Record<string, unknown>>(text: string, values?: unknown[]) => {
        if (fail) {
          throw new Error('the database went away');
        }
        const result = await reader.query<R>(text, values);
        return { rows: result.rows, rowCount: result.rowCount };
      },
    };
    const refresh = await redactionAdapters.startMintedCredentialShapeRefresh({
      sql: flaky,
      broadcast: silentBroadcast,
      intervalMs: 60_000,
    });
    try {
      const before = redactionAdapters.installedMintedCredentialShapeRules().length;
      expect(before).toBeGreaterThan(0);
      fail = true;
      await expect(refresh.refresh()).rejects.toThrow(/went away/);
      expect(redactionAdapters.installedMintedCredentialShapeRules()).toHaveLength(before);
    } finally {
      await refresh.stop();
    }
  });
});

/**
 * WP-107 (TD-012's M6 amendment (1), PROGRESS backlog 276): the commit that records a shape is
 * announced, and a process that never minted — its own pool, its own `LISTEN` connection, its own
 * refresher — holds the rule **before its timer would fire**. The timer here is ten minutes; the
 * wait is bounded far below it, so only the notification can satisfy it.
 */
describe('a recorded shape reaches another process on commit (WP-107)', () => {
  const ANNOUNCED = 'wp107pat-FAKE0announced0000000';
  const TIMER_MS = 600_000;

  it('installs the shape in a second pool’s process from the mint’s own transaction, long before the timer', async () => {
    redactionAdapters.installMintedCredentialShapes([]);
    await minter.query('truncate minted_credential_shapes');

    // The minting process: the audit adapter on its own pool, writing through the unit of work
    // whose transactional broadcast is the one production composes.
    const minting = eventingAdapters.createEventing({
      pool: minter,
      connectionString: database.connectionString,
      config: { maxConcurrency: 1 },
    });
    // The other process: a pool and a listening connection of its own.
    const listening = eventingAdapters.createEventing({
      pool: reader,
      connectionString: database.connectionString,
      config: { maxConcurrency: 1 },
    });
    const refresh = await redactionAdapters.startMintedCredentialShapeRefresh({
      sql: reader,
      broadcast: listening.broadcast,
      intervalMs: TIMER_MS,
    });
    try {
      await vi.waitFor(() => {
        expect(listening.broadcast.listening).toBe(true);
      });
      expect(redactionAdapters.installedMintedCredentialShapeRules()).toHaveLength(0);
      const redactor = redactionAdapters.patternRedactor();
      expect(redactor.redactText(ANNOUNCED).value).toBe(ANNOUNCED);

      const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
      const entry: IntegrationActionEntry = {
        integrationId: integrationId as Id,
        provider: 'gitlab',
        projectId: null,
        taskId: null,
        direction: 'out',
        action: 'mint_credential',
        mutating: true,
        status: 'ok',
        payload: { scope: 'push' },
        result: { scope: 'push', expires_at: expiresAt, revoke_id: 'acme/api#107' },
        error: null,
        durationMs: 12,
        occurredAt: new Date().toISOString() as IsoDateTime,
        redactionCount: 0,
        attempts: 1,
        credentialShape: {
          shape: { prefix: 'wp107pat-', charset: 'token', length: ANNOUNCED.length },
          expiresAt,
        },
      };
      const started = Date.now();
      await integrationAdapters
        .createPostgresIntegrationAuditLog({
          unitOfWork: minting.unitOfWork,
          eventStore: minting.store,
          ids: { next: () => randomUUID() as Id },
        })
        .record(entry);

      await vi.waitFor(
        () => {
          expect(refresh.status().notifiedReads).toBeGreaterThanOrEqual(1);
          expect(redactor.redactText(ANNOUNCED).value).toBe(
            redactionAdapters.redactionPlaceholder(ANNOUNCED),
          );
        },
        { timeout: 30_000, interval: 25 },
      );
      // Reached by the announcement, not the timer: no timed read has happened, and the elapsed
      // time is a fraction of the interval.
      expect(refresh.status().timedReads).toBe(0);
      expect(Date.now() - started).toBeLessThan(TIMER_MS);
    } finally {
      await refresh.stop();
      await listening.broadcast.close();
      await minting.broadcast.close();
      redactionAdapters.installMintedCredentialShapes([]);
    }
  });
});
