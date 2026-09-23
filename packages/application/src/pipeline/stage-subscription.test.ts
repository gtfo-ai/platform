/**
 * **TD-028 decision 5**: `stage.execute` is subscribed by *configuration*, never by role.
 *
 * ## The lottery this closes
 *
 * `apps/server/src/role.ts` has measured the alternative since WP-15g: *"pg-boss hands a
 * `stage.execute` job to **any** subscribed worker, so a deployment with `ROLE=worker` beside
 * `ROLE=runner` would give half its agent stages to the process that composes no runner, and each
 * of those would fail its run and escalate its task."* The file also records that per-queue
 * subscription is *"still missing"* and owned by nobody. This is it.
 *
 * ## Both directions, because "no worker" and "no jobs" look the same from outside
 *
 * A composition that subscribes nothing and a composition whose queue is empty are indistinguishable
 * unless the subscription itself is asserted (standing rule 42), so both cases read the same seam —
 * `RecordingJobs.handlers`, which is what `Jobs.work` writes to.
 *
 * ## The consequence this tier makes visible, and it is wider than "agent stages"
 *
 * `stage.execute` also evaluates the **platform gates** (`jobs.ts`: *"an agent stage runs, a
 * platform gate is evaluated, anything else is skipped"*), so a deployment with no configured runner
 * leaves those queued too. TD-028's **WP-53 amendment** is where that trade is written down, and it
 * refuses to split the queue for a named reason: `stage.execute` is `stately` with
 * `singletonKey: task:<id>`, which is what enforces *a task never runs two stages at once*, and a
 * second queue would let a gate and a stage for one task run concurrently. The queue is still
 * **declared** either way, so its depth is a metric rather than an error.
 */

import { describe, expect, it } from 'vitest';
import { JOB_QUEUES } from '../ports/jobs.js';
import { createPipelineHarness } from '../testing/pipeline-harness.js';

describe('TD-028 decision 5 — who takes a `stage.execute` job', () => {
  it('subscribes the queue when this process runs agents', async () => {
    const harness = createPipelineHarness({ runsAgents: true });
    await harness.drain();
    expect(harness.jobs.handlers.has(JOB_QUEUES.stageExecute)).toBe(true);
  });

  it('does not subscribe it when this process runs none, so no run fails for being in the wrong container', async () => {
    const harness = createPipelineHarness({ runsAgents: false });
    await harness.drain();
    expect(harness.jobs.handlers.has(JOB_QUEUES.stageExecute)).toBe(false);
  });

  it('leaves the ask queue unsubscribed too, because an ask is a run', async () => {
    // TD-028's wording says "the agent-run queue"; this build has **two**. An ask goes through the
    // same `ClaudeRunner`, so a worker with no provisioner that took one would fail it exactly as
    // it would fail a stage — which is the lottery the decision exists to close.
    const harness = createPipelineHarness({ runsAgents: false });
    await harness.drain();
    expect(harness.jobs.handlers.has(JOB_QUEUES.taskAsk)).toBe(false);
  });

  it('keeps the queues that need no workspace subscribed either way', async () => {
    // The narrow claim: this is per-queue subscription, not "the worker half is off". A process
    // with no launcher still debounces merge-request comments and still makes every outbound
    // provider call.
    const harness = createPipelineHarness({ runsAgents: false });
    await harness.drain();
    expect(harness.jobs.handlers.has(JOB_QUEUES.pipelineOutbound)).toBe(true);
    expect(harness.jobs.handlers.has(JOB_QUEUES.mrCommentDebounce)).toBe(true);
  });

  it('subscribes by default, which is what every composition that predates the option does', async () => {
    const harness = createPipelineHarness();
    await harness.drain();
    expect(harness.jobs.handlers.has(JOB_QUEUES.stageExecute)).toBe(true);
  });
});
