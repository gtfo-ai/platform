/**
 * A tool call as a log step (S-23.10): its title, summary, status, timing and whether it opens on
 * arrival — pure, over the reducer's own `ToolBlock`.
 */
import { describe, expect, it } from 'vitest';
import type { ToolBlock } from './blocks.js';
import {
  formatStepDuration,
  NO_RESULT,
  stepDurationMs,
  stepOpenByDefault,
  stepStatus,
  stepSummary,
  stepTiming,
  stepTitle,
} from './steps.js';

const AT = '2026-11-05T10:00:00.000Z';

const tool = (overrides: Partial<ToolBlock> = {}): ToolBlock => ({
  kind: 'tool',
  id: 't',
  seq: 1,
  at: AT,
  startedAt: AT,
  toolUseId: 'toolu_1',
  toolName: 'Read',
  input: { file_path: 'src/invoice.ts' },
  result: null,
  children: [],
  ...overrides,
});

describe('stepTitle', () => {
  it('names a platform tool in its words, and any other tool by its own name', () => {
    expect(stepTitle('mcp__platform__kb_search')).toBe('Searching the knowledge base');
    expect(stepTitle('Read')).toBe('Read');
    expect(stepTitle('mcp__sentry__issue')).toBe('mcp__sentry__issue');
  });

  it('filters and bounds a tool name the run chose', () => {
    const title = stepTitle(`evil‮${'x'.repeat(200)}`);
    expect(title).not.toContain('‮');
    expect(title.length).toBeLessThanOrEqual(64);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('a step’s line', () => {
  it('summarises the call by its first telling argument', () => {
    expect(stepSummary(tool())).toBe('src/invoice.ts');
    expect(stepSummary(tool({ input: { command: 'pnpm   test\ninvoice' } }))).toBe(
      'pnpm test invoice',
    );
    expect(stepSummary(tool({ input: {} }))).toBe('');
  });

  it('is running until a result arrives, then succeeded or failed', () => {
    expect(stepStatus(tool())).toBe('running');
    expect(stepStatus(tool({ result: { isError: false, content: '' } }))).toBe('success');
    expect(stepStatus(tool({ result: { isError: true, content: '' } }))).toBe('failure');
  });

  // S-25.19: an ended run's unanswered call will never be answered.
  it('reads a call an ended run never answered as no result, never running', () => {
    expect(stepStatus(tool(), true)).toBe('skipped');
    expect(stepTiming(tool(), true)).toBe(NO_RESULT);
    expect(NO_RESULT).toBe('no result');
    // An answered call reads the same whether the run ended or not.
    expect(stepStatus(tool({ result: { isError: true, content: '' } }), true)).toBe('failure');
    expect(
      stepTiming(
        tool({ at: '2026-11-05T10:01:04.200Z', result: { isError: false, content: '' } }),
        true,
      ),
    ).toBe('1m 04s');
  });

  it('times the call from its own row to its result’s', () => {
    const done = tool({ at: '2026-11-05T10:01:04.200Z', result: { isError: false, content: '' } });
    expect(stepDurationMs(done)).toBe(64_200);
    expect(stepTiming(done)).toBe('1m 04s');
    expect(stepDurationMs(tool())).toBeNull();
    expect(stepTiming(tool())).toBe('running');
    // An instant that cannot be read says nothing rather than a wrong figure.
    expect(stepTiming(tool({ startedAt: 'never', result: { isError: false, content: '' } }))).toBe(
      '',
    );
  });

  it('formats a duration the way an Actions step does', () => {
    expect(formatStepDuration(0)).toBe('0.0s');
    expect(formatStepDuration(240)).toBe('0.2s');
    expect(formatStepDuration(9_940)).toBe('9.9s');
    expect(formatStepDuration(12_400)).toBe('12s');
    expect(formatStepDuration(64_000)).toBe('1m 04s');
    expect(formatStepDuration(3_720_000)).toBe('1h 02m');
  });

  it('opens on arrival while running or after a failure, and is collapsed otherwise', () => {
    expect(stepOpenByDefault(tool())).toBe(true);
    expect(stepOpenByDefault(tool({ result: { isError: true, content: 'boom' } }))).toBe(true);
    expect(stepOpenByDefault(tool({ result: { isError: false, content: 'ok' } }))).toBe(false);
  });
});
