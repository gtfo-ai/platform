/**
 * The `KnowledgeProposalStore` contract, run against the in-memory double and against PostgreSQL
 * (WP-18b, technical/10 contract tier).
 *
 * Every unit test of the Librarian pipeline — the curation, the apply pass, the nightly hygiene and
 * the decide command — runs on the in-memory double. Each of those claims therefore rests on the
 * two stores being interchangeable, and this is what makes that true.
 *
 * ## The case that earns the suite
 *
 * `listAwaitingApply` is `isAwaitingApply` written twice: once as a TypeScript predicate in
 * `@platform/application` and once as a `where` clause in the adapter (standing rule 41). The suite
 * seeds **every** status — including the near-misses, a `queued` row nobody decided and an
 * `auto_applied` row that already has a commit — runs the predicate over them, and demands the
 * store return exactly what it selects. A store that returned every row, or none, passes neither
 * direction.
 *
 * ## What it does not assert
 *
 * Ordering between two rows written in the same microsecond (the doubles break the tie differently
 * — divergence 3), and transactional rollback, which the in-memory double cannot demonstrate at all
 * and which the integration tier asserts against the real adapter.
 */

import type {
  KbHealthInputs,
  KnowledgeProposalStore,
  StoredKnowledgeProposal,
  Transaction,
} from '@platform/application';
import { isAwaitingApply } from '@platform/application';
import type {
  Id,
  IsoDateTime,
  KnowledgeProposalStatus,
  KnowledgeProposalType,
} from '@platform/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

export interface KnowledgeProposalsHarness {
  readonly name: string;
  create(): Promise<{
    readonly store: KnowledgeProposalStore;
    readonly tx: Transaction;
    readonly projectId: Id;
    /** A second project, so "per project" is a claim the suite can falsify. */
    readonly otherProjectId: Id;
    /**
     * A user who may decide — a **real row** where the store has a foreign key.
     *
     * On the harness because `kb_proposals.decided_by` references `users` (migration 0008), and a
     * literal id here would pass against the in-memory double and violate the constraint against
     * PostgreSQL: the kinder store would be the one the whole unit tier runs on (standing rule 1).
     */
    readonly userId: Id;
    /** Arranges what `readHealthInputs` will answer — rows for the adapter, a seed for the double. */
    seedHealth(projectId: Id, inputs: KbHealthInputs): Promise<void>;
    /**
     * The health reports this project has, as the *harness* reads them.
     *
     * On the harness rather than on the port, deliberately: nothing in this build reads a report
     * back (no screen shows one yet — the WP-18b notes say so), and a port method whose only caller
     * is its own contract test is the shape the ledger records for `RunRepository.load`. The
     * observation is therefore each side's own — a `select` for the adapter, the array for the
     * double — which is what makes "the write really happened" an assertion instead of `expect(true)`.
     */
    readHealthReports(
      projectId: Id,
    ): Promise<readonly { readonly documents: number; readonly findings: number }[]>;
    cleanup(): Promise<void>;
  }>;
}

const AT = '2026-09-12T08:00:00.000Z' as IsoDateTime;

