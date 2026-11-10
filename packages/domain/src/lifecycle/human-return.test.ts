/**
 * The human-return decision table — WP-174 criterion (6) (TD-029 decisions 6, 7 and 9), as M28
 * rulings R1 and R2 amend it (S-28.2): only an unresolved resolvable merge-request thread or a
 * return status returns a task; a ticket comment and a general note are *seen*; a forward status
 * move wins over a word written before it; a handled thread is old business until a newer note.
 * Status names are invented fixture values.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PLATFORM_COMMENT_MARKERS } from '../ask/ask.js';
import {
  type HandledThread,
  type HumanReturnInput,
  type HumanWord,
  type HumanWordForm,
  handledWords,
  humanReturnDecision,
  isForwardMove,
  isPlatformWord,
} from './human-return.js';

const HORIZON = '2026-10-08T10:00:00.000Z';
const AFTER = '2026-10-08T11:00:00.000Z';
const LATER = '2026-10-08T12:00:00.000Z';
const BEFORE = '2026-10-08T09:00:00.000Z';

const SLOTS = {
  lifecycle: {
    in_progress: 'Doing',
    in_review: 'Waiting for review',
    approved: 'Reviewed',
    qa: 'Testing',
    returned: ['Sent back'],
    done: 'Ready for Merge',
  },
  pickUpFrom: 'Backlog',
};

const input = (overrides: Partial<HumanReturnInput>): HumanReturnInput => ({
  stage: 'ready_for_merge',
  slots: SLOTS,
  status: null,
  words: [],
  horizon: HORIZON,
  handled: [],
  forwardSeenAt: null,
  leftQa: null,
  // The status the ticket had when the human stage began: the approved status, as the shipped flow
  // leaves it (WP-178 review amendment (a)).
  entryStatus: 'Reviewed',
  seenAtQa: false,
  ...overrides,
});

/** A word that is not in a resolvable thread: a ticket comment, or a general note. */
const word = (form: HumanWordForm, text: string, at = AFTER): HumanWord => ({ form, text, at });

/** A person's note in an unresolved, resolvable merge-request discussion (M28 R1 (b)). */
const thread = (
  form: 'mr_diff' | 'mr_note',
  text: string,
  at = AFTER,
  ids: { threadId?: string; noteId?: string } = {},
): HumanWord => ({
  form,
  text,
  at,
  resolvable: true,
  threadId: ids.threadId ?? 'd1',
  noteId: ids.noteId ?? 'n1',
});

const HUMAN_STAGES = ['qa', 'ready_for_merge'] as const;

/** A marker as the platform writes it: a parameterised one with an id, `agentic:linter` alone. */
const written = (marker: string): string => (marker.endsWith(':') ? `${marker}t1` : marker);

