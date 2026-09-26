/**
 * The coverage delta, driven through the real handler, the real `pipeline.outbound` duty and the
 * real `IntegrationActionExecutor` over the in-memory doubles (WP-39).
 *
 * The e2e tier runs the same thing on PostgreSQL inside an `apps/server` instance against the real
 * `FakeGitProvider` and a signed webhook; this tier is where the **branches** live: a raise and a
 * drop (standing rule 42), a pipeline that reports no coverage, a base that reports none, the cache
 * and its invalidation, the project that turned the source off, and a project with no git binding.
 *
 * Every assertion is on a **countable effect** — the `tasks.coverage` record, and the
 * `integration_actions` rows the executor wrote — never on a return value. In particular, *"the base
 * was not read"* is asserted as **the absence of a `get_pipeline_status` whose payload names the
 * base sha**, rather than as a call count: the rebase gate's two other duties read the provider on
 * the same task, so a global count would be measuring WP-26 and WP-37 as well.
 */
import type { DomainEvent, Id, MergeRequestRef, TaskCoverage } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { markTransactions } from '../events/open-transaction.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { MergeRequest, PipelineStatus } from '../ports/integrations/git-provider.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import { type CoverageOptions, runCoverage } from './coverage.js';
import { staticPipelineIntegrations } from './integrations.js';
import { staticProjectSettings } from './settings.js';

const PROJECT = '00000000-0000-4000-8000-0000000000c1' as Id;
const IID = 7;
const HEAD = 'b'.repeat(40);
const BASE = 'a'.repeat(40);
/** A second default-branch head, for the one thing that invalidates the cache. */
const MOVED_BASE = 'c'.repeat(40);

const TICKET = {
  provider: 'fake-jira',
  key: 'ACME-1',
  url: 'https://jira.example.test/browse/ACME-1',
};

const MR_REF: MergeRequestRef = {
  provider: 'fake-git',
  project_path: 'acme/api',
  iid: IID,
  url: `https://git.example.test/acme/api/-/merge_requests/${IID}`,
  branch: 'agentic/acme-1',
  head_sha: HEAD,
};

/** What the rebase gate reads on its way past: a merge request that applies cleanly. */
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
    // The provider *does* publish a coverage on the merge request itself, and this duty
    // deliberately never reads it: `MergeRequest.coverage_pct` is whatever the head pipeline said
    // at some unstated moment, and a delta may only subtract two answers of the same read. A
    // number here that no assertion ever sees is the point (standing rule 10).
    coverage_pct: 12.5,
    labels: [],
    reviewers: [],
    web_url: MR_REF.url,
  }) as MergeRequest;

const pipelineStatus = (headSha: string, coveragePct: number | null): PipelineStatus => ({
  id: `p-${headSha.slice(0, 4)}`,
  head_sha: headSha,
  status: 'success',
  url: 'https://git.example.test/acme/api/-/pipelines/1',
  jobs: [],
  coverage_pct: coveragePct,
  finished_at: '2026-06-01T09:00:00.000Z',
});

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

/**
 * A pipeline result as a provider's webhook produces one.
 *
 * `task_id` is **null** and `coverage_pct` is **null**, which is not a shortcut: a git webhook knows
 * a merge request and not a platform task, and the only adapter this build ships (GitLab) publishes
 * no coverage on its pipeline hook at all — `gitlab/inbound.ts` fills the field with `null` and says
 * why. The number this feature renders therefore has to come from `getPipelineStatus`, and a
 * fixture that carried it here would be testing a path production never takes (standing rule 1).
 */
const ciFinished = (headSha: string): DomainEvent => {
  // Its own stream, like every provider event `saga.test.ts` publishes: several pipelines finish on
  // one task and `stream_seq` is per stream, so putting them all on the project's would be the
  // harness's own conflict rather than anything about this duty.
  const id = nextEventId();
  return domainEventSchemasByType['ci.pipeline.finished'].parse({
    id,
    stream_type: 'project',
    stream_id: `00000000-0000-4000-8000-${id.slice(-12)}`,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-git' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ci.pipeline.finished',
    payload: {
      project_id: PROJECT,
      task_id: null,
      mr: { ...MR_REF, head_sha: headSha },
      head_sha: headSha,
      status: 'success',
      failed_jobs: [],
      coverage_pct: null,
    },
  }) as DomainEvent;
};

