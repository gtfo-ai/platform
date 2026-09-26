/**
 * The two delivery measurements, driven through the real handlers, the real `pipeline.outbound`
 * duties and the real `IntegrationActionExecutor` over the in-memory doubles (WP-61, PROGRESS
 * backlog 179 and 114).
 *
 * Every assertion is on a **countable effect** — the event appended to the log, and the
 * `integration_actions` rows the executor wrote for the provider reads — never on a return value.
 *
 * The proving case for backlog 179 is the refiner's: the merge event's `diff_stats` is **null**
 * (what GitLab sends) and the read answers a number, so the number in the event can only have come
 * from the read — and the reverse, a filled event field (what the fake sends) with a read that
 * answers nothing, so a duty that trusted the delivery would be caught recording it.
 */
import type { DiffStats, DomainEvent, Id, MergeRequestRef } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { markTransactions } from '../events/open-transaction.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { MergeRequest } from '../ports/integrations/git-provider.js';
import type { Ticket, TicketLink } from '../ports/integrations/task-management.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import {
  type DeliveryMeasuresOptions,
  isBugIssueType,
  runBugTrace,
  runMergeMeasure,
} from './delivery-measures.js';
import { staticPipelineIntegrations } from './integrations.js';
import type { PipelineOutboundData } from './jobs.js';
import { defaultProjectSettings, staticProjectSettings } from './settings.js';

const PROJECT = '00000000-0000-4000-8000-0000000000c1' as Id;
const IID = 7;
const HEAD = 'b'.repeat(40);

const TICKET = {
  provider: 'fake-jira',
  key: 'ACME-1',
  url: 'https://jira.example.test/browse/ACME-1',
};

const MR_REF: MergeRequestRef = {
  provider: 'fake-git',
  project_path: 'acme/api',
  iid: IID,
  url: `https://git.example.test/acme/api/-/merge_requests/${IID}`,
  branch: 'agentic/acme-1',
  head_sha: HEAD,
};

const mergeRequest = (ref: MergeRequestRef = MR_REF): MergeRequest =>
  ({
    ref,
    state: 'merged' as const,
    draft: false,
    title: 'Sum the invoice footer',
    description: 'Opened by the developer stage.',
    source_branch: ref.branch,
    target_branch: 'main',
    head_sha: HEAD,
    mergeable: true,
    has_conflicts: false,
    labels: [],
    reviewers: [],
    web_url: ref.url,
  }) as MergeRequest;

const REFINED_SPEC = {
  goal: 'Show the totals.',
  user_value: 'Finance can read an invoice.',
  in_scope: ['the footer'],
  out_of_scope: [],
  acceptance_criteria: [
    {
      id: 'ac1',
      given: 'an invoice',
      when: 'it renders',
      // biome-ignore lint/suspicious/noThenProperty: the published field name
      then: 'the footer sums the lines',
      validation: { kind: 'test', value: 'totals.test.ts' },
    },
  ],
  non_functional: [],
  dependencies: [],
  size: 'M',
  drift: { flag: false, justification: 'documented' },
  assumptions: [],
  questions: [],
  decision: 'proceed',
  kb_citations: [],
};

const PLAN = {
  approach: 'Sum the model.',
  alternatives_considered: [],
  affected_modules: ['invoices'],
  files_to_change: [{ path: 'src/totals.ts', change: 'sum the model' }],
  data_changes: [],
  api_changes: [],
  validation_contract: [{ criterion_id: 'ac1', check: { kind: 'test', value: 'totals.test.ts' } }],
  test_plan: ['totals.test.ts'],
  rollout_notes: 'no flag',
  risks: [],
  estimated_size: 'M',
  decisions_to_record: [],
  protected_path_changes: [],
};

const NOTES = {
  summary: 'Summed the model.',
  deviations_from_plan: [],
  tests_added: ['totals.test.ts'],
  commands_run: [],
  known_gaps: [],
  followup_tickets: [],
  mr: { url: MR_REF.url, iid: IID, head_sha: HEAD, branch: MR_REF.branch },
};

const completedRun = (structuredOutput: unknown) =>
  ({ status: 'completed', terminalReason: 'success', structuredOutput }) as const;

let stream = 0;
const nextEventId = (): string => {
  stream += 1;
  return `00000000-0000-4000-9000-${stream.toString(16).padStart(12, '0')}`;
};

