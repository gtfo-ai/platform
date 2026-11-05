/**
 * **The statistics API's prose is UI text, so it carries no internal reference** (TD-033 decision
 * 6, S-23.19).
 *
 * `apps/web/src/spec-reference-census.test.ts` keeps decision ids, work-package numbers and spec
 * pages out of the SPA's own strings — and the owner's live statistics page still showed *"PROGRESS
 * backlog 191"* and *"PROGRESS backlog 88"*, because that census scans `apps/web` and these strings
 * are the **server's**: every label, definition, caveat and absence `GET /api/org/stats` publishes
 * is printed verbatim in a tooltip, in the "How these are measured" disclosure and in the CSV.
 *
 * So this is the same rule applied at the source, wider than the SPA's because a server string has
 * no JSX around it to look like code: besides the SPA census's pattern it refuses a `PROGRESS`
 * entry, a bare `backlog N`, a `migration N`, a `docs/` path and a `§` — and the two Markdown marks
 * the screen would print literally, a backtick and `**`, because nothing on that screen turns a
 * string into markup (`apps/web/src/ui/untrusted.tsx`).
 *
 * **Scope**: every string field of every {@link STATS_CATALOGUE} entry, read off the table so a new
 * metric is covered the moment it exists; plus the folded document and its CSV under row sets that
 * reach every **dynamic** string `foldStats` composes (the withheld-window caveat, the three
 * defect-escape outcomes, the unmeasured-merge caveat). **What it cannot see, stated**: a dynamic
 * string added on a branch none of those row sets reaches — the row sets are listed here, by hand,
 * and the reasons belong in the comments beside the strings.
 */
import type { IsoDateTime, OrgStatsResponse } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  type BugTraceRow,
  foldStats,
  resolveRange,
  STATS_CATALOGUE,
  type StatsSources,
  statsToCsv,
} from './stats-metrics.js';

/** The SPA census's pattern (`apps/web/src/spec-reference-census.test.ts`), widened for prose. */
export const INTERNAL_REFERENCE =
  /\b(?:BD|TD|WP|Q)-?\d+\b|product\/\d+|technical\/\d+|PROGRESS|\bbacklog \d|\bmigration \d|docs\/|§|`|\*\*/;

const offenders = (strings: readonly string[]): string[] =>
  strings.filter((text) => INTERNAL_REFERENCE.test(text));

const EMPTY: StatsSources = {
  startedTasks: [],
  deliveredTasks: [],
  counters: [],
  cost: [],
  estimatedSpend: [],
  questions: [],
  humanMinutes: [],
  kbProposals: [],
  kbUsage: [],
  stageReturns: [],
  withheldReviewMinutes: { minutes: 0, entries: 0 },
  overlaps: [],
  loc: [],
  lintEdits: [],
  bugTraces: [],
};

const fold = (sources: Partial<StatsSources>): OrgStatsResponse =>
  foldStats({
    range: resolveRange('7d', 'day', '2026-06-07'),
    timezone: 'UTC',
    timezoneSubstituted: false,
    projectId: null,
    generatedAt: '2026-06-07T12:00:00.000Z' as IsoDateTime,
    sources: { ...EMPTY, ...sources },
  });

const trace = (bugs: number, linked: number): BugTraceRow => ({
  day: '2026-06-04',
  bugs,
  linked,
  escaped: 0,
});

/** Every row set that reaches a dynamic string, one per branch `foldStats` composes. */
const DYNAMIC_ROW_SETS: Readonly<Record<string, Partial<StatsSources>>> = {
  'no bug traced, nothing withheld': {},
  'withheld review windows and unmeasured merges': {
    withheldReviewMinutes: { minutes: 30, entries: 2 },
    loc: [{ day: '2026-06-03', measured: 1, lines: 10, unmeasured: 1 }],
    stageReturns: [{ stage: 'code_review', entries: 2, returns: 1, rate: null }],
  },
  'defect coverage below the floor': { bugTraces: [trace(10, 1)] },
  'defect coverage at the floor': { bugTraces: [trace(2, 1)] },
};

const publishedStrings = (response: OrgStatsResponse): string[] =>
  response.metrics.flatMap((metric) => [
    metric.label,
    metric.definition,
    ...metric.caveats,
    ...(metric.absent === null ? [] : [metric.absent.reason, metric.absent.owner]),
  ]);

describe('the internal-reference pattern', () => {
  it.each([
    ['a backlog entry', 'An approval is not a comment (PROGRESS backlog 191).'],
    ['a bare backlog number', 'See backlog 88 for the bots.'],
    ['a decision id', 'Reported cost is truth (BD-011).'],
    ['a question id', 'No hourly rate exists (Q73).'],
    ['a work package', 'Since WP-61 the cap is per entry.'],
    ['a spec page and section', 'As product/19 §10 defines it.'],
    ['a migration', 'Runs created before migration 0041.'],
    ['a docs path', 'Until docs/TODO.md is answered.'],
    ['code in backticks', 'Read from `cost_entries.is_estimate`.'],
    ['Markdown emphasis', 'It is a **mean**.'],
  ])('finds %s', (_name, text) => {
    expect(offenders([text])).toEqual([text]);
  });

  it.each([
    ['a plain definition', 'Tasks delivered in the period ÷ tasks started in the period.'],
    ['a percentage and an hour cap', 'Always between 0% and 100%; capped at 8 h per window.'],
    ['words that contain the letters', 'A QA backlog of BDD and TDD work is not a reference.'],
  ])('passes %s', (_name, text) => {
    expect(offenders([text])).toEqual([]);
  });
});

describe('the statistics API publishes no internal reference (S-23.19)', () => {
  it('has none in any string of the catalogue', () => {
    const strings = Object.values(STATS_CATALOGUE).flatMap((entry) => [
      entry.label,
      entry.definition,
      ...(entry.caveats ?? []),
      ...(entry.absent === undefined ? [] : [entry.absent.reason, entry.absent.owner]),
    ]);
    // The anchor (rule 4): the walk read the table, not an empty list.
    expect(strings.length).toBeGreaterThan(80);
    expect(offenders(strings)).toEqual([]);
  });

  it.each(Object.entries(DYNAMIC_ROW_SETS))(
    'has none in the folded document or its CSV with %s',
    (_name, sources) => {
      const response = fold(sources);
      expect(offenders(publishedStrings(response))).toEqual([]);
      expect(offenders(statsToCsv(response).split('\n'))).toEqual([]);
    },
  );

  it('reaches every dynamic string the fold composes', () => {
    // Positive controls: each row set above really produced the string it is listed for, so a
    // clean scan is a scan of the dynamic text and not of its absence.
    const all = Object.values(DYNAMIC_ROW_SETS).flatMap((sources) =>
      publishedStrings(fold(sources)),
    );
    const text = all.join('\n');
    expect(text).toContain('Withheld in this period: 2 review windows');
    expect(text).toContain('1 merged merge request in the period had no counts');
    expect(text).toContain('No bug ticket was traced in the period');
    expect(text).toContain('Coverage below the floor: 1 of 10');
    expect(text).toContain('Coverage: 1 of 2');
    expect(
      statsToCsv(fold(DYNAMIC_ROW_SETS['withheld review windows and unmeasured merges'] ?? {})),
    ).toContain('return_rate_by_stage,code_review');
  });
});
