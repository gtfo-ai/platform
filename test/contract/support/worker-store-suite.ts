/**
 * The `WorkerStore` contract (WP-280), run against the in-memory double by the contract tier
 * (`test/contract/worker-store.contract.test.ts`) and against PostgreSQL by the integration tier
 * (`test/integration/server/worker-store.integration.test.ts`).
 *
 * Every route test of the device flow and the Workers screen runs on the double, so each claim
 * there rests on the two stores answering alike — a new obligation lands here in the same change.
 *
 * ## The cases that earn the suite
 *
 * - **The outstanding-code limits** count *pending* codes only: an approved, denied or expired code
 *   frees its slot, which the suite proves by filling an address and then deciding one code.
 * - **The credential is issued once**: the poll that issues consumes the code, so the next answers
 *   `expired_token`; and the worker row the poll creates is the approver's, under the approved name.
 * - **`slow_down` grows the stored interval**, so the poll after it is judged against the new one.
 * - **Revocation writes exactly what TD-031 §7 says**: the worker's *live* runs' lease expires, an
 *   ended run's does not, another worker's does not, and a second revoke performs nothing.
 * - **A non-administrator cannot see another person's worker exist** (`not_found`).
 *
 * ## What it does not assert
 *
 * Two concurrent polls of one code: the double has no interleaving to show (its register says so),
 * and the integration file asserts the row lock against PostgreSQL on its own.
 */
import type { JsonObject } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type {
  NewDeviceCode,
  WorkerStore,
} from '../../../apps/server/src/queries/worker-queries.js';

export interface WorkerStoreWorld {
  readonly store: WorkerStore;
  /** A user that exists and may act. */
  addUser(email: string): Promise<string>;
  setUserMayAct(userId: string, mayAct: boolean): Promise<void>;
  /** Better Auth's ban, with its expiry (`null`: never expires). */
  banUser(userId: string, expiresAt: Date | null): Promise<void>;
  /** A run held by `workerId`, in `status`; its lease is in the future. */
  seedRun(workerId: string, status: 'running' | 'starting' | 'completed'): Promise<string>;
  /** Whether the run's lease has expired (`lease_expires_at <= now()`). */
  leaseExpired(runId: string): Promise<boolean>;
  /** The `human_actions` rows written, oldest first. */
  audit(): Promise<{ action: string; userId: string; params: JsonObject }[]>;
}

export interface WorkerStoreHarness {
  readonly name: string;
  create(): Promise<WorkerStoreWorld>;
}

const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);
const hex = (seed: string): string => seed.padEnd(64, '0').slice(0, 64);
let sequence = 0;

/** A code pair's row with distinct hashes; the instants are `T0 + offsetMs`. */
const code = (
  address: string,
  offsetMs = 0,
): NewDeviceCode & { userHash: string; deviceHash: string } => {
  sequence += 1;
  const n = sequence.toString(16).padStart(8, '0');
  const deviceHash = hex(`d${n}`);
  const userHash = hex(`e${n}`);
  return {
    id: `00000000-0000-4000-8000-${n.padStart(12, '0')}`,
    deviceCodeHash: deviceHash,
    userCodeHash: userHash,
    deviceHash,
    userHash,
    clientAddress: address,
    userAgent: 'agentic-worker/1 (FAKE)',
    createdAt: new Date(T0 + offsetMs),
    expiresAt: new Date(T0 + offsetMs + 600_000),
    intervalSeconds: 5,
  };
};

const mint = (n: number) => ({
  workerId: `00000000-0000-4000-8000-${(0x280000 + n + sequence * 1000).toString(16).padStart(12, '0')}`,
  credentialHash: hex(`c${n.toString(16)}${sequence.toString(16)}`),
});

const at = (offsetMs: number): Date => new Date(T0 + offsetMs);

