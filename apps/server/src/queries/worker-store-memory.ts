/**
 * An in-memory {@link WorkerStore} for the route tests (WP-280).
 *
 * It asks the same domain decisions the Postgres store asks and is held to the same contract suite
 * (`test/contract/support/worker-store.ts`, run against it by the contract tier). **Divergences,
 * stated:** no transaction and no row lock — a JavaScript turn is atomic, so two polls cannot
 * interleave inside one call here, which is what the lock buys in PostgreSQL; `runs` is a map the
 * test seeds (`seedRun`) rather than a table, and the users' ability to act is a set the test
 * flips (`setUserMayAct`) rather than `users.status`/`banned`.
 */
import type { JsonObject, RunStatus } from '@platform/contracts';
import {
  checkDeviceDecision,
  type DeviceCodeState,
  decideDevicePoll,
  deviceCodeLimitExceeded,
  isDeviceCodeStale,
} from '@platform/domain';
import type {
  CredentialSubject,
  NewDeviceCode,
  WorkerListRow,
  WorkerStore,
} from './worker-queries.js';

interface CodeRow extends Omit<NewDeviceCode, 'intervalSeconds'> {
  intervalSeconds: number;
  lastPolledAt: Date | null;
  approvedAt: Date | null;
  approvedBy: string | null;
  workerName: string | null;
  deniedAt: Date | null;
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
}

export interface MemoryUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
}

export interface MemoryRun {
  readonly id: string;
  readonly workerId: string;
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
  seedRun(run: MemoryRun): void;
  readonly runs: ReadonlyMap<string, MemoryRun>;
  readonly audit: readonly MemoryAudit[];
  /** The number of device-code rows, whatever their state. */
  codeCount(): number;
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

export const createMemoryWorkerStore = (): MemoryWorkerStore => {
  const codes: CodeRow[] = [];
  const workers = new Map<string, WorkerRowMemory>();
  const users = new Map<string, MemoryUser>();
  const disabled = new Set<string>();
  const runs = new Map<string, MemoryRun>();
  const audit: MemoryAudit[] = [];

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

  return {
    runs,
    audit,
    codeCount: () => codes.length,
    addUser: (user) => users.set(user.id, user),
    setUserMayAct: (userId, mayAct) => {
      if (mayAct) disabled.delete(userId);
      else disabled.add(userId);
    },
    seedRun: (run) => runs.set(run.id, run),

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
      if (approver === null || !users.has(approver) || disabled.has(approver)) {
        return { outcome: 'access_denied' };
      }
      workers.set(mint.workerId, {
        id: mint.workerId,
        userId: approver,
        name: row.workerName ?? '',
        credentialHash: mint.credentialHash,
        createdAt: now,
        revokedAt: null,
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
      return { status: 'decided', decidedAt: input.now };
    },

    async listWorkers(userId) {
      return [...workers.values()]
        .filter((worker) => userId === null || worker.userId === userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((worker): WorkerListRow => {
          const user = users.get(worker.userId);
          return {
            id: worker.id,
            name: worker.name,
            userId: worker.userId,
            userEmail: user?.email ?? 'unknown@example.invalid',
            userName: user?.name ?? null,
            createdAt: worker.createdAt,
            lastSeenAt: null,
            protocolVersion: null,
            imageDigests: [],
            state: worker.revokedAt === null ? 'active' : 'revoked',
            revokedAt: worker.revokedAt,
            pausedUntil: null,
            pausedReason: null,
            concurrency: 1,
          };
        });
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

    async expireUserWorkerLeases(userId) {
      return expire(
        new Set([...workers.values()].filter((w) => w.userId === userId).map((w) => w.id)),
      );
    },

    async findCredentialSubject(workerId): Promise<CredentialSubject | null> {
      const worker = workers.get(workerId);
      return worker === undefined
        ? null
        : {
            workerId: worker.id,
            userId: worker.userId,
            credentialHash: worker.credentialHash,
            usable: worker.revokedAt === null && !disabled.has(worker.userId),
          };
    },
  };
};
