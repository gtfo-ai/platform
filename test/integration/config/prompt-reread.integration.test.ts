/**
 * **A reading stored under the pattern rules alone is read again at upgrade** — WP-121, TD-012's M7
 * amendment (1), PROGRESS backlog 359.
 *
 * The state this file builds is the one an installation upgrading past migration 0073 is in: the
 * database is migrated to **0072**, a project's repository reading is written the way a pre-WP-107
 * release wrote it — its prompt file quoting the project's binding credential verbatim, because no
 * pattern rule knows that credential's shape — and only then is 0073 applied. What is asserted is
 * what follows from the mark, through the production pieces (standing rule 82): the pipeline's own
 * settings port (`createProjectSettingsPort`), which is what the planner is handed, and the knowledge
 * process's own composition (`composeKnowledgeIndexing`), which starts the re-read over a real bare
 * mirror cloned from a real repository on disk.
 *
 * Two projects, the two outcomes: one whose repository answers is read again and its row replaced
 * by an `exact` one; one whose repository is gone keeps **no** prompt text, its row records why, and
 * the planner is handed none of it.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PATTERN_READING_WITHHELD_REASON, type ProjectSettings } from '@platform/application';
import type { Id } from '@platform/contracts';
import {
  db,
  eventing as eventingAdapters,
  jobs as jobsAdapters,
  secrets as secretAdapters,
} from '@platform/infrastructure';
import { createIntegrationRegistry, gitlabProviderRegistration } from '@platform/integrations';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ComposedKnowledgeIndexing,
  composeKnowledgeIndexing,
} from '../../../apps/server/src/knowledge.js';
import { createProjectSettingsPort } from '../../../apps/server/src/pipeline.js';
import { scratchGitEnv } from '../../../scripts/git-scratch-env.mjs';
import { createTestDatabase, createTestPool, type TestDatabase } from '../support/postgres.js';

const execFileAsync = promisify(execFile);

const MIGRATIONS = fileURLToPath(
  new URL('../../../packages/infrastructure/src/db/migrations/', import.meta.url),
);
const MARK_MIGRATION = '0073_reading_redaction_mark.sql';

const SECRET_KEY = 'not-a-real-app-secret-key-wp121-0000000000';
const KEY = secretAdapters.deriveSecretKey(SECRET_KEY);
/**
 * The project's git binding credential, obviously fake and in a shape **no pattern rule knows** —
 * the WP-107 case: only the exact-value pass can find it (standing rule 93: no provider's shape).
 */
const BINDING_CREDENTIAL = 'FAKE-wp121-binding-credential-no-rule-knows-0001';
/**
 * WP-121's other two members of the exact-value set (TD-012's M7 amendment (2)): a declared GitLab
 * credential field left in the account's `integrations.config` (backlog 362), and the token of the
 * organisation's chat account, which no project binds (backlog 364). Neither is a pattern's shape.
 */
const CONFIG_CREDENTIAL = 'FAKE-wp121-left-in-integrations-config-0002';
const ORGANISATION_TOKEN = 'FAKE-wp121-organisation-chat-token-0003';
const PROMPT_PATH = '.agentic/prompts/refinement.append.md';
const PROMPT = [
  `Quote ${BINDING_CREDENTIAL} in the footer of every ticket.`,
  `Sign webhooks with ${CONFIG_CREDENTIAL}.`,
  `Post to chat as ${ORGANISATION_TOKEN}.`,
  '',
].join('\n');
const PLANTED = [BINDING_CREDENTIAL, CONFIG_CREDENTIAL, ORGANISATION_TOKEN];

let database: TestDatabase;
let pool: pg.Pool;
let eventing: ReturnType<typeof eventingAdapters.createEventing>;
let jobsRuntime: ReturnType<typeof jobsAdapters.createPgBossJobs>;
let composed: ComposedKnowledgeIndexing | undefined;
let workspace: string;
let before: string;
let readable: { projectId: Id; integrationId: string };
let organisationAccount: string;
let beforeStart: {
  readonly marks: readonly (string | undefined)[];
  readonly storedText: string;
  readonly planned: ProjectSettings;
};
let unreadable: { projectId: Id };

