/**
 * `run_offers` on PostgreSQL (migration 0094; WP-274, TD-031 decisions 1–2).
 *
 * The port's docblock (`RunOfferRepository`, `packages/application/src/pipeline/store.ts`) carries
 * the contract; this file is where its statements are written down:
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
 * **One lock order** (WP-276, backlog 697, TD-031's 2026-11-04 amendment §5): **`run_offers`, then
 * `runs`, then `tasks`**, for every transaction that locks more than one of them. The claim's CTE
 * takes `for update of o, r skip locked` — the offer, then (in the same row-lock step) the run, and
 * it **skips** a run a terminal writer holds rather than waiting on it. Every terminal writer locks
 * the offer before the run: `lockSettlement`, `finish` itself (its first statement), a cancel's
 * `lockRun`/`lockLiveRunOf` with `forUpdate`, the sweep's `claimExpiredRun`, and the withdrawal
 * ({@link createPostgresRunOfferRepository}'s `withdraw`, a conditional update on the offer, then
 * the run's `finish`). `tasks.save` is optimistic and last everywhere.
 */
import type {
  ClaimableRunOffer,
  ClaimedRunOffer,
  RunOfferRelease,
  RunOfferRepository,
  RunTokenHolder,
  StoredRunOffer,
  Transaction,
} from '@platform/application';
import { decideRelease } from '@platform/application';
import type {
  AgentRole,
  Id,
  IsoDateTime,
  RunClaimantKind,
  RunOfferKind,
  RunStatus,
} from '@platform/contracts';
import { ACTIVE_RUN_STATUSES } from '@platform/domain';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';
import { remoteRunCredentialRefusedSql, userMayRunInProjectSql } from './running-role.js';
import { USER_MAY_ACT_SQL, workerUsableSql } from './worker-holder.js';

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
  readonly assignee_user_id: string | null;
  readonly assignee_until: Date | string | null;
  readonly server_from: Date | string | null;
  readonly workers_from: Date | string | null;
  readonly expires_at: Date | string | null;
}

/** Every column {@link toStoredOffer} reads, for the two reads that answer a whole offer. */
const OFFER_COLUMNS = `id, run_id, task_id, project_id, stage, attempt, kind, state, lease_epoch,
              claimant_kind, offered_at, claimed_at, settled_at, withdrawn_at, withdrawn_reason,
              assignee_user_id, assignee_until, server_from, workers_from, expires_at`;

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
  routing: {
    assigneeUserId: row.assignee_user_id,
    assigneeUntil: iso(row.assignee_until),
    serverFrom: iso(row.server_from),
    workersFrom: iso(row.workers_from),
    // `null` for an offer written before WP-278: it never expires (`expiredOpen` never finds it).
    expiresAt: iso(row.expires_at),
  },
});

/**
 * **A remote worker's eligibility for offer `o`** (WP-281, TD-031 decision 8), checked inside the one
 * claim statement:
 *
 * - a **stage** or an **ask** offer — since WP-283 (backlog 741) the worker routes compose the ask's
 *   own ending (TD-031 §13), so an ask goes to the asker's worker inside its head start (the offer's
 *   `assignee_user_id` is the asker) and then to the pool;
 * - the worker is not excluded from it (`excluded_worker_ids`, decisions 6 and 12);
 * - it holds the offer's run and egress images — the digests the offer names, or the core's own for
 *   an offer that names none (decision 4);
 * - the worker is not revoked, its user may act (backlog 714: here, in the statement that commits the
 *   claim) and its **effective** project role — the higher of its organisation role and a project
 *   membership, `rbac.ts`'s rule (backlog 886) — is `member` or above, and it is not paused — neither by a usage
 *   limit (`paused_until`) nor by its owner (`manually_paused_at`, WP-292);
 * - `now ≥ workers_from`, or the worker's user is the offer's assignee inside its head start — a
 *   `null` `workers_from` is *never* (`server_only`, and an offer written before WP-278);
 * - the project's run credential is `minted`, or — WP-282, decision 5, Q124 (a) — a git binding whose
 *   integration declares `run_credential: static` or `deploy_key` **and** `remote_run_credential:
 *   allow` (absent is `deny`, the default: such a project is excluded).
 */
