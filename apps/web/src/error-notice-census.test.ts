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
