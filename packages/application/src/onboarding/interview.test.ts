/**
 * Recording the business interview — WP-64 (PROGRESS backlog 45, criterion 3).
 *
 * Asserted: every answered or not-applicable section becomes **one queued proposal** with source
 * `human` and never an applied one, at the path the completeness score reads; a skipped section
 * writes nothing; and every answer is **redacted, then cut** — with a secret planted across the cut
 * so the order is what fails if it is reversed (the ticket snapshot's rule, standing rule 3).
 */
import type { Id } from '@platform/contracts';
import { MAX_INTERVIEW_ANSWER_CHARS, MAX_INTERVIEW_REASON_CHARS } from '@platform/contracts';
import { fixedClock, sequentialIds } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { memoryKnowledgeStore } from '../testing/memory-knowledge.js';
import { memoryProposalStore } from '../testing/memory-proposals.js';
import {
  type BusinessInterviewAnswers,
  type BusinessInterviewOptions,
  recordBusinessInterview,
} from './interview.js';

const PROJECT = '00000000-0000-4000-8000-0000000000f1' as Id;
const USER = '00000000-0000-4000-8000-0000000000f2' as Id;
/** Obviously fake (BD-002), planted so the redaction has something to find (rule 45). */
const PLANTED = 'FAKE-interview-credential-not-a-real-secret';

const harness = (
  options: {
    readonly indexedPaths?: readonly string[];
    readonly project?: { readonly knowledgeDir: string } | null;
  } = {},
) => {
  const proposals = memoryProposalStore();
  const eventing = new MemoryEventing();
  const knowledge = memoryKnowledgeStore();
  const interview: BusinessInterviewOptions = {
    unitOfWork: eventing,
    eventStore: eventing.store,
    proposals,
    knowledge: {
      ...knowledge,
      readIndexedBlobs: async () =>
        new Map((options.indexedPaths ?? []).map((path) => [path, 'blob'])),
    },
    clock: fixedClock('2026-09-27T04:00:00.000Z'),
    ids: sequentialIds(500),
    redactor: exactSecretRedactor([{ name: 'interview_key', value: PLANTED }]),
    project: async () =>
      options.project === undefined ? { knowledgeDir: '.agentic/knowledge' } : options.project,
  };
  return { proposals, eventing, interview };
};

const record = (interview: BusinessInterviewOptions, answers: BusinessInterviewAnswers) =>
  recordBusinessInterview(interview, { projectId: PROJECT, userId: USER, answers });

