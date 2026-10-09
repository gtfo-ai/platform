/**
 * **WP-183 — the product owner's three flows, end to end, with fake Claude** (BD-031, TD-029,
 * PROGRESS backlog 535, 536 and 537).
 *
 * Whole `apps/server` instances on the Testcontainers PostgreSQL, the shared harness of this tier
 * (`../support/pipeline.ts`), the fake git provider and the fake task manager reached through their
 * registrations. The lifecycle block is written into `bindings.config` the way `PUT …/bindings`
 * stores it, so the production settings port, loader and executor read it. Every person's word
 * arrives over the instance's own webhook door (`deliver`/`deliverGit`), and every effect is read
 * back off the fakes and the database:
 *
 *  - **(i)** every slot mapped to an invented name: claim → `in_progress` → merge request →
 *    `in_review` → review threads → fix with replies → `approved` → `qa` → returned by a
 *    `resolvable: false` general note → re-claimed → fixed → review → `approved` → `qa` → QA passes
 *    → `ready_for_merge` → merge → `done`;
 *  - **(ii)** the same flow with the QA return made by a status change alone, by a ticket comment
 *    alone, and by a ticket comment written **during `code_review`** with no later signal — which
 *    only TD-029 decision 7 amendment (g), the entry into `qa` arming the window, returns;
 *  - **(iii)** no slot mapped, on the fake's **default** workflow (WP-183 (v): invented names):
 *    zero assign, unassign, identity, status or transition calls, no `qa` stage, and the review
 *    conversation and the return at Ready as before.
 *
 * ## What the fake Claude reads, and what it answers
 *
 * The Developer's `thread_replies` and the Reviewer's `resolved_threads` quote thread ids the fake
 * model read through the **production `get_conversation` tool** (the harness's `beforeReport`),
 * the read a real run makes when its prompt tells it to, and the only ids a model could quote back:
 * a flow that passes proves that the platform handed the run the threads it then answered (TD-029
 * decisions 10 and 11). A run that answers the Reviewer's findings first waits until they are on
 * the merge request — the effect it reads, never a sleep. **Why not the prompt's own
 * `conversation` blocks** (measured here, filed as discovered work in PROGRESS under WP-183): the
 * Developer's re-run after a review return, and the re-review after it, are planned before the
 * `review_findings_post` duty has posted the findings — on the e2e clock the duty ran three
 * seconds after the review, after `implementation`, `code_review` and `business_review` had all
 * been planned — so their prompts carried no merge-request entry at all. A real run takes
 * minutes and can call the tool; the fake run takes milliseconds, so it calls it. Which stage
 * attempt replies to what is the flows' script, stated at {@link scenarioFor}.
 *
 * ## Two harness moves, stated (the same ones `mr-poll.e2e.test.ts` makes)
 *
 *  - **The window is nudged, never waited for.** A human stage's window opens two minutes after its
 *    arming signal (BD-007) and production has no setting for it; the queued `mr.comment.debounce`
 *    job is moved to `now()` instead, once the effect the case depends on has landed.
 *  - **The horizon is moved back, and the person's word is placed just after it.** A word counts
 *    when it is newer than the start of the task's latest `implementation` run (TD-029 decision 7),
 *    and the window decides only once the newest word is two minutes old. So the latest
 *    implementation run's `started_at` is set to five minutes ago and the word is written one
 *    second after it: newer than the horizon, older than the window. A word of an earlier round
 *    stays behind the later round's horizon, because each horizon is set from its own `now()`.
 *
 * Every status name here is an invented fixture value (BD-031 ruling 1).
 */
import type { RunSpec } from '@platform/application';
import type { DomainEvent } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GIT_PROJECT,
  inboundEvent,
  type PipelineE2E,
  type ScenarioSpec,
  type SeededWorld,
  type StartPipelineOptions,
  startPipeline,
  TICKETS_INTEGRATION_ID,
} from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const TICKET_KEY = 'ACME-1';
const PICK_UP = 'To pick up';
const QA_PASSED = 'Accepted';
/** Every slot mapped, each to an invented name that no slot shares (TD-029 decision 1). */
const LIFECYCLE = {
  in_progress: 'Doing',
  in_review: 'Waiting for review',
  approved: 'Reviewed',
  qa: 'Testing',
  returned: ['Sent back'],
  done: 'Shipped',
} as const;
const WORKFLOW = [
  PICK_UP,
  LIFECYCLE.in_progress,
  LIFECYCLE.in_review,
  LIFECYCLE.approved,
  LIFECYCLE.qa,
  ...LIFECYCLE.returned,
  QA_PASSED,
  LIFECYCLE.done,
];
const BOT = 'agentic-bot';
const QA_PERSON = 'quinn';

const FINDING_MARKER = '<!-- agentic:review-finding:';
const SUMMARY_MARKER = '<!-- agentic:review-summary:';
const REPLY_MARKER = '<!-- agentic:reply:';

// ── The fake Claude's script ───────────────────────────────────────────────────

interface ConversationEntry {
  readonly source: string;
  readonly id: string;
  readonly platform: boolean;
  readonly body: string;
}

/** `get_conversation`'s answer (`conversationToolAnswer`), as the fake model reads it. */
const entriesOf = (answer: unknown): readonly ConversationEntry[] => {
  const { available, entries } = answer as {
    readonly available: boolean;
    readonly entries: readonly {
      readonly source: string;
      readonly thread_id?: string;
      readonly comment_id?: string;
      readonly platform: boolean;
      readonly body: string;
    }[];
  };
  if (!available) throw new Error('get_conversation answered that the conversation is unavailable');
  return entries.map((entry) => ({
    source: entry.source,
    id: entry.thread_id ?? entry.comment_id ?? '',
    platform: entry.platform,
    body: entry.body,
  }));
};

