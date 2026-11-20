/**
 * **Every date and time goes through `ui/time.ts`** (S-28.21, BACKLOG 1608).
 *
 * The owner read *3:05 PM* on one screen and *15:05* on the next: the activity rows formatted with
 * `hour: 'numeric'` in English, the merge box with `toLocaleTimeString([])` in the browser's
 * locale, and a usage pause with `h23`. The clock is now a setting (`display.clock`, 24-hour by
 * default) and `ui/time.ts` is the one module that turns an instant into words; this census keeps
 * a second spelling from coming back.
 *
 * ### What the scan reads
 *
 * Every source under `apps/web/src` — the worker's local page included — from git's census (so an
 * untracked file is read too), test files excepted, comments stripped. Outside `ui/time.ts` it
 * refuses a call of `toLocaleTimeString`, `toLocaleDateString` or `toLocaleString` (a number's
 * too: `formatInteger` is the number formatter, and a scan that cannot tell a `Date` from a number
 * by syntax refuses both), and any `Intl.DateTimeFormat(` — with or without `new`.
 *
 * ### What it cannot see, stated rather than implied
 *
 * - An instant written by hand — `iso.slice(0, 10)`, `getHours()` — is not a locale format and is
 *   not refused; the two found at S-28.21 were moved by hand, and the dashboard's greeting reads
 *   `getHours()` for the hour, not to show it.
 * - Indirection: `const F = Intl.DateTimeFormat; new F(…)`, or `Intl['DateTimeFormat']`.
 * - A string a dependency formats (none of the application's packages renders a date today).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { censusFiles } from '../../../scripts/census-files.mjs';
import { withoutComments } from '../../../scripts/source-scanner.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The one module that may format a date or a time. */
export const TIME_FORMATTER = 'apps/web/src/ui/time.ts';

const DIRECT_FORMAT = /\.toLocale(?:Time|Date)?String\s*\(|\bIntl\s*\.\s*DateTimeFormat\s*\(/g;

/** Every direct date or time format in `source`, by line, comments ignored. */
export const timeFormatOffenders = (source: string): { line: number; what: string }[] => {
  const code = withoutComments(source);
  return [...code.matchAll(DIRECT_FORMAT)].map((match) => ({
    line: code.slice(0, match.index ?? 0).split('\n').length,
    what: match[0].replace(/\s+/g, ''),
  }));
};

describe('the time-format scanner', () => {
  it.each([
    ['toLocaleTimeString', "new Date(iso).toLocaleTimeString([], { hour: '2-digit' })"],
    ['toLocaleDateString', 'at.toLocaleDateString()'],
    ['toLocaleString on a date', "new Date(iso).toLocaleString('en')"],
    ['toLocaleString on a number', "count.toLocaleString('en')"],
    ['a constructed formatter', "new Intl.DateTimeFormat('en', { hour: 'numeric' })"],
    ['a formatter called without new', "Intl.DateTimeFormat('en').format(at)"],
    ['one split over lines', 'new Intl\n  .DateTimeFormat(\n  locale)'],
  ])('finds %s', (_name, source) => {
    expect(timeFormatOffenders(source)).toHaveLength(1);
  });

  it.each([
    ['the formatter', 'formatDateTime(iso)'],
    ['the options type', 'const o: Intl.DateTimeFormatOptions = {};'],
    ['a number formatter', "new Intl.NumberFormat('en').format(n)"],
    ['a comment', '// once `toLocaleTimeString([])`\nconst x = 1;'],
    ['a block comment', '/* new Intl.DateTimeFormat(…) */ const x = 1;'],
  ])('passes %s', (_name, source) => {
    expect(timeFormatOffenders(source)).toEqual([]);
  });
});

describe('every date and time the application writes goes through ui/time.ts (S-28.21)', () => {
  const files = censusFiles(REPO_ROOT, {
    pathspecs: ['apps/web/src'],
    include: (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path),
  });

  it('has the sources to scan, the worker page among them, and finds the formatter’s own calls', () => {
    expect(files.length).toBeGreaterThan(80);
    expect(files.some((file) => file.path.startsWith('apps/web/src/worker/'))).toBe(true);
    // A scan that matched nothing anywhere would report a clean census of nothing.
    const formatter = files.find((file) => file.path === TIME_FORMATTER);
    expect(formatter).toBeDefined();
    expect(timeFormatOffenders(formatter?.contents ?? '').length).toBeGreaterThan(0);
  });

  it('finds no direct date or time format outside the formatter', () => {
    const offenders = files
      .filter((file) => file.path !== TIME_FORMATTER)
      .flatMap((file) =>
        timeFormatOffenders(file.contents).map(
          (found) => `${file.path}:${found.line}: ${found.what}`,
        ),
      );
    expect(offenders).toEqual([]);
  });
});
