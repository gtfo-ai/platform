/**
 * Resolve on merge (WP-111, PROGRESS backlog 302) against hand-written port doubles and the real
 * `IntegrationActionExecutor` over the memory audit log and idempotency store — this ring may not
 * import the fakes in `@platform/integrations`; the fakes' and Sentry's own behaviour (the flag off
 * by default, both ways) is held by the shared contract suite.
 *
 * Every assertion is on a countable effect: the audit rows the executor wrote, the provider calls
 * the double recorded, the jobs the handler enqueued.
 */
import type { DomainEvent, Id, IsoDateTime, TaskMode, TicketSnapshot } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../events/handler.js';
import { TransactionOpenError, withOpenTransaction } from '../events/open-transaction.js';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { allowAnyIntegrationHost } from '../integrations/egress.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { IntegrationError, type IntegrationRef } from '../ports/integrations/common.js';
import type { Issue, ObservabilityErrorsPort } from '../ports/integrations/observability-errors.js';
import type { Jobs } from '../ports/jobs.js';
import {
  createMemoryAuditLog,
  createMemoryIdempotencyStore,
  createVirtualTimer,
} from '../testing/memory-integrations.js';
import type { PipelineIntegrationsPort } from './integrations.js';
import type { PipelineOutboundData } from './jobs.js';
import {
  type ResolveOnMergeOptions,
  resolveOnMergeHandler,
  resolveOnMergeKey,
  runResolveOnMerge,
} from './resolve-on-merge.js';
import type { StoredTask } from './store.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b2' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c2' as Id;
const ERRORS_ID = '00000000-0000-4000-8000-0000000000e2' as Id;
const EVENT = '00000000-0000-4000-9000-0000000000d2' as Id;
const BASE = 'https://errors.example.test/issues/';

const snapshotWith = (description: string): TicketSnapshot => ({
  title: 'The footer sums the wrong rows',
  description,
  comments: [],
  truncated: false,
  comment_count: 0,
  redaction_count: 0,
  ticket_updated_at: null,
});

const storedTask = (
  options: {
    readonly template?: string;
    readonly mode?: TaskMode;
    readonly snapshot?: TicketSnapshot | null;
  } = {},
): StoredTask =>
  ({
    task: {
      id: TASK,
      projectId: PROJECT,
      template: options.template ?? 'bug',
      mode: options.mode ?? 'normal',
    },
    ticketSnapshot:
      options.snapshot === undefined
        ? snapshotWith(`Sentry says ${BASE}101 and ${BASE}102, and again ${BASE}101.`)
        : options.snapshot,
  }) as unknown as StoredTask;

const issue = (id: string, status: Issue['status']): Issue => ({
  ref: { provider: 'double-errors', id, short_id: null, url: `${BASE}${id}` },
  project: 'api',
  title: 'TypeError',
  culprit: 'src/billing/totals.ts',
  level: 'error',
  status,
  first_seen: '2026-05-30T08:00:00.000Z',
  last_seen: '2026-06-01T09:00:00.000Z',
  count: 1,
  user_count: null,
  assigned_to: null,
});

const REF: IntegrationRef = {
  integrationId: ERRORS_ID,
  provider: 'double-errors',
  type: 'errors',
  host: null,
};

interface Doubles {
  readonly flagged?: boolean;
  /** An error per issue id, thrown by `resolve`. */
  readonly failures?: Readonly<Record<string, Error>>;
}

type Binding = 'present' | 'absent' | Error;

