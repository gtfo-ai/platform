/**
 * The human-return decision table — WP-174 criterion (6) (TD-029 decisions 6, 7 and 9). Status
 * names are invented fixture values.
 */
import { describe, expect, it } from 'vitest';
import { PLATFORM_COMMENT_MARKERS } from '../ask/ask.js';
import {
  type HumanReturnInput,
  type HumanWord,
  type HumanWordForm,
  humanReturnDecision,
  isPlatformWord,
} from './human-return.js';

const HORIZON = '2026-10-08T10:00:00.000Z';
const AFTER = '2026-10-08T11:00:00.000Z';
const BEFORE = '2026-10-08T09:00:00.000Z';

const SLOTS = {
  lifecycle: {
    in_progress: 'Doing',
    in_review: 'Waiting for review',
    qa: 'Testing',
    returned: ['Sent back'],
  },
  pickUpFrom: 'Backlog',
};

const input = (overrides: Partial<HumanReturnInput>): HumanReturnInput => ({
  stage: 'ready_for_merge',
  slots: SLOTS,
  status: null,
  words: [],
  horizon: HORIZON,
  extraAcks: [],
  leftQa: null,
  // The status the ticket had when the human stage began: the approved status, as the shipped flow
  // leaves it (WP-178 review amendment (a)).
  entryStatus: 'Reviewed',
  seenAtQa: false,
  ...overrides,
});

const word = (form: HumanWordForm, text: string, at = AFTER): HumanWord => ({ form, text, at });

const HUMAN_STAGES = ['qa', 'ready_for_merge'] as const;

/** A marker as the platform writes it: a parameterised one with an id, `agentic:linter` alone. */
const written = (marker: string): string => (marker.endsWith(':') ? `${marker}t1` : marker);
const WORD_FORMS: readonly HumanWordForm[] = ['mr_diff', 'mr_note', 'ticket_comment'];

