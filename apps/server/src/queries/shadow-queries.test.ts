/**
 * The Shadow screen's projections, as pure functions of the rows (WP-34).
 *
 * `project-queries.test.ts`'s shape and for its reason: everything worth asserting is the
 * conversion — three `numeric` columns that arrive as strings, a `left join` that answers `null` for
 * a refused ticket, a `jsonb` report that may be a document this build cannot read, and the rule
 * about which tickets the aggregate counts. A projection driven only through a container is a
 * projection asserted once, slowly.
 *
 * Both directions throughout (standing rule 42): a reader that dropped every report and one that
 * kept every document would each pass half of this file.
 */
import type { ShadowBatchTicket, ShadowReportData } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  type BatchRowShape,
  readShadowReport,
  shadowAggregateFrom,
  shadowBatchSummaryFrom,
  shadowTicketFrom,
  type TicketRowShape,
} from './shadow-queries.js';

const BATCH = '00000000-0000-4000-8000-000000000c01';
const PROJECT = '00000000-0000-4000-8000-000000000c02';
const TASK = '00000000-0000-4000-8000-000000000c03';

const batchRow = (overrides: Partial<BatchRowShape> = {}): BatchRowShape => ({
  id: BATCH,
  projectId: PROJECT,
  budgetUsd: '25.500000',
  createdAt: new Date('2026-09-14T10:00:00.000Z'),
  completedAt: null,
  ...overrides,
});

const ticketRow = (overrides: Partial<TicketRowShape> = {}): TicketRowShape => ({
  ticketKey: 'ACME-1',
  taskId: TASK,
  baseSha: 'b'.repeat(40),
  humanMrRef: {
    provider: 'fake-git',
    iid: 7,
    url: 'https://git.example.test/acme/api/-/merge_requests/7',
  },
  humanMrSource: 'title_scan',
  refusedReason: null,
  taskState: 'ready_for_merge',
  size: 'M',
  costActual: '4.250000',
  estimateUsd: '6.000000',
  ...overrides,
});

const report = (overrides: Partial<ShadowReportData> = {}): ShadowReportData =>
  ({
    ticket: 'ACME-1',
    human_mr: null,
    agent_diff_stats: { files_changed: 2, insertions: 10, deletions: 1 },
    overlap: {
      files_jaccard: 0.75,
      size_ratio: 1,
      tests_added_ratio: 1,
      agent_test_files: 1,
      human_test_files: 1,
    },
    agent_review_of_human_mr: null,
    predicted_cost: 6,
    shadow_cost: 4.25,
    reviewer_minutes_estimate: null,
    notes: '',
    ...overrides,
  }) as ShadowReportData;

describe('shadowBatchSummaryFrom', () => {
  it('sums the batch’s spend, counts its tickets and its refusals', () => {
    const summary = shadowBatchSummaryFrom(batchRow(), [
      { refusedReason: null, costActual: '4.250000' },
      { refusedReason: null, costActual: '1.750000' },
      // A refused ticket has no task, so the `left join` answers `null` for its cost.
      { refusedReason: 'no merge base', costActual: null },
    ]);
    expect(summary.spent_usd).toBe(6);
    expect(summary.tickets).toBe(3);
    expect(summary.refused).toBe(1);
    expect(summary.budget_usd).toBe(25.5);
    expect(summary.created_at).toBe('2026-09-14T10:00:00.000Z');
    expect(summary.completed_at).toBeNull();
  });

  it('keeps a null budget null and publishes the completion instant when there is one', () => {
    const summary = shadowBatchSummaryFrom(
      batchRow({ budgetUsd: null, completedAt: new Date('2026-09-14T11:00:00.000Z') }),
      [],
    );
    expect(summary.budget_usd).toBeNull();
    expect(summary.completed_at).toBe('2026-09-14T11:00:00.000Z');
    expect(summary.spent_usd).toBe(0);
  });
});

