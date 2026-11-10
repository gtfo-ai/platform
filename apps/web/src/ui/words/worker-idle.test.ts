import { WORKER_IDLE_REASONS, type WorkerIdleReason } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { workerIdleWords } from './worker-idle.js';

const SELF = { self: true, ownerName: 'Jan' };
const OTHER = { self: false, ownerName: 'Jan' };
const ID = '00000000-0000-4000-8000-000000002861';

/** One reason of every kind — the test is parameterised over the vocabulary. */
const ONE_OF: Readonly<Record<WorkerIdleReason['kind'], WorkerIdleReason>> = {
  slots_busy: { kind: 'slots_busy', running: 1, concurrency: 1 },
  owner_limit: {
    kind: 'owner_limit',
    owner: { user_id: ID, name: 'Jan' },
    count: 3,
    limit: 3,
    queued: 2,
    holders: [{ task_id: ID, ticket_key: 'AUT-1' }],
  },
  project_limit: {
    kind: 'project_limit',
    project_id: ID,
    project_key: 'AUT',
    limit_kind: 'max_parallel_tasks',
    count: 2,
    limit: 2,
    queued: 1,
    organisation_bound: true,
  },
  policy_skips: { kind: 'policy_skips', skipped: 3, claim_policy: 'mine' },
  nothing_queued: { kind: 'nothing_queued' },
};

describe('why a ready machine runs nothing, in words (S-28.6)', () => {
  it.each(WORKER_IDLE_REASONS)('says %s in one plain sentence with no raw enum', (kind) => {
    const words = workerIdleWords(ONE_OF[kind], SELF);
    expect(words.text.length).toBeGreaterThan(20);
    expect(words.text).not.toMatch(/_/);
  });

  it('names the numbers and the rule', () => {
    expect(workerIdleWords(ONE_OF.slots_busy, SELF).text).toBe(
      'Its one place is busy: it takes the next run when this one ends.',
    );
    expect(workerIdleWords(ONE_OF.owner_limit, SELF).text).toBe(
      'You own 3 of 3 tasks in flight — your limit — and 2 more of your tasks are queued. A place frees when one of them finishes, is paused, or is handed to someone else.',
    );
    const project = workerIdleWords(ONE_OF.project_limit, SELF);
    expect(project.text).toContain('Project AUT already works on 2 of 2 tasks at once');
    expect(project.text).toContain('(the project’s limit, not a person’s)');
    expect(project.text).toContain('1 task it would take is queued');
    expect(project.text).toContain('The limit is the organisation’s maximum.');
    expect(project.next).toEqual({ kind: 'board', projectKey: 'AUT', label: 'Open the board' });
  });

  it('says it to the machine’s person as you, and to anybody else by name, with no control', () => {
    expect(workerIdleWords(ONE_OF.policy_skips, SELF)).toEqual({
      text: 'It takes only your tasks, and 3 waiting runs belong to others.',
      next: { kind: 'policy', label: 'Change what it takes' },
    });
    expect(workerIdleWords(ONE_OF.policy_skips, OTHER)).toEqual({
      text: 'It takes only Jan’s tasks, and 3 waiting runs belong to others. Only its owner can change what it takes.',
      next: null,
    });
    expect(workerIdleWords(ONE_OF.owner_limit, OTHER).text).toMatch(/^Jan owns 3 of 3 tasks/);
  });
});
