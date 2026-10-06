/**
 * The per-run runner, and the obligation it exists to discharge: **every ending frees the
 * workspace**.
 *
 * WP-13 measured that a run container outlives anything that signals one pid — only the container's
 * pid namespace ending takes a detached grandchild with it — so a workspace that is not released is
 * an agent that is still running. `LauncherService.endRun` discharges that, and only if something
 * calls it on every path. The set is enumerated in `workspace-runner.ts` and each member is driven
 * here **separately**: a single "release was called" assertion over one ending is how the other
 * seven stay untested (standing rule 68).
 */
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type {
  ClaudeRunner,
  ExistingProtectedPaths,
  RunHandle,
  RunOutcome,
  RunSpec,
  TerminalRunStatus,
} from '@platform/application';
import { countingStartHooks, RunStartError, WorkspaceError } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { runSpecFixture } from './fixtures.js';
import {
  classifyProvisionFailure,
  createWorkspaceClaudeRunner,
  type ProvisionedRunWorkspace,
  type RunWorkspaceEnding,
} from './workspace-runner.js';

const WORKDIR = '/work/repo';

const outcomeWith = (spec: RunSpec, status: TerminalRunStatus): RunOutcome => ({
  runId: spec.runId,
  status,
  terminalReason: status === 'completed' ? 'success' : 'error_during_execution',
  sessionId: 'session-1',
  numTurns: 1,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_read_tokens: 0,
  },
  modelUsage: [],
  cost: { usd: 0.1, is_estimate: false, price_list_id: null },
  wallMs: 1,
  structuredOutput: null,
  error: null,
  redactionCount: 0,
});

interface Harness {
  readonly runner: ClaudeRunner;
  readonly released: RunWorkspaceEnding[];
  readonly provisioned: RunSpec[];
  /** The `cwd` the inner runner was given, once it has been built. */
  readonly startedWith: RunSpec[];
  readonly spawnCalls: number;
  /** What `build` was handed, per run: the transport and, since WP-118, the launcher's answer. */
  readonly transports: { readonly workdir: string; readonly cliEnvironment?: unknown }[];
}

const harness = (options: {
  readonly provision?: () => Promise<ProvisionedRunWorkspace>;
  readonly inner?: (spec: RunSpec) => RunHandle;
  readonly releaseThrows?: boolean;
}): Harness => {
  const released: RunWorkspaceEnding[] = [];
  const provisioned: RunSpec[] = [];
  const startedWith: RunSpec[] = [];
  let spawnCalls = 0;
  const transports: { readonly workdir: string; readonly cliEnvironment?: unknown }[] = [];
  const spawn = (_options: SpawnOptions): SpawnedProcess => {
    spawnCalls += 1;
    return {} as SpawnedProcess;
  };
  const workspace: ProvisionedRunWorkspace = {
    workdir: WORKDIR,
    spawn,
    release: async (ending) => {
      released.push(ending);
      if (options.releaseThrows === true) {
        throw new Error('the daemon is gone');
      }
    },
  };
  const runner = createWorkspaceClaudeRunner({
    provisioner: {
      provision: async (spec) => {
        provisioned.push(spec);
        return options.provision === undefined ? workspace : await options.provision();
      },
    },
    build: (transport) => ({
      start: (spec) => {
        transports.push(transport);
        startedWith.push(spec);
        return (
          options.inner?.(spec) ?? {
            runId: spec.runId,
            sessionId: `session-${spec.runId}`,
            outcome: Promise.resolve(outcomeWith(spec, 'completed')),
            steer: async () => {},
            stop: async () => {},
          }
        );
      },
    }),
  });
  return {
    runner,
    released,
    provisioned,
    startedWith,
    transports,
    get spawnCalls() {
      return spawnCalls;
    },
  };
};

/** Every terminal status of `RunOutcome`, which is the enumeration standing rule 68 asks for. */
const TERMINAL_STATUSES: readonly TerminalRunStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'budget_exceeded',
  'timed_out',
  'stalled',
];

