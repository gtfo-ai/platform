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
import { resolveBudgetTimezone } from '@platform/application';
import {
  type CoreImageDigests,
  type JsonObject,
  PROJECT_EXECUTION_WORKERS_MAX,
  WORKER_SCOPE_PROJECTS_MAX,
  type WorkerClaimPolicy,
  type WorkerManualPauseVia,
  type WorkerUpdateResult,
  type WorkspaceUnavailableCause,
  workspaceUnavailableCauseSchema,
} from '@platform/contracts';
import {
  checkDeviceDecision,
  DEFAULT_EXECUTION_MODE,
  type DeviceCodeState,
  type DevicePollDecision,
  decideDevicePoll,
  deviceCodeLimitExceeded,
  effectiveClaimPolicy,
  isDeviceCodeStale,
  NEW_WORKER_CLAIM_POLICY,
  type RunImageDigests,
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
  /** The pause is the default, the limit named no reset (migration 0100, WP-285): *until about*. */
  readonly pausedUntilEstimated: boolean;
  /** The owner's hold from the worker's local page (migration 0099, WP-292). */
  readonly manuallyPausedAt: Date | null;
  /**
   * The claim scope (migration 0101, WP-293): `null` every project, `[]` pick only, otherwise those
   * projects with their keys — `null` for a project that no longer exists.
   */
  readonly claimProjects: readonly { readonly id: string; readonly key: string | null }[] | null;
  /**
   * The claim policy as it reads (migration 0108, S-26.4): the stored value, or what a `null`
   * reads as (`effectiveClaimPolicy`: `pick_only` over a legacy `[]` scope, else `everything`).
   */
  readonly claimPolicy: WorkerClaimPolicy;
  /**
   * S-28.12 (migration 0117): the machine could not provision a run's workspace, from its `release
   * provision_failed` until its next claim; `null` while it can. Absent where a read does not ask.
   */
  readonly workspaceUnavailable?: {
    readonly cause: WorkspaceUnavailableCause;
    readonly detail: string | null;
    readonly since: Date;
  } | null;
  /**
   * Open offers its eligibility and scope admit now and its policy refuses (S-26.4) — read by
   * {@link WorkerStore.listWorkers} only, against the core's digests; `null` when they were not
   * given (the core cannot name its images) or the read does not count them.
   */
  readonly policySkippedOffers?: number | null;
  readonly concurrency: number;
  /**
   * The live runs (`created`/`starting`/`running`) this worker **holds**, oldest first (S-23.15):
   * `runs.worker_id` names it — the column revocation expires — or the run's claimed offer does
   * (`run_offers.worker_id`, which wins when both are set). The agents list's seat
   * (`live-view-queries.ts`'s `seatOf`) reads the same two columns the same way, so a run sits at
   * a worker's seat there exactly when it is in that worker's `running` here.
   */
  readonly running: readonly WorkerRunRef[];
  /**
   * The last update its updater reported (WP-287 (4)) — read by {@link WorkerStore.listWorkers}
   * only; absent on the row a worker call's contact answers, which is asked on every heartbeat.
   */
  readonly lastUpdate?: WorkerUpdateRecord | null;
  /**
   * What the core knows about whether it can claim (S-22.19) — read by {@link WorkerStore.listWorkers}
   * only, like {@link lastUpdate}; `domain`'s `coreClaimBlockersOf` turns it into blockers.
   */
  readonly claimFacts?: WorkerClaimRowFacts;
}

/** The row half of a worker's claim blockers (S-22.19), each on the database's clock. */
export interface WorkerClaimRowFacts {
  /** Seen within {@link WORKER_CONNECTED_SECONDS}. */
  readonly online: boolean;
  /** `paused_until` still ahead (a usage limit). */
  readonly usagePaused: boolean;
  /** Its user may act — not disabled, under no ban in force (`USER_MAY_ACT_SQL`, the claim's). */
  readonly ownerMayAct: boolean;
  /**
   * The owner's hold (`manually_paused_at`), told apart by the newest `worker.pause` row's `via`:
   * `draining` for `worker_ui_drain`/`worker_internal_drain`, `paused` otherwise; `null` for none.
   */
  readonly hold: 'paused' | 'draining' | null;
  /**
   * Projects that would give it work: its user may run there (the effective role), the project's
   * mode is not `server_only`, its run credential may reach a worker, and the claim scope names it —
   * `null` (every project) and `[]` (*pick only*, whose picks ignore the scope) count every project.
   * `null` when not asked (a project's execution read asks its own question).
   */
  readonly eligibleProjects: number | null;
  /** Its newest claim (`run_offers.claimed_at`), or `null`. */
  readonly lastClaimedAt: Date | null;
}

