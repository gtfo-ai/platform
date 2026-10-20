import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROCESS_SUITES } from '../vitest.config.js';
import { censusFiles } from './census-files.mjs';
import { matchingClose } from './git-spawn-sites.js';
import { withoutComments } from './source-scanner.mjs';

/**
 * **A test case that walks the whole tree carries its own timeout** (WP-249, PROGRESS backlog 649).
 *
 * A census case lists every file git knows about and reads them. On a loaded CI runner that takes
 * seconds — `default-branch-readers.test.ts` timed out at 5101 ms on `ci` `39403396684` against
 * 546 ms locally — so a commit that changed nothing the case reads went red. The remedy ruled for
 * WP-249 is an explicit timeout beside each such case (at least 2× its slowest measured CI duration
 * and no less than 15 s, with a one-line reason citing the figure), never a raised global
 * `testTimeout`. This census is what keeps a new walk case from forgetting it.
 *
 * **A walker** is discovered from disk: an exported `const`/`function` of a non-test module that
 * mentions `census-files` or `ls-files` and whose body, expanded through that module's own
 * declarations, reaches the literal `'ls-files'` or another walker — so `censusPaths` (it spawns
 * `git ls-files`), `censusFiles`, `webSourceFiles`, `gitSpawnSites`, `propertyFiles` and the rest
 * are found rather than listed. **A walk case** is an `it`/`test` call (or a `beforeAll`/`beforeEach`
 * hook) in a `*.test.ts(x)` file whose callback, expanded the same way through the test file's own
 * declarations, names a walker or the literal `'ls-files'` **and** names the repository root — an
 * identifier the file binds to `import.meta.dirname`, `import.meta.url` or `process.cwd()`, or
 * imports as `repositoryRoot`. A case that walks only a scratch repository it built is fast and is
 * not one. **It is admitted** when it carries a timeout of at least 15 000 ms, as the third
 * argument or as `{ timeout: … }`: a numeric literal, or a name the file binds to one.
 *
 * **What it cannot see**, stated rather than implied:
 * - a walk reached through a helper in **another** module that is not itself a walker by the rule
 *   above (a test support file that calls `censusPaths` and is imported by a test), and a module
 *   that wraps a walker of a module it imports without mentioning `census-files` or `ls-files`;
 * - `it.each(…)(…)`, `it.for(…)(…)` and `describe(…, { timeout })` — no census uses them, and a
 *   describe-level timeout is not beside the case;
 * - a destructured binding (`const { a } = …`), a binding re-assigned later, and a name declared in
 *   two scopes of one file: declarations are matched by name across the whole file, not per scope,
 *   and the first binding wins — for a walker name that over-asks, but for a timeout name it can
 *   admit the wrong (shorter) value (measured at review, WP-249);
 * - an import alias (`censusPaths as walkTree`): the call is matched by the walker's own name, so an
 *   aliased walk is not seen;
 * - a `readdirSync` walk: only `census-files` and `ls-files` walks are walkers here;
 * - a timeout computed (`20 * 1000`) or imported: only a numeric literal, or a name this file binds
 *   to one, is read, so such a case is refused rather than guessed at;
 * - a regular-expression literal holding an unbalanced bracket: the bracket matcher skips strings
 *   and templates, not regular expressions;
 * - a `git ls-files` inside a shell string or a command name held in a variable;
 * - whether the cited figure is true: the ≥ 2× rule is the reviewer's, against the table in the
 *   WP-249 notes.
 */

