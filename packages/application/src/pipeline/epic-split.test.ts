/**
 * The spike's ending and the epic-split variant, driven through the real handlers, the real
 * interpreter, the real stage executor and the real `IntegrationActionExecutor` over the in-memory
 * doubles (WP-40).
 *
 * The e2e tier runs the same thing on PostgreSQL through a real `apps/server` with a fake runner
 * that picks its scenario from the **prompt**; this tier is where the branches live — a project
 * with the variant off, a binding that cannot create tickets, a shadow task, a partial decision, a
 * replay, and the two refusals a decision can meet.
 *
 * Nothing here asserts through the runner: it is scripted per stage and never reads the prompt
 * (standing rule 82), which is why the e2e exists.
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { EPIC_SPLIT_TEMPLATE_ID, SPIKE_HUMAN_STAGE, SPIKE_TEMPLATE_ID } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type {
  CommentRef,
  TicketDraft,
  TicketRefInput,
} from '../ports/integrations/task-management.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import {
  BreakdownRefusedError,
  childTicketIdempotencyKey,
  decideBreakdown,
  projectKeyOf,
  renderResearchReport,
  researchPagePath,
  SPIKE_DOCUMENT_STAGE,
  spikeReportIdempotencyKey,
  spikeReportMarkerFor,
} from './epic-split.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const EPIC_KEY = 'ACME-7';
const TICKET_URL = 'https://tickets.example.test/browse/ACME-7';
const USER = '00000000-0000-4000-8000-0000000000c1' as Id;

/**
 * **Two** obviously fake credentials (BD-002), because there are two redactors and neither
 * subsumes the other (WP-40 round 2).
 *
 * `PLANTED` is the **binding's** own token: only the task-management adapter's exact-match redactor
 * knows it (TD-012 step 1), so it survives into the queue row — the queue is written inside the
 * dispatcher's transaction, where no binding can be resolved — and is removed at the write into the
 * tracker. `PLATFORM_PLANTED` stands for what the **platform's** redactor knows (step 2, the
 * pattern rules in production), so it is gone from the row itself.
 *
 * Planting one of each is what keeps both layers measurable: a single credential known to both
 * would make the queue's redaction hide the adapter's, and the outer guard of a layered pair that
 * is complete is a guard nothing can fail (standing rule 22).
 */
const PLANTED = 'FAKE-jira-token-not-a-real-secret-0000';
const PLACEHOLDER = '[REDACTED:integration:jira_token]';
const PLATFORM_PLANTED = 'FAKE-platform-secret-not-a-real-one-00';
const PLATFORM_PLACEHOLDER = '[REDACTED:integration:platform_token]';

const REFINED = {
  goal: 'Approve plans from Slack',
  user_value: 'Maintainers stop opening the web app to approve',
  in_scope: ['the Slack message and its buttons'],
  out_of_scope: ['email approvals'],
  acceptance_criteria: [],
  non_functional: [],
  dependencies: [],
  size: 'L',
  drift: { flag: false, justification: '' },
  assumptions: [],
  questions: [],
  decision: 'proceed',
  kb_citations: [],
};

const criterion = (id: string) => ({
  id,
  given: `a maintainer with Slack connected and ${PLATFORM_PLANTED} in the env`,
  when: 'the plan is posted',
  // biome-ignore lint/suspicious/noThenProperty: the published acceptance-criterion field name
  then: 'the buttons appear in the thread',
  validation: {
    kind: 'test' as const,
    value: `slack-approval.test.ts --token=${PLATFORM_PLANTED}`,
  },
});

const BREAKDOWN = (children = 2) => ({
  epic_summary: 'Slack approvals, split into pieces that each ship on their own.',
  children: Array.from({ length: children }, (_, index) => ({
    title: `Child ${index + 1}`,
    description: `What child ${index + 1} covers. The run was given ${PLANTED} and ${PLATFORM_PLANTED}, and repeated both.`,
    acceptance_criteria: [criterion(`AC-${index + 1}`)],
    size: 'S' as const,
    rationale: `It can be reverted on its own — unlike ${PLATFORM_PLANTED}.`,
  })),
  out_of_scope: ['email approvals'],
  open_questions: [],
});

