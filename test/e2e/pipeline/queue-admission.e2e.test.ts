/**
 * **A free place starts the next queued task, with no further event** (S-25.21, BACKLOG 1369 and
 * 1379), against whole instances.
 *
 * One running place (`pipeline.wip.max_parallel_tasks: 1`). ACME-1's first run is **held** by the
 * fake model (`beforeReport`) until ACME-2 has been matched and queued behind it, so the queue is
 * built while ACME-1 is certainly active — no race between the two intakes and the first run. Then
 * the run is released, and ACME-1 stops counting against the running limit one of three ways:
 *
 *  - it reaches **Ready for merge** (`task.stage.entered` at `ready_for_merge`), the commonest;
 *  - it asks a **blocking question** (`waiting_answers`);
 *  - its plan touches a risk class that needs **plan approval** (`waiting_approval`).
 *
 * Nothing else is published. ACME-2 reaching the same place proves the scheduler started it on
 * ACME-1's own transition; before S-25.21 it stayed `queued` in all three.
 */
import type { RunSpec } from '@platform/application';
import type { JsonObject } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inboundEvent,
  type PipelineE2E,
  type StartPipelineOptions,
  startPipeline,
} from '../support/pipeline.js';
import { askingScenarios, featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const ticketMatched = (pipeline: PipelineE2E, key: string) =>
  inboundEvent('ticket.matched', {
    project_id: pipeline.projectId,
    ticket: {
      provider: 'fake-task-management',
      key,
      url: `https://tickets.example.test/browse/${key}`,
    },
    rule: 'label:agentic',
    priority: 'High',
    issue_type: 'Story',
    epic: null,
    links: [],
  });

const stateOf = async (pipeline: PipelineE2E, key: string): Promise<string | null> => {
  const rows = await pipeline.query<{ state: string }>(
    'select state from tasks where ticket_key = $1',
    [key],
  );
  return rows[0]?.state ?? null;
};

const waitForState = async (pipeline: PipelineE2E, key: string, state: string) => {
  await pipeline.waitFor(`${key} to reach ${state}`, async () => {
    return (await stateOf(pipeline, key)) === state;
  });
};

const ONE_RUNNING = { pipeline: { wip: { max_parallel_tasks: 1 } } };

const admittedAfter = async (input: {
  readonly label: string;
  readonly scenarios: StartPipelineOptions['scenarios'];
  readonly config: JsonObject;
  /** Where ACME-1 stops counting as running — and where ACME-2, started then, stops too. */
  readonly stopsAt: string;
}) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runs: RunSpec[] = [];
  const pipeline = await startPipeline({
    scenarios: input.scenarios,
    label: input.label,
    tickets: TICKETS,
    config: input.config,
    // Only the very first run (ACME-1's first stage) waits for the case; every other reports.
    beforeReport: (spec) => {
      runs.push(spec);
      return runs.length === 1 ? held : undefined;
    },
  });
  harness = pipeline;

  await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
  await pipeline.waitFor('ACME-1’s first run to start', async () => runs.length === 1);
  expect(await stateOf(pipeline, 'ACME-1')).toBe('active');
  await pipeline.publish([ticketMatched(pipeline, 'ACME-2')]);
  await waitForState(pipeline, 'ACME-2', 'queued');

  // The only thing that happens next: ACME-1's run reports and the task moves on by itself.
  release();
  await waitForState(pipeline, 'ACME-1', input.stopsAt);
  await waitForState(pipeline, 'ACME-2', input.stopsAt);
  // ACME-2 was queued, and started by the scheduler rather than created running.
  const queued = await pipeline.query<{ type: string }>(
    `select e.type from events e join tasks t on t.id = e.stream_id
      where t.ticket_key = 'ACME-2' and e.type = 'task.queued'`,
  );
  expect(queued).toHaveLength(1);
};

describe('a queued task is admitted when the running one stops counting (S-25.21)', () => {
  it('starts when the running task reaches Ready for merge', async () => {
    await admittedAfter({
      label: 'queue-admission-ready',
      scenarios: featureScenarios,
      config: { version: 1, ...ONE_RUNNING },
      stopsAt: 'ready_for_merge',
    });
  }, 300_000);

  it('starts when the running task asks a blocking question', async () => {
    await admittedAfter({
      label: 'queue-admission-question',
      scenarios: askingScenarios(),
      config: { version: 1, ...ONE_RUNNING },
      stopsAt: 'waiting_answers',
    });
  }, 300_000);

  it('starts when the running task waits for a plan approval', async () => {
    await admittedAfter({
      label: 'queue-admission-approval',
      scenarios: featureScenarios,
      // The plan names `src/totals.ts` (`PLAN.files_to_change`): a class that requires approval.
      config: {
        version: 1,
        ...ONE_RUNNING,
        policies: {
          risk_classes: { totals: { paths: ['src/totals.ts'], require: ['plan_approval'] } },
        },
      },
      stopsAt: 'waiting_approval',
    });
  }, 300_000);
});
