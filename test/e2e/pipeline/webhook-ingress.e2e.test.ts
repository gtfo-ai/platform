/**
 * **WP-15c's headline criterion: a signed provider delivery to a running `apps/server` drives a
 * task to `task.completed` without a seeded row.**
 *
 * Every other pipeline e2e starts by *appending an event* — `pipeline.publish([...])`, which is
 * what an inbound adapter would have done. That made "the platform runs a ticket to an MR" a claim
 * about the pipeline package with a harness standing where the door should be. This file removes
 * the harness: it `POST`s bytes to a real socket, and everything from there is production code —
 * the Fastify route and its raw-body parser, the binding loader reading `integrations`/`bindings`
 * and decrypting `secrets`, the provider's own signature check, `inbox(provider, delivery_id)`, the
 * event append, the outbox worker, pg-boss and every stage.
 *
 * The one double is the provider on the far side of the HTTP call (and the model), which is exactly
 * the boundary technical/10 draws for this tier — and the fake is reached **through its
 * registration**, resolved by the `provider` column of the seeded row, so the door is the same one
 * GitLab and Jira come through. Their real signature schemes are asserted against a real database
 * in `test/integration/integrations/webhook-ingress.integration.test.ts`.
 */
import { FAKE_TASK_MANAGEMENT_PROVIDER_ID } from '@platform/integrations';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GIT_PROJECT,
  inboundEvent,
  type PipelineE2E,
  startPipeline,
  TICKETS_INTEGRATION_ID,
} from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

/** The human merge, as `pipeline.e2e.test.ts` publishes it. */
const mergedEvent = (pipeline: PipelineE2E) =>
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

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe('a signed webhook delivery', () => {
  it('starts a ticket nothing seeded and drives it to task.completed', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'ingress',
      tickets: TICKETS,
      config: { status_mapping: { refinement: 'In Progress', ready_for_merge: 'In Review' } },
    });
    harness = pipeline;

    // Nothing has been appended and no task exists: the only thing that happens is an HTTP request.
    expect(await pipeline.taskCount()).toBe(0);

    const delivery = pipeline.tickets.emitTicketMatched({
      ticketKey: 'ACME-1',
      rule: 'label:agentic',
    });
    const response = await pipeline.deliver(delivery);

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ accepted: true });

    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );
    expect(waiting.template).toBe('feature');

    /**
     * **WP-15f: the platform read the ticket, over the production path.**
     *
     * The row is the end of the chain the rest of this file walks — signed delivery, binding
     * loader, `inbox`, `ticket.matched`, the `intake_check` outbound job — and the read is the one
     * thing in it that reaches back *out* to the provider through `IntegrationActionExecutor`.
     * Asserted on the stored row rather than through the runner, which never reads a prompt
     * (standing rule 82); the assembled prompt itself is asserted in the unit and contract tiers.
     */
    expect(waiting.ticket_snapshot?.title).toBe('Show the totals in the invoice footer');
    expect(waiting.ticket_snapshot?.description).toContain('sums the visible rows');
    expect(waiting.ticket_snapshot?.truncated).toBe(false);
    expect(waiting.ticket_snapshot_at).not.toBeNull();

    /**
     * **TD-012 step 2 reaches the sink this work package created.**
     *
     * `TICKETS` plants a `glpat-…`-shaped token in the ticket body, and the only thing between it
     * and a prompt is `platformRedactor: patternRedactor()` on `createPipelineIntegrationsLoader`
     * in `apps/server/src/pipeline.ts` — the line the sibling `composeWebhookIngress` has had since
     * WP-15c for `inbox`. Removing it leaves the token in `tasks.ticket_snapshot` and in every
     * prompt built from it — and in whatever task DTO first carries the field, which none does yet.
     */
    expect(waiting.ticket_snapshot?.description).not.toContain('glpat-');
    expect(waiting.ticket_snapshot?.description).toContain('[REDACTED sha256:');
    expect(waiting.ticket_snapshot?.redaction_count).toBe(1);

    // BD-007: the platform never merges, so the last step is a human's. It is `publish`ed rather
    // than delivered, because the merge is a **git** event and the git binding of this harness is
    // the fake provider, which has no webhook half — the ingress criterion is about the ticket that
    // started the task, and that one really did arrive over HTTP.
    await pipeline.publish([mergedEvent(pipeline)]);
    const done = await pipeline.settle('done', (task) => task.state === 'done');
    expect(done.state).toBe('done');
    expect((await pipeline.events()).map((event) => event.type)).toContain('task.completed');
  }, 180_000);

  it('is deduplicated on a replay, and performs nothing twice', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'ingress-replay',
      tickets: TICKETS,
    });
    harness = pipeline;

    const delivery = pipeline.tickets.emitTicketMatched({
      ticketKey: 'ACME-1',
      rule: 'label:agentic',
      deliveryId: 'fixed-delivery-1',
    });

    const first = await pipeline.deliver(delivery);
    await pipeline.settle('a task', (task) => task.id.length > 0);
    const second = await pipeline.deliver(delivery);

    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ accepted: true });
    expect(second.status).toBe(202);
    expect(second.body).toMatchObject({ accepted: true });

    const rows = await pipeline.inbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: FAKE_TASK_MANAGEMENT_PROVIDER_ID,
      verified: true,
    });
    // The assertion "performs nothing twice" actually needs: one `ticket.matched`, one task.
    const matched = (await pipeline.events()).filter((event) => event.type === 'ticket.matched');
    expect(matched).toHaveLength(1);
    expect(await pipeline.taskCount()).toBe(1);
  }, 180_000);

  it('refuses a forged delivery, writes no inbox row, and starts nothing', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'ingress-forged',
      tickets: TICKETS,
    });
    harness = pipeline;

    const genuine = pipeline.tickets.emitTicketMatched({
      ticketKey: 'ACME-1',
      rule: 'label:agentic',
      deliveryId: 'forged-1',
    });
    const forged = {
      ...genuine,
      // The body an attacker wants, with the signature of the body they were given.
      body: genuine.body.replace('ACME-1', 'ACME-2'),
    };

    const response = await pipeline.deliver(forged);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ accepted: false, delivery_id: null });
    // A dedup key an unauthenticated caller chose is a key it could poison: the genuine delivery
    // that follows must still be performed.
    expect(await pipeline.inbox()).toHaveLength(0);
    expect(await pipeline.taskCount()).toBe(0);

    const accepted = await pipeline.deliver(genuine);
    expect(accepted.status).toBe(202);
    await pipeline.settle('the task the forgery could not block', (task) => task.id.length > 0);
  }, 180_000);

  it('answers 404 for an integration id nobody has', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'ingress-unknown',
      tickets: TICKETS,
    });
    harness = pipeline;

    const response = await fetch(
      `${pipeline.instance.baseUrl}/webhooks/${FAKE_TASK_MANAGEMENT_PROVIDER_ID}/00000000-0000-4000-8000-00000000dead`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );

    expect(response.status).toBe(404);
    expect(TICKETS_INTEGRATION_ID).not.toBe('00000000-0000-4000-8000-00000000dead');
  }, 180_000);
});