describe('humanReturnDecision (WP-174 criterion 6, M28 R1)', () => {
  describe.each(HUMAN_STAGES)('at %s', (stage) => {
    it.each(['mr_diff', 'mr_note'] as const)(
      'returns on a person’s note in an unresolved resolvable %s thread',
      (form) => {
        expect(
          humanReturnDecision(input({ stage, words: [thread(form, 'Please rename X')] })),
        ).toEqual({
          kind: 'return',
          from: stage,
          forms: [form],
          counts: { mr_diff: 0, mr_note: 0, ticket_comment: 0, [form]: 1 },
          status: null,
          seen: [],
        });
      },
    );

    /**
     * AUT-6655: a long Czech *QA: OK* at Ready returned the task twice. A ticket comment alone is
     * never a change request now — whatever it says, in any language — and it is recorded as seen.
     */
    it.each([
      'QA – MR !2768: OK. Otestováno na stagingu, vše funguje podle zadání, můžete mergovat.',
      'Please rename X before merging',
      'thanks!',
    ])('a ticket comment alone does not return the task, and is seen: %s', (text) => {
      const comment = word('ticket_comment', text);
      expect(humanReturnDecision(input({ stage, words: [comment] }))).toEqual({
        kind: 'none',
        seen: [comment],
      });
    });

    it('a general note that cannot be resolved does not return the task, and is seen', () => {
      const note = word('mr_note', 'Please rename X');
      expect(humanReturnDecision(input({ stage, words: [note] }))).toEqual({
        kind: 'none',
        seen: [note],
      });
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
          seen: [],
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
              thread('mr_diff', 'rename this'),
              thread('mr_diff', 'and this', AFTER, { noteId: 'n2' }),
              word('mr_note', 'thanks!'),
            ],
          }),
        ),
      ).toEqual({
        kind: 'return',
        from: stage,
        forms: ['status', 'mr_diff'],
        counts: { mr_diff: 2, mr_note: 0, ticket_comment: 0 },
        status: 'Sent back',
        seen: [],
      });
    });

    it('gives none for a platform-marked word, a system note and a word older than the horizon', () => {
      expect(
        humanReturnDecision(
          input({
            stage,
            status: stage === 'qa' ? 'Testing' : null,
            words: [
              thread('mr_note', '<!-- agentic:reply:t1.r1.0 -->\nFixed in the last commit.'),
              thread('mr_diff', '<!-- agentic:review-finding:t1.r1.f1 -->\nRename this.'),
              word('ticket_comment', 'agentic:claim-refused:t1\nClaim refused.'),
              { ...word('ticket_comment', 'Our workpad'), markerId: 'agentic:task:t1' },
              { ...thread('mr_note', 'changed the description'), system: true },
              thread('mr_note', 'Please rename X', BEFORE),
            ],
          }),
        ),
      ).toEqual({ kind: 'none', seen: [] });
    });

    /** Amendment (c), Q119: an `@agentic ask` ticket comment is answered by ask-the-task. */
    it('(c) gives no return for an @agentic ask ticket comment, and does not record it as seen', () => {
      expect(
        humanReturnDecision(
          input({ stage, words: [word('ticket_comment', '@agentic ask why a column?')] }),
        ),
      ).toEqual({ kind: 'none', seen: [] });
    });
  });

  describe('forward wins over return (M28 R1)', () => {
    it.each(HUMAN_STAGES)(
      'at %s, a forward move and a thread note written before it: nothing returns',
      (stage) => {
        const note = thread('mr_diff', 'one more thing');
        const decision = humanReturnDecision(
          input({
            stage,
            status: 'Ready for Merge',
            entryStatus: stage === 'qa' ? 'Testing' : 'Reviewed',
            forwardSeenAt: LATER,
            words: [note, word('ticket_comment', 'QA OK')],
          }),
        );
        expect(decision.kind).not.toBe('return');
        expect(decision.seen).toHaveLength(2);
      },
    );

    it('a forward move first seen in this firing (no recorded instant) blocks every word read', () => {
      expect(
        humanReturnDecision(
          input({
            status: 'Ready for Merge',
            forwardSeenAt: null,
            words: [thread('mr_diff', 'one more thing', LATER)],
          }),
        ).kind,
      ).toBe('none');
    });

    it('a thread note written after the forward move was first seen still returns', () => {
      expect(
        humanReturnDecision(
          input({
            status: 'Ready for Merge',
            forwardSeenAt: AFTER,
            words: [thread('mr_diff', 'found a bug', LATER)],
          }),
        ),
      ).toMatchObject({ kind: 'return', forms: ['mr_diff'] });
    });

    it('at qa a forward move with a thread note passes rather than returns', () => {
      expect(
        humanReturnDecision(
          input({
            stage: 'qa',
            status: 'Ready for Merge',
            entryStatus: 'Testing',
            forwardSeenAt: LATER,
            words: [thread('mr_diff', 'nit')],
          }),
        ),
      ).toMatchObject({ kind: 'pass', status: 'Ready for Merge' });
    });

    it('isForwardMove: a change to a slot ahead of the stage, never the entry itself (review of #139)', () => {
      const of = (status: string | null, entryStatus: string | null, stage = 'ready_for_merge') =>
        isForwardMove({ stage, slots: SLOTS, status, entryStatus });
      expect(of('Ready for Merge', 'Reviewed')).toBe(true);
      expect(of('Reviewed', 'Testing')).toBe(true);
      expect(of('Ready for Merge', 'Testing', 'qa')).toBe(true);
      // An unmapped status is not forward.
      expect(of('Reopened', 'Reviewed')).toBe(false);
      // The platform's own writes, landing late, are never forward: in_review, approved at qa, qa at qa.
      expect(of('Waiting for review', 'Reviewed')).toBe(false);
      expect(of('Reviewed', 'Testing', 'qa')).toBe(false);
      expect(of('Testing', 'Reviewed', 'qa')).toBe(false);
      expect(of('reviewed', 'Reviewed')).toBe(false);
      expect(of('Sent back', 'Reviewed')).toBe(false);
      expect(of('Doing', 'Reviewed')).toBe(false);
      expect(of(null, 'Reviewed')).toBe(false);
      expect(of('Ready for Merge', null)).toBe(false);
    });

    it('an unmapped status beside an open review thread: the thread still returns the task', () => {
      expect(
        humanReturnDecision(
          input({
            status: 'Reopened',
            forwardSeenAt: null,
            words: [thread('mr_diff', 'one more thing')],
          }),
        ),
      ).toMatchObject({ kind: 'return', forms: ['mr_diff'] });
    });

    it('the platform’s own in_review write landing late does not outrank an open thread', () => {
      expect(
        humanReturnDecision(
          input({
            status: 'Waiting for review',
            forwardSeenAt: null,
            words: [thread('mr_diff', 'one more thing')],
          }),
        ).kind,
      ).toBe('return');
    });
  });

  describe('the handled ledger (M28 R2)', () => {
    const handled = (overrides: Partial<HandledThread> = {}): HandledThread => ({
      source: 'mr_thread',
      threadId: 'd1',
      lastNoteId: 'n1',
      handledAt: AFTER,
      ...overrides,
    });

    it('a handled thread does not return the task, and is not seen again', () => {
      expect(
        humanReturnDecision(
          input({ words: [thread('mr_diff', 'rename X')], handled: [handled()] }),
        ),
      ).toEqual({ kind: 'none', seen: [] });
    });

    it('a handled thread with a newer person note returns the task', () => {
      const newer = thread('mr_diff', 'still wrong', LATER, { noteId: 'n2' });
      expect(
        humanReturnDecision(
          input({ words: [thread('mr_diff', 'rename X'), newer], handled: [handled()] }),
        ),
      ).toMatchObject({ kind: 'return', counts: { mr_diff: 1 } });
    });

    it('a row that names no note the window read covers the words written no later than it', () => {
      const words = [
        thread('mr_diff', 'rename X', AFTER, { noteId: 'gone' }),
        thread('mr_diff', 'still wrong', LATER, { noteId: 'n9' }),
      ];
      const covered = handledWords(words, [handled({ lastNoteId: null })]);
      expect([...covered]).toEqual([words[0]]);
    });

    it('a row of another source or thread handles nothing', () => {
      const words = [thread('mr_diff', 'rename X')];
      expect(handledWords(words, [handled({ source: 'mr_note' })]).size).toBe(0);
      expect(handledWords(words, [handled({ threadId: 'd2' })]).size).toBe(0);
    });

    it('a seen ticket comment is not seen twice', () => {
      const comment = {
        ...word('ticket_comment', 'QA OK'),
        threadId: 'c1',
        noteId: 'c1',
      };
      const once = humanReturnDecision(input({ words: [comment] }));
      expect(once.seen).toEqual([comment]);
      expect(
        humanReturnDecision(
          input({
            words: [comment],
            handled: [handled({ source: 'ticket_comment', threadId: 'c1', lastNoteId: 'c1' })],
          }),
        ).seen,
      ).toEqual([]);
    });
  });

  /** Property: whatever ticket comments and general notes say, alone they never return a task. */
  it('never returns on ticket comments and non-resolvable notes alone (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            form: fc.constantFrom<HumanWordForm>('ticket_comment', 'mr_note', 'mr_diff'),
            text: fc.string(),
          }),
          { maxLength: 8 },
        ),
        fc.constantFrom(...HUMAN_STAGES),
        (drawn, stage) => {
          const words = drawn.map((entry) => word(entry.form, entry.text));
          expect(humanReturnDecision(input({ stage, words })).kind).not.toBe('return');
        },
      ),
    );
  });

  it('passes only at qa: the ticket left the qa status for a status that is not a return status', () => {
    const left = { leftQa: 'Finished' };
    expect(humanReturnDecision(input({ stage: 'qa', status: 'Finished', ...left }))).toEqual({
      kind: 'pass',
      status: 'Finished',
      seen: [],
    });
    expect(
      humanReturnDecision(input({ stage: 'ready_for_merge', status: 'Finished', ...left })),
    ).toEqual({ kind: 'none', seen: [] });
    // Still in the qa status, or unreadable: no pass.
    expect(humanReturnDecision(input({ stage: 'qa', status: 'testing', ...left })).kind).toBe(
      'none',
    );
    expect(humanReturnDecision(input({ stage: 'qa', status: null, ...left })).kind).toBe('none');
    // A ticket comment beside the pass does not stop it, and is seen.
    const comment = word('ticket_comment', 'one more thing');
    expect(
      humanReturnDecision(input({ stage: 'qa', status: 'Finished', words: [comment], ...left })),
    ).toEqual({ kind: 'pass', status: 'Finished', seen: [comment] });
  });

  /**
   * WP-178 criterion (14): a pass is the ticket **leaving** `qa` (TD-029 decision 9).
   */
  it('(14) never passes before the ticket was seen leaving the qa status', () => {
    expect(humanReturnDecision(input({ stage: 'qa', status: 'Reviewed', leftQa: null })).kind).toBe(
      'none',
    );
    expect(
      humanReturnDecision(input({ stage: 'qa', status: 'Finished', leftQa: 'Sent back' })).kind,
    ).toBe('none');
    expect(
      humanReturnDecision(input({ stage: 'qa', status: 'Finished', leftQa: 'Finished' })).kind,
    ).toBe('pass');
  });

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
      expect(
        humanReturnDecision(input({ stage, slots: partial, status: 'doing', entryStatus: 'Doing' }))
          .kind,
      ).toBe('none');
      expect(
        humanReturnDecision(
          input({ stage, slots: partial, status: 'Sent back', entryStatus: null }),
        ).kind,
      ).toBe('none');
    }
  });

  it('(b) passes a poll-only-shaped input: no recorded from, entry at qa, now moved on', () => {
    expect(
      humanReturnDecision(
        input({ stage: 'qa', status: 'Finished', leftQa: null, entryStatus: 'Testing' }),
      ).kind,
    ).toBe('pass');
    expect(
      humanReturnDecision(
        input({
          stage: 'qa',
          status: 'Finished',
          leftQa: null,
          entryStatus: 'Reviewed',
          seenAtQa: true,
        }),
      ).kind,
    ).toBe('pass');
    expect(humanReturnDecision(input({ stage: 'qa', status: 'Finished', leftQa: null })).kind).toBe(
      'none',
    );
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
      ).kind,
    ).toBe('none');
  });

  it.each(['implementation', 'code_review', 'business_review', 'rebase_gate', 'merged_gate'])(
    'gives none at %s, whatever the status and the words',
    (stage) => {
      expect(
        humanReturnDecision(
          input({ stage, status: 'Sent back', words: [thread('mr_note', 'Please rename X')] }),
        ),
      ).toEqual({ kind: 'none', seen: [] });
    },
  );

  it('counts every word when there is no horizon yet, and one whose timestamp cannot be read', () => {
    expect(
      humanReturnDecision(input({ horizon: null, words: [thread('mr_note', 'fix', BEFORE)] })).kind,
    ).toBe('return');
    expect(
      humanReturnDecision(input({ words: [thread('mr_note', 'fix', 'yesterday')] })).kind,
    ).toBe('return');
  });
});

