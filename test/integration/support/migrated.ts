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
 *
 * **Stale writes are refused** (ci-fix, session 21). The other half of the same class is a suite
 * that writes a *fixed* calendar instant — a frozen clock reading `'2026-09-11T12:00:00.000Z'`, a
 * transcript row stamped with a literal. It passes until the calendar moves past it: the event log
 * refuses an `occurred_at` before the start of the previous UTC month (`assertInPartitionWindow`,
 * technical/03), so 22 tests in three unchanged files went red on 2026-11-01, and the three past
 * partitions above only move the same cliff further out for the other tables. So every partition
 * that exists once `migrate` and the past months above have run — the ones whose existence depends
 * on the day the suite runs — gets a test-only `before insert` trigger that refuses a row whose
 * partition column is more than `staleWriteDays` (default 14) before `now()`, naming the table, the
 * column, the value and the remedy (`test/support/recent-instant.ts`).
 *
 * The trigger is on those partitions and **not** on the partitioned parent, which would clone it
 * onto every partition created later: a suite that creates its own fixed month (`partition of
 * events for values from ('2026-06-01')`, as `deadline-recovery-store` and the pipeline store's
 * take-over cases do) and writes June instants into it does not depend on the date at all, and the
 * first version of this guard refused 16 such tests (measured).
 *
 * Why a row-level trigger and not a source census: the instants that broke reached the database
 * through a contract suite's entry builder, a provider replay's clock and a transcript fixture —
 * three spellings, no common call site — and what they share is only what they wrote. Why 14 days:
 * the earliest the event log's window can drop a timestamp is about 29 days after it (one written on
 * the last day of a month leaves the window on the 1st of the month after next), and the oldest
 * clock-relative write measured across the integration and e2e tiers when this was added was about
 * seven days (`stats-queries`). So a fresh literal trips this a fortnight before the calendar would,
 * with a message that says what it is, and one copied from an older suite trips at once. A suite
 * that genuinely needs an older row passes a larger `staleWriteDays`, or `null` to switch it off.
 * A literal already outside the event log's window is refused by `assertInPartitionWindow` first;
 * this guard is for the 14-to-about-45-day band that window still admits.
 */
import { db } from '@platform/infrastructure';
import { createTestDatabase, type TestDatabase, withClient } from './postgres.js';

export interface MigratedDatabase extends TestDatabase {
  readonly report: db.MigrateReport;
}

export interface MigratedDatabaseOptions {
  /** Months before the current UTC month to give a partition; `0` leaves `migrate`'s window alone. */
  readonly pastMonths?: number;
  /**
   * Refuse a row written to a clock-derived partition more than this many days before `now()`
   * (default 14); `null` installs no refusal. See the module docblock.
   */
  readonly staleWriteDays?: number | null;
}

/** The message's fixed prefix, which `migrated.integration.test.ts` matches on. */
export const STALE_WRITE_REFUSAL = 'test harness refuses a stale write';

const refuseStaleWrites = async (connectionString: string, days: number | null): Promise<void> => {
  if (days === null) return;
  await withClient(connectionString, async (client) => {
    await client.query(
      `create function public.test_harness_refuse_stale_write() returns trigger
         language plpgsql as $f$
       -- TG_ARGV: the partition column, the bound in days, and the partitioned table's own name
       -- (TG_TABLE_NAME would name the monthly partition the row was routed to).
       declare
         v_at timestamptz := (to_jsonb(new) ->> TG_ARGV[0])::timestamptz;
       begin
         if v_at < now() - make_interval(days => TG_ARGV[1]::integer) then
           raise exception '${STALE_WRITE_REFUSAL}: %.% = % is more than % days before now()',
             TG_ARGV[2], TG_ARGV[0], v_at, TG_ARGV[1]
             using hint = 'a fixture wrote a fixed calendar instant; take it from the clock '
                          '(test/support/recent-instant.ts) or the test fails once the month turns';
         end if;
         return new;
       end
       $f$`,
    );
    const { rows } = await client.query<{
      table_name: string;
      partition_name: string;
      partition_column: string;
    }>(
      `select p.table_name, c.relname as partition_name, p.partition_column
         from platform_table_policy p
         join pg_inherits i on i.inhparent = format('public.%I', p.table_name)::regclass
         join pg_class c on c.oid = i.inhrelid
        where p.partition_column is not null
        order by p.table_name, c.relname`,
    );
    for (const { table_name, partition_name, partition_column } of rows) {
      await client.query(
        `create trigger test_harness_refuse_stale_write before insert on public.${client.escapeIdentifier(partition_name)}
           for each row execute function public.test_harness_refuse_stale_write(${client.escapeLiteral(partition_column)}, '${Number(days)}', ${client.escapeLiteral(table_name)})`,
      );
    }
  });
};

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
  await refuseStaleWrites(
    database.connectionString,
    options.staleWriteDays === undefined ? 14 : options.staleWriteDays,
  );
  return { ...database, report };
};