/** The Reviewer's own finding threads among what the run read. */
const findingThreadsIn = (entries: readonly ConversationEntry[]): readonly string[] => [
  ...new Set(
    entries
      .filter((entry) => entry.source === 'mr' && entry.body.trimStart().startsWith(FINDING_MARKER))
      .map((entry) => entry.id),
  ),
];

/** The runs that read the conversation before they report: the ones that answer it (below). */
const readsConversation = (spec: RunSpec): boolean =>
  (spec.stage === 'implementation' && spec.attempt >= 2) ||
  (spec.stage === 'code_review' && spec.attempt === 2);

/** What each such run read, by run id — written before the run reports, read by the scenario. */
const readings = new Map<string, readonly ConversationEntry[]>();

const readingOf = (spec: RunSpec): readonly ConversationEntry[] => {
  const entries = readings.get(spec.runId);
  if (entries === undefined) throw new Error(`run ${spec.runId} read no conversation`);
  return entries;
};

const REQUEST_CHANGES = {
  verdict: 'request_changes',
  findings: [
    {
      id: 'f1',
      severity: 'major',
      category: 'correctness',
      file: 'src/totals.ts',
      line: 1,
      explanation: 'The footer still sums the visible rows.',
      suggestion: 'Sum the invoice model.',
    },
    {
      id: 'f2',
      severity: 'minor',
      category: 'tests',
      explanation: 'No case covers a hidden row.',
    },
  ],
  summary: 'Two findings to answer before this can pass.',
  protected_path_changes_confirmed: [],
};

/**
 * The flows' script, picked per stage **attempt**:
 *
 *  - `code_review` attempt 1 asks for changes with two findings, one anchored on a line;
 *  - `implementation` attempt 2 (after that review) answers each finding thread it read;
 *  - `code_review` attempt 2 approves and resolves the finding threads it read;
 *  - `implementation` attempt 3 (after the human return) answers every person's word it read —
 *    none when the status alone returned the task;
 *  - everything else is `featureScenarios`' (an approving review at attempt 3 resolves nothing).
 */
const scenarioFor = (spec: RunSpec, world: SeededWorld): ScenarioSpec | undefined => {
  const base = featureScenarios(world);
  if (spec.stage === 'implementation' && spec.attempt >= 2) {
    const read = readingOf(spec);
    const replies =
      spec.attempt === 2
        ? findingThreadsIn(read).map((thread) => ({
            thread_id: thread,
            kind: 'fixed',
            reply: 'Fixed: the footer sums the invoice model, and a test covers a hidden row.',
          }))
        : read
            .filter((entry) => !entry.platform)
            .map((entry) => ({
              thread_id: entry.id,
              kind: 'fixed',
              reply: 'Done as asked; the change is on the branch.',
            }));
    return {
      structuredOutput: { ...base.implementation.structuredOutput, thread_replies: replies },
    };
  }
  if (spec.stage === 'code_review' && spec.attempt === 1) {
    return { structuredOutput: REQUEST_CHANGES };
  }
  if (spec.stage === 'code_review' && spec.attempt === 2) {
    return {
      structuredOutput: {
        ...base.code_review.structuredOutput,
        resolved_threads: findingThreadsIn(readingOf(spec)),
      },
    };
  }
  return undefined;
};

// ── The harness moves ───────────────────────────────────────────────────────────

const ticketMatched = (pipeline: PipelineE2E) =>
  inboundEvent('ticket.matched', {
    project_id: pipeline.projectId,
    ticket: {
      provider: 'fake-task-management',
      key: TICKET_KEY,
      url: `https://tickets.example.test/browse/${TICKET_KEY}`,
    },
    rule: 'label:agentic',
    priority: 'High',
    issue_type: 'Story',
    epic: null,
    links: [],
  });

/**
 * One step of a flow, on **one** log across both fakes and the fake model (WP-183 review round 1):
 * a provider write as it lands, or a run as the fake model starts it. `at` is the wall clock, which
 * the instance's `occurred_at` shares (one process), for the one comparison with a stage entry.
 */
interface Step {
  readonly kind: 'assign' | 'transition' | 'open_mr' | 'thread' | 'reply' | 'resolve' | 'run';
  /** The target status, the discussion id, the finding marker's kind, or `<stage>:<attempt>`. */
  readonly detail: string;
  /** A transition's answer; `true` for every other step. */
  readonly changed: boolean;
  readonly at: number;
}

/**
 * Wraps one method of a fake so its calls land on the log when they settle — through the fake's own
 * method, so a person's move (`emitStatusChanged`, `addGeneralNote`, test controls) is never one.
 * Installed before the ticket arrives, as `workpadDelayMs` wraps `upsertWorkpad`: the registrations
 * hand the loader these objects (the git view is a `Proxy` reading the property at call time).
 */
const logCalls = <TArgs extends unknown[], TResult>(
  target: object,
  method: string,
  record: (args: TArgs, result: TResult | undefined) => Omit<Step, 'at'> | null,
): void => {
  const holder = target as Record<string, (...args: TArgs) => Promise<TResult>>;
  const original = (holder[method] as (...args: TArgs) => Promise<TResult>).bind(target);
  holder[method] = async (...args: TArgs) => {
    let result: TResult | undefined;
    try {
      result = await original(...args);
      return result;
    } finally {
      const step = record(args, result);
      if (step !== null) steps.push({ ...step, at: Date.now() });
    }
  };
};

