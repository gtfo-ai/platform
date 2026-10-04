/**
 * The ticket poller's rows (WP-87, migration 0061) and the merge-request poller's (WP-110,
 * migration 0068): which bindings poll, and where each one's next window starts.
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
  type MergeRequestPollStore,
  type PolledBinding,
  type ReadyMergeRequest,
  TICKET_POLL_CONFIG_KEYS,
  type TicketPollStore,
} from '@platform/application';
import { type Id, type IsoDateTime, mergeRequestRefSchema } from '@platform/contracts';
import type { SqlExecutor } from '../events/sql.js';

interface PollingRow extends Record<string, unknown> {
  readonly project_id: string;
  readonly integration_id: string;
}

interface CursorRow extends Record<string, unknown> {
  readonly cursor: Date | null;
}

export interface PostgresTicketPollStoreOptions {
  readonly sql: SqlExecutor;
}

/**
 * The three statements both pollers share, over a binding type and a cursor column that are
 * **constants of this file** — never caller text, so interpolating them is not a query built from
 * input (WP-110: the merge-request poller reads git bindings and `mr_poll_cursor`).
 */
const bindingPollStatements = (
  sql: SqlExecutor,
  type: 'task_management' | 'git',
  column: 'poll_cursor' | 'mr_poll_cursor',
): Pick<MergeRequestPollStore, 'listPolling' | 'cursorOf' | 'advanceCursor'> => ({
  listPolling: async (limit) => {
    const { rows } = await sql.query<PollingRow>(
      `select b.project_id, b.integration_id
         from bindings b
         join integrations i on i.id = b.integration_id
        where i.type = '${type}'
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
    const { rows } = await sql.query<CursorRow>(
      `select ${column} as cursor from bindings where project_id = $1 and integration_id = $2`,
      [binding.projectId, binding.integrationId],
    );
    const cursor = rows[0]?.cursor ?? null;
    return cursor === null ? null : (cursor.toISOString() as IsoDateTime);
  },
  advanceCursor: async (binding, to) => {
    await sql.query(
      `update bindings
          set ${column} = greatest(coalesce(${column}, $3::timestamptz), $3::timestamptz)
        where project_id = $1 and integration_id = $2`,
      [binding.projectId, binding.integrationId, to],
    );
  },
});

export const createPostgresTicketPollStore = (
  options: PostgresTicketPollStoreOptions,
): TicketPollStore => ({
  ...bindingPollStatements(options.sql, 'task_management', 'poll_cursor'),
  /**
   * WP-110 (backlog 298): the live tasks' ticket keys, the set `recordTicketSignal` stamps
   * (`state not in ('done', 'cancelled')`), most recently touched first — served by
   * `tasks (project_id, state)`.
   */
  liveTicketKeys: async (binding, provider, limit) => {
    const { rows } = await options.sql.query<{ ticket_key: string }>(
      `select ticket_key
         from tasks
        where project_id = $1 and ticket_provider = $2 and state not in ('done', 'cancelled')
        group by ticket_key
        order by max(updated_at) desc, ticket_key
        limit $3`,
      [binding.projectId, provider, limit],
    );
    return rows.map((row) => row.ticket_key);
  },
});

interface ReadyRow extends Record<string, unknown> {
  readonly task_id: string;
  readonly mr_ref: unknown;
  readonly entered_at: string;
}

/**
 * The merge-request poller's rows (WP-110, migration 0068): git bindings, `mr_poll_cursor` — and,
 * since WP-123 (migration 0074), the poll-only binding's last-seen default head and the tasks
 * waiting at Ready whose notes it reads.
 */
export const createPostgresMergeRequestPollStore = (
  options: PostgresTicketPollStoreOptions,
): MergeRequestPollStore => ({
  ...bindingPollStatements(options.sql, 'git', 'mr_poll_cursor'),
  /** WP-142: the stored default branch and the binding's head of it, in one statement. */
  defaultHeadOf: async (binding) => {
    const { rows } = await options.sql.query<{ branch: string; head: string | null }>(
      `select p.default_branch as branch, b.mr_poll_default_head as head
         from bindings b join projects p on p.id = b.project_id
        where b.project_id = $1 and b.integration_id = $2`,
      [binding.projectId, binding.integrationId],
    );
    const row = rows[0];
    return row === undefined ? null : { branch: row.branch, head: row.head };
  },
  /** WP-142: written only while `branch` is still the stored default branch (a compare-and-set). */
  recordDefaultHead: async (binding, sha, branch) => {
    await options.sql.query(
      `update bindings b set mr_poll_default_head = $3
         from projects p
        where b.project_id = $1 and b.integration_id = $2
          and p.id = b.project_id and p.default_branch = $4`,
      [binding.projectId, binding.integrationId, sha, branch],
    );
  },
  /**
   * Tasks at `ready_for_merge` with a merge request, joined to their **current** stage row (the
   * attempt `stage_attempts` names, as the stranded-stage read joins it) for its `entered_at`, in
   * the database's own microsecond rendering. Oldest entry first. A row whose `mr_ref` fails the
   * contract's schema is left out rather than thrown on (rule 20: one bad row must not stop every
   * other task's notes).
   */
  readyMergeRequests: async (binding, limit) => {
    const { rows } = await options.sql.query<ReadyRow>(
      `select t.id as task_id, t.mr_ref,
              to_char(s.entered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as entered_at
         from tasks t
         join task_stages s
           on s.task_id = t.id and s.stage = t.current_stage
          and s.attempt = coalesce((t.stage_attempts ->> t.current_stage)::int, 1)
        where t.project_id = $1 and t.state = 'ready_for_merge' and t.mr_ref is not null
        order by s.entered_at, t.id
        limit $2`,
      [binding.projectId, limit],
    );
    const ready: ReadyMergeRequest[] = [];
    for (const row of rows) {
      const mr = mergeRequestRefSchema.safeParse(row.mr_ref);
      if (mr.success) {
        ready.push({
          taskId: row.task_id as Id,
          mr: mr.data,
          enteredAt: row.entered_at as IsoDateTime,
        });
      }
    }
    return ready;
  },
});