const REPORT = {
  question: 'Can the refund ledger reuse the outbox?',
  summary: `The outbox already carries an ordering key. Read with ${PLANTED}.`,
  findings: [
    {
      statement: 'The outbox writer takes the same advisory lock.',
      evidence: ['src/outbox/writer.ts:88'],
      confidence: 'high' as const,
    },
  ],
  options: [
    {
      option: 'Reuse the outbox',
      pros: ['no second queue'],
      cons: ['coupled releases'],
      effort: 'M' as const,
    },
  ],
  recommendation: 'Reuse the outbox.',
  open_questions: [
    { id: 'q1', text: 'What retention does finance need?', blocking: false, options: null },
  ],
  kb_citations: [],
};

interface Posted {
  readonly key: string;
  readonly markdown: string;
  readonly markerId: string | null;
}

interface Created {
  readonly draft: TicketDraft;
}

const splitHarness = (
  options: {
    readonly template?: 'spike' | 'epic_split' | 'off';
    readonly children?: number;
    readonly createTicket?: boolean;
    /**
     * A binding whose `createTicket` capability is **true while intake routes and false when the
     * duty calls** — a token downgraded between the two, which is the only way this build reaches
     * the write-level refusal (`epicSplitRouting` refuses the variant outright otherwise).
     */
    readonly revokeCreateAfter?: number;
    readonly noTaskManagement?: boolean;
  } = {},
): {
  harness: PipelineHarness;
  posted: Posted[];
  createdTickets: Created[];
} => {
  const posted: Posted[] = [];
  const createdTickets: Created[] = [];
  let capabilityReads = 0;
  const which = options.template ?? 'epic_split';
  const harness = createPipelineHarness({
    projectId: PROJECT,
    runs: {
      refinement: {
        status: 'completed',
        terminalReason: 'success',
        structuredOutput: REFINED,
      },
      [SPIKE_DOCUMENT_STAGE]: {
        status: 'completed',
        terminalReason: 'success',
        structuredOutput: which === 'spike' ? REPORT : BREAKDOWN(options.children ?? 2),
      },
    },
    settings: {
      config: {
        features: {
          epic_split: {
            enabled: which === 'epic_split',
            ...(which === 'spike' ? { issue_types: ['Nothing'] } : {}),
          },
          // The plain spike template's own opt-in (WP-40 round 2). Off is the shipped default and
          // the `epic_split` cases run with it off, which is what proves the two switches are
          // independent: the variant routes to `epic_split` without this one.
          spike: { enabled: which === 'spike' },
        },
      },
      ...(which === 'spike' ? { templateByIssueType: { epic: SPIKE_TEMPLATE_ID } } : {}),
    },
    // The binding's own redactor, armed: a disarmed one proves nothing (standing rules 31, 35).
    ticketRedactor: exactSecretRedactor([{ name: 'jira_token', value: PLANTED }]),
    // The **platform's** redactor, which the runtime hands the queue handler and the decision
    // command. Production composes `patternRedactor()` there; this is the same wiring with a value
    // a test can plant (`pipeline-harness.ts`).
    commandSecrets: [{ name: 'platform_token', value: PLATFORM_PLANTED }],
    taskManagement:
      options.noTaskManagement === true
        ? null
        : {
            capabilities: () => {
              capabilityReads += 1;
              const revoked =
                options.revokeCreateAfter !== undefined &&
                capabilityReads > options.revokeCreateAfter;
              return { createTicket: revoked ? false : (options.createTicket ?? true) } as never;
            },
            addComment: async (
              ref: TicketRefInput,
              markdown: string,
              commentOptions?: { readonly markerId?: string | null },
            ): Promise<CommentRef> => {
              posted.push({ key: ref.key, markdown, markerId: commentOptions?.markerId ?? null });
              return {
                provider: ref.provider,
                ticket_key: ref.key,
                comment_id: `comment-${posted.length}`,
                url: null,
                marker_id: commentOptions?.markerId ?? null,
              };
            },
            createTicket: async (draft: TicketDraft): Promise<TicketRefInput> => {
              createdTickets.push({ draft });
              const key = `${draft.project_key}-${1000 + createdTickets.length}`;
              return {
                provider: 'fake-jira',
                key,
                url: `https://tickets.example.test/browse/${key}`,
              };
            },
          },
  });
  return { harness, posted, createdTickets };
};

