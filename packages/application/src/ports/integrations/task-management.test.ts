/**
 * The task-management port's pure parts (WP-171): the status-category normalisation of ruling (b)
 * and the member → capability table the shared contract suite runs its branches from.
 */
import { describe, expect, it } from 'vitest';
import {
  commentPageSchema,
  LIFECYCLE_MEMBER_CAPABILITY,
  listCommentsOptionsSchema,
  normaliseStatusCategory,
} from './task-management.js';

describe('normaliseStatusCategory (WP-171 ruling (b), research/15 J1a, J3)', () => {
  it.each([
    ['new', 'todo'],
    ['indeterminate', 'in_progress'],
    ['in-flight', 'in_progress'],
    ['done', 'done'],
    // Anything the table does not hold is unknown — never a guess, and the raw key survives.
    ['undefined', 'unknown'],
    ['some-fourth-key', 'unknown'],
    ['DONE', 'unknown'],
    ['New', 'unknown'],
    [' done', 'unknown'],
    ['todo', 'unknown'],
    ['in_progress', 'unknown'],
  ] as const)('maps the key %j to %j and keeps it', (raw, category) => {
    expect(normaliseStatusCategory(raw)).toEqual({ category, raw_category: raw });
  });

  it.each([null, undefined, ''])('answers unknown with no raw key for %j', (raw) => {
    expect(normaliseStatusCategory(raw)).toEqual({ category: 'unknown', raw_category: null });
  });
});

describe('the lifecycle members', () => {
  it('declares each of the six members by one of the four flags, and every flag is used', () => {
    expect(Object.keys(LIFECYCLE_MEMBER_CAPABILITY).toSorted()).toEqual(
      [
        'assignToSelf',
        'listComments',
        'listStatuses',
        'listTransitions',
        'selfIdentity',
        'unassign',
      ].toSorted(),
    );
    expect([...new Set(Object.values(LIFECYCLE_MEMBER_CAPABILITY))].toSorted()).toEqual(
      ['assign', 'commentsRead', 'lifecycleStatuses', 'transitionsRead'].toSorted(),
    );
  });

  it('bounds a comment page request at one provider page', () => {
    expect(listCommentsOptionsSchema.safeParse({ limit: 100 }).success).toBe(true);
    expect(listCommentsOptionsSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(listCommentsOptionsSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(listCommentsOptionsSchema.safeParse({ limit: 5, since: 'yesterday' }).success).toBe(
      false,
    );
  });

  it('carries an unknown total as null, never as a number it invented', () => {
    expect(commentPageSchema.safeParse({ comments: [], total: null }).success).toBe(true);
    expect(commentPageSchema.safeParse({ comments: [] }).success).toBe(false);
  });
});
