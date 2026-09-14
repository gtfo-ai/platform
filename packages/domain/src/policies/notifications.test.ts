import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_URGENT_NOTIFICATION_CLASSES,
  inQuietWindow,
  isUrgentNotification,
  minutesOfTimeOfDay,
  type NotificationRoutingInput,
  notificationDelivery,
  urgentClassesOf,
} from './notifications.js';

const at = (hour: number, minute = 0): number => hour * 60 + minute;

describe('minutesOfTimeOfDay', () => {
  it('reads a 24-hour clock', () => {
    expect(minutesOfTimeOfDay('00:00')).toBe(0);
    expect(minutesOfTimeOfDay('09:30')).toBe(570);
    expect(minutesOfTimeOfDay('23:59')).toBe(1439);
  });

  it.each(['24:00', '9:30', '09:60', '', 'noon', '09:30:00'])('refuses %s', (value) => {
    expect(() => minutesOfTimeOfDay(value)).toThrow(/HH:MM/);
  });
});

describe('inQuietWindow', () => {
  const day = { from: '13:00', to: '14:00' };
  const night = { from: '22:00', to: '08:00' };

  it('is closed at the start and open at the end — both boundaries, and a minute either side', () => {
    expect(inQuietWindow(at(12, 59), day)).toBe(false);
    expect(inQuietWindow(at(13, 0), day)).toBe(true);
    expect(inQuietWindow(at(13, 1), day)).toBe(true);
    expect(inQuietWindow(at(13, 59), day)).toBe(true);
    expect(inQuietWindow(at(14, 0), day)).toBe(false);
    expect(inQuietWindow(at(14, 1), day)).toBe(false);
  });

  it('wraps midnight, which the obvious comparison would make never quiet at all', () => {
    expect(inQuietWindow(at(21, 59), night)).toBe(false);
    expect(inQuietWindow(at(22, 0), night)).toBe(true);
    expect(inQuietWindow(at(23, 59), night)).toBe(true);
    expect(inQuietWindow(at(0, 0), night)).toBe(true);
    expect(inQuietWindow(at(7, 59), night)).toBe(true);
    expect(inQuietWindow(at(8, 0), night)).toBe(false);
    expect(inQuietWindow(at(8, 1), night)).toBe(false);
  });

  it('treats a window whose ends meet as empty, not as a whole day', () => {
    for (const minutes of [0, at(6), at(12), at(23, 59)]) {
      expect(inQuietWindow(minutes, { from: '12:00', to: '12:00' })).toBe(false);
    }
  });

  it('covers every minute but one when the window is a whole day less a minute', () => {
    const almost = { from: '00:01', to: '00:00' };
    expect(inQuietWindow(0, almost)).toBe(false);
    expect(inQuietWindow(1, almost)).toBe(true);
    expect(inQuietWindow(1439, almost)).toBe(true);
  });

  it('property: a minute is in [from, to) or in [to, from), never in both and never in neither', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1439 }),
        fc.integer({ min: 0, max: 1439 }),
        fc.integer({ min: 0, max: 1439 }),
        (minutes, a, b) => {
          fc.pre(a !== b);
          const hhmm = (value: number): string =>
            `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
          const inside = inQuietWindow(minutes, { from: hhmm(a), to: hhmm(b) });
          const complement = inQuietWindow(minutes, { from: hhmm(b), to: hhmm(a) });
          expect(inside).not.toBe(complement);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('urgent classes', () => {
  it('defaults to product/18:33’s escalation and budget 100 %', () => {
    expect([...DEFAULT_URGENT_NOTIFICATION_CLASSES]).toEqual(['escalation', 'budget_exhausted']);
    expect(isUrgentNotification('escalation', undefined)).toBe(true);
    expect(isUrgentNotification('budget_exhausted', undefined)).toBe(true);
    expect(isUrgentNotification('question', undefined)).toBe(false);
  });

  it('is overridden by configuration, in both directions', () => {
    expect(isUrgentNotification('question', ['question'])).toBe(true);
    expect(isUrgentNotification('escalation', ['question'])).toBe(false);
  });

  it('distinguishes an absent list from an empty one', () => {
    expect([...urgentClassesOf(undefined)]).toEqual([...DEFAULT_URGENT_NOTIFICATION_CLASSES]);
    expect([...urgentClassesOf([])]).toEqual([]);
    expect(isUrgentNotification('escalation', [])).toBe(false);
  });
});

describe('notificationDelivery', () => {
  const base: NotificationRoutingInput = {
    notificationClass: 'question',
    digestEnabled: true,
    quietHours: { from: '22:00', to: '08:00' },
    urgentClasses: undefined,
    localMinutes: at(23),
  };

  it('defers a non-urgent notification raised inside the window', () => {
    expect(notificationDelivery(base)).toBe('digest');
    expect(notificationDelivery({ ...base, localMinutes: at(22, 0) })).toBe('digest');
    expect(notificationDelivery({ ...base, localMinutes: at(7, 59) })).toBe('digest');
  });

  it('delivers a non-urgent notification raised a minute outside the window', () => {
    expect(notificationDelivery({ ...base, localMinutes: at(21, 59) })).toBe('immediate');
    expect(notificationDelivery({ ...base, localMinutes: at(8, 0) })).toBe('immediate');
  });

  it('delivers an urgent class inside the window, by default and by configuration', () => {
    expect(notificationDelivery({ ...base, notificationClass: 'escalation' })).toBe('immediate');
    expect(notificationDelivery({ ...base, notificationClass: 'budget_exhausted' })).toBe(
      'immediate',
    );
    expect(notificationDelivery({ ...base, urgentClasses: ['question'] })).toBe('immediate');
  });

  it('defers an escalation when the project says escalations are not urgent', () => {
    expect(
      notificationDelivery({ ...base, notificationClass: 'escalation', urgentClasses: [] }),
    ).toBe('digest');
  });

  it('delivers everything when the digest is off, because there is nothing to defer into', () => {
    expect(notificationDelivery({ ...base, digestEnabled: false })).toBe('immediate');
  });

  it('delivers everything when quiet hours are off — the shipped default', () => {
    expect(notificationDelivery({ ...base, quietHours: null })).toBe('immediate');
  });

  it('never answers anything but the two deliveries: nothing is dropped', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'task_started',
          'question',
          'stage_returned',
          'escalation',
          'task_completed',
          'task_cancelled',
          'budget_threshold',
          'budget_exhausted',
        ),
        fc.boolean(),
        fc.integer({ min: 0, max: 1439 }),
        (notificationClass, digestEnabled, localMinutes) => {
          const delivery = notificationDelivery({
            ...base,
            notificationClass: notificationClass as NotificationRoutingInput['notificationClass'],
            digestEnabled,
            localMinutes,
          });
          expect(['immediate', 'digest']).toContain(delivery);
        },
      ),
      { numRuns: 300 },
    );
  });
});
