/**
 * The counter vocabulary and the purity of the fold (WP-41).
 *
 * `projector.test.ts` asserts what each event counts; this file asserts the properties the
 * *backfill* rests on — that the fold is a function of the event alone, that it is total, and that
 * every value it can write is one of a fixed set of literals. A fold that failed any of the three
 * would produce rows a replay could not reproduce, which is criterion 5's equality.
 */

import type { DomainEvent } from '@platform/contracts';
import { DOMAIN_EVENT_TYPES, domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { countersFor, STATS_COUNTED_EVENT_TYPES, STATS_COUNTERS } from './metrics.js';

const rebaseChecked = (): DomainEvent =>
  domainEventSchemasByType['task.rebase.checked'].parse({
    id: '00000000-0000-4000-9000-000000000001',
    stream_type: 'task',
    stream_id: '00000000-0000-4000-8000-0000000000c1',
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'system', component: 'test' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'task.rebase.checked',
    payload: {
      project_id: '00000000-0000-4000-8000-0000000000b1',
      task_id: '00000000-0000-4000-8000-0000000000c1',
      mr: {
        provider: 'gitlab',
        project_path: 'acme/api',
        iid: 7,
        url: 'https://git.example.test/acme/api/-/merge_requests/7',
      },
      conflicts: false,
      attempt: 0,
      outcome: 'clean',
    },
  }) as DomainEvent;

describe('the counter vocabulary', () => {
  it('has a distinct key per counter', () => {
    const values = Object.values(STATS_COUNTERS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('writes only keys the migration’s comment describes: a family, a dot and a name', () => {
    // `stats_event_daily.metric` is `text` (TD-011: a new counter must not be an `alter type`), so
    // the shape is held here rather than by the column. Nothing untrusted reaches it — every value
    // is a literal in `metrics.ts` — and this case is what keeps that true of the *next* one.
    for (const value of Object.values(STATS_COUNTERS)) {
      expect(value, value).toMatch(/^[a-z][a-z_]*\.[a-z][a-z_]*$/);
    }
  });

  it('counts only the four types it declares, and is total over the catalogue', () => {
    // Standing rule 20: a type this fold does not know returns nothing rather than throwing — being
    // *told* something is not the moment to fail closed. Asserted over the whole catalogue rather
    // than over an example (rule 68), so a new event type cannot quietly acquire a counter.
    expect([...STATS_COUNTED_EVENT_TYPES].toSorted()).toEqual(
      [
        'task.conflict.warned',
        'task.lint.posted',
        'task.rebase.checked',
        'task.review.observed',
      ].toSorted(),
    );
    for (const type of DOMAIN_EVENT_TYPES) {
      if ((STATS_COUNTED_EVENT_TYPES as readonly string[]).includes(type)) {
        continue;
      }
      // A minimal stand-in: the fold switches on `type` and reads the payload only inside a branch
      // it does not take here, so an unparsed shape is enough to prove it never reaches one.
      expect(countersFor({ type } as unknown as DomainEvent), type).toEqual([]);
    }
  });

  it('is a function of the event alone: the same event folds the same way twice', () => {
    const event = rebaseChecked();
    expect(countersFor(event)).toEqual(countersFor(event));
  });

  it('writes whole numbers only, so nothing rounds into `numeric(18, 6)`', () => {
    for (const delta of countersFor(rebaseChecked())) {
      expect(Number.isInteger(delta.count)).toBe(true);
      expect(Number.isInteger(delta.total)).toBe(true);
    }
  });
});
