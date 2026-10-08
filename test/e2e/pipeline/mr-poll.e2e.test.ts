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
 *  - **The world's own merge request is listed too** (`agentic/ACME-1`, opened by the harness for
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
      env: { APP_POLL_SWEEP_INTERVAL_MS: '500' },
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
      env: { APP_POLL_SWEEP_INTERVAL_MS: '500' },
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

/**
 * **WP-123 criterion 2: a poll-only binding re-checks a task at Ready when `main` moves, and hears a
 * reviewer** (PROGRESS backlog 373). The git binding here has no webhook (`receives_webhooks` is
 * absent, which the fake's registration reads as GitLab reads a binding with neither webhook secret),
 * so the only door for `default_branch.moved` and `mr.review.comment` is the poll.
 *
 * Three harness moves, each stated:
 *
 *  - **Polls are nudged** (`start_after = now()` on the queued `mr.poll` job) rather than waited
 *    for: the binding's interval cannot go below 30 seconds, and a case needs three polls.
 *  - **"A poll ran after X" is a completed `mr.poll` job that started after X**, both instants on
 *    the database's clock — the last row a poll writes (rule 87), and the only one a poll that
 *    recorded nothing writes at all.
 *  - **The task's Ready entry is moved ten minutes back** in the notes case, and each note is
 *    written three minutes ago: after the entry, so the poll reads it, and older than BD-007's
 *    two-minute window, so the window returns the task when it fires instead of opening another
 *    (`reviewWindowHandler` compares the newest note with now). Without it the case would wait two
 *    real minutes for a window. The window's job is nudged like the polls.
 */
