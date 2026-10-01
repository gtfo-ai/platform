/**
 * **Every `ROLE` re-reads the minted-credential shapes on the commit that records one** — WP-107,
 * TD-012's M6 amendment (1), and the residual the orchestrator added to PROGRESS backlog 276.
 *
 * The two-process e2e cannot tell which instance's refresher installed a rule: the tier runs both
 * `apps/server` instances in one Node process and the rules are module state, so a refresher started
 * only for `ROLE=runner` would pass it by construction. What *is* per instance is the refresher's own
 * `status()` — `ServerRuntime.mintedCredentialShapes`, a labelled seam — so this file starts a whole
 * runtime **per role** and asks that runtime's refresher whether it subscribed the shape topic and
 * whether an announcement on it started a read.
 *
 * **A census, not a list kept here** (standing rule 7): the roles are `ROLES`, the tuple the
 * configuration schema itself validates `ROLE` against, so a role added to the composition root is
 * started here the day it exists.
 */
import { MINTED_CREDENTIAL_SHAPES_TOPIC } from '@platform/application';
import { broadcast as broadcastAdapters } from '@platform/infrastructure';
import {
  loadServerConfig,
  ROLES,
  requiredPoolConnections,
  type ServerRuntime,
  startRuntime,
} from '@platform/server';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let announcer: pg.Pool;

beforeAll(async () => {
  database = await createMigratedDatabase('shape-refresh-roles');
  announcer = createTestPool(database.connectionString, { max: 1 });
}, 180_000);

afterAll(async () => {
  await announcer?.end();
  await database?.drop();
});

/** The environment a container gives the process for `role`, at that role's own pool floor. */
const environmentFor = (role: string): Record<string, string> => {
  const environment = {
    ROLE: role,
    PORT: '0',
    HOST: '127.0.0.1',
    APP_BASE_URL: 'http://127.0.0.1:8080',
    DATABASE_URL: database.connectionString,
    APP_SECRET_KEY: 'shape-refresh-roles-integration-secret-not-a-real-0000',
    LOG_LEVEL: 'silent',
    TZ: 'UTC',
  };
  const floor = requiredPoolConnections(
    loadServerConfig({ ...environment, APP_DB_POOL_MAX: '1000' }),
  );
  return { ...environment, APP_DB_POOL_MAX: String(floor) };
};

/** What the audit adapter publishes in a mint's transaction, sent outside one. */
const announce = async (): Promise<void> => {
  await broadcastAdapters
    .transactionalBroadcast(announcer)
    .publish({ topic: MINTED_CREDENTIAL_SHAPES_TOPIC, payload: {} });
};

describe('the minted-credential shape refresh, per ROLE (WP-107)', () => {
  it('knows at least the roles the shipped topology deploys', () => {
    // A census over an empty tuple asserts nothing (standing rule 10).
    expect(ROLES).toEqual(expect.arrayContaining(['all', 'api', 'worker', 'runner']));
  });

  it.each(ROLES)(
    'ROLE=%s subscribes the shape topic and re-reads the shapes when one is announced',
    async (role) => {
      const runtime: ServerRuntime = await startRuntime({ env: environmentFor(role) });
      try {
        const before = runtime.mintedCredentialShapes.status();
        expect(before.subscribed).toBe(true);
        expect(before.notifiedReads).toBe(0);
        // Announced until heard: a notification sent before the `LISTEN` connection is up is not
        // delivered, and that is the timer's case, not this one's.
        await vi.waitFor(
          async () => {
            await announce();
            expect(runtime.mintedCredentialShapes.status().notifiedReads).toBeGreaterThanOrEqual(1);
          },
          { timeout: 30_000, interval: 100 },
        );
        expect(runtime.mintedCredentialShapes.status().consecutiveFailures).toBe(0);
      } finally {
        await runtime.stop();
      }
      expect(runtime.mintedCredentialShapes.status().subscribed).toBe(false);
    },
    120_000,
  );
});
