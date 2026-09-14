/**
 * Ask-the-task's composition for the API half (WP-31).
 *
 * One property, and it is the one a route cannot assert for itself: a process with **no queue**
 * composes no ask command. A recorded question with no wake-up is worse than a refusal — the thread
 * shows a `pending` row for ever and nobody is told this process cannot answer it — so the `null`
 * is the composition saying so, and `routes/asks.ts` turns it into a `503` that names the
 * deployment.
 *
 * The reads are composed either way, because a thread somebody asked for on a worker is readable
 * from an API-only replica.
 */
import type { Jobs } from '@platform/application';
import { silentLogger } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { composeAsks } from './asks.js';

const eventing = {
  unitOfWork: {
    transaction: async () => {
      throw new Error('a composition test must not open a transaction');
    },
  } as never,
  ids: { next: () => '00000000-0000-4000-8000-0000000000a1' as never },
  clock: { now: () => '2026-06-01T09:00:00.000Z' as never },
};

describe('composeAsks', () => {
  it('composes no ask command on a process with no queue', () => {
    const composed = composeAsks({ eventing, jobs: null, logger: silentLogger });
    expect(composed.commands).toBeNull();
    // …and the reads are still there, which is what makes the `null` above a statement about the
    // *write* rather than about the feature (standing rule 42).
    expect(typeof composed.queries.listAsks).toBe('function');
    expect(typeof composed.queries.taskAudit).toBe('function');
  });

  it('composes one on a process that has a queue', () => {
    const jobs = { enqueue: async () => ({ status: 'enqueued', jobId: 'j' }) } as unknown as Jobs;
    const composed = composeAsks({ eventing, jobs, logger: silentLogger });
    expect(composed.commands).not.toBeNull();
  });
});
