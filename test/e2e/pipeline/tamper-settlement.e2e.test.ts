/**
 * **A declared protected change is confirmed in the rebase settlement** — WP-102, Q109 answered (b).
 *
 * Every shipped template runs `ci_gate` before `code_review`, so the CI gate's tamper check (BD-024
 * §2, WP-81) cannot read the Code review's confirmation of a declared change on its first pass. It
 * passes such a change **provisionally** and records the excused paths on the task
 * (`tasks.ci_excused_paths`, migration 0065); the rebase gate's settlement compares them with the
 * latest Review Verdict in its own transaction. Until WP-102 the provisional pass recorded no
 * `ci_head_sha` instead, so the rebase settlement sent the task back through `ci_gate` — and the
 * template's fall-through after `ci_gate` ran `code_review` and `business_review` a second time.
 *
 * These cases count runs per stage off `pipeline.specs` (every run the production planner built),
 * so an extra review round is a number, not an impression.
 */
import type { RunSpec } from '@platform/application';
import { afterEach, describe, expect, it } from 'vitest';
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

/** The existing test the change modifies — under the default `**` + `/*.test.*` protected path. */
const LEGACY_TEST = 'src/legacy.test.ts';

const PLAN_DECLARING = (world: SeededWorld) => ({
  ...(featureScenarios(world).architecture.structuredOutput as Record<string, unknown>),
  protected_path_changes: [{ path: LEGACY_TEST, reason: 'it pins the rounding this change fixes' }],
});

const REVIEW = (confirmed: readonly string[]) => ({
  verdict: 'approve',
  findings: [],
  summary: 'Matches the plan; the declared test change is the rounding the ticket asks for.',
  protected_path_changes_confirmed: confirmed,
});

/** How many runs the planner built per stage — every attempt, in order. */
const runsPerStage = (specs: readonly RunSpec[]): Readonly<Record<string, number>> =>
  specs.reduce<Record<string, number>>((counts, spec) => {
    const stage = spec.stage ?? '(none)';
    counts[stage] = (counts[stage] ?? 0) + 1;
    return counts;
  }, {});

interface StageRow extends Record<string, unknown> {
  stage: string;
  attempt: number;
  state: string;
  outcome: string | null;
  returned_to: string | null;
  return_reason: string | null;
}

const gateRows = (pipeline: PipelineE2E): Promise<readonly StageRow[]> =>
  pipeline.query<StageRow>(
    `select stage, attempt, state, outcome, returned_to, return_reason
       from task_stages where stage in ('ci_gate', 'rebase_gate') order by entered_at`,
  );

/** The merge request modifies an existing test beside an ordinary file. */
const seedDiff = (pipeline: PipelineE2E): void => {
  pipeline.git.setDiff({
    project: GIT_PROJECT,
    iid: pipeline.world.mr.iid,
    files: [{ path: 'src/totals.ts' }, { path: LEGACY_TEST }],
  });
};

interface TaskCounters extends Record<string, unknown> {
  iteration_counters: Record<string, number>;
  ci_head_sha: string | null;
  ci_excused_paths: string[];
}

const taskColumns = async (pipeline: PipelineE2E): Promise<TaskCounters> => {
  const [row] = await pipeline.query<TaskCounters>(
    'select iteration_counters, ci_head_sha, ci_excused_paths from tasks',
  );
  if (row === undefined) {
    throw new Error('the task under test is not in the table');
  }
  return row;
};

