/**
 * The escalation's words for a remote run its worker stopped at the core's transcript bound (backlog
 * 754, S-22.14): named only for a `cancelled` run whose transcript is within one batch of the bound.
 */
import { MAX_TRANSCRIPT_ENTRIES_PER_RUN } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { transcriptBoundDetail } from './worker-protocol.js';

const poolCounting = (count: number) => ({
  query: async () => ({ rows: [{ count: String(count) }] }),
});

describe('transcriptBoundDetail (S-22.14)', () => {
  it('names the bound for a cancelled run at it, and nothing below it or for another ending', async () => {
    const at = poolCounting(MAX_TRANSCRIPT_ENTRIES_PER_RUN) as never;
    const below = poolCounting(MAX_TRANSCRIPT_ENTRIES_PER_RUN - 1_000) as never;
    const runId = '00000000-0000-4000-8000-000000002214';
    expect(await transcriptBoundDetail(at, { runId, outcome: { status: 'cancelled' } })).toContain(
      `at most ${MAX_TRANSCRIPT_ENTRIES_PER_RUN} transcript entries`,
    );
    expect(
      await transcriptBoundDetail(below, { runId, outcome: { status: 'cancelled' } }),
    ).toBeNull();
    expect(await transcriptBoundDetail(at, { runId, outcome: { status: 'failed' } })).toBeNull();
  });
});