/** A provider event on a stream of its own, as `coverage.test.ts` publishes them. */
const providerEvent = (type: string, payload: Record<string, unknown>): DomainEvent => {
  const id = nextEventId();
  return domainEventSchemasByType[type as keyof typeof domainEventSchemasByType].parse({
    id,
    stream_type: 'project',
    stream_id: `00000000-0000-4000-8000-${id.slice(-12)}`,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-git' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type,
    payload,
  }) as DomainEvent;
};

const ticketMatched = (): DomainEvent =>
  providerEvent('ticket.matched', {
    project_id: PROJECT,
    ticket: TICKET,
    rule: 'label:agentic',
    priority: 'High',
    issue_type: 'Story',
    epic: null,
    links: [],
  });

const merged = (iid: number, diffStats: DiffStats | null): DomainEvent =>
  providerEvent('mr.merged', {
    project_id: PROJECT,
    // A webhook names a merge request, not a platform task — the handler has to look it up.
    task_id: null,
    mr: { ...MR_REF, iid, url: `https://git.example.test/acme/api/-/merge_requests/${iid}` },
    draft: false,
    head_sha: HEAD,
    diff_stats: diffStats,
    merge_commit_sha: 'c'.repeat(40),
  });

const bugFiled = (key: string, issueType: string | null): DomainEvent =>
  providerEvent('ticket.created', {
    project_id: PROJECT,
    ticket: { provider: 'fake-jira', key, url: `https://jira.example.test/browse/${key}` },
    issue_type: issueType,
  });

const ticketWith = (key: string, links: readonly TicketLink[], issueType = 'Bug'): Ticket =>
  ({
    ref: { provider: 'fake-jira', key, url: `https://jira.example.test/browse/${key}` },
    issue_type: issueType,
    title: 'Totals are wrong on page two',
    description: 'The footer is off by one row.',
    status: 'To Do',
    priority: null,
    labels: [],
    comments: [],
    links: [...links],
    epic: null,
    siblings: [],
    attachments_text: [],
    assignee: null,
    reporter: null,
    updated_at: '2026-06-02T09:00:00.000Z',
  }) as Ticket;

const link = (url: string): TicketLink => ({ kind: 'mentioned_in', key: url, url, state: null });

interface World {
  readonly harness: PipelineHarness;
  readonly diffStatsCalls: number[];
  readonly readTickets: string[];
  mergedListings: number;
}

const startWorld = (options: {
  readonly diffStats?: DiffStats | null;
  readonly tickets?: Readonly<Record<string, Ticket>>;
  /** What `getMergeRequest` answers per iid; absent iids answer `null`. */
  readonly mergeRequests?: Readonly<Record<number, MergeRequestRef>>;
}): World => {
  const world = { diffStatsCalls: [] as number[], readTickets: [] as string[], mergedListings: 0 };
  const harness = createPipelineHarness({
    projectId: PROJECT,
    runs: {
      refinement: completedRun(REFINED_SPEC),
      architecture: completedRun(PLAN),
      implementation: completedRun(NOTES),
    },
    gitRedactor: exactSecretRedactor([]),
    git: {
      getMergeRequest: async (ref: { iid: number }) => {
        const scripted = options.mergeRequests?.[ref.iid];
        return scripted === undefined ? mergeRequest() : mergeRequest(scripted);
      },
      getMergeRequestDiffStats: async (ref: { iid: number }) => {
        world.diffStatsCalls.push(ref.iid);
        return options.diffStats ?? null;
      },
      listMergedMergeRequests: async () => {
        world.mergedListings += 1;
        return [];
      },
    } as never,
    taskManagement: {
      readTicket: async (ref: { key: string }) => {
        world.readTickets.push(ref.key);
        const ticket = options.tickets?.[ref.key];
        if (ticket === undefined) {
          throw new Error(`the test scripted no ticket ${ref.key}`);
        }
        return ticket;
      },
    } as never,
  });
  return { harness, ...world } as World;
};

const eventsOf = <T extends DomainEvent['type']>(harness: PipelineHarness, type: T) =>
  harness.events().filter((event) => event.type === type) as Extract<DomainEvent, { type: T }>[];

const taskIdOf = (harness: PipelineHarness): Id =>
  (eventsOf(harness, 'task.created')[0] as { payload: { task_id: Id } }).payload.task_id;

