import { describe, expect, it } from 'vitest';
import { MIN_TRUNCATION_LIMIT, renderToolResponse, truncateHeadTail } from './truncation.js';

describe('truncateHeadTail', () => {
  it('leaves output at or under the cap untouched', () => {
    const result = truncateHeadTail('short', 10_000);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe('short');
    expect(result.originalLength).toBe(5);
  });

  /**
   * The named assertion the `fake-spawn` divergence register points at for entry 6: the cap is
   * reached with a body far larger than any pipe buffer, without needing backpressure to exist.
   */
  it('truncates tool output past the cap', () => {
    const body = `HEAD-MARKER${'x'.repeat(400_000)}TAIL-MARKER`;
    const result = truncateHeadTail(body, 10_000);
    expect(result.truncated).toBe(true);
    expect(result.originalLength).toBe(body.length);
    expect(result.text.length).toBe(10_000);
    expect(result.text.startsWith('HEAD-MARKER')).toBe(true);
    expect(result.text.endsWith('TAIL-MARKER')).toBe(true);
    expect(result.text).toContain('characters truncated by the platform');
  });

  it('keeps both ends, because a failing command puts the answer at the bottom', () => {
    const body = `${'a'.repeat(500)}FAILURE`;
    const result = truncateHeadTail(body, 200);
    expect(result.text).toContain('FAILURE');
    expect(result.text.startsWith('aaa')).toBe(true);
  });

  it('reports how much it removed, so the model can narrow its command', () => {
    const result = truncateHeadTail('y'.repeat(1_000), 200);
    expect(result.text).toContain('[800 characters truncated by the platform]');
  });

  it('refuses a cap so small the marker would be the whole output', () => {
    const result = truncateHeadTail('z'.repeat(1_000), 1);
    expect(result.text.length).toBe(MIN_TRUNCATION_LIMIT);
  });
});

describe('renderToolResponse', () => {
  it.each([
    ['a string', 'plain output', 'plain output'],
    ['null', null, ''],
    ['undefined', undefined, ''],
    ['an MCP content array', { content: [{ type: 'text', text: 'from mcp' }] }, 'from mcp'],
    ['an object', { rows: 2 }, '{"rows":2}'],
  ])('renders %s', (_name, input, expected) => {
    expect(renderToolResponse(input)).toBe(expected);
  });
});
