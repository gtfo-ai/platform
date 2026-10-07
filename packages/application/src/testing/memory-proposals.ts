/**
 * An in-memory `KnowledgeProposalStore` — the double every unit test of the Librarian pipeline runs
 * on (WP-18b).
 *
 * ## Divergence register (standing rule 1: a fake may be stricter than the real adapter, never
 * kinder, and every deliberate difference is written down where the fake is defined)
 *
 * | # | Divergence | Direction | Why it is safe |
 * |---|---|---|---|
 * | 1 | **Writes are not transactional** unless the store is built with `rollback` (WP-109). Without it the maps mutate immediately and the `Transaction` handle is accepted and unused; with `MemoryEventing.onRollback` passed in, every write registers its undo on the transaction it was made in, and a transaction that throws undoes it — which is what lets a unit test re-run a lost sequence race in place without the first attempt's claim answering the second. Visibility is still immediate: a concurrent reader sees a row its writer has not committed. | **Kinder** without `rollback`; *different* with it | `test/integration/knowledge/postgres-knowledge-store.integration.test.ts` runs the same contract suite against PostgreSQL, where a failed transaction really does undo the insert. |
 * | 2 | **`decide` compares the status in JavaScript** where the adapter does it in the `where` clause of one statement. | *Different* | The adapter's version is atomic against a concurrent decider and this one is not, so a **lost-update** race cannot be reproduced here. The contract suite asserts the observable both share — a second decision on a decided row answers `false` — and the atomicity is the adapter's to keep. |
 * | 3 | **Ordering is insertion order reversed**, not `(created_at, id) desc`. | *Different* | For a batch written in id order — which is what `recordLibrarianProposals` does — the two agree, and the contract suite pages through a same-timestamp batch to hold them to it. A test that inserted out of id order would see the two disagree, so no test may assert an ordering from this double and claim it of PostgreSQL. |
 * | 4 | **`readHealthInputs` answers what it was seeded with.** It holds no index of its own, so a test decides what the pass sees. | *Different* | The real one reads `kb_documents` and `kb_links`. A test that asserted "the pass found the expired page the indexer wrote" would be asserting this seam rather than the query, which is why the postgres half of the contract suite seeds rows and asks the adapter. |
 * | 5 | **`markCurated` holds the claim in a map** rather than in `knowledge_curations`, and it does not model the recovery's own columns (`recovery_attempted_at`, `abandoned_at`). `markCurationRefused` (WP-125) records the refusal's instant in the same map and so cannot show that it **clears** the recovery's attempt. | *Different* | The observable both share — the first call answers `true` and every later one `false`, so a redelivered wake-up writes no second set of proposals, and a refusal does not curate — is what the contract suite asserts. The recovery's columns are written by `StrandedWorkStore`, whose queries are the integration tier's: `test/integration/knowledge/curation-settings-refusal.integration.test.ts` holds the cleared attempt. |
 * | 6 | **`applyCarriers` orders by insertion, newest first**, where the adapter orders by `(created_at, id) desc` (WP-125). | *Different* | Divergence 3's shape; the contract suite asserts which carriers come back and the per-path bound, not their order. |
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import type {
  KbHealthInputs,
  KbHealthReportWrite,
  KnowledgeApplyCarrier,
  KnowledgeProposalDecision,
  KnowledgeProposalStore,
  StoredKnowledgeProposal,
} from '../knowledge/ports.js';
import { isAwaitingApply, MAX_CARRIERS_PER_PATH } from '../knowledge/ports.js';
import type { Transaction } from '../ports/transaction.js';

export interface MemoryProposalStore extends KnowledgeProposalStore {
  /** Everything written, oldest first — what a test asserts on. */
  readonly rows: readonly StoredKnowledgeProposal[];
  /** Which artifacts have been curated, and what each curation produced (WP-48). */
  curationOf(artifactId: Id): { readonly proposals: number } | null;
  /** When the project's settings last refused this artifact's curation, if they did (WP-125). */
  refusalOf(artifactId: Id): IsoDateTime | null;
  readonly reports: readonly KbHealthReportWrite[];
  /** What {@link KnowledgeProposalStore.readHealthInputs} will answer for this project. */
  seedHealthInputs(projectId: Id, inputs: KbHealthInputs): void;
}