describe('every ending frees the workspace', () => {
  it.each(TERMINAL_STATUSES)('releases it after a run that ended as %s', async (status) => {
    const spec = runSpecFixture();
    const world = harness({
      inner: (inner) => ({
        runId: inner.runId,
        sessionId: `session-${inner.runId}`,
        outcome: Promise.resolve(outcomeWith(inner, status)),
        steer: async () => {},
        stop: async () => {},
      }),
    });
    const result = await world.runner.start(spec, countingStartHooks()).outcome;

    expect(result.status).toBe(status);
    // The ending is reported, not merely "released": the launcher's retention policy reads it
    // (technical/05 §5 keeps a paused or taken-over workspace longer than an ordinary one).
    expect(world.released).toEqual([{ kind: 'ended', status }]);
  });

  it('releases it when the run crashes instead of producing an outcome', async () => {
    const world = harness({
      inner: (inner) => ({
        runId: inner.runId,
        sessionId: null,
        outcome: Promise.reject(new Error('the transport died mid-run')),
        steer: async () => {},
        stop: async () => {},
      }),
    });
    await expect(
      world.runner.start(runSpecFixture(), countingStartHooks()).outcome,
    ).rejects.toThrow('transport died');
    expect(world.released).toEqual([{ kind: 'crashed' }]);
  });

  it('releases it when the runner refuses to start, and reports the refusal as terminal', async () => {
    const world = harness({
      inner: () => {
        throw new Error('this spec names a model the CLI does not have');
      },
    });
    const failure = await world.runner
      .start(runSpecFixture(), countingStartHooks())
      .outcome.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RunStartError);
    expect((failure as RunStartError).retryable).toBe(false);
    expect(world.released).toEqual([{ kind: 'not_started' }]);
  });

  it('does not swallow the run’s outcome when releasing the workspace fails', async () => {
    // A release that throws must not become the failure the caller sees — the run really did
    // complete — and it must not be silent either; the log line is the only signal that a container
    // may still be up.
    const world = harness({ releaseThrows: true });
    await expect(
      world.runner.start(runSpecFixture(), countingStartHooks()).outcome,
    ).resolves.toMatchObject({
      status: 'completed',
    });
    expect(world.released).toHaveLength(1);
  });

  it('has nothing to release when provisioning itself failed', async () => {
    const world = harness({
      provision: async () => {
        throw new WorkspaceError('engine_unavailable', 'the daemon refused the connection');
      },
    });
    const failure = await world.runner
      .start(runSpecFixture(), countingStartHooks())
      .outcome.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RunStartError);
    expect((failure as RunStartError).retryable).toBe(true);
    // `create` is atomic ("either it returns a handle or it leaves nothing behind"), so a failed
    // provision owns its own cleanup; calling `release` on a workspace that was never produced
    // would be calling a method on nothing.
    expect(world.released).toEqual([]);
  });

  it('carries the workspace’s kind, reason code and commit to the stage executor (WP-127)', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const world = harness({
      provision: async () => {
        throw new WorkspaceError('invalid_spec', 'FAKE-planted words that stay in the log', {
          reason: 'checkout_commit_missing',
          commit: sha,
        });
      },
    });
    const failure = await world.runner
      .start(runSpecFixture(), countingStartHooks())
      .outcome.catch((error: unknown) => error);

    expect((failure as RunStartError).diagnosis).toEqual({
      kind: 'invalid_spec',
      reason: 'checkout_commit_missing',
      commit: sha,
    });
    expect((failure as RunStartError).retryable).toBe(false);
  });
});

describe('the run is executed in the workspace’s own working directory', () => {
  it('replaces the planned workspacePath with the provisioned workdir', async () => {
    const spec = runSpecFixture({ workspacePath: '/workspaces/task-22222222' });
    const world = harness({});
    await world.runner.start(spec, countingStartHooks()).outcome;

    // The planner cannot know where the container has the checkout mounted; the CLI runs inside the
    // container, so its `cwd` must be the path the container sees.
    expect(world.startedWith[0]?.workspacePath).toBe(WORKDIR);
    // And everything else is the spec the planner built, unchanged.
    expect(world.startedWith[0]?.userPrompt).toBe(spec.userPrompt);
    expect(world.provisioned[0]?.workspacePath).toBe('/workspaces/task-22222222');
  });

  /** WP-99: the launcher's listing reaches the spec the runner starts, beside `workspacePath`. */
  it('substitutes the workspace’s listing of existing protected paths, and keeps the planned one when it has none', async () => {
    const listing: ExistingProtectedPaths = {
      state: 'listed',
      paths: ['src/totals.test.ts'],
      opaque: [],
    };
    const spawn = (_options: SpawnOptions): SpawnedProcess => ({}) as SpawnedProcess;
    const listed = harness({
      provision: async () => ({
        workdir: WORKDIR,
        existingProtectedPaths: listing,
        spawn,
        release: async () => {},
      }),
    });
    const spec = runSpecFixture();
    await listed.runner.start(spec, countingStartHooks()).outcome;
    expect(listed.startedWith[0]?.existingProtectedPaths).toEqual(listing);
    expect(listed.provisioned[0]?.existingProtectedPaths.state).toBe('unlisted');

    const silent = harness({});
    await silent.runner.start(spec, countingStartHooks()).outcome;
    expect(silent.startedWith[0]?.existingProtectedPaths).toEqual(spec.existingProtectedPaths);
  });

  it('hands the launcher’s CLI environment to build, and nothing when the workspace has none (WP-118)', async () => {
    const answer = {
      proxy: null,
      home: '/tmp',
      claudeConfigDir: '/tmp/claude',
      path: '/usr/bin:/bin',
      gitConfig: [
        { key: 'credential.helper', value: '!agentic-runlet credential --socket /ctl/cred.sock' },
      ],
    };
    const spawn = (_options: SpawnOptions): SpawnedProcess => ({}) as SpawnedProcess;
    const answered = harness({
      provision: async () => ({
        workdir: WORKDIR,
        cliEnvironment: answer,
        spawn,
        release: async () => {},
      }),
    });
    await answered.runner.start(runSpecFixture(), countingStartHooks()).outcome;
    expect(answered.transports[0]?.cliEnvironment).toEqual(answer);

    const bare = harness({});
    await bare.runner.start(runSpecFixture(), countingStartHooks()).outcome;
    expect(bare.transports[0]).not.toHaveProperty('cliEnvironment');
  });
});

