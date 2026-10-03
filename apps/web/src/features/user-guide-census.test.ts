/**
 * **`docs/user-guide.md` against the screens it names** — the run page's tabs and the top
 * navigation (WP-129, PROGRESS backlog 400).
 *
 * Nothing read the guide before this file. WP-112 added a fourth tab to the run page and the guide
 * went on saying *"three tabs"* until WP-117 happened to edit the section for another reason. So
 * the two label tables the app renders are read **as data** — `TABS` (`run-detail.tsx`, the only
 * `role="tab"` site in the app) and `NAV` (`app/shell.tsx`) — and compared with the guide's
 * matching sections **in both directions**, the way `checks-panel.test.tsx` compares its census:
 *
 *  - § 5's *"then <n> tabs:"* list must name exactly `TABS`'s labels, in order, each as a bullet
 *    opening with the label in bold, and `<n>` must be the count spelled as a word;
 *  - every later *"<n> tabs …"* list in § 5 (*"Three tabs can refuse…"*) must name only tabs that
 *    exist, and as many as its number says;
 *  - *The top navigation*'s first bold run (*"Dashboard · Agents · …"*) must be `NAV`'s labels, in
 *    order.
 *
 * So an added tab, a renamed one, a removed navigation entry and a guide edit that drops one all
 * fail here.
 *
 * ## What it cannot see
 *
 * **Prose about behaviour.** It holds labels and counts, never what a screen *does*: the paragraph
 * that said the Context pack tab could not be answered — false from WP-57 to WP-117 — is server
 * behaviour described in words, and no check here would have caught it. That half stays a review
 * duty: the plan's definition of done asks a row that changes `apps/web/src/features/` to sweep the
 * guide (rule 83). It also reads no other screen's labels (the task page's commands, the settings
 * sections, the per-project tabs below the navigation), nor a tab rendered outside `TABS.map` or
 * a second `role="tablist"` on the run page — `TABS` is the table it trusts to be the whole set,
 * which is true today and checked nowhere — and a section heading it looks for that
 * has been renamed fails loudly rather than passing over nothing.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAV } from '../app/shell.js';
import { TABS } from './run-detail.js';

const GUIDE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'docs',
  'user-guide.md',
);

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
] as const;

/** `"four"` → 4; `undefined` for anything else, so a figure written as digits fails rather than passes. */
const numberOf = (word: string): number | undefined => {
  const index = NUMBER_WORDS.indexOf(word.toLowerCase() as (typeof NUMBER_WORDS)[number]);
  return index === -1 ? undefined : index;
};

/** The lines of the section a heading opens, up to the next heading of the same or a higher level. */
export const sectionOf = (guide: string, heading: string): string[] => {
  const lines = guide.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    throw new Error(`docs/user-guide.md has no heading "${heading}"`);
  }
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  const end = lines.findIndex(
    (line, index) =>
      index > start && /^#+ /.test(line) && (/^#+/.exec(line)?.[0].length ?? 0) <= level,
  );
  return lines.slice(start + 1, end === -1 ? undefined : end);
};

export interface TabList {
  /** The number word the sentence opening the list uses, as a number (`undefined` if not a word). */
  readonly count: number | undefined;
  readonly word: string;
  /** The bold label each bullet of the list opens with, in order. */
  readonly labels: readonly string[];
}

/**
 * Every list a *"<n> tabs"* sentence introduces: the bullets that follow it up to the next blank
 * line. A bullet's continuation lines (indented or not) are skipped; a bullet that does not open
 * with a bold label is reported as `?`, so it cannot pass unnoticed.
 */
export const tabListsIn = (section: readonly string[]): TabList[] => {
  const lists: TabList[] = [];
  section.forEach((line, index) => {
    const sentence = /\b([A-Za-z]+) tabs\b/.exec(line);
    if (sentence === null) {
      return;
    }
    // The list is the run of bullets after the sentence's paragraph ends and the blank lines after it.
    const rest = section.slice(index + 1);
    const paragraphEnd = rest.findIndex((next) => next.trim() === '');
    const after = paragraphEnd === -1 ? [] : rest.slice(paragraphEnd);
    const first = after.findIndex((next) => next.trim() !== '');
    const labels: string[] = [];
    for (const next of first === -1 ? [] : after.slice(first)) {
      if (next.trim() === '') {
        break;
      }
      if (next.startsWith('- ')) {
        labels.push(/^- \*\*([^*]+)\*\*/.exec(next)?.[1] ?? '?');
      } else if (labels.length === 0) {
        break;
      }
    }
    if (labels.length > 0) {
      const word = sentence[1] ?? '';
      lists.push({ count: numberOf(word), word, labels });
    }
  });
  return lists;
};

/** The labels of the navigation line: its first bold run, split on the middle dot. */
export const navigationLabelsIn = (section: readonly string[]): string[] => {
  const line = section.find((candidate) => candidate.trim() !== '') ?? '';
  const bold = /\*\*([^*]+)\*\*/.exec(line)?.[1] ?? '';
  return bold
    .split('·')
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
};

