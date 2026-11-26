/**
 * The *Start a ticket* typeahead's command (`searchTicketsForStart`): one audited read through the
 * real executor, and the platform's own judgement over the port's answer — the binding's scope
 * again, the start's status verdict (`intakeStatusDecision` over the binding's policy), the binding's
 * redactor, the bounds — and the two "nothing to ask" answers by name.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { ticketStatusPolicyOf } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { allowAnyIntegrationHost } from '../integrations/egress.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type {
  TaskManagementPort,
  TicketScopeVerdict,
  TicketSearchHit,
} from '../ports/integrations/task-management.js';
import { createMemoryAuditLog, createVirtualTimer } from '../testing/memory-integrations.js';
import { type PipelineIntegrations, staticPipelineIntegrations } from './integrations.js';
import { defaultProjectSettings, staticProjectSettings } from './settings.js';
import { searchTicketsForStart } from './ticket-search.js';

const PROJECT = '00000000-0000-4000-8000-0000000000d1' as Id;
/** Obviously fake, planted in a summary to prove the binding's redactor runs. */
const BINDING_TOKEN = 'FAKE-jira-token-typeahead-0000';

const hit = (
  key: string,
  status: string,
  category: TicketSearchHit['status_category'],
  title = `Ticket ${key}`,
): TicketSearchHit => ({
  ref: { provider: 'fake-jira', key, url: `https://jira.example.test/browse/${key}` },
  title,
  status,
  status_category: category,
});

const world = (
  options: {
    readonly hits?: readonly TicketSearchHit[];
    readonly declares?: boolean;
    readonly binding?: boolean;
    readonly scope?: (key: string) => TicketScopeVerdict;
    readonly fails?: Error;
    readonly startFrom?: readonly string[];
  } = {},
) => {
  const asked: { query: string; limit: number }[] = [];
  const audit = createMemoryAuditLog();
  const port = {
    ref: {
      integrationId: '00000000-0000-4000-8000-00000000a0d1',
      provider: 'fake-jira',
      type: 'task_management',
    },
    capabilities: () => ({ ticketSearch: options.declares ?? true }),
    ticketScope: options.scope ?? (() => ({ kind: 'unscoped' })),
    searchTickets: async (query: string, searchOptions: { limit: number }) => {
      asked.push({ query, limit: searchOptions.limit });
      if (options.fails !== undefined) {
        throw options.fails;
      }
      return options.hits ?? [];
    },
  } as unknown as TaskManagementPort;
  const integrations = {
    executor: createIntegrationActionExecutor({
      egress: allowAnyIntegrationHost(),
      auditLog: audit,
      redactor: exactSecretRedactor([]),
      timer: createVirtualTimer({ autoAdvance: true }),
      clock: { now: () => '2026-11-26T09:00:00.000Z' as IsoDateTime },
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } as never,
    }),
    git: null,
    taskManagement:
      options.binding === false
        ? null
        : {
            port,
            ref: port.ref,
            redactor: exactSecretRedactor([{ name: 'fake_jira_token', value: BINDING_TOKEN }]),
          },
    communication: null,
  } as unknown as PipelineIntegrations;
  const settings = defaultProjectSettings(PROJECT, {
    ticketStatusPolicy: ticketStatusPolicyOf(
      null,
      options.startFrom === undefined ? null : { start_from: [...options.startFrom] },
    ),
  });
  const search = (query: string) =>
    searchTicketsForStart(
      {
        integrations: staticPipelineIntegrations(integrations),
        settings: staticProjectSettings(() => settings),
      },
      { projectId: PROJECT, query },
    );
  return { search, asked, audit };
};

describe('searchTicketsForStart (the Start a ticket typeahead)', () => {
  it('reads once through the executor, audited as search_tickets with no typed text', async () => {
    const { search, asked, audit } = world({ hits: [hit('ACME-12', 'To Do', 'todo')] });
    const answer = await search('  acme-12  ');
    expect(answer).toEqual({
      status: 'ok',
      items: [{ ...hit('ACME-12', 'To Do', 'todo'), startable: true }],
    });
    expect(asked).toEqual([{ query: 'acme-12', limit: 10 }]);
    const rows = audit.entriesFor('search_tickets');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain('acme-12');
  });

  it('says whether the start would start work, by the start’s own status decision', async () => {
    const hits = [
      hit('ACME-1', 'To Do', 'todo'),
      hit('ACME-2', 'In review', 'in_progress'),
      hit('ACME-3', 'Done', 'done'),
      hit('ACME-4', 'Specified', 'todo'),
    ];
    const byCategory = await world({ hits }).search('acme');
    expect(byCategory.status === 'ok' && byCategory.items.map((item) => item.startable)).toEqual([
      true,
      false,
      false,
      true,
    ]);
    // A `start_from` list decides by name instead of by category.
    const byList = await world({ hits, startFrom: ['Specified'] }).search('acme');
    expect(byList.status === 'ok' && byList.items.map((item) => item.startable)).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it('drops a ticket outside the binding’s scope the provider answered anyway', async () => {
    const { search } = world({
      hits: [hit('OPS-1', 'To Do', 'todo'), hit('ACME-1', 'To Do', 'todo')],
      scope: (key) =>
        key.startsWith('ACME-') ? { kind: 'in_scope' } : { kind: 'out_of_scope', scope: ['ACME'] },
    });
    const answer = await search('invoice');
    expect(answer.status === 'ok' && answer.items.map((item) => item.ref.key)).toEqual(['ACME-1']);
  });

  it('redacts the binding’s secrets out of the title and the status (canary: the token is gone)', async () => {
    const { search } = world({
      hits: [hit('ACME-1', `Done ${BINDING_TOKEN}`, 'done', `The token is ${BINDING_TOKEN}`)],
    });
    const answer = await search('token');
    expect(JSON.stringify(answer)).not.toContain(BINDING_TOKEN);
    expect(answer.status === 'ok' && answer.items[0]?.title).toContain('REDACTED');
  });

  it('answers no_binding and unsupported by name, asking the provider nothing', async () => {
    const none = world({ binding: false });
    expect(await none.search('acme')).toEqual({ status: 'no_binding' });
    const undeclared = world({ declares: false });
    expect(await undeclared.search('acme')).toEqual({ status: 'unsupported' });
    expect(undeclared.asked).toEqual([]);
  });

  it('lets a provider failure through, audited, for the caller to answer', async () => {
    const { search, audit } = world({
      fails: new IntegrationError('unauthorised', 'fake-jira', 'the token was refused'),
    });
    await expect(search('acme')).rejects.toBeInstanceOf(IntegrationError);
    expect(audit.entriesFor('search_tickets')[0]?.status).toBe('failed');
  });

  it('refuses a query past the bound rather than cutting it', async () => {
    await expect(world().search('x'.repeat(101))).rejects.toBeInstanceOf(RangeError);
  });
});
