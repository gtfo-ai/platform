import { describe, expect, it } from 'vitest';
import { RunCredentialBroker, type RunCredentialSource } from './broker.js';

const RUN = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const HOST = 'gitlab.example.com';
const SECRET = 'glpat-FAKE-000000000000000000';

const source = () => {
  const minted: unknown[] = [];
  const revoked: unknown[] = [];
  let counter = 0;
  const port: RunCredentialSource = {
    async mint(request) {
      minted.push(request);
      counter += 1;
      return {
        username: 'agentic-bot',
        value: `${SECRET}-${counter}`,
        expiresAt: '2026-09-11T00:00:00.000Z',
        revokeId: `tokens/${counter}`,
      };
    },
    async revoke(credential) {
      revoked.push(credential);
    },
  };
  return { port, minted, revoked };
};

const issue = async (overrides: { readOnly?: boolean } = {}) => {
  const harness = source();
  const broker = new RunCredentialBroker(harness.port);
  const credential = await broker.issue({
    runId: RUN,
    project: 'acme/web',
    host: HOST,
    readOnly: overrides.readOnly ?? false,
    branchPatterns: ['agentic/*'],
    ttlSeconds: 86_400,
  });
  return { ...harness, broker, credential };
};

describe('run credential broker', () => {
  it('mints a push credential scoped to agentic/* and answers for the git host', async () => {
    const { broker, minted, credential } = await issue();
    expect(minted).toEqual([
      { project: 'acme/web', scope: 'push', branchPatterns: ['agentic/*'], ttlSeconds: 86_400 },
    ]);
    expect(credential).toEqual({ host: HOST, username: 'agentic-bot', password: `${SECRET}-1` });
    expect(broker.answer(RUN, HOST)).toEqual(credential);
  });

  it('mints nothing at all for a read-only stage (BD-021)', async () => {
    const { broker, minted, credential } = await issue({ readOnly: true });
    expect(credential).toBeNull();
    expect(minted).toEqual([]);
    expect(broker.answer(RUN, HOST)).toBeNull();
  });

  /**
   * Standing rule 43. `evil.example.com` is refused by `endsWith`, by `includes`, by a case fold
   * and by exact matching alike, so it is not a test of anything. Each case below is named for the
   * wrong implementation it separates — mutate `host !== issued.host` to that implementation and
   * exactly the named test fails.
   */
  it.each([
    ['a prefixed host, which endsWith admits', 'evil-gitlab.example.com'],
    ['a suffixed host, which startsWith admits', 'gitlab.example.com.evil.test'],
    ['a containing host, which includes admits', 'x.gitlab.example.com.y'],
    ['a subdomain, which a suffix match admits', 'ci.gitlab.example.com'],
    ['the upper-case spelling, which a case fold admits', 'GITLAB.example.com'],
    ['the DNS-absolute spelling, which a trailing-dot strip admits', 'gitlab.example.com.'],
    ['an unrelated host', 'evil.example.com'],
  ])('refuses %s', async (_label, host) => {
    const { broker } = await issue();
    expect(broker.answer(RUN, host)).toBeNull();
  });

  it('answers nothing for a run it never issued to', async () => {
    const { broker } = await issue();
    expect(broker.answer('9f8a1c22-6f3f-4c07-8f61-3a2f6b19bb01', HOST)).toBeNull();
  });

  it('stops answering the moment the credential is revoked', async () => {
    const { broker, revoked } = await issue();
    expect(broker.answer(RUN, HOST)).not.toBeNull();
    await broker.revoke(RUN);
    expect(revoked).toEqual([{ value: `${SECRET}-1`, revokeId: 'tokens/1' }]);
    expect(broker.answer(RUN, HOST)).toBeNull();
    expect(broker.liveCount).toBe(0);
  });

  /**
   * The window this test exists for was found by mutation, not by design: deleting the run from
   * the map in `revoke`'s `finally` makes `issued.revoked` *look* redundant — both
   * `if (issued.revoked)` and setting the flag before the provider call survived every other test
   * in this file. They are not redundant. Revocation is a network call, and a `cred.get` arriving
   * while it is in flight is the one moment the map still holds a credential the platform has
   * already decided to destroy. The revocation here never settles, so the window is held open
   * deterministically — no timing, no sleep.
   */
  it('stops answering while the revocation is still in flight', async () => {
    const harness = source();
    let releaseRevoke: (() => void) | undefined;
    const slow: RunCredentialSource = {
      mint: harness.port.mint,
      revoke: () =>
        new Promise<void>((resolve) => {
          releaseRevoke = resolve;
        }),
    };
    const broker = new RunCredentialBroker(slow);
    await broker.issue({
      runId: RUN,
      project: 'acme/web',
      host: HOST,
      readOnly: false,
      branchPatterns: ['agentic/*'],
      ttlSeconds: 60,
    });
    expect(broker.answer(RUN, HOST)).not.toBeNull();

    const pending = broker.revoke(RUN);
    // The provider call has started and has not returned. The credential is still in the map.
    expect(broker.liveCount).toBe(1);
    expect(broker.answer(RUN, HOST)).toBeNull();
    expect(broker.credentialFor(RUN)).toBeNull();

    releaseRevoke?.();
    await pending;
    expect(broker.answer(RUN, HOST)).toBeNull();
  });

  it('revokes once, however many times it is asked', async () => {
    const { broker, revoked } = await issue();
    await broker.revoke(RUN);
    await broker.revoke(RUN);
    expect(revoked).toHaveLength(1);
  });

  /**
   * The order matters and is asserted, not described: the broker marks the run refused *before*
   * the provider call, so a revocation that throws still leaves the door shut. A broker that
   * revoked first and marked second would keep handing out a push token every time the provider
   * was briefly unreachable.
   */
  it('stops answering even when the revocation itself fails', async () => {
    const harness = source();
    const failing: RunCredentialSource = {
      mint: harness.port.mint,
      async revoke() {
        throw new Error('gitlab is down');
      },
    };
    const broker = new RunCredentialBroker(failing);
    await broker.issue({
      runId: RUN,
      project: 'acme/web',
      host: HOST,
      readOnly: false,
      branchPatterns: ['agentic/*'],
      ttlSeconds: 60,
    });
    await expect(broker.revoke(RUN)).rejects.toThrow('gitlab is down');
    expect(broker.answer(RUN, HOST)).toBeNull();
  });

  it('keeps two runs' + " apart, so one workspace cannot ask for another's token", async () => {
    const harness = source();
    const broker = new RunCredentialBroker(harness.port);
    const other = '9f8a1c22-6f3f-4c07-8f61-3a2f6b19bb01';
    for (const runId of [RUN, other]) {
      await broker.issue({
        runId,
        project: 'acme/web',
        host: HOST,
        readOnly: false,
        branchPatterns: ['agentic/*'],
        ttlSeconds: 60,
      });
    }
    expect(broker.answer(RUN, HOST)?.password).toBe(`${SECRET}-1`);
    expect(broker.answer(other, HOST)?.password).toBe(`${SECRET}-2`);
    await broker.revoke(RUN);
    expect(broker.answer(RUN, HOST)).toBeNull();
    expect(broker.answer(other, HOST)?.password).toBe(`${SECRET}-2`);
  });
});
