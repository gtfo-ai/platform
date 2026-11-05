/**
 * **An `ErrorNotice` is handed the error, never `String(error)`** — the census WP-167 adds for
 * PROGRESS backlog 524 (ruling (b)).
 *
 * `ErrorNotice` (`ui/kit.tsx`) renders nothing for a `PlatformUpdatedError`, the one failure the
 * shell's reload banner already states for the whole page. Until WP-167 that was decided by
 * matching the notice's *text* against the platform sentence, because 62 screens passed
 * `detail={String(error)}` rather than the error — so an `ApiError` whose server-written message
 * carried the same words hid itself. The decision is now the error's type, which only works where
 * the screen passes `error={…}`. A screen that goes back to `String(…)` in a `title` or `detail`
 * attribute would show the platform-updated sentence as a section error again, and nothing else
 * would notice; this test does.
 *
 * ## What it reads, and what it cannot see
 *
 * Every `.ts`/`.tsx` file under `apps/web/src` that is not a test, read off disk (so a file not yet
 * committed is read too), with comments stripped by the repository's one scanner
 * (`scripts/source-scanner.mjs`). For each `<ErrorNotice` it reads the element's attributes up to
 * the tag's end — braces counted, string literals skipped — and refuses a `title={…}` or
 * `detail={…}` whose expression contains `String(`. It is syntactic, and says so (standing rule 48):
 * it **cannot see** a spread (`<ErrorNotice {...props} />` whose object holds `detail: String(e)`),
 * `createElement(ErrorNotice, { detail: String(e) })`, the component under an alias
 * (`import { ErrorNotice as Notice }`), a variable that holds `String(e)` and is passed by name,
 * or the other spellings of an error's text — `` `${e}` ``, `e.toString()`, `e.message` (two sites
 * pass `.message` as the detail *beside* `error={…}`, which is allowed: the type still decides).
 * Nor does it see a helper that turns the error into text inside itself: `readErrorDetail`
 * (`api/read-error.ts`) returns `String(error)` for anything but a 403, so its ten notices stay
 * hidden for a `PlatformUpdatedError` only because each also passes `error={…}` — a notice that
 * keeps `detail={readErrorDetail(…)}` and drops `error=` reads green here (WP-167 review round 1).
 *
 * ## A "…refused." notice carries the refusal (S-23.22)
 *
 * About a dozen notices said *"That command was refused."* and passed no `error`, so the person was
 * told that the server said no and never why — the sentence `ErrorNotice` builds from the error's
 * code, and the server's diagnostic behind *Technical details*, both need the error. The second
 * census refuses an `<ErrorNotice` whose `title` mentions "refused" and that has no `error={…}`
 * attribute. The same syntactic limits apply: a title held in a variable is not read.
 *
 * ## No error is stringified for a screen (review of PR #51)
 *
 * Three screens still put `String(error)` in front of the person — a status line, a Checks row's
 * basis, the sign-in notice's title — which is the server's diagnostic in the open. The third census
 * refuses `String(…)` of anything named `error`/`err` (or a `.error`) in any application source but
 * the two that own the text: `api/read-error.ts`, which produces the diagnostic `ErrorNotice` and
 * `ErrorReason` fold under *Technical details*, and `ui/error-boundary.tsx`, which shows a
 * *component's* crash (sanitised and bounded), not a server's answer. It cannot see `` `${error}` ``,
 * `error.toString()`, `error.message`, or an error held under another name.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withoutComments } from '../../../scripts/source-scanner.mjs';

const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));

const TAG = '<ErrorNotice';
const ATTRIBUTE = /\b(title|detail)=\{$/;

/** The index just past the `{…}` expression opened at `open`, string literals skipped. */
const closingBrace = (code: string, open: number): number => {
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (quote !== null) {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return code.length;
};

/** The `title`/`detail` attributes of every `<ErrorNotice` in `source` whose value holds `String(`. */
export const stringifiedNoticeAttributes = (source: string): string[] => {
  const code = withoutComments(source);
  const found: string[] = [];
  let at = code.indexOf(TAG);
  while (at !== -1) {
    let index = at + TAG.length;
    // Read attributes until the tag's own `>` (or `/>`), outside any `{…}` expression.
    while (index < code.length && code[index] !== '>') {
      if (code[index] === '{') {
        const end = closingBrace(code, index);
        const name = ATTRIBUTE.exec(code.slice(Math.max(at, index - 8), index + 1))?.[1];
        if (name !== undefined && code.slice(index, end).includes('String(')) {
          found.push(name);
        }
        index = end;
      } else if (code[index] === '"' || code[index] === "'") {
        const quote = code[index];
        index = code.indexOf(quote as string, index + 1) + 1;
        if (index === 0) {
          break;
        }
      } else {
        index += 1;
      }
    }
    at = code.indexOf(TAG, index);
  }
  return found;
};

/** The attribute text of every `<ErrorNotice …>` tag in `source`, comments removed. */
export const noticeTags = (source: string): string[] => {
  const code = withoutComments(source);
  const tags: string[] = [];
  let at = code.indexOf(TAG);
  while (at !== -1) {
    let index = at + TAG.length;
    while (index < code.length && code[index] !== '>') {
      if (code[index] === '{') {
        index = closingBrace(code, index);
      } else if (code[index] === '"' || code[index] === "'") {
        const next = code.indexOf(code[index] as string, index + 1);
        index = next === -1 ? code.length : next + 1;
      } else {
        index += 1;
      }
    }
    tags.push(code.slice(at + TAG.length, index));
    at = code.indexOf(TAG, index);
  }
  return tags;
};

/** The raw value of attribute `name` in a tag's text — `"…"` or `{…}` — or `null`. */
const attributeValue = (tag: string, name: string): string | null => {
  const match = new RegExp(`\\b${name}=`).exec(tag);
  if (match === null) {
    return null;
  }
  const start = match.index + match[0].length;
  if (tag[start] === '{') {
    return tag.slice(start, closingBrace(tag, start));
  }
  const quote = tag[start] as string;
  const end = tag.indexOf(quote, start + 1);
  return tag.slice(start, end === -1 ? tag.length : end + 1);
};

/** The titles of every "…refused" notice in `source` that is not handed its error. */
export const refusedNoticesWithoutError = (source: string): string[] =>
  noticeTags(source).flatMap((tag) => {
    const title = attributeValue(tag, 'title');
    return title !== null && /refused/i.test(title) && attributeValue(tag, 'error') === null
      ? [title]
      : [];
  });

/** The files allowed to stringify an error, each with its reason (see the module note). */
const STRINGIFY_ALLOWED: Readonly<Record<string, string>> = {
  'api/read-error.ts': 'produces the diagnostic shown behind Technical details',
  'ui/error-boundary.tsx': 'a component crash, sanitised and bounded, not a server answer',
};

/** Every `String(…)` in `source` whose argument names an error, comments removed. */
export const stringifiedErrors = (source: string): string[] => {
  const code = withoutComments(source);
  const found: string[] = [];
  for (const match of code.matchAll(/\bString\(/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = open;
    for (; end < code.length; end += 1) {
      if (code[end] === '(') depth += 1;
      else if (code[end] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const argument = code.slice(open + 1, end);
    if (/\berr(?:or)?\b|\.error\b/i.test(argument)) {
      found.push(`String(${argument})`);
    }
  }
  return found;
};

const walk = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const sourceFiles = (): string[] =>
  walk(SOURCE_ROOT).filter((path) => /\.(ts|tsx)$/.test(path) && !/\.test\.(ts|tsx)$/.test(path));

describe('ErrorNotice is handed the error, not its text (WP-167)', () => {
  it('has sources to scan, and reads the notices that pass the error', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    // A walk that found no notices would also report no violations.
    const passing = files.filter((path) =>
      /<ErrorNotice[^>]*\berror=\{/.test(withoutComments(readFileSync(path, 'utf8'))),
    );
    // 29 files at WP-167.
    expect(passing.length).toBeGreaterThanOrEqual(25);
  });

  it('finds no String(…) in an ErrorNotice title or detail', () => {
    const found = sourceFiles().flatMap((path) =>
      stringifiedNoticeAttributes(readFileSync(path, 'utf8')).map(
        (attribute) => `${relative(SOURCE_ROOT, path)}: ${attribute}`,
      ),
    );
    expect(found).toEqual([]);
  });

  /** Calibration (standing rule 3): the instrument sees what it forbids, and only that. */
  it.each([
    ['a detail', '<ErrorNotice title="x" detail={String(e)} />', ['detail']],
    ['a title', '<ErrorNotice title={String(e)} />', ['title']],
    [
      'a multi-line element with an arrow before it',
      '<ErrorNotice\n  title={ok ? "a>" : pick(() => 1)}\n  detail={String(query.error)}\n/>',
      ['detail'],
    ],
    ['a nested call', '<ErrorNotice title="x" detail={cut(String(e), 80)} />', ['detail']],
  ])('flags %s', (_name, source, expected) => {
    expect(stringifiedNoticeAttributes(source)).toEqual(expected);
  });

  it.each([
    ['the error itself', '<ErrorNotice title="x" error={e} />'],
    [
      'readErrorDetail beside the error',
      '<ErrorNotice title="x" error={e} detail={readErrorDetail(e, \'y\')} />',
    ],
    ['String( in another component', '<Other detail={String(e)} />'],
    ['String( after the tag closed', '<ErrorNotice title="x" error={e} />; const t = String(e);'],
    ['a comment', '// <ErrorNotice detail={String(e)} />\nconst c = 1;'],
    ['String( in a quoted title', '<ErrorNotice title="String(e)" />'],
  ])('does not flag %s', (_name, source) => {
    expect(stringifiedNoticeAttributes(source)).toEqual([]);
  });
});

describe('a "…refused." ErrorNotice is handed the refusal (S-23.22)', () => {
  it('finds every refused notice passing its error', () => {
    const files = sourceFiles();
    const refused = files.flatMap((path) =>
      noticeTags(readFileSync(path, 'utf8')).filter((tag) =>
        /refused/i.test(attributeValue(tag, 'title') ?? ''),
      ),
    );
    // 18 at S-23.22: a walk that read none would also report no violations.
    expect(refused.length).toBeGreaterThanOrEqual(15);
    const found = files.flatMap((path) =>
      refusedNoticesWithoutError(readFileSync(path, 'utf8')).map(
        (title) => `${relative(SOURCE_ROOT, path)}: ${title}`,
      ),
    );
    expect(found).toEqual([]);
  });

  it.each([
    [
      'a literal title',
      '<ErrorNotice title="That command was refused." />',
      ['"That command was refused."'],
    ],
    [
      'an expression title',
      // A brace inside the expression (`{ verb }`) does not end the attribute.
      '<ErrorNotice title={pick({ verb }) + " was refused."} detail="x" />',
      ['{pick({ verb }) + " was refused."}'],
    ],
    [
      'a multi-line element',
      '<ErrorNotice\n  title="That answer was refused."\n/>',
      ['"That answer was refused."'],
    ],
  ])('flags %s with no error', (_name, source, expected) => {
    expect(refusedNoticesWithoutError(source)).toEqual(expected);
  });

  it.each([
    [
      'a refused notice with its error',
      '<ErrorNotice title="That command was refused." error={e} />',
    ],
    ['a notice that is not a refusal', '<ErrorNotice title="Could not be loaded." />'],
    ['a refusal in a comment', '// <ErrorNotice title="x refused" />\nconst c = 1;'],
    ['another component', '<Other title="That was refused." />'],
  ])('does not flag %s', (_name, source) => {
    expect(refusedNoticesWithoutError(source)).toEqual([]);
  });
});

describe('no error is stringified for a screen (review of PR #51)', () => {
  it('finds none outside the two files that own the text, and each of those still does', () => {
    const offenders: string[] = [];
    const used = new Set<string>();
    for (const path of sourceFiles()) {
      const name = relative(SOURCE_ROOT, path);
      const found = stringifiedErrors(readFileSync(path, 'utf8'));
      if (found.length === 0) continue;
      if (Object.hasOwn(STRINGIFY_ALLOWED, name)) {
        used.add(name);
        continue;
      }
      offenders.push(...found.map((each) => `${name}: ${each}`));
    }
    expect(offenders).toEqual([]);
    expect(Object.keys(STRINGIFY_ALLOWED).filter((name) => !used.has(name))).toEqual([]);
  });

  it.each([
    [
      'JSX text',
      '<p>Could not: <UntrustedText value={String(gate.error)} /></p>',
      ['String(gate.error)'],
    ],
    [
      'a template literal',
      // Split so the literal is not read as a template by the linter.
      'const why = `not served: $' + '{String(body.error)}`;',
      ['String(body.error)'],
    ],
    ['a bare error', 'return { detail: String(error) };', ['String(error)']],
    ['a nested call', 'String(pick(err, 1))', ['String(pick(err, 1))']],
  ])('flags %s', (_name, source, expected) => {
    expect(stringifiedErrors(source)).toEqual(expected);
  });

  it.each([
    ['a number', 'String(count)'],
    ['an id', 'String(task.id)'],
    ['a comment', '// String(error)\nconst a = 1;'],
    ['a word that contains err', 'String(terrain)'],
  ])('does not flag %s', (_name, source) => {
    expect(stringifiedErrors(source)).toEqual([]);
  });
});
