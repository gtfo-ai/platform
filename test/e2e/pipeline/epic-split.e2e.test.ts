/**
 * **WP-40's headline criterion, through a real `apps/server`: an epic walks the spike template's
 * epic-split variant, a human accepts some of the proposed children over HTTP, and exactly those
 * children become tickets in the provider's own board — none before the decision, none twice.**
 *
 * Everything from the event in is production code: the intake duty that routes the epic (asking the
 * binding whether it can create tickets at all), the two agent stages, the `pipeline.epic.split.queue`
 * handler that writes `ticket_breakdown_items`, the real `POST /api/tasks/:id/breakdown/decide` with
 * its `Idempotency-Key`, the `task.breakdown.decided` handler that steps the task out of the human
 * stage, and the `breakdown_create` duty that files each accepted child through
 * `IntegrationActionExecutor`.
 *
 * **The fake runner picks its scenario from the prompt** (standing rule 82), and for this row it is
 * not a nicety: the breakdown is *about* the epic, so a stage-keyed table would answer happily for a
 * prompt that never mentioned it. `scenarioFromPrompt` reads the `ticket` data block, refuses a run
 * whose prompt does not carry the epic's own words, and quotes them back into the children — so a
 * build that lost the ticket snapshot finds no scenario and the run fails by name.
 *
 * Every wait is on the last row the platform writes and the rest is asserted as what that row
 * implies (standing rule 87): the queue rows before the decision, the `ticket_key` on the row after
 * it — which the duty stamps **after** the provider has answered, so the tickets on the board and
 * the `integration_actions` rows are both implied by it.
 */
import type { RunSpec } from '@platform/application';
import { readDataBlocks } from '@platform/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';

const EPIC_KEY = 'ACME-5';
const EPIC_TITLE = 'Approve plans from Slack';
/** A sentence only the epic's own description carries; the scenario keys on it (rule 82). */
const EPIC_MARKER = 'maintainers approve from Slack instead of the web app';

/**
 * An obviously fake credential (BD-002) shaped like one gitleaks rule the **production** redactor
 * actually ships — `gl(pat|dt|…)-…`, `packages/infrastructure/src/redaction/pattern-redaction.ts` —
 * planted in what the model writes and in what the human types (WP-40 round 2).
 *
 * This tier is where the redaction is the product's rather than a harness's: the queue handler and
 * the decision command are given `redactionAdapters.patternRedactor()` by `apps/server`'s own
 * composition, so a credential surviving into `ticket_breakdown_items` or into the DTO fails here
 * and nowhere else. The placeholder is a digest rather than a name, so it is matched by shape and
 * this file is not a second copy of `redactionPlaceholder`.
 */
const PLANTED = 'glpat-FAKENOTAREALTOKEN0000000';
const PLACEHOLDER = /\[REDACTED sha256:[0-9a-f]{6}]/;

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const epicMatched = (pipeline: PipelineE2E) =>
  inboundEvent('ticket.matched', {
    project_id: pipeline.projectId,
    ticket: {
      provider: 'fake-task-management',
      key: EPIC_KEY,
      url: `https://tickets.example.test/browse/${EPIC_KEY}`,
    },
    rule: 'label:agentic',
    priority: 'High',
    issue_type: 'Epic',
    epic: null,
    links: [],
  });

const criterion = (id: string, what: string) => ({
  id,
  given: 'a maintainer with Slack connected',
  when: what,
  // biome-ignore lint/suspicious/noThenProperty: the published acceptance-criterion field name
  then: 'the decision is recorded and audited',
  validation: { kind: 'test' as const, value: `${id}.test.ts` },
});

/**
 * The two stages' outputs, **built from the run's own prompt**.
 *
 * `undefined` falls through to the stage map — which this file deliberately leaves empty, so a run
 * whose prompt carries no epic has no scenario at all and fails by name rather than passing on a
 * fixture nobody inspected.
 */
