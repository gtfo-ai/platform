/**
 * **WP-38's acceptance, through a real `apps/server` instance**: a package the Developer stage adds
 * is read out of the merge request's own **patch**, and the project's policy decides what happens
 * next (product/04:58, product/18:43, BD-030).
 *
 * What this tier adds to `dependency-gate.test.ts`'s branches is the **composition**: the diff is
 * read through the production `IntegrationActionExecutor` from the instance's own
 * `pipeline.outbound` worker, the question is opened by the production `PostgresPipelineStore`, and
 * the record the Checks panel renders is the one that store wrote. Every assertion is on a row —
 * `tasks.dependencies`, `questions`, `tasks.state`, the `integration_actions` audit — never on a
 * return value (standing rule 79).
 *
 * **The fake produces the diff the detector reads** (standing rule 82). `FakeGitProvider.setDiff`
 * carries a real unified patch here rather than a bare path list, because a patch is what the
 * detector parses: a test that seeded a `tasks.dependencies` row would certify nothing about the
 * one thing this work package built. The three cases below differ only in that patch and in the
 * project's configuration, which is what makes the *policy* the variable under test.
 *
 * Every wait is on the last row the platform writes and the rest is asserted as what that row
 * implies (standing rule 87). The gate writes the question, the task's new state and the record in
 * **one** transaction, so waiting on the record bounds all three; the provider read happens before
 * it, so the audit assertion is bounded too.
 */