const world = (binding: Binding, task: StoredTask | null = storedTask(), doubles: Doubles = {}) => {
  const audit = createMemoryAuditLog();
  const executor = createIntegrationActionExecutor({
    egress: allowAnyIntegrationHost(),
    auditLog: audit,
    redactor: exactSecretRedactor([]),
    timer: createVirtualTimer({ autoAdvance: true }),
    clock: { now: () => '2026-06-01T10:00:00.000Z' as IsoDateTime },
    idempotencyStore: createMemoryIdempotencyStore(),
  });
  const resolved: string[] = [];
  const port = {
    ref: REF,
    // The double's own link rule; the shared suite holds the real ones.
    linkedIssues: (text: string) =>
      [...new Set([...text.matchAll(/issues\/(\d+)/g)].map((match) => match[1] as string))].map(
        (id) => ({ id }),
      ),
    resolveOnMerge: () => doubles.flagged ?? true,
    resolve: async (ref: { id: string }) => {
      const failure = doubles.failures?.[ref.id];
      if (failure !== undefined) {
        throw failure;
      }
      resolved.push(ref.id);
      return issue(ref.id, 'resolved');
    },
    comment: async () => {
      throw new Error('resolve on merge must never comment (Q43)');
    },
    linkMergeRequest: async () => {
      throw new Error('resolve on merge must never link a merge request (Q43)');
    },
  } as unknown as ObservabilityErrorsPort;
  const resolutions: string[] = [];
  const integrations = {
    forProject: async () => {
      throw new Error('resolve on merge must not resolve the pipeline’s bindings');
    },
    forMintingIntegration: async () => null,
    forObservability: async (_projectId: Id, type: 'errors' | 'logs') => {
      resolutions.push(type);
      if (binding instanceof Error) throw binding;
      if (binding === 'absent') return null;
      return { executor, port, ref: REF, redactor: exactSecretRedactor([]) };
    },
  } as unknown as PipelineIntegrationsPort;
  const loads: Id[] = [];
  const options = {
    store: {
      tasks: {
        load: async (_tx: unknown, id: Id) => {
          loads.push(id);
          return task;
        },
      },
    },
    unitOfWork: { transaction: async (work: (scope: unknown) => unknown) => work({ tx: {} }) },
    integrations,
  } as unknown as ResolveOnMergeOptions;
  const data: PipelineOutboundData = {
    duty: 'resolve_on_merge',
    project_id: PROJECT,
    task_id: TASK,
    cause_event_id: EVENT,
  };
  const rows = () =>
    audit.entries
      .filter((entry) => entry.action === 'resolve_issue')
      .map((entry) => ({ status: entry.status, payload: entry.payload }));
  return {
    audit,
    resolved,
    resolutions,
    loads,
    rows,
    /** `causeEventId` overrides the wake-up's event, as a second distinct `mr.merged` would. */
    run: (causeEventId: Id = EVENT) =>
      runResolveOnMerge(options, { ...data, cause_event_id: causeEventId }),
  };
};

describe('resolve on merge — the duty (WP-111)', () => {
  it('resolves every issue the bug ticket links, once each, one audited call per issue', async () => {
    const w = world('present');
    await w.run();
    expect(w.resolved, 'each linked issue once, in order of first appearance').toEqual([
      '101',
      '102',
    ]);
    expect(w.rows()).toEqual([
      { status: 'ok', payload: { issue_id: '101' } },
      { status: 'ok', payload: { issue_id: '102' } },
    ]);
  });

  it('resolves nothing twice: a second wake-up for the same task, from another event, replays', async () => {
    const w = world('present');
    await w.run();
    // A different event: a key built from the wake-up would resolve again (review round 1).
    await w.run('00000000-0000-4000-9000-0000000000d3' as Id);
    expect(w.resolved, 'the provider was called once per issue').toEqual(['101', '102']);
    expect(w.rows().map((row) => row.status)).toEqual(['ok', 'ok', 'replayed', 'replayed']);
  });

  it('calls nothing and writes no row on a binding that does not set the flag', async () => {
    const w = world('present', storedTask(), { flagged: false });
    await w.run();
    expect(w.resolutions, 'the binding was asked').toEqual(['errors']);
    expect(w.resolved).toEqual([]);
    expect(w.audit.entries).toEqual([]);
  });

  it('calls nothing for a project with no errors binding', async () => {
    const w = world('absent');
    await w.run();
    expect(w.resolutions).toEqual(['errors']);
    expect(w.audit.entries).toEqual([]);
  });

  it('re-validates on fire: a task that is gone, or is not a bug task, resolves no binding', async () => {
    const gone = world('present', null);
    await gone.run();
    expect(gone.loads).toEqual([TASK]);
    expect(gone.resolutions).toEqual([]);
    const feature = world('present', storedTask({ template: 'feature' }));
    await feature.run();
    expect(feature.resolutions).toEqual([]);
    expect(feature.audit.entries).toEqual([]);
  });

  it('records would_have for a shadow task and calls the provider for none', async () => {
    const w = world('present', storedTask({ mode: 'shadow' }));
    await w.run();
    expect(w.resolved).toEqual([]);
    expect(w.rows().map((row) => row.status)).toEqual(['would_have', 'would_have']);
  });

  it('resolves nothing for a task with no ticket snapshot, and for a ticket with no link', async () => {
    const none = world('present', storedTask({ snapshot: null }));
    await none.run();
    expect(none.audit.entries).toEqual([]);
    const unlinked = world('present', storedTask({ snapshot: snapshotWith('no link here') }));
    await unlinked.run();
    expect(unlinked.audit.entries).toEqual([]);
  });

  it('fails the job when the errors binding will not load — broken is not absent', async () => {
    const w = world(new Error('the sealed token does not decrypt'));
    await expect(w.run()).rejects.toThrow('does not decrypt');
  });

  it('goes on past an issue Sentry refuses for good, and fails the job for one a retry may cure', async () => {
    const lasting = world('present', storedTask(), {
      failures: { '101': new IntegrationError('not_found', 'double-errors', 'no such issue') },
    });
    await lasting.run();
    expect(lasting.resolved, 'the second issue was still resolved').toEqual(['102']);
    expect(lasting.rows().map((row) => row.status)).toEqual(['failed', 'ok']);

    const transient = world('present', storedTask(), {
      failures: { '101': new IntegrationError('unavailable', 'double-errors', 'try later') },
    });
    await expect(transient.run()).rejects.toMatchObject({ code: 'unavailable' });
    expect(transient.resolved, 'the rest were tried before the job failed').toEqual(['102']);
  });

  it('never absorbs a call moved inside a transaction', async () => {
    const w = world('present');
    await expect(withOpenTransaction(() => w.run())).rejects.toBeInstanceOf(TransactionOpenError);
    expect(w.resolved).toEqual([]);
  });

  it('keys each resolve on the task and the issue, never on the wake-up', () => {
    expect(resolveOnMergeKey(TASK, '101')).toBe(`resolve_on_merge:${TASK}:101`);
  });
});