/** What the guide says against what the app renders; empty when they agree. */
export const guideFindings = (
  guide: string,
  tabs: readonly string[],
  navigation: readonly string[],
): string[] => {
  const problems: string[] = [];
  const lists = tabListsIn(sectionOf(guide, '## 5. Run detail and the transcript'));
  const [all, ...rest] = lists;
  if (all === undefined) {
    problems.push('§ 5 introduces no list of tabs');
  } else {
    if (JSON.stringify(all.labels) !== JSON.stringify(tabs)) {
      problems.push(
        `§ 5 lists the tabs ${JSON.stringify(all.labels)}; the app renders ${JSON.stringify(tabs)}`,
      );
    }
    if (all.count !== tabs.length) {
      problems.push(`§ 5 says "${all.word} tabs"; the app renders ${tabs.length}`);
    }
  }
  for (const list of rest) {
    const unknown = list.labels.filter((label) => !tabs.includes(label));
    if (unknown.length > 0) {
      problems.push(
        `§ 5 "${list.word} tabs" names ${JSON.stringify(unknown)}, which the app does not render`,
      );
    }
    if (list.count !== list.labels.length) {
      problems.push(`§ 5 says "${list.word} tabs" and lists ${list.labels.length}`);
    }
  }
  const listed = navigationLabelsIn(sectionOf(guide, '### The top navigation'));
  if (JSON.stringify(listed) !== JSON.stringify(navigation)) {
    problems.push(
      `the top navigation reads ${JSON.stringify(listed)}; the app renders ${JSON.stringify(navigation)}`,
    );
  }
  return problems;
};

const guide = (): string => readFileSync(GUIDE_PATH, 'utf8');
const tabLabels = (): string[] => TABS.map((tab) => tab.label);
const navLabels = (): string[] => NAV.map((item) => item.label);

describe('docs/user-guide.md names the screens the app renders (WP-129)', () => {
  it('lists the run page’s tabs and the top navigation exactly as the app renders them', () => {
    expect(guideFindings(guide(), tabLabels(), navLabels())).toEqual([]);
  });

  it('reads both lists off the guide, not an empty section (calibration, standing rule 21)', () => {
    // A parser that found nothing would agree with an empty table; these are the guide's own words.
    const lists = tabListsIn(sectionOf(guide(), '## 5. Run detail and the transcript'));
    expect(lists.map((list) => list.labels)).toEqual([
      ['Transcript', 'Prompt', 'Context pack', 'Settings'],
      ['Prompt', 'Context pack', 'Settings'],
    ]);
    expect(navigationLabelsIn(sectionOf(guide(), '### The top navigation'))).toEqual(navLabels());
    expect(navLabels().length).toBeGreaterThan(0);
    expect(() => sectionOf(guide(), '## 5. Run details')).toThrow(/no heading/);
  });

  describe('canaries: the check fails on the drift it exists to catch', () => {
    it('fails on a tab the app renders and the guide does not name', () => {
      expect(guideFindings(guide(), [...tabLabels(), 'Diff'], navLabels())).toEqual([
        `§ 5 lists the tabs ${JSON.stringify(tabLabels())}; the app renders ${JSON.stringify([...tabLabels(), 'Diff'])}`,
        `§ 5 says "four tabs"; the app renders ${tabLabels().length + 1}`,
      ]);
    });

    it('fails on a navigation entry the app no longer renders', () => {
      const withoutInbox = navLabels().filter((label) => label !== 'Inbox');
      expect(guideFindings(guide(), tabLabels(), withoutInbox)).toEqual([
        `the top navigation reads ${JSON.stringify(navLabels())}; the app renders ${JSON.stringify(withoutInbox)}`,
      ]);
    });

    it('fails on a guide that drops a tab, miscounts one, or names one that is gone', () => {
      const dropped = guide().replace(
        /^- \*\*Settings\*\* — the project settings/m,
        '- the project settings',
      );
      expect(guideFindings(dropped, tabLabels(), navLabels())).toContainEqual(
        `§ 5 lists the tabs ${JSON.stringify(['Transcript', 'Prompt', 'Context pack', '?'])}; the app renders ${JSON.stringify(tabLabels())}`,
      );
      const miscounted = guide().replace('then four tabs:', 'then three tabs:');
      expect(guideFindings(miscounted, tabLabels(), navLabels())).toEqual([
        `§ 5 says "three tabs"; the app renders ${tabLabels().length}`,
      ]);
      const gone = tabLabels().filter((label) => label !== 'Settings');
      expect(guideFindings(guide(), gone, navLabels())).toContainEqual(
        `§ 5 "Three tabs" names ${JSON.stringify(['Settings'])}, which the app does not render`,
      );
    });
  });
});
