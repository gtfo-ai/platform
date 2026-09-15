/**
 * The statistics projector — the reader of the four metric events nothing consumed, and the writer
 * of the delivery row every per-task metric joins from (WP-41, product/16, product/19 §10).
 *
 * **One handler, two tables, and nothing else writes them** (`stats-writers.test.ts` is the census
 * over the tree). Every row commits in the handler's own transaction together with the
 * `handler_executions` claim that says the handler ran (TD-005), which is what makes it idempotent
 * under a redelivery *and* under a backfill: a second dispatch finds a `succeeded` claim and never
 * reaches this code, and so does a second pass of `events/replay.ts` over the same range.
 *
 * ## The fold reads nothing and decides nothing
 *
 * `countersFor` is a pure function of the event (`./metrics.ts`) and `mr.merged` writes the instant
 * the envelope carries. The projector's only read is the organisation's timezone, which decides
 * which civil day a counter lands in. That restraint is the backfill criterion: a fold that asked
 * the database *"how many returns does this task have?"* would answer differently in a replay than
 * it did live — the state has moved on — and the two sets of rows would not be equal. Every metric
 * that needs such a question is answered at **read time**, from the rows that carry it
 * (`apps/server/src/queries/stats-queries.ts`).
 *
 * ## What `mr.merged` is used for here, and what it is not
 *
 * It is the **delivery**: product/19 §10 defines tasks delivered as *"count(tasks with `mr.merged`
 * and mode=normal) per period (merge time)"*, and no table records the merge time (migration 0034
 * says why `tasks.completed_at` is a different instant). The `mode = normal` half is deliberately
 * **not** applied here: it is a property of the `tasks` row, which the read joins, and filtering at
 * fold time would bake today's mode into a row a later correction could not revise.
 *
 * A merge request that belongs to **no task** writes nothing and says so in the log — every
 * human-authored merge request review-only mode observes is one of those. It is not a zero and not
 * a delivery; it is a merge the platform did not make. Which task a merge request belongs to is a
 * **lookup**, not a payload field: `task_id` is nullish on every `mr.*` event and is null on every
 * one a git adapter produces, which `StatsStore.taskForMergeRequest` exists for.
 *
 * ## Why it does not read `mr.updated`
 *
 * The same answer WP-29 gave and for the same two reasons, restated here because this is the work
 * package its `EVENT_CONSUMPTION` entry named: the payload carries **no author**, so nothing can be
 * attributed to anybody, and it fires for the platform's **own** pushes, so counting it as activity
 * would record the Developer stage pushing a commit. It stays `unconsumed` with its reason.
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { resolveBudgetTimezone, rollupDay } from '../cost/window.js';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import { countersFor, STATS_COUNTED_EVENT_TYPES } from './metrics.js';
import type { StatsStore } from './ports.js';

/** The handler's name is its `handler_executions` key; renaming it re-runs it over the whole log. */
export const STATS_HANDLER = 'stats.projection';

/**
 * TD-005's 200–299 band is notifications, UI and projections, and technical/02 names *"stats"* on
 * the `mr.*` row. **240**, one band after the human-time projector at 230, for the same reason that
 * one runs late: at 240 the task↔merge-request association an earlier handler wrote has committed,
 * so `mr.merged` for a task the saga has just bound is not read before the binding exists.
 */
export const STATS_PRIORITY = 240;

export interface StatsProjectorOptions {
  readonly store: StatsStore;
  readonly logger?: Logger;
}

/**
 * The organisation's zone, or UTC — and it **fails open**, exactly as the ledger and the human-time
 * projector do (standing rule 9: one arbiter, `resolveBudgetTimezone`).
 *
 * A handler that threw would park the stream it is on and stop counting for every project over one
 * organisation's misconfiguration (rule 20), so the substitution is logged by name and the day is
 * cut in UTC — which is what an unset zone already means (Q12).
 */
const usableTimezone = async (
  options: StatsProjectorOptions,
  context: HandlerContext,
  projectId: Id,
  logger: Logger,
): Promise<string> => {
  const configured = await options.store.organisationTimezone(context.scope.tx, projectId);
  const resolved = resolveBudgetTimezone(configured);
  if (resolved.substituted) {
    logger.warn(
      { timezone: configured, fallback: resolved.timezone, project_id: projectId },
      'stats: the organisation timezone is not an IANA zone this runtime can do calendar arithmetic in; the day is cut in UTC',
    );
  }
  return resolved.timezone;
};

const onMerged = async (
  options: StatsProjectorOptions,
  context: HandlerContext,
  event: Extract<DomainEvent, { type: 'mr.merged' }>,
  logger: Logger,
): Promise<void> => {
  /**
   * **The payload's `task_id` is almost always null on a real instance**, and reading it alone is
   * how this projection would have shipped as a permanent zero: a git adapter turning a webhook
   * into `mr.merged` does not know which task the merge request belongs to, so the association is
   * read from `tasks.mr_ref` exactly as the human-time projector and the saga read it. The payload
   * is still preferred when it carries one — a producer that *does* know is more precise than a
   * lookup by iid.
   */
  const taskId =
    event.payload.task_id ??
    (await options.store.taskForMergeRequest(context.scope.tx, {
      projectId: event.payload.project_id,
      iid: event.payload.mr.iid,
    }));
  if (taskId === null) {
    logger.debug(
      { project_id: event.payload.project_id, iid: event.payload.mr.iid },
      'stats: this merge request belongs to no task, so it is not a delivery of one; nothing is recorded',
    );
    return;
  }
  await options.store.recordDelivery(context.scope.tx, {
    taskId,
    projectId: event.payload.project_id,
    mergedAt: context.event.event.occurred_at,
  });
};

/** The four counted types, named rather than described: each carries a non-null `project_id`. */
type CountedEvent = Extract<DomainEvent, { type: (typeof STATS_COUNTED_EVENT_TYPES)[number] }>;

const onCounted = async (
  options: StatsProjectorOptions,
  context: HandlerContext,
  event: CountedEvent,
  logger: Logger,
): Promise<void> => {
  const deltas = countersFor(event);
  if (deltas.length === 0) {
    return;
  }
  const timezone = await usableTimezone(options, context, event.payload.project_id, logger);
  const day = rollupDay(context.event.event.occurred_at, timezone);
  for (const delta of deltas) {
    await options.store.addCounter(context.scope.tx, {
      projectId: event.payload.project_id,
      day,
      metric: delta.metric,
      count: delta.count,
      total: delta.total,
    });
  }
};

export const statsProjector = (options: StatsProjectorOptions): EventHandler => ({
  name: STATS_HANDLER,
  priority: STATS_PRIORITY,
  // Read off `STATS_COUNTED_EVENT_TYPES` rather than restated, so the fold and the registration
  // cannot disagree about which types this handler is responsible for (standing rule 7).
  eventTypes: ['mr.merged', ...STATS_COUNTED_EVENT_TYPES],
  handle: async (context) => {
    const logger = options.logger ?? silentLogger;
    const event = context.event.event;
    if (event.type === 'mr.merged') {
      return onMerged(options, context, event, logger);
    }
    // The registration below is exactly `mr.merged` plus the counted four, so the narrowing is a
    // statement about that list rather than an assumption about the catalogue.
    return onCounted(options, context, event as CountedEvent, logger);
  },
});
