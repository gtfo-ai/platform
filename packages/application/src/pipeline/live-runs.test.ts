/**
 * The register of live runs (WP-27), driven through the wrapper rather than through a setter.
 *
 * `observe` is the only way anything gets into it, which is what the cases below exercise: a run is
 * findable by its id **and** by its task while its outcome is pending, and by neither once that
 * outcome has settled — however it settled. The asymmetry worth pinning is the last one: a rejected
 * outcome is a run that crashed, and a handle left in the register for it would answer a steer with
 * a push into a closed queue, which the runner silently ignores (`claude-runner.ts`).
 */
import type { Id } from '@platform/contracts';
import { DEFAULT_COMMAND_POLICY } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { ClaudeRunner, RunHandle, RunOutcome, RunSpec } from '../ports/runner.js';
import { runLimitsDefaults, runSpecSchema } from '../ports/runner.js';
import { createLiveRuns, MAX_LIVE_RUNS } from './live-runs.js';

const RUN = '11111111-1111-4111-8111-111111111111' as Id;
const TASK = '22222222-2222-4222-8222-222222222222' as Id;
const PROJECT = '33333333-3333-4333-8333-333333333333' as Id;

/**
 * A spec that parses, built here rather than imported.
 *
 * `runSpecFixture` lives in `packages/infrastructure`, which the application ring may not import
 * (the dependency rule in `biome.json`). Parsing rather than casting is the point: a required field
 * added to `runSpecSchema` fails this file rather than being cast past.
 */
const specFixture = (overrides: Partial<RunSpec> = {}): RunSpec =>
  runSpecSchema.parse({
    runId: RUN,
    taskId: TASK,
    projectId: PROJECT,
    stage: 'implementation',
    role: 'developer',
    mode: 'normal',
    attempt: 1,
    model: 'claude-opus-5',
    effort: 'high',
    providerMode: 'api',
    promptVersion: 'sha256:fixture',
    systemPromptAppend: 'You are the developer agent.',
    userPrompt: 'Fix the flaky login test.',
    workspacePath: '/workspace/task',
    contextPack: [],
    limits: runLimitsDefaults,
    tools: ['Read'],
    disallowedTools: [],
    platformTools: [],
    commandPolicy: {
      allow: [...DEFAULT_COMMAND_POLICY.allow],
      ask: [...DEFAULT_COMMAND_POLICY.ask],
      block: [...DEFAULT_COMMAND_POLICY.block],
    },
    protectedPaths: [],
    plannedProtectedPaths: [],
    agents: {},
    mcpServers: {},
    skills: [],
    artifactType: null,
    env: {},
    secretEnvNames: [],
    claudeCodePath: null,
    resumeSessionId: null,
    ...overrides,
  });

const outcomeFixture = (runId: Id): RunOutcome => ({
  runId,
  status: 'completed',
  terminalReason: 'success',
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

/** A runner whose handle settles when the test says so. */
const deferredRunner = (): {
  readonly runner: ClaudeRunner;
  readonly settle: (runId: Id, how: 'resolve' | 'reject') => void;
  readonly handles: readonly RunHandle[];
} => {
  const settlers = new Map<Id, { resolve: () => void; reject: () => void }>();
  const handles: RunHandle[] = [];
  return {
    handles,
    settle: (runId, how) => {
      const settler = settlers.get(runId);
      if (settler === undefined) {
        throw new Error(`no run ${runId}`);
      }
      settler[how]();
    },
    runner: {
      start: (spec) => {
        const outcome = new Promise<RunOutcome>((resolve, reject) => {
          settlers.set(spec.runId, {
            resolve: () => resolve(outcomeFixture(spec.runId)),
            reject: () => reject(new Error('the transport died mid-run')),
          });
        });
        // The runner's own guard, reproduced: an unhandled rejection ends the process in Node 24.
        outcome.catch(() => undefined);
        const handle: RunHandle = {
          runId: spec.runId,
          sessionId: `session-${spec.runId}`,
          outcome,
          steer: async () => {},
          stop: async () => {},
        };
        handles.push(handle);
        return handle;
      },
    },
  };
};

describe('the register of live runs', () => {
  it('finds a running run by its id and by its task, and returns the handle unchanged', () => {
    const live = createLiveRuns();
    const inner = deferredRunner();
    const handle = live.observe(inner.runner).start(specFixture());

    expect(handle).toBe(inner.handles[0]);
    expect(live.forRun(RUN)?.handle).toBe(handle);
    expect(live.forTask(TASK)?.runId).toBe(RUN);
    expect(live.size).toBe(1);
  });

  it.each(['resolve', 'reject'] as const)(
    'forgets a run whose outcome %sd — both endings, because a crashed handle is as dead',
    async (how) => {
      const live = createLiveRuns();
      const inner = deferredRunner();
      const handle = live.observe(inner.runner).start(specFixture());

      inner.settle(RUN, how);
      await handle.outcome.catch(() => undefined);
      // One turn of the microtask queue after the settle, which is where the `finally` runs.
      await Promise.resolve();
      await Promise.resolve();

      expect(live.forRun(RUN)).toBeNull();
      expect(live.forTask(TASK)).toBeNull();
      expect(live.size).toBe(0);
    },
  );

  it('answers null for a run it has never seen, which is how a steer is refused', () => {
    const live = createLiveRuns();
    expect(live.forRun(RUN)).toBeNull();
    expect(live.forTask(TASK)).toBeNull();
  });

  it('keeps the task pointing at its newest run when the previous one settles late', async () => {
    const live = createLiveRuns();
    const inner = deferredRunner();
    const runner = live.observe(inner.runner);
    const second = '44444444-4444-4444-8444-444444444444' as Id;

    const first = runner.start(specFixture());
    runner.start(specFixture({ runId: second }));
    // The first run ends *after* the second started — the ordinary shape of a retried stage.
    inner.settle(RUN, 'resolve');
    await first.outcome;
    await Promise.resolve();
    await Promise.resolve();

    // The dead run is gone and the task still names the live one: a `forTask` that deleted the
    // index unconditionally would have made the second run unreachable for a take-over.
    expect(live.forRun(RUN)).toBeNull();
    expect(live.forTask(TASK)?.runId).toBe(second);
  });

  it('evicts the oldest entry past the cap, and the evicted run is refused rather than confused', () => {
    const live = createLiveRuns(2);
    const inner = deferredRunner();
    const runner = live.observe(inner.runner);
    const ids = [
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
      '77777777-7777-4777-8777-777777777777',
    ] as Id[];
    for (const [index, runId] of ids.entries()) {
      runner.start(
        specFixture({ runId, taskId: `88888888-8888-4888-8888-00000000000${index}` as Id }),
      );
    }

    expect(live.size).toBe(2);
    expect(live.forRun(ids[0] as Id)).toBeNull();
    expect(live.forTask('88888888-8888-4888-8888-000000000000' as Id)).toBeNull();
    expect(live.forRun(ids[2] as Id)?.runId).toBe(ids[2]);
  });

  it('is bounded at 64× the runs BD-010’s default lets an organisation hold at once', () => {
    // The docblock's ratio, asserted rather than described (standing rule 39): the first version of
    // that sentence said "two orders of magnitude", and 256 is not 400.
    expect(MAX_LIVE_RUNS).toBe(4 * 64);
  });

  it('forgets a run on request, so a caller that ended one need not wait for its outcome', () => {
    const live = createLiveRuns();
    const inner = deferredRunner();
    live.observe(inner.runner).start(specFixture());

    live.forget(RUN);

    expect(live.forRun(RUN)).toBeNull();
    expect(live.forTask(TASK)).toBeNull();
  });
});