/** The most workers a project's execution read lists (`projectExecutionResponseSchema.workers`). */
export const PROJECT_WORKERS_MAX = PROJECT_EXECUTION_WORKERS_MAX;

/** A listed worker, and whether its user may run in the project asked about (S-22.19). */
export interface ProjectWorkerRow extends WorkerListRow {
  readonly mayRunInProject: boolean;
}

/** The `via` of a hold that is a drain's (TD-031's 2026-11-05 amendment, decision 3). */
export const DRAIN_VIAS: readonly WorkerManualPauseVia[] = [
  'worker_ui_drain',
  'worker_internal_drain',
];

/** A worker's update report as recorded (`human_actions`, action `worker.update`). */
export interface WorkerUpdateRecord {
  readonly result: WorkerUpdateResult;
  readonly from: CoreImageDigests;
  readonly to: CoreImageDigests;
  readonly detail: string | null;
  readonly reportedAt: Date;
}

/** One live run a worker holds, as `GET /api/workers` lists it (S-23.15). */
export interface WorkerRunRef {
  readonly runId: string;
  readonly taskId: string;
  readonly projectId: string;
}

/** What {@link WorkerStore.setManualPause} answers: the stored hold, and whether this call wrote it. */
export type ManualPauseResult =
  | { readonly status: 'not_found' }
  | {
      readonly status: 'set';
      readonly manuallyPausedAt: Date | null;
      /** `false`: the row already said so — nothing written, no audit row. */
      readonly performed: boolean;
    };

