/**
 * A maintainer's decision on a proposal — WP-18b.
 *
 * The cases that matter are the two endings: an approval makes the row appliable and asks for a
 * commit, a rejection makes it terminal and asks for nothing. Everything else here is about the
 * states in between — a second decision, an edit with no text, a process with no job runtime.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { decideKbProposalRequestSchema, MAX_PROPOSAL_DELTA_BYTES } from '@platform/contracts';
import { fixedClock, sequentialIds } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor, noSecretsRedactor } from '../integrations/redaction.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { silentLogger } from '../ports/logger.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { memoryProposalStore } from '../testing/memory-proposals.js';
import { recordingJobs } from '../testing/pipeline-harness.js';
import { type DecideProposalOptions, decideKnowledgeProposal } from './decide.js';
import type { StoredKnowledgeProposal } from './ports.js';
import { isAwaitingApply } from './ports.js';

const PROJECT = '00000000-0000-4000-8000-0000000000f1' as Id;
const PROPOSAL = '00000000-0000-4000-8000-0000000000f2' as Id;
const USER = '00000000-0000-4000-8000-0000000000f3' as Id;
const AT = '2026-09-12T10:00:00.000Z' as IsoDateTime;
const PLANTED_SECRET = 'FAKE-maintainer-pasted-credential-00000001';

const row = (overrides: Partial<StoredKnowledgeProposal> = {}): StoredKnowledgeProposal => ({
  id: PROPOSAL,
  projectId: PROJECT,
  taskId: null,
  runId: null,
  source: 'task',
  kind: 'technical',
  type: 'lesson',
  targetPath: '.agentic/knowledge/lessons/L-1.md',
  delta: '# a page\n',
  evidence: [],
  significance: 0.8,
  status: 'queued',
  decidedByUserId: null,
  decidedAt: null,
  appliedCommitSha: null,
  createdAt: AT,
  ...overrides,
});

const harness = (options: { readonly jobs?: boolean; readonly redact?: boolean } = {}) => {
  const proposals = memoryProposalStore();
  const jobs = recordingJobs();
  const eventing = new MemoryEventing();
  const decideOptions: DecideProposalOptions = {
    unitOfWork: eventing,
    eventStore: eventing.store,
    proposals,
    clock: fixedClock(AT),
    ids: sequentialIds(950),
    redactor:
      options.redact === true
        ? exactSecretRedactor([{ name: 'pasted', value: PLANTED_SECRET }])
        : noSecretsRedactor(),
    jobs: (options.jobs ?? true) ? jobs : null,
    logger: silentLogger,
  };
  return { proposals, jobs, eventing, decideOptions };
};

describe('deciding a knowledge proposal', () => {
  it('approves: the row becomes appliable and a commit is asked for', async () => {
    const { proposals, jobs, decideOptions } = harness();
    await proposals.insert({} as never, [row()]);

    const result = await decideKnowledgeProposal(decideOptions, {
      projectId: PROJECT,
      proposalId: PROPOSAL,
      decision: 'approve',
      userId: USER,
    });

    expect(result.status).toBe('decided');
    const stored = proposals.rows[0] as StoredKnowledgeProposal;
    // "Approved" is `queued` + a decision — there is no sixth status (see the module docblock).
    expect(stored.status).toBe('queued');
    expect(stored.decidedByUserId).toBe(USER);
    expect(stored.decidedAt).toBe(AT);
    expect(isAwaitingApply(stored)).toBe(true);
    expect(jobs.take(JOB_QUEUES.knowledgeApply)).toHaveLength(1);
  });

  it('rejects: the row is terminal, nothing is applied, and the event records who', async () => {
    const { proposals, jobs, eventing, decideOptions } = harness();
    await proposals.insert({} as never, [row()]);

    const result = await decideKnowledgeProposal(decideOptions, {
      projectId: PROJECT,
      proposalId: PROPOSAL,
      decision: 'reject',
      userId: USER,
      reason: 'the page already says this',
    });

    expect(result.status).toBe('decided');
    const stored = proposals.rows[0] as StoredKnowledgeProposal;
    expect(stored.status).toBe('rejected');
    expect(isAwaitingApply(stored)).toBe(false);
    expect(jobs.enqueued).toEqual([]);
    const stream = await eventing.store.readStream('project', PROJECT);
    expect(stream.map((entry) => entry.event.type)).toEqual(['knowledge.proposal.rejected']);
    expect(stream[0]?.event.payload).toMatchObject({
      proposal_id: PROPOSAL,
      reason: 'the page already says this',
      decided_by_user_id: USER,
    });
  });

  it('edits: the maintainer’s text replaces the model’s and is redacted on the way in', async () => {
    const { proposals, decideOptions } = harness({ redact: true });
    await proposals.insert({} as never, [row()]);

    await decideKnowledgeProposal(decideOptions, {
      projectId: PROJECT,
      proposalId: PROPOSAL,
      decision: 'edit',
      userId: USER,
      delta: `# what the human wrote\n\ntoken ${PLANTED_SECRET}\n`,
    });

    const stored = proposals.rows[0] as StoredKnowledgeProposal;
    expect(stored.delta).toContain('# what the human wrote');
    expect(stored.delta).not.toContain(PLANTED_SECRET);
    expect(stored.delta).toContain('[REDACTED:integration:pasted]');
    expect(isAwaitingApply(stored)).toBe(true);
  });

  /**
   * TD-012 over the **reason**, in both directions (standing rule 42). The delta's own assertion is
   * above; this is its sibling, and it was missing until review round 2 asked for it.
   */
  it('redacts the maintainer’s reason before it reaches the event payload', async () => {
    const { proposals, eventing, decideOptions } = harness({ redact: true });
    await proposals.insert({} as never, [row()]);

    await decideKnowledgeProposal(decideOptions, {
      projectId: PROJECT,
      proposalId: PROPOSAL,
      decision: 'reject',
      userId: USER,
      reason: `it pasted ${PLANTED_SECRET} into the page`,
    });

    const stream = await eventing.store.readStream('project', PROJECT);
    const payload = stream[0]?.event.payload as { reason: string };
    expect(payload.reason).not.toContain(PLANTED_SECRET);
    expect(payload.reason).toContain('[REDACTED:integration:pasted]');
    expect(payload.reason).toContain('into the page');
  });

  /**
   * The page budget, from both sides (rule 42) and in the unit the row actually carries. A model's
   * page is capped by the curator; an `edit` reaches the same row, the same commit and the same
   * context pack, so it is capped here too.
   */
  it('accepts a replacement page exactly at the budget and refuses one byte over', async () => {
    const { proposals, decideOptions } = harness();
    await proposals.insert({} as never, [row()]);

    const atCap = 'a'.repeat(MAX_PROPOSAL_DELTA_BYTES);
    const accepted = await decideKnowledgeProposal(decideOptions, {
      projectId: PROJECT,
      proposalId: PROPOSAL,
      decision: 'edit',
      userId: USER,
      delta: atCap,
    });
    expect(accepted.status).toBe('decided');
    expect(proposals.rows[0]?.delta).toBe(atCap);

    const refused = await decideKnowledgeProposal(decideOptions, {
      projectId: PROJECT,
      proposalId: PROPOSAL,
      decision: 'edit',
      userId: USER,
      delta: `${atCap}a`,
    });
    expect(refused.status).toBe('invalid');
    // …and the row still carries what the accepted edit wrote, not the refused one.
    expect(proposals.rows[0]?.delta).toBe(atCap);
  });

  /** The wire boundary carries the same number, so an over-long body never reaches the command. */
  it('publishes the same budget on the request schema', () => {
    const oversized = 'a'.repeat(MAX_PROPOSAL_DELTA_BYTES + 1);
    expect(
      decideKbProposalRequestSchema.safeParse({ decision: 'edit', delta: oversized }).success,
    ).toBe(false);
    expect(
      decideKbProposalRequestSchema.safeParse({
        decision: 'edit',
        delta: 'a'.repeat(MAX_PROPOSAL_DELTA_BYTES),
      }).success,
    ).toBe(true);
  });

  it('refuses an edit with no replacement text', async () => {
    const { proposals, decideOptions } = harness();
    await proposals.insert({} as never, [row()]);
    const result = await decideKnowledgeProposal(decideOptions, {
      projectId: PROJECT,
      proposalId: PROPOSAL,
      decision: 'edit',
      userId: USER,
    });
    expect(result.status).toBe('invalid');
    expect(proposals.rows[0]?.decidedAt).toBeNull();
  });

  it('answers not_found for a proposal of another project', async () => {
    const { proposals, decideOptions } = harness();
    await proposals.insert({} as never, [row()]);
    const result = await decideKnowledgeProposal(decideOptions, {
      projectId: '00000000-0000-4000-8000-0000000000ff' as Id,
      proposalId: PROPOSAL,
      decision: 'approve',
      userId: USER,
    });
    expect(result.status).toBe('not_found');
  });

  it.each([['applied'], ['rejected'], ['discarded'], ['auto_applied']] as const)(
    'refuses to decide a proposal that is already %s',
    async (status) => {
      const { proposals, jobs, decideOptions } = harness();
      await proposals.insert({} as never, [row({ status })]);
      const result = await decideKnowledgeProposal(decideOptions, {
        projectId: PROJECT,
        proposalId: PROPOSAL,
        decision: 'reject',
        userId: USER,
      });
      expect(result.status).toBe('not_decidable');
      expect(proposals.rows[0]?.status).toBe(status);
      expect(jobs.enqueued).toEqual([]);
    },
  );

  /**
   * The residual the module states, asserted rather than described: the decision is committed and
   * the commit waits for the nightly pass. A process that lost the decision here would be the
   * defect; one that lost the *wake-up* is recovered by `projectsAwaitingApply`.
   */
  it('records the decision on a process with no job runtime', async () => {
    const { proposals, decideOptions } = harness({ jobs: false });
    await proposals.insert({} as never, [row()]);
    const result = await decideKnowledgeProposal(decideOptions, {
      projectId: PROJECT,
      proposalId: PROPOSAL,
      decision: 'approve',
      userId: USER,
    });
    expect(result.status).toBe('decided');
    expect(isAwaitingApply(proposals.rows[0] as StoredKnowledgeProposal)).toBe(true);
    expect(await proposals.projectsAwaitingApply(10)).toEqual([PROJECT]);
  });
});
