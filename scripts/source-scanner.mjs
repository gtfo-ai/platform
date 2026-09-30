/**
 * The one comment stripper every source census in this repository reads through (WP-96, PROGRESS
 * backlogs 261 and 269).
 *
 * WP-73c made it a scanner inside `apps/server/src/routes/web-sources.ts`, and five censuses read
 * it from there; four more — `apps/server/src/queries/integration-config-writers.test.ts`,
 * `packages/application/src/pipeline/task-save-sites.test.ts`, `wip-commit-sites.test.ts` and
 * `compile-sites.test.ts` — kept their own copies, which cut a line at its first `//` or dropped a
 * line opening with `*`, `//` or `/*`. So `const url = 'https://x'; tasks.save(tx, t)` hid the
 * call, a false negative in a census of what must be **absent**. The application ring cannot
 * import `apps/server`, so the scanner lives here, beside `census-files.mjs`, re-allowed by name in
 * `biome.json`'s dependency rule the same way and narrowed by the same census
 * (`census-files.test.ts`, *who may import census-files.mjs*). `web-sources.ts` re-exports it, so
 * its five readers are unchanged.
 *
 * Plain JavaScript for the reason `census-files.mjs` is: a script run with no TypeScript resolver
 * may need it. Its test tier is `source-scanner.test.ts` (standing rule 33).
 */

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

/**
 * Does a `/` at this point open a regular expression, judged by the last significant token?
 *
 * @param {string} before
 * @returns {boolean}
 */
const slashOpensRegex = (before) => {
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
 *
 * **`keepLineComments`, for a reader of JSX** (WP-96 review round 1, `apps/web/src/no-html.test.ts`).
 * JSX text is where the misreadings above live, and the one of them that *removes* text is a `//`
 * in prose. With the option set, a `//` comment is still a state — so a `/*` inside it opens
 * nothing — but its text is **kept**, and only block comments are removed. Every remaining
 * misreading then fails towards keeping text, which for a census of what must be *absent* is a
 * false positive rather than a false negative, with one exception, stated: a `/*` in JSX text that
 * no `//` precedes on its line still opens a block comment and removes code up to the next `*\/`.
 *
 * @param {string} source
 * @param {{ readonly keepLineComments?: boolean }} [options]
 * @returns {string}
 */
export const withoutComments = (source, options = {}) => {
  let output = '';
  let previous = '';
  /** Open `${` depths of the templates being read; a `}` at the top one resumes the template. */
  /** @type {number[]} */
  const templates = [];
  let braces = 0;
  let index = 0;
  /** @param {string} quote */
  const readQuoted = (quote) => {
    const start = index;
    index += 1;
    while (index < source.length && source[index] !== quote && source[index] !== '\n') {
      index += source[index] === '\\' ? 2 : 1;
    }
    index += 1;
    output += source.slice(start, index);
    previous = quote;
  };
  const readTemplate = () => {
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
  const readRegex = () => {
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
      const start = index;
      while (index < source.length && source[index] !== '\n') {
        index += 1;
      }
      if (options.keepLineComments === true) {
        output += source.slice(start, index);
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