interface CoverageHarness {
  readonly harness: PipelineHarness;
  /** Moves the default branch, which is the one thing that invalidates the cached base. */
  moveDefaultBranch(sha: string): void;
  /** Installs (or replaces) the coverage a revision's pipeline reports. */
  setCoverage(sha: string, pct: number | null): void;
  /** Forgets a revision's pipeline entirely — the provider answers `null` for it. */
  dropPipeline(sha: string): void;
}

const startHarness = (options: {
  readonly coverage?: Readonly<Record<string, number | null>>;
  readonly source?: 'pipeline' | 'none';
}): CoverageHarness => {
  const coverage = new Map<string, number | null>(Object.entries(options.coverage ?? {}));
  let base = BASE;
  const harness = createPipelineHarness({
    projectId: PROJECT,
    settings: {
      config: {
        policies: options.source === undefined ? {} : { coverage_source: options.source },
      },
    },
    runs: {
      refinement: completedRun(REFINED_SPEC),
      architecture: completedRun(PLAN),
      implementation: completedRun(NOTES),
      code_review: completedRun(REVIEW),
      business_review: completedRun(ACCEPTANCE),
    },
    gitRedactor: exactSecretRedactor([]),
    git: {
      getDefaultBranchHead: async () => ({ branch: 'main', sha: base }),
      getMergeRequest: async () => mergeRequest(),
      getPipelineStatus: async (_project: string, headSha: string) =>
        coverage.has(headSha) ? pipelineStatus(headSha, coverage.get(headSha) ?? null) : null,
    },
  });
  return {
    harness,
    moveDefaultBranch: (sha) => {
      base = sha;
    },
    setCoverage: (sha, pct) => {
      coverage.set(sha, pct);
    },
    dropPipeline: (sha) => {
      coverage.delete(sha);
    },
  };
};

const taskId = async (harness: PipelineHarness): Promise<Id> => {
  const created = harness.events().find((event) => event.type === 'task.created') as DomainEvent & {
    payload: { task_id: Id };
  };
  return created.payload.task_id;
};

const coverageOf = async (harness: PipelineHarness): Promise<TaskCoverage | null> => {
  const id = await taskId(harness);
  return await harness.memory.transaction(async (scope) => {
    const stored = await harness.store.tasks.load(scope.tx, id);
    return stored?.coverage ?? null;
  });
};

/** Every `get_pipeline_status` the executor recorded for one revision, which is the read's cost. */
const statusReads = (harness: PipelineHarness, headSha: string): number =>
  harness.audit.entries.filter(
    (entry) => entry.action === 'get_pipeline_status' && entry.payload?.head_sha === headSha,
  ).length;

/** The duty's dependencies, with the transaction guard armed — the shape `notify.test.ts` uses. */
const optionsOf = (harness: PipelineHarness): CoverageOptions => ({
  store: harness.store,
  settings: staticProjectSettings(() => harness.settings),
  jobs: harness.jobs,
  calendar: harness.calendar,
  integrations: staticPipelineIntegrations(harness.integrations),
  ids: harness.ids,
  clock: { now: () => harness.clock.now() },
  unitOfWork: markTransactions(harness.memory),
});

