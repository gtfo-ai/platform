/**
 * **WP-25's headline criterion: a signed ticket-created delivery to a running `apps/server` drives a
 * lint task to completion and posts exactly one comment on the ticket.**
 *
 * Everything from the socket in is production code — the unauthenticated `/webhooks/:provider/:id`
 * route and its raw-body parser, the binding loader reading `integrations`/`bindings` and decrypting
 * `secrets`, the provider's own signature check, `inbox(provider, delivery_id)`, the event append,
 * the outbox worker, the `pipeline.ticket.lint` handler, the `ticket_lint_check` outbound job, the
 * stage executor, the **production** `ClaudeRunner` over a scripted CLI, and the `ticket_lint_post`
 * job that writes the comment through `IntegrationActionExecutor`.
 *
 * Two things this file is written to avoid.
 *
 *  - **The prompt assertion is on the bytes the CLI received** (standing rule 82). `FakeClaudeRunner`
 *    picks its scenario from `spec.stage` and never reads the prompt, so `agent: 'real-over-fake-cli'`
 *    is what makes "the ticket's own words reached the model" a claim that can fail.
 *  - **The redaction assertion is on a credential in the model's own answer**, on its way to a
 *    comment on somebody's ticket. The only thing between them is the task-management binding's
 *    redactor at `ticketWrites.lintComment`.
 *
 * What it does not prove: Jira's own webhook scheme and its comment API (the contract tier's replay
 * corpus does that), and anything about a real model.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { type PipelineE2E, startPipeline } from '../support/pipeline.js';

/**
 * A credential planted in the **model's own answer**, on its way to somebody's ticket.
 *
 * Obviously fake (BD-002) and shaped so TD-012 **step 2** — the gitleaks-derived pattern rules —
 * matches it, which is the half that reaches this sink: `ticketWrites.lintComment` redacts with the
 * **task-management binding's** redactor, which `bindings/loader.ts` composes as the binding's own
 * credentials plus `apps/server`'s `platformRedactor`. That composition is what this assertion
 * exists to prove, and it can only be proved through a composed instance.
 */
const PLANTED_IN_ANSWER = 'sk-ant-api03-FAKE000000000000000000000000000';

const LINTED_TICKET = 'ACME-2';
const LABELLED_TICKET = 'ACME-3';
const EPIC_TICKET = 'ACME-4';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** What the Product Manager returns for a ticket nobody has specified: no criteria, two questions. */
const LINT_SPEC = {
  goal: 'Make the invoice footer add up',
  user_value: 'Finance stops re-checking invoices by hand',
  in_scope: [],
  out_of_scope: [],
  acceptance_criteria: [],
  non_functional: [],
  dependencies: [],
  size: 'M',
  drift: { flag: false, justification: '' },
  assumptions: [],
  questions: [
    {
      id: 'q1',
      // A credential quoted into the answer — the ordinary way one reaches a comment on somebody
      // else's ticket.
      text: `Which rows count, and is ${PLANTED_IN_ANSWER} the staging token to use?`,
      blocking: true,
      options: null,
    },
    { id: 'q2', text: 'Does this apply to credit notes?', blocking: false, options: null },
  ],
  decision: 'ask',
  kb_citations: [],
};

/** The refinement a *labelled* ticket's delivery task gets, so the pipeline half has a scenario. */
const PIPELINE_SPEC = {
  ...LINT_SPEC,
  in_scope: ['the footer'],
  out_of_scope: ['the header'],
  questions: [],
  decision: 'proceed',
};

const LINT_CONFIG = {
  features: {
    ticket_linter: { enabled: true, issue_types: ['Story', 'Bug'], label: 'agentic' },
  },
};

const lintTaskOf = async (pipeline: PipelineE2E) => {
  const rows = await pipeline.query<{
    id: string;
    state: string;
    template: string;
    ticket_key: string;
    ticket_url: string;
    ticket_snapshot: { title: string; description: string } | null;
    workpad_ref: unknown;
  }>(
    `select id, state, template, ticket_key, ticket_url, ticket_snapshot, workpad_ref
       from tasks where template = 'ticket_lint' order by created_at limit 1`,
  );
  return rows[0] ?? null;
};

/** Every comment the fake provider holds for a ticket — the countable effect (standing rule 79). */
const commentsOn = (pipeline: PipelineE2E, key: string) =>
  pipeline.tickets.peek(key)?.comments ?? [];

