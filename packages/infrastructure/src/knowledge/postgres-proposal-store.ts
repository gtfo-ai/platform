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
 * with every other page that also has none. The one input that is *not* the index is
 * `kb_index_refusals` — the documents the parser kept out of it — which the index run writes beside
 * the documents (WP-57).
 */

import type {
  KbHealthInputs,
  KbHealthReportWrite,
  KnowledgeApplyCarrier,
  KnowledgeProposalDecision,
  KnowledgeProposalStore,
  ProposalCursor,
  StoredKnowledgeProposal,
  Transaction,
} from '@platform/application';
import { MAX_CARRIERS_PER_PATH } from '@platform/application';
import type {
  Id,
  IsoDateTime,
  KbHealthReportFinding,
  KnowledgeProposalKind,
  KnowledgeProposalSource,
  KnowledgeProposalStatus,
  KnowledgeProposalType,
  MergeRequestRef,
} from '@platform/contracts';
import { mergeRequestRefSchema } from '@platform/contracts';
import type { HealthDocument, HealthLink, HealthRefusal } from '@platform/domain';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

const PROPOSAL_COLUMNS =
  'id, project_id, task_id, run_id, source, kind, type, target_path, delta, evidence, ' +
  'significance, status, decided_by, decided_at, applied_commit_sha, created_at, apply_failure_reason, ' +
  'applied_merge_request, apply_deferred_reason';

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
  readonly apply_failure_reason: string | null;
  readonly applied_merge_request: unknown;
  readonly apply_deferred_reason: string | null;
}

/**
 * The stored merge-request reference, **parsed** (WP-125): it is the provider's answer to
 * `openMergeRequest` (BD-022), so a value that does not parse is read as no merge request rather
 * than handed to a provider read.
 */
const mergeRequestOf = (value: unknown): MergeRequestRef | null => {
  if (value === null || value === undefined) return null;
  const parsed = mergeRequestRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

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
  // Present only on an `apply_failed` row (WP-124), so a row with none reads as it did before.
  ...(row.apply_failure_reason === null ? {} : { applyFailureReason: row.apply_failure_reason }),
  // WP-125: present only when set, so a row with neither reads as it did before.
  ...(mergeRequestOf(row.applied_merge_request) === null
    ? {}
    : { appliedMergeRequest: mergeRequestOf(row.applied_merge_request) }),
  ...(row.apply_deferred_reason === null ? {} : { applyDeferredReason: row.apply_deferred_reason }),
});

