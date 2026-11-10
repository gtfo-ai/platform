/**
 * **Low-risk plans go ahead, the rest wait for a person** — S-28.8 (the M28 ruling amending
 * BD-006), on a real `apps/server` instance with the fake model.
 *
 * The project switches on `policies.plan_approval_risk` up to size L (and turns probation off), and
 * the Architect writes an L plan, which the dial asks about (above_size at L). Two walks of the same feature ticket:
 *
 * - the Architect's plan says *low risk, high confidence*, touches one ordinary file: the task goes
 *   on to `ready_for_merge` with **no** `task.approval.requested`, and its plan approval is a row
 *   that is `approved`, `auto_decided`, with no decider and the one `low_risk_auto` reason;
 * - the same plan also changes a migration: the platform's fact makes it wait, whatever the plan
 *   says about itself — `waiting_approval`, a `pending` row whose reason names the migration as
 *   found by the platform.
 */
import { afterEach, describe, expect, it } from 'vitest';
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

const SELF_ASSESSMENT = {
  confidence: 'high',
  risk_level: 'low',
  risk_factors: [],
  reasons: ['one renderer function, no data or API change'],
  open_questions: [],
};

/** `featureScenarios` with a self-assessed plan, and optionally a migration among its files. */
const assessedScenarios = (withMigration: boolean) => (world: SeededWorld) => {
  const base = featureScenarios(world);
  const plan = base.architecture.structuredOutput as Record<string, unknown>;
  return {
    ...base,
    architecture: {
      structuredOutput: {
        ...plan,
        estimated_size: 'L',
        ...(withMigration
          ? {
              files_to_change: [
                ...(plan.files_to_change as unknown[]),
                { path: 'db/migrations/0002_totals.sql', change: 'add a cached total' },
              ],
            }
          : {}),
        self_assessment: SELF_ASSESSMENT,
      },
    },
  };
};

// The dial asks about an L plan (above_size at L); the rule may waive that ask up to L.
const CONFIG = {
  version: 1,
  policies: { probation_tasks: 0, plan_approval_risk: { enabled: true, max_size: 'L' } },
};

interface ApprovalRow extends Record<string, unknown> {
  readonly status: string;
  readonly auto_decided: boolean;
  readonly decided_by_user_id: string | null;
  readonly reasons: unknown;
}

describe('low-risk plans go ahead, the rest wait for a person (S-28.8)', () => {
  it('lets a low-risk plan go ahead, with an approved row nobody decided', async () => {
    const pipeline = await startPipeline({
      scenarios: assessedScenarios(false),
      label: 'plan-risk-auto',
      tickets: TICKETS,
      agent: 'fake-runner',
      config: CONFIG,
    });
    harness = pipeline;
    await pipeline.publish([ticketMatched(pipeline)]);
    const ready = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );
    const rows = await pipeline.query<ApprovalRow>(
      'select status, auto_decided, decided_by_user_id, reasons from approvals where task_id = $1',
      [ready.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'approved',
      auto_decided: true,
      decided_by_user_id: null,
    });
    expect(rows[0]?.reasons).toEqual([
      { code: 'low_risk_auto', confidence: 'high', risk_level: 'low', size: 'L', files: 1 },
    ]);
    const requested = await pipeline.query<{ count: string }>(
      `select count(*)::text as count from events
        where type = 'task.approval.requested' and payload->>'task_id' = $1`,
      [ready.id],
    );
    expect(requested[0]?.count).toBe('0');
  });

  it('makes a plan with a migration wait, whatever the plan says about itself', async () => {
    const pipeline = await startPipeline({
      scenarios: assessedScenarios(true),
      label: 'plan-risk-ask',
      tickets: TICKETS,
      agent: 'fake-runner',
      config: CONFIG,
    });
    harness = pipeline;
    await pipeline.publish([ticketMatched(pipeline)]);
    const waiting = await pipeline.settle(
      'waiting_approval',
      (task) => task.state === 'waiting_approval',
    );
    const rows = await pipeline.query<ApprovalRow>(
      'select status, auto_decided, decided_by_user_id, reasons from approvals where task_id = $1',
      [waiting.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', auto_decided: false });
    expect(rows[0]?.reasons).toContainEqual({
      code: 'risk_factor',
      factors: ['schema_migration'],
      source: 'platform',
    });
  });
});
