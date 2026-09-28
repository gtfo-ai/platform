import type { Jobs } from '@platform/application';
import { jobs as jobsAdapters } from '@platform/infrastructure';
import { describe, expect, it } from 'vitest';
import {
  EnqueueOnlyJobsError,
  enqueueOnlyJobs,
  QueueNotDeclaredError,
} from './enqueue-only-jobs.js';

describe('the enqueue-only job client of ROLE=api (WP-72)', () => {
  it('lets an enqueue through to the queue a worker declared', async () => {
    const runtime = jobsAdapters.createInMemoryJobs();
    await runtime.jobs.defineQueue({ name: 'knowledge.apply', policy: 'stately' });
    const sender = enqueueOnlyJobs(runtime.jobs, 'api');

    const result = await sender.enqueue({ queue: 'knowledge.apply', data: { project_id: 'p' } });

    expect(result.status).toBe('enqueued');
  });

  it('refuses, by name, every operation only a worker performs', async () => {
    const sender = enqueueOnlyJobs(jobsAdapters.createInMemoryJobs().jobs, 'api');
    const refusals: [string, () => Promise<unknown>][] = [
      ['subscribes a queue', () => sender.work({ queue: 'x.y', handler: async () => {} })],
      ['declares a queue', () => sender.defineQueue({ name: 'x.y' })],
      [
        'schedules a cron',
        () => sender.scheduleCron({ queue: 'x.y', cron: '0 3 * * *', timezone: 'UTC' }),
      ],
      ['removes a cron schedule', () => sender.unscheduleCron('x.y')],
      ['reads the cron schedules', () => sender.listCronSchedules()],
    ];
    for (const [operation, call] of refusals) {
      const error = await call().then(
        () => null,
        (thrown: unknown) => thrown,
      );
      expect(error, operation).toBeInstanceOf(EnqueueOnlyJobsError);
      expect((error as EnqueueOnlyJobsError).operation).toBe(operation);
      expect((error as Error).message).toContain('ROLE=api');
    }
  });

  it('names the undeclared queue, in pg-boss’s own spelling of it, and points at migrate (WP-86)', async () => {
    const pgBossLike: Jobs = {
      ...jobsAdapters.createInMemoryJobs().jobs,
      enqueue: async () => {
        throw new Error('Queue knowledge.apply does not exist');
      },
    };
    const error = await enqueueOnlyJobs(pgBossLike, 'api')
      .enqueue({ queue: 'knowledge.apply' })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(QueueNotDeclaredError);
    expect((error as QueueNotDeclaredError).queue).toBe('knowledge.apply');
    expect((error as Error).message).toContain('migrate declares every queue');
  });

  it('passes any other failure through unchanged', async () => {
    const failure = new Error('connection terminated');
    const failing: Jobs = {
      ...jobsAdapters.createInMemoryJobs().jobs,
      enqueue: async () => {
        throw failure;
      },
    };
    await expect(enqueueOnlyJobs(failing, 'api').enqueue({ queue: 'a.b' })).rejects.toBe(failure);
  });
});
