/**
 * `RunStartHooks` for a test whose subject is not the CLI spawn marker (WP-150).
 *
 * Every shipped runner asks `beforeCliSpawn` before it starts a CLI and starts none when it answers
 * `false`, so a test that drives a runner directly has to answer it. This one answers `answer`
 * (default `true`, the marker written) and counts the asks, so a case can still assert that the
 * runner asked — once — or did not.
 */
import type { ContextPackRecord, Id, IsoDateTime } from '@platform/contracts';
import { type CommandContext, FIRST_STREAM_SEQ, type Run } from '@platform/domain';
import type { RunLeaseFence } from '../pipeline/store.js';
import type { RunStartHooks } from '../ports/runner.js';

export interface CountingStartHooks extends RunStartHooks {
  /** How many times the runner asked. */
  readonly asks: () => number;
  /** How many times the runner said the frame was withheld after a written marker (WP-163). */
  readonly withholds: () => number;
}

export const countingStartHooks = (answer: boolean | (() => Promise<boolean>) = true) => {
  let asked = 0;
  let withheld = 0;
  const hooks: CountingStartHooks = {
    beforeCliSpawn: async () => {
      asked += 1;
      return typeof answer === 'function' ? answer() : answer;
    },
    cliSpawnWithheld: () => {
      withheld += 1;
    },
    asks: () => asked,
    withholds: () => withheld,
  };
  return hooks;
};

/**
 * The deps `recordCliSpawn` takes since WP-275b, for a test whose run row was seeded rather than
 * created through transaction 1b: a claimed (`starting`) aggregate at the run stream's `sequence`
 * (default the first, an empty stream), an empty context pack, and the fence a seeded row with no
 * claim carries (`epoch 0`, no owner) unless the test passes the claim's.
 */
export const cliSpawnDepsForTest = (input: {
  readonly runId: Id;
  readonly taskId?: Id;
  readonly projectId?: Id;
  /** Accepted for symmetry with `recordCliSpawn`'s own `now`; the event is stamped in real time. */
  readonly now?: () => IsoDateTime;
  readonly sequence?: number;
  readonly fence?: RunLeaseFence;
}): {
  readonly run: Run;
  readonly contextPack: ContextPackRecord;
  readonly fence: RunLeaseFence;
  readonly context: CommandContext;
} => ({
  run: {
    id: input.runId,
    taskId: input.taskId ?? ('00000000-0000-4000-8000-00000000f0f1' as Id),
    projectId: input.projectId ?? ('00000000-0000-4000-8000-00000000f0f2' as Id),
    stage: null,
    role: 'developer',
    mode: 'normal',
    attempt: 1,
    model: 'claude-opus-5',
    effort: 'high',
    promptVersion: 'test@1',
    status: 'starting',
    startedAt: null,
    lastOutputAt: null,
    endedAt: null,
    terminalReason: null,
    sequence: input.sequence ?? FIRST_STREAM_SEQ,
  },
  contextPack: { tier0: [], tier1: [], budget_tokens: 1_000, total_tokens: 0, kb_commit: null },
  fence: input.fence ?? { epoch: 0, owner: null },
  context: {
    ids: { next: () => crypto.randomUUID() as Id },
    actor: { kind: 'system', component: 'test' },
    // The event's own instant: real time, because a database harness refuses an event stamped far
    // in the past, and the marker's instant (`input.now`) is the caller's to choose.
    clock: { now: () => new Date().toISOString() as IsoDateTime },
  },
});
