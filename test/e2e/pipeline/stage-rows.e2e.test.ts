/**
 * WP-55 — a returned stage is served the finding it was sent back to fix, and a gate the pipeline
 * walked through is closed with its verdict. On a whole `apps/server` instance and a real
 * PostgreSQL, because both defects were **between** components that were each green on their own:
 *
 *  - PROGRESS backlog **67**: `applyDecision` wrote a return's reason on the row of the stage the
 *    task *left*, and the stage executor read it off the rows of the stage the task *entered* — a
 *    pair that never names the same stage on any shipped edge. Nothing asserted the channel at any
 *    tier: every test handed `returnFeedback` straight to the assembler. So this file asserts it the
 *    only way that cannot be satisfied by a double — on the **next run's assembled prompt**, read
 *    with `readDataBlocks` exactly as the planner's own tests read one (criteria 1 and 2);
 *  - PROGRESS backlog **95**'s first two items: no gate's `task_stages` row was ever closed. The
 *    **measurement before the fix** (criterion 6) is recorded in PROGRESS under `#### WP-55`, taken
 *    with the first version of the last case below on the unfixed tree: after a passing CI gate the
 *    `ci_gate` and `rebase_gate` rows read `state: entered`, `outcome: null`, `exited_at: null`.
 *    The case now asserts the row **and** what `GET /api/tasks/:id` publishes for it (criteria 4
 *    and 5), both ways: a passed gate is closed, and the stage the task is still at is not.
 */
import type { RunSpec } from '@platform/application';
import { taskDetailResponseSchema } from '@platform/contracts';
import { readDataBlocks } from '@platform/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import {
  GIT_PROJECT,
  inboundEvent,
  type PipelineE2E,
  type ScenarioSpec,
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

const signIn = async (baseUrl: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

/** The body of every `return_feedback` data block in a prompt — the block the role prompt reads. */
const feedbackIn = (spec: RunSpec | undefined): readonly string[] =>
  readDataBlocks(spec?.userPrompt ?? '')
    .blocks.filter((block) => block.kind === 'return_feedback')
    .map((block) => block.body);

interface StageRow extends Record<string, unknown> {
  stage: string;
  attempt: number;
  state: string;
  outcome: string | null;
  returned_to: string | null;
  return_reason: string | null;
  exited_at: Date | null;
}

const stageRows = (pipeline: PipelineE2E): Promise<readonly StageRow[]> =>
  pipeline.query<StageRow>(
    `select stage, attempt, state, outcome, returned_to, return_reason, exited_at
       from task_stages order by entered_at`,
  );

describe('the return channel, on the next run’s prompt (WP-55, backlog 67)', () => {
  it('serves each re-run the finding that sent it back, and never an earlier loop’s', async () => {
    /**
     * Two loops into `implementation`, with different sentences:
     *  1. code review asks for changes → the second implementation run is sent back with the
     *     **review's own words** (`[summary] The footer rounds twice.`), not the interpreter's literal
     *     `requested changes` (WP-55 review round 1: the agent half of backlog 159);
     *  2. that run's push is red → `ci_gate` returns with *"pipeline p-N failed: test:unit"*, and
     *     the third implementation run must be handed **that**, not loop 1's review finding.
     * The third run turns CI green, code review approves its second round, and the task reaches
     * the human merge.
     */
    let pipeline: PipelineE2E | undefined;
    const ci = (world: SeededWorld, status: 'success' | 'failed') =>
      pipeline?.git.setPipeline({
        project: GIT_PROJECT,
        headSha: world.mr.headSha,
        status,
        jobs: [
          status === 'failed'
            ? { name: 'test:unit', status: 'failed', log: 'FAIL src/totals.test.ts' }
            : { name: 'test:unit', status: 'success' },
        ],
      });
    const scenarioFor = (spec: RunSpec, world: SeededWorld): ScenarioSpec | undefined => {
      if (spec.stage === 'implementation' && spec.attempt === 2) {
        ci(world, 'failed');
      }
      if (spec.stage === 'implementation' && spec.attempt === 3) {
        ci(world, 'success');
      }
      if (spec.stage === 'code_review' && spec.attempt === 1) {
        return {
          structuredOutput: {
            verdict: 'request_changes',
            findings: [],
            summary: 'The footer rounds twice.',
            protected_path_changes_confirmed: [],
          },
        };
      }
      return undefined;
    };
    pipeline = await startPipeline({
      scenarios: featureScenarios,
      scenarioFor,
      label: 'wp55-return-channel',
      tickets: TICKETS,
    });
    harness = pipeline;
    const client = await signIn(pipeline.instance.baseUrl);

    await pipeline.publish([ticketMatched(pipeline)]);
    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );

    const implementation = pipeline.specs.filter((spec) => spec.stage === 'implementation');
    expect(implementation.map((spec) => spec.attempt)).toEqual([1, 2, 3]);
    const [first, second, third] = implementation;

    // The first attempt was entered forward: there is no feedback block at all.
    expect(feedbackIn(first)).toEqual([]);
    // (1) The reviewer's own sentence, inside the data block, in the run it sent back. Before WP-55
    // this list was empty (the reader looked at `implementation`'s own rows), and after round 1 of
    // its review it was `['requested changes']`.
    expect(feedbackIn(second)).toEqual(['[summary] The footer rounds twice.']);
    // (2) The second loop's sentence — the CI gate's — and not the first loop's resurrected.
    expect(feedbackIn(third)).toHaveLength(1);
    expect(feedbackIn(third)[0]).toMatch(/^pipeline p-\d+ failed: test:unit$/);
    expect(feedbackIn(third).join('\n')).not.toContain('footer');

    // The rows say where each return went, on the attempt that produced it.
    const returns = (await stageRows(pipeline)).filter((row) => row.state === 'returned');
    expect(returns.map((row) => [row.stage, row.attempt, row.returned_to])).toEqual([
      ['code_review', 1, 'implementation'],
      ['ci_gate', 2, 'implementation'],
    ]);

    // (3) A returned attempt publishes `returned` on the task screen, through the real route.
    const detail = await client.json(`/api/tasks/${waiting.id}`, { method: 'GET' });
    expect(detail.status).toBe(200);
    const published = taskDetailResponseSchema.parse(detail.body).stages;
    const at = (stage: string, attempt: number) =>
      published.find((row) => row.stage === stage && row.attempt === attempt);
    expect(at('code_review', 1)).toMatchObject({ state: 'returned', outcome: 'returned' });
    expect(at('ci_gate', 2)).toMatchObject({ state: 'returned', outcome: 'returned' });
    expect(at('code_review', 2)).toMatchObject({ state: 'completed', outcome: 'approve' });
    expect(at('ci_gate', 1)).toMatchObject({ state: 'completed', outcome: 'pass' });
  });
});

