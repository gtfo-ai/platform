/**
 * What a human ends up with when an event is poisoned (WP-49, criterion 2).
 *
 * Driven through the **real** dispatcher and the real in-memory pipeline store rather than through
 * doubles, because the thing to prove is not that a function was called: it is that a task nobody
 * could have moved ends up in `needs_human`, exactly once, with a brief that names the event and the
 * handler — which is Q59's answer reused, and the same shape `escalateTaskAfterConflict` produces.
 *
 * The negative cases are the ones the mechanism turns on (standing rule 42): an event that names no
 * task, a task that no longer exists, and a task already parked all escalate **nothing** and none of
 * them stops the dead letter.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { FEATURE_TEMPLATE } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { DeadLetterRecord } from '../events/dead-letter.js';
import { DEFAULT_MAX_DISPATCH_ATTEMPTS, EventBus } from '../events/event-bus.js';
import type { EventHandler } from '../events/handler.js';
import { OutboxWorker } from '../events/outbox.js';
import type { StoredEvent } from '../ports/event-store.js';
import { makeEvent, streamId, taskQueued } from '../testing/fixtures.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { createMemoryPipelineStore } from '../testing/memory-pipeline.js';
import { createDeadLetterEscalation, taskOfEvent } from './dead-letter.js';
import type { StoredTask } from './store.js';
import { INITIAL_TASK_VERSION } from './store.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1' as Id;
const TASK = streamId(1);
const RUN = '00000000-0000-4000-8000-0000000000e1' as Id;
const BUDGET = '00000000-0000-4000-8000-0000000000b1' as Id;
const contextPack = () => ({ tier0: [], tier1: [], budget_tokens: 1_000, total_tokens: 0 });
const NOW = '2026-09-15T10:00:00.000Z' as IsoDateTime;

const task = (state: StoredTask['task']['state'] = 'active'): StoredTask => ({
  task: {
    id: TASK,
    projectId: PROJECT,
    ticket: { provider: 'fake-jira', key: 'ACME-9', url: 'https://jira.test/ACME-9' },
    template: 'feature',
    mode: 'normal',
    state,
    currentStage: 'implementation',
    stageAttempts: { implementation: 1 },
    iterationCounters: {},
    limits: {
      code_review: 3,
      business_review: 2,
      ci_fix: 3,
      human_rounds: 3,
      refinement_questions: 2,
      architecture_revisions: 2,
      rebase: 2,
      rebase_rechecks: 10,
      dependency_policy: 2,
    },
    sequence: 1,
  },
  template: FEATURE_TEMPLATE,
  priorityRank: 2,
  createdAt: '2026-09-15T08:00:00.000Z' as IsoDateTime,
  branch: null,
  mr: null,
  workpad: null,
  costActualUsd: 0,
  estimateUsd: null,
  estimateBasis: null,
  estimateSamples: null,
  ticketSnapshot: null,
  reviewSubject: null,
  historySample: null,
  riskClasses: [],
  coverage: null,
  dependencies: null,
  requiredReviewers: null,
  requestedByUserId: null,
  ticketSnapshotAt: null,
  ticketSignalAt: null,
  version: INITIAL_TASK_VERSION,
});

const poisoning = (message: string): EventHandler => ({
  name: 'core.workpad',
  priority: 110,
  eventTypes: ['task.queued'],
  handle: async () => {
    throw new Error(message);
  },
});

/** A bus wired the way `composePipeline` wires it, over a store holding one task. */
const world = async (options: { readonly state?: StoredTask['task']['state'] } = {}) => {
  const eventing = new MemoryEventing();
  // The aggregate's next sequence comes from the log, exactly as `TASK_COLUMNS` derives it in
  // PostgreSQL: the poisoned event is on the task's own stream, so an escalation that numbered
  // itself from the stored aggregate alone would collide with it (memory-pipeline, divergence 7).
  const store = createMemoryPipelineStore({
    streamSequence: (taskId) => eventing._committedLastSeq('task', taskId) + 1,
  });
  await eventing.transaction(async (scope) => {
    await store.tasks.insert(scope.tx, task(options.state ?? 'active'));
  });
  const bus = new EventBus({ unitOfWork: eventing, retryDelayMs: 0, maxRetryDelayMs: 0 });
  bus.onDeadLetter(
    createDeadLetterEscalation({
      store,
      context: (correlationId, causeEventId) => ({
        ids: { next: () => '00000000-0000-4000-8000-0000000000f1' as Id },
        actor: { kind: 'system', component: 'dispatcher' },
        clock: { now: () => NOW },
        correlationId,
        causeEventId,
      }),
    }),
  );
  const loadTask = async (): Promise<StoredTask | null> =>
    eventing.transaction(async (scope) => store.tasks.load(scope.tx, TASK));
  return { eventing, store, bus, loadTask };
};

