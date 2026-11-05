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
 * | 5 | `updateMirror` performs no fetch, so a URL that does not resolve still "updates". | **Kinder** | The fake refuses a `create` whose project has no mirror (stricter than nothing, same as Docker's failing clone), asserted by `provider-suite.ts` › "refuses to create a workspace before the mirror exists". The refusal is for a spec **with** a repository only: a repo-less spec (WP-74) clones nothing in either implementation, and `provider-suite.ts` › "creates a workspace with no checkout and no mirror, and keeps its container, socket and skills" holds both to that. |
 * | 6 | No image pull, no daemon, so `engine_unavailable` never happens. | Kinder | Nothing pins it. Stated so no one reads the fake's reliability as the system's. |
 * | 7 | No repository, so a `repo.checkoutCommit` the mirror does not hold is not refused: the fake has no objects to look it up in (WP-105). | **Kinder** — a spec naming a lost shadow base creates a workspace here | `workspace/provider.test.ts` › "refuses a checkout commit the mirror does not hold, by name, before the run container" and the daemon case in `test/e2e/workspace/docker-workspace.e2e.test.ts` › "refuses a shadow base the mirror does not hold, and checks out one it does, detached". |
 * | 9 | No daemon, so an image digest is "local" when it is in `localImageDigests` — **every** digest when that option is absent (WP-279). | **Kinder** when absent | Both implementations refuse a digest that is not local: `provider-suite.ts` › "refuses an image digest that is not on the daemon, naming it, before creating anything" passes `localImageDigests` to the fake and a digest no image has to Docker. The relayed helper agent socket (WP-279) is accepted and recorded, and — only with `relayedSigning` (WP-283) — asked for one signature per mirror update and export, as the helper's `ssh` asks it; the helper's own mount and ssh are `workspace/provider.test.ts`'s and `scripts/deploy-key-check.mjs`'s. |
 * | 8 | No image, so its shim protocol label is this build's `RUNLET_PROTOCOL_VERSION` by definition: an image with **no** label cannot be expressed (WP-151). | Neither for a mismatch, **kinder** for an absent label | A runner protocol the "image" does not speak is refused in both implementations: `provider-suite.ts` › "refuses a spec whose runner speaks another shim protocol than the run image, before creating anything". The absent label is the Docker provider's alone: `workspace/runtime-protocol.test.ts` › "refuses an image with no protocol label, and one with a label that is not a number". |
 *
 * Three places the fake is deliberately **stricter**, which is always allowed: it refuses a second
 * `create` for a run id it has ever seen (Docker refuses only while the container exists, because
 * a name is free once removed), it refuses an `export` for a run whose volume the retention
 * sweep has purged (Docker would fail later, in the helper, with a mount error), and it refuses an
 * `extendRetention` for a run it does not have (the daemon would happily create a hold volume for a
 * workspace that is gone — WP-27).
 */

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import type {
  ExistingProtectedPaths,
  LabelledRunWorkspace,
  PurgedWorkspace,
  PurgeReport,
  RunImages,
  WorkspaceAttachment,
  WorkspaceCliEnvironment,
  WorkspaceExport,
  WorkspaceExportRequest,
  WorkspaceGitAccess,
  WorkspaceHandle,
  WorkspaceProvider,
  WorkspaceProvision,
  WorkspaceRepo,
  WorkspaceSpec,
} from '@platform/application';
import {
  isRelayedSsh,
  MAX_LABELLED_RUNS,
  WORKSPACE_LABELS,
  WorkspaceError,
  workspaceSpecSchema,
} from '@platform/application';
import { RUNLET_PROTOCOL_VERSION } from '@platform/contracts';
import { signThroughAgent } from '../runlet/helper-agent.js';
import { egressProxyUrl, renderEgressConfig } from './egress.js';
import { type DockerCreateBody, runContainerCreateBody } from './hardening.js';
import {
  assertRunId,
  controlSocketPath,
  egressContainerName,
  retentionHoldVolumeName,
  WORKSPACE_WORKDIR,
  workspaceVolumeName,
} from './names.js';
import { assertHasCheckout, assertProjectEnv, mintRunToken } from './provider.js';
import { expiredHolds, type RetentionHold, retentionDecisions } from './retention.js';

import { WORKSPACE_GIT_EXCLUDE_ENTRY, workspaceSkillFiles } from './skills.js';
import { filterTar, type TarInput, writeTar } from './tar.js';
import { listingRefusal, parseTrackedListing, trackedListingOutput } from './tracked.js';

/** The `PATH` the fake's run image "declares": the value every `node:*` base image does. */
export const FAKE_RUN_IMAGE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

interface FakeRun {
  readonly spec: WorkspaceSpec;
  readonly handle: WorkspaceHandle;
  readonly token: string;
  readonly hardening: DockerCreateBody;
  readonly files: Map<string, TarInput>;
  running: boolean;
  destroyed: boolean;
  volumeRemoved: boolean;
  /**
   * Whether anything was planted after `create` — the fake's answer to `onlyIfChanged` (backlog
   * 467). It has no index to compare with, so *a planted entry* stands for *the tree changed*; a
   * run nothing was planted in exports nothing under `onlyIfChanged`, as the helper does.
   */
  planted: boolean;
  /** When `create` made it, on the injected clock — what the listing verb dates a run by (WP-103). */
  readonly createdAt: string;
  /**
   * The retention hold, as a **separate** record (WP-27).
   *
   * Deliberately not a mutation of `spec.keepUntil`: the Docker provider cannot change a volume's
   * label and writes a second object instead, so a fake that simply overwrote the field would be
   * modelling an operation the adapter it stands in for does not have (standing rule 1). Both go
   * through the same `retentionDecisions`, which is what makes the two agree.
   */
  hold: { volumeName: string; keepUntil: string } | null;
}

export interface FakeWorkspaceProviderOptions {
  /**
   * The image digests this fake "daemon" holds (WP-279): a create naming another is refused
   * `image_not_local`, as the Docker provider refuses it. Absent holds every digest — divergence 9.
   */
  readonly localImageDigests?: ReadonlySet<string>;
  /** Where the (never-listening) control sockets are said to live. */
  readonly controlRoot?: string;
  readonly now?: () => Date;
  readonly mintToken?: () => string;
  /**
   * What the tree at the merge base holds, as the helper's `git ls-tree -r` would list it (WP-99).
   * Defaults to the two files the fake's clone stand-in holds. The listing goes through the
   * **same** parser the Docker provider's helper output does (`tracked.ts`), so the two cannot
   * disagree about what a given tree lists. The fake has no task branch, so it lists no checkout
   * links of its own.
   */
  readonly tracked?: readonly FakeTrackedEntry[];
  /**
   * **Sign through a relayed helper agent socket** (WP-283, backlog 693): with this set, a mirror
   * update or an export handed a `relayed_ssh` access connects to the socket under `controlRoot`,
   * lists its identity and asks it to sign one synthetic RFC 4252 user-authentication blob for
   * `git` with that key — what the Docker provider's helper `ssh` does once per connection — and
   * fails the way a helper's `git` would when the agent refuses. Absent, the socket is recorded and
   * never connected to (divergence 9).
   */
  readonly relayedSigning?: { readonly controlRoot: string };
}

/** One signature a relayed helper agent made for a mirror update or an export (WP-283). */
export interface FakeRelayedSignature {
  readonly kind: 'mirror' | 'export';
  readonly keyBlob: Buffer;
  readonly data: Buffer;
  readonly signature: Buffer;
}

/** A synthetic RFC 4252 §7 user-authentication request for user `git` with `keyBlob`. */
export const syntheticUserauthBlob = (keyBlob: Buffer, session: Buffer): Buffer => {
  const string = (value: Buffer | string): Buffer => {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length, 0);
    return Buffer.concat([length, bytes]);
  };
  return Buffer.concat([
    string(session),
    Buffer.from([50]),
    string('git'),
    string('ssh-connection'),
    string('publickey'),
    Buffer.from([1]),
    string('ssh-ed25519'),
    string(keyBlob),
  ]);
};

