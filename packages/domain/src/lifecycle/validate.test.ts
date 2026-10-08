/**
 * The lifecycle validator — WP-174 criterion (4) (TD-029 decision 1). Status names are invented
 * fixture values; no real tracker's workflow is named.
 */
import { describe, expect, it } from 'vitest';
import { validateLifecycle } from './validate.js';

const LOADED = ['Backlog', 'Doing', 'Waiting for review', 'Testing', 'Sent back', 'Finished'];

describe('validateLifecycle (WP-174 criterion 4)', () => {
  it('accepts a block whose names are distinct and all loaded', () => {
    expect(
      validateLifecycle(
        {
          in_progress: 'Doing',
          in_review: 'Waiting for review',
          qa: 'Testing',
          returned: ['Sent back'],
          done: 'Finished',
        },
        'Backlog',
        LOADED,
      ),
    ).toEqual([]);
  });

  it('accepts a match that differs only in case — the tracker compares that way', () => {
    expect(validateLifecycle({ in_progress: 'doing', qa: ' TESTING ' }, 'backlog', LOADED)).toEqual(
      [],
    );
  });

  it('refuses a duplicate slot, including one that differs only in case and one equal to pick_up_from', () => {
    expect(validateLifecycle({ in_progress: 'Doing', in_review: 'doing' }, null, LOADED)).toEqual([
      { code: 'duplicate_slot', slot: 'in_review', other: 'in_progress', name: 'doing' },
    ]);
    expect(validateLifecycle({ in_progress: 'Backlog' }, 'Backlog', LOADED)).toEqual([
      { code: 'duplicate_slot', slot: 'in_progress', other: 'pick_up_from', name: 'Backlog' },
    ]);
  });

  it('refuses an overlap with returned, and a returned name listed twice', () => {
    expect(
      validateLifecycle(
        { qa: 'Testing', returned: ['Sent back', 'testing', 'SENT BACK', 'Backlog'] },
        'Backlog',
        LOADED,
      ),
    ).toEqual([
      { code: 'returned_overlap', index: 1, other: 'qa', name: 'testing' },
      { code: 'returned_duplicate', index: 2, name: 'SENT BACK' },
      { code: 'returned_overlap', index: 3, other: 'pick_up_from', name: 'Backlog' },
    ]);
  });

  it('refuses an unknown name, naming the slot and the name, in every slot', () => {
    expect(
      validateLifecycle(
        { in_review: 'Reviewing', returned: ['Sent back', 'Bounced'] },
        'Inbox',
        LOADED,
      ),
    ).toEqual([
      { code: 'unknown_status', slot: 'pick_up_from', index: null, name: 'Inbox' },
      { code: 'unknown_status', slot: 'in_review', index: null, name: 'Reviewing' },
      { code: 'unknown_status', slot: 'returned', index: 1, name: 'Bounced' },
    ]);
  });

  it('treats an empty loaded set as knowing no status, and never throws', () => {
    expect(validateLifecycle({ done: 'Finished' }, null, [])).toEqual([
      { code: 'unknown_status', slot: 'done', index: null, name: 'Finished' },
    ]);
    expect(validateLifecycle({}, null, [])).toEqual([]);
  });
});
