/**
 * `KnowledgeProposalStore` on PostgreSQL — `kb_proposals` (migration 0008) and `kb_health_reports`
 * (migration 0018), WP-18b.
 *
 * Three statements here deserve reading before they are changed.
 *
 * **`decide` is one statement with the status in its `where` clause**, and it returns whether it
 * changed a row. Reading the row, deciding in TypeScript and writing it back would be a
 * read-modify-write across an HTTP request boundary — two maintainers clicking approve and reject
 * within the same second would produce whichever write landed last, with both told they succeeded.
 * The in-memory double cannot reproduce that (its divergence register says so), so the atomicity is
 * this file's to keep.
 *
 * **`listAwaitingApply` is `isAwaitingApply` as SQL**, which is two spellings of one rule
 * (standing rule 41). The contract suite runs the TypeScript predicate over the rows and demands
 * the store return exactly what it selects, which is what converts "they should agree" into a
 * check.
 *
 * **`readHealthInputs` reads the index, not the vault.** `expires` is a `date` column the indexer
 * wrote from the page's frontmatter, and the frontmatter `id` is inside the `frontmatter` jsonb —
 * so a page with no frontmatter contributes nothing to the duplicate check rather than colliding
 * with every other page that also has none.
 */

import type {
  KbHealthInputs,
  KbHealthReportWrite,
  KnowledgeProposalDecision,
  KnowledgeProposalStore,
  ProposalCursor,
  StoredKnowledgeProposal,
  Transaction,
} from '@platform/application';
import type {
  Id,
  IsoDateTime,
  KbHealthFinding,
  KnowledgeProposalKind,
  KnowledgeProposalSource,
  KnowledgeProposalStatus,
  KnowledgeProposalType,
} from '@platform/contracts';
import type { HealthDocument, HealthLink } from '@platform/domain';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

const PROPOSAL_COLUMNS =
  'id, project_id, task_id, run_id, source, kind, type, target_path, delta, evidence, ' +
  'significance, status, decided_by, decided_at, applied_commit_sha, created_at';

interface ProposalRow extends Record<string, unknown> {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string | null;
  readonly run_id: string | null;
  readonly source: string;
  readonly kind: string;
  readonly type: string;
  readonly target_path: string;
  readonly delta: string;
  readonly evidence: unknown;
  readonly significance: number;
  readonly status: string;
  readonly decided_by: string | null;
  readonly decided_at: Date | null;
  readonly applied_commit_sha: string | null;
  readonly created_at: Date;
}

const at = (value: Date | null): IsoDateTime | null =>
  value === null ? null : (new Date(value).toISOString() as IsoDateTime);

const toProposal = (row: ProposalRow): StoredKnowledgeProposal => ({
  id: row.id as Id,
  projectId: row.project_id as Id,
  taskId: row.task_id as Id | null,
  runId: row.run_id as Id | null,
  source: row.source as KnowledgeProposalSource,
  kind: row.kind as KnowledgeProposalKind,
  type: row.type as KnowledgeProposalType,
  targetPath: row.target_path,
  delta: row.delta,
  // `evidence` is `jsonb` holding an array of strings; anything else in it is a row this platform
  // did not write, and it becomes an empty list rather than a crash in a read.
  evidence: Array.isArray(row.evidence)
    ? row.evidence.filter((entry): entry is string => typeof entry === 'string')
    : [],
  significance: Number(row.significance),
  status: row.status as KnowledgeProposalStatus,
  decidedByUserId: row.decided_by as Id | null,
  decidedAt: at(row.decided_at),
  appliedCommitSha: row.applied_commit_sha,
  createdAt: at(row.created_at) as IsoDateTime,
});

/** `isAwaitingApply`, as a `where` clause. Held to the predicate by the contract suite. */
const AWAITING_APPLY =
  "applied_commit_sha is null and (status = 'auto_applied' or (status = 'queued' and decided_at is not null))";

export class PostgresProposalStore implements KnowledgeProposalStore {
  readonly #sql: SqlExecutor;

  constructor(sql: SqlExecutor) {
    this.#sql = sql;
  }

  async insert(tx: Transaction, proposals: readonly StoredKnowledgeProposal[]): Promise<void> {
    if (proposals.length === 0) return;
    const sql = sqlOf(tx);
    for (const proposal of proposals) {
      // Every column, including the three a *fresh* proposal leaves null (`decided_by`,
      // `decided_at`, `applied_commit_sha`). The recorder never fills them — but a store that
      // silently dropped them would be **kinder than the in-memory double**, which keeps whatever
      // it is handed, and the contract suite seeds decided rows to exercise `listAwaitingApply`.
      // Standing rule 1, found by that suite the first time it ran against PostgreSQL.
      await sql.query(
        `insert into kb_proposals
           (id, project_id, task_id, run_id, source, kind, type, target_path, delta, evidence,
            significance, status, decided_by, decided_at, applied_commit_sha, created_at)
         values ($1, $2, $3, $4, $5::knowledge_proposal_source, $6::knowledge_proposal_kind,
                 $7::knowledge_proposal_type, $8, $9, $10::jsonb, $11,
                 $12::knowledge_proposal_status, $13, $14, $15, $16)`,
        [
          proposal.id,
          proposal.projectId,
          proposal.taskId,
          proposal.runId,
          proposal.source,
          proposal.kind,
          proposal.type,
          proposal.targetPath,
          proposal.delta,
          JSON.stringify([...proposal.evidence]),
          proposal.significance,
          proposal.status,
          proposal.decidedByUserId,
          proposal.decidedAt,
          proposal.appliedCommitSha,
          proposal.createdAt,
        ],
      );
    }
  }