/** One index entry of the fake's clone: a path and its git mode (`100644`, `120000`, `160000`). */
export interface FakeTrackedEntry {
  readonly path: string;
  readonly mode: string;
}

const DEFAULT_FAKE_TRACKED: readonly FakeTrackedEntry[] = [
  { path: 'README.md', mode: '100644' },
  { path: 'node_modules/left-pad/index.js', mode: '100644' },
];

/** What the fake recorded happening, for tests that need to assert which branch ran. */
export interface FakeWorkspaceEvent {
  readonly kind: 'mirror' | 'create' | 'attach' | 'stop' | 'remove' | 'export' | 'purge';
  readonly runId: string;
}

export class FakeWorkspaceProvider implements WorkspaceProvider {
  readonly #controlRoot: string;
  readonly #localImageDigests: ReadonlySet<string> | null;
  /** What each create was given (WP-279) — the skills it wrote and the image digests, for assertions. */
  readonly provisions = new Map<string, WorkspaceProvision>();
  /** The git access each mirror update and export was handed, in order (WP-279's relayed socket). */
  readonly gitAccess: Array<{
    readonly kind: 'mirror' | 'export';
    readonly access: WorkspaceGitAccess | null;
  }> = [];
  readonly #now: () => Date;
  readonly #mintToken: () => string;
  readonly #runs = new Map<string, FakeRun>();
  readonly #mirrors = new Set<string>();
  readonly #seen = new Set<string>();
  readonly #tracked: readonly FakeTrackedEntry[];
  readonly events: FakeWorkspaceEvent[] = [];
  /** Every signature a relayed helper agent made (WP-283), when `relayedSigning` is set. */
  readonly relayedSignatures: FakeRelayedSignature[] = [];
  readonly #relayedSigning: { readonly controlRoot: string } | null;

