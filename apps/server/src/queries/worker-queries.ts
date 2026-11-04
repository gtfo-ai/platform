/**
 * The storage of workers and the device flow (WP-280, TD-031 decisions 7 and 10c; migration 0096).
 *
 * {@link WorkerStore} is what the two route modules (`routes/worker-device.ts`, `routes/workers.ts`)
 * need, and {@link createPostgresWorkerStore} is its only production implementation; the in-memory
 * double the route tests use is `queries/worker-store-memory.ts`, and both are held to one
 * contract suite (`test/contract/support/worker-store.ts`) — the double by the contract tier, this
 * module by the integration tier. Every decision is the domain's (`@platform/domain`'s
 * `workers/device-flow.ts`); this module reads the row, asks, and writes what the answer says, in
 * one transaction with the row locked, so two concurrent polls (or a poll racing an approval)
 * serialise rather than both minting.
 *
 * ## What is stored, and what never is
 *
 * Both codes and the credential arrive **already hashed** (SHA-256 hex, `workers/secrets.ts`): this
 * module never sees a device code, a user code or a credential, so no query, log line or error
 * built here can carry one.
 *
 * ## Revocation and deactivation (TD-031 §7)
 *
 * {@link WorkerStore.revokeWorker} sets `revoked_at` and, in the same transaction, the worker's live
 * runs' `lease_expires_at = now()` — **nothing else** — so the ordinary lease sweep ends them after
 * its grace, revokes their minted credentials, closes their offers and re-plans once (WP-286).
 * {@link WorkerStore.expireUserWorkerLeases} is the same write for every worker of a user, which the
 * user's deactivation runs (`auth/better-auth.ts`'s user-update hook); a deactivated user's
 * credentials stop authenticating at once through {@link WorkerStore.findCredentialSubject}, which
 * reads the user's state on every call.
 */
import type { JsonObject } from '@platform/contracts';
import {
  checkDeviceDecision,
  type DeviceCodeState,
  type DevicePollDecision,
  decideDevicePoll,
  deviceCodeLimitExceeded,
  isDeviceCodeStale,
  repeatedDeviceDecision,
} from '@platform/domain';
import { pipeline as pipelineAdapters } from '@platform/infrastructure';
import { sql } from 'drizzle-orm';
import type { Database } from './identity-queries.js';

/** Serialises the outstanding-code count with the insert it admits (`pg_advisory_xact_lock`). */
export const WORKER_DEVICE_CODE_LOCK = 4_214_280_001;

export interface NewDeviceCode {
  readonly id: string;
  readonly deviceCodeHash: string;
  readonly userCodeHash: string;
  readonly clientAddress: string;
  readonly userAgent: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly intervalSeconds: number;
}

export type CreateDeviceCodeResult =
  | { readonly status: 'created' }
  | { readonly status: 'limited'; readonly limit: 'address' | 'instance' }
  /** A hash collided with an existing row's; the caller draws a new pair. */
  | { readonly status: 'collision' };

/** The worker a successful poll creates. The credential's hash only; the caller holds the value. */
export interface MintedWorker {
  readonly workerId: string;
  readonly credentialHash: string;
}

export type DevicePollResult =
  | Exclude<DevicePollDecision, { readonly outcome: 'issue' }>
  | { readonly outcome: 'issued'; readonly workerId: string };

