/**
 * The SDK adapter, driven by the **real** `query()` over the fake transport.
 *
 * Nothing between the fixture and the assertion is stubbed except the model: the fixtures in
 * `test/fixtures/claude/*.script.jsonl` are replayed by `fakeSpawnClaudeCodeProcess`, the Agent
 * SDK parses them, dispatches the hooks and `canUseTool` for real, and the adapter normalises the
 * result. TD-007 asks for golden fixtures around the normaliser "because SDK message types
 * evolve"; `*.transcript.json` is that golden, regenerated with `UPDATE_CLAUDE_FIXTURES=1`.
 *
 * A golden file on its own certifies nothing — it is the code's own output. Every scenario
 * therefore also carries **named assertions about its content**, which is what would fail if the
 * behaviour changed and the golden were regenerated without thinking.
 *
 * No test in this file waits on the wall clock. The stall and budget guards are reached by
 * advancing {@link manualClock}, so they take microseconds on a two-core runner.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunOutcome, RunSpec, ToolApprovalDecision } from '@platform/application';
import type { TranscriptEvent } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { type ClaudeRunnerDependencies, createClaudeRunner } from './claude-runner.js';
import { manualClock } from './clock.js';
import { type FakeCli, type FakeCliScript, fakeSpawnClaudeCodeProcess } from './fake-spawn.js';
import {
  FIXTURE_CLOCK_START,
  FIXTURE_INJECTED_SECRET,
  injectedSecretRedactorFixture,
  recordingSink,
  recordingTools,
  runSpecFixture,
  scriptedApprovals,
} from './fixtures.js';

const FIXTURE_DIR = path.join(process.cwd(), 'test/fixtures/claude');
const UPDATE = process.env['UPDATE_CLAUDE_FIXTURES'] === '1';

export interface GoldenTranscript {
  readonly outcome: RunOutcome;
  readonly events: readonly TranscriptEvent[];
}

const loadScript = (name: string): FakeCliScript =>
  readFileSync(path.join(FIXTURE_DIR, `${name}.script.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FakeCliScript[number]);

const goldenPath = (name: string): string => path.join(FIXTURE_DIR, `${name}.transcript.json`);

/**
 * Compares against the golden, or writes it under `UPDATE_CLAUDE_FIXTURES=1`.
 *
 * A missing golden is a failure rather than an implicit write: a scenario that silently records
 * whatever the code did on its first run is a scenario nobody ever read.
 */
