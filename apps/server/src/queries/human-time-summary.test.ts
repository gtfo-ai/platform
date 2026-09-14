/**
 * The fold behind `TaskDetailResponse.human_time` (WP-29).
 *
 * It is asserted here rather than only through the integration tier because it is a pure function:
 * the four buckets, the per-user rollup, the two identity shapes and the setting that decides
 * whether anybody is named are all decisions about *rows*, and a container adds nothing to them.
 * What the integration tier does add, and keeps, is that the SQL really returns these rows
 * (`test/integration/server/read-api.integration.test.ts`).
 */
import { humanTimeKindSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  type HumanTimeRow,
  perUserBreakdownEnabled,
  summariseHumanTime,
} from './human-time-summary.js';

const row = (over: Partial<HumanTimeRow> = {}): HumanTimeRow => ({
  kind: 'review',
  userId: null,
  userName: null,
  externalAuthor: 'gitlab:ada',
  minutes: '30.00',
  ...over,
});

describe('the human-time summary', () => {
  it('has a bucket for every kind of minute the platform can record', () => {
    // Derived from the enum rather than written out (standing rule 68): a fifth kind is a key here
    // on the commit that adds it, instead of a bucket whose absence somebody has to notice.
    const summary = summariseHumanTime([], { perUserBreakdown: false });
    expect(Object.keys(summary.by_kind).sort()).toEqual([...humanTimeKindSchema.options].sort());
    expect(summary).toEqual({
      total_minutes: 0,
      by_kind: { review: 0, question: 0, approval: 0, steer: 0 },
      by_user: null,
      entries: 0,
    });
  });

  it('sums per kind and in total, over rows the driver hands back as strings', () => {
    const summary = summariseHumanTime(
      [
        row({ minutes: '30.00' }),
        row({ kind: 'question', minutes: '12.50' }),
        row({ kind: 'approval', minutes: '10.00' }),
        row({ kind: 'steer', minutes: '5.00' }),
      ],
      { perUserBreakdown: false },
    );
    expect(summary.by_kind).toEqual({ review: 30, question: 12.5, approval: 10, steer: 5 });
    expect(summary.total_minutes).toBe(57.5);
    expect(summary.entries).toBe(4);
  });

  it('counts an open window as an entry worth nothing, not as a missing row', () => {
    // `minutes: null` is a window the projector has opened and not yet measured. It contributes no
    // minutes **and** is counted, because "0 minutes over 1 entry" and "no entries" are different
    // facts about a task (standing rule 16).
    const summary = summariseHumanTime([row({ minutes: null })], { perUserBreakdown: true });
    expect(summary.total_minutes).toBe(0);
    expect(summary.entries).toBe(1);
    expect(summary.by_user).toEqual([
      { user_id: null, user_name: null, external_author: 'gitlab:ada', minutes: 0 },
    ]);
  });

  it('rolls a person’s rows together and keeps two unmapped accounts apart', () => {
    const ada = '00000000-0000-4000-8000-0000000000a1';
    const summary = summariseHumanTime(
      [
        row({ userId: ada, userName: 'Ada Lovelace', externalAuthor: 'gitlab:ada', minutes: 60 }),
        row({
          userId: ada,
          userName: 'Ada Lovelace',
          externalAuthor: null,
          kind: 'approval',
          minutes: 10,
        }),
        row({ externalAuthor: 'gitlab:grace', minutes: 12.5 }),
        row({ externalAuthor: 'gitlab:hedy', minutes: '7.25' }),
      ],
      { perUserBreakdown: true },
    );

    expect(summary.by_user).toEqual([
      // One line per person, whatever kind the minutes came from — and the provider account is the
      // **first** one seen rather than the last, so an approval (which carries none) does not erase
      // where the review minutes came from.
      { user_id: ada, user_name: 'Ada Lovelace', external_author: 'gitlab:ada', minutes: 70 },
      // …and one per unmapped **account**, which is the whole reason the entries carry it: on an
      // instance where nobody has been mapped, every row's `user_id` is null and a fold keyed on it
      // alone would publish one number that is nobody's (BD-006, Q10).
      { user_id: null, user_name: null, external_author: 'gitlab:grace', minutes: 12.5 },
      { user_id: null, user_name: null, external_author: 'gitlab:hedy', minutes: 7.25 },
    ]);
    expect(summary.total_minutes).toBe(89.75);
  });

  it('publishes no names at all when the breakdown is off — which is not an empty list', () => {
    const rows = [row({ minutes: 30 })];
    expect(summariseHumanTime(rows, { perUserBreakdown: false }).by_user).toBeNull();
    // Both sides of the switch, from the same rows: `null` is "this project does not publish who"
    // and `[]` would be "it does, and nobody has spent a minute" (standing rule 42).
    expect(summariseHumanTime(rows, { perUserBreakdown: true })).toMatchObject({
      by_user: [expect.objectContaining({ external_author: 'gitlab:ada' })],
    });
    expect(summariseHumanTime([], { perUserBreakdown: true }).by_user).toEqual([]);
  });

  it('rounds to the two decimals the column holds, so the total and the buckets agree', () => {
    const summary = summariseHumanTime(
      [row({ minutes: '0.33' }), row({ minutes: '0.33' }), row({ minutes: '0.34' })],
      { perUserBreakdown: false },
    );
    expect(summary.total_minutes).toBe(1);
    expect(summary.by_kind.review).toBe(1);
  });
});

describe('product/18:32’s per-user-breakdown setting', () => {
  it('is off for a project that has never configured it', () => {
    expect(perUserBreakdownEnabled({ version: 1 })).toBe(false);
    expect(perUserBreakdownEnabled({ version: 1, features: {} })).toBe(false);
    expect(perUserBreakdownEnabled({ version: 1, features: { human_time: {} } })).toBe(false);
  });

  it('is on only for the literal `true`', () => {
    expect(
      perUserBreakdownEnabled({
        version: 1,
        features: { human_time: { per_user_breakdown: true } },
      }),
    ).toBe(true);
    expect(
      perUserBreakdownEnabled({
        version: 1,
        features: { human_time: { per_user_breakdown: false } },
      }),
    ).toBe(false);
  });

  it('is off for a document that does not parse, and for one that is not a document', () => {
    // Strict schemas refuse rather than drop, and on a **read** the conservative answer is the one
    // that publishes fewer names (standing rule 20 splits the two sides). A project that has never
    // been configured stores `{}`, which is also not a valid document.
    expect(
      perUserBreakdownEnabled({
        version: 1,
        features: { human_time: { per_user_breakdown: true } },
        unknown_key: 1,
      }),
    ).toBe(false);
    expect(perUserBreakdownEnabled({})).toBe(false);
    expect(perUserBreakdownEnabled(null)).toBe(false);
    expect(perUserBreakdownEnabled(undefined)).toBe(false);
  });
});
