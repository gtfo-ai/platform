import { WorkspaceError } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { type CarriedRunCredential, RunCredentialBroker } from './broker.js';

const RUN = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER = '9f8a1c22-6f3f-4c07-8f61-3a2f6b19bb01';
const HOST = 'gitlab.example.com';
const SECRET = 'glpat-FAKE-000000000000000000';

const carried = (overrides: Partial<CarriedRunCredential> = {}): CarriedRunCredential => ({
  host: HOST,
  username: 'oauth2',
  password: `${SECRET}-1`,
  scope: 'push',
  expiresAt: '2026-09-11T00:00:00.000Z',
  ...overrides,
});

const holding = (overrides: Partial<CarriedRunCredential> = {}, readOnly = false) => {
  const broker = new RunCredentialBroker();
  const credential = broker.hold({ runId: RUN, readOnly, credential: carried(overrides) });
  return { broker, credential };
};

describe('run credential broker', () => {
  it('holds the carried credential and answers for the git host with exactly it', () => {
    const { broker, credential } = holding();
    expect(credential).toEqual({ host: HOST, username: 'oauth2', password: `${SECRET}-1` });
    expect(broker.answer(RUN, HOST)).toEqual(credential);
    expect(broker.credentialFor(RUN)).toEqual(credential);
    expect(broker.scopeOf(RUN)).toBe('push');
  });

  it('holds a read credential for a read-only run (the read scope’s producer, backlog 133 (2))', () => {
    const { broker } = holding({ scope: 'read' }, true);
    expect(broker.credentialFor(RUN)?.password).toBe(`${SECRET}-1`);
    expect(broker.scopeOf(RUN)).toBe('read');
  });

  /** Rule 42: the refusal above is paired with the acceptance that differs from it by one field. */
  it('refuses a push credential for a read-only run, and holds nothing', () => {
    const broker = new RunCredentialBroker();
    expect(() =>
      broker.hold({ runId: RUN, readOnly: true, credential: carried({ scope: 'push' }) }),
    ).toThrow(WorkspaceError);
    expect(broker.liveCount).toBe(0);
    expect(broker.answer(RUN, HOST)).toBeNull();
  });

  it.each([
    ['an empty password', { password: '' }],
    ['a blank password', { password: '   ' }],
    ['an empty username', { username: '' }],
  ])('refuses %s (standing rule 18)', (_label, overrides) => {
    const broker = new RunCredentialBroker();
    expect(() =>
      broker.hold({ runId: RUN, readOnly: false, credential: carried(overrides) }),
    ).toThrow(/empty credential is not a credential/);
  });

  /**
   * Standing rule 43. `evil.example.com` is refused by `endsWith`, by `includes`, by a case fold
   * and by exact matching alike, so it is not a test of anything. Each case below is named for the
   * wrong implementation it separates — mutate `host !== held.host` to that implementation and
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
  ])('refuses %s', (_label, host) => {
    const { broker } = holding();
    expect(broker.answer(RUN, host)).toBeNull();
  });

  it('answers nothing for a run it holds nothing for', () => {
    const { broker } = holding();
    expect(broker.answer(OTHER, HOST)).toBeNull();
  });

  it('stops answering the moment the credential is forgotten', () => {
    const { broker } = holding();
    expect(broker.forget(RUN)).toBe(true);
    expect(broker.answer(RUN, HOST)).toBeNull();
    expect(broker.credentialFor(RUN)).toBeNull();
    expect(broker.scopeOf(RUN)).toBeNull();
    expect(broker.liveCount).toBe(0);
    expect(broker.forget(RUN)).toBe(false);
  });

  it('keeps two runs apart, so one workspace cannot ask for another’s token', () => {
    const broker = new RunCredentialBroker();
    broker.hold({ runId: RUN, readOnly: false, credential: carried() });
    broker.hold({
      runId: OTHER,
      readOnly: false,
      credential: carried({ password: `${SECRET}-2` }),
    });
    expect(broker.answer(RUN, HOST)?.password).toBe(`${SECRET}-1`);
    expect(broker.answer(OTHER, HOST)?.password).toBe(`${SECRET}-2`);
    broker.forget(RUN);
    expect(broker.answer(RUN, HOST)).toBeNull();
    expect(broker.answer(OTHER, HOST)?.password).toBe(`${SECRET}-2`);
  });
});