import type { TaskDependencies } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { GIT_PROJECT, inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
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

/** A patch as a provider sends one: the header, a hunk marker, then the lines. */
const patch = (path: string, ...lines: readonly string[]): string =>
  [`--- a/${path}`, `+++ b/${path}`, '@@ -1,4 +1,5 @@', ...lines].join('\n');

/** The Developer stage added `lodash` to the manifest **and** to the lockfile, as a real one does. */
const ADDS_A_PACKAGE = [
  {
    path: 'package.json',
    diff: patch(
      'package.json',
      '   "dependencies": {',
      '     "react": "^19.0.0",',
      '+    "lodash": "^4.17.21"',
      '   },',
    ),
  },
  {
    path: 'pnpm-lock.yaml',
    diff: patch('pnpm-lock.yaml', '+  lodash@4.17.21:', '+    resolution: {integrity: sha512-x}'),
  },
];

/** The same stage changing code only — the diff the gate must say nothing about. */
const TOUCHES_NO_MANIFEST = [
  { path: 'src/totals.ts', diff: patch('src/totals.ts', '+export const sum = (a: number) => a;') },
];

const dependenciesOf = async (pipeline: PipelineE2E): Promise<TaskDependencies | null> => {
  const rows = await pipeline.query<{ dependencies: TaskDependencies | null }>(
    'select dependencies from tasks where project_id = $1 limit 1',
    [pipeline.projectId],
  );
  return rows[0]?.dependencies ?? null;
};

const questionsOf = async (
  pipeline: PipelineE2E,
): Promise<readonly { text: string; status: string; stage: string }[]> =>
  pipeline.query<{ text: string; status: string; stage: string }>(
    'select q.text, q.status, q.stage from questions q join tasks t on t.id = q.task_id where t.project_id = $1',
    [pipeline.projectId],
  );

const diffReads = async (pipeline: PipelineE2E): Promise<number> =>
  (await pipeline.auditRows()).filter((row) => row.action === 'get_merge_request_diff').length;

describe('the dependency policy at the Developer stage', () => {
  it('asks one question about the package the diff adds, and waits for the answer', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'dependency-ask',
      tickets: TICKETS,
      // product/18:43's shipped default, written out so the case says what it is testing.
      config: { version: 1, policies: { dependency_policy: 'ask' } },
      /**
       * **The CI is still running**, which is what puts the task where production would be.
       *
       * A stage of the real product takes minutes and this job is polled every half second, so the
       * gate's decision lands while the task is still at the CI gate — `active`, which is the state
       * a blocking question needs. With the fake runner a whole template walks in milliseconds and
       * the task reaches `ready_for_merge` first, which is a **harness** that is faster than
       * production rather than a product behaviour. A pipeline in flight makes the CI gate answer
       * *"not yet"* and wait `GATE_RECHECK_MS`, which widens the window instead of sleeping inside
       * an assertion (standing rule 76). The `running` status is seeded below, before the ticket.
       */
      ciStatus: null,
    });
    harness = pipeline;

    pipeline.git.setDiff({
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      files: ADDS_A_PACKAGE,
    });
    pipeline.git.setPipeline({
      project: GIT_PROJECT,
      headSha: pipeline.world.mr.headSha,
      status: 'running',
    });

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    await pipeline.waitFor(
      'the dependency gate to record what it found',
      async () => (await dependenciesOf(pipeline)) !== null,
    );

    const record = await dependenciesOf(pipeline);
    expect(record?.decision).toBe('ask');
    expect(record?.question_id).not.toBeNull();
    // The manifest line outranks the lockfile echo of the same package: the gate reports the line
    // somebody wrote, once, and says which file it came from.
    expect(record?.added).toEqual([
      expect.objectContaining({
        ecosystem: 'npm',
        name: 'lodash',
        from: 'manifest',
        path: 'package.json',
        policy: 'ask',
        allowlisted: false,
      }),
    ]);
    // No registry host is declared on this instance — the shipped default — so the platform asked
    // nobody and says so rather than leaving the field blank (Q84).
    expect(record?.added[0]?.metadata).toMatchObject({ status: 'not_checked', license: null });

    // …and the countable effects of `ask`, in the same transaction as that record.
    const asked = await questionsOf(pipeline);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.status).toBe('open');
    expect(asked[0]?.text).toContain('npm:lodash');
    expect(asked[0]?.text).toContain('licence not checked');
    // The question belongs to the stage that added the package, so an answer resumes that run.
    expect(asked[0]?.stage).toBe('implementation');
    /**
     * **And the task is still waiting**, which is the assertion that found a defect this work
     * package made reachable: a gate evaluation in flight when the question landed used to settle
     * anyway, the state machine refused `waiting_answers -> ready_for_merge`, and the generic
     * fallback escalated the task with a brief blaming the template (`jobs.ts`'s `settle` now
     * re-reads the state inside its transaction). Asserted after the record rather than by polling
     * for a state, because `waiting_answers` is where the task should *stay*.
     */
    expect((await pipeline.task()).state).toBe('waiting_answers');

    // The diff was read through the production executor, which is the only way the record above
    // could exist — the audit row is what that record implies (rule 87).
    expect(await diffReads(pipeline)).toBeGreaterThanOrEqual(1);
  }, 180_000);

  it('asks nothing when the same walk produces a diff that touches no manifest', async () => {
    /**
     * The other direction (standing rule 42), and the one that decides whether this feature is a
     * gate or a nuisance: a detector that fired on every diff would pass the case above and would
     * park every task in the product.
     */
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'dependency-none',
      tickets: TICKETS,
    });
    harness = pipeline;

    pipeline.git.setDiff({
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      files: TOUCHES_NO_MANIFEST,
    });

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');
    await pipeline.waitFor(
      'the dependency gate to record what it found',
      async () => (await dependenciesOf(pipeline)) !== null,
    );

    // **It ran and found nothing**, which is a different row from a gate that never ran (`null`)
    // and a different sentence on the panel (standing rule 18).
    const record = await dependenciesOf(pipeline);
    expect(record?.decision).toBe('none');
    expect(record?.added).toEqual([]);
    expect(await questionsOf(pipeline)).toEqual([]);
    expect((await pipeline.task()).state).toBe('ready_for_merge');
  }, 180_000);

  it('sends the task back when the project blocks the package, and escalates when the loop is spent', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'dependency-block',
      tickets: TICKETS,
      config: { version: 1, policies: { dependency_policy: { ecosystems: { npm: 'block' } } } },
    });
    harness = pipeline;

    pipeline.git.setDiff({
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      files: ADDS_A_PACKAGE,
    });

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    /**
     * **The wait is on the return, not on the escalation.**
     *
     * The fake runner produces the same notes — and therefore the same diff — on every attempt, so
     * the gate blocks each time and the **loop's own bound** ends it in `needs_human`; that whole
     * sequence is driven in `dependency-gate.test.ts`, where the counters are asserted against the
     * limit. Here it would cost a second full template walk per round, and it timed out once at 90 s
     * on a loaded machine — a wait whose length depends on the runner's speed is a flake nobody can
     * prove fixed (standing rule 76). What this tier owes is the **composition**: a real provider
     * read produced a real `task.stage.returned` with the package in its reason.
     */
    await pipeline.waitFor('the dependency gate to send the task back', async () =>
      (await pipeline.events()).some((event) => event.type === 'task.stage.returned'),
    );

    const record = await dependenciesOf(pipeline);
    expect(record?.decision).toBe('block');
    expect(record?.added[0]?.policy).toBe('block');
    // A block is not a question: nobody was asked anything.
    expect(await questionsOf(pipeline)).toEqual([]);

    const returns = (await pipeline.events()).filter(
      (event) => event.type === 'task.stage.returned',
    );
    expect(JSON.stringify(returns[0]?.payload)).toContain('dependency policy blocks npm:lodash');
    expect(JSON.stringify(returns[0]?.payload)).toContain('"to_stage":"implementation"');
    /**
     * **The loop it spends is its own**, and this tier is where that was measured (standing rule
     * 81). The gate's job fires whenever the outbound worker reaches it, and with a fake runner the
     * task is usually at the rebase gate or at `ready_for_merge` by then — where `RETURN_LOOPS`
     * says `human_rounds`, BD-008's *"human MR rounds"*. Before `dependency_policy` existed this
     * task escalated with *"human_rounds iteration limit of 3 reached: the project's dependency
     * policy blocks npm:lodash"*: a bound nobody had spent, named after a loop nobody had been
     * round.
     */
    const counters = (await pipeline.task()).iteration_counters;
    expect(counters.dependency_policy).toBeGreaterThanOrEqual(1);
    expect(counters.human_rounds ?? 0).toBe(0);
  }, 180_000);
});
