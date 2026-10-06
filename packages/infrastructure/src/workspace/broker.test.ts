import { type Logger, WorkspaceError } from '@platform/application';
import { describe, expect, it } from 'vitest';
import {
  type CarriedRunCredential,
  type CredentialQuestion,
  isRepositoryPath,
  RunCredentialBroker,
  repositoryPathMatches,
} from './broker.js';

const RUN = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OTHER = '9f8a1c22-6f3f-4c07-8f61-3a2f6b19bb01';
const HOST = 'gitlab.example.com';
const SECRET = 'glpat-FAKE-000000000000000000';
/** The project's repository path, as `repositoryPathOf(projects.repo_url)` answers it. */
const REPO = 'acme/api';

/** The question the helper relays for the project's own `origin` — git sends `.git` with it. */
const ask = (host: string, path: string | null = `${REPO}.git`): CredentialQuestion => ({
  host,
  path,
});

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
  const credential = broker.hold({
    runId: RUN,
    readOnly,
    credential: carried(overrides),
    repositoryPath: REPO,
  });
  return { broker, credential };
};

describe('run credential broker', () => {
  it('holds the carried credential and answers for the git host with exactly it', () => {
    const { broker, credential } = holding();
    expect(credential).toEqual({ host: HOST, username: 'oauth2', password: `${SECRET}-1` });
    expect(broker.answer(RUN, ask(HOST))).toEqual(credential);
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
    expect(broker.answer(RUN, ask(HOST))).toBeNull();
  });

  /** WP-137 (TD-028 decision 13): the one push credential a read-only run may hold. */
  it('holds a static run credential for a read-only run with its push scope', () => {
    const broker = new RunCredentialBroker();
    broker.hold({
      runId: RUN,
      readOnly: true,
      credential: carried({ scope: 'push', source: 'static' }),
      repositoryPath: REPO,
    });
    expect(broker.scopeOf(RUN)).toBe('push');
    expect(broker.answer(RUN, ask(HOST))?.password).toBe(`${SECRET}-1`);
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
    expect(broker.answer(RUN, ask(host))).toBeNull();
  });

  it('answers nothing for a run it holds nothing for', () => {
    const { broker } = holding();
    expect(broker.answer(OTHER, ask(HOST))).toBeNull();
  });

  it('stops answering the moment the credential is forgotten', () => {
    const { broker } = holding();
    expect(broker.forget(RUN)).toBe(true);
    expect(broker.answer(RUN, ask(HOST))).toBeNull();
    expect(broker.credentialFor(RUN)).toBeNull();
    expect(broker.scopeOf(RUN)).toBeNull();
    expect(broker.liveCount).toBe(0);
    expect(broker.forget(RUN)).toBe(false);
  });

  it('keeps two runs apart, so one workspace cannot ask for another’s token', () => {
    const broker = new RunCredentialBroker();
    broker.hold({ runId: RUN, readOnly: false, credential: carried(), repositoryPath: REPO });
    broker.hold({
      runId: OTHER,
      readOnly: false,
      credential: carried({ password: `${SECRET}-2` }),
      repositoryPath: REPO,
    });
    expect(broker.answer(RUN, ask(HOST))?.password).toBe(`${SECRET}-1`);
    expect(broker.answer(OTHER, ask(HOST))?.password).toBe(`${SECRET}-2`);
    broker.forget(RUN);
    expect(broker.answer(RUN, ask(HOST))).toBeNull();
    expect(broker.answer(OTHER, ask(HOST))?.password).toBe(`${SECRET}-2`);
  });
});

/**
 * Backlog 481: **the repository, not just the host.** A static run token can reach every
 * repository its owner can, so the exact host was not a bound on it; `answer` now answers the
 * project's repository path only. Every refusal below is paired (standing rule 42) with the
 * acceptance one byte away, and each is named for the looser rule that would admit it — mutate
 * `repositoryPathMatches` to that rule and exactly the named case fails.
 */
