/**
 * The registration and the binding configuration.
 *
 * The registry's own checks are guards rather than bookkeeping — a `secretFields` name that does
 * not exist in `configSchema` means the field is stored unencrypted and printed in a config diff —
 * so this file registers the provider for real instead of asserting the shape of an object literal.
 */
import { agentToolingSchema, noSecretsRedactor } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { createIntegrationRegistry } from '../../registry.js';
import { gitlabConfigSchema } from './config.js';
import {
  GITLAB_COMMIT_IDENTITY,
  GITLAB_STATIC_RUN_CREDENTIAL,
  gitlabAdapterInput,
  gitlabAgentTooling,
  gitlabProviderRegistration,
  gitlabRateLimitPolicy,
} from './index.js';

describe('gitlabProviderRegistration', () => {
  it('registers as a git provider and is retrievable by type', () => {
    const registry = createIntegrationRegistry([gitlabProviderRegistration]);
    expect(registry.get('git', 'gitlab').displayName).toContain('GitLab');
    expect(registry.list('git').map((entry) => entry.id)).toEqual(['gitlab']);
  });

  it('names only secret fields that exist in the config schema', () => {
    // The registry throws when they do not; registering it here is the assertion.
    expect(() => createIntegrationRegistry([gitlabProviderRegistration])).not.toThrow();
    for (const field of gitlabProviderRegistration.secretFields) {
      expect(Object.keys(gitlabConfigSchema.shape)).toContain(field);
    }
  });

  it('marks every credential-bearing field as a secret', () => {
    expect([...gitlabProviderRegistration.secretFields].sort()).toEqual([
      // WP-146: the deploy key's private half (TD-028 decision 13b item 1).
      'run_ssh_private_key',
      'run_token',
      'token',
      'webhook_secret_token',
      'webhook_signing_token',
    ]);
  });

  /**
   * WP-137 (TD-028 decision 13 item 3): the static run token is a declared secret — stripped from
   * `GET /api/integrations`, sealed only through `secret_refs`, redacted by every loader — and the
   * adapter is built **without** it, in the config and in the secrets alike.
   */
  it('declares the static run credential and builds the adapter without the run token', () => {
    expect(gitlabProviderRegistration.staticRunCredential).toEqual(GITLAB_STATIC_RUN_CREDENTIAL);
    const planted = 'glpat-FAKE-static-run-token-not-real-0001';
    const input = gitlabAdapterInput({
      integrationId: '00000000-0000-4000-8000-0000000000a9',
      config: {
        base_url: 'https://gitlab.example.test',
        run_credential: 'static',
        run_token: planted,
      },
      secrets: { token: 'FAKE-api-token-0000000000', run_token: planted },
      redactor: noSecretsRedactor(),
    });
    expect(JSON.stringify(input)).not.toContain(planted);
    expect(input.secrets).toEqual({ token: 'FAKE-api-token-0000000000' });
    expect(input.config).toEqual({
      base_url: 'https://gitlab.example.test',
      run_credential: 'static',
    });
  });

  it('cannot be fetched as another type', () => {
    const registry = createIntegrationRegistry([gitlabProviderRegistration]);
    expect(() => registry.get('task_management', 'gitlab')).toThrow(/is a "git" provider/);
  });

  it('declares agent tooling by name only, never by value (BD-002, BD-025)', () => {
    const parsed = agentToolingSchema.parse(gitlabAgentTooling);
    expect(parsed.cli?.command).toBe('glab');
    expect(parsed.env.variables.map((variable) => variable.name)).toEqual([
      'GITLAB_TOKEN',
      'GITLAB_HOST',
    ]);
    expect(
      parsed.env.variables.find((variable) => variable.name === 'GITLAB_TOKEN')?.secret,
      'the token variable must be marked secret or it ends up in a log line',
    ).toBe(true);
    const serialised = JSON.stringify(parsed);
    for (const forbidden of ['"value"', '"token"', '"password"', '"secret_value"']) {
      expect(serialised, `a tooling spec must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('asks for a fraction of the documented gitlab.com budget', () => {
    // 2,000 authenticated requests a minute is ~33/s; a self-managed instance sets its own, lower.
    expect(gitlabRateLimitPolicy.refillPerSecond).toBeLessThan(33);
    expect(gitlabRateLimitPolicy.capacity).toBeGreaterThan(0);
    expect(gitlabRateLimitPolicy.maxConcurrent).toBeGreaterThan(0);
  });
});

describe('gitlabConfigSchema', () => {
  it('accepts a gitlab.com binding and a self-managed one alike', () => {
    expect(gitlabConfigSchema.parse({ base_url: 'https://gitlab.com' }).base_url).toBe(
      'https://gitlab.com',
    );
    expect(
      gitlabConfigSchema.parse({ base_url: 'https://code.example.test/gitlab' }).base_url,
    ).toBe('https://code.example.test/gitlab');
  });

  it('refuses a base URL that already carries /api/v4', () => {
    // `…/api/v4/api/v4/projects` 404s in a way that reads like a missing project.
    expect(() => gitlabConfigSchema.parse({ base_url: 'https://gitlab.com/api/v4' })).toThrow();
    expect(() => gitlabConfigSchema.parse({ base_url: 'https://gitlab.com/api/v4/' })).toThrow();
  });

  it('refuses a trailing slash', () => {
    expect(() => gitlabConfigSchema.parse({ base_url: 'https://gitlab.com/' })).toThrow();
  });

  it('refuses an unknown key rather than dropping it (CLAUDE.md: boundary schemas are strict)', () => {
    expect(() =>
      gitlabConfigSchema.parse({ base_url: 'https://gitlab.com', typo_project: 'acme/api' }),
    ).toThrow();
  });

  it('defaults minting off, because gitlab.com Free cannot do it', () => {
    const config = gitlabConfigSchema.parse({ base_url: 'https://gitlab.com' });
    expect(config.mint_credentials).toBe(false);
    expect(config.webhook_tolerance_seconds).toBe(300);
    expect(config.read_access_level).toBe(20);
    expect(config.push_access_level).toBe(30);
  });

  describe('commit_author_name and commit_author_email (owner request, 2026-11-20)', () => {
    const BASE = { base_url: 'https://gitlab.com' };
    const EMAIL =
      'service_account_group_1234_0123456789abcdef0123456789abcdef@noreply.gitlab.example';
    const issuesOf = (config: Record<string, unknown>) => {
      const parsed = gitlabConfigSchema.safeParse({ ...BASE, ...config });
      return parsed.success
        ? []
        : parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          }));
    };

    it('accepts both, and neither — absent is the platform’s own identity', () => {
      expect(issuesOf({ commit_author_name: 'Agentic', commit_author_email: EMAIL })).toEqual([]);
      expect(
        issuesOf({ commit_author_name: 'O\'Brien "Bot" Žluťoučký 🤖', commit_author_email: EMAIL }),
      ).toEqual([]);
      expect(issuesOf({})).toEqual([]);
      expect(issuesOf({ commit_author_name: null, commit_author_email: null })).toEqual([]);
    });

    it('refuses one without the other, naming the missing field', () => {
      expect(issuesOf({ commit_author_name: 'Agentic' })).toEqual([
        { path: 'commit_author_email', message: expect.stringContaining('`commit_author_email`') },
      ]);
      expect(issuesOf({ commit_author_email: EMAIL })).toEqual([
        { path: 'commit_author_name', message: expect.stringContaining('`commit_author_name`') },
      ]);
    });

    it.each([
      [
        'a newline in the name',
        { commit_author_name: 'Agentic\nEvil', commit_author_email: EMAIL },
      ],
      [
        'a carriage return in the name',
        { commit_author_name: 'Agentic\rx', commit_author_email: EMAIL },
      ],
      [
        'angle brackets in the name',
        { commit_author_name: 'A <b@c.de>', commit_author_email: EMAIL },
      ],
      ['a NUL in the name', { commit_author_name: 'A\u0000b', commit_author_email: EMAIL }],
      ['an empty name', { commit_author_name: '', commit_author_email: EMAIL }],
      [
        'a name of 129 characters',
        { commit_author_name: 'a'.repeat(129), commit_author_email: EMAIL },
      ],
      [
        'an address with no domain dot',
        { commit_author_name: 'A', commit_author_email: 'a@localhost' },
      ],
      [
        'an address with a space',
        { commit_author_name: 'A', commit_author_email: 'a b@example.test' },
      ],
      [
        'an address past 254 characters',
        { commit_author_name: 'A', commit_author_email: `${'a'.repeat(250)}@x.de` },
      ],
    ])('refuses %s', (_label, config) => {
      expect(issuesOf(config).length).toBeGreaterThan(0);
    });

    it('is declared as the registration’s commit identity, account-level and never a secret', () => {
      expect(gitlabProviderRegistration.commitIdentity).toEqual(GITLAB_COMMIT_IDENTITY);
      for (const field of ['commit_author_name', 'commit_author_email']) {
        expect(gitlabProviderRegistration.accountOnlyFields).toContain(field);
        expect(gitlabProviderRegistration.secretFields).not.toContain(field);
      }
    });
  });

  it('refuses an access level GitLab does not define', () => {
    expect(() =>
      gitlabConfigSchema.parse({ base_url: 'https://gitlab.com', push_access_level: 35 }),
    ).toThrow();
  });

  it('refuses a project that is not namespace/project', () => {
    expect(() =>
      gitlabConfigSchema.parse({ base_url: 'https://gitlab.com', project: 'api' }),
    ).toThrow();
    expect(
      gitlabConfigSchema.parse({ base_url: 'https://gitlab.com', project: 'acme/group/api' })
        .project,
    ).toBe('acme/group/api');
  });
});
