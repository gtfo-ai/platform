/**
 * `FakeWorkspaceProvider` — the unit tier's `WorkspaceProvider`, and WP-15's.
 *
 * The pipeline's e2e cannot start a container per stage, so this object is what every later work
 * package's tests will believe about workspaces. Standing rule 1 therefore governs it: **it may be
 * stricter than the Docker provider and never kinder.** Where it cannot be either — where it
 * simply has no kernel — the difference is written down below *and* pinned by an assertion, because
 * documenting a divergence is necessary and not sufficient (standing rule 12: hard-coding
 * `mergeable: true` in WP-07's git fake passed 39 of 39 tests).
 *
 * Both implementations run the same shared suite
 * (`test/contract/support/workspace/provider-suite.ts`): the fake in the contract tier, the Docker
 * one against a real daemon in `test/e2e/workspace/docker-workspace.e2e.test.ts`. Anything the
 * suite asserts is therefore asserted of both, which is the only mechanism that keeps a fake
 * honest as it ages (standing rule 23).
 *
 * **Every citation below is resolved mechanically** by `scripts/citations.test.ts`: the file must be
 * tracked and must declare a test of that exact name. Round 1's register cited a test that had
 * never been written, and it was the entry justifying the kindest divergence (standing rule 11);
 * the parser's grammar — a backticked `*.ts` file, `›`, then the quoted names, which may run over
 * the wrap onto the next comment line — is in `scripts/citations.ts`, along with what it cannot
 * check.
 *
 * ## Divergence register
 *
 * | # | Divergence | Direction | Pinned by |
 * |---|---|---|---|
 * | 1 | No kernel: the hardening flags are *recorded*, not enforced. A write outside the workspace, a capability-requiring syscall and a route off the run network cannot be attempted at all. | **Kinder** — a caller could believe an unenforced flag | `hardening()` returns the body `runContainerCreateBody` builds, which is the same pure function `DockerWorkspaceProvider.create` sends to the daemon, so the two agree by construction rather than by an assertion; what is asserted is that the body carries the flags (`workspace/fake.test.ts` › "records the same create body the Docker provider would send") and that the **daemon** recorded them (`docker-workspace.e2e.test.ts` › "recorded every flag technical/05 names"). The *properties* are demonstrated only there: `docker-workspace.e2e.test.ts` › "--read-only refuses a write outside the workspace and allows one inside it", "--cap-drop ALL refuses a capability-requiring syscall that succeeds with the capability", "no-new-privileges is what the kernel reports, not what we passed", "--init makes a reaper PID 1, so an orphan inside the workspace is not the shim", "the memory limit is the one the cgroup enforces" and "the workspace has no route off its internal network, and the sidecar has two networks". |
 * | 2 | `attach` returns a socket path with nothing listening. | **Kinder** — a caller assuming a live control channel passes here | `workspace/fake.test.ts` › "attach returns a path that no server is listening on" connects and asserts `ENOENT`, so WP-15 must compose `runner/fake-spawn.ts` rather than `createRunletSpawn`. |
 * | 3 | No detached grandchild can exist, so "the container stop is what ends the pid namespace" cannot be shown. | **Kinder** — the whole point of WP-13's third obligation is invisible here | The *ordering* claim is checkable and is checked in both implementations: `events` records every stop and removal, and the shared suite reads them through its `containerOps` seam in `provider-suite.ts` › "stops the run container before it removes it". Until WP-14 round 2 the suite asserted only that `attach` rejects afterwards, which is true whichever order the two happened in (standing rule 10), and the ordering was pinned for Docker alone in `workspace/provider.test.ts` › "stops the container before removing anything". The property itself is `docker-workspace.e2e.test.ts` › "a detached grandchild does not survive destroy". |
 * | 4 | The tarball is built from an in-memory tree rather than from a clone. | Neither: same `filterTar` | `workspace/fake.test.ts` › "drops a symlink that escapes the workspace, through the same filter", and `provider-suite.ts` › "drops a symlink that points outside the workspace, and counts it", which both implementations run. |
 * | 5 | `updateMirror` performs no fetch, so a URL that does not resolve still "updates". | **Kinder** | The fake refuses a `create` whose project has no mirror (stricter than nothing, same as Docker's failing clone), asserted by `provider-suite.ts` › "refuses to create a workspace before the mirror exists". |
 * | 6 | No image pull, no daemon, so `engine_unavailable` never happens. | Kinder | Nothing pins it. Stated so no one reads the fake's reliability as the system's. |
 *
 * Two places the fake is deliberately **stricter**, which is always allowed: it refuses a second
 * `create` for a run id it has ever seen (Docker refuses only while the container exists, because
 * a name is free once removed), and it refuses an `export` for a run whose volume the retention
 * sweep has purged (Docker would fail later, in the helper, with a mount error).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import type {
  PurgedWorkspace,
  PurgeReport,
  WorkspaceAttachment,
  WorkspaceExport,
  WorkspaceExportRequest,
  WorkspaceGitCredential,
  WorkspaceHandle,
  WorkspaceProvider,
  WorkspaceRepo,
  WorkspaceSpec,
} from '@platform/application';
import { WORKSPACE_LABELS, WorkspaceError, workspaceSpecSchema } from '@platform/application';
import { renderEgressConfig } from './egress.js';
import { type DockerCreateBody, runContainerCreateBody } from './hardening.js';
import { assertRunId, controlSocketPath, WORKSPACE_WORKDIR, workspaceVolumeName } from './names.js';
import { assertProjectEnv, mintRunToken } from './provider.js';
import { retentionDecisions } from './retention.js';
import { filterTar, type TarInput, writeTar } from './tar.js';

interface FakeRun {
  readonly spec: WorkspaceSpec;
  readonly handle: WorkspaceHandle;
  readonly token: string;
  readonly hardening: DockerCreateBody;
  readonly files: Map<string, TarInput>;
  running: boolean;
  destroyed: boolean;
  volumeRemoved: boolean;
}

export interface FakeWorkspaceProviderOptions {
  /** Where the (never-listening) control sockets are said to live. */
  readonly controlRoot?: string;
  readonly now?: () => Date;
  readonly mintToken?: () => string;
}