describe('a stop that arrives before the run has started', () => {
  it('is applied the moment it can be, rather than dropped', async () => {
    const stops: string[] = [];
    let releaseInner!: (outcome: RunOutcome) => void;
    const spec = runSpecFixture();
    const world = harness({
      provision: async () =>
        // Provisioning has not finished when `stop()` is called below; this is the window a human
        // cancelling a run that is still starting lands in.
        new Promise<ProvisionedRunWorkspace>((resolve) => {
          setTimeout(
            () =>
              resolve({
                workdir: WORKDIR,
                spawn: () => ({}) as SpawnedProcess,
                release: async () => {},
              }),
            5,
          );
        }),
      inner: (inner) => ({
        runId: inner.runId,
        sessionId: `session-${inner.runId}`,
        outcome: new Promise<RunOutcome>((resolve) => {
          releaseInner = resolve;
        }),
        steer: async () => {},
        stop: async (stop) => {
          stops.push(stop.reason);
          releaseInner(outcomeWith(inner, 'cancelled'));
        },
      }),
    });

    const handle = world.runner.start(spec, countingStartHooks());
    await handle.stop({ reason: 'cancelled' });
    const result = await handle.outcome;

    expect(stops).toEqual(['cancelled']);
    expect(result.status).toBe('cancelled');
  });
});

/**
 * Backlog 467 — the product owner's 2026-10-05 decision: an unsuccessful Developer run's unfinished
 * work is exported on the way out, and the workspace's answer reaches the outcome the executor
 * records. The decision of *when* is `unfinished-work.ts`'s (its own tests); what is asserted here is
 * that this runner asks at the one moment the tree exists, with the spec's branch, and folds the
 * answer back without changing the run's ending.
 */