const assertGolden = (name: string, actual: GoldenTranscript): void => {
  const file = goldenPath(name);
  if (UPDATE) {
    writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  expect(existsSync(file), `${file} is missing; regenerate with UPDATE_CLAUDE_FIXTURES=1`).toBe(
    true,
  );
  expect(actual).toEqual(JSON.parse(readFileSync(file, 'utf8')) as GoldenTranscript);
};

interface Harness {
  readonly cli: FakeCli;
  readonly clock: ReturnType<typeof manualClock>;
  readonly events: readonly TranscriptEvent[];
  readonly outcome: Promise<RunOutcome>;
  readonly handle: ReturnType<ReturnType<typeof createClaudeRunner>['start']>;
}

type StartOptions = {
  spec?: Partial<RunSpec>;
  approval?: ToolApprovalDecision | 'never-answers';
  deps?: Partial<ClaudeRunnerDependencies>;
};

/**
 * The same harness over a script the test built rather than a named fixture.
 *
 * Used where the point *is* a stream no honest CLI produces: `total_cost_usd` deleted, a `system`
 * row that fails its own schema. Those cannot be golden fixtures — a golden is a recording of what
 * the platform accepts — but they are exactly what WP-13's shim, sitting between the CLI and this
 * adapter, is able to deliver.
 */
const startScript = (script: FakeCliScript, options: StartOptions = {}): Harness => {
  const sink = recordingSink();
  const clock = manualClock(FIXTURE_CLOCK_START);
  const cli = fakeSpawnClaudeCodeProcess(script);
  const runner = createClaudeRunner({
    sink,
    approvals: scriptedApprovals(options.approval),
    tools: recordingTools(),
    clock,
    injectedSecretRedactorFor: () => injectedSecretRedactorFixture(),
    spawnClaudeCodeProcess: cli.spawn,
    ...options.deps,
  });
  const handle = runner.start(runSpecFixture(options.spec));
  return { cli, clock, events: sink.events, outcome: handle.outcome, handle };
};

const start = (
  name: string,
  options: {
    spec?: Partial<RunSpec>;
    approval?: ToolApprovalDecision | 'never-answers';
    deps?: Partial<ClaudeRunnerDependencies>;
  } = {},
): Harness => {
  const sink = recordingSink();
  const clock = manualClock(FIXTURE_CLOCK_START);
  const cli = fakeSpawnClaudeCodeProcess(loadScript(name));
  const runner = createClaudeRunner({
    sink,
    approvals: scriptedApprovals(options.approval),
    tools: recordingTools(),
    clock,
    injectedSecretRedactorFor: () => injectedSecretRedactorFixture(),
    spawnClaudeCodeProcess: cli.spawn,
    ...options.deps,
  });
  const handle = runner.start(runSpecFixture(options.spec));
  return { cli, clock, events: sink.events, outcome: handle.outcome, handle };
};

const run = async (
  name: string,
  options: Parameters<typeof start>[1] = {},
): Promise<Harness & { readonly result: RunOutcome }> => {
  const harness = start(name, options);
  const result = await harness.outcome;
  assertGolden(name, { outcome: result, events: harness.events });
  return { ...harness, result };
};

const kinds = (events: readonly TranscriptEvent[]): string[] => events.map((event) => event.kind);

describe('happy path', () => {
  it('completes, validates the artifact and reports the cost', async () => {
    const { result, events } = await run('happy-path');
    expect(result.status).toBe('completed');
    expect(result.terminalReason).toBe('success');
    expect(result.sessionId).toBe('fake-session-0001');
    expect(result.numTurns).toBe(4);
    expect(result.cost).toEqual({ usd: 0.42, is_estimate: false, price_list_id: null });
    expect(result.usage).toEqual({
      input_tokens: 12_000,
      output_tokens: 900,
      cache_write_5m_tokens: 2_000,
      cache_write_1h_tokens: 1_000,
      cache_read_tokens: 8_000,
    });
    expect(result.modelUsage).toEqual([
      {
        model: 'claude-opus-5',
        input_tokens: 12_000,
        output_tokens: 900,
        cache_write_5m_tokens: 2_000,
        cache_write_1h_tokens: 1_000,
        cache_read_tokens: 8_000,
        usd: 0.42,
      },
    ]);
    expect(result.structuredOutput).toMatchObject({ confidence: 'high' });
    expect(result.error).toBeNull();

    // Positive, not "at least one": every entry the scenario produces, in order.
    //
    // The `hook` row sits second, ahead of entries the CLI wrote to stdout *before* the hook fired.
    // That is the SDK's own dispatch order, not a bug in the adapter: control requests are handled
    // as they are read, while ordinary messages queue for the iterator, so a hook callback overtakes
    // messages the platform has not consumed yet. Pinned here because it is the sort of thing a
    // later reader would "fix" into the wrong order.
    expect(kinds(events)).toEqual([
      'system',
      'hook',
      'stream_block',
      'assistant',
      'user',
      'assistant',
      'result',
    ]);
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('coalesces the partial deltas into one `stream_block` and stores no delta of its own', async () => {
    const { events } = await run('happy-path');
    const blocks = events.filter((event) => event.kind === 'stream_block');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      block_index: 0,
      block: { type: 'text', text: 'Reading the login test now.' },
    });
  });

  it('runs the command policy hook against the real SDK dispatch and allows `git status`', async () => {
    const { cli } = await run('happy-path');
    const hook = cli.callbacks.find((callback) => callback.event === 'PreToolUse');
    expect(hook?.response).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'allow' },
    });
  });

  it('spawns the CLI with the platform environment and no inherited variables', async () => {
    const { cli } = await run('happy-path');
    expect(cli.spawnOptions?.env?.['DISABLE_AUTOUPDATER']).toBe('1');
    expect(cli.spawnOptions?.env?.['CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH']).toBe('1');
    expect(cli.spawnOptions?.args).toContain('--include-partial-messages');
    expect(cli.spawnOptions?.args).toContain('--strict-mcp-config');
  });

  /**
   * Asserted on the **argv the SDK built**, not on the options table: `managedSettings` closes the
   * second `canUseTool` shadow — the workspace's own `.claude/settings.json` — and it only does so
   * if it reaches the CLI. `options.test.ts` proves the mapping; this proves the delivery.
   */
  it('hands the CLI a managed policy tier, so project settings cannot add allow rules or hooks', async () => {
    const { cli } = await run('happy-path');
    const args = cli.spawnOptions?.args ?? [];
    const flag = args.indexOf('--managed-settings');
    expect(flag).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(args[flag + 1] ?? '{}')).toEqual({
      allowManagedPermissionRulesOnly: true,
      allowManagedHooksOnly: true,
    });
  });
});

