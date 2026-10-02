/**
 * **A role sentence is written only where a 403 decides it** — the census WP-122 adds for PROGRESS
 * backlog 385.
 *
 * Backlog 327 found three screens that named every read failure *"… needs the admin role"*, so a
 * `503` from a process with no eventing read to an administrator as a permission they lacked;
 * WP-114 fixed those three with `readErrorDetail` (`api/read-error.ts`), which keeps the role
 * sentence for a 403 and shows what the server said otherwise. Backlog 385 then found **five more**
 * by grep, and the next one would have been found the same way. So the rule is held here instead:
 * a sentence of the shape *"needs the <role> role"* — or *"needs <role>"* — may appear in the
 * application's code only as the `forbidden` argument of a `readErrorDetail(` call, or on a line
 * declared below with the reason it is not an error path.
 *
 * ## What it reads, and what it cannot see
 *
 * Every `.ts`/`.tsx` file under `apps/web/src` that is not a test, read off disk (so a file not yet
 * committed is read too), with comments stripped by the repository's one scanner
 * (`scripts/source-scanner.mjs`) — a docblock that *describes* the old sentence is not a sentence
 * the screen shows. "Inside a `readErrorDetail(` call" is decided by counting parentheses from the
 * nearest call before the sentence, ignoring those inside string literals, so a call that closed
 * before the sentence does not cover it. It is syntactic, and says so: a role sentence assembled
 * from pieces (`'needs the ' + role`), held in a variable passed to `readErrorDetail` from
 * elsewhere, or naming a role this list does not know, is invisible to it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { withoutComments } from '../../../scripts/source-scanner.mjs';

const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url));

/** *"needs the maintainer role"*, *"needs maintainer"*, *"need the admin role"*. */
const ROLE_SENTENCE = /\bneeds? (?:the )?(?:viewer|member|maintainer|admin)\b/gi;

const CALL = 'readErrorDetail(';

/**
 * Role sentences that are **not** a read error's detail, each with why — compared with what the
 * census finds in both directions, so an entry that stops matching fails as well.
 */
const DECLARED: readonly {
  readonly file: string;
  readonly sentence: string;
  readonly why: string;
}[] = [
  {
    file: 'features/breakdown-panel.tsx',
    sentence: 'needs the maintainer',
    why: 'shown when the server answered `can_decide: false` — a statement about the caller made from the 403 rule itself, never from a failed read',
  },
];

/** Is the parenthesis opened at `from` still open at `at`? Parens inside string literals are skipped. */
const stillOpen = (source: string, from: number, at: number): boolean => {
  let depth = 1;
  let quote: string | null = null;
  for (let index = from; index < at; index += 1) {
    const char = source[index];
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
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return false;
      }
    }
  }
  return true;
};

/** The role sentences in `source` that no `readErrorDetail(` call is still open around. */
export const uncoveredRoleSentences = (source: string): string[] => {
  const code = withoutComments(source);
  const found: string[] = [];
  for (const match of code.matchAll(ROLE_SENTENCE)) {
    const at = match.index;
    const call = code.lastIndexOf(CALL, at);
    const covered = call !== -1 && stillOpen(code, call + CALL.length, at);
    if (!covered) {
      found.push(match[0].toLowerCase());
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

const census = (): { readonly file: string; readonly sentence: string }[] =>
  sourceFiles().flatMap((path) =>
    uncoveredRoleSentences(readFileSync(path, 'utf8')).map((sentence) => ({
      file: relative(SOURCE_ROOT, path),
      sentence,
    })),
  );

describe('role sentences in the web application (WP-122)', () => {
  it('has sources to scan, and finds the sentences that are covered as well', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    // The covered sites exist and are read: a walk that found nothing would also report nothing.
    const covered = files.filter((path) =>
      withoutComments(readFileSync(path, 'utf8')).includes(CALL),
    );
    expect(covered.length).toBeGreaterThanOrEqual(7);
  });

  it('writes a role sentence only as the forbidden argument of readErrorDetail, or where declared', () => {
    const found = census();
    const undeclared = found.filter(
      (hit) =>
        !DECLARED.some((entry) => entry.file === hit.file && entry.sentence === hit.sentence),
    );
    expect(undeclared).toEqual([]);
    // And the other direction: a declared line that no longer matches is a stale exemption.
    const stale = DECLARED.filter(
      (entry) => !found.some((hit) => hit.file === entry.file && hit.sentence === entry.sentence),
    );
    expect(stale).toEqual([]);
  });

  /** Calibration (standing rule 3): the instrument sees what it forbids, and only that. */
  it.each([
    [
      'a bare detail string',
      'const a = <ErrorNotice detail="Reading it needs the maintainer role." />;',
    ],
    ['an EmptyState hint', "const b = { hint: 'reading the record needs the admin role' };"],
    [
      'a sentence after a readErrorDetail call that already closed',
      "const c = readErrorDetail(error, 'x'); const d = 'needs the viewer role';",
    ],
    ['the short form', "const e = 'setting one needs maintainer';"],
  ])('flags %s', (_name, source) => {
    expect(uncoveredRoleSentences(source)).toHaveLength(1);
  });

  it.each([
    [
      'the forbidden argument',
      "const a = readErrorDetail(jobs.error, 'Reading them needs the admin role.');",
    ],
    [
      'the forbidden argument, across lines, after a call inside the first argument',
      "const b = readErrorDetail(\n  first(error),\n  'Reading it (Q36) needs the maintainer role.',\n);",
    ],
    ['a comment', '// this used to say it needs the admin role\nconst c = 1;'],
    ['a docblock', '/** needs the admin role */\nconst d = 1;'],
  ])('does not flag %s', (_name, source) => {
    expect(uncoveredRoleSentences(source)).toEqual([]);
  });
});
