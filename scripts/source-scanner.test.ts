/**
 * The comment stripper every source census reads through (PROGRESS backlogs 261 and 269). Until
 * WP-96 five read it by import and four kept a line-by-line copy — six, counted when the copies
 * were removed, plus a seventh that still used the block-comment regex; since WP-96 there is one,
 * `source-scanner.mjs`, and the census at the end of this file refuses a second.
 *
 * Each case is a place a `/*` or a `//` sits **outside** a comment, where the regex this replaced
 * opened a pseudo-comment and deleted the code after it up to the next real `*\/`. The code after
 * the trap is what each case asserts survives; the comment beside it is what must not.
 */
import { describe, expect, it } from 'vitest';
import { censusPaths, censusText } from './census-files.mjs';
import { withoutComments } from './source-scanner.mjs';

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

/**
 * The case the line-by-line copies got wrong (WP-96, backlog 269): a `//` inside a string on a line
 * that also carries code. Each copy cut the line at the first `//`, so the call after it vanished —
 * a false negative in a census of what must be **absent**. Each former copy's own file plants the
 * same line against its own pattern; this is the scanner's half.
 */
describe('a `//` inside a string on a line of code (backlog 269)', () => {
  it('keeps the code after a URL in a single-quoted, double-quoted or template string', () => {
    expect(code("const url = 'https://x'; tasks.save(tx, t);")).toEqual([
      "const url = 'https://x'; tasks.save(tx, t);",
    ]);
    expect(code('const url = "https://x"; escalateTask(t); // but not this')).toEqual([
      'const url = "https://x"; escalateTask(t);',
    ]);
    expect(code('const url = `https://${host}/`; new DockerEngine(); /* nor this */')).toEqual([
      'const url = `https://${host}/`; new DockerEngine();',
    ]);
  });

  it('keeps a line that opens with `*` when it is code, not a docblock', () => {
    // A continued multiplication: a copy dropped any line opening with `*`.
    expect(code('const area = width\n  * compilePipeline(a, b, c);')).toEqual([
      'const area = width',
      '* compilePipeline(a, b, c);',
    ]);
  });
});

/**
 * **A comment stripper by its shape, not its name** (WP-96 review round 1). The name census below
 * missed `apps/web/src/no-html.test.ts`'s `stripBlockComments` — 261's regex, under another name —
 * and two line filters (`operating-mode.test.tsx`, `human-commands.test.ts`) that dropped lines
 * opening with a comment marker. So this reads every source (tracked and untracked, rule 85), with
 * its comments removed by the scanner, for four shapes a hand-rolled stripper needs:
 *
 *  - `slashStar`: a regular expression that matches `/*` (the text `\/\*`);
 *  - `slashSlash`: one that matches `//` not after a `:` (so `https?:\/\/` is not one);
 *  - `probe`: `startsWith`/`indexOf`/`includes`/`endsWith`/`split` handed `'//'`, `'/*'` or `'*'`;
 *  - `chars`: a comparison of one character with `'/'` — how a scanner walks.
 *
 * Every file with a shape is in {@link SHAPED}, with what the shape is really doing, both
 * directions. **What it cannot see, stated**: a stripper that builds its pattern at run time
 * (`new RegExp('\\/' + '\\*')`), one that compares char codes (`=== 47`), or one that calls a
 * library; and a file already listed that gains a second, real stripper beside its listed use.
 * This file is out of its own scope by name, because its patterns are the shapes (rule 59).
 */
