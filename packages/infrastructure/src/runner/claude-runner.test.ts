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
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { RunOutcome, RunSpec, ToolApprovalDecision } from '@platform/application';
import {
  countingStartHooks,
  PROGRESS_MIN_INTERVAL_MS,
  reportProgressTool,
} from '@platform/application';
import type { TranscriptEvent } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  type ClaudeRunnerDependencies,
  createClaudeRunner,
  INTERRUPT_GRACE_MS,
  retriedWithoutModel,
} from './claude-runner.js';
import { manualClock } from './clock.js';
import {
  type FakeCli,
  type FakeCliOptions,
  type FakeCliScript,
  fakeSpawnClaudeCodeProcess,
} from './fake-spawn.js';
import {
  FIXTURE_CLOCK_START,
  FIXTURE_INJECTED_SECRET,
  injectedSecretRedactorFixture,
  recordingSink,
  recordingTools,
  rootCauseAnalysisFixture,
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
  /** The fake CLI's own options — its interrupted turn's result, for WP-101's cases. */
  cli?: FakeCliOptions;
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
  const cli = fakeSpawnClaudeCodeProcess(script, options.cli);
  const runner = createClaudeRunner({
    sink,
    approvals: scriptedApprovals(options.approval),
    tools: recordingTools(),
    clock,
    injectedSecretRedactorFor: () => injectedSecretRedactorFixture(),
    spawnClaudeCodeProcess: cli.spawn,
    ...options.deps,
  });
  const handle = runner.start(runSpecFixture(options.spec), countingStartHooks());
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
  const handle = runner.start(runSpecFixture(options.spec), countingStartHooks());
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

/** A take-over's instruction to the workspace, for the stop that carries one (WP-27). */
const TAKE_OVER_EXPORT = {
  branch: 'agentic/ACME-1',
  commitMessage: 'wip: hand-over to Ada',
  tarball: false,
  keepUntil: '2026-09-28T00:00:00.000Z',
} as const;

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
    // No `result`, so nothing measured it: unmeasured, never the `0` floor stated as a figure
    // (WP-119 pre-review round, standing rule 16).
    expect(result.costUnmeasured).toBe(true);
    expect(result.modelUsage).toEqual([]);
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
        permissionDecisionReason: expect.stringContaining('matches the block-list entry'),
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

/**
 * Drives a stop the platform has already decided to its end: a stop that reads the interrupted
 * turn's result (WP-101, and the stall and the wall clock since WP-119) waits up to
 * {@link INTERRUPT_GRACE_MS} for it, so a script that never sends one is released only by advancing
 * the manual clock past the grace — never by the wall clock (rule 2).
 */
const releaseByGrace = async (harness: Harness): Promise<RunOutcome> => {
  let settled = false;
  void harness.outcome.then(() => {
    settled = true;
  });
  for (let round = 0; round < 50 && !settled; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    harness.clock.advance(INTERRUPT_GRACE_MS);
  }
  return harness.outcome;
};

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
    // Since WP-119 a stall reads the interrupted turn's result within the interrupt's grace, and
    // this script never sends one, so only the grace releases the stop (rule 2: the manual clock).
    const result = await releaseByGrace(harness);
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
    const result = await runner.start(spec, countingStartHooks()).outcome;
    expect(result.status).toBe('completed');
    expect(sink.events).toHaveLength(7);
    expect(armed.filter((delayMs) => delayMs === 300_000)).toHaveLength(8);
  });
});

/**
 * **A retry is not progress** (WP-127, PROGRESS backlog 346).
 *
 * With no route to the model the CLI retries (`api_retry`, measured at WP-118: seven in sixty
 * seconds, delays doubling from 0.6 s), and each retry used to re-arm the stall, so the run lived
 * until the wall clock. The fake CLI emits the retries at once, so "does not re-arm" is asserted
 * the way the re-arm itself is above — by counting arms — and then the stall is reached on the
 * injected clock and its error names the route in platform words.
 */
