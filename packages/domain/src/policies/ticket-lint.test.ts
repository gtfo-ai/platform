/**
 * The ticket readiness linter's three pure decisions (WP-25).
 *
 * The filter is asserted in **both** directions everywhere (standing rule 42): every refusal has a
 * twin that matches, so a filter that refused everything — the cheapest way to pass a test suite of
 * refusals — fails here.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LINT_ISSUE_TYPES,
  DEFAULT_LINT_LABEL,
  MAX_LINT_MISSING,
  MAX_LINT_QUESTIONS,
  OPEN_QUESTION_PENALTY,
  READINESS_PENALTIES,
  scoreTicketReadiness,
  selectLintQuestions,
  type TicketLintSettings,
  type TicketLintSpec,
  ticketMatchesLintFilter,
} from './ticket-lint.js';

const settings = (overrides: Partial<TicketLintSettings> = {}): TicketLintSettings => ({
  enabled: true,
  issueTypes: DEFAULT_LINT_ISSUE_TYPES,
  label: DEFAULT_LINT_LABEL,
  ...overrides,
});

const criterion = (kind: 'command' | 'test' | 'manual' = 'test') => ({
  validation: { kind },
});

/** A spec with every gap closed and no questions — the only input that scores 100. */
const READY: TicketLintSpec = {
  in_scope: ['the footer'],
  out_of_scope: ['the header'],
  acceptance_criteria: [criterion('test')],
  questions: [],
};

describe('which tickets are linted', () => {
  it('lints a configured issue type that carries no agent label', () => {
    const match = ticketMatchesLintFilter(settings(), { issueType: 'Bug', labels: ['billing'] });
    expect(match.matched).toBe(true);
    expect(match.reason).toContain('carries no agent label');
  });

  it('does not lint a ticket that is labelled for the agent, whatever its type', () => {
    const match = ticketMatchesLintFilter(settings(), {
      issueType: 'Bug',
      labels: ['billing', DEFAULT_LINT_LABEL],
    });
    expect(match.matched).toBe(false);
    expect(match.reason).toContain('the pipeline delivers it');
  });

  it('does not lint an issue type the project did not configure', () => {
    const match = ticketMatchesLintFilter(settings({ issueTypes: ['Bug'] }), {
      issueType: 'Epic',
      labels: [],
    });
    expect(match.matched).toBe(false);
    expect(match.reason).toContain('"Epic" is not an issue type');
  });

  it('lints nothing when the feature is off, and the same ticket when it is on', () => {
    const candidate = { issueType: 'Story', labels: [] };
    expect(ticketMatchesLintFilter(settings({ enabled: false }), candidate).matched).toBe(false);
    expect(ticketMatchesLintFilter(settings(), candidate).matched).toBe(true);
  });

  /**
   * An **explicitly empty** list is "the types I named", which is none — the fail-closed reading
   * `review_only.paths` takes for the same shape. The default list is what an absent one resolves
   * to, and that happens in `resolveTicketLintSettings`, one ring out.
   */
  it('lints nothing when the project configured an empty issue-type list', () => {
    const match = ticketMatchesLintFilter(settings({ issueTypes: [] }), {
      issueType: 'Story',
      labels: [],
    });
    expect(match.matched).toBe(false);
    expect(match.reason).toBe('the project lints no issue type');
  });

  it('compares the type and the label case-insensitively and after trimming', () => {
    expect(
      ticketMatchesLintFilter(settings({ issueTypes: [' story '] }), {
        issueType: 'Story',
        labels: [],
      }).matched,
    ).toBe(true);
    expect(
      ticketMatchesLintFilter(settings(), { issueType: 'Story', labels: [' AGENTIC '] }).matched,
    ).toBe(false);
  });

  it('lints nothing for a provider that gives no issue type at all', () => {
    const match = ticketMatchesLintFilter(settings(), { issueType: null, labels: [] });
    expect(match.matched).toBe(false);
    expect(match.reason).toContain('no issue type');
  });
});

