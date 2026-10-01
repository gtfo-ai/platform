/**
 * **A discovery task whose `stage.execute` enqueue was lost runs once, by the recovery pass** —
 * PROGRESS backlog **320**, WP-108's criterion (2), against a whole `apps/server` instance on
 * PostgreSQL and real pg-boss.
 *
 * ## The loss, and the seam that reproduces it
 *
 * `POST /api/projects/:id/discovery` commits the discovery task and the saga enqueues its one agent
 * stage after the commit, at-most-once (TD-004). A process that dies in between leaves the task
 * `active` at `discovery` with no job and no run — and before WP-108 nothing ever moved it, and the
 * re-evaluate gate refused every later run with `discovery_in_flight`.
 *
 * Killing the process at that boundary is not a test; dropping the enqueue is the same loss,
 * deterministically, through `PipelineComposition.jobs` — the seam `intake-recovery.e2e.test.ts`
 * and `dependency-gate-recovery.e2e.test.ts` use. It drops **one** `stage.execute` for the
 * discovery stage — the saga's — because the recovery's re-enqueue is a second, and a seam that
 * swallowed every one would test that the pipeline cannot work rather than that the recovery does.
 *
 * The recovery pass runs at the floor the setting allows (one second between passes, and the age a
 * stage entry must reach), so the stranded row's grace has passed by the second pass.
 *
 * Every wait binds the last rows the recovered run writes (standing rule 87): the evaluation the
 * `onboarding.discovery` job records from the run's artifact, and the task's `done`, which the saga
 * writes on the stage's completion — the two are written by different transactions in no fixed
 * order, so the wait is on both.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { EnqueueRequest, Jobs } from '@platform/application';
import type { DiscoveryDraftData } from '@platform/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { TICKETS } from '../support/scenarios.js';

const execFileAsync = promisify(execFile);

const DRAFT: DiscoveryDraftData = {
  documents: [],
  commands: [{ purpose: 'test', command: 'npm test', verified: true, evidence: 'ran it' }],
  linked_documents: [],
  questions: [],
  readiness: [{ id: 'R1', passed: true, evidence: 'the scripted draft says R1 passes' }],
};

let harness: PipelineE2E | undefined;
let workspace: string;
let mirrorRoot: string;
let repo: string;

const git = async (args: readonly string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', [...args], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
};

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'wp108-discovery-recovery-'));
  mirrorRoot = path.join(workspace, 'mirrors');
  repo = path.join(workspace, 'fixture-repo');
  await mkdir(mirrorRoot, { recursive: true });
  await mkdir(path.join(repo, '.agentic/knowledge'), { recursive: true });
  await git(['init', '-q', '-b', 'main', repo]);
  await writeFile(path.join(repo, 'README.md'), '# fixture repository\n');
  await writeFile(
    path.join(repo, '.agentic/knowledge/index.md'),
    '---\nid: index\ntitle: Index\ntype: reference\nkind: technical\nscope: project\n---\n\nThe map.\n',
  );
  await git(['-C', repo, 'add', '-A']);
  await git([
    '-C',
    repo,
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'user.name=Fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'the fixture repository',
  ]);
}, 120_000);

afterAll(async () => {
  await harness?.stop();
  harness = undefined;
  await rm(workspace, { recursive: true, force: true });
});

interface Seam {
  /** The discovery stage's `stage.execute` wake-ups swallowed — at most one. */
  readonly dropped: EnqueueRequest[];
}

const seamOver = (seam: Seam) => (jobs: Jobs) => ({
  ...jobs,
  enqueue: async <TData extends Record<string, unknown>>(request: {
    queue: string;
    data?: TData;
  }) => {
    const stage = (request.data as { stage?: string } | undefined)?.stage;
    if (request.queue === 'stage.execute' && stage === 'discovery' && seam.dropped.length === 0) {
      seam.dropped.push(request as EnqueueRequest);
      return { status: 'enqueued' as const, jobId: 'dropped-on-the-floor' };
    }
    return jobs.enqueue(request as never);
  },
});

describe('a discovery task whose stage wake-up was lost (backlog 320)', () => {
  it('is re-enqueued once by the recovery pass, runs once, and records its evaluation', async () => {
    const seam: Seam = { dropped: [] };
    const pipeline = await startPipeline({
      label: 'discovery-recovery',
      tickets: TICKETS,
      gitProjects: [repo.replace(/^\/+/, '')],
      scenarios: () => ({ discovery: { structuredOutput: DRAFT, costUsd: 0.4 } }),
      jobs: seamOver(seam),
      env: { APP_KNOWLEDGE_MIRROR_ROOT: mirrorRoot, APP_INTAKE_RECONCILE_INTERVAL_MS: '1000' },
    });
    harness = pipeline;
    await pipeline.query('update projects set repo_url = $1 where id = $2', [
      `file://${repo}`,
      pipeline.projectId,
    ]);
    const projectId = pipeline.projectId;
    const client = new Client(pipeline.instance.baseUrl);
    const signedIn = await client.post('/api/auth/sign-in/email', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD,
    });
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);

    const started = await client.json<{ task_id: string; started: boolean }>(
      `/api/projects/${projectId}/discovery`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'wp108-discovery' },
        body: '{}',
      },
    );
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    expect(started.body.started).toBe(true);
    const taskId = started.body.task_id;

    const stateOf = async (): Promise<string | undefined> =>
      (
        await pipeline.query<{ state: string }>(
          'select state::text as state from tasks where id = $1',
          [taskId],
        )
      )[0]?.state;
    const evaluations = async (): Promise<number> =>
      (
        await pipeline.query<{ count: number }>(
          'select count(*)::int as count from readiness_evaluations where project_id = $1',
          [projectId],
        )
      )[0]?.count ?? 0;

    await pipeline.waitFor(
      'the recovered discovery run’s evaluation and the task’s done (the last two rows it writes)',
      async () => (await evaluations()) > 0 && (await stateOf()) === 'done',
    );

    // The saga's wake-up was dropped — so what ran was the recovery's.
    expect(seam.dropped.map((request) => request.data)).toEqual([
      expect.objectContaining({ task_id: taskId, stage: 'discovery', attempt: 1 }),
    ]);
    // Once: one run of the discovery stage on the task.
    expect(
      await pipeline.query<{ role: string; status: string }>(
        'select role::text as role, status::text as status from runs where task_id = $1',
        [taskId],
      ),
    ).toEqual([{ role: 'discovery', status: 'completed' }]);
    // The recovery's mark is on the task, for this entry, and nothing escalated it.
    const marked = await pipeline.query<{ marked: boolean; entered: boolean }>(
      `select t.stage_recovery_attempted_at is not null as marked,
              t.stage_recovery_attempted_at >= s.entered_at as entered
         from tasks t join task_stages s on s.task_id = t.id and s.stage = 'discovery'
        where t.id = $1`,
      [taskId],
    );
    expect(marked).toEqual([{ marked: true, entered: true }]);
    expect(
      await pipeline.query(
        "select count(*)::int as count from events where stream_id = $1 and type = 'task.escalated'",
        [taskId],
      ),
    ).toEqual([{ count: 0 }]);
    expect(await evaluations()).toBe(1);
  }, 300_000);
});
