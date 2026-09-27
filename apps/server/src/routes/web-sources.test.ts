/**
 * The comment stripper nine source guards read through — five by import, and the shape the other
 * four copy (PROGRESS backlog 261).
 *
 * Each case is a place a `/*` or a `//` sits **outside** a comment, where the regex this replaced
 * opened a pseudo-comment and deleted the code after it up to the next real `*\/`. The code after
 * the trap is what each case asserts survives; the comment beside it is what must not.
 */
import { describe, expect, it } from 'vitest';
import { withoutComments } from './web-sources.js';

const code = (source: string): string[] =>
  withoutComments(source)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

describe('withoutComments', () => {
  it('keeps the code after a `/*` inside a string literal', () => {
    const source = [
      "const patterns = ['agentic/*'];",
      'tasks.save(tx, task);',
      '/** a docblock */',
      'export const after = 1;',
    ].join('\n');
    expect(code(source)).toEqual([
      "const patterns = ['agentic/*'];",
      'tasks.save(tx, task);',
      'export const after = 1;',
    ]);
  });

  it('keeps the code after a `/*` inside a `//` line comment', () => {
    const source = ['// names `/webhooks/*`', 'const heldConnections = 1;', '/* real */'].join(
      '\n',
    );
    expect(code(source)).toEqual(['const heldConnections = 1;']);
  });

  it('keeps the code after a `/*` inside a trailing comment, and drops the comment', () => {
    const source = [
      "const url = '/api'; // serves /api/auth/*",
      'const shadow = 2;',
      '/** x */',
    ].join('\n');
    expect(code(source)).toEqual(["const url = '/api';", 'const shadow = 2;']);
  });

  it('keeps a `//` or a `/*` inside a template literal and its interpolations', () => {
    const source = [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the template is the input under test.
      'const u = `https://${host}/api/*/${`x//${y}`}`; // gone',
      'const next = 3;',
    ].join('\n');
    expect(code(source)).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the expected output is the same text.
      'const u = `https://${host}/api/*/${`x//${y}`}`;',
      'const next = 3;',
    ]);
  });

  it('keeps a double-quoted string and a regex character class that hold `/*`', () => {
    const source = [
      'const glob = "src/*/index.ts";',
      'const either = /[/*]/;',
      'export const after = 1;',
    ].join('\n');
    expect(code(source)).toEqual([
      'const glob = "src/*/index.ts";',
      'const either = /[/*]/;',
      'export const after = 1;',
    ]);
  });

  it('keeps a regular-expression literal that contains `/*` or `//`', () => {
    const source = [
      'const block = /\\/\\*[\\s\\S]*?\\*\\//g;',
      'return /https?:\\/\\//.test(x);',
      'const half = a / b / c; // divided',
    ].join('\n');
    expect(code(source)).toEqual([
      'const block = /\\/\\*[\\s\\S]*?\\*\\//g;',
      'return /https?:\\/\\//.test(x);',
      'const half = a / b / c;',
    ]);
  });

  it('keeps every newline of a removed block comment, so line numbers survive', () => {
    const source = ['/**', ' * two', ' */', 'const third = 3;'].join('\n');
    expect(withoutComments(source).split('\n')).toEqual(['', '', '', 'const third = 3;']);
  });
});
