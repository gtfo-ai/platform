/**
 * The dependency gate, driven through the real handler, the real `pipeline.outbound` duty and the
 * real pipeline walk over the in-memory doubles (WP-38, product/04:58).
 *
 * The e2e tier runs the same thing on PostgreSQL inside an `apps/server` instance with a signed
 * ticket delivery and the real `FakeGitProvider`; this tier is where the **branches** live. Two
 * rules shape every case:
 *
 *  - **both directions** (standing rule 42). A detector that fired on every diff would pass every
 *    "it found the package" assertion and would ask a human about every change, so each ending has
 *    a case where it fires and a case where the same walk produces nothing.
 *  - **countable effects, never a return value** (standing rule 79). The assertions are the
 *    `questions` rows, the `task.stage.returned` events, the task's state and the `tasks.dependencies`
 *    record — the things a maintainer would see.
 */
import type {
  DependencyMetadata,
  DomainEvent,
  Id,
  MergeRequestRef,
  PoliciesConfig,
} from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { MAX_DETECTED_DEPENDENCIES } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { DependencyMetadataPort } from '../ports/dependency-metadata.js';
import type { FileDiff, MergeRequest } from '../ports/integrations/git-provider.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';

const PROJECT = '00000000-0000-4000-8000-0000000000d1' as Id;
const IID = 11;
const HEAD = 'd'.repeat(40);

const TICKET = {
  provider: 'fake-jira',
  key: 'ACME-4',
  url: 'https://jira.example.test/browse/ACME-4',
};

const MR_REF: MergeRequestRef = {
  provider: 'fake-git',
  project_path: 'acme/api',
  iid: IID,
  url: `https://git.example.test/acme/api/-/merge_requests/${IID}`,
  branch: 'agentic/acme-4',
  head_sha: HEAD,
};

const mergeRequest = (): MergeRequest =>
  ({
    ref: MR_REF,
    state: 'opened' as const,
    draft: true,
    title: 'Sum the invoice footer',
    description: 'Opened by the developer stage.',
    source_branch: MR_REF.branch,
    target_branch: 'main',
    head_sha: HEAD,
    mergeable: true,
    has_conflicts: false,
    coverage_pct: null,
    labels: [],
    reviewers: [],
    web_url: MR_REF.url,
  }) as MergeRequest;

/** One file of a diff, as a provider sends it: a path and a patch. */
const file = (path: string, ...lines: readonly string[]): FileDiff => ({
  new_path: path,
  old_path: path,
  diff: [`--- a/${path}`, `+++ b/${path}`, '@@ -1,4 +1,5 @@', ...lines].join('\n'),
  new_file: false,
  renamed_file: false,
  deleted_file: false,
  omitted: false,
});

/** The Developer stage adds `lodash` to `package.json` — the diff every "it fired" case reads. */
const ADDS_LODASH = [
  file(
    'package.json',
    '   "dependencies": {',
    '     "react": "^19.0.0",',
    '+    "lodash": "^4.17.21"',
    '   },',
  ),
];

/** The same stage changing code only — the diff every "it did not fire" case reads. */
const TOUCHES_NO_MANIFEST = [file('src/totals.ts', '+export const sum = (a: number) => a;')];

const REFINED_SPEC = {
  goal: 'Show the totals.',
  user_value: 'Finance can read an invoice.',
  in_scope: ['the footer'],
  out_of_scope: [],
  acceptance_criteria: [
    {
      id: 'ac1',
      given: 'an invoice',
      when: 'it renders',
      // biome-ignore lint/suspicious/noThenProperty: the published field name
      then: 'the footer sums the lines',
      validation: { kind: 'test', value: 'totals.test.ts' },
    },
  ],
  non_functional: [],
  dependencies: [],
  size: 'M',
  drift: { flag: false, justification: 'documented' },
  assumptions: [],
  questions: [],
  decision: 'proceed',
  kb_citations: [],
};

const PLAN = {
  approach: 'Sum the model.',
  alternatives_considered: [],
  affected_modules: ['invoices'],
  files_to_change: [{ path: 'src/totals.ts', change: 'sum the model' }],
  data_changes: [],
  api_changes: [],
  validation_contract: [{ criterion_id: 'ac1', check: { kind: 'test', value: 'totals.test.ts' } }],
  test_plan: ['totals.test.ts'],
  rollout_notes: 'no flag',
  risks: [],
  estimated_size: 'M',
  decisions_to_record: [],
  protected_path_changes: [],
};

const NOTES = {
  summary: 'Summed the model.',
  deviations_from_plan: [],
  tests_added: ['totals.test.ts'],
  commands_run: [],
  known_gaps: [],
  followup_tickets: [],
  mr: { url: MR_REF.url, iid: IID, head_sha: HEAD, branch: MR_REF.branch },
};

