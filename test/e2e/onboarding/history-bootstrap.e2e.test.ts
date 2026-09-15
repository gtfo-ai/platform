/**
 * **WP-35's acceptance, through a real `apps/server` instance**: a history bootstrap mines a
 * project's merged history and turns it into knowledge proposals that cite it.
 *
 * What this tier adds to `bootstrap/*.test.ts` is the **composition**: the bootstrap is started over
 * HTTP through the real router, the real RBAC guard and the real `Idempotency-Key` guard; the
 * provider reads go through the production `IntegrationActionExecutor` and the production binding
 * loader; the tasks are created by the production `PostgresPipelineStore`; the sample is written to
 * and read back from a real `tasks.history_sample`; and the proposals are written by the production
 * `PostgresProposalStore` from a job the instance's own worker ran. Every assertion is on a row —
 * `history_bootstrap_batches`, `history_bootstrap_chunks`, `tasks`, `runs`, `kb_proposals`,
 * `integration_actions` — never on a return value (standing rule 79).
 *
 * **The fake runner picks its scenario from the prompt** (standing rule 82), and that is the whole
 * point of this file: `scenarioFor` reads the `history` **data block** out of `spec.userPrompt` and
 * cites the merge requests it finds there. A build that lost `tasks.history_sample`, forgot the
 * block, or handed every run the same slice would find no scenario and the run would fail by name —
 * where a stage-keyed table would answer happily for a prompt that said nothing.
 *
 * Every wait is on the last row the platform writes and the rest is asserted as what that row
 * implies (standing rule 87): the chunk's `recorded_at`, the proposals and the batch's completion
 * are written in **one** transaction by the recorder, so waiting on the batch row bounds all three,
 * and the provider reads all happened before the first run started.
 */
import type { RunSpec } from '@platform/application';
import { MAX_HISTORY_EVIDENCE_PER_PROPOSAL } from '@platform/contracts';
import { readDataBlocks } from '@platform/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { GIT_PROJECT, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/**
 * How many merged merge requests the repository's history holds, against product/19 §18's fixed
 * batch size of twenty.
 *
 * Twenty-one rather than forty, so the batch is **two runs and the second is short** — a partial
 * batch is still a run, and the two chunks are what makes "each run was shown its own slice"
 * assertable at all.
 */
const MERGED = 21;
const BATCH_SIZE = 20;

/** A merge request reference the model could only have written by reading its own prompt. */
const REF = /--- merge request (![0-9]+) ---/g;
const URL_OF = /url: (\S+)/g;

/**
 * The scenario one mining run plays, built **from that run's own prompt**.
 *
 * Three proposals, and each is a case:
 *
 *  1. a `convention` observed three times, citing the merge requests this run was shown — accepted;
 *  2. a `pitfall` citing a merge request the platform counted **one** review round on — refused by
 *     `curateHistoryFindings` against the platform's own count;
 *  3. a `rule` citing a merge request that is **not in this run's sample** — refused, which is the
 *     guarantee product/19 §18's *"every proposal cites MR/ticket links as evidence"* rests on.
 */
