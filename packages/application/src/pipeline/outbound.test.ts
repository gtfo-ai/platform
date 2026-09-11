/**
 * WP-15d: the three sites that used to call a provider from inside a handler's transaction.
 *
 * They are a **set** — the intake branch check, the workpad render, the ticket status — so the
 * tests are parameterised over the same set rather than over the one that was remembered (standing
 * rule 68: when a behaviour is parameterised over a set, the test must be too, or the set is
 * decoration). Each site is asserted from both sides, because an assertion satisfied by every
 * branch certifies the observable and not the code (rule 10):
 *
 *  - **committed**: the dispatch reaches no provider *and* leaves exactly one `pipeline.outbound`
 *    job, and running that job reaches the provider. The second half is what stops this file from
 *    passing on a pipeline that simply stopped talking to providers;
 *  - **rolled back**: a handler transaction that does not commit reaches no provider and leaves no
 *    job, which is the compensation question answered — nothing un-does a comment posted for a task
 *    that never existed, so it is never posted.
 */
import { type DomainEvent, domainEventSchemasByType, type Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../events/event-bus.js';
import { transactionIsOpen } from '../events/open-transaction.js';
import type { StoredEvent } from '../ports/event-store.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import {
  integrationsForProject,
  noRunScopedSecrets,
  staticPipelineIntegrations,
} from './integrations.js';
import type { PipelineOutboundData } from './jobs.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;

interface ProviderCalls {
  defaultBranch: number;
  upsertWorkpad: number;
  transition: number;
}

const harnessWith = (calls: ProviderCalls): PipelineHarness =>
  createPipelineHarness({
    projectId: PROJECT,
    settings: { config: { status_mapping: { waiting_answers: 'Waiting for input' } } },
    runs: {
      refinement: {
        status: 'completed',
        terminalReason: 'success',
        // Parks the task at `waiting_answers` after one stage: enough of a task to render.
        structuredOutput: { decision: 'ask', questions: [{ id: 'q1', text: 'Which currency?' }] },
      },
    },
    git: {
      getDefaultBranchHead: (async () => {
        calls.defaultBranch += 1;
        return { branch: 'main', sha: 'a'.repeat(40) };
      }) as never,
    },
    taskManagement: {
      upsertWorkpad: (async () => {
        calls.upsertWorkpad += 1;
        return {
          provider: 'fake-jira',
          ticket_key: 'ACME-1',
          comment_id: 'comment-1',
          url: null,
        };
      }) as never,
      transition: (async (_ref: unknown, to: string) => {
        calls.transition += 1;
        return { changed: true, from: 'To Do', to };
      }) as never,
    },
  });

const noCalls = (): ProviderCalls => ({ defaultBranch: 0, upsertWorkpad: 0, transition: 0 });

let stream = 0;
const event = <T extends DomainEvent['type']>(
  type: T,
  payload: Extract<DomainEvent, { type: T }>['payload'],
): DomainEvent => {
  stream += 1;
  const suffix = stream.toString(16).padStart(12, '0');
  return domainEventSchemasByType[type].parse({
    id: `00000000-0000-4000-9000-${suffix}`,
    stream_type: 'project',
    stream_id: `00000000-0000-4000-8000-${suffix}`,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type,
    payload,
  }) as DomainEvent;
};

const ticketMatched = (key = 'ACME-1') =>
  event('ticket.matched', {
    project_id: PROJECT,
    ticket: { provider: 'fake-jira', key, url: `https://jira.example.test/${key}` },
    rule: 'label:agentic',
    priority: 'High',
    issue_type: 'Story',
    epic: null,
    links: [],
  });

const escalated = (taskId: Id) =>
  event('task.escalated', {
    project_id: PROJECT,
    task_id: taskId,
    reason: 'a human is needed',
    blocker_brief: 'Decide whether the invoice footer should sum hidden rows.',
  });

/** Appends the event the way an adapter would and hands back what the bus dispatches. */
const appended = async (
  harness: PipelineHarness,
  domainEvent: DomainEvent,
): Promise<StoredEvent> => {
  const [stored] = await harness.memory.transaction(async (scope) =>
    scope.events.append([domainEvent]),
  );
  if (stored === undefined) {
    throw new Error('the event was not appended');
  }
  return stored;
};

/** A unit of work that runs the work and then rolls it back, like a failing commit. */
const rollsBack = (inner: UnitOfWork): UnitOfWork => ({
  transaction: async <T>(fn: (scope: TransactionScope) => Promise<T>): Promise<T> => {
    await inner.transaction(fn);
    throw new Error('the handler transaction rolled back');
  },
});

const outboundJobs = (harness: PipelineHarness): readonly PipelineOutboundData[] =>
  harness.jobs
    .take(JOB_QUEUES.pipelineOutbound)
    .map((request) => request.data as PipelineOutboundData);

