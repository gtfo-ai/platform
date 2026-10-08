/**
 * **A change of the default branch moves the configuration read and the readiness re-check at
 * once** — WP-147, backlog 442's index-and-configuration half, against a real PostgreSQL 18 and a
 * real `git` mirror over a `file://` origin.
 *
 * Autix's shape: `develop` is the stored default branch and is **ahead** of `main` (so `main`'s head
 * is an ancestor of `develop`'s), and each branch carries a different `.agentic/config.yml`. Before
 * this row, after a change `develop` → `main` the project's configuration stayed `develop`'s until
 * the next index run — and even then, because the refresher took `main`'s head for an *older*
 * reading than `develop`'s recorded one (it is its ancestor), `develop`'s stood.
 *
 * What is asserted, each through the production function:
 *  1. the change's transaction turns the old branch's reading into an `invalid` one
 *     (`writeProjectDefaultBranch`), so no configuration read after the commit answers `develop`'s
 *     file and no run plans until `main` is read — never a missing row, which would fail open;
 *  2. the change's after-commit reading (`ProjectConfigCommands.readNewDefaultBranch`) records
 *     `main`'s file at `main`'s head and enqueues a readiness re-check pinned to that commit — no
 *     index run anywhere in this file;
 *  3. a reading of `develop` that lands **after** the change (an index run that started before it)
 *     does not make `main`'s reading "older": the next reading still records `main`.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { type Jobs, repositoryConfigRefusal } from '@platform/application';
import type { Id } from '@platform/contracts';
import { knowledge as knowledgeAdapters } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositoryConfigRefresher } from '../../../apps/server/src/knowledge.js';
import { createProjectSettingsPort } from '../../../apps/server/src/pipeline.js';
import { createProjectConfigCommands } from '../../../apps/server/src/project-config.js';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import { writeProjectDefaultBranch } from '../../../apps/server/src/queries/onboarding-queries.js';
import { scratchGitEnv } from '../../../scripts/git-scratch-env.mjs';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

const execFileAsync = promisify(execFile);
const SECRET_KEY = 'not-a-real-app-secret-key-wp147-0000000000';
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let database: MigratedDatabase;
let pool: pg.Pool;
let db: Database;
let orgId: string;
let root: string;
let origin: string;
let mirrorRoot: string;
let mainHead: string;
let developHead: string;

const git = async (args: readonly string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', [...args], {
    // WP-162: `scratchGitEnv` over a parent that inherits nothing but `PATH`.
    env: scratchGitEnv(root, {
      parent: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root },
      author: { name: 'Fixture', email: 'fixture@example.test' },
    }),
  });
  return stdout.trim();
};

const commitFile = async (relative: string, body: string, message: string): Promise<string> => {
  const absolute = path.join(origin, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, body, 'utf8');
  await git(['-C', origin, 'add', '-A']);
  await git(['-C', origin, '-c', 'commit.gpgsign=false', 'commit', '-qm', message]);
  return git(['-C', origin, 'rev-parse', 'HEAD']);
};

beforeAll(async () => {
  database = await createMigratedDatabase('default-branch-reads');
  pool = createTestPool(database.connectionString, { max: 4 });
  db = drizzle(pool) as unknown as Database;
  orgId =
    (
      await pool.query<{ id: string }>(
        "insert into organizations (name) values ('wp147') returning id",
      )
    ).rows[0]?.id ?? '';
  root = await mkdtemp(path.join(tmpdir(), 'wp147-'));
  origin = path.join(root, 'origin');
  mirrorRoot = path.join(root, 'mirrors');
  await mkdir(mirrorRoot, { recursive: true });
  await git(['init', '-q', '-b', 'main', origin]);
  mainHead = await commitFile(
    '.agentic/config.yml',
    'version: 1\ncommands:\n  block: ["make deploy-main"]\n',
    'main',
  );
  await git(['-C', origin, 'checkout', '-qb', 'develop']);
  developHead = await commitFile(
    '.agentic/config.yml',
    'version: 1\ncommands:\n  block: ["make deploy-develop"]\n',
    'develop, ahead of main',
  );
  await git(['-C', origin, 'checkout', '-q', 'main']);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

const newProject = async (): Promise<Id> =>
  (
    await pool.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url, default_branch)
       values ($1, $2, 'Autix', $3, 'develop') returning id`,
      [orgId, `autix_${randomUUID().slice(0, 8).replace(/-/g, '')}`, `file://${origin}`],
    )
  ).rows[0]?.id as Id;

/** The production file source over the project's **stored** default branch, read per call. */
const filesSource = () =>
  knowledgeAdapters.createGitRepositoryFileSource({
    mirrorRoot,
    target: async (projectId) => {
      const row = (
        await pool.query<{ default_branch: string }>(
          'select default_branch from projects where id = $1',
          [projectId],
        )
      ).rows[0];
      return row === undefined
        ? null
        : {
            repoUrl: `file://${origin}`,
            defaultBranch: row.default_branch,
            credential: { username: 'oauth2', password: 'glpat-FAKE-not-a-real-token-wp147' },
          };
    },
    logger: silent,
  });

