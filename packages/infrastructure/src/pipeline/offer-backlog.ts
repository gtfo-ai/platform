/**
 * **What the offer pool is holding** (WP-277, TD-031 decision 13) — the reads behind `/readyz`'s
 * `claimants` line and the `run_offers_open{project}` / `run_offer_wait_seconds` gauges.
 *
 * Since WP-276 an agent run waits as an **offer**, not as a `stage.execute` job: the job ends at the
 * offer, so `jobs_queued{queue="stage.execute"}` counts plans and gates waiting for a worker, never
 * runs waiting for a claimant. These two reads are where an agent backlog is visible now. Both are
 * about the **instance**: the pool is in the database, so every process reads the same answer.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import type { SqlExecutor } from '../events/sql.js';

/**
 * How long an open offer may wait, with no claimant, before `/readyz` says so: **five minutes** past
 * the instant workers may claim it (TD-031 decision 13's `workers_from + 5 min`). Since WP-278 the
 * offer carries `workers_from`; a `server_only` offer has none and is measured from its
 * `server_from`, and an offer written before WP-278 from its `offered_at`.
 */
export const OFFER_UNCLAIMED_AFTER_SECONDS = 300;

/** One project's open offers and how long the oldest has waited. */
export interface ProjectOfferBacklog {
  readonly projectId: Id;
  readonly open: number;
  readonly oldestWaitSeconds: number;
}

/** Per project, the open offers — the `run_offers_open{project}` gauge's source. */
export const readOfferBacklog = async (
  sql: SqlExecutor,
): Promise<readonly ProjectOfferBacklog[]> => {
  const { rows } = await sql.query<{ project_id: string; open: number; oldest: number }>(
    `select project_id, count(*)::int as open,
            extract(epoch from now() - min(offered_at))::float8 as oldest
       from run_offers
      where state = 'open'
      group by project_id
      order by project_id`,
  );
  return rows.map((row) => ({
    projectId: row.project_id as Id,
    open: Number(row.open),
    oldestWaitSeconds: Math.max(0, Number(row.oldest)),
  }));
};

/** The oldest open offer that has waited past the bound, or `null`. */
export interface UnclaimedOffer {
  readonly runId: Id;
  readonly offeredAt: IsoDateTime;
  readonly waitedSeconds: number;
}

export const readOldestUnclaimedOffer = async (
  sql: SqlExecutor,
  unclaimedAfterSeconds: number = OFFER_UNCLAIMED_AFTER_SECONDS,
): Promise<UnclaimedOffer | null> => {
  const { rows } = await sql.query<{ run_id: string; offered_at: Date; waited: number }>(
    `select run_id, offered_at,
            extract(epoch from now() - coalesce(workers_from, server_from, offered_at))::float8
              as waited
       from run_offers
      where state = 'open'
        and coalesce(workers_from, server_from, offered_at)
              <= now() - make_interval(secs => $1::float8)
      order by coalesce(workers_from, server_from, offered_at), id
      limit 1`,
    [unclaimedAfterSeconds],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : {
        runId: row.run_id as Id,
        offeredAt: new Date(row.offered_at).toISOString() as IsoDateTime,
        waitedSeconds: Math.max(0, Number(row.waited)),
      };
};
