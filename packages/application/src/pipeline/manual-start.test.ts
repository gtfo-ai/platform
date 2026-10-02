/**
 * product/04's manual "Start" (WP-122, PROGRESS backlog 379): a ticket named by its key is recorded
 * as the same `ticket.matched` intake consumes, and intake decides everything else.
 *
 * Every case runs on the whole in-memory pipeline (`createPipelineHarness`): the real event bus, the
 * real intake handler and intake check, the real WIP admission — so "the manual start bypasses the
 * pick-up rule and nothing else" is asserted against the code that applies the rest, never against
 * a copy of it.
 */
import type { DomainEvent, Id, IsoDateTime } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { materialiseAutonomy, resolveWipLimits } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import {
  TransactionOpenError,
  transactionIsOpen,
  withOpenTransaction,
} from '../events/open-transaction.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type { Ticket, TicketRefInput } from '../ports/integrations/task-management.js';
import {
  createPipelineHarness,
  type HarnessOptions,
  type PipelineHarness,
} from '../testing/pipeline-harness.js';
import {
  MANUAL_START_RULE,
  type ManualStartInput,
  type ManualStartRecord,
  ManualStartRefusedError,
  startTicketManually,
} from './manual-start.js';
import { staticProjectSettings } from './settings.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const USER = '00000000-0000-4000-8000-0000000000c1' as Id;

/** A ticket as the provider answers it — its own URL, never the one the read was asked with. */
const ticketFor = (ref: TicketRefInput, overrides: Partial<Ticket> = {}): Ticket => ({
  ref: { provider: ref.provider, key: ref.key, url: `https://jira.example.test/browse/${ref.key}` },
  issue_type: 'Bug',
  title: 'The footer sums the visible rows only',
  description: 'It should sum all of them.',
  status: 'To Do',
  priority: 'High',
  labels: [],
  comments: [],
  links: [{ kind: 'is_blocked_by', key: 'ACME-99', url: null }],
  epic: null,
  siblings: [],
  attachments_text: [],
  assignee: null,
  reporter: null,
  updated_at: '2026-06-01T09:00:00.000Z',
  ...overrides,
});

const harnessWith = (options: HarnessOptions = {}): PipelineHarness =>
  createPipelineHarness({
    projectId: PROJECT,
    // The first stage's job stays queued, so a started task holds its WIP slot and nothing has to
    // be scripted: these cases are about intake, not about the stages after it.
    runsAgents: false,
    taskManagement: { readTicket: async (ref) => ticketFor(ref) },
    ...options,
  });

/** The application command over the harness's own collaborators. */
const start = (
  harness: PipelineHarness,
  ticketKey: string,
  record: ManualStartInput['record'] = async () => undefined,
): Promise<ManualStartRecord> =>
  startTicketManually(
    {
      unitOfWork: harness.memory,
      eventStore: harness.memory.store,
      store: harness.store,
      settings: staticProjectSettings(() => harness.settings),
      integrations: { forProject: async () => harness.integrations } as never,
      ids: harness.ids,
      clock: harness.clock,
    },
    { projectId: PROJECT, ticketKey, userId: USER, record },
  );

let stream = 0;
/** A rule match, as a webhook adapter would append it. */
const ruleMatch = (key: string): DomainEvent => {
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
      ticket: { provider: 'fake-jira', key, url: `https://jira.example.test/browse/${key}` },
      rule: 'label:agentic',
      priority: 'High',
      issue_type: 'Bug',
      epic: null,
      links: [],
    },
  }) as DomainEvent;
};

const matchesOf = (harness: PipelineHarness) =>
  harness
    .events()
    .filter(
      (entry): entry is Extract<DomainEvent, { type: 'ticket.matched' }> =>
        entry.type === 'ticket.matched',
    );

const stateOf = (harness: PipelineHarness, key: string) =>
  harness.store.snapshot().find((stored) => stored.task.ticket.key === key)?.task;

const refusalOf = async (promise: Promise<unknown>): Promise<ManualStartRefusedError> => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ManualStartRefusedError);
  return error as ManualStartRefusedError;
};