/** Runs one outbound job the way the worker does. */
const runOutbound = async (harness: PipelineHarness, data: PipelineOutboundData): Promise<void> => {
  await harness.runtime.start();
  const handler = harness.jobs.handlers.get(JOB_QUEUES.pipelineOutbound);
  if (handler === undefined) {
    throw new Error('no worker is subscribed to the outbound queue');
  }
  await handler({
    id: `job-${data.duty}`,
    queue: JOB_QUEUES.pipelineOutbound,
    data,
    signal: AbortSignal.abort(),
  });
};

/** A task parked at `waiting_answers`, so the workpad and the status have something to say. */
const parkedTask = async (harness: PipelineHarness, calls: ProviderCalls): Promise<Id> => {
  await harness.publish([ticketMatched()]);
  const [task] = harness.store.snapshot();
  if (task === undefined) {
    throw new Error('intake created no task');
  }
  calls.defaultBranch = 0;
  calls.upsertWorkpad = 0;
  calls.transition = 0;
  return task.task.id;
};

interface Site {
  readonly name: string;
  readonly duty: PipelineOutboundData['duty'];
  /** The event that makes this site's handler decide on a provider call. */
  trigger(harness: PipelineHarness, calls: ProviderCalls): Promise<DomainEvent>;
  /** How many times this site's provider method was entered. */
  entered(calls: ProviderCalls): number;
}

const SITES: readonly Site[] = [
  {
    name: 'the intake branch check',
    duty: 'intake_check',
    trigger: async () => ticketMatched(),
    entered: (calls) => calls.defaultBranch,
  },
  {
    name: 'the workpad render',
    duty: 'workpad',
    trigger: async (harness, calls) => escalated(await parkedTask(harness, calls)),
    entered: (calls) => calls.upsertWorkpad,
  },
  {
    name: 'the ticket status transition',
    duty: 'status',
    trigger: async (harness, calls) => escalated(await parkedTask(harness, calls)),
    entered: (calls) => calls.transition,
  },
];

describe.each(SITES)('$name', (site) => {
  it('reaches no provider while the handler runs, and leaves a job that does', async () => {
    const calls = noCalls();
    const harness = harnessWith(calls);
    const trigger = await site.trigger(harness, calls);

    outboundJobs(harness);
    await harness.bus.dispatch(await appended(harness, trigger));

    // Nothing was called from inside the dispatch — the whole of this work package.
    expect(site.entered(calls)).toBe(0);

    const jobs = outboundJobs(harness).filter((data) => data.duty === site.duty);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.cause_event_id).toBe(trigger.id);

    // …and the call still happens, which is what stops this file from passing on a pipeline that
    // stopped talking to providers altogether (standing rule 29).
    await runOutbound(harness, jobs[0] as PipelineOutboundData);
    expect(site.entered(calls)).toBe(1);
  });

  it('reaches no provider at all when the handler transaction rolls back', async () => {
    const calls = noCalls();
    const harness = harnessWith(calls);
    const trigger = await site.trigger(harness, calls);
    const stored = await appended(harness, trigger);
    outboundJobs(harness);

    const bus = new EventBus({
      unitOfWork: rollsBack(harness.memory),
      retryDelayMs: 0,
      maxRetryDelayMs: 0,
    });
    for (const handler of harness.runtime.handlers) {
      bus.register(handler);
    }
    await bus.dispatch(stored).catch(() => undefined);

    // Nothing was posted for a decision that never committed, and nothing was queued to post it
    // later: `afterCommit` runs after the commit, and there was none.
    expect(site.entered(calls)).toBe(0);
    expect(outboundJobs(harness)).toEqual([]);
  });
});

describe('the refusal, on the paths a later work package will take', () => {
  it('fails the next handler that reaches for a provider, rather than the production pool', async () => {
    const harness = harnessWith(noCalls());
    // The handler this work package exists to make impossible, written out: a core-band handler
    // that resolves the project's bindings while its transaction is open.
    harness.bus.register({
      name: 'pipeline.regression',
      priority: 11,
      eventTypes: ['ticket.matched'],
      handle: async () => {
        await integrationsForProject(
          staticPipelineIntegrations(harness.integrations),
          PROJECT,
          noRunScopedSecrets(),
        );
      },
    });

    const result = await harness.bus.dispatch(await appended(harness, ticketMatched('ACME-9')));

    const outcome = result.handlers.find((entry) => entry.handler === 'pipeline.regression');
    expect(outcome?.result).toBe('failed');
    expect(outcome?.error).toContain('inside an open database transaction');
  });

  it('marks the job path’s transactions too, so a job that tried would be refused as well', async () => {
    const calls = noCalls();
    const harness = harnessWith(calls);
    const taskId = await parkedTask(harness, calls);
    await harness.runtime.start();

    // The duty's first step is a load inside a transaction of its own. What is asserted is that the
    // mark is set there — i.e. that `createPipelineRuntime` wrapped the unit of work it was given,
    // which is what would refuse a *job* that called a provider from inside one. Removing
    // `markTransactions` from `runtime.ts` leaves this `false`.
    const inTransaction: boolean[] = [];
    const tasks = harness.store.tasks as { load: typeof harness.store.tasks.load };
    const load = tasks.load.bind(harness.store.tasks);
    tasks.load = async (tx, id) => {
      inTransaction.push(transactionIsOpen());
      return load(tx, id);
    };

    await runOutbound(harness, {
      duty: 'workpad',
      project_id: PROJECT,
      task_id: taskId,
      cause_event_id: '00000000-0000-4000-9000-00000000000f',
    });

    expect(inTransaction).not.toEqual([]);
    expect(inTransaction.every(Boolean)).toBe(true);
  });
});

