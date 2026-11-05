/**
 * The worker page's argument summary (review of PR #30): what a tool call is about as plain text —
 * its path, its command or its query — never its raw JSON input.
 */
import { describe, expect, it } from 'vitest';
import { argumentSummaryOf } from './model.js';

describe('argumentSummaryOf', () => {
  it.each([
    ['a file path', { file_path: 'src/a.ts', limit: 20 }, 'src/a.ts'],
    ['a path', { path: 'docs/', recursive: true }, 'docs/'],
    ['a command, one line', { command: 'pnpm test\n  --run', timeout: 60 }, 'pnpm test --run'],
    ['a grep pattern', { pattern: 'TODO', path: '' }, 'TODO'],
    ['a query', { query: 'login bug' }, 'login bug'],
    ['a URL', { url: 'https://example.test/x', prompt: 'read it' }, 'https://example.test/x'],
    ['another string field', { include: 3, note: 'the ticket' }, 'the ticket'],
    ['nothing a person reads', { include: 3, nested: { a: 1 } }, ''],
  ] as const)('reads %s', (_name, input, expected) => {
    expect(argumentSummaryOf(input)).toBe(expected);
  });

  it('cuts a long one at 160 characters, and says so', () => {
    const summary = argumentSummaryOf({ command: 'x'.repeat(400) });
    expect(summary).toHaveLength(160);
    expect(summary.endsWith('…')).toBe(true);
  });
});