let stream = 0;

const matched = (issueType: string) => {
  stream += 1;
  const suffix = stream.toString(16).padStart(12, '0');
  return domainEventSchemasByType['ticket.matched'].parse({
    id: `00000000-0000-4000-9000-${suffix}`,
    stream_type: 'project',
    stream_id: `00000000-0000-4000-8000-${suffix}`,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ticket.matched',
    payload: {
      project_id: PROJECT,
      ticket: { provider: 'fake-jira', key: EPIC_KEY, url: TICKET_URL },
      rule: 'label:agentic',
      priority: 'High',
      issue_type: issueType,
      epic: null,
      links: [],
    },
  }) as DomainEvent;
};

const theTask = (harness: PipelineHarness) => {
  const [task] = harness.store.snapshot();
  if (task === undefined) {
    throw new Error('no task was created');
  }
  return task;
};

const items = async (harness: PipelineHarness) =>
  harness.store.breakdown.listForTask(null as never, theTask(harness).task.id);

describe('the spike template, end to end through the handlers', () => {
  it('attaches the report to the ticket and rests at the human stage', async () => {
    const { harness, posted } = splitHarness({ template: 'spike' });
    await harness.publish([matched('Epic')]);

    const task = theTask(harness);
    expect(task.task.template).toBe(SPIKE_TEMPLATE_ID);
    // product/04:117's last arrow: the task **waits** at the human stage rather than finishing.
    expect(task.task.currentStage).toBe(SPIKE_HUMAN_STAGE);
    expect(task.task.state).not.toBe('done');

    expect(posted).toHaveLength(1);
    expect(posted[0]?.key).toBe(EPIC_KEY);
    expect(posted[0]?.markerId).toBe(spikeReportMarkerFor(task.task.id, 1));
    expect(posted[0]?.markdown).toContain('## Recommendation');
    expect(posted[0]?.markdown).toContain('Reuse the outbox.');
    // TD-012 at the call: the credential the model repeated does not reach the provider.
    expect(posted[0]?.markdown).not.toContain(PLANTED);
    expect(posted[0]?.markdown).toContain(PLACEHOLDER);

    // …and the comment was made through the executor, with the attempt's own key.
    const audit = harness.audit.entriesFor('add_comment');
    expect(audit).toHaveLength(1);
    expect(harness.idempotency.keys().join('\n')).toContain(
      encodeURIComponent(spikeReportIdempotencyKey(task.task.id, 1)),
    );
  });

  it('makes no comment and no call when the project has no task-management binding', async () => {
    const { harness, posted } = splitHarness({ template: 'spike', noTaskManagement: true });
    await harness.publish([matched('Epic')]);
    expect(theTask(harness).task.currentStage).toBe(SPIKE_HUMAN_STAGE);
    expect(posted).toHaveLength(0);
    expect(harness.audit.entriesFor('add_comment')).toEqual([]);
  });

  it('renders the report as one document, used for the ticket and for the page alike', () => {
    const markdown = renderResearchReport({ report: REPORT as never, ticketKey: EPIC_KEY });
    expect(markdown).toContain(`# Spike: ${EPIC_KEY}`);
    expect(markdown).toContain('**Question**: Can the refund ledger reuse the outbox?');
    expect(markdown).toContain('## What was established');
    expect(markdown).toContain('  - evidence: src/outbox/writer.ts:88');
    expect(markdown).toContain('### Reuse the outbox (effort: M)');
    expect(markdown).toContain('## Still open');
    expect(markdown).toContain('No merge request was opened');
  });

  it('leaves out the sections a report has nothing for, rather than printing empty headings', () => {
    // Every list in the artifact may legitimately be empty — a spike that weighed no alternatives
    // still owes a recommendation — and an empty heading reads to a human like a bug.
    const markdown = renderResearchReport({
      report: {
        ...REPORT,
        findings: [],
        options: [],
        open_questions: [],
      } as never,
      ticketKey: EPIC_KEY,
    });
    expect(markdown).not.toContain('## What was established');
    expect(markdown).not.toContain('## Options weighed');
    expect(markdown).not.toContain('## Still open');
    // …and the two things a report always owes are still there.
    expect(markdown).toContain('**Question**:');
    expect(markdown).toContain('## Recommendation');
  });

  it('prints an option that has only reasons against it', () => {
    const markdown = renderResearchReport({
      report: {
        ...REPORT,
        options: [
          {
            option: 'A second queue',
            pros: [],
            cons: ['one more thing to page about'],
            effort: 'L',
          },
        ],
      } as never,
      ticketKey: EPIC_KEY,
    });
    expect(markdown).toContain('### A second queue (effort: L)');
    expect(markdown).not.toContain('For:');
    expect(markdown).toContain('Against:');
  });

  it('files the page under research/, on a path the model never chose', () => {
    expect(researchPagePath({ key: 'ACME-7' })).toBe('research/ACME-7.md');
    // A key a provider could not have issued still cannot escape the directory.
    expect(researchPagePath({ key: '../../.github/workflows/ci.yml' })).toBe(
      'research/..-..-.github-workflows-ci.yml.md',
    );
    expect(researchPagePath({ key: '///' })).toBe('research/spike.md');
  });
});

