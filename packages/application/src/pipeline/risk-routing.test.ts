/**
 * Risk classes and reviewer routing, driven through the real handler, the real `pipeline.outbound`
 * duty and the real `IntegrationActionExecutor` over the in-memory doubles (WP-37).
 *
 * The e2e tier runs the same thing on PostgreSQL inside an `apps/server` instance against the real
 * `FakeGitProvider`; this tier is where the **branches** live — a diff that is classed and one that
 * is not (standing rule 42), the three steps of product/19:138's precedence, the `CODEOWNERS` a
 * change plants on its own branch and does not get to be routed by, a handle that resolves to
 * nobody, and a shadow task that assigns nobody at all.
 *
 * The last one is the only case driven by calling the duty directly: nothing in this build creates
 * a shadow task, so the row is flipped by hand and the arrangement is stated at the case. Every
 * other case goes through the real handler from a real `ticket.matched`.
 *
 * Every assertion is on a **countable effect** — the task row, the `integration_actions` rows the
 * executor wrote — never on a return value (standing rule 79), because the duty's whole purpose is
 * the row and the call.
 */
import type { DomainEvent, Id, RiskClass } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { markTransactions } from '../events/open-transaction.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type {
  CodeownersRules,
  FileDiff,
  MergeRequest,
} from '../ports/integrations/git-provider.js';
import {
  createPipelineHarness,
  type HarnessOptions,
  type PipelineHarness,
} from '../testing/pipeline-harness.js';
import { staticPipelineIntegrations } from './integrations.js';
import {
  type RiskRoutingOptions,
  reviewerRoutingIdempotencyKey,
  runRiskRouting,
} from './risk-routing.js';
import { staticProjectSettings } from './settings.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const IID = 7;
const HEAD = 'b'.repeat(40);
/** What the harness's git double calls the default branch, and the branch the change is on. */
const DEFAULT_BRANCH = 'main';
const TASK_BRANCH = 'agentic/acme-1';

/** An obviously fake credential (BD-002), planted in a path so the redaction has a target. */
const PLANTED = 'FAKE-git-token-not-a-real-secret-0000';

const TICKET = {
  provider: 'fake-jira',
  key: 'ACME-1',
  url: 'https://jira.example.test/browse/ACME-1',
};

const CLASSES: Readonly<Record<string, RiskClass>> = {
  data: { paths: ['**/migrations/**', '**/*.sql'], require: ['plan_approval'] },
  auth: { paths: ['src/auth/**'], require: ['plan_approval', 'reviewer:@security'] },
};

const fileDiff = (path: string): FileDiff => ({
  new_path: path,
  old_path: path,
  diff: `@@ -1 +1 @@\n-old\n+new in ${path}\n`,
  new_file: false,
  renamed_file: false,
  deleted_file: false,
  omitted: false,
});

const mergeRequest = (reviewers: readonly string[]): MergeRequest =>
  ({
    ref: {
      provider: 'fake-git',
      project_path: 'acme/api',
      iid: IID,
      url: `https://git.example.test/acme/api/-/merge_requests/${IID}`,
      branch: TASK_BRANCH,
      head_sha: HEAD,
    },
    state: 'opened' as const,
    draft: true,
    title: 'Sum the invoice footer',
    description: 'Opened by the developer stage.',
    source_branch: TASK_BRANCH,
    target_branch: DEFAULT_BRANCH,
    head_sha: HEAD,
    mergeable: true,
    has_conflicts: false,
    labels: [],
    reviewers: reviewers.map((id) => ({
      provider: 'fake-git',
      external_id: id,
      verified: true,
    })),
    web_url: `https://git.example.test/acme/api/-/merge_requests/${IID}`,
  }) as MergeRequest;

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

/**
 * The plan declares **one** path and it is not in any class.
 *
 * That is the point of this fixture rather than an accident: the plan-approval gate reads these
 * paths and the duty under test reads the *diff*, so a test whose plan and diff agreed could not
 * tell which of the two produced the classes on the row (standing rule 10).
 */
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
  mr: {
    url: `https://git.example.test/acme/api/-/merge_requests/${IID}`,
    iid: IID,
    head_sha: HEAD,
    branch: TASK_BRANCH,
  },
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

const ticketMatched = (): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: '00000000-0000-4000-9000-000000000001',
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