describe('a ticket started by hand (WP-122)', () => {
  it('is recorded as the ticket.matched intake consumes, and intake creates the task', async () => {
    const harness = harnessWith();
    const started = await start(harness, 'ACME-7');
    const [match] = matchesOf(harness);
    expect(match?.payload).toEqual({
      project_id: PROJECT,
      // The provider's own reference, never the URL the read was asked with.
      ticket: {
        provider: 'fake-jira',
        key: 'ACME-7',
        url: 'https://jira.example.test/browse/ACME-7',
      },
      rule: MANUAL_START_RULE,
      priority: 'High',
      issue_type: 'Bug',
      epic: null,
      links: [{ kind: 'is_blocked_by', key: 'ACME-99', url: null }],
    });
    expect(match?.actor).toEqual({ kind: 'user', user_id: USER });
    expect(match?.stream_type).toBe('project');
    expect(started.eventId).toBe(match?.id);

    // Nothing was created by the start itself: the task is intake's.
    expect(harness.store.snapshot()).toHaveLength(0);
    await harness.drain();
    const task = stateOf(harness, 'ACME-7');
    expect(task?.state).toBe('active');
    expect(task?.currentStage).toBe('refinement');
    // Classified by its issue type exactly as a rule match is: `Bug` → the bug template.
    expect(task?.template).toBe('bug');
  });

  it('queues above the WIP limit exactly as a rule match does', async () => {
    const config = { pipeline: { wip: { max_parallel_tasks: 1 } } };
    const settings = { config, wip: resolveWipLimits(config.pipeline.wip, undefined).limits };

    const byRule = harnessWith({ settings });
    await byRule.publish([ruleMatch('ACME-1')]);
    await byRule.publish([ruleMatch('ACME-2')]);

    const byHand = harnessWith({ settings });
    await byHand.publish([ruleMatch('ACME-1')]);
    await start(byHand, 'ACME-2');
    await byHand.drain();

    expect(stateOf(byRule, 'ACME-2')?.state).toBe('queued');
    expect(stateOf(byHand, 'ACME-2')?.state).toBe('queued');
    expect(byHand.types()).toContain('task.queued');
    // Canary on the comparison itself: the first ticket of each was admitted.
    expect(stateOf(byHand, 'ACME-1')?.state).toBe('active');
  });

  it('writes the caller’s row in the match’s transaction, and rolls the match back with it', async () => {
    const harness = harnessWith();
    const seen: string[] = [];
    await start(harness, 'ACME-7', async (scope, started) => {
      // Inside the transaction: the match is appended and not yet visible to anybody else.
      expect(scope.tx).toBeDefined();
      seen.push(started.ticket.key);
    });
    expect(seen).toEqual(['ACME-7']);

    const failing = harnessWith();
    await expect(
      start(failing, 'ACME-8', async () => {
        throw new Error('the audit insert failed');
      }),
    ).rejects.toThrow('the audit insert failed');
    expect(matchesOf(failing)).toHaveLength(0);
  });

  it('redacts the provider’s fields with the binding’s redactor before building the event', async () => {
    const secret = 'jira-token-0123456789abcdef';
    const harness = harnessWith({
      ticketRedactor: exactSecretRedactor([{ name: 'jira:api_token', value: secret }]),
      taskManagement: {
        readTicket: async (ref) =>
          ticketFor(ref, { links: [{ kind: 'relates_to', key: `X-${secret}`, url: null }] }),
      },
    });
    await start(harness, 'ACME-7');
    const serialised = JSON.stringify(matchesOf(harness));
    expect(serialised).not.toContain(secret);
    expect(serialised).toContain('[REDACTED:');
  });
});

/**
 * WP-122 pre-review round: a binding's declared scope (Jira's `project_keys`) is not the pick-up
 * rule, so the manual start does not bypass it. The provider answers, with the key it returned.
 */
/**
 * Review round 1: the ticket read is held outside every transaction **mechanically**, not by the
 * docblock. `assertOutsideTransaction` sees only marked transactions, so the command marks its own.
 */
describe('the read outside every transaction', () => {
  it('marks the transactions it opens, so a provider call inside one would be refused', async () => {
    const harness = harnessWith();
    const marked: boolean[] = [];
    await start(harness, 'ACME-7', async () => {
      // `record` runs inside the append's transaction: the mark is what arms the refusal.
      marked.push(transactionIsOpen());
    });
    expect(marked).toEqual([true]);
  });

  it('refuses to read the ticket from inside a transaction', async () => {
    const harness = harnessWith();
    await expect(withOpenTransaction(async () => start(harness, 'ACME-7'))).rejects.toBeInstanceOf(
      TransactionOpenError,
    );
    expect(matchesOf(harness)).toHaveLength(0);
  });
});

describe('the binding’s declared scope', () => {
  const scoped = (keys: readonly string[]): HarnessOptions['taskManagement'] => ({
    // Jira answers the canonical upper-case key whatever case was typed.
    readTicket: async (ref) => ticketFor({ ...ref, key: ref.key.toUpperCase() }),
    ticketScope: (key) =>
      keys.length === 0
        ? { kind: 'unscoped' }
        : keys.includes(key.split('-')[0] ?? key)
          ? { kind: 'in_scope' }
          : { kind: 'out_of_scope', scope: keys },
  });

  it('starts a ticket inside the scope, judged by the key the provider answered', async () => {
    const harness = harnessWith({ taskManagement: scoped(['ACME']) });
    const started = await start(harness, 'acme-7');
    expect(started.ticket.key).toBe('ACME-7');
    expect(matchesOf(harness)).toHaveLength(1);
  });

  it('refuses a ticket outside the scope, naming the scope and recording nothing', async () => {
    const harness = harnessWith({ taskManagement: scoped(['ACME', 'OPS']) });
    const refusal = await refusalOf(start(harness, 'OTHER-7'));
    expect(refusal.reason).toBe('outside_binding_scope');
    expect(refusal.message).toContain('ACME, OPS');
    // Never the ticket's content: the provider's title is not in the sentence.
    expect(refusal.message).not.toContain('footer');
    expect(matchesOf(harness)).toHaveLength(0);
    await harness.drain();
    expect(harness.store.snapshot()).toHaveLength(0);
  });

  it('admits any key on a binding that declares no scope', async () => {
    const harness = harnessWith({ taskManagement: scoped([]) });
    await start(harness, 'OTHER-7');
    expect(matchesOf(harness)).toHaveLength(1);
  });
});

