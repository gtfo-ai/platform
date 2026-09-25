/**
 * The first production derivation of a `WorkspaceSpec` (WP-15g).
 *
 * The cases that matter are the ones about what a run container may *do*: what it may reach, whether
 * it gets a git write credential, and how long its volume outlives it. Everything else the schema
 * already refuses.
 */
import { TOOLS_BY_ROLE } from '@platform/application';
import { REVIEW_ONLY_TEMPLATE } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { runSpecFixture } from '../runner/fixtures.js';
import { RunCredentialBroker } from './broker.js';
import {
  buildWorkspaceSpec,
  DEFAULT_WORKSPACE_KEEP_DAYS,
  egressHostOfRepoUrl,
  mirrorCacheKeyFor,
  PLATFORM_WORKSPACE_LIMITS,
  runIsReadOnly,
  runNeedsCheckout,
  TOOLS_THAT_NEED_NO_CHECKOUT,
  TOOLS_THAT_OPEN_THE_CHECKOUT,
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

/**
 * WP-74, PROGRESS backlog 82: **no checkout** for a run with no file tool and no shell — never no
 * container. The rows are the planner's own, not a literal: `TOOLS_BY_ROLE` is this predicate's
 * input, and WP-54 rewrote it once already.
 */
describe('the checkout a run gets', () => {
  const specOf = (role: 'ask' | 'historian' | 'developer' | 'discovery') =>
    build({
      spec: runSpecFixture({ role, tools: [...TOOLS_BY_ROLE[role]] }),
      platformEgressHosts: ['api.anthropic.com'],
    });

  it('is none for an ask and for a history miner, whose tool rows are empty', () => {
    expect(TOOLS_BY_ROLE.ask).toEqual([]);
    expect(TOOLS_BY_ROLE.historian).toEqual([]);
    expect(specOf('ask').repo).toBeNull();
    expect(specOf('historian').repo).toBeNull();
  });

  /**
   * The other direction (rule 42), and discovery is the case that matters: it is stage-less like
   * the ask, and it reads its tree — a predicate keyed on "no stage" would have taken it away.
   */
  it('is kept for a developer and for discovery, which read their tree', () => {
    expect(specOf('developer').repo).toMatchObject({ url: 'https://git.example.com/acme/api.git' });
    expect(specOf('discovery').repo).toMatchObject({
      defaultBranch: 'main',
      cacheKey: mirrorCacheKeyFor(specOf('discovery').projectId),
    });
  });

  it('is decided by the tools, never the role: one shell is enough, and no tool at all is none', () => {
    expect(runNeedsCheckout(runSpecFixture({ role: 'ask', tools: ['Bash'] }))).toBe(true);
    expect(runNeedsCheckout(runSpecFixture({ role: 'developer', tools: [] }))).toBe(false);
    expect(runNeedsCheckout(runSpecFixture({ tools: ['Grep'] }))).toBe(true);
  });

  /**
   * Every tool any role holds is classified, on one side or the other. An unrecognised name counts
   * as *not* opening the checkout (the fail-closed direction), so without this a tool added to a
   * role's row would silently run on an empty directory.
   */
  it('classifies every tool a role holds, so a new one cannot fall through', () => {
    const held = [...new Set(Object.values(TOOLS_BY_ROLE).flat())].sort();
    const classified = [...TOOLS_THAT_OPEN_THE_CHECKOUT, ...TOOLS_THAT_NEED_NO_CHECKOUT];
    expect(held.filter((tool) => !classified.includes(tool))).toEqual([]);
    expect(
      TOOLS_THAT_OPEN_THE_CHECKOUT.filter((tool) => TOOLS_THAT_NEED_NO_CHECKOUT.includes(tool)),
    ).toEqual([]);
  });

  /** WP-74 criterion (8): the narrowing is a decision, asserted as the whole list. */
  it('narrows a run with no checkout to the model hosts alone: no git host on its egress list', () => {
    expect(specOf('ask').egress).toEqual({ hosts: ['api.anthropic.com'], connectPorts: [443] });
    expect(specOf('developer').egress.hosts).toEqual(['api.anthropic.com', 'git.example.com']);
  });

  it('does not read the repository URL for a run that will not clone it', () => {
    const ask = runSpecFixture({ role: 'ask', tools: [] });
    expect(build({ spec: ask, repoUrl: 'https:///acme/api.git' }).repo).toBeNull();
    expect(() => build({ repoUrl: 'https:///acme/api.git' })).toThrow(/names no host/);
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

  /**
   * **A review-only run mints nothing, so it has no run-scoped credential to leak** (WP-24 review
   * round 2, and the measurement behind the sentence in `pipeline/review-only.ts` and in
   * `pipeline/integrations.ts` § `reviewWrites.thread`).
   *
   * The thread a review posts is redacted against the **git binding's** credentials and TD-012's
   * patterns, and round 1 filed the gap that it is not redacted against a credential
   * `mintCredential` issued for the run. This walks the chain that decides whether such a
   * credential exists: `REVIEW_ONLY_TEMPLATE`'s one agent stage is the reviewer's,
   * `TOOLS_BY_ROLE.reviewer` has neither `Write` nor `Edit`, `runIsReadOnly` is therefore true,
   * `buildWorkspaceSpec` marks the workspace read-only, and `RunCredentialBroker.issue` returns
   * `null` **without calling the source** (BD-021). So on this build there is nothing run-scoped to
   * survive into a thread; the gap opens for a future role that both mints and posts.
   */
  it('is none for a review-only run: the reviewer writes nothing, so the broker mints nothing', async () => {
    const stage = REVIEW_ONLY_TEMPLATE.stages.find((entry) => entry.id === 'code_review');
    expect(stage?.kind).toBe('agent');
    const role = stage?.kind === 'agent' ? stage.role : null;
    expect(role).toBe('reviewer');
    const tools = TOOLS_BY_ROLE.reviewer;
    // Positively, not "does not contain Write": a list that grew an `Edit` is the thing to catch.
    // `Bash` since WP-54 (product/13's "tests only", PROGRESS backlog 39): a shell changes what the
    // run may *execute*, never whether the broker mints a credential — that is `Write`/`Edit`.
    expect(tools).toEqual(['Read', 'Glob', 'Grep', 'Bash']);

    const spec = runSpecFixture({
      stage: 'code_review',
      role: 'reviewer',
      mode: 'review_only',
      tools: [...tools],
      artifactType: 'ReviewVerdict',
    });
    expect(runIsReadOnly(spec)).toBe(true);
    expect(build({ spec }).readOnly).toBe(true);

    let mints = 0;
    const broker = new RunCredentialBroker({
      mint: async () => {
        mints += 1;
        throw new Error('a read-only run must not reach the credential source');
      },
      revoke: async () => {
        throw new Error('nothing was minted, so nothing can be revoked');
      },
    });
    const issued = await broker.issue({
      runId: spec.runId,
      project: 'acme/api',
      host: 'git.example.com',
      readOnly: build({ spec }).readOnly,
      branchPatterns: ['agentic/*'],
      ttlSeconds: 900,
    });
    expect(issued).toBeNull();
    expect(mints).toBe(0);
    // …and the workspace's own `cred.get` has nothing to be answered with either.
    expect(broker.answer(spec.runId, 'git.example.com')).toBeNull();
    expect(broker.liveCount).toBe(0);
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
    expect(spec.repo?.cacheKey).toBe(mirrorCacheKeyFor(spec.projectId));
    // A directory name on a shared volume: the schema's own pattern, asserted here because the
    // consequence of breaking it is a mount path rather than a validation error.
    expect(spec.repo?.cacheKey).toMatch(/^[a-z0-9][a-z0-9._-]{0,62}$/);
  });

  it('checks out the default branch unless a re-entry names the task branch', () => {
    expect(build().repo?.checkoutBranch).toBeNull();
    expect(build({ checkoutBranch: 'agentic/acme-1' }).repo?.checkoutBranch).toBe('agentic/acme-1');
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
