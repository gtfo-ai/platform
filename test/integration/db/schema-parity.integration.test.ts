/**
 * The Drizzle schema and the SQL migrations are two descriptions of one thing (TD-011): the SQL
 * creates it, the Drizzle definitions type the queries against it. Nothing generates one from the
 * other, so this test compares them against a freshly migrated database — a column added to only
 * one side is a failure here rather than a runtime surprise later.
 *
 * Compared: the table set, every column's name, SQL type, nullability, whether it has a database
 * default (which is what decides if Drizzle makes it optional on insert) and whether it is
 * generated, plus the primary key and its column order.
 *
 * Not compared (they have no Drizzle counterpart here, because the DDL is hand-written and nothing
 * generates it): secondary indexes, foreign keys, check constraints, unique constraints and
 * partition bounds. Those are asserted by the behavioural suites — migrations, partitions,
 * event-log and grants — rather than structurally.
 */
import { db } from '@platform/infrastructure';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { withClient } from '../support/postgres.js';

interface ColumnFacts {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly hasDefault: boolean;
  readonly generated: boolean;
}

/** `numeric(12, 6)` and `numeric(12,6)` are the same type spelled two ways. */
const normaliseType = (type: string): string => type.toLowerCase().replaceAll(/\s+/g, '');

const byName = <T extends { name: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => (a.name < b.name ? -1 : 1));

const drizzleTables = (): PgTable[] =>
  (Object.values(db.schema) as unknown[]).filter((value): value is PgTable => is(value, PgTable));

const declaredColumns = (table: PgTable): ColumnFacts[] => {
  const config = getTableConfig(table);
  return byName(
    config.columns.map((column) => ({
      name: column.name,
      type: normaliseType(column.getSQLType()),
      notNull: column.notNull,
      // An identity column has no `default` but the database still supplies the value.
      hasDefault: column.hasDefault || column.generated !== undefined,
      generated: column.generated !== undefined,
    })),
  );
};

const declaredPrimaryKey = (table: PgTable): string[] => {
  const config = getTableConfig(table);
  const composite = config.primaryKeys[0];
  if (composite !== undefined) {
    return composite.columns.map((column) => column.name);
  }
  return config.columns.filter((column) => column.primary).map((column) => column.name);
};

const actualColumns = async (client: pg.Client, table: string): Promise<ColumnFacts[]> => {
  const { rows } = await client.query<{
    name: string;
    type: string;
    not_null: boolean;
    has_default: boolean;
    generated: boolean;
  }>(
    `select a.attname as name,
            format_type(a.atttypid, a.atttypmod) as type,
            a.attnotnull as not_null,
            (a.atthasdef or a.attidentity <> '') as has_default,
            (a.attgenerated <> '') as generated
       from pg_attribute a
      where a.attrelid = ('public.' || quote_ident($1))::regclass
        and a.attnum > 0
        and not a.attisdropped`,
    [table],
  );
  return byName(
    rows.map((row) => ({
      name: row.name,
      type: normaliseType(row.type),
      notNull: row.not_null,
      hasDefault: row.has_default,
      generated: row.generated,
    })),
  );
};

const actualPrimaryKey = async (client: pg.Client, table: string): Promise<string[]> => {
  const { rows } = await client.query<{ columns: string[] }>(
    `select array_agg(a.attname::text order by k.ord) as columns
       from pg_index i
       join lateral unnest(i.indkey) with ordinality as k(attnum, ord) on true
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
      where i.indrelid = ('public.' || quote_ident($1))::regclass
        and i.indisprimary`,
    [table],
  );
  return rows[0]?.columns ?? [];
};

describe('Drizzle schema parity with the migrations', () => {
  let database: MigratedDatabase;

  beforeAll(async () => {
    database = await createMigratedDatabase('parity');
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('describes every table the migrations create, and no others', async () => {
    const declared = drizzleTables()
      .map((table) => getTableConfig(table).name)
      .sort();

    const created = await withClient(database.connectionString, async (client) => {
      const { rows } = await client.query<{ relname: string }>(
        `select c.relname
           from pg_class c
          where c.relnamespace = 'public'::regnamespace
            and c.relkind in ('r', 'p')
            and not c.relispartition`,
      );
      return rows.map((row) => row.relname).sort();
    });

    expect(declared).toEqual(created);
  });

  it('declares every column with the type, nullability, default and generation the database has', async () => {
    await withClient(database.connectionString, async (client) => {
      for (const table of drizzleTables()) {
        const name = getTableConfig(table).name;
        await expect(actualColumns(client, name), `columns of ${name}`).resolves.toEqual(
          declaredColumns(table),
        );
      }
    });
  });

  it('declares the same primary key as the database, in the same order', async () => {
    await withClient(database.connectionString, async (client) => {
      for (const table of drizzleTables()) {
        const name = getTableConfig(table).name;
        await expect(actualPrimaryKey(client, name), `primary key of ${name}`).resolves.toEqual(
          declaredPrimaryKey(table),
        );
      }
    });
  });

  it('gives every registered partitioned table the partition column the registry names', async () => {
    await withClient(database.connectionString, async (client) => {
      const { rows } = await client.query<{ table_name: string; partition_column: string }>(
        'select table_name, partition_column from platform_table_policy where partition_column is not null',
      );

      for (const { table_name, partition_column } of rows) {
        const key = await client.query<{ attname: string }>(
          `select a.attname
             from pg_partitioned_table p
             join lateral unnest(p.partattrs) as k(attnum) on true
             join pg_attribute a on a.attrelid = p.partrelid and a.attnum = k.attnum
            where p.partrelid = ('public.' || quote_ident($1))::regclass`,
          [table_name],
        );
        expect(
          key.rows.map((row) => row.attname),
          `partition key of ${table_name}`,
        ).toEqual([partition_column]);
      }
    });
  });
});
