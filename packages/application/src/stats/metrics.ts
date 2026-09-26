/**
 * What the statistics projector counts, as data — the vocabulary of `stats_event_daily.metric`
 * (WP-41, migration 0034).
 *
 * The fold is a **pure function of one event**: `countersFor(event)` returns the rows that event
 * adds to, and nothing else decides. That matters more here than it looks, because it is what makes
 * the projection replayable: a fold that read the database to decide what to count would produce
 * different rows on a backfill than it did live, and criterion 5 of this work package is an
 * *equality* between the two (`events/replay.ts`).
 *
 * ## Why a count *and* a total
 *
 * `count` is how many events contributed and `total` is the quantity they summed. Six review
 * observations carrying eighteen accepted threads is a different fact from eighteen observations
 * carrying eighteen, and one number cannot say which — so both are stored and the read publishes
 * whichever the metric's definition asks for. A counter with no quantity leaves `total` at zero,
 * which is a *measured* zero because the row exists at all (standing rule 18: the absent case must
 * not be spelled like the empty one).
 */
import type { DomainEvent } from '@platform/contracts';

/**
 * Every key this projector may write, with the metric it serves.
 *
 * Fixed here rather than in the database (`stats_event_daily.metric` is `text`) for TD-011's
 * reason: a new counter would otherwise be an `alter type` in a migration. Nothing untrusted
 * reaches the column — every value below is a literal in this file, which
 * `metrics.test.ts` holds the fold to.
 */
export const STATS_COUNTERS = {
  /** `task.rebase.checked`, one per settlement — product/16's *"conflicts auto-resolved vs escalated"*. */
  rebaseClean: 'rebase.clean',
  rebaseResolved: 'rebase.resolved',
  rebaseConflicted: 'rebase.conflicted',
  rebaseExhausted: 'rebase.exhausted',
  /** `task.conflict.warned`, one per warned ordered pair — both orders per comparison since WP-59; `total` sums the overlapping paths. */
  conflictWarned: 'conflict.warned',
  /** `task.review.observed` — product/18:59's *"findings accepted vs dismissed"*. */
  reviewObserved: 'review_only.observed',
  reviewPosted: 'review_only.threads_posted',
  reviewAccepted: 'review_only.threads_accepted',
  reviewDismissed: 'review_only.threads_dismissed',
  /** `task.lint.posted` — product/18:60's baseline; `total` sums the questions the comment carried. */
  lintPosted: 'ticket_lint.posted',
} as const;

export type StatsCounter = (typeof STATS_COUNTERS)[keyof typeof STATS_COUNTERS];

/** A row this event adds to: `metric` is keyed per project and per civil day by the projector. */
export interface StatsCounterDelta {
  readonly metric: StatsCounter;
  /** Always 1 today — one event, one contribution — and a field so the store needs no rule of its own. */
  readonly count: number;
  /** The quantity this event carried for that metric; `0` when the metric is a pure count. */
  readonly total: number;
}

/** The types {@link countersFor} folds. Read by the projector so there is no second list. */
export const STATS_COUNTED_EVENT_TYPES = [
  'task.rebase.checked',
  'task.conflict.warned',
  'task.review.observed',
  'task.lint.posted',
] as const satisfies readonly DomainEvent['type'][];

const REBASE_COUNTERS = {
  clean: STATS_COUNTERS.rebaseClean,
  resolved: STATS_COUNTERS.rebaseResolved,
  conflicted: STATS_COUNTERS.rebaseConflicted,
  exhausted: STATS_COUNTERS.rebaseExhausted,
} as const;

/**
 * What this event adds to, or an empty list.
 *
 * Deliberately **total**: an event type this fold does not know returns nothing rather than
 * throwing, because the projector is registered for a fixed list and a throw here would park a
 * stream over a type somebody added to the catalogue (standing rule 20 — being *told* something is
 * not the moment to fail closed).
 */
export const countersFor = (event: DomainEvent): readonly StatsCounterDelta[] => {
  switch (event.type) {
    case 'task.rebase.checked':
      return [{ metric: REBASE_COUNTERS[event.payload.outcome], count: 1, total: 0 }];
    case 'task.conflict.warned':
      return [
        // `path_count` is the overlap the comparison **found**, which is not the length of the
        // event's bounded `paths` list (WP-26 says so at the payload); counting the list would
        // under-report exactly the pairs that overlap most.
        { metric: STATS_COUNTERS.conflictWarned, count: 1, total: event.payload.path_count },
      ];
    case 'task.review.observed':
      return [
        { metric: STATS_COUNTERS.reviewObserved, count: 1, total: 0 },
        {
          metric: STATS_COUNTERS.reviewPosted,
          count: 1,
          total: event.payload.threads_posted,
        },
        {
          metric: STATS_COUNTERS.reviewAccepted,
          count: 1,
          total: event.payload.threads_accepted,
        },
        {
          metric: STATS_COUNTERS.reviewDismissed,
          count: 1,
          total: event.payload.threads_dismissed,
        },
      ];
    case 'task.lint.posted':
      return [
        { metric: STATS_COUNTERS.lintPosted, count: 1, total: event.payload.questions_posted },
      ];
    default:
      return [];
  }
};