describe('budget', () => {
  it('maps the CLI’s own `error_max_budget_usd` onto `budget_exceeded`', async () => {
    const { result } = await run('budget-exceeded-cli');
    expect(result.status).toBe('budget_exceeded');
    expect(result.terminalReason).toBe('error_max_budget_usd');
    expect(result.structuredOutput).toBeNull();
  });

  /**
   * The second, independent path: the CLI reported a *success* whose cost is past the ceiling it
   * was given. Reverting the watchdog makes this scenario return `completed`, which is what the
   * first assertion below names.
   */
  it('stops the run itself when the reported cost passes the ceiling the CLI ignored', async () => {
    const { result, events } = await run('budget-exceeded-watchdog', {
      spec: { limits: { ...runSpecFixture().limits, maxBudgetUsd: 10 } },
    });
    expect(result.status).toBe('budget_exceeded');
    expect(result.terminalReason).toBe('error_max_budget_usd');
    expect(result.error).toContain('budget_exceeded');
    expect(events.at(-1)).toMatchObject({
      kind: 'system',
      subtype: 'run_stopped',
      data: { reason: 'budget_exceeded' },
    });
  });
});

describe('the budget watchdog and an unreported cost', () => {
  /**
   * The SDK types declare `total_cost_usd` as a plain `number` and pass it through **unvalidated**,
   * so the producer decides what arrives — and from WP-13 the producer is `agentic-runlet`, not the
   * CLI. Each of these used to return `status: completed`, `terminalReason: success` and
   * `cost.usd: NaN` with the watchdog silent, because `NaN > 0.01` is `false`.
   */
  const resultWith = (cost: unknown): FakeCliScript => {
    const script = loadScript('happy-path');
    return script.map((step) => {
      if (step.step !== 'emit' || step.message['type'] !== 'result') {
        return step;
      }
      const { total_cost_usd: _dropped, ...rest } = step.message;
      return {
        ...step,
        message: cost === undefined ? rest : { ...rest, total_cost_usd: cost },
      };
    });
  };

  it.each([
    ['absent', undefined],
    ['null', null],
    ['a string', '0.42'],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -1],
  ])('fails closed when the reported cost is %s', async (_label, cost) => {
    const harness = startScript(resultWith(cost), {
      spec: { limits: { ...runSpecFixture().limits, maxBudgetUsd: 0.01 } },
    });
    const result = await harness.outcome;
    expect(result.status).toBe('budget_exceeded');
    expect(result.terminalReason).toBe('error_max_budget_usd');
    expect(result.error).toContain('cost_unreported');
    expect(result.cost.usd).toBe(0);
    expect(Number.isFinite(result.cost.usd)).toBe(true);
    expect(result.structuredOutput).toBeNull();
    expect(harness.events.at(-1)).toMatchObject({
      kind: 'system',
      subtype: 'run_stopped',
      data: { reason: 'cost_unreported' },
    });
  });

  it('still writes the `result` row the pipeline reads, rather than a normalisation failure', async () => {
    const harness = startScript(resultWith(undefined));
    await harness.outcome;
    const rows = harness.events.filter((event) => event.kind === 'result');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cost: { usd: 0, is_estimate: false } });
    expect(
      harness.events.filter(
        (event) => event.kind === 'system' && event.subtype === 'transcript_normalisation_failed',
      ),
    ).toHaveLength(0);
  });

  it('accepts a reported zero, which is a measurement and not a missing one', async () => {
    const harness = startScript(resultWith(0));
    const result = await harness.outcome;
    expect(result.status).toBe('completed');
    expect(result.terminalReason).toBe('success');
    expect(result.cost.usd).toBe(0);
  });
});