const workerEligibleSql = (p: {
  readonly now: string;
  readonly worker: string;
  readonly held: string;
  readonly run: string;
  readonly egress: string;
}): string => `(
         not (${p.worker}::uuid = any(o.excluded_worker_ids))
     and coalesce(o.image_digests ->> 'run', ${p.run}::text) = any(${p.held}::text[])
     and coalesce(o.image_digests ->> 'egress', ${p.egress}::text) = any(${p.held}::text[])
     and exists (
           select 1
             from workers w
             join users u on u.id = w.user_id
            where w.id = ${p.worker}::uuid
              and w.revoked_at is null
              and ${USER_MAY_ACT_SQL}
              and (w.paused_until is null or w.paused_until <= ${p.now}::timestamptz)
              and w.manually_paused_at is null
              and ${userMayRunInProjectSql('w.user_id', 'o.project_id')}
              and (o.workers_from <= ${p.now}::timestamptz
                   or (o.assignee_user_id = w.user_id and ${p.now}::timestamptz < o.assignee_until)))
     and not ${remoteRunCredentialRefusedSql('o.project_id')})`;

/**
 * **A worker's claim scope takes offer `o`** (WP-293, TD-031's 2026-11-05 claim-scope amendment,
 * decision 2): `workers.claim_project_ids` is `null` (every project) or names `o`'s project. A
 * conjunct of an **automatic** claim only — a pick ignores it — and it only narrows: it is asked
 * beside {@link workerEligibleSql}, never instead of any part of it, so no value admits an offer the
 * eligibility refuses. `'{}'` (*pick only*) matches nothing.
 */
const workerScopeTakesSql = (worker: string): string => `exists (
           select 1 from workers ws
            where ws.id = ${worker}::uuid
              and (ws.claim_project_ids is null or o.project_id = any(ws.claim_project_ids)))`;

/** The claim's parameters, as {@link CLAIM_SQL} numbers them. */
const WORKER_ELIGIBLE_CLAIM = workerEligibleSql({
  now: '$4',
  worker: '$7',
  held: '$8',
  run: '$9',
  egress: '$10',
});

/**
 * TD-031 §2's claim. `$1` narrows it to one run's offer, or is null for the oldest eligible open
 * offer (the server claimant's loop, WP-276); `$2` the live statuses, `$3` the claimant kind, `$4`
 * the claim instant, `$5` the owner, `$6` the lease's expiry — both null in a composition with no
 * lease. **The server's eligibility** (WP-278, TD-031 decision 8): `server_from` reached — a
 * `null` `server_from` is *never* (`workers_only`) — or an offer written before WP-278, which has
 * neither `*_from` and is the server's at once. **A remote worker's** (WP-281, {@link workerEligibleSql}):
 * `$7` the worker, `$8` the digests it holds, `$9`/`$10` the core's run and egress digests, `$11` the
 * run token's hash — and `$12`, **a pick** (WP-293): `true` skips the worker's claim scope
 * ({@link workerScopeTakesSql}) and nothing else, `false` (an automatic claim) asks it. The outer update is the run's `created → starting` (WP-275b); a row a previous
 * build inserted live in another status keeps it. `for update of o, r skip locked` takes the offer and
 * then its run (the one lock order, WP-276) and skips a run a terminal writer holds.
 */
const CLAIM_SQL = `with candidate as (
    select o.id
      from run_offers o
      join runs r on r.id = o.run_id
     where o.state = 'open'
       and ($1::uuid is null or o.run_id = $1::uuid)
       and r.status = any($2::run_status[])
       and ($3 <> 'server'
            or o.server_from <= $4::timestamptz
            or (o.server_from is null and o.workers_from is null))
       and ($3 <> 'worker' or ${WORKER_ELIGIBLE_CLAIM})
       and ($3 <> 'worker' or $12::boolean or ${workerScopeTakesSql('$7')})
     order by o.offered_at, o.id
     for update of o, r skip locked
     limit 1
  ), claimed as (
    update run_offers o
       set state = 'claimed', lease_epoch = o.lease_epoch + 1, claimant_kind = $3,
           claimed_at = $4::timestamptz, worker_id = $7::uuid,
           run_token_hash = case when $7::uuid is null then o.run_token_hash else $11 end,
           run_token_epoch = case when $7::uuid is null then o.run_token_epoch
                                  else o.lease_epoch + 1 end,
           image_digests = case when $7::uuid is null then o.image_digests
                                else coalesce(o.image_digests,
                                              jsonb_build_object('run', $9::text, 'egress', $10::text))
                           end
      from candidate
     where o.id = candidate.id
    returning o.id, o.run_id, o.task_id, o.kind, o.lease_epoch, o.image_digests
  )
  update runs r
     set lease_owner = $5, lease_expires_at = $6::timestamptz, lease_epoch = c.lease_epoch,
         worker_id = $7::uuid,
         status = case r.status when 'created' then 'starting'::run_status else r.status end
    from claimed c
   where r.id = c.run_id
  returning c.id, c.run_id, c.task_id, c.kind, c.lease_epoch, c.image_digests`;

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

