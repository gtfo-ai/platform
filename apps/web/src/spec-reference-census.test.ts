/**
 * **No spec reference in UI text** (TD-033 decision 6, research/19 § 3 item 6).
 *
 * A decision id, a work-package number or a spec page — `BD-011`, `TD-020`, `WP-85`, `Q36`,
 * `product/18`, `technical/12` — is how this repository cites its reasons, and it means nothing to
 * the person reading a screen. The reason belongs in a comment beside the string (or in the user
 * guide, behind a "Learn more"), never in the string. This census fails on one anywhere in the
 * application's sources outside a comment: string literals, template literals and JSX text alike.
 *
 * **Scope** is every `.ts`/`.tsx` under `apps/web/src` that git knows about, tracked or untracked
 * (`scripts/census-files.mjs`), test files excluded — a test may name the decision it holds.
 *
 * **How a comment is told from text.** `withoutComments` (`scripts/source-scanner.mjs`) knows
 * strings, templates and regular expressions, and removes block comments — `{/* … *\/}` in JSX
 * included. It reads JSX text as code, so a `//` in prose (`https://`) would look like a line
 * comment. So each line is read twice — with the scanner's line comments kept and with them removed
 * — and what the scanner called a line comment is dropped only where it opens the line or follows
 * whitespace, which a real line comment does and a URL does not. **What that cannot see, stated**:
 * JSX *text* containing ` // ` followed by a reference on the same line reads as a comment and is
 * missed (a string literal is not: the scanner knows strings).
 *
 * **The opt-out list** is for a string that is a code identifier matching the pattern (none today).
 * Every entry must still occur, so an entry outlives nothing it excuses.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { censusFiles } from '../../../scripts/census-files.mjs';
import { withoutComments } from '../../../scripts/source-scanner.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const SPEC_REFERENCE = /\b(?:BD|TD|WP|Q)-?\d+\b|product\/\d+|technical\/\d+/;

/** `path` → the exact references allowed in it, each with its reason. */
const OPT_OUT: Readonly<
  Record<string, readonly { readonly text: string; readonly why: string }[]>
> = {};

export interface SpecReference {
  readonly line: number;
  readonly reference: string;
  readonly text: string;
}

/**
 * Each line with comments removed, the scanner's line comments included **unless** the text the
 * scanner calls a comment follows a non-space character on its line — `https://` in JSX prose.
 * Both readings come from the shared scanner, whose newlines survive, so the lines align and where
 * the two differ is exactly where it saw a line comment begin.
 */
const codeLines = (source: string): string[] => {
  const kept = withoutComments(source, { keepLineComments: true }).split('\n');
  const cut = withoutComments(source).split('\n');
  return kept.map((line, index) => {
    const before = cut[index] ?? '';
    return before === line || before === '' || /\s$/.test(before) ? before : line;
  });
};

/** Every spec reference in `source` outside a comment. */
export const specReferences = (source: string): SpecReference[] => {
  const found: SpecReference[] = [];
  codeLines(source).forEach((text, index) => {
    for (const match of text.matchAll(new RegExp(SPEC_REFERENCE, 'g'))) {
      found.push({ line: index + 1, reference: match[0], text: text.trim() });
    }
  });
  return found;
};

describe('the spec-reference scanner', () => {
  it.each([
    ['a string literal', "const hint = 'Estimated in local mode (BD-011).';", ['BD-011']],
    ['a template literal', 'const t = `see TD-020 here`;', ['TD-020']],
    ['JSX text', '<p>\n  Nothing here is required (product/06).\n</p>', ['product/06']],
    ['an attribute', '<Metric definition="Readiness level (product/17)." />', ['product/17']],
    ['a question id', "notice('needs the maintainer role (Q36)')", ['Q36']],
    ['a page reference', "hint: 'An SSH remote is refused (technical/12).'", ['technical/12']],
    ['JSX text after a URL', '<p>https://example.test explains WP-85</p>', ['WP-85']],
    ['a string holding a spaced slash pair', "const s = 'a // b WP-7';", ['WP-7']],
    ['an unhyphenated id', "'WP85 and BD7'", ['WP85', 'BD7']],
  ])('finds one in %s', (_name, source, references) => {
    expect(specReferences(source).map((found) => found.reference)).toEqual(references);
  });

  it.each([
    ['a block comment', '/** BD-022: untrusted. */\nconst a = 1;'],
    ['a JSX comment', '<div>{/* WP-95: the title is provider text */}</div>'],
    ['a line comment', '// TD-033 decision 6\nconst a = 1;'],
    ['a trailing line comment', "const a = 'x'; // WP-12"],
    ['a word that only contains the letters', "'BDD, TDD, WPF and Q&A'"],
    ['a reference glued to a word', "'ABD-1 and xQ3'"],
  ])('ignores %s', (_name, source) => {
    expect(specReferences(source)).toEqual([]);
  });

  it('reports the line it found the reference on', () => {
    expect(specReferences("const a = 1;\n\nconst b = 'BD-002';")).toEqual([
      { line: 3, reference: 'BD-002', text: "const b = 'BD-002';" },
    ]);
  });
});

describe('UI text carries no spec reference (TD-033 decision 6)', () => {
  const files = censusFiles(REPO_ROOT, {
    pathspecs: ['apps/web/src'],
    include: (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path),
  });

  it('has the sources to scan', () => {
    // An empty walk would report a clean scan of nothing.
    expect(files.length).toBeGreaterThan(80);
    expect(files.some((file) => file.path === 'apps/web/src/features/task-detail.tsx')).toBe(true);
  });

  it('finds none outside a comment, except an opted-out code identifier', () => {
    const offenders: string[] = [];
    const used = new Set<string>();
    for (const file of files) {
      const allowed = OPT_OUT[file.path] ?? [];
      for (const found of specReferences(file.contents)) {
        const excuse = allowed.find((entry) => found.text.includes(entry.text));
        if (excuse === undefined) {
          offenders.push(`${file.path}:${found.line}: ${found.reference} in ${found.text}`);
        } else {
          used.add(`${file.path}\0${excuse.text}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    const stale = Object.entries(OPT_OUT).flatMap(([path, entries]) =>
      entries.filter((entry) => !used.has(`${path}\0${entry.text}`)).map(() => path),
    );
    expect(stale).toEqual([]);
  });
});