  constructor(options: FakeWorkspaceProviderOptions) {
    this.#relayedSigning = options.relayedSigning ?? null;
    this.#controlRoot = options.controlRoot ?? '/tmp/agentic-fake-ctl';
    this.#localImageDigests = options.localImageDigests ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#mintToken = options.mintToken ?? mintRunToken;
    this.#tracked = options.tracked ?? DEFAULT_FAKE_TRACKED;
  }

  /** One SSH connection's signature through a relayed helper agent, as the helper's `ssh` asks it. */
  async #signRelayed(kind: 'mirror' | 'export', access: WorkspaceGitAccess | null): Promise<void> {
    if (this.#relayedSigning === null || access === null || !isRelayedSsh(access)) return;
    const session = randomBytes(32);
    let data: Buffer = Buffer.alloc(0);
    const answer = await signThroughAgent({
      socketPath: path.join(this.#relayedSigning.controlRoot, access.agentSocket),
      data: (keyBlob) => {
        data = syntheticUserauthBlob(keyBlob, session);
        return data;
      },
    });
    if (answer === null) {
      throw new WorkspaceError(
        'workspace_failed',
        `the ${kind} helper's ssh was refused by the relayed agent (Permission denied (publickey))`,
      );
    }
    this.relayedSignatures.push({
      kind,
      keyBlob: answer.keyBlob,
      data,
      signature: answer.signature,
    });
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
    readonly credential: WorkspaceGitAccess | null;
  }): Promise<{ readonly cachePath: string; readonly updated: boolean }> {
    // Stricter than doing nothing: a URL the Docker provider's `git` would refuse is refused here
    // too, so a spec with a nonsense remote fails in both tiers rather than only in production.
    if (!/^(https?|ssh|git|file):\/\/\S+$/.test(input.repo.url)) {
      throw new WorkspaceError('invalid_spec', 'repository url is not a git remote', {
        detail: input.repo.url.slice(0, 80),
      });
    }
    this.gitAccess.push({ kind: 'mirror', access: input.credential });
    await this.#signRelayed('mirror', input.credential);
    this.#mirrors.add(input.repo.cacheKey);
    this.#record('mirror', input.projectId);
    return { cachePath: `/cache/${input.repo.cacheKey}.git`, updated: true };
  }