/** The current flow's log (one flow per test, run in order). */
let steps: Step[] = [];

const recordSteps = (pipeline: PipelineE2E): Step[] => {
  steps = [];
  const ok = (kind: Step['kind'], detail: string) => ({ kind, detail, changed: true });
  logCalls(pipeline.tickets, 'assignToSelf', () => ok('assign', ''));
  logCalls<[unknown, string], { changed: boolean }>(
    pipeline.tickets,
    'transition',
    (args, result) =>
      result === undefined
        ? null
        : { kind: 'transition', detail: args[1], changed: result.changed },
  );
  // A refused open (the provider's duplicate, which the tool then adopts) is a step too.
  logCalls(pipeline.git, 'openMergeRequest', () => ok('open_mr', ''));
  logCalls<[unknown, { markdown: string }], unknown>(pipeline.git, 'createDiscussion', (args) =>
    ok('thread', /<!-- agentic:([a-z-]+):/.exec(args[1].markdown)?.[1] ?? 'unmarked'),
  );
  logCalls<[unknown, string], unknown>(pipeline.git, 'replyToDiscussion', (args, result) =>
    result === undefined ? null : ok('reply', args[1]),
  );
  logCalls<[unknown, string], unknown>(pipeline.git, 'resolveDiscussion', (args, result) =>
    result === undefined ? null : ok('resolve', args[1]),
  );
  return steps;
};

const runStep = (spec: RunSpec): void => {
  steps.push({
    kind: 'run',
    detail: `${spec.stage ?? 'none'}:${String(spec.attempt)}`,
    changed: true,
    at: Date.now(),
  });
};

/** Every changed transition, and the repeats, from the log. */
const transitionsIn = (log: readonly Step[]) => log.filter((step) => step.kind === 'transition');

const ofType = async (pipeline: PipelineE2E, type: string): Promise<readonly DomainEvent[]> =>
  (await pipeline.events()).filter((event) => event.type === type);

const payloadOf = (event: DomainEvent | undefined): Record<string, unknown> =>
  (event?.payload ?? {}) as Record<string, unknown>;

const openWindows = async (pipeline: PipelineE2E): Promise<number> =>
  (
    await pipeline.query<{ n: number }>(
      `select count(*)::int as n from pgboss.job
        where name = 'mr.comment.debounce' and state = 'created'`,
    )
  )[0]?.n ?? 0;

const nudgeWindow = (pipeline: PipelineE2E) =>
  pipeline.query(
    `update pgboss.job set start_after = now()
      where name = 'mr.comment.debounce' and state = 'created'`,
  );

/** See the docblock: the latest implementation run starts five minutes ago; answers that instant. */
const moveHorizonBack = async (pipeline: PipelineE2E, taskId: string): Promise<string> => {
  const rows = await pipeline.query<{ at: string }>(
    `update runs set started_at = now() - interval '5 minutes'
      where id = (select r.id from runs r join task_stages s on s.id = r.task_stage_id
                   where r.task_id = $1 and s.stage = 'implementation'
                   order by r.created_at desc, r.id desc limit 1)
      returning to_char(started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at`,
    [taskId],
  );
  const at = rows[0]?.at;
  if (at === undefined) throw new Error('the task has no implementation run to move');
  return at;
};

const justAfter = (iso: string): string => new Date(Date.parse(iso) + 1_000).toISOString();

/**
 * Waits for the task's `visit`-th entry into its human stage **and** for the two effects a case
 * then acts on: the window the entry armed (amendment (g)) and, with slots, the `qa` status written.
 */
const atHumanStage = async (
  pipeline: PipelineE2E,
  stage: 'qa' | 'ready_for_merge',
  visit: number,
): Promise<string> => {
  const task = await pipeline.settle(
    `${stage}, visit ${String(visit)}`,
    (snapshot) =>
      snapshot.current_stage === stage && (snapshot.stage_attempts[stage] ?? 0) === visit,
  );
  await pipeline.waitFor(
    'the window the entry armed',
    async () => (await openWindows(pipeline)) === 1,
  );
  if (stage === 'qa') {
    await pipeline.waitFor(
      'the qa status reached the ticket',
      async () => pipeline.tickets.peek(TICKET_KEY)?.status === LIFECYCLE.qa,
    );
  }
  return task.id;
};

/** Nudges the window until the task has been returned `count` times by a person's word. */
const returned = async (pipeline: PipelineE2E, count: number): Promise<void> =>
  pipeline.waitFor(`human return ${String(count)}`, async () => {
    await nudgeWindow(pipeline);
    return (await ofType(pipeline, 'task.human_return')).length >= count;
  });

/** A person's general note on the merge request, and the provider's note hook for it. */
const generalNote = async (pipeline: PipelineE2E, text: string, createdAt: string) => {
  const note = pipeline.git.addGeneralNote({
    project: GIT_PROJECT,
    iid: pipeline.world.mr.iid,
    authorId: QA_PERSON,
    text,
    resolvable: false,
    createdAt,
  });
  const hook = await pipeline.deliverGit(
    pipeline.git.emitReviewComment({
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      discussionId: note.id,
      authorId: QA_PERSON,
      text,
    }),
  );
  expect(hook.status).toBe(202);
  return note;
};

const ticketComment = async (pipeline: PipelineE2E, text: string, createdAt: string) => {
  const hook = await pipeline.deliver(
    pipeline.tickets.emitCommentAdded({
      ticketKey: TICKET_KEY,
      authorId: QA_PERSON,
      text,
      createdAt,
    }),
  );
  expect(hook.status).toBe(202);
};

