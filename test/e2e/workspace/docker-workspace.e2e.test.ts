/**
 * WP-14's acceptance criterion: the launcher against a real Docker daemon, with a fixture
 * repository in a container, and **the security flags demonstrated rather than asserted**.
 *
 * ## The distinction this file is built around
 *
 * `hardening.test.ts` asserts the create body the provider sends. That is a test of a string this
 * repository wrote (standing rule 3). What is here instead:
 *
 *  - every flag is read back from `docker inspect` — the **daemon's** record of the container, not
 *    our argument vector;
 *  - and for the flags that buy a property, the property is attempted inside a container running
 *    under exactly that recorded `HostConfig`: a write outside the workspace, a
 *    capability-requiring syscall, `NoNewPrivs` as the kernel reports it, the memory ceiling as
 *    the cgroup reports it, and a route off the run network.
 *
 * Each negative is paired with the positive that makes it mean something (standing rule 42): the
 * `chown` that fails without `CAP_CHOWN` succeeds with it, the write that fails at `/etc` succeeds
 * at `/work/repo`, and the host that is unreachable from the workspace is reachable from a
 * container on the other network.
 *
 * ## The images are the real ones (WP-22)
 *
 * The run container is `platform-runtime` and the sidecar is `platform-egress`, so this file no
 * longer reasons about stand-ins: there is **no `/repo` bind mount** (the shim is the image's
 * entrypoint), and tinyproxy really filters — "the workspace can reach the allowed host through the
 * proxy and not the one next to it on the same address" is asserted below rather than deferred.
 * `test/e2e/support/docker-workspace.ts` says how the images are obtained, and a missing one fails
 * the suite instead of skipping it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { workspace } from '@platform/infrastructure';
import { PLATFORM_SKILL_NAMES, PLATFORM_SKILLS } from '@platform/prompts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWorkspaceProviderContractSuite } from '../../contract/support/workspace/provider-suite.js';
import {
  ALPINE_IMAGE,
  controlSocketExists,
  type DockerFixture,
  docker,
  exportPath,
  FIXTURE_TASK_BRANCH,
  FIXTURE_TASK_BRANCH_FILE,
  FIXTURE_TASK_BRANCH_MARKER,
  GIT_IMAGE,
  PROJECT_SKILL_FILE,
  plantInWorkspace,
  probeUnderRunContainerConfig,
  REPO_ROOT,
  RUNTIME_IMAGE,
  relaxControlDirectoryForHost,
  removeControlSocket,
  startDockerFixture,
  startEgressTarget,
} from '../support/docker-workspace.js';

let fixture: DockerFixture;

const specFor = (overrides: Parameters<typeof workspace.workspaceSpecFixture>[0] = {}) =>
  workspace.workspaceSpecFixture({
    runId: randomUUID(),
    ...overrides,
    repo: { url: fixture.repoUrl, cacheKey: 'acme', ...overrides.repo },
  });

const startRun = async (overrides: Parameters<typeof workspace.workspaceSpecFixture>[0] = {}) => {
  const spec = specFor(overrides);
  await fixture.provider.updateMirror({
    projectId: spec.projectId,
    repo: spec.repo,
    credential: null,
  });
  return { spec, handle: await fixture.provider.create(spec) };
};

beforeAll(async () => {
  fixture = await startDockerFixture();
}, 300_000);

afterAll(async () => {
  await fixture?.cleanup();
}, 120_000);

describe('the workspace lifecycle against a real daemon', () => {
  it('mirrors from the fixture repository container and clones with the mirror as its source', async () => {
    const spec = specFor();
    const mirror = await fixture.provider.updateMirror({
      projectId: spec.projectId,
      repo: spec.repo,
      credential: null,
    });
    expect(mirror.cachePath).toBe('/cache/acme.git');
    const handle = await fixture.provider.create(spec);
    try {
      const probe = await probeUnderRunContainerConfig(
        fixture.engine,
        handle.containerId,
        'cat /work/repo/README.md; cat /work/repo/.git/objects/info/alternates',
      );
      expect(probe.exitCode).toBe(0);
      expect(probe.output).toContain('# fixture repository');
      // technical/05 §1: the clone's objects come from the shared mirror, which is why gc is
      // disabled on it while a workspace references it.
      expect(probe.output).toContain('/cache/acme.git/objects');
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 180_000);

  /**
   * **PROGRESS backlog 71's countable effect** — WP-53 criterion (4), closed at review.
   *
   * The row asks for *"a re-entry run's workspace carries the task branch's head commit"*, and until
   * the review nothing asserted it at any tier: the mapping `checkoutRef → repo.checkoutBranch` was
   * covered, and `#clone`'s `git checkout "$B" || git checkout -b "$B"` was not. Worse, the one
   * daemon check that set a branch used one that is **not** on the remote, so only the `-b` half had
   * ever run — the half a *first* run takes, not the half a re-entry depends on.
   *
   * Both halves are here, and the assertion is on the checkout's own `HEAD` rather than on the spec
   * (standing rule 82). The fixture's task branch is deliberately **one commit ahead** of `main` and
   * carries a file `main` does not: with equal heads, a provider that ignored `checkoutBranch`
   * outright would pass (rule 43).
   */
  it('checks out a task branch that is on the remote, at that branch’s head (backlog 71)', async () => {
    const spec = specFor({ repo: { checkoutBranch: FIXTURE_TASK_BRANCH } });
    await fixture.provider.updateMirror({
      projectId: spec.projectId,
      repo: spec.repo,
      credential: null,
    });
    const handle = await fixture.provider.create(spec);
    try {
      const probe = await probeUnderRunContainerConfig(
        fixture.engine,
        handle.containerId,
        'git -C /work/repo rev-parse --abbrev-ref HEAD; ' +
          `git -C /work/repo rev-parse HEAD; git -C /work/repo rev-parse ${FIXTURE_TASK_BRANCH}; ` +
          'git -C /work/repo rev-parse main; ' +
          `cat /work/repo/${FIXTURE_TASK_BRANCH_FILE}`,
        // **The run image, not the default `alpine:3.21`**, because this probe needs `git` and only
        // the run image has it (`/usr/bin/git`, measured — the first draft of this case answered
        // `/bin/sh: git: not found`, which is the probe's own image and not a fact about the
        // workspace). It is also the honest container to ask in: it is what the agent gets.
        { image: RUNTIME_IMAGE },
      );
      expect(probe.exitCode).toBe(0);
      const [branch = '', head = '', taskHead = '', mainHead = '', ...rest] = probe.output
        .trim()
        .split('\n');
      expect(branch).toBe(FIXTURE_TASK_BRANCH);
      // The countable effect the row names, in one line.
      expect(head).toBe(taskHead);
      // …and it is a *different* commit from the default branch's, so the assertion above has a
      // subject that could have differed.
      expect(head).not.toBe(mainHead);
      expect(rest.join('\n')).toContain(FIXTURE_TASK_BRANCH_MARKER);
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 180_000);

  it('creates a task branch that is not on the remote, at the default branch’s head', async () => {
    // The `||`'s second half, which is what a task's **first** run takes: the branch does not exist
    // yet, so the clone creates it rather than failing — the behaviour backlog 71 asks the change to
    // answer "in the same commit".
    const spec = specFor({ repo: { checkoutBranch: 'agentic/never-pushed' } });
    await fixture.provider.updateMirror({
      projectId: spec.projectId,
      repo: spec.repo,
      credential: null,
    });
    const handle = await fixture.provider.create(spec);
    try {
      const probe = await probeUnderRunContainerConfig(
        fixture.engine,
        handle.containerId,
        'git -C /work/repo rev-parse --abbrev-ref HEAD; ' +
          'git -C /work/repo rev-parse HEAD; git -C /work/repo rev-parse main; ' +
          `test -e /work/repo/${FIXTURE_TASK_BRANCH_FILE} && echo PRESENT || echo ABSENT`,
        { image: RUNTIME_IMAGE },
      );
      expect(probe.exitCode).toBe(0);
      const [branch = '', head = '', mainHead = '', marker = ''] = probe.output.trim().split('\n');
      expect(branch).toBe('agentic/never-pushed');
      expect(head).toBe(mainHead);
      // And it did **not** silently land on the other branch, which is the mistake a `checkout -b`
      // over a stale working tree would make.
      expect(marker).toBe('ABSENT');
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 180_000);

  /**
   * WP-14a, tier 2: **the skills are in a real container's filesystem, and they are the bytes this
   * repository ships** — asserted by digest, so nothing here can be satisfied by a log line that
   * merely looks right.
   *
   * Three properties, because only together do they mean "provisioned correctly":
   *
   *  1. every skill the spec names is there, byte for byte;
   *  2. the directory holds **only** those — a provider that copied the whole catalogue would be
   *     handing a role skills its tool policy does not back (BD-021, BD-025);
   *  3. the project's own `.claude/skills` is exactly what the project committed, and the platform
   *     wrote nothing inside `.claude/` at all.
   *
   * The fake provider passes the same suite case, and that is the point of doing it here too: it
   * has no filesystem, no clone and no git (standing rule 82).
   */
  it('provisions the platform skills into the run container, byte for byte', async () => {
    const { spec, handle } = await startRun();
    try {
      const expected = spec.skills.map((name) => ({
        name,
        digest: createHash('sha256')
          .update(PLATFORM_SKILLS[name]?.text ?? '')
          .digest('hex'),
      }));
      expect(expected.length).toBeGreaterThan(1);
      const probe = await probeUnderRunContainerConfig(
        fixture.engine,
        handle.containerId,
        'cd /work/repo/.agentic-run/plugins/agentic/skills && ls && sha256sum */SKILL.md',
      );
      expect(probe.exitCode).toBe(0);
      for (const skill of expected) {
        expect(probe.output).toContain(`${skill.digest}  ${skill.name}/SKILL.md`);
      }
      // Only those: `retro` is shipped and belongs to the facilitator, not to this spec.
      expect(PLATFORM_SKILL_NAMES).toContain('retro');
      expect(probe.output).not.toContain('retro');
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 180_000);

  it("leaves the project's own .claude/skills exactly as the project committed it", async () => {
    const { handle } = await startRun();
    try {
      const probe = await probeUnderRunContainerConfig(
        fixture.engine,
        handle.containerId,
        'ls /work/repo/.claude/skills && sha256sum /work/repo/.claude/skills/project-own/SKILL.md',
      );
      expect(probe.exitCode).toBe(0);
      expect(probe.output).toContain(createHash('sha256').update(PROJECT_SKILL_FILE).digest('hex'));
      // Nothing of the platform's is inside `.claude/`: no `_platform` directory (the layout
      // technical/04 described, which the pinned CLI does not discover anyway) and no skill of
      // ours next to the project's.
      expect(probe.output).not.toContain('_platform');
      for (const name of PLATFORM_SKILL_NAMES) {
        expect(probe.output, `${name} must not be in the project's own skills`).not.toContain(name);
      }
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 180_000);

  /**
   * The plugin directory lives inside the checkout — the CLI resolves a relative plugin path
   * against its `cwd` — so provisioning also writes `.git/info/exclude`. Without it the Developer
   * role's `git add -A` sweeps the platform's ten files into the project's merge request, which is
   * a thing a reviewer would see and nobody would have asked for.
   */
  it('leaves the checkout clean, so the platform’s directory cannot reach a commit', async () => {
    const { handle } = await startRun();
    try {
      // `set -e`, and a **canary** the same `git status` must report: an assertion that a command
      // printed nothing passes just as well when the command failed, and the first draft of this case
      // was exactly that (its mutant — the exclude entry removed — stayed green, because the mutation
      // was a no-op *and* the case could not have told the difference).
      const script = [
        'set -e',
        'cd /work/repo',
        'git -c safe.directory=/work/repo status --porcelain',
        'echo ---CANARY---',
        ': > canary-untracked.txt',
        'git -c safe.directory=/work/repo status --porcelain',
        'echo STATUS_END',
      ].join('\n');
      const probe = await probeUnderRunContainerConfig(fixture.engine, handle.containerId, script, {
        image: GIT_IMAGE,
      });
      expect(probe.exitCode, probe.output).toBe(0);
      expect(probe.output).toContain('STATUS_END');
      const [before = '', after = ''] = probe.output.split('---CANARY---');
      // The platform's directory is present and invisible to git...
      expect(before).not.toContain('.agentic-run');
      // ...and `git status` in this checkout does report an untracked file, so the line above is a
      // statement about the exclude entry rather than about a command that said nothing.
      expect(after).toContain('canary-untracked.txt');
      const present = await probeUnderRunContainerConfig(
        fixture.engine,
        handle.containerId,
        'test -d /work/repo/.agentic-run/plugins/agentic/skills && echo PRESENT',
      );
      expect(present.output).toContain('PRESENT');
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 180_000);

  /**
   * The control volume's root must admit the `prep-<run-id>` helper, and that helper is **not** an
   * omnipotent root: `CapDrop: ALL` with only `CAP_CHOWN` added leaves it without
   * `CAP_DAC_OVERRIDE`, so it is an ordinary process subject to the directory's mode bits.
   *
   * This is the assertion `main` was missing for six red runs. The whole failure —
   * `mkdir: can't create directory '/ctl/<uuid>': Permission denied`, three tiers of cases
   * downstream of it — was this one `mkdir`, and nothing named it. It is deliberately *not* routed
   * through the provider: a probe that starts one container says which permission failed, where a
   * `create` says only that a helper exited 1.
   *
   * **What it is worth on each platform.** Against a *named* volume it is worth the same on both,
   * which is the point of using one: a fresh named volume is `root:root 0755` on Docker Desktop
   * and on a Linux runner alike (measured on each). The platform difference lives entirely in the
   * fixture's bind-backed control root, and that is precisely why this case must not use it —
   * standing rule 69 the other way round.
   */
  it('admits the prep helper into a control volume root: root, CAP_DAC_OVERRIDE dropped', async () => {
    // A **throwaway named volume**, deliberately not `fixture.controlVolume`. The fixture's control
    // root is bind-backed and loosened to `0777` so this process can empty it, which would make the
    // probe a tautology: measured, `--user 1000:1000 --cap-drop ALL --cap-add CHOWN` cannot `mkdir`
    // into a `root:root 0755` root but can into a `0777` one, so run `#prepare` as any uid and the
    // e2e would stay green while production broke. A fresh named volume is `root:root 0755` — what
    // `APP_WORKSPACE_CONTROL_VOLUME` is in production — so this is that shape and no other.
    const volume = `agentic-e2e-ctlshape-${randomUUID()}`;
    await docker(['volume', 'create', volume]);
    try {
      const shape = await docker([
        'run',
        '--rm',
        '-v',
        `${volume}:/ctl`,
        ALPINE_IMAGE,
        'ls',
        '-ldn',
        '/ctl',
      ]);
      expect(shape.stdout).toMatch(/^drwxr-xr-x\s+\d+\s+0\s+0\b/);
      const result = await docker(
        [
          'run',
          '--rm',
          '--user',
          '0:0',
          '--cap-drop',
          'ALL',
          '--cap-add',
          'CHOWN',
          '--network',
          'none',
          '-v',
          `${volume}:/ctl`,
          ALPINE_IMAGE,
          'sh',
          '-c',
          `mkdir /ctl/${randomUUID()} && echo ADMITTED`,
        ],
        { allowFailure: true },
      );
      expect(`${result.stdout}${result.stderr}`).toContain('ADMITTED');
      expect(result.ok).toBe(true);
    } finally {
      await docker(['volume', 'rm', '-f', volume], { allowFailure: true });
    }
  }, 60_000);

  /**
   * The engine never pulls; `docker run` does. A `create` through the API answers **404** when the
   * image is absent — measured on this daemon, `{"message":"No such image: <tag>"}` — so an image
   * the fixture assumes rather than ensures is green on every machine that has run the suite
   * before and 21 failures on a clean runner, which is what happened (standing rules 4 and 69).
   */
  it('has every image it will create a container from, because the engine never pulls', async () => {
    const missing: string[] = [];
    for (const image of fixture.images) {
      const present = await docker(['image', 'inspect', image], { allowFailure: true });
      if (!present.ok) {
        missing.push(image);
      }
    }
    expect(missing).toEqual([]);
    // The mapping itself, so a reader never has to take "404 means no such image" on trust — and
    // so the message names the image, which cost this project a CI round when it did not.
    const absent = `alpine:does-not-exist-${randomUUID()}`;
    await expect(
      fixture.engine.createContainer(`agentic-e2e-absent-${randomUUID()}`, {
        Image: absent,
        Cmd: ['true'],
      }),
    ).rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining(absent) });
  }, 60_000);

  it('creates the control sub-directory before the container starts (WP-13 obligation 1)', async () => {
    // Measured on Docker 29.7.2: the daemon refuses a `volume-subpath` that does not exist, which
    // is what makes the ordering load-bearing rather than tidy. Re-measured here so the model in
    // `workspace/testing.ts` is anchored to the daemon rather than to a memory of it.
    const missing = await docker(
      [
        'run',
        '--rm',
        '--mount',
        `type=volume,source=${fixture.controlVolume},target=/ctl,volume-subpath=${randomUUID()}`,
        'alpine:3.21',
        'true',
      ],
      { allowFailure: true },
    );
    expect(missing.ok).toBe(false);
    expect(missing.stderr).toMatch(/no such file or directory/i);

    const { handle } = await startRun();
    try {
      const probe = await probeUnderRunContainerConfig(
        fixture.engine,
        handle.containerId,
        'ls -la /ctl; stat -c "%u:%g %a" /ctl/token',
      );
      expect(probe.output).toContain('token');
      // Owned by the uid the shim runs as, and 0600 — Q51's fail-closed choice.
      expect(probe.output).toContain('1000:1000 600');
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 180_000);

  it('shows one run only its own control directory', async () => {
    const first = await startRun();
    const second = await startRun();
    try {
      const probe = await probeUnderRunContainerConfig(
        fixture.engine,
        first.handle.containerId,
        'ls /ctl',
      );
      // `volume-subpath` is TD-025 §2's whole isolation mechanism: one `ctl` volume, one
      // sub-directory per run, and a workspace that cannot see a sibling's token.
      expect(probe.output).toContain('token');
      expect(probe.output).not.toContain(second.handle.runId);
    } finally {
      await fixture.provider.destroy(first.handle);
      await fixture.provider.destroy(second.handle);
    }
  }, 180_000);

  /**
   * `destroy` says it removes the control directory "which holds the run token"; until now only
   * the *script* was asserted (`provider.test.ts`), never the outcome.
   *
   * It did not hold on Linux. `#prepare` hands the directory to uid 1000 as `0700`, and the
   * `ctlrm-<run-id>` helper is root with `CapDrop: ALL` and nothing added — no `CAP_DAC_OVERRIDE`,
   * so it cannot descend into a directory it no longer owns. `#teardown` runs the step through
   * `step()`, which logs `workspace teardown partial` and carries on, so the token simply stayed on
   * the shared control volume. Measured on the daemon before the fix: `rm -rf /ctl/<id>` exits 1.
   *
   * The listing is taken by a container, not from the host, so this reads the volume rather than
   * the bind's macOS view of it.
   */
  const controlVolumeListing = async (): Promise<string> => {
    const listing = await docker([
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${fixture.controlVolume}:/ctl`,
      ALPINE_IMAGE,
      'ls',
      '-A',
      '/ctl',
    ]);
    return listing.stdout;
  };

  it('destroy leaves nothing of the run on the control volume, token and all', async () => {
    const { handle } = await startRun();
    await fixture.provider.destroy(handle);
    expect(await controlVolumeListing()).not.toContain(handle.runId);
  }, 180_000);

  /**
   * The adversary is the agent, and it owns the directory the launcher has to reclaim.
   *
   * `<ctl>/<run-id>` is mounted into the run container read-write and chowned to uid 1000, so the
   * agent may `chmod 000` it — and root with `CapDrop: ALL` is an ordinary non-owner. Measured:
   * with `CAP_CHOWN` only, `chown -R` + `chmod -R` + `rm -rf` exits 1 and the directory survives
   * holding the run token; with `CAP_DAC_OVERRIDE` a plain `rm -rf` exits 0. `#teardown` only logs
   * a failed step, and the backstop — `purgeExpired`'s control-directory sweep since WP-53 — reclaims
   * through the very same two helpers, so a removal that fails here fails there too.
   *
   * The write is done from a container on the run's own `volume-subpath` mount as uid 1000 rather
   * than through the agent, because the agent is a stand-in until WP-22; the *mount* and the *uid*
   * are the real ones, read back from the run container's own configuration.
   *
   * ## On this fixture's shape, the claim is the verdict's honesty — PROGRESS backlog 147
   *
   * This file's control volume is **bind-backed** onto a host directory, and on Docker Desktop for
   * macOS the locked case does not reclaim: measured 2 of 2 on 2026-09-25, the shim's two Unix
   * sockets (`ctl.sock`, `cred.sock`) survive the guest's `rm -rf` on the host side, and in the
   * guest they are entries `readdir` returns and `lstat`/`unlink` answer `ENOENT` for — not even a
   * full-capability root container removes them. Before WP-74 step 1 read that directory as empty
   * (busybox `ls` names such an entry on stderr only) and step 2 then failed on it: two helpers
   * disagreeing about one directory. So what this shape can assert on every platform is that the
   * **verdict agrees with the volume** — a directory that survives is reported, by step 1, as a
   * failed `control-dir` step — and that **the run token never survives**, which it does not on
   * either platform. Full reclamation of a locked directory is asserted on production's shape, a
   * plain named volume, in "on production's control-volume shape, a plain named volume" below,
   * under this case's former name.
   */
  it('destroy reports a locked control directory it could not empty, and never leaves the token', async () => {
    const { handle } = await startRun();
    const hostile = await probeUnderRunContainerConfig(
      fixture.engine,
      handle.containerId,
      'chmod 000 /ctl; stat -c "MODE=%a OWNER=%u" /ctl',
      { user: '1000:1000' },
    );
    // The lock takes on both platforms — measured, `MODE=0 OWNER=1000` through the subpath mount
    // on Docker Desktop as well as on Linux — so this is asserted, not hedged.
    expect(hostile.output).toContain('MODE=0 ');
    const before = fixture.warnings.length;
    await fixture.provider.destroy(handle);
    const warnings = fixture.warnings.slice(before);
    const failed = warnings
      .filter((entry) => entry.message === 'workspace teardown step failed')
      .map((entry) => entry.fields['step']);
    const survived = (await controlVolumeListing()).split('\n').includes(handle.runId);
    // The verdict agrees with the volume, in both directions: a surviving directory is a reported
    // failure, and a reported failure is a surviving directory.
    expect(failed.includes('control-dir')).toBe(survived);
    // On Linux — CI's shape — the bind-backed directory is reclaimed, as it was before WP-74; only
    // Docker Desktop for macOS keeps the sockets. Without this a regression that leaves the directory
    // behind *and* reports it would pass on CI (WP-74 review round 1).
    if (process.platform === 'linux') expect(survived).toBe(false);
    if (survived) {
      // Reported by **step 1**, whose emptiness test now counts what it cannot stat — never by
      // step 2 refusing a directory step 1 had called empty.
      const helpers = warnings
        .filter((entry) => entry.message === 'workspace helper container failed')
        .map((entry) => entry.fields['helper']);
      expect(helpers).toEqual([`ctlempty-${handle.runId}`]);
      // What survives is never the credential.
      const left = await docker(
        [
          'run',
          '--rm',
          '--network',
          'none',
          '-v',
          `${fixture.controlVolume}:/ctl`,
          ALPINE_IMAGE,
          'sh',
          '-c',
          `ls -A /ctl/${handle.runId} 2>&1`,
        ],
        // `ls` exits 1 over an entry it cannot `lstat`, which is the state being inspected.
        { allowFailure: true },
      );
      expect(left.stdout).not.toContain('token');
      // And the sweep, which reclaims through the same two helpers, reports it rather than
      // skipping it or counting it removed. Aged past the grace window first — the sweep's own
      // `find -mmin` withholds a young directory by design.
      await docker([
        'run',
        '--rm',
        '--network',
        'none',
        '-v',
        `${fixture.controlVolume}:/ctl`,
        ALPINE_IMAGE,
        'touch',
        '-d',
        '2000-01-01 00:00:00',
        `/ctl/${handle.runId}`,
      ]);
      const report = await fixture.provider.purgeExpired(new Date());
      expect(report.controlDirectories).toContainEqual({
        runId: handle.runId,
        removed: false,
        keptReason: 'remove_failed',
      });
    }
  }, 180_000);

  /**
   * The other way an agent defeats reclamation: not by locking the directory, by **filling it**.
   *
   * Step 1 used to empty the directory with `rm -rf <dir>/*`, and a glob is an argument list.
   * Measured on a named volume, 8 000 files of 240-character names — about 1.9 MB of argv against
   * a ~2 MB `ARG_MAX`: `/bin/sh: rm: Argument list too long`, the helper exiting **0**, 8 001
   * entries left and the token among them, and `ctlrm` then exiting 1 because root cannot unlink
   * inside a `0755` directory it does not own. Silent, and the run token stays on the shared
   * volume — the exact thing this branch exists to close.
   *
   * The count is the point of the case, so it is a constant with its arithmetic rather than a
   * round number: below the cliff this case passes against the defect.
   */
  it('destroy reclaims the control directory even after the agent floods it past ARG_MAX', async () => {
    const { handle } = await startRun();
    // 8 000 x 240 characters is ~1.9 MB of argv, against a ~2 MB ceiling. Cheap to make (file
    // creation, not CPU) and it is the smallest shape that crosses it with a legal filename.
    const flood = await probeUnderRunContainerConfig(
      fixture.engine,
      handle.containerId,
      [
        'n=$(printf "%0.sx" $(seq 1 240))',
        'i=0',
        'while [ $i -lt 8000 ]; do : > "/ctl/$n$i"; i=$((i+1)); done',
        'ls -A /ctl | wc -l | sed "s/^/entries=/"',
      ].join('\n'),
      { user: '1000:1000' },
    );
    // At least the 8 000, plus whatever the run legitimately put there (`token`, and the shim's
    // `ctl.sock`) — counted rather than pinned, because the exact figure is the launcher's
    // business and this case is about crossing the cliff.
    const entries = Number(/entries=(\d+)/.exec(flood.output)?.[1] ?? '0');
    expect(entries).toBeGreaterThanOrEqual(8001);
    const before = fixture.warnings.length;
    await fixture.provider.destroy(handle);
    expect(await controlVolumeListing()).not.toContain(handle.runId);
    // Loudly, if at all: the emptiness test is the helper's verdict, so a step that deleted
    // nothing fails here instead of reporting success.
    const failed = fixture.warnings
      .slice(before)
      .filter((entry) => entry.message === 'workspace teardown step failed')
      .map((entry) => entry.fields['step']);
    expect(failed).not.toContain('control-dir');
  }, 180_000);
});

/**
 * WP-74, PROGRESS backlog 82: a run with no file tool and no shell gets **no checkout and the whole
 * container**. Every assertion is read off the daemon — the names it was asked to create, its own
 * `inspect`, and files and sockets reached from a container under the run's recorded configuration —
 * never off the spec (standing rule 82).
 */
describe('a run with no checkout (WP-74)', () => {
  /** The helper containers created for `runId` since `from`, by role (`prep-<id>` → `prep`). */
  const helpersSince = (from: number, runId: string): string[] =>
    fixture.engine.createdNames
      .slice(from)
      .filter((name) => name.endsWith(`-${runId}`))
      .map((name) => name.slice(0, -`-${runId}`.length));

  it('asks the daemon for no mirror and no clone helper, where a run with a checkout asks for both', async () => {
    const from = fixture.engine.createdNames.length;
    const spec = workspace.repoLessWorkspaceSpecFixture({ runId: randomUUID() });
    const handle = await fixture.provider.create(spec);
    try {
      expect(helpersSince(from, spec.runId)).toEqual([
        'prep',
        'skills',
        'egresscfg',
        'egress',
        'ws',
      ]);
      expect(
        fixture.engine.createdNames.slice(from).filter((n) => n.startsWith('mirror-')),
      ).toEqual([]);
    } finally {
      await fixture.provider.destroy(handle);
    }
    // The other direction (rule 42), through the same record: the mirror helper precedes the
    // create, and the clone runs in its place in the sequence.
    const again = fixture.engine.createdNames.length;
    const ful = await startRun();
    try {
      expect(fixture.engine.createdNames.slice(again)).toContain('mirror-acme');
      expect(helpersSince(again, ful.spec.runId)).toEqual([
        'prep',
        'clone',
        'skills',
        'egresscfg',
        'egress',
        'ws',
      ]);
    } finally {
      await fixture.provider.destroy(ful.handle);
    }
  }, 240_000);

  it('keeps its network, volume, sidecar and a control socket the shim accepts — and `agentic:kb` on disk', async () => {
    const spec = workspace.repoLessWorkspaceSpecFixture({ runId: randomUUID() });
    const handle = await fixture.provider.create(spec);
    try {
      await relaxControlDirectoryForHost(fixture, handle.runId);
      const attachment = await fixture.provider.attach(handle);
      expect(attachment.workdir).toBe('/work/repo');
      expect(await controlSocketExists(fixture, handle.runId)).toBe(true);
      expect(handle.sidecarContainerId).not.toBeNull();
      const sidecar = await fixture.engine.inspectContainer(handle.sidecarContainerId as string);
      expect(sidecar.State.Running).toBe(true);
      await docker(['network', 'inspect', `run-${handle.runId}`]);
      await docker(['volume', 'inspect', `ws-${handle.runId}`]);

      // The shim accepts a connection on the socket `attach` answered, asked from a container on
      // the run's own mount as the run's own uid — the connection a runner makes.
      const connected = await probeUnderRunContainerConfig(
        fixture.engine,
        handle.containerId,
        `node -e "require('net').connect('/ctl/ctl.sock').on('connect',()=>{console.log('CONNECTED');process.exit(0)}).on('error',(e)=>{console.log('REFUSED '+e.code);process.exit(1)})"`,
        { image: RUNTIME_IMAGE },
      );
      expect(connected.output).toContain('CONNECTED');

      // The skill is asserted on the **file** (criterion 4), byte for byte, and the tree around it
      // is the empty working directory: no clone, so no `.git`.
      const digest = createHash('sha256')
        .update(PLATFORM_SKILLS['kb']?.text ?? '')
        .digest('hex');
      const tree = await probeUnderRunContainerConfig(
        fixture.engine,
        handle.containerId,
        [
          'cd /work/repo && sha256sum .agentic-run/plugins/agentic/skills/kb/SKILL.md',
          'ls -A /work/repo',
          'stat -c "OWNER=%u" /work/repo',
        ].join(' && '),
      );
      expect(tree.exitCode).toBe(0);
      expect(tree.output).toContain(`${digest}  .agentic-run/plugins/agentic/skills/kb/SKILL.md`);
      expect(tree.output).not.toContain('.git');
      expect(tree.output).toContain('OWNER=1000');

      // Criterion (6): no `repo-cache` mount, in the daemon's own record — one fewer read-only view
      // of every project's mirror.
      const inspect = (await fixture.engine.inspectContainer(handle.containerId)) as unknown as {
        Mounts: { Destination: string }[];
      };
      expect(inspect.Mounts.map((mount) => mount.Destination).sort()).toEqual(['/ctl', '/work']);
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 240_000);

  it('refuses an export by name, before the daemon is asked for an export helper', async () => {
    const spec = workspace.repoLessWorkspaceSpecFixture({ runId: randomUUID() });
    const handle = await fixture.provider.create(spec);
    try {
      const from = fixture.engine.createdNames.length;
      await expect(
        fixture.provider.export(
          handle,
          { branch: 'agentic/task-1', tarballPath: null, commitMessage: 'wip' },
          null,
        ),
      ).rejects.toMatchObject({ code: 'invalid_spec', message: /no checkout to export/ });
      expect(fixture.engine.createdNames.slice(from)).toEqual([]);
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 180_000);
});

describe('the hardening flags, as the daemon recorded them and as the kernel enforces them', () => {
  let handle: Awaited<ReturnType<typeof startRun>>['handle'];

  beforeAll(async () => {
    handle = (await startRun()).handle;
  }, 180_000);

  afterAll(async () => {
    await fixture.provider.destroy(handle);
  }, 120_000);

  it('recorded every flag technical/05 names', async () => {
    const inspect = (await fixture.engine.inspectContainer(handle.containerId)) as unknown as {
      Config: { User: string };
      HostConfig: Record<string, unknown>;
    };
    expect(inspect.Config.User).toBe('1000:1000');
    expect(inspect.HostConfig['CapDrop']).toEqual(['ALL']);
    expect(inspect.HostConfig['SecurityOpt']).toEqual(['no-new-privileges:true']);
    expect(inspect.HostConfig['ReadonlyRootfs']).toBe(true);
    expect(inspect.HostConfig['Init']).toBe(true);
    expect(inspect.HostConfig['PidsLimit']).toBe(256);
    expect(inspect.HostConfig['Memory']).toBe(512 * 1024 * 1024);
    expect(inspect.HostConfig['NanoCpus']).toBe(1_000_000_000);
    expect(inspect.HostConfig['Privileged']).toBe(false);
    expect(inspect.HostConfig['PublishAllPorts']).toBe(false);
    expect(inspect.HostConfig['Binds']).toBeFalsy();
  });

  it('--read-only refuses a write outside the workspace and allows one inside it', async () => {
    const outside = await probeUnderRunContainerConfig(
      fixture.engine,
      handle.containerId,
      'echo compromised > /etc/probe 2>&1',
    );
    expect(outside.exitCode).not.toBe(0);
    expect(outside.output).toMatch(/read-only file system/i);

    // The other half: without it, a container where *every* write failed would pass the negative.
    const inside = await probeUnderRunContainerConfig(
      fixture.engine,
      handle.containerId,
      'echo ok > /work/repo/.probe && cat /work/repo/.probe && rm /work/repo/.probe',
    );
    expect(inside.exitCode).toBe(0);
    expect(inside.output).toContain('ok');
  });

  it('--user 1000 runs the workspace as a non-root uid', async () => {
    const probe = await probeUnderRunContainerConfig(fixture.engine, handle.containerId, 'id -u');
    expect(probe.output.trim()).toBe('1000');
  });

  it('--cap-drop ALL refuses a capability-requiring syscall that succeeds with the capability', async () => {
    const script = 'touch /tmp/f && chown 0:0 /tmp/f 2>&1; echo "rc=$?"';
    const dropped = await probeUnderRunContainerConfig(fixture.engine, handle.containerId, script);
    expect(dropped.output).toMatch(/operation not permitted|not permitted/i);
    expect(dropped.output).toContain('rc=1');

    // The positive control, and the reason the negative is evidence: the same command, the same
    // image, the same mounts — only `CAP_CHOWN` added and the uid raised — succeeds. Without this,
    // a `chown` that failed for an unrelated reason would read as the capability working.
    const granted = await probeUnderRunContainerConfig(fixture.engine, handle.containerId, script, {
      user: '0:0',
      capAdd: ['CHOWN'],
    });
    expect(granted.output).toContain('rc=0');
  });

  it('no-new-privileges is what the kernel reports, not what we passed', async () => {
    const probe = await probeUnderRunContainerConfig(
      fixture.engine,
      handle.containerId,
      'grep NoNewPrivs /proc/self/status',
    );
    expect(probe.output).toMatch(/NoNewPrivs:\s*1/);
  });

  it('--init makes a reaper PID 1, so an orphan inside the workspace is not the shim', async () => {
    const probe = await probeUnderRunContainerConfig(
      fixture.engine,
      handle.containerId,
      'cat /proc/1/comm',
    );
    expect(probe.output.trim()).toBe('docker-init');
  });

  it('the memory limit is the one the cgroup enforces', async () => {
    const probe = await probeUnderRunContainerConfig(
      fixture.engine,
      handle.containerId,
      'cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes',
    );
    // 512 MiB, read out of the container's own cgroup rather than out of `docker inspect`.
    expect(probe.output.trim()).toBe(String(512 * 1024 * 1024));
  });

  it('the workspace has no route off its internal network, and the sidecar has two networks', async () => {
    const reachable = await probeUnderRunContainerConfig(
      fixture.engine,
      handle.containerId,
      // The fixture repository is on the bridge network; the workspace is on `run-<id>`, which is
      // `internal: true`. Bounded so a firewalled environment fails fast rather than hanging.
      `nc -z -w 3 ${fixture.repoContainer} 9418; echo "rc=$?"; ip route | grep -c "^default"`,
    );
    expect(reachable.output).toContain('rc=1');
    // No default route at all — the same thing WP-13 measured, now for a network this provider
    // created. (busybox `ip route show default` ignores its own selector; the line is matched.)
    expect(reachable.output.trim().endsWith('0')).toBe(true);

    // And the neighbour it *can* name is the sidecar, by container name on the embedded resolver.
    //
    // `getent hosts`, not `nslookup`. This assertion was `nslookup … ; rc=0` and it was the last
    // red test on `main`: busybox `nslookup` also queries `<name>.<search-domain>`, the embedded
    // resolver forwards that upstream, an `internal` network has no route upstream, and the whole
    // invocation exits 1 while the name resolves. A developer machine has no `search` line; a
    // cloud runner's host does, and Docker copies it into every container. Measured on one
    // internal network, varying nothing but that: `nslookup` rc 0 → 1, `getent hosts` rc 0 → 0,
    // same address both times. So the old probe's false branch meant "the name did not resolve
    // **or** some other query in the same process did not" (standing rule 56).
    //
    // The address is asserted and not only the status, and the pair is completed by a name that
    // *would* resolve if this network had a route off it — `example.com` rather than something
    // `.invalid`, which would fail for the wrong reason and make the negative vacuous (rule 42).
    const neighbour = await probeUnderRunContainerConfig(
      fixture.engine,
      handle.containerId,
      [
        `getent hosts egress-${handle.runId} | head -1 | sed 's/^/neighbour=/'`,
        `getent hosts egress-${handle.runId} >/dev/null; echo "neighbour_rc=$?"`,
        'getent hosts example.com >/dev/null; echo "upstream_rc=$?"',
      ].join('\n'),
      // The upstream half is a query the internal network drops, so it costs a full resolver
      // timeout: 10 s at the default budget, 2 s at this one — measured, same two answers. The
      // trade, since bounding a timeout can always hide a slow success: an `internal` network has
      // no route at all, so the packet is dropped rather than answered late, and a network that
      // *did* have a route would be answered by the host resolver far inside one second. The
      // "no route at all" claim does not rest on this either way — `nc` and the default-route
      // count above carry it (standing rule 43).
      { dnsOptions: ['timeout:1', 'attempts:1'] },
    );
    expect(neighbour.output).toContain('neighbour_rc=0');
    expect(neighbour.output).toMatch(/neighbour=\d+\.\d+\.\d+\.\d+\s/);
    expect(neighbour.output).not.toContain('upstream_rc=0');

    const sidecar = (await fixture.engine.inspectContainer(
      handle.sidecarContainerId ?? '',
    )) as unknown as { NetworkSettings: { Networks: Record<string, unknown> } };
    // One container on two networks *is* the network policy. What the proxy on it does with a
    // request is the `egress policy` block below, against the real tinyproxy.
    expect(Object.keys(sidecar.NetworkSettings.Networks)).toHaveLength(2);
    const runContainer = (await fixture.engine.inspectContainer(handle.containerId)) as unknown as {
      NetworkSettings: { Networks: Record<string, unknown> };
    };
    expect(Object.keys(runContainer.NetworkSettings.Networks)).toHaveLength(1);
  });

  /**
   * technical/05, in the daemon's own record: **no** host path in a run container.
   *
   * Until WP-22 this case asserted the opposite — exactly one bind, the repository read-only at
   * `/repo` — because the shim had to be started from TypeScript source and `hardening.ts` named
   * that as its single hole. With `platform-runtime` the shim is the image's entrypoint,
   * `WorkspaceImages.runtimeSourceDir` is `null`, and the hole is closed rather than documented.
   */
  it('mounts no host path into the run container', async () => {
    const inspect = (await fixture.engine.inspectContainer(handle.containerId)) as unknown as {
      Mounts: { Type: string; Source: string; Destination: string; RW: boolean }[];
    };
    expect(inspect.Mounts.filter((mount) => mount.Type === 'bind')).toEqual([]);
    expect(inspect.Mounts.some((mount) => mount.Source.includes('docker.sock'))).toBe(false);
    // Paired with the positive, so an empty `Mounts` could not pass this (standing rule 42): the
    // three named volumes are still there — the cache as the run's own mirror only (WP-75).
    expect(inspect.Mounts.map((mount) => mount.Destination).sort()).toEqual([
      '/cache/acme.git',
      '/ctl',
      '/work',
    ]);
  });
});

describe('mount escapes', () => {
  it('refuses a run id that could name another directory', async () => {
    for (const runId of [
      '../other-run',
      '..%2fother-run',
      `${randomUUID()}/../other`,
      `${randomUUID()}\0../other`,
    ]) {
      await expect(fixture.provider.create(specFor({ runId }))).rejects.toMatchObject({
        code: 'invalid_spec',
      });
    }
  });

  it('refuses a bind source that is a symlink, because the daemon would follow it', async () => {
    const dir = await workspace.shortTempDir('agentic-e2e-link-');
    try {
      const link = path.join(dir, 'repo');
      await symlink('/', link);
      expect(() => workspace.assertSafeBindSource(link)).toThrow(/is a symlink/);
      // And the guard is not merely refusing everything: the real repository passes.
      expect(workspace.assertSafeBindSource(REPO_ROOT)).toBe(REPO_ROOT);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The measurement that replaced the deny-list (`hardening.ts` § "Why an allow-condition").
   *
   * On this machine `/var/run/docker.sock` is a symlink into `$HOME`, so passing *it* would be
   * refused by the symlink branch and prove nothing about the branch under test; the daemon
   * resolves a bind source itself, so the realpath is the value that matters and the value the
   * guard must refuse. The round-1 guard accepted it and the daemon recorded the bind.
   */
  it('refuses the docker socket at the realpath the daemon would bind', () => {
    const socket = realpathSync('/var/run/docker.sock');
    expect(() => workspace.assertSafeBindSource(socket)).toThrow(/not a checkout/);
    // Paired with the positive, so a guard that refused everything could not pass (rule 42).
    expect(workspace.assertSafeBindSource(REPO_ROOT)).toBe(REPO_ROOT);
  });

  it('drops a symlink that escapes the workspace from the exported archive', async () => {
    const { handle } = await startRun();
    try {
      await plantInWorkspace(
        fixture,
        handle.volumeName,
        'ln -sf ../../../../etc/passwd /work/repo/escape && ln -sf README.md /work/repo/inside',
      );
      const target = exportPath(fixture, `${handle.runId}.tar`);
      const result = await fixture.provider.export(
        handle,
        { branch: 'agentic/e2e', tarballPath: target, commitMessage: 'wip: e2e' },
        null,
      );
      expect(result.droppedLinks).toBe(1);
      const names = workspace.parseTar(await readFile(target)).map((entry) => entry.name);
      expect(names).toContain('repo/README.md');
      expect(names.some((name) => name.endsWith('/escape'))).toBe(false);
      // The link that stays inside is kept: a filter that dropped every link would pass the
      // assertion above and quietly mangle every repository that uses one.
      expect(names.some((name) => name.endsWith('/inside'))).toBe(true);
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 180_000);
});

describe('export', () => {
  it('pushes the branch to the fixture repository and writes a tarball without .git', async () => {
    const { handle } = await startRun();
    try {
      await plantInWorkspace(
        fixture,
        handle.volumeName,
        'printf "agent work\\n" > /work/repo/AGENT.md',
      );
      const target = exportPath(fixture, `${handle.runId}-push.tar`);
      const result = await fixture.provider.export(
        handle,
        { branch: 'agentic/e2e-push', tarballPath: target, commitMessage: 'wip: e2e push' },
        { host: fixture.repoContainer, username: 'agentic', password: 'unused-by-git-daemon' },
      );
      expect(result.pushed).toBe(true);
      expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);

      // Read the branch back out of the *fixture repository*, not out of the workspace: "the push
      // landed" is a claim about the remote.
      const refs = await docker([
        'run',
        '--rm',
        '--network',
        fixture.network,
        '--entrypoint',
        'git',
        'alpine/git:v2.49.1',
        'ls-remote',
        fixture.repoUrl,
        'refs/heads/agentic/e2e-push',
      ]);
      expect(refs.stdout).toContain('refs/heads/agentic/e2e-push');

      const names = workspace.parseTar(await readFile(target)).map((entry) => entry.name);
      expect(names).toContain('repo/AGENT.md');
      expect(names.some((name) => name.split('/').includes('.git'))).toBe(false);
      expect(names.some((name) => name.split('/').includes('node_modules'))).toBe(false);
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 240_000);
});

/**
 * **WP-75 — one project's mirror, not every project's** (PROGRESS backlog 148, TD-021:9's
 * *"per-project bare mirror ro at `/cache`"*).
 *
 * Two projects' mirrors on **one** `repo-cache` volume — `acme` (the run's) and `beta` (another
 * project's, the same remote under a different key: what separates two projects on the volume is
 * the directory, and the directory is what the mount scopes). Every assertion is read off the
 * daemon: the mounts it recorded for the run container and was asked for by the export helper, and
 * what a container under the run container's own recorded `HostConfig` can list and read (standing
 * rule 82). Each negative has the positive that gives it a subject (rule 42): `beta`'s `config` and
 * `packed-refs` **are** readable by uid 1000 through a whole-volume mount — the pre-WP-75 shape — so
 * "refused inside the run" is the scoping, not a mirror that is not there; and the planted hooks
 * **do** fire under a plain `git commit` in the same tree, so "no side effect after the export" is
 * the export disabling them, not a hook that could never run.
 *
 * The cache volume is a **plain named volume** in the daemon's own storage — production's shape,
 * and not the bind-backed shape the control volume has in this file (standing rule 69).
 */
describe('one project’s mirror, not every project’s (WP-75)', () => {
  const OTHER_KEY = 'beta';
  interface MountRecord {
    readonly Type: string;
    readonly Source: string;
    readonly Target: string;
    readonly ReadOnly?: boolean;
    readonly VolumeOptions?: { readonly Subpath?: string };
  }
  const cacheMountsOf = (body: unknown): MountRecord[] =>
    ((body as { HostConfig?: { Mounts?: MountRecord[] } }).HostConfig?.Mounts ?? []).filter(
      (mount) => mount.Source === fixture.cacheVolume,
    );
  const OWN_MIRROR_MOUNT = {
    Type: 'volume',
    Target: '/cache/acme.git',
    ReadOnly: true,
    VolumeOptions: { Subpath: 'acme.git' },
  };

  beforeAll(async () => {
    await fixture.provider.updateMirror({
      projectId: randomUUID(),
      repo: specFor({ repo: { cacheKey: OTHER_KEY } }).repo,
      credential: null,
    });
    // The positive (rule 42): uid 1000, the run's uid, reads the other project's mirror through a
    // mount of the whole volume — which is what the run container had before WP-75.
    const whole = await docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      '1000:1000',
      '-v',
      `${fixture.cacheVolume}:/cache:ro`,
      ALPINE_IMAGE,
      'sh',
      '-c',
      `ls -A /cache; cat /cache/${OTHER_KEY}.git/config /cache/${OTHER_KEY}.git/packed-refs`,
    ]);
    expect(whole.stdout).toContain(`${OTHER_KEY}.git`);
    expect(whole.stdout).toContain('[remote "origin"]');
    expect(whole.stdout).toContain('refs/heads/main');
  }, 240_000);

  it('mounts the run’s own mirror at the path its alternates name, and no other project’s', async () => {
    const { handle } = await startRun();
    try {
      const inspect = (await fixture.engine.inspectContainer(handle.containerId)) as unknown as {
        HostConfig: { Mounts: MountRecord[] };
        Mounts: { Destination: string }[];
      };
      const recorded = cacheMountsOf(inspect);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject(OWN_MIRROR_MOUNT);
      expect(inspect.Mounts.map((mount) => mount.Destination).sort()).toEqual([
        '/cache/acme.git',
        '/ctl',
        '/work',
      ]);

      const probe = await probeUnderRunContainerConfig(
        fixture.engine,
        handle.containerId,
        [
          'echo "LS=$(ls -A /cache | tr "\\n" " ")"',
          `if cat /cache/${OTHER_KEY}.git/config >/dev/null 2>&1; then echo B_CONFIG=read; else echo B_CONFIG=refused; fi`,
          `if cat /cache/${OTHER_KEY}.git/packed-refs >/dev/null 2>&1; then echo B_REFS=read; else echo B_REFS=refused; fi`,
          'cat /work/repo/.git/objects/info/alternates',
          // Nothing local: every object this clone has, it has through the alternates — so the
          // `log -p` below reads the mirror, not a copy (rule 43).
          'git -C /work/repo count-objects -v | grep -E "^(count|in-pack):"',
          'git -C /work/repo log -1 -p --format=COMMIT=%H HEAD; echo "LOG_EXIT=$?"',
        ].join('\n'),
        { image: RUNTIME_IMAGE },
      );
      expect(probe.output).toContain('LS=acme.git \n');
      expect(probe.output).toContain('B_CONFIG=refused');
      expect(probe.output).toContain('B_REFS=refused');
      expect(probe.output).toContain('/cache/acme.git/objects');
      expect(probe.output).toContain('count: 0');
      expect(probe.output).toContain('in-pack: 0');
      // An object older than the run, decoded through the alternates: the regression the narrowing
      // risks, measured rather than argued.
      expect(probe.output).toMatch(/COMMIT=[0-9a-f]{40}/);
      expect(probe.output).toContain('+# fixture repository');
      expect(probe.output).toContain('LOG_EXIT=0');
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 240_000);

  it('refuses a checkout whose mirror was never made by name, before the run container is asked for', async () => {
    const from = fixture.engine.createdNames.length;
    const spec = specFor({ repo: { cacheKey: 'never-mirrored' } });
    await expect(fixture.provider.create(spec)).rejects.toMatchObject({
      code: 'workspace_failed',
      message: /no mirror to clone from/,
    });
    // The clone helper is the last container this create asked for before its own teardown
    // (`ctlempty`, `ctlrm` — `create`'s catch): no skills, no sidecar, no run container, so the
    // daemon's sub-path refusal was never reachable (the WP-74 case above asserts the other
    // direction, a repo-ful create that asks for `ws`).
    expect(
      fixture.engine.createdNames
        .slice(from)
        .filter((name) => name.endsWith(`-${spec.runId}`))
        .map((name) => name.slice(0, -`-${spec.runId}`.length)),
    ).toEqual(['prep', 'clone', 'ctlempty', 'ctlrm']);
    // What the check pre-empts, measured on this daemon rather than assumed from the control
    // volume's case: a container mounting a mirror that does not exist by sub-path is refused.
    // Named, and removed below whatever happened: a `run` whose start the daemon refuses can leave
    // the created container behind, and `--rm` only acts on one that started.
    const probe = `agentic-e2e-subpath-${spec.runId}`;
    const refused = await docker(
      [
        'run',
        '--rm',
        '--name',
        probe,
        '--network',
        'none',
        '--mount',
        `type=volume,src=${fixture.cacheVolume},dst=/cache/never-mirrored.git,readonly,volume-subpath=never-mirrored.git`,
        ALPINE_IMAGE,
        'true',
      ],
      { allowFailure: true },
    );
    await docker(['rm', '-f', '-v', probe], { allowFailure: true });
    expect(refused.ok).toBe(false);
    expect(refused.stderr).toMatch(/never-mirrored\.git/);
  }, 180_000);

  /**
   * **What the run owns under `.git/` runs nothing in the export** (WP-75, backlogs 148 and 152).
   *
   * The positive control comes **first and on a copy** (`/work/pc`): the export replaces the
   * checkout's `.git/config` and removes its hooks, so a control run afterwards would be measuring the
   * platform's configuration rather than the run's. Each vector writes `/work/MARK-<name>`; the copy
   * shows every one of them firing under plain git in the same tree, same uid, same one-mirror mount;
   * the markers are cleared, the copy removed, and only then is the export run.
   */
  const markers = async (volume: string): Promise<string[]> => {
    const listing = await docker([
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${volume}:/work:ro`,
      ALPINE_IMAGE,
      'ls',
      '-A',
      '/work',
    ]);
    return listing.stdout.split('\n').filter((name) => name.startsWith('MARK-'));
  };
  const clearControl = async (volume: string): Promise<void> => {
    await docker([
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${volume}:/work`,
      ALPINE_IMAGE,
      'sh',
      '-c',
      'rm -rf /work/pc /work/MARK-*',
    ]);
  };
  /** Plain git — no platform wrapper, no replaced configuration — on a copy of the run's tree. */
  const underPlainGit = async (
    volume: string,
    commands: readonly string[],
    { inPlace = false }: { readonly inPlace?: boolean } = {},
  ): Promise<void> => {
    await docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      '1000:1000',
      '-e',
      'HOME=/tmp',
      '-v',
      `${volume}:/work`,
      '--mount',
      `type=volume,src=${fixture.cacheVolume},dst=/cache/acme.git,readonly,volume-subpath=acme.git`,
      '--entrypoint',
      'sh',
      GIT_IMAGE,
      '-c',
      [
        "git config --global --add safe.directory '*'",
        'git config --global user.email probe@example.invalid',
        'git config --global user.name probe',
        // In place only when a copy cannot be made faithfully — a directory the run left
        // unreadable is one `cp -a` cannot copy either.
        inPlace ? 'cd /work/repo' : 'cp -a /work/repo /work/pc && cd /work/pc',
        ...commands.map((command) => `${command} >/dev/null 2>&1 || true`),
      ].join('\n'),
    ]);
  };
  const exportPushing = (handle: Awaited<ReturnType<typeof startRun>>['handle']) =>
    fixture.provider.export(
      handle,
      { branch: `agentic/e2e-${handle.runId}`, tarballPath: null, commitMessage: 'wip' },
      { host: fixture.repoContainer, username: 'agentic', password: 'unused-by-git-daemon' },
    );
  const remoteHas = async (branch: string): Promise<boolean> => {
    const refs = await docker([
      'run',
      '--rm',
      '--network',
      fixture.network,
      '--entrypoint',
      'git',
      GIT_IMAGE,
      'ls-remote',
      fixture.repoUrl,
      `refs/heads/${branch}`,
    ]);
    return refs.stdout.includes(`refs/heads/${branch}`);
  };

  const HOOKS = [
    'pre-commit',
    'prepare-commit-msg',
    'commit-msg',
    'post-commit',
    'reference-transaction',
    'post-index-change',
    'pre-push',
  ];
  const plantHooks = (dir: string): string =>
    [
      `mkdir -p ${dir}`,
      ...HOOKS.map(
        (hook) =>
          `printf '#!/bin/sh\\ntouch /work/MARK-hook-${hook}\\n' > ${dir}/${hook} && chmod 755 ${dir}/${hook}`,
      ),
    ].join(' && ');

  it.each([
    ['in .git/hooks', plantHooks('/work/repo/.git/hooks')],
    [
      'behind the run’s own core.hooksPath',
      `${plantHooks('/work/hooks')} && printf '[core]\\n\\thooksPath = /work/hooks\\n' >> /work/repo/.git/config`,
    ],
  ])(
    'the export mounts one mirror and fires no hook the run planted %s',
    async (_where, plant) => {
      const { handle } = await startRun();
      try {
        await plantInWorkspace(
          fixture,
          handle.volumeName,
          `${plant} && printf "agent work\\n" > /work/repo/AGENT.md`,
        );
        // The positive (rule 42), first and on a copy: the planted hooks are live.
        await underPlainGit(handle.volumeName, ['git add -A', 'git commit -q -m probe']);
        expect(await markers(handle.volumeName)).toEqual(
          expect.arrayContaining([
            'MARK-hook-pre-commit',
            'MARK-hook-commit-msg',
            'MARK-hook-post-commit',
            'MARK-hook-post-index-change',
          ]),
        );
        await clearControl(handle.volumeName);

        const result = await exportPushing(handle);
        expect(result.pushed).toBe(true);
        expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
        expect(await markers(handle.volumeName)).toEqual([]);
        const asked = cacheMountsOf(fixture.engine.createdBodies.get(`export-${handle.runId}`));
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatchObject(OWN_MIRROR_MOUNT);
      } finally {
        await fixture.provider.destroy(handle);
      }
    },
    240_000,
  );

  it('executes nothing the run wrote into .git/config or .gitattributes, and pushes to the platform’s URL', async () => {
    const { handle } = await startRun();
    try {
      const script = (name: string, body: string): string =>
        `printf '#!/bin/sh\\n${body}\\n' > /work/v/${name} && chmod 755 /work/v/${name}`;
      await plantInWorkspace(
        fixture,
        handle.volumeName,
        [
          'mkdir -p /work/v',
          script('fsmonitor', 'touch /work/MARK-fsmonitor'),
          script('clean', 'touch /work/MARK-filter\\ncat'),
          script('gpg', 'touch /work/MARK-gpg\\nexit 1'),
          script('cred', 'touch /work/MARK-credential\\necho username=x\\necho password=y'),
          `printf '#!/bin/sh\\ntouch /work/MARK-hook-post-index-change\\n' > /work/repo/.git/hooks/post-index-change`,
          'chmod 755 /work/repo/.git/hooks/post-index-change',
          "printf '* filter=evil\\n' > /work/repo/.gitattributes",
          // `printf '%s\n'` with the lines as arguments, because two of them carry `%`.
          "printf '%s\\n' '[core]' 'fsmonitor = /work/v/fsmonitor' '[filter \"evil\"]' 'clean = /work/v/clean' " +
            "'[commit]' 'gpgSign = true' '[gpg]' 'program = /work/v/gpg' " +
            "'[remote \"origin\"]' 'pushurl = ext::sh -c touch% /work/MARK-pushurl' " +
            "'[protocol \"ext\"]' 'allow = always' " +
            "'[url \"ext::sh -c touch% /work/MARK-insteadof% #\"]' 'insteadOf = git://' " +
            "'[credential]' 'helper = /work/v/cred' >> /work/repo/.git/config",
          'printf "agent work\\n" > /work/repo/AGENT.md',
        ].join(' && '),
      );
      // The positive (rule 42): every vector fires under plain git in a copy of this tree.
      await underPlainGit(handle.volumeName, [
        'git status --porcelain',
        'git add -A',
        'git commit -q -m probe',
        'git push origin HEAD:refs/heads/probe',
        `git push ${fixture.repoUrl} HEAD:refs/heads/probe`,
        // Not a command the pre-WP-75 export ran (rule 43): it pushed over `git://`, which asks no
        // credential helper. This line shows the run's helper is **live** in this tree — that the
        // old export would have been handed the password needs an `https` push this fixture has not.
        "printf 'protocol=https\\nhost=example.invalid\\n\\n' | git credential fill",
      ]);
      expect((await markers(handle.volumeName)).sort()).toEqual([
        'MARK-credential',
        'MARK-filter',
        'MARK-fsmonitor',
        'MARK-gpg',
        'MARK-hook-post-index-change',
        'MARK-insteadof',
        'MARK-pushurl',
      ]);
      await clearControl(handle.volumeName);

      const result = await exportPushing(handle);
      expect(result.pushed).toBe(true);
      expect(await markers(handle.volumeName)).toEqual([]);
      // The push went where the platform's mirror says, not where the run's config pointed.
      expect(await remoteHas(`agentic/e2e-${handle.runId}`)).toBe(true);
      // The configuration the export left is the platform's, and a pre-run object still decodes
      // through the alternates — which are a file, not configuration.
      const after = await docker([
        'run',
        '--rm',
        '--network',
        'none',
        '--user',
        '1000:1000',
        '-e',
        'HOME=/tmp',
        '-e',
        'GIT_CONFIG_NOSYSTEM=1',
        '-v',
        `${handle.volumeName}:/work:ro`,
        '--mount',
        `type=volume,src=${fixture.cacheVolume},dst=/cache/acme.git,readonly,volume-subpath=acme.git`,
        '--entrypoint',
        'sh',
        GIT_IMAGE,
        '-c',
        'cat /work/repo/.git/config; echo ---; ' +
          "git -c safe.directory='*' -c core.hooksPath=/dev/null -C /work/repo show HEAD~1:README.md",
      ]);
      const [config = '', decoded = ''] = after.stdout.split('---');
      expect(config).toContain(fixture.repoUrl);
      for (const planted of ['fsmonitor', 'filter', 'gpg', 'pushurl', 'insteadOf', 'credential']) {
        expect(config).not.toContain(planted);
      }
      expect(decoded).toContain('# fixture repository');
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 240_000);

  /** Writes into the run's tree **with git**, as uid 1000 — the agent's own commands, for the plants that need a repository. */
  const plantWithGit = async (volume: string, commands: readonly string[]): Promise<void> => {
    await docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--user',
      '1000:1000',
      '-e',
      'HOME=/tmp',
      '-v',
      `${volume}:/work`,
      '--mount',
      `type=volume,src=${fixture.cacheVolume},dst=/cache/acme.git,readonly,volume-subpath=acme.git`,
      '--entrypoint',
      'sh',
      GIT_IMAGE,
      '-c',
      [
        'set -e',
        "git config --global --add safe.directory '*'",
        'git config --global user.email agent@example.invalid',
        'git config --global user.name agent',
        'mkdir -p /work/v',
        "printf '#!/bin/sh\\ntouch /work/MARK-nested-fsmonitor\\n' > /work/v/nested",
        'chmod 755 /work/v/nested',
        'cd /work/repo',
        ...commands,
      ].join('\n'),
    ]);
  };

  /**
   * **A nested repository's own configuration** (review round 2, measured there): a gitlink whose
   * repository sets `core.fsmonitor` ran it from the export's `git add -A`. The refusal is by name,
   * before the first git command that reads the work tree. Two shapes: the gitlink committed in the checkout (the
   * reviewer's), and a nested repository the run never added — which git 2.49.1 turns into a gitlink
   * on the first `add -A` without running its fsmonitor (measured on a throwaway container), and
   * whose fsmonitor then runs on the **next** tree walk; so its positive control is two `add`s.
   */
  it.each([
    [
      'a committed gitlink',
      [
        'git init -q sub',
        '(cd sub && echo a > x && git add x && git commit -q -m nested)',
        'git add sub',
        'git commit -q -m gitlink',
        'git -C sub config core.fsmonitor /work/v/nested',
        'echo dirty > sub/x',
      ],
      ['git add -A'],
    ],
    [
      'an untracked nested repository',
      [
        'git init -q sub',
        '(cd sub && echo a > x && git add x && git commit -q -m nested)',
        'git -C sub config core.fsmonitor /work/v/nested',
        'echo dirty > sub/x',
      ],
      ['git add -A', 'git add -A'],
    ],
  ])(
    'refuses to export a checkout holding %s, by name, and runs its fsmonitor nowhere',
    async (_shape, plant, control) => {
      const { handle } = await startRun();
      try {
        await plantWithGit(handle.volumeName, plant);
        await underPlainGit(handle.volumeName, control);
        expect(await markers(handle.volumeName)).toEqual(['MARK-nested-fsmonitor']);
        await clearControl(handle.volumeName);
        await expect(exportPushing(handle)).rejects.toMatchObject({
          code: 'workspace_failed',
          message: /refusing to export: the checkout holds a nested repository/,
        });
        expect(await markers(handle.volumeName)).toEqual([]);
        expect(await remoteHas(`agentic/e2e-${handle.runId}`)).toBe(false);
      } finally {
        await fixture.provider.destroy(handle);
      }
    },
    240_000,
  );

  /**
   * **An unreadable directory must not hide a nested repository** (review round 3, measured there on
   * the real script): the export runs as the run's own uid, so a directory the run left at mode
   * 0111 cannot be listed by `find`, while git reaches the nested repository through the index. The
   * positive control is plain `git status` **in place** (a copy of an unreadable tree is not the
   * tree); the export normalises the tree first, so its walk completes and the refusal is the
   * nested repository's, by name.
   */
  it('refuses a nested repository behind a directory the run made unlistable (mode 0111)', async () => {
    const { handle } = await startRun();
    try {
      await plantWithGit(handle.volumeName, [
        'mkdir d',
        'git init -q d/sub',
        '(cd d/sub && echo a > x && git add x && git commit -q -m nested)',
        'git add d/sub',
        'git commit -q -m gitlink',
        'git -C d/sub config core.fsmonitor /work/v/nested',
        'echo dirty > d/sub/x',
        'chmod 0111 d',
      ]);
      await underPlainGit(handle.volumeName, ['git status --porcelain'], { inPlace: true });
      expect(await markers(handle.volumeName)).toEqual(['MARK-nested-fsmonitor']);
      await clearControl(handle.volumeName);
      await expect(exportPushing(handle)).rejects.toMatchObject({
        code: 'workspace_failed',
        message: /refusing to export: the checkout holds a nested repository/,
      });
      expect(await markers(handle.volumeName)).toEqual([]);
      expect(await remoteHas(`agentic/e2e-${handle.runId}`)).toBe(false);
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 240_000);

  /**
   * The other direction of the ruling (rule 42): a committed gitlink with **no** `.git` behind it —
   * the shape a project with submodules has in every checkout, since the clone initialises none —
   * exports and pushes normally. The committed-gitlink case above differs from this one by the
   * nested repository alone, so the refusal is the `.git`, not the gitlink.
   */
  it('exports a committed gitlink with no nested .git behind it, and pushes', async () => {
    const { handle } = await startRun();
    try {
      await plantWithGit(handle.volumeName, [
        'git init -q sub',
        '(cd sub && echo a > x && git add x && git commit -q -m nested)',
        'git add sub',
        'git commit -q -m gitlink',
        // What a clone leaves for an uninitialised submodule: the gitlink, and an empty directory.
        'rm -rf sub && mkdir sub',
        'printf "agent work\\n" > AGENT.md',
      ]);
      const result = await exportPushing(handle);
      expect(result.pushed).toBe(true);
      expect(await remoteHas(`agentic/e2e-${handle.runId}`)).toBe(true);
      expect(await markers(handle.volumeName)).toEqual([]);
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 240_000);

  it.each([
    ['a symlink', 'mv /work/repo/.git /work/real-git && ln -s /work/real-git /work/repo/.git'],
    [
      'a gitfile',
      "mv /work/repo/.git /work/real-git && printf 'gitdir: /work/real-git\\n' > /work/repo/.git",
    ],
    // A linked worktree's `.git` is a directory whose `commondir` names the configuration git reads.
    ['a linked worktree (commondir)', "printf '/work/elsewhere\\n' > /work/repo/.git/commondir"],
  ])(
    'refuses to export a checkout whose .git is %s, by name',
    async (_shape, plant) => {
      const { handle } = await startRun();
      try {
        await plantInWorkspace(fixture, handle.volumeName, plant);
        await expect(exportPushing(handle)).rejects.toMatchObject({
          code: 'workspace_failed',
          message:
            /refusing to export: the checkout’s \.git is not the directory the platform cloned/,
        });
      } finally {
        await fixture.provider.destroy(handle);
      }
    },
    240_000,
  );
});

describe('teardown ends the pid namespace (WP-13 obligation 3)', () => {
  const sizeFromVolume = async (volumeName: string): Promise<number> => {
    const probe = await docker([
      'run',
      '--rm',
      '-v',
      `${volumeName}:/work`,
      'alpine:3.21',
      'sh',
      '-c',
      'wc -c < /work/tick 2>/dev/null || echo 0',
    ]);
    return Number.parseInt(probe.stdout.trim() || '0', 10);
  };

  /**
   * The criterion in the plan row: *a run whose child forked a detached grandchild leaves no
   * process behind, including on the paths where the shim exited first and the launcher is only
   * tidying up.*
   *
   * ## What the first attempt at this test measured instead, and why it is worth recording
   *
   * The container was first given a command that forked the grandchild and **exited 0** — "the
   * shim exited first", literally. The grandchild never wrote a byte: when a container's PID 1
   * exits, the daemon tears the pid namespace down with it, so a detached grandchild cannot
   * outlive its own container's main process. Measured on Docker 29.7.2.
   *
   * That is not a reason to drop the case; it is the shape of the real risk, sharpened. The
   * dangerous state is the one where the container is **still up**: the shim's flush window
   * re-arms on progress (WP-13, standing rule 50), so a grandchild holding the stdout pipe and
   * dribbling keeps the shim alive and the container running for as long as it likes. So PID 1
   * here sleeps — standing in for a shim that is still draining — while a grandchild in its own
   * session writes, and nothing has signalled anything. Then the launcher tidies up.
   */
  it('a detached grandchild does not survive destroy', async () => {
    const { handle } = await startRun();
    const inspect = await fixture.engine.inspectContainer(handle.containerId);
    const name = `agentic-e2e-orphan-${randomUUID().slice(0, 8)}`;
    const orphanId = await fixture.engine.createContainer(name, {
      Image: 'alpine:3.21',
      Entrypoint: ['/bin/sh', '-c'],
      // The grandchild is `setsid`, so it is in a new session and a new process group: a signal to
      // the main pid, or to the main pid's group, cannot reach it. PID 1 then sleeps, which is the
      // shim still holding the run open.
      Cmd: [
        'setsid sh -c "while :; do printf x >> /work/tick; sleep 0.1; done" >/dev/null 2>&1 & ' +
          'sleep 600',
      ],
      User: inspect.Config.User ?? '1000:1000',
      HostConfig: inspect.HostConfig,
    });
    try {
      await fixture.engine.startContainer(orphanId);

      // Positive first: the grandchild is really running, and nothing has signalled anything.
      // Polled to a deadline — a lower bound on progress, never a sleep-then-assert.
      const deadline = Date.now() + 60_000;
      let growing = 0;
      for (;;) {
        growing = await sizeFromVolume(handle.volumeName);
        if (growing > 0) {
          break;
        }
        if (Date.now() > deadline) {
          throw new Error('the detached grandchild never wrote: the premise did not hold');
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      await fixture.provider.destroy({ ...handle, containerId: orphanId });

      const afterDestroy = await sizeFromVolume(handle.volumeName);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const later = await sizeFromVolume(handle.volumeName);
      // It was writing every 100 ms, so two seconds of silence is about twenty missed writes. The
      // assertion is equality of a counter that would otherwise have moved by ~20; a slower
      // machine only makes it safer.
      expect(later).toBe(afterDestroy);
      expect(afterDestroy).toBeGreaterThan(0);

      const gone = await docker(['inspect', orphanId], { allowFailure: true });
      expect(gone.ok).toBe(false);
    } finally {
      await docker(['rm', '-f', '-v', orphanId], { allowFailure: true });
      await fixture.provider.destroy(handle);
    }
  }, 300_000);
});

describe('retention', () => {
  it('keeps a volume inside its window and removes one past it', async () => {
    const { handle } = await startRun();
    await fixture.provider.destroy(handle);

    const kept = await fixture.provider.purgeExpired(new Date('2020-01-01T00:00:00.000Z'));
    expect(kept.volumes).toContainEqual(
      expect.objectContaining({ volumeName: handle.volumeName, keptReason: 'not_expired' }),
    );
    const stillThere = await docker(['volume', 'inspect', handle.volumeName], {
      allowFailure: true,
    });
    expect(stillThere.ok).toBe(true);

    const purged = await fixture.provider.purgeExpired(new Date('2099-01-01T00:00:00.000Z'));
    expect(purged.volumes).toContainEqual(
      expect.objectContaining({ volumeName: handle.volumeName, removed: true }),
    );
    // The data is really gone, not merely reported gone.
    const afterwards = await docker(['volume', 'inspect', handle.volumeName], {
      allowFailure: true,
    });
    expect(afterwards.ok).toBe(false);
  }, 240_000);

  it('keeps a volume whose run still has a container', async () => {
    const { handle } = await startRun();
    try {
      const report = await fixture.provider.purgeExpired(new Date('2099-01-01T00:00:00.000Z'));
      expect(report.volumes).toContainEqual(
        expect.objectContaining({ volumeName: handle.volumeName, keptReason: 'in_use' }),
      );
      expect(
        (await docker(['volume', 'inspect', handle.volumeName], { allowFailure: true })).ok,
      ).toBe(true);
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 180_000);
});

/**
 * The readiness handshake, against the real provider and the real image (WP-22, PROGRESS backlog 27).
 *
 * **What was unguarded.** `attach` waits for the shim's control socket (`#waitForControlSocket`,
 * `provider.ts`), and without that wait the first run of every task failed: `create` returns when the
 * container has *started*, the shim then has to boot and `listen()`, and a runner that connects
 * immediately gets `connect ENOENT` on a healthy workspace — measured at WP-15g, 8 ms in, reported as
 * "Failed to spawn Claude Code process". The unit half is calibrated with a fake engine. The e2e half
 * was not, and the honest measurement (taken at WP-22, before this case existed) is that it could not
 * be: with `create` then `relaxControlDirectoryForHost` then `attach`, that middle step is a whole
 * `docker run`, so the socket is always already there and shortening the wait to a single look left
 * the file **green**.
 *
 * **Why the real image makes it sharper rather than softer.** The stand-in booted the shim with
 * `node --import ts-source-resolver /repo/apps/runlet/src/index.ts`, which loads the whole
 * `@platform/infrastructure` barrel; `platform-runtime` runs a 349 kB bundle. The gap between
 * "container started" and "socket listening" is a different quantity, and it is smaller — so a test
 * that waited for the race to happen would be flakier here, not less.
 *
 * **So the ordering is forced rather than waited for** (standing rule 76). The socket is removed while
 * the container keeps running, which nothing can undo — the only thing that creates it is a shim
 * starting, and this one has already started — then `attach` is called, then the absence is
 * *observed*, and only then is the container restarted so a second shim listens. Every look `attach`
 * takes before that restart sees nothing, which is what makes the one-look mutant fail by name while
 * the unmutated wait passes.
 */
describe('attach waits for a shim that starts listening after it was called', () => {
  it('attaches to a workspace whose socket appears only after attach', async () => {
    const { handle } = await startRun();
    try {
      await relaxControlDirectoryForHost(fixture, handle.runId);
      // The shim has listened at least once by now, and this is the state no shim can leave behind:
      // socket gone, container up.
      await removeControlSocket(fixture, handle.runId);
      expect(await controlSocketExists(fixture, handle.runId)).toBe(false);

      const attaching = fixture.provider.attach(handle);
      // Sampled *after* `attach` was called: every look it has taken so far saw nothing. Without
      // this line the case would be asserting a race; with it, the ordering is a recorded fact.
      expect(await controlSocketExists(fixture, handle.runId)).toBe(false);

      await docker(['restart', `ws-${handle.runId}`]);
      const attachment = await attaching;
      expect(attachment.socketPath.endsWith(`${handle.runId}/ctl.sock`)).toBe(true);
      expect(attachment.workdir).toBe('/work/repo');
      expect(await controlSocketExists(fixture, handle.runId)).toBe(true);
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 240_000);
});

/**
 * The egress policy, through the real sidecar (WP-22's criterion).
 *
 * Every earlier statement about egress in this file is about *topology*: the run network is
 * `internal: true`, the sidecar is the only container on two networks, the workspace has no default
 * route. None of it showed a request being filtered, because the sidecar was `alpine` running
 * `sleep`. This is the other half — `platform-egress` running tinyproxy under exactly the flags
 * `sidecarCreateBody` sets (uid 1000, `CapDrop: ['ALL']`, read-only rootfs) with the allow-list
 * `renderEgressConfig` wrote.
 *
 * The discriminating part is that both names are **the same container on the same address**
 * (`startEgressTarget`), so a 403 for one of them cannot be "the host was unreachable": it is the
 * filter, and nothing else (standing rule 43). The positive is what makes the negative mean something
 * (rule 42) — a proxy that refused everything would pass the refusal assertion on its own.
 */
describe('egress policy', () => {
  it('proxies the allowed host and refuses the one beside it', async () => {
    const allowed = `allowed-${Math.random().toString(36).slice(2, 8)}`;
    const denied = `denied-${Math.random().toString(36).slice(2, 8)}`;
    const target = await startEgressTarget(fixture, allowed, denied);
    const { handle } = await startRun({ egress: { hosts: [allowed], connectPorts: [443] } });
    try {
      const proxy = `http://egress-${handle.runId}:8888`;
      const probe = await probeUnderRunContainerConfig(
        fixture.engine,
        handle.containerId,
        // Two requests that differ only in the host, through the proxy the run container's own
        // HTTPS_PROXY names, then the body of the allowed one.
        `curl -s -o /dev/null -w "allowed=%{http_code}\\n" --max-time 20 -x ${proxy} http://${allowed}:${target.port}/; ` +
          `curl -s -o /dev/null -w "denied=%{http_code}\\n" --max-time 20 -x ${proxy} http://${denied}:${target.port}/; ` +
          `curl -s --max-time 20 -x ${proxy} http://${allowed}:${target.port}/`,
        { image: RUNTIME_IMAGE },
      );
      expect(probe.output).toContain('allowed=200');
      expect(probe.output).toContain('denied=403');
      // And the body came from the server behind the proxy, not from tinyproxy's own error page.
      expect(probe.output).toContain('EGRESS-TARGET-OK');
    } finally {
      await fixture.provider.destroy(handle);
      await target.stop();
    }
  }, 240_000);
});

describe('create is atomic', () => {
  it('leaves no container, network or sidecar behind when a step fails', async () => {
    const before = await docker(['ps', '-aq', '--filter', 'label=com.agentic.run']);
    const spec = specFor({ repo: { cacheKey: 'no-such-mirror' } });
    await expect(fixture.provider.create(spec)).rejects.toMatchObject({
      code: 'workspace_failed',
    });
    const after = await docker(['ps', '-aq', '--filter', 'label=com.agentic.run']);
    expect(after.stdout.split('\n').filter(Boolean)).toEqual(
      before.stdout.split('\n').filter(Boolean),
    );
    const network = await docker(['network', 'inspect', `run-${spec.runId}`], {
      allowFailure: true,
    });
    expect(network.ok).toBe(false);
  }, 180_000);
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
        create: async (input) => {
          const handle = await fixture.provider.create(input);
          created = handle.runId;
          // Q51, admitted: this process is not uid 1000, and `attach` reads a 0600 file owned by
          // it. The real mode is measured in its own case above, before anything relaxes it.
          await relaxControlDirectoryForHost(fixture, handle.runId);
          return handle;
        },
        attach: (handle) => fixture.provider.attach(handle),
        kill: (handle) => fixture.provider.kill(handle),
        destroy: (handle) => fixture.provider.destroy(handle),
        export: (handle, request, credential) =>
          fixture.provider.export(handle, request, credential),
        extendRetention: (handle, keepUntil) => fixture.provider.extendRetention(handle, keepUntil),
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

/**
 * The locked-directory case on **production's** control-volume shape — PROGRESS backlog 147.
 *
 * `compose.yml`'s `APP_WORKSPACE_CONTROL_VOLUME` is a plain named volume inside the daemon's own
 * storage, not a bind onto a host directory, so the macOS file-share behaviour measured in the
 * bind-backed case above — socket entries the guest can list and cannot `lstat` or unlink — does
 * not arise on it. This fixture is that shape (`controlVolumeBind: false`); it cannot read the
 * control root from this process, which none of these cases needs.
 *
 * **Last in the file on purpose**: a fixture's `cleanup` sweeps every container, network and volume
 * labelled `com.agentic.run` on the daemon, so this one's `afterAll` must not run while the file's
 * own fixture still has cases to serve.
 */
describe('on production’s control-volume shape, a plain named volume', () => {
  let named: DockerFixture;

  beforeAll(async () => {
    named = await startDockerFixture({ controlVolumeBind: false });
  }, 300_000);

  afterAll(async () => {
    await named?.cleanup();
  }, 120_000);

  it('destroy reclaims the control directory even after the agent locks it', async () => {
    const spec = workspace.workspaceSpecFixture({
      runId: randomUUID(),
      repo: { url: named.repoUrl, cacheKey: 'acme' },
    });
    await named.provider.updateMirror({
      projectId: spec.projectId,
      repo: spec.repo,
      credential: null,
    });
    const handle = await named.provider.create(spec);
    const hostile = await probeUnderRunContainerConfig(
      named.engine,
      handle.containerId,
      'chmod 000 /ctl; stat -c "MODE=%a OWNER=%u" /ctl',
      { user: '1000:1000' },
    );
    expect(hostile.output).toContain('MODE=0 ');
    const before = named.warnings.length;
    await named.provider.destroy(handle);
    const listing = await docker([
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${named.controlVolume}:/ctl`,
      ALPINE_IMAGE,
      'ls',
      '-A',
      '/ctl',
    ]);
    expect(listing.stdout.split('\n')).not.toContain(handle.runId);
    // And not merely apparently: `#teardown` logs a failed step and carries on.
    const failed = named.warnings
      .slice(before)
      .filter((entry) => entry.message === 'workspace teardown step failed')
      .map((entry) => entry.fields['step']);
    expect(failed).not.toContain('control-dir');
  }, 180_000);
});