const REVIEW = {
  verdict: 'approve',
  findings: [],
  summary: 'ok',
  protected_path_changes_confirmed: [],
};

const ACCEPTANCE = {
  verdict: 'approve',
  criteria: [{ id: 'ac1', status: 'met', evidence: 'totals.test.ts' }],
  scope_creep: [],
  missing: [],
  ux_notes: [],
};

const completedRun = (structuredOutput: unknown) =>
  ({ status: 'completed', terminalReason: 'success', structuredOutput }) as const;

let stream = 0;
const nextEventId = (): string => {
  stream += 1;
  return `00000000-0000-4000-9000-${stream.toString(16).padStart(12, '0')}`;
};

const ticketMatched = (): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: nextEventId(),
    stream_type: 'project',
    stream_id: PROJECT,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'system', component: 'test' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ticket.matched',
    payload: {
      project_id: PROJECT,
      ticket: TICKET,
      rule: 'label:agentic',
      priority: 'High',
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;

interface StartOptions {
  readonly policy?: PoliciesConfig['dependency_policy'];
  readonly files?: readonly FileDiff[];
  readonly metadata?: DependencyMetadataPort;
  readonly git?: null;
  readonly secrets?: readonly { readonly name: string; readonly value: string }[];
}

const start = async (options: StartOptions = {}): Promise<PipelineHarness> => {
  const harness = createPipelineHarness({
    projectId: PROJECT,
    settings: {
      config: {
        policies: options.policy === undefined ? {} : { dependency_policy: options.policy },
      },
    },
    runs: {
      refinement: completedRun(REFINED_SPEC),
      architecture: completedRun(PLAN),
      implementation: completedRun(NOTES),
      code_review: completedRun(REVIEW),
      business_review: completedRun(ACCEPTANCE),
    },
    gitRedactor: exactSecretRedactor(options.secrets ?? []),
    ...(options.metadata === undefined ? {} : { dependencyMetadata: options.metadata }),
    ...(options.git === null
      ? { git: null }
      : {
          git: {
            getMergeRequest: async () => mergeRequest(),
            getMergeRequestDiff: async () => options.files ?? ADDS_LODASH,
          },
        }),
  });
  await harness.publish([ticketMatched()]);
  return harness;
};

const taskIdOf = (harness: PipelineHarness): Id => {
  const created = harness.events().find((event) => event.type === 'task.created') as DomainEvent & {
    payload: { task_id: Id };
  };
  return created.payload.task_id;
};

const storedTask = async (harness: PipelineHarness) => {
  const id = taskIdOf(harness);
  return await harness.memory.transaction(async (scope) => harness.store.tasks.load(scope.tx, id));
};

/** Every question the walk opened — the countable effect of the `ask` ending. */
const questionsAsked = (harness: PipelineHarness): readonly { text: string }[] =>
  harness
    .events()
    .filter((event) => event.type === 'task.question.asked')
    .map((event) => (event as { payload: { question: { text: string } } }).payload.question);

const returns = (harness: PipelineHarness): readonly { reason: string }[] =>
  harness
    .events()
    .filter((event) => event.type === 'task.stage.returned')
    .map((event) => (event as { payload: { reason: string } }).payload);

const checkedMetadata = (metadata: Partial<DependencyMetadata>): DependencyMetadataPort => ({
  describe: async () => ({
    status: 'checked',
    license: 'MIT',
    last_published_at: '2026-04-02T11:00:00.000Z',
    deprecated: false,
    source_url: 'https://www.npmjs.com/package/lodash',
    ...metadata,
  }),
});

describe('the dependency gate (product/04:58, WP-38)', () => {
  it('asks exactly one question when the Developer stage adds a package, and names its licence', async () => {
    const harness = await start({ metadata: checkedMetadata({}) });

    const asked = questionsAsked(harness);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.text).toContain('npm:lodash');
    expect(asked[0]?.text).toContain('licence MIT');
    expect(asked[0]?.text).toContain('last release 2026-04-02');

    const stored = await storedTask(harness);
    // The task waits on the **existing** question gate: the same state every blocking question
    // produces, reached through the same aggregate.
    expect(stored?.task.state).toBe('waiting_answers');
    expect(stored?.dependencies?.decision).toBe('ask');
    expect(stored?.dependencies?.question_id).not.toBeNull();
    expect(stored?.dependencies?.added).toEqual([
      expect.objectContaining({
        ecosystem: 'npm',
        name: 'lodash',
        from: 'manifest',
        path: 'package.json',
        policy: 'ask',
        allowlisted: false,
      }),
    ]);
    // The question belongs to the stage that added the package, so answering it resumes *that* run.
    expect(stored?.dependencies?.head_sha).toBe(HEAD);
  });

  it('asks nothing when the same walk produces a diff that touches no manifest', async () => {
    const harness = await start({ files: TOUCHES_NO_MANIFEST });

    expect(questionsAsked(harness)).toHaveLength(0);
    const stored = await storedTask(harness);
    // The gate **did** run: `decision: 'none'` and an empty list is a different fact from `null`,
    // which is the gate never having run at all (standing rule 18).
    expect(stored?.dependencies?.decision).toBe('none');
    expect(stored?.dependencies?.added).toEqual([]);
    expect(stored?.task.state).not.toBe('waiting_answers');
  });

  it('proceeds with no question when the project’s policy is “allow”', async () => {
    const harness = await start({ policy: 'allow' });

    expect(questionsAsked(harness)).toHaveLength(0);
    const stored = await storedTask(harness);
    expect(stored?.dependencies?.decision).toBe('allow');
    expect(stored?.dependencies?.added).toHaveLength(1);
    expect(stored?.task.state).not.toBe('waiting_answers');
  });

  it('proceeds with no question for an allow-listed package under “ask” (product/04:58)', async () => {
    const harness = await start({
      policy: { default: 'ask', allowlist: ['npm:lodash'] },
    });

    expect(questionsAsked(harness)).toHaveLength(0);
    const stored = await storedTask(harness);
    expect(stored?.dependencies?.decision).toBe('allow');
    expect(stored?.dependencies?.added[0]).toMatchObject({ policy: 'allow', allowlisted: true });
  });

  it('asks about a package in an ecosystem the policy singles out, and not about one it allows', async () => {
    const harness = await start({
      policy: { default: 'allow', ecosystems: { npm: 'ask' } },
    });
    expect(questionsAsked(harness)).toHaveLength(1);

    const allowed = await start({
      policy: { default: 'ask', ecosystems: { npm: 'allow' } },
    });
    expect(questionsAsked(allowed)).toHaveLength(0);
  });

  it('returns the task to the stage that added the package when the policy blocks it', async () => {
    const harness = await start({ policy: 'block' });

    const blocked = returns(harness).filter((entry) =>
      entry.reason.includes('dependency policy blocks npm:lodash'),
    );
    // The fake produces the same diff on every implementation run, so the gate blocks each time and
    // the **loop's own bound** ends it: this is the ending `returnToStage` already owns, which is
    // why no counter was invented for it.
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    const stored = await storedTask(harness);
    expect(stored?.dependencies?.decision).toBe('block');
    // A block is not a question: nobody was asked anything.
    expect(questionsAsked(harness)).toHaveLength(0);
    expect(stored?.task.state).toBe('needs_human');
    // **The loop it spends is its own**, not the leaving stage's: this job fires whenever the queue
    // reaches it, and `RETURN_LOOPS['ready_for_merge']` is `human_rounds` — BD-008's *"human MR
    // rounds"*, a bound nobody had spent (standing rule 81, measured on the e2e).
    expect(stored?.task.iterationCounters.dependency_policy).toBe(
      stored?.task.limits.dependency_policy,
    );
    expect(stored?.task.iterationCounters.human_rounds ?? 0).toBe(0);
    expect(stored?.task.iterationCounters.ci_fix ?? 0).toBe(0);
  });

  it('names a manifest it cannot read rather than reporting that nothing was added', async () => {
    const harness = await start({
      files: [file('pom.xml', '+    <artifactId>guava</artifactId>')],
    });

    expect(questionsAsked(harness)).toHaveLength(0);
    const stored = await storedTask(harness);
    expect(stored?.dependencies?.decision).toBe('none');
    expect(stored?.dependencies?.unread).toEqual([{ ecosystem: 'maven', path: 'pom.xml' }]);
  });

  it('asks the question with no licence when no registry host is declared — the shipped default', async () => {
    const harness = await start({});

    const asked = questionsAsked(harness);
    expect(asked[0]?.text).toContain('licence not checked');
    const stored = await storedTask(harness);
    expect(stored?.dependencies?.added[0]?.metadata).toEqual({
      status: 'not_checked',
      license: null,
      last_published_at: null,
      deprecated: null,
      source_url: null,
    });
  });

  it('asks the question anyway when the registry cannot answer (Q84: the gate never depends on it)', async () => {
    const harness = await start({
      metadata: {
        describe: async () => {
          throw new Error('the registry is down');
        },
      },
    });

    expect(questionsAsked(harness)).toHaveLength(1);
    const stored = await storedTask(harness);
    expect(stored?.dependencies?.added[0]?.metadata.status).toBe('unavailable');
    expect(stored?.task.state).toBe('waiting_answers');
  });

  it('asks and blocks anyway when the lookup answers metadata the record cannot hold', async () => {
    /**
     * Review round 2's first major, from the gate's side: **the decision is the platform's, so a
     * package it cannot describe is still a package it asks about or blocks** (standing rules 16,
     * 18, 20).
     *
     * The port here breaks its contract the way the shipped npm client did — a licence longer than
     * `dependencyMetadataSchema.license`'s 200 — which made `taskDependenciesSchema.parse` throw
     * inside the write: no record, no question, no `block`, and a dead outbound job. Both endings
     * are asserted, because the one that fails open costs a merge and the other costs a question.
     */
    const unstorable: DependencyMetadataPort = {
      describe: async () => ({
        status: 'checked',
        license: 'A'.repeat(300),
        last_published_at: null,
        deprecated: null,
        source_url: null,
      }),
    };

    const asked = await start({ metadata: unstorable });
    expect(questionsAsked(asked)).toHaveLength(1);
    const waiting = await storedTask(asked);
    expect(waiting?.task.state).toBe('waiting_answers');
    // The package is on the panel with the honest non-answer, not absent and not truncated.
    expect(waiting?.dependencies?.added[0]?.metadata).toEqual({
      status: 'unavailable',
      license: null,
      last_published_at: null,
      deprecated: null,
      source_url: null,
    });

    const blocked = await start({ policy: 'block', metadata: unstorable });
    expect(
      returns(blocked).filter((entry) =>
        entry.reason.includes('dependency policy blocks npm:lodash'),
      ),
    ).not.toHaveLength(0);
    expect((await storedTask(blocked))?.dependencies?.decision).toBe('block');
  });

  it('blocks on the twenty-sixth package, which the report’s own cap used to drop', async () => {
    /**
     * Review round 2's second major. `MAX_DETECTED_DEPENDENCIES` bounds what is **reported**, never
     * what is **decided** — and the cut used to happen inside `detectDependencyChanges`, so the
     * gate resolved policies over an already-shortened list and package 26 was neither blocked nor
     * asked about. Here the first 25 are allow-listed and the twenty-sixth is not, so the whole
     * decision rests on the package the old cut threw away.
     */
    const packages = Array.from(
      { length: MAX_DETECTED_DEPENDENCIES + 1 },
      (_, index) => `dep-${index}`,
    );
    const harness = await start({
      policy: {
        default: 'block',
        allowlist: packages.slice(0, MAX_DETECTED_DEPENDENCIES).map((name) => `npm:${name}`),
      },
      files: [file('pnpm-lock.yaml', ...packages.map((name) => `+  ${name}@1.0.0:`))],
    });

    const last = `npm:dep-${MAX_DETECTED_DEPENDENCIES}`;
    expect(
      returns(harness).filter((entry) => entry.reason.includes(`dependency policy blocks ${last}`)),
    ).not.toHaveLength(0);
    const stored = await storedTask(harness);
    expect(stored?.dependencies?.decision).toBe('block');
    // The record is still bounded, says so, and keeps the package the block is about — a reason
    // naming nobody would be the cut's other failure (the return text is quoted from this list).
    expect(stored?.dependencies?.added).toHaveLength(MAX_DETECTED_DEPENDENCIES);
    expect(stored?.dependencies?.truncated).toBe(true);
    expect(stored?.dependencies?.added.map((entry) => entry.name)).toContain(
      `dep-${MAX_DETECTED_DEPENDENCIES}`,
    );
  });

  it('redacts an injected secret out of a manifest path before it is stored (BD-022)', async () => {
    const harness = await start({
      secrets: [{ name: 'git', value: 'glpat-deadbeef' }],
      files: [
        file(
          'services/glpat-deadbeef/package.json',
          '   "dependencies": {',
          '+    "lodash": "^4.17.21"',
          '   },',
        ),
      ],
    });

    const stored = await storedTask(harness);
    const path = stored?.dependencies?.added[0]?.path ?? '';
    expect(path).not.toContain('glpat-deadbeef');
    expect(path).toContain('[REDACTED:integration:git]');
    // …and the package is still found: redaction happens on the path and the patch, not instead of
    // reading them.
    expect(stored?.dependencies?.added[0]?.name).toBe('lodash');
  });

  it('records nothing at all for a project whose git binding is gone (standing rule 20)', async () => {
    const harness = await start({ git: null });

    const stored = await storedTask(harness);
    // Not an empty record: the gate could not read a diff, so it states nothing about one.
    expect(stored?.dependencies).toBeNull();
    expect(questionsAsked(harness)).toHaveLength(0);
  });
});
