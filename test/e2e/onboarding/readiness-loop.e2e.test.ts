/**
 * **WP-64's loop, through a real `apps/server` instance: the interview raises the score and the
 * re-check notices** (PROGRESS backlogs 45 and 46).
 *
 * Every step is a request to the instance or a commit on a **real git repository on disk** that the
 * platform's own mirror reads (TD-026). The doubles are technical/10's two: the model (the fake
 * runner, scripted per stage) and the providers (the fake git and ticket providers). Every
 * assertion is on a row the platform wrote (rule 79), and every wait binds the row it asserts
 * (rule 87).
 *
 * The fixture's arithmetic, so the numbers below can be checked by hand:
 *
 *  - the repository starts with `index.md` and one technical page (`technical/how-to-run.md`), so
 *    discovery measures completeness **1/10**;
 *  - the discovery draft (scripted) claims every criterion but R8 — and claims R9 and R12 too,
 *    which the platform must ignore (criterion 5) — so the first evaluation is **level 2**: R8 and
 *    R12 are the two level-3 criteria missing;
 *  - the interview proposes the seven scored business pages (and the unscored communication page);
 *    a maintainer approves them, the platform opens its merge request, and the "merge" is this file
 *    committing exactly the bytes the platform proposed. Completeness is then **8/10 = 0.8**, above
 *    R12's 0.7 — asserted as the number (criterion 4) — and still level 2, because R8 is missing;
 *  - a **task** is then merged whose change adds a `CLAUDE.md` linking to the knowledge index. The
 *    re-check reads it at the merged commit and the level becomes **3** (criterion 1).
 *
 * The re-check is never called here. It is woken by the index run a merge causes, exactly as in
 * production (`onboarding/recheck.ts`): that is criterion 1's "not by calling the evaluator".
 *
 * **What this file cannot settle — criterion 6.** Whether a *real* discovery run drafts a business
 * page is a question about a model, and this tier's model is scripted; `pnpm eval` cannot run here
 * (the WP-17 blocker). The platform's side is asserted instead: the scripted draft's proposals are
 * all `technical/`, and the prompt now says so in as many words (`disc-drafts-no-business-page`).
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  BusinessInterviewResponse,
  DiscoveryDraftData,
  ReadinessResponse,
} from '@platform/contracts';
import {
  KNOWLEDGE_COMPLETENESS_SECTIONS,
  KNOWLEDGE_COMPLETENESS_THRESHOLD,
  knowledgeCompleteness,
} from '@platform/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import {
  inboundEvent,
  type PipelineE2E,
  type SeededWorld,
  startPipeline,
} from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

const execFileAsync = promisify(execFile);

/** Obviously fake (BD-002): the `gitlab-token` shape, so TD-012's pattern rules must find it. */
const PLANTED = 'glpat-FAKE-wp64-interview-credential-00';

const DISCOVERY_DRAFT: DiscoveryDraftData = {
  documents: [
    {
      path: 'technical/overview.md',
      title: 'How the fixture is laid out',
      confidence: 'medium',
      markdown: '# Overview\n\nOne service.\n',
    },
  ],
  commands: [{ purpose: 'test', command: 'npm test', verified: true, evidence: 'exit 0 in 40 s' }],
  linked_documents: [],
  questions: [{ id: 'q1', text: 'Who are the users?', blocking: false }],
  readiness: [
    ...['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R10', 'R13', 'R14'].map((id) => ({
      id,
      passed: true,
      evidence: `the scripted draft says ${id} passes`,
    })),
    { id: 'R8', passed: false, evidence: 'there is no CLAUDE.md' },
    // Ignored on the way in, and never carried by a re-check (criterion 5).
    { id: 'R9', passed: true, evidence: 'the model says the branch is protected' },
    { id: 'R12', passed: true, evidence: 'the model says the knowledge base is complete' },
  ],
};

/** The interview's answers: all eight sections, one of them carrying a planted credential. */
const ANSWERS = {
  product: { status: 'answered', text: 'Invoicing for small accountancies. Not a ledger.' },
  users: { status: 'answered', text: 'Bookkeepers who close the month on the last Friday.' },
  business_rules: {
    status: 'answered',
    text: `An issued invoice is never edited. Our old CI token was ${PLANTED}.`,
  },
  glossary: { status: 'answered', text: '**Posting** — one line of the ledger.' },
  direction: { status: 'answered', text: 'Grow to 500 firms; no payroll.' },
  quality_bar: { status: 'answered', text: 'Every change has a test.' },
  review: { status: 'answered', text: 'One approval; small merge requests.' },
  communication: { status: 'not_applicable', reason: 'We only use the ticket.' },
} as const;

