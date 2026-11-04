/**
 * The `migrate` one-shot entrypoint (technical/11 § Compose, TD-019).
 *
 * Compose runs this as its own service before the app starts:
 *
 *     migrate:  image: platform ; command: node dist/migrate.js
 *     app:      depends_on: { migrate: { condition: service_completed_successfully } }
 *
 * It is safe to run concurrently — `runMigrations` serialises on a PostgreSQL advisory lock — and
 * safe to re-run, because every step is idempotent. Locally: `pnpm run -s db:migrate`.
 *
 * Output is one JSON object per line on stdout (`LOG_FORMAT=pretty` switches to plain text). WP-06
 * introduces pino and this entrypoint should adopt it then; a one-shot process that must report
 * before any application wiring exists does not justify pulling the logger in early.
 *
 * **`--plan`** (TD-032 decisions 2 and 5, WP-272) is the read-only half: it applies nothing, takes
 * no lock and installs nothing. Its first line is the image's three labels (`image labels`,
 * printed before the configuration is read, so an operator re-pinning a tag can read the guard,
 * the rollback floor and the pg-boss schema version with no database at all); its second is the
 * `migration plan` — every pending migration with the class its file declares, the unknown rows
 * with the class each was recorded with, and the guard's verdict (`known`, `ahead_additive`,
 * `ahead`) — or the failure, with the same exit codes as a migration.
 */
import process from 'node:process';
import { db, jobs } from '@platform/infrastructure';

const pretty = (process.env.LOG_FORMAT ?? 'json') === 'pretty';

const emit = (record: Record<string, unknown>): void => {
  const line = pretty
    ? Object.entries(record)
        .map(
          ([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`,
        )
        .join(' ')
    : JSON.stringify(record);
  process.stdout.write(`${line}\n`);
};

const USAGE = 'usage: migrate [--plan]';

/** `--plan`: the labels, then the read-only plan (see the module note). */
const plan = async (config: db.DatabaseConfig): Promise<number> => {
  const client = await db.defaultMigrateDependencies.connect(config.url);
  try {
    const report = await db.planMigrations(client);
    emit({ level: 'info', msg: 'migration plan', ...report });
    return 0;
  } finally {
    await client.end().catch(() => undefined);
  }
};

export const main = async (argv: readonly string[] = process.argv.slice(2)): Promise<number> => {
  const planOnly = argv.includes('--plan');
  const unexpected = argv.filter((arg) => arg !== '--plan');
  if (unexpected.length > 0) {
    emit({ level: 'error', msg: 'invalid arguments', error: `${unexpected.join(' ')}; ${USAGE}` });
    return 2;
  }
  if (planOnly) {
    emit({ level: 'info', msg: 'image labels', labels: db.imageLabels() });
  }
  // WP-106 (PROGRESS backlog 296): this process installs pg-boss into `pgboss` and reads no
  // variable for another schema, so an `APP_JOBS_SCHEMA` naming one is refused here, by name,
  // before anything is installed — the same refusal every server role makes at start.
  const jobsSchemaRefusal = jobs.jobsSchemaRefusal(process.env);
  if (jobsSchemaRefusal !== null) {
    emit({ level: 'error', msg: 'invalid jobs configuration', error: jobsSchemaRefusal });
    return 2;
  }
  let config: db.DatabaseConfig;
  try {
    config = db.loadDatabaseConfig(process.env);
  } catch (error) {
    emit({ level: 'error', msg: 'invalid database configuration', error: String(error) });
    return 2;
  }

  if (planOnly) {
    try {
      return await plan(config);
    } catch (error) {
      emit({
        level: 'error',
        msg: 'migration plan failed',
        error: error instanceof Error ? error.message : String(error),
      });
      return 1;
    }
  }

  try {
    const report = await db.runMigrations({
      connectionString: config.url,
      appRole: config.appRole,
      partitionMonthsAhead: config.partitionMonthsAhead,
      transcriptRetentionDays: config.transcriptRetentionDays,
      log: (event) => emit({ level: 'info', ...event }),
    });

    emit({
      level: 'info',
      msg: 'migrations complete',
      applied: report.applied,
      already_applied: report.skipped.length,
      pgboss_schema_version: report.pgBossSchemaVersion,
      queues_declared: report.queuesDeclared.length,
      partitions_created: report.partitionsCreated,
      grants_applied_to: report.grantsAppliedTo,
      transcript_retention_days: report.transcriptRetentionDays,
      duration_ms: report.durationMs,
    });
    return 0;
  } catch (error) {
    emit({
      level: 'error',
      msg: 'migration failed',
      error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
};

process.exitCode = await main();
