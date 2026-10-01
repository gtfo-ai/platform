/**
 * A stored project settings document this release refuses — WP-106, PROGRESS backlogs 311 and 354.
 *
 * Against a real `apps/server` instance and its production settings port, with `projects.config`
 * written by SQL the way a narrowing release or an operator's edit leaves it: a `pipeline.wip` above
 * the schema's maximum. Before backlog 354 was fixed, the port threw at every reader: the intake duty
 * failed, and the ticket never became a task. Now the port answers the refusal instead of throwing.
 * The ticket becomes a task, marked to re-take its frozen values (migration 0066), and the first step
 * that would decide its next transition (intake's own completion) parks it by **name**: the key, the
 * value and the `PUT` that fixes it. No run is created and nothing is dead-lettered on the way.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe('a stored settings document this release refuses', () => {
  it('still makes the ticket a task, and parks it at admission by name', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'settings-refusal',
      tickets: TICKETS,
      config: { version: 1, pipeline: { wip: { max_parallel_tasks: 500 } } },
    });
    harness = pipeline;

    await pipeline.publish([
      inboundEvent('ticket.matched', {
        project_id: pipeline.projectId,
        ticket: {
          provider: 'fake-task-management',
          key: 'ACME-1',
          url: 'https://tickets.example.test/browse/ACME-1',
        },
        rule: 'label:agentic',
        priority: 'High',
        issue_type: 'Story',
        epic: null,
        links: [],
      }),
    ]);

    const parked = await pipeline.settle(
      'the named refusal',
      (task) => task.state === 'needs_human',
    );
    // The first step that would decide this task's next transition is intake's own completion,
    // which parks it by name (WP-106 review round 1) — before any run.
    expect(parked.current_stage).toBe('intake');

    const events = await pipeline.events();
    const types = events.map((event) => event.type);
    expect(types).not.toContain('run.created');
    const escalated = events.find((event) => event.type === 'task.escalated');
    const payload = (escalated?.payload ?? {}) as { reason?: string; blocker_brief?: string };
    expect(payload.reason).toContain('pipeline.wip.max_parallel_tasks: 500');
    expect(payload.blocker_brief).toContain(`PUT /api/projects/${pipeline.projectId}/config`);

    // The task is marked to take its frozen limits and dial again before its first run (0066).
    const marked = await pipeline.query<{ settings_refreeze_pending: boolean }>(
      'select settings_refreeze_pending from tasks where id = $1',
      [parked.id],
    );
    expect(marked[0]?.settings_refreeze_pending).toBe(true);

    // No reader turned the parse failure into a retry loop: nothing was dead-lettered.
    const deadLettered = await pipeline.query<{ count: string }>(
      'select count(*)::text as count from event_dispatch where dead_lettered_at is not null',
    );
    expect(deadLettered[0]?.count).toBe('0');
  });
});