describe('humanReturnDecision (WP-174 criterion 6)', () => {
  describe.each(HUMAN_STAGES)('at %s', (stage) => {
    it.each(WORD_FORMS)('returns on a person’s %s newer than the horizon', (form) => {
      expect(humanReturnDecision(input({ stage, words: [word(form, 'Please rename X')] }))).toEqual(
        {
          kind: 'return',
          from: stage,
          forms: [form],
          counts: { mr_diff: 0, mr_note: 0, ticket_comment: 0, [form]: 1 },
          status: null,
        },
      );
    });

    it.each([['Sent back'], ['doing'], ['BACKLOG']])(
      'returns on the status form alone — %s, a returned, in_progress or pick_up_from status',
      (status) => {
        expect(humanReturnDecision(input({ stage, status }))).toEqual({
          kind: 'return',
          from: stage,
          forms: ['status'],
          counts: { mr_diff: 0, mr_note: 0, ticket_comment: 0 },
          status,
        });
      },
    );

    it('records every contributing form once, in the schema’s order, with the counts', () => {
      expect(
        humanReturnDecision(
          input({
            stage,
            status: 'Sent back',
            words: [
              word('ticket_comment', 'still broken'),
              word('mr_diff', 'rename this'),
              word('mr_diff', 'and this'),
              word('mr_note', 'thanks!'),
            ],
          }),
        ),
      ).toEqual({
        kind: 'return',
        from: stage,
        forms: ['status', 'mr_diff', 'ticket_comment'],
        counts: { mr_diff: 2, mr_note: 0, ticket_comment: 1 },
        status: 'Sent back',
      });
    });

    it('gives none for acknowledgements alone', () => {
      expect(
        humanReturnDecision(
          input({
            stage,
            status: stage === 'qa' ? 'Testing' : null,
            words: [word('mr_note', 'LGTM 👍'), word('ticket_comment', 'thanks!')],
          }),
        ),
      ).toEqual({ kind: 'none' });
    });

    it('gives none for a platform-marked word, a system note and a word older than the horizon', () => {
      expect(
        humanReturnDecision(
          input({
            stage,
            status: stage === 'qa' ? 'Testing' : null,
            words: [
              word('mr_note', '<!-- agentic:reply:t1.r1.0 -->\nFixed in the last commit.'),
              word('mr_diff', '<!-- agentic:review-finding:t1.r1.f1 -->\nRename this.'),
              word('ticket_comment', 'agentic:claim-refused:t1\nClaim refused.'),
              { ...word('ticket_comment', 'Our workpad'), markerId: 'agentic:task:t1' },
              { ...word('mr_note', 'changed the description'), system: true },
              word('mr_note', 'Please rename X', BEFORE),
            ],
          }),
        ),
      ).toEqual({ kind: 'none' });
    });

    it('reads an acknowledgement in the project’s own language only when it is configured', () => {
      const words = [word('ticket_comment', 'Díky!')];
      expect(humanReturnDecision(input({ stage, words, status: 'Testing' })).kind).toBe('return');
      expect(
        humanReturnDecision(input({ stage, words, status: 'Testing', extraAcks: ['díky'] })),
      ).toEqual({ kind: 'none' });
    });
  });

  it('passes only at qa: the ticket left the qa status for a status that is not a return status', () => {
    const left = { leftQa: 'Finished' };
    expect(humanReturnDecision(input({ stage: 'qa', status: 'Finished', ...left }))).toEqual({
      kind: 'pass',
      status: 'Finished',
    });
    expect(
      humanReturnDecision(input({ stage: 'ready_for_merge', status: 'Finished', ...left })),
    ).toEqual({
      kind: 'none',
    });
    // Still in the qa status, or unreadable: no pass.
    expect(humanReturnDecision(input({ stage: 'qa', status: 'testing', ...left }))).toEqual({
      kind: 'none',
    });
    expect(humanReturnDecision(input({ stage: 'qa', status: null, ...left }))).toEqual({
      kind: 'none',
    });
    // An acknowledgement beside the pass does not stop it; a request does, and wins.
    expect(
      humanReturnDecision(
        input({ stage: 'qa', status: 'Finished', words: [word('mr_note', 'thanks!')], ...left }),
      ),
    ).toEqual({ kind: 'pass', status: 'Finished' });
    expect(
      humanReturnDecision(
        input({
          stage: 'qa',
          status: 'Finished',
          words: [word('mr_note', 'one more thing')],
          ...left,
        }),
      ).kind,
    ).toBe('return');
  });

  /**
   * WP-178 criterion (14): a pass is the ticket **leaving** `qa` (TD-029 decision 9). A task that
   * entered `qa` with its ticket still at the `approved` status — the `qa` write refused — must not
   * pass on the first firing of the window; only a recorded move out of the `qa` status does.
   */
  it('(14) never passes before the ticket was seen leaving the qa status', () => {
    // The ticket still sits at its approved status; nobody moved it out of qa.
    expect(humanReturnDecision(input({ stage: 'qa', status: 'Reviewed', leftQa: null }))).toEqual({
      kind: 'none',
    });
    // A move out of qa to a return status is a return, never a pass.
    expect(
      humanReturnDecision(input({ stage: 'qa', status: 'Finished', leftQa: 'Sent back' })),
    ).toEqual({ kind: 'none' });
    // Then the recorded move from the qa slot to a status that moves on: a pass.
    expect(
      humanReturnDecision(input({ stage: 'qa', status: 'Finished', leftQa: 'Finished' })),
    ).toEqual({ kind: 'pass', status: 'Finished' });
  });

  /**
   * WP-178 review, TD-029 decision 7's amendment (a): the status form is a **change**. With partial
   * mapping the ticket reaches the human stage still at a status the form counts — `in_progress`, or
   * the pick-up status when nothing else is mapped — and an acknowledgement must then return nothing.
   */
  it.each([
    [
      'only in_progress mapped, the ticket left at it',
      { in_progress: 'Doing' },
      'Backlog',
      'Doing',
    ],
    ['an empty block, the ticket left at the pick-up status', {}, 'Backlog', 'Backlog'],
  ] as const)(
    '(a) gives none for %s with only an acknowledgement, at both stages',
    (_name, lifecycle, pickUpFrom, status) => {
      for (const stage of HUMAN_STAGES) {
        expect(
          humanReturnDecision(
            input({
              stage,
              slots: { lifecycle, pickUpFrom },
              status,
              entryStatus: status,
              words: [word('mr_note', 'LGTM')],
            }),
          ),
        ).toEqual({ kind: 'none' });
      }
    },
  );

  it('(a) returns on a real move into a return status, and on nothing while the entry is unknown', () => {
    const partial = {
      lifecycle: { in_progress: 'Doing', returned: ['Sent back'] },
      pickUpFrom: null,
    };
    for (const stage of HUMAN_STAGES) {
      expect(
        humanReturnDecision(
          input({ stage, slots: partial, status: 'Sent back', entryStatus: 'Doing' }),
        ),
      ).toMatchObject({ kind: 'return', forms: ['status'], status: 'Sent back' });
      // Back at the entry status (TD-029 decision 7's amendment (a); which status is the entry is
      // the window's, amendment (e)): no change, no return.
      expect(
        humanReturnDecision(
          input({ stage, slots: partial, status: 'doing', entryStatus: 'Doing' }),
        ),
      ).toEqual({ kind: 'none' });
      expect(
        humanReturnDecision(
          input({ stage, slots: partial, status: 'Sent back', entryStatus: null }),
        ),
      ).toEqual({ kind: 'none' });
    }
  });

  /**
   * Amendment (b): the pass reads the same record. A binding that only polls records no `from`, so
   * `leftQa` is null; the ticket's entry status at the `qa` slot — or a sighting of it since — and a
   * current status that is neither `qa` nor a return status is a pass.
   */
  it('(b) passes a poll-only-shaped input: no recorded from, entry at qa, now moved on', () => {
    expect(
      humanReturnDecision(
        input({ stage: 'qa', status: 'Finished', leftQa: null, entryStatus: 'Testing' }),
      ),
    ).toEqual({ kind: 'pass', status: 'Finished' });
    expect(
      humanReturnDecision(
        input({
          stage: 'qa',
          status: 'Finished',
          leftQa: null,
          entryStatus: 'Reviewed',
          seenAtQa: true,
        }),
      ),
    ).toEqual({ kind: 'pass', status: 'Finished' });
    // Never at qa: no pass, whatever the current status.
    expect(humanReturnDecision(input({ stage: 'qa', status: 'Finished', leftQa: null }))).toEqual({
      kind: 'none',
    });
    // Moved from qa to a return status that equals nothing new is no pass either.
    expect(
      humanReturnDecision(
        input({
          stage: 'qa',
          slots: { ...SLOTS, lifecycle: { ...SLOTS.lifecycle, in_progress: 'Doing' } },
          status: 'Doing',
          entryStatus: 'Doing',
          seenAtQa: true,
        }),
      ),
    ).toEqual({ kind: 'none' });
  });

  /** Amendment (c), Q119: an `@agentic ask` ticket comment is answered by ask-the-task. */
  it('(c) gives none for an @agentic ask ticket comment, at both stages', () => {
    for (const stage of HUMAN_STAGES) {
      expect(
        humanReturnDecision(
          input({
            stage,
            words: [
              word('ticket_comment', '@agentic ask why did you sum the visible rows?'),
              word('ticket_comment', '  @agentic why a column?'),
            ],
          }),
        ),
      ).toEqual({ kind: 'none' });
    }
  });

  it('never passes when no qa slot is mapped', () => {
    expect(
      humanReturnDecision(
        input({
          stage: 'qa',
          slots: { lifecycle: { in_progress: 'Doing' }, pickUpFrom: null },
          status: 'Finished',
          leftQa: 'Finished',
        }),
      ),
    ).toEqual({ kind: 'none' });
  });

  it.each(['implementation', 'code_review', 'business_review', 'rebase_gate', 'merged_gate'])(
    'gives none at %s, whatever the status and the words',
    (stage) => {
      expect(
        humanReturnDecision(
          input({ stage, status: 'Sent back', words: [word('mr_note', 'Please rename X')] }),
        ),
      ).toEqual({ kind: 'none' });
    },
  );

  it('counts every word when there is no horizon yet, and one whose timestamp cannot be read', () => {
    expect(
      humanReturnDecision(input({ horizon: null, words: [word('mr_note', 'fix', BEFORE)] })).kind,
    ).toBe('return');
    expect(humanReturnDecision(input({ words: [word('mr_note', 'fix', 'yesterday')] })).kind).toBe(
      'return',
    );
  });
});