describe('a gate the pipeline walked through (WP-55, backlog 95 items 1 and 2)', () => {
  it('is closed with its verdict and published as completed; the stage the task is at is not', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'wp55-gate-rows',
      tickets: TICKETS,
    });
    harness = pipeline;
    const client = await signIn(pipeline.instance.baseUrl);
    await pipeline.publish([ticketMatched(pipeline)]);
    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );

    const rows = await stageRows(pipeline);
    for (const gate of ['ci_gate', 'rebase_gate']) {
      const row = rows.find((candidate) => candidate.stage === gate);
      // (4) A passed gate's row has an outcome and an exit. The measurement before the fix read
      // `entered` / null / null for both.
      expect(row, gate).toMatchObject({ state: 'completed', outcome: 'pass', returned_to: null });
      expect(row?.exited_at, gate).toBeInstanceOf(Date);
    }
    // The other direction: the stage the task is still at has neither.
    expect(rows.find((row) => row.stage === 'ready_for_merge')).toMatchObject({
      state: 'running',
      outcome: null,
      exited_at: null,
    });

    // (5) What the task screen is told — through the real route, parsed with the published schema.
    const detail = await client.json(`/api/tasks/${waiting.id}`, { method: 'GET' });
    expect(detail.status).toBe(200);
    const published = taskDetailResponseSchema.parse(detail.body).stages;
    const stateOf = (stage: string) => published.find((row) => row.stage === stage);
    expect(stateOf('ci_gate')).toMatchObject({ state: 'completed', outcome: 'pass' });
    expect(stateOf('rebase_gate')).toMatchObject({ state: 'completed', outcome: 'pass' });
    expect(stateOf('ready_for_merge')).toMatchObject({ state: 'running', exited_at: null });
    // Nothing the task has left is published as running.
    expect(published.filter((row) => row.state === 'running').map((row) => row.stage)).toEqual([
      'ready_for_merge',
    ]);
  });
});
