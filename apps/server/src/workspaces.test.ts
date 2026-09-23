/**
 * The one setting that decides whether a process runs agents — WP-53, TD-028 decision 5.
 *
 * Three states, and the middle one is the reason this file exists: **both** variables composes a
 * provisioner, **neither** composes none, and **one** is a configuration mistake that must not be
 * spelled the same way as "no launcher" (standing rule 18). An operator who set `APP_LAUNCHER_URL`
 * and forgot the token would otherwise get a silent instance that queues every agent stage and
 * reports nothing about why.
 */
import { silentLogger } from '@platform/application';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { composeRunWorkspaces, createRunWorkspaceProjectSource } from './workspaces.js';

const TOKEN = 'FAKE-launcher-token-0000000000000000';

const poolWith = (rows: Record<string, unknown>[]): pg.Pool =>
  ({ query: async () => ({ rows }) }) as unknown as pg.Pool;

const compose = (launcherUrl: string | null, launcherToken: string | null) =>
  composeRunWorkspaces({
    pool: poolWith([]),
    launcherUrl,
    launcherToken,
    controlRoot: '/run/agentic/ctl',
    modelEgressHosts: ['api.anthropic.com'],
    logger: silentLogger,
  });

describe('composing the run workspaces', () => {
  it('composes a provisioner when the launcher is configured', () => {
    expect(compose('http://launcher:7780', TOKEN)).toBeDefined();
  });

  it('composes none when no launcher is configured, which is the `app` service’s state', () => {
    // Not an error: TD-028 decision 5 ships a topology where the API container deliberately has no
    // launcher. What it must *also* do is not subscribe `stage.execute`, which `pipeline.ts` reads
    // off the same condition.
    expect(compose(null, null)).toBeUndefined();
  });

  it.each([
    ['a URL with no token', 'http://launcher:7780', null],
    ['a token with no URL', null, TOKEN],
  ])('refuses %s, naming the missing half', (_label, url, token) => {
    expect(() => compose(url, token)).toThrow(/APP_LAUNCHER_(URL|TOKEN)/);
  });

  it('refuses a launcher URL that is not an http address', () => {
    // The client's own check, reached at composition rather than at the first run: TD-028 decision
    // 7's "says so by name at composition".
    expect(() => compose('file:///etc/passwd', TOKEN)).toThrow();
  });
});

describe('what the platform tells the launcher about a project', () => {
  it('derives the project path and the git host from `projects.repo_url`', async () => {
    const source = createRunWorkspaceProjectSource(
      poolWith([
        { repo_url: 'https://git.example.com:8443/acme/api.git', default_branch: 'trunk' },
      ]),
    );
    const project = await source.forRun({
      projectId: '33333333-3333-4333-8333-333333333333',
      runId: '11111111-1111-4111-8111-111111111111',
    } as never);
    expect(project).toEqual({
      repoUrl: 'https://git.example.com:8443/acme/api.git',
      defaultBranch: 'trunk',
      projectPath: 'acme/api',
      // Lowercased, port removed — the same derivation the egress allow-list uses, so the host the
      // credential is scoped to and the host the container may reach cannot disagree.
      gitHost: 'git.example.com',
      branchPatterns: ['agentic/*'],
      containerEnv: {},
    });
  });

  it('refuses a run whose project has no row rather than cloning nothing', async () => {
    const source = createRunWorkspaceProjectSource(poolWith([]));
    await expect(
      source.forRun({
        projectId: '33333333-3333-4333-8333-333333333333',
        runId: '11111111-1111-4111-8111-111111111111',
      } as never),
    ).rejects.toThrow(/has no row/);
  });
});
