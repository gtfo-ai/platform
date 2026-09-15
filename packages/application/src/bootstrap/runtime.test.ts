/**
 * The one queue, the one worker and the one handler (WP-35).
 *
 * What this file holds is the **wiring**, which nothing else in this ring can: that the trigger
 * fires on a `HistoryFindings` artifact and on nothing else, that both halves of the job ride one
 * queue and are discriminated on `kind`, and that a skip is logged rather than thrown — because a
 * throw would spend two pg-boss retries on a state the platform can legitimately be in.
 */
import { describe, expect, it, vi } from 'vitest';
import type { EventHandler } from '../events/handler.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { recordingJobs } from '../testing/pipeline-harness.js';
import {
  createHistoryBootstrapRuntime,
  type HistoryBootstrapRuntimeOptions,
  historyBootstrapJobHandler,
} from './runtime.js';

const PROJECT = '00000000-0000-4000-8000-0000000000f1';
const TASK = '00000000-0000-4000-8000-0000000000f2';
const ARTIFACT = '00000000-0000-4000-8000-0000000000f3';
const BATCH = '00000000-0000-4000-8000-0000000000f4';

const artifactEvent = (artifactType: string) =>
  ({
    event: {
      type: 'artifact.created',
      payload: {
        project_id: PROJECT,
        task_id: TASK,
        artifact: { id: ARTIFACT, artifact_type: artifactType },
      },
    },
  }) as never;

const fire = async (handler: EventHandler, artifactType: string) => {
  const after: (() => Promise<void>)[] = [];
  await handler.handle({
    event: artifactEvent(artifactType),
    afterCommit: (callback: () => Promise<void>) => {
      after.push(callback);
    },
  } as never);
  for (const callback of after) {
    await callback();
  }
};

describe('the history bootstrap runtime', () => {
  it('enqueues a record job for a HistoryFindings artifact and for nothing else', async () => {
    const jobs = recordingJobs();
    const runtime = createHistoryBootstrapRuntime({
      jobs,
      collect: {} as HistoryBootstrapRuntimeOptions['collect'],
      record: {} as HistoryBootstrapRuntimeOptions['record'],
    });
    const [handler] = runtime.handlers;
    expect(handler?.eventTypes).toEqual(['artifact.created']);

    await fire(handler as EventHandler, 'HistoryFindings');
    // Both directions (standing rule 42): the type this runtime owns, and one it does not.
    await fire(handler as EventHandler, 'DiscoveryDraft');

    const enqueued = jobs.enqueued.filter((job) => job.queue === JOB_QUEUES.historyBootstrap);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.data).toEqual({
      kind: 'record',
      project_id: PROJECT,
      task_id: TASK,
      artifact_id: ARTIFACT,
    });
  });

  it('starts one worker on one queue, for both halves of the job', async () => {
    const jobs = recordingJobs();
    const runtime = createHistoryBootstrapRuntime({
      jobs,
      collect: {} as HistoryBootstrapRuntimeOptions['collect'],
      record: {} as HistoryBootstrapRuntimeOptions['record'],
    });
    await runtime.start();
    expect([...jobs.handlers.keys()]).toEqual([JOB_QUEUES.historyBootstrap]);
    await runtime.stop();
  });

  it('routes each wake-up by its `kind`, so a third one would have to declare itself', async () => {
    const collected: unknown[] = [];
    const recorded: unknown[] = [];
    const handler = historyBootstrapJobHandler({
      jobs: recordingJobs(),
      collect: {
        // The handler calls `collectHistory(options.collect, …)`, so a store that records is enough
        // to see which branch ran without building the whole collection.
        unitOfWork: {
          transaction: async (work: (scope: unknown) => Promise<unknown>) => work({ tx: {} }),
        },
        bootstrap: {
          batch: async () => {
            collected.push('collect');
            return null;
          },
        },
      } as never,
      record: {
        unitOfWork: {
          transaction: async (work: (scope: unknown) => Promise<unknown>) => work({ tx: {} }),
        },
        bootstrap: {
          chunkOfTask: async () => {
            recorded.push('record');
            return null;
          },
        },
      } as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });

    await handler({ data: { kind: 'collect', batch_id: BATCH, project_id: PROJECT } } as never);
    expect(collected).toEqual(['collect']);
    expect(recorded).toEqual([]);

    await handler({
      data: { kind: 'record', project_id: PROJECT, task_id: TASK, artifact_id: ARTIFACT },
    } as never);
    expect(recorded).toEqual(['record']);
  });

  it('logs a skip rather than throwing, so a legitimate state costs no pg-boss retry', async () => {
    const warn = vi.fn();
    const handler = historyBootstrapJobHandler({
      jobs: recordingJobs(),
      collect: {
        unitOfWork: {
          transaction: async (work: (scope: unknown) => Promise<unknown>) => work({ tx: {} }),
        },
        bootstrap: { batch: async () => null },
      } as never,
      record: {} as never,
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
    });

    await expect(
      handler({ data: { kind: 'collect', batch_id: BATCH, project_id: PROJECT } } as never),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