interface RoutingHarness {
  readonly harness: PipelineHarness;
  /** Every `resolveUserId` the duty asked for, in order — the read whose cost is bounded. */
  readonly lookups: readonly string[];
  /** The reviewer list every `updateMergeRequest` was called with. */
  readonly assigned: readonly (readonly string[])[];
  /**
   * Every ref the duty read `CODEOWNERS` at, in order.
   *
   * Captured rather than assumed: the ref is the whole of the security property, and the double
   * below answers a **different file per ref** so that reading the wrong one is a wrong answer
   * rather than the same answer by another route (standing rule 4 — a stub that ignored `ref`
   * cannot reach the state the assertion is about, which is exactly how this went unasserted
   * through round 1).
   */
  readonly codeownersReads: readonly string[];
}

const startHarness = (options: {
  readonly paths?: readonly string[];
  readonly classes?: Readonly<Record<string, RiskClass>>;
  readonly reviewers?: readonly string[];
  /** The `CODEOWNERS` at the **default branch** — the copy a change cannot rewrite. */
  readonly codeowners?: CodeownersRules | null;
  /** The `CODEOWNERS` at the **task branch**, i.e. the copy the change itself carries. */
  readonly branchCodeowners?: CodeownersRules | null;
  /** Handle → account id; anything else resolves to nobody, like a real directory. */
  readonly accounts?: Readonly<Record<string, string>>;
  /** Reviewers already on the merge request when the platform gets there. */
  readonly existing?: readonly string[];
  /** The provider refuses the assignment — a revoked token, a 403, an outage. */
  readonly assignmentFails?: boolean;
  readonly harness?: HarnessOptions;
}): RoutingHarness => {
  const lookups: string[] = [];
  const assigned: string[][] = [];
  const codeownersReads: string[] = [];
  const codeownersByRef: Readonly<Record<string, CodeownersRules | null | undefined>> = {
    [DEFAULT_BRANCH]: options.codeowners,
    [TASK_BRANCH]: options.branchCodeowners,
  };
  let current = [...(options.existing ?? [])];
  const harness = createPipelineHarness({
    projectId: PROJECT,
    settings: {
      config: {
        policies: {
          ...(options.classes === undefined ? {} : { risk_classes: options.classes }),
          ...(options.reviewers === undefined ? {} : { reviewers: [...options.reviewers] }),
        },
      },
    },
    runs: {
      refinement: completedRun(REFINED_SPEC),
      architecture: completedRun(PLAN),
      implementation: completedRun(NOTES),
      code_review: completedRun(REVIEW),
      business_review: completedRun(ACCEPTANCE),
    },
    gitRedactor: exactSecretRedactor([{ name: 'git_token', value: PLANTED }]),
    git: {
      getPipelineStatus: async () => null,
      getMergeRequest: async () => mergeRequest(current),
      getMergeRequestDiff: async () => (options.paths ?? ['src/totals.ts']).map(fileDiff),
      readCodeowners: async (_project: string, ref: string) => {
        codeownersReads.push(ref);
        return codeownersByRef[ref] ?? null;
      },
      resolveUserId: async (handle: string) => {
        lookups.push(handle);
        return options.accounts?.[handle] ?? null;
      },
      updateMergeRequest: async (_ref, update) => {
        if (options.assignmentFails === true) {
          // Not an `IntegrationError`, so the executor does not retry: one attempt, one `failed`
          // audit row, one throw — which is the shape a 403 from a revoked token has.
          throw new Error('the provider refused the assignment');
        }
        assigned.push([...(update.reviewers ?? [])]);
        current = [...(update.reviewers ?? [])];
        return mergeRequest(current);
      },
    },
    ...options.harness,
  });
  return { harness, lookups, assigned, codeownersReads };
};

const taskId = async (harness: PipelineHarness): Promise<Id> => {
  const created = harness.events().find((event) => event.type === 'task.created') as DomainEvent & {
    payload: { task_id: Id };
  };
  return created.payload.task_id;
};

const requiredReviewers = async (harness: PipelineHarness) => {
  const id = await taskId(harness);
  return await harness.memory.transaction(async (scope) => {
    const stored = await harness.store.tasks.load(scope.tx, id);
    return stored?.requiredReviewers ?? null;
  });
};