/**
 * Locks a run's offer row `for update` — the first lock of every transaction that locks more than one
 * of `run_offers`, `runs` and `tasks` (WP-276, backlog 697). A run with no offer (created before
 * migration 0094) locks nothing here.
 */
export const lockOfferOf = async (sql: SqlExecutor, runId: string): Promise<void> => {
  await sql.query('select 1 from run_offers where run_id = $1 for update', [runId]);
};

export const createPostgresRunOfferRepository = (): RunOfferRepository => ({
  insert: async (tx, offer) => {
    await sqlOf(tx).query(
      `insert into run_offers (id, run_id, task_id, project_id, stage, attempt, kind, offered_at,
                               assignee_user_id, assignee_until, server_from, workers_from,
                               expires_at, excluded_worker_ids)
       values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10::timestamptz,
               $11::timestamptz, $12::timestamptz, $13::timestamptz,
               array(select distinct unnest($14::uuid[])))`,
      [
        offer.id,
        offer.runId,
        offer.taskId,
        offer.projectId,
        offer.stage,
        offer.attempt,
        offer.kind,
        offer.offeredAt,
        offer.routing.assigneeUserId,
        offer.routing.assigneeUntil,
        offer.routing.serverFrom,
        offer.routing.workersFrom,
        offer.routing.expiresAt,
        [...(offer.excludedWorkerIds ?? [])],
      ],
    );
  },
  carriedExclusions: async (tx, entry): Promise<readonly Id[]> => {
    // TD-031 §12: the entry's newest stage offer — its exclusions, plus the worker it lost to the
    // sweep (never one a usage limit stopped: its own pause keeps it off, TD-031's 2026-11-05
    // amendment). `ordinality` keeps the order they were excluded in.
    const { rows } = await sqlOf(tx).query<{ worker_id: string }>(
      `with previous as (
         select o.excluded_worker_ids,
                case when r.terminal_reason = 'lease_expired' then o.worker_id end as lost_worker_id
           from run_offers o
           join runs r on r.id = o.run_id
          where o.kind = 'stage' and o.task_id = $1 and o.stage = $2 and o.attempt = $3
          order by o.offered_at desc, o.id desc
          limit 1)
       select worker_id from (
         select w.worker_id, min(w.position) as position
           from previous p,
                lateral (select e.worker_id, e.position
                           from unnest(p.excluded_worker_ids) with ordinality as e(worker_id, position)
                         union all
                         select p.lost_worker_id, 2147483647 where p.lost_worker_id is not null) w
          group by w.worker_id) ordered
        order by position`,
      [entry.taskId, entry.stage, entry.attempt],
    );
    return rows.map((row) => row.worker_id as Id);
  },
  claim: async (tx, claim): Promise<ClaimedRunOffer | null> => {
    const worker = claim.worker;
    if ((claim.claimantKind === 'worker') !== (worker !== undefined)) {
      throw new Error(
        'a worker claim names its worker, and only a worker claim does (RunOfferClaim.worker, WP-281)',
      );
    }
    if (worker?.pick === true && claim.eligibility.runId === undefined) {
      throw new Error('a pick names its run (RemoteClaimant.pick, WP-293)');
    }
    const { rows } = await sqlOf(tx).query<{
      id: string;
      run_id: string;
      task_id: string;
      kind: RunOfferKind;
      lease_epoch: number;
      image_digests: { run?: unknown; egress?: unknown } | null;
    }>(CLAIM_SQL, [
      claim.eligibility.runId ?? null,
      [...ACTIVE_RUN_STATUSES],
      claim.claimantKind,
      claim.now,
      claim.owner,
      claim.expiresAt,
      worker?.workerId ?? null,
      worker === undefined ? null : [...worker.heldImageDigests],
      worker?.images.run ?? null,
      worker?.images.egress ?? null,
      worker?.runTokenHash ?? null,
      worker?.pick === true,
    ]);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const digests = row.image_digests;
    return {
      offerId: row.id,
      runId: row.run_id,
      taskId: row.task_id,
      kind: row.kind,
      epoch: row.lease_epoch,
      owner: claim.owner,
      images:
        digests !== null && typeof digests.run === 'string' && typeof digests.egress === 'string'
          ? { run: digests.run, egress: digests.egress }
          : null,
    };
  },
  /**
   * WP-293's list: the claim's own candidate predicate and {@link workerEligibleSql} — the same text,
   * numbered for this statement — with the claim scope **read** (`automatic`) rather than asked. No
   * lock: a row another claim holds is listed and then refused at the pick, which is the claim's own
   * answer to a race.
   */
  claimable: async (tx, input): Promise<readonly ClaimableRunOffer[]> => {
    const { rows } = await sqlOf(tx).query<{
      run_id: string;
      task_id: string;
      project_id: string;
      kind: RunOfferKind;
      stage: string | null;
      role: AgentRole;
      offered_at: Date | string;
      automatic: boolean;
    }>(
      `select o.run_id, o.task_id, o.project_id, o.kind, o.stage, r.role, o.offered_at,
              ${workerScopeTakesSql('$2')} as automatic
         from run_offers o
         join runs r on r.id = o.run_id
        where o.state = 'open'
          and r.status = any($1::run_status[])
          and ${workerEligibleSql({ now: '$3', worker: '$2', held: '$4', run: '$5', egress: '$6' })}
        order by o.offered_at, o.id
        limit $7`,
      [
        [...ACTIVE_RUN_STATUSES],
        input.worker.workerId,
        input.now,
        [...input.worker.heldImageDigests],
        input.worker.images.run,
        input.worker.images.egress,
        input.limit,
      ],
    );
    return rows.map((row) => ({
      runId: row.run_id as Id,
      taskId: row.task_id as Id,
      projectId: row.project_id as Id,
      kind: row.kind,
      stage: row.stage,
      role: row.role,
      offeredAt: iso(row.offered_at) as IsoDateTime,
      automatic: row.automatic,
    }));
  },
  /**
   * WP-281's release — the port's docblock has the rule. The offer, then the run, locked (§5's
   * order); the decision is read off the locked rows and the two writes follow, so a claim, a
   * settle or a sweep of the same run waits for this transaction or has already ended the row.
   */
  release: async (tx, input): Promise<RunOfferRelease> => {
    const sql = sqlOf(tx);
    await lockOfferOf(sql, input.runId);
    const { rows } = await sql.query<{
      offer_id: string;
      task_id: string;
      project_id: string;
      state: string;
      offer_epoch: number;
      token_epoch: number | null;
      released_at: Date | null;
      offer_worker: string | null;
      status: string;
      run_epoch: number;
      lease_owner: string | null;
      marked: boolean;
    }>(
      `select o.id as offer_id, o.task_id, o.project_id, o.state, o.lease_epoch as offer_epoch,
              o.run_token_epoch as token_epoch, o.released_at, o.worker_id as offer_worker,
              r.status, r.lease_epoch as run_epoch, r.lease_owner,
              r.cli_spawn_requested_at is not null as marked
         from run_offers o
         join runs r on r.id = o.run_id
        where o.run_id = $1
          for update of r`,
      [input.runId],
    );
    const row = rows[0];
    if (row === undefined) {
      return { kind: 'lease_lost' };
    }
    const decision = decideRelease(
      {
        offerState: row.state,
        offerEpoch: row.offer_epoch,
        tokenEpoch: row.token_epoch,
        released: row.released_at !== null,
        offerOwner: row.offer_worker === null ? null : `worker:${row.offer_worker}`,
        runStatus: row.status,
        runEpoch: row.run_epoch,
        leaseOwner: row.lease_owner,
        marked: row.marked,
      },
      input,
    );
    if (decision !== 'release') {
      return { kind: decision };
    }
    await sql.query(
      `update run_offers
          set state = 'open', release_reason = $2, released_at = $3::timestamptz,
              excluded_worker_ids = case
                when $4::uuid is null or $4::uuid = any(excluded_worker_ids) then excluded_worker_ids
                else array_append(excluded_worker_ids, $4::uuid) end
        where run_id = $1`,
      [input.runId, input.reason, input.now, input.excludeWorkerId],
    );
    await sql.query(
      `update runs
          set status = 'created', lease_owner = null, lease_expires_at = null, worker_id = null
        where id = $1`,
      [input.runId],
    );
    return {
      kind: 'released',
      offerId: row.offer_id,
      taskId: row.task_id,
      projectId: row.project_id,
    };
  },
  runTokenHolder: async (tx, runId): Promise<RunTokenHolder | null> => {
    const { rows } = await sqlOf(tx).query<{
      offer_id: string;
      kind: RunOfferKind;
      run_token_hash: string | null;
      run_token_epoch: number | null;
      worker_id: string | null;
      usable: boolean;
      status: RunStatus;
      ended_at: Date | null;
    }>(
      `select o.id as offer_id, o.kind, o.run_token_hash, o.run_token_epoch, o.worker_id,
              (o.worker_id is not null and ${workerUsableSql('o.worker_id')}) as usable,
              r.status, r.ended_at
         from run_offers o
         join runs r on r.id = o.run_id
        where o.run_id = $1`,
      [runId],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          runId,
          offerId: row.offer_id,
          kind: row.kind,
          tokenHash: row.run_token_hash,
          tokenEpoch: row.run_token_epoch,
          workerId: row.worker_id,
          workerUsable: row.usable,
          runStatus: row.status,
          endedAt: iso(row.ended_at),
        };
  },
  /**
   * WP-276's withdrawal: **one conditional statement** — only an `open` offer moves, so a claim that
   * won the row lock first leaves it untouched and this answers `null`. The offer is the first row
   * the withdrawal locks (§5); the caller ends the run and saves the task after.
   */
  withdraw: async (tx, input) => {
    const byTask = 'taskId' in input.by;
    const { rows } = await sqlOf(tx).query<{ id: string; run_id: string }>(
      `update run_offers
          set state = 'withdrawn', withdrawn_at = $2::timestamptz, withdrawn_reason = $3
        where state = 'open'
          and ${byTask ? "task_id = $1 and kind = 'stage'" : 'run_id = $1'}
       returning id, run_id`,
      [
        byTask ? (input.by as { taskId: Id }).taskId : (input.by as { runId: Id }).runId,
        input.now,
        input.reason,
      ],
    );
    const row = rows[0];
    return row === undefined ? null : { offerId: row.id, runId: row.run_id };
  },
  liveStageOffer: async (tx, taskId) => {
    const { rows } = await sqlOf(tx).query<RunOfferRow>(
      `select ${OFFER_COLUMNS}
         from run_offers
        where task_id = $1 and kind = 'stage' and state in ('open', 'claimed')`,
      [taskId],
    );
    const row = rows[0];
    return row === undefined ? null : toStoredOffer(row);
  },
  openWithoutPlan: async (tx, limit) => {
    const { rows } = await sqlOf(tx).query<{ run_id: string; kind: RunOfferKind }>(
      `select o.run_id, o.kind
         from run_offers o
        where o.state = 'open'
          and not exists (select 1 from run_plans p where p.run_id = o.run_id)
        order by o.offered_at
        limit $1`,
      [limit],
    );
    return rows.map((row) => ({ runId: row.run_id, kind: row.kind }));
  },
  expiredOpen: async (tx, input) => {
    const { rows } = await sqlOf(tx).query<{
      run_id: string;
      task_id: string;
      project_id: string;
      kind: RunOfferKind;
      offered_at: Date;
      expires_at: Date;
    }>(
      `select run_id, task_id, project_id, kind, offered_at, expires_at
         from run_offers
        where state = 'open' and expires_at <= $1::timestamptz
        order by expires_at, id
        limit $2`,
      [input.now, input.limit],
    );
    return rows.map((row) => ({
      runId: row.run_id,
      taskId: row.task_id,
      projectId: row.project_id,
      kind: row.kind,
      offeredAt: iso(row.offered_at) as IsoDateTime,
      expiresAt: iso(row.expires_at) as IsoDateTime,
    }));
  },
  unroutedOpen: async (tx, limit) => {
    const { rows } = await sqlOf(tx).query<{
      id: string;
      run_id: string;
      project_id: string;
      kind: RunOfferKind;
      offered_at: Date;
    }>(
      `select id, run_id, project_id, kind, offered_at
         from run_offers
        where state = 'open' and server_from is null and workers_from is null
        order by offered_at, id
        limit $1`,
      [limit],
    );
    return rows.map((row) => ({
      offerId: row.id,
      runId: row.run_id,
      projectId: row.project_id,
      kind: row.kind,
      offeredAt: iso(row.offered_at) as IsoDateTime,
    }));
  },
  reroute: async (tx, input) => {
    const result = await sqlOf(tx).query(
      `update run_offers
          set server_from = $2::timestamptz, workers_from = $3::timestamptz,
              expires_at = $4::timestamptz
        where id = $1 and state = 'open' and server_from is null and workers_from is null`,
      [input.offerId, input.routing.serverFrom, input.routing.workersFrom, input.routing.expiresAt],
    );
    return (result.rowCount ?? 0) > 0;
  },
  load: async (tx, runId) => {
    const { rows } = await sqlOf(tx).query<RunOfferRow>(
      `select ${OFFER_COLUMNS}
         from run_offers where run_id = $1`,
      [runId],
    );
    const row = rows[0];
    return row === undefined ? null : toStoredOffer(row);
  },
});