describe('a comment stripper is recognised by its shape', () => {
  const ROOT = new URL('..', import.meta.url).pathname;
  const SHAPES: Readonly<Record<string, RegExp>> = {
    slashStar: /\\\/\\\*/,
    slashSlash: /(?<!:)\\\/\\\//,
    probe: /(?:startsWith|indexOf|includes|split|endsWith)\(\s*(['"`])(?:\/\/|\/\*|\*)\1/,
    chars: /===\s*'\/'/,
  };
  const SHAPED: Readonly<Record<string, string>> = {
    'scripts/source-scanner.mjs chars': 'the scanner itself',
    'scripts/check-data-model.mjs chars':
      "a **SQL** stripper (`--`, block comments, `'…'` literals) for the migrations — another language than the scanner reads (WP-97)",
    'apps/web/src/app/shell.tsx chars': "a route comparison, `item.to === '/'`",
    'apps/web/src/routes/redirect.ts probe':
      "refuses a protocol-relative redirect, `startsWith('//')`",
    'packages/domain/src/knowledge/frontmatter.ts probe': "a YAML alias, `startsWith('*')`",
    'packages/infrastructure/src/workspace/tracked.ts probe':
      "a path with an empty segment, `includes('//')`",
    'packages/application/src/pipeline/config-refusal-readers.test.ts probe':
      'whether the one line holding a settings read opens with a comment marker — a context check on a call, not a stripper',
    'packages/infrastructure/src/pipeline/tasks-column-ownership.test.ts probe':
      'whether the one line holding a SQL match opens with a comment marker — a context check on a statement, not a stripper',
    'packages/domain/src/knowledge/globs.ts slashStar': 'a trailing `/**` glob',
    'packages/domain/src/policies/path-patterns.ts slashStar': 'a trailing `/**` glob',
    'scripts/release.test.ts slashStar': 'a trailing `/**` in a CODEOWNERS row',
    'scripts/citations.ts slashSlash':
      'the decoration of a comment line a citation may sit on — it reads prose in comments on purpose',
    'apps/launcher/src/runtime.test.ts slashSlash':
      'the third slash of `unix:///path` in an error message',
  };

  it('finds exactly the listed shapes, in both directions', () => {
    const found = censusPaths(ROOT, { pathspecs: ['*.ts', '*.tsx', '*.mjs', '*.js'] })
      .filter((path) => path !== 'scripts/source-scanner.test.ts')
      .flatMap((path) => {
        const code = withoutComments(censusText(ROOT, path));
        return Object.entries(SHAPES)
          .filter(([, shape]) => shape.test(code))
          .map(([name]) => `${path} ${name}`);
      });
    expect(found.toSorted()).toEqual(Object.keys(SHAPED).toSorted());
  });

  it('would see each stripper this round replaced', () => {
    const shapesOf = (code: string) =>
      Object.entries(SHAPES)
        .filter(([, shape]) => shape.test(code))
        .map(([name]) => name);
    expect(shapesOf(String.raw`source.replace(/\/\*[\s\S]*?\*\//g, ' ')`)).toContain('slashStar');
    expect(shapesOf(String.raw`.filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))`)).toContain(
      'slashStar',
    );
    expect(shapesOf("const comment = line.indexOf('//');")).toEqual(['probe']);
    expect(shapesOf(String.raw`/^\s*\/\//.test(line)`)).toEqual(['slashSlash']);
    expect(shapesOf(String.raw`/https?:\/\/[^\s]+/`)).toEqual([]);
  });
});

/**
 * **One stripper** (WP-96, backlog 269, standing rule 7): no source outside this module defines a
 * function named `withoutComments`, the name all six former copies used. Read off git's tree,
 * tracked and untracked (rule 85), through the scanner itself so prose naming it is not a copy.
 * What it cannot see, stated: a copy under another name, which a reviewer still has to catch.
 */
describe('the stripper is defined once', () => {
  const ROOT = new URL('..', import.meta.url).pathname;
  const DEFINES = /\b(?:const|let|var|function)\s+withoutComments\b/;

  it('is defined in scripts/source-scanner.mjs and nowhere else', () => {
    const definers = censusPaths(ROOT, { pathspecs: ['*.ts', '*.tsx', '*.mjs', '*.js'] }).filter(
      (path) => DEFINES.test(withoutComments(censusText(ROOT, path))),
    );
    expect(definers).toEqual(['scripts/source-scanner.mjs']);
  });

  it('would see a copy: the pattern matches the spelling the copies used', () => {
    // Assembled, so this file's own plant is not a definition in its own census (rule 59).
    expect(DEFINES.test(`${'const'} withoutComments = (source: string): string =>`)).toBe(true);
    expect(DEFINES.test('// a docblock that names withoutComments')).toBe(false);
  });
});
