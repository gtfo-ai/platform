/**
 * The two schemas TD-028 decision 12 added to the control plane's wire format (WP-103).
 *
 * Both are **strict**, and that is the decision worth pinning: the destroy request is empty because
 * the run id is the path and a handle is exactly what its caller does not have, so anything in the
 * body is a caller that thinks it is sending something; and the listing carries exactly the three
 * fields the reaper decides on, bounded, so a launcher cannot hand the runner an unbounded array.
 * The round trip over a real listener is `apps/launcher/src/control-plane.test.ts`'s.
 */
import { MAX_LABELLED_RUNS } from '@platform/application';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_PLANE_PATHS,
  destroyRunRequestSchema,
  destroyRunResponseSchema,
  listRunsResponseSchema,
} from './protocol.js';

const RUN = '44444444-4444-4444-8444-444444444444';
const entry = { runId: RUN, createdAt: '2026-09-30T10:00:00.000Z', running: false };

describe('the reaper’s verbs on the wire (WP-103)', () => {
  it('names the destroy verb beside end, under the runs path', () => {
    expect(CONTROL_PLANE_PATHS.runs).toBe('/v1/runs');
    expect(CONTROL_PLANE_PATHS.destroy).toBe('destroy');
    expect(CONTROL_PLANE_PATHS.destroy).not.toBe(CONTROL_PLANE_PATHS.end);
  });

  it('accepts only an empty destroy request, so a handle cannot ride along', () => {
    expect(destroyRunRequestSchema.safeParse({}).success).toBe(true);
    expect(destroyRunRequestSchema.safeParse({ handle: { runId: RUN } }).success).toBe(false);
    expect(destroyRunRequestSchema.safeParse(null).success).toBe(false);
  });

  it('answers found as a boolean and nothing else', () => {
    expect(destroyRunResponseSchema.parse({ found: true })).toEqual({ found: true });
    expect(destroyRunResponseSchema.safeParse({ found: true, removed: 3 }).success).toBe(false);
  });

  it('bounds the listing and refuses an entry with a field the reaper does not decide on', () => {
    expect(listRunsResponseSchema.parse({ runs: [entry] })).toEqual({ runs: [entry] });
    expect(
      listRunsResponseSchema.safeParse({
        runs: Array.from({ length: MAX_LABELLED_RUNS }, () => entry),
      }).success,
    ).toBe(true);
    expect(
      listRunsResponseSchema.safeParse({
        runs: Array.from({ length: MAX_LABELLED_RUNS + 1 }, () => entry),
      }).success,
    ).toBe(false);
    expect(listRunsResponseSchema.safeParse({ runs: [{ ...entry, project: 'p' }] }).success).toBe(
      false,
    );
    expect(
      listRunsResponseSchema.safeParse({ runs: [{ ...entry, createdAt: 'yesterday' }] }).success,
    ).toBe(false);
  });
});