/**
 * S-28.13 — TD-029 Amendment D.3: the platform closes its own finding thread after an approval with
 * *"Reopen this thread to have it changed"*, so a platform thread the platform resolved (a
 * `resolved` ledger row since the horizon) that is open again returns the task at Ready even with
 * no note — and nothing else about a platform thread does.
 */
describe('a reopened platform thread (TD-029 Amendment D.3, S-28.13)', () => {
  const finding =
    '<!-- agentic:review-finding:00000000-0000-4000-8000-0000000017a2.r1.n1 -->\n**nit · style**';
  const closing =
    '<!-- agentic:reply:00000000-0000-4000-8000-0000000017a2.left-d1 -->\n**Left as is**';
  const platform = (text: string, noteId: string): HumanWord =>
    thread('mr_diff', text, AFTER, { threadId: 'd1', noteId });
  const words = [platform(finding, 'n1'), platform(closing, 'n2')];
  const resolvedRow = (handledAt: string): HandledThread => ({
    source: 'mr_thread',
    threadId: 'd1',
    lastNoteId: 'n2',
    handledAt,
    kind: 'resolved',
  });

  it('returns the task at Ready when the platform had resolved it since the horizon', () => {
    const decision = humanReturnDecision(input({ words, handled: [resolvedRow(LATER)] }));
    expect(decision.kind).toBe('return');
    if (decision.kind === 'return') {
      expect(decision.counts.mr_diff).toBe(1);
      expect(decision.reopened?.map((word) => word.noteId)).toEqual(['n1']);
    }
  });

  it('returns nothing on platform notes the platform never resolved, or resolved before the horizon', () => {
    expect(humanReturnDecision(input({ words }))).toEqual({ kind: 'none', seen: [] });
    expect(humanReturnDecision(input({ words, handled: [resolvedRow(BEFORE)] }))).toEqual({
      kind: 'none',
      seen: [],
    });
  });

  it('returns nothing while the ticket has moved forward (forward wins)', () => {
    const decision = humanReturnDecision(
      input({
        words,
        handled: [resolvedRow(LATER)],
        status: 'Ready for Merge',
        entryStatus: 'Reviewed',
      }),
    );
    expect(decision.kind).not.toBe('return');
  });

  it('counts a person’s note in a reopened thread once, as the person’s word', () => {
    const decision = humanReturnDecision(
      input({
        words: [
          ...words,
          thread('mr_diff', 'Please change it after all.', LATER, { threadId: 'd1', noteId: 'n3' }),
        ],
        handled: [resolvedRow(AFTER)],
      }),
    );
    expect(decision.kind).toBe('return');
    if (decision.kind === 'return') {
      expect(decision.counts.mr_diff).toBe(1);
      expect(decision.reopened).toBeUndefined();
    }
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
   * quotes a whole platform comment while asking for a change is a person — whose ticket comment,
   * since M28 ruling R1, is recorded as seen rather than returning the task.
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
          humanReturnDecision(input({ stage, words: [word('ticket_comment', quoting)] })).seen,
        ).toHaveLength(1);
        expect(
          humanReturnDecision(
            input({
              stage,
              words: [word('ticket_comment', `${written(marker)}\nplease rename X`)],
            }),
          ).seen,
        ).toHaveLength(0);
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
        expect(humanReturnDecision(input({ stage, words: [person] })).seen).toEqual([person]);
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
        expect(humanReturnDecision(input({ stage, words: [bare] })).seen).toEqual([]);
        expect(humanReturnDecision(input({ stage, words: [quoting] })).seen).toEqual([quoting]);
      }
    },
  );
});
