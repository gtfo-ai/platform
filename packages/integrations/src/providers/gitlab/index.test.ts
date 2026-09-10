/**
 * The registration and the binding configuration.
 *
 * The registry's own checks are guards rather than bookkeeping — a `secretFields` name that does
 * not exist in `configSchema` means the field is stored unencrypted and printed in a config diff —
 * so this file registers the provider for real instead of asserting the shape of an object literal.
 */
import { agentToolingSchema } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { createIntegrationRegistry } from '../../registry.js';
import { gitlabConfigSchema } from './config.js';
import { gitlabAgentTooling, gitlabProviderRegistration, gitlabRateLimitPolicy } from './index.js';

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
      'token',
      'webhook_secret_token',
      'webhook_signing_token',
    ]);
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