/** What the fake recorded happening, for tests that need to assert which branch ran. */
export interface FakeWorkspaceEvent {
  readonly kind: 'mirror' | 'create' | 'attach' | 'stop' | 'remove' | 'export' | 'purge';
  readonly runId: string;
}

export class FakeWorkspaceProvider implements WorkspaceProvider {
  readonly #controlRoot: string;
  readonly #now: () => Date;
  readonly #mintToken: () => string;
  readonly #runs = new Map<string, FakeRun>();
  readonly #mirrors = new Set<string>();
  readonly #seen = new Set<string>();
  readonly events: FakeWorkspaceEvent[] = [];

  constructor(options: FakeWorkspaceProviderOptions = {}) {
    this.#controlRoot = options.controlRoot ?? '/tmp/agentic-fake-ctl';
    this.#now = options.now ?? (() => new Date());
    this.#mintToken = options.mintToken ?? mintRunToken;
  }

  #record(kind: FakeWorkspaceEvent['kind'], runId: string): void {
    this.events.push({ kind, runId });
  }

  #run(runId: string): FakeRun {
    const run = this.#runs.get(runId);
    if (run === undefined) {
      throw new WorkspaceError('not_found', 'no such workspace', { runId });
    }
    return run;
  }

  async updateMirror(input: {
    readonly projectId: string;
    readonly repo: WorkspaceRepo;
    readonly credential: WorkspaceGitCredential | null;
  }): Promise<{ readonly cachePath: string; readonly updated: boolean }> {
    // Stricter than doing nothing: a URL the Docker provider's `git` would refuse is refused here
    // too, so a spec with a nonsense remote fails in both tiers rather than only in production.
    if (!/^(https?|ssh|git|file):\/\/\S+$/.test(input.repo.url)) {
      throw new WorkspaceError('invalid_spec', 'repository url is not a git remote', {
        detail: input.repo.url.slice(0, 80),
      });
    }
    this.#mirrors.add(input.repo.cacheKey);
    this.#record('mirror', input.projectId);
    return { cachePath: `/cache/${input.repo.cacheKey}.git`, updated: true };
  }

  async create(rawSpec: WorkspaceSpec): Promise<WorkspaceHandle> {
    const parsed = workspaceSpecSchema.safeParse(rawSpec);
    if (!parsed.success) {
      throw new WorkspaceError('invalid_spec', 'workspace spec did not validate', {
        detail: parsed.error.issues[0]?.message ?? 'invalid',
      });
    }
    const spec = parsed.data;
    assertRunId(spec.runId);
    assertProjectEnv(spec.env);
    if (this.#seen.has(spec.runId)) {
      throw new WorkspaceError('invalid_spec', 'this run already had a workspace', {
        runId: spec.runId,
      });
    }
    if (!this.#mirrors.has(spec.repo.cacheKey)) {
      throw new WorkspaceError('workspace_failed', 'the project has no mirror to clone from', {
        runId: spec.runId,
      });
    }
    if (spec.egress.hosts.length > 0) {
      // Rendering here as well as in the Docker provider is deliberate: a spec whose egress list
      // cannot be rendered must fail in the unit tier too, not only against a daemon.
      renderEgressConfig(spec.egress);
    }
    const handle: WorkspaceHandle = {
      runId: spec.runId,
      projectId: spec.projectId,
      containerId: `fake-container-${spec.runId}`,
      sidecarContainerId: spec.egress.hosts.length === 0 ? null : `fake-egress-${spec.runId}`,
      networkId: `fake-network-${spec.runId}`,
      volumeName: workspaceVolumeName(spec.runId),
      cacheKey: spec.repo.cacheKey,
      controlSubPath: spec.runId,
      keepUntil: spec.keepUntil,
    };
    this.#seen.add(spec.runId);
    this.#runs.set(spec.runId, {
      spec,
      handle,
      token: this.#mintToken(),
      hardening: runContainerCreateBody({
        spec,
        images: {
          runtime: 'platform-runtime:fake',
          egress: 'tinyproxy:fake',
          git: 'git:fake',
          runtimeSourceDir: null,
        },
        controlVolume: 'ctl',
        cacheVolume: 'repo-cache',
        labels: {
          [WORKSPACE_LABELS.run]: spec.runId,
          [WORKSPACE_LABELS.project]: spec.projectId,
          [WORKSPACE_LABELS.role]: 'workspace',
          [WORKSPACE_LABELS.keepUntil]: spec.keepUntil,
          [WORKSPACE_LABELS.createdAt]: this.#now().toISOString(),
        },
        command: [],
        entrypoint: null,
        env: {},
      }),
      // Seeded with the two directories the export is supposed to exclude, so the assertion that
      // they are absent is not vacuous (standing rule 42: a filter with nothing to filter passes).
      files: new Map<string, TarInput>([
        ['repo/', { name: 'repo/', type: 'directory' }],
        ['repo/README.md', { name: 'repo/README.md', type: 'file', content: '# fixture\n' }],
        ['repo/.git/config', { name: 'repo/.git/config', type: 'file', content: '[core]\n' }],
        [
          'repo/node_modules/left-pad/index.js',
          { name: 'repo/node_modules/left-pad/index.js', type: 'file', content: 'x\n' },
        ],
      ]),
      running: true,
      destroyed: false,
      volumeRemoved: false,
    });
    this.#record('create', spec.runId);
    return handle;
  }

  async attach(handle: WorkspaceHandle): Promise<WorkspaceAttachment> {
    const run = this.#run(handle.runId);
    if (!run.running) {
      throw new WorkspaceError('not_found', 'the run container is not running', {
        runId: handle.runId,
      });
    }
    this.#record('attach', handle.runId);
    return {
      socketPath: controlSocketPath(this.#controlRoot, handle.runId),
      token: run.token,
      workdir: WORKSPACE_WORKDIR,
    };
  }

  async kill(handle: WorkspaceHandle): Promise<void> {
    const run = this.#runs.get(handle.runId);
    if (run === undefined) {
      return;
    }
    run.running = false;
    this.#record('stop', handle.runId);
  }

  async destroy(handle: WorkspaceHandle): Promise<void> {
    const run = this.#runs.get(handle.runId);
    if (run === undefined) {
      return;
    }
    // Stop before remove, always — including when the container has already exited. The ordering
    // is the checkable half of WP-13's third obligation.
    run.running = false;
    this.#record('stop', handle.runId);
    run.destroyed = true;
    this.#record('remove', handle.runId);
  }

  async export(
    handle: WorkspaceHandle,
    request: WorkspaceExportRequest,
    credential: WorkspaceGitCredential | null,
  ): Promise<WorkspaceExport> {
    const run = this.#run(handle.runId);
    if (run.volumeRemoved) {
      throw new WorkspaceError('not_found', 'the workspace volume has been purged', {
        runId: handle.runId,
      });
    }
    const entries = [...run.files.values()].filter(
      (entry) =>
        !entry.name.split('/').some((segment) => segment === '.git' || segment === 'node_modules'),
    );
    const filtered = filterTar(writeTar(entries));
    if (request.tarballPath !== null) {
      await mkdir(path.dirname(request.tarballPath), { recursive: true });
      await writeFile(request.tarballPath, filtered.bytes, { mode: 0o600 });
    }
    this.#record('export', handle.runId);
    return {
      branch: request.branch,
      pushed: credential !== null,
      commitSha: 'f'.repeat(40),
      tarballPath: request.tarballPath,
      tarballBytes: filtered.bytes.length,
      droppedLinks: filtered.droppedLinks,
    };
  }

  async purgeExpired(now: Date): Promise<PurgeReport> {
    const candidates = [...this.#runs.values()]
      .filter((run) => !run.volumeRemoved)
      .map((run) => ({
        volumeName: run.handle.volumeName,
        labels: {
          [WORKSPACE_LABELS.run]: run.spec.runId,
          [WORKSPACE_LABELS.keepUntil]: run.spec.keepUntil,
        },
        inUse: !run.destroyed,
      }));
    const results: PurgedWorkspace[] = [];
    for (const decision of retentionDecisions(candidates, now)) {
      if (decision.action === 'keep') {
        results.push(decision);
        continue;
      }
      const run = this.#runs.get(decision.runId);
      if (run !== undefined) {
        run.volumeRemoved = true;
      }
      this.#record('purge', decision.runId);
      results.push({ ...decision, removed: true });
    }
    return {
      examined: results.length,
      removed: results.filter((result) => result.removed).length,
      volumes: results,
    };
  }

  // ── Test seams ─────────────────────────────────────────────────────────────

  /** The create body the Docker provider would have sent. The shared suite asserts it for both. */
  hardening(runId: string): DockerCreateBody {
    return this.#run(runId).hardening;
  }

  /** Plants a file, a directory or a symlink in the workspace, for the export cases. */
  plant(runId: string, entry: TarInput): void {
    this.#run(runId).files.set(entry.name, entry);
  }

  /** Whether the run's container is still running, for tests asserting `kill`/`destroy`. */
  isRunning(runId: string): boolean {
    return this.#runs.get(runId)?.running ?? false;
  }

  /**
   * Proves divergence 2: nothing is listening on the path `attach` returns.
   *
   * Exported rather than inlined in a test because the claim belongs with the fake, and because a
   * later work package that starts to rely on a live socket should find this function when it
   * greps for why its connection fails.
   */
  static async controlSocketIsDead(socketPath: string): Promise<NodeJS.ErrnoException> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      socket.on('error', (error: NodeJS.ErrnoException) => {
        socket.destroy();
        resolve(error);
      });
      socket.on('connect', () => {
        socket.destroy();
        reject(
          new Error('the fake provider is listening on its control socket: divergence 2 is stale'),
        );
      });
    });
  }
}
