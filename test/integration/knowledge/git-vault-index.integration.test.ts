/**
 * WP-18a's acceptance, asserted where the work package's artefact actually lands: **rows in
 * PostgreSQL after an index run over a real bare mirror**.
 *
 * Standing rule 82 is what decides the shape of this file. The thing WP-18a produces is *the tree
 * the index sees*, so nothing here asks the adapter what it would return: every criterion is a
 * `kb_documents` / `kb_chunks` count, taken after the production composition
 * (`apps/server/src/knowledge.ts`) ran its `knowledge.index` job through **real pg-boss** over a
 * mirror this test built with `git clone --mirror` from a **real seeded remote**. An in-memory vault
 * passes none of them.
 *
 * What is deliberately *not* faked, and why it matters for each criterion:
 *
 *  - the **remote** is another git repository on disk, so `git remote update --prune` is a real
 *    fetch over the git transport (criterion 4 — a commit pushed after the first run) and deleting
 *    it is a real unreachable remote (criterion 5);
 *  - the **credential** is resolved through `createGitMirrorCredentials` from real `integrations`,
 *    `bindings` and `secrets` rows, encrypted with the real envelope (criterion 9's second half:
 *    the planted token is absent from the mirror's own `config` after a fetch — its argv half is
 *    `packages/infrastructure/src/knowledge/git-vault.test.ts`, which can wrap the process runner);
 *  - the **queue** is pg-boss, so "singleton per project" is asked of the thing that decides it
 *    rather than of a fake that would answer the same whatever the policy was (criterion 8; the
 *    in-flight half is `packages/infrastructure/src/jobs/knowledge-index.test.ts`, and the
 *    in-memory adapter's divergence register says where it is stricter).
 *
 * `/readyz` with no `APP_KNOWLEDGE_MIRROR_ROOT` is criterion 7's other half and is asserted where a
 * whole instance exists: `test/e2e/pipeline/composition.e2e.test.ts`.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LogFields, Logger } from '@platform/application';
import { enqueueKnowledgeIndex, JOB_QUEUES } from '@platform/application';
import type { Id } from '@platform/contracts';
import {
  eventing as eventingAdapters,
  jobs as jobsAdapters,
  secrets as secretAdapters,
} from '@platform/infrastructure';
import { createIntegrationRegistry, gitlabProviderRegistration } from '@platform/integrations';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type ComposedKnowledgeIndexing,
  composeKnowledgeIndexing,
} from '../../../apps/server/src/knowledge.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

const execFileAsync = promisify(execFile);

const SECRET_KEY = 'not-a-real-app-secret-key-000000000000';
const KEY = secretAdapters.deriveSecretKey(SECRET_KEY);
/** Obviously fake, and planted so its absence from the mirror's config is a measurement. */
const BINDING_TOKEN = 'glpat-FAKE-wp18a-planted-credential-00';
const SECRET_MARKER = 'MARKER-THE-SYMLINK-TARGET-MUST-NOT-BE-INDEXED';
const KNOWLEDGE_DIR = '.agentic/knowledge';
// pg-boss refuses anything below 500 ms (`attorney.js` § applyPollingInterval).
const POLL_SECONDS = 0.5;
const WAIT_TIMEOUT_MS = 60_000;

let database: MigratedDatabase;
let pool: pg.Pool;
let eventing: ReturnType<typeof eventingAdapters.createEventing>;
let jobsRuntime: ReturnType<typeof jobsAdapters.createPgBossJobs>;
let orgId: string;

/** Per test: a project, a seeded remote, a mirror root and the composition reading them. */
let workspace: string;
let origin: string;
let mirrorRoot: string;
let projectId: Id;
let composed: ComposedKnowledgeIndexing | undefined;
let logs: { level: string; fields: LogFields; message: string }[] = [];

const registry = createIntegrationRegistry([gitlabProviderRegistration]);

