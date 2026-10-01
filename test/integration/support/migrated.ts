/**
 * Convenience wrapper for suites that need a migrated database rather than an empty one.
 *
 * **Past partitions** (session 11, found by WP-105's implementer): `migrate` creates the current
 * UTC month and three ahead (`platform_ensure_partitions`), which is right for an installation —
 * it writes rows at *now* — and wrong for a test database, because suites write rows relative to
 * `Date.now()` (a day ago, a week ago, thirty days ago). In the first days of a UTC month those
 * timestamps fall in a month that has no partition, and the insert fails with `no partition of
 * relation …`: 41 failures measured at 00:01 UTC on 1 October 2026, none of them in a suite that
 * had changed. So the harness also creates `pastMonths` (default three) months *behind* the
 * current one, for every table `platform_table_policy` partitions — test-only, never a migration.
 * The suite that asserts `migrate`'s own window and the retention sweep passes `pastMonths: 0`.
 */
import { db } from '@platform/infrastructure';
import { createTestDatabase, type TestDatabase, withClient } from './postgres.js';

export interface MigratedDatabase extends TestDatabase {
  readonly report: db.MigrateReport;
}

export interface MigratedDatabaseOptions {
  /** Months before the current UTC month to give a partition; `0` leaves `migrate`'s window alone. */
  readonly pastMonths?: number;
}

const createPastPartitions = async (connectionString: string, months: number): Promise<void> => {
  if (months <= 0) return;
  await withClient(connectionString, async (client) => {
    await client.query(
      `do $$
       declare
         v_policy record;
         v_offset integer;
         v_month  date;
         v_name   text;
       begin
         for v_policy in
           select table_name from platform_table_policy where partition_column is not null
         loop
           for v_offset in 1 .. ${Number(months)} loop
             v_month := (date_trunc('month', (now() at time zone 'UTC')::date) - make_interval(months => v_offset))::date;
             v_name  := platform_partition_name(v_policy.table_name, v_month);
             if to_regclass(format('public.%I', v_name)) is null then
               execute format(
                 'create table public.%I partition of public.%I for values from (%L) to (%L)',
                 v_name, v_policy.table_name, v_month, (v_month + interval '1 month')::date);
             end if;
           end loop;
         end loop;
       end
       $$`,
    );
  });
};

export const createMigratedDatabase = async (
  label = 'migrated',
  options: MigratedDatabaseOptions = {},
): Promise<MigratedDatabase> => {
  const database = await createTestDatabase(label);
  const report = await db.runMigrations({ connectionString: database.connectionString });
  await createPastPartitions(database.connectionString, options.pastMonths ?? 3);
  return { ...database, report };
};
