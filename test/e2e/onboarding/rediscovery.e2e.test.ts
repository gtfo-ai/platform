/**
 * **WP-94 criterion 1: a maintainer's re-evaluate runs discovery again, under the admission guard
 * and the cost ledger, and a project's level rises when a carried criterion now passes**
 * (PROGRESS backlog 230, Q107 (a)).
 *
 * Every step is a request to a real `apps/server` instance; the doubles are technical/10's two (the
 * model, scripted per task, and the providers). Every assertion is on a row the platform wrote
 * (rule 79), and every wait binds the row it asserts (rule 87).
 *
 * The fixture's arithmetic, so the numbers can be checked by hand:
 *
 *  - the **first** discovery's scripted draft reports R1 failing (the suite is red), so the
 *    evaluation is **level 0** — R1 is a level-1 requirement, and it is one of the seven criteria
 *    the post-merge re-check carries and never re-answers;
 *  - the project then fixes its suite. A merge could not raise the level — R1 needs a run — which is
 *    backlog 230. The maintainer presses re-evaluate: a **new** discovery task, whose scripted
 *    draft reports R1–R7, R10, R13 and R14 passing and R8 failing. With R9 answered by the platform
 *    from the fake git provider (protected) and R12 failing (the vault is not complete), the
 *    re-evaluation is **level 2** — R8 and R12 are the level-3 criteria missing;
 *  - finally the project's budget is spent and a third re-evaluation is pressed: the task is
 *    created and the stage executor's **admission guard** refuses its run — no `runs` row, no ledger
 *    row — which is what "every guard the first run had" means in a countable form.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  DiscoveryDraftData,
  ReadinessResponse,
  RediscoveryGateResponse,
} from '@platform/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scratchGitEnv } from '../../../scripts/git-scratch-env.mjs';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { TICKETS } from '../support/scenarios.js';

const execFileAsync = promisify(execFile);

const draft = (passing: readonly string[], failing: readonly string[]): DiscoveryDraftData => ({
  documents: [],
  commands: [{ purpose: 'test', command: 'npm test', verified: true, evidence: 'ran it' }],
  linked_documents: [],
  questions: [],
  readiness: [
    ...passing.map((id) => ({
      id,
      passed: true,
      evidence: `the scripted draft says ${id} passes`,
    })),
    ...failing.map((id) => ({
      id,
      passed: false,
      evidence: `the scripted draft says ${id} fails`,
    })),
  ],
});

/** The first look: the suite is red, so R1 fails and the project is level 0. */
const FIRST = draft(['R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R10', 'R13', 'R14'], ['R1', 'R8']);
/** After the fix: every agent criterion but R8 passes. */
const AGAIN = draft(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R10', 'R13', 'R14'], ['R8']);

let harness: PipelineE2E | undefined;
let workspace: string;
let mirrorRoot: string;
let repo: string;

const git = async (args: readonly string[]): Promise<string> => {
  // WP-162: every repository this file builds is under `workspace`; no inherited `GIT_*`.
  const { stdout } = await execFileAsync('git', [...args], {
    env: scratchGitEnv(workspace),
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
};

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'wp94-rediscovery-'));
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

const signIn = async (baseUrl: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

const send = async <T>(
  client: Client,
  target: string,
  key?: string,
): Promise<{ status: number; body: T }> =>
  client.json<T>(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    body: '{}',
  });

describe('a maintainer’s re-evaluate', () => {
  it('runs discovery again under the guard and the ledger, and the level rises', async () => {
    /** The first discovery's task, once known: every other discovery run gets the second draft. */
    let firstTask: string | null = null;
    const pipeline = await startPipeline({
      label: 'rediscovery',
      tickets: TICKETS,
      gitProjects: [repo.replace(/^\/+/, '')],
      scenarios: () => ({ discovery: { structuredOutput: FIRST, costUsd: 0.6 } }),
      scenarioFor: (spec) =>
        spec.stage === 'discovery' && firstTask !== null && spec.taskId !== firstTask
          ? { structuredOutput: AGAIN, costUsd: 0.7 }
          : undefined,
      env: { APP_KNOWLEDGE_MIRROR_ROOT: mirrorRoot },
    });
    harness = pipeline;
    await pipeline.query('update projects set repo_url = $1 where id = $2', [
      `file://${repo}`,
      pipeline.projectId,
    ]);
    const projectId = pipeline.projectId;
    const client = await signIn(pipeline.instance.baseUrl);
    const rowsOf = async (source: string) =>
      pipeline.query<{ id: string; level: number }>(
        'select id, level from readiness_evaluations where project_id = $1 and source = $2 order by evaluated_at',
        [projectId, source],
      );
    const gate = async (): Promise<RediscoveryGateResponse> => {
      const response = await client.json<RediscoveryGateResponse>(
        `/api/projects/${projectId}/rediscovery`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body;
    };

    // Before anything: the gate names why the button is off.
    expect((await gate()).blocker?.code).toBe('discovery_not_started');

    // ── The first discovery: level 0 ─────────────────────────────────────────
    const first = await send<{ task_id: string }>(
      client,
      `/api/projects/${projectId}/discovery`,
      'wp94-first',
    );
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    firstTask = first.body.task_id;
    await pipeline.waitFor(
      'the first evaluation',
      async () => (await rowsOf('discovery')).length > 0,
    );
    expect((await rowsOf('discovery')).map((row) => row.level)).toEqual([0]);
    await pipeline.waitFor('the first discovery task to end', async () => {
      const rows = await pipeline.query<{ state: string }>(
        'select state::text as state from tasks where id = $1',
        [firstTask],
      );
      return rows[0]?.state === 'done';
    });

    // The gate: the ceiling is the stage's run budget, and the last discovery's cost is measured.
    const open = await gate();
    expect(open.can_start).toBe(true);
    expect(open.ceiling_usd).toBe(2);
    expect(open.last_discovery).toMatchObject({ task_id: firstTask, state: 'done' });
    expect(open.last_discovery?.cost_usd).toBeCloseTo(0.6, 6);

    // The first start is still idempotent on the project: pressing it again runs nothing.
    const repeated = await send<{ started: boolean }>(
      client,
      `/api/projects/${projectId}/discovery`,
      'wp94-first-again',
    );
    expect(repeated.body.started).toBe(false);

    // ── The re-evaluate: a new task, one stage, the ledger, a higher level ──
    const unkeyed = await send<{ error: { code: string } }>(
      client,
      `/api/projects/${projectId}/rediscovery`,
    );
    expect(unkeyed.status).toBe(400);
    expect(unkeyed.body.error.code).toBe('idempotency_key_required');

    const again = await send<{ task_id: string; started: boolean }>(
      client,
      `/api/projects/${projectId}/rediscovery`,
      'wp94-again',
    );
    expect(again.status, JSON.stringify(again.body)).toBe(202);
    expect(again.body.started).toBe(true);
    const secondTask = again.body.task_id;
    expect(secondTask).not.toBe(firstTask);

    await pipeline.waitFor(
      'the re-evaluation’s evaluation',
      async () => (await rowsOf('rediscovery')).length > 0,
    );
    const [recorded] = await rowsOf('rediscovery');
    expect(recorded?.level).toBe(2);
    // The first record stands beside it.
    expect((await rowsOf('discovery')).map((row) => row.level)).toEqual([0]);

    // One run of the discovery stage on the new task…
    const runs = await pipeline.query<{ id: string; role: string; mode: string }>(
      'select id, role::text as role, mode::text as mode from runs where task_id = $1',
      [secondTask],
    );
    expect(runs.map((run) => [run.role, run.mode])).toEqual([['discovery', 'discovery']]);
    // …charged to the ledger like every run (the handler commits with the event: wait for the row).
    await pipeline.waitFor('the re-evaluation’s ledger row', async () =>
      (await pipeline.costRows()).entries.some((entry) => entry.run_id === runs[0]?.id),
    );
    const charged = (await pipeline.costRows()).entries.filter(
      (entry) => entry.task_id === secondTask,
    );
    expect(charged.map((entry) => entry.stage)).toEqual(['discovery']);
    expect(charged.reduce((total, entry) => total + entry.usd, 0)).toBeCloseTo(0.7, 6);

    // The level the board reads moved with the row, and the endpoint names who recorded it.
    await pipeline.waitFor('the re-evaluation to be the latest', async () => {
      const response = await client.json<ReadinessResponse>(`/api/projects/${projectId}/readiness`);
      return response.status === 200 && response.body.source === 'rediscovery';
    });
    const readiness = await client.json<ReadinessResponse>(`/api/projects/${projectId}/readiness`);
    expect(readiness.body.level).toBe(2);
    expect(readiness.body.criteria.find((criterion) => criterion.id === 'R1')).toMatchObject({
      passed: true,
      detected_by: 'agent',
    });
    expect(
      await pipeline.query('select readiness_level from projects where id = $1', [projectId]),
    ).toEqual([{ readiness_level: 2 }]);
    // One event per recorded row, naming its producer (backlog 228's rule, a third source).
    const events = await pipeline.query<{ source: string }>(
      "select payload->>'source' as source from events where type = 'readiness.evaluated' and stream_id = $1 order by position",
      [projectId],
    );
    expect(events.map((event) => event.source)).toContain('rediscovery');

    // Audited once, with the ceiling the maintainer spent against.
    const audited = await pipeline.query<{ params: Record<string, unknown> }>(
      "select params from human_actions where action = 'project.discovery.rerun'",
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]?.params).toMatchObject({ task_id: secondTask, ceiling_usd: 2 });

    // ── The admission guard: a spent budget refuses the next run ────────────
    await pipeline.waitFor('the re-evaluation task to end', async () => {
      const rows = await pipeline.query<{ state: string }>(
        'select state::text as state from tasks where id = $1',
        [secondTask],
      );
      return rows[0]?.state === 'done';
    });
    await pipeline.seedBudget({ scope: 'project', window: 'month', limitUsd: 5, spentUsd: 5 });
    const refused = await send<{ task_id: string; started: boolean }>(
      client,
      `/api/projects/${projectId}/rediscovery`,
      'wp94-over-budget',
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(202);
    const thirdTask = refused.body.task_id;
    await pipeline.waitFor('the admission guard to pause the third task', async () => {
      const rows = await pipeline.query<{ state: string }>(
        'select state::text as state from tasks where id = $1',
        [thirdTask],
      );
      return rows[0]?.state === 'paused';
    });
    expect(
      await pipeline.query('select count(*)::int as count from runs where task_id = $1', [
        thirdTask,
      ]),
    ).toEqual([{ count: 0 }]);
    expect(
      (await pipeline.costRows()).entries.filter((entry) => entry.task_id === thirdTask),
    ).toEqual([]);
    // …and while it is parked, the gate says so rather than offering a fourth run.
    const blocked = await gate();
    expect(blocked.can_start).toBe(false);
    expect(blocked.blocker).toMatchObject({ code: 'discovery_in_flight', task_id: thirdTask });
  }, 300_000);
});
