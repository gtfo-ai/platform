/**
 * The ticket readiness linter, driven through the real handlers, the real interpreter, the real
 * stage executor and the real `IntegrationActionExecutor` over the in-memory doubles (WP-25).
 *
 * The e2e tier runs the same thing on PostgreSQL with a signed delivery and a real `apps/server`;
 * this tier is where the **branches** live — a project with the feature off, a ticket the filter
 * refuses in each of its three ways, a ticket the provider will not give up, a redelivery that must
 * comment nothing twice, a planted credential in the model's own questions, and the two ticket
 * writes that must not reach a human's ticket.
 *
 * Nothing here asserts through the runner: it is scripted per stage and never reads the prompt
 * (standing rule 82). What reaches the model is asserted on the **assembled prompt**, which the
 * harness exposes as `harness.specs`.
 */
import type { DomainEvent } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { readDataBlocks } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { CommentRef, Ticket, TicketRefInput } from '../ports/integrations/task-management.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import {
  LINT_COMMENT_MARKER,
  LINT_COMMENT_MARKER_ID,
  LINT_COMMENT_MAX_TEXT_CHARS,
  lintCommentIdempotencyKey,
  lintTicketKeyFor,
  MAX_LINT_COMMENT_LINES,
  MAX_LINT_QUESTION_CHARS,
  renderLintComment,
  TICKET_LINT_STAGE,
  TICKET_LINT_TEMPLATE_ID,
  TICKET_LINT_TICKET_PROVIDER,
  ticketKeyOfLintTask,
} from './ticket-lint.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const TICKET_KEY = 'ACME-2';
const TICKET_URL = 'https://tickets.example.test/browse/ACME-2';

/** An obviously fake credential (BD-002), planted so the redaction assertion has a target. */
const PLANTED = 'FAKE-jira-token-not-a-real-secret-0000';
const PLACEHOLDER = '[REDACTED:integration:jira_token]';

/** What the Product Manager returns for an unready ticket: no criteria, no scope, two questions. */
const SPEC = (overrides: Record<string, unknown> = {}) => ({
  goal: 'Make the footer add up',
  user_value: 'Finance stops re-checking invoices by hand',
  in_scope: [],
  out_of_scope: [],
  acceptance_criteria: [],
  non_functional: [],
  dependencies: [],
  size: 'M',
  drift: { flag: false, justification: '' },
  assumptions: ['The footer is rendered server-side'],
  questions: [
    { id: 'q1', text: 'Which rows count — visible or all?', blocking: true, options: null },
    { id: 'q2', text: 'Does this apply to credit notes?', blocking: false, options: null },
  ],
  decision: 'ask',
  kb_citations: [],
  ...overrides,
});

interface Posted {
  readonly key: string;
  readonly markdown: string;
  readonly markerId: string | null;
}

const ticketOf = (overrides: Partial<Ticket> = {}): Ticket =>
  ({
    ref: { provider: 'fake-jira', key: TICKET_KEY, url: TICKET_URL },
    issue_type: 'Story',
    title: 'Invoice footer is wrong',
    description: 'The footer sums the visible rows rather than all of them.',
    status: 'To Do',
    priority: null,
    labels: [],
    comments: [],
    links: [],
    epic: null,
    siblings: [],
    attachments_text: [],
    assignee: null,
    reporter: null,
    updated_at: '2026-06-01T09:00:00.000Z',
    ...overrides,
  }) as Ticket;

