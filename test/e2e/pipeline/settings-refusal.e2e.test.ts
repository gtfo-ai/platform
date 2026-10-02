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
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
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

  /**
   * WP-125 review round 1 (PROGRESS backlog 356): the refusal `GET …/config` answers names how many
   * knowledge curations the refused document holds back — through the real route, so the count has
   * to reach the 409 from the composed query (the canary: drop `waitingCurations` at the route).
   */
  it('says in the config refusal how many knowledge curations wait on the document (WP-125)', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'settings-refusal-count',
      tickets: TICKETS,
      config: { version: 1, pipeline: { wip: { max_parallel_tasks: 500 } } },
    });
    harness = pipeline;
    const task = await pipeline.query<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode, state)
       values ($1, 'fake-task-management', 'ACME-99', 'https://tickets.example.test/browse/ACME-99',
               'feature', 'normal', 'done')
       returning id`,
      [pipeline.projectId],
    );
    const artifact = await pipeline.query<{ id: string }>(
      `insert into artifacts (task_id, type, data, schema_version, redaction_count)
       values ($1, 'LibrarianProposals', '{}'::jsonb, '1', 0) returning id`,
      [task[0]?.id],
    );
    await pipeline.query(
      'insert into knowledge_curations (artifact_id, settings_refused_at) values ($1, now())',
      [artifact[0]?.id],
    );

    const client = new Client(pipeline.instance.baseUrl);
    const signedIn = await client.post('/api/auth/sign-in/email', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD,
    });
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    const refused = await client.json<{ error: { code: string; message: string } }>(
      `/api/projects/${pipeline.projectId}/config`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('invalid_stored_config');
    expect(refused.body.error.message).toContain(
      '1 knowledge curation of finished tasks waits on this document',
    );
  });
});
