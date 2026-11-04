/**
 * The read behind `sse/domain-event-bridge.ts` (S-23.14): live events in a position range.
 *
 * Bounded three ways, each in the statement: the position range a hint named (`events_position_idx`
 * on every partition), the live types (`task.*`, `run.*` — `LIVE_DOMAIN_EVENT_TYPES`), and, when no
 * `org` stream is watched, the watched projects and tasks — so a row for a topic nobody here
 * watches is not read at all. The payload is selected only so the bridge can project it; nothing
 * of it beyond the projection's allow-list leaves this process.
 */
import { LIVE_DOMAIN_EVENT_TYPES } from '@platform/contracts';
import { sql } from 'drizzle-orm';
import type { LiveEventReadRequest, LiveEventRow } from '../sse/domain-event-bridge.js';
import type { Database } from './identity-queries.js';

interface Row extends Record<string, unknown> {
  readonly position: string | number;
  readonly id: string;
  readonly type: string;
  readonly stream_type: string;
  readonly stream_id: string;
  readonly occurred_at: Date | string;
  readonly payload: unknown;
}

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
    select position, id, type, stream_type, stream_id, occurred_at, payload
      from events
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
  }));
};
