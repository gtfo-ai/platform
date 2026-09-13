/**
 * **WP-24's headline criterion: a signed merge-request delivery to a running `apps/server` drives a
 * review-only task to completion and posts the review on the merge request.**
 *
 * Everything from the socket in is production code — the unauthenticated `/webhooks/:provider/:id`
 * route and its raw-body parser, the binding loader reading `integrations`/`bindings` and
 * decrypting `secrets`, the provider's own signature check, `inbox(provider, delivery_id)`, the
 * event append, the outbox worker, the `pipeline.review.only` handler, the `review_only_check`
 * outbound job, the stage executor, the **production** `ClaudeRunner` over a scripted CLI, and the
 * `review_only_post` job that writes the threads through `IntegrationActionExecutor`.
 *
 * Two things this file is written to avoid.
 *
 *  - **The prompt assertion is on the bytes the CLI received** (standing rule 82). `FakeClaudeRunner`
 *    picks its scenario from `spec.stage` and never reads the prompt, so `agent: 'real-over-fake-cli'`
 *    is what makes "the merge request's diff reached the model" a claim that can fail.
 *  - **The redaction assertion is on a credential the instance really holds.** `PLANTED_MODEL_KEY`
 *    is in the instance's environment and in the model's own answer, and the only thing between it
 *    and a comment on somebody's merge request is the git binding's redactor at
 *    `reviewWrites.thread`.
 *
 * What it does not prove: GitLab's own signature scheme and its discussions API (the contract tier's
 * replay corpus does that), and anything about a real model.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { GIT_PROJECT, type PipelineE2E, startPipeline } from '../support/pipeline.js';

/**
 * A credential planted in the **model's own answer**, on its way to somebody's merge request.
 *
 * Obviously fake (BD-002) and shaped so TD-012 **step 2** — the gitleaks-derived pattern rules —
 * matches it, because step 2 is the half that reaches this sink: `reviewWrites.thread` redacts with
 * the **git binding's** redactor, which `bindings/loader.ts` composes as the binding's own
 * credentials plus `apps/server`'s `platformRedactor`. That composition is what this assertion
 * exists to prove, and it can only be proved through a composed instance.
 *
 * **The residual, restated to what was measured** (review round 2): a credential that is neither one
 * of the binding's own nor pattern-shaped would survive into a posted thread, because the posting
 * job runs outside the run and holds no run-scoped secret set (Q55). On this build **a review-only
 * run has no run-scoped credential at all** — the reviewer's tools make the run read-only and
 * `RunCredentialBroker.issue` mints nothing (BD-021), measured in
 * `packages/infrastructure/src/workspace/spec.test.ts` § "is none for a review-only run" — so the
 * hole is a future one: a role that both mints and posts. `PLANTED_MODEL_KEY` (the
 * `ANTHROPIC_API_KEY` the instance is started with) is deliberately *not* pattern-shaped, which is
 * why the assertion below plants an `sk-ant-…` shape instead: a real model credential is a pattern
 * match and is covered.
 */
const PLANTED_IN_ANSWER = 'sk-ant-api03-FAKE000000000000000000000000000';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** The Reviewer's answer: one blocker worth posting, one nit that the severity floor drops. */
const VERDICT = {
  verdict: 'request_changes',
  findings: [
    {
      id: 'f1',
      severity: 'blocker',
      category: 'security',
      file: 'src/totals.ts',
      line: 3,
      // A credential quoted into the answer — the ordinary way one reaches a comment on somebody
      // else's merge request.
      explanation: `The config hard-codes ${PLANTED_IN_ANSWER}, which must not be committed.`,
      suggestion: 'Read it from the environment.',
    },
    {
      id: 'f2',
      severity: 'nit',
      category: 'conventions',
      file: 'src/totals.ts',
      line: 9,
      explanation: 'A trailing space.',
      suggestion: null,
    },
  ],
  summary: 'One security problem; the rest reads fine.',
  protected_path_changes_confirmed: [],
};

const REVIEW_ONLY_CONFIG = {
  features: {
    review_only: {
      enabled: true,
      trigger: 'label',
      label: 'agentic-review',
      severity_floor: 'major',
      max_findings: 10,
    },
  },
};

