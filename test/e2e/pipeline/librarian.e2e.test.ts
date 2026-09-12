/**
 * **WP-18b end to end: a merged ticket produces knowledge proposals, and an accepted one becomes a
 * commit.**
 *
 * Every assertion here is against a real `apps/server` instance — the production composition root,
 * the real pg-boss, the real binding loader, the production `PostgresProposalStore` — and the runner
 * is the **real** `createClaudeRunner` over a scripted CLI process (`agent: 'real-over-fake-cli'`).
 * That choice is standing rule 82 applied to this work package: `FakeClaudeRunner` picks its
 * scenario from `spec.stage` and never reads the prompt, but more importantly it is composed here
 * with a sink that stores nothing — and the artefact this half of WP-18 exists to produce is a
 * **model output that becomes a row and then a commit**. Driving the real runner means the bytes in
 * `artifacts.data` are the bytes the CLI wrote, which is what makes the redaction assertion below
 * mean anything.
 *
 * ## What each case is for
 *
 * 1. **The stage runs and the policy decides.** A feature ticket walks to `done` through the
 *    `librarian` stage, and the four proposals the scenario produces land as four rows with the
 *    statuses BD-018's thresholds imply — one auto-applied, one queued, one discarded for noise and
 *    one discarded for a path outside the vault. Both sides of both thresholds in one pass.
 * 2. **The commit.** The auto-applied page is committed on an `agentic/knowledge/*` branch with the
 *    provenance trailer technical/07 specifies, an MR is opened against the default branch, and the
 *    refused proposals are in neither.
 * 3. **The redaction (TD-012).** The scenario's page repeats this run's `ANTHROPIC_API_KEY`. The
 *    runner passes `structuredOutput` through untouched, so the raw key **is** in `artifacts.data` —
 *    asserted, because a test that could not see it could not tell a redactor that worked from a
 *    fixture that never carried a secret — and is in **neither** the proposal row nor the commit.
 * 4. **The UI's endpoints**, over HTTP, signed in: the queue, the tree, one document, and a decision
 *    that turns into a second commit.
 */
