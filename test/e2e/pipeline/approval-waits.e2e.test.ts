/**
 * **An approval waits until a person decides it**, on a real `apps/server` instance — S-27.1,
 * BD-006's 2026-11-07 amendment (AUT-6639: a plan approval expired after 24 h and its task stopped).
 *
 * The task is started by a `ticket.matched`, walked by the real saga and the fake model to a real
 * plan approval (an **XL** plan trips the `above_size` gate), and then **the clock is moved past
 * three working days** the only way a real instance allows — its time is real (see
 * `../support/pipeline.ts`), so the approval's own instants are moved back instead: `requested_at`
 * ten calendar days ago, which is past three working days on any calendar, and a `deadline_at` a
 * week ago, which is what an earlier build would have written and expired the approval on.
 *
 * What the instance then does on its own — the recovery pass every second
 * (`APP_INTAKE_RECONCILE_INTERVAL_MS`) and the `deadline.sweep` worker — is the assertion:
 *
 * - the task is still `waiting_approval` and the approval still `pending`, its old deadline unread
 *   and unwritten;
 * - five reminders are recorded (`approvals.reminders_sent` = 5), the recovery row finding the first
 *   whose arm lay in the future and each reminder arming the next (all overdue here);
 * - the task read publishes the approval's `deadline_at` as `null` (criterion 4);
 * - and a resume of the waiting task is refused `409 approval_pending`, naming the approval
 *   (criterion 6, BACKLOG 854).
 */
import type { TaskDetailResponse } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import {
  inboundEvent,
  type PipelineE2E,
  type SeededWorld,
  startPipeline,
} from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const DAY_MS = 24 * 60 * 60_000;

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

/** `featureScenarios` with an **XL** plan, which is what trips the plan approval gate. */
const approvingScenarios = (world: SeededWorld) => {
  const base = featureScenarios(world);
  return {
    ...base,
    architecture: {
      structuredOutput: {
        ...(base.architecture.structuredOutput as Record<string, unknown>),
        estimated_size: 'XL',
      },
    },
  };
};

const signIn = async (baseUrl: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

interface ApprovalRow extends Record<string, unknown> {
  readonly id: string;
  readonly status: string;
  readonly reminders_sent: number;
  readonly deadline_at: Date | null;
}

describe('an approval waits until a person decides it (S-27.1)', () => {
  it('is still pending past three working days, with five reminders recorded, and its task still waits', async () => {
    const pipeline = await startPipeline({
      scenarios: approvingScenarios,
      label: 'approval-waits',
      tickets: TICKETS,
      agent: 'fake-runner',
      // The recovery pass every second, so the moved instants are acted on inside the test.
      env: { APP_INTAKE_RECONCILE_INTERVAL_MS: '1000' },
    });
    harness = pipeline;
    await pipeline.publish([ticketMatched(pipeline)]);
    const waiting = await pipeline.settle(
      'waiting_approval',
      (snapshot) => snapshot.state === 'waiting_approval',
    );
    const [requested] = await pipeline.query<ApprovalRow>(
      'select id, status, reminders_sent, deadline_at from approvals where task_id = $1',
      [waiting.id],
    );
    expect(requested?.status).toBe('pending');
    // This build writes no deadline (BD-006's amendment, item 4).
    expect(requested?.deadline_at).toBeNull();
    const approvalId = requested?.id as string;

    // Past three working days: requested ten calendar days ago, with the deadline an earlier build
    // would have written a week ago — history, which nothing on this build reads as an expiry.
    const now = Date.now();
    const oldDeadline = new Date(now - 7 * DAY_MS);
    await pipeline.query('update approvals set requested_at = $2, deadline_at = $3 where id = $1', [
      approvalId,
      new Date(now - 10 * DAY_MS),
      oldDeadline,
    ]);

    // The last row the platform writes for it: the fifth reminder's count (rule 4).
    await pipeline.waitFor('the approval’s fifth reminder', async () => {
      const [row] = await pipeline.query<ApprovalRow>(
        'select id, status, reminders_sent, deadline_at from approvals where id = $1',
        [approvalId],
      );
      return row?.reminders_sent === 5;
    });

    const [after] = await pipeline.query<ApprovalRow>(
      'select id, status, reminders_sent, deadline_at from approvals where id = $1',
      [approvalId],
    );
    expect(after?.status).toBe('pending');
    expect(after?.reminders_sent).toBe(5);
    expect(after?.deadline_at?.toISOString()).toBe(oldDeadline.toISOString());
    expect((await pipeline.task()).state).toBe('waiting_approval');
    const events = await pipeline.events();
    expect(events.filter((event) => event.type === 'task.approval.decided')).toEqual([]);
    expect(events.filter((event) => event.type === 'task.escalated')).toEqual([]);

    // Criterion 4: the read publishes no deadline for it, whatever the row holds.
    const admin = await signIn(pipeline.instance.baseUrl);
    const detail = await admin.json<TaskDetailResponse>(`/api/tasks/${waiting.id}`);
    expect(detail.body.approvals.map((approval) => [approval.id, approval.deadline_at])).toEqual([
      [approvalId, null],
    ]);

    // Criterion 6: a resume does not go round it, even an administrator's.
    const resumed = (await admin.json(`/api/tasks/${waiting.id}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })) as { status: number; body: { error?: { code: string; message: string } } };
    expect(resumed.status).toBe(409);
    expect(resumed.body.error?.code).toBe('approval_pending');
    expect(resumed.body.error?.message).toContain(approvalId);
    expect((await pipeline.task()).state).toBe('waiting_approval');
  }, 240_000);
});