describe('an unsuccessful run’s unfinished work (backlog 467)', () => {
  const BRANCH = 'agentic/ACME-1';
  const SAVED = { branch: BRANCH, commit_sha: 'abc1234def', pushed: true } as const;

  const world = (options: {
    readonly spec: RunSpec;
    readonly outcome: RunOutcome;
    readonly answer?: () => Promise<unknown>;
    readonly stopFirst?: Parameters<RunHandle['stop']>[0];
  }) => {
    const released: RunWorkspaceEnding[] = [];
    let releases = 0;
    const runner = createWorkspaceClaudeRunner({
      provisioner: {
        provision: async () => ({
          workdir: WORKDIR,
          spawn: () => ({}) as SpawnedProcess,
          release: async (ending) => {
            releases += 1;
            released.push(ending);
            return (await options.answer?.()) as never;
          },
        }),
      },
      build: () => ({
        start: (spec) => ({
          runId: spec.runId,
          sessionId: 'session-1',
          outcome: Promise.resolve(options.outcome),
          steer: async () => {},
          stop: async () => {},
        }),
      }),
    });
    const handle = runner.start(options.spec, countingStartHooks());
    return {
      handle,
      released,
      get releases() {
        return releases;
      },
    };
  };

  const failed = (spec: RunSpec, reason: RunOutcome['terminalReason']): RunOutcome => ({
    ...outcomeWith(spec, 'failed'),
    terminalReason: reason,
    numTurns: 201,
  });

  it('asks the workspace for the export with the spec’s branch and a `wip:` message, and records its answer', async () => {
    const spec = runSpecFixture({ unfinishedWorkBranch: BRANCH, attempt: 2 });
    const run = world({
      spec,
      outcome: failed(spec, 'error_max_turns'),
      answer: async () => ({ savedWork: SAVED }),
    });
    const result = await run.handle.outcome;

    expect(run.releases).toBe(1);
    expect(run.released[0]).toEqual({
      kind: 'ended',
      status: 'failed',
      unfinishedWork: {
        branch: BRANCH,
        commitMessage: 'wip: unfinished attempt 2 of implementation (error_max_turns)',
      },
    });
    // The ending is the run's own; only the saved work is added.
    expect(result.status).toBe('failed');
    expect(result.terminalReason).toBe('error_max_turns');
    expect(result.savedWork).toEqual(SAVED);
  });

  it('asks nothing of a run whose spec names no branch, or whose ending is not saved', async () => {
    const noBranch = runSpecFixture({ unfinishedWorkBranch: null });
    const first = world({ spec: noBranch, outcome: failed(noBranch, 'error_max_turns') });
    expect((await first.handle.outcome).savedWork).toBeUndefined();
    expect(first.released[0]).toEqual({ kind: 'ended', status: 'failed' });

    const withBranch = runSpecFixture({ unfinishedWorkBranch: BRANCH });
    const completed = world({
      spec: withBranch,
      outcome: outcomeWith(withBranch, 'completed'),
      answer: async () => ({ savedWork: SAVED }),
    });
    expect((await completed.handle.outcome).savedWork).toBeUndefined();
    expect(completed.released[0]).toEqual({ kind: 'ended', status: 'completed' });

    const cancelled = world({
      spec: withBranch,
      outcome: { ...outcomeWith(withBranch, 'cancelled'), terminalReason: 'cancelled' },
    });
    await cancelled.handle.outcome;
    expect(cancelled.released[0]).toEqual({ kind: 'ended', status: 'cancelled' });
  });

  it('sends a take-over’s export instead, never both', async () => {
    const spec = runSpecFixture({ unfinishedWorkBranch: BRANCH });
    const takeOver = {
      branch: BRANCH,
      commitMessage: 'wip: hand-over to Ada',
      tarball: false,
      keepUntil: '2026-10-19T00:00:00.000Z',
    };
    const run = world({ spec, outcome: failed(spec, 'error_max_turns') });
    await run.handle.stop({ reason: 'taken_over', workspaceExport: takeOver });
    await run.handle.outcome;
    expect(run.released[0]).toEqual({ kind: 'ended', status: 'failed', takeOver });
  });

  it('keeps the outcome as it was when the release answers nothing or throws', async () => {
    const spec = runSpecFixture({ unfinishedWorkBranch: BRANCH });
    const silent = world({ spec, outcome: failed(spec, 'timed_out') });
    const quiet = await silent.handle.outcome;
    expect(quiet.savedWork).toBeUndefined();
    expect(quiet.terminalReason).toBe('timed_out');

    const throwing = world({
      spec,
      outcome: failed(spec, 'stalled'),
      answer: async () => {
        throw new Error('the launcher is gone');
      },
    });
    const thrown = await throwing.handle.outcome;
    // Released once — the ended path's release is the one, the `finally` does not repeat it.
    expect(throwing.releases).toBe(1);
    expect(thrown.savedWork).toBeUndefined();
    expect(thrown.status).toBe('failed');
  });
});

describe('classifyProvisionFailure', () => {
  it('retries a transport failure and refuses to retry a spec the launcher rejected', () => {
    expect(classifyProvisionFailure(new WorkspaceError('engine_unavailable', 'x')).retryable).toBe(
      true,
    );
    expect(classifyProvisionFailure(new WorkspaceError('workspace_failed', 'x')).retryable).toBe(
      true,
    );
    expect(classifyProvisionFailure(new WorkspaceError('not_found', 'x')).retryable).toBe(true);
    // The same spec would be refused identically on every attempt.
    expect(classifyProvisionFailure(new WorkspaceError('invalid_spec', 'x')).retryable).toBe(false);
  });

  it('treats anything it does not recognise as terminal', () => {
    // Fail closed: a failure shape nobody has classified parks one task and tells a human, rather
    // than retrying something nobody has looked at.
    expect(classifyProvisionFailure(new Error('boom')).retryable).toBe(false);
    expect(classifyProvisionFailure('a string').retryable).toBe(false);
    expect(classifyProvisionFailure(undefined).retryable).toBe(false);
    // A provisioner that classified its own failure is taken at its word, in both directions.
    expect(classifyProvisionFailure(new RunStartError('flap', { retryable: true })).retryable).toBe(
      true,
    );
    expect(
      classifyProvisionFailure(new RunStartError('refused', { retryable: false })).retryable,
    ).toBe(false);
  });
});
