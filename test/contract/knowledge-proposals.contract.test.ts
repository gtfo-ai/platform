/**
 * The `KnowledgeProposalStore` contract against the in-memory double (technical/10 contract tier).
 *
 * `test/integration/knowledge/postgres-knowledge-store.integration.test.ts` runs the same suite
 * against a real PostgreSQL 18, which is what makes WP-18b's unit tier — the curation, the apply
 * pass, the hygiene pass and the decide command, all of which drive this double — a claim about the
 * product rather than about a pair of arrays.
 */
import { memoryProposalStore, memoryTransaction } from '@platform/application';
import type { Id } from '@platform/contracts';
import { runKnowledgeProposalsContract } from './support/knowledge-proposals-suite.js';

const PROJECT = '00000000-0000-4000-8000-0000000000f1' as Id;
const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000f2' as Id;
const USER = '00000000-0000-4000-8000-0000000000f3' as Id;

runKnowledgeProposalsContract({
  name: 'in-memory',
  create: async () => {
    const store = memoryProposalStore();
    return {
      store,
      tx: memoryTransaction,
      projectId: PROJECT,
      otherProjectId: OTHER_PROJECT,
      userId: USER,
      seedHealth: async (projectId, inputs) => {
        store.seedHealthInputs(projectId, inputs);
      },
      readHealthReports: async (projectId) =>
        store.reports
          .filter((report) => report.projectId === projectId)
          .map((report) => ({ documents: report.documents, findings: report.findings.length })),
      cleanup: async () => {},
    };
  },
});
