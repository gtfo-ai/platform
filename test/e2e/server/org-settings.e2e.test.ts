/**
 * **The organisation settings document, over HTTP, against a real instance** (WP-93).
 *
 * Until WP-93 the organisation layer the pipeline composes (`organizations.settings`) had **no
 * writer but SQL** (PROGRESS backlogs 146 (2), 223): its command maximum and WIP maximum were read
 * on every run and could be set by nobody, and the autonomy maximum BD-025 §2 promises was read by
 * nothing. What this tier owns is the whole chain — a person with a session cookie writes the
 * document through `PATCH /api/org`, and the **next** run, the **next** task and the **next**
 * settings read change because of it — which the unit tier can only assert one function at a time.
 *
 * The ruling it holds, stated once (the plan's WP-93 row): a lowered maximum applies **at the next
 * read**, and a task's frozen dial (`tasks.pipeline_dial`, migration 0049) is **not moved**. The
 * second case asserts both halves on one instance: a task in flight when the maximum is lowered
 * finishes on the dial it started under, and the task after it starts under the maximum.
 */
import type { RunSpec } from '@platform/application';
import type { AutonomyResponse } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

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

const signIn = async (baseUrl: string, email: string, password: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', { email, password });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

/** A signed-in client for a user of the given organisation role, created by the administrator. */
const signInAs = async (
  admin: Client,
  baseUrl: string,
  role: 'member' | 'maintainer',
): Promise<Client> => {
  const email = `${role}@example.test`;
  const password = `not-a-real-password-${role}-0000`;
  const created = await admin.post('/api/auth/admin/create-user', {
    email,
    password,
    name: role,
    role,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return signIn(baseUrl, email, password);
};

type Reply = { status: number; body: Record<string, unknown> };

const send = async (
  client: Client,
  method: 'PATCH' | 'PUT' | 'POST',
  path: string,
  body: unknown,
  key?: string,
): Promise<Reply> =>
  client.json(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    body: JSON.stringify(body),
  }) as Promise<Reply>;

const codeOf = (reply: Reply): string =>
  ((reply.body as { error?: { code?: string } }).error?.code ?? '') as string;

/** The one task of a ticket, once it exists. */
const taskOf = async (
  pipeline: PipelineE2E,
  key: string,
): Promise<{ id: string; state: string; pipeline_dial: Record<string, unknown> | null } | null> => {
  const rows = await pipeline.query<{
    id: string;
    state: string;
    pipeline_dial: Record<string, unknown> | null;
  }>('select id, state, pipeline_dial from tasks where ticket_key = $1', [key]);
  return rows[0] ?? null;
};

const waitForState = async (pipeline: PipelineE2E, key: string, state: string) => {
  await pipeline.waitFor(`${key} to reach ${state}`, async () => {
    return (await taskOf(pipeline, key))?.state === state;
  });
};

const stagesRun = async (pipeline: PipelineE2E, taskId: string): Promise<string[]> => {
  const rows = await pipeline.query<{ stage: string }>(
    `select ts.stage from runs r join task_stages ts on ts.id = r.task_stage_id
      where r.task_id = $1 order by r.created_at`,
    [taskId],
  );
  return rows.map((row) => row.stage);
};

const approvePlan = async (pipeline: PipelineE2E, client: Client, taskId: string, key: string) => {
  const approvals = await pipeline.query<{ id: string }>(
    "select id from approvals where task_id = $1 and status = 'pending'",
    [taskId],
  );
  expect(approvals).toHaveLength(1);
  const decided = await send(
    client,
    'POST',
    `/api/tasks/${taskId}/approvals/${approvals[0]?.id}/decide`,
    { decision: 'approve' },
    key,
  );
  expect(decided.status, JSON.stringify(decided.body)).toBe(200);
};

describe('the organisation settings document over HTTP', () => {
  it('lets an admin set the command and WIP maximums, refuses a member, and the next run is held to them (criteria 1 and 6)', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'org-settings-commands',
      tickets: TICKETS,
    });
    harness = pipeline;
    const admin = await signIn(pipeline.instance.baseUrl, BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    const member = await signInAs(admin, pipeline.instance.baseUrl, 'member');

    // The document as a stock instance has it: nothing stated.
    const initial = await admin.json<{ settings: unknown }>('/api/org');
    expect(initial.status).toBe(200);
    expect(initial.body.settings).toEqual({});

    // A run planned before any maximum exists: the role baseline, as shipped.
    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    await waitForState(pipeline, 'ACME-1', 'ready_for_merge');
    const before: readonly RunSpec[] = [...pipeline.specs];
    expect(before.length).toBeGreaterThan(0);
    expect(before.some((spec) => spec.commandPolicy.allow.length > 1)).toBe(true);

    const maximum = {
      commands: { allow: ['git status'], block: ['curl *'] },
      pipeline: { wip: { max_parallel_tasks: 1 } },
    };
    // A member may not write it — BD-025 §2's maximum is the organisation's, not a project's.
    const refused = await send(member, 'PATCH', '/api/org', maximum);
    expect(refused.status).toBe(403);
    expect(
      await pipeline.query("select 1 from human_actions where action = 'org.settings.write'"),
    ).toEqual([]);

    const written = await send(admin, 'PATCH', '/api/org', maximum, 'org-settings-1');
    expect(written.status, JSON.stringify(written.body)).toBe(200);
    expect(written.body).toMatchObject({
      settings: maximum,
      changed: ['commands', 'pipeline'],
      performed: true,
    });
    // WP-113 (backlog 318): the write names the project it caps, read in its own transaction.
    expect(written.body.capped_projects).toContainEqual(
      expect.objectContaining({
        project_id: pipeline.projectId,
        setting: 'pipeline.wip.max_parallel_tasks',
        after: 1,
      }),
    );
    // Stored as written, read back through the parse, and audited once.
    expect((await admin.json<{ settings: unknown }>('/api/org')).body.settings).toEqual(maximum);
    const audited = await pipeline.query<{ params: Record<string, unknown> }>(
      "select params from human_actions where action = 'org.settings.write'",
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]?.params).toMatchObject({ scope: 'org', changed: ['commands', 'pipeline'] });

    // Criterion 6: the WIP maximum is what the project's effective configuration reads now.
    const config = await admin.json<{
      effective: { pipeline: { wip: { max_parallel_tasks: number } } };
      sources: Record<string, string>;
    }>(`/api/projects/${pipeline.projectId}/config`);
    expect(config.status).toBe(200);
    expect(config.body.effective.pipeline.wip.max_parallel_tasks).toBe(1);
    expect(config.body.sources['pipeline.wip.max_parallel_tasks']).toBe('org');

    // Criterion 1: the **next** run's policy is the baseline intersected with the maximum.
    await pipeline.publish([ticketMatched(pipeline, 'ACME-2')]);
    await waitForState(pipeline, 'ACME-2', 'ready_for_merge');
    const after = pipeline.specs.slice(before.length);
    expect(after.length).toBeGreaterThan(0);
    for (const spec of after) {
      expect(spec.commandPolicy.allow.every((entry) => entry === 'git status')).toBe(true);
      expect(spec.commandPolicy.block).toContain('curl *');
    }
    // Not vacuous: the verb both the baseline and the maximum grant is still granted.
    expect(after.some((spec) => spec.commandPolicy.allow.includes('git status'))).toBe(true);
  }, 300_000);

  it('caps the dial at the next task and never moves a running task’s frozen dial (criterion 2)', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'org-settings-autonomy',
      tickets: TICKETS,
    });
    harness = pipeline;
    const admin = await signIn(pipeline.instance.baseUrl, BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    const dial = `/api/projects/${pipeline.projectId}/autonomy`;

    // Supervised: business review runs, and probation parks the first plan at a human — which is
    // what keeps ACME-1 **in flight** while the maximum is lowered.
    const selected = await send(admin, 'PUT', dial, { autonomy: 'supervised' }, 'dial-1');
    expect(selected.status, JSON.stringify(selected.body)).toBe(200);
    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    await waitForState(pipeline, 'ACME-1', 'waiting_approval');
    const first = await taskOf(pipeline, 'ACME-1');
    expect(first?.pipeline_dial).toMatchObject({ level: 'supervised', business_review: true });

    // The organisation lowers its maximum to Assist while ACME-1 waits.
    const lowered = await send(admin, 'PATCH', '/api/org', { autonomy: { maximum: 'assist' } });
    expect(lowered.status, JSON.stringify(lowered.body)).toBe(200);
    // WP-113 (backlog 318): the answer names the project the maximum now caps — the dial read off
    // the materialised document the real row holds, in the write's own transaction.
    const [project] = await pipeline.query<{ key: string }>(
      'select key from projects where id = $1',
      [pipeline.projectId],
    );
    expect(lowered.body.capped_projects).toEqual([
      {
        project_id: pipeline.projectId,
        project_key: project?.key,
        setting: 'autonomy',
        before: 'supervised',
        after: 'assist',
      },
    ]);

    // The dial read says what the project chose and what is in force; selecting above is refused.
    const read = await admin.json<AutonomyResponse>(dial);
    expect(read.body).toMatchObject({
      level: 'supervised',
      organisation_maximum: 'assist',
      level_in_force: 'assist',
    });
    const above = await send(admin, 'PUT', dial, { autonomy: 'autonomous' }, 'dial-2');
    expect(above.status).toBe(409);
    expect(codeOf(above)).toBe('autonomy_above_organisation');

    // The next task starts under the maximum: Assist's scoping-only dial is what it freezes.
    await pipeline.publish([ticketMatched(pipeline, 'ACME-2')]);
    await waitForState(pipeline, 'ACME-2', 'waiting_approval');
    const second = await taskOf(pipeline, 'ACME-2');
    expect(second?.pipeline_dial).toMatchObject({
      level: 'assist',
      business_review: false,
      stop_after_stage: 'architecture',
    });
    // …and the running task's frozen dial did not move.
    expect((await taskOf(pipeline, 'ACME-1'))?.pipeline_dial).toEqual(first?.pipeline_dial);

    // One case each way, through to the end: ACME-1 finishes on Supervised (business review ran),
    // ACME-2 parks after architecture on Assist (no implementation ran).
    await approvePlan(pipeline, admin, first?.id as string, 'approve-1');
    await waitForState(pipeline, 'ACME-1', 'ready_for_merge');
    expect(await stagesRun(pipeline, first?.id as string)).toContain('business_review');

    await approvePlan(pipeline, admin, second?.id as string, 'approve-2');
    await waitForState(pipeline, 'ACME-2', 'needs_human');
    expect(await stagesRun(pipeline, second?.id as string)).not.toContain('implementation');
  }, 300_000);
});