const riskClasses = async (harness: PipelineHarness): Promise<readonly string[]> => {
  const id = await taskId(harness);
  return await harness.memory.transaction(async (scope) => {
    const stored = await harness.store.tasks.load(scope.tx, id);
    return stored?.riskClasses ?? [];
  });
};

const actions = (harness: PipelineHarness, action: string) =>
  harness.audit.entries.filter((entry) => entry.action === action);

/**
 * The duty's dependencies, built out of the harness with the transaction guard **armed** — the
 * shape `notify.test.ts` uses, and needed here for the one case the pipeline cannot drive into
 * being (the shadow task below).
 */
const optionsOf = (harness: PipelineHarness): RiskRoutingOptions => ({
  store: harness.store,
  settings: staticProjectSettings(() => harness.settings),
  jobs: harness.jobs,
  calendar: harness.calendar,
  integrations: staticPipelineIntegrations(harness.integrations),
  ids: harness.ids,
  clock: { now: () => harness.clock.now() },
  unitOfWork: markTransactions(harness.memory),
  // Never consulted here: `tasks.requested_by_user_id` is `null` on every task this build creates
  // (PROGRESS backlog 92), so step three of the precedence stops before it.
  identities: { forProvider: async () => new Map() },
});

describe('risk classes from the merge request’s own diff (product/19 §14, WP-37)', () => {
  it('classes a task whose diff touches a declared path', async () => {
    // The **diff** carries a migration and the **plan** does not, so this class can only have come
    // from the read this work package added (standing rule 10: the assertion says which branch ran).
    const started = startHarness({
      classes: CLASSES,
      paths: ['src/totals.ts', 'db/migrations/0007_add_totals.sql'],
    });
    await started.harness.publish([ticketMatched()]);

    expect(await riskClasses(started.harness)).toEqual(['data']);
  });

  it('leaves the list empty when the diff touches nothing classed', async () => {
    const started = startHarness({ classes: CLASSES, paths: ['docs/readme.md'] });
    await started.harness.publish([ticketMatched()]);

    expect(await riskClasses(started.harness)).toEqual([]);
    // …and it looked: the empty list is a classification that happened, not a duty that never ran.
    expect(actions(started.harness, 'get_merge_request_diff').length).toBeGreaterThan(0);
  });

  it('leaves the list empty for a project that declares no classes at all', async () => {
    const started = startHarness({ paths: ['db/migrations/0007_add_totals.sql'] });
    await started.harness.publish([ticketMatched()]);

    expect(await riskClasses(started.harness)).toEqual([]);
  });

  it('keeps a credential somebody committed in a path out of the stored class match', async () => {
    // The path is redacted before it is matched, so a class whose pattern happened to contain the
    // secret cannot be the thing that matched (BD-022, and `changedPathsOf`'s stated ordering).
    const started = startHarness({
      classes: { data: { paths: [`src/${PLANTED}/**`], require: ['plan_approval'] } },
      paths: [`src/${PLANTED}/totals.ts`],
    });
    await started.harness.publish([ticketMatched()]);

    expect(await riskClasses(started.harness)).toEqual([]);
  });
});