describe('the repository path a cred.get is answered for', () => {
  const recording = () => {
    const lines: { fields: Record<string, unknown>; message: string }[] = [];
    const record = (fields: Record<string, unknown>, message: string): void => {
      lines.push({ fields, message });
    };
    const logger: Logger = { debug: record, info: record, warn: record, error: record };
    return { lines, logger };
  };

  it.each([
    ['the path with .git, as an https origin sends it', 'acme/api.git'],
    ['the path without .git', 'acme/api'],
  ])('answers %s', (_label, path) => {
    const { broker, credential } = holding();
    expect(broker.answer(RUN, ask(HOST, path))).toEqual(credential);
  });

  it.each([
    ['another repository in the same group', 'acme/other.git'],
    ['the same name in another group', 'other/api.git'],
    ['a repository below the project, which a prefix match admits', 'acme/api/sub.git'],
    ['a repository named after it, which a prefix match admits', 'acme/api-fork.git'],
    ['a group above the project, which a suffix match admits', 'evil/acme/api.git'],
    ['the path as a substring, which includes admits', 'x/acme/api.git/y'],
    ['another case, which a case fold admits', 'Acme/API.git'],
    ['an upper-case suffix, which a case-insensitive .git strip admits', 'acme/api.GIT'],
    ['a doubled suffix, which a repeated .git strip admits', 'acme/api.git.git'],
    ['a trailing slash, which slash trimming admits', 'acme/api.git/'],
    ['a leading slash, which slash trimming admits', '/acme/api.git'],
    ['a doubled slash, which slash collapsing admits', 'acme//api.git'],
    ['an encoded slash, which percent-decoding admits', 'acme%2Fapi.git'],
    ['a dot segment, which path resolution admits', 'acme/./api.git'],
    ['a climb back, which path resolution admits', 'acme/x/../api.git'],
    ['a climb out, which path resolution resolves elsewhere', 'acme/api.git/../../other/repo.git'],
    ['a query, which dropping the query admits', 'acme/api.git?x=1'],
    ['a fragment, which dropping it admits', 'acme/api.git#x'],
    ['a trailing space, which trimming admits', 'acme/api.git '],
    ['the bare group', 'acme'],
  ])('refuses %s', (_label, path) => {
    const { broker } = holding();
    expect(broker.answer(RUN, ask(HOST, path))).toBeNull();
  });

  it('refuses a question with no path — git sends none when useHttpPath is off', () => {
    const { broker } = holding();
    expect(broker.answer(RUN, ask(HOST, null))).toBeNull();
    // The same question with the path is answered: the refusal is the missing path alone.
    expect(broker.answer(RUN, ask(HOST))).not.toBeNull();
  });

  it('answers nothing when it holds no repository path, so the launcher’s copy answers no workspace', () => {
    const broker = new RunCredentialBroker();
    broker.hold({ runId: RUN, readOnly: false, credential: carried() });
    expect(broker.answer(RUN, ask(HOST))).toBeNull();
    // …while its own helpers still get the credential.
    expect(broker.credentialFor(RUN)?.password).toBe(`${SECRET}-1`);
  });

  it('answers each run for its own repository only', () => {
    const broker = new RunCredentialBroker();
    broker.hold({ runId: RUN, readOnly: false, credential: carried(), repositoryPath: REPO });
    broker.hold({
      runId: OTHER,
      readOnly: false,
      credential: carried({ password: `${SECRET}-2` }),
      repositoryPath: 'acme/web',
    });
    expect(broker.answer(RUN, ask(HOST, 'acme/web.git'))).toBeNull();
    expect(broker.answer(OTHER, ask(HOST, 'acme/web.git'))?.password).toBe(`${SECRET}-2`);
    expect(broker.answer(OTHER, ask(HOST))).toBeNull();
  });

  it('logs each refusal with its reason and never the path the workspace sent', () => {
    const { lines, logger } = recording();
    const broker = new RunCredentialBroker(logger);
    broker.hold({ runId: RUN, readOnly: false, credential: carried(), repositoryPath: REPO });
    // A workspace can put anything in the path, the token included.
    const planted = `acme/${SECRET}-1.git`;
    broker.answer(RUN, ask(HOST, planted));
    broker.answer(RUN, ask(HOST, null));
    broker.answer(RUN, ask('evil.example.com'));
    const warned = lines.filter((line) => line.message.startsWith('refused'));
    expect(warned.map((line) => line.fields['reason'])).toEqual([
      'another_repository',
      'no_path',
      'another_host',
    ]);
    expect(warned.every((line) => line.fields['run_id'] === RUN)).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it.each([
    ['a trailing .git', 'acme/api.git'],
    ['a leading slash', '/acme/api'],
    ['a trailing slash', 'acme/api/'],
    ['an empty segment', 'acme//api'],
    ['a dot-dot segment', 'acme/../api'],
    ['a dot segment', './api'],
    ['a percent-encoded character', 'acme/my%20repo'],
    ['a space', 'acme/my repo'],
    ['a query', 'acme/api?x'],
    ['nothing', ''],
  ])('refuses to hold a repository path with %s', (_label, repositoryPath) => {
    const broker = new RunCredentialBroker();
    expect(isRepositoryPath(repositoryPath)).toBe(false);
    expect(() =>
      broker.hold({ runId: RUN, readOnly: false, credential: carried(), repositoryPath }),
    ).toThrow(/repository path/);
    expect(broker.liveCount).toBe(0);
  });

  it.each(['acme/api', 'group/subgroup/project', 'Acme.Corp/my_repo-2', 'a'])(
    'holds %s',
    (repositoryPath) => {
      expect(isRepositoryPath(repositoryPath)).toBe(true);
    },
  );

  it('matches exactly the path and the path with .git', () => {
    expect(repositoryPathMatches('acme/api', 'acme/api')).toBe(true);
    expect(repositoryPathMatches('acme/api', 'acme/api.git')).toBe(true);
    expect(repositoryPathMatches('acme/api', 'acme/ap')).toBe(false);
    expect(repositoryPathMatches('acme/api', 'acme/apigit')).toBe(false);
  });
});

/** WP-146 (TD-028 decision 13b item 2): a deploy key is held with its route and never answered. */
describe('a deploy key in the broker', () => {
  const SSH = {
    publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf',
    httpsPrefix: 'https://gitlab.com/',
    sshPrefix: 'ssh://git@altssh.gitlab.com:443/',
    connectHost: 'altssh.gitlab.com',
    connectPort: 443,
    hostKeyAlias: 'gitlab.com',
    knownHosts: [
      'gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf',
    ],
  };
  const KEY = carried({
    username: 'git',
    password: 'FAKE-openssh-private-key-0001',
    source: 'deploy_key',
  });

  // The exact host *and* the project's path since backlog 481; the name is PROGRESS's citation.
  it('never answers the workspace’s cred.get with the key, even for the exact host', () => {
    const broker = new RunCredentialBroker();
    broker.hold({ runId: RUN, readOnly: false, credential: KEY, ssh: SSH, repositoryPath: REPO });
    expect(broker.answer(RUN, ask(HOST))).toBeNull();
    // The platform side's own helpers get it, with the route they take.
    expect(broker.credentialFor(RUN)).toEqual({
      host: HOST,
      username: 'git',
      password: 'FAKE-openssh-private-key-0001',
      ssh: SSH,
    });
  });

  it('holds it for a read-only run (it cannot be narrowed), and refuses it without its route', () => {
    const broker = new RunCredentialBroker();
    expect(() =>
      broker.hold({ runId: RUN, readOnly: true, credential: KEY, ssh: SSH }),
    ).not.toThrow();
    expect(() => broker.hold({ runId: OTHER, readOnly: false, credential: KEY })).toThrow(
      WorkspaceError,
    );
    expect(() =>
      broker.hold({ runId: OTHER, readOnly: false, credential: carried(), ssh: SSH }),
    ).toThrow(/held with its SSH route and nothing else is/);
  });
});
