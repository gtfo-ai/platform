/**
 * **WP-26's acceptance, through a real `apps/server` instance**: the rebase gate before Ready and
 * again when the default branch moves, bounded conflict resolution, CI re-run, and the warning
 * between two tasks that touch the same files (product/04 S6b, BD-030).
 *
 * What this tier adds to `saga.test.ts`'s branches: the **composition**. The gate is evaluated by
 * the instance's own `stage.execute` worker, the conflict-resolution run is planned by the
 * production planner and — in the case that needs it — driven by the **production runner over a
 * scripted CLI**, so the assertion that the conflict instruction reached the model is on the bytes
 * the CLI received rather than on a `RunSpec` the fake runner ignores (standing rule 82). The
 * default-branch move arrives as a **signed delivery** through the unauthenticated webhook route,
 * which is the only door production has (WP-15c).
 *
 * Every wait is on the row the assertion then reads (standing rule 50): a task state, a
 * `stage_attempts` count, an `integration_actions` row or an event — never on the provider call
 * that precedes one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import {
  GIT_PROJECT,
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

/**
 * The conflict resolution's `ImplementationNotes`, which is the developer's artifact — the same
 * shape `implementation` produces, because it is the same role.
 */
const RESOLUTION_NOTES = (world: SeededWorld) => ({
  structuredOutput: {
    summary: 'Merged main into the branch and resolved src/totals.ts.',
    deviations_from_plan: [],
    tests_added: [],
    commands_run: [
      { command: 'git fetch origin', exit_code: 0, summary: 'fetched' },
      { command: 'git merge origin/main', exit_code: 0, summary: 'resolved src/totals.ts' },
      { command: 'git push origin agentic/acme-1', exit_code: 0, summary: 'pushed' },
    ],
    known_gaps: [],
    followup_tickets: [],
    mr: {
      url: world.mr.url,
      iid: world.mr.iid,
      head_sha: world.mr.headSha,
      branch: world.branch,
    },
  },
});

const rebaseChecks = async (pipeline: PipelineE2E) =>
  (await pipeline.events())
    .filter((event) => event.type === 'task.rebase.checked')
    .map((event) => {
      const payload = event.payload as { outcome: string; attempt: number; conflicts: boolean };
      // Projected rather than compared whole: the payload also carries the merge-request ref and
      // the two ids, and an equality over those would be a test of the harness's fixture.
      return {
        outcome: payload.outcome,
        attempt: payload.attempt,
        conflicts: payload.conflicts,
      };
    });

