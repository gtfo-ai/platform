/**
 * The job census holds every registered queue (WP-108, PROGRESS backlog 325).
 *
 * The registered set is `JOB_QUEUE_DEFINITIONS` — the one table `migrate` declares and every worker
 * subscribes from (WP-86) — so the comparison is with it, in both directions, and never with a list
 * kept beside this file (standing rule 7). A queue added to the table without a row here fails by
 * name; a row left behind for a queue that was removed fails too.
 */
import { describe, expect, it } from 'vitest';
import { JOB_EXHAUSTION, jobExhaustionOf } from './job-exhaustion.js';
import { JOB_QUEUE_DEFINITIONS } from './job-queues.js';

const registered = (): readonly string[] => JOB_QUEUE_DEFINITIONS.map((row) => row.name).sort();

describe('the job exhaustion census (backlog 325)', () => {
  it('classifies every registered queue, and nothing else', () => {
    const classified = Object.keys(JOB_EXHAUSTION).sort();
    expect(
      registered().filter((queue) => !classified.includes(queue)),
      'a registered queue has no row in JOB_EXHAUSTION — say whether it bounds its own failures or relies on pg-boss retries, and what a failed job drops',
    ).toEqual([]);
    expect(
      classified.filter((queue) => !registered().includes(queue)),
      'JOB_EXHAUSTION classifies a queue JOB_QUEUE_DEFINITIONS does not declare',
    ).toEqual([]);
  });

  it('gives every row a loss, and every self-bounding row the residual a stray throw leaves', () => {
    for (const [queue, row] of Object.entries(JOB_EXHAUSTION)) {
      expect(row.loss.length, `${queue}: loss`).toBeGreaterThan(0);
      if (row.kind === 'bounds_itself') {
        expect(row.residual?.length ?? 0, `${queue}: residual`).toBeGreaterThan(0);
      }
    }
  });

  it('answers null for a queue this build does not declare, and never a prototype member', () => {
    expect(jobExhaustionOf('stage.execute')?.kind).toBe('bounds_itself');
    expect(jobExhaustionOf('pipeline.outbound')?.kind).toBe('relies_on_retries');
    expect(jobExhaustionOf('budget.window.reset')).toBeNull();
    expect(jobExhaustionOf('constructor')).toBeNull();
  });
});
