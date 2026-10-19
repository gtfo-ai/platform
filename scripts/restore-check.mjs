#!/usr/bin/env node
/**
 * `node scripts/restore-check.mjs` — the operator guide's restore block, run as text against a dump
 * the pinned `db-backup` image made (WP-228, PROGRESS backlogs 633 and 632).
 *
 * ## The defect it exists for
 *
 * `docs/operator-guide.md` § 6 restored with `pg_restore … < backup.dump`, but `db-backup` writes
 * gzipped plain SQL (`/backup.sh` runs `pg_dump -Z1` with no `-F`), which `pg_restore` refuses —
 * measured on the pinned digest: *"input file does not appear to be a valid tar archive"*, exit 1.
 * The upgrade rollback pointed at the same line, and nothing had ever run it. This check reads the
 * block between the guide's markers (`scripts/restore-block.mjs`) and runs **those lines**, so the
 * guide cannot drift from the image again.
 *
 * ## What it does
 *
 *  1. Starts the whole stack from `compose.yml` with the `backup` profile, under a project of its
 *     own, and waits for `app` to answer `/healthz`.
 *  2. Seeds rows into the platform's own tables (`price_list`, `organizations`), dumps through the
 *     image's own `/backup.sh`, and copies the newest dump out with `docker compose cp -L`, as the
 *     guide does. The per-table row counts at dump time are read **off the dump** (its `COPY` blocks),
 *     so they are exactly what was dumped, whatever the running services wrote meanwhile.
 *  3. Writes more rows, so the database is no longer the dump.
 *  4. **The cut-dump leg** (backlog 632): runs the block against the dump cut in half with `head -c`.
 *     It must fail at `gzip -t` (*"unexpected end of file"*), with every service still running and
 *     every row count unchanged.
 *  5. **The restore leg**: runs the block against the whole dump. It must exit 0, `app` must answer
 *     again, and every table's row count and the applied migrations must equal the dump's.
 *  6. **The rollback leg**: runs § 5's pre-upgrade dump line (its own markers), writes more rows,
 *     copies the file to `backup.sql.gz` as § 5 says, and runs the block again with the same
 *     comparison — so the rollback the guide documents is executed, not just read.
 *
 * pg-boss's job tables are left out of the count comparison, by measurement: the idle services
 * fill them on pg-boss's own schedule (a 90 s idle window moved `pgboss.job` from 11 to 14 rows
 * while every other table stood still). The exclusion names pg-boss 12.30.0's tables: the parent
 * `job`, the shared partition `job_common`, and a per-queue partition `j` + the queue name's
 * sha224 in hex (`plans.js`), which no queue of this build creates today.
 *
 * Like the other compose checks it is **not** a `verify` target (no daemon there); the block's shape
 * is held on every `verify` by `scripts/restore-block.test.ts`. A skip counts as a failure: with no
 * daemon or no image it exits 1 naming what is missing.
 *
 * Usage:
 *   node scripts/restore-check.mjs                       against `platform:dev`
 *   node scripts/restore-check.mjs --tag ci              against images built as `:ci`
 *   node scripts/restore-check.mjs --project <name>      a compose project of its own
 *   node scripts/restore-check.mjs --guide <file>        a copy of the guide (the canaries)
 */
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  composeEnvironment,
  createStages,
  describeInstance,
  installExitBackstop,
  publishedPort,
  refuseOldNode,
  Unsettled,
  waitForOk,
} from './compose-check-support.mjs';
import { readPreUpgradeDump, readRestoreBlock } from './restore-block.mjs';

const CHECK = 'restore-check';
refuseOldNode(CHECK);

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const optionValue = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};
const TAG = optionValue('--tag', process.env.PLATFORM_TAG ?? 'dev');
const PROJECT = optionValue(
  '--project',
  `agentic-restore-check-${process.env.GITHUB_RUN_ID ?? 'local'}`,
);
const GUIDE = path.resolve(optionValue('--guide', path.join(REPO, 'docs', 'operator-guide.md')));
const known = new Set(['--tag', '--project', '--guide']);
const unknown = args.filter((argument) => argument.startsWith('--') && !known.has(argument));
if (unknown.length > 0) {
  console.error(
    `FAIL: ${CHECK} — unknown option(s): ${unknown.join(', ')}\n` +
      'usage: restore-check.mjs [--tag <tag>] [--project <name>] [--guide <file>]',
  );
  process.exit(1);
}