const lintHarness = (
  options: {
    readonly enabled?: boolean;
    readonly issueTypes?: readonly string[];
    readonly label?: string;
    readonly ticket?: Partial<Ticket>;
    readonly readThrows?: boolean;
    readonly spec?: Record<string, unknown>;
    /** Runs inside the duty's **call** phase, which is where an interleaving is forced (rule 76). */
    readonly onReadTicket?: () => Promise<void>;
    /**
     * Lets the *pipeline* deliver in the same harness: the feature template's first stage is
     * scripted (its `ask` verdict parks the task, which is the shortest ending that template has),
     * and the two ticket writes a delivery legitimately makes record instead of throwing. The
     * linter's own refusal of those two writes is asserted by every other case in this file.
     */
    readonly delivering?: boolean;
  } = {},
): {
  harness: PipelineHarness;
  posted: Posted[];
  /** Read **after** the publish that is supposed to move them; never destructured (see below). */
  counters: { workpads: number; transitions: number; reads: number };
} => {
  const posted: Posted[] = [];
  const counters = { workpads: 0, transitions: 0, reads: 0 };
  const harness = createPipelineHarness({
    projectId: PROJECT,
    runs: {
      [TICKET_LINT_STAGE]: {
        status: 'completed',
        terminalReason: 'success',
        structuredOutput: options.spec ?? SPEC(),
      },
      ...(options.delivering === true
        ? {
            refinement: {
              status: 'completed' as const,
              terminalReason: 'success' as const,
              structuredOutput: SPEC(),
            },
          }
        : {}),
    },
    settings: {
      config: {
        features: {
          ticket_linter: {
            enabled: options.enabled ?? true,
            ...(options.issueTypes === undefined ? {} : { issue_types: [...options.issueTypes] }),
            ...(options.label === undefined ? {} : { label: options.label }),
          },
        },
        // A project that maps its stages **and** its states, so the ticket writes this mode must
        // not make are the ones a real project would have enabled.
        status_mapping: { ticket_lint: 'In Refinement', done: 'Done' },
      },
    },
    // The binding's own redactor, armed: a disarmed one proves nothing (standing rules 31, 35).
    ticketRedactor: exactSecretRedactor([{ name: 'jira_token', value: PLANTED }]),
    taskManagement: {
      readTicket: async () => {
        if (options.readThrows === true) {
          throw new Error('the provider refused the ticket');
        }
        counters.reads += 1;
        await options.onReadTicket?.();
        return ticketOf(options.ticket);
      },
      addComment: async (
        ref: TicketRefInput,
        markdown: string,
        commentOptions?: { readonly markerId?: string | null },
      ): Promise<CommentRef> => {
        posted.push({
          key: ref.key,
          markdown,
          markerId: commentOptions?.markerId ?? null,
        });
        return {
          provider: ref.provider,
          ticket_key: ref.key,
          comment_id: `comment-${posted.length}`,
          url: null,
          marker_id: commentOptions?.markerId ?? null,
        };
      },
      upsertWorkpad: async (ref: TicketRefInput, markerId: string): Promise<CommentRef> => {
        counters.workpads += 1;
        if (options.delivering !== true) {
          throw new Error('a lint must not write a workpad on a human’s ticket');
        }
        return {
          provider: ref.provider,
          ticket_key: ref.key,
          comment_id: 'workpad',
          url: null,
          marker_id: markerId,
        };
      },
      transition: async (_ref: TicketRefInput, to: string) => {
        counters.transitions += 1;
        if (options.delivering !== true) {
          throw new Error('a lint must not move a human’s ticket');
        }
        return { changed: true, from: 'To Do', to };
      },
    },
  });
  // `counters` itself, not a getter per field: a getter read at destructuring time answers 0 for
  // every call the test has not made yet, which is how `expect(workpads).toBe(0)` passed here
  // before the run that would have written one (WP-25 round 2).
  return { harness, posted, counters };
};

let stream = 0;

const created = (overrides: { readonly key?: string; readonly issueType?: string } = {}) => {
  stream += 1;
  const suffix = stream.toString(16).padStart(12, '0');
  return domainEventSchemasByType['ticket.created'].parse({
    id: `00000000-0000-4000-9000-${suffix}`,
    stream_type: 'project',
    stream_id: `00000000-0000-4000-8000-${suffix}`,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ticket.created',
    payload: {
      project_id: PROJECT,
      ticket: {
        provider: 'fake-jira',
        key: overrides.key ?? TICKET_KEY,
        url: TICKET_URL,
      },
      issue_type: overrides.issueType ?? 'Story',
    },
  }) as DomainEvent;
};

/**
 * `ticket.matched` as the Jira normaliser emits it **beside** `ticket.created`, out of one
 * `jira:issue_created` delivery (`webhook.ts`: `matchedEvent` is pushed first, the creation second).
 *
 * The rule is the *integration's* pick-up rule, and in these cases it is deliberately not the
 * linter's label — a status, or a label the project's `features.ticket_linter.label` does not equal.
 */
const matched = (rule: string, overrides: { readonly key?: string } = {}) => {
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
      ticket: { provider: 'fake-jira', key: overrides.key ?? TICKET_KEY, url: TICKET_URL },
      rule,
      priority: 'High',
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;
};

