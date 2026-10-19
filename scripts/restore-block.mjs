/**
 * The operator guide's restore block and its pre-upgrade dump line, read as text (WP-228, PROGRESS
 * backlogs 633 and 632).
 *
 * `docs/operator-guide.md` § 6 *Restore* carries the restore procedure between
 * {@link RESTORE_BLOCK_START} and {@link RESTORE_BLOCK_END}, and § 5 the dump an operator takes
 * before an upgrade between {@link PRE_UPGRADE_DUMP_START} and {@link PRE_UPGRADE_DUMP_END}, each in
 * one ```bash fence. Two readers take them from there and nothing else: `scripts/restore-check.mjs`
 * runs exactly those lines — the restore against a dump the pinned `db-backup` image made **and**
 * against a dump § 5's line made, which is the rollback — and `scripts/restore-block.test.ts` holds
 * their shape. Until WP-228 the guide restored with `pg_restore` from a file `db-backup` never
 * writes — `/backup.sh` writes gzipped plain SQL — and nothing ran it, so the blocks are now read
 * where they are written rather than copied into a check that could drift from them.
 *
 * Plain JavaScript, no dependency: the Docker script runs with nothing installed.
 */

export const RESTORE_BLOCK_START = '<!-- restore-block:start -->';
export const RESTORE_BLOCK_END = '<!-- restore-block:end -->';
export const PRE_UPGRADE_DUMP_START = '<!-- pre-upgrade-dump:start -->';
export const PRE_UPGRADE_DUMP_END = '<!-- pre-upgrade-dump:end -->';

/**
 * The commands that change the database or stop the instance. `gzip -t` must come before the first
 * of them, so a cut dump (backlog 632) is refused while the database is still whole.
 */
const DESTRUCTIVE =
  /\b(?:dropdb|createdb|pg_restore|psql)\b|\bdrop\s+database\b|\bdocker\s+compose\s+(?:stop|down|rm)\b/i;

const FENCE = /^```bash\n([\s\S]*?)^```$/m;

/**
 * The one ```bash fence between `start` and `end`: `{ problems }` naming what is wrong with the
 * markers or the region, else `{ problems: [], script }`.
 */
const markedFence = (markdown, start, end, label) => {
  const starts = markdown.split(start).length - 1;
  const ends = markdown.split(end).length - 1;
  if (starts !== 1 || ends !== 1) {
    return {
      problems: [
        `expected exactly one ${label} marker pair, found ${starts} start(s) and ${ends} end(s)`,
      ],
    };
  }
  const from = markdown.indexOf(start);
  const to = markdown.indexOf(end, from);
  if (to === -1) return { problems: [`the ${label} start marker has no end marker after it`] };
  const region = markdown.slice(from + start.length, to);
  const fence = FENCE.exec(region);
  if (fence === null) return { problems: [`the ${label} holds no \`\`\`bash fence`] };
  if (region.replace(fence[0], '').trim() !== '') {
    return { problems: [`the ${label} holds text outside its one \`\`\`bash fence`] };
  }
  return { problems: [], script: fence[1] ?? '' };
};

/** What is wrong with the guide's restore block, empty when nothing is. */
export const restoreBlockProblems = (markdown) => {
  const { problems, script } = markedFence(
    markdown,
    RESTORE_BLOCK_START,
    RESTORE_BLOCK_END,
    'restore block',
  );
  if (script === undefined) return problems;
  if (/\bpg_restore\b/.test(script)) {
    problems.push(
      'the restore block runs pg_restore, which cannot read the gzipped plain SQL db-backup writes',
    );
  }
  const check = script.search(/\bgzip\s+-t\b/);
  const destructive = script.search(DESTRUCTIVE);
  if (check === -1) problems.push('the restore block never runs `gzip -t` on the dump');
  else if (destructive !== -1 && destructive < check) {
    problems.push(
      'the restore block runs a destructive command before `gzip -t` has checked the dump',
    );
  }
  return problems;
};

/**
 * What is wrong with § 5's pre-upgrade dump line, empty when nothing is: it must write the one
 * format § 6 restores (gzipped plain SQL, `.sql.gz`), never pg_dump's custom or directory format.
 */
export const preUpgradeDumpProblems = (markdown) => {
  const { problems, script } = markedFence(
    markdown,
    PRE_UPGRADE_DUMP_START,
    PRE_UPGRADE_DUMP_END,
    'pre-upgrade dump',
  );
  if (script === undefined) return problems;
  if (!/\bpg_dump\b/.test(script)) problems.push('the pre-upgrade dump never runs pg_dump');
  if (/(?:^|\s)(?:-F\s*[^p\s]|--format[=\s]*[^p\s])/.test(script)) {
    problems.push('the pre-upgrade dump is not plain SQL, which § 6 cannot restore');
  }
  if (!/\.sql\.gz\b/.test(script)) {
    problems.push('the pre-upgrade dump does not write a .sql.gz file');
  }
  return problems;
};

const read = (problems, markdown, start, end, label) => {
  if (problems.length > 0) throw new Error(problems.join('; '));
  return markedFence(markdown, start, end, label).script ?? '';
};

/** The restore block's shell text, or a thrown error naming every problem. */
export const readRestoreBlock = (markdown) =>
  read(
    restoreBlockProblems(markdown),
    markdown,
    RESTORE_BLOCK_START,
    RESTORE_BLOCK_END,
    'restore block',
  );

/** § 5's pre-upgrade dump line, or a thrown error naming every problem. */
export const readPreUpgradeDump = (markdown) =>
  read(
    preUpgradeDumpProblems(markdown),
    markdown,
    PRE_UPGRADE_DUMP_START,
    PRE_UPGRADE_DUMP_END,
    'pre-upgrade dump',
  );
