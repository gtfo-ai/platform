/**
 * What the flow canvas says about each stage (S-23.5): a template's configuration, and one task's
 * progress — node states from the task's stage rows and runs, the current stage's activity, the
 * loop pills, which edge is live — and the card's words built from them.
 */
import type { RunRecord, TaskDetailResponse } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { FEATURE_GRAPH } from './graph.test-fixture.js';
import { type FlowGraph, loopPill, taskFlow, templateFlow } from './model.js';
import {
  attemptLabel,
  cardBody,
  doneFacts,
  modelChip,
  stageCardName,
  statusWord,
} from './stage-card.js';

const NOW = Date.parse('2026-11-05T10:10:00.000Z');

const run = (over: Partial<RunRecord>): RunRecord =>
  ({
    id: '00000000-0000-4000-8000-0000000000c1',
    task_id: 't',
    project_id: 'p',
    stage: 'implementation',
    role: 'developer',
    mode: 'normal',
    attempt: 1,
    model: 'claude-opus-5',
    effort: 'high',
    status: 'running',
    terminal_reason: null,
    started_at: '2026-11-05T10:00:00.000Z',
    ended_at: null,
    cost: { usd: 1.5, is_estimate: false, price_list_id: null },
    ...over,
  }) as RunRecord;

const row = (
  stage: string,
  attempt: number,
  state: TaskDetailResponse['stages'][number]['state'],
  minutes = 0,
): TaskDetailResponse['stages'][number] => ({
  stage,
  attempt,
  state,
  entered_at: '2026-11-05T09:00:00.000Z',
  exited_at:
    state === 'running' || state === 'pending'
      ? null
      : new Date(Date.parse('2026-11-05T09:00:00.000Z') + minutes * 60_000).toISOString(),
  outcome: null,
});

const detail = (over: {
  current: string | null;
  state?: TaskDetailResponse['task']['state'];
  stages: TaskDetailResponse['stages'];
  runs: RunRecord[];
  counters?: Record<string, number>;
  questions?: TaskDetailResponse['questions'];
}) => ({
  task: {
    current_stage: over.current,
    state: over.state ?? 'active',
    iteration_counters: over.counters ?? {},
  } as unknown as TaskDetailResponse['task'],
  stages: over.stages,
  runs: over.runs,
  questions: over.questions ?? [],
  approvals: [],
});

const nodeOf = (graph: FlowGraph, id: string) => {
  const node = graph.nodes.find((item) => item.id === id);
  if (node === undefined) {
    throw new Error(`no node ${id}`);
  }
  return node;
};

describe('a template (the Pipeline tab)', () => {
  const graph = templateFlow(FEATURE_GRAPH);

  it('has no progress, marks a disabled stage, and says each loop’s ceiling', () => {
    expect(nodeOf(graph, 'implementation').state).toBeNull();
    expect(nodeOf(graph, 'qa').state).toBe('disabled');
    expect(
      graph.edges.find((edge) => edge.from === 'code_review' && edge.loop !== null)?.pill,
    ).toBe('Review rounds: up to 3');
    expect(graph.edges.every((edge) => !edge.live && edge.loopUsed === null)).toBe(true);
  });

  it('names a card by what it shows', () => {
    expect(stageCardName(nodeOf(graph, 'implementation'))).toBe(
      'Implementation, Developer, claude-test · high',
    );
    // A gate card says what it waits for: no role, and never an empty card.
    expect(stageCardName(nodeOf(graph, 'ci_gate'))).toBe('CI, Waits for the CI pipeline');
    expect(stageCardName(nodeOf(graph, 'rebase_gate'))).toBe(
      'Up-to-date check, Checks the branch is up to date with the default branch',
    );
    expect(cardBody({ id: 'security_scan', kind: 'gate', role: null })).toBe(
      'Waits for an event to settle it',
    );
    expect(cardBody({ id: 'constructor', kind: 'gate', role: null })).toBe(
      'Waits for an event to settle it',
    );
    expect(stageCardName(nodeOf(graph, 'intake'))).toBe('Intake, Automatic step');
    expect(stageCardName(nodeOf(graph, 'qa'))).toBe(
      'QA, Acceptance tester, Disabled, claude-test · high',
    );
  });
});

