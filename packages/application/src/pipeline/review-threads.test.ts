/**
 * `review-threads.ts` on its own (WP-46, WP-178): the panel's predicate, the words the window reads,
 * the one-line rule, and the cap that is always announced by the prompt block rather than by a body
 * line. The channel end to end — the next run's `return_feedback` block — is `saga.test.ts` and
 * `human-return.test.ts`.
 */
import type { HumanWord } from '@platform/domain';
import { isPlatformWord, MAX_FEEDBACK_CHARS } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { Discussion } from '../ports/integrations/git-provider.js';
import { conflictWarningMarker } from './conflict-warning.js';
import { reviewMarkerFor, reviewSummaryMarkerFor } from './review-only.js';
import {
  humanReturnFeedback,
  isOpenReviewThread,
  isPlatformNote,
  MAX_REVIEW_FEEDBACK_CHARS,
  mergeRequestWords,
  reviewThreadCounts,
  ticketCommentWords,
} from './review-threads.js';

const AT = '2026-06-01T09:00:00.000Z';

const note = (body: string, extra: Partial<Discussion['notes'][number]> = {}) => ({
  id: `n-${body.length}`,
  author: {
    provider: 'fake-git',
    external_id: '42',
    email: null,
    display_name: 'A human',
    verified: true,
  },
  body,
  created_at: AT,
  path: null,
  line: null,
  system: false,
  ...extra,
});

const thread = (
  notes: Discussion['notes'],
  flags: { resolvable?: boolean; resolved?: boolean } = {},
): Discussion => ({
  id: `t-${notes.length}`,
  resolvable: flags.resolvable ?? true,
  resolved: flags.resolved ?? false,
  notes,
});

const none = exactSecretRedactor([]);

/** The feedback of a return made by the merge request's words alone, every word counted. */
const feedbackOf = (threads: readonly Discussion[], redactor = none) =>
  humanReturnFeedback({
    stage: 'ready_for_merge',
    forms: ['mr_diff'],
    status: null,
    words: mergeRequestWords(threads),
    horizon: null,
    redactor,
  });

describe('which threads are open, and what the panel counts', () => {
  it('counts only resolvable threads, and a thread of system notes is not a review thread', () => {
    const threads = [
      thread([note('rename this')]),
      thread([note('merged main into branch', { system: true })]),
      thread([note('done')], { resolved: true }),
      thread([note('a plain remark')], { resolvable: false }),
    ];
    expect(threads.map(isOpenReviewThread)).toEqual([true, false, false, false]);
    expect(reviewThreadCounts(threads, AT)).toEqual({ open: 1, resolved: 1, checked_at: AT });
    expect(reviewThreadCounts([], AT)).toEqual({ open: 0, resolved: 0, checked_at: AT });
  });
});

/**
 * WP-73, PROGRESS backlog 214: the platform's own conflict warning is not a human review thread —
 * not on the panel, not in the Developer's feedback — and a human reply inside it is.
 */
describe('the platform’s own threads (backlog 214)', () => {
  const WARNING = `${conflictWarningMarker('00000000-0000-4000-8000-0000000000b1' as never)}\n**Heads up:** another open merge request changes src/totals.ts.`;

  it('counts a conflict-warning thread alone as no open thread, and returns nothing on it', () => {
    const threads = [thread([note(WARNING)])];
    expect(threads.map(isOpenReviewThread)).toEqual([false]);
    expect(reviewThreadCounts(threads, AT).open).toBe(0);
  });

  it('counts the warning thread open once a human replies in it, and quotes the human alone', () => {
    const replied = thread([note(WARNING), note('I will rebase after lunch')]);
    expect(isOpenReviewThread(replied)).toBe(true);
    const { reason } = feedbackOf([replied]);
    expect(reason).toContain('I will rebase after lunch');
    expect(reason).not.toContain('Heads up');
    expect(reason).not.toContain('agentic:conflict-warning');
  });

  it('recognises every marker the platform posts on a merge request, and not ordinary text', () => {
    const task = '00000000-0000-4000-8000-0000000000b1' as never;
    for (const marker of [
      conflictWarningMarker(task),
      reviewMarkerFor(task),
      reviewSummaryMarkerFor(task),
    ]) {
      expect(isPlatformNote({ body: `${marker}\nbody` }), marker).toBe(true);
    }
    expect(isPlatformNote({ body: 'agentic: please look at this' })).toBe(false);
  });

  it('keeps a human quote-reply that copies the marker a human note (review round 1)', () => {
    const quoted = `> ${WARNING.replace('\n', '\n> ')}\n\nI disagree, this overlap is fine.`;
    expect(isPlatformNote({ body: quoted })).toBe(false);
    // A marker further down a human's own note does not make it the platform's either.
    expect(isPlatformNote({ body: `see the warning\n${WARNING}` })).toBe(false);
    const replied = thread([note(quoted)]);
    expect(isOpenReviewThread(replied)).toBe(true);
    expect(feedbackOf([replied]).reason).toContain('I disagree');
  });

  /**
   * WP-178 criterion (13): **one** merge-request marker test, the domain's. The application's
   * `isPlatformNote` and the decision's `isPlatformWord` answer every body alike, so the window and
   * the handlers cannot disagree about whose note it is.
   */
  it('(13) answers every body through isPlatformNote exactly as the domain’s isPlatformWord does', () => {
    const marker = conflictWarningMarker('00000000-0000-4000-8000-0000000000b1' as never);
    const bodies = [
      `${marker}\nA platform note.`,
      `   \n\t${marker} after leading whitespace`,
      `A person's note, then ${marker} not at the start`,
      `> ${marker}\n> quoted`,
      'An unmarked note.',
      '<!-- agentic:Upper:case -->',
      '<!-- agentic:reply:t.r.1 -->',
    ];
    for (const body of bodies) {
      for (const form of ['mr_diff', 'mr_note'] as const) {
        const word: HumanWord = { form, text: body, at: AT };
        expect(isPlatformNote({ body }), body).toBe(isPlatformWord(word));
      }
    }
    // And the answers are the right ones, so the agreement is not two copies agreeing on a defect.
    expect(bodies.map((body) => isPlatformNote({ body }))).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      true,
    ]);
  });
});

