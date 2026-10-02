/**
 * The task export — `GET /api/tasks/:task_id/export`, product/09:45's *"Export as JSON per task"*
 * (WP-112, PROGRESS backlog 310).
 *
 * **A fold over projections that already exist, and nothing else.** The route hands this function
 * what three reads answered — `findTaskDetail` (the projection `GET /api/tasks/:id` serves), the
 * task's `human_actions` as `GET /api/tasks/:id/audit` projects them, and the task's events — and
 * this function decides only the three things an export adds: where each cap cut, whether the
 * caller may see the audit rows, and what the pattern redaction replaced in the event payloads. It
 * reads no table, so the route test can drive every branch through the real router against plain
 * functions, and the one new SQL statement (`listTaskEvents`) is the integration tier's to hold.
 *
 * ## Why the event payloads are redacted here and nothing else is
 *
 * Every other part of the document is a projection that is already served, and each one carries
 * whatever redaction its writer applied (the run's TD-012 redactor on prompts and artifacts, the
 * command routes' on reasons and steers, the inbound path's on provider text). The event log is the
 * one part **no route has ever published** — the dead-letter list says in so many words that it does
 * not publish a payload — and its rows carry no `redaction_count` that would vouch for them. So the
 * payloads go through the platform's patterns (TD-012 step 2) on the way out, the way the dead-letter
 * route treats a handler's error, and the replacements are counted rather than hidden. The cost is
 * stated: the exported payload can differ from the stored row, which an export taken off the
 * platform is the right place to pay. **Patterns only** — no exact-value layer over the project's
 * binding credentials (WP-107 applies that to prompt files): today no unredacted provider text is on
 * a task's events (the inbound events built from raw deliveries sit on the project stream with no
 * correlation id), so a future writer that correlates one to a task would export a credential no
 * pattern knows (WP-112 review round 1, a stated residual).
 */
import type {
  JsonObject,
  TaskAuditEntry,
  TaskDetailResponse,
  TaskExportEvent,
  TaskExportResponse,
} from '@platform/contracts';
import { MAX_TASK_EXPORT_EVENTS, MAX_TASK_EXPORT_HUMAN_ACTIONS } from '@platform/contracts';
import type { TaskEventRow } from './pipeline-queries.js';

/** The platform's pattern redaction, as the dead-letter route takes it. */
export interface PayloadRedactor {
  readonly redactJson: (value: JsonObject) => {
    readonly value: JsonObject;
    readonly count: number;
  };
}

export interface TaskExportParts {
  readonly detail: Omit<TaskDetailResponse, 'can_raise_budget'>;
  /**
   * The audit rows **as read with one row past the cap**, newest first — or `null` when the caller
   * may not read them, in which case nothing was read.
   */
  readonly humanActions: readonly TaskAuditEntry[] | null;
  /** The events, oldest first, **read with one row past the cap**. */
  readonly events: readonly TaskEventRow[];
  readonly exportedAt: Date;
  readonly redactor: PayloadRedactor;
}

/** The caps the route reads with: one past each, so the export can say whether it cut. */
export const TASK_EXPORT_LIMITS = {
  events: MAX_TASK_EXPORT_EVENTS,
  humanActions: MAX_TASK_EXPORT_HUMAN_ACTIONS,
} as const;

const toWireEvent = (row: TaskEventRow, payload: JsonObject): TaskExportEvent => ({
  position: row.position,
  id: row.id,
  type: row.type,
  stream_type: row.streamType,
  stream_id: row.streamId,
  stream_seq: row.streamSeq,
  correlation_id: row.correlationId,
  cause_event_id: row.causeEventId,
  actor: row.actor,
  occurred_at: row.occurredAt.toISOString(),
  payload,
});

/** The export document — see the module note for what each part is and why. */
/**
 * The task read without what it says about **the caller** — `can_raise_budget` (WP-131 review
 * round 2). A document handed to somebody else must not carry the exporter's permissions, and the
 * export's schema has no such field, so a read that carried one would otherwise fail the document.
 */
const withoutCallerFacts = (
  detail: TaskExportParts['detail'],
): Omit<TaskDetailResponse, 'can_raise_budget'> => {
  const { can_raise_budget: _caller, ...rest } = detail as TaskExportParts['detail'] & {
    readonly can_raise_budget?: boolean;
  };
  return rest;
};

export const assembleTaskExport = (parts: TaskExportParts): TaskExportResponse => {
  const limits = TASK_EXPORT_LIMITS;
  let redactionCount = 0;
  const events = parts.events.slice(0, limits.events).map((row) => {
    const redacted = parts.redactor.redactJson(row.payload);
    redactionCount += redacted.count;
    return toWireEvent(row, redacted.value);
  });
  return {
    format: 1,
    exported_at: parts.exportedAt.toISOString(),
    ...withoutCallerFacts(parts.detail),
    human_actions:
      parts.humanActions === null
        ? null
        : {
            items: parts.humanActions.slice(0, limits.humanActions),
            limit: limits.humanActions,
            truncated: parts.humanActions.length > limits.humanActions,
          },
    events: {
      items: events,
      limit: limits.events,
      truncated: parts.events.length > limits.events,
      redaction_count: redactionCount,
    },
  };
};
