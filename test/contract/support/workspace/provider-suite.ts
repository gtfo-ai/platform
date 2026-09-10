/**
 * The **WorkspaceProvider** contract suite (technical/10 contract tier).
 *
 * Two implementations run it: `FakeWorkspaceProvider` in the contract tier
 * (`test/contract/workspace/fake-workspace-provider.contract.test.ts`) and
 * `DockerWorkspaceProvider` against a real daemon in `test/e2e/workspace/docker-workspace.e2e.test.ts`.
 * A Kubernetes provider (TD-021 § Consequences) joins without a line changing here.
 *
 * ## Why a shared suite and not two test files
 *
 * The fake is what every later work package's unit tier believes about workspaces, and a fake that
 * drifts from the adapter launders a bug into a pass (standing rule 1). A promise taught to the
 * fake alone is a provider-local promise (standing rule 23): WP-09 taught its git fake that a
 * foreign credential handle yields `not_found` and left the shared suite untouched, so a future
 * adapter would have passed the whole suite while doing the opposite. Everything a caller may rely
 * on therefore lives here.
 *
 * ## What this suite cannot assert, and where it is asserted instead
 *
 * The hardening flags *buy* properties — a write outside the workspace fails, a
 * capability-requiring syscall fails, there is no route off the run network — and none of those
 * can be attempted without a kernel. The suite asserts the create body both implementations
 * produce; the properties are demonstrated only in the e2e, which says so at each assertion. That
 * split is deliberate and is the fake's divergence 1.
 */

import { readFile } from 'node:fs/promises';
import type {
  WorkspaceExportRequest,
  WorkspaceHandle,
  WorkspaceProvider,
  WorkspaceSpec,
} from '@platform/application';
import { WorkspaceError } from '@platform/application';
import { workspace } from '@platform/infrastructure';
import { describe, expect, it } from 'vitest';

export interface WorkspaceProviderContractContext {
  /** A fresh provider and a fresh spec per case: every case creates its own run. */
  readonly provider: () => Promise<{
    readonly provider: WorkspaceProvider;
    readonly spec: WorkspaceSpec;
    /** An absolute path on the *test's* filesystem where an export tarball may be written. */
    readonly tarballPath: string;
    /**
     * Plants a symlink in the workspace whose target escapes it, so the export's link filter has
     * something to refuse. The Docker runner writes a real link; the fake plants a tar entry.
     */
    readonly plantEscapingLink: (handle: WorkspaceHandle) => Promise<void>;
    /** Removes whatever the case created. */
    readonly cleanup: () => Promise<void>;
  }>;
  /** Whether this runner can express "the workspace volume was purged". */
  readonly supportsPurge: boolean;
  /**
   * The stop and remove operations this run's **container** received, in the order the
   * implementation performed them.
   *
   * A seam rather than an inference, because the ordering cannot be observed from the port's own
   * return values: after `destroy`, `attach` rejects whichever order the two happened in, so a
   * suite that asserted only the rejection would certify nothing (standing rule 10). The fake
   * reads its own event log; the Docker runner reads a recording `DockerEngine`, so what it
   * reports is the sequence of calls that went to the daemon.
   */
  readonly containerOps: (handle: WorkspaceHandle) => readonly ('stop' | 'remove')[];
}

const exportRequest = (tarballPath: string | null): WorkspaceExportRequest => ({
  branch: 'agentic/task-1',
  tarballPath,
  commitMessage: 'wip: contract suite',
});