describe('the coverage delta (product/18:38, WP-39)', () => {
  it('records a positive delta when the change raises coverage, and names its base', async () => {
    const started = startHarness({ coverage: { [HEAD]: 81.5, [BASE]: 79 } });
    await started.harness.publish([ticketMatched()]);
    await started.harness.publish([ciFinished(HEAD)]);

    const record = await coverageOf(started.harness);
    expect(record?.head_pct).toBe(81.5);
    expect(record?.base_pct).toBe(79);
    expect(record?.delta_pct).toBe(2.5);
    // The base is **named** rather than implied, which is what lets a reader say how stale it is
    // (standing rule 63): the branch, its head at the moment of the write, and that moment.
    expect(record?.base_branch).toBe('main');
    expect(record?.base_sha).toBe(BASE);
    expect(record?.head_sha).toBe(HEAD);
    expect(record?.measured_at).toBeTruthy();
  });

  it('records a negative delta when the change lowers it', async () => {
    /**
     * The other direction, and the reason this test exists beside the one above (standing rule 42):
     * a build that printed the head number, or subtracted the wrong way round, passes a one-sided
     * test and shows a maintainer a rise on a change that dropped coverage by nine points.
     */
    const started = startHarness({ coverage: { [HEAD]: 70, [BASE]: 79 } });
    await started.harness.publish([ticketMatched()]);
    await started.harness.publish([ciFinished(HEAD)]);

    const record = await coverageOf(started.harness);
    expect(record?.head_pct).toBe(70);
    expect(record?.delta_pct).toBe(-9);
  });

  it('says nothing was reported rather than zero, and does not go looking for a base', async () => {
    /**
     * Standing rule 16, at the one place it decides what a maintainer reads. A pipeline that
     * reports no coverage is *"not reported"*; `0` and `+0.0` would both read as **"the agent's
     * change covers nothing"**, and the second one is worse because it looks measured.
     *
     * The event carries `coverage_pct: null` like every GitLab delivery does, and the pipeline this
     * project ran carries `null` too — both halves, because either one alone would leave the other
     * as the thing that produced the answer.
     */
    const started = startHarness({ coverage: { [HEAD]: null, [BASE]: 79 } });
    await started.harness.publish([ticketMatched()]);
    await started.harness.publish([ciFinished(HEAD)]);

    const record = await coverageOf(started.harness);
    expect(record).not.toBeNull();
    expect(record?.head_pct).toBeNull();
    expect(record?.delta_pct).toBeNull();
    expect(record?.base_pct).toBeNull();
    // …and the base was never asked for: there is nothing to subtract it from, so the provider is
    // not charged a read for it. The head *was* read, which is what makes this a measurement.
    expect(statusReads(started.harness, HEAD)).toBeGreaterThan(0);
    expect(statusReads(started.harness, BASE)).toBe(0);
  });

  it('keeps the head number when the default branch has no coverage of its own', async () => {
    const started = startHarness({ coverage: { [HEAD]: 81.5, [BASE]: null } });
    await started.harness.publish([ticketMatched()]);
    await started.harness.publish([ciFinished(HEAD)]);

    const record = await coverageOf(started.harness);
    expect(record?.head_pct).toBe(81.5);
    expect(record?.base_pct).toBeNull();
    // A delta is never inferred from one number.
    expect(record?.delta_pct).toBeNull();
    expect(record?.base_sha).toBe(BASE);
  });

  it('reports nothing for a revision the provider has no pipeline for', async () => {
    const started = startHarness({ coverage: { [BASE]: 79 } });
    await started.harness.publish([ticketMatched()]);
    started.dropPipeline(HEAD);
    await started.harness.publish([ciFinished(HEAD)]);

    const record = await coverageOf(started.harness);
    expect(record?.head_pct).toBeNull();
    expect(record?.delta_pct).toBeNull();
  });
});

