/**
 * The batch projection's arithmetic (WP-35).
 *
 * `bootstrapBatchFrom` is a pure function of a batch row, its chunks and the ledger's sum, for
 * `shadow-queries.ts`'s reason: everything worth asserting is the arithmetic — the `numeric`
 * conversion, the two counts and the status fallback — and a projection driven only through a
 * container is a projection asserted once, slowly.
 */
import { describe, expect, it } from 'vitest';
import { bootstrapBatchFrom } from './bootstrap-queries.js';

const BATCH = '00000000-0000-4000-8000-0000000000e1';
const PROJECT = '00000000-0000-4000-8000-0000000000e2';

const row = (overrides: Partial<Parameters<typeof bootstrapBatchFrom>[0]> = {}) => ({
  id: BATCH,
  projectId: PROJECT,
  status: 'mining',
  detail: null,
  mergeRequests: 200,
  capUsd: '20.000000',
  estimatedUsd: '20.000000',
  createdAt: new Date('2026-09-14T10:00:00.000Z'),
  completedAt: null,
  ...overrides,
});

const chunk = (overrides: Partial<Parameters<typeof bootstrapBatchFrom>[1][number]> = {}) => ({
  batchId: BATCH,
  recordedAt: null,
  proposals: 0,
  refusedProposals: 0,
  ...overrides,
});

describe('projecting one batch', () => {
  it('converts the numeric columns and sums what the chunks reported', () => {
    const projected = bootstrapBatchFrom(
      row(),
      [
        chunk({
          recordedAt: new Date('2026-09-14T11:00:00.000Z'),
          proposals: 3,
          refusedProposals: 1,
        }),
        chunk({ recordedAt: new Date('2026-09-14T11:05:00.000Z'), proposals: 2 }),
        chunk(),
      ],
      4.8,
    );
    expect(projected).toEqual({
      id: BATCH,
      project_id: PROJECT,
      status: 'mining',
      created_at: '2026-09-14T10:00:00.000Z',
      completed_at: null,
      merge_requests: 200,
      detail: null,
      cap_usd: 20,
      estimated_usd: 20,
      spent_usd: 4.8,
      chunks: 3,
      // The distinction the batch screen rests on: two runs have reported and one has not, which
      // is a different fact from "one run found nothing".
      chunks_recorded: 2,
      proposals: 5,
      refused_proposals: 1,
    });
  });

  it('carries the platform’s own sentence for an empty batch', () => {
    const projected = bootstrapBatchFrom(
      row({
        status: 'empty',
        detail: 'no merge request has been merged on this project in the last 183 days',
        completedAt: new Date('2026-09-14T10:01:00.000Z'),
      }),
      [],
      0,
    );
    expect(projected.status).toBe('empty');
    expect(projected.detail).toContain('no merge request');
    expect(projected.completed_at).toBe('2026-09-14T10:01:00.000Z');
    expect(projected.chunks).toBe(0);
  });

  it('falls back to the most conservative status for a value this build cannot read', () => {
    // The column is constrained by migration 0030, so this cannot happen today. The fallback is
    // `collecting` rather than `completed` because a batch whose status a build cannot read is one
    // that has not finished as far as the screen is concerned (standing rule 20).
    expect(bootstrapBatchFrom(row({ status: 'reticulating' }), [], 0).status).toBe('collecting');
  });
});
