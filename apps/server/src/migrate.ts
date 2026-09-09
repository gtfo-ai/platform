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
 */
import process from 'node:process';
import { db } from '@platform/infrastructure';

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

export const main = async (): Promise<number> => {
  let config: db.DatabaseConfig;
  try {
    config = db.loadDatabaseConfig(process.env);
  } catch (error) {
    emit({ level: 'error', msg: 'invalid database configuration', error: String(error) });
    return 2;
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