const scenarioFromPrompt = (spec: RunSpec) => {
  const block = readDataBlocks(spec.userPrompt).blocks.find((entry) => entry.kind === 'ticket');
  if (block === undefined || !block.body.includes(EPIC_MARKER)) {
    return undefined;
  }
  if (spec.stage === 'refinement') {
    return {
      structuredOutput: {
        goal: `Let ${EPIC_MARKER}.`,
        user_value: 'Fewer context switches for the people who approve',
        in_scope: ['the Slack message, its buttons and the callback'],
        out_of_scope: ['email approvals'],
        acceptance_criteria: [criterion('AC-0', 'a plan is posted')],
        non_functional: [],
        dependencies: [],
        size: 'L',
        drift: { flag: false, justification: 'in the documented direction' },
        assumptions: [],
        questions: [],
        decision: 'proceed',
        kb_citations: [],
      },
    };
  }
  if (spec.stage === 'architecture') {
    return {
      structuredOutput: {
        epic_summary: `Splitting "${EPIC_TITLE}": ${EPIC_MARKER}.`,
        children: [
          {
            title: 'Render the approval message',
            description: `Build the Block Kit payload so ${EPIC_MARKER}. The run read ${PLANTED}.`,
            acceptance_criteria: [criterion('AC-1', 'a plan is posted')],
            size: 'S',
            rationale: 'The message can be reviewed before any button does anything.',
          },
          {
            title: 'Handle the button callback',
            description: 'Verify the signature and record the decision.',
            acceptance_criteria: [criterion('AC-2', 'a maintainer presses approve')],
            size: 'M',
            rationale: 'Separates the write from the render, so each can be reverted alone.',
          },
          {
            title: 'Audit the Slack decision',
            description: 'Write the `human_actions` row for a decision made outside the web app.',
            acceptance_criteria: [criterion('AC-3', 'a decision is recorded')],
            size: 'S',
            rationale: 'The audit is a separate promise from the mechanics.',
          },
        ],
        out_of_scope: ['email approvals'],
        open_questions: [],
      },
    };
  }
  return undefined;
};

