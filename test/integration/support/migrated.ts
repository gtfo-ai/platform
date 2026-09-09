/**
 * Convenience wrapper for suites that need a migrated database rather than an empty one.
 */
import { db } from '@platform/infrastructure';
import { createTestDatabase, type TestDatabase } from './postgres.js';

export interface MigratedDatabase extends TestDatabase {
  readonly report: db.MigrateReport;
}

export const createMigratedDatabase = async (label = 'migrated'): Promise<MigratedDatabase> => {
  const database = await createTestDatabase(label);
  const report = await db.runMigrations({ connectionString: database.connectionString });
  return { ...database, report };
};
