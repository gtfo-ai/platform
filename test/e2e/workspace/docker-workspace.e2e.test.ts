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
 *
 * ## One of three files (BACKLOG 1654)
 *
 * The cases were all here until this file's 239–330 s set the floor of its `e2e-fake-claude` part.
 * Mount escapes, the export and the two git-server blocks (WP-75, WP-76) are now
 * `docker-workspace-git.e2e.test.ts`, and the shared contract suite is
 * `docker-workspace-contract.e2e.test.ts`; the fixture preamble the three share is
 * `test/e2e/support/docker-workspace-suite.ts`, whose docblock says why they may run at once.
 */
import { createHash, randomUUID } from 'node:crypto';
import { commandBaselineFor, runOrphanWorkspaceReap, TOOLS_BY_ROLE } from '@platform/application';
import { runner, workspace } from '@platform/infrastructure';
import { PLATFORM_SKILL_NAMES, PLATFORM_SKILLS } from '@platform/prompts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALPINE_IMAGE,
  controlSocketExists,
  type DockerFixture,
  docker,
  EGRESS_IMAGE,
  FIXTURE_TASK_BRANCH,
  FIXTURE_TASK_BRANCH_FILE,
  FIXTURE_TASK_BRANCH_MARKER,
  GIT_IMAGE,
  PROJECT_SKILL_FILE,
  probeUnderRunContainerConfig,
  RUNTIME_IMAGE,
  relaxControlDirectoryForHost,
  removeControlSocket,
  startDockerFixture,
  startEgressTarget,
} from '../support/docker-workspace.js';
import { shipped, useDockerFixture } from '../support/docker-workspace-suite.js';
import {
  harnessLabelMap,
  harnessLabels,
  harnessProbe,
  harnessProbeName,
} from '../support/harness-volumes.js';

let fixture: DockerFixture;
const { specFor, startRun } = useDockerFixture((started) => {
  fixture = started;
});