/** A project a worker's scope may name: one where its user's effective role is `member`+ now. */
export interface ScopeProject {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

/** What {@link WorkerStore.claimScope} answers. */
export type ClaimScopeRead =
  | { readonly status: 'not_found' }
  | {
      readonly status: 'found';
      readonly claimProjectIds: readonly string[] | null;
      readonly projects: readonly ScopeProject[];
      /** The policy as it reads (S-26.4). */
      readonly claimPolicy: WorkerClaimPolicy;
      /** {@link WorkerListRow.policySkippedOffers}: `null` without the core's digests. */
      readonly policySkippedOffers: number | null;
    };

/** What {@link WorkerStore.setClaimScope} and {@link WorkerStore.setClaimPolicy} answer. */
export type ClaimScopeResult =
  | { readonly status: 'not_found' }
  /**
   * `setClaimPolicy` only: the worker is not the caller's, and the caller may see it (an
   * administrator, `403`); nothing written.
   */
  | { readonly status: 'not_owner' }
  /** `[]`: *pick only* is the policy `pick_only` since S-26.4 (`422`); nothing written. */
  | { readonly status: 'empty_scope' }
  /** Ids that are not a project where the user is `member`+ now (`422`); nothing written. */
  | { readonly status: 'invalid'; readonly projectIds: readonly string[] }
  | {
      readonly status: 'set';
      /** Distinct and sorted, as stored. */
      readonly claimProjectIds: readonly string[] | null;
      /** The policy as stored now, or as a `null` reads (S-26.4). */
      readonly claimPolicy: WorkerClaimPolicy;
      /** `false`: the row already held this scope (as a set) and policy — nothing written, no audit row. */
      readonly performed: boolean;
    };

/** Who wrote a claim policy — the audit row's `via`. */
export type ClaimPolicyVia = 'worker_ui' | 'workers_screen';

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
  /**
   * Every worker when `userId` is `null`; the user's own otherwise. Newest first. With the core's
   * run and egress digests, each row counts its `policySkippedOffers` (S-26.4); without, `null`.
   */
  listWorkers(
    userId: string | null,
    coreDigests?: RunImageDigests | null,
    /** S-28.6: only this worker's row — the idle read of one machine's `GET offers`. */
    workerId?: string,
  ): Promise<WorkerListRow[]>;
  /**
   * {@link listWorkers}' rows — **not revoked** — with whether each worker's user may run in
   * `projectId` now (the claim's effective-role predicate): a project's execution read (S-22.19).
   */
  listWorkersForProject(projectId: string, userId: string | null): Promise<ProjectWorkerRow[]>;
  revokeWorker(input: {
    readonly workerId: string;
    /** `null` for an administrator, who may revoke any worker; a user id restricts to that user's. */
    readonly ownerUserId: string | null;
    readonly actorUserId: string;
    readonly now: Date;
  }): Promise<RevokeWorkerResult>;
  /**
   * The owner's hold on claiming (WP-292, TD-031's worker-UI amendment §4) — a **state assertion**:
   * `paused` sets `manually_paused_at` (kept when already set) and `!paused` clears it, with **one**
   * `human_actions` row per change (`worker.pause` / `worker.resume`, `params: {worker_id, via:
   * 'worker_ui'}`, the worker's user). A repeat of the stored state writes nothing.
   */
  setManualPause(input: {
    readonly workerId: string;
    readonly paused: boolean;
    /** Who asked — the audit row's `via` (TD-031's 2026-11-05 amendment, decision 3). */
    readonly via: WorkerManualPauseVia;
    readonly now: Date;
  }): Promise<ManualPauseResult>;
  /**
   * The worker's claim scope and the projects it may name — those where its user's **effective**
   * role is `member` or above now (`running-role.ts`, the claim's own predicate), by key, at most
   * {@link WORKER_SCOPE_PROJECTS_MAX} (WP-293).
   */
  claimScope(workerId: string, coreDigests?: RunImageDigests | null): Promise<ClaimScopeRead>;
  /**
   * The owner's claim scope (WP-293, TD-031's claim-scope amendment §2) — a **state assertion**
   * from the worker's own page: `null` every project, otherwise those projects (stored distinct and
   * sorted), and since S-26.4 the claim policy (`policy`; absent leaves it as it was). `[]` is
   * `empty_scope` (the route maps a version-3 worker's `[]` to `pick_only` over every project before
   * it asks), an id that is not a project where the user is `member`+ now `invalid`; nothing is
   * written for either. **One** `human_actions` row per change under the worker's user —
   * `worker.claim_policy` `{worker_id, claim_policy, project_ids, via: 'worker_ui'}` when the policy
   * moved, else `worker.claim_scope` `{worker_id, project_ids, via: 'worker_ui'}`; a repeat of the
   * stored pair (the scope as a set, the policy as it reads) writes nothing.
   */
  setClaimScope(input: {
    readonly workerId: string;
    readonly projectIds: readonly string[] | null;
    readonly policy?: WorkerClaimPolicy;
  }): Promise<ClaimScopeResult>;
  /**
   * `PUT /api/workers/:id/claim-policy` (S-26.4, TD-031's 2026-11-06 amendment item 6) — the same
   * state assertion of both of the card's controls, from a **session**: only the worker's own user
   * may write it. Somebody else's worker is `not_found` to a non-administrator and `not_owner` to
   * an administrator (`canSeeAll`), who reads it and may not change it. One `human_actions` row
   * `worker.claim_policy` `{worker_id, claim_policy, project_ids, via: 'workers_screen'}` per change.
   */
  setClaimPolicy(input: {
    readonly workerId: string;
    readonly actorUserId: string;
    readonly canSeeAll: boolean;
    readonly projectIds: readonly string[] | null;
    readonly policy: WorkerClaimPolicy;
  }): Promise<ClaimScopeResult>;
  /**
   * What `GET offers` says beside its list (S-26.4): the open offers the worker's eligibility and
   * scope admit now and its policy refuses, against the core's digests. `null` for no such worker.
   */
  policySkippedOffers(workerId: string, coreDigests: RunImageDigests): Promise<number | null>;
  /**
   * S-28.12: records why the machine cannot provision a workspace (its `release provision_failed`),
   * or clears it (`null`, its next claim) — a write only when something changes.
   */
  setWorkspaceUnavailable(input: {
    readonly workerId: string;
    readonly value: {
      readonly cause: WorkspaceUnavailableCause;
      readonly detail: string | null;
      readonly at: Date;
    } | null;
  }): Promise<void>;
  /**
   * **A usage limit's pause** (`POST pause`, WP-285, TD-031 decision 11): `paused_until`,
   * `paused_reason = 'usage_limited'` and whether the instant is the default pause. A repeat stores
   * the same; nothing else on the row moves — never `manually_paused_at`, a person's hold, which
   * the limit's end does not clear. No `human_actions` row: no person decided it. `false` for no
   * such worker.
   */
  setUsagePause(input: {
    readonly workerId: string;
    readonly until: Date;
    readonly estimated: boolean;
  }): Promise<boolean>;
  /**
   * A worker's update report (`POST update-report`, WP-287 (4)): one `human_actions` row,
   * `worker.update`, under the worker's user — the shape the worker's pause and drain are audited in
   * (`worker.pause` with `via: worker_internal_drain` is the updater's too) — with `params: {worker_id,
   * result, from, to, detail}`. Append-only, so every report is kept; the Workers screen reads the
   * newest. `not_found` for no such worker.
   */
  recordUpdateReport(input: {
    readonly workerId: string;
    readonly report: Omit<WorkerUpdateRecord, 'reportedAt'>;
    readonly now: Date;
  }): Promise<'recorded' | 'not_found'>;
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
  /**
   * The organisation's timezone as every read of it resolves it (`resolveBudgetTimezone`: `UTC`
   * for none, or for one this server cannot use) — what a usage pause's *until HH:MM* is shown in
   * (WP-285).
   */
  organisationTimezone(): Promise<string>;
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

/**
 * The user `q.uid` may take a run of the project `p` — the claim's own predicate (`running-role.ts`,
 * the effective role at `member` or above), so the chooser offers exactly what the claim can admit.
 * The statement binds the user as `(select $1::uuid as uid) q`; the predicate inlines only a closed
 * set of role literals and the two column names given here.
 */
const MAY_RUN_IN_P = sql.raw(pipelineAdapters.userMayRunInProjectSql('q.uid', 'p.id'));

/**
 * **Open offers a worker's policy leaves for others** (S-26.4) — the claim's own fragments
 * (`policySkippedOffersSql`), over a lateral of the listed row (`wk`: its id and the digests it
 * holds) and the core's digests (`cd`), never over `w` itself, which the eligibility's own `workers
 * w` shadows. Only the alias names are inlined; the digests are bound parameters.
 */
const POLICY_SKIPPED = sql.raw(
  pipelineAdapters.policySkippedOffersSql({
    worker: 'wk.wid',
    held: 'wk.held',
    run: 'cd.run',
    egress: 'cd.egress',
  }),
);
const policySkippedJoins = (digests: RunImageDigests) => sql`
  cross join lateral (select w.id as wid,
                             array(select jsonb_array_elements_text(w.image_digests)) as held) wk
  cross join (select ${digests.run}::text as run, ${digests.egress}::text as egress) cd`;

/** A scope as stored: distinct and sorted, so a repeat is recognised as a set (WP-293). */
export const normaliseScope = (ids: readonly string[] | null): string[] | null =>
  ids === null ? null : [...new Set(ids.map((id) => id.toLowerCase()))].sort();

const sameScope = (a: readonly string[] | null, b: readonly string[] | null): boolean =>
  a === null || b === null
    ? a === b
    : a.length === b.length && a.every((id, index) => id === b[index]);

/** The revocation's one write to `runs` (TD-031 §7): the live runs' lease expires now, nothing else. */
const expireLeasesSql = (workerFilter: ReturnType<typeof sql>) => sql`
  update runs set lease_expires_at = now()
   where worker_id in (${workerFilter})
     and status in ('created', 'starting', 'running')
  returning id`;

/** A `workers` row joined with its user, as {@link WorkerStore.listWorkers} reads it. */
type WorkerRowSql = {
  claim_projects: { id: string; key: string | null }[] | null;
  claim_project_ids: string[] | null;
  claim_policy: WorkerClaimPolicy | null;
  /** Present only where the statement counted it (`listWorkers` with the core's digests). */
  policy_skipped_offers?: number | null;
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
  paused_until_estimated: boolean;
  manually_paused_at: Date | null;
  workspace_unavailable_at?: Date | null;
  workspace_unavailable_cause?: string | null;
  workspace_unavailable_detail?: string | null;
  concurrency: number;
  running: { run_id: string; task_id: string; project_id: string }[];
};

/**
 * The live runs a worker holds (S-23.15), as a `running` column of a `workers w` select: its claim
 * (`runs.worker_id`, which the claim writes and a release clears) or its claimed offer's
 * `run_offers.worker_id` — the same reading the agents list's seat makes (`seatOf`). A released
 * run (offer back to `open`, `runs.worker_id` null) is no longer the worker's.
 */
const RUNNING_OF_WORKER = sql`coalesce((
    select json_agg(json_build_object('run_id', r.id, 'task_id', r.task_id,
                                      'project_id', r.project_id) order by r.created_at, r.id)
      from runs r
      left join run_offers o on o.run_id = r.id
     where r.status in ('created', 'starting', 'running')
       and coalesce(o.worker_id, r.worker_id) = w.id
       and (r.worker_id is not null
            or (o.state = 'claimed' and o.claimant_kind = 'worker' and o.worker_id is not null))
  ), '[]'::json) as running,
  case when w.claim_project_ids is null then null
       else coalesce((
         select json_agg(json_build_object('id', x.id, 'key', p.key) order by x.ord)
           from unnest(w.claim_project_ids) with ordinality as x(id, ord)
           left join projects p on p.id = x.id
       ), '[]'::json) end as claim_projects`;

const MAY_RUN_IN_LISTED = sql.raw(pipelineAdapters.userMayRunInProjectSql('w.user_id', 'p.id'));
const CREDENTIAL_REFUSED_P = sql.raw(pipelineAdapters.remoteRunCredentialRefusedSql('p.id'));

/**
 * A listed worker's claim facts (S-22.19), as columns of a `workers w` select — {@link WorkerClaimRowFacts}.
 * The hold's `via` is the newest `worker.pause` row's (one per performed pause); a hold with no row
 * (a seed, or a row the audit lost) reads as the owner's pause. The project count asks the claim's
 * own predicates (`userMayRunInProjectSql`, `remoteRunCredentialRefusedSql`) per project.
 */
const CLAIM_FACTS_OF_WORKER_ROW = sql`
  (w.last_seen_at is not null
     and w.last_seen_at > now() - make_interval(secs => ${WORKER_CONNECTED_SECONDS})) as online,
  ${USER_MAY_ACT} as owner_may_act,
  (w.paused_until is not null and w.paused_until > now()) as usage_paused,
  case when w.manually_paused_at is null then null
       else (select h.params ->> 'via'
               from human_actions h
              where h.action = 'worker.pause' and h.params ->> 'worker_id' = w.id::text
              order by h.created_at desc, h.id desc
              limit 1) end as hold_via,
  (select max(o.claimed_at) from run_offers o where o.worker_id = w.id) as last_claimed_at`;

/** {@link CLAIM_FACTS_OF_WORKER_ROW} and the count of projects that would give it work. */
const CLAIM_FACTS_OF_WORKER = sql`${CLAIM_FACTS_OF_WORKER_ROW},
  (select count(*)::int
     from projects p
     left join project_execution_settings s on s.project_id = p.id
    where coalesce(s.mode, ${DEFAULT_EXECUTION_MODE}) <> 'server_only'
      and (w.claim_project_ids is null or cardinality(w.claim_project_ids) = 0
           or p.id = any(w.claim_project_ids))
      and ${MAY_RUN_IN_LISTED}
      and not ${CREDENTIAL_REFUSED_P}) as eligible_projects`;

type ClaimFactsSql = {
  online: boolean;
  owner_may_act: boolean;
  usage_paused: boolean;
  hold_via: string | null;
  last_claimed_at: Date | string | null;
  /** Absent from a project's read, which asks its own question. */
  eligible_projects?: number;
};

/** A hold's `via` → the vocabulary's hold. */
export const holdOf = (
  manuallyPaused: boolean,
  via: string | null,
): 'paused' | 'draining' | null =>
  !manuallyPaused
    ? null
    : (DRAIN_VIAS as readonly string[]).includes(via ?? '')
      ? 'draining'
      : 'paused';

const toClaimFacts = (row: WorkerRowSql & ClaimFactsSql): WorkerClaimRowFacts => ({
  online: row.online === true,
  usagePaused: row.usage_paused === true,
  ownerMayAct: row.owner_may_act === true,
  hold: holdOf(row.manually_paused_at !== null, row.hold_via),
  eligibleProjects: row.eligible_projects === undefined ? null : Number(row.eligible_projects),
  lastClaimedAt: at(row.last_claimed_at),
});

/**
 * The newest `worker.update` row per worker, for the listed workers: one pass over `human_actions`
 * filtered on the action (it has no index on it — the Workers screen is read by a person, rarely;
 * BACKLOG notes the index a larger installation would want).
 */
const LAST_UPDATES_SQL = (workerIds: readonly string[]) => sql`
  select distinct on (params->>'worker_id')
         params->>'worker_id' as worker_id, params, created_at
    from human_actions
   where action = 'worker.update'
     and params->>'worker_id' = any(${`{${workerIds.join(',')}}`}::text[])
   order by params->>'worker_id', created_at desc, id desc`;

const toUpdateRecord = (params: unknown, createdAt: Date | string): WorkerUpdateRecord | null => {
  const value = params as Record<string, unknown> | null;
  if (value === null || typeof value !== 'object') return null;
  return {
    result: value.result as WorkerUpdateResult,
    from: value.from as CoreImageDigests,
    to: value.to as CoreImageDigests,
    detail: typeof value.detail === 'string' ? value.detail : null,
    reportedAt: at(createdAt) as Date,
  };
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
  pausedUntilEstimated: row.paused_until_estimated === true,
  manuallyPausedAt: at(row.manually_paused_at),
  claimProjects:
    row.claim_projects === null
      ? null
      : row.claim_projects.map((project) => ({ id: project.id, key: project.key })),
  claimPolicy: effectiveClaimPolicy(row.claim_policy, row.claim_project_ids),
  // S-28.12: a cause this build does not know reads as `unknown`, never as no block.
  workspaceUnavailable:
    row.workspace_unavailable_at === null || row.workspace_unavailable_at === undefined
      ? null
      : {
          cause:
            workspaceUnavailableCauseSchema.safeParse(row.workspace_unavailable_cause).data ??
            'unknown',
          detail: row.workspace_unavailable_detail ?? null,
          since: at(row.workspace_unavailable_at) as Date,
        },
  ...(row.policy_skipped_offers === undefined
    ? {}
    : {
        policySkippedOffers:
          row.policy_skipped_offers === null ? null : Number(row.policy_skipped_offers),
      }),
  concurrency: row.concurrency,
  running: row.running.map((run) => ({
    runId: run.run_id,
    taskId: run.task_id,
    projectId: run.project_id,
  })),
});