const signIn = async (baseUrl: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

interface BreakdownRow extends Record<string, unknown> {
  id: string;
  position: number;
  title: string;
  description: string;
  status: string;
  ticket_key: string | null;
  reason: string | null;
  redaction_count: number;
}

const queueOf = async (pipeline: PipelineE2E) =>
  pipeline.query<BreakdownRow>(
    `select id, position, title, description, status, ticket_key, reason, redaction_count
       from ticket_breakdown_items order by position`,
  );

const start = async () => {
  const pipeline = await startPipeline({
    // Empty on purpose: every scenario this file uses is built from the prompt (rule 82).
    scenarios: () => ({}),
    scenarioFor: (spec) => scenarioFromPrompt(spec),
    label: 'epic-split',
    ciStatus: null,
    config: { features: { epic_split: { enabled: true } } },
    tickets: [
      {
        key: EPIC_KEY,
        title: EPIC_TITLE,
        issueType: 'Epic',
        description: `We want ${EPIC_MARKER}. Includes the message, the buttons and the audit.`,
      },
    ],
  });
  harness = pipeline;
  return pipeline;
};

describe('the epic-split variant, from a matched epic to real child tickets', () => {
  it('queues a breakdown, waits for a human, and files only what was accepted', async () => {
    const pipeline = await start();
    const client = await signIn(pipeline.instance.baseUrl);

    await pipeline.publish([epicMatched(pipeline)]);

    /**
     * **Wait 1 of 2**: the queue rows, which the `pipeline.epic.split.queue` handler writes in the
     * same dispatch that stored the artifact. Waiting on the *task* reaching the human stage would
     * be waiting on a nearer consequence — the saga's transition commits at priority 10 and the
     * queue at 20, in one transaction, so the rows are the later of the two writes either way
     * (standing rule 87: bind the last row, not an earlier one).
     */
    await pipeline.waitFor(
      'the breakdown to be queued',
      async () => (await queueOf(pipeline)).length === 3,
    );

    const task = await pipeline.task();
    expect(task.template).toBe('epic_split');
    expect(task.current_stage).toBe('human_review');
    expect(task.state).not.toBe('done');

    const queued = await queueOf(pipeline);
    expect(queued.map((row) => [row.position, row.title, row.status])).toEqual([
      [0, 'Render the approval message', 'queued'],
      [1, 'Handle the button callback', 'queued'],
      [2, 'Audit the Slack decision', 'queued'],
    ]);

    // **Stored redacted** (TD-012, BD-022): the credential the model repeated is not in the row
    // PostgreSQL holds, the placeholder is, and the row counts what was replaced — asserted from
    // both sides, because a writer that dropped the field would pass the first half alone.
    expect(queued[0]?.description).not.toContain(PLANTED);
    expect(queued[0]?.description).toMatch(PLACEHOLDER);
    /**
     * **The count moved to the artifact row at WP-52, and that is the change rather than a loss.**
     *
     * It was `1` here because this queue's writer was the *first* thing to redact that text:
     * `artifacts.data` held the `TicketBreakdown` unredacted (PROGRESS backlog 35). The artifact is
     * now redacted at **its own** write, so by the time the breakdown handler reads the row there is
     * nothing left to replace and its own count is legitimately `0`. The assertion therefore moved
     * rather than weakened — a count of `0` alone would be satisfied by a redactor that never ran
     * (standing rule 10), so the replacement is asserted where it happened.
     */
    expect(await pipeline.artifactRedactionCount('TicketBreakdown')).toBe(1);
    expect(queued[0]?.redaction_count).toBe(0);
    // …and a child that carried no credential is stored whole and counted as zero either way.
    expect(queued[1]?.redaction_count).toBe(0);

    // **Nothing has been created**, which is the criterion a change that filed on the run's own
    // verdict would fail outright: no ticket on the board and no call in the audit.
    expect(pipeline.tickets.peek('ACME-1001')).toBeUndefined();
    expect((await pipeline.auditRows()).filter((row) => row.action === 'create_ticket')).toEqual(
      [],
    );

    // ── the bytes the run was given (standing rule 82) ──────────────────────
    const architecture = pipeline.specs.find((spec) => spec.stage === 'architecture');
    expect(architecture, 'no architecture run was planned').toBeDefined();
    const blocks = readDataBlocks(architecture?.userPrompt ?? '').blocks;
    expect(
      blocks.some((block) => block.kind === 'ticket' && block.body.includes(EPIC_MARKER)),
    ).toBe(true);

    // ── the decision: two of three, over HTTP, through the real route ───────
    const decided = await client.json<{
      performed: boolean;
      accepted: number;
      remaining: number;
    }>(`/api/tasks/${task.id}/breakdown/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'split-1' },
      body: JSON.stringify({
        decision: 'accept',
        item_ids: [queued[0]?.id, queued[1]?.id],
        reason: `these two first, per the ticket we opened with ${PLANTED}`,
      }),
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body).toMatchObject({ performed: true, accepted: 2, remaining: 1 });

    /**
     * **Wait 2 of 2**: the `ticket_key` on the row, which the `breakdown_create` duty stamps in a
     * transaction of its own **after** the provider has answered. It is the last thing the duty
     * writes, so it implies both earlier ones — the ticket on the fake provider's board and the
     * `integration_actions` row the executor records after the call returns.
     */
    await pipeline.waitFor(
      'the accepted children to be filed',
      async () => (await queueOf(pipeline)).filter((row) => row.ticket_key !== null).length === 2,
    );

    const filed = await queueOf(pipeline);
    expect(filed.map((row) => [row.status, row.ticket_key])).toEqual([
      ['accepted', 'ACME-1001'],
      ['accepted', 'ACME-1002'],
      // The third is untouched: Q85's *"a PM who wants five of seven"*.
      ['queued', null],
    ]);
    /**
     * The human's own words are stored too, and redacted where they are stored — with the count
     * **added** to what the row already carried rather than overwriting it.
     *
     * The *addition* is now asserted as a pair across this test rather than as a single `2`: the
     * queue row read **0** above (the model's text was already redacted at the artifact's own
     * write, WP-52) and reads **1** here, so the increment is the assertion. Before WP-52 it was
     * `1 → 2`; the property is the same and the arithmetic moved, because the first replacement
     * now happens one write earlier.
     */
    expect(filed[0]?.reason).not.toContain(PLANTED);
    expect(filed[0]?.reason).toMatch(PLACEHOLDER);
    expect(filed[0]?.redaction_count).toBe(1);
    expect(filed[1]?.redaction_count).toBe(1);

    // …and the tickets the row implies really exist on the board, under the epic.
    const child = pipeline.tickets.peek('ACME-1001');
    expect(child?.title).toBe('Render the approval message');
    expect(child?.description).toContain('**Acceptance criteria**');
    expect(child?.description).toContain(`splitting ${EPIC_KEY}`);
    expect(pipeline.tickets.peek('ACME-1002')?.title).toBe('Handle the button callback');
    expect(pipeline.tickets.peek('ACME-1003')).toBeUndefined();

    const created = (await pipeline.auditRows()).filter((row) => row.action === 'create_ticket');
    expect(created).toHaveLength(2);
    expect(created.every((row) => row.status === 'ok')).toBe(true);

    // ── the replay: the same key performs nothing twice ─────────────────────
    const replayed = await client.json<{ performed: boolean }>(
      `/api/tasks/${task.id}/breakdown/decide`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'split-1' },
        body: JSON.stringify({
          decision: 'accept',
          item_ids: [queued[0]?.id, queued[1]?.id],
          reason: `these two first, per the ticket we opened with ${PLANTED}`,
        }),
      },
    );
    expect(replayed.status).toBe(200);
    expect(replayed.body.performed).toBe(false);
    // The countable effect: two tickets, not four (standing rule 79).
    expect(
      (await pipeline.auditRows()).filter((row) => row.action === 'create_ticket'),
    ).toHaveLength(2);
    expect(pipeline.tickets.peek('ACME-1003')).toBeUndefined();

    // ── the last child, and the task ends ───────────────────────────────────
    const rejected = await client.json(`/api/tasks/${task.id}/breakdown/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'split-2' },
      body: JSON.stringify({
        decision: 'reject',
        item_ids: [queued[2]?.id],
        reason: 'covered by an existing ticket',
      }),
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);

    await pipeline.waitFor(
      'the task to finish',
      async () => (await pipeline.task()).state === 'done',
    );
    const ended = await queueOf(pipeline);
    // A rejection leaves the row with its reason and files nothing (product/10:52, Q85).
    expect(ended[2]).toMatchObject({
      status: 'rejected',
      ticket_key: null,
      reason: 'covered by an existing ticket',
    });
    expect(
      (await pipeline.auditRows()).filter((row) => row.action === 'create_ticket'),
    ).toHaveLength(2);

    // ── and the queue is readable through the route the SPA will call ───────
    const read = await client.json<{
      items: {
        status: string;
        ticket_key: string | null;
        description: string;
        reason: string | null;
      }[];
    }>(`/api/tasks/${task.id}/breakdown`);
    expect(read.status).toBe(200);
    expect(read.body.items.map((item) => [item.status, item.ticket_key])).toEqual([
      ['accepted', 'ACME-1001'],
      ['accepted', 'ACME-1002'],
      ['rejected', null],
    ]);
    // The other side of the row: what the endpoint publishes is the redacted copy, for the model's
    // words and for the human's alike. The DTO is what a screen renders, so this is the assertion
    // that says a reader never sees the credential.
    expect(JSON.stringify(read.body)).not.toContain(PLANTED);
    expect(read.body.items[0]?.description).toMatch(PLACEHOLDER);
    expect(read.body.items[0]?.reason).toMatch(PLACEHOLDER);
  });
});
