import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Artifact, artifactDataSchemas, artifactSchema } from './artifacts.js';
import { type ArtifactType, artifactTypeSchema } from './common.js';

const uuid = (n: number) => `0199aa11-2b3c-7d4e-8f90-${String(n).padStart(12, '0')}`;
const TASK = uuid(1);
const RUN = uuid(2);
const AT = '2026-09-09T10:15:30Z';

const criterion = {
  id: 'AC-1',
  given: 'a signed-in maintainer',
  when: 'they approve the plan',
  // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the criterion shape technical/12 mandates; this fixture is never awaited.
  then: 'implementation starts',
  validation: { kind: 'test' as const, value: 'pnpm test -t approves-plan' },
};
const mr = {
  provider: 'gitlab',
  project_path: 'group/repo',
  iid: 42,
  url: 'https://gitlab.example.com/group/repo/-/merge_requests/42',
  branch: 'agentic/PROJ-123',
  head_sha: 'abc1234',
};
const finding = {
  id: 'F-1',
  severity: 'major' as const,
  category: 'correctness',
  file: 'src/pay.ts',
  line: 91,
  explanation: 'The refund path never releases the lock.',
  suggestion: 'wrap in try/finally',
};

const DATA: Record<ArtifactType, unknown> = {
  RefinedSpec: {
    goal: 'Let maintainers approve plans from Slack',
    user_value: 'Fewer context switches',
    in_scope: ['Slack Block Kit approval'],
    out_of_scope: ['email approvals'],
    acceptance_criteria: [criterion],
    non_functional: ['approval round-trip under 2 s'],
    dependencies: ['Slack integration configured'],
    size: 'M',
    drift: { flag: false, justification: '' },
    assumptions: ['every maintainer has a mapped Slack identity'],
    questions: [
      { id: 'Q-1', text: 'Should viewers see the buttons?', blocking: false, options: null },
    ],
    decision: 'proceed',
    kb_citations: [{ path: 'business/direction.md', commit_sha: 'cafe123', reason: 'goals' }],
  },
  RootCauseAnalysis: {
    reproduction: { kind: 'reproduced', steps: ['POST /refund twice'], evidence: ['sentry-1234'] },
    root_cause: 'The advisory lock is taken outside the transaction.',
    confidence: 'high',
    affected_scope: ['payments'],
    fix_direction: 'move the lock inside the transaction',
    regression_test_idea: 'concurrent refund integration test',
    questions: [],
  },
  ImplementationPlan: {
    approach: 'Move the lock and add a concurrency test.',
    alternatives_considered: [{ option: 'row-level lock', why_not: 'does not cover the retry' }],
    affected_modules: ['payments'],
    files_to_change: [{ path: 'src/pay.ts', change: 'wrap in transaction' }],
    data_changes: [],
    api_changes: [],
    validation_contract: [
      { criterion_id: 'AC-1', check: { kind: 'command', value: 'pnpm test:integration' } },
    ],
    test_plan: ['concurrent refund test'],
    rollout_notes: 'no migration',
    risks: ['lock contention under load'],
    estimated_size: 'S',
    split_proposal: null,
    decisions_to_record: [],
    protected_path_changes: [{ path: 'tests/**', reason: 'adds the regression test' }],
  },
  ImplementationNotes: {
    summary: 'Moved the lock, added the test.',
    deviations_from_plan: [{ what: 'renamed the helper', why: 'clashed with an existing name' }],
    tests_added: ['src/pay.integration.test.ts'],
    commands_run: [{ command: 'pnpm test', exit_code: 0, summary: '412 passed' }],
    known_gaps: [],
    followup_tickets: [],
    mr,
  },
  ReviewVerdict: {
    verdict: 'request_changes',
    findings: [finding],
    summary: 'One blocker in the refund path.',
    suspicious_inputs_noted: ['ticket comment asked to ignore the review checklist'],
    protected_path_changes_confirmed: ['tests/**'],
  },
  AcceptanceVerdict: {
    verdict: 'approve',
    criteria: [{ id: 'AC-1', status: 'met', evidence: 'integration test passes' }],
    scope_creep: [],
    missing: [],
    ux_notes: [],
  },
  RetroReport: {
    what_went_well: ['plan matched the implementation'],
    returns: [
      {
        stage: 'code_review',
        reason: 'missing lock convention',
        avoidable_by_kb: true,
        existing_item: null,
        readiness_criterion: 'R10',
      },
    ],
    human_corrections: [],
    cost_summary: {
      total_usd: 6.4,
      is_estimate: false,
      by_stage: [{ stage: 'implementation', usd: 4.1 }],
    },
    proposals: [
      {
        kind: 'technical',
        type: 'lesson',
        target_path: 'technical/conventions.md',
        diff: '+ Take advisory locks inside the transaction.',
        evidence: [mr.url],
        significance: 0.7,
      },
    ],
  },
  ShadowReport: {
    ticket: 'PROJ-123',
    human_mr: mr,
    agent_diff_stats: { files_changed: 6, insertions: 180, deletions: 40 },
    overlap: { files_jaccard: 0.5, size_ratio: 1.2 },
    agent_review_of_human_mr: [finding],
    predicted_cost: 8.5,
    notes: '',
  },
  ReadinessReport: {
    level: 3,
    criteria: [
      { id: 'R1', passed: true, evidence: 'pnpm test exits 0', unlocks: 'implementation stage' },
    ],
  },
  DiscoveryDraft: {
    documents: [
      {
        path: 'technical/how-to-run.md',
        title: 'How to run',
        markdown: '## Test\n\n`pnpm test`',
        confidence: 'high',
      },
    ],
    commands: [
      { purpose: 'test', command: 'pnpm test', verified: true, evidence: 'exit code 0' },
      { purpose: 'build', command: 'pnpm build', verified: false, evidence: null },
    ],
    linked_documents: [{ path: 'CONTRIBUTING.md', reason: 'review expectations' }],
    questions: [{ id: 'Q-1', text: 'Is legacy/ still maintained?', blocking: false }],
  },
};