type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** {@link POLICY_SKIPPED} for one worker; `null` for no such worker. */
const countPolicySkipped = async (
  database: Database,
  workerId: string,
  coreDigests: RunImageDigests,
): Promise<number | null> => {
  const { rows } = await database.execute<{ skipped: number }>(sql`
    select ${POLICY_SKIPPED} as skipped
      from workers w ${policySkippedJoins(coreDigests)}
     where w.id = ${workerId}`);
  const row = rows[0];
  return row === undefined ? null : Number(row.skipped);
};

/**
 * **The one writer of a worker's claim settings** (WP-293; S-26.4) — both `setClaimScope` (the
 * worker's page) and `setClaimPolicy` (a session): the row locked, the owner checked when a session
 * asks, `[]` refused, the projects asked of the claim's own role predicate, and a repeat of the
 * stored pair — the scope as a set (a legacy `'{}'` reading as every project), the policy as it
 * reads — writing nothing. One audit row per change: `worker.claim_policy` when the policy moved or
 * a session wrote, `worker.claim_scope` (its WP-293 shape) when only the projects did.
 */
const writeClaimSettings = async (
  tx: DatabaseTransaction,
  input: {
    readonly workerId: string;
    readonly owner: { readonly userId: string; readonly canSeeAll: boolean } | null;
    readonly projectIds: readonly string[] | null;
    readonly policy?: WorkerClaimPolicy;
    readonly via: ClaimPolicyVia;
  },
): Promise<ClaimScopeResult> => {
  const { rows } = await tx.execute<{
    user_id: string;
    claim_project_ids: string[] | null;
    claim_policy: WorkerClaimPolicy | null;
  }>(sql`select user_id, claim_project_ids, claim_policy
           from workers where id = ${input.workerId} for update`);
  const row = rows[0];
  if (row === undefined) {
    return { status: 'not_found' };
  }
  if (input.owner !== null && row.user_id !== input.owner.userId) {
    // Somebody else's worker: absent to whoever may not see it, refused to an administrator.
    return { status: input.owner.canSeeAll ? 'not_owner' : 'not_found' };
  }
  const next = normaliseScope(input.projectIds);
  if (next !== null && next.length === 0) {
    return { status: 'empty_scope' };
  }
  if (next !== null) {
    const admitted = await tx.execute<{ id: string }>(sql`
      select p.id from projects p cross join (select ${row.user_id}::uuid as uid) q
       where p.id = any(${`{${next.join(',')}}`}::uuid[])
         and ${MAY_RUN_IN_P}`);
    const known = new Set(admitted.rows.map((project) => project.id));
    const invalid = next.filter((id) => !known.has(id));
    if (invalid.length > 0) {
      return { status: 'invalid', projectIds: invalid };
    }
  }
  const before = effectiveClaimPolicy(row.claim_policy, row.claim_project_ids);
  const storedPolicy = input.policy ?? row.claim_policy;
  const after = effectiveClaimPolicy(storedPolicy, next);
  const storedList = normaliseScope(row.claim_project_ids);
  const sameList = sameScope(
    storedList !== null && storedList.length === 0 ? null : storedList,
    next,
  );
  if (sameList && before === after) {
    return { status: 'set', claimProjectIds: next, claimPolicy: after, performed: false };
  }
  await tx.execute(sql`
    update workers
       set claim_project_ids = ${next === null ? null : `{${next.join(',')}}`}::uuid[],
           claim_policy = ${storedPolicy}
     where id = ${input.workerId}`);
  const policyAudit = before !== after || input.via === 'workers_screen';
  const params: JsonObject = policyAudit
    ? { worker_id: input.workerId, claim_policy: after, project_ids: next, via: input.via }
    : { worker_id: input.workerId, project_ids: next, via: input.via };
  await tx.execute(sql`
    insert into human_actions (user_id, action, params)
    values (${row.user_id}, ${policyAudit ? 'worker.claim_policy' : 'worker.claim_scope'},
            ${JSON.stringify(params)}::jsonb)`);
  return { status: 'set', claimProjectIds: next, claimPolicy: after, performed: true };
};

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
      // S-26.4: a new worker takes its owner's tasks and unassigned ones (TD-031's 2026-11-06
      // amendment item 6) — the one writer that names the policy at the insert.
      await tx.execute(sql`
        insert into workers (id, user_id, name, credential_hash, created_at, claim_policy)
        values (${mint.workerId}, ${row.approved_by}, ${row.worker_name}, ${mint.credentialHash}, ${now},
                ${NEW_WORKER_CLAIM_POLICY})`);
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

  async listWorkers(userId, coreDigests = null, workerId) {
    const counted = coreDigests ?? null;
    const { rows } = await database.execute<WorkerRowSql & ClaimFactsSql>(sql`
      select w.*, u.email, u.name as user_name, ${RUNNING_OF_WORKER}, ${CLAIM_FACTS_OF_WORKER},
             ${counted === null ? sql`null::int` : POLICY_SKIPPED} as policy_skipped_offers
        from workers w join users u on u.id = w.user_id
        ${counted === null ? sql`` : policySkippedJoins(counted)}
       where ${userId === null ? sql`true` : sql`w.user_id = ${userId}`}
         and ${workerId === undefined ? sql`true` : sql`w.id = ${workerId}`}
       order by w.created_at desc, w.id desc`);
    const listed = rows.map((row) => ({ ...toWorkerListRow(row), claimFacts: toClaimFacts(row) }));
    if (listed.length === 0) return listed;
    const updates = await database.execute<{
      worker_id: string;
      params: unknown;
      created_at: Date;
    }>(LAST_UPDATES_SQL(listed.map((row) => row.id)));
    const byWorker = new Map(
      updates.rows.map((update) => [
        update.worker_id,
        toUpdateRecord(update.params, update.created_at),
      ]),
    );
    return listed.map((row) => ({ ...row, lastUpdate: byWorker.get(row.id) ?? null }));
  },

  async listWorkersForProject(projectId, userId) {
    const mayRun = sql.raw(pipelineAdapters.userMayRunInProjectSql('w.user_id', 'q.pid'));
    const { rows } = await database.execute<
      WorkerRowSql & ClaimFactsSql & { may_run_in_project: boolean }
    >(sql`
      select w.*, u.email, u.name as user_name, ${RUNNING_OF_WORKER}, ${CLAIM_FACTS_OF_WORKER_ROW},
             ${mayRun} as may_run_in_project
        from workers w
        join users u on u.id = w.user_id
       cross join (select ${projectId}::uuid as pid) q
       where w.revoked_at is null
         and ${userId === null ? sql`true` : sql`w.user_id = ${userId}`}
       order by w.created_at desc, w.id desc
       limit ${PROJECT_WORKERS_MAX}`);
    return rows.map((row) => ({
      ...toWorkerListRow(row),
      claimFacts: toClaimFacts(row),
      mayRunInProject: row.may_run_in_project === true,
    }));
  },

  async recordUpdateReport({ workerId, report, now }) {
    const { rows } = await database.execute<{ user_id: string }>(sql`
      select user_id from workers where id = ${workerId}`);
    const row = rows[0];
    if (row === undefined) return 'not_found';
    const params: JsonObject = {
      worker_id: workerId,
      result: report.result,
      from: { ...report.from },
      to: { ...report.to },
      detail: report.detail,
    };
    await database.execute(sql`
      insert into human_actions (user_id, action, params, created_at)
      values (${row.user_id}, 'worker.update', ${JSON.stringify(params)}::jsonb, ${now})`);
    return 'recorded';
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

  async setManualPause({ workerId, paused, via, now }) {
    return database.transaction(async (tx): Promise<ManualPauseResult> => {
      const { rows } = await tx.execute<{ user_id: string; manually_paused_at: Date | null }>(sql`
        select user_id, manually_paused_at from workers where id = ${workerId} for update`);
      const row = rows[0];
      if (row === undefined) {
        return { status: 'not_found' };
      }
      const stored = at(row.manually_paused_at);
      if ((stored !== null) === paused) {
        return { status: 'set', manuallyPausedAt: stored, performed: false };
      }
      const next = paused ? now : null;
      await tx.execute(sql`
        update workers set manually_paused_at = ${next} where id = ${workerId}`);
      const params: JsonObject = { worker_id: workerId, via };
      await tx.execute(sql`
        insert into human_actions (user_id, action, params)
        values (${row.user_id}, ${paused ? 'worker.pause' : 'worker.resume'}, ${JSON.stringify(params)}::jsonb)`);
      return { status: 'set', manuallyPausedAt: next, performed: true };
    });
  },

  async claimScope(workerId, coreDigests = null) {
    const { rows } = await database.execute<{
      user_id: string;
      claim_project_ids: string[] | null;
      claim_policy: WorkerClaimPolicy | null;
    }>(sql`select user_id, claim_project_ids, claim_policy from workers where id = ${workerId}`);
    const row = rows[0];
    if (row === undefined) {
      return { status: 'not_found' };
    }
    const skipped =
      coreDigests === null ? null : await countPolicySkipped(database, workerId, coreDigests);
    const projects = await database.execute<{ id: string; key: string; name: string }>(sql`
      select p.id, p.key, left(p.name, 200) as name
        from projects p cross join (select ${row.user_id}::uuid as uid) q
       where ${MAY_RUN_IN_P}
       order by p.key, p.id
       limit ${WORKER_SCOPE_PROJECTS_MAX}`);
    return {
      status: 'found',
      claimProjectIds: row.claim_project_ids === null ? null : [...row.claim_project_ids],
      projects: projects.rows.map((project) => ({
        id: project.id,
        key: project.key,
        name: project.name,
      })),
      claimPolicy: effectiveClaimPolicy(row.claim_policy, row.claim_project_ids),
      policySkippedOffers: skipped,
    };
  },

  async policySkippedOffers(workerId, coreDigests) {
    return countPolicySkipped(database, workerId, coreDigests);
  },

  async setClaimScope({ workerId, projectIds, policy }) {
    return database.transaction(async (tx) =>
      writeClaimSettings(tx, {
        workerId,
        owner: null,
        projectIds,
        ...(policy === undefined ? {} : { policy }),
        via: 'worker_ui',
      }),
    );
  },

  async setClaimPolicy({ workerId, actorUserId, canSeeAll, projectIds, policy }) {
    return database.transaction(async (tx) =>
      writeClaimSettings(tx, {
        workerId,
        owner: { userId: actorUserId, canSeeAll },
        projectIds,
        policy,
        via: 'workers_screen',
      }),
    );
  },

  async setWorkspaceUnavailable({ workerId, value }) {
    if (value === null) {
      await database.execute(sql`
        update workers
           set workspace_unavailable_at = null, workspace_unavailable_cause = null,
               workspace_unavailable_detail = null
         where id = ${workerId} and workspace_unavailable_at is not null`);
      return;
    }
    await database.execute(sql`
      update workers
         set workspace_unavailable_at = coalesce(workspace_unavailable_at, ${value.at}),
             workspace_unavailable_cause = ${value.cause},
             workspace_unavailable_detail = ${value.detail}
       where id = ${workerId}`);
  },

  async organisationTimezone() {
    const { rows } = await database.execute<{ timezone: string | null }>(sql`
      select timezone from organizations order by created_at limit 1`);
    return resolveBudgetTimezone(rows[0]?.timezone ?? null).timezone;
  },

  async setUsagePause({ workerId, until, estimated }) {
    const result = await database.execute(sql`
      update workers
         set paused_until = ${until}, paused_reason = 'usage_limited',
             paused_until_estimated = ${estimated}
       where id = ${workerId}`);
    return (result.rowCount ?? 0) > 0;
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
      select w.*, u.email, u.name as user_name, ${RUNNING_OF_WORKER}
        from workers w join users u on u.id = w.user_id
       where w.id = ${workerId}`);
    const row = rows[0];
    return row === undefined ? null : toWorkerListRow(row);
  },

  async countConnected() {
    const { rows } = await database.execute<{ connected: number; paused: number }>(sql`
      select count(*)::int as connected,
             count(*) filter (where paused_until > now() or manually_paused_at is not null)::int
               as paused
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
