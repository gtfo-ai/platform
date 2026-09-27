/**
 * Reading `apps/web/src` off disk, for the two censuses that compare the SPA against something.
 *
 * `client-census.test.ts` compares the client's `/api/*` paths against this server's router;
 * `settings-mirror.test.ts` compares the wizard's command set against the settings screens'. Both
 * need the same two things — which files git knows about, and a source with its prose removed — and
 * a second copy of either is a second thing to keep right (standing rule 41 applied to a helper).
 *
 * It is a plain module rather than an export of a test file on purpose: importing one test file
 * from another puts its `describe`s into the importer's module graph and runs them twice.
 *
 * **Tracked *and* untracked-but-not-ignored** is standing rule 85, paid for by a rejected push: a
 * guard that reads only `git ls-files` is green on a file its author has not committed, so a census
 * would pass locally and fail on CI with the author's own new screen in it. Since WP-68 the list
 * and the read are `scripts/census-files.mjs`'s, shared with every census in the repository: a
 * path that vanished after the listing reads as nothing, and one that exists and cannot be read
 * throws naming it rather than crashing on the first `ENOENT` (backlog 10's second column).
 */
import { fileURLToPath } from 'node:url';
import { censusPaths, censusText } from '../../../../scripts/census-files.mjs';

export const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));

/** The SPA's sources, relative to the repository root. */
export const WEB_SOURCES = 'apps/web/src';

/**
 * Every source file git knows about under `directory` — tracked **and** untracked-but-not-ignored.
 *
 * Rule 85, and the reason it is a parameter since WP-48: the jobs-seam census reads
 * `apps/server/src` the same way this one reads `apps/web/src`, and a second copy of the two `git`
 * invocations is a second place for the untracked half to be forgotten.
 */
export const sourceFilesUnder = (directory: string): string[] =>
  censusPaths(repositoryRoot, {
    pathspecs: [directory],
    include: (path) =>
      (path.endsWith('.ts') || path.endsWith('.tsx')) &&
      !path.endsWith('.test.ts') &&
      !path.endsWith('.test.tsx'),
  });

/**
 * One listed source's text. A path that vanished since it was listed reads as the empty string —
 * it is no longer part of the tree — and one that exists and cannot be read throws, naming it.
 */
export const readSource = (path: string): string => censusText(repositoryRoot, path);

export const webSourceFiles = (): string[] => sourceFilesUnder(WEB_SOURCES);

/**
 * Words after which a `/` opens a regular-expression literal rather than dividing: an operand
 * cannot follow them, so the slash cannot be an operator.
 */
const REGEX_AFTER_KEYWORD = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'instanceof',
  'yield',
  'await',
]);

/** Does a `/` at this point open a regular expression, judged by the last significant token? */
const slashOpensRegex = (before: string): boolean => {
  const previous = before.trimEnd();
  if (previous === '') {
    return true;
  }
  const word = /[A-Za-z_$][\w$]*$/.exec(previous)?.[0];
  if (word !== undefined) {
    return REGEX_AFTER_KEYWORD.has(word);
  }
  // After an operand — a number, a closing bracket or a string — it divides.
  return !/[\w$)\]}'"`]$/.test(previous);
};

/**
 * Removes every comment and keeps everything else **byte for byte**, including string, template
 * and regular-expression contents, so prose about a thing is not a use of it while a route path
 * written as `'/api/auth/*'` stays one.
 *
 * **Why a scanner and not a regex** (PROGRESS backlog 261). This was
 * `replaceAll(/\/\*[\s\S]*?\*\//g, '')` over the raw text, which treats a `/*` inside a string, a
 * `//` line or a trailing comment as a block-comment opener and deletes the code up to the next
 * real `*\/` — `workspaces.ts`'s `['agentic/*']` hid a declaration tail and a docblock, and
 * WP-72 met it as a pipeline-census key that vanished. For a census of what must be **absent**
 * that is a false negative. So this walks the text once: `'…'`, `"…"`, template literals (with
 * `${…}` nesting), regular-expression literals, `//` and `/* *\/` are each a state.
 *
 * **Newlines survive**, including those inside a removed block comment, so a census that reports a
 * line number still reports the right one; a line that held only a comment reads as blank.
 *
 * **The one heuristic**: whether a `/` opens a regular expression is decided by the last
 * significant token before it (an operand before it means division; a keyword such as `return`
 * or any operator means a regex), which is the classic rule and is wrong only for a
 * regular expression directly after `)` of an `if (…)` — a form nothing in this repository writes.
 * TypeScript's own scanner would settle it, and `typescript` 7 ships no JavaScript API to call.
 * **What it reads wrongly, stated**: JSX *text* is read as code, so an apostrophe in it opens a
 * quote that ends at the line's end and a `//` in it (a URL written as prose) drops the rest of that
 * line; a backtick in it opens a template that runs to the next backtick, which is harmless while
 * they pair and hides code when one is alone.
 */
export const withoutComments = (source: string): string => {
  let output = '';
  let previous = '';
  /** Open `${` depths of the templates being read; a `}` at the top one resumes the template. */
  const templates: number[] = [];
  let braces = 0;
  let index = 0;
  const readQuoted = (quote: string): void => {
    const start = index;
    index += 1;
    while (index < source.length && source[index] !== quote && source[index] !== '\n') {
      index += source[index] === '\\' ? 2 : 1;
    }
    index += 1;
    output += source.slice(start, index);
    previous = quote;
  };
  const readTemplate = (): void => {
    // Called with `index` on the opening backtick or on the `}` that closes an interpolation.
    const start = index;
    index += 1;
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') {
        index += 2;
      } else if (char === '`') {
        index += 1;
        output += source.slice(start, index);
        previous = '`';
        return;
      } else if (char === '$' && source[index + 1] === '{') {
        index += 2;
        output += source.slice(start, index);
        templates.push(braces);
        braces += 1;
        previous = '{';
        return;
      } else {
        index += 1;
      }
    }
    output += source.slice(start, index);
  };
  const readRegex = (): void => {
    const start = index;
    index += 1;
    let inClass = false;
    while (index < source.length && source[index] !== '\n') {
      const char = source[index];
      if (char === '\\') {
        index += 2;
        continue;
      }
      index += 1;
      if (char === '[') {
        inClass = true;
      } else if (char === ']') {
        inClass = false;
      } else if (char === '/' && !inClass) {
        break;
      }
    }
    while (index < source.length && /[a-z]/i.test(source[index] ?? '')) {
      index += 1;
    }
    output += source.slice(start, index);
    // A regular expression is an operand: a `/` after it divides.
    previous = ')';
  };
  while (index < source.length) {
    const char = source[index] ?? '';
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        index += 1;
      }
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      output += source.slice(index, stop).replaceAll(/[^\n]/g, '');
      index = stop;
    } else if (char === "'" || char === '"') {
      readQuoted(char);
    } else if (char === '`') {
      readTemplate();
    } else if (char === '/' && slashOpensRegex(previous)) {
      readRegex();
    } else if (char === '}' && templates.at(-1) === braces - 1) {
      templates.pop();
      braces -= 1;
      readTemplate();
    } else {
      if (char === '{') {
        braces += 1;
      } else if (char === '}') {
        braces -= 1;
      }
      output += char;
      index += 1;
      // A run of whitespace is one space, so `return /re/` and `y\nreturn` read as words.
      const token = /\s/.test(char) ? (previous.endsWith(' ') ? '' : ' ') : char;
      previous = (previous + token).slice(-32);
    }
  }
  return output;
};
