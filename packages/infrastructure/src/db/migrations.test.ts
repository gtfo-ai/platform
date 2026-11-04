import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FIRST_CLASSIFIED_MIGRATION, migrationNumber } from './migration-class.js';
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

  describe('the class a file declares (WP-271, TD-032 decision 1)', () => {
    it('reads the header of every shipped file from 0092 on, and finds none before it', () => {
      const migrations = loadMigrations();
      const classified = migrations.filter(
        (migration) => (migrationNumber(migration.name) ?? 0) >= FIRST_CLASSIFIED_MIGRATION,
      );
      expect(classified.map((migration) => migration.name)).toContain('0092_migration_class');
      expect(classified.every((migration) => migration.header !== null)).toBe(true);
      expect(
        migrations
          .filter((migration) => !classified.includes(migration))
          .map((migration) => migration.header),
      ).toEqual(Array(migrations.length - classified.length).fill(null));
      expect(
        migrations.find((migration) => migration.name === '0092_migration_class')?.header,
      ).toEqual({ class: 'additive', expands: null, raisesRollbackFloor: false });
    });

    it('refuses a file from 0092 on that declares no class, naming it and the grammar', () => {
      const dir = scratchDir({ '0092_bare.sql': 'create table widgets ();' });
      expect(() => loadMigrations(dir)).toThrow(
        /migration 0092_bare declares no class; every migration from 0092 on opens with -- migration-class: additive/,
      );
    });

    it('admits a file before 0092 without a header, and reads one when it has it', () => {
      const dir = scratchDir({
        '0091_old.sql': 'create table widgets ();',
        '0093_new.sql':
          '-- migration-class: contract; expands: 0092_x; raises-rollback-floor\nselect 1;',
      });
      expect(loadMigrations(dir).map((migration) => [migration.name, migration.header])).toEqual([
        ['0091_old', null],
        ['0093_new', { class: 'contract', expands: '0092_x', raisesRollbackFloor: true }],
      ]);
    });

    it('refuses a malformed header with the file named, whatever its number', () => {
      const dir = scratchDir({ '0010_typo.sql': '-- migration-class: additiv\nselect 1;' });
      expect(() => loadMigrations(dir)).toThrow(/^migration 0010_typo: the first line/);
    });
  });
});
