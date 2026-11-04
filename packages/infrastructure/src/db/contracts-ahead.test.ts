import { runTerminalReasonSchema } from '@platform/contracts';
import { is } from 'drizzle-orm';
import { PgEnumColumn } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  CONTRACTS_AHEAD_OF_STORAGE,
  ContractsAheadDeclarationError,
  storedLabelsOf,
} from './contracts-ahead.js';
import * as schema from './schema/index.js';

/**
 * The Drizzle half of WP-273's parity: every `pgEnum` the schema declares holds exactly the contract's
 * values minus {@link CONTRACTS_AHEAD_OF_STORAGE}, and never a value declared ahead. The live
 * database's half is `test/integration/db/enums.integration.test.ts`.
 */
const pgEnumValues = (typeName: string): readonly string[] | undefined => {
  for (const table of Object.values(schema)) {
    if (typeof table !== 'object' || table === null) continue;
    for (const column of Object.values(table as Record<string, unknown>)) {
      if (is(column, PgEnumColumn) && column.getSQLType() === typeName) return column.enumValues;
    }
  }
  return undefined;
};

/** The enums with a declared entry, and the contract each is published by. */
const PUBLISHED: Readonly<Record<string, readonly string[]>> = {
  run_terminal_reason: runTerminalReasonSchema.options,
};

describe('CONTRACTS_AHEAD_OF_STORAGE', () => {
  it('names a published contract for every declared enum, and a work package that empties each entry', () => {
    for (const [name, entries] of Object.entries(CONTRACTS_AHEAD_OF_STORAGE)) {
      expect(PUBLISHED[name], `${name} has no published contract here`).toBeDefined();
      expect(
        entries.length,
        `${name}: an empty entry is a stale declaration — delete it`,
      ).toBeGreaterThan(0);
      for (const entry of entries) expect(entry.emptiedBy).toMatch(/^WP-\d+$/);
    }
  });

  it('declares rate_limited ahead of run_terminal_reason until WP-285 stores it (TD-031 decision 11)', () => {
    expect(CONTRACTS_AHEAD_OF_STORAGE.run_terminal_reason).toEqual([
      { value: 'rate_limited', emptiedBy: 'WP-285' },
    ]);
    expect(runTerminalReasonSchema.options.at(-1)).toBe('rate_limited');
  });

  it('holds every Drizzle pgEnum with a declared entry to the contract minus that entry', () => {
    for (const [name, published] of Object.entries(PUBLISHED)) {
      const stored = pgEnumValues(name);
      expect(stored, `pgEnum ${name}`).toBeDefined();
      expect([...(stored ?? [])], `pgEnum ${name}`).toEqual(storedLabelsOf(name, published));
    }
  });

  it('fails on a declared value the pgEnum already has — the row that stores it empties the entry', () => {
    for (const [name, entries] of Object.entries(CONTRACTS_AHEAD_OF_STORAGE)) {
      const stored = pgEnumValues(name) ?? [];
      for (const { value, emptiedBy } of entries) {
        expect(
          stored.includes(value),
          `${name} already stores '${value}': ${emptiedBy} must delete its CONTRACTS_AHEAD_OF_STORAGE entry`,
        ).toBe(false);
      }
    }
  });
});

describe('storedLabelsOf', () => {
  it('answers the published list unchanged for an enum with no declaration', () => {
    expect(storedLabelsOf('task_state', ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('strips a declared tail', () => {
    expect(storedLabelsOf('run_terminal_reason', ['success', 'shutdown', 'rate_limited'])).toEqual([
      'success',
      'shutdown',
    ]);
  });

  it('refuses a declared value that is not published, or not the tail', () => {
    expect(() => storedLabelsOf('run_terminal_reason', ['success', 'shutdown'])).toThrow(
      ContractsAheadDeclarationError,
    );
    expect(() =>
      storedLabelsOf('run_terminal_reason', ['success', 'rate_limited', 'shutdown']),
    ).toThrow(/must be the last 1 of the contract's list/);
    expect(() => storedLabelsOf('run_terminal_reason', [])).toThrow(ContractsAheadDeclarationError);
  });
});