describe('recordBusinessInterview', () => {
  it('queues one human proposal per section, at the path the score reads, and applies none', async () => {
    const { proposals, eventing, interview } = harness();
    const result = await record(interview, {
      product: { status: 'answered', text: 'Invoicing for small accountancies.' },
      glossary: { status: 'answered', text: '**Ledger** — the book of record.' },
      users: { status: 'not_applicable', reason: 'One internal user.' },
    });

    expect(result.status).toBe('recorded');
    if (result.status !== 'recorded') return;
    expect(result.pages.map((page) => [page.section, page.targetPath, page.status])).toEqual([
      ['product', '.agentic/knowledge/business/overview.md', 'queued'],
      ['users', '.agentic/knowledge/business/personas.md', 'queued'],
      ['glossary', '.agentic/knowledge/business/glossary.md', 'queued'],
    ]);
    // The rows the queue shows, not the return value (rule 79).
    expect(proposals.rows).toHaveLength(3);
    for (const row of proposals.rows) {
      expect(row).toMatchObject({
        source: 'human',
        kind: 'business',
        type: 'doc-update',
        status: 'queued',
        taskId: null,
        runId: null,
        decidedByUserId: null,
        appliedCommitSha: null,
      });
    }
    expect(proposals.rows[2]?.delta).toContain('**Ledger** — the book of record.');
    expect(proposals.rows[1]?.delta).toContain('Marked **not applicable**');
    // One `knowledge.proposal.created` per row, attributed to the person who answered.
    const stream = await eventing.store.readStream('project', PROJECT);
    expect(stream.map((entry) => entry.event.type)).toEqual(
      Array(3).fill('knowledge.proposal.created'),
    );
    expect(stream.every((entry) => entry.event.actor.kind === 'user')).toBe(true);
  });

  it('writes nothing for a skipped section', async () => {
    const { proposals, interview } = harness();
    await record(interview, { direction: { status: 'answered', text: 'Grow to 500 firms.' } });
    expect(proposals.rows.map((row) => row.targetPath)).toEqual([
      '.agentic/knowledge/business/direction.md',
    ]);
  });

  it('proposes an update when the index already holds the page', async () => {
    const { proposals, interview } = harness({
      indexedPaths: ['.agentic/knowledge/business/glossary.md'],
    });
    await record(interview, { glossary: { status: 'answered', text: 'Ledger.' } });
    expect(proposals.rows[0]?.status).toBe('queued');
    expect(proposals.rows).toHaveLength(1);
  });

  it('joins the project’s own knowledge directory', async () => {
    const { proposals, interview } = harness({ project: { knowledgeDir: 'docs/kb' } });
    await record(interview, { review: { status: 'answered', text: 'Two approvals.' } });
    expect(proposals.rows[0]?.targetPath).toBe('docs/kb/business/review-expectations.md');
  });

  it('answers not_found for a project with no row and writes nothing', async () => {
    const { proposals, interview } = harness({ project: null });
    expect((await record(interview, { product: { status: 'answered', text: 'x' } })).status).toBe(
      'not_found',
    );
    expect(proposals.rows).toHaveLength(0);
  });

  it('redacts before it cuts: a secret straddling the cap is still found', async () => {
    // The secret starts four characters before the cap. Cut first, and the redactor would see only
    // its first four characters and store them; redact first, and the placeholder is what is cut.
    const text = `${'a'.repeat(MAX_INTERVIEW_ANSWER_CHARS - 4)}${PLANTED}`;
    const { proposals, interview } = harness();
    const result = await record(interview, { product: { status: 'answered', text } });
    const delta = proposals.rows[0]?.delta ?? '';
    // Cut first would have stored `…aaaaFAKE`: the secret's head, which no exact matcher finds.
    expect(delta).not.toContain('aFAKE');
    expect(delta).toContain('a[RED');
    expect(result.status === 'recorded' && result.redactions).toBe(1);
    expect(result.status === 'recorded' && result.pages[0]?.truncated).toBe(true);
    expect(delta).toContain(`cut this text at ${MAX_INTERVIEW_ANSWER_CHARS} characters`);
  });

  it('keeps an answer exactly at the cap whole, and cuts one a character past it', async () => {
    // Both sides of the bound (rule 42).
    for (const [length, truncated] of [
      [MAX_INTERVIEW_ANSWER_CHARS, false],
      [MAX_INTERVIEW_ANSWER_CHARS + 1, true],
    ] as const) {
      const { interview } = harness();
      const result = await record(interview, {
        product: { status: 'answered', text: 'b'.repeat(length) },
      });
      expect(result.status === 'recorded' && result.pages[0]?.truncated, String(length)).toBe(
        truncated,
      );
    }
  });

  it('redacts and bounds a not-applicable reason too', async () => {
    const { proposals, interview } = harness();
    await record(interview, {
      users: {
        status: 'not_applicable',
        reason: `${PLANTED} ${'r'.repeat(MAX_INTERVIEW_REASON_CHARS)}`,
      },
    });
    const delta = proposals.rows[0]?.delta ?? '';
    expect(delta).not.toContain(PLANTED);
    expect(delta).toContain(`cut this text at ${MAX_INTERVIEW_REASON_CHARS} characters`);
  });
});

/**
 * WP-64 review round 1: the audit row is written **in the proposals' transaction** through
 * `claim`, and a refused claim (the key already performed the interview) rolls back everything —
 * so a replay after the commit, or the loser of two racing submits, queues nothing.
 */
describe('the claim inside the transaction', () => {
  it('hands the claim the pages it is about to write, and writes them when it is granted', async () => {
    const { proposals, interview } = harness();
    const seen: number[] = [];
    const result = await recordBusinessInterview(interview, {
      projectId: PROJECT,
      userId: USER,
      answers: { glossary: { status: 'answered', text: 'Ledger.' } },
      claim: async (_tx, recorded) => {
        seen.push(recorded.pages.length);
        return true;
      },
    });
    expect(result.status).toBe('recorded');
    expect(seen).toEqual([1]);
    expect(proposals.rows).toHaveLength(1);
  });

  it('queues nothing and answers replayed when the claim is refused', async () => {
    const { proposals, eventing, interview } = harness();
    const result = await recordBusinessInterview(interview, {
      projectId: PROJECT,
      userId: USER,
      answers: { glossary: { status: 'answered', text: 'Ledger.' } },
      claim: async () => false,
    });
    expect(result.status).toBe('replayed');
    expect(proposals.rows).toHaveLength(0);
    expect(await eventing.store.readStream('project', PROJECT)).toEqual([]);
  });
});
