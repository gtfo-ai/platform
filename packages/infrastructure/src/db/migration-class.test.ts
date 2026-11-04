import { describe, expect, it } from 'vitest';
import {
  FIRST_CLASSIFIED_MIGRATION,
  MigrationHeaderError,
  migrationNumber,
  parseMigrationHeader,
  requiresMigrationClass,
} from './migration-class.js';

/** The header grammar of TD-032 decision 1 (WP-271 criterion (1)). */
describe('parseMigrationHeader', () => {
  it('reads an additive header', () => {
    expect(parseMigrationHeader('-- migration-class: additive\ncreate table x ();')).toEqual({
      class: 'additive',
      expands: null,
      raisesRollbackFloor: false,
    });
  });

  it('reads a contract header and the migration it expands', () => {
    expect(
      parseMigrationHeader('-- migration-class: contract; expands: 0093_run_offers\nselect 1;'),
    ).toEqual({ class: 'contract', expands: '0093_run_offers', raisesRollbackFloor: false });
  });

  it('reads raises-rollback-floor on either class', () => {
    expect(parseMigrationHeader('-- migration-class: additive; raises-rollback-floor\n')).toEqual({
      class: 'additive',
      expands: null,
      raisesRollbackFloor: true,
    });
    expect(
      parseMigrationHeader(
        '-- migration-class: contract; expands: 0092_a; raises-rollback-floor\r\nselect 1;',
      ),
    ).toEqual({ class: 'contract', expands: '0092_a', raisesRollbackFloor: true });
  });

  it('tolerates the spacing a person types, and nothing else', () => {
    expect(parseMigrationHeader('--migration-class:additive  ')?.class).toBe('additive');
    expect(
      parseMigrationHeader('--  migration-class:  contract ;expands:0092_a ; raises-rollback-floor')
        ?.expands,
    ).toBe('0092_a');
  });

  it('answers null for a file whose first line is not a header — the files before 0092', () => {
    expect(parseMigrationHeader('-- 0091 — task_duty_leases\ncreate table x ();')).toBeNull();
    expect(parseMigrationHeader('')).toBeNull();
  });

  it.each([
    ['an unknown class', '-- migration-class: additiv'],
    ['an upper-case class', '-- migration-class: ADDITIVE'],
    ['trailing words', '-- migration-class: additive because it adds'],
    ['an expands without a name', '-- migration-class: contract; expands:'],
    [
      'an expands that is not a migration name',
      '-- migration-class: contract; expands: run_offers',
    ],
    ['an unknown clause', '-- migration-class: additive; reviewed'],
    [
      'a clause in the wrong order',
      '-- migration-class: contract; raises-rollback-floor; expands: 0092_a',
    ],
  ])('refuses %s, quoting the line and the grammar', (_, line) => {
    expect(() => parseMigrationHeader(`${line}\nselect 1;`)).toThrow(MigrationHeaderError);
    expect(() => parseMigrationHeader(`${line}\nselect 1;`)).toThrow(
      /is not a valid header; write -- migration-class: additive \| -- migration-class: contract; expands:/,
    );
  });

  it('refuses an additive that names an expand, and a contract that names none', () => {
    expect(() => parseMigrationHeader('-- migration-class: additive; expands: 0092_a')).toThrow(
      /an additive migration expands nothing/,
    );
    expect(() => parseMigrationHeader('-- migration-class: contract')).toThrow(
      /a contract migration names the additive migration it completes/,
    );
  });

  it('refuses a header anywhere but the first line, naming the line', () => {
    expect(() =>
      parseMigrationHeader('-- 0093 — run offers\n-- migration-class: additive\nselect 1;'),
    ).toThrow(/the migration-class header is on line 2; it must be the file's first line/);
    expect(() =>
      parseMigrationHeader('-- migration-class: additive\n  -- migration-class: contract'),
    ).toThrow(/on line 2/);
  });
});

describe('which files must declare a class', () => {
  it('starts at 0092, the file that adds platform_migrations.class', () => {
    expect(FIRST_CLASSIFIED_MIGRATION).toBe(92);
    expect(requiresMigrationClass('0091_task_duty_leases')).toBe(false);
    expect(requiresMigrationClass('0092_migration_class')).toBe(true);
    expect(requiresMigrationClass('1000_far_future')).toBe(true);
    expect(requiresMigrationClass('not_numbered')).toBe(false);
  });

  it('reads the number off the name', () => {
    expect(migrationNumber('0092_migration_class')).toBe(92);
    expect(migrationNumber('add_widgets')).toBeNull();
  });
});
