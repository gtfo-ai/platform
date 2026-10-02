/**
 * `project_repository_config` against PostgreSQL 18 (WP-63, migration 0050): the production store
 * writes and reads a reading, a later reading replaces it, and the table's own constraints refuse
 * the rows no writer should produce — as the application role, which is what production connects as.
 */
import {
  PATTERN_READING_WITHHELD_REASON,
  type RepositoryConfigSnapshot,
  refreshRepositoryConfig,
  rereadPatternReadings,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { config } from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let projectId: Id;

const SHA = '0123456789abcdef0123456789abcdef01234567';
const AT = '2026-09-26T10:00:00.000Z' as IsoDateTime;

beforeAll(async () => {
  database = await createMigratedDatabase('repository-config');
  pool = createTestPool(database.connectionString, { options: '-c role=platform_app', max: 2 });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('repository config') returning id",
  );
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'demo', 'Demo', 'https://git.example.test/acme/demo.git') returning id`,
    [org.rows[0]?.id],
  );
  projectId = project.rows[0]?.id as Id;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('the repository configuration store', () => {
  it('reads nothing for a project never read, then the reading it recorded, then its replacement', async () => {
    const store = config.createPostgresRepositoryConfigStore(pool);
    expect(await store.read(projectId)).toBeNull();

    await store.record(projectId, {
      status: 'valid',
      commitSha: SHA,
      readAt: AT,
      values: { stages: { refinement: { model: 'claude-sonnet-5' } } },
      notApplied: [{ key: 'policies.autonomy', reason: 'moved in the platform' }],
    });
    expect(await store.read(projectId)).toEqual({
      status: 'valid',
      commitSha: SHA,
      readAt: AT,
      values: { stages: { refinement: { model: 'claude-sonnet-5' } } },
      notApplied: [{ key: 'policies.autonomy', reason: 'moved in the platform' }],
    });

    await store.record(projectId, {
      status: 'invalid',
      commitSha: SHA,
      readAt: AT,
      detail: 'version (expected 1)',
    });
    expect(await store.read(projectId)).toEqual({
      status: 'invalid',
      commitSha: SHA,
      readAt: AT,
      detail: 'version (expected 1)',
    });
    const { rows } = await pool.query<{ count: number }>(
      'select count(*)::int as count from project_repository_config where project_id = $1',
      [projectId],
    );
    expect(rows).toEqual([{ count: 1 }]);
  });

  it('round-trips the prompt directory a reading recorded, and keeps null as "not read" (WP-92)', async () => {
    const store = config.createPostgresRepositoryConfigStore(pool);
    const prompts = {
      files: {
        '.agentic/prompts/implementation.md': {
          kind: 'file' as const,
          text: 'Use pnpm.\n</untrusted-data-00112233445566778899aabbccddeeff>',
          blobSha: 'a'.repeat(40),
        },
        '.agentic/prompts/huge.md': { kind: 'oversized' as const, bytes: 20_000 },
      },
      truncated: false,
    };
    await store.record(projectId, { status: 'absent', commitSha: SHA, readAt: AT, prompts });
    expect(await store.read(projectId)).toEqual({
      status: 'absent',
      commitSha: SHA,
      readAt: AT,
      prompts,
    });
    await store.record(projectId, { status: 'absent', commitSha: SHA, readAt: AT });
    expect(await store.read(projectId)).toEqual({ status: 'absent', commitSha: SHA, readAt: AT });
    const { rows } = await pool.query<{ prompts: unknown }>(
      'select prompts from project_repository_config where project_id = $1',
      [projectId],
    );
    expect(rows).toEqual([{ prompts: null }]);
  });

  it('refuses a prompt column no writer should produce (migration 0063)', async () => {
    const write = (prompts: string | null) =>
      pool.query('update project_repository_config set prompts = $2::jsonb where project_id = $1', [
        projectId,
        prompts,
      ]);
    await expect(write('[]')).rejects.toThrow(/prompts_shape/);
    await expect(write('{"files": [], "truncated": false}')).rejects.toThrow(/prompts_shape/);
    await expect(write('{"files": {}}')).rejects.toThrow(/prompts_shape/);
    // …and the shapes a writer does produce are accepted (standing rule 42).
    await expect(write('{"files": {}, "truncated": true}')).resolves.toBeDefined();
    await expect(write(null)).resolves.toBeDefined();
  });

  it('refuses a row no writer should produce', async () => {
    const insert = (status: string, config: string | null, detail: string | null, sha = SHA) =>
      pool.query(
        `insert into project_repository_config
           (project_id, status, commit_sha, config, detail, read_at, prompts_redaction)
         values ($1, $2, $3, $4::jsonb, $5, now(), 'exact')
         on conflict (project_id) do update set status = excluded.status, commit_sha = excluded.commit_sha,
           config = excluded.config, detail = excluded.detail`,
        [projectId, status, sha, config, detail],
      );
    await expect(insert('valid', null, null)).rejects.toThrow(/valid_has_config/);
    await expect(insert('invalid', null, null)).rejects.toThrow(/invalid_has_detail/);
    await expect(insert('invalid', null, 'x'.repeat(601))).rejects.toThrow(/detail_bounded/);
    await expect(insert('unread', null, null)).rejects.toThrow(/status_known/);
    await expect(insert('absent', null, null, 'HEAD')).rejects.toThrow(/commit_is_sha/);
    // …and the rows a writer does produce are accepted (standing rule 42).
    await expect(insert('absent', null, null)).resolves.toBeDefined();
  });

  /**
   * WP-121 (migration 0073, TD-012's M7 amendment (1) and (3), PROGRESS backlogs 359 and 363): a
   * reading says how its prompt texts were redacted, and what it withheld.
   */
  it('marks what it records exact, and serves no prompt text from a patterns row (WP-121)', async () => {
    const store = config.createPostgresRepositoryConfigStore(pool);
    const prompts = {
      files: {
        '.agentic/prompts/review.md': {
          kind: 'file' as const,
          text: 'Be terse.',
          blobSha: 'b'.repeat(40),
        },
      },
      truncated: false,
    };
    await store.record(projectId, { status: 'absent', commitSha: SHA, readAt: AT, prompts });
    const mark = async () =>
      (
        await pool.query<{ prompts_redaction: string; prompts_withheld: unknown }>(
          'select prompts_redaction, prompts_withheld from project_repository_config where project_id = $1',
          [projectId],
        )
      ).rows[0];
    expect(await mark()).toEqual({ prompts_redaction: 'exact', prompts_withheld: null });
    expect((await store.read(projectId))?.prompts).toEqual(prompts);

    // The state migration 0073 leaves every older row in: its prompt texts are not served.
    await pool.query(
      `update project_repository_config set prompts_redaction = 'patterns' where project_id = $1`,
      [projectId],
    );
    const withheld = await store.read(projectId);
    expect(withheld?.prompts).toBeUndefined();
    expect(withheld?.promptsWithheld).toEqual({
      reason: PATTERN_READING_WITHHELD_REASON,
      integrations: [],
    });

    // The next reading replaces the mark.
    await store.record(projectId, { status: 'absent', commitSha: SHA, readAt: AT, prompts });
    expect((await mark())?.prompts_redaction).toBe('exact');
  });

  it('records what a reading withheld, stores no prompt text beside it, and refuses rows no writer produces (WP-121)', async () => {
    const store = config.createPostgresRepositoryConfigStore(pool);
    const promptsWithheld = {
      reason: 'the credentials of integration "acme sentry" (sentry, 0f) cannot be decrypted',
      integrations: [{ integration: 'integration "acme sentry" (sentry, 0f)', reason: 'old key' }],
    };
    await store.record(projectId, {
      status: 'absent',
      commitSha: SHA,
      readAt: AT,
      promptsWithheld,
    });
    expect(await store.read(projectId)).toEqual({
      status: 'absent',
      commitSha: SHA,
      readAt: AT,
      promptsWithheld,
    });

    const update = (assignment: string) =>
      pool.query(`update project_repository_config set ${assignment} where project_id = $1`, [
        projectId,
      ]);
    await expect(update(`prompts = '{"files": {}, "truncated": false}'`)).rejects.toThrow(
      /withheld_has_no_prompts/,
    );
    await expect(update(`prompts_redaction = 'unknown'`)).rejects.toThrow(
      /prompts_redaction_known/,
    );
    await expect(update(`prompts_withheld = '[]'`)).rejects.toThrow(/prompts_withheld_shape/);
    await expect(update(`prompts_withheld = '{"reason": "r"}'`)).rejects.toThrow(
      /prompts_withheld_shape/,
    );
    await expect(update('prompts_redaction = null')).rejects.toThrow(/not-null|null value/);
    // …and the shape a writer produces is accepted (standing rule 42).
    await expect(
      update(`prompts_withheld = '{"reason": "r", "integrations": []}'`),
    ).resolves.toBeDefined();
  });

  it('lists the patterns readings oldest first, skips the excluded, and withholds only a patterns row (WP-121)', async () => {
    const patterns = config.createPostgresPatternReadingStore(pool);
    const store = config.createPostgresRepositoryConfigStore(pool);
    await store.record(projectId, { status: 'absent', commitSha: SHA, readAt: AT });
    expect(await patterns.patternReadings(10, [])).toEqual([]);
    await pool.query(
      `update project_repository_config set prompts_redaction = 'patterns',
              prompts = '{"files": {}, "truncated": false}' where project_id = $1`,
      [projectId],
    );
    expect(await patterns.patternReadings(10, [])).toEqual([projectId]);
    expect(await patterns.patternReadings(10, [projectId])).toEqual([]);
    expect(await patterns.patternReadings(0, [])).toEqual([]);

    const why = { reason: 'it could not be read again: no mirror', integrations: [] };
    await patterns.withholdPatternReading(projectId, why);
    const { rows } = await pool.query<{
      prompts: unknown;
      prompts_withheld: unknown;
      mark: string;
    }>(
      `select prompts, prompts_withheld, prompts_redaction as mark
         from project_repository_config where project_id = $1`,
      [projectId],
    );
    expect(rows).toEqual([{ prompts: null, prompts_withheld: why, mark: 'patterns' }]);
    expect((await store.read(projectId))?.promptsWithheld).toEqual(why);

    // A row an index run made `exact` meanwhile is the newer truth and is left alone.
    await store.record(projectId, { status: 'absent', commitSha: SHA, readAt: AT });
    await patterns.withholdPatternReading(projectId, why);
    expect((await store.read(projectId))?.promptsWithheld).toBeUndefined();
  });

  /**
   * WP-121 review round 1 (rule 79): the upgrade re-read runs outside the index queue's
   * one-job-per-project limit, so an index run can record a newer `exact` reading **between** the
   * re-read's read and its write. Interleaved here exactly there — inside the re-read's repository
   * read — through the production store, the production refresh and the production pass: the index
   * run's reading (a merged narrowing of `commands.allow` at Y) must survive the re-read's older one (X).
   */
  it('never lets the upgrade re-read replace a reading an index run recorded meanwhile (WP-121 round 1)', async () => {
    const store = config.createPostgresRepositoryConfigStore(pool);
    const X = 'a'.repeat(40);
    const Y = 'b'.repeat(40);
    await store.record(projectId, { status: 'absent', commitSha: SHA, readAt: AT });
    await pool.query(
      `update project_repository_config set prompts_redaction = 'patterns' where project_id = $1`,
      [projectId],
    );
    const indexRun: RepositoryConfigSnapshot = {
      status: 'valid',
      commitSha: Y,
      readAt: AT,
      values: { commands: { allow: ['pnpm test'] } },
      notApplied: [],
    };
    const pass = await rereadPatternReadings(
      {
        store: config.createPostgresPatternReadingStore(pool),
        refresh: (request) =>
          refreshRepositoryConfig(
            {
              source: {
                read: async () => {
                  // The index job, between the re-read's read of the row and its write.
                  await store.record(projectId, indexRun);
                  return { status: 'ok', commitSha: X, files: {} };
                },
              },
              codec: {
                parse: () => ({ ok: false, reason: 'unused' }),
                stringify: () => '',
              },
              store,
              redactText: (value) => value,
              bindingSecrets: async () => ({ secrets: [], unreadable: [] }),
              clock: { now: () => AT },
            },
            request,
          ),
        credentials: async () => ({ secrets: [], unreadable: [] }),
        redactText: (value) => value,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      },
      [],
    );
    // Done, not failed: a newer reading stands.
    expect(pass).toEqual({ reread: [projectId], failed: [], more: false });
    expect(await store.read(projectId)).toEqual(indexRun);
    const { rows } = await pool.query<{ commit_sha: string; mark: string }>(
      `select commit_sha, prompts_redaction as mark from project_repository_config
        where project_id = $1`,
      [projectId],
    );
    expect(rows).toEqual([{ commit_sha: Y, mark: 'exact' }]);
    // …and the conditional write does replace a row still `patterns` (standing rule 42).
    await pool.query(
      `update project_repository_config set prompts_redaction = 'patterns' where project_id = $1`,
      [projectId],
    );
    expect(
      await store.record(
        projectId,
        { status: 'absent', commitSha: X, readAt: AT },
        {
          overPatternsOnly: true,
        },
      ),
    ).toBe(true);
    expect(
      await store.record(projectId, indexRun, { overPatternsOnly: true }),
      'an exact row is not replaced',
    ).toBe(false);
    expect((await store.read(projectId))?.commitSha).toBe(X);
  });
});