describe('the refusals, each before anything is recorded', () => {
  it('refuses a project with no task-management binding', async () => {
    const harness = harnessWith({ taskManagement: null });
    const refusal = await refusalOf(start(harness, 'ACME-7'));
    expect(refusal.reason).toBe('no_task_management');
    expect(matchesOf(harness)).toHaveLength(0);
  });

  it('refuses a ticket that already has a task, before reading the provider', async () => {
    let reads = 0;
    const harness = harnessWith({
      taskManagement: {
        readTicket: async (ref) => {
          reads += 1;
          return ticketFor(ref);
        },
      },
    });
    await harness.publish([ruleMatch('ACME-1')]);
    const readsBefore = reads;
    const refusal = await refusalOf(start(harness, 'ACME-1'));
    expect(refusal.reason).toBe('task_exists');
    expect(refusal.taskId).toBe(stateOf(harness, 'ACME-1')?.id);
    expect(reads).toBe(readsBefore);
    expect(matchesOf(harness)).toHaveLength(1);
  });

  it('refuses inside the append when a task appeared while the provider answered', async () => {
    // The pre-check passes; while the read is out, a rule match for the same ticket becomes a task.
    // The in-transaction check is what refuses — the canary for it is this case alone.
    let harness: PipelineHarness | undefined;
    let raced = false;
    harness = harnessWith({
      taskManagement: {
        readTicket: async (ref) => {
          // Once: intake's own read of the ticket comes through here too.
          if (!raced) {
            raced = true;
            await harness?.publish([ruleMatch(ref.key)]);
          }
          return ticketFor(ref);
        },
      },
    });
    const refusal = await refusalOf(start(harness, 'ACME-3'));
    expect(refusal.reason).toBe('task_exists');
    expect(matchesOf(harness).map((match) => match.payload.rule)).toEqual(['label:agentic']);
  });

  it('answers not found for a key the provider does not know', async () => {
    const harness = harnessWith({
      taskManagement: {
        readTicket: async () => {
          throw new IntegrationError('not_found', 'fake-jira', 'ticket ACME-404', {
            action: 'read_ticket',
          });
        },
      },
    });
    const refusal = await refusalOf(start(harness, 'ACME-404'));
    expect(refusal.reason).toBe('ticket_not_found');
    expect(matchesOf(harness)).toHaveLength(0);
  });

  it('fails closed on any other provider failure, and keeps the provider’s words out of it', async () => {
    const harness = harnessWith({
      taskManagement: {
        readTicket: async () => {
          throw new IntegrationError('forbidden', 'fake-jira', 'the provider said something long', {
            action: 'read_ticket',
          });
        },
      },
    });
    const refusal = await refusalOf(start(harness, 'ACME-7'));
    expect(refusal.reason).toBe('ticket_unreadable');
    expect(refusal.message).toContain('(forbidden)');
    expect(refusal.message).not.toContain('the provider said something long');
    expect(matchesOf(harness)).toHaveLength(0);
  });

  it('refuses a project whose dial does not pick up new tickets, where intake would drop it', async () => {
    const observe = materialiseAutonomy({
      level: 'observe',
      at: '2026-06-01T09:00:00.000Z' as IsoDateTime,
      appliedBy: null,
    });
    const harness = harnessWith({ settings: { autonomy: observe } });
    const refusal = await refusalOf(start(harness, 'ACME-7'));
    expect(refusal.reason).toBe('not_picked_up');
    expect(matchesOf(harness)).toHaveLength(0);

    // The same predicate, from intake's side: a rule match on this project creates nothing.
    await harness.publish([ruleMatch('ACME-8')]);
    expect(harness.store.snapshot()).toHaveLength(0);

    // And the override that turns pick-up on admits both doors.
    const pickingUp = harnessWith({
      settings: {
        autonomy: { ...observe, policies: { ...observe.policies, picks_up_new_tickets: true } },
      },
    });
    await start(pickingUp, 'ACME-7');
    await pickingUp.drain();
    expect(stateOf(pickingUp, 'ACME-7')).toBeDefined();
  });
});