import type { KbProposalsResponse, KbTreeResponse } from '@platform/contracts';
import { kbProposalsResponseSchema, kbTreeResponseSchema } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { PLANTED_MODEL_KEY, PLANTED_MODEL_KEY_PLACEHOLDER } from '../support/agent-workspace.js';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { GIT_PROJECT, inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const ticketMatched = (pipeline: PipelineE2E) =>
  inboundEvent('ticket.matched', {
    project_id: pipeline.projectId,
    ticket: {
      provider: 'fake-task-management',
      key: 'ACME-1',
      url: 'https://tickets.example.test/browse/ACME-1',
    },
    rule: 'label:agentic',
    priority: 'High',
    issue_type: 'Story',
    epic: null,
    links: [],
  });

const merged = (pipeline: PipelineE2E) =>
  inboundEvent('mr.merged', {
    project_id: pipeline.projectId,
    task_id: null,
    mr: {
      provider: 'fake-git',
      project_path: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      url: pipeline.world.mr.url,
      branch: pipeline.world.branch,
      head_sha: pipeline.world.mr.headSha,
    },
    draft: false,
    head_sha: pipeline.world.mr.headSha,
    diff_stats: null,
    merge_commit_sha: 'c'.repeat(40),
  });

const signIn = async (baseUrl: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

const AUTO_APPLIED_PATH = '.agentic/knowledge/lessons/L-2026-09-12-totals.md';
const QUEUED_PATH = '.agentic/knowledge/lessons/L-2026-09-12-rounding.md';

/** A feature ticket, merged, with `auto_apply` on — BD-018's band then commits without a human. */
const startMerged = async (label: string): Promise<PipelineE2E> => {
  const pipeline = await startPipeline({
    scenarios: featureScenarios,
    label,
    tickets: TICKETS,
    agent: 'real-over-fake-cli',
    config: { policies: { knowledge_apply: { auto_apply: true } } },
  });
  harness = pipeline;
  await pipeline.publish([ticketMatched(pipeline)]);
  await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');
  await pipeline.publish([merged(pipeline)]);
  await pipeline.settle('done', (task) => task.state === 'done');
  /**
   * **Wait for the line each case asserts, not for one that precedes it** (standing rule 50, and
   * the flake it was earned on).
   *
   * `task.completed` is the *stage's* ending; the curation runs in a `knowledge.proposals` job and
   * the commit in a `knowledge.apply` job, two queue hops later. Waiting only for `done` passed
   * most of the time and left the first case reading `auto_applied` and the second one committing
   * two pages in one batch.
   */
  await pipeline.waitFor(
    'the four proposals to be curated and the auto-applied one committed',
    async () => {
      const rows = await pipeline.proposals();
      return (
        rows.length === 4 &&
        rows.some((row) => row.target_path === AUTO_APPLIED_PATH && row.status === 'applied')
      );
    },
  );
  return pipeline;
};

describe('the librarian stage, over a merged ticket', () => {
  it('records what it proposed, commits what the policy accepted, and redacts both', async () => {
    const pipeline = await startMerged('librarian');

    // ── the stage ran, and it was an agent stage with an artifact ────────────
    expect(pipeline.agentRuns.map((run) => run.stage)).toEqual([
      'refinement',
      'architecture',
      'implementation',
      'code_review',
      'business_review',
      'retrospective',
      'librarian',
    ]);
    const artifact = (await pipeline.artifactData('LibrarianProposals')) as {
      proposals: { target_path: string }[];
    };
    expect(artifact.proposals).toHaveLength(4);

    // ── the four rows, and the policy that decided each ──────────────────────
    const rows = await pipeline.proposals();
    const byPath = new Map(rows.map((row) => [row.target_path, row]));
    // Inside the band with `auto_apply` on: the policy decided, so it is applied without a human.
    expect(byPath.get(AUTO_APPLIED_PATH)?.status).toBe('applied');
    // Above `proposal_above`: a maintainer decides, whatever `auto_apply` says.
    expect(byPath.get(QUEUED_PATH)?.status).toBe('queued');
    // Below `discard_below`: recorded for the audit, never applied.
    expect(byPath.get('.agentic/knowledge/lessons/L-2026-09-12-noise.md')?.status).toBe(
      'discarded',
    );
    // Outside the vault: refused whatever its significance (BD-025), and the row keeps the model's
    // own path so a human can see what was asked for.
    expect(byPath.get('../../.github/workflows/ci.yml')?.status).toBe('discarded');

    // Provenance: the task and the run that produced it, on every row.
    const task = await pipeline.task();
    for (const row of rows) {
      expect(row.task_id).toBe(task.id);
      expect(row.run_id).not.toBeNull();
      expect(Array.isArray(row.evidence)).toBe(true);
    }

    // ── the commit ───────────────────────────────────────────────────────────
    //
    // No wait here, and that is the same rule the other case learned: `startMerged` already waited
    // for the **row** to reach `applied`, which the apply pass writes *after* the provider call and
    // after the executor's audit row. Everything this block reads — the commit, the audit row — is
    // therefore already written. Waiting on the commit and asserting the row is the ordering that
    // fails; waiting on the row and asserting the commit is the one that cannot.
    expect(pipeline.git.commits).toHaveLength(1);
    const commit = pipeline.git.commits[0];
    expect(commit?.branch.startsWith('agentic/knowledge/')).toBe(true);
    expect(commit?.project).toBe(GIT_PROJECT);
    // Only the accepted page, and only inside the vault.
    expect(commit?.files.map((file) => file.path)).toEqual([AUTO_APPLIED_PATH]);
    // The provenance trailer technical/07 specifies, with the **ticket key**.
    expect(commit?.message).toContain('Agentic-Source: task ACME-1 run ');
    expect(commit?.author.name).toBe('Agentic');
    // The row records which commit carried it.
    expect(byPath.get(AUTO_APPLIED_PATH)?.applied_commit_sha).toBe(commit?.sha);

    // …and a merge request against the default branch, never a push to it.
    const branch = commit?.branch as string;
    expect(pipeline.git.fileAt(GIT_PROJECT, 'main', AUTO_APPLIED_PATH)).toBeNull();
    expect(pipeline.git.fileAt(GIT_PROJECT, branch, AUTO_APPLIED_PATH)).not.toBeNull();

    // ── redaction, in both directions (TD-012, standing rule 42) ─────────────
    //
    // The runner passes `structuredOutput` through untouched, so the raw credential really is in
    // the artifact row — which is what makes the two `not.toContain`s below evidence rather than a
    // fixture that never carried a secret.
    //
    // **It is also a finding, and this line is its reproduction.** TD-012's write list names
    // *artifacts*, and `artifacts.data` is written unredacted by the stage executor — for every
    // artifact type, not only this one. It is reported as discovered work rather than fixed here
    // (it is a change to the executor's write path, and this work package owns the proposals).
    // When somebody does fix it, **this** expectation becomes the placeholder and the two below it
    // do not move: they are about the redactor the curation composes.
    expect(JSON.stringify(artifact)).toContain(PLANTED_MODEL_KEY);
    const storedDelta = byPath.get(AUTO_APPLIED_PATH)?.delta ?? '';
    expect(storedDelta).not.toContain(PLANTED_MODEL_KEY);
    expect(storedDelta).toContain(PLANTED_MODEL_KEY_PLACEHOLDER);
    const committed = commit?.files[0]?.content ?? '';
    expect(committed).not.toContain(PLANTED_MODEL_KEY);
    expect(committed).toContain(PLANTED_MODEL_KEY_PLACEHOLDER);

    // ── the audit row every provider call leaves (technical/06) ──────────────
    const audited = await pipeline.auditRows();
    const commitAction = audited.find((row) => row.action === 'commit_files');
    expect(commitAction?.status).toBe('ok');
    // The payload describes what was touched; it is not a copy of the page's bytes.
    expect(JSON.stringify(commitAction?.payload)).toContain(AUTO_APPLIED_PATH);
    expect(JSON.stringify(commitAction?.payload)).not.toContain('Sum the invoice model');
  }, 300_000);

  it('serves the queue, the tree and a document, and commits what a maintainer approves', async () => {
    const pipeline = await startMerged('librarian-api');
    const client = await signIn(pipeline.instance.baseUrl);

    // ── the queue ────────────────────────────────────────────────────────────
    const queue = await client.json<KbProposalsResponse>(
      `/api/projects/${pipeline.projectId}/kb/proposals`,
    );
    expect(queue.status, JSON.stringify(queue.body)).toBe(200);
    const page = kbProposalsResponseSchema.parse(queue.body);
    expect(page.items).toHaveLength(4);
    // Proposal text reaches the response as data — and as the redacted data that was stored.
    const served = JSON.stringify(page);
    expect(served).not.toContain(PLANTED_MODEL_KEY);
    expect(served).toContain(PLANTED_MODEL_KEY_PLACEHOLDER);

    // ── the tree and one document, which the indexer wrote ───────────────────
    //
    // The vault this project's mirror holds is whatever `APP_KNOWLEDGE_MIRROR_ROOT` let the indexer
    // read — nothing, in this tier — so the tree is legitimately empty and the assertion is on the
    // *shape* answering rather than on a page being there. What it proves is that the endpoint is
    // served, scoped and parsed by the published schema (the census proves the 401 half).
    const tree = await client.json<KbTreeResponse>(`/api/projects/${pipeline.projectId}/kb/tree`);
    expect(tree.status, JSON.stringify(tree.body)).toBe(200);
    expect(kbTreeResponseSchema.parse(tree.body).entries).toEqual([]);
    const missing = await client.json<{ error: { code: string } }>(
      `/api/projects/${pipeline.projectId}/kb/doc?path=${encodeURIComponent(QUEUED_PATH)}`,
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');

    // ── a maintainer's decision, and the commit it causes ────────────────────
    const queued = page.items.find((item) => item.target_path === QUEUED_PATH);
    expect(queued?.status).toBe('queued');
    const before = pipeline.git.commits.length;
    const decided = await client.post(
      `/api/projects/${pipeline.projectId}/kb/proposals/${queued?.id}/approve`,
      { decision: 'approve' },
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    /**
     * **Wait on the row, not on the commit** — standing rule 50, paid for by CI run `34722271238`,
     * which failed here on a **docs-only** commit while the same job was green on the code one.
     *
     * `knowledge.apply` calls the provider and writes `status = 'applied'` **afterwards**, in a
     * transaction of its own, so `pipeline.git.commits.length > before` becomes true a moment
     * before the row moves — and the assertion two lines later fell into that window. The rate was
     * the only random thing about it (rule 76): the ordering is fixed, the gap is one transaction
     * wide, and a loaded runner is all it takes.
     *
     * The row reaching `applied` is the **last** thing the pass does and it implies the commit, so
     * this is both the stronger wait and the one the assertions below are about. Nothing here is
     * weakened: every assertion the old ordering made is still made, plus the sha tie that the old
     * ordering could not make because it read the row before the writer had put one on it.
     */
    await pipeline.waitFor('the approved proposal to be applied', async () =>
      (await pipeline.proposals()).some(
        (row) => row.target_path === QUEUED_PATH && row.status === 'applied',
      ),
    );
    const applied = (await pipeline.proposals()).find((row) => row.target_path === QUEUED_PATH);
    expect(applied?.status).toBe('applied');
    expect(applied?.decided_by).not.toBeNull();

    const second = pipeline.git.commits.at(-1);
    expect(pipeline.git.commits.length).toBe(before + 1);
    expect(second?.files.map((file) => file.path)).toEqual([QUEUED_PATH]);
    expect(second?.branch).not.toBe(pipeline.git.commits[0]?.branch);
    expect(applied?.applied_commit_sha).toBe(second?.sha);

    // ── and a rejection writes nothing to git ────────────────────────────────
    const noise = page.items.find((item) => item.status === 'discarded');
    const rejected = await client.post(
      `/api/projects/${pipeline.projectId}/kb/proposals/${noise?.id}/reject`,
      { decision: 'reject', reason: 'not worth a page' },
    );
    // A discarded proposal is past deciding: the queue is for `queued` rows (BD-018's "audit only").
    expect(rejected.status).toBe(409);
    expect(pipeline.git.commits.length).toBe(before + 1);
  }, 300_000);
});
