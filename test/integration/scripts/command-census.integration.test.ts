/**
 * The recorded-command census on PostgreSQL (WP-225 criteria 2–4): `run_messages` seeded with
 * composed lines — one per tier-3 class, plus controls and the rows the read must not count — read
 * through the script's own session and counted, the session refused a write, and the command's
 * stdout held to carrying no word of a recorded line.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  censusCounts,
  readRecordedCalls,
  withReadOnlySession,
} from '../../../scripts/command-census.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { withClient } from '../support/postgres.js';

const SCRIPT = fileURLToPath(new URL('../../../scripts/command-census.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DAY_MS = 86_400_000;
const token = `zzcensus${randomUUID().replaceAll('-', '')}`;

type Block = Record<string, unknown>;
const bashCall = (id: string, command: unknown): Block => ({
  type: 'tool_use',
  tool_use_id: id,
  tool_name: 'Bash',
  input: { command, description: 'composed' },
});

let database: MigratedDatabase;
let since: Date;

const seed = async (connectionString: string): Promise<void> => {
  await withClient(connectionString, async (client) => {
    const org = await client.query<{ id: string }>(
      "insert into organizations (name) values ('census') returning id",
    );
    const project = await client.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'census', 'census', 'https://example.invalid/census') returning id`,
      [org.rows[0]?.id],
    );
    const runs: string[] = [];
    for (const key of ['CEN-1', 'CEN-2']) {
      const task = await client.query<{ id: string }>(
        `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template)
         values ($1, 'fake', $2, 'https://example.invalid/t', 'feature') returning id`,
        [project.rows[0]?.id, key],
      );
      const run = await client.query<{ id: string }>(
        `insert into runs (task_id, project_id, role, model, prompt_version)
         values ($1, $2, 'developer', 'claude-opus-5', 'developer@1') returning id`,
        [task.rows[0]?.id, project.rows[0]?.id],
      );
      runs.push(run.rows[0]?.id as string);
    }
    const [runA, runB] = runs as [string, string];
    const blob = await client.query<{ id: string }>(
      `insert into blobs (sha256, size, media_type, data)
       values ('fake', 1, 'application/json', '\\x00'::bytea) returning id`,
    );
    const insert = async (
      runId: string,
      seq: number,
      kind: 'assistant' | 'stream_block',
      blocks: Block[],
      options: { readonly ageMs?: number; readonly blobId?: string } = {},
    ): Promise<void> => {
      const createdAt = new Date(Date.now() - (options.ageMs ?? 0)).toISOString();
      const payload =
        kind === 'assistant'
          ? {
              run_id: runId,
              seq,
              created_at: createdAt,
              kind,
              model: 'claude-opus-5',
              content: blocks,
              redaction_count: 0,
            }
          : {
              run_id: runId,
              seq,
              created_at: createdAt,
              kind,
              block_index: 0,
              block: blocks[0],
              first_delta_at: createdAt,
              last_delta_at: createdAt,
              redaction_count: 0,
            };
      await client.query(
        `insert into run_messages (run_id, seq, created_at, kind, payload, blob_id)
         values ($1, $2, $3::timestamptz, $4::transcript_kind, $5::jsonb, $6)`,
        [runId, seq, createdAt, kind, JSON.stringify(payload), options.blobId ?? null],
      );
    };
    // Run A: one line per class, the run writing its script first, and the controls.
    await insert(runA, 1, 'assistant', [
      {
        type: 'tool_use',
        tool_use_id: 'a1',
        tool_name: 'Write',
        input: { file_path: '/work/repo/tools/build-helper.sh', content: 'x' },
      },
    ]);
    await insert(runA, 2, 'assistant', [bashCall('a2', 'bash tools/build-helper.sh')]);
    await insert(runA, 3, 'assistant', [bashCall('a3', `python3 -c "print('${token}')"`)]);
    await insert(runA, 4, 'assistant', [bashCall('a4', `git -C ../${token}-dir status`)]);
    await insert(runA, 5, 'assistant', [bashCall('a5', `frobnicate --target "$${token}"`)]);
    // A reason built from the line names the program: a tag printer would leak it (rule 43).
    await insert(runA, 6, 'assistant', [bashCall('a6', `${token} sudo id`)]);
    await insert(runA, 7, 'assistant', [
      { type: 'text', text: 'running the controls' },
      bashCall('a7', 'ls -la'),
      bashCall('a8', 'git status'),
      bashCall('a9', 'python3 -m pytest -q'),
      bashCall('a10', 'echo "$HOME"'),
    ]);
    // The same call stored twice (a resume) counts once.
    await insert(runA, 8, 'assistant', [bashCall('a3', `python3 -c "print('${token}')"`)]);
    // Read from the finished message only, never from its stream block.
    await insert(runA, 9, 'stream_block', [bashCall('a11', 'node -e "1"')]);
    // The token in a written path, a here-document body and an assignment: none is printed either.
    await insert(runA, 10, 'assistant', [
      {
        type: 'tool_use',
        tool_use_id: 'a12',
        tool_name: 'Write',
        input: { file_path: `/work/repo/${token}.txt`, content: 'x' },
      },
      bashCall('a13', `cat <<EOF\n${token}\nEOF`),
      bashCall('a14', `CENSUS_X=${token} ls`),
    ]);
    // Run B: the same script name, never written in this run, is no written script.
    await insert(runB, 1, 'assistant', [bashCall('b1', 'bash build-helper.sh')]);
    await insert(runB, 2, 'assistant', [bashCall('b2', 42)]);
    // Before `since`, and a row held in a blob: neither is read.
    await insert(runB, 3, 'assistant', [bashCall('b3', 'perl -e 1')], { ageMs: 10 * DAY_MS });
    await insert(runB, 4, 'assistant', [bashCall('b4', 'ruby -e 1')], {
      blobId: blob.rows[0]?.id as string,
    });
  });
};

beforeAll(async () => {
  database = await createMigratedDatabase('command_census');
  await seed(database.connectionString);
  since = new Date(Date.now() - DAY_MS);
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

describe('the recorded-command census on a seeded database', () => {
  it('counts every class once, the controls in no class, and skips what it must not read', async () => {
    const read = await withReadOnlySession(database.connectionString, (client) =>
      readRecordedCalls(client, since, 1_000),
    );
    expect(read).toMatchObject({ rowsRead: 11, capReached: false, skippedBlobRows: 1 });
    const counts = censusCounts(read.calls);
    expect(counts.runs).toBe(2);
    expect(counts.lines).toBe(12);
    expect(counts.skippedNoCommand).toBe(1);
    expect({
      inline_interpreter: counts.tier3.inline_interpreter.lines,
      written_script: counts.tier3.written_script.lines,
      git_dash_c: counts.tier3.git_dash_c.lines,
      unshipped_wrapper_expansion: counts.tier3.unshipped_wrapper_expansion.lines,
      any: counts.tier3.any.lines,
    }).toEqual({
      inline_interpreter: 1,
      written_script: 1,
      git_dash_c: 1,
      unshipped_wrapper_expansion: 1,
      any: 4,
    });
    for (const mode of ['attended', 'auto', 'deny'] as const) {
      expect(Object.values(counts.cells[mode]).reduce((a, b) => a + b, 0)).toBe(12);
    }
    expect(counts.uncertainty.unknownProgramRunsJudgedName).toBeGreaterThanOrEqual(1);
  });

  it('reports a reached cap', async () => {
    const read = await withReadOnlySession(database.connectionString, (client) =>
      readRecordedCalls(client, since, 3),
    );
    expect(read).toMatchObject({ rowsRead: 3, capReached: true });
    // The other side (rule 42): a cap equal to the row count is not reached.
    const exact = await withReadOnlySession(database.connectionString, (client) =>
      readRecordedCalls(client, since, 11),
    );
    expect(exact).toMatchObject({ rowsRead: 11, capReached: false });
  });

  it('reads in a session that refuses a write', async () => {
    await expect(
      withReadOnlySession(database.connectionString, (client) =>
        client.query("insert into organizations (name) values ('census-write')"),
      ),
    ).rejects.toMatchObject({ code: '25006' });
    const { rows } = await withClient(database.connectionString, (client) =>
      client.query("select count(*)::int as n from organizations where name = 'census-write'"),
    );
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('prints counts and never a word of a recorded line', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--since', since.toISOString()], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: database.connectionString, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('bash_lines: 12\n');
    expect(run.stdout).toContain('tier3.any: 4\n');
    expect(run.stdout).toContain('tier3.git_dash_c: 1\n');
    expect(run.stdout.trimEnd().split('\n').at(-1)).toBe('PASS: command-census');
    expect(run.stdout).not.toContain(token);
    expect(run.stderr).not.toContain(token);
  });

  const failedRun = (databaseUrl: string) => {
    const { FORCE_COLOR: _colour, ...env } = process.env;
    return spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      env: { ...env, DATABASE_URL: databaseUrl, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };

  // The server's own message names the database (`database "<token>" does not exist`), so a
  // command that printed the message would leak it (rule 43); the refused port is the brief's case.
  it.each([
    ['a refused connection', `postgres://u:${token}@127.0.0.1:1/x`, 'ECONNREFUSED'],
    ['a database the server does not have', 'unknown-database', '3D000'],
  ])('fails on %s with one FAIL line, its code, and never the message', (_name, target, code) => {
    const url =
      target === 'unknown-database'
        ? Object.assign(new URL(database.connectionString), { pathname: `/${token}` }).toString()
        : target;
    const run = failedRun(url);
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain(token);
    expect(run.stderr).not.toContain(token);
    const failures = run.stdout.split('\n').filter((line) => line.startsWith('FAIL:'));
    expect(failures).toEqual([
      `FAIL: command-census — ${code} (message withheld: it may quote row data)`,
    ]);
  });
});
