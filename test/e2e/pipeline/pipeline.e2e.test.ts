/**
 * WP-15a's acceptance criterion: **a ticket reaches `task.completed` through an `apps/server`
 * instance**, with its integration bindings read from the database.
 *
 * WP-15 proved the loop against a runtime this file composed itself. That left the product's own
 * composition root untested and `PipelineIntegrations` with no production constructor, so the thing
 * being demonstrated was the pipeline package rather than the platform. `startPipeline` now starts
 * a real instance and seeds `integrations`, `secrets` and `bindings` **rows**; the adapters the
 * stages call are built by the production loader from those rows, with the credential decrypted
 * under the instance's own `APP_SECRET_KEY`.
 *
 * What that adds to WP-15's list: the outbox worker runs on its own timer and pg-boss runs the
 * stage jobs, so nothing here drives a drain — a transition that only happened because a harness
 * called a handler by hand would not happen at all. What it costs is determinism about *when*;
 * `settle` waits for a state and never asserts a duration (standing rule 2).
 *
 * Every stage of the templates is scripted, so what is exercised is the interpreter's transitions
 * and the saga's handlers, not the model.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { GIT_PROJECT, inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { bugScenarios, featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const ticketMatched = (pipeline: PipelineE2E, key: string, issueType: string) =>
  inboundEvent('ticket.matched', {
    project_id: pipeline.projectId,
    ticket: {
      provider: 'fake-task-management',
      key,
      url: `https://tickets.example.test/browse/${key}`,
    },
    rule: 'label:agentic',
    priority: 'High',
    issue_type: issueType,
    epic: null,
    links: [],
  });

const merged = (pipeline: PipelineE2E) =>
  inboundEvent('mr.merged', {
    project_id: pipeline.projectId,
    task_id: null,
    mr: {
      provider: 'fake-git',
      project_path: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      url: pipeline.world.mr.url,
      branch: pipeline.world.branch,
      head_sha: pipeline.world.mr.headSha,
    },
    draft: false,
    head_sha: pipeline.world.mr.headSha,
    diff_stats: null,
    merge_commit_sha: 'c'.repeat(40),
  });

describe('a feature ticket, end to end', () => {
  it('runs every stage, waits for the human merge, and finishes done', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'feature',
      tickets: TICKETS,
      // technical/12's `status_mapping`, so the ticket's own status moves with the task.
      config: { status_mapping: { refinement: 'In Progress', ready_for_merge: 'In Review' } },
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1', 'Story')]);

    // BD-007: the platform never merges. It stops here until a human does.
    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );
    expect(waiting.current_stage).toBe('ready_for_merge');

    await pipeline.publish([merged(pipeline)]);

    const finished = await pipeline.settle('done', (task) => task.state === 'done');
    expect(finished.template).toBe('feature');
    // Five agent stages at 0.40 USD each, on the row a human would read.
    expect(Number(finished.cost_actual)).toBeCloseTo(2.4, 6);

    const types = (await pipeline.events()).map((event) => event.type);
    expect(types.filter((type) => type === 'task.created')).toHaveLength(1);
    expect(types.filter((type) => type === 'run.created')).toHaveLength(6);
    expect(types.filter((type) => type === 'artifact.created')).toHaveLength(6);
    expect(types).toContain('task.completed');
    expect(types).not.toContain('task.escalated');

    expect(pipeline.specs.map((spec) => spec.stage)).toEqual([
      'refinement',
      'architecture',
      'implementation',
      'code_review',
      'business_review',
      'retrospective',
    ]);
  });

  it('keeps one workpad comment on the ticket and moves the ticket status', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'feature-workpad',
      tickets: TICKETS,
      config: { status_mapping: { refinement: 'In Progress', ready_for_merge: 'In Review' } },
      // The interleaving this test used to fail on about one run in five, forced. Since WP-15d the
      // delay lands on the render's `pipeline.outbound` job rather than inside the dispatch — the
      // status job was enqueued first and runs first on the same single worker, so the render is
      // still the later of the two and a wait that stops at the status still fails every time
      // rather than rarely. The harness's `workpadDelayMs` has the full reasoning.
      workpadDelayMs: 250,
    });
    harness = pipeline;
    await pipeline.publish([ticketMatched(pipeline, 'ACME-1', 'Story')]);

    // Wait for **every line this test asserts**, and for nothing that merely precedes them.
    //
    // The original wait was on the ticket *status* while the assertions read the workpad *body*:
    // priority order (110 before 120) guaranteed the status committed first, so the wait was
    // structurally incapable of covering them and passed only because both handlers finished
    // inside one 50 ms poll. WP-15d changes what the ordering rests on and therefore what this
    // wait may assume. Neither handler calls the provider now: each enqueues a `pipeline.outbound`
    // job after its commit, and one worker runs that queue, so the status still normally reaches
    // the ticket before the render — but that is a property of the queue, not a guarantee of the
    // pipeline, and two jobs enqueued microseconds apart are ordered by pg-boss and not by TD-005.
    // So the wait covers **both** consequences and the assertions read them afterwards. There is
    // nothing to wait for beyond them: `ready_for_merge` is the last stage the task enters before
    // the human merge, and the workpad render is the last outbound job that dispatch enqueues.
    const WORKPAD_HEADER = '**ACME-1** — ready_for_merge (ready_for_merge)';
    await pipeline.waitFor(
      'the workpad rendered for ready_for_merge and the ticket status moved with it',
      async () => {
        const seen = pipeline.tickets.peek('ACME-1');
        return (
          seen?.comments[0]?.body.startsWith(WORKPAD_HEADER) === true &&
          seen?.status === 'In Review'
        );
      },
    );

    const ticket = pipeline.tickets.peek('ACME-1');
    // BD-023: one sticky comment, however many times the task moved.
    expect(ticket?.comments).toHaveLength(1);
    // The **first line**, not `toContain`. The render's checklist names every stage of the template
    // from the first pass, so `toContain('ready_for_merge')` was satisfied by the checklist and
    // would have passed on a task that never reached the state (standing rule 10). The header is
    // the only part of the body that reports where the task actually is.
    expect(ticket?.comments[0]?.body.split('\n')[0]).toBe(WORKPAD_HEADER);
    // The last mapped state the task passed through.
    expect(ticket?.status).toBe('In Review');
  });

  it('leaves a readable trail: a stage row per attempt and an artifact per stage', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'feature-trail',
      tickets: TICKETS,
    });
    harness = pipeline;
    await pipeline.publish([ticketMatched(pipeline, 'ACME-2', 'Story')]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');
    await pipeline.publish([merged(pipeline)]);
    await pipeline.settle('done', (task) => task.state === 'done');

    const stages = (await pipeline.events())
      .filter((event) => event.type === 'task.stage.entered')
      .map((event) => (event.payload as { stage: string }).stage);
    expect(stages).toEqual([
      'intake',
      'refinement',
      'architecture',
      'implementation',
      'ci_gate',
      'code_review',
      'business_review',
      'rebase_gate',
      'ready_for_merge',
      'merged_gate',
      'retrospective',
    ]);
  });
});

describe('BD-003: the instance audits its own outbound calls (WP-15b)', () => {
  it('writes an integration_actions row per provider call, with no audit log supplied', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'feature-audit',
      tickets: TICKETS,
      config: { status_mapping: { refinement: 'In Progress', ready_for_merge: 'In Review' } },
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1', 'Story')]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

    // `startPipeline` passes `{ runner, registry }` and **no** `auditLog`, so every row below was
    // written by the adapter `composePipeline` built from the instance's own pool. That is the
    // difference between "the port has an implementation" and "production uses it" — the defect
    // standing rules 31 and 35 are named for, asserted from the side that cannot be faked.
    const rows = await pipeline.auditRows();
    expect(rows.length).toBeGreaterThan(0);
    // The workpad is the loudest mutating call the pipeline makes, and it goes through
    // `IntegrationActionExecutor` like everything else (`pipeline/integrations.ts`).
    expect(rows.map((row) => row.action)).toContain('upsert_workpad');
    expect(rows.every((row) => row.project_id === pipeline.projectId)).toBe(true);
    // `attempts` is 0 only for a call that never reached the provider; every `ok` row made one.
    expect(rows.filter((row) => row.status === 'ok').every((row) => row.attempts >= 1)).toBe(true);
    // Migration 0013 dropped the column default, so a row that exists carries a number somebody
    // wrote rather than one the database supplied.
    expect(rows.every((row) => Number.isInteger(row.redaction_count))).toBe(true);

    // The other half of the port's promise: the row and its catalogue event, appended in the same
    // transaction, on the integration's own stream.
    const types = (await pipeline.events()).map((event) => event.type);
    expect(types).toContain('integration.action.performed');
  });
});

describe('when the merge request’s pipeline is red', () => {
  it('sends the task back to implementation and parks it, never reaching code review', async () => {
    // The gate that matters most, on the real path: `ci_gate` is a builtin, so the stage job polls
    // the provider whatever the template's `on` says. A failure branch that fell open here would
    // advance a task to code review on red CI — which is why this drives the fake provider's
    // *failed* pipeline rather than asserting the evaluator's return value again.
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'feature-ci-red',
      tickets: TICKETS,
      ciStatus: 'failed',
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1', 'Story')]);

    const parked = await pipeline.settle('needs_human', (task) => task.state === 'needs_human');
    expect(parked.current_stage).toBe('ci_gate');
    // BD-008 bounds the loop at 3, and the counter never passes its limit.
    expect(parked.iteration_counters.ci_fix).toBe(3);
    // The guard, stated as the thing a human would notice if it failed open.
    expect(pipeline.specs.map((spec) => spec.stage)).not.toContain('code_review');
    expect(pipeline.specs.filter((spec) => spec.stage === 'implementation')).toHaveLength(4);

    const events = await pipeline.events();
    const escalated = events.find((event) => event.type === 'task.escalated');
    const reason = (escalated?.payload as { reason?: string } | undefined)?.reason ?? '';
    expect(reason).toContain('ci_fix iteration limit of 3 reached');
    // The gate's `detail` is what the human is given, and the Q55 cut is what it contains: the
    // failing job's name, carried all the way from the provider to the escalation.
    expect(reason).toContain('test:unit');
    expect(events.map((event) => event.type)).not.toContain('task.completed');
  });
});

describe('a bug ticket, end to end', () => {
  it('takes the investigation stage and finishes on the same tail', async () => {
    const pipeline = await startPipeline({
      scenarios: bugScenarios,
      label: 'bug',
      tickets: TICKETS,
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline, 'ACME-9', 'Bug')]);
    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );
    expect(waiting.template).toBe('bug');
    expect(pipeline.specs.map((spec) => spec.stage)).toContain('investigation');

    await pipeline.publish([merged(pipeline)]);

    const finished = await pipeline.settle('done', (task) => task.state === 'done');
    // Six agent stages: the feature five plus investigation.
    expect(Number(finished.cost_actual)).toBeCloseTo(2.8, 6);
    expect(pipeline.specs.map((spec) => spec.stage)).toEqual([
      'refinement',
      'investigation',
      'architecture',
      'implementation',
      'code_review',
      'business_review',
      'retrospective',
    ]);
  });
});
