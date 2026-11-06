/**
 * The worker page's argument summary (review of PR #30): what a tool call is about as plain text —
 * its path, its command or its query — never its raw JSON input.
 */
import { CLAUDE_OAUTH_TOKEN_SHAPE, normaliseClaudeToken } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { argumentSummaryOf, normalisePastedToken, PASTED_TOKEN_SHAPE } from './model.js';

describe('the pasted token’s shape and normalisation, held to the contract', () => {
  it('is the contract’s shape, and normalises as the worker does', () => {
    expect(PASTED_TOKEN_SHAPE.source).toBe(CLAUDE_OAUTH_TOKEN_SHAPE.source);
    expect(PASTED_TOKEN_SHAPE.flags).toBe(CLAUDE_OAUTH_TOKEN_SHAPE.flags);
    const token = `sk-ant-oat01-${'F'.repeat(95)}`;
    for (const pasted of [token, ` ${token.slice(0, 79)}\r\n\t  ${token.slice(79)} `, ' \n ']) {
      expect(normalisePastedToken(pasted)).toBe(normaliseClaudeToken(pasted));
    }
    expect(normalisePastedToken(`  ${token.slice(0, 79)}\n    ${token.slice(79)}\n`)).toBe(token);
  });
});

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
