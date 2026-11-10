/**
 * **Why a labelled ticket did not start** (S-28.5, M28 ruling 6): the newest `ticket.intake.skipped`
 * events of a project's stream, as `GET /api/projects/:project_id/skipped-tickets` publishes them.
 *
 * The event is the only record of a skip — no task exists — and it is already redacted at its write
 * (the ticket reference and the status name went through the binding's redactor in intake), so this
 * reads it back and **parses** it: a row the schema refuses is left out rather than published as
 * something it does not say. The status name is untrusted provider text (BD-022); the screen
 * renders it as text.
 */
import {
  type IsoDateTime,
  MAX_SKIPPED_TICKETS,
  type SkippedTicket,
  skippedTicketSchema,
} from '@platform/contracts';
import { db as dbAdapters } from '@platform/infrastructure';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from './identity-queries.js';

const { events } = dbAdapters.schema;

/** The newest skips of the project, newest first, at most {@link MAX_SKIPPED_TICKETS}. */
export const listSkippedTickets = async (
  database: Database,
  projectId: string,
): Promise<readonly SkippedTicket[]> => {
  const rows = await database
    .select({ occurredAt: events.occurredAt, payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.streamType, 'project'),
        eq(events.streamId, projectId),
        eq(events.type, 'ticket.intake.skipped'),
      ),
    )
    .orderBy(desc(events.occurredAt), desc(events.position))
    .limit(MAX_SKIPPED_TICKETS);
  return rows.flatMap((row) => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const parsed = skippedTicketSchema.safeParse({
      ticket: payload.ticket,
      reason: payload.reason,
      status: typeof payload.status === 'string' ? payload.status : null,
      skipped_at: new Date(row.occurredAt).toISOString() as IsoDateTime,
    });
    return parsed.success ? [parsed.data] : [];
  });
};