const optionsOf = (harness: PipelineHarness): DeliveryMeasuresOptions => ({
  store: harness.store,
  settings: staticProjectSettings(() => harness.settings),
  jobs: harness.jobs,
  calendar: harness.calendar,
  integrations: staticPipelineIntegrations(harness.integrations),
  ids: harness.ids,
  clock: { now: () => harness.clock.now() },
  unitOfWork: markTransactions(harness.memory),
  eventStore: harness.memory.store,
});

describe('which tickets are bugs', () => {
  it('asks the project’s own template map, and never falls back to a default', () => {
    const settings = defaultProjectSettings(PROJECT);
    expect(isBugIssueType(settings, 'Bug')).toBe(true);
    expect(isBugIssueType(settings, ' defect ')).toBe(true);
    expect(isBugIssueType(settings, 'Story')).toBe(false);
    // Unmapped is not "a bug", and no type is not one either.
    expect(isBugIssueType(settings, 'Gremlin')).toBe(false);
    expect(isBugIssueType(settings, null)).toBe(false);
    const own = defaultProjectSettings(PROJECT, { templateByIssueType: { regression: 'bug' } });
    expect(isBugIssueType(own, 'Regression')).toBe(true);
    expect(isBugIssueType(own, 'Bug')).toBe(false);
  });
});

describe('the size of a merge the platform made (backlog 179)', () => {
  it('reads the counts once and records them, although the merge event carried none', async () => {
    const world = startWorld({ diffStats: { files_changed: 3, insertions: 40, deletions: 12 } });
    await world.harness.publish([ticketMatched()]);
    await world.harness.publish([merged(IID, null)]);

    const measured = eventsOf(world.harness, 'task.mr.measured');
    expect(measured).toHaveLength(1);
    expect(measured[0]?.stream_type).toBe('project');
    expect(measured[0]?.payload).toMatchObject({
      task_id: taskIdOf(world.harness),
      mr: { iid: IID },
      diff_stats: { files_changed: 3, insertions: 40, deletions: 12 },
    });
    expect(world.diffStatsCalls).toEqual([IID]);
    expect(
      world.harness.audit.entries.filter(
        (entry) => entry.action === 'get_merge_request_diff_stats',
      ),
    ).toHaveLength(1);
  });

  it('never takes the delivery’s own counts: a filled event and an empty read record unmeasured', async () => {
    // What the fake sends (divergence 17) with what an old GitLab answers: a duty that trusted the
    // event would record 1/1/1 here.
    const world = startWorld({ diffStats: null });
    await world.harness.publish([ticketMatched()]);
    await world.harness.publish([merged(IID, { files_changed: 1, insertions: 1, deletions: 1 })]);
    expect(
      eventsOf(world.harness, 'task.mr.measured').map((event) => event.payload.diff_stats),
    ).toEqual([null]);
  });

  it('measures nothing for a merge request no task owns — a human’s merge is not the platform’s', async () => {
    const world = startWorld({ diffStats: { files_changed: 3, insertions: 40, deletions: 12 } });
    await world.harness.publish([ticketMatched()]);
    await world.harness.publish([merged(99, null)]);
    expect(eventsOf(world.harness, 'task.mr.measured')).toEqual([]);
    expect(world.diffStatsCalls).toEqual([]);
  });

  it('records nothing — not even an unmeasured merge — for a project whose git binding is gone', async () => {
    const world = startWorld({ diffStats: { files_changed: 3, insertions: 40, deletions: 12 } });
    await world.harness.publish([ticketMatched()]);
    const data: PipelineOutboundData = {
      duty: 'merge_measure',
      project_id: PROJECT,
      task_id: taskIdOf(world.harness),
      cause_event_id: nextEventId(),
      iid: IID,
      mr_url: MR_REF.url,
    };
    await runMergeMeasure(
      {
        ...optionsOf(world.harness),
        integrations: staticPipelineIntegrations({ ...world.harness.integrations, git: null }),
      },
      data,
    );
    expect(eventsOf(world.harness, 'task.mr.measured')).toEqual([]);
  });
});

