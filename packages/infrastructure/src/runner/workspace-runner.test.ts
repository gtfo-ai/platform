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
  RunHandle,
  RunOutcome,
  RunSpec,
  TerminalRunStatus,
} from '@platform/application';
import { RunStartError, WorkspaceError } from '@platform/application';
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
    build: () => ({
      start: (spec) => {
        startedWith.push(spec);
        return (
          options.inner?.(spec) ?? {
            runId: spec.runId,
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
        outcome: Promise.resolve(outcomeWith(inner, status)),
        steer: async () => {},
        stop: async () => {},
      }),
    });
    const result = await world.runner.start(spec).outcome;

    expect(result.status).toBe(status);
    // The ending is reported, not merely "released": the launcher's retention policy reads it
    // (technical/05 §5 keeps a paused or taken-over workspace longer than an ordinary one).
    expect(world.released).toEqual([{ kind: 'ended', status }]);
  });

  it('releases it when the run crashes instead of producing an outcome', async () => {
    const world = harness({
      inner: (inner) => ({
        runId: inner.runId,
        outcome: Promise.reject(new Error('the transport died mid-run')),
        steer: async () => {},
        stop: async () => {},
      }),
    });
    await expect(world.runner.start(runSpecFixture()).outcome).rejects.toThrow('transport died');
    expect(world.released).toEqual([{ kind: 'crashed' }]);
  });

  it('releases it when the runner refuses to start, and reports the refusal as terminal', async () => {
    const world = harness({
      inner: () => {
        throw new Error('this spec names a model the CLI does not have');
      },
    });
    const failure = await world.runner
      .start(runSpecFixture())
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
    await expect(world.runner.start(runSpecFixture()).outcome).resolves.toMatchObject({
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
      .start(runSpecFixture())
      .outcome.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RunStartError);
    expect((failure as RunStartError).retryable).toBe(true);
    // `create` is atomic ("either it returns a handle or it leaves nothing behind"), so a failed
    // provision owns its own cleanup; calling `release` on a workspace that was never produced
    // would be calling a method on nothing.
    expect(world.released).toEqual([]);
  });
});

describe('the run is executed in the workspace’s own working directory', () => {
  it('replaces the planned workspacePath with the provisioned workdir', async () => {
    const spec = runSpecFixture({ workspacePath: '/workspaces/task-22222222' });
    const world = harness({});
    await world.runner.start(spec).outcome;

    // The planner cannot know where the container has the checkout mounted; the CLI runs inside the
    // container, so its `cwd` must be the path the container sees.
    expect(world.startedWith[0]?.workspacePath).toBe(WORKDIR);
    // And everything else is the spec the planner built, unchanged.
    expect(world.startedWith[0]?.userPrompt).toBe(spec.userPrompt);
    expect(world.provisioned[0]?.workspacePath).toBe('/workspaces/task-22222222');
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
        outcome: new Promise<RunOutcome>((resolve) => {
          releaseInner = resolve;
        }),
        steer: async () => {},
        stop: async (reason) => {
          stops.push(reason);
          releaseInner(outcomeWith(inner, 'cancelled'));
        },
      }),
    });

    const handle = world.runner.start(spec);
    await handle.stop('cancelled');
    const result = await handle.outcome;

    expect(stops).toEqual(['cancelled']);
    expect(result.status).toBe('cancelled');
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
