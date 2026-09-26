/**
 * The launcher service, against the fake provider.
 *
 * Every case here is about **order and obligation** rather than about containers: what happens
 * when a step fails, and what must happen anyway. The clock is injected (standing rule 2): the
 * retention sweep is driven by advancing it, never by waiting.
 */

import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { type LogFields, silentLogger, type WorkspaceProvider } from '@platform/application';
import { runner, workspace } from '@platform/infrastructure';
import { PLATFORM_SKILLS } from '@platform/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LauncherService } from './service.js';

const SECRET = 'glpat-FAKE-000000000000000000';

let dir: string;
let clock: runner.ManualClock;
let provider: workspace.FakeWorkspaceProvider;
let broker: workspace.RunCredentialBroker;
let service: LauncherService;

/** What the runner mints and the create request carries (WP-76). Obviously fake (BD-002). */
const carried = (overrides: Partial<workspace.CarriedRunCredential> = {}) => ({
  host: 'vcs.example.com',
  username: 'oauth2',
  password: `${SECRET}-1`,
  scope: 'push' as const,
  expiresAt: '2026-09-11T00:00:00.000Z',
  ...overrides,
});

const build = (overrides: { retentionSweepMs?: number } = {}) => {
  broker = new workspace.RunCredentialBroker(silentLogger);
  service = new LauncherService({
    provider,
    broker,
    clock,
    logger: silentLogger,
    exportDir: path.join(dir, 'exports'),
    retentionSweepMs: overrides.retentionSweepMs ?? 60_000,
  });
};

const start = async (overrides: { readOnly?: boolean } = {}) => {
  const readOnly = overrides.readOnly ?? false;
  const spec = workspace.workspaceSpecFixture({ runId: randomUUID(), readOnly });
  return {
    spec,
    started: await service.startRun(spec, carried(readOnly ? { scope: 'read' } : {})),
  };
};

beforeEach(async () => {
  dir = await workspace.shortTempDir('agentic-launcher-');
  clock = runner.manualClock();
  provider = new workspace.FakeWorkspaceProvider({
    controlRoot: path.join(dir, 'ctl'),
    // The shipped ten, because this is `apps/launcher` — the composition root that supplies them
    // in production does so from exactly this import.
    skills: PLATFORM_SKILLS,
  });
  build();
});

afterEach(async () => {
  service.stop();
  await rm(dir, { recursive: true, force: true });
});