describe('reviewer routing (product/19:138, WP-37)', () => {
  const codeowners = (owners: readonly string[]): CodeownersRules => ({
    rules: [{ pattern: 'src/', owners: [...owners] }],
  });

  it('assigns the CODEOWNERS match first', async () => {
    const started = startHarness({
      codeowners: codeowners(['@dana']),
      reviewers: ['9001'],
      accounts: { '@dana': '4242' },
    });
    await started.harness.publish([ticketMatched()]);

    expect(started.lookups).toEqual(['@dana']);
    expect(started.assigned).toEqual([['4242']]);
    expect(actions(started.harness, 'set_reviewers').length).toBe(1);
  });

  it('reads CODEOWNERS at the default branch, so a copy planted in the change appoints nobody', async () => {
    /**
     * **The security property of this duty**, asserted both ways (standing rule 42): a merge
     * request may edit `CODEOWNERS` itself, and routing by the version *in* the change would let
     * whoever wrote it appoint their own reviewer (BD-022 — in a fork workflow, a contributor).
     *
     * The two files disagree on purpose and the double answers per ref, so the read that happened
     * is legible three ways: the ref asked for, the handle looked up, and the account assigned. A
     * build that read `stored.mr.branch` fails all three by name — which nothing did until this
     * case existed, because the double used to ignore `ref` entirely (WP-37 review round 2).
     */
    const started = startHarness({
      codeowners: codeowners(['@dana']),
      branchCodeowners: codeowners(['@mallory']),
      accounts: { '@dana': '4242', '@mallory': '6666' },
    });
    await started.harness.publish([ticketMatched()]);

    expect(started.codeownersReads).toEqual([DEFAULT_BRANCH]);
    expect(started.lookups).toEqual(['@dana']);
    expect(started.assigned).toEqual([['4242']]);
  });

  it('falls back to the project’s `reviewers` key when CODEOWNERS matched nothing', async () => {
    const started = startHarness({
      codeowners: codeowners(['@dana']),
      // The owners' rule covers `src/`, and this diff does not touch it.
      paths: ['docs/readme.md'],
      reviewers: ['9001'],
      accounts: { '9001': '9001' },
    });
    await started.harness.publish([ticketMatched()]);

    expect(started.lookups).toEqual(['9001']);
    expect(started.assigned).toEqual([['9001']]);
  });

  it('adds the reviewer a risk class requires without dropping the CODEOWNERS one', async () => {
    const started = startHarness({
      classes: CLASSES,
      paths: ['src/auth/session.ts'],
      codeowners: codeowners(['@dana']),
      accounts: { '@dana': '4242', '@security': '7' },
    });
    await started.harness.publish([ticketMatched()]);

    expect(await riskClasses(started.harness)).toEqual(['auth']);
    // product/19:138: classes **add** required reviewers rather than replace them. The two disagree
    // here on purpose.
    expect(started.assigned).toEqual([['4242', '7']]);
  });

  it('never removes a reviewer a human added to the merge request', async () => {
    const started = startHarness({
      codeowners: codeowners(['@dana']),
      accounts: { '@dana': '4242' },
      existing: ['1234'],
    });
    await started.harness.publish([ticketMatched()]);

    // `updateMergeRequest` sets the whole list, so the union is the platform's responsibility.
    expect(started.assigned).toEqual([['1234', '4242']]);
  });

  it('assigns nobody, and calls nothing, when every handle resolves to nobody', async () => {
    const started = startHarness({ codeowners: codeowners(['@team/security']) });
    await started.harness.publish([ticketMatched()]);

    expect(started.lookups).toEqual(['@team/security']);
    expect(started.assigned).toEqual([]);
    expect(actions(started.harness, 'set_reviewers')).toEqual([]);
  });

  it('assigns nobody on a project with no CODEOWNERS, no reviewers and no mapped requester', async () => {
    // The shipped default, and the one an operator meets first: `tasks.requested_by_user_id` has no
    // writer and `user_identities` is empty (PROGRESS backlog 79), so step three finds nobody.
    const started = startHarness({});
    await started.harness.publish([ticketMatched()]);

    expect(started.lookups).toEqual([]);
    expect(started.assigned).toEqual([]);
  });

  it('records the assignment as a real call, with the task’s own mode (technical/06)', async () => {
    // What the duty owes is the task's own mode on the way in; what the executor does with it is
    // its branch. This is the half a `normal` task takes — the call went out, recorded `ok` — and
    // the case below is the other one (standing rule 42), driven by hand because no task this
    // build creates is `shadow`.
    const started = startHarness({
      codeowners: codeowners(['@dana']),
      accounts: { '@dana': '4242' },
    });
    await started.harness.publish([ticketMatched()]);

    const entry = actions(started.harness, 'set_reviewers')[0];
    expect(entry?.mutating).toBe(true);
    expect(entry?.status).toBe('ok');
    // The payload records what was touched, never a copy of the provider's answer.
    expect(entry?.payload).toMatchObject({ iid: IID, reviewers: ['4242'] });
  });

  it('records a shadow task’s assignment as would_have and never calls update_merge_request', async () => {
    /**
     * Criterion 6's other half — and the arrangement is stated because it is a state **this build
     * cannot reach on its own**: `pipeline.intake` creates every task `normal`, nothing writes
     * `shadow` (WP-34 owns the reader of `shadowMode`, PROGRESS backlog 72), so the row is flipped
     * and the duty is called directly, the shape `notify.test.ts` uses for the same reason.
     *
     * What is asserted is the duty's **own** obligation rather than the executor's branch: it
     * carries the *task's* mode into the call, so step 1 of the executor turns the assignment into
     * a `would_have` row and `updateMergeRequest` is never reached.
     *
     * The directory learns the account only after the pipeline has settled, which is what makes the
     * shadow run the **first** one with anything to assign: `reviewWrites.reviewers` unions with
     * whoever is already on the merge request and makes no call when that adds nothing, so a
     * shadow pass over an already-assigned merge request would assert nothing at all.
     */
    const accounts: Record<string, string> = {};
    const started = startHarness({ codeowners: codeowners(['@dana']), accounts });
    await started.harness.publish([ticketMatched()]);
    const id = await taskId(started.harness);
    expect(started.lookups, 'the normal pass looked and found nobody').toEqual(['@dana']);
    expect(actions(started.harness, 'set_reviewers'), 'so it assigned nobody').toEqual([]);

    await started.harness.memory.transaction(async (scope) => {
      const stored = await started.harness.store.tasks.load(scope.tx, id);
      const loaded = stored as NonNullable<typeof stored>;
      await started.harness.store.tasks.save(scope.tx, {
        ...loaded,
        task: { ...loaded.task, mode: 'shadow' },
      });
    });
    accounts['@dana'] = '4242';
    started.harness.audit.reset();

    await runRiskRouting(optionsOf(started.harness), {
      duty: 'risk_route',
      project_id: PROJECT,
      task_id: id,
      cause_event_id: '00000000-0000-4000-9000-000000000001',
    });

    const entry = actions(started.harness, 'set_reviewers')[0];
    expect(entry?.status).toBe('would_have');
    expect(entry?.payload).toMatchObject({ iid: IID, reviewers: ['4242'] });
    expect(started.assigned, 'a shadow task assigns nobody on the provider').toEqual([]);
    // …and the row says so too: `assigned` is what a provider was told, and in shadow mode nothing
    // was (review round 2 — the same field, the same rule as the failed call above).
    const record = await requiredReviewers(started.harness);
    expect(record?.handles).toEqual(['@dana']);
    expect(record?.assigned).toEqual([]);
  });

  it('records no assignment when the provider refuses the call the row is about', async () => {
    /**
     * Review round 2's third minor, and standing rule 87's family: `assigned` is *"the accounts the
     * platform actually asked for a review"*, and it used to be written **before** the call. A
     * revoked token, a 403 or an outage therefore left the Checks panel stating a request that was
     * never made — the panel being the one screen a maintainer uses to decide whether to merge.
     *
     * The routing itself is still recorded, because it is what the platform *chose* and it is true:
     * `handles` names @dana, `assigned` names nobody, and the two together are the honest sentence.
     */
    const started = startHarness({
      codeowners: codeowners(['@dana']),
      accounts: { '@dana': '4242' },
      assignmentFails: true,
    });

    await expect(started.harness.publish([ticketMatched()])).rejects.toThrow(
      /refused the assignment/,
    );

    const record = await requiredReviewers(started.harness);
    expect(record?.handles).toEqual(['@dana']);
    expect(record?.assigned, 'nobody was asked: the call threw').toEqual([]);
    // The call was really attempted — otherwise an empty `assigned` would prove nothing.
    expect(actions(started.harness, 'set_reviewers').map((entry) => entry.status)).toEqual([
      'failed',
    ]);
    expect(started.assigned, 'and the provider never got as far as a reviewer list').toEqual([]);
  });

  it('is keyed on the revision, so a second gate entry assigns nobody twice', async () => {
    const started = startHarness({
      codeowners: codeowners(['@dana']),
      accounts: { '@dana': '4242' },
    });
    await started.harness.publish([ticketMatched()]);
    const id = await taskId(started.harness);

    // The key is the platform's own: the task and the head sha it was assigned at.
    // `idempotencyStorageKey` is `integrationId:action:key` with each part URI-encoded, so the
    // stored spelling is the encoded one — compared here rather than reproduced by hand.
    const key = encodeURIComponent(reviewerRoutingIdempotencyKey(id, HEAD));
    expect(started.harness.idempotency.keys().some((stored) => stored.endsWith(key))).toBe(true);
    expect(actions(started.harness, 'set_reviewers').length).toBe(1);
  });
});