/**
 * The other number the `result` line carries. It reaches `RunOutcome.numTurns`, a `number`, and
 * `num_turns` is as unvalidated as `total_cost_usd` was: deleting it put `undefined` there and a
 * `"7"` off the JSON wire put a string there. Standing rule 16 is not only about the budget.
 */
describe('the turn count comes from the same untrusted line', () => {
  const resultWithTurns = (turns: unknown): FakeCliScript => {
    const script = loadScript('happy-path');
    return script.map((step) => {
      if (step.step !== 'emit' || step.message['type'] !== 'result') {
        return step;
      }
      const { num_turns: _dropped, ...rest } = step.message;
      return {
        ...step,
        message: turns === undefined ? rest : { ...rest, num_turns: turns },
      };
    });
  };

  // `NaN` and `Infinity` are deliberately **not** in this table: `JSON.stringify` turns both into
  // `null` on the NDJSON wire, so driving them through the fake CLI would only re-test `null` and
  // would read as coverage it is not. They are asserted against `reportedCount` directly, in
  // `transcript-normaliser.test.ts`.
  it.each([
    ['absent', undefined],
    ['null', null],
    ['a string', '7'],
    ['negative', -3],
  ])('reads an unusable num_turns of %s as zero, still a number', async (_label, turns) => {
    const harness = startScript(resultWithTurns(turns));
    const result = await harness.outcome;
    expect(result.numTurns).toBe(0);
    expect(typeof result.numTurns).toBe('number');
    // The run itself is unaffected: an unreadable turn count is not a reason to stop, unlike an
    // unreadable cost — nothing is being verified against it.
    expect(result.status).toBe('completed');
  });

  it('truncates a fractional count rather than carrying it into an integer column', async () => {
    const result = await startScript(resultWithTurns(4.7)).outcome;
    expect(result.numTurns).toBe(4);
  });

  it('carries a well-formed count through, and the transcript row agrees with the outcome', async () => {
    const harness = startScript(resultWithTurns(3));
    const result = await harness.outcome;
    expect(result.numTurns).toBe(3);
    expect(harness.events.filter((event) => event.kind === 'result')).toMatchObject([
      { num_turns: 3 },
    ]);
  });

  /**
   * The stopped branch builds its outcome from a *different* line of code, and `?? 0` there is not
   * the same guard: it catches an absent count and passes a `"7"` straight through. So this drives
   * the string, not the absence.
   */
  it('reads the turn count the same way when the platform stopped the run', async () => {
    const script = resultWithTurns('7').map((step) =>
      step.step === 'emit' && step.message['type'] === 'result'
        ? { ...step, message: { ...step.message, total_cost_usd: 999 } }
        : step,
    );
    const result = await startScript(script, {
      spec: { limits: { ...runSpecFixture().limits, maxBudgetUsd: 0.01 } },
    }).outcome;
    expect(result.status).toBe('budget_exceeded');
    expect(result.numTurns).toBe(0);
    expect(typeof result.numTurns).toBe('number');
  });
});