const MINIMUM_TIMEOUT_MS = 15_000;
const LS_FILES = /['"`]ls-files['"`]/;
/**
 * An expression that names this checkout: a directory resolved from the test file's own location,
 * or the working directory. A file path beside the test (`new URL('./x.ts', import.meta.url)`) is
 * not one.
 */
const ROOT_EXPRESSION =
  /import\.meta\.dirname|process\.cwd\(\)|new URL\(\s*['"]\.\.[./]*['"]\s*,\s*import\.meta\.url|dirname\(\s*fileURLToPath\(\s*import\.meta\.url/;

/** The index just past the string or template that opens at `start`. */
const skipString = (source: string, start: number): number => {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length && source[index] !== quote) {
    if (source[index] === '\\') index += 2;
    else if (quote === '`' && source.startsWith('${', index))
      index = matchingClose(source, index + 1);
    else index += 1;
  }
  return index + 1;
};

/**
 * `source` with every regular-expression literal's body blanked to spaces, so a bracket inside one
 * (`/\bsave\s*\(/g`) does not unbalance the matcher. Offsets and newlines are kept. A `/` is read
 * as a literal's start after an operator, a bracket, a comma or the start, and after `return`.
 */
const blankRegularExpressions = (source: string): string => {
  let output = '';
  let index = 0;
  let previous = '';
  while (index < source.length) {
    const char = source[index] as string;
    if (`'"\``.includes(char)) {
      const end = skipString(source, index);
      output += source.slice(index, end);
      index = end;
      previous = char;
    } else if (
      char === '/' &&
      (/^$|[(,=:[!&|?{};+\-*%<>~^]$/.test(previous) || /\breturn$/.test(output.trimEnd()))
    ) {
      let end = index + 1;
      let inClass = false;
      while (end < source.length && source[end] !== '\n') {
        const next = source[end] as string;
        if (next === '\\') end += 1;
        else if (next === '[') inClass = true;
        else if (next === ']') inClass = false;
        else if (next === '/' && !inClass) break;
        end += 1;
      }
      output += `/${' '.repeat(end - index - 1)}/`;
      index = end + 1;
      previous = '/';
    } else {
      output += char;
      index += 1;
      if (!/\s/.test(char)) previous = char;
    }
  }
  return output;
};

/** The index just past the statement that runs from `from`, or at the block that encloses it. */
const statementEnd = (source: string, from: number): number => {
  let index = from;
  while (index < source.length) {
    const char = source[index] as string;
    if ('([{'.includes(char)) index = matchingClose(source, index);
    else if (`'"\``.includes(char)) index = skipString(source, index);
    else if (char === ';') return index + 1;
    else if (char === ')' || char === '}' || char === ']') return index;
    else index += 1;
  }
  return index;
};

interface Declaration {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  /** A function, so its body runs when it is called — not a value computed while the file loads. */
  readonly callable: boolean;
}

interface Declared {
  readonly text: string;
  readonly callable: boolean;
  /** A function's parameter names, which shadow the file's declarations inside its body. */
  readonly parameters: ReadonlySet<string>;
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/** The identifiers of the first parenthesised list in `text` (a function's parameters). */
const parametersOf = (text: string): Set<string> => {
  const open = text.indexOf('(');
  return new Set(
    open < 0 ? [] : (text.slice(open, matchingClose(text, open)).match(IDENTIFIER) ?? []),
  );
};

/**
 * The `const`/`let`/`function` declarations of the source that are not inside another one, by
 * name, with their text — the module's and its `describe` blocks', never a function's locals.
 */
const declarations = (
  source: string,
  outside: readonly Declaration[] = [],
): Map<string, Declared[]> => {
  const all: Declaration[] = [];
  for (const match of source.matchAll(/\b(?:const|let)\s+(\w+)\b[^=;]*=/g)) {
    const start = match.index ?? 0;
    const initializer = start + match[0].length;
    all.push({
      name: match[1] as string,
      start,
      end: statementEnd(source, initializer),
      callable: isCallback(source.slice(initializer).trimStart()),
    });
  }
  for (const match of source.matchAll(/\bfunction\s*\*?\s*(\w+)\s*(?:<[^>(]*>)?\s*\(/g)) {
    const start = match.index ?? 0;
    const paramsEnd = matchingClose(source, start + match[0].length - 1);
    const body = source.indexOf('{', paramsEnd);
    all.push({
      name: match[1] as string,
      start,
      end: body < 0 ? paramsEnd : matchingClose(source, body),
      callable: true,
    });
  }
  const enclosing = [...all, ...outside];
  const found = new Map<string, Declared[]>();
  for (const { name, start, end, callable } of all) {
    if (enclosing.some((other) => other.start < start && start < other.end)) continue;
    const text = source.slice(start, end);
    const parameters = callable ? parametersOf(text) : new Set<string>();
    found.set(name, [...(found.get(name) ?? []), { text, callable, parameters }]);
  }
  return found;
};

/**
 * `text` and every declaration it reaches through `declared`, transitively. With `callableOnly`,
 * only functions are followed: a value is computed once while the file loads, outside any case.
 */
const reachedText = (
  text: string,
  declared: ReadonlyMap<string, Declared[]>,
  callableOnly = false,
): string => {
  const seen = new Set<string>();
  const parts: { text: string; parameters: ReadonlySet<string> }[] = [
    { text, parameters: new Set() },
  ];
  for (let index = 0; index < parts.length; index += 1) {
    const { text: part, parameters } = parts[index] as (typeof parts)[number];
    for (const identifier of part.match(IDENTIFIER) ?? []) {
      if (seen.has(identifier) || parameters.has(identifier) || !declared.has(identifier)) continue;
      seen.add(identifier);
      for (const found of declared.get(identifier) as Declared[]) {
        if (found.callable || !callableOnly) parts.push(found);
      }
    }
  }
  return parts.map((part) => part.text).join('\n');
};

const namesOne = (text: string, names: ReadonlySet<string>): boolean =>
  (text.match(IDENTIFIER) ?? []).some((identifier) => names.has(identifier));

interface Walkers {
  /** Exported names that reach `git ls-files`. */
  readonly walkers: Set<string>;
  /** Exported names whose own text names this checkout (`repositoryRoot`, `webSourceFiles`). */
  readonly rooted: Set<string>;
}

/** The exported names of `modules` that walk, and that name this checkout, to a fixpoint. */
const discoverWalkers = (modules: readonly { contents: string }[]): Walkers => {
  const walkers = new Set<string>();
  const rooted = new Set<string>();
  const parsed = modules.map(({ contents }) => {
    const source = blankRegularExpressions(withoutComments(contents));
    const exported = [
      ...source.matchAll(/\bexport\s+(?:async\s+)?(?:const|let|function\s*\*?)\s*(\w+)/g),
    ].map((match) => match[1] as string);
    return { exported, declared: declarations(source) };
  });
  for (let grew = true; grew; ) {
    grew = false;
    for (const { exported, declared } of parsed) {
      for (const name of exported.filter((exportedName) => declared.has(exportedName))) {
        const reached = reachedText(
          (declared.get(name) as Declared[]).map(({ text }) => text).join('\n'),
          declared,
        );
        if (!walkers.has(name) && (LS_FILES.test(reached) || namesOne(reached, walkers))) {
          walkers.add(name);
          grew = true;
        }
        if (!rooted.has(name) && (ROOT_EXPRESSION.test(reached) || namesOne(reached, rooted))) {
          rooted.add(name);
          grew = true;
        }
      }
    }
  }
  return { walkers, rooted };
};

/** The top-level arguments of the call whose parenthesis opens at `open`. */
const callArguments = (source: string, open: number): string[] => {
  const close = matchingClose(source, open) - 1;
  const args: string[] = [];
  let start = open + 1;
  let index = start;
  while (index < close) {
    const char = source[index] as string;
    if ('([{'.includes(char)) index = matchingClose(source, index);
    else if (`'"\``.includes(char)) index = skipString(source, index);
    else if (char === ',') {
      args.push(source.slice(start, index).trim());
      index += 1;
      start = index;
    } else index += 1;
  }
  const last = source.slice(start, close).trim();
  if (last.length > 0) args.push(last);
  return args;
};

const isCallback = (arg: string): boolean =>
  /^(?:async\s+)?(?:function\b|\([\s\S]*?\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)/.test(arg);

/**
 * The milliseconds an argument states: a numeric literal, `{ timeout: … }`, or a name the file
 * binds to a numeric literal (`const WHOLE_TREE_TIMEOUT_MS = 30_000;`).
 */
const timeoutOf = (arg: string, declared: ReadonlyMap<string, Declared[]>): number | undefined => {
  const value = /^(?:\{[\s\S]*\btimeout\s*:\s*)?([\w$]+)\s*,?\s*\}?$/.exec(arg)?.[1];
  if (value === undefined) return undefined;
  const literal = /^\d[\d_]*$/.test(value)
    ? value
    : declared
        .get(value)
        ?.map(({ text }) => /=\s*(\d[\d_]*)\s*;?$/.exec(text)?.[1])
        .find((bound) => bound !== undefined);
  return literal === undefined ? undefined : Number(literal.replaceAll('_', ''));
};

interface WalkCase {
  readonly path: string;
  readonly line: number;
  readonly name: string;
  /** The explicit timeout in milliseconds, when the case carries a numeric literal one. */
  readonly timeout: number | undefined;
}

const CASE_CALL = /(?<![\w$.])(it|test|beforeAll|beforeEach)((?:\.[\w$]+)*)\s*\(/g;

/** Every case and hook in `contents` that walks the repository's whole tree. */
const walkCases = (path: string, contents: string, { walkers, rooted }: Walkers): WalkCase[] => {
  const source = blankRegularExpressions(withoutComments(contents));
  const calls = [...source.matchAll(CASE_CALL)]
    .filter((match) => !/\.(?:each|for)\b/.test(match[2] as string))
    .map((match) => {
      const open = (match.index ?? 0) + match[0].length - 1;
      return { kind: match[1] as string, open, args: callArguments(source, open) };
    });
  const insideCases = calls.map(({ open }) => ({
    name: '',
    start: open,
    end: matchingClose(source, open),
    callable: true,
  }));
  const declared = declarations(source, insideCases);
  const cases: WalkCase[] = [];
  for (const { kind, open, args } of calls) {
    const callback = args.find(isCallback);
    if (callback === undefined) continue;
    const called = reachedText(callback, declared, true);
    const reached = reachedText(callback, declared);
    const walks = LS_FILES.test(called) || namesOne(called, walkers);
    const atRoot = ROOT_EXPRESSION.test(reached) || namesOne(reached, rooted);
    if (!walks || !atRoot) continue;
    const isHook = kind.startsWith('before');
    cases.push({
      path,
      line: source.slice(0, open).split('\n').length,
      name: isHook ? kind : (args[0] ?? '').slice(0, 100),
      timeout: args
        .slice(1)
        .filter((arg) => arg !== callback)
        .map((arg) => timeoutOf(arg, declared))
        .find((value) => value !== undefined),
    });
  }
  return cases;
};

const REPOSITORY_ROOT = join(import.meta.dirname, '..');
const SOURCE = /\.(?:ts|tsx|mts|mjs|js)$/;
const TEST_FILE = /\.test\.tsx?$/;

/**
 * The files run under vitest's 5 s default: every test file but the projects that set a bound of
 * their own — `process` (120 s), `integration` (120 s) and `e2e-fake-claude` (180 s).
 */
const underDefaultTimeout = (path: string): boolean =>
  TEST_FILE.test(path) &&
  !PROCESS_SUITES.includes(path) &&
  !/\.(?:integration|e2e)\.test\.ts$/.test(path) &&
  !/^test\/(?:integration|e2e)\//.test(path);

const unadmitted = (cases: readonly WalkCase[]): string[] =>
  cases
    .filter((walk) => walk.timeout === undefined || walk.timeout < MINIMUM_TIMEOUT_MS)
    .map((walk) => `${walk.path}:${walk.line} ${walk.name} (timeout ${walk.timeout ?? 'none'})`);

describe('every whole-tree census case carries its own timeout (WP-249)', () => {
  // WP-249: a new case with no CI figure yet; 1.0–1.3 s locally, so the 15 s floor.
  it('finds no walk case in this repository without an explicit timeout of at least 15 s', () => {
    const sources = censusFiles(REPOSITORY_ROOT, {
      include: (path) => SOURCE.test(path) && !path.startsWith('node_modules/'),
    });
    const found = discoverWalkers(
      sources.filter(
        ({ path, contents }) =>
          !TEST_FILE.test(path) && (contents.includes('census-files') || LS_FILES.test(contents)),
      ),
    );
    // An anchor (standing rule 10): the discovery must find the helper every census calls.
    expect([...found.walkers]).toEqual(expect.arrayContaining(['censusPaths', 'censusFiles']));
    const cases = sources
      .filter(({ path }) => underDefaultTimeout(path))
      .flatMap(({ path, contents }) => walkCases(path, contents, found));
    // And the census this row exists for must be among the cases found.
    expect(cases.map((walk) => walk.path)).toContain(
      'packages/application/src/pipeline/default-branch-readers.test.ts',
    );
    expect(unadmitted(cases)).toEqual([]);
  }, 15_000);

  it('names the case whose timeout was removed (the canary)', () => {
    const path = 'packages/application/src/pipeline/default-branch-readers.test.ts';
    const contents = readFileSync(join(REPOSITORY_ROOT, path), 'utf8');
    // Spelled apart, so this case is not itself a walk case of this file's census.
    const walkers = { walkers: new Set([`census${'Paths'}`]), rooted: new Set<string>() };
    expect(unadmitted(walkCases(path, contents, walkers))).toEqual([]);
    const removed = contents.lastIndexOf('}, 15_000);');
    const planted = `${contents.slice(0, removed)}});${contents.slice(removed + '}, 15_000);'.length)}`;
    expect(unadmitted(walkCases(path, planted, walkers))).toEqual([
      expect.stringMatching(
        /^packages\/application\/src\/pipeline\/default-branch-readers\.test\.ts:\d+ 'has no member left that answers “which branch” on the provider’s behalf' \(timeout none\)$/,
      ),
    ]);
  });
});
