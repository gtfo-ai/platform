/**
 * `FakeClaudeRunner`, and every strictness its divergence register claims.
 *
 * The scenarios are loaded from the **golden transcripts the SDK adapter produced**
 * (`test/fixtures/claude/*.transcript.json`), so this file also proves the two halves fit: what the
 * real adapter emits is exactly what the fake replays.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RunOutcome, RunSpec } from '@platform/application';
import type { TranscriptEvent } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { manualClock } from './clock.js';
import {
  createFakeClaudeRunner,
  type FakeRunScenario,
  FakeScenarioError,
  scenarioByStage,
} from './fake-claude-runner.js';
import { FIXTURE_CLOCK_START, recordingSink, runSpecFixture } from './fixtures.js';

const FIXTURE_DIR = path.join(process.cwd(), 'test/fixtures/claude');

const golden = (name: string): { outcome: RunOutcome; events: TranscriptEvent[] } =>
  JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${name}.transcript.json`), 'utf8')) as {
    outcome: RunOutcome;
    events: TranscriptEvent[];
  };

/** A golden transcript, replayable by the fake. */
const scenarioOf = (name: string, extra: Partial<FakeRunScenario> = {}): FakeRunScenario => {
  const { outcome, events } = golden(name);
  return {
    events,
    status: outcome.status,
    terminalReason: outcome.terminalReason,
    numTurns: outcome.numTurns,
    usage: outcome.usage,
    modelUsage: outcome.modelUsage,
    cost: outcome.cost,
    structuredOutput: outcome.structuredOutput,
    error: outcome.error,
    ...extra,
  };
};

const runFake = async (
  scenario: FakeRunScenario,
  spec: Partial<RunSpec> = {},
): Promise<{ outcome: RunOutcome; events: readonly TranscriptEvent[] }> => {
  const sink = recordingSink();
  const runner = createFakeClaudeRunner({
    sink,
    clock: manualClock(FIXTURE_CLOCK_START),
    select: () => scenario,
  });
  const outcome = await runner.start(runSpecFixture(spec)).outcome;
  return { outcome, events: sink.events };
};

describe('replaying a golden transcript', () => {
  it('emits every entry, re-sequenced under the run’s own id', async () => {
    const expected = golden('happy-path');
    const { outcome, events } = await runFake(scenarioOf('happy-path'));
    expect(events).toHaveLength(expected.events.length);
    expect(events.map((event) => event.kind)).toEqual(expected.events.map((event) => event.kind));
    expect(events.map((event) => event.seq)).toEqual(expected.events.map((_, index) => index));
    expect(new Set(events.map((event) => event.run_id))).toEqual(new Set([runSpecFixture().runId]));
    expect(outcome.status).toBe('completed');
    expect(outcome.structuredOutput).toMatchObject({ confidence: 'high' });
    expect(outcome.redactionCount).toBe(expected.outcome.redactionCount);
  });

  it('reproduces a failing scenario’s outcome verbatim', async () => {
    const { outcome } = await runFake(scenarioOf('budget-exceeded-cli'));
    expect(outcome.status).toBe('budget_exceeded');
    expect(outcome.terminalReason).toBe('error_max_budget_usd');
    expect(outcome.structuredOutput).toBeNull();
  });

  it('records a steer as a transcript entry', async () => {
    const sink = recordingSink();
    const runner = createFakeClaudeRunner({
      sink,
      clock: manualClock(FIXTURE_CLOCK_START),
      select: () => scenarioOf('happy-path'),
    });
    const handle = runner.start(runSpecFixture());
    await handle.outcome;
    await handle.steer({
      text: 'try the other branch',
      authorUserId: '44444444-4444-4444-8444-444444444444',
      authorLabel: 'Jan',
    });
    expect(sink.events.at(-1)).toMatchObject({ kind: 'steer', message: 'try the other branch' });
  });
});

describe('scenarioByStage', () => {
  it('picks by stage slug', async () => {
    const select = scenarioByStage({ implementation: scenarioOf('happy-path') });
    expect(select(runSpecFixture()).status).toBe('completed');
  });

  /** Divergence 1. */
  it('throws when no scenario matches the spec', () => {
    const select = scenarioByStage({ refinement: scenarioOf('happy-path') });
    expect(() => select(runSpecFixture({ stage: 'code_review' }))).toThrow(
      /no scenario for stage "code_review"/,
    );
  });
});