describe('the epic-split variant', () => {
  it('queues one row per proposed child and creates nothing', async () => {
    const { harness, createdTickets } = splitHarness({ children: 3 });
    await harness.publish([matched('Epic')]);

    const task = theTask(harness);
    expect(task.task.template).toBe(EPIC_SPLIT_TEMPLATE_ID);
    expect(task.task.currentStage).toBe(SPIKE_HUMAN_STAGE);

    const queued = await items(harness);
    expect(queued.map((item) => [item.position, item.title, item.status])).toEqual([
      [0, 'Child 1', 'queued'],
      [1, 'Child 2', 'queued'],
      [2, 'Child 3', 'queued'],
    ]);
    expect(queued[0]?.acceptanceCriteria).toHaveLength(1);
    // **Nothing is created until a human accepts** — the criterion a change that filed on the run's
    // own verdict would fail outright.
    expect(createdTickets).toHaveLength(0);
    expect(harness.audit.entriesFor('create_ticket')).toEqual([]);
  });

  /**
   * **The queue is stored external text, and it is stored redacted** (WP-40 round 2, TD-012).
   *
   * Every model-authored field is asserted from both sides (standing rule 42): the credential is
   * gone *and* the placeholder is there, because a field the writer dropped altogether would pass
   * the first half alone. `redactionCount` is pinned exactly rather than `> 0` — an under-reporting
   * count is the one signal a redactor that stopped working leaves (migration 0024's note), so a
   * redactor applied to four fields of five has to fail here.
   *
   * The **residual is measured rather than claimed**: the binding's own credential is still in the
   * row, because this writer runs inside the dispatcher's transaction and has no binding to get a
   * step-1 redactor from. That is what `files one ticket per accepted child, under the parent, and
   * none twice` then catches at the write into the tracker, and asserting it here is what keeps the
   * two layers from being confused for one.
   */
  it('redacts every model-written field of a queued child, and counts it', async () => {
    const { harness } = splitHarness({ children: 1 });
    await harness.publish([matched('Epic')]);

    const [child] = await items(harness);
    expect(child, 'the epic was not routed to the variant').toBeDefined();
    const criteria = child?.acceptanceCriteria[0];

    for (const field of [
      child?.description,
      child?.rationale,
      criteria?.given,
      criteria?.validation.value,
    ]) {
      expect(field).not.toContain(PLATFORM_PLANTED);
      expect(field).toContain(PLATFORM_PLACEHOLDER);
    }
    // A field with nothing to redact is passed through whole rather than emptied.
    expect(child?.title).toBe('Child 1');
    expect(criteria?.when).toBe('the plan is posted');
    // One occurrence in the description, one in the rationale, one in `given`, one in the
    // validation command: four, and every one of them a different field.
    expect(child?.redactionCount).toBe(4);

    // The stated residual, measured: the *binding's* token is not the platform redactor's to know.
    expect(child?.description).toContain(PLANTED);
  });

  it('does not route an epic to the variant when the project has it off', async () => {
    const { harness } = splitHarness({ template: 'off' });
    await harness.publish([matched('Epic')]);
    // product/18:45's default, from the other side (standing rule 42).
    expect(theTask(harness).task.template).toBe('feature');
    expect(await items(harness)).toEqual([]);
  });

  it('does not route one when the binding cannot create tickets', async () => {
    const { harness } = splitHarness({ createTicket: false });
    await harness.publish([matched('Epic')]);
    // Criterion 6: a breakdown nobody can accept is worse than a feature ticket.
    expect(theTask(harness).task.template).toBe('feature');
  });

  it('writes the queue exactly once when the dispatch is redelivered', async () => {
    const { harness } = splitHarness({ children: 2 });
    await harness.publish([matched('Epic')]);
    const before = await items(harness);
    // `handler_executions` claims `(position, handler)`, so a second dispatch of the same event
    // writes nothing: the guard is the dispatcher's rather than a key of this feature's.
    await harness.drain();
    expect((await items(harness)).map((item) => item.id)).toEqual(before.map((item) => item.id));
  });
});