let harness: PipelineE2E | undefined;
let workspace: string;
let mirrorRoot: string;
let repo: string;
let repoPath: string;

const git = async (args: readonly string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', [...args], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
};

const commitAll = async (message: string): Promise<string> => {
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
    message,
  ]);
  return git(['-C', repo, 'rev-parse', 'HEAD']);
};

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'wp64-readiness-'));
  mirrorRoot = path.join(workspace, 'mirrors');
  repo = path.join(workspace, 'fixture-repo');
  repoPath = repo.replace(/^\/+/, '');
  await mkdir(mirrorRoot, { recursive: true });
  await mkdir(path.join(repo, '.agentic/knowledge/technical'), { recursive: true });
  await git(['init', '-q', '-b', 'main', repo]);
  await writeFile(path.join(repo, 'README.md'), '# fixture repository\n');
  await writeFile(
    path.join(repo, '.agentic/knowledge/index.md'),
    '---\nid: index\ntitle: Index\ntype: reference\nkind: technical\nscope: project\n---\n\nThe map.\n',
  );
  await writeFile(
    path.join(repo, '.agentic/knowledge/technical/how-to-run.md'),
    '---\nid: how-to-run\ntitle: How to run\ntype: reference\nkind: technical\nscope: project\n---\n\n`npm test`.\n',
  );
  await commitAll('the fixture repository');
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
  body: unknown,
  key?: string,
): Promise<{ status: number; body: T }> =>
  client.json<T>(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    body: JSON.stringify(body),
  });

/** R12's number, read off the platform's own evidence sentence (`evaluate-readiness.ts`). */
const completenessOf = (readiness: ReadinessResponse): number => {
  const evidence = readiness.criteria.find((criterion) => criterion.id === 'R12')?.evidence ?? '';
  const match = /knowledge completeness is (\d+)%/.exec(evidence);
  expect(match, evidence).not.toBeNull();
  return Number(match?.[1]) / 100;
};

