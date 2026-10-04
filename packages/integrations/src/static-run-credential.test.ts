/**
 * The static run credential's rules (TD-028 decision 13 item 1, WP-137), over GitLab's declaration —
 * the one shipped provider that has one.
 */
import { describe, expect, it } from 'vitest';
import { GITLAB_STATIC_RUN_CREDENTIAL } from './providers/gitlab/index.js';
import {
  expiryInstantOf,
  staticRunCredentialConfigIssues,
  staticRunCredentialOf,
  staticRunCredentialWriteIssues,
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
