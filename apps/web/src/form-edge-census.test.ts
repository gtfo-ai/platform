/**
 * **A form control's edge is the input token** (S-23.13a, from S-23.17's review; WCAG 2.1 SC 1.4.11).
 *
 * The edge of a field is the only thing that tells a sighted reader where to type, so it is a
 * "user interface component" under 1.4.11 and needs 3:1 against what is around it. The theme has
 * two border tokens for that reason: `border-line` (`--border-default`, a divider — about 1.6:1
 * against a card) and `border-line-input` (`--border-input`, which `ui/contrast.test.ts` holds to
 * 3:1). About thirty `<input>`, `<select>` and `<textarea>` elements had been given the divider.
 * axe did not see it: its `color-contrast` rule reads text, not borders, so the browser tier was
 * green over every one of them.
 *
 * ### What the scan reads
 *
 * Every `<input`, `<select>` and `<textarea` JSX tag in the application's sources (git's census, so
 * an untracked file is read too), from its `<` to the `>` that closes it at brace depth 0. A tag
 * fails when its text names the class `border-line` (not `border-line-input`, not
 * `border-line-muted`), or names an identifier that resolves to a string constant naming it —
 * `const INPUT = 'rounded-md border border-line …'` in the same file, or an exported one anywhere in
 * the sources. Block and line comments are stripped first.
 *
 * ### What it cannot see, stated rather than implied
 *
 * - **A class that arrives as a prop.** `<input className={className} />` in a wrapper is read, but
 *   the caller's `className` is not followed.
 * - **A class built at run time** (`'border-' + tone`).
 * - **A control that is not one of the three tags** — a Base UI `Select.Trigger`, a `<div
 *   contentEditable>` — would need its own entry here.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { censusFiles } from '../../../scripts/census-files.mjs';
import { withoutComments } from '../../../scripts/source-scanner.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The divider class itself, and never a longer token that starts with it. */
const DIVIDER = /(?<![\w-])border-line(?![\w-])/;

/** `<input`, `<select`, `<textarea` as JSX intrinsic elements. */
const CONTROL_OPEN = /<(input|select|textarea)(?=[\s/>])/g;

/** Every `const NAME = '…'` (or `"…"`, or a template without substitutions) in `source`. */
export const stringConstants = (source: string): ReadonlyMap<string, string> => {
  const found = new Map<string, string>();
  for (const match of source.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2/g,
  )) {
    const [, name, , value] = match;
    if (name !== undefined && value !== undefined) {
      found.set(name, value);
    }
  }
  return found;
};

/** The text of the tag that opens at `start`, up to the `>` that closes it at brace depth 0. */
const tagText = (source: string, start: number): string => {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (char === '\\') {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
    } else if (char === '>' && depth === 0) {
      return source.slice(start, index + 1);
    }
  }
  return source.slice(start);
};

export interface EdgeOffender {
  readonly line: number;
  readonly tag: string;
  /** The class text that named the divider: the tag's own, or the constant it referred to. */
  readonly via: string;
}

/**
 * Every form control in `source` whose edge is the divider. `shared` holds the constants exported
 * elsewhere in the sources, consulted for an identifier the file does not define itself.
 */
export const dividerEdgedControls = (
  source: string,
  shared: ReadonlyMap<string, string> = new Map(),
): EdgeOffender[] => {
  const code = withoutComments(source);
  const local = stringConstants(code);
  const offenders: EdgeOffender[] = [];
  for (const match of code.matchAll(CONTROL_OPEN)) {
    const start = match.index ?? 0;
    const tag = tagText(code, start);
    const line = code.slice(0, start).split('\n').length;
    const name = match[1] ?? '';
    if (DIVIDER.test(tag)) {
      offenders.push({ line, tag: name, via: 'the tag' });
      continue;
    }
    for (const identifier of new Set(tag.match(/\b[A-Za-z_$][\w$]*\b/g) ?? [])) {
      const value = local.get(identifier) ?? shared.get(identifier);
      if (value !== undefined && DIVIDER.test(value)) {
        offenders.push({ line, tag: name, via: identifier });
        break;
      }
    }
  }
  return offenders;
};

describe('the form-control edge scanner', () => {
  it.each([
    ['a class string', '<input className="rounded-md border border-line px-2" />', 'the tag'],
    [
      'a cx() call over several lines',
      "<select\n  value={v}\n  className={cx('rounded-md border', 'border-line')}\n>",
      'the tag',
    ],
    [
      'a constant in the file',
      "const INPUT = 'rounded-md border border-line';\nconst F = () => <textarea className={INPUT} />;",
      'INPUT',
    ],
    [
      'an arrow function inside the tag before the class',
      "<input onChange={(e) => set(e.target.value)} className='border border-line' />",
      'the tag',
    ],
  ])('finds %s', (_name, source, via) => {
    expect(dividerEdgedControls(source).map((found) => found.via)).toEqual([via]);
  });

  it('follows an identifier to a constant exported from another module', () => {
    const shared = new Map([['FIELD', 'rounded-md border border-line']]);
    expect(dividerEdgedControls('<input className={FIELD} />', shared)).toEqual([
      { line: 1, tag: 'input', via: 'FIELD' },
    ]);
  });

  it.each([
    ['the input token', '<input className="rounded-md border border-line-input" />'],
    ['another token that starts with the name', '<select className="border-line-muted" />'],
    ['a divider on an element that is not a control', '<div className="border-b border-line" />'],
    ['a comment', '<input /* border-line */ className="border-line-input" />'],
    ['an Input component (its own tag is what is read)', '<Input className="x" />'],
  ])('passes %s', (_name, source) => {
    expect(dividerEdgedControls(source)).toEqual([]);
  });
});

describe('every form control’s edge is the input token (WCAG 1.4.11)', () => {
  const files = censusFiles(REPO_ROOT, {
    pathspecs: ['apps/web/src'],
    include: (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path),
  });

  it('has the sources to scan, and they hold form controls', () => {
    expect(files.length).toBeGreaterThan(80);
    // An empty walk, or a tag pattern that matched nothing, would report a clean scan of nothing.
    const controls = files.reduce(
      (total, file) => total + [...withoutComments(file.contents).matchAll(CONTROL_OPEN)].length,
      0,
    );
    expect(controls).toBeGreaterThan(30);
  });

  it('finds none edged with the divider', () => {
    const shared = new Map<string, string>();
    for (const file of files) {
      for (const [name, value] of stringConstants(withoutComments(file.contents))) {
        if (new RegExp(`export\\s+const\\s+${name}\\b`).test(file.contents)) {
          shared.set(name, value);
        }
      }
    }
    const offenders = files.flatMap((file) =>
      dividerEdgedControls(file.contents, shared).map(
        (found) => `${file.path}:${found.line}: <${found.tag}> via ${found.via}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
