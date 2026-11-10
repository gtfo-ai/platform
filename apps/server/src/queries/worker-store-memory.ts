/**
 * An in-memory {@link WorkerStore} for the route tests (WP-280).
 *
 * It asks the same domain decisions the Postgres store asks and is held to the same contract suite
 * (`test/contract/support/worker-store.ts`, run against it by the contract tier). **Divergences,
 * stated:** no transaction and no row lock — a JavaScript turn is atomic, so two polls cannot
 * interleave inside one call here, which is what the lock buys in PostgreSQL; `runs` is a map the
 * test seeds (`seedRun`) rather than a table — a seeded run is held through its `workerId` alone, with no offer, and
 * `listWorkers`' `running` lists it in seed order (PostgreSQL: by `created_at`) — and the users' ability to act is a set the test
 * flips (`setUserMayAct`, `banUser`) rather than `users.status`/`banned`, judged by the same
 * `userMayAct` the session hook uses. **The claim policy's offer count** (`policySkippedOffers`,
 * S-26.4) is a number the test seeds (`seedPolicySkippedOffers`) — this store has no offers — and
 * `null` when nothing was seeded or no core digests were given, as PostgreSQL answers without them.
 */
import type { ExecutionMode, JsonObject, RunStatus, WorkerClaimPolicy } from '@platform/contracts';
import {
  checkDeviceDecision,
  DEFAULT_EXECUTION_MODE,
  type DeviceCodeState,
  decideDevicePoll,
  deviceCodeLimitExceeded,
  effectiveClaimPolicy,
  isDeviceCodeStale,
  NEW_WORKER_CLAIM_POLICY,
  repeatedDeviceDecision,
} from '@platform/domain';
import { userMayAct } from './identity-queries.js';
import {
  type ClaimPolicyVia,
  type ClaimScopeResult,
  type CredentialSubject,
  holdOf,
  type NewDeviceCode,
  normaliseScope,
  PROJECT_WORKERS_MAX,
  type ProjectWorkerRow,
  type ScopeProject,
  WORKER_CONNECTED_SECONDS,
  type WorkerClaimRowFacts,
  type WorkerListRow,
  type WorkerStore,
  type WorkerUpdateRecord,
} from './worker-queries.js';

interface CodeRow extends Omit<NewDeviceCode, 'intervalSeconds'> {
  intervalSeconds: number;
  lastPolledAt: Date | null;
  approvedAt: Date | null;
  approvedBy: string | null;
  workerName: string | null;
  deniedAt: Date | null;
  deniedBy: string | null;
  consumedAt: Date | null;
  workerId: string | null;
}

interface WorkerRowMemory {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly credentialHash: string;
  readonly createdAt: Date;
  revokedAt: Date | null;
  lastSeenAt: Date | null;
  protocolVersion: number | null;
  imageDigests: readonly string[];
  pausedUntil: Date | null;
  pausedUntilEstimated?: boolean;
  manuallyPausedAt: Date | null;
  claimProjectIds?: readonly string[] | null;
  /** `workers.claim_policy` (migration 0108); absent or `null` reads as the SQL's `null`. */
  claimPolicy?: WorkerClaimPolicy | null;
}

export interface MemoryUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
}

export interface MemoryRun {
  readonly id: string;
  readonly workerId: string;
  readonly taskId: string;
  readonly projectId: string;
  /** The contract's own vocabulary, so a seed the database would refuse does not type-check. */
  status: RunStatus;
  leaseExpiresAt: Date | null;
}

export interface MemoryAudit {
  readonly userId: string;
  readonly action: string;
  readonly params: JsonObject;
}

