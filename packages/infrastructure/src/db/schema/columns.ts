/**
 * Column types Drizzle has no builder for. The DDL is hand-written (TD-011), so these only have to
 * describe the on-disk type well enough for queries and for the schema-parity test.
 */
import { customType } from 'drizzle-orm/pg-core';

/** Encrypted secret material and inline blob payloads. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** Generated full-text index column; never written by the application. */
export const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

/**
 * 64-bit transaction id. Consumers fence on `pg_snapshot_xmin(pg_current_snapshot())` because the
 * event log's global position is not gapless (research/07, TD-005).
 */
export const xid8 = customType<{ data: string }>({
  dataType: () => 'xid8',
});
