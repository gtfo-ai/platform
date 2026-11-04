/**
 * **The job ends at the offer** — WP-276 criterion (6), TD-031 decision 3, through a whole
 * `apps/server` instance on PostgreSQL with the fake Claude CLI.
 *
 *  1. A task walks every stage of the default template with **every run outside its job**: the
 *     `stage.execute` job that offered a run had completed before the run ended — inside the job,
 *     the job completed only after its run's settle — and every offer was claimed by the server's
 *     claimant and settled.
 *  2. A **duplicate** `stage.execute` for an entry whose run is live starts nothing — no second run,
 *     no second offer — because `revalidate` asks whether the entry already has a live run.
 *  3. A **cancel** during a claimed run ends it `cancelled` through its holder (TD-028 decision 11).
 */
import type { Jobs } from '@platform/application';
import type { CancelRunResponse } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const ticketMatched = (pipeline: PipelineE2E) =>
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
  });

const signIn = async (baseUrl: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

describe('runs outside the job (WP-276 criterion 6)', () => {
  it('walks the default template with every run claimed and settled after its job completed', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'offers-default-template',
      tickets: TICKETS,
    });
    harness = pipeline;
    await pipeline.publish([ticketMatched(pipeline)]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

    const offers = await pipeline.query<{
      stage: string;
      state: string;
      claimant_kind: string | null;
      job_done_before_run_ended: boolean | null;
    }>(
      `select o.stage, o.state::text as state, o.claimant_kind::text as claimant_kind,
              exists (select 1
                 from pgboss.job j
                where j.name = 'stage.execute'
                  and j.data->>'task_id' = o.task_id::text
                  and j.data->>'stage' = o.stage
                  and (j.data->>'attempt')::int = o.attempt
                  and j.state = 'completed'
                  and j.completed_on < r.ended_at) as job_done_before_run_ended
         from run_offers o join runs r on r.id = o.run_id
        where o.kind = 'stage'
        order by o.offered_at`,
    );
    expect(offers.length).toBeGreaterThan(3);
    for (const offer of offers) {
      expect(offer, offer.stage).toMatchObject({
        state: 'settled',
        claimant_kind: 'server',
        job_done_before_run_ended: true,
      });
    }
  }, 300_000);

  it('starts nothing for a duplicate stage.execute during a run, and a cancel ends the run through its holder', async () => {
    let jobs: Jobs | undefined;
    const pipeline = await startPipeline({
      scenarios: (world) => ({
        ...featureScenarios(world),
        refinement: { ...featureScenarios(world).refinement, awaitSteers: 1 },
      }),
      label: 'offers-duplicate-cancel',
      tickets: TICKETS,
      agent: 'real-over-fake-cli',
      jobs: (inner) => {
        jobs = inner;
        return inner;
      },
    });
    harness = pipeline;
    await pipeline.publish([ticketMatched(pipeline)]);
    await pipeline.waitFor('the refinement run to be running', async () => {
      const rows = await pipeline.query("select 1 from runs where status = 'running'");
      return rows.length === 1;
    });
    const [live] = await pipeline.query<{ id: string; task_id: string }>(
      "select id, task_id from runs where status = 'running'",
    );

    // The duplicate wake-up: the same stage entry, while its run is live.
    const enqueued = await jobs?.enqueue({
      queue: 'stage.execute',
      singletonKey: `task:${live?.task_id}`,
      data: {
        task_id: live?.task_id,
        project_id: pipeline.projectId,
        stage: 'refinement',
        attempt: 1,
      },
    });
    expect(enqueued?.status).toBe('enqueued');
    await pipeline.waitFor('the duplicate job to have run', async () => {
      const rows = await pipeline.query(
        `select 1 from pgboss.job where name = 'stage.execute' and state = 'completed'
           and data->>'stage' = 'refinement' and created_on > (select created_at from runs where id = $1)`,
        [live?.id],
      );
      return rows.length > 0;
    });
    const [counts] = await pipeline.query<{ runs: number; offers: number }>(
      `select (select count(*)::int from runs) as runs,
              (select count(*)::int from run_offers) as offers`,
    );
    expect(counts).toEqual({ runs: 1, offers: 1 });

    // The cancel: recorded for the holder, which stops the session; the run ends `cancelled`.
    const client = await signIn(pipeline.instance.baseUrl);
    const cancelled = await client.json<CancelRunResponse>(`/api/runs/${live?.id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'cancel-offers-e2e' },
      body: JSON.stringify({}),
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(202);
    await pipeline.waitFor('the holder to end the run cancelled', async () => {
      const [row] = await pipeline.query<{ status: string }>(
        'select status::text as status from runs where id = $1',
        [live?.id],
      );
      return row?.status === 'cancelled';
    });
    const [command] = await pipeline.query<{ applied: boolean }>(
      "select applied_at is not null as applied from run_commands where run_id = $1 and kind = 'cancel'",
      [live?.id],
    );
    expect(command?.applied).toBe(true);
    const [offer] = await pipeline.query<{ state: string }>(
      'select state::text as state from run_offers where run_id = $1',
      [live?.id],
    );
    expect(offer?.state).toBe('settled');
  }, 300_000);
});