export interface MemoryWorkerStore extends WorkerStore {
  addUser(user: MemoryUser): void;
  setUserMayAct(userId: string, mayAct: boolean): void;
  /** Better Auth's ban: `null` never expires. */
  banUser(userId: string, expiresAt: Date | null): void;
  seedRun(run: MemoryRun): void;
  readonly runs: ReadonlyMap<string, MemoryRun>;
  readonly audit: readonly MemoryAudit[];
  /** The number of device-code rows, whatever their state. */
  codeCount(): number;
  /** TD-031 §11's pause, as `pause` writes it (`null` resumes) — a test's direct seed. */
  setPausedUntil(workerId: string, until: Date | null): void;
  /** Whether a user may act now — the rule the store applies, for a composition that mirrors it. */
  userMayAct(userId: string): boolean;
  /** The worker's row as the store holds it, for a harness that mirrors it elsewhere. */
  worker(workerId: string): WorkerListRow | null;
  /**
   * A project, and the users who may take its runs — `project_members`/`users.role` at `member`+
   * in PostgreSQL (the effective role), a set here (WP-293).
   */
  addProject(project: ScopeProject, runners: readonly string[]): void;
  /** A project's execution mode (`project_execution_settings.mode`; none stored is `hybrid`). */
  setProjectMode(projectId: string, mode: ExecutionMode): void;
  /** A project whose run credential may not reach a worker (a static token without the opt-in). */
  refuseRemoteCredential(projectId: string): void;
  /** A claim of a run by this worker at `at` (`run_offers.claimed_at`, S-22.19). */
  recordClaim(workerId: string, at: Date): void;
  /** The open offers the worker's policy leaves for others, as PostgreSQL would count them (S-26.4). */
  seedPolicySkippedOffers(workerId: string, count: number | null): void;
  /** A worker row as a build before migration 0108 left it: its policy `null` (S-26.4). */
  clearClaimPolicy(workerId: string): void;
}

const stateOf = (row: CodeRow): DeviceCodeState => ({
  createdAt: row.createdAt.getTime(),
  expiresAt: row.expiresAt.getTime(),
  intervalSeconds: row.intervalSeconds,
  lastPolledAt: row.lastPolledAt?.getTime() ?? null,
  approvedAt: row.approvedAt?.getTime() ?? null,
  deniedAt: row.deniedAt?.getTime() ?? null,
  consumedAt: row.consumedAt?.getTime() ?? null,
});

const LIVE = new Set(['created', 'starting', 'running']);