const recordingLogger = (): Logger => ({
  debug: (fields, message) => logs.push({ level: 'debug', fields, message }),
  info: (fields, message) => logs.push({ level: 'info', fields, message }),
  warn: (fields, message) => logs.push({ level: 'warn', fields, message }),
  error: (fields, message) => logs.push({ level: 'error', fields, message }),
});

const git = async (args: readonly string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', [...args], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
};

const commit = (repo: string, message: string): Promise<string> =>
  git([
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

const write = async (repo: string, relative: string, body: string): Promise<void> => {
  const absolute = path.join(repo, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, body, 'utf8');
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

beforeAll(async () => {
  database = await createMigratedDatabase('git-vault-index');
  pool = createTestPool(database.connectionString, { max: 8 });
  eventing = eventingAdapters.createEventing({
    pool,
    connectionString: database.connectionString,
    config: { maxConcurrency: 1 },
  });
  jobsRuntime = jobsAdapters.createPgBossJobs({
    database: jobsAdapters.asJobsDatabase(pool),
    pollingIntervalSeconds: POLL_SECONDS,
    onError: () => {},
  });
  await jobsRuntime.start();

  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('knowledge') returning id",
  );
  orgId = org.rows[0]?.id as string;
}, 240_000);

afterAll(async () => {
  await jobsRuntime?.stop();
  await eventing?.stop();
  await pool?.end();
  await database?.drop();
});

afterEach(async () => {
  await composed?.stop();
  composed = undefined;
  await rm(workspace, { recursive: true, force: true });
});

/** A project with a git binding, a seeded remote holding the four indexed path classes, a mirror root. */
const seed = async (): Promise<void> => {
  logs = [];
  workspace = await mkdtemp(path.join(tmpdir(), 'kb-index-'));
  origin = path.join(workspace, 'origin');
  mirrorRoot = path.join(workspace, 'mirrors');
  await mkdir(mirrorRoot, { recursive: true });
  await writeFile(path.join(workspace, 'secret-target.txt'), `${SECRET_MARKER}\n`, 'utf8');

  await git(['init', '-q', '-b', 'main', origin]);
  await write(origin, 'CLAUDE.md', '# Claude\n\nThe project rules.\n');
  await write(origin, 'AGENTS.md', '# Agents\n\nAgent notes.\n');
  await write(
    origin,
    `${KNOWLEDGE_DIR}/index.md`,
    '---\nid: index\ntype: reference\n---\n# Index\n\nThe vault index.\n',
  );
  await write(
    origin,
    `${KNOWLEDGE_DIR}/lessons/L-1.md`,
    '---\nid: L-1\ntype: lesson\n---\n# Lesson one\n\nWhat we learned.\n',
  );
  await write(
    origin,
    '.agentic/rules/commit-style.md',
    '---\nid: R-1\ntype: reference\n---\n# Commit style\n\nConventional commits.\n',
  );
  await write(origin, 'src/app.ts', 'export const x = 1;\n');
  await symlink(
    path.join(workspace, 'secret-target.txt'),
    path.join(origin, KNOWLEDGE_DIR, 'evil.md'),
  );
  await git(['-C', origin, 'add', '-A']);
  await git([
    '-C',
    origin,
    'update-index',
    '--add',
    '--cacheinfo',
    '160000,0000000000000000000000000000000000000001,vendor/sub',
  ]);
  await commit(origin, 'the vault');

  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url, default_branch, knowledge_dir)
     values ($1, $2, 'Demo', $3, 'main', $4) returning id`,
    [orgId, `P${randomUUID().slice(0, 8)}`, `file://${origin}`, KNOWLEDGE_DIR],
  );
  projectId = project.rows[0]?.id as Id;

  const secretId = randomUUID();
  await pool.query('insert into secrets (id, ciphertext, key_id) values ($1, $2, $3)', [
    secretId,
    secretAdapters.sealSecret(KEY, secretAdapters.secretDocument('token', BINDING_TOKEN), secretId),
    KEY.keyId,
  ]);
  const integration = await pool.query<{ id: string }>(
    `insert into integrations (org_id, type, provider, name, config, secret_ids)
     values ($1, 'git'::integration_type, 'gitlab', $2, $3::jsonb, $4::uuid[]) returning id`,
    [
      orgId,
      // `integrations(org_id, type, name)` is unique, and each test seeds its own account.
      `GitLab ${randomUUID().slice(0, 8)}`,
      JSON.stringify({ base_url: 'https://gitlab.example.test' }),
      [secretId],
    ],
  );
  await pool.query(
    'insert into bindings (project_id, integration_id, config) values ($1, $2, $3::jsonb)',
    [projectId, integration.rows[0]?.id, JSON.stringify({})],
  );
};