describe('failures', () => {
  it('reports a CLI that exits without a result as a crash', async () => {
    const { result } = await run('crash');
    expect(result.status).toBe('failed');
    expect(result.terminalReason).toBe('crash');
    expect(result.error).not.toBeNull();
  });

  it('reports a denied tool as `permission_denied`', async () => {
    const { result, cli } = await run('permission-denied', {
      approval: { decision: 'deny', reason: 'publishing is a human decision', questionId: null },
    });
    expect(result.status).toBe('failed');
    expect(result.terminalReason).toBe('permission_denied');
    expect(cli.callbacks.at(-1)?.response).toMatchObject({ behavior: 'deny' });
  });

  it('rejects a result with no structured output at all', async () => {
    const { result } = await run('missing-structured-output');
    expect(result.status).toBe('failed');
    expect(result.terminalReason).toBe('error_max_structured_output_retries');
    expect(result.error).toContain('produced no structured output');
  });

  it('rejects structured output the artifact schema refuses, naming the paths', async () => {
    const { result } = await run('invalid-structured-output');
    expect(result.status).toBe('failed');
    expect(result.terminalReason).toBe('error_max_structured_output_retries');
    expect(result.error).toContain('confidence');
    expect(result.error).toContain('extra_field');
  });
});

describe('compaction and subagents', () => {
  it('writes one marker per phase, with the token counts on the `post` one', async () => {
    const { events } = await run('compaction');
    const compactions = events.filter((event) => event.kind === 'compaction');
    expect(compactions).toHaveLength(2);
    expect(compactions[0]).toMatchObject({ phase: 'pre', pre_tokens: null });
    expect(compactions[1]).toMatchObject({
      phase: 'post',
      pre_tokens: 148_000,
      post_tokens: 21_000,
    });
    expect(events.filter((event) => event.kind === 'hook').map((event) => event.kind)).toEqual([
      'hook',
    ]);
  });

  it('nests a subagent’s messages under its parent tool use', async () => {
    const { events } = await run('subagent');
    const assistants = events.filter((event) => event.kind === 'assistant');
    expect(assistants.map((event) => event.parent_tool_use_id)).toEqual(['toolu_parent', null]);
    const hooks = events.filter((event) => event.kind === 'hook');
    expect(hooks.map((event) => (event as { hook: string }).hook)).toEqual([
      'SubagentStart',
      'SubagentStop',
    ]);
  });
});

describe('the command policy through the SDK', () => {
  /** The assertion `fake-spawn.ts` divergence 4 points at. */
  it('records the deny the command policy returned', async () => {
    const { cli, events } = await run('denied-tool');
    const hook = cli.callbacks.find((callback) => callback.event === 'PreToolUse');
    expect(hook?.response).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('command policy: block'),
      },
    });
    const recorded = events.find((event) => event.kind === 'hook');
    expect(recorded).toMatchObject({ decision: 'deny', tool_name: 'Bash' });
  });
});

describe('redaction on the way to the transcript (TD-012)', () => {
  it('leaves no injected secret and no credential shape anywhere in the transcript', async () => {
    const { events, result } = await run('redaction');
    const rendered = JSON.stringify(events);
    expect(rendered).not.toContain(FIXTURE_INJECTED_SECRET);
    expect(rendered).not.toContain('ghp_FAKE');
    expect(rendered).toContain('[REDACTED:integration:gitlab_token]');
    expect(rendered).toContain('[REDACTED sha256:');
    expect(result.redactionCount).toBeGreaterThan(0);
  });

  it('counts every replacement on the entry that carried it', async () => {
    const { events, result } = await run('redaction');
    const counted = events.reduce((total, event) => total + event.redaction_count, 0);
    expect(counted).toBe(result.redactionCount);
    expect(events.some((event) => event.redaction_count > 0)).toBe(true);
  });

  it('never lets redaction touch the envelope', async () => {
    const { events } = await run('redaction');
    for (const [index, event] of events.entries()) {
      expect(event.run_id).toBe(runSpecFixture().runId);
      expect(event.seq).toBe(index);
      expect(event.created_at).toBe(new Date(FIXTURE_CLOCK_START).toISOString());
    }
  });
});

describe('steering', () => {
  it('pushes a second user turn and records who steered', async () => {
    const harness = start('steer');
    await harness.handle.steer({
      text: 'look at the session store instead',
      authorUserId: '44444444-4444-4444-8444-444444444444',
      authorLabel: 'Jan Mikeš',
    });
    const result = await harness.outcome;
    assertGolden('steer', { outcome: result, events: harness.events });
    expect(result.status).toBe('completed');
    const steer = harness.events.find((event) => event.kind === 'steer');
    expect(steer).toMatchObject({
      message: 'look at the session store instead',
      author_user_id: '44444444-4444-4444-8444-444444444444',
    });
    const userFrames = harness.cli.stdin.filter((frame) => frame['type'] === 'user');
    expect(userFrames).toHaveLength(2);
  });
});

