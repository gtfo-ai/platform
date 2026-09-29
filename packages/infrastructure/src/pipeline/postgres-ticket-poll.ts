/**
 * The ticket poller's rows (WP-87, migration 0061): which bindings poll, and where each one's next
 * window starts.
 *
 * `listPolling` reads the switch out of the **merged** configuration — `bindings.config` over
 * `integrations.config`, the overlay `createPostgresBindingRepository` applies — without decrypting
 * a credential or building an adapter, which is what lets the sweep run once a minute over every
 * binding. It is a pre-filter: each poll asks the adapter's `pollPlan()` again, which is the
 * authority (a provider whose schema has no `poll_enabled` never reaches `true` here, because its
 * strict schema refuses the key at the write). A binding's copy of an account-only key is dropped
 * by the repository's overlay; `poll_enabled` is not one, by design — the ruling puts the switch on
 * the binding.
 *
 * `advanceCursor` is forward-only in the statement itself (`greatest`), so two polls of one binding
 * that raced — which `stately` makes rare, not impossible — cannot move the cursor back.
 */
import {
  type PolledBinding,
  TICKET_POLL_CONFIG_KEYS,
  type TicketPollStore,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import type { SqlExecutor } from '../events/sql.js';

interface PollingRow extends Record<string, unknown> {
  readonly project_id: string;
  readonly integration_id: string;
}

interface CursorRow extends Record<string, unknown> {
  readonly poll_cursor: Date | null;
}

export interface PostgresTicketPollStoreOptions {
  readonly sql: SqlExecutor;
}

export const createPostgresTicketPollStore = (
  options: PostgresTicketPollStoreOptions,
): TicketPollStore => ({
  listPolling: async (limit) => {
    const { rows } = await options.sql.query<PollingRow>(
      `select b.project_id, b.integration_id
         from bindings b
         join integrations i on i.id = b.integration_id
        where i.type = 'task_management'
          and coalesce(b.config -> $1::text, i.config -> $1::text) = 'true'::jsonb
        order by b.created_at, b.id
        limit $2`,
      [TICKET_POLL_CONFIG_KEYS.enabled, limit],
    );
    return rows.map(
      (row): PolledBinding => ({
        projectId: row.project_id as Id,
        integrationId: row.integration_id as Id,
      }),
    );
  },
  cursorOf: async (binding) => {
    const { rows } = await options.sql.query<CursorRow>(
      `select poll_cursor from bindings where project_id = $1 and integration_id = $2`,
      [binding.projectId, binding.integrationId],
    );
    const cursor = rows[0]?.poll_cursor ?? null;
    return cursor === null ? null : (cursor.toISOString() as IsoDateTime);
  },
  advanceCursor: async (binding, to) => {
    await options.sql.query(
      `update bindings
          set poll_cursor = greatest(coalesce(poll_cursor, $3::timestamptz), $3::timestamptz)
        where project_id = $1 and integration_id = $2`,
      [binding.projectId, binding.integrationId, to],
    );
  },
});