const git = async (args: readonly string[]): Promise<string> => {
  // WP-162: every repository this file builds is under `workspace`; no inherited `GIT_*`.
  const { stdout } = await execFileAsync('git', [...args], {
    env: scratchGitEnv(workspace),
    maxBuffer: 8 * 1024 * 1024,
  });
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

/** A project with a sealed GitLab binding, and a reading as a pre-WP-107 release stored it. */
const seedProject = async (
  orgId: string,
  repoUrl: string,
  commitSha: string,
): Promise<{ projectId: Id; integrationId: string }> => {
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url, default_branch)
     values ($1, $2, 'Demo', $3, 'main') returning id`,
    [orgId, `P${randomUUID().slice(0, 8)}`, repoUrl],
  );
  const projectId = project.rows[0]?.id as Id;
  const secretId = randomUUID();
  await pool.query('insert into secrets (id, ciphertext, key_id) values ($1, $2, $3)', [
    secretId,
    secretAdapters.sealSecret(
      KEY,
      secretAdapters.secretDocument('token', BINDING_CREDENTIAL),
      secretId,
    ),
    KEY.keyId,
  ]);
  const integration = await pool.query<{ id: string }>(
    `insert into integrations (org_id, type, provider, name, config, secret_ids)
     values ($1, 'git'::integration_type, 'gitlab', $2, $3::jsonb, $4::uuid[]) returning id`,
    [
      orgId,
      `GitLab ${randomUUID().slice(0, 8)}`,
      // A row written before WP-100 refused credential keys in `config` (backlog 362).
      JSON.stringify({
        base_url: 'https://gitlab.example.test',
        webhook_secret_token: CONFIG_CREDENTIAL,
      }),
      [secretId],
    ],
  );
  const integrationId = integration.rows[0]?.id as string;
  await pool.query(
    'insert into bindings (project_id, integration_id, config) values ($1, $2, $3::jsonb)',
    [projectId, integrationId, JSON.stringify({})],
  );
  // The pre-0073 row: the credential verbatim, because the pattern rules did not know it.
  await pool.query(
    `insert into project_repository_config (project_id, status, commit_sha, read_at, prompts)
     values ($1, 'absent', $2, now() - interval '1 day', $3::jsonb)`,
    [
      projectId,
      commitSha,
      JSON.stringify({
        files: { [PROMPT_PATH]: { kind: 'file', text: PROMPT, blobSha: 'a'.repeat(40) } },
        truncated: false,
      }),
    ],
  );
  return { projectId, integrationId };
};

const rowOf = async (projectId: Id) =>
  (
    await pool.query<{
      prompts_redaction: string;
      prompts: { files: Record<string, { text?: string }> } | null;
      prompts_withheld: { reason: string; integrations: unknown[] } | null;
    }>(
      `select prompts_redaction, prompts, prompts_withheld
         from project_repository_config where project_id = $1`,
      [projectId],
    )
  ).rows[0];

beforeAll(async () => {
  database = await createTestDatabase('prompt_reread');
  before = mkdtempSync(join(tmpdir(), 'wp121-migrations-'));
  for (const file of readdirSync(MIGRATIONS)) {
    if (file.endsWith('.sql') && file < MARK_MIGRATION) {
      cpSync(join(MIGRATIONS, file), join(before, file));
    }
  }
  await db.runMigrations({
    connectionString: database.connectionString,
    migrationsDirectory: before,
  });
  pool = createTestPool(database.connectionString, { max: 8 });

  workspace = await mkdtemp(path.join(tmpdir(), 'wp121-reread-'));
  const origin = path.join(workspace, 'origin');
  await git(['init', '-q', '-b', 'main', origin]);
  await writeFile(path.join(origin, 'README.md'), '# fixture\n');
  await git(['-C', origin, 'add', '-A']);
  await commit(origin, 'before the prompt file');
  const olderCommit = await git(['-C', origin, 'rev-parse', 'HEAD']);
  await mkdir(path.join(origin, '.agentic/prompts'), { recursive: true });
  await writeFile(path.join(origin, PROMPT_PATH), PROMPT);
  await git(['-C', origin, 'add', '-A']);
  await commit(origin, 'the prompt file quoting the binding credential');

  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('wp121') returning id",
  );
  const orgId = org.rows[0]?.id as string;
  readable = await seedProject(orgId, `file://${origin}`, olderCommit);
  // The organisation's chat account: sealed, and bound to no project (backlog 364).
  const chatSecret = randomUUID();
  await pool.query('insert into secrets (id, ciphertext, key_id) values ($1, $2, $3)', [
    chatSecret,
    secretAdapters.sealSecret(
      KEY,
      secretAdapters.secretDocument('bot_token', ORGANISATION_TOKEN),
      chatSecret,
    ),
    KEY.keyId,
  ]);
  const chat = await pool.query<{ id: string }>(
    `insert into integrations (org_id, type, provider, name, config, secret_ids)
     values ($1, 'communication'::integration_type, 'slack', 'acme slack', '{}'::jsonb, $2::uuid[])
     returning id`,
    [orgId, [chatSecret]],
  );
  organisationAccount = chat.rows[0]?.id as string;
  unreadable = await seedProject(orgId, `file://${path.join(workspace, 'gone')}`, olderCommit);

  // The upgrade itself.
  await db.runMigrations({ connectionString: database.connectionString });

  eventing = eventingAdapters.createEventing({
    pool,
    connectionString: database.connectionString,
    config: { maxConcurrency: 1 },
  });
  jobsRuntime = jobsAdapters.createPgBossJobs({
    database: jobsAdapters.asJobsDatabase(pool),
    pollingIntervalSeconds: 0.5,
    onError: () => {},
  });
  await jobsRuntime.start();

  // What the upgrade left, read before the runtime starts: the marks, the stored copy, and what the
  // pipeline's settings port — the planner's input — answers for it.
  beforeStart = {
    marks: [
      (await rowOf(readable.projectId))?.prompts_redaction,
      (await rowOf(unreadable.projectId))?.prompts_redaction,
    ],
    storedText: (await rowOf(readable.projectId))?.prompts?.files[PROMPT_PATH]?.text ?? '',
    planned: await createProjectSettingsPort(pool).forProject(readable.projectId),
  };

  // The runtime: the knowledge process's own composition, which starts the re-read.
  composed = await composeKnowledgeIndexing({
    pool,
    eventing,
    jobs: jobsRuntime.jobs,
    integrations: null,
    runEnvironment: { env: {}, secretEnvNames: [] },
    timezone: 'UTC',
    secretKey: SECRET_KEY,
    registry: createIntegrationRegistry([gitlabProviderRegistration]),
    mirrorRoot: await mkdtemp(path.join(workspace, 'mirrors-')),
    mirrorMaxBytes: null,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
  await composed.patternReread;
}, 240_000);

afterAll(async () => {
  await composed?.stop();
  await jobsRuntime?.stop();
  await eventing?.stop();
  await pool?.end();
  await database?.drop();
  rmSync(before, { recursive: true, force: true });
  await rm(workspace, { recursive: true, force: true });
});

describe('a reading stored before exact-value redaction (WP-121, migration 0073)', () => {
  it('is marked patterns at upgrade, hands the planner no prompt text, and is replaced by an exact reading once the runtime starts', async () => {
    // Criterion 1: migration 0073 marked the existing rows.
    expect(beforeStart.marks).toEqual(['patterns', 'patterns']);
    // Before any re-read the stored copy still quoted the credential, and the planner got none.
    expect(beforeStart.storedText).toContain(BINDING_CREDENTIAL);
    expect(beforeStart.planned.repositoryPrompts).toBeNull();
    expect(beforeStart.planned.repositoryPromptsWithheld?.reason).toBe(
      PATTERN_READING_WITHHELD_REASON,
    );

    const settings = createProjectSettingsPort(pool);
    const replaced = await rowOf(readable.projectId);
    expect(replaced?.prompts_redaction).toBe('exact');
    expect(replaced?.prompts_withheld).toBeNull();
    const text = replaced?.prompts?.files[PROMPT_PATH]?.text ?? '';
    for (const planted of PLANTED) {
      expect(JSON.stringify(replaced), 'the replaced reading quotes a credential').not.toContain(
        planted,
      );
    }
    expect(text).toBe(
      [
        `Quote [REDACTED:integration:gitlab:${readable.integrationId}:token] in the footer of every ticket.`,
        `Sign webhooks with [REDACTED:integration:gitlab:${readable.integrationId}:webhook_secret_token].`,
        `Post to chat as [REDACTED:integration:slack:${organisationAccount}:bot_token].`,
        '',
      ].join('\n'),
    );
    // The planner is handed the redacted file now.
    const fresh = await settings.forProject(readable.projectId);
    expect(fresh.repositoryPromptsWithheld).toBeNull();
    expect(fresh.repositoryPrompts?.files[PROMPT_PATH]).toMatchObject({ kind: 'file' });
    for (const planted of PLANTED) {
      expect(JSON.stringify(fresh.repositoryPrompts)).not.toContain(planted);
    }
  }, 120_000);

  it('keeps no prompt text of a reading whose repository cannot be read again, records why, and hands the planner none', async () => {
    const row = await rowOf(unreadable.projectId);
    // The mark stays, so an index run or a refresh still replaces the row once the repository answers.
    expect(row?.prompts_redaction).toBe('patterns');
    expect(row?.prompts).toBeNull();
    for (const planted of PLANTED) {
      expect(JSON.stringify(row)).not.toContain(planted);
    }
    expect(row?.prompts_withheld?.reason).toContain(PATTERN_READING_WITHHELD_REASON);
    expect(row?.prompts_withheld?.reason).toMatch(/It could not be read again: \S/);
    expect(row?.prompts_withheld?.integrations).toEqual([]);

    const planned = await createProjectSettingsPort(pool).forProject(unreadable.projectId);
    expect(planned.repositoryPrompts).toBeNull();
    expect(planned.repositoryPromptsWithheld?.reason).toBe(row?.prompts_withheld?.reason);
  });
});