const compose = async (options: { readonly mirrorRoot?: string | null } = {}) =>
  composeKnowledgeIndexing({
    pool,
    eventing,
    jobs: jobsRuntime.jobs,
    // WP-18a's tier is about the index; the librarian half needs an integrations loader, and a
    // `null` one is what a process with no pipeline composes (the queues are then not started).
    integrations: null,
    runEnvironment: { env: {}, secretEnvNames: [] },
    timezone: 'UTC',
    secretKey: SECRET_KEY,
    registry,
    mirrorRoot: options.mirrorRoot === undefined ? mirrorRoot : options.mirrorRoot,
    logger: recordingLogger(),
  });

/** The report line the job logs, whatever its status — the job's own verdict, not a guess at it. */
const runIndex = async (request: { readonly commitSha?: string } = {}): Promise<LogFields> => {
  const before = logs.filter((line) => line.message.startsWith('knowledge index run')).length;
  await enqueueKnowledgeIndex(jobsRuntime.jobs, {
    projectId,
    reason: 'requested',
    ...(request.commitSha === undefined ? {} : { commitSha: request.commitSha }),
  });
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const reports = logs.filter((line) => line.message.startsWith('knowledge index run'));
    if (reports.length > before) return reports[reports.length - 1]?.fields as LogFields;
    await sleep(50);
  }
  throw new Error('timed out waiting for the index job to report');
};

const indexedPaths = async (): Promise<string[]> => {
  const { rows } = await pool.query<{ path: string }>(
    'select path from kb_documents where project_id = $1 order by path',
    [projectId],
  );
  return rows.map((row) => row.path);
};

const chunkTextMatching = async (needle: string): Promise<number> => {
  const { rows } = await pool.query<{ count: string }>(
    `select count(*)::text as count from kb_chunks c
       join kb_documents d on d.id = c.document_id
      where d.project_id = $1 and c.text like $2`,
    [projectId, `%${needle}%`],
  );
  return Number(rows[0]?.count ?? '0');
};

const mirrorDirectory = (): string => path.join(mirrorRoot, `p${projectId.replaceAll('-', '')}`);

