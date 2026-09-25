/**
 * The bound on one `get_task_context` answer, without a database (WP-54 review rounds 1 and 2).
 * The SQL and the scoping are `test/integration/server/task-context.integration.test.ts`'s.
 */
import { describe, expect, it } from 'vitest';
import {
  boundTaskContextSection,
  TASK_CONTEXT_MAX_CHARS,
  TASK_CONTEXT_TICKET_SHARE,
  type TaskContextInclude,
  taskContextShares,
} from './task-context-queries.js';

const artifact = (type: string, chars: number) => ({
  artifact_type: type,
  version: 1,
  status: 'ok',
  url: `/api/artifacts/${type}`,
  data: { text: 'x'.repeat(chars) },
});

describe('the task-context bound', () => {
  it('skips an artifact that does not fit, names it, and still serves the ones after it', () => {
    const bounded = boundTaskContextSection(
      'artifacts',
      {
        status: 'ok',
        latest_per_type: [
          artifact('RefinedSpec', 50),
          artifact('ImplementationPlan', 5_000),
          artifact('ReviewVerdict', 50),
        ],
      },
      1_000,
    );
    const text = JSON.stringify(bounded);
    expect(text.length).toBeLessThanOrEqual(1_000);
    expect(text).toContain('"artifact_type":"ImplementationPlan","version":1,"status":"refused"');
    expect(text).toContain('/api/artifacts/ImplementationPlan');
    // Skip-and-continue: the small one after the large one is served whole.
    expect(text).toContain('"artifact_type":"ReviewVerdict","version":1,"status":"ok"');
    expect(bounded).toMatchObject({ truncated: false, omitted: 0 });
  });

  it('stops an ordered list at the first row that does not fit, and says how many it left', () => {
    const actions = Array.from({ length: 10 }, (_, index) => ({
      id: String(index),
      padding: 'p'.repeat(200),
    }));
    const bounded = boundTaskContextSection(
      'audit',
      { status: 'ok', truncated: false, actions },
      1_000,
    );
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(1_000);
    const kept = (bounded as unknown as { actions: { id: string }[] }).actions;
    // A contiguous prefix, newest first — never a gapped list.
    expect(kept.map((row) => row.id)).toEqual(kept.map((_, index) => String(index)));
    expect(bounded).toMatchObject({ truncated: true, omitted: 10 - kept.length });
  });

  it('refuses a single document that does not fit rather than cutting it', () => {
    const bounded = boundTaskContextSection(
      'ticket',
      { status: 'ok', snapshot: { description: 'd'.repeat(5_000) } },
      1_000,
    );
    expect(bounded.status).toBe('refused');
    // …and passes one that fits unchanged (rule 42).
    const small = { status: 'ok' as const, snapshot: { description: 'd' } };
    expect(boundTaskContextSection('ticket', small, 1_000)).toBe(small);
  });

  it('guarantees the ticket a full-size share, and keeps the total within the cap', () => {
    const all: TaskContextInclude[] = [
      'ticket',
      'artifacts',
      'feedback',
      'mr',
      'ci',
      'runs',
      'audit',
    ];
    const shares = taskContextShares(all);
    expect(shares.ticket).toBe(TASK_CONTEXT_TICKET_SHARE);
    const total = Object.values(shares).reduce((sum, share) => sum + (share ?? 0), 0);
    expect(total).toBeLessThanOrEqual(TASK_CONTEXT_MAX_CHARS);
    // Without the ticket the shares are equal.
    expect(new Set(Object.values(taskContextShares(['runs', 'audit']))).size).toBe(1);
  });
});