describe('the defect trace of a bug ticket (backlog 114, Q87)', () => {
  const OTHER_PROJECT_URL = 'https://git.example.test/other/project/-/merge_requests/7';

  it('traces a bug through its own link to the platform task whose merge request it names', async () => {
    const world = startWorld({ tickets: { 'BUG-1': ticketWith('BUG-1', [link(MR_REF.url)]) } });
    await world.harness.publish([ticketMatched()]);
    await world.harness.publish([bugFiled('BUG-1', 'Bug')]);

    const traced = eventsOf(world.harness, 'ticket.bug.traced');
    expect(traced).toHaveLength(1);
    expect(traced[0]?.payload).toMatchObject({
      ticket: { key: 'BUG-1' },
      outcome: 'linked',
      found_by: 'ticket_link',
      mr: { iid: IID, url: MR_REF.url },
      task_id: taskIdOf(world.harness),
      filed_at: '2026-06-01T09:00:00.000Z',
    });
    // The link half only: the scan's listing is never asked for (criterion 4).
    expect(world.mergedListings).toBe(0);
  });

  it('records a bug with no resolvable link as `no_link`, including a link to another project', async () => {
    const world = startWorld({
      tickets: {
        'BUG-2': ticketWith('BUG-2', []),
        'BUG-3': ticketWith('BUG-3', [link(OTHER_PROJECT_URL)]),
        'BUG-4': ticketWith('BUG-4', [link('https://jira.example.test/browse/ACME-9')]),
      },
    });
    await world.harness.publish([
      bugFiled('BUG-2', 'Bug'),
      bugFiled('BUG-3', 'Bug'),
      bugFiled('BUG-4', 'Bug'),
    ]);
    const traced = eventsOf(world.harness, 'ticket.bug.traced');
    expect(traced.map((event) => [event.payload.ticket.key, event.payload.outcome])).toEqual([
      ['BUG-2', 'no_link'],
      ['BUG-3', 'no_link'],
      ['BUG-4', 'no_link'],
    ]);
    expect(
      traced.every((event) => event.payload.found_by === null && event.payload.mr === null),
    ).toBe(true);
  });

  it('records a linked bug on a human’s merge request with no task, which counts for coverage only', async () => {
    const human: MergeRequestRef = { ...MR_REF, iid: 42, url: `${MR_REF.url.slice(0, -1)}42` };
    const world = startWorld({
      tickets: { 'BUG-5': ticketWith('BUG-5', [link(human.url)]) },
      mergeRequests: { 42: human },
    });
    await world.harness.publish([bugFiled('BUG-5', 'Bug')]);
    expect(eventsOf(world.harness, 'ticket.bug.traced')[0]?.payload).toMatchObject({
      outcome: 'linked',
      mr: { iid: 42 },
      task_id: null,
    });
  });

  it('traces nothing for a ticket that is not a bug, and reads no ticket to find out', async () => {
    const world = startWorld({ tickets: {} });
    await world.harness.publish([bugFiled('STORY-1', 'Story')]);
    expect(eventsOf(world.harness, 'ticket.bug.traced')).toEqual([]);
    expect(world.readTickets).toEqual([]);
  });

  it('classifies by the ticket’s own type when the delivery named none', async () => {
    const world = startWorld({
      tickets: {
        'BUG-6': ticketWith('BUG-6', []),
        'STORY-2': ticketWith('STORY-2', [], 'Story'),
      },
    });
    await world.harness.publish([bugFiled('BUG-6', null), bugFiled('STORY-2', null)]);
    expect(
      eventsOf(world.harness, 'ticket.bug.traced').map((event) => event.payload.ticket.key),
    ).toEqual(['BUG-6']);
  });

  it('records `unreadable` when the platform could not look — no tracker or no git binding', async () => {
    const world = startWorld({ tickets: { 'BUG-7': ticketWith('BUG-7', [link(MR_REF.url)]) } });
    const data = (key: string): PipelineOutboundData => ({
      duty: 'bug_trace',
      project_id: PROJECT,
      cause_event_id: nextEventId(),
      ticket: { provider: 'fake-jira', key, url: `https://jira.example.test/browse/${key}` },
      issue_type: 'Bug',
      filed_at: '2026-06-01T09:00:00.000Z',
    });
    await runBugTrace(
      {
        ...optionsOf(world.harness),
        integrations: staticPipelineIntegrations({
          ...world.harness.integrations,
          taskManagement: null,
        }),
      },
      data('BUG-7'),
    );
    await runBugTrace(
      {
        ...optionsOf(world.harness),
        integrations: staticPipelineIntegrations({ ...world.harness.integrations, git: null }),
      },
      data('BUG-7'),
    );
    expect(
      eventsOf(world.harness, 'ticket.bug.traced').map((event) => event.payload.outcome),
    ).toEqual(['unreadable', 'unreadable']);
  });
});
