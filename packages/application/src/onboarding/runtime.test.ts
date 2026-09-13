/**
 * `createOnboardingRuntime` — the wiring, asserted as wiring (WP-21).
 *
 * The thing worth a test here is the pairing: the handler that **enqueues** and the worker that
 * **runs** the queue it enqueues onto. A composition root that registered one and forgot the other
 * would enqueue jobs nothing runs — which is what one function exists to prevent — and no
 * behavioural test of `recordDiscoveryFindings` could see it, because that function is driven
 * directly.
 */
import { describe, expect, it } from 'vitest';
import type { Jobs, JobWorker } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { silentLogger } from '../ports/logger.js';
import { recordingJobs } from '../testing/pipeline-harness.js';
import { DISCOVERY_ARTIFACT_HANDLER, type DiscoveryRecordOptions } from './record.js';
import { createOnboardingRuntime } from './runtime.js';

/**
 * `recordingJobs` remembers what it was handed but not which queues were **declared** or whether a
 * worker was stopped, and those are the two facts this file is about — so it is wrapped rather than
 * replaced, which keeps the enqueue behaviour the rest of the tier relies on.
 */
const observedJobs = () => {
  const inner = recordingJobs();
  const defined: string[] = [];
  const workers: { queue: string; stopped: boolean }[] = [];
  const jobs: Jobs = {
    ...inner,
    defineQueue: async (definition) => {
      defined.push(definition.name);
      await inner.defineQueue(definition);
    },
    work: async (request) => {
      const entry = { queue: request.queue, stopped: false };
      workers.push(entry);
      const worker = await inner.work(request);
      return {
        ...worker,
        stop: async () => {
          entry.stopped = true;
          await worker.stop();
        },
      } satisfies JobWorker;
    },
  };
  return { jobs, defined, workers, inner };
};

const runtimeFor = (logger?: DiscoveryRecordOptions['logger']) => {
  const observed = observedJobs();
  const runtime = createOnboardingRuntime({
    jobs: observed.jobs,
    record: { logger } as never,
  });
  return { ...observed, runtime };
};

describe('createOnboardingRuntime', () => {
  it('registers the DiscoveryDraft handler, in TD-005’s core band', () => {
    const { runtime } = runtimeFor();
    expect(runtime.handlers.map((handler) => handler.name)).toEqual([DISCOVERY_ARTIFACT_HANDLER]);
    expect(runtime.handlers[0]?.eventTypes).toEqual(['artifact.created']);
    expect(runtime.handlers[0]?.priority).toBe(95);
  });

  it('declares the queue the handler enqueues onto, and works it', async () => {
    const { defined, workers, inner, runtime } = runtimeFor();
    await runtime.start();
    expect(defined).toEqual([JOB_QUEUES.discoveryRecord]);
    expect(workers.map((worker) => worker.queue)).toEqual([JOB_QUEUES.discoveryRecord]);
    // The pairing: the queue the worker serves is the queue the handler enqueues onto.
    expect([...inner.handlers.keys()]).toEqual([defined[0]]);
  });

  it('passes the composition root’s logger to the handler, and copes without one', () => {
    // Both branches of the optional spread (rule 10): a root that composed a logger gets it, and
    // one that did not still gets a handler rather than an exception at registration.
    expect(runtimeFor(silentLogger).runtime.handlers).toHaveLength(1);
    expect(runtimeFor(undefined).runtime.handlers).toHaveLength(1);
  });

  it('stops the worker it started, and stopping twice is not an error', async () => {
    const { workers, runtime } = runtimeFor();
    await runtime.start();
    await runtime.stop();
    expect(workers[0]?.stopped).toBe(true);
    await runtime.stop();
  });
});