describe('the stall detector', () => {
  /**
   * The harness is audited before the assertion: the run must actually reach the state the
   * assertion is about. `awaitOutput` waits until the scenario has emitted its last entry, so the
   * clock is advanced against a genuinely silent stream rather than against a run that had not
   * started.
   */
  const awaitOutput = async (harness: Harness, count: number): Promise<void> => {
    for (let attempt = 0; attempt < 200 && harness.events.length < count; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(harness.events).toHaveLength(count);
  };

  it('ends a silent run as `stalled` once the timeout passes on the injected clock', async () => {
    const harness = start('stall', {
      spec: { limits: { ...runSpecFixture().limits, stallTimeoutMs: 300_000 } },
    });
    await awaitOutput(harness, 2);

    harness.clock.advance(299_999);
    let settled = false;
    void harness.outcome.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled, 'the run must not end before the stall timeout').toBe(false);

    harness.clock.advance(1);
    const result = await harness.outcome;
    assertGolden('stall', { outcome: result, events: harness.events });
    expect(result.status).toBe('stalled');
    expect(result.terminalReason).toBe('stalled');
    expect(harness.events.at(-1)).toMatchObject({
      kind: 'system',
      subtype: 'run_stopped',
      data: { reason: 'stalled' },
    });
  });

  /**
   * Counting the arms rather than asserting "it did not stall": a run whose clock never moves does
   * not stall whether or not the timer is re-armed, so the obvious version of this test passes with
   * the re-arm deleted. One arm at start plus one per transcript entry is the shape that only holds
   * when `append` re-arms.
   */
  it('re-arms the stall timer on every transcript entry', async () => {
    const clock = manualClock(FIXTURE_CLOCK_START);
    const armed: number[] = [];
    const spy: typeof clock = {
      ...clock,
      setTimer: (delayMs, callback) => {
        armed.push(delayMs);
        return clock.setTimer(delayMs, callback);
      },
    };
    const sink = recordingSink();
    const cli = fakeSpawnClaudeCodeProcess(loadScript('happy-path'));
    const runner = createClaudeRunner({
      sink,
      approvals: scriptedApprovals(),
      tools: recordingTools(),
      clock: spy,
      injectedSecretRedactorFor: () => injectedSecretRedactorFixture(),
      spawnClaudeCodeProcess: cli.spawn,
    });
    const spec = runSpecFixture({
      limits: { ...runSpecFixture().limits, stallTimeoutMs: 300_000, wallClockMs: 3_600_000 },
    });
    const result = await runner.start(spec).outcome;
    expect(result.status).toBe('completed');
    expect(sink.events).toHaveLength(7);
    expect(armed.filter((delayMs) => delayMs === 300_000)).toHaveLength(8);
  });
});

describe('the wall clock', () => {
  it('ends a long run as `timed_out`, and the stall detector wins when both are due', async () => {
    const harness = start('stall', {
      spec: {
        limits: { ...runSpecFixture().limits, stallTimeoutMs: 300_000, wallClockMs: 60_000 },
      },
    });
    harness.clock.advance(60_000);
    const result = await harness.outcome;
    expect(result.status).toBe('timed_out');
    expect(result.terminalReason).toBe('timed_out');
  });
});

describe('cancellation', () => {
  it('stops a live run and reports `cancelled`', async () => {
    const harness = start('stall');
    await harness.handle.stop('cancelled');
    const result = await harness.outcome;
    expect(result.status).toBe('cancelled');
    expect(result.terminalReason).toBe('cancelled');
  });

  it('reports a take-over as a cancellation of the run', async () => {
    const harness = start('stall');
    await harness.handle.stop('taken_over');
    expect((await harness.outcome).status).toBe('cancelled');
  });
});