describe('the strictnesses the divergence register claims', () => {
  /** Divergence 2. */
  it('throws on a scripted entry that is not a transcript event', async () => {
    const scenario = scenarioOf('happy-path');
    const broken: FakeRunScenario = {
      ...scenario,
      events: [{ ...scenario.events[0], kind: 'not-a-kind' } as unknown as TranscriptEvent],
    };
    await expect(runFake(broken)).rejects.toThrow(FakeScenarioError);
  });

  /** Divergence 3. */
  it('refuses a completed scenario whose artifact does not validate', async () => {
    const scenario = scenarioOf('happy-path', {
      structuredOutput: { root_cause: 'only half an artifact' },
    });
    await expect(runFake(scenario)).rejects.toThrow(
      /completes with structured output the RootCauseAnalysis schema rejects/,
    );
  });

  /** Divergence 4 — the one that neutralises divergence 6. */
  it('refuses a scenario whose Bash command the run’s policy blocks', async () => {
    const scenario = scenarioOf('happy-path');
    const withBlockedCommand: FakeRunScenario = {
      ...scenario,
      events: scenario.events.map((event) =>
        event.kind === 'assistant'
          ? {
              ...event,
              content: [
                {
                  type: 'tool_use',
                  tool_use_id: 'toolu_x',
                  tool_name: 'Bash',
                  input: { command: 'sudo rm -rf /var' },
                },
              ],
            }
          : event,
      ) as TranscriptEvent[],
    };
    await expect(runFake(withBlockedCommand)).rejects.toThrow(
      /which this run's command policy blocks/,
    );
  });

  it('accepts a scenario whose Bash command the policy merely asks about', async () => {
    // The other branch, so the guard is not simply "no Bash allowed".
    const scenario = scenarioOf('happy-path');
    const withAskCommand: FakeRunScenario = {
      ...scenario,
      events: scenario.events.map((event) =>
        event.kind === 'assistant'
          ? {
              ...event,
              content: [
                {
                  type: 'tool_use',
                  tool_use_id: 'toolu_x',
                  tool_name: 'Bash',
                  input: { command: 'terraform plan' },
                },
              ],
            }
          : event,
      ) as TranscriptEvent[],
    };
    await expect(runFake(withAskCommand)).resolves.toMatchObject({
      outcome: { status: 'completed' },
    });
  });

  /** Divergence 5. */
  it('refuses an over-budget scenario that does not end in budget_exceeded', async () => {
    const scenario = scenarioOf('happy-path', {
      cost: { usd: 99, is_estimate: false, price_list_id: null },
    });
    await expect(runFake(scenario)).rejects.toThrow(/rather than "budget_exceeded"/);
  });

  /**
   * Divergence 5b. The JavaScript caller is the one that matters: `RunCost.usd` is a `number` in
   * the type system and `NaN` is a `number`, so nothing but this check stands between a fixture
   * with no cost and a green pipeline test (standing rules 1 and 14).
   */
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -1],
  ])('refuses a scenario whose cost is not a number (%s)', async (_label, usd) => {
    const scenario = scenarioOf('happy-path', {
      cost: { usd: usd as number, is_estimate: false, price_list_id: null },
    });
    await expect(runFake(scenario)).rejects.toThrow(/as its cost; a run the platform accepts/);
  });

  it('refuses a scenario that stalls but does not say so in its status', async () => {
    await expect(runFake(scenarioOf('happy-path', { stallAfter: 1 }))).rejects.toThrow(
      /stalls after 1 entries but ends in "completed"/,
    );
  });
});

describe('the kindest divergence (8) and its positive assertion', () => {
  it('advances the injected clock by stepDelayMs per entry, and the stall detector fires on a scenario that stops emitting', async () => {
    const clock = manualClock(FIXTURE_CLOCK_START);
    const sink = recordingSink();
    const stallScenario: FakeRunScenario = {
      ...scenarioOf('happy-path'),
      status: 'stalled',
      terminalReason: 'stalled',
      stepDelayMs: 1_000,
      stallAfter: 2,
    };
    const runner = createFakeClaudeRunner({ sink, clock, select: () => stallScenario });
    const handle = runner.start(
      runSpecFixture({ limits: { ...runSpecFixture().limits, stallTimeoutMs: 120_000 } }),
    );

    // Two entries, each behind a 1 s delay on the injected clock: time has to pass for them to
    // arrive at all, which is what makes this a test of the pacing rather than of an instant replay.
    for (let step = 0; step < 2; step += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      clock.advance(1_000);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sink.events).toHaveLength(2);

    clock.advance(119_999);
    let settled = false;
    void handle.outcome.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled, 'the run must not end before the stall timeout').toBe(false);

    clock.advance(1);
    const outcome = await handle.outcome;
    expect(outcome.status).toBe('stalled');
    expect(outcome.wallMs).toBe(122_000);
  });
});

describe('stopping', () => {
  it('reports a cancellation rather than the scripted outcome', async () => {
    const clock = manualClock(FIXTURE_CLOCK_START);
    const sink = recordingSink();
    const runner = createFakeClaudeRunner({
      sink,
      clock,
      select: () => ({ ...scenarioOf('happy-path'), stepDelayMs: 1_000 }),
    });
    const handle = runner.start(runSpecFixture());
    await handle.stop('cancelled');
    const outcome = await handle.outcome;
    expect(outcome.status).toBe('cancelled');
    expect(outcome.terminalReason).toBe('cancelled');
  });
});