const EMPTY_INPUTS: KbHealthInputs = {
  commitSha: null,
  documents: [],
  danglingLinks: [],
  refusals: [],
  pathWitnesses: null,
};

/**
 * Registers an undo on the transaction a write was made in — `MemoryEventing.onRollback`, passed
 * by a test that needs divergence 1 closed.
 */
export type MemoryRollback = (tx: Transaction, undo: () => void) => void;

export const memoryProposalStore = (
  options: { readonly rollback?: MemoryRollback } = {},
): MemoryProposalStore => {
  const undoOnRollback: MemoryRollback = options.rollback ?? (() => {});
  const rows: StoredKnowledgeProposal[] = [];
  const reports: KbHealthReportWrite[] = [];
  /** `knowledge_curations`, as much of it as this double needs: the claim and what it produced. */
  const curations = new Map<
    Id,
    { curatedAt: IsoDateTime | null; proposals: number; settingsRefusedAt: IsoDateTime | null }
  >();
  const health = new Map<Id, KbHealthInputs>();

  const replace = (index: number, next: StoredKnowledgeProposal): void => {
    rows.splice(index, 1, next);
  };
  /** Puts a row back as it was before a rolled-back write. */
  const restore = (previous: StoredKnowledgeProposal): void => {
    const index = rows.findIndex((row) => row.id === previous.id);
    if (index >= 0) replace(index, previous);
  };

  return {
    rows,
    reports,
    curationOf: (artifactId) => {
      const row = curations.get(artifactId);
      return row === undefined || row.curatedAt === null ? null : { proposals: row.proposals };
    },
    refusalOf: (artifactId) => curations.get(artifactId)?.settingsRefusedAt ?? null,
    seedHealthInputs: (projectId, inputs) => {
      health.set(projectId, inputs);
    },

    insert: async (tx: Transaction, proposals) => {
      rows.push(...proposals);
      undoOnRollback(tx, () => {
        const ids = new Set(proposals.map((proposal) => proposal.id));
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (ids.has((rows[index] as StoredKnowledgeProposal).id)) rows.splice(index, 1);
        }
      });
    },

    markCurated: async (tx: Transaction, input) => {
      const existing = curations.get(input.artifactId);
      if (existing?.curatedAt != null) {
        return false;
      }
      curations.set(input.artifactId, {
        curatedAt: input.at,
        proposals: input.proposals,
        settingsRefusedAt: existing?.settingsRefusedAt ?? null,
      });
      undoOnRollback(tx, () => {
        if (existing === undefined) curations.delete(input.artifactId);
        else curations.set(input.artifactId, existing);
      });
      return true;
    },

    markCurationRefused: async (tx: Transaction, input) => {
      const existing = curations.get(input.artifactId);
      if (existing?.curatedAt != null) return;
      curations.set(input.artifactId, {
        curatedAt: null,
        proposals: 0,
        settingsRefusedAt: input.at,
      });
      undoOnRollback(tx, () => {
        if (existing === undefined) curations.delete(input.artifactId);
        else curations.set(input.artifactId, existing);
      });
    },

    load: async (projectId, id) =>
      rows.find((row) => row.id === id && row.projectId === projectId) ?? null,

    listAwaitingApply: async (projectId, limit) =>
      rows.filter((row) => row.projectId === projectId && isAwaitingApply(row)).slice(0, limit),

    list: async (projectId, query) =>
      rows
        .filter((row) => row.projectId === projectId)
        .filter(
          (row) =>
            query.before === undefined ||
            row.createdAt < query.before.createdAt ||
            (row.createdAt === query.before.createdAt && row.id < query.before.id),
        )
        .slice()
        .reverse()
        .slice(0, query.limit),

    decide: async (tx: Transaction, decision: KnowledgeProposalDecision) => {
      const index = rows.findIndex((row) => row.id === decision.id);
      const row = rows[index];
      if (
        row === undefined ||
        (row.status !== 'queued' && row.status !== 'scored' && row.status !== 'apply_failed')
      ) {
        return false;
      }
      // WP-124: a decision clears an apply failure, as the adapter's statement does — and, as the
      // adapter reads it back, a row with no failure has no `applyFailureReason` key at all. WP-125:
      // and a deferral, which was a statement about the decision this one replaces.
      const { applyFailureReason: _cleared, applyDeferredReason: _undeferred, ...unfailed } = row;
      replace(index, {
        ...unfailed,
        status: decision.status,
        decidedByUserId: decision.decidedByUserId,
        decidedAt: decision.decidedAt,
        ...(decision.delta === undefined ? {} : { delta: decision.delta }),
      });
      undoOnRollback(tx, () => restore(row));
      return true;
    },

    supersedeQueued: async (tx: Transaction, input) => {
      const discarded: Id[] = [];
      rows.forEach((row, index) => {
        if (
          row.projectId === input.projectId &&
          row.source === input.source &&
          row.status === 'queued' &&
          row.decidedAt === null &&
          row.appliedCommitSha === null &&
          input.paths.includes(row.targetPath) &&
          !input.keep.includes(row.id)
        ) {
          replace(index, {
            ...row,
            status: 'discarded',
            evidence: [input.reason, ...row.evidence],
          });
          undoOnRollback(tx, () => restore(row));
          discarded.push(row.id);
        }
      });
      return discarded;
    },

    markApplied: async (tx: Transaction, input) => {
      for (const id of input.ids) {
        const index = rows.findIndex((row) => row.id === id);
        const row = rows[index];
        if (row === undefined || !isAwaitingApply(row)) continue;
        const { applyDeferredReason: _applied, ...undeferred } = row;
        replace(index, {
          ...undeferred,
          status: 'applied',
          appliedCommitSha: input.commitSha,
          ...(input.mergeRequest == null ? {} : { appliedMergeRequest: input.mergeRequest }),
        });
        undoOnRollback(tx, () => restore(row));
      }
    },

    markApplyFailed: async (tx: Transaction, input) => {
      const moved: Id[] = [];
      for (const failure of input.failures) {
        const index = rows.findIndex((row) => row.id === failure.id);
        const row = rows[index];
        if (row === undefined || !isAwaitingApply(row)) continue;
        const { applyDeferredReason: _undeferred, ...rest } = row;
        replace(index, { ...rest, status: 'apply_failed', applyFailureReason: failure.reason });
        undoOnRollback(tx, () => restore(row));
        moved.push(failure.id);
      }
      return moved;
    },

    applyCarriers: async (projectId, paths) => {
      const carriers: KnowledgeApplyCarrier[] = [];
      for (const path of paths) {
        carriers.push(
          ...rows
            .filter(
              (row) =>
                row.projectId === projectId &&
                row.targetPath === path &&
                row.status === 'applied' &&
                row.appliedMergeRequest != null,
            )
            .reverse()
            .slice(0, MAX_CARRIERS_PER_PATH)
            .map((row) => ({
              proposalId: row.id,
              targetPath: row.targetPath,
              mergeRequest: row.appliedMergeRequest as NonNullable<typeof row.appliedMergeRequest>,
            })),
        );
      }
      return carriers;
    },

    clearApplyDeferral: async (tx: Transaction, input) => {
      for (const id of input.ids) {
        const index = rows.findIndex((row) => row.id === id);
        const row = rows[index];
        if (row === undefined || row.applyDeferredReason == null) continue;
        const { applyDeferredReason: _cleared, ...undeferred } = row;
        replace(index, undeferred);
        undoOnRollback(tx, () => restore(row));
      }
    },

    deferApply: async (tx: Transaction, input) => {
      for (const deferral of input.deferrals) {
        const index = rows.findIndex((row) => row.id === deferral.id);
        const row = rows[index];
        if (row === undefined || !isAwaitingApply(row)) continue;
        replace(index, { ...row, applyDeferredReason: deferral.reason });
        undoOnRollback(tx, () => restore(row));
      }
    },

    projectsAwaitingApply: async (limit) =>
      [...new Set(rows.filter(isAwaitingApply).map((row) => row.projectId))].slice(0, limit),

    readHealthInputs: async (projectId) => health.get(projectId) ?? EMPTY_INPUTS,

    writeHealthReport: async (_tx: Transaction, report) => {
      reports.push(report);
    },
  };
};