export const createMemoryWorkerStore = (
  options: { readonly now?: () => Date } = {},
): MemoryWorkerStore => {
  /** The database's `now()` here: what `last_seen_at` is stamped by and the connected window reads. */
  const now = options.now ?? (() => new Date());
  const codes: CodeRow[] = [];
  const workers = new Map<string, WorkerRowMemory>();
  const users = new Map<string, MemoryUser>();
  const disabled = new Set<string>();
  const bans = new Map<string, Date | null>();
  /** The session's rule (`userMayAct`), so the double and PostgreSQL agree on an expired ban. */
  const mayAct = (userId: string): boolean =>
    userMayAct(
      {
        status: disabled.has(userId) ? 'disabled' : 'active',
        banned: bans.has(userId),
        banExpires: bans.get(userId) ?? null,
      },
      new Date(),
    );
  const runs = new Map<string, MemoryRun>();
  const audit: MemoryAudit[] = [];
  /** When each `worker.update` row was written — `human_actions.created_at`, kept beside its params. */
  const recordedAt = new Map<MemoryAudit, Date>();
  const projects = new Map<
    string,
    { readonly project: ScopeProject; readonly runners: Set<string> }
  >();
  const mayRunIn = (userId: string, projectId: string): boolean =>
    projects.get(projectId)?.runners.has(userId) === true;
  const modes = new Map<string, ExecutionMode>();
  const refused = new Set<string>();
  const claims = new Map<string, Date>();
  const skipped = new Map<string, number | null>();
  /** S-28.12: why a machine cannot provision a workspace (`workers.workspace_unavailable_*`). */
  const workspace = new Map<string, NonNullable<WorkerListRow['workspaceUnavailable']>>();

  /** The SQL store's `CLAIM_FACTS_OF_WORKER`, over this double's maps (S-22.19). */
  const claimFactsOf = (worker: WorkerRowMemory): WorkerClaimRowFacts => {
    const at = now().getTime();
    let via: string | null = null;
    for (let index = audit.length - 1; index >= 0; index -= 1) {
      const row = audit[index];
      if (row?.action === 'worker.pause' && row.params.worker_id === worker.id) {
        via = typeof row.params.via === 'string' ? row.params.via : null;
        break;
      }
    }
    const scope = worker.claimProjectIds ?? null;
    return {
      online:
        worker.lastSeenAt !== null &&
        at - worker.lastSeenAt.getTime() < WORKER_CONNECTED_SECONDS * 1000,
      usagePaused: worker.pausedUntil !== null && worker.pausedUntil.getTime() > at,
      ownerMayAct: mayAct(worker.userId),
      hold: holdOf(worker.manuallyPausedAt !== null, via),
      eligibleProjects: [...projects.keys()].filter(
        (projectId) =>
          (modes.get(projectId) ?? DEFAULT_EXECUTION_MODE) !== 'server_only' &&
          (scope === null || scope.length === 0 || scope.includes(projectId)) &&
          mayRunIn(worker.userId, projectId) &&
          !refused.has(projectId),
      ).length,
      lastClaimedAt: claims.get(worker.id) ?? null,
    };
  };

  const expire = (workerIds: ReadonlySet<string>): number => {
    let count = 0;
    for (const run of runs.values()) {
      if (workerIds.has(run.workerId) && LIVE.has(run.status)) {
        run.leaseExpiresAt = new Date();
        count += 1;
      }
    }
    return count;
  };

  const listRowOf = (worker: WorkerRowMemory): WorkerListRow => {
    const user = users.get(worker.userId);
    return {
      id: worker.id,
      name: worker.name,
      userId: worker.userId,
      userEmail: user?.email ?? 'unknown@example.invalid',
      userName: user?.name ?? null,
      createdAt: worker.createdAt,
      lastSeenAt: worker.lastSeenAt,
      protocolVersion: worker.protocolVersion,
      imageDigests: [...worker.imageDigests],
      state: worker.revokedAt === null ? 'active' : 'revoked',
      revokedAt: worker.revokedAt,
      pausedUntil: worker.pausedUntil,
      pausedReason: worker.pausedUntil === null ? null : 'usage_limited',
      pausedUntilEstimated: worker.pausedUntil !== null && worker.pausedUntilEstimated === true,
      manuallyPausedAt: worker.manuallyPausedAt,
      claimPolicy: effectiveClaimPolicy(worker.claimPolicy ?? null, worker.claimProjectIds ?? null),
      workspaceUnavailable: workspace.get(worker.id) ?? null,
      claimProjects:
        worker.claimProjectIds === undefined || worker.claimProjectIds === null
          ? null
          : worker.claimProjectIds.map((id) => ({
              id,
              key: projects.get(id)?.project.key ?? null,
            })),
      concurrency: 1,
      running: [...runs.values()]
        .filter((run) => run.workerId === worker.id && LIVE.has(run.status))
        .map((run) => ({ runId: run.id, taskId: run.taskId, projectId: run.projectId })),
    };
  };

  /** The newest `worker.update` audit row per worker (WP-287 (4)), as the SQL store reads it. */
  const lastUpdateOf = (workerId: string): WorkerUpdateRecord | null => {
    for (let index = audit.length - 1; index >= 0; index -= 1) {
      const row = audit[index];
      if (row?.action === 'worker.update' && row.params.worker_id === workerId) {
        return {
          result: row.params.result as WorkerUpdateRecord['result'],
          from: row.params.from as unknown as WorkerUpdateRecord['from'],
          to: row.params.to as unknown as WorkerUpdateRecord['to'],
          detail: typeof row.params.detail === 'string' ? row.params.detail : null,
          reportedAt: recordedAt.get(row) ?? new Date(0),
        };
      }
    }
    return null;
  };

  /** The SQL store's `writeClaimSettings`, over this double's row (S-26.4). */
  const writeClaimSettings = (input: {
    readonly workerId: string;
    readonly owner: { readonly userId: string; readonly canSeeAll: boolean } | null;
    readonly projectIds: readonly string[] | null;
    readonly policy?: WorkerClaimPolicy;
    readonly via: ClaimPolicyVia;
  }): ClaimScopeResult => {
    const worker = workers.get(input.workerId);
    if (worker === undefined) {
      return { status: 'not_found' };
    }
    if (input.owner !== null && worker.userId !== input.owner.userId) {
      return { status: input.owner.canSeeAll ? 'not_owner' : 'not_found' };
    }
    const next = normaliseScope(input.projectIds);
    if (next !== null && next.length === 0) {
      return { status: 'empty_scope' };
    }
    const invalid = (next ?? []).filter((id) => !mayRunIn(worker.userId, id));
    if (invalid.length > 0) {
      return { status: 'invalid', projectIds: invalid };
    }
    const before = effectiveClaimPolicy(worker.claimPolicy ?? null, worker.claimProjectIds ?? null);
    const storedPolicy = input.policy ?? worker.claimPolicy ?? null;
    const after = effectiveClaimPolicy(storedPolicy, next);
    const stored = normaliseScope(worker.claimProjectIds ?? null);
    const storedList = stored !== null && stored.length === 0 ? null : stored;
    if (JSON.stringify(storedList) === JSON.stringify(next) && before === after) {
      return { status: 'set', claimProjectIds: next, claimPolicy: after, performed: false };
    }
    worker.claimProjectIds = next;
    worker.claimPolicy = storedPolicy;
    const policyAudit = before !== after || input.via === 'workers_screen';
    audit.push({
      userId: worker.userId,
      action: policyAudit ? 'worker.claim_policy' : 'worker.claim_scope',
      params: policyAudit
        ? { worker_id: input.workerId, claim_policy: after, project_ids: next, via: input.via }
        : { worker_id: input.workerId, project_ids: next, via: input.via },
    });
    return { status: 'set', claimProjectIds: next, claimPolicy: after, performed: true };
  };

  return {
    runs,
    audit,
    codeCount: () => codes.length,
    setPausedUntil: (workerId, until) => {
      const worker = workers.get(workerId);
      if (worker !== undefined) worker.pausedUntil = until;
    },
    userMayAct: (userId) => mayAct(userId),
    worker: (workerId) => {
      const worker = workers.get(workerId);
      return worker === undefined ? null : listRowOf(worker);
    },
    addUser: (user) => users.set(user.id, user),
    addProject: (project, runners) =>
      projects.set(project.id, { project, runners: new Set(runners) }),
    setProjectMode: (projectId, mode) => modes.set(projectId, mode),
    refuseRemoteCredential: (projectId) => refused.add(projectId),
    recordClaim: (workerId, at) => {
      const previous = claims.get(workerId);
      if (previous === undefined || previous < at) claims.set(workerId, at);
    },
    seedPolicySkippedOffers: (workerId, count) => skipped.set(workerId, count),
    clearClaimPolicy: (workerId) => {
      const worker = workers.get(workerId);
      if (worker !== undefined) worker.claimPolicy = null;
    },
    setUserMayAct: (userId, mayAct) => {
      if (mayAct) disabled.delete(userId);
      else disabled.add(userId);
    },
    seedRun: (run) => runs.set(run.id, run),
    banUser: (userId, expiresAt) => bans.set(userId, expiresAt),

    async createDeviceCode(input, now) {
      const pending = codes.filter(
        (row) => row.approvedAt === null && row.deniedAt === null && row.expiresAt > now,
      );
      const limit = deviceCodeLimitExceeded(
        pending.filter((row) => row.clientAddress === input.clientAddress).length,
        pending.length,
      );
      if (limit !== null) {
        return { status: 'limited', limit };
      }
      if (
        codes.some(
          (row) =>
            row.id === input.id ||
            row.deviceCodeHash === input.deviceCodeHash ||
            row.userCodeHash === input.userCodeHash,
        )
      ) {
        return { status: 'collision' };
      }
      codes.push({
        ...input,
        lastPolledAt: null,
        approvedAt: null,
        approvedBy: null,
        workerName: null,
        deniedAt: null,
        deniedBy: null,
        consumedAt: null,
        workerId: null,
      });
      return { status: 'created' };
    },

    async pollDeviceCode({ deviceCodeHash, now, mint }) {
      const row = codes.find((code) => code.deviceCodeHash === deviceCodeHash);
      if (row === undefined) {
        return { outcome: 'expired_token' };
      }
      const decision = decideDevicePoll(stateOf(row), now.getTime());
      if (decision.outcome === 'expired_token') {
        return decision;
      }
      row.lastPolledAt = now;
      if (decision.outcome === 'slow_down') {
        row.intervalSeconds = decision.intervalSeconds;
      }
      if (decision.outcome !== 'issue') {
        return decision;
      }
      const approver = row.approvedBy;
      if (approver === null || !users.has(approver) || !mayAct(approver)) {
        return { outcome: 'access_denied' };
      }
      workers.set(mint.workerId, {
        id: mint.workerId,
        userId: approver,
        name: row.workerName ?? '',
        credentialHash: mint.credentialHash,
        createdAt: now,
        revokedAt: null,
        lastSeenAt: null,
        protocolVersion: null,
        imageDigests: [],
        pausedUntil: null,
        manuallyPausedAt: null,
        claimPolicy: NEW_WORKER_CLAIM_POLICY,
      });
      row.consumedAt = now;
      row.workerId = mint.workerId;
      return { outcome: 'issued', workerId: mint.workerId };
    },

    async findPendingDeviceCode(userCodeHash, now) {
      const row = codes.find(
        (code) =>
          code.userCodeHash === userCodeHash &&
          code.approvedAt === null &&
          code.deniedAt === null &&
          code.expiresAt > now,
      );
      return row === undefined
        ? null
        : {
            clientAddress: row.clientAddress,
            userAgent: row.userAgent,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
          };
    },

    async decideDeviceCode(input) {
      const row = codes.find((code) => code.userCodeHash === input.userCodeHash);
      if (row === undefined) {
        return { status: 'not_found' };
      }
      const repeated = repeatedDeviceDecision(
        {
          approvedAt: row.approvedAt?.getTime() ?? null,
          approvedBy: row.approvedBy,
          workerName: row.workerName,
          deniedAt: row.deniedAt?.getTime() ?? null,
          deniedBy: row.deniedBy,
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
        row.approvedAt = input.now;
        row.approvedBy = input.actorUserId;
        row.workerName = input.name;
      } else {
        row.deniedAt = input.now;
        row.deniedBy = input.actorUserId;
      }
      audit.push({
        userId: input.actorUserId,
        action: `worker.device.${input.decision}`,
        params: {
          ...input.auditParams,
          decision: input.decision,
          requested_ip: row.clientAddress,
          stale_confirmed:
            input.decision === 'approve' && isDeviceCodeStale(state, input.now.getTime()),
        },
      });
      return { status: 'decided', decidedAt: input.now, performed: true };
    },

    async listWorkers(userId, coreDigests = null, workerId) {
      return [...workers.values()]
        .filter((worker) => userId === null || worker.userId === userId)
        .filter((worker) => workerId === undefined || worker.id === workerId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((worker) => ({
          ...listRowOf(worker),
          lastUpdate: lastUpdateOf(worker.id),
          claimFacts: claimFactsOf(worker),
          policySkippedOffers: coreDigests === null ? null : (skipped.get(worker.id) ?? null),
        }));
    },

    async setWorkspaceUnavailable({ workerId, value }) {
      if (value === null) {
        workspace.delete(workerId);
        return;
      }
      workspace.set(workerId, {
        cause: value.cause,
        detail: value.detail,
        since: workspace.get(workerId)?.since ?? value.at,
        until: value.until,
      });
    },

    async retryWorkspace(workerId) {
      const known = workspace.get(workerId);
      if (known !== undefined) workspace.set(workerId, { ...known, until: null });
    },

    async policySkippedOffers(workerId) {
      return workers.has(workerId) ? (skipped.get(workerId) ?? null) : null;
    },

    async listWorkersForProject(projectId, userId): Promise<ProjectWorkerRow[]> {
      return [...workers.values()]
        .filter((worker) => worker.revokedAt === null)
        .filter((worker) => userId === null || worker.userId === userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, PROJECT_WORKERS_MAX)
        .map((worker) => ({
          ...listRowOf(worker),
          // A project's read asks its own question rather than counting projects (as PostgreSQL).
          claimFacts: { ...claimFactsOf(worker), eligibleProjects: null },
          mayRunInProject: mayRunIn(worker.userId, projectId),
        }));
    },

    async recordUpdateReport({ workerId, report, now }) {
      const worker = workers.get(workerId);
      if (worker === undefined) return 'not_found';
      const row: MemoryAudit = {
        userId: worker.userId,
        action: 'worker.update',
        params: {
          worker_id: workerId,
          result: report.result,
          from: { ...report.from },
          to: { ...report.to },
          detail: report.detail,
        },
      };
      audit.push(row);
      recordedAt.set(row, now);
      return 'recorded';
    },

    async revokeWorker({ workerId, ownerUserId, actorUserId, now }) {
      const worker = workers.get(workerId);
      if (worker === undefined || (ownerUserId !== null && worker.userId !== ownerUserId)) {
        return { status: 'not_found' };
      }
      if (worker.revokedAt !== null) {
        return { status: 'revoked', performed: false, revokedAt: worker.revokedAt, expiredRuns: 0 };
      }
      worker.revokedAt = now;
      const expiredRuns = expire(new Set([workerId]));
      audit.push({
        userId: actorUserId,
        action: 'worker.revoke',
        params: { worker_id: workerId, owner_user_id: worker.userId, expired_runs: expiredRuns },
      });
      return { status: 'revoked', performed: true, revokedAt: now, expiredRuns };
    },

    async organisationTimezone() {
      return 'UTC';
    },
    async setUsagePause({ workerId, until, estimated }) {
      const worker = workers.get(workerId);
      if (worker === undefined) return false;
      worker.pausedUntil = until;
      worker.pausedUntilEstimated = estimated;
      return true;
    },
    async setManualPause({ workerId, paused, via, now }) {
      const worker = workers.get(workerId);
      if (worker === undefined) {
        return { status: 'not_found' };
      }
      if ((worker.manuallyPausedAt !== null) === paused) {
        return { status: 'set', manuallyPausedAt: worker.manuallyPausedAt, performed: false };
      }
      worker.manuallyPausedAt = paused ? now : null;
      audit.push({
        userId: worker.userId,
        action: paused ? 'worker.pause' : 'worker.resume',
        params: { worker_id: workerId, via },
      });
      return { status: 'set', manuallyPausedAt: worker.manuallyPausedAt, performed: true };
    },

    async claimScope(workerId, coreDigests = null) {
      const worker = workers.get(workerId);
      if (worker === undefined) {
        return { status: 'not_found' };
      }
      return {
        status: 'found',
        claimPolicy: effectiveClaimPolicy(
          worker.claimPolicy ?? null,
          worker.claimProjectIds ?? null,
        ),
        policySkippedOffers: coreDigests === null ? null : (skipped.get(workerId) ?? null),
        claimProjectIds: worker.claimProjectIds ?? null,
        projects: [...projects.values()]
          .filter((entry) => mayRunIn(worker.userId, entry.project.id))
          .map((entry) => entry.project)
          .sort((a, b) => a.key.localeCompare(b.key) || a.id.localeCompare(b.id)),
      };
    },
    async setClaimScope({ workerId, projectIds, policy }) {
      return writeClaimSettings({
        workerId,
        owner: null,
        projectIds,
        ...(policy === undefined ? {} : { policy }),
        via: 'worker_ui',
      });
    },

    async setClaimPolicy({ workerId, actorUserId, canSeeAll, projectIds, policy }) {
      return writeClaimSettings({
        workerId,
        owner: { userId: actorUserId, canSeeAll },
        projectIds,
        policy,
        via: 'workers_screen',
      });
    },

    async expireUserWorkerLeases(userId) {
      return expire(
        new Set([...workers.values()].filter((w) => w.userId === userId).map((w) => w.id)),
      );
    },

    async recordContact({ workerId, protocolVersion, imageDigests }) {
      const worker = workers.get(workerId);
      if (worker === undefined) {
        return null;
      }
      worker.lastSeenAt = now();
      worker.protocolVersion = protocolVersion;
      if (imageDigests !== null) {
        worker.imageDigests = [...imageDigests];
      }
      return listRowOf(worker);
    },

    async countConnected() {
      const at = now().getTime();
      const connected = [...workers.values()].filter(
        (worker) =>
          worker.revokedAt === null &&
          worker.lastSeenAt !== null &&
          at - worker.lastSeenAt.getTime() < WORKER_CONNECTED_SECONDS * 1000,
      );
      return {
        connected: connected.length,
        paused: connected.filter(
          (worker) =>
            (worker.pausedUntil !== null && worker.pausedUntil.getTime() > at) ||
            worker.manuallyPausedAt !== null,
        ).length,
      };
    },

    async findCredentialSubject(workerId): Promise<CredentialSubject | null> {
      const worker = workers.get(workerId);
      return worker === undefined
        ? null
        : {
            workerId: worker.id,
            userId: worker.userId,
            credentialHash: worker.credentialHash,
            usable: worker.revokedAt === null && mayAct(worker.userId),
          };
    },
  };
};
