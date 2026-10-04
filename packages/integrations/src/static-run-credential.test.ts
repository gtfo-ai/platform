/**
 * The static run credential's rules (TD-028 decision 13 item 1, WP-137), over GitLab's declaration —
 * the one shipped provider that has one.
 */
import { encodeOpenSshKey, FAKE_DEPLOY_KEY, RFC8032_TEST1 } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { GITLAB_STATIC_RUN_CREDENTIAL } from './providers/gitlab/index.js';
import {
  declaresDedicatedRunCredential,
  deployKeyRunCredentialOf,
  deployKeyWriteIssues,
  expiryInstantOf,
  staticRunCredentialConfigIssues,
  staticRunCredentialOf,
  staticRunCredentialWriteIssues,
  withoutRunOnlyFields,
} from './static-run-credential.js';

const SUPPORT = GITLAB_STATIC_RUN_CREDENTIAL;
const NOW = new Date('2026-10-03T12:00:00.000Z');
const RUN_TOKEN = 'glpat-FAKE-static-run-token-not-real-01';
const API_TOKEN = 'glpat-FAKE-binding-api-token-not-real-01';

const staticConfig = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  base_url: 'https://gitlab.example.test',
  run_credential: 'static',
  run_token_username: 'agentic-runner',
  run_token_expires_at: '2026-12-01',
  mint_credentials: false,
  ...overrides,
});

const paths = (issues: readonly { readonly path: string }[]): string[] =>
  issues.map((issue) => issue.path);

describe('the static run credential (WP-137, TD-028 decision 13)', () => {
  it('asks nothing of an integration that does not declare static', () => {
    expect(staticRunCredentialConfigIssues(SUPPORT, { mint_credentials: true })).toEqual([]);
    expect(staticRunCredentialWriteIssues(SUPPORT, { run_credential: 'minted' }, {}, NOW)).toEqual(
      [],
    );
    expect(staticRunCredentialOf(SUPPORT, { token: API_TOKEN })).toBeUndefined();
    expect(staticRunCredentialOf(undefined, staticConfig())).toBeUndefined();
  });

  it('refuses static beside minting, and static without a username or a date', () => {
    expect(
      paths(staticRunCredentialConfigIssues(SUPPORT, staticConfig({ mint_credentials: true }))),
    ).toEqual(['mint_credentials']);
    expect(
      paths(
        staticRunCredentialConfigIssues(
          SUPPORT,
          staticConfig({ run_token_username: undefined, run_token_expires_at: '2026-13-40' }),
        ),
      ),
    ).toEqual(['run_token_username', 'run_token_expires_at']);
  });

  it('refuses at the write: no run token, the API token as the run token, past and too far', () => {
    const write = (config: Record<string, unknown>, secrets: Record<string, string>) =>
      staticRunCredentialWriteIssues(SUPPORT, config, secrets, NOW);
    expect(write(staticConfig(), { token: API_TOKEN, run_token: RUN_TOKEN })).toEqual([]);
    expect(paths(write(staticConfig(), { token: API_TOKEN }))).toEqual(['run_token']);
    const same = write(staticConfig(), { token: API_TOKEN, run_token: API_TOKEN });
    expect(paths(same)).toEqual(['run_token']);
    expect(same[0]?.message).toMatch(/own API token/);
    expect(JSON.stringify(same)).not.toContain(API_TOKEN);
    expect(
      paths(write(staticConfig({ run_token_expires_at: '2026-10-03' }), { run_token: RUN_TOKEN })),
    ).toEqual(['run_token_expires_at']);
    // 90 days ahead of noon on 3 October is 1 January; the 2nd is past it.
    expect(
      write(staticConfig({ run_token_expires_at: '2026-12-31' }), { run_token: RUN_TOKEN }),
    ).toEqual([]);
    const far = write(staticConfig({ run_token_expires_at: '2027-01-02' }), {
      run_token: RUN_TOKEN,
    });
    expect(paths(far)).toEqual(['run_token_expires_at']);
    expect(far[0]?.message).toMatch(/more than 90 days/);
  });

  it('reads what the run-credential path refuses on, and never the API token as a value', () => {
    const read = staticRunCredentialOf(SUPPORT, {
      ...staticConfig(),
      token: API_TOKEN,
      run_token: RUN_TOKEN,
    });
    expect(read).toEqual({
      owner: 'dedicated_user',
      username: 'agentic-runner',
      value: RUN_TOKEN,
      expiresAt: '2026-12-01T00:00:00.000Z',
      declaredExpiry: '2026-12-01',
      sameAsApiToken: false,
      refusal: null,
    });
    expect(
      staticRunCredentialOf(SUPPORT, { ...staticConfig(), token: API_TOKEN, run_token: API_TOKEN })
        ?.sameAsApiToken,
    ).toBe(true);
    const broken = staticRunCredentialOf(SUPPORT, staticConfig({ mint_credentials: true }));
    expect(broken?.value).toBe('');
    expect(broken?.refusal).toMatch(/mint_credentials: true/);
  });

  it('reads an expiry as the start of its day in UTC, and nothing else as a date', () => {
    expect(expiryInstantOf('2026-12-01')).toBe('2026-12-01T00:00:00.000Z');
    expect(expiryInstantOf('2026-02-30')).toBeNull();
    expect(expiryInstantOf('2026-12-01T00:00:00Z')).toBeNull();
    expect(expiryInstantOf('')).toBeNull();
  });
});

