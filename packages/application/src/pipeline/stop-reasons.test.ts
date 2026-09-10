/**
 * The seam that carries WP-12's `run_stopped` reason from the transcript to the stage executor.
 *
 * The runner takes **one** sink for every run it drives, so the executor cannot wrap a sink per
 * run. These are the properties that makes it safe to ask afterwards.
 */
import type { TranscriptEvent } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createRunStopReasons, MAX_REMEMBERED_STOPS } from './stop-reasons.js';

const runId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const stopped = (n: number, reason: unknown): TranscriptEvent =>
  ({
    run_id: runId(n),
    seq: 1,
    created_at: '2026-06-01T09:00:00.000Z',
    redaction_count: 0,
    kind: 'system',
    subtype: 'run_stopped',
    data: { reason },
  }) as TranscriptEvent;

const assistant = (n: number): TranscriptEvent =>
  ({
    run_id: runId(n),
    seq: 2,
    created_at: '2026-06-01T09:00:00.000Z',
    redaction_count: 0,
    kind: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text: 'working' }],
  }) as TranscriptEvent;

describe('createRunStopReasons', () => {
  it('remembers the reason per run and passes everything on to the inner sink', async () => {
    const seen: TranscriptEvent[] = [];
    const reasons = createRunStopReasons();
    const sink = reasons.observe({
      append: async (event) => {
        seen.push(event);
      },
    });

    await sink.append(assistant(1));
    await sink.append(stopped(1, 'cost_unreported'));
    await sink.append(stopped(2, 'budget_exceeded'));

    expect(reasons.reasonFor(runId(1))).toBe('cost_unreported');
    expect(reasons.reasonFor(runId(2))).toBe('budget_exceeded');
    // The decoration is transparent: the composition root's sink still sees every row, in order.
    expect(seen.map((event) => event.kind)).toEqual(['assistant', 'system', 'system']);
  });

  it('answers null for a run the platform did not stop', () => {
    const reasons = createRunStopReasons();
    expect(reasons.reasonFor(runId(9))).toBeNull();
  });

  it('ignores a reason that is not a string, rather than storing whatever arrived', async () => {
    const reasons = createRunStopReasons();
    const sink = reasons.observe({ append: async () => {} });
    await sink.append(stopped(3, { code: 42 }));
    expect(reasons.reasonFor(runId(3))).toBeNull();
  });

  it('forgets on request, so the normal path leaves nothing behind', async () => {
    const reasons = createRunStopReasons();
    const sink = reasons.observe({ append: async () => {} });
    await sink.append(stopped(4, 'stalled'));
    expect(reasons.size).toBe(1);
    reasons.forget(runId(4));
    expect(reasons.size).toBe(0);
    expect(reasons.reasonFor(runId(4))).toBeNull();
  });

  it('evicts the oldest past its cap, and the eviction fails closed', async () => {
    // Losing an entry makes the executor read `null`, which is the same answer it gets for a run
    // stopped for a reason with no name — and that path escalates rather than pausing.
    const reasons = createRunStopReasons(3);
    const sink = reasons.observe({ append: async () => {} });
    for (const n of [1, 2, 3, 4]) {
      await sink.append(stopped(n, `reason-${n}`));
    }
    expect(reasons.size).toBe(3);
    expect(reasons.reasonFor(runId(1))).toBeNull();
    expect(reasons.reasonFor(runId(4))).toBe('reason-4');
  });

  it('caps well above BD-010’s parallel-run limit, and the docblock’s ratio is the real one', () => {
    // BD-010's default `max_parallel_runs` is 4 per organisation; the docblock claims 64×.
    expect(MAX_REMEMBERED_STOPS / 4).toBe(64);
  });
});
