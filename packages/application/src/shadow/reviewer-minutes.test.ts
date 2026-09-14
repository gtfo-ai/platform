/**
 * product/19 §16's review arithmetic applied to somebody else's merge request (WP-34).
 *
 * The rules are WP-29's and are tested there; what this file holds is the **gathering**: which
 * notes count, what an absence means, and that the gap rule is actually applied rather than
 * assumed. Both directions on every one of them (standing rule 42).
 */
import { describe, expect, it } from 'vitest';
import type { Discussion } from '../ports/integrations/git-provider.js';
import { reviewerMinutesFromDiscussions } from './reviewer-minutes.js';

const note = (createdAt: string, system = false) => ({
  id: createdAt,
  author: { provider: 'fake-git', external_id: 'dana', email: null, verified: false },
  body: 'looks good',
  created_at: createdAt,
  path: null,
  line: null,
  system,
});

const thread = (...notes: readonly ReturnType<typeof note>[]): Discussion =>
  ({ id: 'd1', resolvable: true, resolved: false, notes }) as Discussion;

describe('reviewerMinutesFromDiscussions', () => {
  it('measures from the first human note to the last', () => {
    const minutes = reviewerMinutesFromDiscussions(
      [thread(note('2026-04-01T09:00:00.000Z'), note('2026-04-01T09:30:00.000Z'))],
      { until: null },
    );
    expect(minutes).toBe(30);
  });

  it('is null when there is no human note, and not zero', () => {
    // "nobody commented" and "somebody commented for no time" are different facts, and only one of
    // them is something this can establish (standing rule 16).
    expect(reviewerMinutesFromDiscussions([], { until: null })).toBeNull();
    expect(reviewerMinutesFromDiscussions([thread()], { until: null })).toBeNull();
    // A single note *is* evidence of review, and its window is zero minutes long — which is a
    // measurement rather than an absence, so it answers 0.
    expect(
      reviewerMinutesFromDiscussions([thread(note('2026-04-01T09:00:00.000Z'))], {
        until: null,
      }),
    ).toBe(0);
  });

  it('ignores the provider’s own system notes, both ways', () => {
    const systemOnly = reviewerMinutesFromDiscussions(
      [thread(note('2026-04-01T09:00:00.000Z', true), note('2026-04-01T10:00:00.000Z', true))],
      { until: null },
    );
    expect(systemOnly).toBeNull();
    const mixed = reviewerMinutesFromDiscussions(
      [
        thread(
          note('2026-04-01T09:00:00.000Z', true),
          note('2026-04-01T09:10:00.000Z'),
          note('2026-04-01T09:40:00.000Z'),
        ),
      ],
      { until: null },
    );
    // From the first **human** note, so 30 rather than 40.
    expect(mixed).toBe(30);
  });

  it('splits on a gap of more than two hours and keeps one on a gap of exactly two', () => {
    const split = reviewerMinutesFromDiscussions(
      [
        thread(
          note('2026-04-01T09:00:00.000Z'),
          note('2026-04-01T09:10:00.000Z'),
          // …four hours later, which is a new window rather than four hours of review.
          note('2026-04-01T13:10:00.000Z'),
          note('2026-04-01T13:20:00.000Z'),
        ),
      ],
      { until: null },
    );
    expect(split).toBe(20);
    const continued = reviewerMinutesFromDiscussions(
      [thread(note('2026-04-01T09:00:00.000Z'), note('2026-04-01T11:00:00.000Z'))],
      { until: null },
    );
    // Exactly two hours continues the window (product/19 §16: *"gaps > 2 h"*).
    expect(continued).toBe(120);
  });

  it('extends the last window to the merge only when the merge is inside the gap rule', () => {
    const near = reviewerMinutesFromDiscussions([thread(note('2026-04-01T09:00:00.000Z'))], {
      until: '2026-04-01T09:45:00.000Z',
    });
    expect(near).toBe(45);
    const far = reviewerMinutesFromDiscussions([thread(note('2026-04-01T09:00:00.000Z'))], {
      until: '2026-04-08T09:00:00.000Z',
    });
    // A merge request merged a week after its last comment is not a week of review.
    expect(far).toBe(0);
  });

  it('applies the daily cap to a window that really does span a day boundary', () => {
    // Notes every two hours, so the gap rule keeps one window open from 10:00 until 04:00 the next
    // day. Day 1's slice is 14 h and is **capped at 8 h**; day 2's is 4 h and is not. 720, not 1080.
    const every2h = Array.from({ length: 10 }, (_, index) =>
      note(new Date(Date.UTC(2026, 3, 1, 10 + index * 2)).toISOString()),
    );
    expect(reviewerMinutesFromDiscussions([thread(...every2h)], { until: null })).toBe(720);
  });

  it('lets the gap rule dominate the daily cap, which is why the cap rarely bites', () => {
    // The measurement behind `minutes.ts`'s own note that *"the gap rule is what keeps that bounded
    // in practice"*: two notes 23 h 30 m apart are **two** windows, not one capped day, so this is
    // 90 minutes rather than the 540 a reader assuming the cap would predict.
    const minutes = reviewerMinutesFromDiscussions(
      [
        thread(
          note('2026-04-01T00:00:00.000Z'),
          note('2026-04-01T23:30:00.000Z'),
          note('2026-04-02T01:00:00.000Z'),
        ),
      ],
      { until: null },
    );
    expect(minutes).toBe(90);
  });

  it('collects notes across threads and sorts them, so order of arrival does not decide', () => {
    const minutes = reviewerMinutesFromDiscussions(
      [thread(note('2026-04-01T09:40:00.000Z')), thread(note('2026-04-01T09:00:00.000Z'))],
      { until: null },
    );
    expect(minutes).toBe(40);
  });
});
