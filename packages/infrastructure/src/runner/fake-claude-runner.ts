/**
 * `FakeClaudeRunner` — the `ClaudeRunner` every later work package tests against.
 *
 * technical/10: "replays `test/fixtures/claude/<scenario>.jsonl` (our normalised `RunEvent`s incl. a
 * `result` with usage/cost/`structured_output`); scripted `ask_human`, tool policy prompts, budget
 * stops, stalls; used by application tests, the UI dev server and the e2e job."
 *
 * The fixtures it replays are the **golden output of the real adapter** (`test/fixtures/claude/`):
 * one file is both the assertion the SDK adapter is held to and the script this fake plays. A fake
 * whose script is a hand-written guess about what the SDK produces is a fake that drifts; this one
 * cannot drift without failing the adapter's own golden test in the same run.
 *
 * ## Divergence register — a fake may be stricter than the real adapter, never kinder
 *
 * Direction is from the point of view of a later WP: **stricter** = the fake refuses something
 * production allows, so a bug fails early; **kinder** = the fake allows something production
 * refuses, which is how a fake launders a defect into a pass.
 *
 * | # | Divergence | Direction | Justification |
 * |---|---|---|---|
 * | 1 | No scenario for a spec is an error; production would happily run any spec. | **stricter** | A missing fixture must not look like a run that did nothing. Asserted by `throws when no scenario matches the spec`. |
 * | 2 | Every scripted entry is parsed against `transcriptEventSchema` and a failure **throws**; the real adapter downgrades it to a `system` row and carries on. | **stricter** | The adapter's leniency exists so a normaliser bug cannot kill a live run. A fixture has no such excuse. Asserted by `throws on a scripted entry that is not a transcript event`. |
 * | 3 | A scenario claiming `completed` whose `structuredOutput` the artifact schema rejects **throws**; production returns `failed(schema)`. | **stricter** | This is the one that matters most: a fixture with a plausible-looking artifact that no real run could produce would make WP-15's pipeline tests green against an impossible world. Asserted by `refuses a completed scenario whose artifact does not validate`. |
 * | 4 | A scenario whose `assistant` entries run a `Bash` command the spec's own command policy **blocks** throws. | **stricter** | Same class, and the sharpest: the fake does not evaluate the policy during a run (see 6), so without this a fixture could show the agent running `sudo rm -rf /` and every downstream test would accept it. Asserted by `refuses a scenario whose Bash command the run’s policy blocks`. |
 * | 5 | A scenario whose reported cost exceeds `RunSpec.limits.maxBudgetUsd` without ending in `budget_exceeded` throws. | **stricter** | Keeps budget fixtures honest about the guard they are exercising. Asserted by `refuses an over-budget scenario that does not end in budget_exceeded`. |
 * | 5b | A scenario whose `cost.usd` is not a finite, non-negative number throws; production stops such a run as `cost_unreported` and reports a zero cost. | **stricter** | `NaN > budget` is `false`, so without this the fake would wave through the exact stream the adapter's watchdog was blind to until WP-12's review — a fake kinder than production in the one place the budget is decided. Asserted by `refuses a scenario whose cost is not a number`. |
 * | 6 | Hooks, `canUseTool` and the platform MCP tools are **not** executed. Scripted `hook` entries are replayed verbatim. | **different** | This fake stands in for the model *and* the SDK; the hooks are the adapter's own code and are driven by the real SDK in `claude-runner.test.ts` — `runs the command policy hook against the real SDK dispatch and allows `git status`` and `records the deny the command policy returned` are the two that watch a verdict travel through `query()` to the CLI and back. (The name this register carried until WP-12's review, `claude-runner.sdk.test.ts`, never existed: a justification is a claim about the suite, so it is checkable, and this one was false.) Divergence 4 is what stops the difference becoming a kindness. |
 * | 7 | `created_at` comes from the fixture, not from the injected clock; only `run_id` and `seq` are rewritten. | **different** | Replaying a golden transcript with its own timestamps is what makes two runs of the same fixture byte-identical, which is what a UI dev server and a snapshot test both want. The clock still governs pacing, stalls and the wall clock. |
 * | 8 | A scenario ends immediately unless it scripts `stepDelayMs`; a real run takes minutes. | **kinder** | The fake never makes a caller wait, so a caller that forgot to await would still pass here and hang in production. The **positive assertion** for it: `advances the injected clock by stepDelayMs per entry, and the stall detector fires on a scenario that stops emitting` — the fake reaches `stalled` through the same clock the adapter uses, so "time passes" is exercised rather than assumed. |
 *
 * Entry 8 is the kindest and carries a positive assertion rather than a warning, per the standing
 * rule; entry 6 is neutralised by entry 4 rather than merely documented.
 */