describe('a wake-up that was lost', () => {
  it.each(SITES)('still reaches the provider when $name fires later', async (site) => {
    const calls = noCalls();
    const harness = harnessWith(calls);
    const trigger = await site.trigger(harness, calls);
    outboundJobs(harness);
    await harness.bus.dispatch(await appended(harness, trigger));

    // The crash `afterCommit` documents: the handler's effect is committed and the callback that
    // would have enqueued the wake-up never ran. Take the data it would have carried and drop it.
    const [data] = outboundJobs(harness).filter((entry) => entry.duty === site.duty);
    expect(site.entered(calls)).toBe(0);

    // The job's next fire — a redelivery, or the same wake-up arriving late — re-validates from
    // committed state and does the work anyway. Nothing was held in the handler's memory.
    await runOutbound(harness, data as PipelineOutboundData);
    expect(site.entered(calls)).toBe(1);
  });

  it('creates the task the intake check was about, however late it fires', async () => {
    const calls = noCalls();
    const harness = harnessWith(calls);
    outboundJobs(harness);
    await harness.bus.dispatch(await appended(harness, ticketMatched('ACME-7')));
    const [data] = outboundJobs(harness);
    // Nothing was written by the handler: no half-intaken task for the scheduler to start behind
    // the branch check's back.
    expect(harness.store.snapshot()).toHaveLength(0);

    await runOutbound(harness, data as PipelineOutboundData);
    expect(harness.store.snapshot().map((stored) => stored.task.ticket.key)).toEqual(['ACME-7']);
  });

  it('does nothing the second time, because the job re-validates rather than trusting its payload', async () => {
    const calls = noCalls();
    const harness = harnessWith(calls);
    outboundJobs(harness);
    await harness.bus.dispatch(await appended(harness, ticketMatched('ACME-8')));
    const [data] = outboundJobs(harness);

    await runOutbound(harness, data as PipelineOutboundData);
    await runOutbound(harness, data as PipelineOutboundData);

    expect(harness.store.snapshot()).toHaveLength(1);
    // The second fire found the task already there and never asked the provider again.
    expect(calls.defaultBranch).toBe(1);
  });
});

describe('a ticket write that is delivered twice', () => {
  it('replays instead of writing again, through the idempotency store the executor was given', async () => {
    const calls = noCalls();
    const harness = harnessWith(calls);
    const taskId = await parkedTask(harness, calls);
    outboundJobs(harness);
    await harness.bus.dispatch(await appended(harness, escalated(taskId)));
    const [workpad] = outboundJobs(harness).filter((data) => data.duty === 'workpad');

    await runOutbound(harness, workpad as PipelineOutboundData);
    await runOutbound(harness, workpad as PipelineOutboundData);

    // A job is at-least-once (TD-004): pg-boss re-delivers one whose lease expired and retries one
    // that threw after the provider had already answered. The `IdempotencyPlan` keyed by the cause
    // event is what makes the second delivery a replay rather than a second comment — and this is
    // the first assertion in the repository that the store composed into the executor is used at
    // all (standing rule 35: a required dependency is *supplied*, not *used*).
    expect(calls.upsertWorkpad).toBe(1);
    // One stored key for this wake-up, under the scope the executor chose — and the second
    // delivery answered out of it rather than from the provider.
    expect(
      harness.idempotency
        .keys()
        .filter((key) => key.includes(workpad?.cause_event_id ?? 'no such event')),
    ).toHaveLength(1);
    expect(harness.audit.entries.filter((entry) => entry.status === 'replayed')).toHaveLength(1);
  });

  it('writes again for the next event, because the key is the wake-up and not the task', async () => {
    const calls = noCalls();
    const harness = harnessWith(calls);
    const taskId = await parkedTask(harness, calls);
    outboundJobs(harness);

    for (const one of [escalated(taskId), escalated(taskId)]) {
      await harness.bus.dispatch(await appended(harness, one));
    }
    for (const data of outboundJobs(harness).filter((entry) => entry.duty === 'workpad')) {
      await runOutbound(harness, data);
    }

    // Two events, two renders: a key stable across events would leave the ticket showing the task's
    // first state for ever, which is the failure a "one comment per task" key would have.
    expect(calls.upsertWorkpad).toBe(2);
  });
});