describe('startRun', () => {
  it('holds the carried credential, mirrors with it, creates and attaches', async () => {
    const { spec, started } = await start();
    expect(started.credential).toMatchObject({ host: 'vcs.example.com', password: `${SECRET}-1` });
    expect(started.credentialScope).toBe('push');
    expect(broker.credentialFor(spec.runId)?.password).toBe(`${SECRET}-1`);
    expect(started.attachment.workdir).toBe('/work/repo');
    expect(provider.events.map((event) => event.kind)).toEqual(['mirror', 'create', 'attach']);
    expect(started.handle.runId).toBe(spec.runId);
  });

  it('holds a read credential for a read-only stage, and refuses a push one (BD-021)', async () => {
    const { started } = await start({ readOnly: true });
    expect(started.credentialScope).toBe('read');
    const spec = workspace.workspaceSpecFixture({ runId: randomUUID(), readOnly: true });
    await expect(service.startRun(spec, carried())).rejects.toMatchObject({
      code: 'invalid_spec',
    });
  });

  it('lets a read-only stage start with no credential — an anonymous fetch', async () => {
    const spec = workspace.workspaceSpecFixture({ runId: randomUUID(), readOnly: true });
    const started = await service.startRun(spec, null);
    expect(started.credential).toBeNull();
    expect(provider.events.map((event) => event.kind)).toEqual(['mirror', 'create', 'attach']);
  });

  /**
   * WP-74 criteria (2) and (5): a spec with no repository makes no mirror fetch — the call a
   * read-only run of a private repository has no credential for (backlog 133) — and the broker is
   * never **asked**, which is stronger than the read-only case above, where it is asked and answers
   * `null`. The container and the socket are created as for any run.
   */
  it('neither mirrors nor asks the broker for a spec with no checkout, and still attaches', async () => {
    const hold = vi.spyOn(broker, 'hold');
    const spec = workspace.repoLessWorkspaceSpecFixture({ runId: randomUUID() });
    const started = await service.startRun(spec, null);
    expect(provider.events.map((event) => event.kind)).toEqual(['create', 'attach']);
    expect(hold).not.toHaveBeenCalled();
    expect(started.credential).toBeNull();
    expect(started.handle.cacheKey).toBeNull();
    expect(started.attachment.workdir).toBe('/work/repo');
  });

  it('refuses a credential that does not match the spec: none for no repository, one for a writer', async () => {
    const repoLess = workspace.repoLessWorkspaceSpecFixture({ runId: randomUUID() });
    await expect(service.startRun(repoLess, carried())).rejects.toMatchObject({
      code: 'invalid_spec',
    });
    const repoFul = workspace.workspaceSpecFixture({ runId: randomUUID() });
    await expect(service.startRun(repoFul, null)).rejects.toMatchObject({ code: 'invalid_spec' });
    expect(broker.liveCount).toBe(0);
    expect(provider.events).toEqual([]);
  });

  /**
   * A run that never started must not leave the credential answerable: the second `startRun` for
   * the same run id fails inside `create`, and the broker has forgotten the value — the runner,
   * which sees the create fail, revokes it at the provider (TD-028's WP-76 amendment, decision 5).
   */
  it('forgets the credential when the workspace cannot be created', async () => {
    const spec = workspace.workspaceSpecFixture({ runId: randomUUID() });
    const other = workspace.workspaceSpecFixture({ runId: randomUUID() });
    await service.startRun(other, carried());
    await service.startRun(spec, carried());
    await expect(service.startRun(spec, carried())).rejects.toMatchObject({
      code: 'invalid_spec',
    });
    expect(broker.answer(spec.runId, 'vcs.example.com')).toBeNull();
    expect(broker.credentialFor(spec.runId)).toBeNull();
    // Another run's credential is untouched by this one's failure.
    expect(broker.credentialFor(other.runId)).not.toBeNull();
  });
});

/**
 * The composition root's half of WP-13's third obligation (standing rule 44).
 *
 * `DockerWorkspaceProvider.create` guarantees "either a handle or nothing" **for itself**. It
 * cannot guarantee it for a *sequence* of its own calls: `create` returns, `attach` throws, and the
 * only reference to a live container is a local in this method. Round 1 shipped exactly that — the
 * `catch` revoked the credential and rethrew, and the container ran until someone found it by hand
 * (nothing reaps orphans: `purgeExpired` removes volumes).
 *
 * It is not an exotic path. `names.ts` records the 103-byte socket cap being hit for real, and
 * `#readToken` throws `not_found` when the control volume is mis-mounted — both inside `attach`,
 * both after the container is up.
 *
 * So the check **enumerates** the steps rather than naming one: a delegating provider fails the
 * n-th call `startRun` makes, for every n the successful path performs. A step added to `startRun`
 * later is covered the day it is added, which is what makes the docblock's claim enforced rather
 * than decorative.
 */
