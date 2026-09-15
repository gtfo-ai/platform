/**
 * The epic-split variant's two pure decisions (WP-40).
 *
 * The bound on a created ticket is **produced** here rather than quoted (standing rule 39): the
 * worst case is driven through `renderChildDescription` at the shipped caps, so a cap that moves
 * moves this number with it.
 */
import type { AcceptanceCriterion, BreakdownChild } from '@platform/contracts';
import {
  MAX_BREAKDOWN_CRITERIA,
  MAX_BREAKDOWN_DESCRIPTION_CHARS,
  MAX_BREAKDOWN_TITLE_CHARS,
} from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  childTicketTitle,
  DEFAULT_CHILD_ISSUE_TYPE,
  DEFAULT_EPIC_SPLIT_ISSUE_TYPES,
  type EpicSplitSettings,
  epicSplitClaims,
  renderChildDescription,
} from './epic-split.js';

const ON: EpicSplitSettings = {
  enabled: true,
  issueTypes: [...DEFAULT_EPIC_SPLIT_ISSUE_TYPES],
  childIssueType: DEFAULT_CHILD_ISSUE_TYPE,
};

const criterion = (id: string): AcceptanceCriterion => ({
  id,
  given: 'a maintainer with Slack connected',
  when: 'the plan is posted',
  // biome-ignore lint/suspicious/noThenProperty: the published acceptance-criterion field name
  then: 'the buttons appear in the thread',
  validation: { kind: 'test', value: 'slack-approval.test.ts' },
});

const child = (over: Partial<BreakdownChild> = {}): BreakdownChild => ({
  title: 'Render the approval message',
  description: 'Build the Block Kit payload from the plan the task already stored.',
  acceptance_criteria: [criterion('AC-1')],
  size: 'S',
  rationale: 'The message can be reviewed before any button does anything.',
  ...over,
});

describe('epicSplitClaims', () => {
  it('claims the configured types, case- and whitespace-insensitively', () => {
    expect(epicSplitClaims(ON, 'Epic')).toBe(true);
    expect(epicSplitClaims(ON, ' epic ')).toBe(true);
    expect(epicSplitClaims(ON, 'EPIC')).toBe(true);
  });

  it('claims nothing when the feature is off, whatever the type says', () => {
    // Both directions of product/18:45's default (standing rule 42).
    expect(epicSplitClaims({ ...ON, enabled: false }, 'Epic')).toBe(false);
  });

  it('claims nothing for a ticket with no issue type, or one the project did not name', () => {
    expect(epicSplitClaims(ON, null)).toBe(false);
    expect(epicSplitClaims(ON, undefined)).toBe(false);
    expect(epicSplitClaims(ON, 'Story')).toBe(false);
  });

  it('claims nothing for an explicitly empty list — "the types I named", fail-closed', () => {
    expect(epicSplitClaims({ ...ON, issueTypes: [] }, 'Epic')).toBe(false);
  });
});

describe('childTicketTitle', () => {
  it('passes a title the schema already bounds through unchanged', () => {
    expect(childTicketTitle({ title: '  Render the approval message  ' })).toBe(
      'Render the approval message',
    );
  });

  it('cuts one longer than the cap rather than refusing it (standing rule 20)', () => {
    // A row written by an older build, or one the schema's bound moved under. Half a title still
    // names the ticket; a refusal would lose a child a human already accepted.
    const long = 'x'.repeat(MAX_BREAKDOWN_TITLE_CHARS + 50);
    const cut = childTicketTitle({ title: long });
    expect(cut.length).toBe(MAX_BREAKDOWN_TITLE_CHARS);
    expect(cut.endsWith('…')).toBe(true);
    // …and exactly at the cap it is untouched, which is the other side of the boundary.
    const exact = 'y'.repeat(MAX_BREAKDOWN_TITLE_CHARS);
    expect(childTicketTitle({ title: exact })).toBe(exact);
  });
});

describe('renderChildDescription', () => {
  it('quotes the model’s words and writes every other word itself', () => {
    const body = renderChildDescription({ child: child(), parentKey: 'ACME-1' });
    expect(body).toContain('splitting ACME-1');
    expect(body).toContain('Build the Block Kit payload');
    expect(body).toContain('**Acceptance criteria**');
    expect(body).toContain('1. **Given** a maintainer with Slack connected');
    expect(body).toContain('(test: slack-approval.test.ts)');
    expect(body).toContain('**Why this is a ticket of its own**: The message can be reviewed');
  });

  it('numbers the criteria and takes at most the cap, so a long list cannot run away', () => {
    const many = Array.from({ length: MAX_BREAKDOWN_CRITERIA + 5 }, (_, index) =>
      criterion(`AC-${index}`),
    );
    const body = renderChildDescription({
      child: child({ acceptance_criteria: many }),
      parentKey: 'ACME-1',
    });
    expect(body).toContain(`${MAX_BREAKDOWN_CRITERIA}. **Given**`);
    expect(body).not.toContain(`${MAX_BREAKDOWN_CRITERIA + 1}. **Given**`);
  });

  /**
   * The worst case, **measured** by driving the renderer at the shipped caps rather than by
   * asserting the arithmetic (standing rule 39). **16 605 characters** is what a created ticket's
   * body can be at `MAX_BREAKDOWN_DESCRIPTION_CHARS` 4 000 (twice — the description and the
   * rationale) and `MAX_BREAKDOWN_CRITERIA` 10 criteria of 200-character clauses. The fixture's
   * clause length is this test's choice and not a platform bound, which is why the figure is a
   * measurement of *this* input rather than a ceiling: the only platform caps in it are the two
   * 4 000s and the 10, and a change to either moves this number.
   */
  it('has a longest form, and it is produced rather than quoted', () => {
    const long = (n: number) => 'z'.repeat(n);
    const body = renderChildDescription({
      child: child({
        description: long(MAX_BREAKDOWN_DESCRIPTION_CHARS),
        rationale: long(MAX_BREAKDOWN_DESCRIPTION_CHARS),
        acceptance_criteria: Array.from({ length: MAX_BREAKDOWN_CRITERIA }, (_, index) => ({
          ...criterion(`AC-${index}`),
          given: long(200),
          when: long(200),
          // biome-ignore lint/suspicious/noThenProperty: the published acceptance-criterion field name
          then: long(200),
          validation: { kind: 'test' as const, value: long(200) },
        })),
      }),
      parentKey: 'ACME-1',
    });
    expect(body.length).toBe(16_605);
  });
});
