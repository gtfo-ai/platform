import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checksumOf, loadMigrations, migrationsDirectory } from './migrations.js';

const scratches: string[] = [];
const scratchDir = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'platform-migrations-'));
  scratches.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return dir;
};

afterAll(() => {
  for (const dir of scratches) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadMigrations', () => {
  it('loads the shipped migrations in numeric order, starting from the bootstrap', () => {
    const migrations = loadMigrations();
    const names = migrations.map((migration) => migration.name);

    expect(names[0]).toBe('0001_bootstrap');
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    expect(migrations.every((migration) => migration.sql.length > 0)).toBe(true);
  });

  it('defaults to the directory next to it', () => {
    expect(migrationsDirectory.endsWith('/migrations/')).toBe(true);
    expect(loadMigrations(migrationsDirectory)).toEqual(loadMigrations());
  });

  it('checksums the file contents, so an edit is detectable', () => {
    const [first] = loadMigrations();
    expect(first?.checksum).toBe(checksumOf(first?.sql ?? ''));
    expect(checksumOf('a')).not.toBe(checksumOf('b'));
    expect(checksumOf('a')).toHaveLength(64);
  });

  it('ignores files that are not .sql', () => {
    const dir = scratchDir({ '0001_first.sql': 'select 1;', 'README.md': 'notes' });
    expect(loadMigrations(dir).map((migration) => migration.name)).toEqual(['0001_first']);
  });

  it('rejects a file name that does not carry an order', () => {
    const dir = scratchDir({ 'add_widgets.sql': 'select 1;' });
    expect(() => loadMigrations(dir)).toThrow(/does not match/);
  });

  it('rejects two migrations claiming the same position', () => {
    const dir = scratchDir({ '0007_a.sql': 'select 1;', '0007_b.sql': 'select 2;' });
    expect(() => loadMigrations(dir)).toThrow(/share the prefix 0007/);
  });
});