describe('startRun leaves no container behind on any failure path', () => {
  const request = carried();

  /**
   * A delegating object rather than a `Proxy`, for the reason recorded below at "destroys the
   * workspace even when the export throws": the fake's state is in `#private` fields.
   *
   * Teardown (`kill`, `destroy`) is deliberately *not* a countable step: it is what the guarantee
   * is about, not a step of the composition.
   */
  const failingAtStep = (
    target: workspace.FakeWorkspaceProvider,
    failAt: number,
    onDestroy: 'delegate' | 'throw' = 'delegate',
  ): { readonly provider: WorkspaceProvider; readonly steps: () => readonly string[] } => {
    const steps: string[] = [];
    const step = async <T>(name: string, call: () => Promise<T>): Promise<T> => {
      steps.push(name);
      if (steps.length === failAt) {
        throw new Error(`injected failure in ${name}`);
      }
      return call();
    };
    return {
      steps: () => steps,
      provider: {
        updateMirror: (input) => step('updateMirror', () => target.updateMirror(input)),
        create: (spec) => step('create', () => target.create(spec)),
        attach: (handle) => step('attach', () => target.attach(handle)),
        export: (handle, exportRequest, credential) =>
          step('export', () => target.export(handle, exportRequest, credential)),
        extendRetention: (handle, keepUntil) =>
          step('extendRetention', () => target.extendRetention(handle, keepUntil)),
        purgeExpired: (now) => step('purgeExpired', () => target.purgeExpired(now)),
        kill: (handle) => target.kill(handle),
        destroy: async (handle) => {
          if (onDestroy === 'throw') {
            throw new Error('the daemon is unreachable');
          }
          await target.destroy(handle);
        },
      },
    };
  };

  const serviceWith = (provider: WorkspaceProvider): LauncherService =>
    new LauncherService({
      provider,
      broker,
      clock,
      logger: silentLogger,
      exportDir: path.join(dir, 'exports'),
      retentionSweepMs: 60_000,
    });

  it('destroys the workspace when attach fails, stopping before removing', async () => {
    const spec = workspace.workspaceSpecFixture({ runId: randomUUID() });
    const { provider: broken } = failingAtStep(provider, 3);
    await expect(serviceWith(broken).startRun(spec, request)).rejects.toThrow(
      'injected failure in attach',
    );
    const kinds = provider.events
      .filter((event) => event.runId === spec.runId)
      .map((event) => event.kind);
    // Order matters: removing a container that was never stopped leaves the daemon to SIGKILL it
    // with no grace period, and "the shim exited" is not "the workspace's processes are gone".
    expect(kinds).toEqual(['create', 'stop', 'remove']);
    expect(provider.isRunning(spec.runId)).toBe(false);
    expect(broker.credentialFor(spec.runId)).toBeNull();
  });

  /**
   * Standing rule 10 applied to the repair itself: the teardown must not become the failure the
   * caller sees, or a launcher with an unreachable daemon reports the wrong cause for every failed
   * start.
   */
  it('reports the original failure even when the teardown itself fails', async () => {
    const spec = workspace.workspaceSpecFixture({ runId: randomUUID() });
    const { provider: broken } = failingAtStep(provider, 3, 'throw');
    await expect(serviceWith(broken).startRun(spec, request)).rejects.toThrow(
      'injected failure in attach',
    );
  });

  it('leaves nothing running whichever step fails, for every step it performs', async () => {
    // The number of steps is measured, not written down: a step added to `startRun` extends this
    // enumeration by itself (standing rule 7 — ask, do not carry a list).
    const probe = failingAtStep(provider, 0);
    await serviceWith(probe.provider).startRun(
      workspace.workspaceSpecFixture({ runId: randomUUID() }),
      request,
    );
    const stepCount = probe.steps().length;
    expect(stepCount).toBeGreaterThanOrEqual(3);

    for (let failAt = 1; failAt <= stepCount; failAt += 1) {
      const spec = workspace.workspaceSpecFixture({ runId: randomUUID() });
      const attempt = failingAtStep(provider, failAt);
      const failure = await serviceWith(attempt.provider)
        .startRun(spec, request)
        .then(
          () => null,
          (error: unknown) => error,
        );
      // The step's name is read *after* the call, so the message pins which call was failed rather
      // than which call the test hoped to fail.
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(`injected failure in ${attempt.steps()[failAt - 1]}`);
      expect(provider.isRunning(spec.runId)).toBe(false);
      // The credential is the other thing that outlives a failed start: the launcher forgets it
      // here and the runner revokes it at the provider (WP-76, decision 5).
      expect(broker.credentialFor(spec.runId)).toBeNull();
      const kinds = provider.events
        .filter((event) => event.runId === spec.runId)
        .map((event) => event.kind);
      // Rule 10: assert which branch ran. A run whose container was created must have been stopped
      // and removed; one that failed before `create` must not have been torn down at all.
      if (kinds.includes('create')) {
        expect(kinds.indexOf('stop')).toBeGreaterThan(kinds.indexOf('create'));
        expect(kinds.indexOf('remove')).toBeGreaterThan(kinds.indexOf('stop'));
      } else {
        expect(kinds).not.toContain('stop');
      }
    }
  });
});

