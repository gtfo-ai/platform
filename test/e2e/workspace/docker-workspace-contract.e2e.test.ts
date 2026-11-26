/**
 * The shared `WorkspaceProvider` contract suite against a real daemon — the same suite the fake runs
 * in the contract tier.
 *
 * Moved whole out of `docker-workspace.e2e.test.ts` (BACKLOG 1654), whose docblock carries what the
 * three files are built around and which images they run; `test/e2e/support/docker-workspace-suite.ts`
 * is the fixture they share and says why they may run at once.
 */
import { randomUUID } from 'node:crypto';
import { runWorkspaceProviderContractSuite } from '../../contract/support/workspace/provider-suite.js';
import {
  type DockerFixture,
  docker,
  exportPath,
  plantInWorkspace,
  probeUnderRunContainerConfig,
  relaxControlDirectoryForHost,
} from '../support/docker-workspace.js';
import { useDockerFixture } from '../support/docker-workspace-suite.js';

let fixture: DockerFixture;
const { specFor } = useDockerFixture((started) => {
  fixture = started;
});

/**
 * The shared `WorkspaceProvider` contract suite, against a real daemon.
 *
 * The same file the fake runs in the contract tier. Running it twice is the whole mechanism that
 * keeps the fake from drifting (standing rule 23): a promise taught to one implementation and not
 * the other fails here.
 *
 * It is slow — every case builds a network, two volumes, four helper containers and two
 * long-lived ones — and that is the price of the fake being trustworthy for WP-15.
 */
runWorkspaceProviderContractSuite('DockerWorkspaceProvider', {
  supportsPurge: true,
  // What the daemon was asked to do to this run's container, recorded by the engine itself rather
  // than inferred from the port's return values.
  containerOps: (handle) => fixture.engine.opsFor(handle.containerId),
  /**
   * Read from **inside a container running under the run's own configuration**, so the answer is
   * about the workspace volume rather than about anything this process holds. An absent file is
   * `null`, not a throw: `cat` exits non-zero and the suite asks the question in both directions.
   */
  readWorkspaceFile: async (handle, relativePath) => {
    const probe = await probeUnderRunContainerConfig(
      fixture.engine,
      handle.containerId,
      `cat /work/repo/${relativePath}`,
    );
    return probe.exitCode === 0 ? probe.output : null;
  },
  provider: async () => {
    // A mirror per case: the suite has a case that asserts `create` refuses *before* the mirror
    // exists, and a shared fixture would already have one. The fake gets a fresh provider per
    // case; this is how the Docker runner gets the same freshness.
    const runId = randomUUID();
    const spec = specFor({ runId, repo: { cacheKey: `acme-${runId}` } });
    let created: string | null = null;
    return {
      provider: {
        updateMirror: (input) => fixture.provider.updateMirror(input),
        // The suite's own provision, passed through: it is what the WP-279 refusals are about.
        create: async (input, provision) => {
          const handle = await fixture.provider.create(input, provision);
          created = handle.runId;
          // Q51, admitted: this process is not uid 1000, and `attach` reads a 0600 file owned by
          // it. The real mode is measured in its own case in `docker-workspace.e2e.test.ts`, before anything relaxes it.
          await relaxControlDirectoryForHost(fixture, handle.runId);
          return handle;
        },
        attach: (handle) => fixture.provider.attach(handle),
        cliEnvironment: (handle) => fixture.provider.cliEnvironment(handle),
        listExistingProtectedPaths: (handle, request) =>
          fixture.provider.listExistingProtectedPaths(handle, request),
        kill: (handle) => fixture.provider.kill(handle),
        destroy: (handle) => fixture.provider.destroy(handle),
        export: (handle, request, credential) =>
          fixture.provider.export(handle, request, credential),
        extendRetention: (handle, keepUntil) => fixture.provider.extendRetention(handle, keepUntil),
        listLabelledRuns: () => fixture.provider.listLabelledRuns(),
        destroyRun: (runId) => fixture.provider.destroyRun(runId),
        purgeExpired: (now) => fixture.provider.purgeExpired(now),
      },
      spec,
      tarballPath: exportPath(fixture, `${spec.runId}.tar`),
      plantEscapingLink: async (handle) => {
        await plantInWorkspace(
          fixture,
          handle.volumeName,
          'ln -sf ../../../../etc/passwd /work/repo/escape',
        );
      },
      cleanup: async () => {
        if (created !== null) {
          await docker(['rm', '-f', '-v', `ws-${created}`, `egress-${created}`], {
            allowFailure: true,
          });
          await docker(['network', 'rm', `run-${created}`], { allowFailure: true });
          // `hold-<run>` is WP-27's retention hold: a real volume on the daemon, so a case that
          // extends a window and then fails would otherwise leave one behind for ever.
          await docker(
            ['volume', 'rm', '-f', `ws-${created}`, `egress-${created}`, `hold-${created}`],
            { allowFailure: true },
          );
        }
      },
    };
  },
});