describe('the failure branches of the transcript writer', () => {
  /**
   * A transcript entry that fails its own schema is a platform bug. It must be loud and it must not
   * kill the run — so the row is replaced by one that says so, with paths and no values, and the
   * run carries on to its result. Asserted positively: the substitute row is there, and the result
   * still arrives.
   */
  it('replaces an unvalidatable entry with a `transcript_normalisation_failed` row and finishes', async () => {
    const sink = recordingSink();
    const errors: { fields: Record<string, unknown>; message: string }[] = [];
    const script = loadScript('happy-path');
    // `subtype: ''` fails `nonEmptyStringSchema` on the `system` entry.
    const broken = [
      {
        step: 'emit' as const,
        message: { type: 'system', subtype: '', session_id: 'x', uuid: 'y' },
      },
      ...script,
    ];
    const cli = fakeSpawnClaudeCodeProcess(broken);
    const runner = createClaudeRunner({
      sink,
      approvals: scriptedApprovals(),
      tools: recordingTools(),
      clock: manualClock(FIXTURE_CLOCK_START),
      injectedSecretRedactorFor: () => injectedSecretRedactorFixture(),
      spawnClaudeCodeProcess: cli.spawn,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (fields, message) => errors.push({ fields, message }),
      },
    });
    const result = await runner.start(runSpecFixture()).outcome;
    expect(sink.events[0]).toMatchObject({
      kind: 'system',
      subtype: 'transcript_normalisation_failed',
      data: { entry_kind: 'system' },
    });
    expect(errors.map((entry) => entry.message)).toContain('transcript entry failed validation');
    expect(result.status).toBe('completed');
    expect(sink.events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  /**
   * A crash left the transport running: `abort()` was on the stop path only, and `return()` is
   * fire-and-forget by necessity. The signal is observed through the one place it is visible from
   * outside — the `AbortController` the adapter hands to `query()`.
   */
  it('aborts the transport when the session throws mid-stream', async () => {
    let signal: AbortSignal | null = null;
    const runner = createClaudeRunner({
      sink: recordingSink(),
      approvals: scriptedApprovals(),
      tools: recordingTools(),
      clock: manualClock(FIXTURE_CLOCK_START),
      injectedSecretRedactorFor: () => injectedSecretRedactorFixture(),
      query: ((args: { options: { abortController: AbortController } }) => {
        signal = args.options.abortController.signal;
        return {
          // A hand-rolled iterator rather than a generator: the point is a `next()` that rejects
          // after the loop has already started awaiting it, which is where the SDK's transport
          // fails and where the adapter used to leave it running.
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<never> => {
              throw new Error('the transport died mid-stream');
            },
          }),
          interrupt: async () => {},
          return: async () => {},
        };
      }) as unknown as ClaudeRunnerDependencies['query'],
    });
    const result = await runner.start(runSpecFixture()).outcome;
    expect(result.terminalReason).toBe('crash');
    expect(signal).not.toBeNull();
    expect((signal as unknown as AbortSignal).aborted).toBe(true);
  });

  it('reports a `query()` that throws as a crash, with the message redacted', async () => {
    const sink = recordingSink();
    const runner = createClaudeRunner({
      sink,
      approvals: scriptedApprovals(),
      tools: recordingTools(),
      clock: manualClock(FIXTURE_CLOCK_START),
      injectedSecretRedactorFor: () => injectedSecretRedactorFixture(),
      query: (() => {
        throw new Error(`the transport refused ${FIXTURE_INJECTED_SECRET}`);
      }) as ClaudeRunnerDependencies['query'],
    });
    const result = await runner.start(runSpecFixture()).outcome;
    expect(result.status).toBe('failed');
    expect(result.terminalReason).toBe('crash');
    expect(result.error).not.toContain(FIXTURE_INJECTED_SECRET);
    expect(result.error).toContain('[REDACTED:integration:gitlab_token]');
  });
});

describe('local provider mode (BD-004)', () => {
  it('labels the cost an estimate, and still carries the number the SDK reported', async () => {
    const harness = start('happy-path', {
      spec: { providerMode: 'local', claudeCodePath: '/usr/local/bin/claude' },
    });
    const result = await harness.outcome;
    expect(result.cost).toEqual({ usd: 0.42, is_estimate: true, price_list_id: null });
  });
});