describe('the decision', () => {
  const deps = (harness: PipelineHarness) => ({
    store: harness.store,
    unitOfWork: harness.memory,
    ids: harness.ids,
    clock: harness.clock,
    // The composition root's redactor, armed from `commandSecrets` — the same object the harness
    // gives every other command (standing rule 31).
    redactor: harness.commands.redactor,
  });

  it('accepts a subset, leaves the rest queued and keeps the task waiting', async () => {
    const { harness } = splitHarness({ children: 3 });
    await harness.publish([matched('Epic')]);
    const queued = await items(harness);
    const task = theTask(harness);

    const result = await decideBreakdown(deps(harness), {
      taskId: task.task.id,
      itemIds: [queued[0]?.id as Id, queued[1]?.id as Id],
      decision: 'accept',
      userId: USER,
      reason: 'these two are the ones we need first',
    });
    expect(result).toEqual({ accepted: 2, rejected: 0, remaining: 1 });
    await harness.drain();

    // Q85's *"five of seven"*: the third child is untouched and the task has not finished.
    const after = await items(harness);
    expect(after.map((item) => item.status)).toEqual(['accepted', 'accepted', 'queued']);
    expect(after[0]?.decidedByUserId).toBe(USER);
    expect(after[0]?.reason).toBe('these two are the ones we need first');
    // **Which branch ran** (standing rule 10): the task is still *waiting*, not finished and not
    // escalated. Asserting the stage alone is satisfied by both of the wrong answers — a task the
    // interpreter moved illegally escalates and keeps `current_stage` — so the state and the two
    // events it would have produced are named too.
    expect({
      stage: theTask(harness).task.currentStage,
      state: theTask(harness).task.state,
    }).toEqual({ stage: SPIKE_HUMAN_STAGE, state: 'active' });
    expect(harness.types()).not.toContain('task.completed');
    expect(harness.types()).not.toContain('task.escalated');
  });

  /**
   * **The human's words are stored too, so they are redacted too** (WP-40 round 2, TD-012).
   *
   * `reason` is free text a maintainer typed, published by `GET /api/tasks/:id/breakdown` and kept
   * on a rejected row for as long as the task exists (product/10:52). The route bounds it and has
   * no redactor; this command is where it lands, so this is where TD-012 applies — the same answer
   * `answerTaskQuestion` and `returnTaskToStage` give their own free text.
   *
   * The count is asserted as a **delta** on the row rather than absolutely, because the model's
   * four are already on it: a decision that overwrote the queue's count instead of adding to it
   * would read as "nothing was redacted when this row was written".
   */
  it('redacts the reason a human gave, and adds it to what the row already counted', async () => {
    const { harness } = splitHarness({ children: 1 });
    await harness.publish([matched('Epic')]);
    const queued = await items(harness);
    const before = queued[0]?.redactionCount ?? 0;

    await decideBreakdown(deps(harness), {
      taskId: theTask(harness).task.id,
      itemIds: [queued[0]?.id as Id],
      decision: 'reject',
      userId: USER,
      reason: `covered by the ticket we opened with ${PLATFORM_PLANTED}`,
    });
    await harness.drain();

    const [decided] = await items(harness);
    expect(decided?.reason).not.toContain(PLATFORM_PLANTED);
    expect(decided?.reason).toBe(`covered by the ticket we opened with ${PLATFORM_PLACEHOLDER}`);
    expect(decided?.redactionCount).toBe(before + 1);
  });

  it('ends the task when the last child has been decided', async () => {
    const { harness } = splitHarness({ children: 2 });
    await harness.publish([matched('Epic')]);
    const queued = await items(harness);
    const task = theTask(harness);

    await decideBreakdown(deps(harness), {
      taskId: task.task.id,
      itemIds: queued.map((item) => item.id),
      decision: 'reject',
      userId: USER,
      reason: 'the epic is going to be rewritten',
    });
    await harness.drain();

    expect(theTask(harness).task.state).toBe('done');
    // A rejection leaves the rows with their reason (product/10:52, Q85's second confirmation).
    expect((await items(harness)).map((item) => [item.status, item.reason])).toEqual([
      ['rejected', 'the epic is going to be rewritten'],
      ['rejected', 'the epic is going to be rewritten'],
    ]);
    expect(harness.types().filter((type) => type === 'task.breakdown.decided')).toHaveLength(1);
  });

  it('files one ticket per accepted child, under the parent, and none twice', async () => {
    const { harness, createdTickets } = splitHarness({ children: 2 });
    await harness.publish([matched('Epic')]);
    const queued = await items(harness);
    const task = theTask(harness);

    await decideBreakdown(deps(harness), {
      taskId: task.task.id,
      itemIds: queued.map((item) => item.id),
      decision: 'accept',
      userId: USER,
      reason: null,
    });
    await harness.drain();

    expect(createdTickets).toHaveLength(2);
    expect(createdTickets[0]?.draft.parent_key).toBe(EPIC_KEY);
    expect(createdTickets[0]?.draft.project_key).toBe('ACME');
    expect(createdTickets[0]?.draft.issue_type).toBe('Task');
    expect(createdTickets[0]?.draft.title).toBe('Child 1');
    // Criterion 7: the credential the model wrote into a child's body never reaches the tracker.
    expect(createdTickets[0]?.draft.description).not.toContain(PLANTED);
    expect(createdTickets[0]?.draft.description).toContain(PLACEHOLDER);
    expect(createdTickets[0]?.draft.description).toContain('**Acceptance criteria**');

    // The ticket is on the row, which is what makes the duty's re-derivation idempotent…
    const filed = await items(harness);
    expect(filed.map((item) => item.ticketKey)).toEqual(['ACME-1001', 'ACME-1002']);
    expect(harness.idempotency.keys().join('\n')).toContain(
      encodeURIComponent(childTicketIdempotencyKey(queued[0]?.id as Id)),
    );

    // …and firing the duty again files nothing (standing rule 79's replay, on a countable effect).
    // Through the **composed** handler the runtime registered, not the function directly: a replay
    // that went round the composition would prove something about this test rather than the build.
    const outbound = harness.jobs.handlers.get(JOB_QUEUES.pipelineOutbound);
    expect(outbound).toBeDefined();
    await outbound?.({
      id: 'replayed',
      data: {
        duty: 'breakdown_create',
        project_id: PROJECT,
        task_id: task.task.id,
        cause_event_id: '00000000-0000-4000-9000-00000000ffff',
      },
    } as never);
    expect(createdTickets).toHaveLength(2);
  });

  /**
   * Criterion 6's write-level half, which the routing refusal cannot reach.
   *
   * `epicSplitRouting` keeps an epic off the variant when the binding reports `createTicket: false`,
   * so the only way to a queued breakdown on a binding that cannot file is a capability that was
   * true when the task was created and false when the duty called — a token downgraded in between.
   * The port's own contract is *"a caller checks the flag before asking; a provider that is asked
   * anyway throws"*, so what is asserted is that **no call and no audit row** happen at all, rather
   * than that a throw is caught.
   */
  it('makes no call at all when the binding can no longer create tickets', async () => {
    // Three reads get the epic routed (intake asks once); everything after is a read-only binding.
    const { harness, createdTickets } = splitHarness({ children: 1, revokeCreateAfter: 1 });
    await harness.publish([matched('Epic')]);
    const queued = await items(harness);
    expect(queued, 'the epic was not routed to the variant').toHaveLength(1);
    const task = theTask(harness);
    harness.audit.reset();

    await decideBreakdown(deps(harness), {
      taskId: task.task.id,
      itemIds: queued.map((entry) => entry.id),
      decision: 'accept',
      userId: USER,
      reason: null,
    });
    await harness.drain();

    expect(createdTickets).toEqual([]);
    expect(harness.audit.entriesFor('create_ticket')).toEqual([]);
    // The row stays accepted **without** a ticket, which is the honest difference between
    // "accepted" and "created" and is what the duty re-derives its work from next time.
    expect((await items(harness))[0]).toMatchObject({ status: 'accepted', ticketKey: null });
  });

  /**
   * Criterion 5's other half — and the arrangement is stated because it is a state **this build
   * cannot reach through the routing**: `epicSplitRouting` refuses the variant for a shadow task by
   * name (`settings.test.ts` asserts that), and `pipeline.intake` creates every task `normal`. So
   * the row is flipped and the duty is fired directly, the shape `risk-routing.test.ts` uses for
   * the same reason.
   *
   * What is asserted is the duty's **own** obligation rather than the executor's branch: it carries
   * the task's mode into the call, so step 1 of the executor turns the creation into a `would_have`
   * row and `createTicket` is never reached — *"a shadow task must not be able to pretend it filed
   * a ticket"* (BD-021), which is the sentence Jira's own adapter carries.
   */
  it('files nothing for a shadow task, and records would_have instead', async () => {
    const { harness, createdTickets } = splitHarness({ children: 1 });
    await harness.publish([matched('Epic')]);
    const queued = await items(harness);
    const task = theTask(harness);
    await decideBreakdown(deps(harness), {
      taskId: task.task.id,
      itemIds: queued.map((item) => item.id),
      decision: 'accept',
      userId: USER,
      reason: null,
    });

    await harness.memory.transaction(async (scope) => {
      const stored = await harness.store.tasks.load(scope.tx, task.task.id);
      const loaded = stored as NonNullable<typeof stored>;
      await harness.store.tasks.save(scope.tx, {
        ...loaded,
        task: { ...loaded.task, mode: 'shadow' },
      });
    });
    harness.audit.reset();

    const outbound = harness.jobs.handlers.get(JOB_QUEUES.pipelineOutbound);
    await outbound?.({
      id: 'shadow',
      data: {
        duty: 'breakdown_create',
        project_id: PROJECT,
        task_id: task.task.id,
        cause_event_id: '00000000-0000-4000-9000-00000000fffe',
      },
    } as never);

    expect(createdTickets).toHaveLength(0);
    const audit = harness.audit.entriesFor('create_ticket');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.status).toBe('would_have');
    // …and the row the duty stamped names the obviously fake key rather than a real one.
    expect((await items(harness))[0]?.ticketKey).toBe('WOULD-HAVE-NOT-A-REAL-TICKET');
  });

  it('refuses a second decision on a child somebody already decided', async () => {
    const { harness } = splitHarness({ children: 2 });
    await harness.publish([matched('Epic')]);
    const queued = await items(harness);
    const task = theTask(harness);
    const first = queued[0]?.id as Id;

    await decideBreakdown(deps(harness), {
      taskId: task.task.id,
      itemIds: [first],
      decision: 'accept',
      userId: USER,
      reason: null,
    });
    await expect(
      decideBreakdown(deps(harness), {
        taskId: task.task.id,
        itemIds: [first],
        decision: 'reject',
        userId: USER,
        reason: null,
      }),
    ).rejects.toBeInstanceOf(BreakdownRefusedError);
    await harness.drain();
    expect((await items(harness))[0]?.status).toBe('accepted');
  });

  it('refuses a decision on a task nobody has', async () => {
    const { harness } = splitHarness({ children: 1 });
    await harness.publish([matched('Epic')]);
    await expect(
      decideBreakdown(deps(harness), {
        taskId: '00000000-0000-4000-8000-0000000000de' as Id,
        itemIds: ['00000000-0000-4000-8000-0000000000df' as Id],
        decision: 'accept',
        userId: USER,
        reason: null,
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it('refuses a decision on a task that is not an epic split', async () => {
    const { harness } = splitHarness({ template: 'off' });
    await harness.publish([matched('Epic')]);
    await expect(
      decideBreakdown(deps(harness), {
        taskId: theTask(harness).task.id,
        itemIds: ['00000000-0000-4000-8000-0000000000d1' as Id],
        decision: 'accept',
        userId: USER,
        reason: null,
      }),
    ).rejects.toThrow(/proposes no ticket breakdown/);
  });
});

/**
 * The duties' refusals, each by name — *"nothing happened"* is the normal outcome for a wake-up that
 * arrives twice or for a task somebody cancelled, and an operator still has to be able to read why
 * (standing rule 18). Driven through the **composed** outbound handler, so what is asserted is the
 * build rather than a function this file called directly.
 */
describe('the duties settle rather than throw', () => {
  const fire = async (harness: PipelineHarness, data: Record<string, unknown>) => {
    const outbound = harness.jobs.handlers.get(JOB_QUEUES.pipelineOutbound);
    await outbound?.({ id: 'fired', data } as never);
  };

  it('posts no report for a task that is not a spike, or has no report to post', async () => {
    const { harness, posted } = splitHarness({ template: 'off' });
    await harness.publish([matched('Epic')]);
    const task = theTask(harness);
    await fire(harness, {
      duty: 'spike_report',
      project_id: PROJECT,
      task_id: task.task.id,
      cause_event_id: '00000000-0000-4000-9000-00000000fff1',
    });
    expect(posted).toEqual([]);

    // …and a task that has gone entirely.
    await fire(harness, {
      duty: 'spike_report',
      project_id: PROJECT,
      task_id: '00000000-0000-4000-8000-0000000000dd',
      cause_event_id: '00000000-0000-4000-9000-00000000fff2',
    });
    expect(posted).toEqual([]);
  });

  it('files nothing for a task that is not an epic split, or whose children are all filed', async () => {
    const { harness, createdTickets } = splitHarness({ template: 'off' });
    await harness.publish([matched('Epic')]);
    await fire(harness, {
      duty: 'breakdown_create',
      project_id: PROJECT,
      task_id: theTask(harness).task.id,
      cause_event_id: '00000000-0000-4000-9000-00000000fff3',
    });
    expect(createdTickets).toEqual([]);

    // The other early-out: an epic split whose queue holds nothing accepted.
    const split = splitHarness({ children: 1 });
    await split.harness.publish([matched('Epic')]);
    await fire(split.harness, {
      duty: 'breakdown_create',
      project_id: PROJECT,
      task_id: theTask(split.harness).task.id,
      cause_event_id: '00000000-0000-4000-9000-00000000fff4',
    });
    expect(split.createdTickets).toEqual([]);
  });

  it('queues nothing when the epic-split stage produced no breakdown', async () => {
    // A stage that returned an artifact of the wrong shape, which is what a row written by an
    // older build looks like: named in the log and no rows, rather than a throw that would retry.
    const { harness } = splitHarness({ children: 0 });
    await harness.publish([matched('Epic')]);
    expect(await items(harness)).toEqual([]);
    // …and the task still rests at the human stage with an empty queue, which is a finding rather
    // than a failure: a model that could not split an epic has said something.
    expect(theTask(harness).task.currentStage).toBe(SPIKE_HUMAN_STAGE);
  });
});

describe('projectKeyOf', () => {
  it('files a child in the epic’s own project', () => {
    expect(projectKeyOf({ key: 'ACME-7' })).toBe('ACME');
    expect(projectKeyOf({ key: 'ACME-SUB-12' })).toBe('ACME-SUB');
  });

  it('uses a key with no separator whole, so the provider refuses rather than the platform guessing', () => {
    expect(projectKeyOf({ key: '42' })).toBe('42');
    expect(projectKeyOf({ key: '-7' })).toBe('-7');
  });
});