export const runWorkspaceProviderContractSuite = (
  name: string,
  context: WorkspaceProviderContractContext,
): void => {
  describe(`${name} — WorkspaceProvider contract`, () => {
    const withRun = async (
      body: (harness: {
        provider: WorkspaceProvider;
        spec: WorkspaceSpec;
        handle: WorkspaceHandle;
        tarballPath: string;
        plantEscapingLink: (handle: WorkspaceHandle) => Promise<void>;
      }) => Promise<void>,
    ): Promise<void> => {
      const harness = await context.provider();
      try {
        await harness.provider.updateMirror({
          projectId: harness.spec.projectId,
          repo: harness.spec.repo,
          credential: null,
        });
        const handle = await harness.provider.create(harness.spec);
        await body({ ...harness, handle });
      } finally {
        await harness.cleanup();
      }
    };

    it('creates a workspace whose objects are all named after the run', async () => {
      await withRun(async ({ spec, handle }) => {
        expect(handle.runId).toBe(spec.runId);
        expect(handle.volumeName).toBe(`ws-${spec.runId}`);
        expect(handle.controlSubPath).toBe(spec.runId);
        expect(handle.keepUntil).toBe(spec.keepUntil);
        expect(handle.containerId.length).toBeGreaterThan(0);
      });
    });

    it('refuses to create a workspace before the mirror exists', async () => {
      const harness = await context.provider();
      try {
        await expect(harness.provider.create(harness.spec)).rejects.toBeInstanceOf(WorkspaceError);
      } finally {
        await harness.cleanup();
      }
    });

    it('refuses a run id that is not a uuid, and does so before creating anything', async () => {
      const harness = await context.provider();
      try {
        await expect(
          harness.provider.create({ ...harness.spec, runId: '../other-run' }),
        ).rejects.toMatchObject({ code: 'invalid_spec' });
      } finally {
        await harness.cleanup();
      }
    });

    it('attaches to a running workspace with a control socket and a token', async () => {
      await withRun(async ({ provider, handle, spec }) => {
        const attachment = await provider.attach(handle);
        expect(attachment.workdir).toBe('/work/repo');
        expect(attachment.socketPath).toContain(spec.runId);
        expect(attachment.socketPath.endsWith('ctl.sock')).toBe(true);
        // TD-025 §1: an absent, empty or short token is refused by the shim at construction, so a
        // provider that handed one over would produce a run that never starts.
        expect(attachment.token.length).toBeGreaterThanOrEqual(24);
      });
    });

    it('refuses to attach after the workspace has been killed', async () => {
      await withRun(async ({ provider, handle }) => {
        await provider.kill(handle);
        await expect(provider.attach(handle)).rejects.toMatchObject({ code: 'not_found' });
      });
    });

    it('kills and destroys idempotently', async () => {
      await withRun(async ({ provider, handle }) => {
        await provider.kill(handle);
        await provider.kill(handle);
        await provider.destroy(handle);
        await provider.destroy(handle);
      });
    });

    /**
     * The ordering half of WP-13's third obligation. The property — that ending the container's
     * pid namespace is what takes a *detached grandchild* with it — needs a kernel and is
     * demonstrated in the e2e; what every implementation must promise is that no path ends a run
     * by removing a container it did not stop.
     */
    it('stops the run container as part of destroying it', async () => {
      await withRun(async ({ provider, handle }) => {
        await provider.destroy(handle);
        await expect(provider.attach(handle)).rejects.toBeInstanceOf(WorkspaceError);
      });
    });

    /**
     * And in that order, which the case above cannot see: a rejected `attach` is what both orders
     * produce (standing rule 10). Removing a container that was never stopped hands it to the
     * daemon's `SIGKILL` with no grace period, and on the paths where the shim exited first, "the
     * shim exited" is not "the workspace's processes are gone" (`research/12`). It was pinned for
     * the Docker adapter alone until WP-14's round 2; a promise only one implementation is held to
     * is a provider-local promise (standing rule 23).
     */
    it('stops the run container before it removes it', async () => {
      await withRun(async ({ provider, handle }) => {
        await provider.destroy(handle);
        // Asserted as the whole sequence rather than as an ordering of indices, so an
        // implementation that reported *nothing* — the way this seam fails silently — cannot pass.
        expect(context.containerOps(handle)).toEqual(['stop', 'remove']);
      });
    });

    it('keeps the workspace volume when the run is destroyed, because retention owns it', async () => {
      await withRun(async ({ provider, handle, tarballPath }) => {
        await provider.destroy(handle);
        // The export reads the volume, so a successful export after `destroy` is the assertion
        // that the volume survived — and it is also the real take-over sequence.
        const result = await provider.export(handle, exportRequest(tarballPath), null);
        expect(result.tarballBytes).toBeGreaterThan(0);
      });
    });

    it('exports a tarball of the workspace without .git or node_modules', async () => {
      await withRun(async ({ provider, handle, tarballPath }) => {
        const result = await provider.export(handle, exportRequest(tarballPath), null);
        expect(result.branch).toBe('agentic/task-1');
        expect(result.tarballPath).toBe(tarballPath);
        const entries = workspace.parseTar(await readFile(tarballPath)).map((entry) => entry.name);
        // "The export contains the workspace" is a claim, so it is read back rather than assumed.
        expect(entries.some((entry) => entry.endsWith('README.md'))).toBe(true);
        expect(entries.some((entry) => entry.split('/').includes('.git'))).toBe(false);
        expect(entries.some((entry) => entry.split('/').includes('node_modules'))).toBe(false);
      });
    });

    it('drops a symlink that points outside the workspace, and counts it', async () => {
      await withRun(async ({ provider, handle, tarballPath, plantEscapingLink }) => {
        await plantEscapingLink(handle);
        const result = await provider.export(handle, exportRequest(tarballPath), null);
        expect(result.droppedLinks).toBeGreaterThanOrEqual(1);
        const entries = workspace.parseTar(await readFile(tarballPath));
        // An archive is unpacked somewhere else; a link that escapes there is the export handing
        // over a write outside the workspace.
        expect(entries.some((entry) => entry.name.endsWith('escape'))).toBe(false);
      });
    });

    it('keeps a workspace whose retention window has not closed', async () => {
      await withRun(async ({ provider, handle }) => {
        await provider.destroy(handle);
        const report = await provider.purgeExpired(new Date('2020-01-01T00:00:00.000Z'));
        const mine = report.volumes.find((entry) => entry.volumeName === handle.volumeName);
        expect(mine).toMatchObject({ removed: false, keptReason: 'not_expired' });
      });
    });

    it('removes a workspace whose retention window has closed', async () => {
      if (!context.supportsPurge) {
        return;
      }
      await withRun(async ({ provider, handle, tarballPath }) => {
        await provider.destroy(handle);
        const report = await provider.purgeExpired(new Date('2099-01-01T00:00:00.000Z'));
        expect(report.volumes).toContainEqual(
          expect.objectContaining({ volumeName: handle.volumeName, removed: true }),
        );
        // And the data is really gone: the export that succeeded a moment ago now cannot.
        await expect(provider.export(handle, exportRequest(tarballPath), null)).rejects.toThrow();
      });
    });

    it('never touches a volume it did not label', async () => {
      await withRun(async ({ provider }) => {
        const report = await provider.purgeExpired(new Date('2099-01-01T00:00:00.000Z'));
        for (const entry of report.volumes) {
          expect(entry.volumeName.startsWith('ws-')).toBe(true);
        }
      });
    });
  });
};