describe('loop pills', () => {
  it('say the ceiling for a template and what is spent for a task', () => {
    expect(loopPill(null, 3, null)).toBeNull();
    expect(loopPill('code_review', 3, null)).toBe('Review rounds: up to 3');
    expect(loopPill('code_review', null, null)).toBe('Review rounds');
    expect(loopPill('code_review', 3, 1)).toBe('Review rounds: 1 of 3 used');
    expect(loopPill('code_review', null, 2)).toBe('Review rounds: 2 used');
  });
});

describe('a task (the task page)', () => {
  const live = run({ id: 'live', stage: 'implementation', attempt: 2 });
  const input = detail({
    current: 'implementation',
    counters: { code_review: 1 },
    stages: [
      row('intake', 1, 'completed', 0),
      row('refinement', 1, 'completed', 12),
      row('architecture', 1, 'completed', 30),
      row('implementation', 1, 'completed', 40),
      row('ci_gate', 1, 'completed', 3),
      row('code_review', 1, 'returned', 9),
      row('implementation', 2, 'running'),
    ],
    runs: [
      run({ id: 'r1', stage: 'refinement', role: 'product_manager', status: 'completed' }),
      run({ id: 'i1', stage: 'implementation', status: 'completed' }),
      run({ id: 'c1', stage: 'code_review', role: 'reviewer', status: 'completed' }),
      live,
    ],
  });
  const graph = taskFlow({
    graph: FEATURE_GRAPH,
    detail: input,
    latest: { kind: 'tool', tool_name: 'Read', at: '2026-11-05T10:09:30.000Z' },
    now: NOW,
  });

  it('reads each stage’s state from its latest attempt, in PhaseTrack’s vocabulary', () => {
    expect(nodeOf(graph, 'refinement').state).toBe('done');
    expect(nodeOf(graph, 'code_review').state).toBe('returned');
    expect(nodeOf(graph, 'implementation').state).toBe('current');
    expect(nodeOf(graph, 'rebase_gate').state).toBe('upcoming');
    // Never entered and walked over: disabled, not upcoming.
    expect(nodeOf(graph, 'qa').state).toBe('disabled');
    // Declared after the current stage and never entered: still ahead.
    expect(nodeOf(graph, 'conflict_resolution').state).toBe('upcoming');
    // Declared before the current stage, never entered, enabled: stepped over.
    const later = taskFlow({
      graph: FEATURE_GRAPH,
      detail: detail({
        current: 'code_review',
        stages: [row('implementation', 1, 'completed', 2), row('code_review', 1, 'running')],
        runs: [],
      }),
      latest: null,
      now: NOW,
    });
    expect(nodeOf(later, 'conflict_resolution').state).toBe('skipped');
  });

  it('gives the current stage its attempt, its run and what the agent is doing now', () => {
    const current = nodeOf(graph, 'implementation');
    expect(current.attempt).toBe(2);
    expect(current.run?.id).toBe('live');
    expect(current.activity).toEqual({ activity: 'working', detail: 'Reading files' });
    expect(statusWord(current)).toBe('Working');
    expect(attemptLabel(current.attempt)).toBe('Attempt 2');
    expect(stageCardName(current)).toBe(
      'Implementation, Developer, Working, Now: Reading files, Attempt 2, claude-test · high',
    );
    // A stage that is not current has no activity of its own.
    expect(nodeOf(graph, 'refinement').activity).toBeNull();
  });

  it('says how long a done stage took and what its latest run cost', () => {
    const refinement = nodeOf(graph, 'refinement');
    expect(refinement.durationMs).toBe(12 * 60_000);
    expect(doneFacts(refinement)).toBe('12m 0s · $1.50');
    // A gate has no run: its duration alone.
    expect(doneFacts(nodeOf(graph, 'ci_gate'))).toBe('3m 0s');
    expect(doneFacts(nodeOf(graph, 'implementation'))).toBeNull();
    // A run nobody measured is "not measured", never a zero.
    const unmeasured = taskFlow({
      graph: FEATURE_GRAPH,
      detail: detail({
        current: 'architecture',
        stages: [row('refinement', 1, 'completed', 1), row('architecture', 1, 'running')],
        runs: [run({ id: 'r', stage: 'refinement', status: 'failed', cost: null })],
      }),
      latest: null,
      now: NOW,
    });
    expect(doneFacts(nodeOf(unmeasured, 'refinement'))).toBe('1m 0s · not measured');
  });

  it('animates only the way in the task took, and counts what each loop has spent', () => {
    const liveEdges = graph.edges.filter((edge) => edge.live).map((edge) => edge.id);
    // architecture → implementation and the CI gate's failure both enter implementation; only the
    // forward edge from a stage the task entered is the live one (a return is not "the way in").
    expect(liveEdges).toHaveLength(1);
    expect(liveEdges[0]).toMatch(/^architecture->implementation:/);
    // A stage that ended has no live edge into it.
    const ended = taskFlow({
      graph: FEATURE_GRAPH,
      detail: detail({
        current: 'implementation',
        stages: [row('architecture', 1, 'completed', 1), row('implementation', 1, 'running')],
        runs: [run({ id: 'e', status: 'completed' })],
      }),
      latest: null,
      now: NOW,
    });
    expect(ended.edges.some((edge) => edge.live)).toBe(false);
    const review = graph.edges.find((edge) => edge.from === 'code_review' && edge.loop !== null);
    expect(review?.pill).toBe('Review rounds: 1 of 3 used');
    const ci = graph.edges.find((edge) => edge.from === 'ci_gate' && edge.loop !== null);
    expect(ci?.pill).toBe('CI fixes: 0 of 3 used');
    expect(
      graph.edges.find((edge) => edge.from === 'intake' && edge.to === 'refinement')?.traversed,
    ).toBe(true);
    expect(
      graph.edges.find((edge) => edge.from === 'rebase_gate' && edge.to === 'ready_for_merge')
        ?.traversed,
    ).toBe(false);
  });

  it('puts what needs a person first on the current stage', () => {
    const waiting = taskFlow({
      graph: FEATURE_GRAPH,
      detail: detail({
        current: 'implementation',
        stages: [row('implementation', 1, 'running')],
        runs: [run({ id: 'w' })],
        questions: [{ status: 'open' } as TaskDetailResponse['questions'][number]],
      }),
      latest: { kind: 'tool', tool_name: 'Read', at: '2026-11-05T10:09:30.000Z' },
      now: NOW,
    });
    expect(statusWord(nodeOf(waiting, 'implementation'))).toBe('Needs you');
    // No source of a way in was entered (the read kept no row for it): every forward way in is
    // live, and still no return.
    expect(waiting.edges.filter((edge) => edge.live).map((edge) => edge.from)).toEqual([
      'architecture',
    ]);
  });

  it('marks a current stage whose latest attempt failed as failed, with the run’s ending', () => {
    const failed = taskFlow({
      graph: FEATURE_GRAPH,
      detail: detail({
        current: 'implementation',
        state: 'needs_human',
        stages: [row('implementation', 1, 'failed', 5)],
        runs: [run({ id: 'f', status: 'failed', ended_at: '2026-11-05T10:05:00.000Z' })],
      }),
      latest: null,
      now: NOW,
    });
    const node = nodeOf(failed, 'implementation');
    expect(node.state).toBe('failed');
    expect(statusWord(node)).toBe('Failed');
    expect(modelChip({ model: null, effort: null })).toBeNull();
    expect(modelChip({ model: 'm', effort: null })).toBe('m');
  });
});
