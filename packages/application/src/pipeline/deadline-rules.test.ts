/**
 * The question timeout reads the dial where the document is silent — WP-62, PROGRESS backlog 72 (a).
 *
 * Every shipped preset carries the same `1 working day`, so the only way to see the dial being read
 * is a project whose **materialised** copy says something else — which is exactly BD-027:14's case:
 * a preset stored by an earlier release is what the project was given, and the current table must
 * not replace it at read time. Asserted as the deadline the rule produces (the countable effect), and
 * from all three sides: dial only, document over dial, and no dial at all.
 */
import type { IsoDateTime } from '@platform/contracts';
import { materialiseAutonomy } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { createWorkingCalendar, questionTimeoutAt } from '../scheduling/working-calendar.js';
import { questionDeadlineRule, questionTimeoutOf } from './deadline-rules.js';
import { defaultProjectSettings } from './settings.js';

const PROJECT = '00000000-0000-4000-8000-0000000000d1';
/** A Monday morning, inside the default working window. */
const ASKED_AT = '2026-06-01T09:00:00.000Z' as IsoDateTime;

const stored = materialiseAutonomy({ level: 'supervised', at: ASKED_AT, appliedBy: null });
/** The copy an earlier release stored — what BD-027:14 says the project keeps. */
const fromAnEarlierRelease = {
  ...stored,
  policies: { ...stored.policies, question_timeout: '3 working days' },
};

describe('questionTimeoutOf (backlog 72 (a))', () => {
  const calendar = createWorkingCalendar();
  const deadline = (duration: string): string =>
    questionTimeoutAt(calendar, new Date(ASKED_AT), duration).toISOString();

  it('reads the materialised dial where the document is silent', () => {
    const settings = defaultProjectSettings(PROJECT, { autonomy: fromAnEarlierRelease });
    expect(questionTimeoutOf(settings)).toBe('3 working days');
    expect(questionDeadlineRule(calendar, settings)(ASKED_AT)).toBe(deadline('3 working days'));
  });

  it('lets the document override the dial (Q78)', () => {
    const settings = defaultProjectSettings(PROJECT, {
      autonomy: fromAnEarlierRelease,
      config: { pipeline: { limits: { question_timeout: '2 working days' } } },
    });
    expect(questionTimeoutOf(settings)).toBe('2 working days');
    expect(questionDeadlineRule(calendar, settings)(ASKED_AT)).toBe(deadline('2 working days'));
  });

  it('keeps BD-006’s default for a project whose dial was never materialised', () => {
    const settings = defaultProjectSettings(PROJECT);
    expect(questionTimeoutOf(settings)).toBe('1 working day');
    expect(questionDeadlineRule(calendar, settings)(ASKED_AT)).toBe(deadline('1 working day'));
    // …and the three deadlines really are three different instants, so the cases above are not
    // passing by agreeing with each other.
    expect(
      new Set([deadline('1 working day'), deadline('2 working days'), deadline('3 working days')])
        .size,
    ).toBe(3);
  });
});