describe('isPlatformWord — by marker, never by author (TD-029 decision 6)', () => {
  it('reads a merge-request marker only when the note opens with it', () => {
    expect(isPlatformWord(word('mr_note', '  <!-- agentic:reply:t.r.1 --> done'))).toBe(true);
    expect(isPlatformWord(word('mr_note', '> <!-- agentic:reply:t.r.1 -->\nno, not done'))).toBe(
      false,
    );
  });

  it('reads every ticket marker the platform writes, the claim refusal and the reply included (WP-174 ruling f)', () => {
    expect(PLATFORM_COMMENT_MARKERS).toEqual(
      expect.arrayContaining(['agentic:claim-refused:', 'agentic:reply:']),
    );
    for (const marker of PLATFORM_COMMENT_MARKERS) {
      expect(isPlatformWord(word('ticket_comment', `${written(marker)}\ntext`))).toBe(true);
      expect(isPlatformWord(word('ticket_comment', `  ${written(marker)} text`))).toBe(true);
    }
    expect(isPlatformWord(word('ticket_comment', 'a person’s comment'))).toBe(false);
  });

  /**
   * WP-178 criterion (15): TD-029 decision 6 says the body **opens with** a marker. A person who
   * quotes a whole platform comment while asking for a change is a person, and returns the task.
   */
  it.each(PLATFORM_COMMENT_MARKERS)(
    '(15) reads a ticket marker %s only at the start, so a quoting person still returns the task',
    (marker) => {
      const quoting = `> ${written(marker)}\n> **Asked and answered**\n\nplease rename X`;
      expect(isPlatformWord(word('ticket_comment', quoting))).toBe(false);
      expect(isPlatformWord(word('ticket_comment', `please rename X — ${written(marker)}`))).toBe(
        false,
      );
      for (const stage of HUMAN_STAGES) {
        expect(
          humanReturnDecision(input({ stage, words: [word('ticket_comment', quoting)] })).kind,
        ).toBe('return');
        expect(
          humanReturnDecision(
            input({
              stage,
              words: [word('ticket_comment', `${written(marker)}\nplease rename X`)],
            }),
          ).kind,
        ).toBe('none');
      }
    },
  );

  /**
   * WP-191 criterion (2), backlog 546: the four ticket bodies that once carried their marker only
   * as the provider's `marker_id` open with it in the body, so with **no** `marker_id` each is still
   * the platform's. The first lines are the renderers' shapes (`platform-marker-census.test.ts`
   * renders the real bodies in the application ring, which this ring cannot import).
   */
  const TASK = '0199a0b0-1111-7000-8000-0000000191a1';
  const FOUR_BODIES = [
    { name: 'the workpad', body: `agentic:task:${TASK}\n**ACME-1** — running (implementation)` },
    {
      name: 'the linter’s comment',
      body: 'agentic:linter <!-- agentic:linter -->\n**Agent readiness: 45/100** — missing: scope boundaries.',
    },
    {
      name: 'the spike report',
      body: `agentic:spike-report:${TASK}:1\n# Spike: ACME-1\n\n**Question**: which store?`,
    },
    {
      name: 'the claim refusal',
      body: `agentic:claim-refused:${TASK}\nThe agent did not start work on this ticket: it is assigned to somebody else.`,
    },
  ] as const;

  it('(WP-191) reads a person’s comment that opens with a word extending `agentic:linter` as a person’s', () => {
    for (const text of ['agentic:linterX is noisy', 'agentic:linters are noisy\nplease stop']) {
      const person: HumanWord = { form: 'ticket_comment', text, at: AFTER, markerId: null };
      expect(isPlatformWord(person)).toBe(false);
      for (const stage of HUMAN_STAGES) {
        expect(humanReturnDecision(input({ stage, words: [person] })).kind).toBe('return');
      }
    }
    // The delimited spellings are still the platform's.
    for (const text of [
      'agentic:linter',
      'agentic:linter\nx',
      'agentic:linter <!-- agentic:linter -->',
    ]) {
      expect(isPlatformWord({ form: 'ticket_comment', text, at: AFTER, markerId: null })).toBe(
        true,
      );
    }
  });

  it.each(FOUR_BODIES)(
    '(WP-191) reads $name as the platform’s with no marker_id, and a person quoting its marker on the second line as a person',
    ({ body }) => {
      const bare: HumanWord = { form: 'ticket_comment', text: body, at: AFTER, markerId: null };
      expect(isPlatformWord(bare)).toBe(true);
      const [marker] = body.split(/\s/, 1);
      const quoting: HumanWord = {
        form: 'ticket_comment',
        text: `please rename X\n${marker} was the platform's`,
        at: AFTER,
        markerId: null,
      };
      expect(isPlatformWord(quoting)).toBe(false);
      for (const stage of HUMAN_STAGES) {
        expect(humanReturnDecision(input({ stage, words: [bare] })).kind).toBe('none');
        expect(humanReturnDecision(input({ stage, words: [quoting] })).kind).toBe('return');
      }
    },
  );
});
