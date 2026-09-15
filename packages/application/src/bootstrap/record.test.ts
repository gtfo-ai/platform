/**
 * The recorder: the queue only, evidence that resolves, and one write per chunk (WP-35).
 *
 * Every assertion is on the **`kb_proposals` rows** and the **chunk row**, because those are what a
 * maintainer and the batch screen read. The four things this suite exists to hold:
 *
 *  1. an evidenced proposal is **queued**, and it is queued **even when the project's policy says
 *     auto-apply** — product/06's *"never applied silently"* is the one rule a bulk import must not
 *     inherit from the per-task path;
 *  2. an unevidenced or invented citation is **refused and recorded**, with the platform's reason
 *     where a reader of the queue will see it;
 *  3. the source is `history`, so a mined page is distinguishable from a Discovery draft;
 *  4. a redelivery writes **nothing** twice.
 */
import type { HistoryFindingsData, HistorySample, Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import { createMemoryHistoryBootstrapStore } from '../testing/memory-bootstrap.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { memoryKnowledgeStore } from '../testing/memory-knowledge.js';
import { memoryProposalStore } from '../testing/memory-proposals.js';
import { recordHistoryFindings } from './record.js';

const PROJECT = '00000000-0000-4000-8000-0000000000c1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c2' as Id;
const RUN = '00000000-0000-4000-8000-0000000000c3' as Id;
const ARTIFACT = '00000000-0000-4000-8000-0000000000c4' as Id;
const BATCH = '00000000-0000-4000-8000-0000000000c5' as Id;
const CHUNK = '00000000-0000-4000-8000-0000000000c6' as Id;
const AT = '2026-09-14T10:00:00.000Z' as IsoDateTime;

const MR_URL = 'https://git.example.test/acme/api/-/merge_requests/11';
const TICKET_URL = 'https://jira.example.test/browse/ACME-3';
const SECRET = 'sk-ant-api03-PLANTED-CREDENTIAL-0000';

/** What the platform recorded that this run was shown — the set a citation must resolve into. */
const SAMPLE = {
  merge_requests: [{ ref: '!11', url: MR_URL, rounds: 4 }],
  tickets: [{ url: TICKET_URL }],
  evidence_links: [MR_URL, TICKET_URL],
};

const proposal = (overrides: Partial<HistoryFindingsData['proposals'][number]> = {}) => ({
  finding: 'rule' as const,
  kind: 'technical' as const,
  type: 'rule' as const,
  target_path: 'technical/conventions.md',
  delta: '# Conventions\n\nMoney is never a float.\n',
  evidence: [{ kind: 'merge_request' as const, ref: '!11', url: MR_URL }],
  occurrences: 3,
  significance: 0.8,
  reason: 'asked for three times',
  ...overrides,
});

const findings = (
  proposals: readonly ReturnType<typeof proposal>[] = [proposal()],
): HistoryFindingsData =>
  ({
    proposals,
    merge_requests_read: 20,
    summary: 'reviews are mostly about money handling',
  }) as HistoryFindingsData;

/** An exact-match redactor over one planted value, so the write path can be probed. */
const redactor: SecretRedactor = {
  redactText: (text: string) => ({
    value: text.split(SECRET).join('[REDACTED:integration:git]'),
    count: text.split(SECRET).length - 1,
  }),
  redactJson: (value: unknown) => ({ value, count: 0 }),
} as SecretRedactor;

const setup = async (options: { readonly data?: unknown; readonly sample?: unknown } = {}) => {
  const eventing = new MemoryEventing();
  const bootstrap = createMemoryHistoryBootstrapStore({ now: () => AT });
  const proposals = memoryProposalStore();
  const knowledge = memoryKnowledgeStore();
  await eventing.transaction(async (scope) => {
    await bootstrap.createBatch(scope.tx, {
      id: BATCH,
      projectId: PROJECT,
      requestedBy: null,
      mergeRequests: 20,
      batchSize: 20,
      days: 183,
      capUsd: 20,
      estimatedUsd: 2,
    });
    await bootstrap.addChunk(scope.tx, {
      id: CHUNK,
      batchId: BATCH,
      chunkIndex: 0,
      taskId: TASK,
      mergeRequests: 1,
      tickets: 1,
      commits: 0,
      redactionCount: 0,
      truncated: false,
    });
  });
  let ids = 0;
  const record = () =>
    recordHistoryFindings(
      {
        unitOfWork: eventing,
        bootstrap,
        proposals,
        knowledge,
        eventStore: eventing.store,
        project: async () => ({ knowledgeDir: '.agentic/knowledge' }),
        artifact: async () => ({
          data: options.data ?? findings(),
          runId: RUN,
        }),
        sample: async () =>
          (options.sample === undefined
            ? SAMPLE
            : options.sample) as unknown as HistorySample | null,
        redactor,
        ids: {
          next: () => {
            ids += 1;
            return `00000000-0000-4000-8000-${String(ids).padStart(12, '0')}` as Id;
          },
        },
        clock: { now: () => AT },
      },
      { kind: 'record', project_id: PROJECT, task_id: TASK, artifact_id: ARTIFACT },
    );
  return { bootstrap, proposals, eventing, record };
};

describe('recording a mining run’s findings', () => {
  it('queues an evidenced proposal with source history, carrying the citations', async () => {
    const { proposals, record, bootstrap } = await setup();
    const report = await record();

    expect(report.status).toBe('recorded');
    expect(report.queued).toBe(1);
    expect(report.refused).toBe(0);

    const [row] = proposals.rows;
    expect(row?.status).toBe('queued');
    // The value migration 0030 added: a mined convention is not a Discovery draft.
    expect(row?.source).toBe('history');
    expect(row?.targetPath).toBe('.agentic/knowledge/technical/conventions.md');
    expect(row?.evidence).toEqual([`!11 ${MR_URL}`]);
    expect(row?.runId).toBe(RUN);

    const chunk = bootstrap.chunksOf(BATCH)[0];
    expect(chunk?.recordedAt).toBe(AT);
    expect(chunk?.proposals).toBe(1);
    // …and the batch is complete, because every chunk of it has reported.
    expect(bootstrap.batches[0]?.status).toBe('completed');
  });

  it('queues rather than applies, at every significance a project’s band would swallow', async () => {
    /**
     * The thresholds are **forced** (`HISTORY_PROPOSAL_THRESHOLDS`), not read from the project:
     * BD-018's band is a judgement about a Librarian that has watched a project deliver, and a
     * bootstrap is the platform's first look at six months of somebody else's history.
     *
     * **The significances are the point, and the first version of this case got them wrong.** It
     * used `1` — the maximum — and a canary that opened an auto-apply band at `proposalAbove: 1`
     * **survived**, because `dispositionFor` queues anything at or above the band. The values here
     * are the middling ones a real project's `{discard_below: 0.3, proposal_above: 0.7}` would
     * auto-apply, so the case now fails when the band opens (standing rule 3, and rule 10's shape:
     * an assertion every threshold satisfies certifies nothing).
     */
    const { proposals, record } = await setup({
      data: findings([
        proposal({ significance: 0.5, target_path: 'technical/a.md' }),
        proposal({ significance: 0.35, target_path: 'technical/b.md' }),
      ]),
    });
    await record();
    expect(proposals.rows.map((row) => row.status)).toEqual(['queued', 'queued']);
    expect(proposals.rows.map((row) => row.status)).not.toContain('auto_applied');
  });

  it('records a refused citation as a discarded row whose evidence says why', async () => {
    const invented = 'https://git.example.test/acme/api/-/merge_requests/999';
    const { proposals, record, bootstrap } = await setup({
      data: findings([
        proposal(),
        proposal({
          reason: 'invented',
          evidence: [{ kind: 'merge_request', ref: '!999', url: invented }],
        }),
      ]),
    });
    const report = await record();

    expect(report.queued).toBe(1);
    expect(report.refused).toBe(1);
    const discarded = proposals.rows.find((row) => row.status === 'discarded');
    expect(discarded?.source).toBe('history');
    expect(discarded?.evidence[0]).toContain('refused by the platform');
    expect(discarded?.evidence[0]).toContain('!999');
    // A drop nobody can see is not an audit (technical/07's "audit only" path), and the count
    // travels onto the batch screen so a run that cited nothing real is visible.
    expect(bootstrap.chunksOf(BATCH)[0]?.refusedProposals).toBe(1);
  });

  it('redacts the model’s own text on the way into the row', async () => {
    const { proposals, record } = await setup({
      data: findings([proposal({ delta: `# Conventions\n\nuse ${SECRET}\n` })]),
    });
    const report = await record();
    expect(report.redactions).toBeGreaterThan(0);
    expect(JSON.stringify(proposals.rows)).not.toContain('sk-ant-api03');
    expect(JSON.stringify(proposals.rows)).toContain('[REDACTED');
  });

  it('writes nothing on a redelivery, and appends no second event', async () => {
    const { proposals, record, eventing } = await setup();
    await record();
    const rowsAfterFirst = proposals.rows.length;
    const eventsAfterFirst = (await eventing.store.readStream('project', PROJECT)).length;
    expect(eventsAfterFirst).toBe(1);

    const again = await record();
    expect(again.status).toBe('skipped');
    expect(proposals.rows).toHaveLength(rowsAfterFirst);
    expect(await eventing.store.readStream('project', PROJECT)).toHaveLength(eventsAfterFirst);
  });

  it('records nothing once the recovery has stopped waiting for this chunk', async () => {
    /**
     * WP-48, PROGRESS backlog 106: the recovery pass gave up on this run's findings and completed
     * the batch without them, so a `record` job that arrives afterwards must not write proposals
     * against a batch that already says it finished. Both writers refuse it — the guard here and
     * `markChunkRecorded`'s own predicate — and this asserts the one that says which happened.
     */
    const { bootstrap, proposals, record, eventing } = await setup();
    await eventing.transaction(async (scope) => {
      await bootstrap.abandonChunk(scope.tx, CHUNK, { at: AT, detail: 'the wake-up was lost' });
    });

    const report = await record();
    expect(report.status).toBe('skipped');
    expect(report.reason).toContain('stopped waiting');
    expect(proposals.rows).toEqual([]);
    expect(await eventing.store.readStream('project', PROJECT)).toEqual([]);
  });

  it('records nothing when the task no longer carries the sample its citations rest on', async () => {
    // Without the platform's own record of what the run was shown there is nothing to resolve a
    // citation against, and accepting the proposals anyway would publish exactly the unevidenced
    // rows this module exists to refuse.
    const { proposals, record } = await setup({ sample: null });
    const report = await record();
    expect(report.status).toBe('skipped');
    expect(report.reason).toContain('sample');
    expect(proposals.rows).toEqual([]);
  });

  it('records nothing for an artifact this build’s schema refuses', async () => {
    const { proposals, record } = await setup({ data: { proposals: 'not a list' } });
    const report = await record();
    expect(report.status).toBe('skipped');
    expect(report.reason).toContain('HistoryFindings schema');
    expect(proposals.rows).toEqual([]);
  });
});
