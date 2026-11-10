/**
 * **A ticket out of sync is visible, and a tracker never says ready about a draft** (S-28.10,
 * TD-029's amendment C), on a real `apps/server` instance with the fake tracker and fake GitLab.
 *
 * AUT-6655 replayed in shape: the binding maps a lifecycle slot to a status the tracker's workflow
 * cannot reach, so every move to it fails (twenty times on Autix). Here the failures are:
 * - kept on the audit row with their code and redacted message (amendment C (1));
 * - recorded on the task and served as `provider_sync` with what the ticket showed, the statuses it
 *   offered and the reason (C (2)); **Retry** asks again and counts the attempt;
 * and, on the same task, the optional `ready_for_merge` slot is written only after the merge request
 * has read back non-draft (C (4)): the ticket reaches *Ready for Merge* and the merge request is not
 * a draft when it does.
 */
import type { TaskDetailResponse } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import {
  inboundEvent,
  type PipelineE2E,
  startPipeline,
  TICKETS_INTEGRATION_ID,
} from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const STATUSES = ['Ready for the agent', 'Doing', 'Ready for Merge', 'Finished'];

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

describe('out of sync, end to end (S-28.10)', () => {
  it('records a refused lifecycle move with its reason, retries it, and moves the ticket to ready_for_merge only after the MR reads back non-draft', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'provider-sync',
      tickets: [{ ...(TICKETS[0] as (typeof TICKETS)[number]), status: 'Ready for the agent' }],
      ticketStatuses: STATUSES,
      config: { version: 1 },
    });
    harness = pipeline;
    // Written by SQL, past the save check, as a binding saved before the workflow changed would be.
    await pipeline.query(
      'update bindings set config = $3::jsonb where project_id = $1 and integration_id = $2',
      [
        pipeline.projectId,
        TICKETS_INTEGRATION_ID,
        JSON.stringify({
          pickup_status: 'Ready for the agent',
          lifecycle: {
            in_progress: 'Doing',
            in_review: 'In Review',
            ready_for_merge: 'Ready for Merge',
          },
        }),
      ],
    );
    const client = await signIn(pipeline.instance.baseUrl);

    await pipeline.publish([ticketMatched(pipeline)]);
    const ready = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );

    // ── C (1): the audit row keeps what failed ────────────────────────────────────────────────
    const failed = await pipeline.query<{
      error_code: string | null;
      error_message: string | null;
    }>(
      `select error_code, error_message from integration_actions
        where action = 'transition_ticket' and status = 'failed' order by created_at`,
    );
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]?.error_code).toBe('invalid_request');
    expect(failed[0]?.error_message).toContain('In Review');

    // ── C (4): the ticket says ready only once the merge request reads back non-draft ─────────
    await pipeline.waitFor('the ticket moved to Ready for Merge', async () =>
      Promise.resolve(pipeline.tickets.peek('ACME-1')?.status === 'Ready for Merge'),
    );
    const mr = await pipeline.git.getMergeRequest({
      provider: 'fake-git',
      project_path: 'acme/api',
      iid: pipeline.world.mr.iid,
      url: pipeline.world.mr.url,
    } as never);
    expect(mr?.draft).toBe(false);
    // The ready write came before the ticket's move to Ready for Merge.
    const actions = (await pipeline.auditRows()).map((row) => row.action);
    expect(actions.indexOf('mark_merge_request_ready')).toBeGreaterThanOrEqual(0);

    // ── C (2): the refused move is on the task, and Retry asks again ──────────────────────────
    // The in_review failure was recorded; the ready_for_merge move that went through since cleared
    // it, because a later successful move means the ticket is where the platform wants it now.
    const detail = await client.json<TaskDetailResponse>(`/api/tasks/${ready.id}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.provider_sync).toEqual([]);
    const refusedOnce = await client.json<{ error?: { code: string } }>(
      `/api/tasks/${ready.id}/ticket-sync/retry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(refusedOnce.status).toBe(409);
    expect(refusedOnce.body.error?.code).toBe('ticket_in_sync');
  });

  it('keeps a refused move on the task with what the ticket showed and offered, and counts a Retry', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'provider-sync-held',
      tickets: [{ ...(TICKETS[0] as (typeof TICKETS)[number]), status: 'Ready for the agent' }],
      ticketStatuses: STATUSES,
      config: { version: 1 },
    });
    harness = pipeline;
    await pipeline.query(
      'update bindings set config = $3::jsonb where project_id = $1 and integration_id = $2',
      [
        pipeline.projectId,
        TICKETS_INTEGRATION_ID,
        JSON.stringify({
          pickup_status: 'Ready for the agent',
          lifecycle: { in_progress: 'Doing', in_review: 'In Review' },
        }),
      ],
    );
    const client = await signIn(pipeline.instance.baseUrl);
    await pipeline.publish([ticketMatched(pipeline)]);
    const ready = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );

    const read = async () =>
      (await client.json<TaskDetailResponse>(`/api/tasks/${ready.id}`)).body.provider_sync ?? [];
    const [row] = await read();
    expect(row).toMatchObject({
      subject: 'ticket_status',
      slot: 'in_review',
      target: 'In Review',
      observed: 'Doing',
      reason_code: 'invalid_request',
    });
    expect(row?.available).toEqual(expect.arrayContaining(['Ready for Merge', 'Finished']));
    const before = row?.attempts ?? 0;

    const retried = await client.json<{ performed?: boolean }>(
      `/api/tasks/${ready.id}/ticket-sync/retry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'retry-1' },
        body: JSON.stringify({}),
      },
    );
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    await pipeline.waitFor('the retry to fail again and count', async () => {
      const [again] = await read();
      return (again?.attempts ?? 0) > before;
    });
    expect(
      await pipeline.query(
        `select 1 from human_actions where task_id = $1 and action = 'task.ticket_sync.retry'`,
        [ready.id],
      ),
    ).toHaveLength(1);
  });
});
