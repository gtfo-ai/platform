/**
 * The LogQL boundary (technical/10 unit tier).
 *
 * This is where BD-022 meets a query language: a `selector` is validated because it is an
 * expression, a `filter` is escaped because it is a literal, and the difference is the whole
 * security property. Every case below is a claim about one of the two.
 */
import { describe, expect, it } from 'vitest';
import { buildRangeQuery, escapeLogQLString, parseStreamSelector } from './logql.js';

const parse = (selector: string) => parseStreamSelector(selector, 'query_range');

describe('parseStreamSelector', () => {
  it('accepts one matcher', () => {
    expect(parse('{app="api"}')).toEqual([{ name: 'app', operator: '=', value: 'api' }]);
  });

  it.each(['=', '!=', '=~', '!~'] as const)('accepts the documented %s operator', (operator) => {
    expect(parse(`{app${operator}"api"}`)[0]?.operator).toBe(operator);
  });

  it('accepts several matchers and tolerates whitespace', () => {
    expect(parse('{ app = "api" ,  env="production" }').map((matcher) => matcher.name)).toEqual([
      'app',
      'env',
    ]);
  });

  it('accepts the backtick raw-string form the documentation offers', () => {
    expect(parse('{path=~`/invoices/.*`}')[0]?.value).toBe('/invoices/.*');
  });

  /**
   * A naive `split(',')` reports a syntax error for a selector Loki accepts. Commas inside a label
   * value are not exotic — a `path` label carrying a query string has them.
   */
  it('does not split on a comma inside a quoted value', () => {
    expect(parse('{path="/a,b", app="api"}')).toEqual([
      { name: 'path', operator: '=', value: '/a,b' },
      { name: 'app', operator: '=', value: 'api' },
    ]);
  });

  it('keeps an escaped quote inside a value', () => {
    expect(parse('{msg="say \\"hi\\"", app="api"}').map((matcher) => matcher.name)).toEqual([
      'msg',
      'app',
    ]);
  });

  it.each([
    ['app = api', 'not braced at all'],
    ['{}', 'no matcher'],
    ['{   }', 'only whitespace'],
    ['{app=api}', 'an unquoted value'],
    ['{app="api"} |= "boom"', 'a line filter smuggled into the selector'],
    ['{app="api"} | json', 'a parser stage'],
    ['count_over_time({app="api"}[5m])', 'an aggregation'],
    ['{1bad="x"}', 'a label name that is not an identifier'],
  ])('refuses %s (%s)', (selector) => {
    expect(() => parse(selector)).toThrow(/invalid_request|loki/i);
  });

  it('carries the invalid_request code and names only the offending matcher', () => {
    let caught: unknown;
    try {
      parse(`{app="api", ${'x'.repeat(300)}}`);
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string })?.code).toBe('invalid_request');
    expect(
      (caught as Error).message.length,
      'an error message must not carry a page of untrusted text',
    ).toBeLessThan(300);
  });
});

describe('escapeLogQLString', () => {
  it.each([
    ['plain', 'plain'],
    ['a"b', 'a\\"b'],
    ['a\\b', 'a\\\\b'],
    ['a\nb', 'a\\nb'],
    ['a\tb', 'a\\tb'],
    ['a\rb', 'a\\rb'],
    ['a\u0000b', 'a\\x00b'],
    ['ab', 'a\\x7fb'],
  ])('escapes %j', (input, expected) => {
    expect(escapeLogQLString(input)).toBe(expected);
  });

  it('leaves non-ASCII alone, because a log line is full of it', () => {
    expect(escapeLogQLString('přišel 🙂')).toBe('přišel 🙂');
  });
});

describe('buildRangeQuery', () => {
  it('returns the selector alone when there is no filter', () => {
    expect(buildRangeQuery('{app="api"}', null)).toBe('{app="api"}');
    expect(buildRangeQuery('{app="api"}', '')).toBe('{app="api"}');
  });

  it('appends one literal line filter', () => {
    expect(buildRangeQuery('{app="api"}', 'trace-abc')).toBe('{app="api"} |= "trace-abc"');
  });

  /**
   * The injection case, stated as an assertion rather than as a comment: a filter that tries to
   * close the string and add a pipeline stage becomes a literal that matches nothing.
   */
  it('cannot be escaped out of by a filter that looks like LogQL', () => {
    expect(buildRangeQuery('{app="api"}', 'x" | json | line_format "{{.password}}')).toBe(
      '{app="api"} |= "x\\" | json | line_format \\"{{.password}}"',
    );
  });
});
