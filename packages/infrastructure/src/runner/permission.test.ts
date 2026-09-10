import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import type { ToolApprovalDecision } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { manualClock } from './clock.js';
import {
  FIXTURE_USER_ID,
  runSpecFixture,
  type ScriptedApprovals,
  scriptedApprovals,
} from './fixtures.js';
import type { HookRecord } from './hooks.js';
import { approvalDetail, buildCanUseTool } from './permission.js';

const options = (toolUseID = 'toolu_1') =>
  ({
    signal: new AbortController().signal,
    toolUseID,
    requestId: 'req-1',
  }) as Parameters<CanUseTool>[2];

interface Harness {
  readonly canUseTool: CanUseTool;
  readonly records: HookRecord[];
  readonly approvals: ScriptedApprovals;
  readonly clock: ReturnType<typeof manualClock>;
  readonly abort: AbortController;
}

const harness = (answer: ToolApprovalDecision | 'never-answers' | 'throws'): Harness => {
  const records: HookRecord[] = [];
  const clock = manualClock();
  const abort = new AbortController();
  const approvals =
    answer === 'throws'
      ? ({
          requests: [],
          requestApproval: async () => {
            throw new Error('the question channel is down: token=glpat-FAKE000000000000000');
          },
        } as unknown as ScriptedApprovals)
      : scriptedApprovals(answer);
  const canUseTool = buildCanUseTool({
    spec: runSpecFixture({
      limits: { ...runSpecFixture().limits, questionTimeoutMs: 60_000 },
    }),
    approvals,
    clock,
    signal: abort.signal,
    recordHook: async (record) => {
      records.push(record);
    },
  });
  return { canUseTool, records, approvals, clock, abort };
};

describe('canUseTool', () => {
  it('allows when a human approves, and records the question it came from', async () => {
    const test = harness({
      decision: 'allow',
      reason: 'a maintainer approved it',
      questionId: FIXTURE_USER_ID,
    });
    const result = await test.canUseTool('Bash', { command: 'npm publish' }, options());
    expect(result).toMatchObject({ behavior: 'allow' });
    expect(test.records.at(-1)).toMatchObject({
      decision: 'allow',
      questionId: FIXTURE_USER_ID,
      toolUseId: 'toolu_1',
    });
  });

  it('denies when a human refuses, and tells the model why', async () => {
    const test = harness({ decision: 'deny', reason: 'not on a release day', questionId: null });
    const result = await test.canUseTool('Bash', { command: 'npm publish' }, options());
    expect(result).toEqual({ behavior: 'deny', message: 'not on a release day' });
  });

  it('shows a human the exact command for Bash, and a rendering for anything else', () => {
    expect(approvalDetail('Bash', { command: 'rm -rf build' })).toBe('rm -rf build');
    expect(approvalDetail('WebFetch', { url: 'https://example.invalid' })).toBe(
      '{"url":"https://example.invalid"}',
    );
  });

  /**
   * Unattended default deny (BD-025). The named assertion is this one: with the deadline removed,
   * the promise below never settles and the test fails on a timeout instead — which is why the
   * assertion is written on the *resolved value*, and why the clock is injected.
   */
  it('denies when nobody answers before the deadline', async () => {
    const test = harness('never-answers');
    const pending = test.canUseTool('Bash', { command: 'npm publish' }, options());
    test.clock.advance(60_000);
    await expect(pending).resolves.toEqual({
      behavior: 'deny',
      message: expect.stringContaining('Unattended runs default to deny'),
    });
    expect(test.records.at(-1)?.decision).toBe('deny');
  });

  it('does not deny one millisecond early', async () => {
    const test = harness('never-answers');
    let settled = false;
    const pending = test.canUseTool('Bash', { command: 'npm publish' }, options()).then((value) => {
      settled = true;
      return value;
    });
    test.clock.advance(59_999);
    await Promise.resolve();
    expect(settled).toBe(false);
    test.clock.advance(1);
    await pending;
    expect(settled).toBe(true);
  });

  it('denies when the run ends underneath the question', async () => {
    const test = harness('never-answers');
    const pending = test.canUseTool('Bash', { command: 'npm publish' }, options());
    test.abort.abort();
    await expect(pending).resolves.toEqual({
      behavior: 'deny',
      message: 'the run ended while this tool call was waiting for approval.',
    });
  });

  it('denies immediately when the run has already ended', async () => {
    const test = harness('never-answers');
    test.abort.abort();
    await expect(
      test.canUseTool('Bash', { command: 'npm publish' }, options()),
    ).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('denies when the approval channel throws, without quoting the error to the model', async () => {
    const test = harness('throws');
    const result = await test.canUseTool('Bash', { command: 'npm publish' }, options());
    expect(result).toEqual({
      behavior: 'deny',
      message: 'the approval channel failed, so the platform denied the tool call.',
    });
    expect(JSON.stringify(result)).not.toContain('glpat-FAKE000000000000000');
  });

  it('passes the run’s deadline and abort signal to the port', async () => {
    const test = harness({ decision: 'allow', reason: 'ok', questionId: null });
    await test.canUseTool('Bash', { command: 'npm publish' }, options());
    const request = test.approvals.requests[0];
    expect(request?.timeoutMs).toBe(60_000);
    expect(request?.detail).toBe('npm publish');
    expect(request?.signal).toBe(test.abort.signal);
  });
});
