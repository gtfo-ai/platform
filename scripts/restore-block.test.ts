import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRE_UPGRADE_DUMP_END,
  preUpgradeDumpProblems,
  RESTORE_BLOCK_END,
  RESTORE_BLOCK_START,
  readPreUpgradeDump,
  readRestoreBlock,
  restoreBlockProblems,
} from './restore-block.mjs';

/**
 * The operator guide's restore block (WP-228, PROGRESS backlogs 633 and 632): one marker pair, one
 * ```bash fence, `gzip -t` before anything destructive, and no `pg_restore` — which cannot read the
 * gzipped plain SQL `db-backup` writes. `scripts/restore-check.mjs` runs the same block against a
 * real dump; this case holds its shape on every `verify`, where no daemon is.
 */
const GUIDE = readFileSync(join(import.meta.dirname, '..', 'docs', 'operator-guide.md'), 'utf8');
const BLOCK = readRestoreBlock(GUIDE);

/** The guide with its block's text replaced — every canary below starts from the real page. */
const withBlock = (script: string): string => GUIDE.replace(BLOCK, script);

describe('the operator guide restore block', () => {
  it('is exactly one marker pair around one bash fence, with gzip -t first and no pg_restore', () => {
    expect(restoreBlockProblems(GUIDE)).toEqual([]);
    expect(BLOCK).toMatch(/^gzip -t backup\.sql\.gz &&\n/);
    expect(BLOCK).toContain('-v ON_ERROR_STOP=1');
    expect(BLOCK).toContain('gunzip -c backup.sql.gz |');
  });

  it('is refused when pg_restore is put back', () => {
    const canary = withBlock(
      `${BLOCK}docker compose exec -T db pg_restore -U app -d app --clean --if-exists < backup.dump\n`,
    );
    expect(restoreBlockProblems(canary)).toEqual([
      'the restore block runs pg_restore, which cannot read the gzipped plain SQL db-backup writes',
    ]);
    expect(() => readRestoreBlock(canary)).toThrow(/pg_restore/);
  });

  it('is refused when a destructive line comes before gzip -t, or gzip -t is gone', () => {
    const lines = BLOCK.split('\n');
    const swapped = [lines[1], lines[0], ...lines.slice(2)].join('\n');
    expect(restoreBlockProblems(withBlock(swapped))).toEqual([
      'the restore block runs a destructive command before `gzip -t` has checked the dump',
    ]);
    expect(restoreBlockProblems(withBlock(lines.slice(1).join('\n')))).toEqual([
      'the restore block never runs `gzip -t` on the dump',
    ]);
  });

  it('is refused when the markers are missing, doubled or unbalanced', () => {
    const marked = `${RESTORE_BLOCK_START}\n\`\`\`bash\n${BLOCK}\`\`\`\n${RESTORE_BLOCK_END}`;
    expect(restoreBlockProblems(GUIDE.replaceAll(RESTORE_BLOCK_START, ''))[0]).toMatch(
      /found 0 start\(s\) and 1 end\(s\)/,
    );
    expect(restoreBlockProblems(`${GUIDE}\n${marked}\n`)[0]).toMatch(
      /found 2 start\(s\) and 2 end\(s\)/,
    );
    expect(restoreBlockProblems(`${RESTORE_BLOCK_END}\n${RESTORE_BLOCK_START}\n`)).toEqual([
      'the restore block start marker has no end marker after it',
    ]);
  });

  it('ends with up -d, which re-reads PLATFORM_TAG, never with a bare start of app', () => {
    expect(BLOCK).toMatch(/docker compose up -d &&\ndocker compose start db-backup\n$/);
    expect(BLOCK).not.toMatch(/docker compose start app/);
  });

  it('is refused when the region holds no bash fence or text beside it', () => {
    const region = (body: string): string =>
      `${RESTORE_BLOCK_START}\n${body}\n${RESTORE_BLOCK_END}\n`;
    expect(restoreBlockProblems(region('gzip -t backup.sql.gz'))).toEqual([
      'the restore block holds no ```bash fence',
    ]);
    expect(restoreBlockProblems(region(`\`\`\`bash\n${BLOCK}\`\`\`\nrun psql by hand`))).toEqual([
      'the restore block holds text outside its one ```bash fence',
    ]);
  });
});

/**
 * § 5's pre-upgrade dump (review round 1): the rollback sends it to § 6, so it must be the one
 * format § 6 restores. Until round 1 it was `pg_dump -Fc … > pre-upgrade-….dump`, which § 6's
 * `gzip -t` refuses.
 */
describe('the operator guide pre-upgrade dump', () => {
  const DUMP = readPreUpgradeDump(GUIDE);
  const withDump = (script: string): string => GUIDE.replace(DUMP, script);

  it('is one marked bash fence writing gzipped plain SQL to a .sql.gz file', () => {
    expect(preUpgradeDumpProblems(GUIDE)).toEqual([]);
    expect(DUMP).toContain('pg_dump -Z1');
    expect(DUMP).toMatch(/> pre-upgrade-\$\(date \+%F\)\.sql\.gz\n$/);
  });

  it('is refused when it goes back to the custom format', () => {
    const canary = withDump(
      'docker compose exec -T db pg_dump -U app -Fc app > pre-upgrade-$(date +%F).dump\n',
    );
    expect(preUpgradeDumpProblems(canary)).toEqual([
      'the pre-upgrade dump is not plain SQL, which § 6 cannot restore',
      'the pre-upgrade dump does not write a .sql.gz file',
    ]);
    expect(() => readPreUpgradeDump(canary)).toThrow(/not plain SQL/);
    expect(
      preUpgradeDumpProblems(
        withDump(DUMP.replace('pg_dump -Z1', 'pg_dump --format=directory -Z1')),
      ),
    ).toEqual(['the pre-upgrade dump is not plain SQL, which § 6 cannot restore']);
  });

  it('is refused when its markers are missing or it runs no pg_dump', () => {
    expect(preUpgradeDumpProblems(GUIDE.replaceAll(PRE_UPGRADE_DUMP_END, ''))[0]).toMatch(
      /found 1 start\(s\) and 0 end\(s\)/,
    );
    expect(preUpgradeDumpProblems(withDump('cp old.sql.gz new.sql.gz\n'))).toEqual([
      'the pre-upgrade dump never runs pg_dump',
    ]);
  });
});
