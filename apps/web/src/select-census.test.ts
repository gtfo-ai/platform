/**
 * **A `<select>` is the `Select` primitive** (S-25.10, TD-033 decisions 2 and 5).
 *
 * The owner, on project Settings → Ticket lifecycle: "the selectboxes use the native `<select>`
 * without proper styling". Seventeen of them carried their own class strings, each an OS arrow on
 * the page's own colour, and *Returned* was a native multi-select that needed Cmd/Ctrl-click.
 * `ui/select.tsx` draws the native element in the brand and `ui/checkbox-list.tsx` is a multiple
 * choice; this census keeps a raw one from coming back.
 *
 * ### What the scan reads
 *
 * Every source under `apps/web/src` (git's census, so an untracked file is read too), test files
 * excepted, with comments stripped: a `<select` JSX tag anywhere but `ui/select.tsx` fails, and so
 * does a `multiple` attribute on a `<Select` (its props type omits it; this catches a cast).
 *
 * **Out of scope, on purpose:** `apps/web/src/worker/` — the remote worker's local page is its own
 * session's (S-22.x), and it has no `<select>` today (it may adopt the primitive later).
 *
 * ### What it cannot see, stated rather than implied
 *
 * - `createElement('select')` or `document.createElement('select')` — no source writes either.
 * - A select built by a library this application does not use today.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { censusFiles } from '../../../scripts/census-files.mjs';
import { withoutComments } from '../../../scripts/source-scanner.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The one file that may write the element. */
export const SELECT_PRIMITIVE = 'apps/web/src/ui/select.tsx';
/** The worker's local page: its session's, not this census's. */
const WORKER_PAGE = 'apps/web/src/worker/';

const RAW_SELECT = /<select(?=[\s/>])/g;
const MULTIPLE_SELECT = /<Select(?=[\s/>])[^>]*?\bmultiple\b/g;

export interface SelectOffender {
  readonly line: number;
  readonly what: 'raw <select>' | '<Select multiple>';
}

/** Every raw `<select>` and every `<Select multiple>` in `source`, comments ignored. */
export const selectOffenders = (source: string): SelectOffender[] => {
  const code = withoutComments(source);
  const lineOf = (index: number): number => code.slice(0, index).split('\n').length;
  return [
    ...[...code.matchAll(RAW_SELECT)].map((match) => ({
      line: lineOf(match.index ?? 0),
      what: 'raw <select>' as const,
    })),
    ...[...code.matchAll(MULTIPLE_SELECT)].map((match) => ({
      line: lineOf(match.index ?? 0),
      what: '<Select multiple>' as const,
    })),
  ].sort((a, b) => a.line - b.line);
};

describe('the select scanner', () => {
  it.each([
    ['a raw select', '<select value={v} onChange={f}>', 'raw <select>'],
    ['one opened on its own line', 'return (\n  <select\n    id={id}\n  >', 'raw <select>'],
    ['a self-closing one', '<select/>', 'raw <select>'],
    ['the primitive asked for several values', '<Select value={v} multiple>', '<Select multiple>'],
  ])('finds %s', (_name, source, what) => {
    expect(selectOffenders(source).map((found) => found.what)).toEqual([what]);
  });

  it.each([
    ['the primitive', '<Select id={id} value={v}>'],
    ['a comment', '/* a `<select>` over the models */ const x = 1;'],
    ['a line comment', '// the <select> is the primitive’s\nconst x = 1;'],
    ['another element that starts with the name', '<selection />'],
  ])('passes %s', (_name, source) => {
    expect(selectOffenders(source)).toEqual([]);
  });
});

describe('every select in the application is the Select primitive (S-25.10)', () => {
  const files = censusFiles(REPO_ROOT, {
    pathspecs: ['apps/web/src'],
    include: (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path),
  });

  it('has the sources to scan, and the pattern finds the one element the primitive writes', () => {
    expect(files.length).toBeGreaterThan(80);
    // A scan that matched nothing anywhere would report a clean census of nothing.
    const primitive = files.find((file) => file.path === SELECT_PRIMITIVE);
    expect(primitive).toBeDefined();
    expect(selectOffenders(primitive?.contents ?? '').map((found) => found.what)).toEqual([
      'raw <select>',
    ]);
    // And the screens use it.
    const users = files.filter((file) => /<Select(?=[\s/>])/.test(file.contents));
    expect(users.length).toBeGreaterThan(10);
  });

  it('finds no raw select outside the primitive, and no multiple select anywhere', () => {
    const offenders = files
      .filter((file) => file.path !== SELECT_PRIMITIVE && !file.path.startsWith(WORKER_PAGE))
      .flatMap((file) =>
        selectOffenders(file.contents).map((found) => `${file.path}:${found.line}: ${found.what}`),
      );
    expect(offenders).toEqual([]);
  });
});
