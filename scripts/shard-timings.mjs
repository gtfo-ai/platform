#!/usr/bin/env node
/**
 * `node scripts/shard-timings.mjs <run-id>` — refresh `scripts/shard-timings.json`, the per-file
 * durations the split CI tiers are balanced on (`scripts/shard-balance.ts` has the rule), from one
 * **green** run of `ci.yml`.
 *
 *   node scripts/shard-timings.mjs 45861948638          reads the run's log through `gh run view --log`
 *   node scripts/shard-timings.mjs 45861948638 --log f  reads a log saved earlier from `f` instead
 *
 * Only the **part** jobs are read (a merge job replays every file line), and a file two parts
 * reported is refused. `workers` and `projects` are kept from the table on disk: they are
 * calibrations, not figures a log carries. Run it after a change moves a tier's balance (a new slow
 * file, a split file), commit the table, and the next run is balanced on it; a file the table does
 * not name is still assigned to exactly one part, at its project's median weight.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isProgram } from './is-program.mjs';
import './ts-source-resolver.mjs';

const TABLE = fileURLToPath(new URL('./shard-timings.json', import.meta.url));

if (isProgram(import.meta.url)) {
  const { parseVitestLog, refreshedTimings } = await import('./shard-balance.ts');
  const [run, flag, file] = process.argv.slice(2);
  if (run === undefined || !/^\d+$/.test(run) || (flag !== undefined && flag !== '--log')) {
    process.stderr.write('usage: node scripts/shard-timings.mjs <run-id> [--log <file>]\n');
    process.exit(2);
  }
  let log;
  if (flag === '--log') {
    log = readFileSync(String(file), 'utf8');
  } else {
    const viewed = spawnSync('gh', ['run', 'view', run, '--log'], {
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    });
    if (viewed.status !== 0) {
      process.stderr.write(`gh run view ${run} --log failed: ${viewed.stderr}\n`);
      process.exit(1);
    }
    log = viewed.stdout;
  }
  const previous = JSON.parse(readFileSync(TABLE, 'utf8'));
  const table = refreshedTimings(
    previous,
    parseVitestLog(log),
    run,
    new Date().toISOString().slice(0, 10),
  );
  writeFileSync(TABLE, `${JSON.stringify(table, null, 2)}\n`);
  process.stdout.write(
    `wrote ${Object.keys(table.files).length} files from run ${run} to ${TABLE}\n`,
  );
}