const world = () => {
  const files = filesSource();
  const enqueued: unknown[] = [];
  const jobs = {
    enqueue: async (request: unknown) => {
      enqueued.push(request);
      return { status: 'enqueued', jobId: `job-${enqueued.length}` };
    },
  } as unknown as Jobs;
  const commands = createProjectConfigCommands({
    pool,
    integrations: {} as never,
    files,
    secretKey: SECRET_KEY,
    logger: silent as never,
    jobs,
  });
  const refresh = createRepositoryConfigRefresher({
    pool,
    files,
    secretKey: SECRET_KEY,
    logger: silent as never,
  });
  return { commands, refresh, enqueued };
};

const repositoryOf = async (projectId: Id) =>
  (await createProjectSettingsPort(pool).forProject(projectId)).repository;

describe('a change of the default branch moves the configuration and readiness reads (WP-147, backlog 442)', () => {
  it('turns the old branch’s configuration reading into a refusal in the change’s transaction, so no run plans on it or without it', async () => {
    const projectId = await newProject();
    const { refresh } = world();
    await refresh({ projectId });
    expect(await repositoryOf(projectId)).toMatchObject({
      status: 'valid',
      commitSha: developHead,
    });

    const written = await writeProjectDefaultBranch(db, projectId, 'main');
    expect(written.status).toBe('written');
    // Read before any reading of `main` and before any index run: nothing of `develop` is served,
    // and the project's runs are refused rather than planned with no repository layer (fail closed).
    const settings = await createProjectSettingsPort(pool).forProject(projectId);
    expect(settings.repository).toMatchObject({ status: 'invalid' });
    expect(JSON.stringify(settings.repositoryCommands ?? null)).not.toContain('deploy-develop');
    expect(repositoryConfigRefusal(settings)).toMatch(
      /default branch changed from "develop" to "main"/,
    );
  });

  it('leaves a project that was never read with no reading to refuse', async () => {
    const projectId = await newProject();
    await writeProjectDefaultBranch(db, projectId, 'main');
    expect(await repositoryOf(projectId)).toMatchObject({ status: 'unread' });
  });

  it('reads main’s configuration and asks for a readiness re-check pinned to main’s head, before any index run', async () => {
    const projectId = await newProject();
    const { refresh, commands, enqueued } = world();
    await refresh({ projectId });
    await writeProjectDefaultBranch(db, projectId, 'main');

    const reading = await commands.readNewDefaultBranch(projectId);
    expect(reading).toEqual({ config: 'recorded', commitSha: mainHead, recheckRequested: true });
    expect(await repositoryOf(projectId)).toMatchObject({ status: 'valid', commitSha: mainHead });
    const settings = await createProjectSettingsPort(pool).forProject(projectId);
    expect(JSON.stringify(settings.repositoryCommands ?? null)).toContain('make deploy-main');
    expect(JSON.stringify(settings.repositoryCommands ?? null)).not.toContain('deploy-develop');
    expect(enqueued).toEqual([
      expect.objectContaining({
        data: { kind: 'readiness_recheck', project_id: projectId, commit_sha: mainHead },
      }),
    ]);
  });

  it('records main even when a reading of develop lands after the change', async () => {
    const projectId = await newProject();
    const { refresh, commands } = world();
    await writeProjectDefaultBranch(db, projectId, 'main');
    // An index run that read `develop` before the change and wrote after it: pinned to its commit,
    // which was the default branch's when it read.
    await pool.query("update projects set default_branch = 'develop' where id = $1", [projectId]);
    await refresh({ projectId, commitSha: developHead });
    await pool.query("update projects set default_branch = 'main' where id = $1", [projectId]);
    expect((await repositoryOf(projectId))?.commitSha).toBe(developHead);

    const reading = await commands.readNewDefaultBranch(projectId);
    expect(reading.config).toBe('recorded');
    expect(await repositoryOf(projectId)).toMatchObject({ commitSha: mainHead });
  });
});
