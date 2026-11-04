/**
 * `run_offers` on PostgreSQL (migration 0094; WP-274, TD-031 decisions 1–2).
 *
 * The port's docblock (`RunOfferRepository`, `packages/application/src/pipeline/store.ts`) carries
 * the contract; this file is where its two statements are written down:
 *
 * - **The claim** is TD-031 §2's SQL, one statement: a `candidate` CTE picks the oldest eligible
 *   `open` offer `for update … skip locked` — a second claimant skips the row the first holds and
 *   finds nothing, rather than waiting for it and claiming it again — the `claimed` CTE moves it to
 *   `claimed` with `lease_epoch + 1`, and the outer `update runs` writes `lease_owner`,
 *   `lease_expires_at` and `lease_epoch` from it. A run that is no longer live is not a candidate.
 * - **The closing** ({@link closeRunOffer}) is called by `RunRepository.finish`, after it won the
 *   run row, in the terminal writer's own transaction: `claimed → settled`, `open → withdrawn` with
 *   the terminal reason. That is what frees `run_offers_one_live_stage_per_task` for the task's next
 *   stage (TD-031 §12).
 *
 * **Lock order.** A terminal writer locks the run row (its `update runs`, or a cancel's `for update`
 * before it) and then the offer; the claim locks the offer and then the run. The two orders cannot
 * deadlock in WP-274 because its only claim runs in the transaction that **inserted** the run, whose
 * row no other transaction can see, let alone lock. WP-276, which claims a run committed earlier,
 * inherits the question (PROGRESS, WP-274 notes).
 */
import type {
  ClaimedRunOffer,
  RunOfferRepository,
  StoredRunOffer,
  Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, RunClaimantKind, RunOfferKind } from '@platform/contracts';
import { ACTIVE_RUN_STATUSES } from '@platform/domain';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

const iso = (value: Date | string | null): IsoDateTime | null =>
  value === null ? null : (new Date(value).toISOString() as IsoDateTime);

interface RunOfferRow extends Record<string, unknown> {
  readonly id: string;
  readonly run_id: string;
  readonly task_id: string;
  readonly project_id: string;
  readonly stage: string | null;
  readonly attempt: number;
  readonly kind: RunOfferKind;
  readonly state: StoredRunOffer['state'];
  readonly lease_epoch: number;
  readonly claimant_kind: RunClaimantKind | null;
  readonly offered_at: Date | string;
  readonly claimed_at: Date | string | null;
  readonly settled_at: Date | string | null;
  readonly withdrawn_at: Date | string | null;
  readonly withdrawn_reason: string | null;
}

const toStoredOffer = (row: RunOfferRow): StoredRunOffer => ({
  id: row.id,
  runId: row.run_id,
  taskId: row.task_id,
  projectId: row.project_id,
  stage: row.stage,
  attempt: row.attempt,
  kind: row.kind,
  state: row.state,
  leaseEpoch: row.lease_epoch,
  claimantKind: row.claimant_kind,
  offeredAt: iso(row.offered_at) as IsoDateTime,
  claimedAt: iso(row.claimed_at),
  settledAt: iso(row.settled_at),
  withdrawnAt: iso(row.withdrawn_at),
  withdrawnReason: row.withdrawn_reason,
});

/**
 * TD-031 §2's claim. `$1` the eligible run (WP-274's only eligibility, `RunOfferEligibility`), `$2`
 * the live statuses, `$3` the claimant kind, `$4` the claim instant, `$5` the owner, `$6` the
 * lease's expiry — both null in a composition with no lease, which leaves the run row as such a
 * composition wrote it before WP-274. Since WP-275b the outer update is also the run's
 * `created → starting` (TD-031's 2026-11-04 amendment §4); a row a previous build inserted live in
 * another status keeps it.
 */
const CLAIM_SQL = `with candidate as (
    select o.id
      from run_offers o
      join runs r on r.id = o.run_id
     where o.state = 'open'
       and o.run_id = $1
       and r.status = any($2::run_status[])
     order by o.offered_at
     for update of o skip locked
     limit 1
  ), claimed as (
    update run_offers o
       set state = 'claimed', lease_epoch = o.lease_epoch + 1, claimant_kind = $3,
           claimed_at = $4::timestamptz
      from candidate
     where o.id = candidate.id
    returning o.id, o.run_id, o.task_id, o.lease_epoch
  )
  update runs r
     set lease_owner = $5, lease_expires_at = $6::timestamptz, lease_epoch = c.lease_epoch,
         status = case r.status when 'created' then 'starting'::run_status else r.status end
    from claimed c
   where r.id = c.run_id
  returning c.id, c.run_id, c.task_id, c.lease_epoch`;

/**
 * Closes the run's offer — `RunRepository.finish`'s second statement, only for the writer that won
 * the run row. An offer already `settled` or `withdrawn` is left as it is; a run with no offer (one
 * created before migration 0094) has nothing to close.
 */
export const closeRunOffer = async (
  sql: SqlExecutor,
  runId: Id,
  terminalReason: string,
): Promise<void> => {
  await sql.query(
    `update run_offers
        set state = case state when 'claimed' then 'settled' else 'withdrawn' end,
            settled_at = case state when 'claimed' then now() else settled_at end,
            withdrawn_at = case state when 'open' then now() else withdrawn_at end,
            withdrawn_reason = case state when 'open' then $2 else withdrawn_reason end
      where run_id = $1 and state in ('open', 'claimed')`,
    [runId, terminalReason],
  );
};

export const createPostgresRunOfferRepository = (): RunOfferRepository => ({
  insert: async (tx, offer) => {
    await sqlOf(tx).query(
      `insert into run_offers (id, run_id, task_id, project_id, stage, attempt, kind, offered_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
      [
        offer.id,
        offer.runId,
        offer.taskId,
        offer.projectId,
        offer.stage,
        offer.attempt,
        offer.kind,
        offer.offeredAt,
      ],
    );
  },
  claim: async (tx, claim): Promise<ClaimedRunOffer | null> => {
    const { rows } = await sqlOf(tx).query<{
      id: string;
      run_id: string;
      task_id: string;
      lease_epoch: number;
    }>(CLAIM_SQL, [
      claim.eligibility.runId,
      [...ACTIVE_RUN_STATUSES],
      claim.claimantKind,
      claim.now,
      claim.owner,
      claim.expiresAt,
    ]);
    const row = rows[0];
    return row === undefined
      ? null
      : {
          offerId: row.id,
          runId: row.run_id,
          taskId: row.task_id,
          epoch: row.lease_epoch,
          owner: claim.owner,
        };
  },
  load: async (tx, runId) => {
    const { rows } = await sqlOf(tx).query<RunOfferRow>(
      `select id, run_id, task_id, project_id, stage, attempt, kind, state, lease_epoch,
              claimant_kind, offered_at, claimed_at, settled_at, withdrawn_at, withdrawn_reason
         from run_offers where run_id = $1`,
      [runId],
    );
    const row = rows[0];
    return row === undefined ? null : toStoredOffer(row);
  },
});
