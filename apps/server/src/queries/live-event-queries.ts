/**
 * The read behind `sse/domain-event-bridge.ts` (S-23.14): live events in a position range.
 *
 * Bounded three ways, each in the statement: the position range a hint named (`events_position_idx`
 * on every partition), the live types (`task.*`, `run.*` — `LIVE_DOMAIN_EVENT_TYPES`), and, when no
 * `org` stream is watched, the watched projects and tasks — so a row for a topic nobody here
 * watches is not read at all. The payload is selected only so the bridge can project it; nothing
 * of it beyond the projection's allow-list leaves this process.
 *
 * **The project each row is about** (BD-035): the payload's `project_id`, else the project of its
 * `task_id` or `run_id`, else of its own task or run stream — each by primary key, and a value that
 * is not a uuid is never cast (a `case` guards it), so a malformed payload resolves nothing rather
 * than failing the read. The hub filters the `org` topic by it.
 */
import { LIVE_DOMAIN_EVENT_TYPES } from '@platform/contracts';
import { sql } from 'drizzle-orm';
import type { LiveEventReadRequest, LiveEventRow } from '../sse/domain-event-bridge.js';
import type { Database } from './identity-queries.js';

interface Row extends Record<string, unknown> {
  readonly position: string | number;
  readonly project_id: string | null;
  readonly id: string;
  readonly type: string;
  readonly stream_type: string;
  readonly stream_id: string;
  readonly occurred_at: Date | string;
  readonly payload: unknown;
}

/** A uuid, as a PostgreSQL regular expression: the guard before a payload value is cast. */
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export const readLiveEvents = async (
  database: Database,
  request: LiveEventReadRequest,
): Promise<readonly LiveEventRow[]> => {
  const scoped =
    request.scope.kind === 'all'
      ? sql``
      : sql`and (payload ->> 'project_id' = any(${sql.param([...request.scope.projectIds])}::text[])
              or payload ->> 'task_id' = any(${sql.param([...request.scope.taskIds])}::text[]))`;
  const { rows } = await database.execute<Row>(sql`
    select e.position, e.id, e.type, e.stream_type, e.stream_id, e.occurred_at, e.payload,
           coalesce(
             case when e.payload ->> 'project_id' ~* ${UUID_PATTERN}
                  then e.payload ->> 'project_id' end,
             case when e.payload ->> 'task_id' ~* ${UUID_PATTERN}
                  then (select t.project_id::text from tasks t
                         where t.id = (e.payload ->> 'task_id')::uuid) end,
             case when e.payload ->> 'run_id' ~* ${UUID_PATTERN}
                  then (select r.project_id::text from runs r
                         where r.id = (e.payload ->> 'run_id')::uuid) end,
             case when e.stream_type = 'task'
                  then (select t.project_id::text from tasks t where t.id = e.stream_id) end,
             case when e.stream_type = 'run'
                  then (select r.project_id::text from runs r where r.id = e.stream_id) end
           ) as project_id
      from events e
     where position > ${request.after}
       and position <= ${request.upTo}
       and type = any(${sql.param([...LIVE_DOMAIN_EVENT_TYPES])}::text[])
       ${scoped}
     order by position
     limit ${request.limit}
  `);
  return rows.map((row) => ({
    position: Number(row.position),
    id: row.id,
    type: row.type,
    stream_type: row.stream_type,
    stream_id: row.stream_id,
    occurred_at: toIso(row.occurred_at),
    payload: row.payload,
    projectId: row.project_id ?? null,
  }));
};