const scenarioFromPrompt = (spec: RunSpec) => {
  const block = readDataBlocks(spec.userPrompt).blocks.find((entry) => entry.kind === 'history');
  if (block === undefined) {
    // Rule 82: no block, no scenario. The run then fails by name rather than passing on a stage map.
    return undefined;
  }
  /**
   * At most {@link MAX_HISTORY_EVIDENCE_PER_PROPOSAL} citations, because that is what the artifact
   * schema admits — a claim resting on twenty merge requests is a summary, and the first version of
   * this file cited all twenty and was refused by the runner's own validation (divergence 3 of the
   * fake's register, doing exactly what it exists for).
   */
  const refs = [...block.body.matchAll(REF)]
    .map((match) => match[1] as string)
    .slice(0, MAX_HISTORY_EVIDENCE_PER_PROPOSAL);
  const urls = [...block.body.matchAll(URL_OF)].map((match) => match[1] as string);
  const first = refs[0] as string;
  const firstUrl = urls[0] as string;
  const cite = (ref: string, url: string) => ({ kind: 'merge_request' as const, ref, url });
  return {
    structuredOutput: {
      proposals: [
        {
          finding: 'convention',
          kind: 'technical',
          type: 'doc-update',
          // One page per chunk, so two runs do not claim the same path (the curator would turn the
          // second into an `update`, which is correct but makes the count harder to read).
          target_path: `technical/conventions-${first.replace('!', '')}.md`,
          delta: `# Conventions\n\nMoney is never a float (seen in ${refs.join(', ')}).\n`,
          evidence: refs.map((ref, index) => cite(ref, urls[index] as string)),
          occurrences: 3,
          significance: 0.8,
          reason: 'the same reviewer asked for it in every merge request of this batch',
        },
        {
          finding: 'pitfall',
          kind: 'technical',
          type: 'lesson',
          target_path: `lessons/shallow-${first.replace('!', '')}.md`,
          delta: '# A lesson from a merge request nobody argued about\n',
          evidence: [cite(first, firstUrl)],
          occurrences: 1,
          significance: 0.5,
          reason: 'claims a pitfall from a merge request with one review round',
        },
        {
          finding: 'rule',
          kind: 'technical',
          type: 'rule',
          target_path: `rules/invented-${first.replace('!', '')}.md`,
          delta: '# A rule from a merge request that was never in the prompt\n',
          evidence: [cite('!9999', 'https://git.example.test/acme/api/-/merge_requests/9999')],
          occurrences: 5,
          significance: 0.9,
          reason: 'cites a merge request this run was never shown',
        },
      ],
      merge_requests_read: refs.length,
      summary: `read ${refs.length} merge requests of this project's history`,
    },
  };
};

const signIn = async (baseUrl: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post<{ user?: { id: string } }>('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

const start = async (options: { readonly capUsd?: number } = {}): Promise<PipelineE2E> => {
  const pipeline = await startPipeline({
    label: 'bootstrap',
    tickets: [],
    config: {
      version: 1,
      features: {
        history_bootstrap: {
          enabled: true,
          merge_requests: MERGED,
          days: 183,
          ...(options.capUsd === undefined ? {} : { budget_usd: options.capUsd }),
        },
      },
      /**
       * **`auto_apply: true`, deliberately.** product/06's rule is that a bootstrap's output goes to
       * the proposal **queue** whatever the project's apply policy says, and the only way to assert
       * that is to turn the policy on and find the rows still `queued` (WP-35 criterion 4).
       */
      policies: { knowledge_apply: { auto_apply: true } },
      // The platform has no definition of "closed" that is not the project's own status mapping.
      status_mapping: { done: 'Done' },
      // Two merge requests per run, so the batch is more than one chunk and each run's sample can
      // be shown to be its own slice.
      stages: { history_mining: { budget_usd: 2 } },
    },
    scenarios: featureScenarios,
    scenarioFor: (spec) => (spec.stage === 'history_mining' ? scenarioFromPrompt(spec) : undefined),
  });
  return pipeline;
};

/** The history a team merged: four merge requests, one of them argued about. */
const seedHistory = (pipeline: PipelineE2E): void => {
  for (let index = 1; index <= MERGED; index += 1) {
    const mr = pipeline.git.seedMergedMergeRequest({
      project: GIT_PROJECT,
      title: `Sum the invoice footer (${index})`,
      branch: `feature/history-${index}`,
      mergedAt: '2026-08-01T09:00:00.000Z',
      baseSha: 'b'.repeat(40),
    });
    // One review comment each, and three rounds on the first — the platform counts **threads**, so
    // the first merge request is the only one a `pitfall` could honestly come from.
    const rounds = index === 1 ? 3 : 1;
    for (let round = 0; round < rounds; round += 1) {
      pipeline.git.addHumanDiscussion({
        project: GIT_PROJECT,
        iid: mr.ref.iid,
        authorId: 'human-reviewer',
        text: `Use the money helper rather than raw floats (round ${round + 1}).`,
      });
    }
    pipeline.git.seedCommit({
      project: GIT_PROJECT,
      message: `fix(totals): round once (${index})`,
      committedAt: '2026-08-01T09:05:00.000Z',
    });
  }
  // A closed ticket of the same window, which the collection reads through `matchTickets`.
  pipeline.tickets.seedTicket({
    key: 'ACME-CLOSED',
    title: 'Rounding happened twice',
    status: 'Done',
    description: 'The invoice footer disagreed with the rows by a cent.',
  });
};

const startBootstrap = async (client: Client, projectId: string, key: string) =>
  client.json<{ batch_id: string; estimate: { batches: number; estimated_usd: number } }>(
    `/api/projects/${projectId}/history-bootstraps`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ merge_requests: MERGED }),
    },
  );

