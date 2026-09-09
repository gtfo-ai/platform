/**
 * Structural checks on the Drizzle schema that need no database. The column-by-column comparison
 * against the migrated database lives in the `integration` tier
 * (`test/integration/db/schema-parity.integration.test.ts`).
 */
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './index.js';

const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable =>
  is(value, PgTable),
);

describe('Drizzle schema', () => {
  it('declares the tables technical/03 specifies', () => {
    expect(tables.length).toBe(45);
  });

  it('names every table and column in snake_case, matching the wire format', () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      expect(config.name, config.name).toMatch(/^[a-z][a-z0-9_]*$/);
      for (const column of config.columns) {
        expect(column.name, `${config.name}.${column.name}`).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  it('has no duplicate table name', () => {
    const names = tables.map((table) => getTableConfig(table).name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every table a primary key', () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      const hasKey =
        config.primaryKeys.length > 0 || config.columns.some((column) => column.primary);
      // redaction_log is the one log without a key: the same rule may match one message twice.
      expect(hasKey || config.name === 'redaction_log', `${config.name} has a primary key`).toBe(
        true,
      );
    }
  });

  it('stores every timestamp with a time zone', () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        if (column.getSQLType().startsWith('timestamp')) {
          expect(column.getSQLType(), `${config.name}.${column.name}`).toBe(
            'timestamp with time zone',
          );
        }
      }
    }
  });

  it('keeps money in numeric, never in a float', () => {
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        if (/usd|cost|limit_usd|input$|output$|cache_/.test(column.name)) {
          expect(
            column.getSQLType().startsWith('numeric') || column.getSQLType() === 'bigint',
            `${config.name}.${column.name} is ${column.getSQLType()}`,
          ).toBe(true);
        }
      }
    }
  });
});
