/**
 * `review-threads.ts` on its own (WP-46): the predicate the panel and the return share, the one-line
 * rule, and the cap that is always announced by the prompt block rather than by a body line.
 * The channel end to end — the next run's `return_feedback` block — is `saga.test.ts`.
 */
import { MAX_FEEDBACK_CHARS } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { Discussion } from '../ports/integrations/git-provider.js';
import {
  isOpenReviewThread,
  MAX_REVIEW_FEEDBACK_CHARS,
  reviewThreadCounts,
  reviewThreadsReturnReason,
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

describe('the reason a human-comment return carries', () => {
  it('opens with the count and gives each human note one tagged line, system notes left out', () => {
    const { reason, redactions } = reviewThreadsReturnReason(
      [
        thread([
          note('use cents', { path: 'src/a.ts', line: 3 }),
          note('bot noise', { system: true }),
          note('and\r\nround once please'),
        ]),
        thread([note('whole file', { path: 'src/b.ts' })]),
      ],
      none,
    );
    expect(reason.split('\n')).toEqual([
      '2 unresolved review threads',
      '[thread 1] src/a.ts:3 — use cents',
      '[reply 1] — and round once please',
      '[thread 2] src/b.ts — whole file',
    ]);
    expect(redactions).toBe(0);
  });

  it('redacts before it cuts, and counts what it replaced', () => {
    const secret = 'glpat-notarealtokenatall';
    const { reason, redactions } = reviewThreadsReturnReason(
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
    const { reason } = reviewThreadsReturnReason(
      [thread([note('x'.repeat(MAX_REVIEW_FEEDBACK_CHARS * 2))])],
      none,
    );
    expect(reason).toHaveLength(MAX_REVIEW_FEEDBACK_CHARS);
    expect(reason.endsWith('x')).toBe(true);
  });
});
