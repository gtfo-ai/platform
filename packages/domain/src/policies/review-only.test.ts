/**
 * Review-only mode's two pure decisions (WP-24).
 *
 * The filter is asserted from **both sides** for every trigger (standing rule 42): a merge request
 * the project asked for is selected, and one it did not is refused with a reason. `selectFindings`
 * is asserted at the cap and one under it, and in the order that matters — the floor before the cap,
 * which is the pair a reversed implementation passes half of.
 */
import type { ReviewFinding, Severity } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_REVIEW_FINDINGS,
  DEFAULT_REVIEW_SEVERITY_FLOOR,
  mergeRequestMatchesFilter,
  type ReviewOnlySettings,
  selectFindings,
  severityRank,
} from './review-only.js';

const settings = (overrides: Partial<ReviewOnlySettings> = {}): ReviewOnlySettings => ({
  enabled: true,
  trigger: 'label',
  label: 'agentic-review',
  paths: [],
  severityFloor: DEFAULT_REVIEW_SEVERITY_FLOOR,
  maxFindings: DEFAULT_MAX_REVIEW_FINDINGS,
  ...overrides,
});

describe('the review-only filter', () => {
  it('refuses everything while the feature is off, whatever the trigger says', () => {
    for (const trigger of ['all', 'label', 'paths'] as const) {
      const verdict = mergeRequestMatchesFilter(settings({ enabled: false, trigger }), {
        labels: ['agentic-review'],
        changedPaths: ['src/app.ts'],
      });
      expect(verdict.matched, trigger).toBe(false);
      expect(verdict.reason).toContain('not enabled');
    }
  });

  it('selects every merge request under `all`, and says so', () => {
    const verdict = mergeRequestMatchesFilter(settings({ trigger: 'all' }), {
      labels: [],
      changedPaths: null,
    });
    expect(verdict).toEqual({ matched: true, reason: 'the project reviews every merge request' });
  });

  it('matches the configured label, and refuses a merge request without it', () => {
    expect(
      mergeRequestMatchesFilter(settings(), { labels: ['bug', 'agentic-review'], changedPaths: [] })
        .matched,
    ).toBe(true);
    const missing = mergeRequestMatchesFilter(settings(), {
      labels: ['bug'],
      changedPaths: [],
    });
    expect(missing.matched).toBe(false);
    expect(missing.reason).toContain('agentic-review');
  });

  it('compares labels case-insensitively and after trimming, because a human typed them', () => {
    for (const label of ['Agentic-Review', ' agentic-review ', 'AGENTIC-REVIEW']) {
      expect(
        mergeRequestMatchesFilter(settings(), { labels: [label], changedPaths: [] }).matched,
        label,
      ).toBe(true);
    }
    // …and not so far that a different label matches.
    expect(
      mergeRequestMatchesFilter(settings(), { labels: ['agentic-reviewer'], changedPaths: [] })
        .matched,
    ).toBe(false);
  });

  it('matches a changed file against the configured globs, in both directions', () => {
    const paths = settings({ trigger: 'paths', paths: ['src/billing/**', '*.sql'] });
    expect(
      mergeRequestMatchesFilter(paths, {
        labels: [],
        changedPaths: ['README.md', 'src/billing/invoice.ts'],
      }),
    ).toEqual({ matched: true, reason: 'a changed file matches "src/billing/**"' });
    const miss = mergeRequestMatchesFilter(paths, {
      labels: [],
      changedPaths: ['src/shipping/box.ts'],
    });
    expect(miss.matched).toBe(false);
    expect(miss.reason).toBe('no changed file matches the configured paths');
  });

  it('refuses a paths trigger whose diff could not be read, rather than matching nothing by luck', () => {
    const verdict = mergeRequestMatchesFilter(settings({ trigger: 'paths', paths: ['src/**'] }), {
      labels: [],
      changedPaths: null,
    });
    expect(verdict.matched).toBe(false);
    // The reason is what separates it from "no path matched": an operator has to be able to tell
    // a filter that decided from one that could not.
    expect(verdict.reason).toContain('could not be read');
  });

  it('matches nothing when a paths trigger has no paths, and says which of the two it is', () => {
    const verdict = mergeRequestMatchesFilter(settings({ trigger: 'paths' }), {
      labels: [],
      changedPaths: ['src/app.ts'],
    });
    expect(verdict.matched).toBe(false);
    expect(verdict.reason).toContain('configured none');
  });
});

