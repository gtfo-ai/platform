/**
 * The three PostgreSQL adapters the webhook ingress stands on — `inbox`, the inbound half of
 * `integration_actions`, and the identity directory (WP-15c).
 *
 * ## `inbox` is a dedup key that has to commit with what it discharged
 *
 * {@link createPostgresInboxStore}'s `record` takes the **caller's** transaction, unlike every
 * other adapter in this directory. That is the whole point: the row means "this delivery has been
 * performed, never again", so it has to land in the same transaction as the events it produced.
 * Writing it separately would leave a window in which a crash records a delivery as performed that
 * was not — and, because the row is exactly what a redelivery is deduplicated against, nothing
 * could ever fix it. `integrations/inbound.ts` carries the argument in full.
 *
 * `on conflict (provider, delivery_id) do nothing` makes the insert the arbiter rather than a
 * preceding read: two racing deliveries both normalise, and the one whose row lands is the one
 * whose events are appended.
 *
 * ## The inbound audit writes a row and no event, deliberately
 *
 * `IntegrationAuditLog` appends `integration.action.performed` / `.failed` beside its row, because
 * those events are about an action *the platform performed*. A delivery is something the platform
 * was **told**, and its refusal path is reachable by anyone who can address the endpoint — so an
 * event there would let an unauthenticated caller grow the append-only event log and the dispatch
 * queue one row per request. Two ports writing one table, with the difference stated (`InboundAuditLog`).
 */
import type {
  InboundAuditLog,
  InboundDeliveryRecord,
  InboundIdentityDirectory,
  InboxDelivery,
  InboxStore,
  Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, JsonObject } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const INSERT_DELIVERY = `insert into inbox
    (provider, delivery_id, integration_id, received_at, headers, payload, processed_at, error,
     redaction_count, verified)
  values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)
  on conflict (provider, delivery_id) do nothing`;

interface InboxRow extends Record<string, unknown> {
  readonly provider: string;
  readonly delivery_id: string;
  readonly integration_id: string | null;
  readonly received_at: Date;
  readonly headers: unknown;
  readonly payload: unknown;
  readonly processed_at: Date | null;
  readonly error: string | null;
  readonly redaction_count: number;
  readonly verified: boolean;
}

const asObject = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};

const toDelivery = (row: InboxRow): InboxDelivery => ({
  provider: row.provider,
  deliveryId: row.delivery_id,
  integrationId: (row.integration_id ?? '') as Id,
  headers: asObject(row.headers),
  payload: asObject(row.payload),
  verified: row.verified,
  redactionCount: row.redaction_count,
  error: row.error,
  receivedAt: row.received_at.toISOString() as IsoDateTime,
  processedAt: (row.processed_at?.toISOString() ?? null) as IsoDateTime | null,
});

export const createPostgresInboxStore = (options: { readonly sql: SqlExecutor }): InboxStore => ({
  record: async (tx: Transaction, delivery: InboxDelivery): Promise<boolean> => {
    const client = postgresTransaction(tx).client;
    const result = await client.query(INSERT_DELIVERY, [
      delivery.provider,
      delivery.deliveryId,
      delivery.integrationId,
      delivery.receivedAt,
      JSON.stringify(delivery.headers),
      JSON.stringify(delivery.payload),
      delivery.processedAt,
      delivery.error,
      delivery.redactionCount,
      delivery.verified,
    ]);
    return (result.rowCount ?? 0) > 0;
  },

  find: async (provider: string, deliveryId: string): Promise<InboxDelivery | null> => {
    const { rows } = await options.sql.query<InboxRow>(
      `select provider, delivery_id, integration_id, received_at, headers, payload, processed_at,
              error, redaction_count, verified
         from inbox
        where provider = $1 and delivery_id = $2`,
      [provider, deliveryId],
    );
    const row = rows[0];
    return row === undefined ? null : toDelivery(row);
  },
});

/** `InboundDeliveryStatus` → `integration_actions.status`, so an operator meets one vocabulary. */
const STATUS: Readonly<Record<InboundDeliveryRecord['status'], string>> = {
  accepted: 'ok',
  duplicate: 'replayed',
  refused: 'failed',
};

const INSERT_ACTION = `insert into integration_actions
    (integration_id, project_id, task_id, direction, action, payload, result, status,
     duration_ms, redaction_count, attempts, created_at)
  values ($1, $2, null, 'in', $3, $4::jsonb, null, $5, $6, $7, 0, $8)`;

/** The action name every inbound row carries, so the audit can be filtered on one string. */
export const INBOUND_DELIVERY_ACTION = 'webhook_delivery';

export const createPostgresInboundAuditLog = (options: {
  readonly sql: SqlExecutor;
}): InboundAuditLog => ({
  record: async (entry: InboundDeliveryRecord): Promise<void> => {
    await options.sql.query(INSERT_ACTION, [
      entry.integrationId,
      entry.projectId,
      INBOUND_DELIVERY_ACTION,
      // `error` is already redacted by the ingress and is stored on the payload as well as in the
      // column, because `integration_actions` has no `error` column of its own (technical/03).
      JSON.stringify(
        entry.error === null ? entry.payload : { ...entry.payload, error: entry.error },
      ),
      STATUS[entry.status],
      entry.durationMs,
      entry.redactionCount,
      // `attempts` counts **provider** attempts and the platform made none: it was called, not
      // calling. The provider's own retry count is in a header (`X-Atlassian-Webhook-Retry`) that
      // this row deliberately does not promote to a column.
      entry.occurredAt,
    ]);
  },
});

/**
 * `user_identities` for one provider, as one map.
 *
 * `InboundContext.resolveUser` is **synchronous** — a normaliser decides `verified` while it builds
 * a payload — so the mapping has to be in memory before `normalise` is called, and the endpoint
 * cannot know which identities a delivery will mention. The query is a primary-key prefix scan
 * (`primary key (provider, external_id)`), and the row count is the number of external accounts a
 * self-hosted team has mapped.
 *
 * BD-006/Q10: an identity that is not here resolves to `null`, which every normaliser turns into
 * `verified: false` — recorded, never acted on.
 */
export const createPostgresIdentityDirectory = (options: {
  readonly sql: SqlExecutor;
}): InboundIdentityDirectory => ({
  forProvider: async (provider: string): Promise<ReadonlyMap<string, Id>> => {
    const { rows } = await options.sql.query<{ external_id: string; user_id: string }>(
      'select external_id, user_id from user_identities where provider = $1',
      [provider],
    );
    return new Map(rows.map((row) => [row.external_id, row.user_id as Id]));
  },
});