/** Obviously fake values (BD-002); the secret key is past its 32-character floor. */
const LAUNCHER_TOKEN = 'restore-check-launcher-token-not-a-secret';
const TIMEOUT_MS = 15 * 60 * 1000;
const DOCKER_QUERY_MS = 60_000;
/** The tables the idle services write on their own (measured; see the docblock). */
const WRITTEN_WHILE_IDLE = /^pgboss\.(?:job|job_common|j[0-9a-f]{56})$/;

/**
 * The services' environment as an override file. `env_file: !reset []` drops `compose.yml`'s
 * optional `.env`, so a developer's own file beside the checkout cannot reach the check.
 */
const WORK = mkdtempSync(path.join(tmpdir(), 'restore-check-'));
const OVERRIDE = path.join(WORK, 'compose.restore-check.yml');
writeFileSync(
  OVERRIDE,
  [
    'x-restore-check-env: &env',
    '  APP_SECRET_KEY: restore-check-not-a-real-secret-key-0000',
    '  APP_BOOTSTRAP_ADMIN_EMAIL: admin@restore-check.example.test',
    '  APP_BOOTSTRAP_ADMIN_PASSWORD: not-a-real-password-restore-check',
    '  APP_BASE_URL: http://restore-check.example.test',
    '  APP_LAUNCHER_URL: http://launcher:7780',
    `  APP_LAUNCHER_TOKEN: ${LAUNCHER_TOKEN}`,
    '  LOG_LEVEL: warn',
    'services:',
    '  migrate:',
    '    env_file: !reset []',
    '  app:',
    '    env_file: !reset []',
    '    environment: *env',
    '  runner:',
    '    env_file: !reset []',
    '    environment: *env',
    '',
  ].join('\n'),
  'utf8',
);

/**
 * How every `docker compose` here — the check's own and the guide's bare ones — finds this project:
 * through the environment, because the guide's lines name no project and no file.
 */
const ENV = {
  ...process.env,
  ...composeEnvironment(PROJECT),
  PLATFORM_TAG: TAG,
  APP_LAUNCHER_TOKEN: LAUNCHER_TOKEN,
  COMPOSE_PROJECT_NAME: PROJECT,
  COMPOSE_FILE: [path.join(REPO, 'compose.yml'), OVERRIDE].join(path.delimiter),
  COMPOSE_ENV_FILES: '/dev/null',
};
delete ENV.COMPOSE_PROFILES;

const compose = async (composeArgs, options = {}) =>
  run('docker', ['compose', ...composeArgs], {
    cwd: WORK,
    env: ENV,
    maxBuffer: 64 * 1024 * 1024,
    timeout: TIMEOUT_MS,
    ...options,
  });

const docker = async (dockerArgs) =>
  run('docker', dockerArgs, { maxBuffer: 16 * 1024 * 1024, timeout: DOCKER_QUERY_MS });

const psql = async (sql) => {
  const { stdout } = await compose([
    'exec',
    '-T',
    'db',
    'psql',
    '-U',
    'app',
    '-d',
    'app',
    '-v',
    'ON_ERROR_STOP=1',
    '-At',
    '-c',
    sql,
  ]);
  return stdout.trim();
};

/** Every ordinary table's row count, `schema.table → n` (a partitioned parent holds no rows). */
const COUNT_SQL = `select n.nspname || '.' || c.relname || ' ' ||
  (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
  order by 1`;

const parseCounts = (text) =>
  new Map(
    text
      .split('\n')
      .filter((line) => line.includes(' '))
      .map((line) => {
        const [table = '', n = ''] = line.split(' ');
        return [table, Number(n)];
      }),
  );

const liveCounts = async () => parseCounts(await psql(COUNT_SQL));

const MIGRATIONS_SQL =
  "select string_agg(name || ':' || checksum, ',' order by name) from platform_migrations";

/**
 * The row count of every table a plain dump carries, read off its `COPY … FROM stdin;` blocks —
 * one data line per row, ended by `\.`.
 */
const dumpCounts = (sql) => {
  const counts = new Map();
  let table = null;
  for (const line of sql.split('\n')) {
    if (table === null) {
      const copy = /^COPY ([^ ]+) .*FROM stdin;$/.exec(line);
      if (copy?.[1] !== undefined) {
        table = copy[1].replaceAll('"', '');
        counts.set(table, 0);
      }
    } else if (line === '\\.') {
      table = null;
    } else {
      counts.set(table, (counts.get(table) ?? 0) + 1);
    }
  }
  return counts;
};