const statusMovedByAPerson = async (pipeline: PipelineE2E, to: string) => {
  const from = pipeline.tickets.peek(TICKET_KEY)?.status ?? '';
  const hook = await pipeline.deliver(
    pipeline.tickets.emitStatusChanged({ ticketKey: TICKET_KEY, from, to }),
  );
  expect(hook.status).toBe(202);
};

/** QA passes: the person moves the ticket on from the `qa` status (TD-029 decision 9). */
const qaPasses = async (pipeline: PipelineE2E): Promise<void> => {
  await statusMovedByAPerson(pipeline, QA_PASSED);
  await pipeline.waitFor('QA passed to ready_for_merge', async () => {
    await nudgeWindow(pipeline);
    return (await pipeline.task()).current_stage === 'ready_for_merge';
  });
};

/** A person merges; the provider's merge hook arrives. */
const merges = async (pipeline: PipelineE2E): Promise<void> => {
  const hook = await pipeline.deliverGit(
    pipeline.git.emitMergeRequestEvent({
      event: 'mr.merged',
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
    }),
  );
  expect(hook.status).toBe(202);
  await pipeline.settle('done', (task) => task.state === 'done');
};

/** Nothing the pipeline decided is still owed: no dispatch, no outbound duty queued or running. */
const quiet = (pipeline: PipelineE2E) =>
  pipeline.waitFor('no dispatch and no outbound duty owed', async () => {
    const rows = await pipeline.query<{ owed: number }>(
      `select ((select count(*) from event_dispatch where dead_lettered_at is null)
             + (select count(*) from pgboss.job
                 where name = 'pipeline.outbound' and state in ('created', 'retry', 'active'))
             )::int as owed`,
    );
    return rows[0]?.owed === 0;
  });

const mergeRequestDiscussions = (pipeline: PipelineE2E) =>
  pipeline.git.listDiscussions({
    provider: 'fake-git',
    project_path: GIT_PROJECT,
    iid: pipeline.world.mr.iid,
    url: pipeline.world.mr.url,
  });

/** The Reviewer's findings of `code_review` attempt 1 are on the merge request. */
const findingsPosted = (pipeline: PipelineE2E) =>
  pipeline.waitFor('the review findings on the merge request', async () =>
    (await mergeRequestDiscussions(pipeline)).some((discussion) =>
      discussion.notes[0]?.body.trimStart().startsWith(FINDING_MARKER),
    ),
  );

/**
 * The fake model's work before it reports (`beforeReport`): a run that answers the conversation
 * reads it through `get_conversation` — the second-round runs once the findings are posted — and a
 * run the case holds waits for the case.
 */
const fakeModelWork =
  (
    current: { pipeline?: PipelineE2E },
    hold: ((spec: RunSpec) => Promise<void> | undefined) | undefined,
  ): NonNullable<StartPipelineOptions['beforeReport']> =>
  (spec, tools) => {
    runStep(spec);
    const held = hold?.(spec);
    if (!readsConversation(spec) && held === undefined) return undefined;
    return (async () => {
      await held;
      if (!readsConversation(spec)) return;
      const pipeline = current.pipeline;
      if (pipeline === undefined) throw new Error('a run started before the flow did');
      // The tool must be the role's to call, as `open_mr` must be the Developer's (WP-138): a role
      // that lost the grant fails the flow rather than reading through the harness.
      if (!spec.platformTools.includes('get_conversation')) {
        throw new Error(`the ${spec.stage ?? 'unstaged'} run is not given get_conversation`);
      }
      if (spec.attempt === 2) await findingsPosted(pipeline);
      const answer = await tools.getConversation(
        {},
        {
          runId: spec.runId,
          taskId: spec.taskId,
          projectId: spec.projectId,
          mode: spec.mode,
          signal: new AbortController().signal,
        },
      );
      readings.set(spec.runId, entriesOf(answer));
    })();
  };

const startFlow = async (
  label: string,
  options: {
    readonly slots: boolean;
    readonly hold?: (spec: RunSpec) => Promise<void> | undefined;
  },
) => {
  const ticket = TICKETS[0] as (typeof TICKETS)[number];
  const current: { pipeline?: PipelineE2E } = {};
  const pipeline = await startPipeline({
    scenarios: featureScenarios,
    scenarioFor,
    beforeReport: fakeModelWork(current, options.hold),
    label,
    // (iii) runs on the fake's default workflow: no status of it is named anywhere here.
    tickets: [options.slots ? { ...ticket, status: PICK_UP } : ticket],
    ...(options.slots ? { ticketStatuses: WORKFLOW } : {}),
    config: { version: 1 },
  });
  harness = pipeline;
  current.pipeline = pipeline;
  if (options.slots) {
    await pipeline.query(
      'update bindings set config = $3::jsonb where project_id = $1 and integration_id = $2',
      [
        pipeline.projectId,
        TICKETS_INTEGRATION_ID,
        JSON.stringify({ pickup_status: PICK_UP, lifecycle: LIFECYCLE }),
      ],
    );
  }
  const log = recordSteps(pipeline);
  await pipeline.publish([ticketMatched(pipeline)]);
  return { pipeline, moves: log };
};

// ── What every flow leaves behind ──────────────────────────────────────────────────

/** The stage entries a flow is about, in order. */
const STAGES_OF_INTEREST = new Set([
  'implementation',
  'code_review',
  'business_review',
  'qa',
  'ready_for_merge',
  'merged_gate',
]);