describe('a declared change to an existing test (WP-102, Q109 (b))', () => {
  /**
   * Criteria (1) and (2). **Measured before the change** (the same world, WP-81's build):
   * `{ refinement: 1, architecture: 1, implementation: 1, code_review: 2, business_review: 2 }`, and
   * the gate rows `ci_gate#1 protected_paths_awaiting_review`, `rebase_gate#1 left`, `ci_gate#2
   * pass`, `rebase_gate#2 pass` — one extra round of each review stage, as Q109 priced it.
   */
  it('reaches Ready with one run of each review stage when the code review confirms it', async () => {
    const pipeline = await startPipeline({
      scenarios: (world) => ({
        ...featureScenarios(world),
        architecture: { structuredOutput: PLAN_DECLARING(world) },
        code_review: { structuredOutput: REVIEW([LEGACY_TEST]) },
      }),
      label: 'wp102-confirmed',
      tickets: TICKETS,
    });
    harness = pipeline;
    seedDiff(pipeline);

    await pipeline.publish([ticketMatched(pipeline)]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

    expect(runsPerStage(pipeline.specs)).toEqual({
      refinement: 1,
      architecture: 1,
      implementation: 1,
      code_review: 1,
      business_review: 1,
    });
    expect(
      (await gateRows(pipeline)).map((row) => [row.stage, row.attempt, row.state, row.outcome]),
    ).toEqual([
      ['ci_gate', 1, 'completed', 'protected_paths_awaiting_review'],
      ['rebase_gate', 1, 'completed', 'protected_paths_confirmed'],
    ]);
    const task = await taskColumns(pipeline);
    expect(task.ci_head_sha).toBe(pipeline.world.mr.headSha);
    expect(task.ci_excused_paths).toEqual([LEGACY_TEST]);
    expect(task.iteration_counters.rebase_rechecks ?? 0).toBe(0);
    expect(task.iteration_counters.ci_fix ?? 0).toBe(0);
  });

  /** Criterion (3): the rebase settlement's return, on `ci_fix`, and the round after it. */
  it('returns a declared change the code review did not confirm to implementation, spending one ci_fix', async () => {
    const scenarioFor = (spec: RunSpec): ScenarioSpec | undefined =>
      spec.stage === 'code_review'
        ? { structuredOutput: REVIEW(spec.attempt === 1 ? [] : [LEGACY_TEST]) }
        : undefined;
    const pipeline = await startPipeline({
      scenarios: (world) => ({
        ...featureScenarios(world),
        architecture: { structuredOutput: PLAN_DECLARING(world) },
      }),
      scenarioFor,
      label: 'wp102-unconfirmed',
      tickets: TICKETS,
    });
    harness = pipeline;
    seedDiff(pipeline);

    await pipeline.publish([ticketMatched(pipeline)]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

    const rows = await gateRows(pipeline);
    expect(rows.map((row) => [row.stage, row.attempt, row.state, row.outcome])).toEqual([
      ['ci_gate', 1, 'completed', 'protected_paths_awaiting_review'],
      ['rebase_gate', 1, 'returned', 'protected_paths_changed'],
      ['ci_gate', 2, 'completed', 'protected_paths_awaiting_review'],
      ['rebase_gate', 2, 'completed', 'protected_paths_confirmed'],
    ]);
    const returned = rows[1];
    expect(returned?.returned_to).toBe('implementation');
    expect(returned?.return_reason).toContain(
      `the Code review did not confirm in protected_path_changes_confirmed: ${LEGACY_TEST}`,
    );
    const task = await taskColumns(pipeline);
    expect(task.iteration_counters.ci_fix).toBe(1);
    expect(task.iteration_counters.rebase_rechecks ?? 0).toBe(0);
    // One round for the return, and no other: each stage after implementation ran once per round.
    expect(runsPerStage(pipeline.specs)).toMatchObject({
      implementation: 2,
      code_review: 2,
      business_review: 2,
    });
  });

  /** Criterion (4): the first half is still the CI gate's, before any review runs. */
  it('returns an undeclared change to an existing test from ci_gate on the first pass', async () => {
    const pipeline = await startPipeline({
      scenarios: (world) => ({
        ...featureScenarios(world),
        // A review that "confirms" the undeclared path is never reached, and would not count.
        code_review: { structuredOutput: REVIEW([LEGACY_TEST]) },
      }),
      label: 'wp102-undeclared',
      tickets: TICKETS,
    });
    harness = pipeline;
    seedDiff(pipeline);

    await pipeline.publish([ticketMatched(pipeline)]);
    await pipeline.settle('needs_human', (task) => task.state === 'needs_human');

    const rows = await gateRows(pipeline);
    expect(rows[0]).toMatchObject({
      stage: 'ci_gate',
      attempt: 1,
      state: 'returned',
      outcome: 'protected_paths_changed',
      returned_to: 'implementation',
    });
    expect(rows[0]?.return_reason).toContain(
      `does not declare in protected_path_changes: ${LEGACY_TEST}`,
    );
    expect(rows.every((row) => row.stage === 'ci_gate')).toBe(true);
    expect(runsPerStage(pipeline.specs).code_review ?? 0).toBe(0);
    expect((await taskColumns(pipeline)).iteration_counters.ci_fix).toBe(3);
  });
});