const finding = (id: string, severity: Severity): ReviewFinding => ({
  id,
  severity,
  category: 'correctness',
  file: 'src/app.ts',
  line: 1,
  explanation: `finding ${id}`,
  suggestion: null,
});

describe('selecting the findings that are posted', () => {
  it('drops everything below the floor and counts what it dropped', () => {
    const result = selectFindings(
      [finding('a', 'blocker'), finding('b', 'minor'), finding('c', 'nit')],
      { severityFloor: 'major', maxFindings: 10 },
    );
    expect(result.posted.map((entry) => entry.finding.id)).toEqual(['a']);
    expect(result.belowFloor).toBe(2);
    expect(result.overFlow).toBe(0);
  });

  it('keeps a `nit` when the project asked for one, which is the other side of the floor', () => {
    const result = selectFindings([finding('c', 'nit')], { severityFloor: 'nit', maxFindings: 10 });
    expect(result.posted.map((entry) => entry.finding.id)).toEqual(['c']);
    expect(result.belowFloor).toBe(0);
  });

  /**
   * The ordering the reversed implementation gets wrong.
   *
   * Ten `minor` findings ahead of one `blocker`: cap-then-floor posts ten minors and reports "10
   * posted" while the blocker never reaches the merge request. Floor-then-cap posts the blocker.
   */
  it('spends the cap on severity, not on the order the model happened to choose', () => {
    const findings = [
      ...Array.from({ length: 10 }, (_, at) => finding(`m${at}`, 'minor')),
      finding('blocker', 'blocker'),
    ];
    const result = selectFindings(findings, { severityFloor: 'minor', maxFindings: 3 });
    expect(result.posted.map((entry) => entry.finding.id)).toEqual(['blocker', 'm0', 'm1']);
    expect(result.overFlow).toBe(8);
  });

  it('is stable inside one severity, so the model’s own order survives', () => {
    const findings = [finding('x', 'major'), finding('y', 'major'), finding('z', 'major')];
    expect(
      selectFindings(findings, { severityFloor: 'major', maxFindings: 10 }).posted.map(
        (entry) => entry.finding.id,
      ),
    ).toEqual(['x', 'y', 'z']);
  });

  it('posts exactly the cap at the cap, and one fewer one under it', () => {
    const findings = Array.from({ length: 12 }, (_, at) => finding(`f${at}`, 'major'));
    expect(
      selectFindings(findings, { severityFloor: 'major', maxFindings: 10 }).posted,
    ).toHaveLength(10);
    expect(
      selectFindings(findings, { severityFloor: 'major', maxFindings: 9 }).posted,
    ).toHaveLength(9);
    expect(selectFindings(findings, { severityFloor: 'major', maxFindings: 9 }).overFlow).toBe(3);
  });

  /**
   * The index is the **artifact's** position, and it is what the caller identifies a thread by
   * (WP-24 review round 2). Two properties, and the posting order breaks the first:
   *
   *  - it survives both cuts — a floor that drops findings 0 and 1 leaves finding 2 numbered 2, not
   *    numbered 0, so a project that lowers its floor does not renumber the threads it already
   *    posted;
   *  - it is unique whatever the model wrote, which `finding.id` is not: `reviewFindingSchema.id` is
   *    any non-empty string and the reviewer's prompt never asks for uniqueness.
   */
  it('numbers a finding by its place in the artifact, not by its place in the posting order', () => {
    const findings = [
      finding('dup', 'nit'),
      finding('dup', 'minor'),
      finding('dup', 'blocker'),
      finding('dup', 'major'),
    ];
    const result = selectFindings(findings, { severityFloor: 'major', maxFindings: 10 });
    // Posting order is severity order (2, 3); the numbers are the artifact's.
    expect(result.posted.map((entry) => entry.index)).toEqual([2, 3]);
    expect(new Set(result.posted.map((entry) => entry.index)).size).toBe(2);
    // …and the model's own identity for the same two findings is one value.
    expect(new Set(result.posted.map((entry) => entry.finding.id)).size).toBe(1);
  });

  it('ranks the four severities in product/18’s order', () => {
    expect(
      ['blocker', 'major', 'minor', 'nit'].map((value) => severityRank(value as Severity)),
    ).toEqual([0, 1, 2, 3]);
  });
});
