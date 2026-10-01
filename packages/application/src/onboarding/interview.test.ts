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
import { StreamConflictError } from '../errors.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { StoredKnowledgeProposal } from '../knowledge/ports.js';
import { PROJECT_STREAM_APPEND_ATTEMPTS } from '../pipeline/project-stream.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { memoryKnowledgeStore } from '../testing/memory-knowledge.js';
import { memoryProposalStore } from '../testing/memory-proposals.js';
import { racingProjectStream } from '../testing/project-stream-race.js';
import {
  type BusinessInterviewAnswers,
  type BusinessInterviewOptions,
  recordBusinessInterview,
  supersededAnswerReason,
} from './interview.js';

const PROJECT = '00000000-0000-4000-8000-0000000000f1' as Id;
const USER = '00000000-0000-4000-8000-0000000000f2' as Id;
/** Obviously fake (BD-002), planted so the redaction has something to find (rule 45). */
const PLANTED = 'FAKE-interview-credential-not-a-real-secret';

const harness = (
  options: {
    readonly indexedPaths?: readonly string[];
    readonly project?: { readonly knowledgeDir: string } | null;
    /** WP-109: how many project-stream races a rival wins; the store then rolls back with the fake. */
    readonly losses?: number;
  } = {},
) => {
  const eventing = new MemoryEventing();
  const proposals = memoryProposalStore(
    options.losses === undefined ? {} : { rollback: (tx, undo) => eventing.onRollback(tx, undo) },
  );
  const race = racingProjectStream(eventing, options.losses ?? 0);
  const knowledge = memoryKnowledgeStore();
  const interview: BusinessInterviewOptions = {
    unitOfWork: eventing,
    eventStore: { ...eventing.store, nextStreamSequence: race.eventStore.nextStreamSequence },
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

/**
 * WP-109, PROGRESS backlog **357**: another project-stream write between the sequence read and the
 * commit used to answer the wizard's step 3 with `500 internal_error`. The re-run repeats the claim
 * — modelled here as `command_idempotency`, a key set whose insert rolls back with the transaction —
 * so a retried attempt still claims exactly once.
 */
describe('an interview that loses the project stream’s sequence', () => {
  const claims = (eventing: MemoryEventing) => {
    const keys = new Set<string>();
    let calls = 0;
    return {
      keys,
      calls: () => calls,
      claimFor:
        (key: string): NonNullable<Parameters<typeof recordBusinessInterview>[1]['claim']> =>
        async (tx) => {
          calls += 1;
          if (keys.has(key)) return false;
          keys.add(key);
          eventing.onRollback(tx, () => keys.delete(key));
          return true;
        },
    };
  };
  const answers: BusinessInterviewAnswers = {
    glossary: { status: 'answered', text: 'Ledger.' },
    users: { status: 'answered', text: 'Accountants.' },
  };
  const created = async (eventing: MemoryEventing) =>
    (await eventing.store.readStream('project', PROJECT)).filter(
      (entry) => entry.event.type === 'knowledge.proposal.created',
    );

  it('records through three lost races, claiming once', async () => {
    const { proposals, eventing, interview } = harness({
      losses: PROJECT_STREAM_APPEND_ATTEMPTS - 1,
    });
    const claim = claims(eventing);
    const result = await recordBusinessInterview(interview, {
      projectId: PROJECT,
      userId: USER,
      answers,
      claim: claim.claimFor('key-1'),
    });
    expect(result.status).toBe('recorded');
    expect(claim.calls()).toBe(PROJECT_STREAM_APPEND_ATTEMPTS);
    expect([...claim.keys]).toEqual(['key-1']);
    expect(proposals.rows).toHaveLength(2);
    expect(await created(eventing)).toHaveLength(2);
  });

  it('throws on the fourth with nothing claimed, so the same key performs on a resend', async () => {
    const { proposals, eventing, interview } = harness({ losses: PROJECT_STREAM_APPEND_ATTEMPTS });
    const claim = claims(eventing);
    await expect(
      recordBusinessInterview(interview, {
        projectId: PROJECT,
        userId: USER,
        answers,
        claim: claim.claimFor('key-1'),
      }),
    ).rejects.toBeInstanceOf(StreamConflictError);
    expect(claim.keys.size).toBe(0);
    expect(proposals.rows).toEqual([]);
    expect(await created(eventing)).toEqual([]);
  });

  it('records two interviews submitted at once, both', async () => {
    const { proposals, eventing, interview } = harness({ losses: 0 });
    const claim = claims(eventing);
    const results = await Promise.all(
      ['key-1', 'key-2'].map((key) =>
        recordBusinessInterview(interview, {
          projectId: PROJECT,
          userId: USER,
          answers,
          claim: claim.claimFor(key),
        }),
      ),
    );
    expect(results.map((result) => result.status)).toEqual(['recorded', 'recorded']);
    expect([...claim.keys].sort()).toEqual(['key-1', 'key-2']);
    expect(proposals.rows).toHaveLength(4);
    expect(await created(eventing)).toHaveLength(4);
    // Both landed, and the second to commit superseded the first's pages (backlog 370).
    assertOnePendingPerPath(proposals.rows);
  });
});

/**
 * The invariant backlog 370 asks for, as a check that names what it found (the canary below asserts
 * the failure by its words, standing rule 3).
 */
const assertOnePendingPerPath = (rows: readonly StoredKnowledgeProposal[]): void => {
  const pending = new Map<string, number>();
  for (const row of rows) {
    if (row.status === 'queued' && row.decidedAt === null) {
      pending.set(row.targetPath, (pending.get(row.targetPath) ?? 0) + 1);
    }
  }
  for (const [path, count] of pending) {
    if (count > 1) throw new Error(`${count} pending proposals for ${path}`);
  }
};

/**
 * WP-109 review round 1, PROGRESS backlog **370**: re-submitting the interview queued every
 * `business/` page a second time beside the first submission's. The newer answer now discards the
 * earlier undecided page for the same section, with the platform's reason as its first evidence.
 */
describe('an interview submitted again', () => {
  const GLOSSARY = '.agentic/knowledge/business/glossary.md';
  const submit = (interview: BusinessInterviewOptions, text: string) =>
    record(interview, { glossary: { status: 'answered', text } });

  it('leaves one pending page per section, and the earlier one discarded with its reason', async () => {
    const { proposals, interview } = harness();
    await submit(interview, 'Ledger: the book of record.');
    await submit(interview, 'Ledger: the book of record, per currency.');

    const glossary = proposals.rows.filter((row) => row.targetPath === GLOSSARY);
    expect(glossary.map((row) => row.status)).toEqual(['discarded', 'queued']);
    const [earlier, newer] = glossary;
    expect(earlier?.evidence[0]).toBe(supersededAnswerReason(USER, earlier?.createdAt as never));
    expect(earlier?.evidence[0]).toContain(USER);
    expect(earlier?.evidence.slice(1)).toEqual(newer?.evidence);
    assertOnePendingPerPath(proposals.rows);
  });

  it('leaves an earlier answer a maintainer already approved, and another section, alone', async () => {
    const { proposals, interview } = harness();
    await record(interview, {
      glossary: { status: 'answered', text: 'Ledger.' },
      users: { status: 'answered', text: 'Accountants.' },
    });
    const approved = proposals.rows.find((row) => row.targetPath === GLOSSARY);
    await proposals.decide({} as never, {
      id: approved?.id as Id,
      status: 'queued',
      decidedByUserId: USER,
      decidedAt: '2026-09-27T05:00:00.000Z' as StoredKnowledgeProposal['createdAt'],
    });
    await submit(interview, 'Ledger, again.');
    expect(proposals.rows.find((row) => row.id === approved?.id)?.status).toBe('queued');
    // The personas page was not answered again, so it is not superseded.
    expect(proposals.rows.find((row) => row.targetPath.endsWith('/personas.md'))?.status).toBe(
      'queued',
    );
  });

  it('leaves another source’s queued page for the same path alone (WP-109 review round 2)', async () => {
    const { proposals, interview } = harness();
    await submit(interview, 'Ledger: the book of record.');
    // The near miss: a queued page at the same path whose author is not the interview.
    const rows = proposals.rows as StoredKnowledgeProposal[];
    const index = rows.findIndex((row) => row.targetPath === GLOSSARY);
    rows[index] = { ...(rows[index] as StoredKnowledgeProposal), source: 'bootstrap' };
    await submit(interview, 'Ledger: the book of record, per currency.');

    const glossary = proposals.rows.filter((row) => row.targetPath === GLOSSARY);
    expect(glossary.map((row) => [row.source, row.status])).toEqual([
      ['bootstrap', 'queued'],
      ['human', 'queued'],
    ]);
  });

  it('fails by name when the queue read is disarmed (the canary)', async () => {
    const { proposals, interview } = harness();
    const disarmed: BusinessInterviewOptions = {
      ...interview,
      proposals: { ...proposals, supersedeQueued: async () => [] },
    };
    await submit(disarmed, 'Ledger.');
    await submit(disarmed, 'Ledger, again.');
    expect(() => assertOnePendingPerPath(proposals.rows)).toThrow(
      `2 pending proposals for ${GLOSSARY}`,
    );
  });
});