describe('a run whose CLI only retries the model API', () => {
  const retry = (attempt: number) => ({
    step: 'emit' as const,
    message: {
      type: 'system',
      subtype: 'api_retry',
      attempt,
      max_retries: 10,
      retry_delay_ms: 600 * 2 ** (attempt - 1),
      error_status: null,
      error: 'unknown',
      uuid: `00000009-0000-4000-8000-00000000000${String(attempt)}`,
      session_id: 'fake-session-0001',
    },
  });
  const retryingScript = (retries: number): FakeCliScript => {
    const stall = loadScript('stall');
    // init, await_user, then the retries in place of the model's answer, then silence.
    return [
      ...stall.slice(0, 2),
      ...Array.from({ length: retries }, (_, index) => retry(index + 1)),
      { step: 'stall' },
    ] as FakeCliScript;
  };

  const run = (retries: number) => {
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
    const cli = fakeSpawnClaudeCodeProcess(retryingScript(retries));
    const handle = createClaudeRunner({
      sink,
      approvals: scriptedApprovals(),
      tools: recordingTools(),
      clock: spy,
      injectedSecretRedactorFor: () => injectedSecretRedactorFixture(),
      spawnClaudeCodeProcess: cli.spawn,
    }).start(
      runSpecFixture({
        limits: { ...runSpecFixture().limits, stallTimeoutMs: 300_000, wallClockMs: 3_600_000 },
      }),
      countingStartHooks(),
    );
    return { clock, armed, events: sink.events, cli, outcome: handle.outcome, handle };
  };

  const settle = async (events: readonly TranscriptEvent[], count: number): Promise<void> => {
    for (let attempt = 0; attempt < 200 && events.length < count; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(events).toHaveLength(count);
  };

  it('transcribes every api_retry and does not re-arm the stall for any of them', async () => {
    const without = run(0);
    await settle(without.events, 1);
    const withRetries = run(4);
    await settle(withRetries.events, 5);

    expect(
      withRetries.events.filter(
        (event) => event.kind === 'system' && event.subtype === 'api_retry',
      ),
    ).toHaveLength(4);
    const stallArms = (armed: number[]) => armed.filter((delayMs) => delayMs === 300_000).length;
    expect(stallArms(withRetries.armed)).toBe(stallArms(without.armed));
  });

  it('ends such a run as stalled, naming the route and the retry count in platform text', async () => {
    const harness = run(3);
    await settle(harness.events, 4);
    harness.clock.advance(300_000);
    const result = await releaseByGrace(harness as unknown as Harness);
    expect(result.status).toBe('stalled');
    expect(result.terminalReason).toBe('stalled');
    expect(result.error).toBe(retriedWithoutModel('stalled', 3, []));
    expect(result.error).toContain('no route to the model host');
    expect(result.error).not.toContain('unknown');
  });

  /**
   * The CLI's own give-up, as measured on the pinned CLI with its sidecar stopped (WP-127): after
   * the last retry a synthetic assistant message (`model: "<synthetic>"`, text "Request timed out")
   * and an `error_during_execution` result. The run's error is the platform's sentence, not the CLI's.
   */
  it('names the route when the CLI gives up after retries, rather than quoting the CLI', async () => {
    const script = retryingScript(2);
    script.splice(
      4,
      1,
      {
        step: 'emit',
        message: {
          type: 'assistant',
          message: {
            id: 'msg_synthetic',
            type: 'message',
            role: 'assistant',
            model: '<synthetic>',
            content: [{ type: 'text', text: 'Request timed out' }],
            stop_reason: 'stop_sequence',
            stop_sequence: '',
            usage: { input_tokens: 0, output_tokens: 0 },
          },
          parent_tool_use_id: null,
          uuid: '0000000a-0000-4000-8000-000000000001',
          session_id: 'fake-session-0001',
        },
      },
      {
        step: 'emit',
        message: {
          type: 'result',
          subtype: 'success',
          is_error: true,
          duration_ms: 177_179,
          duration_api_ms: 0,
          num_turns: 1,
          result: 'Request timed out',
          stop_reason: 'stop_sequence',
          total_cost_usd: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
          modelUsage: {},
          permission_denials: [],
          uuid: '0000000a-0000-4000-8000-000000000002',
          session_id: 'fake-session-0001',
        },
      },
      { step: 'exit', code: 1, signal: null },
    );
    const sink = recordingSink();
    const cli = fakeSpawnClaudeCodeProcess(script as FakeCliScript);
    const result = await createClaudeRunner({
      sink,
      approvals: scriptedApprovals(),
      tools: recordingTools(),
      clock: manualClock(FIXTURE_CLOCK_START),
      injectedSecretRedactorFor: () => injectedSecretRedactorFixture(),
      spawnClaudeCodeProcess: cli.spawn,
    }).start(runSpecFixture(), countingStartHooks()).outcome;
    expect(result.status).toBe('failed');
    expect(result.error).toBe(retriedWithoutModel('gave_up', 2, []));
    expect(result.error).not.toContain('Request timed out');
  });

  it('says the provider answered, with the statuses, when the retries had one', () => {
    expect(retriedWithoutModel('stalled', 2, [529, 503])).toBe(
      'the platform stopped the run: stalled — the CLI retried the model API 2 times (api_retry) and the model API answered HTTP 503, 529, so the provider failed or refused the requests',
    );
  });

  it('keeps the plain stall message once the model made progress after a retry', async () => {
    const script = retryingScript(2);
    const stall = loadScript('stall');
    // The model's answer after the retries: progress, so the count resets.
    script.splice(4, 0, stall[2] as FakeCliScript[number]);
    const sink = recordingSink();
    const clock = manualClock(FIXTURE_CLOCK_START);
    const cli = fakeSpawnClaudeCodeProcess(script);
    const handle = createClaudeRunner({
      sink,
      approvals: scriptedApprovals(),
      tools: recordingTools(),
      clock,
      injectedSecretRedactorFor: () => injectedSecretRedactorFixture(),
      spawnClaudeCodeProcess: cli.spawn,
    }).start(
      runSpecFixture({ limits: { ...runSpecFixture().limits, stallTimeoutMs: 300_000 } }),
      countingStartHooks(),
    );
    await settle(sink.events, 4);
    clock.advance(300_000);
    const result = await releaseByGrace({ clock, outcome: handle.outcome } as unknown as Harness);
    expect(result.status).toBe('stalled');
    expect(result.error).toBe('the platform stopped the run: stalled');
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
    const result = await releaseByGrace(harness);
    expect(result.status).toBe('timed_out');
    expect(result.terminalReason).toBe('timed_out');
  });
});

/**
 * Drives a stop to its end on the manual clock: the stop waits up to {@link INTERRUPT_GRACE_MS} for
 * the interrupted turn's result (WP-101), and a script that never sends one is released only by that
 * grace — so the case advances the clock until the stop settles, never the wall clock (rule 2).
 */
const settleStop = async (harness: Harness, stopping: Promise<void>): Promise<RunOutcome> => {
  let settled = false;
  void stopping.then(() => {
    settled = true;
  });
  for (let round = 0; round < 50 && !settled; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    harness.clock.advance(INTERRUPT_GRACE_MS);
  }
  await stopping;
  return harness.outcome;
};

/** The interrupted turn's `result`, as the SDK documents it arriving after the interrupt's receipt. */
const INTERRUPTED_RESULT = {
  type: 'result',
  subtype: 'error_during_execution',
  duration_ms: 900,
  duration_api_ms: 700,
  is_error: true,
  num_turns: 1,
  stop_reason: null,
  total_cost_usd: 0.13,
  usage: {
    input_tokens: 800,
    output_tokens: 60,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  },
  modelUsage: {
    'claude-opus-5': {
      inputTokens: 800,
      outputTokens: 60,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.13,
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    },
  },
  permission_denials: [],
  errors: [],
  uuid: '00000009-0000-4000-8000-000000000000',
  session_id: 'fake-session-0001',
};

describe('cancellation', () => {
  it('stops a live run and reports `cancelled`', async () => {
    const harness = start('stall');
    const result = await settleStop(harness, harness.handle.stop({ reason: 'cancelled' }));
    expect(result.status).toBe('cancelled');
    expect(result.terminalReason).toBe('cancelled');
    // No interrupted result arrived, so nothing was measured — and the outcome says so, rather than
    // reporting a zero the run row would store as a figure (WP-101 review round 1, rule 16).
    expect(result.modelUsage).toEqual([]);
    expect(result.costUnmeasured).toBe(true);
  });

  it('reports a take-over as a cancellation of the run', async () => {
    const harness = start('stall');
    const result = await settleStop(
      harness,
      harness.handle.stop({ reason: 'taken_over', workspaceExport: TAKE_OVER_EXPORT }),
    );
    expect(result.status).toBe('cancelled');
  });

  /**
   * WP-101 (TD-028 decision 11): a cancel now stops a session that has been spending, so the stopped
   * run must carry what it spent — which only the CLI knows, in the interrupted turn's result.
   * Without the read (`readInterruptedResult` removed) the outcome's cost is `0` and its model usage
   * empty, and the ledger writes no row for a session that cost money.
   */
  it('carries the interrupted turn’s measured cost into a cancelled outcome, before the script ends (WP-101)', async () => {
    const script = loadScript('stall');
    const harness = startScript(script, {
      cli: { interruptedResult: { ...INTERRUPTED_RESULT } },
    });
    // Held after its first turn: the session is live and spending when the human stops it.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = await settleStop(harness, harness.handle.stop({ reason: 'cancelled' }));

    expect(result.status).toBe('cancelled');
    expect(result.terminalReason).toBe('cancelled');
    expect(result.cost).toEqual({ usd: 0.13, is_estimate: false, price_list_id: null });
    expect(result.costUnmeasured).toBeUndefined();
    expect(result.modelUsage.map((entry) => [entry.model, entry.usd])).toEqual([
      ['claude-opus-5', 0.13],
    ]);
    expect(result.structuredOutput).toBeNull();
    // The session was interrupted, not played out: its script never reached its own end.
    expect(harness.cli.interrupts).toBe(1);
    expect(harness.cli.scriptEnded).toBe(false);
    // The transcript says both, in order: the interrupted turn's result, then the platform's stop.
    const kinds = harness.events.map((event) =>
      event.kind === 'system' ? `system:${event.subtype}` : event.kind,
    );
    expect(kinds.slice(-2)).toEqual(['result', 'system:run_stopped']);
  });

  /**
   * **Nothing is left armed behind an ended run** — WP-132, PROGRESS backlog 405. The interrupted
   * turn's `result` and the `run_stopped` row are written after the stop, through the same `append`
   * that re-arms the stall on progress; before WP-132 each left a fresh stall timer pending, and the
   * interrupt's grace stayed armed after the interrupt had answered. Counted on the manual clock.
   */
  it('leaves no timer pending once a stopped run’s outcome is in, the stall included (WP-132)', async () => {
    const harness = startScript(loadScript('stall'), {
      cli: { interruptedResult: { ...INTERRUPTED_RESULT } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = await settleStop(harness, harness.handle.stop({ reason: 'cancelled' }));
    expect(result.status).toBe('cancelled');
    // The rows written after the stop exist, so the re-arm had something to re-arm on.
    const kinds = harness.events.map((event) =>
      event.kind === 'system' ? `system:${event.subtype}` : event.kind,
    );
    expect(kinds.slice(-2)).toEqual(['result', 'system:run_stopped']);
    expect(harness.clock.pending).toBe(0);
  });

  it('does not read past the grace for a result the CLI never sends (the bound, WP-101)', async () => {
    const harness = startScript(loadScript('stall'));
    const stopping = harness.handle.stop({ reason: 'cancelled' });
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    for (let round = 0; round < 10; round += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // Waiting for a result that is not coming: only the grace releases it.
    expect(settled).toBe(false);
    harness.clock.advance(INTERRUPT_GRACE_MS);
    await stopping;
    const result = await harness.outcome;
    expect(result.status).toBe('cancelled');
    // Released by the grace with nothing read: unmeasured, never a measured zero (review round 1).
    expect(result.costUnmeasured).toBe(true);
    expect(result.modelUsage).toEqual([]);
  });
});

/**
 * WP-119 (PROGRESS backlog 334, the M7 ruling): the platform's own stops — a stall and the wall
 * clock — read the interrupted turn's result inside the same grace a human's stop has, and a stop
 * that reads nothing is **unmeasured**, never the measured zero it was until now (standing rule 16).
 * The wall clock is the most expensive run the platform ends; before this a timed-out run's spend
 * reached no ledger row and no cap.
 */
describe('the platform’s own stops read the interrupted turn (WP-119)', () => {
  const stallLimits = {
    ...runSpecFixture().limits,
    stallTimeoutMs: 300_000,
    wallClockMs: 3_600_000,
  };
  const wallLimits = { ...runSpecFixture().limits, stallTimeoutMs: 3_600_000, wallClockMs: 60_000 };
  const cases = [
    { cause: 'stalled', limits: stallLimits, fireAfterMs: 300_000 },
    { cause: 'timed_out', limits: wallLimits, fireAfterMs: 60_000 },
  ] as const;

  /** Lets the script emit what it emits before the clock moves: the state is reached first (rule 4). */
  const untilQuiet = async (): Promise<void> => {
    for (let round = 0; round < 20; round += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  it.each(cases)(
    'carries the interrupted turn’s measured cost into a $cause outcome',
    async ({ cause, limits, fireAfterMs }) => {
      const harness = startScript(loadScript('stall'), {
        spec: { limits },
        cli: { interruptedResult: { ...INTERRUPTED_RESULT } },
      });
      await untilQuiet();
      harness.clock.advance(fireAfterMs);
      const result = await releaseByGrace(harness);

      expect(result.status).toBe(cause);
      expect(result.terminalReason).toBe(cause);
      expect(result.cost).toEqual({ usd: 0.13, is_estimate: false, price_list_id: null });
      expect(result.costUnmeasured).toBeUndefined();
      expect(result.modelUsage.map((entry) => [entry.model, entry.usd])).toEqual([
        ['claude-opus-5', 0.13],
      ]);
      expect(result.usage.input_tokens).toBe(800);
      // Interrupted, not played out, and the transcript says so in order.
      expect(harness.cli.interrupts).toBe(1);
      expect(harness.cli.scriptEnded).toBe(false);
      const kinds = harness.events.map((event) =>
        event.kind === 'system' ? `system:${event.subtype}` : event.kind,
      );
      expect(kinds.slice(-2)).toEqual(['result', 'system:run_stopped']);
      expect(harness.events.at(-1)).toMatchObject({ data: { reason: cause } });
    },
  );

  it.each(cases)(
    'reports a $cause stop that read no result as unmeasured, released only by the grace',
    async ({ cause, limits, fireAfterMs }) => {
      const harness = startScript(loadScript('stall'), { spec: { limits } });
      await untilQuiet();
      harness.clock.advance(fireAfterMs);
      let settled = false;
      void harness.outcome.then(() => {
        settled = true;
      });
      await untilQuiet();
      // Waiting for a result that is not coming: the grace, and nothing else, releases it.
      expect(settled).toBe(false);
      const result = await releaseByGrace(harness);

      expect(result.status).toBe(cause);
      expect(result.costUnmeasured).toBe(true);
      expect(result.modelUsage).toEqual([]);
      // The interrupt was sent: the stop asked, and the CLI's silence is what left it unmeasured.
      const interrupts = harness.cli.stdin.filter(
        (frame) =>
          frame['type'] === 'control_request' &&
          (frame['request'] as { subtype?: string } | undefined)?.subtype === 'interrupt',
      );
      expect(interrupts).toHaveLength(1);
    },
  );
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
    const result = await runner.start(runSpecFixture(), countingStartHooks()).outcome;
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
    const result = await runner.start(runSpecFixture(), countingStartHooks()).outcome;
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
    const result = await runner.start(runSpecFixture(), countingStartHooks()).outcome;
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

/**
 * WP-144 (PROGRESS backlog 432): the process's own stop hands the run back. It is a `failed` run
 * with the terminal reason `shutdown` — never `cancelled`, which says a person stopped it — and it
 * carries the interrupted turn's measured cost like a person's stop, or says nothing was measured.
 */
describe('a hand-back on the runner’s own stop (WP-144)', () => {
  it('ends the run failed/shutdown with the interrupted turn’s measured cost', async () => {
    const script = loadScript('stall');
    const harness = startScript(script, {
      cli: { interruptedResult: { ...INTERRUPTED_RESULT } },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = await settleStop(harness, harness.handle.stop({ reason: 'shutdown' }));

    expect(result.status).toBe('failed');
    expect(result.terminalReason).toBe('shutdown');
    expect(result.cost).toEqual({ usd: 0.13, is_estimate: false, price_list_id: null });
    expect(result.costUnmeasured).toBeUndefined();
  });

  it('says nothing was measured when the interrupted turn sent no result (rule 16)', async () => {
    const harness = start('stall');
    const result = await settleStop(harness, harness.handle.stop({ reason: 'shutdown' }));
    expect(result.status).toBe('failed');
    expect(result.terminalReason).toBe('shutdown');
    expect(result.costUnmeasured).toBe(true);
  });
});

/**
 * **An artifact delivered in the turn that crossed the cap is kept** (product owner, 2026-10-05,
 * BD-010's amendment, PROGRESS backlog 466). The golden is the Autix ending in miniature. The model
 * hands its answer to the CLI's `StructuredOutput` tool. The CLI acknowledges it. The same turn's
 * spend crosses the $5 ceiling. The CLI ends with `error_max_budget_usd` and `structured_output`
 * absent.
 *
 * Every case below edits that golden by one step, so each assertion names the one condition the
 * keep depends on (rule 10). The cost is asserted on every kept outcome, because counting the
 * overrun is half of the decision.
 */
describe('an artifact delivered in the turn that crossed the cap (backlog 466)', () => {
  const FIVE_DOLLAR_CAP: Partial<RunSpec> = {
    limits: { ...runSpecFixture().limits, maxBudgetUsd: 5 },
  };
  const DELIVERED = 'budget-exceeded-delivered';

  type Message = Record<string, unknown>;
  type Edit = (message: Message) => Message | null;

  const isResult = (message: Message): boolean => message['type'] === 'result';
  const isToolResult = (message: Message): boolean => message['type'] === 'user';
  const isOffer = (message: Message): boolean => message['type'] === 'assistant';

  /** The golden script with each emitted message passed through `edit`; `null` drops the step. */
  const edited = (edit: Edit): FakeCliScript =>
    loadScript(DELIVERED).flatMap((step): FakeCliScript[number][] => {
      if (step.step !== 'emit') {
        return [step];
      }
      const message = edit(step.message);
      return message === null ? [] : [{ ...step, message }];
    });

  /** The same script, cut before its `result`, and left silent rather than exiting. */
  const silentAfterDelivery = (): FakeCliScript => [
    ...edited((message) => (isResult(message) ? null : message)).filter(
      (step) => step.step !== 'exit',
    ),
    { step: 'stall' },
  ];

  /** Rewrites the `StructuredOutput` call's tool_use block (the assistant message's second block). */
  const withOffer =
    (change: (block: Message) => Message): Edit =>
    (message) => {
      if (!isOffer(message)) {
        return message;
      }
      const inner = message['message'] as Message;
      const [text, offer] = inner['content'] as Message[];
      return { ...message, message: { ...inner, content: [text, change(offer as Message)] } };
    };

  /** Rewrites the CLI's `tool_result` block for that call. */
  const withToolResult =
    (change: (block: Message) => Message): Edit =>
    (message) => {
      if (!isToolResult(message)) {
        return message;
      }
      const inner = message['message'] as Message;
      const [block] = inner['content'] as Message[];
      return { ...message, message: { ...inner, content: [change(block as Message)] } };
    };

  /** Lets the scripted messages before a silent step reach the transcript. */
  const awaitEntries = async (harness: Harness, count: number): Promise<void> => {
    for (let round = 0; round < 200 && harness.events.length < count; round += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(harness.events.length).toBeGreaterThanOrEqual(count);
  };

  const expectBudgetEnding = (result: RunOutcome): void => {
    expect(result.status).toBe('budget_exceeded');
    expect(result.terminalReason).toBe('error_max_budget_usd');
    expect(result.structuredOutput).toBeNull();
    expect(result.cost.usd).toBe(5.4);
  };

  it('keeps the acknowledged artifact, completes the run and still reports what it spent', async () => {
    const { result, events } = await run(DELIVERED, { spec: FIVE_DOLLAR_CAP });
    expect(result.status).toBe('completed');
    expect(result.terminalReason).toBe('error_max_budget_usd');
    expect(result.structuredOutput).toEqual(rootCauseAnalysisFixture);
    expect(result.error).toBeNull();
    // The overrun is counted: the CLI's figure, over the $5 ceiling, measured rather than a floor.
    expect(result.cost).toEqual({ usd: 5.4, is_estimate: false, price_list_id: null });
    expect(result.costUnmeasured).toBeUndefined();
    expect(result.modelUsage.map((entry) => [entry.model, entry.usd])).toEqual([
      ['claude-opus-5', 5.4],
    ]);
    expect(result.numTurns).toBe(90);
    // 5.4 > 5, so the platform's own relabel fired too, and the transcript says so.
    expect(events.at(-1)).toMatchObject({
      kind: 'system',
      subtype: 'run_stopped',
      data: { reason: 'budget_exceeded' },
    });
  });

  it('keeps it when only the CLI’s own `error_max_budget_usd` ended the run', async () => {
    // The default $10 ceiling: the platform's watchdog stays silent, so this is the `result` branch.
    const harness = startScript(loadScript(DELIVERED));
    const result = await harness.outcome;
    expect(result.status).toBe('completed');
    expect(result.terminalReason).toBe('error_max_budget_usd');
    expect(result.structuredOutput).toEqual(rootCauseAnalysisFixture);
    expect(result.cost.usd).toBe(5.4);
    expect(
      harness.events.some((event) => event.kind === 'system' && event.subtype === 'run_stopped'),
    ).toBe(false);
  });

  it('keeps it when the platform relabels a `success` the CLI reported over the ceiling', async () => {
    // The CLI said success with no `structured_output` of its own, so the artifact can only come
    // from the acknowledged delivery.
    const script = edited((message) =>
      isResult(message)
        ? {
            ...message,
            subtype: 'success',
            is_error: false,
            result: 'Done.',
            stop_reason: 'end_turn',
          }
        : message,
    );
    const result = await startScript(script, { spec: FIVE_DOLLAR_CAP }).outcome;
    expect(result.status).toBe('completed');
    expect(result.terminalReason).toBe('error_max_budget_usd');
    expect(result.structuredOutput).toEqual(rootCauseAnalysisFixture);
    expect(result.cost.usd).toBe(5.4);
  });

  it('does not keep a delivered input the artifact schema refuses', async () => {
    const script = edited(
      withOffer((offer) => ({
        ...offer,
        input: { ...(offer['input'] as Message), confidence: 'certain' },
      })),
    );
    expectBudgetEnding(await startScript(script, { spec: FIVE_DOLLAR_CAP }).outcome);
  });

  it('does not keep a call the CLI answered with an error', async () => {
    const script = edited(
      withToolResult((block) => ({
        ...block,
        is_error: true,
        content: 'Output does not match required schema',
      })),
    );
    expectBudgetEnding(await startScript(script, { spec: FIVE_DOLLAR_CAP }).outcome);
  });

  it('does not keep an offer the CLI never answered', async () => {
    const script = edited((message) => (isToolResult(message) ? null : message));
    expectBudgetEnding(await startScript(script, { spec: FIVE_DOLLAR_CAP }).outcome);
  });

  it('does not keep a result for a different tool use, nor a tool of another name', async () => {
    const otherId = edited(withToolResult((block) => ({ ...block, tool_use_id: 'toolu_other' })));
    expectBudgetEnding(await startScript(otherId, { spec: FIVE_DOLLAR_CAP }).outcome);
    const otherTool = edited(withOffer((offer) => ({ ...offer, name: 'Write' })));
    expectBudgetEnding(await startScript(otherTool, { spec: FIVE_DOLLAR_CAP }).outcome);
  });

  it('does not keep a subagent’s StructuredOutput call', async () => {
    const script = edited((message) =>
      isOffer(message) || isToolResult(message)
        ? { ...message, parent_tool_use_id: 'toolu_task_01' }
        : message,
    );
    expectBudgetEnding(await startScript(script, { spec: FIVE_DOLLAR_CAP }).outcome);
  });

  it('leaves an over-cap run that delivered nothing unchanged', async () => {
    const script = edited((message) =>
      isToolResult(message)
        ? null
        : withOffer(() => ({ type: 'text', text: 'still going' }))(message),
    );
    expectBudgetEnding(await startScript(script, { spec: FIVE_DOLLAR_CAP }).outcome);
  });

  it('does not keep it for a run with no artifact type', async () => {
    const result = await startScript(loadScript(DELIVERED), {
      spec: { ...FIVE_DOLLAR_CAP, artifactType: null },
    }).outcome;
    expectBudgetEnding(result);
  });

  it('keeps nothing from a crash after the delivery', async () => {
    const script = edited((message) => (isResult(message) ? null : message));
    const result = await startScript(script, { spec: FIVE_DOLLAR_CAP }).outcome;
    expect(result.status).toBe('failed');
    expect(result.terminalReason).toBe('crash');
    expect(result.structuredOutput).toBeNull();
    expect(result.costUnmeasured).toBe(true);
  });

  it('keeps nothing when the result reported no usable cost (`cost_unreported`)', async () => {
    const script = edited((message) => {
      if (!isResult(message)) {
        return message;
      }
      const { total_cost_usd: _dropped, ...rest } = message;
      return rest;
    });
    const result = await startScript(script, { spec: FIVE_DOLLAR_CAP }).outcome;
    expect(result.status).toBe('budget_exceeded');
    expect(result.error).toContain('cost_unreported');
    expect(result.structuredOutput).toBeNull();
  });

  it('keeps nothing from a stall after the delivery', async () => {
    const harness = startScript(silentAfterDelivery(), {
      spec: { limits: { ...runSpecFixture().limits, maxBudgetUsd: 5, stallTimeoutMs: 1_000 } },
    });
    await awaitEntries(harness, 3);
    harness.clock.advance(1_000);
    const result = await releaseByGrace(harness);
    expect(result.status).toBe('stalled');
    expect(result.structuredOutput).toBeNull();
  });

  it('keeps nothing from a cancel, even when the interrupted turn reports the budget ending', async () => {
    const budgetResult = loadScript(DELIVERED).find(
      (step) => step.step === 'emit' && isResult(step.message),
    );
    const harness = startScript(silentAfterDelivery(), {
      spec: FIVE_DOLLAR_CAP,
      cli: { interruptedResult: { ...(budgetResult as { message: Message }).message } },
    });
    await awaitEntries(harness, 3);
    const result = await settleStop(harness, harness.handle.stop({ reason: 'cancelled' }));
    expect(result.status).toBe('cancelled');
    expect(result.terminalReason).toBe('cancelled');
    expect(result.structuredOutput).toBeNull();
    // The interrupted turn's figure is still the run's cost (WP-101).
    expect(result.cost.usd).toBe(5.4);
  });
});

/**
 * PROGRESS backlog 496: `report_progress` reaches the run's own transcript door. The tool is called
 * the way the CLI calls it — through the `platform` MCP server the adapter handed to the real
 * `query()` — mid-run, so the row it writes takes the run's next `seq`, its redactor and its sink.
 */
describe('report_progress (backlog 496)', () => {
  type ToolHandler = (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>;
  /** The registered handler, read off the MCP server instance the adapter built for this run. */
  const reportProgressHandler = (options: unknown): ToolHandler => {
    const servers = (options as { mcpServers: Record<string, unknown> }).mcpServers;
    const platform = servers['platform'] as {
      instance: { _registeredTools: Record<string, { handler: ToolHandler } | undefined> };
    };
    const registered = platform.instance._registeredTools['report_progress'];
    if (registered === undefined) {
      throw new Error('report_progress is not registered on the platform server');
    }
    return registered.handler;
  };

  it('writes one redacted progress row per admitted call through the run’s door, and refuses a burst', async () => {
    let options: unknown = null;
    const harness = start('stall', {
      deps: {
        tools: recordingTools({
          reportProgress: (input, context) => reportProgressTool(input, context),
        }),
        query: ((args: Parameters<typeof sdkQuery>[0]) => {
          options = args.options;
          return sdkQuery(args);
        }) as ClaudeRunnerDependencies['query'],
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const call = reportProgressHandler(options);
    const answer = async (args: unknown): Promise<string> =>
      (await call(args, {})).content.map((item) => item.text).join('');

    expect(
      await answer({
        summary: `slice 1 pushed with ${FIXTURE_INJECTED_SECRET}`,
        percent_complete: 25,
      }),
    ).toBe('Progress recorded.');
    expect(await answer({ summary: 'slice 1 again' })).toMatch(/^Not recorded: /);
    harness.clock.advance(PROGRESS_MIN_INTERVAL_MS);
    expect(await answer({ summary: 'slice 2 started' })).toBe('Progress recorded.');

    const result = await settleStop(harness, harness.handle.stop({ reason: 'cancelled' }));
    const progress = harness.events.filter((event) => event.kind === 'progress');
    expect(progress).toEqual([
      expect.objectContaining({
        kind: 'progress',
        summary: 'slice 1 pushed with [REDACTED:integration:gitlab_token]',
        percent_complete: 25,
        truncated: false,
        redaction_count: 1,
      }),
      expect.objectContaining({ kind: 'progress', summary: 'slice 2 started', redaction_count: 0 }),
    ]);
    expect(JSON.stringify(harness.events)).not.toContain(FIXTURE_INJECTED_SECRET);
    // The door is serialised: every row has its own `seq`, and they reach the sink in order.
    const seqs = harness.events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(result.redactionCount).toBeGreaterThanOrEqual(1);
  });

  /**
   * The tool handler writes while the loop writes too. A slow sink write of the progress row must
   * not let a later row overtake it: the SSE bridge reads rows back from a watermark, so a row
   * stored after a higher `seq` would never reach a live stream.
   */
  it('keeps a slow progress write ahead of the rows written after it', async () => {
    let options: unknown = null;
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stored: TranscriptEvent[] = [];
    const harness = start('stall', {
      deps: {
        sink: {
          append: async (event) => {
            if (event.kind === 'progress') {
              await slow;
            }
            stored.push(event);
          },
        },
        tools: recordingTools({
          reportProgress: (input, context) => reportProgressTool(input, context),
        }),
        query: ((args: Parameters<typeof sdkQuery>[0]) => {
          options = args.options;
          return sdkQuery(args);
        }) as ClaudeRunnerDependencies['query'],
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const reported = reportProgressHandler(options)({ summary: 'tests running' }, {});
    const stopping = harness.handle.stop({ reason: 'cancelled' });
    // Let the stop write its own rows while the progress row is still in the sink.
    for (let round = 0; round < 20; round += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      harness.clock.advance(INTERRUPT_GRACE_MS);
    }
    release();
    await reported;
    await settleStop(harness, stopping);
    expect(stored.some((event) => event.kind === 'progress')).toBe(true);
    const seqs = stored.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
  });
});