const compared = (left, right) => {
  const names = [...new Set([...left.keys(), ...right.keys()])].filter(
    (t) => !WRITTEN_WHILE_IDLE.test(t),
  );
  return names
    .sort()
    .filter((t) => left.get(t) !== right.get(t))
    .map((t) => `${t} ${left.get(t)}→${right.get(t)}`);
};

const SERVICES = ['app', 'runner', 'launcher', 'db-backup'];
const states = async () => {
  const { stdout } = await compose(['ps', '-a', '--format', '{{.Service}}|{{.State}}']);
  return new Map(
    stdout
      .trim()
      .split('\n')
      .map((line) => line.split('|')),
  );
};

/** Runs the guide's block in `directory`, which holds the `backup.sql.gz` it names. */
const runBlock = async (block, directory) => {
  try {
    const { stdout, stderr } = await run('sh', ['-c', block], {
      cwd: directory,
      env: ENV,
      maxBuffer: 64 * 1024 * 1024,
      timeout: TIMEOUT_MS,
    });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    return { code: error.code ?? 'killed', output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
};

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
};

const stages = createStages();

const healthy = async () => {
  stages.set('docker compose port app 8080');
  const baseUrl = `http://127.0.0.1:${await publishedPort(compose)}`;
  await waitForOk(stages, `${baseUrl}/healthz`);
  return baseUrl;
};

const insertRows = (label, prices, organizations) =>
  psql(
    [
      ...Array.from(
        { length: prices },
        (_, i) =>
          `insert into price_list (model_id, effective_from, input, output, cache_write_5m, cache_write_1h, cache_read, source_url, verified_at) values ('restore-check-${label}-${i}', now(), 1, 2, 1, 1, 1, 'https://restore-check.example.test/prices', now());`,
      ),
      ...Array.from(
        { length: organizations },
        (_, i) => `insert into organizations (name) values ('restore-check ${label} ${i}');`,
      ),
    ].join('\n'),
  );

/** Runs the restore block in `directory` and holds the database to the dump it restored. */
const restoreLeg = async (what, block, directory, dumped, migrationsAtDump) => {
  const restored = await runBlock(block, directory);
  check(
    `the guide’s restore block exits 0 on ${what}`,
    restored.code === 0,
    `exit ${restored.code}: ${restored.output.trim().split('\n').slice(-3).join(' | ')}`,
  );
  await healthy();
  const counts = await liveCounts();
  const differ = compared(dumped, counts);
  check(
    `every table’s row count equals ${what}’s`,
    differ.length === 0,
    differ.join(', ') ||
      `${dumped.size} tables; public.price_list ${counts.get('public.price_list')}, public.organizations ${counts.get('public.organizations')}`,
  );
  const migrations = await psql(MIGRATIONS_SQL);
  check(
    `the applied migrations equal ${what}’s`,
    migrations === migrationsAtDump && migrations !== '',
    `${migrations.split(',').length} migrations`,
  );
};

const main = async () => {
  let block;
  let preUpgradeDump;
  try {
    const guide = readFileSync(GUIDE, 'utf8');
    block = readRestoreBlock(guide);
    preUpgradeDump = readPreUpgradeDump(guide);
  } catch (error) {
    console.error(`FAIL: ${CHECK} — ${GUIDE}: ${String(error)}`);
    process.exit(1);
  }
  try {
    const { stdout } = await docker(['version', '--format', '{{.Server.Version}}']);
    console.log(`docker daemon ${stdout.trim()}`);
  } catch (error) {
    console.error(`FAIL: ${CHECK} — no Docker daemon: ${String(error)}`);
    process.exit(1);
  }
  for (const image of [`platform:${TAG}`, `platform-launcher:${TAG}`]) {
    try {
      await docker(['image', 'inspect', image, '--format', '{{.Id}}']);
    } catch {
      console.error(
        `FAIL: ${CHECK} — ${image} is not on this daemon; build it with ` +
          `\`node scripts/build-images.mjs base platform launcher --tag ${TAG}\``,
      );
      process.exit(1);
    }
  }

  try {
    stages.set('docker compose up (backup profile)');
    console.log(`starting ${PROJECT} from platform:${TAG} with the backup profile …`);
    await compose(['--profile', 'backup', 'up', '-d', '--no-build']);
    await healthy();

    stages.set('seeding rows and dumping through the image');
    await insertRows('dumped', 3, 1);
    const migrationsAtDump = await psql(MIGRATIONS_SQL);
    await compose(['exec', '-T', 'db-backup', '/backup.sh']);
    const good = path.join(WORK, 'good');
    mkdirSync(good);
    await compose([
      'cp',
      '-L',
      'db-backup:/backups/last/app-latest.sql.gz',
      path.join(good, 'backup.sql.gz'),
    ]);
    const dumped = dumpCounts(
      gunzipSync(readFileSync(path.join(good, 'backup.sql.gz'))).toString('utf8'),
    );
    check(
      'the dump is gzipped plain SQL carrying the seeded rows',
      dumped.get('public.price_list') !== undefined &&
        (dumped.get('public.organizations') ?? 0) >= 1 &&
        dumped.size > 50,
      `${dumped.size} tables, public.price_list ${dumped.get('public.price_list')}, public.organizations ${dumped.get('public.organizations')}`,
    );

    stages.set('writing rows after the dump');
    await insertRows('after', 2, 1);
    const before = await liveCounts();
    const moved = compared(dumped, before);
    check(
      'rows written after the dump moved the database off it',
      moved.length >= 2,
      moved.join(', '),
    );

    stages.set('the cut-dump leg');
    const cut = path.join(WORK, 'cut');
    mkdirSync(cut);
    const half = Math.floor(statSync(path.join(good, 'backup.sql.gz')).size / 2);
    await run('sh', ['-c', `head -c ${half} ../good/backup.sql.gz > backup.sql.gz`], {
      cwd: cut,
      timeout: DOCKER_QUERY_MS,
    });
    const refused = await runBlock(block, cut);
    check(
      'a cut dump is refused by gzip -t',
      refused.code !== 0 && /unexpected end of file/i.test(refused.output),
      `exit ${refused.code}: ${refused.output.trim().split('\n').slice(-2).join(' | ')}`,
    );
    const after = await states();
    check(
      'a cut dump stops no service',
      SERVICES.every((service) => after.get(service) === 'running'),
      SERVICES.map((service) => `${service} ${after.get(service)}`).join(', '),
    );
    const untouched = compared(before, await liveCounts());
    check(
      'a cut dump leaves every row count as it was',
      untouched.length === 0,
      untouched.join(', ') || 'equal',
    );

    stages.set('the restore leg (a db-backup dump)');
    await restoreLeg('a db-backup dump', block, good, dumped, migrationsAtDump);

    stages.set('the rollback leg (§ 5’s pre-upgrade dump)');
    const rollback = path.join(WORK, 'rollback');
    mkdirSync(rollback);
    const taken = await runBlock(preUpgradeDump, rollback);
    const written = readdirSync(rollback).filter((name) => /^pre-upgrade-.*\.sql\.gz$/.test(name));
    check(
      '§ 5’s pre-upgrade dump line exits 0 and writes one pre-upgrade-<date>.sql.gz',
      taken.code === 0 && written.length === 1,
      `exit ${taken.code}; ${written.join(', ') || 'no file'}`,
    );
    if (written[0] === undefined) throw new Error('§ 5’s dump line wrote no pre-upgrade file');
    // The guide's own step: copy it to the `backup.sql.gz` the restore block names.
    copyFileSync(path.join(rollback, written[0]), path.join(rollback, 'backup.sql.gz'));
    const preUpgrade = dumpCounts(
      gunzipSync(readFileSync(path.join(rollback, 'backup.sql.gz'))).toString('utf8'),
    );
    const migrationsAtPreUpgrade = await psql(MIGRATIONS_SQL);
    await insertRows('after-pre-upgrade', 2, 1);
    const drifted = compared(preUpgrade, await liveCounts());
    check(
      'rows written after the pre-upgrade dump moved the database off it',
      drifted.length >= 2,
      drifted.join(', '),
    );
    await restoreLeg('§ 5’s pre-upgrade dump', block, rollback, preUpgrade, migrationsAtPreUpgrade);
  } catch (error) {
    const where = error instanceof Unsettled ? '' : ` (while: ${stages.current})`;
    check('the instance came up and answered', false, `${String(error)}${where}`);
  } finally {
    if (failures.length > 0) await describeInstance(compose);
    stages.set('docker compose down');
    await compose(['--profile', 'backup', 'down', '-v', '--remove-orphans']).catch((error) => {
      console.error(`cleanup of ${PROJECT} failed: ${String(error)}`);
    });
    rmSync(WORK, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    console.error(`FAIL: ${CHECK} (${failures.length}): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(`PASS: ${CHECK}`);
};

const finished = installExitBackstop(CHECK, stages);
await main();
finished();
