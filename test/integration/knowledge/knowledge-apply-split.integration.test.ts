/**
 * **One refused knowledge page fails alone** — WP-156 ruling (d), PROGRESS backlog **420**, on the
 * real proposal store, the real event store and PostgreSQL 18.
 *
 * Three approved proposals of one project are written in one statement with the column's
 * `uuidv7()` default, so their ids share their first eight digits, the batch branch's discriminator
 * — not how production writes them (every writer passes a `randomUUID()` v4 id), but the worst case
 * for the split's branch naming —
 * and the git port refuses, on every attempt, any commit that carries the second page, the way
 * GitLab refuses a commit whole with a 4xx and names no file (`invalid_request`). The pass then
 * commits each page on its own: two rows read `applied` with a commit and a merge request, one reads
 * `apply_failed` with the refusal class in its reason, and the project stream carries two
 * `knowledge.proposal.applied` events. The provider stands in as a stub because the point is the
 * store's rows; the unit cases in `packages/application/src/knowledge/apply.test.ts` hold the calls.
 *
 * The canary (recorded in PROGRESS under WP-156): with the split disarmed in `apply.ts`, the pass
 * throws the batch's refusal and all three rows stay `auto_applied`.
 */
import {
  applyKnowledgeProposals,
  exactSecretRedactor,
  IntegrationError,
  type KnowledgeApplyOptions,
  type PipelineIntegrations,
  silentLogger,
  staticPipelineIntegrations,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { fixedClock } from '@platform/domain';
import { eventing, knowledge } from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

const PAGES = ['L-1', 'L-2', 'L-3'].map((name) => `.agentic/knowledge/lessons/${name}.md`);
const REFUSED = PAGES[1] as string;

let database: MigratedDatabase;
let pool: pg.Pool;
let projectId: Id;

beforeAll(async () => {
  database = await createMigratedDatabase('knowledge-apply-split');
  pool = createTestPool(database.connectionString, { max: 6 });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('split') returning id",
  );
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'split', 'Split', 'https://git.example.test/acme/split.git') returning id`,
    [org.rows[0]?.id],
  );
  projectId = project.rows[0]?.id as Id;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('a knowledge batch the provider refuses whole (WP-156 (d), backlog 420)', () => {
  it('commits the pages it can on their own and fails only the refused one, on the real store', async () => {
    // One statement and the column's uuidv7 default (production passes v4 ids): the worst case.
    const inserted = await pool.query<{ id: string; target_path: string }>(
      `insert into kb_proposals (project_id, source, kind, type, target_path, delta, significance,
                                 status)
       select $1, 'task', 'technical', 'lesson', path, '# ' || path, 0.5, 'auto_applied'
         from unnest($2::text[]) with ordinality as p(path, n) order by n
       returning id, target_path`,
      [projectId, PAGES],
    );
    const idOf = new Map(inserted.rows.map((row) => [row.target_path, row.id]));
    expect(new Set(inserted.rows.map((row) => row.id.slice(0, 8))).size).toBe(1);

    const commits: { branch: string; paths: string[] }[] = [];
    const mergeRequests: string[] = [];
    const port = {
      commitFiles: async (request: { branch: string; actions: readonly { path: string }[] }) => {
        commits.push({ branch: request.branch, paths: request.actions.map((a) => a.path) });
        if (request.actions.some((action) => action.path === REFUSED)) {
          throw new IntegrationError('invalid_request', 'fake-git', '400 Bad Request');
        }
        return { sha: `c0ffee${String(commits.length)}`, branch: request.branch, url: null };
      },
      openMergeRequest: async (draft: { branch: string }) => {
        mergeRequests.push(draft.branch);
        const iid = mergeRequests.length;
        return {
          ref: {
            provider: 'fake-git',
            project_path: 'acme/split',
            iid,
            url: `https://git.example.test/acme/split/-/merge_requests/${String(iid)}`,
          },
          web_url: `https://git.example.test/acme/split/-/merge_requests/${String(iid)}`,
        };
      },
      getMergeRequest: async () => ({ state: 'opened' }),
    };
    const integrations: PipelineIntegrations = {
      executor: {
        execute: async (request: { perform: () => Promise<unknown> }) => ({
          status: 'ok' as const,
          result: await request.perform(),
        }),
      } as unknown as PipelineIntegrations['executor'],
      git: {
        port: port as unknown as NonNullable<PipelineIntegrations['git']>['port'],
        ref: { integrationId: projectId, provider: 'fake-git', type: 'git' as const, host: null },
        project: 'acme/split',
        redactor: exactSecretRedactor([]),
      },
      taskManagement: null,
      communication: null,
    };
    const options: KnowledgeApplyOptions = {
      unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
      eventStore: new eventing.PostgresEventStore(pool),
      proposals: new knowledge.PostgresProposalStore(pool),
      knowledge: {
        readIndexedBlobs: async () => new Map(),
      } as unknown as KnowledgeApplyOptions['knowledge'],
      integrations: staticPipelineIntegrations(integrations),
      jobs: { enqueue: async () => ({ status: 'enqueued', jobId: null }) } as never,
      clock: fixedClock('2026-10-07T10:00:00.000Z' as IsoDateTime),
      ids: { next: () => crypto.randomUUID() as Id },
      project: async () => ({ knowledgeDir: '.agentic/knowledge', defaultBranch: 'main' }),
      ticketKeys: async () => new Map(),
      logger: silentLogger,
    };

    const report = await applyKnowledgeProposals(options, {
      project_id: projectId,
      reason: 'decision',
    });

    expect(report).toMatchObject({ status: 'applied', applied: 2, failed: 1, remaining: 0 });
    expect(commits.map((commit) => commit.paths)).toEqual([
      PAGES,
      [PAGES[0]],
      [PAGES[1]],
      [PAGES[2]],
    ]);
    // Three single branches, distinct although the ids share the batch discriminator.
    expect(new Set(commits.slice(1).map((commit) => commit.branch)).size).toBe(3);

    const rows = await pool.query<{
      target_path: string;
      status: string;
      applied_commit_sha: string | null;
      applied_merge_request: { iid: number } | null;
      apply_failure_reason: string | null;
    }>(
      `select target_path, status::text as status, applied_commit_sha, applied_merge_request,
              apply_failure_reason
         from kb_proposals where project_id = $1 order by target_path`,
      [projectId],
    );
    expect(rows.rows.map((row) => [row.target_path, row.status])).toEqual([
      [PAGES[0], 'applied'],
      [PAGES[1], 'apply_failed'],
      [PAGES[2], 'applied'],
    ]);
    expect(rows.rows[0]?.applied_commit_sha).toBe('c0ffee2');
    expect(rows.rows[0]?.applied_merge_request?.iid).toBe(1);
    expect(rows.rows[2]?.applied_commit_sha).toBe('c0ffee4');
    expect(rows.rows[2]?.applied_merge_request?.iid).toBe(2);
    expect(rows.rows[1]?.applied_commit_sha).toBeNull();
    expect(rows.rows[1]?.apply_failure_reason).toContain(`${REFUSED} (invalid_request)`);
    // The provider's own words never reach the stored reason.
    expect(rows.rows[1]?.apply_failure_reason).not.toContain('400 Bad Request');

    const applied = await pool.query<{ proposal_id: string }>(
      `select payload ->> 'proposal_id' as proposal_id from events
        where stream_type = 'project' and stream_id = $1 and type = 'knowledge.proposal.applied'
        order by stream_seq`,
      [projectId],
    );
    expect(applied.rows.map((row) => row.proposal_id)).toEqual([
      idOf.get(PAGES[0] as string),
      idOf.get(PAGES[2] as string),
    ]);
  });
});