const stageEntries = async (pipeline: PipelineE2E): Promise<readonly string[]> =>
  (await ofType(pipeline, 'task.stage.entered'))
    .map((event) => String(payloadOf(event).stage))
    .filter((stage) => STAGES_OF_INTEREST.has(stage));

const returnsOf = async (pipeline: PipelineE2E) =>
  (await ofType(pipeline, 'task.stage.returned')).map((event) => [
    payloadOf(event).from_stage,
    payloadOf(event).to_stage,
  ]);

/** The position of the `nth` step of a kind (and detail) on the log; fails when there is none. */
const stepAt = (log: readonly Step[], kind: Step['kind'], detail?: string, nth = 0): number => {
  const positions = log.flatMap((step, index) =>
    step.kind === kind && (detail === undefined || step.detail === detail) ? [index] : [],
  );
  const position = positions[nth];
  expect(
    position,
    `step ${kind}${detail === undefined ? '' : ` ${detail}`} #${String(nth)}`,
  ).toBeDefined();
  return position as number;
};

const runAt = (log: readonly Step[], stage: string, attempt: number): number =>
  stepAt(log, 'run', `${stage}:${String(attempt)}`);

/**
 * The merge request's conversation after the flow: the Reviewer's two finding threads (one on a
 * line) each answered once in its thread and resolved; one summary per `code_review` completion;
 * and, for a person's general note, one reply arriving as a new general note (the fake's divergence
 * 31, GitLab's fallback) — that note itself never resolved.
 */
const expectReviewConversation = async (
  pipeline: PipelineE2E,
  log: readonly Step[],
  expected: { readonly reviews: number; readonly personNotes: number },
) => {
  const discussions = await mergeRequestDiscussions(pipeline);
  // (b) The merge request was opened (adopted: the harness's seeded one is on the task's branch)
  // by the first Developer run, before the first review began.
  const opened = pipeline.openMrAnswers()[0]?.answer as
    | { status?: string; iid?: number }
    | undefined;
  expect(['opened', 'adopted']).toContain(opened?.status);
  expect(opened?.iid).toBe(pipeline.world.mr.iid);
  expect(stepAt(log, 'open_mr')).toBeGreaterThan(runAt(log, 'implementation', 1));
  expect(stepAt(log, 'open_mr')).toBeLessThan(runAt(log, 'code_review', 1));
  // The findings are posted after the review that wrote them; each finding thread is answered by
  // the fix run, and resolved only after the re-review started **and** after its reply landed.
  expect(stepAt(log, 'thread', 'review-finding')).toBeGreaterThan(runAt(log, 'code_review', 1));
  const reReview = runAt(log, 'code_review', 2);
  const resolves = log.flatMap((step, index) => (step.kind === 'resolve' ? [{ step, index }] : []));
  expect(resolves).toHaveLength(2);
  for (const { step, index } of resolves) {
    expect(index).toBeGreaterThan(reReview);
    const reply = stepAt(log, 'reply', step.detail);
    expect(reply).toBeGreaterThan(runAt(log, 'implementation', 2));
    expect(index).toBeGreaterThan(reply);
  }
  const opensWith = (marker: string) =>
    discussions.filter((discussion) => discussion.notes[0]?.body.trimStart().startsWith(marker));
  const findings = opensWith(FINDING_MARKER);
  expect(findings).toHaveLength(2);
  expect(findings.map((thread) => [thread.notes[0]?.path, thread.notes[0]?.line])).toEqual([
    ['src/totals.ts', 1],
    [null, null],
  ]);
  for (const thread of findings) {
    expect(thread.resolved).toBe(true);
    expect(thread.notes.map((note) => note.body.trimStart().startsWith(REPLY_MARKER))).toEqual([
      false,
      true,
    ]);
    expect(thread.notes.map((note) => note.author.external_id)).toEqual([BOT, BOT]);
  }
  expect(opensWith(SUMMARY_MARKER)).toHaveLength(expected.reviews);
  const persons = discussions.filter(
    (discussion) => discussion.notes[0]?.author.external_id === QA_PERSON,
  );
  expect(persons).toHaveLength(expected.personNotes);
  for (const note of persons) {
    expect([note.resolvable, note.resolved]).toEqual([false, false]);
  }
  const generalReplies = opensWith(REPLY_MARKER);
  expect(generalReplies).toHaveLength(expected.personNotes);
  for (const reply of generalReplies) {
    expect(reply.notes[0]?.author.external_id).toBe(BOT);
    expect(reply.notes[0]?.body).toContain(`_In reply to note ${persons[0]?.notes[0]?.id ?? ''}._`);
  }
  for (const person of persons) {
    // The person's word is answered by the run after the human return, not before.
    expect(stepAt(log, 'reply', person.id)).toBeGreaterThan(runAt(log, 'implementation', 3));
  }
  const gitActions = pipeline.git.core.calls.map((call) => call.action);
  expect(gitActions.filter((action) => action === 'resolve_discussion')).toHaveLength(2);
  expect(gitActions.filter((action) => action === 'reply_to_discussion')).toHaveLength(
    2 + expected.personNotes,
  );
};

