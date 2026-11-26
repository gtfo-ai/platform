/**
 * BD-035's rule as a table (S-30.1 acceptance 1). Each row is one person's sources and what they
 * see; `test/integration/server/project-visibility-queries.integration.test.ts` holds the real
 * statement to the same table.
 */
import type { UserRole } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { Actor } from './rbac.js';
import {
  createVisibleProjects,
  isProjectVisible,
  type VisibilitySources,
  visibleIdsOf,
  visibleProjectsOf,
} from './visibility.js';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

const NONE: VisibilitySources = { workerScopes: [], memberships: [], ownedTaskProjects: [] };

/** `'all'`, or the ids sorted. */
type Expected = 'all' | readonly string[];

interface VisibilityCase {
  readonly name: string;
  readonly role: UserRole;
  readonly sources: VisibilitySources;
  readonly expected: Expected;
}

/** The integration test builds the same rows in PostgreSQL. */
const VISIBILITY_CASES: readonly VisibilityCase[] = [
  {
    name: 'an admin sees every project, whatever their worker takes',
    role: 'admin',
    sources: { ...NONE, workerScopes: [[A]] },
    expected: 'all',
  },
  {
    name: 'no worker and no membership: every project',
    role: 'member',
    sources: NONE,
    expected: 'all',
  },
  {
    name: 'a worker scoped to [A]: A only',
    role: 'member',
    sources: { ...NONE, workerScopes: [[A]] },
    expected: [A],
  },
  {
    name: 'a worker scoped to [A] beside a worker of every project: every project',
    role: 'member',
    sources: { ...NONE, workerScopes: [[A], null] },
    expected: 'all',
  },
  {
    name: "a legacy '{}' worker reads as every project",
    role: 'member',
    sources: { ...NONE, workerScopes: [[A], []] },
    expected: 'all',
  },
  {
    name: 'a membership adds to a narrowed worker',
    role: 'member',
    sources: { ...NONE, workerScopes: [[A]], memberships: [B] },
    expected: [A, B],
  },
  {
    name: 'a membership alone narrows',
    role: 'viewer',
    sources: { ...NONE, memberships: [B] },
    expected: [B],
  },
  {
    name: 'an unfinished owned task adds to a narrowed set',
    role: 'member',
    sources: { workerScopes: [[A]], memberships: [], ownedTaskProjects: [C] },
    expected: [A, C],
  },
  {
    name: 'an owned task alone narrows nothing: every project',
    role: 'member',
    sources: { ...NONE, ownedTaskProjects: [C] },
    expected: 'all',
  },
  {
    name: 'a maintainer is narrowed like a member (Q136)',
    role: 'maintainer',
    sources: { ...NONE, workerScopes: [[B, A]] },
    expected: [A, B],
  },
];

const asExpected = (visible: ReturnType<typeof visibleProjectsOf>): Expected =>
  visibleIdsOf(visible) ?? 'all';

describe('visibleProjectsOf (BD-035)', () => {
  it.each(VISIBILITY_CASES)('$name', ({ role, sources, expected }) => {
    expect(asExpected(visibleProjectsOf(role, sources))).toEqual(expected);
  });

  it('answers through the reader, and never reads for an admin', async () => {
    const reads: string[] = [];
    const byUser: Record<string, VisibilitySources> = {
      narrowed: { ...NONE, workerScopes: [[A]] },
      admin: { ...NONE, workerScopes: [[A]] },
    };
    const visible = createVisibleProjects(async (userId) => {
      reads.push(userId);
      return byUser[userId] ?? NONE;
    });
    const actor = (userId: string, role: UserRole): Actor => ({
      userId,
      role,
      email: `${userId}@example.test`,
      name: userId,
      sessionId: `s-${userId}`,
    });
    const narrowed = await visible(actor('narrowed', 'member'));
    expect(isProjectVisible(narrowed, A)).toBe(true);
    expect(isProjectVisible(narrowed, B)).toBe(false);
    expect(asExpected(await visible(actor('admin', 'admin')))).toBe('all');
    expect(reads).toEqual(['narrowed']);
  });

  it('a revoked worker contributes nothing: the statement leaves it out, so the rule never sees it', () => {
    // The statement's `revoked_at is null` is held by the integration table; here the consequence:
    // a person whose only narrowed worker was revoked has no worker left, and sees everything.
    expect(asExpected(visibleProjectsOf('member', NONE))).toBe('all');
  });

  it('an empty narrowed set filters to nothing, never to everything', () => {
    expect(visibleIdsOf({ all: false, ids: new Set() })).toEqual([]);
  });
});
