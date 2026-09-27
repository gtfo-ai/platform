/**
 * When an undelivered notification stops being *late* and becomes *not told* — the two bounds the
 * `notifications_undelivered` gauge counts past (WP-65, PROGRESS backlog 81).
 *
 * `delivered_at` is the only column that says a human was told, and until this file nothing read
 * it to ask who was **not**. The row cannot say it either: an undelivered row is a delivery in
 * flight, a retry waiting its turn, a digest line held until the morning — or a failure. The
 * difference is time, and the right amount of it is the machinery's own, derived rather than
 * chosen, so the bound moves when the queue's policy does:
 *
 *  - **planned `immediate`**: `pipeline.outbound`'s whole retry window ({@link retryWindowMs} over
 *    {@link PIPELINE_OUTBOUND_RETRY}). Every attempt inside it re-delivers the row (a retried duty
 *    reads its own recorded row back, `awaitsImmediateRetry`), so past it every attempt has tried
 *    and failed and none is left; the row is either carried by the
 *    project's next digest (and then it *was* late, and the gauge falls when it is carried) or —
 *    for a project with the digest off, and for every organisation-scoped row — by nothing at all,
 *    which is the case backlog 81 found silent;
 *  - **planned `digest`**: a whole day (the next digest is at most a day away), plus one digest
 *    tick, plus `notify.digest`'s own retry window.
 *
 * **What the second bound does not cover, stated**: a day with more rows than one digest carries
 * (`DIGEST_ITEM_LIMIT`) leaves the remainder for the next day, so on such a project the gauge
 * counts rows that are merely a day late. That is the direction worth erring in — a project
 * producing more than fifty notifications a day is one an operator should hear about.
 */
import type { IsoDateTime } from '@platform/contracts';
import { PIPELINE_OUTBOUND_RETRY, retryWindowMs } from '../pipeline/jobs.js';
import { DIGEST_RETRY } from './digest.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** `DIGEST_TICK_CRON` is every five minutes. */
const DIGEST_TICK_MS = 5 * 60 * 1000;

export const IMMEDIATE_UNDELIVERED_AFTER_MS = retryWindowMs(PIPELINE_OUTBOUND_RETRY);
export const DIGEST_UNDELIVERED_AFTER_MS = DAY_MS + DIGEST_TICK_MS + retryWindowMs(DIGEST_RETRY);

/** The two instants before which an undelivered row of each plan is counted as not told. */
export const undeliveredNotificationBounds = (
  at: IsoDateTime,
): { readonly immediateBefore: IsoDateTime; readonly digestBefore: IsoDateTime } => {
  const now = Date.parse(at);
  return {
    immediateBefore: new Date(now - IMMEDIATE_UNDELIVERED_AFTER_MS).toISOString() as IsoDateTime,
    digestBefore: new Date(now - DIGEST_UNDELIVERED_AFTER_MS).toISOString() as IsoDateTime,
  };
};