describe('the workspace lifecycle against a real daemon', () => {
  it('mirrors from the fixture repository container and clones with the mirror as its source', async () => {
    const spec = specFor();
    const mirror = await fixture.provider.updateMirror({
      projectId: spec.projectId,
      repo: spec.repo,
      credential: null,
    });
    expect(mirror.cachePath).toBe('/cache/acme.git');
    const handle = await fixture.provider.create(...shipped(spec));
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
    const handle = await fixture.provider.create(...shipped(spec));
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

  /**
   * WP-99 review round 1, against the real helper: a **re-entry** checks out the task branch, which
   * carries a file `main` does not ({@link FIXTURE_TASK_BRANCH_FILE}). "Existing" is the tree at the
   * merge base with the default branch — what the merge request's diff is computed against — so the
   * file the task added is **not** listed, while `README.md`, on `main`, is. With the checkout's own
   * index both would be listed and the rule would differ from the CI gate's.
   */
  it('lists what exists at the merge base, so a file the task branch added reads as new (WP-99)', async () => {
    const spec = specFor({ repo: { checkoutBranch: FIXTURE_TASK_BRANCH } });
    await fixture.provider.updateMirror({
      projectId: spec.projectId,
      repo: spec.repo,
      credential: null,
    });
    const handle = await fixture.provider.create(...shipped(spec));
    try {
      const listing = await fixture.provider.listExistingProtectedPaths(handle, {
        patterns: [FIXTURE_TASK_BRANCH_FILE, 'README.md'],
        defaultBranch: 'main',
      });
      expect(listing).toEqual({ state: 'listed', paths: ['README.md'], opaque: [] });
      // A default branch the clone has no ref for: no merge base, so the answer fails closed.
      expect(
        await fixture.provider.listExistingProtectedPaths(handle, {
          patterns: ['README.md'],
          defaultBranch: 'no-such-branch',
        }),
      ).toMatchObject({ state: 'unlisted', reason: /merge base/ });
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 180_000);

  /**
   * **WP-105 (WP-98's discovered work, Q82 (a))** — a shadow task's base is a commit, and the real
   * git answers both halves: a commit the mirror holds is checked out **detached**, at that commit,
   * with no branch named after it; a commit it does not hold is refused by name before any run
   * container exists — never the default branch's tree under a branch named after the sha, which is
   * what `checkout "$B" || checkout -b "$B"` made of it before.
   */
  it('refuses a shadow base the mirror does not hold, and checks out one it does, detached', async () => {
    const lost = 'f'.repeat(40);
    const refused = specFor({ repo: { checkoutCommit: lost } });
    await fixture.provider.updateMirror({
      projectId: refused.projectId,
      repo: refused.repo,
      credential: null,
    });
    await expect(fixture.provider.create(...shipped(refused))).rejects.toMatchObject({
      code: 'invalid_spec',
      message: expect.stringContaining(`the commit ${lost} this run must start from`),
    });

    // The canary: the same sha sent the way it travelled before WP-105 — as a **branch** — still
    // takes the branch path, which creates a branch named after it at `main`'s head. That is the
    // substitution the commit field exists to refuse.
    const asBranch = await startRun({ repo: { checkoutBranch: lost } });
    try {
      const probe = await probeUnderRunContainerConfig(
        fixture.engine,
        asBranch.handle.containerId,
        'git -C /work/repo rev-parse --abbrev-ref HEAD; git -C /work/repo rev-parse HEAD; git -C /work/repo rev-parse main',
        { image: RUNTIME_IMAGE },
      );
      expect(probe.exitCode).toBe(0);
      const [branch = '', head = '', main = ''] = probe.output.trim().split('\n');
      expect(branch).toBe(lost);
      expect(head).toBe(main);
    } finally {
      await fixture.provider.destroy(asBranch.handle);
    }

    // The task branch's head is a commit the mirror holds and `main` is not.
    const branchRun = await startRun({ repo: { checkoutBranch: FIXTURE_TASK_BRANCH } });
    let base = '';
    try {
      const probe = await probeUnderRunContainerConfig(
        fixture.engine,
        branchRun.handle.containerId,
        'git -C /work/repo rev-parse HEAD',
        { image: RUNTIME_IMAGE },
      );
      expect(probe.exitCode).toBe(0);
      base = probe.output.trim();
    } finally {
      await fixture.provider.destroy(branchRun.handle);
    }
    expect(base).toMatch(/^[0-9a-f]{40}$/);

    const { handle } = await startRun({ repo: { checkoutCommit: base } });
    try {
      const probe = await probeUnderRunContainerConfig(
        fixture.engine,
        handle.containerId,
        'git -C /work/repo rev-parse --abbrev-ref HEAD; git -C /work/repo rev-parse HEAD; ' +
          // `for-each-ref`, not `branch --list`: the latter also prints `(HEAD detached at …)`.
          "git -C /work/repo for-each-ref --format='%(refname:short)' refs/heads; " +
          `test -e /work/repo/${FIXTURE_TASK_BRANCH_FILE} && echo PRESENT || echo ABSENT`,
        { image: RUNTIME_IMAGE },
      );
      expect(probe.exitCode).toBe(0);
      const lines = probe.output.trim().split('\n');
      // Detached, at the base, with the base's tree — and the only local branch is the clone's own.
      expect(lines[0]).toBe('HEAD');
      expect(lines[1]).toBe(base);
      expect(lines.at(-1)).toBe('PRESENT');
      expect(lines.slice(2, -1)).toEqual(['main']);
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 240_000);

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
    const handle = await fixture.provider.create(...shipped(spec));
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
        ...harnessProbe(),
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
          ...harnessProbe(),
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
        ...harnessProbe(),
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
      ...harnessProbe(),
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
          ...harnessProbe(),
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
        ...harnessProbe(),
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
    const handle = await fixture.provider.create(...shipped(spec));
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
      expect(fixture.engine.createdNames.slice(again)).toContain(
        `mirror-${fixture.controlVolume}-acme`,
      );
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
    const handle = await fixture.provider.create(...shipped(spec));
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
    const handle = await fixture.provider.create(...shipped(spec));
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
    // The fixture repository is on the bridge network; the workspace is on `run-<id>`, which is
    // `internal: true`. The probe dials the repository's **address**, never its name: the name does
    // not resolve on the run network, so `nc` exited 1 on *bad address* before any packet left and
    // the old assertion held whether or not the network was isolated (PROGRESS backlog 571).
    const repoNetworks = JSON.parse(
      (
        await docker([
          'inspect',
          '--format',
          '{{json .NetworkSettings.Networks}}',
          fixture.repoContainer,
        ])
      ).stdout,
    ) as Record<string, { IPAddress?: string }>;
    const repoAddress = repoNetworks[fixture.network]?.IPAddress ?? '';
    expect(repoAddress, JSON.stringify(repoNetworks)).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    // busybox `nc -z -v` (the probe image's) names the outcome on one line — measured: `<ip>
    // (<ip>:<port>) open`, `nc: … Network unreachable` with no route, `nc: … Operation timed out`
    // after `-w`, `nc: bad address '<name>'` — and prints nothing for a refused connect, which
    // would mean a packet reached the host anyway. Bounded so a dropped SYN costs 3 s, not a hang.
    const dial = `out=$(nc -z -v -w 3 ${repoAddress} 9418 2>&1); rc=$?; echo "nc_said=$out"; echo "rc=$rc"`;
    const reachable = await probeUnderRunContainerConfig(
      fixture.engine,
      handle.containerId,
      `${dial}; echo "default_routes=$(ip route | grep -c "^default")"`,
    );
    // Read per line and each line asserted on its own, with the whole output (quoted, so a stray
    // `\r` or trailing text shows) in the failure: this once failed reading the output's last
    // character, and nobody could say which half was wrong (PROGRESS backlog 411, WP-169).
    const valuesIn = (output: string, key: string): string[] =>
      output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith(`${key}=`))
        .map((line) => line.slice(key.length + 1));
    const whole = `the whole probe output: ${JSON.stringify(reachable.output)}`;
    const lineValues = (key: string): string[] => valuesIn(reachable.output, key);
    expect(lineValues('rc'), `the nc line (rc=) — ${whole}`).toEqual(['1']);
    // The failure's kind, not only its status: no route or no answer, never a name lookup.
    const unreachable = `nc: ${repoAddress} (${repoAddress}:9418): `;
    expect(lineValues('nc_said'), `the nc reason (nc_said=) — ${whole}`).toSatisfy(
      (said: string[]) =>
        said.length === 1 &&
        [`${unreachable}Network unreachable`, `${unreachable}Operation timed out`].includes(
          said[0] ?? '',
        ),
    );
    // The control: the same dial from the bridge network reaches the same address and port, so
    // the probe is one that can succeed and its failure above is the network's.
    const control = await docker([
      'run',
      '--rm',
      ...harnessProbe(),
      '--network',
      fixture.network,
      ALPINE_IMAGE,
      'sh',
      '-c',
      dial,
    ]);
    const controlWhole = `the whole control output: ${JSON.stringify(control.stdout)}`;
    expect(valuesIn(control.stdout, 'rc'), controlWhole).toEqual(['0']);
    expect(valuesIn(control.stdout, 'nc_said'), controlWhole).toEqual([
      `${repoAddress} (${repoAddress}:9418) open`,
    ]);
    // No default route at all — the same thing WP-13 measured, now for a network this provider
    // created. (busybox `ip route show default` ignores its own selector; the line is matched.)
    expect(lineValues('default_routes'), `the default-route count line — ${whole}`).toEqual(['0']);

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

describe('teardown ends the pid namespace (WP-13 obligation 3)', () => {
  const sizeFromVolume = async (volumeName: string): Promise<number> => {
    const probe = await docker([
      'run',
      '--rm',
      ...harnessProbe(),
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
    const name = harnessProbeName('orphan');
    const orphanId = await fixture.engine.createContainer(name, {
      // Marked (WP-132, backlog 427): it sleeps ten minutes, so a killed file leaves it running.
      Labels: harnessLabelMap(),
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

/**
 * WP-82 criterion (1), through the real sidecar: the **production derivation** of the egress list
 * (`buildWorkspaceSpec`, with `APP_RUN_REGISTRY_HOSTS` naming one registry) is what tinyproxy
 * enforces. A reviewer run — the `verification` baseline, which carries `LOCKFILE_INSTALL_ALLOW` —
 * reaches the registry; an architect run — `read_only` — is refused the **same host on the same
 * address**, with the same operator list. The positive is what makes the refusal mean something
 * (rule 42), and the two aliases of one container make the refusal the filter's (rule 43).
 *
 * The fixture spec supplies everything but the egress list (its repository and cache key are the
 * fixture's mirror); the list is taken whole from the builder, so the assertion is about the
 * derivation and not about a list this file wrote.
 */
describe('registry egress follows the command baseline (WP-82)', () => {
  it('lets a verification run reach a declared registry, and refuses it to a read-only run', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const registry = `registry-${suffix}.test`;
    const unlisted = `unlisted-${suffix}.test`;
    const target = await startEgressTarget(fixture, registry, unlisted);
    const egressOf = (role: 'reviewer' | 'architect', stage: string) =>
      workspace.buildWorkspaceSpec({
        spec: runner.runSpecFixture({
          role,
          tools: [...TOOLS_BY_ROLE[role]],
          commandPolicy: (({ allow, ask, block }) => ({
            allow: [...allow],
            ask: [...ask],
            block: [...block],
            unattended: 'auto' as const,
          }))(commandBaselineFor(role, stage, [])),
        }),
        repoUrl: fixture.repoUrl,
        defaultBranch: 'main',
        platformEgressHosts: [],
        runRegistryHosts: [registry],
        now: new Date(),
      }).egress;
    const verification = egressOf('reviewer', 'code_review');
    const readOnly = egressOf('architect', 'architecture');
    expect(verification.hosts).toContain(registry);
    expect(readOnly.hosts).not.toContain(registry);

    const probe = async (egress: typeof verification) => {
      const { handle } = await startRun({ egress });
      try {
        const proxy = `http://egress-${handle.runId}:8888`;
        return (
          await probeUnderRunContainerConfig(
            fixture.engine,
            handle.containerId,
            `curl -s -o /dev/null -w "registry=%{http_code}\\n" --max-time 20 -x ${proxy} http://${registry}:${target.port}/; ` +
              `curl -s -o /dev/null -w "unlisted=%{http_code}\\n" --max-time 20 -x ${proxy} http://${unlisted}:${target.port}/`,
            { image: RUNTIME_IMAGE },
          )
        ).output;
      } finally {
        await fixture.provider.destroy(handle);
      }
    };
    try {
      const allowed = await probe(verification);
      expect(allowed).toContain('registry=200');
      expect(allowed).toContain('unlisted=403');
      const refused = await probe(readOnly);
      expect(refused).toContain('registry=403');
      expect(refused).toContain('unlisted=403');
    } finally {
      await target.stop();
    }
  }, 300_000);
});

describe('create is atomic', () => {
  it('leaves no container, network or sidecar behind when a step fails', async () => {
    // This fixture's runs only (WP-128): another instance on the daemon may start one meanwhile.
    const ours = [
      '--filter',
      'label=com.agentic.run',
      '--filter',
      `label=com.agentic.instance=${fixture.controlVolume}`,
    ];
    const before = await docker(['ps', '-aq', ...ours]);
    const spec = specFor({ repo: { cacheKey: 'no-such-mirror' } });
    await expect(fixture.provider.create(...shipped(spec))).rejects.toMatchObject({
      code: 'workspace_failed',
    });
    const after = await docker(['ps', '-aq', ...ours]);
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
 * **A helper whose launcher stopped attending to it is found and removed by the orphan pass** —
 * WP-132, PROGRESS backlog 426.
 *
 * The launcher "dies" during an export: a second provider, configured exactly as the fixture's, runs
 * the export over an engine whose wait on the `export-<run-id>` helper never answers, so the
 * provider's own removal of the helper never runs — which is what a SIGKILL between the helper's
 * start and its removal leaves (WP-128 measured one on this daemon). Then the **production** pass,
 * `runOrphanWorkspaceReap`, runs over the fixture provider's real read verb and destroy, with the run
 * row given as failed an hour ago. Before WP-132 the helper carried the run label and no instance
 * label, so `destroyRun` (which finds a run's containers by both) never named it and it survived the
 * pass; the run itself was still listed through its run container, which is why the assertion is on
 * the helper and not on the listing.
 */
describe('a helper left mid-flight by its launcher (WP-132)', () => {
  it('is listed under its run and removed by the orphan pass', async () => {
    const { spec, handle } = await startRun();
    const helperName = `export-${spec.runId}`;
    let helperId: string | null = null;
    let release: () => void = () => {};
    const abandoned = new Promise<number>((resolve) => {
      release = () => resolve(0);
    });
    const engine = new Proxy(fixture.engine, {
      get(target, property) {
        if (property === 'createContainer') {
          return async (name: string, body: unknown) => {
            const id = await target.createContainer(name, body);
            if (name === helperName) helperId = id;
            return id;
          };
        }
        if (property === 'waitContainer') {
          return async (id: string) => (id === helperId ? abandoned : target.waitContainer(id));
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    const dying = new workspace.DockerWorkspaceProvider({
      engine,
      images: {
        runtime: RUNTIME_IMAGE,
        egress: EGRESS_IMAGE,
        git: GIT_IMAGE,
        runtimeSourceDir: null,
      },
      controlVolume: fixture.controlVolume,
      controlRoot: fixture.controlRoot,
      cacheVolume: fixture.cacheVolume,
      helperNetwork: fixture.network,
      egressNetwork: fixture.network,
      runnerUid: 1000,
    });
    const exporting = dying
      .export(handle, { branch: 'agentic/wp132', tarballPath: null, commitMessage: 'wip:' }, null)
      .catch(() => undefined);
    const deadline = Date.now() + 60_000;
    while (helperId === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(helperId, 'the export never created its helper').not.toBeNull();
    const labels = await docker([
      'container',
      'inspect',
      '--format',
      '{{json .Config.Labels}}',
      helperName,
    ]);
    expect(JSON.parse(labels.stdout)).toMatchObject({
      'com.agentic.run': spec.runId,
      'com.agentic.instance': fixture.controlVolume,
    });

    const now = Date.now();
    const report = await runOrphanWorkspaceReap({
      inventory: {
        list: () => fixture.provider.listLabelledRuns(),
        destroy: (runId) => fixture.provider.destroyRun(runId),
      },
      store: {
        runStates: async (_tx, runIds) =>
          runIds
            .filter((runId) => runId === spec.runId)
            .map((runId) => ({
              runId,
              status: 'failed' as const,
              endedAt: new Date(now - 3_600_000).toISOString() as never,
            })),
      },
      unitOfWork: {
        transaction: async (work: (scope: never) => Promise<unknown>) =>
          work({ tx: null } as never),
      } as never,
      clock: { now: () => now },
      graceMs: 60_000,
    });
    expect(report.reaped.terminal).toBeGreaterThanOrEqual(1);
    const helper = await docker(['container', 'inspect', helperName], { allowFailure: true });
    expect(helper.ok, `${helperName} survived the orphan pass`).toBe(false);
    const listed = await fixture.provider.listLabelledRuns();
    expect(listed.map((run) => run.runId)).not.toContain(spec.runId);
    // The abandoned export is released only now, so nothing of it races the pass.
    release();
    await exporting;
  }, 240_000);
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
 * **Last in the file**, which was once required: a fixture's `cleanup` swept every container,
 * network and volume labelled `com.agentic.run` on the daemon, so this one's `afterAll` could not
 * run while the file's own fixture still had cases to serve. Since WP-128 a cleanup removes only its
 * own instance's run objects (PROGRESS backlog 398), so the order no longer matters.
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
    const handle = await named.provider.create(...shipped(spec));
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
      ...harnessProbe(),
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

/**
 * WP-157 (c) and (d), PROGRESS backlogs 431 and 430, on a real daemon.
 *
 * **Safe on a shared daemon by construction**: every object here is created by this case, carries
 * the harness labels, and is named by it; "the other instance" is a unique, test-only
 * `com.agentic.instance` value, never a product instance's. The sweep is this fixture's provider,
 * whose instance is the fixture's own control volume, so nothing another stack labelled is listed.
 * `now` is two hours ahead so a helper created a second ago is past the hour bound without
 * waiting; this fixture's own workspace volumes keep three days and are untouched by it.
 */
describe('retention lists this instance only, and reaps its run-less helpers (WP-157)', () => {
  it('removes this instance’s expired volume and stale helper, and keeps another instance’s', async () => {
    const otherInstance = `agentic-e2e-other-${randomUUID().slice(0, 8)}`;
    const mine = `ws-${randomUUID()}`;
    const theirs = `ws-${randomUUID()}`;
    const myHelper = harnessProbeName('plant');
    const theirHelper = harnessProbeName('plant');
    const volume = (name: string, instance: string) => [
      'volume',
      'create',
      ...harnessLabels(),
      '--label',
      `com.agentic.run=${name.slice(3)}`,
      '--label',
      'com.agentic.role=workspace',
      '--label',
      'com.agentic.keep_until=2000-01-01T00:00:00.000Z',
      '--label',
      `com.agentic.instance=${instance}`,
      name,
    ];
    const helper = (name: string, instance: string) => [
      'create',
      '--name',
      name,
      ...harnessLabels(),
      '--label',
      'com.agentic.role=cli-check',
      '--label',
      `com.agentic.instance=${instance}`,
      ALPINE_IMAGE,
      'true',
    ];
    try {
      await docker(volume(mine, fixture.controlVolume));
      await docker(volume(theirs, otherInstance));
      await docker(helper(myHelper, fixture.controlVolume));
      await docker(helper(theirHelper, otherInstance));
      const report = await fixture.provider.purgeExpired(new Date(Date.now() + 2 * 3_600_000));
      expect(report.volumes.map((entry) => entry.volumeName)).not.toContain(theirs);
      expect(report.volumes).toContainEqual(
        expect.objectContaining({ volumeName: mine, removed: true }),
      );
      const exists = async (kind: 'volume' | 'container', name: string) =>
        (await docker([kind, 'inspect', name], { allowFailure: true })).ok;
      expect(await exists('volume', mine)).toBe(false);
      expect(await exists('volume', theirs)).toBe(true);
      expect(await exists('container', myHelper)).toBe(false);
      expect(await exists('container', theirHelper)).toBe(true);
    } finally {
      await docker(['rm', '-f', myHelper, theirHelper], { allowFailure: true });
      await docker(['volume', 'rm', '-f', mine, theirs], { allowFailure: true });
    }
  }, 120_000);
});