describe('the ticket readiness linter, from a signed ticket-created delivery', () => {
  it('lints an unlabelled ticket of a configured type and posts one comment', async () => {
    const pipeline = await startPipeline({
      scenarios: () => ({ ticket_lint: { structuredOutput: LINT_SPEC } }),
      label: 'ticket-lint',
      config: LINT_CONFIG,
      agent: 'real-over-fake-cli',
      ciStatus: null,
      tickets: [
        {
          key: LINTED_TICKET,
          title: 'Invoice footer is wrong',
          description: 'The footer sums the visible rows rather than all of them.',
          issueType: 'Story',
        },
      ],
    });
    harness = pipeline;
    expect(await pipeline.taskCount()).toBe(0);

    const delivery = pipeline.tickets.emitTicketCreated({ ticketKey: LINTED_TICKET });
    const response = await pipeline.deliver(delivery);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ accepted: true });

    /**
     * **Wait 1 of 3, and it is sufficient for the three blocks under it** (the rule-49 sweep of
     * this file, recorded in `PROGRESS.md` under WP-25): every row they read is written *before*
     * the task row moves to `done`. The `runs` row and its `task_stages` row are the stage
     * executor's, written when the run starts and finished before the transition it decides; the
     * CLI capture is the runner's, from inside that run; and `ticket_snapshot` is written by the
     * `ticket_lint_check` duty's own `insert`, before the task existed at all. `workpad_ref` is the
     * one negative assertion here and it is bounded further down instead, by the audit rows the
     * lint event covers.
     */
    await pipeline.waitFor('the lint task to finish', async () => {
      const task = await lintTaskOf(pipeline);
      return task?.state === 'done';
    });

    // ── the task shape ──────────────────────────────────────────────────────
    const task = await lintTaskOf(pipeline);
    expect(task?.template).toBe('ticket_lint');
    // A platform-issued key, so the same ticket can still be delivered by the pipeline later.
    expect(task?.ticket_key).toBe(`lint!${LINTED_TICKET}`);
    expect(task?.ticket_snapshot?.title).toBe('Invoice footer is wrong');
    // The workpad never reached the ticket, so the row never learned where one lives.
    expect(task?.workpad_ref).toBeNull();

    // ── exactly one run, and it is the Product Manager's ────────────────────
    const runs = await pipeline.query<{ role: string; stage: string; mode: string }>(
      `select r.role, r.mode, s.stage
         from runs r join task_stages s on s.id = r.task_stage_id
        where r.task_id = $1`,
      [task?.id],
    );
    expect(runs).toHaveLength(1);
    // PROGRESS backlog 57: a lint run records itself as a lint, not as an ordinary run.
    expect(runs[0]).toMatchObject({
      role: 'product_manager',
      stage: 'ticket_lint',
      mode: 'linter',
    });

    // ── the bytes the CLI received (standing rule 82) ───────────────────────
    const run = pipeline.agentRuns.find((entry) => entry.stage === 'ticket_lint');
    expect(run, 'no ticket_lint run reached the scripted CLI').toBeDefined();
    const stdin = JSON.stringify(run?.cli.stdin);
    expect(stdin).toContain('Invoice footer is wrong');
    expect(stdin).toContain('sums the visible rows');
    // …inside a data block, not pasted into the instructions (BD-022).
    expect(stdin).toContain('untrusted-data-');
    // …and the stage's narrower instruction is in the platform's own voice (WP-25).
    expect(stdin).toContain('This run is a ticket readiness lint');

    /**
     * **Wait 2 of 3: on the row, not on the provider call** — standing rule 50, and the ordering
     * `93ffb32` fixed in the librarian and workpad cases the day before this file was written.
     *
     * `runTicketLintPost` posts the comment and appends `task.lint.posted` **afterwards, in a
     * transaction of its own**. So the comment arriving in the fake provider is the *middle* of the
     * duty, and a test that waited for it and then read the events table on the next line was
     * structurally short by one transaction. It passed here and failed on the orchestrator's first
     * run of this file with `expected [] to have a length of 1 but got +0` — the rate was the only
     * random thing about it (rule 76): the ordering is fixed and the gap is one commit wide.
     *
     * The event is the **last** thing the duty writes and it implies every earlier one — the
     * comment on the ticket, and the `integration_actions` row the executor records *after* the
     * provider answers and *before* it returns (`action-executor.ts` step 5, "remember it, then
     * record it"). One wait therefore bounds all three blocks below, and none of them may wait for
     * a nearer consequence.
     */
    await pipeline.waitFor('the lint to be recorded', async () =>
      (await pipeline.events()).some((entry) => entry.type === 'task.lint.posted'),
    );

    // ── the metric's baseline ───────────────────────────────────────────────
    const lints = (await pipeline.events()).filter((entry) => entry.type === 'task.lint.posted');
    expect(lints).toHaveLength(1);
    const lint = lints[0]?.payload as { readonly score: number; readonly questions_posted: number };
    expect(lints[0]?.payload).toMatchObject({
      score: 15,
      questions_posted: 2,
      ticket: { key: LINTED_TICKET },
    });

    // ── the comment the event implies ───────────────────────────────────────
    const comments = commentsOn(pipeline, LINTED_TICKET);
    expect(comments).toHaveLength(1);
    const body = comments[0]?.body ?? '';
    // product/19 § 17: the marker, the score, the gaps, the questions, the offer — in ten lines.
    expect(body.split('\n').length).toBeLessThanOrEqual(10);
    expect(body).toContain('<!-- agentic:linter -->');
    expect(body).toContain('missing: acceptance criteria, scope boundaries');
    expect(body).toContain('- Which rows count');
    expect(body).toContain('Add the label `agentic`');
    // The marker the platform recognises its own comment by.
    expect(comments[0]?.marker_id).toBe('agentic:linter');
    // Tied to the row rather than asserted beside it: the score the metric recorded is the score
    // the ticket was shown, and the questions it counted are the questions on the comment. This is
    // the assertion the old ordering could not make — it read the event before a writer had
    // appended one.
    expect(body).toContain(`**Agent readiness: ${lint.score}/100**`);
    expect(body.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(
      lint.questions_posted,
    );

    // ── TD-012, both directions (standing rule 42) ──────────────────────────
    expect(body).not.toContain(PLANTED_IN_ANSWER);
    expect(body).toContain('[REDACTED sha256:');
    expect(body).toContain('Which rows count');

    // ── product/18 level 0: nothing else was written anywhere ───────────────
    //
    // Asserted on the audit log rather than on a counter of this test's own: every mutating
    // provider call the pipeline makes leaves an `integration_actions` row (BD-003). Bounded by
    // the same wait as the comment, and it needs one: the executor writes this row *after* the
    // provider answered, so the old ordering asserted it ahead of its writer too — the sweep found
    // one wait short for two assertions, not one.
    const actions = await pipeline.auditRows();
    const mutations = actions.map((row) => row.action);
    expect(mutations).not.toContain('open_merge_request');
    // The two writes a lint task must not make — refused by `ticketWrites`, so no call and no row.
    expect(mutations).not.toContain('upsert_workpad');
    expect(mutations).not.toContain('transition_ticket');
    expect(actions.filter((row) => row.action === 'add_comment')).toHaveLength(1);

    // ── a redelivery performs nothing twice ─────────────────────────────────
    const again = await pipeline.deliver(delivery);
    expect(again.status).toBe(202);
    // The same delivery id, answered off the `inbox` row rather than normalised a second time.
    expect(again.body).toEqual(response.body);
    // And a *different* delivery for the same ticket, which the inbox cannot deduplicate: the lint
    // task's key is what stops it (`ticket-lint.ts` § "What one comment rests on").
    await pipeline.deliver(
      pipeline.tickets.emitTicketCreated({ ticketKey: LINTED_TICKET, deliveryId: 'second' }),
    );
    /**
     * **Wait 3 of 3: the dispatch queue is the right wait here, and only because of where this
     * case's decision is made.** `pipeline.ticket.lint` answers a second `ticket.created` *inside
     * its own handler transaction* — it finds the task under `lint!ACME-2` and returns, enqueuing
     * no `pipeline.outbound` duty — and the dispatch row is deleted by that same transaction. So an
     * empty `event_dispatch` means the decision is committed and nothing is left to run, which is
     * exactly what the two assertions below read.
     *
     * It is one handler: `ticket.created` has a single consumer in this build
     * (`events/consumption.ts`). Had the handler enqueued a duty, this wait would be short by one
     * job — which is the case the Epic in the next test has, and which it waits for differently.
     */
    await pipeline.waitFor('the second delivery to be dispatched', async () => {
      const rows = await pipeline.query<{ pending: number }>(
        'select count(*)::int as pending from event_dispatch',
      );
      return (rows[0]?.pending ?? 0) === 0;
    });
    expect(await pipeline.taskCount()).toBe(1);
    expect(commentsOn(pipeline, LINTED_TICKET)).toHaveLength(1);
  }, 180_000);

  it('lints neither a ticket labelled for the agent nor a type the project did not configure', async () => {
    const pipeline = await startPipeline({
      scenarios: () => ({
        ticket_lint: { structuredOutput: LINT_SPEC },
        refinement: { structuredOutput: PIPELINE_SPEC },
      }),
      label: 'ticket-lint-miss',
      config: LINT_CONFIG,
      // The project's own CI never reports, so the delivery task parks at its gate rather than
      // running stages this test does not script.
      ciStatus: null,
      tickets: [
        {
          key: LABELLED_TICKET,
          title: 'Already handed to the agent',
          issueType: 'Story',
          labels: ['agentic'],
        },
        { key: EPIC_TICKET, title: 'A quarter of work', issueType: 'Epic' },
      ],
    });
    harness = pipeline;

    /**
     * **(a) labelled for the agent: the pipeline takes it, the linter does not — and the two
     * deliveries are ordered so that the linter's refusal is the one being watched.**
     *
     * Every assertion in this case is a negative one, and a negative assertion passes silently on a
     * duty that has not started (standing rule 4). The refusal that matters here is the *duty's*
     * label filter, which runs in a `pipeline.outbound` job enqueued **after** the handler's
     * commit — so a drained `event_dispatch` says the handler ran, not that the filter did.
     *
     * The duty's `read_ticket` is the marker, because the executor records a row for a read exactly
     * as it does for a write, and the filter is applied on the next line with nothing written in
     * between. For that row to be unambiguously the **linter's**, the linter must be the only
     * reader of this ticket when it is awaited: `ticket.matched` is therefore delivered *after* the
     * wait, so intake's own `readTicket` (WP-15f) cannot have produced it — and so the lint check
     * runs at all, which a `matched` delivered first would have made a race. Since round 2 that
     * ordering is load-bearing on both sides: a delivery task that already exists makes the handler
     * return early **and** the duty refuse at its first ask, before the read this waits for
     * (`lintRefusal`). What this case asserts is the *label* filter, so the delivery is kept out of
     * its way deliberately.
     *
     * Residual, stated rather than implied: a *broken* filter would insert its lint task one
     * transaction after this row, so the wait bounds the refusal and is one transaction short of
     * bounding a mutant of it. The mutant that matters is killed in the ring that owns the filter
     * (`packages/domain/src/policies/ticket-lint.ts` and its unit cases).
     */
    await pipeline.deliver(pipeline.tickets.emitTicketCreated({ ticketKey: LABELLED_TICKET }));
    await pipeline.waitFor('the linter to have read the labelled ticket', async () =>
      (await pipeline.auditRows()).some(
        (row) => row.action === 'read_ticket' && row.payload.ticket_key === LABELLED_TICKET,
      ),
    );
    await pipeline.deliver(
      pipeline.tickets.emitTicketMatched({ ticketKey: LABELLED_TICKET, rule: 'label = "agentic"' }),
    );
    await pipeline.waitFor('the delivery task to be created', async () => {
      const rows = await pipeline.query<{ count: number }>(
        `select count(*)::int as count from tasks where ticket_key = $1`,
        [LABELLED_TICKET],
      );
      return (rows[0]?.count ?? 0) === 1;
    });

    // (b) a type nobody configured: nothing at all. Same shape as (a) — the issue type is read off
    // the ticket by the duty, not off the delivery, so the wait is on the duty's own read. Nothing
    // else in this test ever reads the Epic: no task was created on it, so there is no intake read
    // to confuse this row with.
    await pipeline.deliver(pipeline.tickets.emitTicketCreated({ ticketKey: EPIC_TICKET }));
    await pipeline.waitFor('the linter to have read the Epic', async () =>
      (await pipeline.auditRows()).some(
        (row) => row.action === 'read_ticket' && row.payload.ticket_key === EPIC_TICKET,
      ),
    );
    await pipeline.waitFor('every delivery to be dispatched', async () => {
      const rows = await pipeline.query<{ pending: number }>(
        'select count(*)::int as pending from event_dispatch',
      );
      return (rows[0]?.pending ?? 0) === 0;
    });

    // Three deliveries, all accepted and recorded; one task, and it is the pipeline's.
    expect((await pipeline.inbox()).length).toBe(3);
    expect(await lintTaskOf(pipeline)).toBeNull();
    const templates = await pipeline.query<{ template: string; ticket_key: string }>(
      'select template, ticket_key from tasks order by created_at',
    );
    expect(templates).toEqual([{ template: 'feature', ticket_key: LABELLED_TICKET }]);
    expect(
      commentsOn(pipeline, LABELLED_TICKET).filter((comment) =>
        comment.body.includes('agentic:linter'),
      ),
    ).toHaveLength(0);
    expect(commentsOn(pipeline, EPIC_TICKET)).toHaveLength(0);
  }, 180_000);
});