/**
 * WP-141 (TD-028 decision 13a): whose token it is. `dedicated_user` is the default and decision 13
 * unchanged; `operator` is read through, applies only to `static`, and changes the username's words.
 */
describe('the run token’s owner (WP-141, TD-028 decision 13a)', () => {
  it('reads dedicated_user by default and operator when declared', () => {
    expect(staticRunCredentialOf(SUPPORT, { ...staticConfig(), run_token: RUN_TOKEN })?.owner).toBe(
      'dedicated_user',
    );
    expect(
      staticRunCredentialOf(SUPPORT, {
        ...staticConfig({ run_token_owner: 'operator' }),
        run_token: RUN_TOKEN,
      })?.owner,
    ).toBe('operator');
    expect(
      staticRunCredentialWriteIssues(
        SUPPORT,
        staticConfig({ run_token_owner: 'operator' }),
        { token: API_TOKEN, run_token: RUN_TOKEN },
        NOW,
      ),
      'every other rule of decision 13 holds for the operator’s token, and this one passes them',
    ).toEqual([]);
  });

  it('refuses operator on an integration that hands runs no static token', () => {
    const issues = staticRunCredentialConfigIssues(SUPPORT, {
      run_credential: 'minted',
      run_token_owner: 'operator',
    });
    expect(paths(issues)).toEqual(['run_token_owner']);
    expect(issues[0]?.message).toMatch(/applies only to `run_credential: static`/);
    expect(
      staticRunCredentialConfigIssues(SUPPORT, { run_token_owner: 'dedicated_user' }),
      'the default says nothing and is refused nowhere',
    ).toEqual([]);
  });

  it('names whose username is missing', () => {
    const [issue] = staticRunCredentialConfigIssues(
      SUPPORT,
      staticConfig({ run_token_owner: 'operator', run_token_username: undefined }),
    );
    expect(issue?.message).toMatch(/the operator the run token belongs to/);
  });
});