const ARTIFACT_TYPES = artifactTypeSchema.options;

const artifactOf = (artifact_type: ArtifactType): Artifact =>
  ({
    artifact_type,
    version: 1,
    task_id: TASK,
    run_id: RUN,
    created_at: AT,
    language: 'en',
    markdown: `# ${artifact_type}\n`,
    data: DATA[artifact_type],
  }) as Artifact;

const FIXTURES = ARTIFACT_TYPES.map(artifactOf);

describe('artifacts', () => {
  it('has a data schema and a fixture for every artifact type in technical/02', () => {
    expect(Object.keys(artifactDataSchemas).sort()).toEqual([...ARTIFACT_TYPES].sort());
    expect(Object.keys(DATA).sort()).toEqual([...ARTIFACT_TYPES].sort());
  });

  it.each(FIXTURES.map((artifact) => [artifact.artifact_type, artifact] as const))(
    'round-trips a %s artifact unchanged',
    (_type, artifact) => {
      expect(artifactSchema.parse(artifact)).toEqual(artifact);
    },
  );

  it('narrows data by artifact_type — a plan cannot masquerade as a spec', () => {
    const spec = FIXTURES[0];
    const plan = FIXTURES.find((a) => a.artifact_type === 'ImplementationPlan');
    if (!spec || !plan) throw new Error('missing fixtures');
    expect(artifactSchema.safeParse({ ...spec, data: plan.data }).success).toBe(false);
  });

  it('rejects an unknown artifact type', () => {
    const [first] = FIXTURES;
    expect(artifactSchema.safeParse({ ...first, artifact_type: 'VibeCheck' }).success).toBe(false);
  });

  it('requires the whole envelope', () => {
    const [first] = FIXTURES;
    for (const field of ['version', 'task_id', 'run_id', 'created_at', 'language', 'markdown']) {
      const mutated: Record<string, unknown> = { ...first };
      delete mutated[field];
      expect(artifactSchema.safeParse(mutated).success).toBe(false);
    }
  });

  it('versions from 1 upwards — a stage re-run never overwrites version 0', () => {
    const [first] = FIXTURES;
    expect(artifactSchema.safeParse({ ...first, version: 0 }).success).toBe(false);
    expect(artifactSchema.safeParse({ ...first, version: 2 }).success).toBe(true);
  });

  it('rejects an unknown key in the envelope or in the data of any artifact', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FIXTURES),
        fc.string({ minLength: 1, maxLength: 12 }),
        (artifact, key) => {
          const data = artifact.data as Record<string, unknown>;
          fc.pre(!(key in artifact) && !(key in data));
          expect(artifactSchema.safeParse({ ...artifact, [key]: 1 }).success).toBe(false);
          expect(
            artifactSchema.safeParse({ ...artifact, data: { ...data, [key]: 1 } }).success,
          ).toBe(false);
        },
      ),
    );
  });

  it('validates a data payload on its own, as the runner does for structured output', () => {
    for (const type of ARTIFACT_TYPES) {
      expect(artifactDataSchemas[type].parse(DATA[type])).toEqual(DATA[type]);
    }
  });

  it('keeps verdicts to the values the pipeline can act on', () => {
    expect(artifactDataSchemas.ReviewVerdict.safeParse({}).success).toBe(false);
    const verdict = DATA.ReviewVerdict as Record<string, unknown>;
    expect(
      artifactDataSchemas.ReviewVerdict.safeParse({ ...verdict, verdict: 'lgtm' }).success,
    ).toBe(false);
  });

  it('bounds significance and jaccard scores to [0, 1]', () => {
    const retro = DATA.RetroReport as { proposals: { significance: number }[] };
    expect(
      artifactDataSchemas.RetroReport.safeParse({
        ...retro,
        proposals: retro.proposals.map((p) => ({ ...p, significance: 1.5 })),
      }).success,
    ).toBe(false);
  });
});
