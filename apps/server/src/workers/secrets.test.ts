import { createHash } from 'node:crypto';
import { workerCredentialSchema, workerUserCodeSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createMemoryWorkerStore } from '../queries/worker-store-memory.js';
import {
  authenticateWorkerCredential,
  hashSecret,
  hashTypedUserCode,
  mintDeviceCodes,
  mintWorkerCredential,
} from './secrets.js';

describe('the device flow’s and the worker’s secrets', () => {
  it('hashes as SHA-256 hex', () => {
    expect(hashSecret('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
    expect(hashSecret('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mints a 43-character device code and a user code the contract accepts, drawing again when the bytes run out', () => {
    const pair = mintDeviceCodes();
    expect(pair.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(workerUserCodeSchema.safeParse(pair.userCode).success).toBe(true);
    let draws = 0;
    const exhausted = mintDeviceCodes((size) => {
      draws += 1;
      return new Uint8Array(size).fill(draws === 1 ? 255 : 0);
    });
    expect(draws).toBe(2);
    expect(exhausted.userCode).toBe('BBBB-BBBB');
  });

  it('hashes what a person typed as the normalised code, and refuses what is not a code', () => {
    expect(hashTypedUserCode('bcdf ghjk')).toBe(hashSecret('BCDF-GHJK'));
    expect(hashTypedUserCode('AEIO-UAEI')).toBeNull();
  });

  it('mints a credential the contract accepts, stored only as its hash', () => {
    const minted = mintWorkerCredential();
    expect(workerCredentialSchema.safeParse(minted.credential).success).toBe(true);
    expect(minted.credentialHash).toBe(hashSecret(minted.credential));
    expect(mintWorkerCredential().credential).not.toBe(minted.credential);
  });
});

describe('authenticateWorkerCredential', () => {
  const USER = '00000000-0000-4000-8000-0000000280c1';
  const setup = async () => {
    const store = createMemoryWorkerStore();
    store.addUser({ id: USER, email: 'c@example.test', name: null });
    const minted = mintWorkerCredential();
    const now = new Date();
    await store.createDeviceCode(
      {
        id: crypto.randomUUID(),
        deviceCodeHash: hashSecret('d'),
        userCodeHash: hashSecret('u'),
        clientAddress: '127.0.0.1',
        userAgent: null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 600_000),
        intervalSeconds: 5,
      },
      now,
    );
    await store.decideDeviceCode({
      userCodeHash: hashSecret('u'),
      decision: 'approve',
      name: 'm',
      confirmedStale: false,
      actorUserId: USER,
      now,
      auditParams: {},
    });
    await store.pollDeviceCode({
      deviceCodeHash: hashSecret('d'),
      now,
      mint: { workerId: minted.workerId, credentialHash: minted.credentialHash },
    });
    return { store, minted };
  };

  it('authenticates the credential it minted', async () => {
    const { store, minted } = await setup();
    expect((await authenticateWorkerCredential(store, minted.credential))?.workerId).toBe(
      minted.workerId,
    );
  });

  it('refuses a wrong secret for a real worker id, a malformed value and an unknown worker', async () => {
    const { store, minted } = await setup();
    const forged = `${minted.credential.slice(0, -1)}${minted.credential.endsWith('A') ? 'B' : 'A'}`;
    expect(await authenticateWorkerCredential(store, forged)).toBeNull();
    expect(await authenticateWorkerCredential(store, 'wkr_nope')).toBeNull();
    expect(await authenticateWorkerCredential(store, mintWorkerCredential().credential)).toBeNull();
  });

  it('refuses a revoked worker and one whose user may not act', async () => {
    const { store, minted } = await setup();
    store.setUserMayAct(USER, false);
    expect(await authenticateWorkerCredential(store, minted.credential)).toBeNull();
    store.setUserMayAct(USER, true);
    await store.revokeWorker({
      workerId: minted.workerId,
      ownerUserId: null,
      actorUserId: USER,
      now: new Date(),
    });
    expect(await authenticateWorkerCredential(store, minted.credential)).toBeNull();
  });
});