describe('the readiness loop', () => {
  it('raises completeness through the interview, and re-checks readiness after a merged task', async () => {
    /** The task's merge request, opened on the fixture's project once the instance is up. */
    let taskWorld: SeededWorld | null = null;
    const pipeline = await startPipeline({
      label: 'readiness-loop',
      tickets: TICKETS,
      gitProjects: [repoPath],
      scenarios: () => ({ discovery: { structuredOutput: DISCOVERY_DRAFT } }),
      scenarioFor: (spec) =>
        taskWorld === null || spec.stage === 'discovery'
          ? undefined
          : (featureScenarios(taskWorld) as Record<string, { structuredOutput: unknown }>)[
              spec.stage ?? ''
            ],
      env: { APP_KNOWLEDGE_MIRROR_ROOT: mirrorRoot },
    });
    harness = pipeline;
    // The seeded project points at the fixture repository on disk, which the mirror clones.
    await pipeline.query('update projects set repo_url = $1 where id = $2', [
      `file://${repo}`,
      pipeline.projectId,
    ]);
    const projectId = pipeline.projectId;
    const client = await signIn(pipeline.instance.baseUrl);
    const readiness = async (): Promise<ReadinessResponse> => {
      const response = await client.json<ReadinessResponse>(`/api/projects/${projectId}/readiness`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return response.body;
    };
    const rowsOf = async (source: string) =>
      pipeline.query<{ level: number }>(
        'select level from readiness_evaluations where project_id = $1 and source = $2 order by evaluated_at',
        [projectId, source],
      );
    /**
     * Re-check rows in which `criterion` passed — the row each wait below is about (rule 87). A
     * count of re-check rows alone would not do: the first index run of the project also re-checks
     * when it happens to finish after the discovery evaluation, and that row passes neither.
     */
    const rechecksPassing = async (criterion: string) =>
      pipeline.query<{ level: number }>(
        `select level from readiness_evaluations
          where project_id = $1 and source = 'recheck' and criteria @> $2::jsonb
          order by evaluated_at`,
        [projectId, JSON.stringify([{ id: criterion, passed: true }])],
      );

    // ── Step 2: discovery measures the repository as it is ──────────────────
    const started = await send<{ task_id: string }>(
      client,
      `/api/projects/${projectId}/discovery`,
      {},
      'wp64-discovery',
    );
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    await pipeline.waitFor(
      'the discovery evaluation',
      async () => (await rowsOf('discovery')).length > 0,
    );
    /**
     * The discovery **row**, not the endpoint's newest: the project's first index run re-checks when
     * it finishes after this evaluation (it read a commit it had not read), and on a loaded machine
     * that row can be the newest — one race apart, and both rows are the platform's.
     */
    const [discovered] = await pipeline.query<{
      level: number;
      criteria: { id: string; passed: boolean; evidence: string }[];
    }>(
      "select level, criteria from readiness_evaluations where project_id = $1 and source = 'discovery'",
      [projectId],
    );
    expect(discovered?.level).toBe(2);
    // R12 fails at discovery whatever the draft claimed: 1/10 when the index had read the fixture by
    // then, "not indexed" when it had not — the two are one race apart and both are the platform's.
    const r12AtDiscovery = discovered?.criteria.find((criterion) => criterion.id === 'R12');
    expect(r12AtDiscovery?.passed).toBe(false);
    expect(r12AtDiscovery?.evidence).not.toContain('the model says');
    expect((await readiness()).level).toBe(2);
    // Criterion 6, the platform's half: every page the (scripted) draft proposed is technical.
    const drafted = (await pipeline.proposals()).filter(
      (row) => row.task_id === started.body.task_id,
    );
    expect(drafted.map((row) => row.target_path)).toEqual([
      '.agentic/knowledge/technical/overview.md',
    ]);

    // ── Step 3: the business interview ───────────────────────────────────────
    const unkeyed = await send<{ error: { code: string } }>(
      client,
      `/api/projects/${projectId}/interview`,
      { answers: ANSWERS },
    );
    expect(unkeyed.status).toBe(400);
    expect(unkeyed.body.error.code).toBe('idempotency_key_required');

    const interviewed = await send<BusinessInterviewResponse>(
      client,
      `/api/projects/${projectId}/interview`,
      { answers: ANSWERS },
      'wp64-interview',
    );
    expect(interviewed.status, JSON.stringify(interviewed.body)).toBe(201);
    expect(interviewed.body.performed).toBe(true);
    expect(interviewed.body.pages.map((page) => page.target_path)).toEqual([
      '.agentic/knowledge/business/overview.md',
      '.agentic/knowledge/business/personas.md',
      '.agentic/knowledge/business/rules.md',
      '.agentic/knowledge/business/glossary.md',
      '.agentic/knowledge/business/direction.md',
      '.agentic/knowledge/business/quality-bar.md',
      '.agentic/knowledge/business/review-expectations.md',
      '.agentic/knowledge/business/communication.md',
    ]);

    // Criterion 3: the queue, never a commit — and redacted at the write.
    const human = await pipeline.query<{
      id: string;
      status: string;
      delta: string;
      source: string;
    }>(
      "select id, status::text as status, delta, source::text as source from kb_proposals where source = 'human' order by created_at, id",
    );
    expect(human).toHaveLength(8);
    expect(human.every((row) => row.status === 'queued')).toBe(true);
    expect(pipeline.git.commits.some((commit) => commit.branch === 'main')).toBe(false);
    const rules = human.find((row) => row.delta.includes('An issued invoice is never edited.'));
    expect(rules?.delta).not.toContain(PLANTED);
    expect(rules?.delta).toContain('[REDACTED');

    // Audited once, with no answer in the row.
    const audited = await pipeline.query<{ params: Record<string, unknown> }>(
      "select params from human_actions where action = 'project.interview.record'",
    );
    expect(audited).toHaveLength(1);
    expect(JSON.stringify(audited)).not.toContain('never edited');
    expect(JSON.stringify(audited)).not.toContain(PLANTED);

    // A replay writes nothing; a different body under the same key is refused.
    const replayed = await send<BusinessInterviewResponse>(
      client,
      `/api/projects/${projectId}/interview`,
      { answers: ANSWERS },
      'wp64-interview',
    );
    expect(replayed.status).toBe(200);
    expect(replayed.body.performed).toBe(false);
    expect(replayed.body.pages).toHaveLength(8);
    const reused = await send<{ error: { code: string } }>(
      client,
      `/api/projects/${projectId}/interview`,
      { answers: { product: { status: 'answered', text: 'something else' } } },
      'wp64-interview',
    );
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('idempotency_key_reused');
    expect(
      await pipeline.query(
        "select count(*)::int as count from kb_proposals where source = 'human'",
      ),
    ).toEqual([{ count: 8 }]);

    // ── Step 5: a maintainer accepts the pages; the platform proposes them as a merge request ──
    for (const row of human) {
      const decided = await send(
        client,
        `/api/projects/${projectId}/kb/proposals/${row.id}/approve`,
        { decision: 'approve' },
      );
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    }
    await pipeline.waitFor('the eight interview pages to be applied', async () => {
      const applied = await pipeline.query<{ count: number }>(
        "select count(*)::int as count from kb_proposals where source = 'human' and status = 'applied'",
      );
      return applied[0]?.count === 8;
    });
    const proposed = pipeline.git.commits.flatMap((commit) =>
      commit.files.filter((file) => file.path.startsWith('.agentic/knowledge/business/')),
    );
    expect(new Set(proposed.map((file) => file.path)).size).toBe(8);
    const knowledgeBranch = pipeline.git.commits.at(-1)?.branch ?? '';
    expect(knowledgeBranch).toMatch(/^agentic\/knowledge\//);

    // …and a reviewer merges it: the fixture's default branch gains exactly the proposed bytes.
    for (const file of proposed) {
      await mkdir(path.dirname(path.join(repo, file.path)), { recursive: true });
      await writeFile(path.join(repo, file.path), file.content);
    }
    await commitAll('Merge the onboarding interview');
    let knowledgeMr: { iid: number; url: string; headSha: string } | null = null;
    for (let iid = 1; iid <= 5 && knowledgeMr === null; iid += 1) {
      const found = await pipeline.git
        .getMergeRequest({ project_path: repoPath, iid, url: 'https://git.example.test/lookup' })
        .catch(() => null);
      if (found?.source_branch === knowledgeBranch) {
        knowledgeMr = {
          iid,
          url: found.ref.url,
          headSha: found.ref.head_sha ?? found.head_sha,
        };
      }
    }
    expect(knowledgeMr, 'the knowledge merge request was opened').not.toBeNull();
    await pipeline.publish([
      inboundEvent('mr.merged', {
        project_id: projectId,
        task_id: null,
        mr: {
          provider: 'fake-git',
          project_path: repoPath,
          iid: knowledgeMr?.iid ?? 0,
          url: knowledgeMr?.url ?? '',
          branch: knowledgeBranch,
          head_sha: knowledgeMr?.headSha ?? '',
        },
        draft: false,
        head_sha: knowledgeMr?.headSha ?? '',
        diff_stats: null,
        merge_commit_sha: null,
      }),
    ]);

    // ── The re-check notices: criterion 4, as a number ───────────────────────
    await pipeline.waitFor(
      'the re-check after the knowledge merge',
      async () => (await rechecksPassing('R12')).length > 0,
    );
    const afterInterview = await readiness();
    expect(afterInterview.source).toBe('recheck');
    const completeness = completenessOf(afterInterview);
    expect(completeness).toBeCloseTo(0.8, 6);
    expect(completeness).toBeGreaterThan(KNOWLEDGE_COMPLETENESS_THRESHOLD);
    // The same number from the index rows, computed independently of the evidence sentence.
    const indexed = await pipeline.query<{ path: string }>(
      'select path from kb_documents where project_id = $1',
      [projectId],
    );
    const vault = indexed.map((row) => row.path.replace(/^\.agentic\/knowledge\//, ''));
    expect(knowledgeCompleteness(vault)).toBeCloseTo(0.8, 6);
    expect(
      KNOWLEDGE_COMPLETENESS_SECTIONS.filter((section) => !vault.includes(section.path)).map(
        (section) => section.id,
      ),
    ).toEqual(['technical_overview', 'conventions']);
    const byId = new Map(afterInterview.criteria.map((criterion) => [criterion.id, criterion]));
    expect(byId.get('R12')?.passed).toBe(true);
    // Criterion 5: the platform's three are the platform's — never the draft's words.
    for (const id of ['R9', 'R11', 'R12']) {
      expect(byId.get(id)?.detected_by, id).toBe('platform');
      expect(byId.get(id)?.evidence, id).not.toContain('the model says');
    }
    // R8 is read from the tree, and the tree has no CLAUDE.md yet: still level 2.
    expect(byId.get('R8')?.passed).toBe(false);
    expect(byId.get('R8')?.evidence).toContain('CLAUDE.md is absent');
    expect(afterInterview.level).toBe(2);
    // A carried criterion says so.
    expect(byId.get('R1')?.evidence).toMatch(/^carried from the discovery evaluation of /);

    // ── Criterion 1: a merged task on a repository that gained a criterion ──
    const opened = await pipeline.git.openMergeRequest({
      project: repoPath,
      branch: 'agentic/ACME-1',
      target: 'main',
      title: 'Draft: sum the invoice footer',
      description: 'Opened by the developer stage.',
      draft: true,
      labels: ['agentic'],
      reviewers: [],
      remove_source_branch: true,
    });
    // WP-81: the CI gate's tamper check reads the merge request's changed files, and the fake
    // opens one with none — *not yet computed* to the gate. One ordinary file, as `startPipeline`
    // seeds for the first merge request.
    pipeline.git.setDiff({
      project: repoPath,
      iid: opened.ref.iid,
      files: [{ path: 'src/totals.ts', diff: '@@ -1 +1 @@\n-a\n+b' }],
    });
    pipeline.git.setPipeline({
      project: repoPath,
      headSha: opened.head_sha,
      status: 'success',
      jobs: [{ name: 'test:unit', status: 'success' }],
    });
    taskWorld = {
      mr: { iid: opened.ref.iid, url: opened.web_url, headSha: opened.head_sha },
      branch: 'agentic/ACME-1',
    };
    await pipeline.publish([
      inboundEvent('ticket.matched', {
        project_id: projectId,
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
    const taskState = async (): Promise<string | null> => {
      const rows = await pipeline.query<{ state: string }>(
        "select state::text as state from tasks where project_id = $1 and ticket_key = 'ACME-1'",
        [projectId],
      );
      return rows[0]?.state ?? null;
    };
    await pipeline.waitFor(
      'the task to wait for the human merge',
      async () => (await taskState()) === 'ready_for_merge',
    );
    // Nothing of the task is merged yet, so no re-check has seen R8.
    expect(await rechecksPassing('R8')).toHaveLength(0);

    // The task's change lands: a CLAUDE.md that links to the knowledge index (R8).
    await writeFile(
      path.join(repo, 'CLAUDE.md'),
      '# House rules\n\nRead .agentic/knowledge/index.md before changing anything.\n',
    );
    const mergedHead = await commitAll('Merge !1: sum the invoice footer');
    await pipeline.publish([
      inboundEvent('mr.merged', {
        project_id: projectId,
        task_id: null,
        mr: {
          provider: 'fake-git',
          project_path: repoPath,
          iid: opened.ref.iid,
          url: opened.web_url,
          branch: 'agentic/ACME-1',
          head_sha: opened.head_sha,
        },
        draft: false,
        head_sha: opened.head_sha,
        diff_stats: null,
        merge_commit_sha: mergedHead,
      }),
    ]);
    await pipeline.waitFor(
      'the re-check after the merged task',
      async () => (await rechecksPassing('R8')).length > 0,
    );
    const afterTask = await readiness();
    expect(afterTask.source).toBe('recheck');
    expect(afterTask.level).toBe(3);
    const r8 = afterTask.criteria.find((criterion) => criterion.id === 'R8');
    expect(r8?.passed).toBe(true);
    // Answered by the platform's own file read, and published as such.
    expect(r8?.detected_by).toBe('platform');
    expect(r8?.evidence).toBe(
      `CLAUDE.md at ${mergedHead.slice(0, 12)} has 3 lines and links to .agentic/knowledge/index.md`,
    );
    // The projection the board badge reads moved with the row.
    expect(
      await pipeline.query('select readiness_level from projects where id = $1', [projectId]),
    ).toEqual([{ readiness_level: 3 }]);
    // The history: one discovery row at level 2, and the re-checks after the two merges — the
    // interview's at 2 (R12 now passing, R8 not) and the task's at 3.
    expect((await rowsOf('discovery')).map((row) => row.level)).toEqual([2]);
    expect((await rechecksPassing('R12')).map((row) => row.level)).toEqual([2, 3]);
    expect((await rechecksPassing('R8')).map((row) => row.level)).toEqual([3]);
    // And the task itself was merged by the pipeline, not by this file.
    await pipeline.waitFor('the merged task to finish', async () => (await taskState()) === 'done');
  }, 300_000);
});