const id = (suffix: number): Id =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}` as Id;

export const runKnowledgeProposalsContract = (harness: KnowledgeProposalsHarness): void => {
  describe(`KnowledgeProposalStore contract — ${harness.name}`, () => {
    let context: Awaited<ReturnType<KnowledgeProposalsHarness['create']>>;
    let store: KnowledgeProposalStore;

    beforeEach(async () => {
      context = await harness.create();
      store = context.store;
      return async () => {
        await context.cleanup();
      };
    });

    const proposal = (
      overrides: Partial<StoredKnowledgeProposal> & { readonly id: Id },
    ): StoredKnowledgeProposal => ({
      projectId: context.projectId,
      taskId: null,
      runId: null,
      source: 'task',
      kind: 'technical',
      type: 'lesson' as KnowledgeProposalType,
      targetPath: `.agentic/knowledge/lessons/L-${overrides.id.slice(-3)}.md`,
      delta: '# a page\n',
      evidence: ['https://git.example.test/acme/api/-/merge_requests/7'],
      significance: 0.5,
      status: 'queued' as KnowledgeProposalStatus,
      decidedByUserId: null,
      decidedAt: null,
      appliedCommitSha: null,
      createdAt: AT,
      ...overrides,
    });

    it('round-trips a proposal, including the fields a reader renders', async () => {
      const row = proposal({
        id: id(1),
        evidence: ['one', 'two'],
        significance: 0.25,
      });
      await store.insert(context.tx, [row]);
      const loaded = await store.load(context.projectId, id(1));
      expect(loaded).toEqual(row);
      // …and a proposal is scoped to its project, not merely filtered by one.
      expect(await store.load(context.otherProjectId, id(1))).toBeNull();
    });

    it('selects exactly the proposals `isAwaitingApply` selects', async () => {
      const rows: readonly StoredKnowledgeProposal[] = [
        // The two that are waiting: policy-decided, and human-decided.
        proposal({ id: id(10), status: 'auto_applied' }),
        proposal({ id: id(11), status: 'queued', decidedAt: AT, decidedByUserId: context.userId }),
        // …and the near-misses, which is the half that discriminates.
        proposal({ id: id(12), status: 'queued' }),
        proposal({ id: id(13), status: 'scored' }),
        proposal({ id: id(14), status: 'discarded' }),
        proposal({
          id: id(15),
          status: 'rejected',
          decidedAt: AT,
          decidedByUserId: context.userId,
        }),
        proposal({ id: id(16), status: 'applied', appliedCommitSha: 'abc1234' }),
        proposal({
          id: id(17),
          status: 'auto_applied',
          appliedCommitSha: 'abc1234',
        }),
      ];
      await store.insert(context.tx, rows);

      const expected = rows.filter(isAwaitingApply).map((row) => row.id);
      expect(expected).toEqual([id(10), id(11)]);
      const waiting = await store.listAwaitingApply(context.projectId, 50);
      expect([...waiting].map((row) => row.id).sort()).toEqual([...expected].sort());
      expect(await store.projectsAwaitingApply(50)).toContain(context.projectId);
    });

    it('pages the queue newest first and honours the limit', async () => {
      await store.insert(context.tx, [
        proposal({ id: id(20), createdAt: '2026-09-10T08:00:00.000Z' as IsoDateTime }),
        proposal({ id: id(21), createdAt: '2026-09-11T08:00:00.000Z' as IsoDateTime }),
        proposal({ id: id(22), createdAt: '2026-09-12T08:00:00.000Z' as IsoDateTime }),
      ]);
      const first = await store.list(context.projectId, { limit: 2 });
      expect(first.map((row) => row.id)).toEqual([id(22), id(21)]);
      const cursor = first.at(-1);
      const next = await store.list(context.projectId, {
        limit: 2,
        ...(cursor === undefined ? {} : { before: { createdAt: cursor.createdAt, id: cursor.id } }),
      });
      expect(next.map((row) => row.id)).toEqual([id(20)]);
    });

    /**
     * **The case the cursor exists for.** One curation writes every proposal of a batch with the
     * same `clock.now()`, so these three share a timestamp — and a cursor of `created_at` alone
     * would skip the whole remainder of the batch on the second page, silently, because a short
     * page reads as the last one. Both halves are asserted: the page boundary lands inside the
     * batch, and the pages together are the batch.
     */
    it('pages through a batch whose rows share one timestamp', async () => {
      const sameInstant = '2026-09-12T09:00:00.000Z' as IsoDateTime;
      await store.insert(context.tx, [
        proposal({ id: id(23), createdAt: sameInstant }),
        proposal({ id: id(24), createdAt: sameInstant }),
        proposal({ id: id(25), createdAt: sameInstant }),
      ]);

      const first = await store.list(context.projectId, { limit: 2 });
      expect(first.map((row) => row.id)).toEqual([id(25), id(24)]);
      const cursor = first.at(-1) as StoredKnowledgeProposal;
      const second = await store.list(context.projectId, {
        limit: 2,
        before: { createdAt: cursor.createdAt, id: cursor.id },
      });
      expect(second.map((row) => row.id)).toEqual([id(23)]);
      expect([...first, ...second]).toHaveLength(3);
    });

    it('decides once: a second decision on a decided row changes nothing', async () => {
      await store.insert(context.tx, [proposal({ id: id(30) })]);
      const first = await store.decide(context.tx, {
        id: id(30),
        status: 'rejected',
        decidedByUserId: context.userId,
        decidedAt: AT,
      });
      expect(first).toBe(true);
      const second = await store.decide(context.tx, {
        id: id(30),
        status: 'queued',
        decidedByUserId: context.userId,
        decidedAt: AT,
      });
      expect(second).toBe(false);
      const loaded = await store.load(context.projectId, id(30));
      expect(loaded?.status).toBe('rejected');
      expect(loaded?.decidedByUserId).toBe(context.userId);
    });

    it('replaces the text on an edit and leaves it alone otherwise', async () => {
      await store.insert(context.tx, [proposal({ id: id(40) }), proposal({ id: id(41) })]);
      await store.decide(context.tx, {
        id: id(40),
        status: 'queued',
        decidedByUserId: context.userId,
        decidedAt: AT,
        delta: '# what the maintainer wrote\n',
      });
      await store.decide(context.tx, {
        id: id(41),
        status: 'queued',
        decidedByUserId: context.userId,
        decidedAt: AT,
      });
      expect((await store.load(context.projectId, id(40)))?.delta).toBe(
        '# what the maintainer wrote\n',
      );
      expect((await store.load(context.projectId, id(41)))?.delta).toBe('# a page\n');
    });

    it('marks a batch applied, and refuses to apply a row that is no longer waiting', async () => {
      await store.insert(context.tx, [
        proposal({ id: id(50), status: 'auto_applied' }),
        proposal({
          id: id(51),
          status: 'rejected',
          decidedAt: AT,
          decidedByUserId: context.userId,
        }),
      ]);
      await store.markApplied(context.tx, { ids: [id(50), id(51)], commitSha: 'deadbee' });
      const applied = await store.load(context.projectId, id(50));
      expect(applied?.status).toBe('applied');
      expect(applied?.appliedCommitSha).toBe('deadbee');
      // The rejected one was in the list and is untouched: a commit must not resurrect a decision
      // somebody made while the job was talking to the provider.
      const rejected = await store.load(context.projectId, id(51));
      expect(rejected?.status).toBe('rejected');
      expect(rejected?.appliedCommitSha).toBeNull();
      expect(await store.listAwaitingApply(context.projectId, 50)).toEqual([]);
    });

    it('reports the health inputs the nightly pass reads', async () => {
      const inputs: KbHealthInputs = {
        commitSha: 'c0ffee1',
        documents: [
          {
            path: '.agentic/knowledge/lessons/L-old.md',
            expires: '2025-01-01',
            frontmatterId: 'L-old',
            tokens: 120,
          },
          {
            path: '.agentic/knowledge/lessons/L-new.md',
            expires: null,
            frontmatterId: null,
            tokens: 80,
          },
        ],
        danglingLinks: [
          { fromPath: '.agentic/knowledge/lessons/L-new.md', toPath: 'lessons/gone.md' },
        ],
      };
      await context.seedHealth(context.projectId, inputs);
      const read = await store.readHealthInputs(context.projectId);
      expect(read.commitSha).toBe('c0ffee1');
      expect([...read.documents].sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual(
        [...inputs.documents].sort((a, b) => (a.path < b.path ? -1 : 1)),
      );
      expect(read.danglingLinks).toEqual(inputs.danglingLinks);
      // …and a project with nothing indexed is an empty report, not a missing one.
      const empty = await store.readHealthInputs(context.otherProjectId);
      expect(empty.documents).toEqual([]);
      expect(empty.danglingLinks).toEqual([]);
    });

    it('stores a health report with its findings', async () => {
      await store.writeHealthReport(context.tx, {
        id: id(60),
        projectId: context.projectId,
        commitSha: 'c0ffee1',
        documents: 12,
        findings: [
          {
            kind: 'expired',
            path: '.agentic/knowledge/lessons/L-old.md',
            detail: 'expires: 2025-01-01 has passed',
          },
        ],
        source: 'hygiene',
        createdAt: AT,
      });
      expect(await context.readHealthReports(context.projectId)).toEqual([
        { documents: 12, findings: 1 },
      ]);
      // …and it is the project's own report, not the deployment's.
      expect(await context.readHealthReports(context.otherProjectId)).toEqual([]);
    });
  });
};
