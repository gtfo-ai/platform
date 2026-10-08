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
  ...overrides,
});

const word = (form: HumanWordForm, text: string, at = AFTER): HumanWord => ({ form, text, at });

const HUMAN_STAGES = ['qa', 'ready_for_merge'] as const;
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
              word('ticket_comment', 'Claim refused — agentic:claim-refused:t1'),
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
    expect(humanReturnDecision(input({ stage: 'qa', status: 'Finished' }))).toEqual({
      kind: 'pass',
      status: 'Finished',
    });
    expect(humanReturnDecision(input({ stage: 'ready_for_merge', status: 'Finished' }))).toEqual({
      kind: 'none',
    });
    // Still in the qa status, or unreadable: no pass.
    expect(humanReturnDecision(input({ stage: 'qa', status: 'testing' }))).toEqual({
      kind: 'none',
    });
    expect(humanReturnDecision(input({ stage: 'qa', status: null }))).toEqual({ kind: 'none' });
    // An acknowledgement beside the pass does not stop it; a request does, and wins.
    expect(
      humanReturnDecision(
        input({ stage: 'qa', status: 'Finished', words: [word('mr_note', 'thanks!')] }),
      ),
    ).toEqual({ kind: 'pass', status: 'Finished' });
    expect(
      humanReturnDecision(
        input({ stage: 'qa', status: 'Finished', words: [word('mr_note', 'one more thing')] }),
      ).kind,
    ).toBe('return');
  });

  it('never passes when no qa slot is mapped', () => {
    expect(
      humanReturnDecision(
        input({
          stage: 'qa',
          slots: { lifecycle: { in_progress: 'Doing' }, pickUpFrom: null },
          status: 'Finished',
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
      expect(isPlatformWord(word('ticket_comment', `text ${marker}t1`))).toBe(true);
    }
    expect(isPlatformWord(word('ticket_comment', 'a person’s comment'))).toBe(false);
  });
});
