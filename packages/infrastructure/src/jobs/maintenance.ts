/**
 * The one scheduled job WP-03 left for the scheduler to register.
 *
 * `packages/infrastructure/src/db/partitions.ts` says it: `migrate` creates the next few months of
 * partitions, and a long-running instance would eventually insert into a month that has none. This
 * wires that maintenance onto pg-boss cron and applies the operator's transcript retention in the
 * same pass (technical/03 § Retention).
 *
 * It runs as the least-privilege application role: both SQL functions are SECURITY DEFINER with
 * EXECUTE granted to exactly that role, and the retention window is read from
 * `platform_table_policy` rather than passed in, so the job cannot widen it.
 */
import type { Jobs, JobWorker } from '@platform/application';
import {
  maintainPartitions,
  PARTITION_MAINTENANCE_CRON,
  PARTITION_MAINTENANCE_JOB,
  type PartitionMaintenanceResult,
  type Queryable,
} from '../db/partitions.js';

export interface PartitionMaintenanceRegistration {
  readonly db: Queryable;
  /** Months of partitions to keep ahead of the current one (`APP_DB_PARTITION_MONTHS_AHEAD`). */
  readonly partitionMonthsAhead: number;
  /**
   * Zone the daily cron is read in. Explicit: "03:20" has to be somebody's 03:20, and taking it
   * from the container's clock is how a redeployment silently moves a maintenance window.
   */
  readonly timezone: string;
  /** Called with what each run created and dropped — the hook `apps/server` logs from (WP-06). */
  readonly onResult?: (result: PartitionMaintenanceResult) => void;
}

/**
 * Declares the queue, registers the daily schedule and subscribes the handler. Idempotent: safe to
 * call on every boot and from every replica — the queue and the schedule are keyed, and the
 * `exclusive` policy keeps two replicas from running the maintenance twice.
 */
export const registerPartitionMaintenance = async (
  jobs: Jobs,
  registration: PartitionMaintenanceRegistration,
): Promise<JobWorker> => {
  await jobs.defineQueue({
    name: PARTITION_MAINTENANCE_JOB,
    policy: 'exclusive',
    retryLimit: 2,
    retryDelaySeconds: 300,
    // Creating a year of partitions on a large instance is slow; the default 15 minutes is plenty
    // but the retention drop is the part that must never be interrupted half-way.
    expireInSeconds: 900,
  });

  await jobs.scheduleCron({
    queue: PARTITION_MAINTENANCE_JOB,
    cron: PARTITION_MAINTENANCE_CRON,
    timezone: registration.timezone,
  });

  return jobs.work({
    queue: PARTITION_MAINTENANCE_JOB,
    handler: async () => {
      const result = await maintainPartitions(registration.db, {
        partitionMonthsAhead: registration.partitionMonthsAhead,
      });
      registration.onResult?.(result);
    },
  });
};

export { PARTITION_MAINTENANCE_CRON, PARTITION_MAINTENANCE_JOB };