describe('endRun — the container stop happens on every path (WP-13 obligation 3)', () => {
  const exportRequest = { branch: 'agentic/task-1', commitMessage: 'wip:', tarball: true } as const;

  it('exports with the held credential, forgets it and destroys, in that order', async () => {
    const { started } = await start();
    const exported = vi.spyOn(provider, 'export');
    const ended = await service.endRun(started.handle, { export: exportRequest });
    expect(ended.failures).toEqual([]);
    expect(ended.exported?.pushed).toBe(true);
    // The export pushed with the run's own credential, and it is gone afterwards.
    expect(exported.mock.calls[0]?.[2]?.password).toBe(`${SECRET}-1`);
    expect(broker.credentialFor(started.handle.runId)).toBeNull();
    expect(provider.isRunning(started.handle.runId)).toBe(false);
    const kinds = provider.events.map((event) => event.kind);
    expect(kinds.indexOf('export')).toBeLessThan(kinds.indexOf('remove'));
  });

  it('destroys the workspace even when the export throws', async () => {
    const { started } = await start();
    // A delegating object rather than a `Proxy`: the fake keeps its state in `#private` fields, and
    // a proxy's `get` trap returns an unbound method whose `this` is the proxy — which cannot read
    // them. The failure ("Cannot read private member #runs") looks like a bug in the fake.
    const broken: WorkspaceProvider = {
      updateMirror: (input) => provider.updateMirror(input),
      create: (spec) => provider.create(spec),
      attach: (handle) => provider.attach(handle),
      kill: (handle) => provider.kill(handle),
      destroy: (handle) => provider.destroy(handle),
      extendRetention: (handle, keepUntil) => provider.extendRetention(handle, keepUntil),
      purgeExpired: (now) => provider.purgeExpired(now),
      export: async () => {
        throw new Error('the git host is down');
      },
    };
    const withBrokenExport = new LauncherService({
      provider: broken,
      broker,
      clock,
      logger: silentLogger,
      exportDir: path.join(dir, 'exports'),
      retentionSweepMs: 60_000,
    });
    const ended = await withBrokenExport.endRun(started.handle, { export: exportRequest });
    expect(ended.exported).toBeNull();
    expect(ended.failures[0]).toContain('the git host is down');
    // The point of the whole work package: the shim signals one pid, so only the container's pid
    // namespace ending takes a detached grandchild with it.
    expect(provider.isRunning(started.handle.runId)).toBe(false);
  });

  it('writes the tarball under the launcher export directory, named for the run', async () => {
    const { started } = await start();
    const ended = await service.endRun(started.handle, { export: exportRequest });
    expect(ended.exported?.tarballPath).toBe(
      path.join(dir, 'exports', `${started.handle.runId}.tar`),
    );
  });

  it('exports without a tarball when the caller does not ask for one', async () => {
    const { started } = await start();
    const ended = await service.endRun(started.handle, {
      export: { ...exportRequest, tarball: false },
    });
    expect(ended.exported?.tarballPath).toBeNull();
    expect(ended.exported?.tarballBytes).toBeGreaterThan(0);
  });

  it('ends a run with no export at all', async () => {
    const { started } = await start();
    const ended = await service.endRun(started.handle, { export: null });
    expect(ended.exported).toBeNull();
    expect(provider.isRunning(started.handle.runId)).toBe(false);
  });

  // ── The fourteen-day window (WP-27, technical/05 §5) ─────────────────────

  it('holds the workspace past its own window when the take-over asks for one', async () => {
    const { started } = await start();
    const ended = await service.endRun(started.handle, {
      export: { ...exportRequest, keepUntil: '2099-01-01T00:00:00.000Z' },
    });
    expect(ended.failures).toEqual([]);
    expect(ended.keepUntil).toBe('2099-01-01T00:00:00.000Z');
    // The property, through the port rather than through a label: a sweep past the workspace's own
    // three days keeps it (`buildWorkspaceSpec`'s default, and the volume this run was created
    // with).
    const report = await provider.purgeExpired(new Date('2098-01-01T00:00:00.000Z'));
    expect(report.volumes.find((entry) => entry.runId === started.handle.runId)).toMatchObject({
      removed: false,
      keptReason: 'not_expired',
    });
  });

  it('holds it **even when the export failed**, which is when the volume matters most', async () => {
    const { started } = await start();
    const broken: WorkspaceProvider = {
      updateMirror: (input) => provider.updateMirror(input),
      create: (spec) => provider.create(spec),
      attach: (handle) => provider.attach(handle),
      kill: (handle) => provider.kill(handle),
      destroy: (handle) => provider.destroy(handle),
      extendRetention: (handle, keepUntil) => provider.extendRetention(handle, keepUntil),
      purgeExpired: (now) => provider.purgeExpired(now),
      export: async () => {
        throw new Error('the git host is unreachable');
      },
    };
    const withBroken = new LauncherService({
      provider: broken,
      broker,
      clock,
      logger: silentLogger,
      exportDir: path.join(dir, 'exports'),
      retentionSweepMs: 60_000,
    });

    const ended = await withBroken.endRun(started.handle, {
      export: { ...exportRequest, keepUntil: '2099-01-01T00:00:00.000Z' },
    });

    // A push that failed leaves the work in the volume and **nowhere else**, so the longer window
    // is more necessary rather than less — which is why the extension is its own step in a
    // `finally` rather than the last line of the export.
    expect(ended.failures.some((failure) => failure.startsWith('export:'))).toBe(true);
    expect(ended.keepUntil).toBe('2099-01-01T00:00:00.000Z');
    expect(provider.isRunning(started.handle.runId)).toBe(false);
  });

  it('reports a retention failure and still stops the container', async () => {
    const { started } = await start();
    const broken: WorkspaceProvider = {
      updateMirror: (input) => provider.updateMirror(input),
      create: (spec) => provider.create(spec),
      attach: (handle) => provider.attach(handle),
      kill: (handle) => provider.kill(handle),
      destroy: (handle) => provider.destroy(handle),
      export: (handle, request, credential) => provider.export(handle, request, credential),
      purgeExpired: (now) => provider.purgeExpired(now),
      extendRetention: async () => {
        throw new Error('the daemon is unreachable');
      },
    };
    const withBroken = new LauncherService({
      provider: broken,
      broker,
      clock,
      logger: silentLogger,
      exportDir: path.join(dir, 'exports'),
      retentionSweepMs: 60_000,
    });

    const ended = await withBroken.endRun(started.handle, {
      export: { ...exportRequest, keepUntil: '2099-01-01T00:00:00.000Z' },
    });

    expect(ended.keepUntil).toBeNull();
    expect(ended.failures.some((failure) => failure.startsWith('retention:'))).toBe(true);
    // The stop is the guarantee, and nothing above it may skip it (WP-13's third obligation).
    expect(provider.isRunning(started.handle.runId)).toBe(false);
  });

  it('leaves the window alone for an ordinary end of run', async () => {
    const { started } = await start();
    const ended = await service.endRun(started.handle, { export: exportRequest });
    expect(ended.keepUntil).toBeNull();
    // …and the workspace really is on the three-day window it was created with.
    const report = await provider.purgeExpired(new Date('2098-01-01T00:00:00.000Z'));
    expect(report.volumes.find((entry) => entry.runId === started.handle.runId)).toMatchObject({
      removed: true,
    });
  });

  it('stops answering credential questions once the run has ended', async () => {
    const { started } = await start();
    expect(broker.answer(started.handle.runId, 'vcs.example.com')).not.toBeNull();
    await service.endRun(started.handle, { export: null });
    // The window between "the run ended" and "the container is gone" is real, and a broker that
    // kept answering in it would hand a live push token to a workspace nobody is watching.
    expect(broker.answer(started.handle.runId, 'vcs.example.com')).toBeNull();
  });
});

