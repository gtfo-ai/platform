/**
 * The restricted frontmatter grammar, and every spelling it refuses.
 *
 * The refusals are the point of the file. A parser that *guesses* what a malformed block meant puts
 * the guess into a context pack and then into a prompt, so each case below asserts `malformed` and
 * the **line** — an author who is told "line 4" fixes it, and an author who is told "invalid
 * frontmatter" opens a ticket.
 */
import { describe, expect, it } from 'vitest';
import { readFrontmatter } from './frontmatter.js';

const parse = (source: string) => readFrontmatter(source);

describe('readFrontmatter — the three outcomes', () => {
  it('reports "absent" for a document with no fence, and keeps the body intact', () => {
    const result = parse('# Overview\n\nA page with no frontmatter at all.\n');
    expect(result.kind).toBe('absent');
    if (result.kind !== 'absent') throw new Error('expected absent');
    expect(result.body).toContain('# Overview');
  });

  it('reports "present" with no fields for an empty block, which is not the same as absent', () => {
    const result = parse('---\n---\n\n# Body\n');
    expect(result.kind).toBe('present');
    if (result.kind !== 'present') throw new Error('expected present');
    expect(result.fields).toEqual({});
    expect(result.body.trim()).toBe('# Body');
  });

  it('does not read a horizontal rule further down the page as frontmatter', () => {
    const result = parse('# Title\n\n---\n\nkind: technical\n\n---\n');
    expect(result.kind).toBe('absent');
  });
});

describe('readFrontmatter — the grammar it accepts', () => {
  it('reads scalars, quoted strings, flow sequences and block sequences', () => {
    const result = parse(
      [
        '---',
        'id: L-2026-01-04-x',
        'title: "Session tests need a seeded fixture"',
        "trigger: 'running tests'",
        'paths: ["src/api/**", "src/api/session.ts"]',
        'evidence:',
        '  - task:DEMO-11',
        '  - run:8f3c1',
        'confidence: confirmed',
        'tokens: 42',
        'blocking: true',
        '# a comment line',
        'empty:',
        '---',
        'body',
      ].join('\n'),
    );
    expect(result.kind).toBe('present');
    if (result.kind !== 'present') throw new Error('expected present');
    expect(result.fields).toEqual({
      id: 'L-2026-01-04-x',
      title: 'Session tests need a seeded fixture',
      trigger: 'running tests',
      paths: ['src/api/**', 'src/api/session.ts'],
      evidence: ['task:DEMO-11', 'run:8f3c1'],
      confidence: 'confirmed',
      tokens: 42,
      blocking: true,
      empty: [],
    });
    expect(result.body).toBe('body');
  });

  it('strips a trailing comment only when whitespace precedes the hash', () => {
    const result = parse('---\na: value  # note\nb: has#hash\n---\n');
    if (result.kind !== 'present') throw new Error('expected present');
    expect(result.fields).toEqual({ a: 'value', b: 'has#hash' });
  });

  it('leaves YAML 1.1 booleans as strings rather than guessing', () => {
    const result = parse('---\nstatus: on\nother: yes\n---\n');
    if (result.kind !== 'present') throw new Error('expected present');
    expect(result.fields).toEqual({ status: 'on', other: 'yes' });
  });
});

describe('readFrontmatter — refusals, each with its line', () => {
  it.each([
    ['a fence that never closes', '---\nkind: technical\n', 1],
    ['a nested mapping', '---\nkind: technical\nnested:\n  key: value\n---\n', 4],
    ['an inline mapping', '---\nnested: { key: value }\n---\n', 2],
    ['a tab', '---\nkind:\tvalue\n---\n', 2],
    ['a block scalar', '---\nbody: |\n  text\n---\n', 2],
    ['an anchor', '---\na: &anchor value\n---\n', 2],
    ['an alias', '---\na: *anchor\n---\n', 2],
    ['a duplicate key', '---\nkind: technical\nkind: business\n---\n', 3],
    ['an unterminated quoted string', '---\ntitle: "unclosed\n---\n', 2],
    ['an unterminated flow sequence', '---\npaths: ["a", "b"\n---\n', 2],
    ['a sequence item with no key', '---\n  - orphan\n---\n', 2],
    ['a line that is neither', '---\njust some prose\n---\n', 2],
  ])('refuses %s and names the line', (_name, source, line) => {
    const result = parse(source);
    expect(result.kind).toBe('malformed');
    if (result.kind !== 'malformed') throw new Error('expected malformed');
    expect(result.line).toBe(line);
    expect(result.reason).not.toBe('');
  });

  it('refuses a duplicate key spelled as an Object.prototype member', () => {
    // `key in fields` would read `constructor` as already present on the very first occurrence and
    // refuse a perfectly legal document; `Object.hasOwn` is the question being asked (rule 38).
    const first = parse('---\nconstructor: a\n---\n');
    expect(first.kind).toBe('present');
    const second = parse('---\nconstructor: a\nconstructor: b\n---\n');
    expect(second.kind).toBe('malformed');
  });
});