/** `isAwaitingApply`, as a `where` clause. Held to the predicate by the contract suite. */
export const AWAITING_APPLY =
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

  /**
   * The curation's own row (migration 0036, WP-48), which is the mark **and** the idempotency key.
   *
   * One statement: the insert claims an artifact nobody has curated, and the `on conflict … do
   * update … where curated_at is null` claims one a recovery pass has already written a row for
   * (its attempt, or its ending). A row that is already curated updates nothing and the `rowCount`
   * says so, which is what the caller branches on.
   *
   * A **late** curation is admitted after an ending: `abandoned_at` is deliberately *not* in the
   * predicate, so the row ends up carrying both instants — the platform gave up at one and the work
   * arrived at the other — rather than throwing away proposals a run was paid for.
   */
  async markCurated(
    tx: Transaction,
    input: { readonly artifactId: Id; readonly at: IsoDateTime; readonly proposals: number },
  ): Promise<boolean> {
    const { rowCount } = await sqlOf(tx).query(
      `insert into knowledge_curations (artifact_id, curated_at, proposals)
            values ($1, $2, $3)
       on conflict (artifact_id) do update
          set curated_at = excluded.curated_at, proposals = excluded.proposals
        where knowledge_curations.curated_at is null`,
      [input.artifactId, input.at, input.proposals],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * The curation's refusal (WP-125, PROGRESS backlog 356): the project's stored settings did not
   * parse. One statement that records the instant **and clears the recovery's attempt**, so a
   * refusal never spends the one attempt `recovery/stranded.ts` has — the pass then finds the row
   * unattempted and re-offers it at its interval until the document parses. A row already curated
   * or given up on is left as it is.
   */
  async markCurationRefused(
    tx: Transaction,
    input: { readonly artifactId: Id; readonly at: IsoDateTime },
  ): Promise<void> {
    await sqlOf(tx).query(
      `insert into knowledge_curations (artifact_id, settings_refused_at)
            values ($1, $2)
       on conflict (artifact_id) do update
          set settings_refused_at = excluded.settings_refused_at,
              recovery_attempted_at = null
        where knowledge_curations.curated_at is null
          and knowledge_curations.abandoned_at is null`,
      [input.artifactId, input.at],
    );
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
      // `apply_failed` is decidable again (WP-124): the decision clears the recovery's mark and
      // reason in the same statement, so a re-approved proposal gets one more recovery attempt.
      `update kb_proposals
          set status = $2::knowledge_proposal_status,
              decided_by = $3,
              decided_at = $4,
              delta = coalesce($5, delta),
              apply_recovery_attempted_at = null,
              apply_failure_reason = null,
              -- WP-125: a deferral was a statement about the decision this one replaces.
              apply_deferred_reason = null
        where id = $1 and status in ('scored', 'queued', 'apply_failed')`,
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

  async supersedeQueued(
    tx: Transaction,
    input: {
      readonly projectId: Id;
      readonly source: KnowledgeProposalSource;
      readonly paths: readonly string[];
      readonly keep: readonly Id[];
      readonly reason: string;
    },
  ): Promise<readonly Id[]> {
    if (input.paths.length === 0) return [];
    const sql = sqlOf(tx);
    // The whole predicate in one statement, as `decide` keeps it: a row a maintainer decided in the
    // meantime has `decided_at` set and is left alone, and a row this statement discarded is no
    // longer `queued` for `decide` to take. The reason goes first in `evidence`, where the history
    // bootstrap puts a refused citation's reason.
    const { rows } = await sql.query<{ id: string }>(
      `update kb_proposals
          set status = 'discarded',
              evidence = jsonb_build_array($5::text) || evidence
        where project_id = $1
          and source = $2::knowledge_proposal_source
          and status = 'queued'
          and decided_at is null
          and applied_commit_sha is null
          and target_path = any($3::text[])
          and not (id = any($4::uuid[]))
        returning id`,
      [input.projectId, input.source, [...input.paths], [...input.keep], input.reason],
    );
    return rows.map((row) => row.id as Id);
  }

  async markApplied(
    tx: Transaction,
    input: {
      readonly ids: readonly Id[];
      readonly commitSha: string;
      readonly mergeRequest?: MergeRequestRef | null;
    },
  ): Promise<void> {
    if (input.ids.length === 0) return;
    const sql = sqlOf(tx);
    // The `where` repeats the awaiting-apply predicate rather than trusting the caller's list: the
    // job read those rows before it made two provider calls, and a row somebody rejected in the
    // meantime must not be marked applied by a commit that no longer carries a decision. WP-125:
    // the merge request that carries the commit is recorded (backlog 369), and a deferral cleared.
    await sql.query(
      `update kb_proposals
          set status = 'applied', applied_commit_sha = $2, applied_merge_request = $3::jsonb,
              apply_deferred_reason = null
        where id = any($1::uuid[]) and ${AWAITING_APPLY}`,
      [
        [...input.ids],
        input.commitSha,
        input.mergeRequest == null ? null : JSON.stringify(input.mergeRequest),
      ],
    );
  }

  async markApplyFailed(
    tx: Transaction,
    input: { readonly failures: readonly { readonly id: Id; readonly reason: string }[] },
  ): Promise<readonly Id[]> {
    const moved: Id[] = [];
    const sql = sqlOf(tx);
    for (const failure of input.failures) {
      // Conditional on the awaiting-apply predicate, as `markApplied` is: a row somebody decided
      // since the pass read it is not given a failure that is no longer about it (WP-156).
      const { rows } = await sql.query<{ id: string }>(
        `update kb_proposals
            set status = 'apply_failed', apply_failure_reason = $2, apply_deferred_reason = null
          where id = $1 and ${AWAITING_APPLY}
          returning id`,
        [failure.id, failure.reason],
      );
      moved.push(...rows.map((row) => row.id as Id));
    }
    return moved;
  }

  /**
   * The applied proposals of these paths that recorded a merge request, newest first, at most
   * {@link MAX_CARRIERS_PER_PATH} per path (WP-125, backlog 369). A stored reference that does not
   * parse is dropped here, never handed to a provider read.
   */
  async applyCarriers(
    projectId: Id,
    paths: readonly string[],
  ): Promise<readonly KnowledgeApplyCarrier[]> {
    if (paths.length === 0) return [];
    const { rows } = await this.#sql.query<{
      id: string;
      target_path: string;
      applied_merge_request: unknown;
    }>(
      `select id, target_path, applied_merge_request from (
         select id, target_path, applied_merge_request,
                row_number() over (partition by target_path order by created_at desc, id desc) as n
           from kb_proposals
          where project_id = $1
            and target_path = any($2::text[])
            and status = 'applied'
            and applied_merge_request is not null
       ) x
       where x.n <= $3
       order by target_path, n`,
      [projectId, [...paths], MAX_CARRIERS_PER_PATH],
    );
    return rows.flatMap((row) => {
      const mergeRequest = mergeRequestOf(row.applied_merge_request);
      return mergeRequest === null
        ? []
        : [{ proposalId: row.id as Id, targetPath: row.target_path, mergeRequest }];
    });
  }

  async clearApplyDeferral(tx: Transaction, input: { readonly ids: readonly Id[] }): Promise<void> {
    if (input.ids.length === 0) return;
    await sqlOf(tx).query(
      `update kb_proposals set apply_deferred_reason = null
        where id = any($1::uuid[]) and apply_deferred_reason is not null`,
      [[...input.ids]],
    );
  }

  async deferApply(
    tx: Transaction,
    input: { readonly deferrals: readonly { readonly id: Id; readonly reason: string }[] },
  ): Promise<void> {
    const sql = sqlOf(tx);
    for (const deferral of input.deferrals) {
      // Conditional on the awaiting-apply predicate: a row a maintainer rejected, or a commit
      // carried, since the pass read it is not given a reason that is no longer true of it.
      await sql.query(
        `update kb_proposals set apply_deferred_reason = $2
          where id = $1 and ${AWAITING_APPLY}`,
        [deferral.id, deferral.reason],
      );
    }
  }

  async projectsAwaitingApply(limit: number): Promise<readonly Id[]> {
    const { rows } = await this.#sql.query<{ project_id: string }>(
      `select distinct project_id from kb_proposals where ${AWAITING_APPLY} limit $1`,
      [limit],
    );
    return rows.map((row) => row.project_id as Id);
  }

  async readHealthInputs(projectId: Id): Promise<KbHealthInputs> {
    const state = await this.#sql.query<{
      commit_sha: string | null;
      path_witnesses: string[] | null;
    }>('select commit_sha, path_witnesses from kb_index_state where project_id = $1', [projectId]);
    const documents = await this.#sql.query<{
      path: string;
      expires: string | null;
      frontmatter_id: string | null;
      tokens: number;
      paths: string[] | null;
    }>(
      // `to_char`, not the `date` column itself: `pg` parses a `date` into a JavaScript `Date` at
      // **local** midnight, so `toISOString().slice(0, 10)` moves it a day backwards anywhere east
      // of UTC — measured here as `2025-01-01` read back as `2024-12-31` on a machine in
      // Europe/Prague. A calendar date has no zone, so the conversion is the database's.
      `select path,
              to_char(expires, 'YYYY-MM-DD') as expires,
              nullif(frontmatter ->> 'id', '') as frontmatter_id,
              tokens,
              paths
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
    // What the last index run refused (WP-57, migration 0041). The index run replaces these rows
    // in the transaction that writes the documents, so they describe the same commit.
    const refusals = await this.#sql.query<{ path: string; reason: string; line: number | null }>(
      `select path, reason, line
         from kb_index_refusals
        where project_id = $1
        order by path`,
      [projectId],
    );
    return {
      commitSha: state.rows[0]?.commit_sha ?? null,
      // WP-58 (migration 0042): the witnesses the `unresolved_paths` finding is judged against.
      pathWitnesses: state.rows[0]?.path_witnesses ?? null,
      refusals: refusals.rows.map(
        (row): HealthRefusal => ({
          path: row.path,
          reason: row.reason,
          line: row.line === null ? null : Number(row.line),
        }),
      ),
      documents: documents.rows.map(
        (row): HealthDocument => ({
          path: row.path,
          expires: row.expires,
          frontmatterId: row.frontmatter_id,
          tokens: Number(row.tokens),
          paths: row.paths ?? [],
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
        JSON.stringify(report.findings satisfies readonly KbHealthReportFinding[]),
        report.source,
        report.createdAt,
      ],
    );
  }
}
