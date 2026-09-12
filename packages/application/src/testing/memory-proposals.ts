/**
 * An in-memory `KnowledgeProposalStore` — the double every unit test of the Librarian pipeline runs
 * on (WP-18b).
 *
 * ## Divergence register (standing rule 1: a fake may be stricter than the real adapter, never
 * kinder, and every deliberate difference is written down where the fake is defined)
 *
 * | # | Divergence | Direction | Why it is safe |
 * |---|---|---|---|
 * | 1 | **Writes are not transactional.** The maps mutate immediately; the `Transaction` handle is accepted and unused. | **Kinder** | Nothing here can demonstrate a rollback. `test/integration/knowledge/postgres-knowledge-store.integration.test.ts` runs the same contract suite against PostgreSQL, where a failed transaction really does undo the insert. |
 * | 2 | **`decide` compares the status in JavaScript** where the adapter does it in the `where` clause of one statement. | *Different* | The adapter's version is atomic against a concurrent decider and this one is not, so a **lost-update** race cannot be reproduced here. The contract suite asserts the observable both share — a second decision on a decided row answers `false` — and the atomicity is the adapter's to keep. |
 * | 3 | **Ordering is insertion order reversed**, not `(created_at, id) desc`. | *Different* | For a batch written in id order — which is what `recordLibrarianProposals` does — the two agree, and the contract suite pages through a same-timestamp batch to hold them to it. A test that inserted out of id order would see the two disagree, so no test may assert an ordering from this double and claim it of PostgreSQL. |
 * | 4 | **`readHealthInputs` answers what it was seeded with.** It holds no index of its own, so a test decides what the pass sees. | *Different* | The real one reads `kb_documents` and `kb_links`. A test that asserted "the pass found the expired page the indexer wrote" would be asserting this seam rather than the query, which is why the postgres half of the contract suite seeds rows and asks the adapter. |
 */
import type { Id } from '@platform/contracts';
import type {
  KbHealthInputs,
  KbHealthReportWrite,
  KnowledgeProposalDecision,
  KnowledgeProposalStore,
  StoredKnowledgeProposal,
} from '../knowledge/ports.js';
import { isAwaitingApply } from '../knowledge/ports.js';
import type { Transaction } from '../ports/transaction.js';

export interface MemoryProposalStore extends KnowledgeProposalStore {
  /** Everything written, oldest first — what a test asserts on. */
  readonly rows: readonly StoredKnowledgeProposal[];
  readonly reports: readonly KbHealthReportWrite[];
  /** What {@link KnowledgeProposalStore.readHealthInputs} will answer for this project. */
  seedHealthInputs(projectId: Id, inputs: KbHealthInputs): void;
}

const EMPTY_INPUTS: KbHealthInputs = { commitSha: null, documents: [], danglingLinks: [] };

export const memoryProposalStore = (): MemoryProposalStore => {
  const rows: StoredKnowledgeProposal[] = [];
  const reports: KbHealthReportWrite[] = [];
  const health = new Map<Id, KbHealthInputs>();

  const replace = (index: number, next: StoredKnowledgeProposal): void => {
    rows.splice(index, 1, next);
  };

  return {
    rows,
    reports,
    seedHealthInputs: (projectId, inputs) => {
      health.set(projectId, inputs);
    },

    insert: async (_tx: Transaction, proposals) => {
      rows.push(...proposals);
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

    decide: async (_tx: Transaction, decision: KnowledgeProposalDecision) => {
      const index = rows.findIndex((row) => row.id === decision.id);
      const row = rows[index];
      if (row === undefined || (row.status !== 'queued' && row.status !== 'scored')) {
        return false;
      }
      replace(index, {
        ...row,
        status: decision.status,
        decidedByUserId: decision.decidedByUserId,
        decidedAt: decision.decidedAt,
        ...(decision.delta === undefined ? {} : { delta: decision.delta }),
      });
      return true;
    },

    markApplied: async (_tx: Transaction, input) => {
      for (const id of input.ids) {
        const index = rows.findIndex((row) => row.id === id);
        const row = rows[index];
        if (row === undefined || !isAwaitingApply(row)) continue;
        replace(index, { ...row, status: 'applied', appliedCommitSha: input.commitSha });
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