describe('an index run over a platform-side bare mirror', () => {
  it('indexes the four path classes with no checkout anywhere on this filesystem', async () => {
    await seed();
    composed = await compose();

    const report = await runIndex();
    expect(report.status).toBe('indexed');
    expect(await indexedPaths()).toEqual([
      '.agentic/knowledge/index.md',
      '.agentic/knowledge/lessons/L-1.md',
      '.agentic/rules/commit-style.md',
      'AGENTS.md',
      'CLAUDE.md',
    ]);

    // The mirror is bare, and nothing under the root is a working tree of the fixture.
    expect(await git(['-C', mirrorDirectory(), 'rev-parse', '--is-bare-repository'])).toBe('true');
    await expect(readFile(path.join(mirrorDirectory(), 'CLAUDE.md'))).rejects.toThrow();
    await expect(readFile(path.join(mirrorDirectory(), 'src', 'app.ts'))).rejects.toThrow();

    // And the run really wrote chunks, so every "no rows" assertion below has a positive control.
    expect(await chunkTextMatching('Conventional commits')).toBeGreaterThan(0);
  });

  it('indexes what the commit holds, not what the directory holds', async () => {
    await seed();
    composed = await compose();
    // Written into the fixture's working directory and never committed.
    await write(
      origin,
      `${KNOWLEDGE_DIR}/lessons/L-uncommitted.md`,
      '---\nid: L-U\n---\n# Draft\n',
    );

    await runIndex();
    expect(await indexedPaths()).not.toContain(`${KNOWLEDGE_DIR}/lessons/L-uncommitted.md`);
  });

  it('reads no byte of a symlink’s target and no gitlink', async () => {
    await seed();
    composed = await compose();

    await runIndex();
    expect(await indexedPaths()).not.toContain(`${KNOWLEDGE_DIR}/evil.md`);
    expect(await indexedPaths()).not.toContain('vendor/sub');
    /**
     * The assertion that can fail is on the **target's path**, not on its bytes.
     *
     * `cat-file -p` on a mode `120000` entry prints the link target — a path — because that is what
     * the blob *is*; the file it points at is never opened by git at all. So an adapter that read
     * the entry stores `…/secret-target.txt` as a document body, and that is the state this catches
     * (measured: reading mode 120000 fails this case). Asserting that {@link SECRET_MARKER} — the
     * bytes *inside* the target — is absent would be standing rule 43's shape: no implementation of
     * this adapter could put it there, so the assertion would pass against every candidate,
     * including a broken one. The marker stays in the fixture because it is what makes the file a
     * meaningful thing to point at, and the unit tier asserts the same absence against the snapshot.
     */
    expect(await chunkTextMatching('secret-target.txt')).toBe(0);
    const { rows } = await pool.query<{ count: string }>(
      'select count(*)::text as count from kb_documents where project_id = $1 and path = $2',
      [projectId, `${KNOWLEDGE_DIR}/evil.md`],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('refreshes the mirror before it reads, so a commit pushed to the remote is indexed', async () => {
    await seed();
    composed = await compose();
    await runIndex();
    expect(await indexedPaths()).not.toContain(`${KNOWLEDGE_DIR}/lessons/L-2.md`);

    await write(
      origin,
      `${KNOWLEDGE_DIR}/lessons/L-2.md`,
      '---\nid: L-2\ntype: lesson\n---\n# Lesson two\n\nAdded after the first run.\n',
    );
    await git(['-C', origin, 'add', '-A']);
    await commit(origin, 'a second lesson');

    // No manual fetch of any kind between the two runs.
    const report = await runIndex();
    expect(report.status).toBe('indexed');
    expect(await indexedPaths()).toContain(`${KNOWLEDGE_DIR}/lessons/L-2.md`);
  });

  it('keeps the index it has when the remote is gone, and says so', async () => {
    await seed();
    composed = await compose();
    await runIndex();
    const before = await indexedPaths();
    expect(before.length).toBeGreaterThan(0);

    await rm(origin, { recursive: true, force: true });
    const report = await runIndex();

    expect(report.status).toBe('vault_unavailable');
    expect(String(report.reason)).toContain('could not be refreshed');
    // Both directions (standing rule 42): unchanged *and* non-zero — a store that had nothing to
    // keep looks identical from one side.
    expect(await indexedPaths()).toEqual(before);
    expect((await indexedPaths()).length).toBeGreaterThan(0);
  });

  it('refuses a commit that is not on the default branch, and indexes nothing', async () => {
    await seed();
    composed = await compose();
    await git(['-C', origin, 'checkout', '-q', '-b', 'agentic/task-1']);
    await write(
      origin,
      `${KNOWLEDGE_DIR}/lessons/L-branch.md`,
      '---\nid: L-B\ntype: lesson\n---\n# On a task branch\n\nNot the default branch.\n',
    );
    await git(['-C', origin, 'add', '-A']);
    await commit(origin, 'a lesson on the task branch');
    const branchHead = await git(['-C', origin, 'rev-parse', 'HEAD']);

    const report = await runIndex({ commitSha: branchHead });

    expect(report.status).toBe('vault_unavailable');
    expect(String(report.reason)).toContain('is not an ancestor');
    expect(await indexedPaths()).toEqual([]);
  });

  it('refuses by name when no mirror root is configured, and empties nothing', async () => {
    await seed();
    composed = await compose();
    await runIndex();
    const before = await indexedPaths();
    expect(before.length).toBeGreaterThan(0);
    await composed.stop();

    logs = [];
    composed = await compose({ mirrorRoot: null });
    expect(composed.missing).toEqual(['APP_KNOWLEDGE_MIRROR_ROOT']);

    const report = await runIndex();
    expect(report.status).toBe('vault_unavailable');
    expect(String(report.reason)).toContain('APP_KNOWLEDGE_MIRROR_ROOT');
    expect(await indexedPaths()).toEqual(before);
  });

  it('keeps the binding’s credential out of the mirror’s own config', async () => {
    await seed();
    composed = await compose();
    await runIndex();

    const config = await readFile(path.join(mirrorDirectory(), 'config'), 'utf8');
    expect(config).toContain(`file://${origin}`);
    expect(config).not.toContain(BINDING_TOKEN);
    // The credential really was resolved — an assertion that a token is absent passes just as well
    // against a composition that never read one (standing rule 10).
    const { rows } = await pool.query<{ count: string }>(
      'select count(*)::text as count from secrets',
    );
    expect(Number(rows[0]?.count)).toBeGreaterThan(0);
    expect(
      logs.some((line) => line.message === 'knowledge mirror ready' && line.level === 'info'),
    ).toBe(true);
  });

  it('collapses a burst of triggers onto one run, through pg-boss’s own singleton key', async () => {
    await seed();
    // Declared before anything is composed, so the three enqueues below race no worker.
    await jobsRuntime.jobs.defineQueue({ name: JOB_QUEUES.knowledgeIndex, policy: 'stately' });

    const results = [];
    for (const reason of ['task_started', 'merged', 'default_branch_moved'] as const) {
      // Through the function the trigger handlers call, so the singleton key under test is the one
      // production sends and not one this test wrote beside it (standing rule 35).
      results.push(await enqueueKnowledgeIndex(jobsRuntime.jobs, { projectId, reason }));
    }
    // pg-boss, not a fake: the second and third are refused by the queue's own policy index.
    expect(results.map((result) => result.status)).toEqual(['enqueued', 'coalesced', 'coalesced']);

    /**
     * And the fold is **per project**, which is the half the three enqueues above cannot show.
     *
     * Measured while writing this: with `singletonKey` deleted from `enqueueKnowledgeIndex` the
     * assertion above still passed — pg-boss folds a burst onto the null key just as happily — so a
     * test that only counts one project's runs is not evidence that the key exists. A second
     * project's request has to be admitted *while* the first is queued.
     */
    const otherProject = randomUUID() as Id;
    const other = await enqueueKnowledgeIndex(jobsRuntime.jobs, {
      projectId: otherProject,
      reason: 'merged',
    });
    expect(other.status).toBe('enqueued');

    composed = await compose();
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (
      Date.now() < deadline &&
      logs.every((line) => !line.message.startsWith('knowledge index run'))
    ) {
      await sleep(50);
    }
    await sleep(2 * POLL_SECONDS * 1_000);

    expect(logs.filter((line) => line.message.startsWith('knowledge index run'))).toHaveLength(1);
    // The second project's job really ran as a job of its own — it has no `projects` row, so it
    // completes with the reason rather than indexing (standing rule 10: assert which branch ran).
    expect(logs.some((line) => line.message.includes('no longer has a row'))).toBe(true);
    const { rows } = await pool.query<{ count: string }>(
      "select count(*)::text as count from events where stream_id = $1 and type = 'knowledge.index.rebuilt'",
      [projectId],
    );
    expect(rows[0]?.count).toBe('1');
  });
});