describe('the readiness score', () => {
  it('is 100 for a spec with nothing missing and nothing to ask', () => {
    expect(scoreTicketReadiness(READY)).toEqual({ score: 100, missing: [], questions: 0 });
  });

  it('is 0 for the emptiest possible ticket with the full five questions', () => {
    const readiness = scoreTicketReadiness({
      questions: Array.from({ length: MAX_LINT_QUESTIONS }, (_, at) => ({
        text: `q${at}`,
        blocking: false,
      })),
    });
    expect(readiness.score).toBe(0);
    // Every gap is named, most costly first — product/19 § 17's own order.
    expect(readiness.missing).toEqual(['acceptance_criteria', 'scope_boundaries', 'validation']);
  });

  it('charges each gap what the table says and nothing more', () => {
    // Only the scope boundary is missing: half a boundary is still a missing boundary.
    const halfScoped = scoreTicketReadiness({ ...READY, out_of_scope: [] });
    expect(halfScoped.missing).toEqual(['scope_boundaries']);
    expect(halfScoped.score).toBe(100 - READINESS_PENALTIES.scope_boundaries);

    // Criteria exist but none of them can be checked by a machine.
    const manual = scoreTicketReadiness({ ...READY, acceptance_criteria: [criterion('manual')] });
    expect(manual.missing).toEqual(['validation']);
    expect(manual.score).toBe(100 - READINESS_PENALTIES.validation);
  });

  it('counts the absence of criteria as two gaps, because both are advice the author needs', () => {
    const readiness = scoreTicketReadiness({ ...READY, acceptance_criteria: [] });
    expect(readiness.missing).toEqual(['acceptance_criteria', 'validation']);
    expect(readiness.score).toBe(
      100 - READINESS_PENALTIES.acceptance_criteria - READINESS_PENALTIES.validation,
    );
  });

  it('charges the questions it will actually post, never the ones it drops', () => {
    const readiness = scoreTicketReadiness({
      ...READY,
      questions: Array.from({ length: MAX_LINT_QUESTIONS + 4 }, (_, at) => ({
        text: `q${at}`,
        blocking: false,
      })),
    });
    expect(readiness.questions).toBe(MAX_LINT_QUESTIONS);
    expect(readiness.score).toBe(100 - MAX_LINT_QUESTIONS * OPEN_QUESTION_PENALTY);
  });

  it('never reports more than the top three gaps', () => {
    expect(scoreTicketReadiness({}).missing.length).toBeLessThanOrEqual(MAX_LINT_MISSING);
  });

  /** The caller reads this out of a `jsonb` column, so absent is not the same as malformed. */
  it('treats an artifact with none of the fields as the emptiest ticket rather than throwing', () => {
    expect(() => scoreTicketReadiness({} as TicketLintSpec)).not.toThrow();
    expect(scoreTicketReadiness({ acceptance_criteria: null, questions: null }).score).toBe(
      100 -
        READINESS_PENALTIES.acceptance_criteria -
        READINESS_PENALTIES.scope_boundaries -
        READINESS_PENALTIES.validation,
    );
  });
});

describe('the questions the comment carries', () => {
  it('puts the blocking ones first and keeps the model’s order inside each group', () => {
    expect(
      selectLintQuestions({
        questions: [
          { text: 'nice to know', blocking: false },
          { text: 'blocks A', blocking: true },
          { text: 'also nice', blocking: false },
          { text: 'blocks B', blocking: true },
        ],
      }),
    ).toEqual(['blocks A', 'blocks B', 'nice to know', 'also nice']);
  });

  it('takes at most five, and takes them all when there are fewer', () => {
    const many = Array.from({ length: 9 }, (_, at) => ({ text: `q${at}`, blocking: false }));
    expect(selectLintQuestions({ questions: many })).toHaveLength(MAX_LINT_QUESTIONS);
    expect(selectLintQuestions({ questions: many.slice(0, 2) })).toHaveLength(2);
  });

  it('drops a blank question rather than spending a line on it', () => {
    expect(
      selectLintQuestions({
        questions: [{ text: '   ', blocking: true }, { text: 'a real one' }],
      }),
    ).toEqual(['a real one']);
  });
});