/** The human's merge request: opened by a person, labelled for review, with a diff of its own. */
const humanMergeRequest = async (pipeline: PipelineE2E, labels: readonly string[]) => {
  const mr = await pipeline.git.openMergeRequest({
    project: GIT_PROJECT,
    branch: 'human/fix-the-footer',
    target: 'main',
    title: 'Fix the invoice footer',
    description: 'The footer sums the visible rows. This sums the model instead.',
    draft: false,
    labels: [...labels],
    reviewers: [],
    remove_source_branch: true,
  });
  pipeline.git.setDiff({
    project: GIT_PROJECT,
    iid: mr.ref.iid,
    files: [
      {
        path: 'src/totals.ts',
        diff: '@@ -1,3 +1,3 @@\n-const total = lines.reduce(sum, 0);\n+const total = model.lines.reduce(sum, 0);\n',
      },
    ],
  });
  return mr;
};

/**
 * The audit rows for the threads this mode posted — **the last write `review_only_post` makes, and
 * therefore the line every wait in this file binds to.**
 *
 * A thread is two writes, in this order: `IntegrationActionExecutor` performs the provider call and
 * writes the `integration_actions` row **after** it returns (`action-executor.ts` step 5, "Success:
 * remember it, then record it"). So a wait on the fake provider's discussions is satisfied one
 * write short of the rows the assertions read, and the summary — posted second — is the row that
 * goes missing. That is standing rule 50/76's shape, and it is not hypothetical here: delaying the
 * executor's post-call `record` by 1.5 s made the previous wait fail on **every** run at
 * `expected [ { …(7) } ] to have a length of 2 but got 1`, which is verbatim the intermittent this
 * file produced once on a loaded machine. Bind to the row, and the discussion is what the row
 * implies.
 */
const auditedThreads = async (pipeline: PipelineE2E) =>
  (await pipeline.auditRows()).filter((row) => row.action === 'create_discussion');

/**
 * The threads this mode posted, and the wait that has to precede reading them.
 *
 * **Bound the line you assert, not one that precedes it** (standing rule 50/76). A review-only task
 * reaches `done` in the core band; the threads are written by the `review_only_post` job, which the
 * handler at TD-005 priority 120 enqueues *after* that commit. Waiting on the task state and then
 * reading the merge request is a wait that is structurally incapable of covering the assertion — it
 * passed nothing at all here, which is the honest version of the flake that shape usually produces.
 * {@link auditedThreads} is that argument one layer further in: the merge request is itself a
 * *preceding* line once the assertions read the audit.
 */
const ourThreads = async (pipeline: PipelineE2E, iid: number, url: string) => {
  const ref = { provider: 'fake-git', project_path: GIT_PROJECT, iid, url };
  const mine = async () =>
    (await pipeline.git.listDiscussions(ref)).filter((discussion) =>
      discussion.notes.some((note) => note.body.includes('agentic:review-only')),
    );
  return { ref, mine };
};

const reviewTaskOf = async (pipeline: PipelineE2E) => {
  const rows = await pipeline.query<{
    id: string;
    state: string;
    template: string;
    ticket_key: string;
    ticket_url: string;
    mr_ref: unknown;
    review_subject: { title: string; files: { path: string; diff: string }[] } | null;
  }>(
    `select id, state, template, ticket_key, ticket_url, mr_ref, review_subject
       from tasks where template = 'review_only' order by created_at limit 1`,
  );
  return rows[0] ?? null;
};