/** What the approval page shows about a pending code (TD-031 §10c). */
export interface DeviceCodeView {
  readonly clientAddress: string;
  readonly userAgent: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface DeviceDecisionInput {
  readonly userCodeHash: string;
  readonly decision: 'approve' | 'deny';
  /** The machine's name; required to approve. */
  readonly name: string | null;
  readonly confirmedStale: boolean;
  readonly actorUserId: string;
  readonly now: Date;
  /** The `human_actions` row's params beside the ones this module adds. */
  readonly auditParams: JsonObject;
}

export type DeviceDecisionResult =
  /** `performed: false` is a repeat of the recorded decision: nothing written, no audit row. */
  | { readonly status: 'decided'; readonly decidedAt: Date; readonly performed: boolean }
  | { readonly status: 'not_found' | 'expired' | 'already_decided' | 'needs_confirmation' };

export interface WorkerListRow {
  readonly id: string;
  readonly name: string;
  readonly userId: string;
  readonly userEmail: string;
  readonly userName: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date | null;
  readonly protocolVersion: number | null;
  readonly imageDigests: unknown;
  readonly state: string;
  readonly revokedAt: Date | null;
  readonly pausedUntil: Date | null;
  readonly pausedReason: string | null;
  readonly concurrency: number;
}

export type RevokeWorkerResult =
  | { readonly status: 'not_found' }
  | {
      readonly status: 'revoked';
      readonly performed: boolean;
      readonly revokedAt: Date;
      readonly expiredRuns: number;
    };

/** What authenticating a presented credential needs to know about the worker it names. */
export interface CredentialSubject {
  readonly workerId: string;
  readonly userId: string;
  readonly credentialHash: string;
  /** Not revoked, and its user may act (not banned, not disabled). */
  readonly usable: boolean;
}

export interface WorkerStore {
  createDeviceCode(input: NewDeviceCode, now: Date): Promise<CreateDeviceCodeResult>;
  /** One `device/token` poll; an unknown device code answers `expired_token`. */
  pollDeviceCode(input: {
    readonly deviceCodeHash: string;
    readonly now: Date;
    readonly mint: MintedWorker;
  }): Promise<DevicePollResult>;
  /** A **pending** code (unexpired, undecided), or `null`. */
  findPendingDeviceCode(userCodeHash: string, now: Date): Promise<DeviceCodeView | null>;
  decideDeviceCode(input: DeviceDecisionInput): Promise<DeviceDecisionResult>;
  /** Every worker when `userId` is `null`; the user's own otherwise. Newest first. */
  listWorkers(userId: string | null): Promise<WorkerListRow[]>;
  revokeWorker(input: {
    readonly workerId: string;
    /** `null` for an administrator, who may revoke any worker; a user id restricts to that user's. */
    readonly ownerUserId: string | null;
    readonly actorUserId: string;
    readonly now: Date;
  }): Promise<RevokeWorkerResult>;
  /** The deactivation write: the live runs of every worker of the user get `lease_expires_at = now()`. */
  expireUserWorkerLeases(userId: string): Promise<number>;
  findCredentialSubject(workerId: string): Promise<CredentialSubject | null>;
  /**
   * What an authenticated worker call records (WP-281): `last_seen_at` on the **database's** clock —
   * what `assigneeOnline` and the connected count compare with `now()` — the protocol it spoke, and,
   * when the call reported them, the image digests it holds. Answers the row as listed, or `null`
   * for no such worker.
   */
  recordContact(input: {
    readonly workerId: string;
    readonly protocolVersion: number;
    readonly imageDigests: readonly string[] | null;
  }): Promise<WorkerListRow | null>;
  /**
   * The workers **connected** now — not revoked, seen in the last {@link WORKER_CONNECTED_SECONDS}
   * on the database's clock — and how many of them are paused (`/readyz`'s `claimants`, the
   * `workers_connected`/`workers_paused` gauges).
   */
  countConnected(): Promise<{ readonly connected: number; readonly paused: number }>;
}

/**
 * A worker is connected while its last authenticated call is younger than this — TD-031 §8's
 * *online* (a heartbeat in the last 60 s), the same window `assigneeOnline` reads.
 */
export const WORKER_CONNECTED_SECONDS = 60;

const at = (value: Date | string | null): Date | null =>
  value === null ? null : value instanceof Date ? value : new Date(value);

const ms = (value: Date | string | null): number | null => at(value)?.getTime() ?? null;

type DeviceCodeRowSql = {
  readonly id: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly interval_seconds: number;
  readonly last_polled_at: Date | null;
  readonly approved_at: Date | null;
  readonly approved_by: string | null;
  readonly worker_name: string | null;
  readonly denied_at: Date | null;
  readonly denied_by: string | null;
  readonly consumed_at: Date | null;
  readonly client_address: string;
  readonly user_agent: string | null;
};

const stateOf = (row: DeviceCodeRowSql): DeviceCodeState => ({
  createdAt: ms(row.created_at) ?? 0,
  expiresAt: ms(row.expires_at) ?? 0,
  intervalSeconds: row.interval_seconds,
  lastPolledAt: ms(row.last_polled_at),
  approvedAt: ms(row.approved_at),
  deniedAt: ms(row.denied_at),
  consumedAt: ms(row.consumed_at),
});

/**
 * The user may act: not disabled, and not under a ban that is still in force — `userMayAct`
 * (`identity-queries.ts`) in SQL, the session hook's rule; the store suite holds the two together
 * with a ban whose expiry has passed and one still ahead. The text is defined once, in
 * `packages/infrastructure/src/pipeline/worker-holder.ts`, because the claim, the renewal and the
 * settle re-ask it in their own statements (WP-281, backlog 714).
 */
const USER_MAY_ACT = sql.raw(pipelineAdapters.USER_MAY_ACT_SQL);

/** The revocation's one write to `runs` (TD-031 §7): the live runs' lease expires now, nothing else. */
const expireLeasesSql = (workerFilter: ReturnType<typeof sql>) => sql`
  update runs set lease_expires_at = now()
   where worker_id in (${workerFilter})
     and status in ('created', 'starting', 'running')
  returning id`;

/** A `workers` row joined with its user, as {@link WorkerStore.listWorkers} reads it. */
type WorkerRowSql = {
  id: string;
  name: string;
  user_id: string;
  email: string;
  user_name: string | null;
  created_at: Date;
  last_seen_at: Date | null;
  protocol_version: number | null;
  image_digests: unknown;
  state: string;
  revoked_at: Date | null;
  paused_until: Date | null;
  paused_reason: string | null;
  concurrency: number;
};

const toWorkerListRow = (row: WorkerRowSql): WorkerListRow => ({
  id: row.id,
  name: row.name,
  userId: row.user_id,
  userEmail: row.email,
  userName: row.user_name,
  createdAt: at(row.created_at) as Date,
  lastSeenAt: at(row.last_seen_at),
  protocolVersion: row.protocol_version,
  imageDigests: row.image_digests,
  state: row.state,
  revokedAt: at(row.revoked_at),
  pausedUntil: at(row.paused_until),
  pausedReason: row.paused_reason,
  concurrency: row.concurrency,
});

export const createPostgresWorkerStore = (database: Database): WorkerStore => ({
  async createDeviceCode(input, now) {
    return database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${WORKER_DEVICE_CODE_LOCK})`);
      const { rows } = await tx.execute<{ address: number; instance: number }>(sql`
        select count(*) filter (where client_address = ${input.clientAddress})::int as address,
               count(*)::int as instance
          from worker_device_codes
         where approved_at is null and denied_at is null and expires_at > ${now}`);
      const limit = deviceCodeLimitExceeded(rows[0]?.address ?? 0, rows[0]?.instance ?? 0);
      if (limit !== null) {
        return { status: 'limited', limit } as const;
      }
      const inserted = await tx.execute<{ id: string }>(sql`
        insert into worker_device_codes
          (id, device_code_hash, user_code_hash, client_address, user_agent, created_at, expires_at,
           interval_seconds)
        values (${input.id}, ${input.deviceCodeHash}, ${input.userCodeHash}, ${input.clientAddress},
                ${input.userAgent}, ${input.createdAt}, ${input.expiresAt}, ${input.intervalSeconds})
        on conflict do nothing
        returning id`);
      return inserted.rows.length === 1
        ? ({ status: 'created' } as const)
        : { status: 'collision' };
    });
  },

  async pollDeviceCode({ deviceCodeHash, now, mint }) {
    return database.transaction(async (tx): Promise<DevicePollResult> => {
      const { rows } = await tx.execute<DeviceCodeRowSql>(sql`
        select * from worker_device_codes where device_code_hash = ${deviceCodeHash} for update`);
      const row = rows[0];
      if (row === undefined) {
        return { outcome: 'expired_token' };
      }
      const decision = decideDevicePoll(stateOf(row), now.getTime());
      if (decision.outcome === 'expired_token') {
        return decision;
      }
      await tx.execute(sql`
        update worker_device_codes
           set last_polled_at = ${now},
               interval_seconds = ${decision.outcome === 'slow_down' ? decision.intervalSeconds : row.interval_seconds}
         where id = ${row.id}`);
      if (decision.outcome !== 'issue') {
        return decision;
      }
      // The approver must still be able to act when the credential is collected (TD-031 §10c).
      const approver = await tx.execute<{ may_act: boolean }>(sql`
        select ${USER_MAY_ACT} as may_act from users u where u.id = ${row.approved_by}`);
      if (approver.rows[0]?.may_act !== true) {
        return { outcome: 'access_denied' };
      }
      await tx.execute(sql`
        insert into workers (id, user_id, name, credential_hash, created_at)
        values (${mint.workerId}, ${row.approved_by}, ${row.worker_name}, ${mint.credentialHash}, ${now})`);
      await tx.execute(sql`
        update worker_device_codes set consumed_at = ${now}, worker_id = ${mint.workerId}
         where id = ${row.id}`);
      return { outcome: 'issued', workerId: mint.workerId };
    });
  },

  async findPendingDeviceCode(userCodeHash, now) {
    const { rows } = await database.execute<DeviceCodeRowSql>(sql`
      select * from worker_device_codes
       where user_code_hash = ${userCodeHash}
         and approved_at is null and denied_at is null and expires_at > ${now}`);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      clientAddress: row.client_address,
      userAgent: row.user_agent,
      createdAt: at(row.created_at) as Date,
      expiresAt: at(row.expires_at) as Date,
    };
  },

  async decideDeviceCode(input) {
    return database.transaction(async (tx): Promise<DeviceDecisionResult> => {
      const { rows } = await tx.execute<DeviceCodeRowSql>(sql`
        select * from worker_device_codes where user_code_hash = ${input.userCodeHash} for update`);
      const row = rows[0];
      if (row === undefined) {
        return { status: 'not_found' };
      }
      const repeated = repeatedDeviceDecision(
        {
          approvedAt: ms(row.approved_at),
          approvedBy: row.approved_by,
          workerName: row.worker_name,
          deniedAt: ms(row.denied_at),
          deniedBy: row.denied_by,
        },
        { decision: input.decision, actorUserId: input.actorUserId, name: input.name },
      );
      if (repeated !== null) {
        return { status: 'decided', decidedAt: new Date(repeated), performed: false };
      }
      const state = stateOf(row);
      const check = checkDeviceDecision(
        state,
        input.now.getTime(),
        input.decision,
        input.confirmedStale,
      );
      if (check !== 'ok') {
        return { status: check };
      }
      if (input.decision === 'approve') {
        await tx.execute(sql`
          update worker_device_codes
             set approved_at = ${input.now}, approved_by = ${input.actorUserId}, worker_name = ${input.name}
           where id = ${row.id}`);
      } else {
        await tx.execute(sql`
          update worker_device_codes set denied_at = ${input.now}, denied_by = ${input.actorUserId}
           where id = ${row.id}`);
      }
      const params: JsonObject = {
        ...input.auditParams,
        device_code_id: row.id,
        decision: input.decision,
        requested_ip: row.client_address,
        code_age_seconds: Math.max(0, Math.floor((input.now.getTime() - state.createdAt) / 1000)),
        stale_confirmed:
          input.decision === 'approve' && isDeviceCodeStale(state, input.now.getTime()),
        ...(input.name === null ? {} : { worker_name: input.name }),
      };
      await tx.execute(sql`
        insert into human_actions (user_id, action, params)
        values (${input.actorUserId}, ${`worker.device.${input.decision}`}, ${JSON.stringify(params)}::jsonb)`);
      return { status: 'decided', decidedAt: input.now, performed: true };
    });
  },

  async listWorkers(userId) {
    const { rows } = await database.execute<WorkerRowSql>(sql`
      select w.*, u.email, u.name as user_name
        from workers w join users u on u.id = w.user_id
       where ${userId === null ? sql`true` : sql`w.user_id = ${userId}`}
       order by w.created_at desc, w.id desc`);
    return rows.map(toWorkerListRow);
  },

  async revokeWorker({ workerId, ownerUserId, actorUserId, now }) {
    return database.transaction(async (tx): Promise<RevokeWorkerResult> => {
      const { rows } = await tx.execute<{ user_id: string; revoked_at: Date | null }>(sql`
        select user_id, revoked_at from workers where id = ${workerId} for update`);
      const row = rows[0];
      // Somebody else's worker reads as absent to a non-administrator: its existence is not theirs.
      if (row === undefined || (ownerUserId !== null && row.user_id !== ownerUserId)) {
        return { status: 'not_found' };
      }
      if (row.revoked_at !== null) {
        return {
          status: 'revoked',
          performed: false,
          revokedAt: at(row.revoked_at) as Date,
          expiredRuns: 0,
        };
      }
      await tx.execute(sql`
        update workers set revoked_at = ${now}, state = 'revoked' where id = ${workerId}`);
      const expired = await tx.execute<{ id: string }>(expireLeasesSql(sql`${workerId}::uuid`));
      const params: JsonObject = {
        worker_id: workerId,
        owner_user_id: row.user_id,
        expired_runs: expired.rows.length,
      };
      await tx.execute(sql`
        insert into human_actions (user_id, action, params)
        values (${actorUserId}, 'worker.revoke', ${JSON.stringify(params)}::jsonb)`);
      return {
        status: 'revoked',
        performed: true,
        revokedAt: now,
        expiredRuns: expired.rows.length,
      };
    });
  },

  async expireUserWorkerLeases(userId) {
    const { rows } = await database.execute<{ id: string }>(
      expireLeasesSql(sql`select id from workers where user_id = ${userId}`),
    );
    return rows.length;
  },

  async recordContact({ workerId, protocolVersion, imageDigests }) {
    const updated = await database.execute<{ id: string }>(sql`
      update workers
         set last_seen_at = now(), protocol_version = ${protocolVersion},
             image_digests = coalesce(${imageDigests === null ? null : JSON.stringify(imageDigests)}::jsonb,
                                      image_digests)
       where id = ${workerId}
      returning id`);
    if (updated.rows.length === 0) {
      return null;
    }
    const { rows } = await database.execute<WorkerRowSql>(sql`
      select w.*, u.email, u.name as user_name
        from workers w join users u on u.id = w.user_id
       where w.id = ${workerId}`);
    const row = rows[0];
    return row === undefined ? null : toWorkerListRow(row);
  },

  async countConnected() {
    const { rows } = await database.execute<{ connected: number; paused: number }>(sql`
      select count(*)::int as connected,
             count(*) filter (where paused_until > now())::int as paused
        from workers
       where state = 'active'
         and last_seen_at > now() - make_interval(secs => ${WORKER_CONNECTED_SECONDS})`);
    return { connected: Number(rows[0]?.connected ?? 0), paused: Number(rows[0]?.paused ?? 0) };
  },

  async findCredentialSubject(workerId) {
    const { rows } = await database.execute<{
      id: string;
      user_id: string;
      credential_hash: string;
      usable: boolean;
    }>(sql`
      select w.id, w.user_id, w.credential_hash,
             (w.revoked_at is null and ${USER_MAY_ACT}) as usable
        from workers w join users u on u.id = w.user_id
       where w.id = ${workerId}`);
    const row = rows[0];
    return row === undefined
      ? null
      : {
          workerId: row.id,
          userId: row.user_id,
          credentialHash: row.credential_hash,
          usable: row.usable,
        };
  },
});
