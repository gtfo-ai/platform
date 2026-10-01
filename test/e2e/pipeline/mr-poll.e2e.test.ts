/**
 * **WP-110 criterion 3, end to end: a binding GitLab cannot reach hears about its merge requests
 * by polling** — a review-only task started by a poll, and a task that learns from a poll that its
 * merge request merged.
 *
 * A whole `apps/server` instance on PostgreSQL, the fake git provider reached through its
 * registration, and nothing appended by the test: polling is switched on the way an operator does
 * it — `poll_enabled` in the git binding's `bindings.config` — and everything from there is
 * production code: the `mr.poll` sweep's query over git bindings, the queue, the binding loader,
 * the executor's audited `list_merge_requests` read, the shared recorder writing `inbox` and the
 * events in one transaction (with the lifecycle dedup reading the log through migration 0068's
 * index), the outbox, review-only mode and the saga's merged gate.
 *
 * Two facts about the harness, stated so a reader need not rediscover them:
 *
 *  - **The fake's clock is not the wall clock** (`FAKE_EPOCH`), and a binding's first poll reads
 *    its last interval only. So each case seeds `mr_poll_cursor` at the fake's epoch — the column a
 *    previous poll would have left — rather than waiting for two clocks to agree.
 *  - **The world's own merge request is listed too** (`agentic/acme-1`, opened by the harness for
 *    the developer stage). It is the platform's, so review-only mode refuses it, and in the second
 *    case it is the merge request whose merge the poll reports.
 */
import { FAKE_EPOCH } from '@platform/integrations';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GIT_INTEGRATION_ID,
  GIT_PROJECT,
  inboundEvent,
  type PipelineE2E,
  startPipeline,
} from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

const POLL_PREFIX = 'fake-git:poll:';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** What an operator does, plus the cursor a previous poll would have left (see the docblock). */
const switchMergeRequestPollingOn = async (pipeline: PipelineE2E): Promise<void> => {
  await pipeline.query(
    `update bindings
        set config = config || '{"poll_enabled": true, "poll_interval_seconds": 30}'::jsonb,
            mr_poll_cursor = $3::timestamptz
      where project_id = $1 and integration_id = $2`,
    [pipeline.projectId, GIT_INTEGRATION_ID, FAKE_EPOCH],
  );
};

/** The `inbox` row that carried a lifecycle event into the log, found by the event's iid. */
const lifecycleEvents = async (pipeline: PipelineE2E, type: string, iid: number) =>
  (await pipeline.events()).filter(
    (event) => event.type === type && (event.payload as { mr?: { iid?: number } }).mr?.iid === iid,
  );

const VERDICT = {
  verdict: 'approve',
  findings: [],
  summary: 'Reads fine.',
  protected_path_changes_confirmed: [],
};

const REVIEW_ONLY_CONFIG = {
  version: 1,
  features: {
    review_only: {
      enabled: true,
      trigger: 'label',
      label: 'agentic-review',
      severity_floor: 'major',
      max_findings: 10,
    },
  },
};

describe('the merge-request poller', () => {
  it('starts a review from a polled mr.opened, and a later webhook of the same open starts nothing', async () => {
    const pipeline = await startPipeline({
      scenarios: () => ({ code_review: { structuredOutput: VERDICT } }),
      label: 'mr-poll-review',
      config: REVIEW_ONLY_CONFIG,
      ciStatus: null,
      // The sweep is what notices a binding switched on after boot; turned down so the case does
      // not wait a minute for it. The binding's own interval stays at the 30-second floor.
      env: { APP_TICKET_POLL_SWEEP_INTERVAL_MS: '500' },
    });
    harness = pipeline;

    const mr = await pipeline.git.openMergeRequest({
      project: GIT_PROJECT,
      branch: 'human/fix-the-footer',
      target: 'main',
      title: 'Fix the invoice footer',
      description: 'A human’s change; no webhook will ever announce it.',
      draft: false,
      labels: ['agentic-review'],
      reviewers: [],
      remove_source_branch: true,
    });
    pipeline.git.setDiff({
      project: GIT_PROJECT,
      iid: mr.ref.iid,
      files: [{ path: 'src/totals.ts', diff: '@@ -1 +1 @@\n-a\n+b\n' }],
    });

    await switchMergeRequestPollingOn(pipeline);

    await pipeline.waitFor('the review task a poll started to finish', async () => {
      const rows = await pipeline.query<{ state: string }>(
        `select state from tasks where template = 'review_only' and ticket_key = $1`,
        [`mr!${mr.ref.iid}`],
      );
      return rows[0]?.state === 'done';
    });

    // The `mr.opened` that started it came through the poll's door: its inbox row is a poll row.
    const opened = await lifecycleEvents(pipeline, 'mr.opened', mr.ref.iid);
    expect(opened).toHaveLength(1);
    const polledRows = (await pipeline.inbox()).filter((row) =>
      row.delivery_id.startsWith(
        `${POLL_PREFIX}${pipeline.projectId}:${GIT_PROJECT}!${mr.ref.iid}@`,
      ),
    );
    expect(polledRows.length).toBeGreaterThanOrEqual(1);
    // The world's own merge request was listed too, and review-only mode left it alone.
    const reviews = await pipeline.query<{ ticket_key: string }>(
      `select ticket_key from tasks where template = 'review_only'`,
    );
    expect(reviews.map((row) => row.ticket_key)).toEqual([`mr!${mr.ref.iid}`]);

    // The provider's webhook of the same open, late: recorded, and no second `mr.opened`.
    const response = await pipeline.deliverGit(
      pipeline.git.emitMergeRequestEvent({
        event: 'mr.opened',
        project: GIT_PROJECT,
        iid: mr.ref.iid,
        deliveryId: 'webhook-late-open',
      }),
    );
    expect(response.status).toBe(202);
    await pipeline.waitFor('the webhook’s delivery recorded', async () =>
      (await pipeline.inbox()).some((row) => row.delivery_id.includes('webhook-late-open')),
    );
    expect(await lifecycleEvents(pipeline, 'mr.opened', mr.ref.iid)).toHaveLength(1);
    expect(
      await pipeline.query(`select id from tasks where template = 'review_only'`),
    ).toHaveLength(1);
  }, 240_000);

  it('finishes a task whose merge request merged, learning it from a poll', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'mr-poll-merged',
      tickets: TICKETS,
      config: {
        version: 1,
        status_mapping: { refinement: 'In Progress', ready_for_merge: 'In Review' },
      },
      env: { APP_TICKET_POLL_SWEEP_INTERVAL_MS: '500' },
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
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

    // A human merges on the provider. This binding has no webhook: the delivery is built and never
    // sent, and only the provider's state moves.
    pipeline.git.emitMergeRequestEvent({
      event: 'mr.merged',
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
    });
    await switchMergeRequestPollingOn(pipeline);

    const finished = await pipeline.settle('done', (task) => task.state === 'done');
    expect(finished.template).toBe('feature');

    const merged = await lifecycleEvents(pipeline, 'mr.merged', pipeline.world.mr.iid);
    expect(merged).toHaveLength(1);
    expect(
      (await pipeline.inbox()).some((row) =>
        row.delivery_id.startsWith(
          `${POLL_PREFIX}${pipeline.projectId}:${GIT_PROJECT}!${pipeline.world.mr.iid}@`,
        ),
      ),
    ).toBe(true);
  }, 240_000);
});