describe('the rebase gate, before Ready and when the default branch moves', () => {
  it('passes a branch that applies, and re-arms on a signed default-branch delivery', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'rebase-clean',
      tickets: TICKETS,
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );
    // Before Ready: the gate ran once and passed, and no resolution run was spent on a branch that
    // applies — the property that keeps this feature off every task's bill.
    expect(waiting.stage_attempts.rebase_gate).toBe(1);
    expect(pipeline.specs.map((spec) => spec.stage)).not.toContain('conflict_resolution');
    // **The measurement is appended after the settlement, in a transaction of its own**, so
    // reaching `ready_for_merge` does not bound it: the wait is on the row the next assertion reads
    // (standing rule 50).
    await pipeline.waitFor(
      'the rebase gate’s first check to be recorded',
      async () => (await rebaseChecks(pipeline)).length >= 1,
    );
    expect(await rebaseChecks(pipeline)).toEqual([
      { outcome: 'clean', attempt: 0, conflicts: false },
    ]);

    // …and again whenever the default branch moved, through the door production has: a signed
    // delivery on the unauthenticated webhook route.
    const response = await pipeline.deliverGit(
      pipeline.git.emitDefaultBranchMoved({ project: GIT_PROJECT, newHead: 'd'.repeat(40) }),
    );
    expect(response.status).toBe(202);

    const rearmed = await pipeline.settle(
      'the rebase gate a second time',
      (task) => (task.stage_attempts.rebase_gate ?? 0) >= 2 && task.state === 'ready_for_merge',
    );
    /**
     * **The re-check spends its own loop, and not a human round** (WP-26).
     *
     * Both counters, because "the right one moved" and "the wrong one did not" are two facts
     * (standing rule 42). Before this work package the edge spent `human_rounds`, whose ceiling is
     * BD-008's three — so a fourth merge to `main` under a waiting merge request escalated the task
     * with *"human_rounds iteration limit of 3 reached: main moved to …"*.
     */
    expect(rearmed.iteration_counters.rebase_rechecks).toBe(1);
    expect(rearmed.iteration_counters.human_rounds).toBeUndefined();
    // Still no resolution run: the branch still applies.
    expect(pipeline.specs.map((spec) => spec.stage)).not.toContain('conflict_resolution');
    await pipeline.waitFor(
      'the re-check to be recorded',
      async () => (await rebaseChecks(pipeline)).length >= 2,
    );
    expect((await rebaseChecks(pipeline)).map((check) => check.outcome)).toEqual([
      'clean',
      'clean',
    ]);
  }, 180_000);

  it('resolves a conflict in one short run, re-runs CI and reaches Ready', async () => {
    let instance: PipelineE2E | undefined;
    const pipeline = await startPipeline({
      scenarios: (world) => ({
        ...featureScenarios(world),
        conflict_resolution: RESOLUTION_NOTES(world),
      }),
      label: 'rebase-resolve',
      tickets: TICKETS,
      agent: 'real-over-fake-cli',
      /**
       * The merge request conflicts until the resolution run starts, and applies afterwards — which
       * is what a run that really merged the default branch in would produce. The flip is made
       * **from inside the run's own provisioning**, so the gate's next evaluation is ordered after
       * it by construction rather than by a sleep.
       */
      onAgentSpec: (spec) => {
        if (spec.stage === 'conflict_resolution' && instance !== undefined) {
          instance.git.setMergeability({
            project: GIT_PROJECT,
            iid: instance.world.mr.iid,
            mergeable: true,
            hasConflicts: false,
          });
        }
      },
    });
    harness = pipeline;
    instance = pipeline;
    pipeline.git.setMergeability({
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      mergeable: false,
      hasConflicts: true,
    });

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );

    // One attempt, and the loop it spent is the rebase loop.
    expect(waiting.iteration_counters.rebase).toBe(1);
    expect(waiting.stage_attempts.conflict_resolution).toBe(1);
    // **CI was re-run through the gate the platform already has** (product/04 S6b), which is what
    // putting the stage before `ci_gate` buys: the CI gate ran twice, and the second time on the
    // provider's pipeline rather than on a local command no run may execute (PROGRESS backlog 49).
    expect(waiting.stage_attempts.ci_gate).toBe(2);
    const statusReads = (await pipeline.auditRows()).filter(
      (row) => row.action === 'get_pipeline_status',
    );
    expect(statusReads.length).toBeGreaterThanOrEqual(2);

    // The metric product/16 asks for, as events rather than as an inference over prose — waited for
    // rather than inferred from the task's state, because it is appended after the settlement.
    await pipeline.waitFor(
      'both rebase checks to be recorded',
      async () => (await rebaseChecks(pipeline)).length >= 2,
    );
    expect(await rebaseChecks(pipeline)).toEqual([
      { outcome: 'conflicted', attempt: 0, conflicts: true },
      { outcome: 'resolved', attempt: 1, conflicts: false },
    ]);

    /**
     * **The conflict instruction reached the model** — asserted on the bytes the CLI received
     * (standing rule 82), which is the only artefact the fake runner could not have produced.
     */
    const run = pipeline.agentRuns.find((entry) => entry.stage === 'conflict_resolution');
    expect(run).toBeDefined();
    const stdin = JSON.stringify(run?.cli.stdin);
    expect(stdin).toContain('This run resolves a merge conflict');
    // The one sentence that is a *measurement* rather than advice: a rebase cannot be published
    // under product/19 §3's block list, so the platform tells the run to merge (Q76).
    expect(stdin).toContain('Merge, do not rebase');
    // The exact spellings the stage may run, in the prompt rather than left to be guessed: any
    // other merge form falls to the command policy's `ask` fallback and costs an attempt (TD-027).
    expect(stdin).toContain('git merge --no-edit origin/<default branch>');
    // And the ticket is still there, so the narrowing did not replace the task's own context.
    expect(stdin).toContain('Show the totals in the invoice footer');

    /**
     * **The stage's command layer survived the production composition** (TD-027). The four merge
     * spellings are on the `conflict_resolution` run's policy and on **no other stage's** — the
     * property the unit tier asserts over `commandBaselineFor`, re-asked here of the `RunSpec` a
     * real `apps/server` built and handed to the CLI, because the layer is applied in the planner
     * and a composition that dropped the stage id would look identical from inside the ring.
     */
    const allowOf = (stage: string) =>
      pipeline.specs.find((spec) => spec.stage === stage)?.commandPolicy.allow ?? [];
    expect(allowOf('conflict_resolution')).toContain('git merge --no-edit origin/*');
    expect(allowOf('implementation')).not.toContain('git merge --no-edit origin/*');
    expect(allowOf('implementation').filter((entry) => entry.startsWith('git merge'))).toEqual([]);
  }, 240_000);

  it('escalates after the bounded number of attempts, and says which loop it spent', async () => {
    const pipeline = await startPipeline({
      scenarios: (world) => ({
        ...featureScenarios(world),
        conflict_resolution: RESOLUTION_NOTES(world),
      }),
      label: 'rebase-exhausted',
      tickets: TICKETS,
    });
    harness = pipeline;
    // A branch that conflicts every time, however often it is resolved.
    pipeline.git.setMergeability({
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      mergeable: false,
      hasConflicts: true,
    });

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    const parked = await pipeline.settle('needs_human', (task) => task.state === 'needs_human');

    // product/04 S6b: "bounded, default 2 attempts", and the counter never passes its limit.
    expect(parked.current_stage).toBe('rebase_gate');
    expect(parked.iteration_counters.rebase).toBe(2);
    expect(pipeline.specs.filter((spec) => spec.stage === 'conflict_resolution')).toHaveLength(2);
    // The implementation stage ran **once**: a conflict no longer re-does the ticket at
    // `implementation`'s price, which is what the stage exists for.
    expect(pipeline.specs.filter((spec) => spec.stage === 'implementation')).toHaveLength(1);

    const events = await pipeline.events();
    const escalated = events.find((event) => event.type === 'task.escalated');
    const reason = (escalated?.payload as { reason?: string } | undefined)?.reason ?? '';
    expect(reason).toContain('rebase iteration limit of 2 reached');
    await pipeline.waitFor(
      'all three rebase checks to be recorded',
      async () => (await rebaseChecks(pipeline)).length >= 3,
    );
    expect((await rebaseChecks(pipeline)).map((check) => check.outcome)).toEqual([
      'conflicted',
      'conflicted',
      'exhausted',
    ]);
  }, 240_000);
});

