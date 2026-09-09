/**
 * Partition maintenance (technical/03: "Native monthly range partitions managed by the app (no
 * pg_partman)", TD-006).
 *
 * `migrate` creates the partitions the next few months need, but a long-running instance would
 * eventually insert into a month that has no partition and fail. The job below runs on the
 * platform's own scheduler (pg-boss cron, WP-05) and keeps the window ahead of "now"; the same
 * job applies the operator's transcript retention, which is the only purge technical/03 allows.
 *
 * Both SQL functions are SECURITY DEFINER with EXECUTE revoked from PUBLIC and granted only to the
 * application role: creating a partition requires ownership of the parent table, which the
 * application role does not have. The retention window is deliberately *not* an argument — it is
 * read from `platform_table_policy.retention_days`, which only the schema owner can write, so a
 * caller cannot widen the only DELETE-shaped power it has over an append-only table.
 */

/** The narrow slice of `pg.Pool` / `pg.Client` this module needs. */
export interface Queryable {
  query<R extends Record<string, unknown>>(
    queryText: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[] }>;
}

/** Job name for the scheduler (WP-05 registers it; the cron expression lives with the job). */
export const PARTITION_MAINTENANCE_JOB = 'db.partitions.maintain' as const;

/**
 * Runs daily. 03:20 keeps it clear of the nightly rollup recompute and well inside the month, so a
 * missed run still has ~30 days of created partitions in hand.
 */
export const PARTITION_MAINTENANCE_CRON = '20 3 * * *' as const;

/** The retention scope of `run_messages` (technical/03 § "Retention and backups"). */
export const TRANSCRIPT_RETENTION_SCOPE = 'transcripts' as const;

export interface PartitionMaintenanceOptions {
  readonly partitionMonthsAhead: number;
}

export interface PartitionMaintenanceResult {
  readonly created: readonly string[];
  readonly dropped: readonly string[];
}

/** Creates every missing monthly partition up to `monthsAhead` months ahead. Idempotent. */
export const ensureMonthlyPartitions = async (
  db: Queryable,
  monthsAhead: number,
): Promise<string[]> => {
  const { rows } = await db.query<{ created: string[] }>(
    'select platform_ensure_partitions($1::int) as created',
    [monthsAhead],
  );
  return rows[0]?.created ?? [];
};

/**
 * Applies the configured transcript retention: drops whole `run_messages` partitions older than
 * `platform_table_policy.retention_days`. Returns an empty list when no retention is configured,
 * which is the default. Metadata, artifacts, events and cost are never touched.
 */
export const dropExpiredTranscriptPartitions = async (db: Queryable): Promise<string[]> => {
  const { rows } = await db.query<{ dropped: string[] }>(
    'select platform_drop_expired_partitions($1::text) as dropped',
    [TRANSCRIPT_RETENTION_SCOPE],
  );
  return rows[0]?.dropped ?? [];
};

/**
 * The body of the scheduled job: extend the partition window, then apply whatever retention the
 * operator configured at migrate time.
 */
export const maintainPartitions = async (
  db: Queryable,
  options: PartitionMaintenanceOptions,
): Promise<PartitionMaintenanceResult> => {
  const created = await ensureMonthlyPartitions(db, options.partitionMonthsAhead);
  const dropped = await dropExpiredTranscriptPartitions(db);
  return { created, dropped };
};
