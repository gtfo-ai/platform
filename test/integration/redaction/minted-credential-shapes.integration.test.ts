/**
 * Every process's minted-credential shape rules, read from the database — WP-80, TD-012's M5
 * amendment, PROGRESS backlog 259.
 *
 * The minting process writes a shape beside the mint's audit row (asserted in
 * `test/integration/integrations/audit-log.integration.test.ts`); this is the other half: a process
 * that **never minted** — its own pool, its own refresher — reads the unexpired shapes at start and
 * on refresh, and its `patternRedactor()` then replaces a value of that shape which no gitleaks rule
 * knows. The values are obviously fake.
 */
import { randomUUID } from 'node:crypto';
import { redaction as redactionAdapters } from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let minter: pg.Pool;
let reader: pg.Pool;
let integrationId: string;

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
  minter = createTestPool(database.connectionString, { max: 2 });
  reader = createTestPool(database.connectionString, { max: 2 });
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
      intervalMs: 60_000,
    });
    try {
      expect(redactionAdapters.installedMintedCredentialShapeRules()).toHaveLength(1);
      const outcome = redactor.redactText(`the run pushed with https://agentic:${MINTED}@git`);
      expect(outcome.value).not.toContain(MINTED);
      expect(outcome.value).toContain(redactionAdapters.redactionPlaceholder(MINTED));
      expect(redactor.redactText('oldpat-FAKE0000000000000000000').count).toBe(0);

      // Minted after this process started: reached at the next refresh, not before.
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