describe('a history bootstrap on a project’s merged history', () => {
  it('mines the history into evidenced proposals, and queues every one of them', async () => {
    const pipeline = await start();
    harness = pipeline;
    seedHistory(pipeline);
    const client = await signIn(pipeline.instance.baseUrl);

    // The header is required on a POST that creates (technical/08 § Principles), and a header that
    // is optional is a header production omits — so the refusal is asserted first.
    const unkeyed = await client.json<{ error: { code: string } }>(
      `/api/projects/${pipeline.projectId}/history-bootstraps`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ merge_requests: MERGED }),
      },
    );
    expect(unkeyed.status).toBe(400);
    expect(unkeyed.body.error.code).toBe('idempotency_key_required');

    // The estimate the operator is shown **before** anything starts — product/06 step 3b.
    const gate = await client.json<{
      can_start: boolean;
      estimate: { batches: number; estimated_usd: number; cap_usd: number };
    }>(`/api/projects/${pipeline.projectId}/history-bootstraps?merge_requests=${MERGED}`);
    expect(gate.status).toBe(200);
    expect(gate.body.can_start).toBe(true);
    expect(gate.body.estimate.batches).toBe(2);

    const created = await startBootstrap(client, pipeline.projectId, 'boot-1');
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    const batchId = created.body.batch_id;

    // ── the countable effects ────────────────────────────────────────────────

    await pipeline.waitFor('the batch has finished', async () => {
      const rows = await pipeline.query<{ status: string; completed_at: Date | null }>(
        'select status, completed_at from history_bootstrap_batches where id = $1',
        [batchId],
      );
      return rows[0]?.completed_at != null;
    });

    const [batch] = await pipeline.query<{ status: string; merge_requests: number }>(
      'select status, merge_requests from history_bootstrap_batches where id = $1',
      [batchId],
    );
    expect(batch?.status).toBe('completed');
    expect(batch?.merge_requests).toBe(MERGED);

    const chunks = await pipeline.query<{
      chunk_index: number;
      merge_requests: number;
      proposals: number;
      refused_proposals: number;
      recorded_at: Date | null;
    }>(
      'select chunk_index, merge_requests, proposals, refused_proposals, recorded_at from history_bootstrap_chunks where batch_id = $1 order by chunk_index',
      [batchId],
    );
    // product/19 §18's *"batches of ~20 MRs per run"*, at this test's smaller batch size.
    expect(chunks.map((chunk) => chunk.merge_requests)).toEqual([BATCH_SIZE, MERGED - BATCH_SIZE]);
    expect(chunks.every((chunk) => chunk.recorded_at != null)).toBe(true);
    /**
     * Both directions of the pitfall threshold, in one batch (standing rule 42).
     *
     * The **first** chunk's first merge request is the one the team argued about — three review
     * threads, which the platform counted when it built the sample — so its pitfall is accepted and
     * that chunk keeps two proposals. The **second** chunk's only merge request has one round, so
     * its pitfall is refused against the platform's own count. Both chunks refuse the invented
     * citation.
     */
    expect(chunks.map((chunk) => chunk.proposals)).toEqual([2, 1]);
    expect(chunks.map((chunk) => chunk.refused_proposals)).toEqual([1, 2]);

    // Every task is a mining task, and every run is a `bootstrap` run by the `historian`.
    const tasks = await pipeline.query<{ template: string; ticket_key: string }>(
      'select template, ticket_key from tasks where project_id = $1 order by ticket_key',
      [pipeline.projectId],
    );
    expect(tasks.every((task) => task.template === 'history_bootstrap')).toBe(true);
    const runs = await pipeline.query<{ mode: string; role: string }>(
      'select distinct mode, role from runs where project_id = $1',
      [pipeline.projectId],
    );
    expect(runs).toEqual([{ mode: 'bootstrap', role: 'historian' }]);

    // ── the sample the prompt was built from, on the row ─────────────────────

    const samples = await pipeline.query<{ history_sample: { merge_requests: unknown[] } | null }>(
      'select history_sample from tasks where project_id = $1',
      [pipeline.projectId],
    );
    expect(samples).toHaveLength(2);
    expect(
      samples
        .map((row) => row.history_sample?.merge_requests.length)
        .sort((a, b) => Number(b) - Number(a)),
    ).toEqual([BATCH_SIZE, MERGED - BATCH_SIZE]);

    // ── the proposals: queued, evidenced, and refused by name ────────────────

    const proposals = await pipeline.query<{
      source: string;
      status: string;
      target_path: string;
      evidence: string[];
    }>('select source, status, target_path, evidence from kb_proposals where project_id = $1', [
      pipeline.projectId,
    ]);
    expect(proposals).toHaveLength(6);
    // The value migration 0030 added: a mined page is not a Discovery draft.
    expect(proposals.every((row) => row.source === 'history')).toBe(true);
    /**
     * **`auto_apply: true` and every accepted proposal is still `queued`.**
     *
     * product/06's rule, and the one thing a bulk import must not inherit from the per-task path.
     */
    const queued = proposals.filter((row) => row.status === 'queued');
    expect(queued).toHaveLength(3);
    expect(proposals.some((row) => row.status === 'auto_applied')).toBe(false);
    // Every queued proposal cites a merge request of this project, by URL a maintainer can follow.
    for (const row of queued) {
      expect(row.evidence.length).toBeGreaterThan(0);
      expect(row.evidence.join(' ')).toContain('/-/merge_requests/');
    }

    const discarded = proposals.filter((row) => row.status === 'discarded');
    expect(discarded).toHaveLength(3);
    const reasons = discarded.map((row) => row.evidence[0] ?? '').join(' | ');
    // The refusal a citation nobody showed the model earns, and the one product/19's pitfall
    // threshold earns — both recorded rather than dropped (technical/07's "audit only").
    expect(reasons).toContain('!9999');
    expect(reasons).toContain('review rounds');
    expect(reasons).toContain('refused by the platform');

    // ── what reached the provider ────────────────────────────────────────────

    const audit = await pipeline.auditRows();
    const actions = audit.map((row) => row.action);
    // `1 + N` discussion reads, plus the commit list and the closed-ticket match — the shape
    // PROGRESS backlog 64 records, made countable rather than described.
    expect(actions.filter((action) => action === 'list_merged_merge_requests')).toHaveLength(1);
    expect(actions.filter((action) => action === 'list_discussions')).toHaveLength(MERGED);
    expect(actions.filter((action) => action === 'list_commits')).toHaveLength(1);
    expect(actions.filter((action) => action === 'match_tickets')).toHaveLength(1);
    // …and nothing was written anywhere: a bootstrap reads.
    expect(audit.filter((row) => row.action === 'commit_files')).toEqual([]);
    expect(audit.filter((row) => row.action === 'open_merge_request')).toEqual([]);

    // ── the batch, read back through the API ─────────────────────────────────

    const listed = await client.json<{
      items: {
        id: string;
        status: string;
        proposals: number;
        refused_proposals: number;
        chunks_recorded: number;
        spent_usd: number;
      }[];
      can_start: boolean;
    }>(`/api/projects/${pipeline.projectId}/history-bootstraps`);
    expect(listed.status).toBe(200);
    const item = listed.body.items.find((row) => row.id === batchId);
    expect(item?.status).toBe('completed');
    expect(item?.proposals).toBe(3);
    expect(item?.refused_proposals).toBe(3);
    expect(item?.chunks_recorded).toBe(2);
    // The spend comes from `cost_entries`, which is the same source the cap is enforced against.
    expect(item?.spent_usd).toBeGreaterThan(0);
    // …and another bootstrap may start now that this one has finished.
    expect(listed.body.can_start).toBe(true);
  }, 180_000);

  it('refuses a second bootstrap while one is still running', async () => {
    const pipeline = await start();
    harness = pipeline;
    seedHistory(pipeline);
    const client = await signIn(pipeline.instance.baseUrl);

    const first = await startBootstrap(client, pipeline.projectId, 'boot-1');
    expect(first.status).toBe(202);

    // A different key and a different body: the refusal is the **project's** live batch, not the
    // idempotency guard, which is what `already_running` means.
    const second = await client.json<{ error: { code: string } }>(
      `/api/projects/${pipeline.projectId}/history-bootstraps`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'boot-2' },
        body: JSON.stringify({ merge_requests: 2 }),
      },
    );
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('bootstrap_already_running');
    const batches = await pipeline.query<{ count: string }>(
      'select count(*)::text as count from history_bootstrap_batches where project_id = $1',
      [pipeline.projectId],
    );
    expect(Number(batches[0]?.count)).toBe(1);
  }, 120_000);

  it('stops the batch when its budget cap is spent', async () => {
    /**
     * **2.20 USD, chosen so the cap bites on the *second* admission** rather than the first.
     *
     * The guard adds what this run *may* spend to what the batch *has* spent, for
     * `taskBudgetExhausted`'s reason: a budget checked only against past spend is a budget
     * discovered one run too late. `history_mining` may spend 2 and the scripted run costs 0.40 —
     * so 2.20 admits the first run (0 + 2 ≤ 2.2) and refuses the second (0.40 + 2 > 2.2), which is
     * what leaves a **ledger row** for the assertion to read. A cap below 2 would refuse the first
     * run and prove only that a number was compared with zero; 2.50 — the figure this case was
     * first written with, copied from the shadow batch's — admits **both**, because every mining
     * run has the same $2 budget where a shadow task's second stage has $5.
     */
    const pipeline = await start({ capUsd: 2.2 });
    harness = pipeline;
    seedHistory(pipeline);
    const client = await signIn(pipeline.instance.baseUrl);

    const created = await startBootstrap(client, pipeline.projectId, 'boot-cap');
    expect(created.status).toBe(202);

    await pipeline.waitFor('a mining task is paused for budget', async () => {
      const rows = await pipeline.query<{ count: string }>(
        `select count(*)::text as count from tasks
          where project_id = $1 and template = 'history_bootstrap' and state = 'paused'`,
        [pipeline.projectId],
      );
      return Number(rows[0]?.count ?? 0) > 0;
    });

    // One run happened and one did not: the ledger has a row, and the batch never completes —
    // "stops when it is spent" rather than "refuses before it starts".
    const entries = await pipeline.query<{ count: string }>(
      'select count(*)::text as count from cost_entries where project_id = $1',
      [pipeline.projectId],
    );
    expect(Number(entries[0]?.count)).toBeGreaterThan(0);
    const [batch] = await pipeline.query<{ completed_at: Date | null }>(
      'select completed_at from history_bootstrap_batches where project_id = $1',
      [pipeline.projectId],
    );
    expect(batch?.completed_at).toBeNull();
  }, 180_000);
});
