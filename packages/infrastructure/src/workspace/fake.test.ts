/**
 * The fake's own tests: the two things the shared contract suite cannot say.
 *
 * Everything a *caller* may rely on is in `test/contract/support/workspace/provider-suite.ts`,
 * which both implementations run. What is left here is the **divergence register**: each entry
 * that admits the fake is kinder than Docker carries a positive assertion, because documenting a
 * divergence is necessary and not sufficient (standing rule 12).
 */
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeWorkspaceProvider } from './fake.js';
import { FIXTURE_RUN_ID, shortTempDir, workspaceSpecFixture } from './fixtures.js';
import { parseTar } from './tar.js';

let dir: string;
let provider: FakeWorkspaceProvider;

const created = async () => {
  const spec = workspaceSpecFixture();
  await provider.updateMirror({ projectId: spec.projectId, repo: spec.repo, credential: null });
  return { spec, handle: await provider.create(spec) };
};

beforeEach(async () => {
  dir = await shortTempDir('agentic-fake-ws-');
  provider = new FakeWorkspaceProvider({ controlRoot: path.join(dir, 'ctl') });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('divergence 1 — the flags are recorded, not enforced', () => {
  it('records the same create body the Docker provider would send', async () => {
    const { handle } = await created();
    const body = provider.hardening(handle.runId);
    expect(body.User).toBe('1000:1000');
    expect(body.HostConfig.CapDrop).toEqual(['ALL']);
    expect(body.HostConfig.ReadonlyRootfs).toBe(true);
    expect(body.HostConfig.Init).toBe(true);
    expect(body.HostConfig.NetworkMode).toBe(`run-${FIXTURE_RUN_ID}`);
    // What none of this shows is that any of it *works*. A write outside the workspace, a
    // capability-requiring syscall and a route off the run network are attempted only in
    // `test/e2e/workspace/docker-workspace.e2e.test.ts`.
  });
});

describe('divergence 2 — the control socket is not live', () => {
  it('attach returns a path that no server is listening on', async () => {
    const { handle } = await created();
    const attachment = await provider.attach(handle);
    const error = await FakeWorkspaceProvider.controlSocketIsDead(attachment.socketPath);
    // The positive assertion. WP-15 must compose this provider with `runner/fake-spawn.ts`; a test
    // that reached for `createRunletSpawn` would hang on a socket that will never exist, and this
    // is the line that says so out loud rather than in a comment.
    expect(error.code).toBe('ENOENT');
  });
});

describe('divergence 3 — no process, so only the ordering is checkable', () => {
  it('records a stop before the removal on every path that ends a run', async () => {
    const { handle } = await created();
    await provider.destroy(handle);
    const kinds = provider.events.map((event) => event.kind);
    expect(kinds.indexOf('stop')).toBeLessThan(kinds.indexOf('remove'));
    expect(provider.isRunning(handle.runId)).toBe(false);
  });

  it('stops the container even when the run had already finished', async () => {
    const { handle } = await created();
    await provider.kill(handle);
    const before = provider.events.filter((event) => event.kind === 'stop').length;
    await provider.destroy(handle);
    // "The shim exited" is not "the workspace's processes are gone" (research/12): the launcher
    // stops the container on the tidy-up path too.
    expect(provider.events.filter((event) => event.kind === 'stop').length).toBe(before + 1);
  });
});

describe('divergence 4 — the tarball comes from an in-memory tree', () => {
  it('drops a symlink that escapes the workspace, through the same filter', async () => {
    const { handle } = await created();
    provider.plant(handle.runId, {
      name: 'repo/escape',
      type: 'symlink',
      linkname: '../../etc/passwd',
    });
    const target = path.join(dir, 'export.tar');
    const result = await provider.export(
      handle,
      { branch: 'agentic/x', tarballPath: target, commitMessage: 'wip:' },
      null,
    );
    expect(result.droppedLinks).toBe(1);
    expect(parseTar(await readFile(target)).map((entry) => entry.name)).toEqual([
      'repo/',
      'repo/README.md',
    ]);
  });
});

describe('divergence 5 — the mirror is not fetched', () => {
  it('still refuses a url that is not a git remote', async () => {
    const spec = workspaceSpecFixture();
    await expect(
      provider.updateMirror({
        projectId: spec.projectId,
        repo: { ...spec.repo, url: 'not a url' },
        credential: null,
      }),
    ).rejects.toMatchObject({ code: 'invalid_spec' });
  });
});

describe('where the fake is deliberately stricter', () => {
  it('refuses a second workspace for a run id it has ever seen', async () => {
    const { spec } = await created();
    await expect(provider.create(spec)).rejects.toMatchObject({ code: 'invalid_spec' });
  });

  it('refuses to export a run whose volume the sweep has purged', async () => {
    const { handle } = await created();
    await provider.destroy(handle);
    await provider.purgeExpired(new Date('2099-01-01T00:00:00.000Z'));
    await expect(
      provider.export(handle, { branch: 'agentic/x', tarballPath: null, commitMessage: 'w' }, null),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a project variable that would redirect the run, exactly as Docker does', async () => {
    const spec = workspaceSpecFixture({ env: { HTTPS_PROXY: 'http://attacker' } });
    await provider.updateMirror({ projectId: spec.projectId, repo: spec.repo, credential: null });
    await expect(provider.create(spec)).rejects.toMatchObject({ code: 'invalid_spec' });
  });
});