describe('conflict warnings between concurrent tasks (product/04 S6b, BD-030)', () => {
  it('warns about the task that touches the same file, and says nothing about the one that does not', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'rebase-warn',
      tickets: TICKETS,
    });
    harness = pipeline;

    /**
     * Two peers, each with a merge request of its own, inserted as **rows**.
     *
     * The feature under test is the *comparison*, not the creation of a second task: the harness
     * scripts one `ImplementationNotes` per stage, so two tasks driven through the pipeline would
     * both claim the same merge request. A row with an `mr_ref` is exactly what the duty reads.
     */
    const peer = async (key: string, files: readonly string[]): Promise<string> => {
      const mr = await pipeline.git.openMergeRequest({
        project: GIT_PROJECT,
        branch: `agentic/${key.toLowerCase()}`,
        target: 'main',
        title: `Draft: ${key}`,
        description: 'Opened by another task.',
        draft: true,
        labels: [],
        reviewers: [],
        remove_source_branch: true,
      });
      pipeline.git.setDiff({
        project: GIT_PROJECT,
        iid: mr.ref.iid,
        files: files.map((path) => ({ path })),
      });
      const rows = await pipeline.query<{ id: string }>(
        `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode,
                            state, current_stage, priority, template_snapshot, branch, mr_ref,
                            stage_attempts, iteration_limits, iteration_counters, cost_actual)
         values ($1, 'fake-task-management', $2, $3, 'feature', 'normal', 'ready_for_merge',
                 'ready_for_merge', 'High', '{"stages":[{"id":"intake","kind":"system"}]}'::jsonb,
                 $4, $5::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0)
         returning id`,
        [
          pipeline.projectId,
          key,
          `https://tickets.example.test/browse/${key}`,
          `agentic/${key.toLowerCase()}`,
          JSON.stringify({
            provider: 'fake-git',
            project_path: GIT_PROJECT,
            iid: mr.ref.iid,
            url: mr.web_url,
            branch: `agentic/${key.toLowerCase()}`,
            head_sha: mr.head_sha,
          }),
        ],
      );
      return rows[0]?.id ?? '';
    };

    // The task under test changes `src/totals.ts`; one peer changes it too and the other does not.
    pipeline.git.setDiff({
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      files: [{ path: 'src/totals.ts' }, { path: 'src/footer.ts' }],
    });
    const overlapping = await peer('ACME-98', ['src/totals.ts', 'src/vat.ts']);
    await peer('ACME-99', ['docs/readme.md']);

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

    // The wait is on the **event the assertions read**, not on the provider call that precedes it
    // (standing rule 50): the duty posts the thread and appends the event afterwards.
    await pipeline.waitFor('the conflict warning to be recorded', async () => {
      const events = await pipeline.events();
      return events.some((event) => event.type === 'task.conflict.warned');
    });

    const warned = (await pipeline.events())
      .filter((event) => event.type === 'task.conflict.warned')
      .map((event) => event.payload as Record<string, unknown>);
    // Exactly one: the overlapping peer, and not the one that shares nothing (standing rule 42).
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({
      other_task_id: overlapping,
      other_ticket_key: 'ACME-98',
      paths: ['src/totals.ts'],
      path_count: 1,
      truncated: false,
    });

    // …and the human-visible half: one thread on this task's own merge request, naming the other
    // ticket and the shared file and nothing else.
    const threads = await pipeline.git.listDiscussions({
      provider: 'fake-git',
      project_path: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      url: pipeline.world.mr.url,
    });
    const bodies = threads.flatMap((thread) => thread.notes.map((note) => note.body));
    const warnings = bodies.filter((body) => body.includes('agentic:conflict-warning'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ACME-98');
    expect(warnings[0]).toContain('src/totals.ts');
    expect(warnings[0]).not.toContain('ACME-99');
    expect(warnings[0]).not.toContain('src/footer.ts');

    /**
     * The read is audited like every other provider call, and it is bounded: this task's diff plus
     * one per peer, never one per task in the project.
     *
     * **Four since WP-38, three of them of this task's own merge request** (rule 83, and the count
     * PROGRESS backlog 64 is about): the dependency gate reads the diff when the Developer stage
     * completes, and the rebase gate's two duties — this warning and WP-37's classification — each
     * read it again. The fourth is the peer's, which is the one this test is actually about.
     */
    const diffReads = (await pipeline.auditRows()).filter(
      (row) => row.action === 'get_merge_request_diff',
    );
    expect(diffReads).toHaveLength(4);

    /**
     * **And the board's half** — product/04 S6b's *"the board warns when two active tasks touch
     * the same files"*, which until WP-41 reached no screen at all (PROGRESS backlog 63).
     *
     * The field is a projection over this task's own event stream (`conflictsFor`), so it is read
     * back through the real API rather than computed here. The wait above already binds the event
     * the projection reads, which is what makes this assertion safe to make immediately after it
     * (standing rule 87).
     */
    const client = new Client(pipeline.instance.baseUrl);
    const signedIn = await client.post('/api/auth/sign-in/email', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD,
    });
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    const page = await client.json<{
      items: readonly {
        ticket: { key: string };
        conflict: { other_ticket_key: string; path_count: number; truncated: boolean } | null;
      }[];
    }>(`/api/projects/${pipeline.projectId}/tasks`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);

    const warnedCard = page.body.items.find((item) => item.ticket.key === 'ACME-1');
    expect(warnedCard?.conflict).toEqual({
      other_task_id: overlapping,
      other_ticket_key: 'ACME-98',
      path_count: 1,
      truncated: false,
      warned_at: expect.any(String),
    });
    // Both directions (rule 42): the peer that shares nothing carries no badge, and neither does
    // the task that was compared *against* — the comparison is not symmetric (backlog 65) and the
    // board must not imply otherwise.
    expect(
      page.body.items.filter((item) => item.conflict !== null).map((item) => item.ticket.key),
    ).toEqual(['ACME-1']);
  }, 180_000);
});
