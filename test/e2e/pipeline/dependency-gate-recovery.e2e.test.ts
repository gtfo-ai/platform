/**
 * **A deferred dependency-gate ending whose wake-up was lost is performed by the recovery pass** —
 * PROGRESS backlog **240**, WP-84's criterion (1), against a whole `apps/server` instance on
 * PostgreSQL.
 *
 * ## The loss, and the seam that reproduces it
 *
 * WP-67 defers a gate `ask` that met a task a person had paused (`tasks.dependencies.deferred_stage`)
 * and performs it from the `task.resumed` handler, which enqueues the `dependency_gate_resume` duty
 * through `HandlerContext.afterCommit` — at-most-once (TD-004). A process that dies between the
 * resume's commit and that enqueue leaves an `active` task carrying a question nobody will ask.
 *
 * Killing a process at that boundary is not a test; dropping the enqueue is the same loss,
 * deterministically, through `PipelineComposition.jobs` — the labelled seam
 * `intake-recovery.e2e.test.ts` uses. It drops **one** `dependency_gate_resume` — the handler's —
 * because the recovery's own re-enqueue is a second, and a seam that swallowed every one would be
 * testing that the pipeline cannot work rather than that the recovery does.
 *
 * ## Putting the task where the deferral happens
 *
 * The gate's decision must meet a paused task. The seam **holds** the first `dependency_gate`
 * wake-up, the test pauses the task through the real route, and then releases the held wake-up into
 * the real queue — so the gate decides against a task that is `paused`, which is the deferral. The
 * CI stays `running` so the task rests at the CI gate, `active`, between the steps (the reason
 * `dependency-gate.e2e.test.ts` gives for its first case).
 *
 * Every wait binds the last row the step writes (standing rule 87): the deferral is the record's
 * `deferred_stage`, and the recovery's effect is the question row the duty writes in the same
 * transaction that clears it.
 */
import type { EnqueueRequest, Jobs } from '@platform/application';
import type { TaskDependencies } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { GIT_PROJECT, inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const patch = (path: string, ...lines: readonly string[]): string =>
  [`--- a/${path}`, `+++ b/${path}`, '@@ -1,4 +1,5 @@', ...lines].join('\n');

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
];

interface Seam {
  /** The first `dependency_gate` wake-up, held until the test releases it. */
  held: EnqueueRequest | null;
  /** The `dependency_gate_resume` wake-ups swallowed — at most one. */
  readonly dropped: EnqueueRequest[];
  /** The real queue, for releasing the held wake-up into. */
  real: Jobs | null;
}

const seamOver = (seam: Seam) => (jobs: Jobs) => {
  seam.real = jobs;
  return {
    ...jobs,
    enqueue: async <TData extends Record<string, unknown>>(request: {
      queue: string;
      data?: TData;
    }) => {
      const duty = (request.data as { duty?: string } | undefined)?.duty;
      if (duty === 'dependency_gate' && seam.held === null) {
        seam.held = request as EnqueueRequest;
        return { status: 'enqueued' as const, jobId: 'held-by-the-test' };
      }
      if (duty === 'dependency_gate_resume' && seam.dropped.length === 0) {
        seam.dropped.push(request as EnqueueRequest);
        return { status: 'enqueued' as const, jobId: 'dropped-on-the-floor' };
      }
      return jobs.enqueue(request as never);
    },
  };
};

const dependenciesOf = async (pipeline: PipelineE2E): Promise<TaskDependencies | null> =>
  (
    await pipeline.query<{ dependencies: TaskDependencies | null }>(
      'select dependencies from tasks where project_id = $1 limit 1',
      [pipeline.projectId],
    )
  )[0]?.dependencies ?? null;

describe('a deferred dependency question whose resume wake-up was lost (backlog 240)', () => {
  it('is asked by the recovery pass, once, and the task waits for the answer', async () => {
    const seam: Seam = { held: null, dropped: [], real: null };
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'dependency-recovery',
      tickets: TICKETS,
      config: { version: 1, policies: { dependency_policy: 'ask' } },
      ciStatus: null,
      jobs: seamOver(seam),
      // The floor the setting allows: one second between passes, and the age a resume must reach.
      env: { APP_INTAKE_RECONCILE_INTERVAL_MS: '1000' },
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

    await pipeline.publish([
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
      }),
    ]);
    await pipeline.waitFor('the gate’s wake-up to be held', async () => seam.held !== null);
    const task = await pipeline.task();

    const client = new Client(pipeline.instance.baseUrl);
    const signedIn = await client.post('/api/auth/sign-in/email', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD,
    });
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    const paused = await client.post(`/api/tasks/${task.id}/pause`, {});
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);

    // The gate decides against the paused task: the question is deferred, not asked.
    await seam.real?.enqueue(seam.held as never);
    await pipeline.waitFor(
      'the dependency question to be deferred',
      async () => (await dependenciesOf(pipeline))?.deferred_stage === 'implementation',
    );
    expect((await dependenciesOf(pipeline))?.question_id).toBeNull();

    // The resume's wake-up is swallowed: exactly what a crash after its commit would cost.
    const resumed = await client.post(`/api/tasks/${task.id}/resume`, {});
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    await pipeline.waitFor(
      'the resume wake-up to be swallowed',
      async () => seam.dropped.length === 1,
    );

    // …and the recovery pass asks the question anyway: the row the duty writes in the transaction
    // that clears the deferral.
    await pipeline.waitFor('the deferred question to be asked', async () => {
      const record = await dependenciesOf(pipeline);
      return record?.question_id !== null && record?.question_id !== undefined;
    });
    const record = await dependenciesOf(pipeline);
    expect(record?.deferred_stage ?? null).toBeNull();
    const questions = await pipeline.query<{ text: string; status: string; stage: string }>(
      'select text, status, stage from questions where task_id = $1',
      [task.id],
    );
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ status: 'open', stage: 'implementation' });
    expect(questions[0]?.text).toContain('npm:lodash');
    await pipeline.settle(
      'waiting for the answer',
      (snapshot) => snapshot.state === 'waiting_answers',
    );

    // The mark that bounds it: one attempt for this resume, written by the pass.
    const marks = await pipeline.query<{ mark: string | null }>(
      'select dependency_recovery_attempted_at::text as mark from tasks where id = $1',
      [task.id],
    );
    expect(marks[0]?.mark).not.toBeNull();
    expect(seam.dropped).toHaveLength(1);
  }, 240_000);
});
