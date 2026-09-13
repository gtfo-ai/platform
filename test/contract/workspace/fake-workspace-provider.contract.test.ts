/**
 * The shared `WorkspaceProvider` contract suite, run against the fake.
 *
 * The Docker adapter runs the same file against a real daemon in
 * `test/e2e/workspace/docker-workspace.e2e.test.ts`. This tier is the one every later work package
 * inherits, so a promise that holds here and not there is exactly the drift standing rule 1 is
 * about — which is why there is one suite and two runners rather than two suites.
 */
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { workspace } from '@platform/infrastructure';
import { PLATFORM_SKILLS } from '@platform/prompts';
import { runWorkspaceProviderContractSuite } from '../support/workspace/provider-suite.js';

/**
 * The fake's event log, filtered to the two operations the ordering case is about.
 *
 * One provider per case, so the log holds this run only; it is still filtered by run id, because a
 * seam that happened to be right for a one-run harness would be wrong the day a case creates two.
 */
const containerOps = (
  provider: workspace.FakeWorkspaceProvider,
  runId: string,
): readonly ('stop' | 'remove')[] => {
  const ops: ('stop' | 'remove')[] = [];
  for (const event of provider.events) {
    if (event.runId === runId && (event.kind === 'stop' || event.kind === 'remove')) {
      ops.push(event.kind);
    }
  }
  return ops;
};

let current: workspace.FakeWorkspaceProvider | null = null;

runWorkspaceProviderContractSuite('FakeWorkspaceProvider', {
  supportsPurge: true,
  containerOps: (handle) => {
    if (current === null) {
      // Never `[]`: an empty answer is what the suite's ordering case is written to refuse, and a
      // seam that returns it when it does not know would turn a broken harness into a pass.
      throw new Error('containerOps was asked before the harness built a provider');
    }
    return containerOps(current, handle.runId);
  },
  readWorkspaceFile: async (handle, relativePath) => {
    if (current === null) {
      throw new Error('readWorkspaceFile was asked before the harness built a provider');
    }
    return current.readWorkspaceFile(handle.runId, relativePath);
  },
  provider: async () => {
    const dir = await workspace.shortTempDir('agentic-ws-contract-');
    const provider = new workspace.FakeWorkspaceProvider({
      controlRoot: path.join(dir, 'ctl'),
      // The shipped files, so the shared suite's skills case is about the real corpus in both
      // tiers — this one and the Docker runner's, which reads them out of a real container.
      skills: PLATFORM_SKILLS,
    });
    current = provider;
    const spec = workspace.workspaceSpecFixture({ runId: randomUUID() });
    return {
      provider,
      spec,
      tarballPath: path.join(dir, 'export.tar'),
      plantEscapingLink: async (handle) => {
        provider.plant(handle.runId, {
          name: 'repo/escape',
          type: 'symlink',
          linkname: '../../../etc/passwd',
        });
      },
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    };
  },
});
