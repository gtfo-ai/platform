/**
 * The first production derivation of a `WorkspaceSpec` (WP-15g).
 *
 * The cases that matter are the ones about what a run container may *do*: what it may reach, whether
 * it gets a git write credential, and how long its volume outlives it. Everything else the schema
 * already refuses.
 */
import { describe, expect, it } from 'vitest';
import { runSpecFixture } from '../runner/fixtures.js';
import {
  buildWorkspaceSpec,
  DEFAULT_WORKSPACE_KEEP_DAYS,
  egressHostOfRepoUrl,
  mirrorCacheKeyFor,
  PLATFORM_WORKSPACE_LIMITS,
  runIsReadOnly,
} from './spec.js';

const NOW = new Date('2026-09-12T10:00:00.000Z');

const build = (overrides: Partial<Parameters<typeof buildWorkspaceSpec>[0]> = {}) =>
  buildWorkspaceSpec({
    spec: runSpecFixture(),
    repoUrl: 'https://git.example.com/acme/api.git',
    defaultBranch: 'main',
    platformEgressHosts: ['api.anthropic.com'],
    now: NOW,
    ...overrides,
  });

describe('the egress allow-list', () => {
  it('is the platform’s hosts plus the git host, and nothing else', () => {
    // The whole list, positively: a test that asserted "contains the git host" would pass a spec
    // that also allowed the world.
    expect(build().egress).toEqual({
      hosts: ['api.anthropic.com', 'git.example.com'],
      connectPorts: [443],
    });
  });

  it('has no registry host, because discovery does not exist — so a run cannot install a package', () => {
    // technical/05 names "package registries for the project's ecosystems (from discovery)" as a
    // source of this list. Discovery has not been written, so the entry cannot be derived and the
    // list is deliberately short. Asserted rather than left to a reader of the docblock, because the
    // day discovery lands this case is the one that says what to change.
    expect(build().egress.hosts).not.toContain('registry.npmjs.org');
  });

  it('is only the git host in local provider mode, where nothing talks to a model host', () => {
    expect(build({ platformEgressHosts: [] }).egress.hosts).toEqual(['git.example.com']);
  });

  it.each([
    ['an https URL', 'https://git.example.com/acme/api.git', 'git.example.com'],
    ['a URL with a port', 'https://git.example.com:8443/acme/api.git', 'git.example.com'],
    ['scp style', 'git@git.example.com:acme/api.git', 'git.example.com'],
    ['ssh with a port', 'ssh://git@git.example.com:2222/acme/api', 'git.example.com'],
    ['an upper-case host', 'https://GIT.Example.COM/acme/api.git', 'git.example.com'],
  ])('reads the host from %s', (_label, url, host) => {
    expect(egressHostOfRepoUrl(url)).toBe(host);
  });

  it('refuses a repository URL with no host rather than allow-listing nothing', () => {
    // An egress list quietly missing the git host is a run that cannot push, failing three minutes
    // later with a TLS error that names no cause.
    expect(() => egressHostOfRepoUrl('/srv/acme.git')).toThrow(/names no host/);
    expect(() => build({ repoUrl: 'https:///acme/api.git' })).toThrow(/names no host/);
  });

  it('deduplicates a platform host that is also the git host', () => {
    expect(
      build({ platformEgressHosts: ['git.example.com', 'api.anthropic.com'] }).egress.hosts,
    ).toEqual(['git.example.com', 'api.anthropic.com']);
  });
});

describe('the credential a run gets', () => {
  it('is read off the run’s own tool policy, not a table of roles', () => {
    // BD-021: a read-only stage gets no git write token at all, so the broker mints nothing and
    // `cred.get` has nothing to answer. The honest question is whether the run can change the
    // checkout.
    expect(build().readOnly).toBe(false);
    expect(build({ spec: runSpecFixture({ tools: ['Read', 'Grep'] }) }).readOnly).toBe(true);
    expect(runIsReadOnly(runSpecFixture({ tools: ['Read', 'Edit'] }))).toBe(false);
    expect(runIsReadOnly(runSpecFixture({ tools: ['Read', 'Write'] }))).toBe(false);
    expect(runIsReadOnly(runSpecFixture({ tools: [] }))).toBe(true);
  });
});

describe('the rest of the spec', () => {
  it('carries TD-021’s limits and `runc`, and a project cannot change either', () => {
    // There is no key in `.agentic/config.yml` for any of these (Q62), so BD-025's
    // narrow-never-widen rule holds by construction rather than by a merge.
    expect(build().limits).toEqual(PLATFORM_WORKSPACE_LIMITS);
    expect(build().runtime).toBe('runc');
    expect(build({ runtime: 'runsc' }).runtime).toBe('runsc');
  });

  it('keeps the volume for three days and says so in ISO-8601', () => {
    expect(build().keepUntil).toBe('2026-09-15T10:00:00.000Z');
    expect(DEFAULT_WORKSPACE_KEEP_DAYS).toBe(3);
    expect(build({ keepDays: 14 }).keepUntil).toBe('2026-09-26T10:00:00.000Z');
  });

  it('names the mirror by the project rather than by the repository', () => {
    const spec = build();
    expect(spec.repo.cacheKey).toBe(mirrorCacheKeyFor(spec.projectId));
    // A directory name on a shared volume: the schema's own pattern, asserted here because the
    // consequence of breaking it is a mount path rather than a validation error.
    expect(spec.repo.cacheKey).toMatch(/^[a-z0-9][a-z0-9._-]{0,62}$/);
  });

  it('checks out the default branch unless a re-entry names the task branch', () => {
    expect(build().repo.checkoutBranch).toBeNull();
    expect(build({ checkoutBranch: 'agentic/acme-1' }).repo.checkoutBranch).toBe('agentic/acme-1');
  });

  it('puts no secret in the container’s environment', () => {
    // BD-025 §3: integration credentials never reach the container's env. The run's *own* env — the
    // one the CLI is spawned with, including the model credential in phase 1 — is `RunSpec.env` and
    // travels on the spawn frame instead.
    expect(build().env).toEqual({});
    expect(build({ containerEnv: { APP_PORT: '3000' } }).env).toEqual({ APP_PORT: '3000' });
  });

  it('validates what it built, so a bad input fails where the platform decided it', () => {
    expect(() => build({ platformEgressHosts: ['https://api.anthropic.com/v1'] })).toThrow();
    expect(() => build({ defaultBranch: '' })).toThrow();
  });
});