import type {
  ClaudeRunner,
  RunHandle,
  RunnerClock,
  RunOutcome,
  RunSpec,
  RunStopReason,
  RunTranscriptSink,
  SteerMessage,
  TerminalRunStatus,
} from '@platform/application';
import { runSpecSchema } from '@platform/application';
import type {
  ModelUsage,
  RunCost,
  RunTerminalReason,
  TokenUsage,
  TranscriptEvent,
} from '@platform/contracts';
import { transcriptEventSchema } from '@platform/contracts';
import { evaluateCommand } from '@platform/domain';
import { deferred } from './async-queue.js';
import { validateStructuredOutput } from './structured-output.js';

export interface FakeRunScenario {
  /** Normalised entries, in order. `run_id` and `seq` are rewritten; everything else is replayed. */
  readonly events: readonly TranscriptEvent[];
  readonly status: TerminalRunStatus;
  readonly terminalReason: RunTerminalReason;
  readonly numTurns: number;
  readonly usage: TokenUsage;
  readonly modelUsage: readonly ModelUsage[];
  readonly cost: RunCost;
  readonly structuredOutput: unknown;
  readonly error: string | null;
  /** Clock milliseconds between entries. Zero (the default) makes the run instantaneous. */
  readonly stepDelayMs?: number;
  /**
   * Stop emitting after this many entries and let the platform's stall detector end the run — the
   * scripted form of "the CLI hung". The scenario's `status` must then be `stalled`.
   */
  readonly stallAfter?: number;
}

export class FakeScenarioError extends Error {
  constructor(message: string) {
    super(`fake claude runner: ${message}`);
    this.name = 'FakeScenarioError';
  }
}

export interface FakeClaudeRunnerOptions {
  readonly sink: RunTranscriptSink;
  readonly clock: RunnerClock;
  /** Chooses the scenario for a spec. Throw {@link FakeScenarioError} when none matches. */
  readonly select: (spec: RunSpec) => FakeRunScenario;
}

/** `select` for the common case: one scenario per stage slug. */
export const scenarioByStage =
  (scenarios: Readonly<Record<string, FakeRunScenario>>) =>
  (spec: RunSpec): FakeRunScenario => {
    const scenario = spec.stage === null ? undefined : scenarios[spec.stage];
    if (scenario === undefined) {
      throw new FakeScenarioError(
        `no scenario for stage "${spec.stage ?? '(none)'}"; known: ${Object.keys(scenarios).join(', ') || '(none)'}`,
      );
    }
    return scenario;
  };

/** Divergence 4: the scripted agent may not run a command the run's own policy blocks. */
const assertCommandsAllowed = (spec: RunSpec, scenario: FakeRunScenario): void => {
  for (const event of scenario.events) {
    if (event.kind !== 'assistant') {
      continue;
    }
    for (const block of event.content) {
      if (block.type !== 'tool_use' || block.tool_name !== 'Bash') {
        continue;
      }
      const command = (block.input as { command?: unknown }).command;
      if (typeof command !== 'string') {
        continue;
      }
      const verdict = evaluateCommand({ command }, spec.commandPolicy).verdict;
      if (verdict === 'block') {
        throw new FakeScenarioError(
          `the scenario runs "${command}", which this run's command policy blocks (BD-025). ` +
            'A fixture may not show an agent doing something production would refuse.',
        );
      }
    }
  }
};

const assertScenarioIsPossible = (spec: RunSpec, scenario: FakeRunScenario): void => {
  if (scenario.status === 'completed') {
    const validated = validateStructuredOutput(spec.artifactType, scenario.structuredOutput);
    if (!validated.ok) {
      throw new FakeScenarioError(
        `the scenario completes with structured output the ${spec.artifactType ?? '(none)'} ` +
          `schema rejects: ${validated.issues.join('; ')}`,
      );
    }
  }
  // The adapter stops a run whose result reports no usable cost (`cost_unreported`). A scenario
  // that hands the fake a `NaN` — which `>` below silently answers `false` for, exactly as the
  // adapter's watchdog did before its review — would be the fake being *kinder* than production,
  // which is the one direction a fake may never take (standing rule 1). A fixture has a cost.
  if (!Number.isFinite(scenario.cost.usd) || scenario.cost.usd < 0) {
    throw new FakeScenarioError(
      `the scenario reports ${String(scenario.cost.usd)} as its cost; a run the platform accepts ` +
        'has a finite, non-negative one (the adapter stops the others as `cost_unreported`)',
    );
  }
  if (scenario.cost.usd > spec.limits.maxBudgetUsd && scenario.status !== 'budget_exceeded') {
    throw new FakeScenarioError(
      `the scenario spends ${scenario.cost.usd} against a budget of ${spec.limits.maxBudgetUsd} ` +
        `but ends in "${scenario.status}" rather than "budget_exceeded"`,
    );
  }
  if (scenario.stallAfter !== undefined && scenario.status !== 'stalled') {
    throw new FakeScenarioError(
      `the scenario stalls after ${scenario.stallAfter} entries but ends in "${scenario.status}"`,
    );
  }
  assertCommandsAllowed(spec, scenario);
};