/** WP-178: what the window reads off the merge request and the ticket. */
describe('the words the human-return window reads', () => {
  it('reads every note of an unresolved discussion, a general note (resolvable: false) included', () => {
    const words = mergeRequestWords([
      thread([note('rename this', { path: 'src/a.ts', line: 3 }), note('and this')]),
      thread([note('a general remark')], { resolvable: false }),
      thread([note('settled')], { resolved: true }),
    ]);
    expect(words.map((word) => [word.form, word.text, word.thread, word.reply])).toEqual([
      ['mr_diff', 'rename this', 1, false],
      ['mr_diff', 'and this', 1, true],
      ['mr_note', 'a general remark', 1, false],
    ]);
  });

  it('reads the ticket’s comments oldest first, with the provider’s marker', () => {
    const comment = (id: string, body: string, created_at: string, marker_id?: string) => ({
      id,
      author: note('x').author,
      body,
      created_at,
      ...(marker_id === undefined ? {} : { marker_id }),
    });
    const words = ticketCommentWords([
      comment('2', 'newer', '2026-06-01T10:00:00.000Z', 'agentic:task:t1'),
      comment('1', 'older', '2026-06-01T09:00:00.000Z'),
    ]);
    expect(words.map((word) => [word.text, word.thread, word.markerId])).toEqual([
      ['older', 1, null],
      ['newer', 2, 'agentic:task:t1'],
    ]);
  });
});

describe('the reason a human return carries (WP-178)', () => {
  it('opens with the stage and the forms, and gives each person’s word one tagged line', () => {
    const { reason, redactions } = humanReturnFeedback({
      stage: 'qa',
      forms: ['mr_diff', 'mr_note', 'ticket_comment'],
      status: null,
      words: [
        ...mergeRequestWords([
          thread([
            note('use cents', { path: 'src/a.ts', line: 3 }),
            note('bot noise', { system: true }),
            note('and\r\nround once please'),
          ]),
          thread([note('whole file', { path: 'src/b.ts' })]),
          thread([note('a general remark')], { resolvable: false }),
        ]),
        ...ticketCommentWords([
          { id: 'c1', author: note('x').author, body: 'still broken on mobile', created_at: AT },
        ]),
      ],
      horizon: null,
      redactor: none,
    });
    expect(reason.split('\n')).toEqual([
      'A person returned the task at qa: a note on a diff discussion, a general note on the merge request, a ticket comment.',
      '[mr thread 1] src/a.ts:3 — use cents',
      '[mr thread 1 reply] — and round once please',
      '[mr thread 2] src/b.ts — whole file',
      '[mr note 1] — a general remark',
      '[ticket comment 1] — still broken on mobile',
    ]);
    expect(redactions).toBe(0);
  });

  it('gives a status-only return platform text that points the agent to get_conversation', () => {
    const { reason } = humanReturnFeedback({
      stage: 'ready_for_merge',
      forms: ['status'],
      status: 'Sent\nback',
      words: [],
      horizon: null,
      redactor: none,
    });
    expect(reason.split('\n')).toEqual([
      'A person returned the task at ready_for_merge: the ticket’s status.',
      '[status] The ticket was moved to "Sent back", a status that sends it back to the agent. Nobody wrote why: read the merge request’s and the ticket’s conversation with get_conversation to find what to fix, and ask a question if you find nothing to fix.',
    ]);
  });

  it('quotes only the words newer than the horizon, and never the platform’s', () => {
    const { reason } = humanReturnFeedback({
      stage: 'ready_for_merge',
      forms: ['mr_note'],
      status: null,
      words: mergeRequestWords([
        thread([note('old word', { created_at: '2026-05-01T09:00:00.000Z' })], {
          resolvable: false,
        }),
        thread([note('<!-- agentic:reply:t.r.1 -->\nFixed.')], { resolvable: false }),
        thread([note('new word')], { resolvable: false }),
      ]),
      horizon: '2026-05-15T09:00:00.000Z',
      redactor: none,
    });
    expect(reason).toContain('new word');
    expect(reason).not.toContain('old word');
    expect(reason).not.toContain('Fixed.');
  });

  it('redacts before it cuts, and counts what it replaced', () => {
    const secret = 'glpat-notarealtokenatall';
    const { reason, redactions } = feedbackOf(
      [thread([note(`token ${secret}`, { path: `src/${secret}.ts` })])],
      exactSecretRedactor([{ name: 'fake_gitlab_token', value: secret }]),
    );
    expect(reason).not.toContain(secret);
    expect(redactions).toBe(2);
  });

  it('is cut past its bound with no notice in the body, and the bound is past the block’s', () => {
    // Strictly greater: a reason cut here is always cut again by the prompt block, whose marker
    // announces it. Equal caps would serve a cut reason with no announcement at all.
    expect(MAX_REVIEW_FEEDBACK_CHARS).toBeGreaterThan(MAX_FEEDBACK_CHARS);
    const { reason } = feedbackOf([thread([note('x'.repeat(MAX_REVIEW_FEEDBACK_CHARS * 2))])]);
    expect(reason).toHaveLength(MAX_REVIEW_FEEDBACK_CHARS);
    expect(reason.endsWith('x')).toBe(true);
  });
});
