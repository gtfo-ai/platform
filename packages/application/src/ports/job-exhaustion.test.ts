/**
 * The job census holds every registered queue (WP-108, PROGRESS backlog 325).
 *
 * The registered set is `JOB_QUEUE_DEFINITIONS` — the one table `migrate` declares and every worker
 * subscribes from (WP-86) — so the comparison is with it, in both directions, and never with a list
 * kept beside this file (standing rule 7). A queue added to the table without a row here fails by
 * name; a row left behind for a queue that was removed fails too.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  boundAndEscalateTargets,
  JOB_EXHAUSTION,
  jobExhaustionOf,
  OUTBOUND_DUTY_EXHAUSTION,
  outboundDutyExhaustionOf,
} from './job-exhaustion.js';
import {
  BOUND_AND_ESCALATE_EXPIRE_SECONDS,
  JOB_QUEUE_DEFINITIONS,
  jobQueueDefinition,
  PROVIDER_CALL_BOUND_SECONDS,
} from './job-queues.js';

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

  /**
   * TD-004's M7 amendment (WP-124, PROGRESS backlog 366): every registered queue declares one of
   * the three shapes, and `pipeline.outbound` — the one queue whose duties differ — declares each
   * duty instead. Iterated over the registered set, so a new queue is held to it the moment it is
   * declared.
   */
  it('gives every registered queue a declared shape, and pipeline.outbound one per duty', () => {
    const shapes = ['recovery_row', 'bound_and_escalate', 'notification_shaped'];
    for (const queue of registered()) {
      const row = jobExhaustionOf(queue);
      expect(row, queue).not.toBeNull();
      if (queue === 'pipeline.outbound') {
        expect(row?.shape, queue).toBe('per_duty');
        continue;
      }
      expect(shapes, `${queue}: shape`).toContain(row?.shape);
      if (row?.shape === 'recovery_row') {
        expect(
          row.recoveredBy?.length ?? 0,
          `${queue}: a recovery row names its site`,
        ).toBeGreaterThan(0);
        expect(row.recoveredBy, `${queue}: a recovery row is not "the next tick"`).not.toBe(
          'next_tick',
        );
      }
    }
    for (const [duty, row] of Object.entries(OUTBOUND_DUTY_EXHAUSTION)) {
      expect(shapes, `${duty}: shape`).toContain(row.shape);
      expect(row.why.length, `${duty}: why`).toBeGreaterThan(0);
      if (row.shape === 'recovery_row') {
        expect(row.recoveredBy?.length ?? 0, `${duty}: recoveredBy`).toBeGreaterThan(0);
      }
    }
    // The ruling's examples, declared as it said.
    expect(OUTBOUND_DUTY_EXHAUSTION.workpad.shape).toBe('notification_shaped');
    expect(OUTBOUND_DUTY_EXHAUSTION.status.shape).toBe('notification_shaped');
    expect(jobExhaustionOf('notify.digest')?.shape).toBe('notification_shaped');
    expect(jobExhaustionOf('knowledge.apply')?.shape).toBe('recovery_row');
    expect(jobExhaustionOf('onboarding.discovery')?.shape).toBe('recovery_row');
    expect(jobExhaustionOf('mr.comment.debounce')?.shape).toBe('bound_and_escalate');
    for (const duty of [
      'breakdown_create',
      'review_only_post',
      'ticket_lint_post',
      'spike_report',
    ]) {
      expect(outboundDutyExhaustionOf(duty)?.shape, duty).toBe('bound_and_escalate');
    }
    expect(outboundDutyExhaustionOf('constructor')).toBeNull();
  });

  /**
   * WP-156 (b), PROGRESS backlog 421: a bound-and-escalate queue's expiry is a number somebody
   * wrote down, never pg-boss's default inherited silently — because a last try that outlives it
   * is failed without the handler throwing, and then it is the `expired_job` recovery row, not the
   * wrapper, that escalates. Iterated over the targets the two tables declare, so a queue or duty
   * newly declared `bound_and_escalate` is held to it the moment it is.
   */
  it('holds every bound-and-escalate queue to a declared expireInSeconds (WP-156)', () => {
    const targets = boundAndEscalateTargets();
    expect(targets.map((target) => target.queue).sort()).toEqual([
      'mr.comment.debounce',
      'pipeline.outbound',
      'stage.execute',
    ]);
    for (const target of targets) {
      expect(
        jobQueueDefinition(target.queue).expireInSeconds,
        `${target.queue}: a bound-and-escalate queue declares its expiry`,
      ).toBeGreaterThan(0);
    }
    expect(targets.find((target) => target.queue === 'pipeline.outbound')?.duties).toEqual(
      Object.entries(OUTBOUND_DUTY_EXHAUSTION)
        .filter(([, row]) => row.shape === 'bound_and_escalate')
        .map(([duty]) => duty)
        .sort(),
    );
    expect(jobQueueDefinition('pipeline.outbound').expireInSeconds).toBe(
      BOUND_AND_ESCALATE_EXPIRE_SECONDS,
    );
    expect(jobQueueDefinition('mr.comment.debounce').expireInSeconds).toBe(
      BOUND_AND_ESCALATE_EXPIRE_SECONDS,
    );
    // The bound the expiry is stated against: one provider call, well under it.
    expect(PROVIDER_CALL_BOUND_SECONDS * 5).toBeLessThan(BOUND_AND_ESCALATE_EXPIRE_SECONDS);
  });

  it('names, for every recovery row, a site the recovery pass really reports', () => {
    const recovery = path.resolve(import.meta.dirname, '../recovery');
    const sources = [
      'stranded.ts',
      'deadline.ts',
      'stranded-stage.ts',
      'knowledge-apply.ts',
      'discovery-record.ts',
    ]
      .map((file) => readFileSync(path.join(recovery, file), 'utf8'))
      .join('\n');
    const sites = [
      ...Object.values(JOB_EXHAUSTION).flatMap((row) =>
        row.shape === 'recovery_row' ? (row.recoveredBy ?? '').split(', ') : [],
      ),
      ...Object.values(OUTBOUND_DUTY_EXHAUSTION).flatMap((row) =>
        row.shape === 'recovery_row' && row.recoveredBy !== 'intake reconcile'
          ? [row.recoveredBy ?? '']
          : [],
      ),
    ];
    for (const site of sites) {
      expect(sources, `a site named "${site}"`).toContain(`site: '${site}'`);
    }
  });
});