/** The tracker's side of a flow with every slot mapped. */
const expectLifecycleOnTheTracker = async (
  pipeline: PipelineE2E,
  log: readonly Step[],
  claims: number,
) => {
  const moves = transitionsIn(log).map((step) => ({ to: step.detail, changed: step.changed }));
  // Every transition that moved the ticket, by target name and in order (TD-029 decision 4). A
  // repeat of the status the ticket already holds (the claim's `in_progress` beside the entry's) is
  // asked and answered `changed: false`, and never anything but `in_progress`.
  expect(moves.filter((move) => move.changed).map((move) => move.to)).toEqual([
    LIFECYCLE.in_progress, // the claim
    LIFECYCLE.in_review,
    LIFECYCLE.in_progress, // the review returned it
    LIFECYCLE.in_review,
    LIFECYCLE.approved,
    LIFECYCLE.qa,
    LIFECYCLE.in_progress, // the re-claim after the human return
    LIFECYCLE.in_review,
    LIFECYCLE.approved,
    LIFECYCLE.qa,
    LIFECYCLE.done,
  ]);
  expect(
    [...new Set(moves.filter((move) => !move.changed).map((move) => move.to))].filter(
      (to) => to !== LIFECYCLE.in_progress,
    ),
  ).toEqual([]);
  // (a) Each claim lands before the Developer run it admits starts: on the log (the assign before
  // the fake model starts the run) and on the event log (`ticket.claimed` before `run.started`).
  expect(stepAt(log, 'assign', undefined, 0)).toBeLessThan(runAt(log, 'implementation', 1));
  expect(stepAt(log, 'assign', undefined, 1)).toBeGreaterThan(runAt(log, 'business_review', 1));
  expect(stepAt(log, 'assign', undefined, 1)).toBeLessThan(runAt(log, 'implementation', 3));
  const events = await pipeline.events();
  const implementationStarts = events.flatMap((event, position) => {
    if (event.type !== 'run.started') return [];
    const created = events.find(
      (other) =>
        other.type === 'run.created' && payloadOf(other).run_id === payloadOf(event).run_id,
    );
    return payloadOf(created).stage === 'implementation'
      ? [{ attempt: Number(payloadOf(created).attempt), position }]
      : [];
  });
  const claimedAt = events.flatMap((event, position) =>
    event.type === 'ticket.claimed' ? [position] : [],
  );
  // A missing run start throws rather than answering -1, which every `>` would pass (review).
  const startOf = (attempt: number): number => {
    const start = implementationStarts.find((candidate) => candidate.attempt === attempt);
    if (start === undefined) throw new Error(`no run.started for implementation:${attempt}`);
    return start.position;
  };
  expect(claimedAt[0]).toBeLessThan(startOf(1));
  expect(claimedAt[1]).toBeGreaterThan(startOf(2));
  expect(claimedAt[1]).toBeLessThan(startOf(3));
  // (d) Each `in_review` write lands at or after its `code_review` entry. **Not** before that
  // stage's run starts: the write is a `pipeline.outbound` duty that never blocks the stage (TD-029
  // decision 4), and on this tier's instant runs it landed after the review's run had started in
  // every flow (measured, WP-183 review round 1). The order against the other writes is the
  // sequence above.
  // `occurred_at` is read off the table: the harness's event reader does not select it.
  const reviewEntries = await pipeline.query<{ at: Date }>(
    `select occurred_at as at from events
      where type = 'task.stage.entered' and payload ->> 'stage' = 'code_review'
      order by position`,
  );
  const inReview = log.flatMap((step, index) =>
    step.kind === 'transition' && step.changed && step.detail === LIFECYCLE.in_review
      ? [{ step, index }]
      : [],
  );
  expect(inReview).toHaveLength(3);
  for (const [k, { step, index }] of inReview.entries()) {
    expect(step.at).toBeGreaterThanOrEqual(reviewEntries[k]?.at.getTime() ?? Number.NaN);
    expect(index).toBeGreaterThan(runAt(log, 'implementation', k + 1));
  }
  expect(stepAt(log, 'open_mr')).toBeLessThan(inReview[0]?.index ?? -1);
  const ticket = pipeline.tickets.peek(TICKET_KEY);
  expect(ticket?.status).toBe(LIFECYCLE.done);
  expect(ticket?.assignee).toBe(BOT);
  const actions = pipeline.tickets.core.calls.map((call) => call.action);
  expect(actions.filter((action) => action === 'assign_to_self')).toHaveLength(claims);
  expect(actions.filter((action) => action === 'unassign')).toHaveLength(0);
  const claimed = await ofType(pipeline, 'ticket.claimed');
  expect(claimed.map((event) => payloadOf(event).account_id)).toEqual(
    Array.from({ length: claims }, () => BOT),
  );
  expect(claimed.every((event) => payloadOf(event).in_progress_written === true)).toBe(true);
  expect(await ofType(pipeline, 'ticket.claim.refused')).toEqual([]);
  expect(await ofType(pipeline, 'ticket.released')).toEqual([]);
  const rows = await pipeline.query<{ ticket_claim: Record<string, unknown>; qa_stage: boolean }>(
    'select ticket_claim, qa_stage from tasks where project_id = $1',
    [pipeline.projectId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.qa_stage).toBe(true);
  expect(rows[0]?.ticket_claim).toMatchObject({ status: 'confirmed', account_id: BOT });
};

/** The stage walk of a flow with a `qa` stage and one return from it. */
const QA_WALK = [
  'implementation',
  'code_review',
  'implementation',
  'code_review',
  'business_review',
  'qa',
  'implementation',
  'code_review',
  'business_review',
  'qa',
  'ready_for_merge',
  'merged_gate',
];

const expectOneHumanReturn = async (
  pipeline: PipelineE2E,
  from: 'qa' | 'ready_for_merge',
  forms: readonly string[],
) => {
  const humanReturns = await ofType(pipeline, 'task.human_return');
  expect(
    humanReturns.map((event) => [payloadOf(event).from_stage, payloadOf(event).forms]),
  ).toEqual([[from, forms]]);
  expect(await returnsOf(pipeline)).toEqual([
    ['code_review', 'implementation'],
    [from, 'implementation'],
  ]);
};

/** The reason the return carried, which the next Developer run is given. */
const humanReturnReason = async (pipeline: PipelineE2E, from: string): Promise<string> =>
  String(
    payloadOf(
      (await ofType(pipeline, 'task.stage.returned')).find(
        (event) => payloadOf(event).from_stage === from,
      ),
    ).reason,
  );

/** The Developer answered the person's ticket comment on the ticket, once, with its marker. */
const expectTicketReply = async (pipeline: PipelineE2E) => {
  const comments = pipeline.tickets.peek(TICKET_KEY)?.comments ?? [];
  const replies = comments.filter(
    (comment) =>
      comment.body.trimStart().startsWith('agentic:reply:') ||
      comment.marker_id?.startsWith('agentic:reply:') === true,
  );
  expect(replies).toHaveLength(1);
  expect(replies[0]?.author.external_id).toBe(BOT);
  expect(comments.filter((comment) => comment.author.external_id === QA_PERSON)).toHaveLength(1);
};

// ── The flows ─────────────────────────────────────────────────────────────────

describe('the ticket lifecycle and the review conversation, end to end (WP-183)', () => {
  it('(i) every slot mapped: claim, review threads with replies, a QA return by a general note, a re-claim, a QA pass and the merge', async () => {
    const { pipeline, moves } = await startFlow('lifecycle-full', { slots: true });

    const taskId = await atHumanStage(pipeline, 'qa', 1);
    // The QA person takes the ticket, tests, and writes one general, non-resolvable note.
    pipeline.tickets.assignTo(TICKET_KEY, QA_PERSON);
    const horizon = await moveHorizonBack(pipeline, taskId);
    await generalNote(
      pipeline,
      'Tested on staging: the total is right, but the footer label should say "Total due".',
      justAfter(horizon),
    );
    await returned(pipeline, 1);

    await atHumanStage(pipeline, 'qa', 2);
    await qaPasses(pipeline);
    await merges(pipeline);
    await pipeline.waitFor(
      'the done status reached the ticket',
      async () => pipeline.tickets.peek(TICKET_KEY)?.status === LIFECYCLE.done,
    );
    await quiet(pipeline);

    expect(await stageEntries(pipeline)).toEqual(QA_WALK);
    await expectOneHumanReturn(pipeline, 'qa', ['mr_note']);
    expect(await humanReturnReason(pipeline, 'qa')).toContain('Total due');
    await expectLifecycleOnTheTracker(pipeline, moves, 2);
    await expectReviewConversation(pipeline, moves, { reviews: 3, personNotes: 1 });
    expect((await pipeline.task()).state).toBe('done');
  }, 300_000);

  describe('(ii) the QA return in each other form', () => {
    it('by a status change alone: the feedback is platform text and points the run at the conversation', async () => {
      const { pipeline, moves } = await startFlow('lifecycle-status', { slots: true });

      await atHumanStage(pipeline, 'qa', 1);
      await statusMovedByAPerson(pipeline, LIFECYCLE.returned[0]);
      await returned(pipeline, 1);

      await atHumanStage(pipeline, 'qa', 2);
      await qaPasses(pipeline);
      await merges(pipeline);
      await pipeline.waitFor(
        'the done status reached the ticket',
        async () => pipeline.tickets.peek(TICKET_KEY)?.status === LIFECYCLE.done,
      );
      await quiet(pipeline);

      expect(await stageEntries(pipeline)).toEqual(QA_WALK);
      await expectOneHumanReturn(pipeline, 'qa', ['status']);
      expect(payloadOf((await ofType(pipeline, 'task.human_return'))[0]).status).toBe(
        LIFECYCLE.returned[0],
      );
      expect(await humanReturnReason(pipeline, 'qa')).toContain('get_conversation');
      // The re-claim moves the ticket out of the returned status, as it moves it out of QA.
      await expectLifecycleOnTheTracker(pipeline, moves, 2);
      await expectReviewConversation(pipeline, moves, { reviews: 3, personNotes: 0 });
    }, 300_000);

    it('by a ticket comment alone, written at qa', async () => {
      const { pipeline, moves } = await startFlow('lifecycle-comment', { slots: true });

      const taskId = await atHumanStage(pipeline, 'qa', 1);
      const horizon = await moveHorizonBack(pipeline, taskId);
      await ticketComment(
        pipeline,
        'Tested on staging: please label the footer total "Total due".',
        justAfter(horizon),
      );
      await returned(pipeline, 1);

      await atHumanStage(pipeline, 'qa', 2);
      await qaPasses(pipeline);
      await merges(pipeline);
      await pipeline.waitFor(
        'the done status reached the ticket',
        async () => pipeline.tickets.peek(TICKET_KEY)?.status === LIFECYCLE.done,
      );
      await quiet(pipeline);

      expect(await stageEntries(pipeline)).toEqual(QA_WALK);
      await expectOneHumanReturn(pipeline, 'qa', ['ticket_comment']);
      expect(await humanReturnReason(pipeline, 'qa')).toContain('Total due');
      await expectLifecycleOnTheTracker(pipeline, moves, 2);
      await expectReviewConversation(pipeline, moves, { reviews: 3, personNotes: 0 });
      await expectTicketReply(pipeline);
    }, 300_000);

    it('by a ticket comment written during code_review, with no later signal: the entry into qa returns it (TD-029 decision 7 (g))', async () => {
      let heldReview: RunSpec | null = null;
      let release: () => void = () => {};
      const reviewHeld = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { pipeline, moves } = await startFlow('lifecycle-comment-before-qa', {
        slots: true,
        hold: (spec) => {
          if (spec.stage !== 'code_review' || spec.attempt !== 2) return undefined;
          heldReview = spec;
          return reviewHeld;
        },
      });

      await pipeline.waitFor(
        'the approving code review is running',
        async () => heldReview !== null,
      );
      const task = await pipeline.task();
      expect(task.current_stage).toBe('code_review');
      const horizon = await moveHorizonBack(pipeline, task.id);
      await ticketComment(
        pipeline,
        'While you review: please label the footer total "Total due".',
        justAfter(horizon),
      );
      await pipeline.waitFor(
        'the comment recorded',
        async () => (await ofType(pipeline, 'ticket.comment.added')).length === 1,
      );
      // At an agent stage the comment arms nothing: the window that returns the task is the entry's.
      expect(await openWindows(pipeline)).toBe(0);
      release();

      await atHumanStage(pipeline, 'qa', 1);
      // The one window this task ever had is the one the entry into `qa` armed, after the comment.
      expect(
        await pipeline.query(`select id from pgboss.job where name = 'mr.comment.debounce'`),
      ).toHaveLength(1);
      const types = (await pipeline.events()).map((event) => event.type);
      const qaEntry = (await pipeline.events()).findIndex(
        (event) => event.type === 'task.stage.entered' && payloadOf(event).stage === 'qa',
      );
      expect(types.indexOf('ticket.comment.added')).toBeLessThan(qaEntry);
      // No signal after the comment: only the entry's window is nudged.
      await returned(pipeline, 1);
      expect(await ofType(pipeline, 'ticket.comment.added')).toHaveLength(1);

      await atHumanStage(pipeline, 'qa', 2);
      await qaPasses(pipeline);
      await merges(pipeline);
      await pipeline.waitFor(
        'the done status reached the ticket',
        async () => pipeline.tickets.peek(TICKET_KEY)?.status === LIFECYCLE.done,
      );
      await quiet(pipeline);

      expect(await stageEntries(pipeline)).toEqual(QA_WALK);
      await expectOneHumanReturn(pipeline, 'qa', ['ticket_comment']);
      expect(await humanReturnReason(pipeline, 'qa')).toContain('Total due');
      await expectLifecycleOnTheTracker(pipeline, moves, 2);
      await expectReviewConversation(pipeline, moves, { reviews: 3, personNotes: 0 });
      await expectTicketReply(pipeline);
    }, 300_000);
  });

  it('(iii) no slot mapped, on the fake’s default workflow: no claim, no transition, no qa, and the review conversation and the Ready return as before', async () => {
    const { pipeline, moves } = await startFlow('lifecycle-none-flow', { slots: false });
    const statusAtStart = pipeline.tickets.peek(TICKET_KEY)?.status;

    const taskId = await atHumanStage(pipeline, 'ready_for_merge', 1);
    const horizon = await moveHorizonBack(pipeline, taskId);
    await generalNote(pipeline, 'Please label the footer total "Total due".', justAfter(horizon));
    await returned(pipeline, 1);

    await atHumanStage(pipeline, 'ready_for_merge', 2);
    await merges(pipeline);
    await quiet(pipeline);

    expect(await stageEntries(pipeline)).toEqual([
      'implementation',
      'code_review',
      'implementation',
      'code_review',
      'business_review',
      'ready_for_merge',
      'implementation',
      'code_review',
      'business_review',
      'ready_for_merge',
      'merged_gate',
    ]);
    await expectOneHumanReturn(pipeline, 'ready_for_merge', ['mr_note']);
    await expectReviewConversation(pipeline, moves, { reviews: 3, personNotes: 1 });

    // Zero assign, unassign or lifecycle calls of any kind (BD-031 ruling 2), and the ticket as it was.
    expect(transitionsIn(moves)).toEqual([]);
    const lifecycleCalls = new Set([
      'self_identity',
      'assign_to_self',
      'unassign',
      'transition',
      'list_statuses',
      'list_transitions',
    ]);
    expect(pipeline.tickets.core.calls.filter((call) => lifecycleCalls.has(call.action))).toEqual(
      [],
    );
    const auditActions = (await pipeline.auditRows()).map((row) => row.action);
    for (const action of ['assign_to_self', 'unassign', 'self_identity', 'transition_ticket']) {
      expect(auditActions).not.toContain(action);
    }
    expect(pipeline.tickets.peek(TICKET_KEY)?.status).toBe(statusAtStart);
    expect(pipeline.tickets.peek(TICKET_KEY)?.assignee ?? null).toBeNull();
    for (const type of ['ticket.claimed', 'ticket.claim.refused', 'ticket.released']) {
      expect(await ofType(pipeline, type)).toEqual([]);
    }
    const rows = await pipeline.query<{ ticket_claim: unknown; qa_stage: boolean; state: string }>(
      'select ticket_claim, qa_stage, state from tasks where project_id = $1',
      [pipeline.projectId],
    );
    expect(rows).toEqual([{ ticket_claim: null, qa_stage: false, state: 'done' }]);
    expect(
      await pipeline.query(`select id from task_stages where task_id = $1 and stage = 'qa'`, [
        taskId,
      ]),
    ).toEqual([]);
  }, 300_000);
});
