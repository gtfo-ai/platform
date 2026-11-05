/**
 * **One word per concept** (S-23.23, the UX audit's § 4; research/19 rule 9): the words the audit
 * found naming one thing several ways, and the one each now uses. This census refuses the retired
 * spelling anywhere in the application's text outside a comment — the cheap half of the vocabulary,
 * the phrases a string can be checked for. The agreed words:
 *
 * | concept | the word | retired here |
 * |---|---|---|
 * | a person must act | **Needs you** (state), *a person* (prose) | "Escalated", "a human" |
 * | capacity | **slot**, on a **machine** | "free seat" |
 * | who runs it | **Runs on** | "claimant" in text |
 * | re-execution | **Retry** a stage, **Re-run** a run | "Retry run" |
 * | attempt | **Attempt 2** | "try 2", "2nd attempt" |
 * | a project's integrations | **Connections**, **Used by N projects** | "Bound to", "Not bound" |
 * | merge request | **merge request**, spelled out | "Open MR" |
 * | money vs tokens | **Cost**, **Cap**, **Token budget**; one window per label | "$… tokens", "Spend this month" |
 *
 * **What it cannot see, stated**: a word assembled at run time, a server-written string (the
 * server's catalogues are their own census's), and a concept spelled a way this table does not
 * list. A word that is also a code identifier (`claimant_kind`, `escalated` as an enum value) is
 * matched only in the capitalised or phrase form the screen would print.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { censusFiles } from '../../../scripts/census-files.mjs';
import { withoutComments } from '../../../scripts/source-scanner.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The retired spelling → the word the screens use instead. */
export const RETIRED_WORDS: readonly { readonly pattern: RegExp; readonly use: string }[] = [
  { pattern: /\bEscalated\b/, use: 'Needs you' },
  { pattern: /\b(?:by|to|for) a human\b/, use: 'a person' },
  { pattern: /\bfree seats?\b/, use: 'free slot' },
  { pattern: /\bown claimant\b/, use: 'Runs on' },
  { pattern: /\bRetry run\b/, use: 'Re-run' },
  { pattern: /\btry \$\{/, use: 'Attempt N' },
  { pattern: /\} attempt`/, use: 'Attempt N' },
  { pattern: /\bNot bound\b|\bBound to \b/, use: 'Used by N projects' },
  { pattern: /\bOpen MR\b/, use: 'Open merge request' },
  { pattern: /\} tokens · /, use: 'a cost in dollars, never "tokens"' },
  { pattern: /\bSpend this month\b/, use: 'one time window per label' },
];

/** Each line of `source` outside comments; a `//` that follows a non-space is kept (a URL). */
const codeLines = (source: string): string[] => {
  const kept = withoutComments(source, { keepLineComments: true }).split('\n');
  const cut = withoutComments(source).split('\n');
  return kept.map((line, index) => {
    const before = cut[index] ?? '';
    return before === line || before === '' || /\s$/.test(before) ? before : line;
  });
};

/** Every retired word in `source`, outside a comment, as `line: word → use`. */
export const retiredWords = (source: string): string[] =>
  codeLines(source).flatMap((text, index) =>
    RETIRED_WORDS.filter(({ pattern }) => pattern.test(text)).map(
      ({ pattern, use }) => `${index + 1}: ${pattern.source} → ${use}`,
    ),
  );

describe('the vocabulary scanner', () => {
  it.each([
    ['a string literal', "const t = 'Escalated to a human.';"],
    ['JSX text', '<h2>\n  Taken over by a human\n</h2>'],
    ['a template literal', 'const t = `${count} free seats`;'],
    ['a button label', '<Button>Retry run</Button>'],
    ['a link label', '<ActionMenuLinkItem label="Open MR" />'],
    ['a badge', '<Badge>{`try ${stage.attempt}`}</Badge>'],
  ])('finds a retired word in %s', (_name, source) => {
    expect(retiredWords(source)).not.toEqual([]);
  });

  it.each([
    ['a comment', '/** Escalated to a human: the old word. */\nconst a = 1;'],
    ['a line comment', "// 'Open MR' was the card's label\nconst a = 1;"],
    ['an enum value', "const state = 'escalated';"],
    ['an identifier', 'const kind = run.claimant_kind;'],
    ['the agreed words', "const t = 'Needs you: handed to a person · 2 free slots · Re-run';"],
  ])('ignores %s', (_name, source) => {
    expect(retiredWords(source)).toEqual([]);
  });
});

describe('the screens use one word per concept (S-23.23)', () => {
  const files = censusFiles(REPO_ROOT, {
    pathspecs: ['apps/web/src'],
    include: (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path),
  });

  it('has the sources to scan', () => {
    expect(files.length).toBeGreaterThan(80);
    expect(files.some((file) => file.path === 'apps/web/src/features/stage-outcome.ts')).toBe(true);
  });

  it('finds no retired word outside a comment', () => {
    const offenders = files.flatMap((file) =>
      retiredWords(file.contents).map((found) => `${file.path}:${found}`),
    );
    expect(offenders).toEqual([]);
  });
});