export const createFakeClaudeRunner = (options: FakeClaudeRunnerOptions): ClaudeRunner => ({
  start: (rawSpec: RunSpec): RunHandle => {
    const spec = runSpecSchema.parse(rawSpec);
    const scenario = options.select(spec);
    assertScenarioIsPossible(spec, scenario);

    const startedAt = options.clock.now();
    const stopped = deferred<RunStopReason | 'stalled'>();
    let seq = 0;
    let redactionCount = 0;

    const emit = async (event: TranscriptEvent): Promise<void> => {
      const parsed = transcriptEventSchema.safeParse({
        ...event,
        run_id: spec.runId,
        seq,
      });
      if (!parsed.success) {
        throw new FakeScenarioError(
          `entry ${seq} is not a transcript event: ` +
            parsed.error.issues
              .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
              .join('; '),
        );
      }
      seq += 1;
      redactionCount += parsed.data.redaction_count;
      await options.sink.append(parsed.data);
    };

    const outcomeOf = (
      status: TerminalRunStatus,
      terminalReason: RunTerminalReason,
      error: string | null,
      structuredOutput: unknown,
    ): RunOutcome => ({
      runId: spec.runId,
      status,
      terminalReason,
      sessionId: `fake-session-${spec.runId}`,
      numTurns: scenario.numTurns,
      usage: scenario.usage,
      modelUsage: scenario.modelUsage,
      cost: scenario.cost,
      wallMs: Math.max(0, options.clock.now() - startedAt),
      structuredOutput: structuredOutput as RunOutcome['structuredOutput'],
      error,
      redactionCount,
    });

    /**
     * Emits the script, racing it against whatever stops the run.
     *
     * `state.interrupted` is a field rather than a local because it is written from a callback:
     * TypeScript narrows a `let` initialised to `null` and would then insist the later comparison
     * is always false, which is the sort of "simplification" that removes a break condition.
     */
    const play = async (): Promise<RunOutcome> => {
      const state: { interrupted: RunStopReason | 'stalled' | null } = { interrupted: null };
      stopped.promise.then(
        (reason) => {
          state.interrupted ??= reason;
        },
        () => undefined,
      );

      const limit = scenario.stallAfter ?? scenario.events.length;
      // A holder rather than a `let`, for the same reason as `state` above: the assignment happens
      // inside `armStall`, and TypeScript would otherwise narrow the variable to `null` for ever.
      const stall: { cancel: (() => void) | null } = { cancel: null };
      const armStall = (): void => {
        stall.cancel?.();
        stall.cancel = options.clock.setTimer(spec.limits.stallTimeoutMs, () =>
          stopped.resolve('stalled'),
        );
      };
      armStall();

      for (const [index, event] of scenario.events.entries()) {
        if (index >= limit || state.interrupted !== null) {
          break;
        }
        const delayMs = scenario.stepDelayMs ?? 0;
        if (delayMs > 0) {
          // Raced against the stop, not merely awaited. A scripted delay that only the clock can
          // release would make `stop()` unhonourable: the caller would wait for a timer the test
          // (or the platform) has no reason to advance, which is the fake hanging rather than the
          // run being cancelled.
          await Promise.race([
            new Promise<void>((resolve) => {
              options.clock.setTimer(delayMs, resolve);
            }),
            stopped.promise.then(() => undefined),
          ]);
        }
        if (state.interrupted !== null) {
          break;
        }
        await emit(event);
        armStall();
      }

      if (scenario.stallAfter !== undefined || state.interrupted !== null) {
        const reason = state.interrupted ?? (await stopped.promise);
        stall.cancel?.();
        return reason === 'stalled'
          ? outcomeOf(
              'stalled',
              'stalled',
              'the run produced no output before the stall timeout',
              null,
            )
          : outcomeOf('cancelled', 'cancelled', `the platform stopped the run: ${reason}`, null);
      }

      stall.cancel?.();
      return outcomeOf(
        scenario.status,
        scenario.terminalReason,
        scenario.error,
        scenario.status === 'completed' ? scenario.structuredOutput : null,
      );
    };

    const outcome = play();
    outcome.catch(() => undefined);

    return {
      runId: spec.runId,
      outcome,
      steer: async (message: SteerMessage) => {
        await emit({
          run_id: spec.runId,
          seq,
          created_at: new Date(options.clock.now()).toISOString(),
          kind: 'steer',
          redaction_count: 0,
          parent_tool_use_id: null,
          message: message.text,
          author_user_id: message.authorUserId,
        });
      },
      stop: async (reason: RunStopReason) => {
        stopped.resolve(reason);
        await outcome.catch(() => undefined);
      },
    };
  },
});