/** Appends the next `task.queued` of the task's own stream, whatever the escalation has taken. */
const append = async (eventing: MemoryEventing): Promise<StoredEvent> => {
  const streamSeq = eventing._committedLastSeq('task', TASK) + 1;
  const [stored] = await eventing.transaction(async (scope) =>
    scope.events.append([taskQueued({ streamType: 'task', streamId: TASK, streamSeq })]),
  );
  if (stored === undefined) {
    throw new Error('append returned nothing');
  }
  return stored;
};

const poison = async (bus: EventBus, event: StoredEvent): Promise<void> => {
  for (let attempt = 1; attempt <= DEFAULT_MAX_DISPATCH_ATTEMPTS; attempt += 1) {
    await bus.dispatch(event);
  }
};

const escalations = (eventing: MemoryEventing) =>
  eventing.log.filter((stored) => stored.event.type === 'task.escalated');

describe('the dead-letter escalation', () => {
  it('parks the task in needs_human with a brief naming the event and the handler', async () => {
    const { eventing, bus, loadTask } = await world();
    bus.register(poisoning('ECONNREFUSED https://jira.internal/rest/api/3/issue/ACME-9'));
    const event = await append(eventing);

    await poison(bus, event);

    expect((await loadTask())?.task.state).toBe('needs_human');
    const escalated = escalations(eventing);
    expect(escalated).toHaveLength(1);
    const payload = escalated[0]?.event.payload as { reason: string; blocker_brief: string };
    expect(payload.reason).toContain(`event ${event.position}`);
    expect(payload.reason).toContain('core.workpad');
    expect(payload.blocker_brief).toContain(`Event ${event.position}`);
    expect(payload.blocker_brief).toContain('task.queued');
    expect(payload.blocker_brief).toContain('core.workpad');
    expect(payload.blocker_brief).toContain('ACME-9');
    // The one thing it must not repeat: the handler's error text. Nothing on this path holds a
    // redactor, and an error may quote a provider, a URL or a credential (BD-022, Q59's answer at
    // the other escalation). It is on the queue row and in the log instead.
    expect(payload.blocker_brief).not.toContain('ECONNREFUSED');
    expect(payload.blocker_brief).not.toContain('jira.internal');
    expect(payload.reason).not.toContain('ECONNREFUSED');
  });

  it('links the escalation to the event that caused it, under the dispatcher’s own actor', async () => {
    const { eventing, bus } = await world();
    bus.register(poisoning('deterministic'));
    const event = await append(eventing);

    await poison(bus, event);

    const escalated = escalations(eventing)[0]?.event;
    expect(escalated?.cause_event_id).toBe(event.event.id);
    expect(escalated?.correlation_id).toBe(TASK);
    expect(escalated?.actor).toEqual({ kind: 'system', component: 'dispatcher' });
  });

  it('escalates once: a later dispatch of the same dead-lettered event writes nothing', async () => {
    const { eventing, bus, loadTask } = await world();
    bus.register(poisoning('deterministic'));
    const event = await append(eventing);
    await poison(bus, event);

    const before = eventing.log.length;
    expect((await bus.dispatch(event)).status).toBe('dead-lettered');

    expect(eventing.log).toHaveLength(before);
    expect(escalations(eventing)).toHaveLength(1);
    expect((await loadTask())?.task.state).toBe('needs_human');
  });

  it('writes nothing for a second poisoned event of a task that is already parked', async () => {
    const { eventing, bus, loadTask } = await world();
    bus.register(poisoning('deterministic'));
    await poison(bus, await append(eventing));
    // The escalation is an event of the same stream, so it has to be dispatched before the next
    // one is anything but `blocked` — which is the stream moving on, in one line.
    await new OutboxWorker({ bus, store: eventing.store }).drain();
    const before = eventing.log.length;

    // The escalation moved the task to `needs_human`, and technical/02's table has no
    // `needs_human → needs_human` edge, so the aggregate is what refuses rather than a flag.
    await poison(bus, await append(eventing));

    expect(escalations(eventing)).toHaveLength(1);
    expect(eventing.log.length).toBe(before + 1); // the second `task.queued`, nothing else
    expect((await loadTask())?.task.state).toBe('needs_human');
    // Both events are out of the queue, which is the half that does not depend on the task at all.
    expect(await eventing.store.countDeadLettered()).toBe(2);
  });

  it('dead-letters an event that names no task, and escalates nothing', async () => {
    const { eventing, store } = await world();
    const sink = createDeadLetterEscalation({
      store,
      context: (correlationId, causeEventId) => ({
        ids: { next: () => '00000000-0000-4000-8000-0000000000f1' as Id },
        actor: { kind: 'system', component: 'dispatcher' },
        clock: { now: () => NOW },
        correlationId,
        causeEventId,
      }),
    });
    const orgEvent = makeEvent(
      'budget.exhausted',
      {
        project_id: null,
        budget_id: BUDGET,
        scope: 'org',
        scope_id: null,
        window: 'month',
        limit_usd: 10,
        spent_usd: 11,
      },
      { streamType: 'budget', streamId: BUDGET, streamSeq: 1 },
    );
    const record: DeadLetterRecord = {
      event: { position: 42, causeEventPosition: null, event: orgEvent },
      handler: 'notify.budget',
      attempts: DEFAULT_MAX_DISPATCH_ATTEMPTS,
      error: 'Error: no chat binding',
    };

    await eventing.transaction(async (scope) => sink(scope, record));

    // The ending for an event with no task: the dead letter stands (it is the dispatcher's, and it
    // has already happened by the time this runs), nothing is parked, and the signal a human gets
    // is the `event_dispatch_dead_lettered` gauge plus the bus's error line. Inventing a task here
    // would put a maintenance fault in somebody's work queue.
    expect(eventing.log).toHaveLength(0);
  });

  it('escalates the task an event is *about* when the event is on another stream', async () => {
    const { eventing, store } = await world();
    const sink = createDeadLetterEscalation({
      store,
      context: (correlationId, causeEventId) => ({
        ids: { next: () => '00000000-0000-4000-8000-0000000000f2' as Id },
        actor: { kind: 'system', component: 'dispatcher' },
        clock: { now: () => NOW },
        correlationId,
        causeEventId,
      }),
    });
    const runEvent = makeEvent(
      'run.started',
      {
        project_id: PROJECT,
        task_id: TASK,
        run_id: RUN,
        model: 'claude-opus-5',
        effort: 'high',
        prompt_version: 'developer@1',
        context_pack: contextPack(),
      },
      { streamType: 'run', streamId: RUN, streamSeq: 2 },
      { correlationId: TASK },
    );
    const record: DeadLetterRecord = {
      event: { position: 7, causeEventPosition: null, event: runEvent },
      handler: 'core.saga',
      attempts: DEFAULT_MAX_DISPATCH_ATTEMPTS,
      error: 'Error: deterministic',
    };

    await eventing.transaction(async (scope) => sink(scope, record));

    expect(escalations(eventing)).toHaveLength(1);
    expect(
      await eventing.transaction(async (scope) => store.tasks.load(scope.tx, TASK)),
    ).toMatchObject({ task: { state: 'needs_human' } });
  });

  it('reads the task from the stream when there is one, and from the correlation otherwise', () => {
    const taskEvent = taskQueued({ streamType: 'task', streamId: TASK, streamSeq: 1 });
    const stray = makeEvent(
      'run.started',
      {
        project_id: PROJECT,
        task_id: TASK,
        run_id: RUN,
        model: 'claude-opus-5',
        effort: 'high',
        prompt_version: 'developer@1',
        context_pack: contextPack(),
      },
      { streamType: 'run', streamId: RUN, streamSeq: 1 },
    );
    const record = (event: typeof stray | typeof taskEvent): DeadLetterRecord => ({
      event: { position: 1, causeEventPosition: null, event },
      handler: 'core.saga',
      attempts: 1,
      error: 'Error: x',
    });

    expect(taskOfEvent(record(taskEvent))).toBe(TASK);
    expect(taskOfEvent(record(stray))).toBeNull();
  });
});
