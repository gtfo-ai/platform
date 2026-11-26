/**
 * The preamble the three files of the workspace e2e share: one {@link DockerFixture} per file,
 * started before its first case and cleaned up after its last, and the two ways a case asks it for a
 * run.
 *
 * The cases were one file, `test/e2e/workspace/docker-workspace.e2e.test.ts`, until its 239–330 s
 * set the floor of whichever `e2e-fake-claude` part the duration balance gave it (BACKLOG 1654).
 * They are now three, moved whole `describe` by whole `describe`, so the balance can place them
 * apart:
 *
 *  - `docker-workspace.e2e.test.ts` — the lifecycle, the hardening flags, teardown, retention,
 *    attach, egress and the control volume;
 *  - `docker-workspace-git.e2e.test.ts` — mount escapes, the export, one project's mirror (WP-75)
 *    and a minted run credential against a credentialled git server (WP-76);
 *  - `docker-workspace-contract.e2e.test.ts` — the shared `WorkspaceProvider` contract suite.
 *
 * Each file starts its own fixture (its own network, repository container and control volume), so
 * two of them may run at once on one daemon: every object a fixture's provider creates carries its
 * instance label (WP-128, WP-132), and every daemon-wide verb a case calls — `listLabelledRuns`,
 * `destroyRun`, `purgeExpired` — answers only that instance's objects (WP-103, WP-157), which is
 * what `harness-volumes.e2e.test.ts` already relied on beside the single file.
 */
import { randomUUID } from 'node:crypto';
import type { WorkspaceSpec } from '@platform/application';
import { workspace } from '@platform/infrastructure';
import { PLATFORM_SKILLS } from '@platform/prompts';
import { afterAll, beforeAll } from 'vitest';
import { type DockerFixture, startDockerFixture } from './docker-workspace.js';

/** A create's two arguments with the **shipped** skills the spec names (WP-279: the request's bytes). */
export const shipped = (spec: WorkspaceSpec) => workspace.provisioned(spec, PLATFORM_SKILLS);

type SpecOverrides = Parameters<typeof workspace.workspaceSpecFixture>[0];

/**
 * Registers the file's fixture hooks and hands the started fixture to `bind`, which a file uses to
 * set its own `fixture` binding — so the cases read `fixture` exactly as they did in one file.
 */
export const useDockerFixture = (bind: (fixture: DockerFixture) => void) => {
  let fixture: DockerFixture | undefined;
  const started = (): DockerFixture => {
    if (fixture === undefined) {
      throw new Error('the Docker fixture is read before its beforeAll started it');
    }
    return fixture;
  };

  beforeAll(async () => {
    fixture = await startDockerFixture();
    bind(fixture);
  }, 300_000);

  afterAll(async () => {
    await fixture?.cleanup();
  }, 120_000);

  const specFor = (overrides: SpecOverrides = {}) =>
    workspace.workspaceSpecFixture({
      runId: randomUUID(),
      ...overrides,
      repo: { url: started().repoUrl, cacheKey: 'acme', ...overrides.repo },
    });

  const startRun = async (overrides: SpecOverrides = {}) => {
    const spec = specFor(overrides);
    await started().provider.updateMirror({
      projectId: spec.projectId,
      repo: spec.repo,
      credential: null,
    });
    return { spec, handle: await started().provider.create(...shipped(spec)) };
  };

  return { specFor, startRun };
};