describe('resolve on merge — the handler (WP-111)', () => {
  const mergedEvent = (taskId: Id | null): DomainEvent =>
    ({
      id: EVENT,
      type: 'mr.merged',
      payload: {
        project_id: PROJECT,
        task_id: taskId,
        mr: { provider: 'fake-git', iid: 7, url: 'https://git.example.test/mr/7' },
      },
    }) as unknown as DomainEvent;

  const handle = async (event: DomainEvent, task: StoredTask | null) => {
    const enqueued: PipelineOutboundData[] = [];
    const lookups: string[] = [];
    const callbacks: (() => Promise<void>)[] = [];
    const handler = resolveOnMergeHandler({
      store: {
        tasks: {
          load: async () => {
            lookups.push('load');
            return task;
          },
          findByMergeRequest: async (_tx: unknown, query: { iid: number }) => {
            lookups.push(`iid:${query.iid}`);
            return task;
          },
        },
      },
      jobs: {
        enqueue: async (job: { data: PipelineOutboundData }) => {
          enqueued.push(job.data);
        },
      } as unknown as Jobs,
    } as never);
    await handler.handle({
      scope: { tx: {} },
      event: { event },
      afterCommit: (callback: () => Promise<void>) => callbacks.push(callback),
    } as unknown as HandlerContext);
    for (const callback of callbacks) {
      await callback();
    }
    return { enqueued, lookups };
  };

  it('enqueues the duty after commit for a bug task found by its merge request', async () => {
    const { enqueued, lookups } = await handle(mergedEvent(null), storedTask());
    expect(lookups).toEqual(['iid:7']);
    expect(enqueued).toEqual([
      { duty: 'resolve_on_merge', project_id: PROJECT, task_id: TASK, cause_event_id: EVENT },
    ]);
  });

  it('loads the task the payload names, and enqueues nothing for a task that is not a bug', async () => {
    const named = await handle(mergedEvent(TASK), storedTask({ template: 'feature' }));
    expect(named.lookups).toEqual(['load']);
    expect(named.enqueued).toEqual([]);
  });

  it('enqueues nothing for a merge request no task owns', async () => {
    expect((await handle(mergedEvent(null), null)).enqueued).toEqual([]);
  });
});