describe('review-only mode, from a signed merge-request delivery', () => {
  it('reviews a labelled human merge request and posts findings and a neutral summary', async () => {
    const pipeline = await startPipeline({
      scenarios: () => ({ code_review: { structuredOutput: VERDICT } }),
      label: 'review-only',
      config: REVIEW_ONLY_CONFIG,
      agent: 'real-over-fake-cli',
      // The project's own CI has nothing to do with a human's merge request.
      ciStatus: null,
    });
    harness = pipeline;

    const mr = await humanMergeRequest(pipeline, ['agentic-review']);
    expect(await pipeline.taskCount()).toBe(0);

    const delivery = pipeline.git.emitMergeRequestEvent({
      event: 'mr.opened',
      project: GIT_PROJECT,
      iid: mr.ref.iid,
    });
    const response = await pipeline.deliverGit(delivery);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ accepted: true });

    await pipeline.waitFor('the review task to finish', async () => {
      const task = await reviewTaskOf(pipeline);
      return task?.state === 'done';
    });

    // ── the task shape ──────────────────────────────────────────────────────
    const task = await reviewTaskOf(pipeline);
    expect(task?.template).toBe('review_only');
    expect(task?.ticket_key).toBe(`mr!${mr.ref.iid}`);
    expect(task?.ticket_url).toBe(mr.web_url);
    // `mr_ref` stays null on purpose: `findByMergeRequest` answers "whose work produced this merge
    // request", and a review-only task produced nothing (`review-only.ts` has the argument).
    expect(task?.mr_ref).toBeNull();
    expect(task?.review_subject?.title).toBe('Fix the invoice footer');
    expect(task?.review_subject?.files[0]?.diff).toContain('+const total = model.lines');

    // ── exactly one run, and it is the reviewer's ───────────────────────────
    const runs = await pipeline.query<{ role: string; stage: string; mode: string }>(
      `select r.role, r.mode, s.stage
         from runs r join task_stages s on s.id = r.task_stage_id
        where r.task_id = $1`,
      [task?.id],
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ role: 'reviewer', stage: 'code_review', mode: 'review_only' });

    // ── the bytes the CLI received (standing rule 82) ───────────────────────
    const run = pipeline.agentRuns.find((entry) => entry.stage === 'code_review');
    expect(run, 'no code_review run reached the scripted CLI').toBeDefined();
    const stdin = JSON.stringify(run?.cli.stdin);
    expect(stdin).toContain('+const total = model.lines');
    expect(stdin).toContain('Fix the invoice footer');
    // …inside a data block, not pasted into the instructions (BD-022).
    expect(stdin).toContain('untrusted-data-');
    expect(stdin).toContain('merge_request');

    // ── the review reached the merge request ────────────────────────────────
    //
    // The wait is on the **audit rows**, which this test reads at the bottom and which the executor
    // writes after the provider call returns — see {@link auditedThreads}. The discussions are then
    // what those rows imply, so they are asserted rather than waited for.
    const threads = await ourThreads(pipeline, mr.ref.iid, mr.web_url);
    await pipeline.waitFor(
      'both review threads to be posted and audited',
      async () => (await auditedThreads(pipeline)).length >= 2,
    );
    const ours = await threads.mine();
    // The blocker as an anchored thread, and the summary on the merge request itself. The `nit` is
    // below the project's `major` floor and is *not* posted, which is the other half of the pair.
    expect(ours).toHaveLength(2);
    const anchored = ours.filter((discussion) => discussion.notes[0]?.path !== null);
    expect(anchored).toHaveLength(1);
    expect(anchored[0]?.notes[0]).toMatchObject({ path: 'src/totals.ts', line: 3 });

    const bodies = ours
      .flatMap((discussion) => discussion.notes.map((note) => note.body))
      .join('\n');
    expect(bodies).toContain('blocker · security');
    expect(bodies).toContain('One security problem');
    expect(bodies).not.toContain('A trailing space.');

    // ── neutral, in the platform's own voice ────────────────────────────────
    expect(bodies).toContain('does not approve or reject this merge request');
    expect(bodies).toContain('does not block the merge');
    // The model's verdict is not published: a `request_changes` must not read as a rejection.
    expect(bodies).not.toContain('request_changes');

    // ── TD-012, both directions (standing rule 42) ──────────────────────────
    expect(bodies).not.toContain(PLANTED_IN_ANSWER);
    expect(bodies).toContain('[REDACTED sha256:');
    expect(bodies).toContain('The config hard-codes');

    // ── product/18 level 0: no agent merge request ──────────────────────────
    //
    // Asserted on the audit log rather than on a counter of this test's own: every mutating
    // provider call the pipeline makes leaves an `integration_actions` row (BD-003), so "no merge
    // request was opened" is a question about what the instance did, not about what this file
    // happened to wrap.
    const actions = await pipeline.auditRows();
    expect(actions.map((row) => row.action)).not.toContain('open_merge_request');
    // The same spelling the wait above uses, so the two cannot drift apart: exactly two, which is
    // the pair the merge request carries — the blocker and the summary.
    expect(await auditedThreads(pipeline)).toHaveLength(2);
  }, 180_000);

  it('does nothing at all for a merge request the filter does not select', async () => {
    const pipeline = await startPipeline({
      scenarios: () => ({ code_review: { structuredOutput: VERDICT } }),
      label: 'review-only-miss',
      config: REVIEW_ONLY_CONFIG,
      ciStatus: null,
    });
    harness = pipeline;

    const mr = await humanMergeRequest(pipeline, ['bug']);
    const response = await pipeline.deliverGit(
      pipeline.git.emitMergeRequestEvent({
        event: 'mr.opened',
        project: GIT_PROJECT,
        iid: mr.ref.iid,
      }),
    );
    expect(response.status).toBe(202);

    // The delivery was accepted and recorded; what must not happen is a task, a run or a comment.
    //
    // **The bound is the duty's own last read, not the dispatch queue** (standing rules 4 and 49).
    // Every assertion below is negative, and a negative assertion passes silently on a duty that
    // has not started: `reviewOnlyHandler` only *enqueues* `review_only_check` after its commit, so
    // a drained `event_dispatch` says the handler ran, not that the filter did. `runReviewOnlyCheck`
    // reads the merge request, then its diff, then applies the label filter on the next line with
    // nothing written in between — so the diff read's `integration_actions` row is the marker that
    // the refusal has been reached, exactly as `ticket-lint.e2e.test.ts` uses `read_ticket`. This
    // test is the only reader of that merge request: no task exists, so there is no intake read to
    // confuse the row with.
    //
    // Residual, stated rather than implied: a *broken* filter would insert its task one transaction
    // after this row, so the wait bounds the refusal and is one transaction short of bounding a
    // mutant of it. That mutant dies in the ring that owns the filter (`mergeRequestMatchesFilter`
    // and its unit cases).
    await pipeline.waitFor('the filter to have read the merge request', async () =>
      (await pipeline.auditRows()).some(
        (row) => row.action === 'get_merge_request_diff' && row.payload.iid === mr.ref.iid,
      ),
    );
    await pipeline.waitFor('the delivery to be dispatched', async () => {
      const rows = await pipeline.query<{ pending: number }>(
        'select count(*)::int as pending from event_dispatch',
      );
      return (rows[0]?.pending ?? 0) === 0;
    });
    expect((await pipeline.inbox()).length).toBe(1);
    expect(await pipeline.taskCount()).toBe(0);
    expect(await reviewTaskOf(pipeline)).toBeNull();
    const threads = await ourThreads(pipeline, mr.ref.iid, mr.web_url);
    expect(await pipeline.git.listDiscussions(threads.ref)).toHaveLength(0);
  }, 180_000);

  it('records what became of the findings when the merge request ends', async () => {
    const pipeline = await startPipeline({
      scenarios: () => ({ code_review: { structuredOutput: VERDICT } }),
      label: 'review-only-metric',
      config: REVIEW_ONLY_CONFIG,
      ciStatus: null,
    });
    harness = pipeline;

    const mr = await humanMergeRequest(pipeline, ['agentic-review']);
    await pipeline.deliverGit(
      pipeline.git.emitMergeRequestEvent({
        event: 'mr.opened',
        project: GIT_PROJECT,
        iid: mr.ref.iid,
      }),
    );
    await pipeline.waitFor('the review task to finish', async () => {
      const task = await reviewTaskOf(pipeline);
      return task?.state === 'done';
    });

    // The human resolves the platform's threads, then merges. The same wait as the first test's
    // (standing rule 49: a liveness fix that is not swept onto its siblings is half a fix) — and
    // strictly the stronger one, because the audit row is written after the call that created the
    // thread this test is about to resolve.
    const threads = await ourThreads(pipeline, mr.ref.iid, mr.web_url);
    await pipeline.waitFor(
      'both review threads to be posted and audited',
      async () => (await auditedThreads(pipeline)).length >= 2,
    );
    for (const discussion of await threads.mine()) {
      await pipeline.git.resolveDiscussion(threads.ref, discussion.id);
    }
    await pipeline.deliverGit(
      pipeline.git.emitMergeRequestEvent({
        event: 'mr.merged',
        project: GIT_PROJECT,
        iid: mr.ref.iid,
      }),
    );
    await pipeline.waitFor('the observation to be recorded', async () => {
      const events = await pipeline.events();
      return events.some((entry) => entry.type === 'task.review.observed');
    });

    const observed = (await pipeline.events()).filter(
      (entry) => entry.type === 'task.review.observed',
    );
    expect(observed).toHaveLength(1);
    // **One**, and the number is the review round 2 correction: this review posted two threads —
    // one finding (the `nit` is below the `major` floor) and the neutral summary — and product/18:59
    // counts *findings*. The summary carries `reviewSummaryMarkerFor`, which the observation's
    // filter does not match, so a human resolving the platform's own framing is not recorded as
    // having accepted a finding. Round 1 pinned `2` here, which was the finding plus the summary.
    expect(observed[0]?.payload).toMatchObject({
      threads_posted: 1,
      threads_resolved: 1,
      threads_unresolved: 0,
      threads_accepted: 0,
      threads_dismissed: 1,
    });
  }, 180_000);
});