describe('a poll-only binding (WP-123)', () => {
  const pollOnlyOn = async (pipeline: PipelineE2E, extra: Record<string, unknown> = {}) => {
    await pipeline.query(
      `update bindings set config = config || $3::jsonb
        where project_id = $1 and integration_id = $2`,
      [
        pipeline.projectId,
        GIT_INTEGRATION_ID,
        JSON.stringify({ poll_enabled: true, poll_interval_seconds: 30, ...extra }),
      ],
    );
  };
  const dbNow = async (pipeline: PipelineE2E): Promise<string> =>
    (await pipeline.query<{ now: string }>('select now()::text as now'))[0]?.now as string;
  const nudge = (pipeline: PipelineE2E, queue: string) =>
    pipeline.query(
      `update pgboss.job set start_after = now() where name = $1 and state = 'created'`,
      [queue],
    );
  /** Waits for one whole poll of this binding that started after `since` (see the docblock). */
  const pollCompletedAfter = async (pipeline: PipelineE2E, since: string, what: string) => {
    await pipeline.waitFor(what, async () => {
      await nudge(pipeline, 'mr.poll');
      const rows = await pipeline.query<{ n: string }>(
        `select count(*)::text as n from pgboss.job
          where name = 'mr.poll' and data->>'kind' = 'poll' and state = 'completed'
            and started_on > $1::timestamptz`,
        [since],
      );
      return Number(rows[0]?.n) >= 1;
    });
  };
  /**
   * **Quiet: nothing the pipeline decided is still owed** — no event awaiting dispatch and no
   * `pipeline.outbound` job `created`, `retry` or `active` — and then the fake git's read count
   * unchanged across two samples one harness polling interval apart (PROGRESS backlog 419).
   *
   * `ready_for_merge` is **already true** while the duties entering the rebase gate and Ready
   * enqueued (`risk_route`, `coverage`, …) are still queued, and two of them read the default
   * branch (`risk-routing.ts`, `coverage.ts`). A baseline taken on the state alone let such a read
   * land after it and count as a poll's (rule 87's second question: the predicate was true before
   * the event). So the baseline is taken here, after the last thing those duties do — their job
   * leaving the queue — and the stable count guards a read still in flight as the job completes.
   */
  const quiesced = async (pipeline: PipelineE2E, reads: () => number): Promise<number> => {
    await pipeline.waitFor('no dispatch and no outbound job owed', async () => {
      const rows = await pipeline.query<{ owed: string }>(
        `select ((select count(*) from event_dispatch where dead_lettered_at is null)
               + (select count(*) from pgboss.job
                   where name = 'pipeline.outbound' and state in ('created', 'retry', 'active'))
               )::text as owed`,
      );
      return Number(rows[0]?.owed) === 0;
    });
    let previous = reads();
    await pipeline.waitFor('the provider read count to hold still', async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const now = reads();
      const stable = now === previous;
      previous = now;
      return stable;
    });
    return previous;
  };
  const ofType = async (pipeline: PipelineE2E, type: string) =>
    (await pipeline.events()).filter((event) => event.type === type);
  const toReady = async (label: string, extraEnv: Record<string, string> = {}) => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label,
      tickets: TICKETS,
      env: { APP_POLL_SWEEP_INTERVAL_MS: '500', ...extraEnv },
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
    return pipeline;
  };

  it('re-enters the rebase gate when a poll sees the default branch move, and a second poll appends nothing', async () => {
    const pipeline = await toReady('mr-poll-default-branch');
    const before = await pipeline.task();
    expect(before.stage_attempts.rebase_gate).toBe(1);

    await pollOnlyOn(pipeline);
    // The first poll reads the head and records no event: it has never seen the branch move.
    await pipeline.waitFor('the first poll to record the head it read', async () => {
      await nudge(pipeline, 'mr.poll');
      const rows = await pipeline.query<{ head: string | null }>(
        `select mr_poll_default_head as head from bindings
          where project_id = $1 and integration_id = $2`,
        [pipeline.projectId, GIT_INTEGRATION_ID],
      );
      return (rows[0]?.head ?? null) !== null;
    });
    expect(await ofType(pipeline, 'default_branch.moved')).toEqual([]);

    const moved = 'd'.repeat(40);
    pipeline.git.moveDefaultBranch(GIT_PROJECT, moved);
    const rearmed = await pipeline.settle('the rebase gate a second time, from a poll', (task) => {
      return (task.stage_attempts.rebase_gate ?? 0) >= 2 && task.state === 'ready_for_merge';
    });
    expect(rearmed.iteration_counters.rebase_rechecks).toBe(1);
    const events = await ofType(pipeline, 'default_branch.moved');
    expect(events.map((event) => event.payload)).toEqual([
      { project_id: pipeline.projectId, branch: 'main', new_head: moved },
    ]);
    expect(
      (await pipeline.inbox()).filter((row) =>
        row.delivery_id.startsWith(`${POLL_PREFIX}${pipeline.projectId}:${GIT_PROJECT}@default:`),
      ),
    ).toHaveLength(1);

    // A whole poll after the move was recorded appends nothing more.
    await pollCompletedAfter(pipeline, await dbNow(pipeline), 'a poll after the move');
    expect(await ofType(pipeline, 'default_branch.moved')).toHaveLength(1);
    expect((await pipeline.task()).stage_attempts.rebase_gate).toBe(2);
  }, 240_000);

  it('returns a task at Ready for a person’s polled note, and not for a system note or the platform’s own', async () => {
    const pipeline = await toReady('mr-poll-review-notes');
    const task = await pipeline.task();
    await pipeline.query(
      `update task_stages set entered_at = now() - interval '10 minutes'
        where task_id = $1 and stage = 'ready_for_merge' and exited_at is null`,
      [task.id],
    );
    // WP-178: a word returns the task only when it is newer than the start of the task's latest
    // implementation run (TD-029 decision 7's horizon). The notes below are written "three minutes
    // ago", so the run is moved back with the Ready entry, as if the walk had taken ten minutes.
    await pipeline.query(
      `update runs set created_at = now() - interval '11 minutes',
                       started_at = now() - interval '11 minutes'
        where task_id = $1`,
      [task.id],
    );
    const threeMinutesAgo = () => new Date(Date.now() - 3 * 60_000).toISOString();
    const systemThread = pipeline.git.addHumanDiscussion({
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      authorId: 'dana',
      text: 'added 1 commit',
      system: true,
      createdAt: threeMinutesAgo(),
    });
    const platformThread = pipeline.git.addHumanDiscussion({
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      authorId: 'agentic-bot',
      text: `<!-- agentic:conflict-warning:${task.id} -->\nThis merge request overlaps another.`,
      createdAt: threeMinutesAgo(),
    });

    const notesAdded = await dbNow(pipeline);
    await pollOnlyOn(pipeline);
    await pollCompletedAfter(pipeline, notesAdded, 'a poll after the two notes');
    expect(await ofType(pipeline, 'mr.review.comment')).toEqual([]);
    expect(
      await pipeline.query(`select id from pgboss.job where name = 'mr.comment.debounce'`),
    ).toEqual([]);
    expect((await pipeline.task()).state).toBe('ready_for_merge');

    const humanThread = pipeline.git.addHumanDiscussion({
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      authorId: 'dana',
      text: 'Please rename totals before this merges.',
      createdAt: threeMinutesAgo(),
    });
    await pipeline.waitFor('the task returned to implementation for the polled note', async () => {
      await nudge(pipeline, 'mr.poll');
      await nudge(pipeline, 'mr.comment.debounce');
      return (await ofType(pipeline, 'task.stage.returned')).some(
        (event) =>
          (event.payload as { from_stage?: string }).from_stage === 'ready_for_merge' &&
          (event.payload as { to_stage?: string }).to_stage === 'implementation',
      );
    });
    const returned = (await ofType(pipeline, 'task.stage.returned')).find(
      (event) => (event.payload as { from_stage?: string }).from_stage === 'ready_for_merge',
    );
    expect((returned?.payload as { reason?: string } | undefined)?.reason).toContain(
      'Please rename totals',
    );
    const comments = await ofType(pipeline, 'mr.review.comment');
    expect(comments.map((event) => (event.payload as { thread_id: string }).thread_id)).toEqual([
      humanThread.id,
    ]);
    const threads = comments.map((event) => (event.payload as { thread_id: string }).thread_id);
    expect(threads).not.toContain(systemThread.id);
    expect(threads).not.toContain(platformThread.id);
    expect(
      (await pipeline.inbox()).filter((row) =>
        row.delivery_id.startsWith(
          `${POLL_PREFIX}${pipeline.projectId}:${GIT_PROJECT}!${pipeline.world.mr.iid}#note:`,
        ),
      ),
    ).toHaveLength(1);
  }, 240_000);

  it('makes neither read on a binding a webhook reaches', async () => {
    const pipeline = await toReady('mr-poll-webhook-binding');
    const task = await pipeline.task();
    await pipeline.query(
      `update task_stages set entered_at = now() - interval '10 minutes'
        where task_id = $1 and stage = 'ready_for_merge' and exited_at is null`,
      [task.id],
    );
    pipeline.git.addHumanDiscussion({
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      authorId: 'dana',
      text: 'Please rename totals before this merges.',
      createdAt: new Date(Date.now() - 3 * 60_000).toISOString(),
    });
    pipeline.git.moveDefaultBranch(GIT_PROJECT, 'e'.repeat(40));
    const reads = () =>
      pipeline
        .gitCalls()
        .filter((call) => call.method === 'getBranchHead' || call.method === 'listDiscussions')
        .length;
    // Backlog 419: the baseline only once the Ready entry's own duties have read what they read.
    const readsBefore = await quiesced(pipeline, reads);

    const switchedOn = await dbNow(pipeline);
    await pollOnlyOn(pipeline, { receives_webhooks: true });
    await pollCompletedAfter(pipeline, switchedOn, 'a first poll of the webhook binding');
    await pollCompletedAfter(pipeline, await dbNow(pipeline), 'a second poll of it');

    expect(reads(), 'no default-branch read and no notes read').toBe(readsBefore);
    const head = await pipeline.query<{ head: string | null }>(
      `select mr_poll_default_head as head from bindings
        where project_id = $1 and integration_id = $2`,
      [pipeline.projectId, GIT_INTEGRATION_ID],
    );
    expect(head[0]?.head ?? null).toBeNull();
    expect(await ofType(pipeline, 'default_branch.moved')).toEqual([]);
    expect(await ofType(pipeline, 'mr.review.comment')).toEqual([]);
    expect((await pipeline.task()).state).toBe('ready_for_merge');
  }, 240_000);
});
