/**
 * **WP-277 (TD-031 decision 13, TD-028's 2026-11-04 amendment)**: every process with a worker half
 * subscribes `stage.execute` and `task.ask`; what is composed *by configuration* is the **claimant**.
 *
 * ## What changed, and why the old lottery cannot come back
 *
 * Until WP-276 the run happened inside the `stage.execute` job, so TD-028 decision 5 kept the queue
 * off a process with no runner — pg-boss hands a job to **any** subscribed worker, and a runner-less
 * process that took one would fail its run. The price was that such a deployment left the platform
 * **gates** queued too (TD-028's WP-53 amendment). Since WP-276 a job plans, offers and evaluates
 * gates and needs no runner, so subscribing it everywhere is safe: an agent stage taken by a
 * runner-less process becomes an **offer** that waits for a claimant, never a failed run.
 *
 * ## Both directions, because "no worker" and "no jobs" look the same from outside
 *
 * A composition that subscribes nothing and one whose queue is empty are indistinguishable unless
 * the subscription itself is asserted (standing rule 42), so every case reads the same seams —
 * `RecordingJobs.handlers` (what `Jobs.work` writes to) and `PipelineRuntime.claimant`.
 */

import { describe, expect, it } from 'vitest';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { createPipelineHarness } from '../testing/pipeline-harness.js';

const recordingLogger = (): { readonly logger: Logger; readonly lines: string[] } => {
  const lines: string[] = [];
  const record = (_fields: unknown, message?: string) => {
    if (message !== undefined) lines.push(message);
  };
  const logger: Logger = {
    debug: record,
    info: record,
    warn: record,
    error: record,
    child: () => logger,
  } as unknown as Logger;
  return { logger, lines };
};

describe('WP-277 — who takes a `stage.execute` job, and who claims', () => {
  it('subscribes both run queues and composes the claimant when this process runs agents', async () => {
    const harness = createPipelineHarness({ runsAgents: true });
    await harness.drain();
    expect(harness.jobs.handlers.has(JOB_QUEUES.stageExecute)).toBe(true);
    expect(harness.jobs.handlers.has(JOB_QUEUES.taskAsk)).toBe(true);
    expect(harness.runtime.claimant).not.toBeNull();
  });

  it('subscribes both run queues on a process that runs none, and composes no claimant', async () => {
    const { logger, lines } = recordingLogger();
    const harness = createPipelineHarness({ runsAgents: false, logger });
    await harness.drain();
    expect(harness.jobs.handlers.has(JOB_QUEUES.stageExecute)).toBe(true);
    expect(harness.jobs.handlers.has(JOB_QUEUES.taskAsk)).toBe(true);
    expect(harness.runtime.claimant).toBeNull();
    // The start log names it, so an operator reading one process's log knows what it will not do.
    expect(lines.filter((line) => line.startsWith('this process is not a claimant'))).toHaveLength(
      1,
    );
  });

  it('keeps the queues that need no workspace subscribed either way', async () => {
    const harness = createPipelineHarness({ runsAgents: false });
    await harness.drain();
    expect(harness.jobs.handlers.has(JOB_QUEUES.pipelineOutbound)).toBe(true);
    expect(harness.jobs.handlers.has(JOB_QUEUES.mrCommentDebounce)).toBe(true);
  });

  it('composes the claimant by default, which is what every composition that predates the option does', async () => {
    const harness = createPipelineHarness();
    await harness.drain();
    expect(harness.jobs.handlers.has(JOB_QUEUES.stageExecute)).toBe(true);
    expect(harness.runtime.claimant).not.toBeNull();
  });
});