describe('the base read, and the cache that bounds it (WP-39 criterion 4)', () => {
  it('reads the base once per base sha however many pipelines finish', async () => {
    const started = startHarness({ coverage: { [HEAD]: 81.5, [BASE]: 79 } });
    await started.harness.publish([ticketMatched()]);
    // The CI **gate** reads the head revision's pipeline for its own reasons on the way past, so
    // the head is counted from here rather than from zero: this assertion is about what the duty
    // adds, and a count from zero would be measuring WP-15's gate as well.
    const headBefore = statusReads(started.harness, HEAD);
    await started.harness.publish([ciFinished(HEAD)]);
    // A second pipeline on the same revision — a re-run, which is the ordinary case.
    started.setCoverage(HEAD, 83);
    await started.harness.publish([ciFinished(HEAD)]);

    // The **head** is read again, because a re-run may report a different number and the record is
    // meant to be the last thing the CI said…
    expect(statusReads(started.harness, HEAD) - headBefore).toBe(2);
    // …and the **base** is not, because the default branch has not moved. The cache is the task's
    // own row: key `(task_id, base_sha)`, invalidated by the branch moving and by nothing else.
    expect(statusReads(started.harness, BASE)).toBe(1);
    const record = await coverageOf(started.harness);
    expect(record?.head_pct).toBe(83);
    expect(record?.base_pct).toBe(79);
    expect(record?.delta_pct).toBe(4);
  });

  it('reads it again once the default branch has moved, and re-bases the delta', async () => {
    const started = startHarness({ coverage: { [HEAD]: 81.5, [BASE]: 79, [MOVED_BASE]: 85 } });
    await started.harness.publish([ticketMatched()]);
    await started.harness.publish([ciFinished(HEAD)]);
    started.moveDefaultBranch(MOVED_BASE);
    await started.harness.publish([ciFinished(HEAD)]);

    expect(statusReads(started.harness, BASE)).toBe(1);
    expect(statusReads(started.harness, MOVED_BASE)).toBe(1);
    const record = await coverageOf(started.harness);
    expect(record?.base_sha).toBe(MOVED_BASE);
    expect(record?.base_pct).toBe(85);
    // The same change against a better `main` is now a regression, which is the fact the panel owes
    // a maintainer.
    expect(record?.delta_pct).toBe(-3.5);
  });

  it('asks again for a base that reported nothing, because it may not have finished yet', async () => {
    /**
     * The one deviation from *"at most once per task per base sha"*, stated at the duty and
     * asserted here: a `null` base is *"the default branch's pipeline has not reported a number"*,
     * which is a state that ends. Caching it would pin "no base" for the whole life of the branch —
     * a wrong answer kept alive by an optimisation.
     */
    const started = startHarness({ coverage: { [HEAD]: 81.5, [BASE]: null } });
    await started.harness.publish([ticketMatched()]);
    await started.harness.publish([ciFinished(HEAD)]);
    expect((await coverageOf(started.harness))?.base_pct).toBeNull();

    started.setCoverage(BASE, 79);
    await started.harness.publish([ciFinished(HEAD)]);

    expect(statusReads(started.harness, BASE)).toBe(2);
    expect((await coverageOf(started.harness))?.delta_pct).toBe(2.5);
  });
});

describe('what stops the duty (WP-39)', () => {
  it('reads nothing and stores nothing when the project turned the source off', async () => {
    const started = startHarness({ source: 'none', coverage: { [HEAD]: 81.5, [BASE]: 79 } });
    await started.harness.publish([ticketMatched()]);
    await started.harness.publish([ciFinished(HEAD)]);

    expect(await coverageOf(started.harness)).toBeNull();
    expect(statusReads(started.harness, BASE)).toBe(0);
    // The CI gate reads the head revision's pipeline for its own reasons, so "the duty read
    // nothing" is asserted on the base, which only this duty ever asks for.
  });

  it('stores nothing for a project whose git binding is gone', async () => {
    /**
     * Standing rule 20 — an inbound notification fails **open**: a project whose integration was
     * removed keeps running rather than dead-lettering every pipeline event. Driven by calling the
     * duty directly, because the pipeline cannot produce a merge request without the binding it is
     * being deprived of; the arrangement is the one `risk-routing.test.ts` uses for its shadow case.
     */
    const started = startHarness({ coverage: { [HEAD]: 81.5, [BASE]: 79 } });
    await started.harness.publish([ticketMatched()]);
    const id = await taskId(started.harness);
    const unbound: CoverageOptions = {
      ...optionsOf(started.harness),
      integrations: staticPipelineIntegrations({ ...started.harness.integrations, git: null }),
    };

    await expect(
      runCoverage(unbound, {
        duty: 'coverage',
        project_id: PROJECT,
        task_id: id,
        cause_event_id: nextEventId(),
        head_sha: HEAD,
      }),
    ).resolves.toBeUndefined();
    expect(await coverageOf(started.harness)).toBeNull();
  });

  it('does nothing for a pipeline on a branch with no merge request', async () => {
    // The base of somebody else's delta: a push to the default branch. There is no task to record
    // it on, and inventing one would be the platform guessing.
    const started = startHarness({ coverage: { [BASE]: 79 } });
    await started.harness.publish([ticketMatched()]);
    const noMergeRequest = domainEventSchemasByType['ci.pipeline.finished'].parse({
      ...ciFinished(BASE),
      payload: {
        project_id: PROJECT,
        task_id: null,
        mr: null,
        head_sha: BASE,
        status: 'success',
        failed_jobs: [],
        coverage_pct: null,
      },
    }) as DomainEvent;
    await started.harness.publish([noMergeRequest]);

    expect(await coverageOf(started.harness)).toBeNull();
  });
});