describe('shadowTicketFrom', () => {
  it('publishes the ticket, its task and the comparison the report carries', () => {
    const ticket = shadowTicketFrom(ticketRow(), report());
    expect(ticket.task_id).toBe(TASK);
    expect(ticket.task_state).toBe('ready_for_merge');
    expect(ticket.size).toBe('M');
    expect(ticket.cost_usd).toBe(4.25);
    expect(ticket.predicted_cost_usd).toBe(6);
    expect(ticket.similarity).toBe(0.75);
    expect(ticket.human_mr_source).toBe('title_scan');
  });

  it('answers three different nulls for three different facts', () => {
    // Still running: a task with no report.
    expect(shadowTicketFrom(ticketRow(), null).similarity).toBeNull();
    // Measured, but nothing to compare with: a report whose overlap is absent.
    expect(shadowTicketFrom(ticketRow(), report({ overlap: null })).similarity).toBeNull();
    // Never run: a refusal, which has no task at all.
    const refused = shadowTicketFrom(
      ticketRow({
        taskId: null,
        refusedReason: 'no merge base',
        taskState: null,
        size: null,
        // The `left join` has no task row to answer from, which is what makes these two null.
        costActual: null,
        estimateUsd: null,
      }),
      null,
    );
    expect(refused.task_id).toBeNull();
    expect(refused.refused_reason).toBe('no merge base');
    expect(refused.cost_usd).toBe(0);
    expect(refused.predicted_cost_usd).toBeNull();
  });

  it('drops a `human_mr_source` this build does not know, and keeps one it does', () => {
    expect(shadowTicketFrom(ticketRow({ humanMrSource: 'telepathy' }), null).human_mr_source).toBe(
      null,
    );
    expect(
      shadowTicketFrom(ticketRow({ humanMrSource: 'ticket_link' }), null).human_mr_source,
    ).toBe('ticket_link');
  });

  it('drops a size the enum does not name', () => {
    expect(shadowTicketFrom(ticketRow({ size: 'XXL' }), null).size).toBeNull();
    expect(shadowTicketFrom(ticketRow({ size: 'XL' }), null).size).toBe('XL');
  });
});

describe('readShadowReport', () => {
  it('parses a report this build wrote', () => {
    expect(readShadowReport(report())?.ticket).toBe('ACME-1');
  });

  it('drops a document the schema refuses, rather than half-populating a comparison', () => {
    // WP-15h's `/context-pack` precedent: publishing a field the store cannot answer is publishing
    // a fact. The screen renders `null` as "this report cannot be read by this build".
    expect(readShadowReport({ ticket: 'ACME-1' })).toBeNull();
    expect(readShadowReport('not a report')).toBeNull();
    expect(readShadowReport(null)).toBeNull();
  });
});

describe('shadowAggregateFrom', () => {
  const ticket = (overrides: Partial<ShadowBatchTicket>): ShadowBatchTicket =>
    ({ ...shadowTicketFrom(ticketRow(), report()), ...overrides }) as ShadowBatchTicket;

  it('counts a reported ticket with no comparison as reported and not as compared', () => {
    const aggregate = shadowAggregateFrom([
      ticket({ ticket_key: 'A-1' }),
      ticket({ ticket_key: 'A-2', similarity: null, report: report({ overlap: null }) }),
    ]);
    expect(aggregate.reported).toBe(2);
    expect(aggregate.compared).toBe(1);
  });

  it('excludes a refused ticket entirely — it never became a measurement', () => {
    const aggregate = shadowAggregateFrom([
      ticket({ ticket_key: 'A-1' }),
      ticket({
        ticket_key: 'A-2',
        task_id: null,
        refused_reason: 'no merge base',
        report: null,
        similarity: null,
      }),
    ]);
    expect(aggregate.reported).toBe(1);
    expect(aggregate.cost_by_size).toEqual([
      { size: 'M', tickets: 1, median_cost_usd: 4.25, median_predicted_cost_usd: 6 },
    ]);
  });

  it('is empty for a batch whose tasks are all still running', () => {
    const aggregate = shadowAggregateFrom([
      ticket({ ticket_key: 'A-1', report: null, similarity: null }),
    ]);
    expect(aggregate.reported).toBe(0);
    expect(aggregate.cost_by_size).toEqual([]);
    expect(aggregate.launch_candidates).toEqual([]);
  });
});