  /** Divergence 9: a digest not in `localImageDigests` is refused as the Docker provider refuses it. */
  #assertImagesLocal(runId: string, images: RunImages | null): void {
    if (images === null || this.#localImageDigests === null) return;
    for (const [role, digest] of [
      ['run', images.run],
      ['egress', images.egress],
    ] as const) {
      if (!this.#localImageDigests.has(digest)) {
        throw new WorkspaceError(
          'invalid_spec',
          `the ${role} image ${digest} is not on this launcher's daemon, and a launcher never pulls at create (TD-031 decision 4)`,
          { runId, reason: 'image_not_local' },
        );
      }
    }
  }

  async create(rawSpec: WorkspaceSpec, provision: WorkspaceProvision): Promise<WorkspaceHandle> {
    const parsed = workspaceSpecSchema.safeParse(rawSpec);
    if (!parsed.success) {
      throw new WorkspaceError('invalid_spec', 'workspace spec did not validate', {
        detail: parsed.error.issues[0]?.message ?? 'invalid',
      });
    }
    const spec = parsed.data;
    assertRunId(spec.runId);
    assertProjectEnv(spec.env);
    // WP-279: the request's skills, digest checked by the function the Docker provider calls, and
    // its image digests — both before anything is marked, as Docker creates nothing.
    const skillFiles = workspaceSkillFiles(spec, provision.skills);
    this.#assertImagesLocal(spec.runId, provision.images);
    // WP-151: the fake's run image is one built from this commit, so its shim speaks this build's
    // protocol — refused before the run id is marked seen, as the Docker provider creates nothing.
    if (spec.runletProtocol !== RUNLET_PROTOCOL_VERSION) {
      throw new WorkspaceError(
        'invalid_spec',
        `the run image fake declares shim protocol ${RUNLET_PROTOCOL_VERSION}, and the runner speaks protocol ${spec.runletProtocol}; rebuild and recreate the runner and the run image from one commit (WP-151)`,
        {
          runId: spec.runId,
          reason: 'runtime_image_protocol_mismatch',
          protocols: { runner: spec.runletProtocol, shim: RUNLET_PROTOCOL_VERSION },
        },
      );
    }
    if (this.#seen.has(spec.runId)) {
      throw new WorkspaceError('invalid_spec', 'this run already had a workspace', {
        runId: spec.runId,
      });
    }
    // Refused for a repo-ful spec whose mirror was never updated, exactly as before; a spec with
    // **no** repository (WP-74) clones nothing and needs no mirror, so it is the one create this
    // check admits without one. The suite asks both directions of both implementations — and, since
    // WP-75, the **words**: the Docker provider's clone helper refuses a missing mirror with this
    // same sentence before any container that mounts the mirror by sub-path is asked for.
    if (spec.repo !== null && !this.#mirrors.has(spec.repo.cacheKey)) {
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
      cacheKey: spec.repo === null ? null : spec.repo.cacheKey,
      controlSubPath: spec.runId,
      keepUntil: spec.keepUntil,
    };
    this.#seen.add(spec.runId);
    this.provisions.set(spec.runId, provision);
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
        // The clone's stand-in — only when there is a clone (WP-74): a repo-less workspace is the
        // empty working directory plus the skills, as the Docker provider leaves it.
        ...(spec.repo === null
          ? []
          : ([
              ['repo/README.md', { name: 'repo/README.md', type: 'file', content: '# fixture\n' }],
              ['repo/.git/config', { name: 'repo/.git/config', type: 'file', content: '[core]\n' }],
              [
                'repo/node_modules/left-pad/index.js',
                { name: 'repo/node_modules/left-pad/index.js', type: 'file', content: 'x\n' },
              ],
            ] as const)),
        // The platform skills, through the same function the Docker provider gives to its helper
        // container, so the two cannot disagree about which files a spec produces. What this
        // **cannot** show is that a CLI discovers them: that is the real container's tier and
        // standing rule 82's whole point (`docker-workspace.e2e.test.ts`).
        ...skillFiles.map(
          (file) =>
            [
              `repo/${file.path}`,
              { name: `repo/${file.path}`, type: 'file', content: file.content },
            ] as const,
        ),
        // Only when there is something to exclude — `#provisionSkills` returns before writing it
        // for a role with no skills, and a fake that wrote it anyway would be the more generous of
        // the two (standing rule 1). No divergence remains on this line.
        ...(spec.skills.length === 0 || spec.repo === null
          ? []
          : [
              [
                'repo/.git/info/exclude',
                {
                  name: 'repo/.git/info/exclude',
                  type: 'file',
                  content: `${WORKSPACE_GIT_EXCLUDE_ENTRY}\n`,
                },
              ] as const,
            ]),
      ]),
      running: true,
      destroyed: false,
      volumeRemoved: false,
      planted: false,
      createdAt: this.#now().toISOString(),
      hold: null,
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

  /**
   * The container facts the CLI needs (WP-118), in the Docker provider's shape: a proxy exactly
   * when the run has a sidecar, and the helper command the Docker provider writes for a run image
   * with no source mount. `PATH` is the value a `node:*` image declares — the fake has no image to
   * read it from (divergence 6's family: no image, no daemon).
   */
  async cliEnvironment(handle: WorkspaceHandle): Promise<WorkspaceCliEnvironment> {
    this.#run(handle.runId);
    return {
      proxy:
        handle.sidecarContainerId === null
          ? null
          : {
              url: egressProxyUrl(egressContainerName(handle.runId)),
              noProxy: 'localhost,127.0.0.1',
            },
      home: '/tmp',
      claudeConfigDir: '/tmp/claude',
      path: FAKE_RUN_IMAGE_PATH,
      gitConfig: [
        { key: 'credential.helper', value: '!agentic-runlet credential --socket /ctl/cred.sock' },
        // Backlog 481: the Docker provider's pair, so the fake's answer has the same shape.
        { key: 'credential.useHttpPath', value: 'true' },
      ],
    };
  }

  /**
   * The Docker provider's answers, without a helper: the same refusals (`listingRefusal`), then the
   * configured entries through `parseTrackedListing`. The fake's clone has no history, so its
   * entries stand for the tree at the merge base — a divergence of shape, not of direction: the
   * base-versus-branch distinction is measured against real git in `tracked.test.ts` and the docker
   * e2e.
   */
  async listExistingProtectedPaths(
    handle: WorkspaceHandle,
    request: { readonly patterns: readonly string[]; readonly defaultBranch: string | null },
  ): Promise<ExistingProtectedPaths> {
    const run = this.#run(handle.runId);
    const refused = listingRefusal(run.handle.cacheKey, request);
    if (refused !== null) {
      return refused;
    }
    return parseTrackedListing(trackedListingOutput(this.#tracked), request.patterns);
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

  /**
   * The runs whose container has not been removed (WP-103). The fake has one instance, so the
   * instance filter the Docker provider applies has nothing to separate here; what the shared suite
   * asks of both is that a created run is listed and a destroyed one is not.
   */
  async listLabelledRuns(): Promise<readonly LabelledRunWorkspace[]> {
    return [...this.#runs.values()]
      .filter((run) => !run.destroyed)
      .map((run) => ({ runId: run.spec.runId, createdAt: run.createdAt, running: run.running }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, MAX_LABELLED_RUNS);
  }

  /** `destroy` by run id, recording the same stop-then-remove; `found: false` for nothing left. */
  async destroyRun(runId: string): Promise<{ readonly found: boolean }> {
    assertRunId(runId);
    const run = this.#runs.get(runId);
    if (run === undefined || run.destroyed) {
      return { found: false };
    }
    await this.destroy(run.handle);
    return { found: true };
  }

  async export(
    handle: WorkspaceHandle,
    request: WorkspaceExportRequest,
    credential: WorkspaceGitAccess | null,
  ): Promise<WorkspaceExport> {
    const run = this.#run(handle.runId);
    this.gitAccess.push({ kind: 'export', access: credential });
    assertHasCheckout(handle);
    await this.#signRelayed('export', credential);
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
    // Backlog 467: an unchanged tree commits and pushes nothing, as the helper's `CHANGED=no` does.
    const changed = request.onlyIfChanged === true ? run.planted : undefined;
    return {
      branch: request.branch,
      pushed: credential !== null && changed !== false,
      ...(changed === undefined ? {} : { changed }),
      commitSha: 'f'.repeat(40),
      tarballPath: request.tarballPath,
      tarballBytes: filtered.bytes.length,
      droppedLinks: filtered.droppedLinks,
    };
  }

  /**
   * technical/05 §5's longer window (WP-27), modelled the way the Docker provider expresses it.
   *
   * **Stricter than the adapter in one direction**, which is the allowed one: an unknown run is
   * `not_found` here, while the daemon would happily create a hold volume for a run whose workspace
   * has been purged. It never shortens a window, for the reason the port states.
   */
  async extendRetention(
    handle: WorkspaceHandle,
    keepUntil: string,
  ): Promise<{ readonly keepUntil: string }> {
    const run = this.#run(handle.runId);
    const requested = Date.parse(keepUntil);
    if (!Number.isFinite(requested)) {
      throw new WorkspaceError('invalid_spec', 'retention instant is not a date', {
        runId: handle.runId,
        detail: `length ${keepUntil.length}`,
      });
    }
    const current = Date.parse(run.hold?.keepUntil ?? run.spec.keepUntil);
    const effective =
      Number.isFinite(current) && current > requested
        ? (run.hold?.keepUntil ?? run.spec.keepUntil)
        : keepUntil;
    run.hold = { volumeName: retentionHoldVolumeName(handle.runId), keepUntil: effective };
    return { keepUntil: effective };
  }

  async purgeExpired(now: Date): Promise<PurgeReport> {
    const live = [...this.#runs.values()].filter((run) => !run.volumeRemoved);
    const candidates = live.map((run) => ({
      volumeName: run.handle.volumeName,
      labels: {
        [WORKSPACE_LABELS.run]: run.spec.runId,
        [WORKSPACE_LABELS.keepUntil]: run.spec.keepUntil,
      },
      inUse: !run.destroyed,
    }));
    const holds: RetentionHold[] = live.flatMap((run) =>
      run.hold === null
        ? []
        : [
            {
              runId: run.spec.runId,
              volumeName: run.hold.volumeName,
              keepUntil: run.hold.keepUntil,
            },
          ],
    );
    const decisions = retentionDecisions(candidates, now, holds);
    const results: PurgedWorkspace[] = [];
    for (const decision of decisions) {
      const { holdVolume, action, ...reported } = decision;
      if (action === 'keep') {
        results.push(reported);
        continue;
      }
      const run = this.#runs.get(decision.runId);
      if (run !== undefined) {
        run.volumeRemoved = true;
      }
      this.#record('purge', decision.runId);
      results.push({ ...reported, removed: true });
    }
    // The hold goes with the workspace, exactly as the adapter's does.
    for (const hold of expiredHolds(holds, decisions)) {
      const run = this.#runs.get(hold.runId);
      if (run !== undefined) {
        run.hold = null;
      }
    }
    return {
      examined: results.length,
      removed: results.filter((result) => result.removed).length,
      volumes: results,
      /**
       * Empty, and that is the honest answer rather than an omission (backlog **0b**).
       *
       * This fake has no control **volume**: `attach` answers a socket path it made up and nothing
       * writes a directory anywhere. So there is nothing for a sweep to examine — which is a
       * different fact from "this provider does not sweep", and the field being present is what
       * lets the shared contract suite ask both providers the same question.
       */
      controlDirectories: [],
    };
  }

  // ── Test seams ─────────────────────────────────────────────────────────────

  /** The create body the Docker provider would have sent. The shared suite asserts it for both. */
  hardening(runId: string): DockerCreateBody {
    return this.#run(runId).hardening;
  }

  /** Plants a file, a directory or a symlink in the workspace, for the export cases. */
  plant(runId: string, entry: TarInput): void {
    const run = this.#run(runId);
    run.files.set(entry.name, entry);
    run.planted = true;
  }

  /**
   * A file of the workspace, by its path relative to the checkout — the shared suite's seam for
   * "what did provisioning put in there".
   *
   * `null` for a path the workspace does not have, never a throw: the suite asks the question of
   * both implementations and the Docker one answers it by `cat`ting inside a container, where an
   * absent file is a non-zero exit rather than an error.
   */
  readWorkspaceFile(runId: string, relativePath: string): string | null {
    const entry = this.#runs.get(runId)?.files.get(`repo/${relativePath}`);
    return entry?.type === 'file' ? (entry.content ?? null) : null;
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