describe('retention sweep', () => {
  it('does not sweep before its interval has passed', async () => {
    service.startRetentionSweep();
    clock.advance(59_999);
    await Promise.resolve();
    expect(provider.events.some((event) => event.kind === 'purge')).toBe(false);
  });

  it('sweeps on the injected clock, and re-arms afterwards', async () => {
    // The manual clock starts at epoch 0, so a `keep_until` in 1969 is already past when the sweep
    // reads `clock.now()`. Nothing here waits on wall-clock time (standing rule 2).
    const spec = workspace.workspaceSpecFixture({
      runId: randomUUID(),
      keepUntil: '1969-01-01T00:00:00.000Z',
    });
    const started = await service.startRun(spec, carried());
    await service.endRun(started.handle, { export: null });

    service.startRetentionSweep();
    clock.advance(60_000);
    await vi.waitFor(() =>
      expect(provider.events.some((event) => event.kind === 'purge')).toBe(true),
    );
    // Re-armed rather than a fixed interval: the next timer exists only because the last sweep
    // finished, so a sweep slower than the period cannot stack up on itself.
    await vi.waitFor(() => expect(clock.pending).toBe(1));
  });

  it('stops sweeping when the service stops', () => {
    service.startRetentionSweep();
    expect(clock.pending).toBe(1);
    service.stop();
    expect(clock.pending).toBe(0);
  });

  it('arms one timer however many times it is started', () => {
    service.startRetentionSweep();
    service.startRetentionSweep();
    expect(clock.pending).toBe(1);
  });

  /**
   * The summary line carries the **control-directory** half too — PROGRESS backlog **0b**, and the
   * assertion is the point rather than the field.
   *
   * WP-53 added those three fields *because* an unreclaimed run token — a directory the sweep tried
   * and failed to remove, whose token is still readable — was visible only in a per-directory `warn`
   * and reached no summary. A log line added for that reason and asserted by nothing is the same gap
   * one step along, which is what WP-53's round-2 review found: a grep for the field names returned
   * only the three lines that write them.
   *
   * The three outcomes are asserted **separately**, because a single count would let the two that
   * matter collapse into each other: `reclaimed` is the sweep working and `unreclaimed` is a
   * credential still on a shared volume, and `run_alive` is neither.
   */
  it('reports the control directories it examined, reclaimed and could not reclaim', async () => {
    const lines: { fields: LogFields; message: string }[] = [];
    /**
     * Built rather than spread from {@link provider}: `FakeWorkspaceProvider` is a class, so
     * `{...instance}` copies its fields and **not** its prototype methods — the object would satisfy
     * nothing and `tsc` says so. Every method but the one under test throws, which is the scope of
     * this case written down: `sweep` calls `purgeExpired` and nothing else, and it fails loudly if
     * that ever stops being true.
     */
    const unused = (name: string) => (): never => {
      throw new Error(`this case drives sweep only; ${name} was not expected`);
    };
    const reporting: WorkspaceProvider = {
      updateMirror: unused('updateMirror'),
      create: unused('create'),
      attach: unused('attach'),
      kill: unused('kill'),
      export: unused('export'),
      destroy: unused('destroy'),
      extendRetention: unused('extendRetention'),
      purgeExpired: async () => ({
        examined: 0,
        removed: 0,
        volumes: [],
        controlDirectories: [
          { runId: randomUUID(), removed: true, keptReason: null },
          { runId: randomUUID(), removed: false, keptReason: 'remove_failed' },
          { runId: randomUUID(), removed: false, keptReason: 'run_alive' },
        ],
      }),
    };
    const sweeper = new LauncherService({
      provider: reporting,
      broker,
      clock,
      logger: {
        ...silentLogger,
        info: (fields, message) => {
          lines.push({ fields, message });
        },
      },
      exportDir: path.join(dir, 'exports'),
      retentionSweepMs: 60_000,
    });

    await sweeper.sweep(new Date(0));

    const summary = lines.find((line) => line.message === 'workspace retention sweep');
    expect(summary).toBeDefined();
    expect(summary?.fields).toMatchObject({
      control_directories: 3,
      control_directories_reclaimed: 1,
      // The one an operator has to act on: a run token that is still there.
      control_directories_unreclaimed: 1,
    });
    // And the volume half is still its own pair of numbers, so a reader counting workspaces cannot
    // count a control directory as one.
    expect(summary?.fields).toMatchObject({ examined: 0, removed: 0 });
  });
});