  async load(projectId: Id, id: Id): Promise<StoredKnowledgeProposal | null> {
    const { rows } = await this.#sql.query<ProposalRow>(
      `select ${PROPOSAL_COLUMNS} from kb_proposals where project_id = $1 and id = $2`,
      [projectId, id],
    );
    const row = rows[0];
    return row === undefined ? null : toProposal(row);
  }

  async listAwaitingApply(
    projectId: Id,
    limit: number,
  ): Promise<readonly StoredKnowledgeProposal[]> {
    const { rows } = await this.#sql.query<ProposalRow>(
      `select ${PROPOSAL_COLUMNS} from kb_proposals
        where project_id = $1 and ${AWAITING_APPLY}
        order by created_at, id
        limit $2`,
      [projectId, limit],
    );
    return rows.map(toProposal);
  }

  async list(
    projectId: Id,
    query: { readonly limit: number; readonly before?: ProposalCursor },
  ): Promise<readonly StoredKnowledgeProposal[]> {
    // Row comparison, which is the keyset the `order by` below is written for: one curation writes
    // every row of a batch with the same `created_at`, so `created_at < $2` alone would skip the
    // rest of that batch whenever a page ended inside it. PostgreSQL compares `(a, b) < (c, d)`
    // lexicographically, so this is the same predicate the in-memory double spells out.
    const { rows } = await this.#sql.query<ProposalRow>(
      `select ${PROPOSAL_COLUMNS} from kb_proposals
        where project_id = $1
          and ($2::timestamptz is null
               or (created_at, id) < ($2::timestamptz, $3::uuid))
        order by created_at desc, id desc
        limit $4`,
      [projectId, query.before?.createdAt ?? null, query.before?.id ?? null, query.limit],
    );
    return rows.map(toProposal);
  }

  async decide(tx: Transaction, decision: KnowledgeProposalDecision): Promise<boolean> {
    const sql = sqlOf(tx);
    const { rowCount } = await sql.query(
      `update kb_proposals
          set status = $2::knowledge_proposal_status,
              decided_by = $3,
              decided_at = $4,
              delta = coalesce($5, delta)
        where id = $1 and status in ('scored', 'queued')`,
      [
        decision.id,
        decision.status,
        decision.decidedByUserId,
        decision.decidedAt,
        decision.delta ?? null,
      ],
    );
    return (rowCount ?? 0) > 0;
  }

  async markApplied(
    tx: Transaction,
    input: { readonly ids: readonly Id[]; readonly commitSha: string },
  ): Promise<void> {
    if (input.ids.length === 0) return;
    const sql = sqlOf(tx);
    // The `where` repeats the awaiting-apply predicate rather than trusting the caller's list: the
    // job read those rows before it made two provider calls, and a row somebody rejected in the
    // meantime must not be marked applied by a commit that no longer carries a decision.
    await sql.query(
      `update kb_proposals
          set status = 'applied', applied_commit_sha = $2
        where id = any($1::uuid[]) and ${AWAITING_APPLY}`,
      [[...input.ids], input.commitSha],
    );
  }

  async projectsAwaitingApply(limit: number): Promise<readonly Id[]> {
    const { rows } = await this.#sql.query<{ project_id: string }>(
      `select distinct project_id from kb_proposals where ${AWAITING_APPLY} limit $1`,
      [limit],
    );
    return rows.map((row) => row.project_id as Id);
  }

  async readHealthInputs(projectId: Id): Promise<KbHealthInputs> {
    const state = await this.#sql.query<{ commit_sha: string | null }>(
      'select commit_sha from kb_index_state where project_id = $1',
      [projectId],
    );
    const documents = await this.#sql.query<{
      path: string;
      expires: string | null;
      frontmatter_id: string | null;
      tokens: number;
    }>(
      // `to_char`, not the `date` column itself: `pg` parses a `date` into a JavaScript `Date` at
      // **local** midnight, so `toISOString().slice(0, 10)` moves it a day backwards anywhere east
      // of UTC — measured here as `2025-01-01` read back as `2024-12-31` on a machine in
      // Europe/Prague. A calendar date has no zone, so the conversion is the database's.
      `select path,
              to_char(expires, 'YYYY-MM-DD') as expires,
              nullif(frontmatter ->> 'id', '') as frontmatter_id,
              tokens
         from kb_documents
        where project_id = $1
        order by path`,
      [projectId],
    );
    const links = await this.#sql.query<{ from_path: string; to_path: string }>(
      `select d.path as from_path, l.to_path
         from kb_links l
         join kb_documents d on d.id = l.from_document_id
        where d.project_id = $1 and l.resolved_document_id is null
        order by d.path, l.to_path`,
      [projectId],
    );
    return {
      commitSha: state.rows[0]?.commit_sha ?? null,
      documents: documents.rows.map(
        (row): HealthDocument => ({
          path: row.path,
          expires: row.expires,
          frontmatterId: row.frontmatter_id,
          tokens: Number(row.tokens),
        }),
      ),
      danglingLinks: links.rows.map(
        (row): HealthLink => ({ fromPath: row.from_path, toPath: row.to_path }),
      ),
    };
  }

  async writeHealthReport(tx: Transaction, report: KbHealthReportWrite): Promise<void> {
    const sql = sqlOf(tx);
    await sql.query(
      `insert into kb_health_reports (id, project_id, commit_sha, documents, findings, source, created_at)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        report.id,
        report.projectId,
        report.commitSha,
        report.documents,
        JSON.stringify(report.findings satisfies readonly KbHealthFinding[]),
        report.source,
        report.createdAt,
      ],
    );
  }
}