const lintTask = (harness: PipelineHarness) =>
  harness.store.snapshot().find((task) => task.task.template === TICKET_LINT_TEMPLATE_ID);

/** Lint comments only: a delivery task in the same harness posts its own (its questions). */
const lintComments = (posted: readonly Posted[]) =>
  posted.filter((comment) => comment.markerId === LINT_COMMENT_MARKER_ID);

// ── The comment ──────────────────────────────────────────────────────────────

describe('the comment the linter posts', () => {
  const readiness = {
    score: 40,
    missing: ['acceptance_criteria', 'scope_boundaries', 'validation'] as const,
    questions: 5,
  };
  const fiveQuestions = Array.from({ length: 5 }, (_, at) => `Question number ${at}?`);

  it('is product/19 § 17’s shape: marker, score, the gaps, the questions and the offer', () => {
    const body = renderLintComment({
      readiness: { score: 45, missing: ['acceptance_criteria'], questions: 2 },
      questions: ['Which rows count?', 'What about credit notes?'],
      label: 'agentic',
    });
    expect(body.startsWith(LINT_COMMENT_MARKER)).toBe(true);
    expect(body).toContain('**Agent readiness: 45/100**');
    expect(body).toContain('missing: acceptance criteria');
    expect(body).toContain('- Which rows count?');
    expect(body).toContain('- What about credit notes?');
    expect(body).toContain('Add the label `agentic`');
  });

  it('stays inside ten lines at its longest, and is four lines when nothing is asked', () => {
    const worst = renderLintComment({
      readiness: { ...readiness, missing: [...readiness.missing] },
      questions: fiveQuestions,
      label: 'agentic',
    });
    expect(worst.split('\n')).toHaveLength(MAX_LINT_COMMENT_LINES);

    const quiet = renderLintComment({
      readiness: { score: 100, missing: [], questions: 0 },
      questions: [],
      label: 'agentic',
    });
    expect(quiet.split('\n')).toHaveLength(4);
    expect(quiet).toContain('nothing obvious is missing');
    expect(quiet).not.toContain('Questions a developer');
  });

  it('cuts a question at its cap and leaves one under it alone (standing rule 42)', () => {
    const long = 'w'.repeat(MAX_LINT_QUESTION_CHARS + 50);
    const exact = 'e'.repeat(MAX_LINT_QUESTION_CHARS);
    const body = renderLintComment({
      readiness: { score: 50, missing: [], questions: 2 },
      questions: [long, exact],
      label: 'agentic',
    });
    expect(body).toContain(`- ${'w'.repeat(MAX_LINT_QUESTION_CHARS - 1)}…`);
    expect(body).toContain(`- ${exact}\n`);
    expect(body).not.toContain(long);
  });

  it('posts at most five questions however many it is handed', () => {
    const body = renderLintComment({
      readiness: { ...readiness, missing: [...readiness.missing] },
      questions: Array.from({ length: 12 }, (_, at) => `q${at}`),
      label: 'agentic',
    });
    expect(body.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(5);
    expect(body).not.toContain('- q5');
  });

  /** Produced by driving the renderer at its caps, never quoted (standing rule 39). */
  it('pins its own worst-case length', () => {
    const worst = renderLintComment({
      // Every cap at once: the longest score, all three gaps, five questions at their cap, and a
      // label at its own.
      readiness: { score: 100, missing: [...readiness.missing], questions: 5 },
      questions: Array.from({ length: 5 }, () => 'q'.repeat(MAX_LINT_QUESTION_CHARS)),
      label: 'L'.repeat(64),
    });
    // The measurement first, then the published bound over it: 1 843 characters is what the
    // renderer really produces at its caps, and the constant is the ceiling a reader is given.
    expect(worst).toHaveLength(1_843);
    expect(worst.length).toBeLessThanOrEqual(LINT_COMMENT_MAX_TEXT_CHARS);
  });
});

describe('the lint task’s key', () => {
  it('round-trips the ticket it is about, and cannot be a real ticket key', () => {
    expect(lintTicketKeyFor(TICKET_KEY)).toBe('lint!ACME-2');
    expect(ticketKeyOfLintTask(lintTicketKeyFor(TICKET_KEY))).toBe(TICKET_KEY);
    // A row written by something else is returned unchanged rather than mangled.
    expect(ticketKeyOfLintTask('ACME-2')).toBe('ACME-2');
  });
});

// ── The trigger ──────────────────────────────────────────────────────────────

describe('a ticket being created', () => {
  it('lints it, posts one comment and finishes', async () => {
    const { harness, posted } = lintHarness();
    await harness.publish([created()]);

    const task = lintTask(harness);
    expect(task).toBeDefined();
    expect(task?.task.state).toBe('done');
    expect(task?.task.mode).toBe('normal');
    expect(task?.task.ticket).toEqual({
      provider: TICKET_LINT_TICKET_PROVIDER,
      key: lintTicketKeyFor(TICKET_KEY),
      url: TICKET_URL,
    });
    // The ticket's own words, read once and stored on the row (WP-15f's reader).
    expect(task?.ticketSnapshot?.title).toBe('Invoice footer is wrong');

    // Exactly one run, the Product Manager's, recorded as a linter run (PROGRESS backlog 57).
    expect(harness.specs.map((spec) => spec.stage)).toEqual([TICKET_LINT_STAGE]);
    expect(harness.specs[0]?.role).toBe('product_manager');
    expect(harness.specs[0]?.mode).toBe('linter');

    // One comment, on the **real** ticket, carrying both markers.
    expect(posted).toHaveLength(1);
    expect(posted[0]?.key).toBe(TICKET_KEY);
    expect(posted[0]?.markerId).toBe(LINT_COMMENT_MARKER_ID);
    expect(posted[0]?.markdown).toContain(LINT_COMMENT_MARKER);
    // The questions are the model's, and the score is the platform's reading of its artifact: no
    // criteria, no scope, two questions.
    expect(posted[0]?.markdown).toContain('Which rows count — visible or all?');
    expect(posted[0]?.markdown).toContain('**Agent readiness: 15/100**');
  });

  it('puts the ticket’s words in the prompt inside a data block, under the stage’s own instruction', async () => {
    const { harness } = lintHarness();
    await harness.publish([created()]);
    const spec = harness.specs[0];
    const reading = readDataBlocks(spec?.userPrompt ?? '');
    const block = reading.blocks.find((entry) => entry.kind === 'ticket');
    expect(block?.body).toContain('The footer sums the visible rows');
    expect(reading.platformVoice.join('')).not.toContain('The footer sums the visible rows');
    // The narrower instruction is platform text and lives in layers 1–3, where `promptVersion`
    // digests it (WP-25; `STAGE_PROMPT_FOCUS`).
    expect(spec?.systemPromptAppend).toContain('This run is a ticket readiness lint');
    expect(spec?.userPrompt).not.toContain('This run is a ticket readiness lint');
  });

  it('gives the run no way to ask a human, because a lint has no watcher', async () => {
    const { harness } = lintHarness();
    await harness.publish([created()]);
    expect(harness.specs[0]?.platformTools).not.toContain('ask_human');
    // The rest of the Product Manager's list is untouched — a stage narrows, never widens.
    expect(harness.specs[0]?.platformTools).toContain('kb_search');
  });

  it('records the metric’s baseline as an event', async () => {
    const { harness } = lintHarness();
    await harness.publish([created()]);
    const events = harness.events().filter((entry) => entry.type === 'task.lint.posted');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      ticket: { provider: 'fake-jira', key: TICKET_KEY, url: TICKET_URL },
      score: 15,
      missing: ['acceptance_criteria', 'scope_boundaries', 'validation'],
      questions_posted: 2,
      ticket_updated_at: '2026-06-01T09:00:00.000Z',
    });
  });

  it('does nothing at all when the project has not enabled the linter', async () => {
    const { harness, posted } = lintHarness({ enabled: false });
    await harness.publish([created()]);
    expect(lintTask(harness)).toBeUndefined();
    expect(harness.specs).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  it('skips a ticket that is labelled for the agent, and lints the same ticket without it', async () => {
    const labelled = lintHarness({ ticket: { labels: ['billing', 'agentic'] } });
    await labelled.harness.publish([created()]);
    expect(lintTask(labelled.harness)).toBeUndefined();
    expect(labelled.posted).toHaveLength(0);

    const plain = lintHarness({ ticket: { labels: ['billing'] } });
    await plain.harness.publish([created()]);
    expect(lintTask(plain.harness)).toBeDefined();
    expect(plain.posted).toHaveLength(1);
  });

  it('skips an issue type the project did not configure, and lints one it did', async () => {
    const miss = lintHarness({ issueTypes: ['Bug'], ticket: { issue_type: 'Epic' } });
    await miss.harness.publish([created({ issueType: 'Epic' })]);
    expect(lintTask(miss.harness)).toBeUndefined();
    expect(miss.posted).toHaveLength(0);

    const hit = lintHarness({ issueTypes: ['Bug'], ticket: { issue_type: 'Bug' } });
    await hit.harness.publish([created({ issueType: 'Bug' })]);
    expect(lintTask(hit.harness)).toBeDefined();
  });

  /**
   * The ticket's text **is** the input, so a read that fails starts nothing rather than spending a
   * budget on a model with nothing to read (standing rule 20's fail-closed direction for a decision
   * to spend — the argument `runReviewOnlyCheck` makes about the diff).
   */
  it('creates no task when the provider would not give up the ticket', async () => {
    const { harness, posted } = lintHarness({ readThrows: true });
    await expect(harness.publish([created()])).rejects.toThrow(/refused the ticket/);
    expect(lintTask(harness)).toBeUndefined();
    expect(harness.specs).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  /** A countable effect, not a counter of this file's own (standing rule 79). */
  it('posts nothing twice when the delivery arrives again', async () => {
    const { harness, posted } = lintHarness();
    await harness.publish([created()]);
    await harness.publish([created()]);
    expect(
      harness.store.snapshot().filter((task) => task.task.template === TICKET_LINT_TEMPLATE_ID),
    ).toHaveLength(1);
    expect(harness.specs).toHaveLength(1);
    expect(posted).toHaveLength(1);
  });

  /**
   * The workpad (TD-005 priority 120) and the status mapping (110) fire for **every** task, and a
   * lint task's ticket reference names no ticket. Until WP-25 they were refused by the *provider*
   * with a failed audit row and a retrying job (standing rule 47); now `ticketWrites` refuses them
   * by name, so neither call is made at all — which is what these two stubs would throw on.
   */
  it('never writes a workpad on the ticket and never moves its status', async () => {
    const { harness, counters } = lintHarness();
    await harness.publish([created()]);
    expect(lintTask(harness)?.task.state).toBe('done');
    expect(counters.workpads).toBe(0);
    expect(counters.transitions).toBe(0);
    expect(lintTask(harness)?.workpad).toBeNull();
  });

  it('keeps a credential the model quoted out of the comment', async () => {
    const { harness, posted } = lintHarness({
      spec: SPEC({
        questions: [
          {
            id: 'q1',
            text: `Is ${PLANTED} the right token for the staging run?`,
            blocking: true,
            options: null,
          },
        ],
      }),
    });
    await harness.publish([created()]);
    const body = posted[0]?.markdown ?? '';
    expect(body).not.toContain(PLANTED);
    expect(body).toContain(PLACEHOLDER);
    // The sentence around it survives, so the question is still a question (standing rule 42).
    expect(body).toContain('the right token for the staging run?');
  });

  /**
   * Asserted where the key is **used**, not where it is built: the storage key the executor wrote
   * when it remembered the provider's answer (`integrationId:action:key`, `idempotencyStorageKey`).
   * The first version of this case compared `lintCommentIdempotencyKey`'s return value with its own
   * formula, which held for any caller that never passed it to anything (WP-25 round 2).
   */
  it('keys the comment by the lint task alone, so no part of it is a model’s or a provider’s', async () => {
    const { harness } = lintHarness();
    await harness.publish([created()]);
    const task = lintTask(harness);
    const key = lintCommentIdempotencyKey(task?.task.id as never);
    expect(key).toBe(`ticket_lint_comment:${task?.task.id}`);
    expect(harness.idempotency.keys()).toEqual([
      `${harness.integrations.taskManagement?.ref.integrationId}:add_comment:${encodeURIComponent(key)}`,
    ]);
  });
});

// ── The ticket the pipeline is already delivering ────────────────────────────

/**
 * **One Jira delivery, two events** — the case the handler's delivery guard documents and, until
 * WP-25 round 2, the case it was dead in.
 *
 * `jira:issue_created` for a ticket that already satisfies the pick-up rule pushes `ticket.matched`
 * **and** `ticket.created` (`webhook.ts`), so both are dispatched before either duty runs:
 * `pipeline.intake` only *enqueues* `intake_check` from `afterCommit`, and the delivery task is
 * created by that job. The lint handler therefore looks at a project that has no task for this
 * ticket yet, passes, and — before this round — the duty on fire re-read only the `lint!` key.
 *
 * The label filter hides it only when the two labels happen to agree. These two cases are the ones
 * where they cannot: a project picking tickets up **by status**, and one whose `pickup_label`
 * (integration configuration) is not `features.ticket_linter.label` (the project's) — Q75.
 *
 * Both directions are here: the third case is the same harness, the same configuration and a ticket
 * nothing picked up, so a fix that simply stopped linting would fail it.
 */
describe('a ticket the pipeline is already delivering', () => {
  const deliveredAndCreated = (rule: string) => [matched(rule), created()];

  it('is not linted when the project picks tickets up by status', async () => {
    const { harness, posted, counters } = lintHarness({ delivering: true });
    await harness.publish(deliveredAndCreated('status = "Ready for agent"'));

    // One task, and it is the delivery's. Before the fix: `feature:ACME-2` *and*
    // `ticket_lint:lint!ACME-2`.
    expect(
      harness.store.snapshot().map((task) => `${task.task.template}:${task.task.ticket.key}`),
    ).toEqual([`feature:${TICKET_KEY}`]);
    expect(lintTask(harness)).toBeUndefined();
    // No lint run was charged: the only run is the delivery's own first stage.
    expect(harness.specs.map((spec) => spec.stage)).toEqual(['refinement']);
    // And no comment told the author to add a label so that a ticket already being delivered would
    // be picked up.
    expect(lintComments(posted)).toHaveLength(0);
    // One ticket read, and it is intake's own snapshot (WP-15f): the duty stopped at its **first**
    // ask, before the settings read, the binding load and its own read of the ticket. Without that
    // ask the inner one would still refuse the task — and the provider would have been called for
    // a lint that was never going to happen.
    expect(counters.reads).toBe(1);
  });

  it('is not linted when the pick-up label is not the linter’s label', async () => {
    const { harness, posted } = lintHarness({
      delivering: true,
      // The project's linter label; the pick-up label below is the integration's and differs.
      label: 'agentic',
      ticket: { labels: ['ai-please'] },
    });
    await harness.publish(deliveredAndCreated('label = "ai-please"'));

    expect(lintTask(harness)).toBeUndefined();
    expect(harness.specs.map((spec) => spec.stage)).toEqual(['refinement']);
    expect(lintComments(posted)).toHaveLength(0);
  });

  it('still lints a ticket nothing picked up', async () => {
    const { harness, posted } = lintHarness({ delivering: true });
    await harness.publish([created()]);

    expect(lintTask(harness)?.task.state).toBe('done');
    expect(harness.specs.map((spec) => spec.stage)).toEqual([TICKET_LINT_STAGE]);
    expect(lintComments(posted)).toHaveLength(1);
  });

  /**
   * The duty's **second** ask, the one inside the create transaction — and the only case that kills
   * a mutant of it.
   *
   * Between the duty's first ask and its write there is nothing but I/O: a settings read, a binding
   * load and the call to the provider. `intake_check` is a job of its own and commits whenever it
   * commits, so the interleaving is **forced** rather than waited for (standing rule 76): the
   * ticket read — the last thing before the write — is where the delivery lands.
   */
  it('does not create the lint task when the delivery lands while the duty is calling the provider', async () => {
    let deliver: (() => Promise<void>) | null = null;
    const { harness, posted } = lintHarness({
      delivering: true,
      onReadTicket: async () => {
        const run = deliver;
        deliver = null;
        await run?.();
      },
    });
    deliver = async () => {
      await harness.publish([matched('status = "Ready for agent"')]);
    };

    await harness.publish([created()]);

    expect(
      harness.store.snapshot().map((task) => `${task.task.template}:${task.task.ticket.key}`),
    ).toEqual([`feature:${TICKET_KEY}`]);
    expect(lintTask(harness)).toBeUndefined();
    expect(lintComments(posted)).toHaveLength(0);
  });
});