export const describeWorkerStoreContract = (harness: WorkerStoreHarness): void => {
  describe(`WorkerStore contract — ${harness.name}`, () => {
    /** A worker of `userId`, through the device flow, as the routes make one. */
    const registerWorker = async (world: WorkerStoreWorld, userId: string): Promise<string> => {
      const pair = code('192.0.2.50');
      await world.store.createDeviceCode(pair, at(0));
      await world.store.decideDeviceCode({
        userCodeHash: pair.userHash,
        decision: 'approve',
        name: 'machine',
        confirmedStale: false,
        actorUserId: userId,
        now: at(1_000),
        auditParams: {},
      });
      const minted = mint(1);
      const result = await world.store.pollDeviceCode({
        deviceCodeHash: pair.deviceHash,
        now: at(10_000),
        mint: minted,
      });
      expect(result).toEqual({ outcome: 'issued', workerId: minted.workerId });
      return minted.workerId;
    };

    it('limits pending codes per address, and a decided code frees its slot', async () => {
      const world = await harness.create();
      const user = await world.addUser('limit@example.test');
      const pairs = [];
      for (let index = 0; index < 20; index += 1) {
        const pair = code('198.51.100.20');
        pairs.push(pair);
        expect(await world.store.createDeviceCode(pair, at(0))).toEqual({ status: 'created' });
      }
      expect(await world.store.createDeviceCode(code('198.51.100.20'), at(0))).toEqual({
        status: 'limited',
        limit: 'address',
      });
      expect(await world.store.createDeviceCode(code('198.51.100.21'), at(0))).toEqual({
        status: 'created',
      });
      const decided = await world.store.decideDeviceCode({
        userCodeHash: pairs[0]?.userHash ?? '',
        decision: 'deny',
        name: null,
        confirmedStale: false,
        actorUserId: user,
        now: at(1_000),
        auditParams: {},
      });
      expect(decided.status).toBe('decided');
      expect(await world.store.createDeviceCode(code('198.51.100.20'), at(2_000))).toEqual({
        status: 'created',
      });
      // An expired code frees its slot too: ten minutes on, the address is empty again.
      expect(
        await world.store.createDeviceCode(code('198.51.100.20', 700_000), at(700_000)),
      ).toEqual({
        status: 'created',
      });
    });

    it('reports a hash collision rather than overwriting a code', async () => {
      const world = await harness.create();
      const pair = code('198.51.100.30');
      await world.store.createDeviceCode(pair, at(0));
      expect(
        await world.store.createDeviceCode(
          { ...code('198.51.100.30'), userCodeHash: pair.userHash },
          at(0),
        ),
      ).toEqual({ status: 'collision' });
    });

    it('polls pending, slows a fast poll and keeps the grown interval, then issues once', async () => {
      const world = await harness.create();
      const user = await world.addUser('poll@example.test');
      const pair = code('198.51.100.40');
      await world.store.createDeviceCode(pair, at(0));
      const poll = (offset: number) =>
        world.store.pollDeviceCode({
          deviceCodeHash: pair.deviceHash,
          now: at(offset),
          mint: mint(2),
        });
      expect(await poll(5_000)).toEqual({ outcome: 'authorization_pending' });
      expect(await poll(6_000)).toEqual({ outcome: 'slow_down', intervalSeconds: 10 });
      // 9 s after the last poll is inside the grown 10 s interval.
      expect((await poll(15_000)).outcome).toBe('slow_down');
      expect(await world.store.findPendingDeviceCode(pair.userHash, at(16_000))).toMatchObject({
        clientAddress: '198.51.100.40',
        userAgent: 'agentic-worker/1 (FAKE)',
      });
      await world.store.decideDeviceCode({
        userCodeHash: pair.userHash,
        decision: 'approve',
        name: 'poll-machine',
        confirmedStale: false,
        actorUserId: user,
        now: at(16_000),
        auditParams: {},
      });
      expect(await world.store.findPendingDeviceCode(pair.userHash, at(16_000))).toBeNull();
      const minted = mint(3);
      const issued = await world.store.pollDeviceCode({
        deviceCodeHash: pair.deviceHash,
        now: at(40_000),
        mint: minted,
      });
      expect(issued).toEqual({ outcome: 'issued', workerId: minted.workerId });
      expect(await poll(80_000)).toEqual({ outcome: 'expired_token' });
      const listed = await world.store.listWorkers(user);
      expect(listed.map((row) => [row.id, row.name, row.userId, row.state])).toEqual([
        [minted.workerId, 'poll-machine', user, 'active'],
      ]);
      expect(await world.store.findCredentialSubject(minted.workerId)).toEqual({
        workerId: minted.workerId,
        userId: user,
        credentialHash: minted.credentialHash,
        usable: true,
      });
      const audit = await world.audit();
      expect(audit.map((row) => row.action)).toEqual(['worker.device.approve']);
      expect(audit[0]?.params).toMatchObject({
        decision: 'approve',
        requested_ip: '198.51.100.40',
      });
    });

    it('answers expired_token for an unknown code, and refuses decisions on what is not pending', async () => {
      const world = await harness.create();
      const user = await world.addUser('refuse@example.test');
      expect(
        await world.store.pollDeviceCode({ deviceCodeHash: hex('ff'), now: at(0), mint: mint(4) }),
      ).toEqual({ outcome: 'expired_token' });
      const decide = (userCodeHash: string, now: number, confirmedStale = false) =>
        world.store.decideDeviceCode({
          userCodeHash,
          decision: 'approve',
          name: 'x',
          confirmedStale,
          actorUserId: user,
          now: at(now),
          auditParams: {},
        });
      expect(await decide(hex('fe'), 0)).toEqual({ status: 'not_found' });
      const pair = code('198.51.100.50');
      await world.store.createDeviceCode(pair, at(0));
      expect(await decide(pair.userHash, 300_001)).toEqual({ status: 'needs_confirmation' });
      expect(await decide(pair.userHash, 600_000, true)).toEqual({ status: 'expired' });
      expect(await world.audit()).toEqual([]);
    });

    it('denies the credential when the approver can no longer act at collection', async () => {
      const world = await harness.create();
      const user = await world.addUser('gone@example.test');
      const pair = code('198.51.100.60');
      await world.store.createDeviceCode(pair, at(0));
      await world.store.decideDeviceCode({
        userCodeHash: pair.userHash,
        decision: 'approve',
        name: 'x',
        confirmedStale: false,
        actorUserId: user,
        now: at(1_000),
        auditParams: {},
      });
      await world.setUserMayAct(user, false);
      expect(
        await world.store.pollDeviceCode({
          deviceCodeHash: pair.deviceHash,
          now: at(10_000),
          mint: mint(5),
        }),
      ).toEqual({ outcome: 'access_denied' });
      expect(await world.store.listWorkers(user)).toEqual([]);
    });

    it('lists the live runs each worker holds, oldest first, and not an ended one or another worker’s (S-23.15)', async () => {
      const world = await harness.create();
      const owner = await world.addUser('holds@example.test');
      const other = await world.addUser('holds-other@example.test');
      const worker = await registerWorker(world, owner);
      const otherWorker = await registerWorker(world, other);
      // Nothing seeded yet: the list is empty, so the assertion below is about the seeds.
      expect((await world.store.listWorkers(owner))[0]?.running).toEqual([]);
      const live = await world.seedRun(worker, 'running');
      await world.seedRun(worker, 'completed');
      const starting = await world.seedRun(worker, 'starting');
      const othersRun = await world.seedRun(otherWorker, 'running');

      const [mine] = await world.store.listWorkers(owner);
      expect(mine?.running.map((run) => run.runId)).toEqual([live, starting]);
      expect(mine?.running.every((run) => run.taskId.length > 0 && run.projectId.length > 0)).toBe(
        true,
      );
      const all = await world.store.listWorkers(null);
      expect(all.find((row) => row.id === otherWorker)?.running.map((run) => run.runId)).toEqual([
        othersRun,
      ]);
    });

    it('revokes: the live runs’ leases expire and nothing else, once; others’ workers read as absent', async () => {
      const world = await harness.create();
      const owner = await world.addUser('owner@example.test');
      const other = await world.addUser('other@example.test');
      const worker = await registerWorker(world, owner);
      const otherWorker = await registerWorker(world, other);
      const live = await world.seedRun(worker, 'running');
      const starting = await world.seedRun(worker, 'starting');
      const ended = await world.seedRun(worker, 'completed');
      const othersRun = await world.seedRun(otherWorker, 'running');

      expect(
        await world.store.revokeWorker({
          workerId: worker,
          ownerUserId: other,
          actorUserId: other,
          now: at(0),
        }),
      ).toEqual({ status: 'not_found' });
      expect(await world.leaseExpired(live)).toBe(false);

      const revoked = await world.store.revokeWorker({
        workerId: worker,
        ownerUserId: owner,
        actorUserId: owner,
        now: at(20_000),
      });
      expect(revoked).toEqual({
        status: 'revoked',
        performed: true,
        revokedAt: at(20_000),
        expiredRuns: 2,
      });
      expect(await world.leaseExpired(live)).toBe(true);
      expect(await world.leaseExpired(starting)).toBe(true);
      expect(await world.leaseExpired(ended)).toBe(false);
      expect(await world.leaseExpired(othersRun)).toBe(false);
      expect((await world.store.findCredentialSubject(worker))?.usable).toBe(false);
      expect((await world.store.listWorkers(owner))[0]).toMatchObject({
        state: 'revoked',
        revokedAt: at(20_000),
      });

      const again = await world.store.revokeWorker({
        workerId: worker,
        ownerUserId: null,
        actorUserId: owner,
        now: at(30_000),
      });
      expect(again).toEqual({
        status: 'revoked',
        performed: false,
        revokedAt: at(20_000),
        expiredRuns: 0,
      });
      expect((await world.audit()).filter((row) => row.action === 'worker.revoke')).toHaveLength(1);
      expect(new Set((await world.store.listWorkers(null)).map((row) => row.id))).toEqual(
        new Set([worker, otherWorker]),
      );
    });

    it('records a worker’s contact and counts it connected until it is revoked (WP-281)', async () => {
      const world = await harness.create();
      const owner = await world.addUser('contact@example.test');
      const worker = await registerWorker(world, owner);
      // Registered but never seen: not connected — `last_seen_at` is the protocol's to write.
      expect(await world.store.countConnected()).toEqual({ connected: 0, paused: 0 });
      const digests = [`sha256:${'c'.repeat(64)}`, `sha256:${'d'.repeat(64)}`];
      const row = await world.store.recordContact({
        workerId: worker,
        protocolVersion: 1,
        imageDigests: digests,
      });
      expect(row).toMatchObject({ id: worker, protocolVersion: 1, imageDigests: digests });
      expect(row?.lastSeenAt).not.toBeNull();
      // A call that reports no digests keeps the ones recorded.
      expect(
        await world.store.recordContact({
          workerId: worker,
          protocolVersion: 1,
          imageDigests: null,
        }),
      ).toMatchObject({ imageDigests: digests });
      expect(await world.store.countConnected()).toEqual({ connected: 1, paused: 0 });
      expect(
        await world.store.recordContact({
          workerId: '00000000-0000-4000-8000-00000028ffff',
          protocolVersion: 1,
          imageDigests: null,
        }),
      ).toBeNull();
      await world.store.revokeWorker({
        workerId: worker,
        ownerUserId: null,
        actorUserId: owner,
        now: at(0),
      });
      expect(await world.store.countConnected()).toEqual({ connected: 0, paused: 0 });
    });

    it('answers a repeated decision with the recorded one, writes nothing, and refuses a different one', async () => {
      const world = await harness.create();
      const user = await world.addUser('repeat@example.test');
      const other = await world.addUser('repeat-other@example.test');
      const pair = code('198.51.100.70');
      await world.store.createDeviceCode(pair, at(0));
      const decide = (actorUserId: string, name: string, now: number) =>
        world.store.decideDeviceCode({
          userCodeHash: pair.userHash,
          decision: 'approve',
          name,
          confirmedStale: false,
          actorUserId,
          now: at(now),
          auditParams: {},
        });
      expect(await decide(user, 'repeat-machine', 1_000)).toEqual({
        status: 'decided',
        decidedAt: at(1_000),
        performed: true,
      });
      // A retry — even after the code expired — answers the first decision and writes no audit row.
      expect(await decide(user, 'repeat-machine', 700_000)).toEqual({
        status: 'decided',
        decidedAt: at(1_000),
        performed: false,
      });
      expect(await decide(user, 'renamed', 2_000)).toEqual({ status: 'already_decided' });
      expect(await decide(other, 'repeat-machine', 2_000)).toEqual({ status: 'already_decided' });
      expect((await world.audit()).map((row) => row.action)).toEqual(['worker.device.approve']);
    });

    it('applies the session’s ban rule: a ban in force stops a worker, an expired one does not', async () => {
      const world = await harness.create();
      const owner = await world.addUser('banned@example.test');
      const worker = await registerWorker(world, owner);
      await world.banUser(owner, new Date(Date.now() - 60_000));
      expect((await world.store.findCredentialSubject(worker))?.usable).toBe(true);
      await world.banUser(owner, new Date(Date.now() + 3_600_000));
      expect((await world.store.findCredentialSubject(worker))?.usable).toBe(false);
      await world.banUser(owner, null);
      expect((await world.store.findCredentialSubject(worker))?.usable).toBe(false);
    });

    it('expires the leases of every worker of a deactivated user, and stops authenticating them', async () => {
      const world = await harness.create();
      const owner = await world.addUser('deactivated@example.test');
      const worker = await registerWorker(world, owner);
      const live = await world.seedRun(worker, 'running');
      await world.setUserMayAct(owner, false);
      expect((await world.store.findCredentialSubject(worker))?.usable).toBe(false);
      expect(await world.store.expireUserWorkerLeases(owner)).toBe(1);
      expect(await world.leaseExpired(live)).toBe(true);
    });
  });
};