describe('a deploy key (WP-146, TD-028 decision 13b item 1)', () => {
  const deployKeyConfig = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    base_url: 'https://gitlab.com',
    run_credential: 'deploy_key',
    run_ssh_public_key: FAKE_DEPLOY_KEY.publicKey,
    mint_credentials: false,
    ...overrides,
  });
  const secrets = { token: API_TOKEN, run_ssh_private_key: FAKE_DEPLOY_KEY.privateKey };

  it('admits an unencrypted Ed25519 key on GitLab.com whose public key is the declared one', () => {
    expect(staticRunCredentialConfigIssues(SUPPORT, deployKeyConfig())).toEqual([]);
    expect(deployKeyWriteIssues(SUPPORT, deployKeyConfig(), secrets)).toEqual([]);
    const loaded = deployKeyRunCredentialOf(SUPPORT, { ...deployKeyConfig(), ...secrets });
    expect(loaded?.refusal).toBeNull();
    expect(loaded?.route?.connectHost).toBe('altssh.gitlab.com');
    expect(loaded?.route?.connectPort).toBe(443);
    expect(declaresDedicatedRunCredential(SUPPORT, deployKeyConfig())).toBe(true);
    expect(staticRunCredentialOf(SUPPORT, deployKeyConfig())).toBeUndefined();
  });

  it('refuses a self-managed host by name, minting beside it, and a public key that is not Ed25519', () => {
    const issues = staticRunCredentialConfigIssues(
      SUPPORT,
      deployKeyConfig({
        base_url: 'https://gitlab.example.test',
        mint_credentials: true,
        run_ssh_public_key: 'ssh-rsa AAAAB3NzaC1yc2E',
      }),
    );
    expect(paths(issues)).toEqual(['mint_credentials', 'run_ssh_public_key', 'run_credential']);
    expect(issues[2]?.message).toBe(
      'SSH deploy-key runs reach gitlab.com through altssh.gitlab.com:443 only; a self-managed host needs its SSH port admitted by the egress sidecar, which this build does not do (TD-028 decision 13b)',
    );
  });

  it('refuses at the write: no key, a passphrase, another type, a mismatched public key, a run token beside it', () => {
    const write = (over: Record<string, string>) =>
      deployKeyWriteIssues(SUPPORT, deployKeyConfig(), { token: API_TOKEN, ...over });
    expect(paths(write({}))).toEqual(['run_ssh_private_key']);
    const encrypted = encodeOpenSshKey({
      seed: RFC8032_TEST1.seed,
      publicKey: RFC8032_TEST1.publicKey,
      cipher: 'aes256-ctr',
    });
    expect(write({ run_ssh_private_key: encrypted })[0]?.message).toMatch(/passphrase/);
    const rsa = encodeOpenSshKey({
      seed: RFC8032_TEST1.seed,
      publicKey: RFC8032_TEST1.publicKey,
      type: 'ssh-rsa',
    });
    expect(write({ run_ssh_private_key: rsa })[0]?.message).toMatch(/Ed25519 only/);
    const other = encodeOpenSshKey({
      seed: Buffer.alloc(32, 5),
      publicKey: Buffer.alloc(32, 5),
    });
    // The embedded public half is wrong for this seed, so the container itself is refused first.
    expect(write({ run_ssh_private_key: other })[0]?.path).toBe('run_ssh_private_key');
    const mismatched = deployKeyWriteIssues(
      SUPPORT,
      deployKeyConfig({
        run_ssh_public_key:
          'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf',
      }),
      secrets,
    );
    expect(mismatched[0]?.message).toMatch(/not the private key’s/);
    expect(
      paths(write({ run_ssh_private_key: FAKE_DEPLOY_KEY.privateKey, run_token: RUN_TOKEN })),
    ).toEqual(['run_token']);
    // The other direction: a static integration with a sealed private key beside its run token.
    expect(
      paths(
        deployKeyWriteIssues(SUPPORT, staticConfig(), {
          run_token: RUN_TOKEN,
          run_ssh_private_key: FAKE_DEPLOY_KEY.privateKey,
        }),
      ),
    ).toEqual(['run_ssh_private_key']);
  });

  it('refuses a static run token at use when a private key is sealed beside it', () => {
    const loaded = staticRunCredentialOf(SUPPORT, {
      ...staticConfig(),
      token: API_TOKEN,
      run_token: RUN_TOKEN,
      run_ssh_private_key: FAKE_DEPLOY_KEY.privateKey,
    });
    expect(loaded?.refusal).toMatch(/both sealed/);
  });

  it('carries every fault to the load as a refusal, never as no credential', () => {
    const loaded = deployKeyRunCredentialOf(SUPPORT, { ...deployKeyConfig(), token: API_TOKEN });
    expect(loaded?.privateKey).toBe('');
    expect(loaded?.refusal).toMatch(/needs the private key itself/);
    const selfManaged = deployKeyRunCredentialOf(SUPPORT, {
      ...deployKeyConfig({ base_url: 'https://gitlab.example.test' }),
      ...secrets,
    });
    expect(selfManaged?.route).toBeNull();
    expect(selfManaged?.refusal).toMatch(/self-managed host/);
  });

  it('keeps the private key out of what an adapter is built from', () => {
    expect(
      withoutRunOnlyFields(SUPPORT, { token: API_TOKEN, run_ssh_private_key: 'x', run_token: 'y' }),
    ).toEqual({ token: API_TOKEN });
  });
});
