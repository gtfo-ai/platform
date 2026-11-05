/**
 * A worker as `GET /api/workers` publishes it (S-23.20's tests): obviously fake values, overridable
 * field by field, seen five seconds before {@link NOW}.
 */
import type { WorkerSummary } from '@platform/contracts';

export const NOW = Date.parse('2026-11-05T10:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

export const USER_ID = '00000000-0000-4000-8000-000000000001';

export const workerFixture = (over: Partial<WorkerSummary> = {}): WorkerSummary => ({
  id: '00000000-0000-4000-8000-000000000a01',
  name: 'jan-mbp',
  user: { id: USER_ID, email: 'jan@example.invalid', name: 'Jan' },
  created_at: ago(10 * 60_000),
  last_seen_at: ago(5_000),
  protocol_version: 3,
  image_digests: [],
  state: 'active',
  revoked_at: null,
  paused_until: null,
  paused_reason: null,
  paused_until_estimated: false,
  manually_paused_at: null,
  concurrency: 1,
  claim_projects: null,
  running: [],
  last_update: null,
  ...over,
});
